/**
 * Local terminal compositor.
 *
 * teleport owns the real terminal. The agent's PTY output is parsed into a
 * headless xterm emulator sized to the screen minus one row; each frame we diff
 * the emulator's screen to the real terminal and paint our own status bar on the
 * reserved bottom row. Keystrokes are forwarded to the PTY unchanged; mouse
 * reports are bridged (see ./mouse) and the scroll wheel drives a local
 * scrollback viewport when the agent is not itself in mouse mode.
 *
 * Why an emulator at all: it gives teleport the screen contents and cursor
 * position locally, which is what makes a robust local status bar (and, later, a
 * sidebar) possible without the fragile cursor save/restore that a dumb byte
 * pipe would need.
 */
import pkg from '@xterm/headless';
import {
  renderFrameDiff,
  frameFromBuffer,
  blankFrame,
  placeholderFrame,
  type Frame,
} from './render.js';
import { renderStatusBar, type BarInfo } from './statusbar.js';
import {
  renderSidebar,
  windowStart,
  SIDEBAR_WIDTH,
  MIN_AGENT_COLS,
  type SidebarItem,
} from './sidebar.js';
import { decodeKey } from './prompt.js';
import { modalFrame, type ModalState, type ModalMenuItem } from './modal.js';
import {
  extractSgrMouse,
  translateToAgent,
  protocolWantsEvent,
  encodeMouse,
  trackMouseEncoding,
  wheelDirection,
  isWheel,
  realTerminalMouseSequences,
  realTerminalMouseDisable,
  type MouseEncoding,
  type MouseProtocol,
  type MouseEvent,
} from './mouse.js';

const { Terminal } = pkg;
const ESC = '\x1b';
/** Ctrl-] (GS, 0x1d) — toggles the sandbox sidebar. */
const SIDEBAR_TOGGLE = '\x1d';

export interface CompositorOptions {
  cols: number;
  rows: number;
  bar: BarInfo;
  /** Write to the real terminal (stdout). */
  write: (data: string) => void;
  /** Forward bytes to the agent PTY. */
  sendInput: (data: string | Uint8Array) => void;
  /** Number of scrollback lines to retain locally. */
  scrollback?: number;
  /** Called when the agent's drawable area changes size (resize / sidebar toggle). */
  onAgentSize?: (cols: number, rows: number) => void;
  /** Called when a sidebar row is activated to switch to it (Enter / click). */
  onSidebarSelect?: (item: SidebarItem, index: number) => void;
  /** Called when the highlighted sidebar row changes (↑/↓ / click) — drives the
   * live preview of the selected sandbox in the agent pane. */
  onSelectionChange?: (item: SidebarItem) => void;
  /** Detaches and exits the current session (the `x` action). */
  onSessionAction?: (outcome: 'detached') => void;
  /** Creates a new sandbox (the `n` action). */
  onNew?: () => void;
  /** Shows an info panel for the selected sandbox (the `i` action). */
  onInfo?: (item: SidebarItem) => void;
  /** Opens the selected sandbox's branch on GitHub (the `g` action). */
  onOpenBranch?: (item: SidebarItem) => void;
  /**
   * Deletes the *current* sandbox. `neighbour` is another sandbox to hand off to
   * so the session (and sidebar) can continue, or null if none exists.
   */
  onDeleteCurrent?: (current: SidebarItem, neighbour: SidebarItem | null) => void;
  /** Deletes another (un-attached) sandbox in place, then the list refreshes. */
  onDeleteOther?: (item: SidebarItem) => void;
}

/** Keybinding legend shown in the sidebar footer (two rows so it isn't clipped). */
const SIDEBAR_LEGEND = ['↵ open   n new   i info', 'g web   d del   x exit'];
/** Footer shown when focus is on the agent pane (the hotkeys type into it). */
const SIDEBAR_AGENT_LEGEND = ['▶ typing to the agent', '← back to the sidebar'];

export class Compositor {
  private term: InstanceType<typeof Terminal>;
  private cols: number;
  private rows: number; // full screen rows (agent uses rows-1)
  private readonly opts: CompositorOptions;

  private prevFrame: Frame | null = null;
  private prevBar = '';
  private live = '';
  private bar: BarInfo;
  /** When set, the agent area shows this centered message instead of the screen. */
  private agentPlaceholder: string | null = null;
  /** Real-terminal colour replies for the agent's OSC 10/11 queries (if detected). */
  private colorReplies: { osc10: string; osc11: string } | null = null;

  private sidebarOpen = false;
  /** When the sidebar is open, whether it (vs. the agent pane) has keyboard focus. */
  private sidebarFocused = true;
  private sidebarItems: SidebarItem[] = [];
  private sidebarSelected = 0;
  private prevSidebar: string[] | null = null;
  /** Sandboxes deleted locally, filtered out until the server stops reporting them. */
  private readonly removedIds = new Set<string>();
  /** A modal shown in the agent pane (sidebar/bar untouched). */
  private modal: ModalState | null = null;

  private mouseEncoding: MouseEncoding = 'default';
  private realMouseProtocol: MouseProtocol = 'none';
  private cursorHidden = false;

  private renderTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly disposers: Array<() => void> = [];

  constructor(opts: CompositorOptions) {
    this.opts = opts;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.bar = opts.bar;
    this.term = new Terminal({
      cols: opts.cols,
      rows: Math.max(1, opts.rows - 1),
      scrollback: opts.scrollback ?? 5000,
      allowProposedApi: true,
    });
    // Replies the emulator generates (answers to the agent's DA/DSR queries,
    // bracketed-paste wrappers, etc.) must go back to the agent.
    const d = this.term.onData((data: string) => this.opts.sendInput(data));
    this.disposers.push(() => d.dispose());
  }

  /** Enters the alt screen, hides the cursor, enables mouse, paints frame one. */
  start(): void {
    // Disable autowrap (?7l): we position every row absolutely, so a full-width
    // row (or the bottom status bar) must not wrap to the next line and scroll
    // the screen — that produces duplicated "double" rows.
    this.opts.write(`${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l${ESC}[?7l`);
    // Always capture buttons + wheel so local scrollback works even for agents
    // that never enable mouse themselves.
    this.opts.write(realTerminalMouseSequences('none'));
    this.prevFrame = blankFrame(this.cols, this.rows - 1);
    this.renderNow();
  }

  /** Feeds a chunk of agent output into the emulator and schedules a repaint. */
  feed(data: Uint8Array | string): void {
    this.agentPlaceholder = null; // first output replaces any "connecting…" notice
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('binary');
    this.mouseEncoding = trackMouseEncoding(text, this.mouseEncoding);
    this.trackCursorVisibility(text);
    this.answerColorQueries(text);
    this.term.write(data, () => {
      this.syncRealMouse();
      this.scheduleRender();
    });
  }

  /**
   * Tells the compositor the real terminal's colours so it can answer an agent's
   * OSC 10/11 queries (the emulator itself doesn't), letting agents pick the
   * right light/dark theme.
   */
  setColorReplies(replies: { osc10: string; osc11: string }): void {
    this.colorReplies = replies;
  }

  /** Replies to OSC 10/11 (fg/bg) colour queries the agent emits, if we know them. */
  private answerColorQueries(text: string): void {
    if (!this.colorReplies) return;
    if (/\x1b\]11;\?(?:\x07|\x1b\\)/.test(text)) this.opts.sendInput(this.colorReplies.osc11);
    if (/\x1b\]10;\?(?:\x07|\x1b\\)/.test(text)) this.opts.sendInput(this.colorReplies.osc10);
  }

  /** Handles a stdin chunk: bridges mouse, drives the sidebar, or forwards keys. */
  input(chunk: Buffer): void {
    const s = chunk.toString('binary');
    const { events, rest } = extractSgrMouse(s);
    // A modal in the agent pane captures all keys (mouse is ignored).
    if (this.modal) {
      if (rest) this.modalInput(rest);
      return;
    }
    for (const ev of events) this.handleMouse(ev);
    if (!rest) return;
    // Ctrl-] toggles the sidebar.
    if (rest.includes(SIDEBAR_TOGGLE)) {
      this.toggleSidebar();
      const stripped = rest.split(SIDEBAR_TOGGLE).join('');
      if (!this.sidebarOpen && stripped) this.opts.sendInput(Buffer.from(stripped, 'binary'));
      return;
    }
    // Two-pane focus: while the sidebar is open, the sideways arrows move the
    // keyboard between the panes — → hands focus to the agent on the right, ←
    // hands it back to the sidebar on the left. When the sidebar is focused it
    // captures navigation keys; when the agent is focused, keystrokes type into
    // it while the sidebar stays visible.
    if (this.sidebarOpen) {
      const key = decodeKey(Buffer.from(rest, 'binary'));
      if (this.sidebarFocused) {
        if (key === 'right') return this.setSidebarFocus(false);
        this.navInput(Buffer.from(rest, 'binary'));
        return;
      }
      // Agent has focus (sidebar still visible): ← returns focus to the sidebar;
      // everything else types into the agent.
      if (key === 'left') return this.setSidebarFocus(true);
    }
    this.opts.sendInput(Buffer.from(rest, 'binary'));
  }

  private setSidebarFocus(toSidebar: boolean): void {
    if (this.sidebarFocused === toSidebar) return;
    this.sidebarFocused = toSidebar;
    this.scheduleRender();
  }

  private handleMouse(ev: MouseEvent): void {
    const w = this.sidebarWidth();
    const protocol = this.mouseProtocol();
    // Wheel the agent doesn't track (or over the sidebar): ignore. We don't scroll
    // a local viewport — that just flashes stale frames of a full-screen agent.
    if (wheelDirection(ev) !== 0 && (protocol === 'none' || ev.col <= w)) return;
    // Clicks in the sidebar band select a row, focus the sidebar, and never
    // reach the agent.
    if (w > 0 && ev.col <= w) {
      if (ev.pressed && !ev.motion && !isWheel(ev)) {
        this.sidebarFocused = true;
        this.selectByRow(ev.row);
        this.scheduleRender();
      }
      return;
    }
    // A click in the agent area (with the sidebar open) hands focus to the agent.
    if (this.sidebarOpen && ev.pressed && !ev.motion && !isWheel(ev) && this.sidebarFocused) {
      this.sidebarFocused = false;
      this.scheduleRender();
    }
    // Forward to the agent (which tracks the wheel/clicks itself).
    const mapped = translateToAgent(ev, this.rows - 1, w);
    if (!mapped || !protocolWantsEvent(mapped, protocol)) return;
    this.opts.sendInput(encodeMouse(mapped, this.mouseEncoding));
  }

  private modalInput(rest: string): void {
    const m = this.modal;
    if (!m) return;
    if (m.kind === 'info') {
      this.closeModal(undefined); // any key dismisses the info panel
      return;
    }
    if (m.kind === 'menu') {
      switch (decodeKey(Buffer.from(rest, 'binary'))) {
        case 'up':
          m.selected = Math.max(0, m.selected - 1);
          this.scheduleRender();
          break;
        case 'down':
          m.selected = Math.min(m.items.length - 1, m.selected + 1);
          this.scheduleRender();
          break;
        case 'enter':
          this.closeModal(m.items[m.selected]?.value ?? null);
          break;
        case 'cancel':
          this.closeModal(null);
          break;
        default:
          break;
      }
      return;
    }
    // Prompt: edit the line; lone Esc/Ctrl-C cancels, Enter submits.
    if (rest === '\x1b' || rest === '\x03') return this.closeModal(null);
    if (rest === '\r' || rest === '\n') return this.closeModal(m.value.trim() || null);
    if (rest.startsWith('\x1b')) return; // ignore arrows/escape sequences
    for (const ch of rest) {
      const b = ch.charCodeAt(0);
      if (b === 0x7f || b === 0x08) m.value = [...m.value].slice(0, -1).join('');
      else if (b >= 0x20 && b < 0x7f) m.value += ch;
    }
    this.scheduleRender();
  }

  private closeModal(value: unknown): void {
    const m = this.modal;
    this.modal = null;
    this.prevFrame = null; // agent area returns to placeholder/agent
    this.scheduleRender();
    (m?.resolve as ((v: unknown) => void) | undefined)?.(value);
  }

  private navInput(buf: Buffer): void {
    const s = buf.toString('binary');
    // Action keys.
    if (s === 'n' || s === 'N') return void this.opts.onNew?.();
    if (s === 'd') return this.askDelete();
    if (s === 'x' || s === 'X') return void this.opts.onSessionAction?.('detached');
    if (s === 'i' || s === 'I') {
      const it = this.sidebarItems[this.sidebarSelected];
      if (it) this.opts.onInfo?.(it);
      return;
    }
    if (s === 'g' || s === 'G') {
      const it = this.sidebarItems[this.sidebarSelected];
      if (it) this.opts.onOpenBranch?.(it);
      return;
    }
    switch (decodeKey(buf)) {
      case 'up':
        this.moveSelection(-1);
        break;
      case 'down':
        this.moveSelection(1);
        break;
      case 'enter':
        this.activateSelection();
        break;
      case 'cancel':
        this.toggleSidebar(); // Esc / q closes the sidebar
        break;
      default:
        break;
    }
  }

  /** Confirms deletion in a modal (default "Delete", so Return deletes). */
  private askDelete(): void {
    const it = this.sidebarItems[this.sidebarSelected];
    if (!it) return;
    void this.menu(`Delete sandbox ${it.id.slice(0, 8)}?`, [
      { label: 'Delete', value: 'delete' },
      { label: 'Cancel', value: 'cancel' },
    ]).then((choice) => {
      if (choice === 'delete') this.performDelete(it);
    });
  }

  private performDelete(it: SidebarItem): void {
    // Keep it filtered until the server confirms it's gone (optimistic).
    this.removedIds.add(it.id);
    if (it.current) {
      // Hand off to a neighbour so deleting the current one keeps the flow.
      const neighbour = this.sidebarItems.find((s) => !s.current && s.id !== it.id) ?? null;
      this.opts.onDeleteCurrent?.(it, neighbour);
    } else {
      // Drop it from the list now; the slow API call + refresh run in the background.
      this.applyList(this.sidebarItems.filter((s) => s.id !== it.id));
      this.opts.onDeleteOther?.(it);
    }
    this.scheduleRender();
  }

  /** Live status text shown on the right of the bar (e.g. push status). */
  setLiveStatus(text: string): void {
    this.live = text;
    this.scheduleRender();
  }

  /** Resizes to a new terminal size and forces a full repaint. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.reflow();
  }

  /**
   * Updates the list of sandboxes shown in the sidebar, keeping the highlight on
   * the *same sandbox* (by id) across refreshes, reorders, and deletions. When
   * the selected sandbox is gone (e.g. just deleted), the cursor stays in the
   * same slot — landing on the neighbour — rather than jumping elsewhere.
   */
  /** Applies a *server* sandbox list, honouring optimistic deletions. */
  setSandboxes(items: SidebarItem[]): void {
    // Forget optimistically-removed ids the server no longer reports (truly
    // gone), and keep filtering the rest until then (no flicker/reappear).
    for (const id of this.removedIds) {
      if (!items.some((it) => it.id === id)) this.removedIds.delete(id);
    }
    if (this.removedIds.size) items = items.filter((it) => !this.removedIds.has(it.id));
    this.applyList(items);
  }

  /** Replaces the list and reconciles the selection (by id) — no removedIds work. */
  private applyList(items: SidebarItem[]): void {
    const prevId = this.sidebarItems[this.sidebarSelected]?.id;
    this.sidebarItems = items;
    let idx = prevId ? items.findIndex((it) => it.id === prevId) : -1;
    if (idx < 0) idx = Math.min(this.sidebarSelected, items.length - 1);
    this.sidebarSelected = Math.max(0, idx);
    if (this.sidebarOpen) this.scheduleRender();
  }

  /** Shows a selection modal in the agent pane; resolves to a value or null. */
  menu(title: string, items: ModalMenuItem[]): Promise<unknown> {
    return new Promise((resolve) => {
      this.modal = { kind: 'menu', title, items, selected: 0, resolve };
      this.scheduleRender();
    });
  }

  /** Shows a text-input modal in the agent pane; resolves to a string or null. */
  prompt(title: string, placeholder = ''): Promise<string | null> {
    return new Promise((resolve) => {
      this.modal = { kind: 'prompt', title, placeholder, value: '', resolve };
      this.scheduleRender();
    });
  }

  /** Shows a read-only info panel in the agent pane; resolves when dismissed. */
  info(title: string, lines: string[]): Promise<void> {
    return new Promise((resolve) => {
      this.modal = { kind: 'info', title, lines, resolve };
      this.scheduleRender();
    });
  }

  /** Opens the sidebar if it isn't already (e.g. on startup as the entry menu). */
  openSidebar(): void {
    if (!this.sidebarOpen) this.toggleSidebar();
  }

  /** Closes the sidebar if open (e.g. when landing in a freshly-switched agent). */
  closeSidebar(): void {
    if (this.sidebarOpen) this.toggleSidebar();
  }

  /** The agent's current drawable area (screen minus the sidebar and status row). */
  agentSize(): { cols: number; rows: number } {
    return { cols: this.agentCols(), rows: Math.max(1, this.rows - 1) };
  }

  /** Updates the status-bar fields (e.g. after switching to a different sandbox). */
  setBar(bar: BarInfo): void {
    this.bar = bar;
    this.live = '';
    this.prevBar = '';
    this.scheduleRender();
  }

  /**
   * Clears the agent screen for a new sandbox and shows a centered placeholder
   * (e.g. "connecting…") until the new agent's first output arrives. This lets a
   * switch happen *inside* the compositor — the sidebar and chrome stay put — with
   * no flash to a bare terminal.
   */
  resetAgent(placeholder = ''): void {
    this.term.reset();
    this.prevFrame = null;
    this.cursorHidden = false;
    this.agentPlaceholder = placeholder;
    this.renderNow();
  }

  /**
   * True when keystrokes go straight to the agent — i.e. neither the sidebar nor
   * a modal is capturing input. Used by the controller to decide whether Ctrl-C
   * is an agent interrupt (focused) or a quit/escape hatch (anything else).
   */
  agentFocused(): boolean {
    return !this.modal && !(this.sidebarOpen && this.sidebarFocused);
  }

  /** True while the sidebar band is open. */
  get sidebarIsOpen(): boolean {
    return this.sidebarOpen;
  }

  /** Opens/closes the sidebar, reflowing the agent area to fit. */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    if (this.sidebarOpen) {
      // Opening the sidebar focuses it (you opened it to navigate); Tab hands
      // focus to the agent without closing it.
      this.sidebarFocused = true;
      const cur = this.sidebarItems.findIndex((it) => it.current);
      this.sidebarSelected = cur >= 0 ? cur : 0;
    }
    this.reflow();
  }

  /** Restores the real terminal and disposes the emulator. */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    // Turn off mouse reporting first so the terminal stops emitting events, then
    // restore autowrap + cursor + bracketed paste/focus, and leave the alt
    // screen. (Leftover input is drained by the caller so it can't leak to the
    // shell as stray "command" characters.)
    this.opts.write(realTerminalMouseDisable());
    this.opts.write(`${ESC}[?2004l${ESC}[?1004l${ESC}[?7h${ESC}[?25h${ESC}[2J${ESC}[H${ESC}[?1049l`);
    for (const dispose of this.disposers) dispose();
    this.term.dispose();
  }

  // --- internals ------------------------------------------------------------

  /** Sidebar band width (0 when closed, or when the terminal is too narrow). */
  private sidebarWidth(): number {
    if (!this.sidebarOpen) return 0;
    const w = Math.min(SIDEBAR_WIDTH, this.cols - MIN_AGENT_COLS);
    return w >= 12 ? w : 0;
  }

  /** Columns available to the agent (screen minus the sidebar band). */
  private agentCols(): number {
    return Math.max(1, this.cols - this.sidebarWidth());
  }

  /** Resizes the emulator + PTY to the current agent area and full-repaints. */
  private reflow(): void {
    const aCols = this.agentCols();
    const aRows = Math.max(1, this.rows - 1);
    this.term.resize(aCols, aRows);
    this.opts.onAgentSize?.(aCols, aRows);
    this.prevFrame = null;
    this.prevSidebar = null;
    this.prevBar = '';
    this.opts.write(`${ESC}[2J`);
    this.renderNow();
  }

  private moveSelection(delta: number): void {
    const n = this.sidebarItems.length;
    if (!n) return;
    const next = Math.max(0, Math.min(this.sidebarSelected + delta, n - 1));
    if (next === this.sidebarSelected) return;
    this.sidebarSelected = next;
    this.scheduleRender();
    this.opts.onSelectionChange?.(this.sidebarItems[next]);
  }

  private activateSelection(): void {
    const it = this.sidebarItems[this.sidebarSelected];
    if (it) this.opts.onSidebarSelect?.(it, this.sidebarSelected);
  }

  /** Footer rows for the sidebar (the keybinding legend). */
  private sidebarFooter(): string[] {
    // When the agent has focus the hotkeys type into it, so show the focus hint
    // instead of a legend that wouldn't fire.
    return this.sidebarFocused ? SIDEBAR_LEGEND : SIDEBAR_AGENT_LEGEND;
  }

  /** Maps a clicked screen row (1-based) to a sidebar item and selects it. */
  private selectByRow(screenRow: number): void {
    // Row 1 is the title; the last rows are the footer legend.
    const agentRows = Math.max(1, this.rows - 1);
    const rows = Math.max(0, agentRows - 1 - this.sidebarFooter().length);
    const start = windowStart(this.sidebarSelected, this.sidebarItems.length, rows);
    const idx = start + (screenRow - 2);
    if (idx >= 0 && idx < this.sidebarItems.length && idx !== this.sidebarSelected) {
      this.sidebarSelected = idx;
      this.scheduleRender();
      this.opts.onSelectionChange?.(this.sidebarItems[idx]);
    }
  }

  private mouseProtocol(): MouseProtocol {
    return (this.term.modes?.mouseTrackingMode ?? 'none') as MouseProtocol;
  }

  /** Adjusts real-terminal mouse tracking when the agent's protocol changes. */
  private syncRealMouse(): void {
    const protocol = this.mouseProtocol();
    if (protocol === this.realMouseProtocol) return;
    this.realMouseProtocol = protocol;
    this.opts.write(realTerminalMouseSequences(protocol));
  }

  private trackCursorVisibility(text: string): void {
    const re = /\x1b\[\?25(h|l)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) this.cursorHidden = m[1] === 'l';
  }


  private scheduleRender(): void {
    if (this.renderTimer || this.disposed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderNow();
    }, 8);
  }

  private renderNow(): void {
    if (this.disposed) return;
    const w = this.sidebarWidth();
    const agentRows = Math.max(1, this.rows - 1);
    const buf = this.term.buffer.active;
    const frame = this.modal
      ? modalFrame(this.modal, this.agentCols(), agentRows)
      : this.agentPlaceholder !== null
        ? placeholderFrame(this.agentPlaceholder, this.agentCols(), agentRows)
        : frameFromBuffer(buf as never, buf.baseY, this.agentCols(), agentRows);

    // Agent screen, painted to the right of the sidebar band.
    let out = renderFrameDiff(this.prevFrame, frame, 1, w + 1);
    this.prevFrame = frame;

    // Sidebar band on the left, diffed line by line.
    if (w > 0) {
      const tabHint = this.sidebarFocused ? '→ agent' : '← list';
      const lines = renderSidebar(this.sidebarItems, this.sidebarSelected, w, agentRows, this.sidebarFooter(), {
        focused: this.sidebarFocused,
        tabHint,
      });
      for (let r = 0; r < lines.length; r++) {
        if (this.prevSidebar && this.prevSidebar[r] === lines[r]) continue;
        out += `${ESC}[${r + 1};1H` + lines[r];
      }
      this.prevSidebar = lines;
    } else {
      this.prevSidebar = null;
    }

    // Status bar on the reserved bottom row (full width).
    const barText = renderStatusBar(this.bar, this.cols);
    if (barText !== this.prevBar) {
      out += `${ESC}[${this.rows};1H${barText}`;
      this.prevBar = barText;
    }

    // Cursor: in the agent area (offset by the sidebar), only when the agent has
    // focus (sidebar closed, or open with focus handed over via Tab), the agent
    // shows it, and there's no modal/placeholder.
    if (this.agentFocused() && !this.cursorHidden && this.agentPlaceholder === null) {
      const cx = Math.min(this.cols, buf.cursorX + 1 + w);
      const cy = Math.min(agentRows, buf.cursorY + 1);
      out += `${ESC}[${cy};${cx}H${ESC}[?25h`;
    } else {
      out += `${ESC}[?25l`;
    }
    if (out) this.opts.write(out);
  }
}
