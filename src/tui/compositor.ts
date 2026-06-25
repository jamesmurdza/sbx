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
  /** Detaches and exits the current session. */
  onSessionAction?: (outcome: 'detached') => void;
  /**
   * Stops/deletes the *current* sandbox. `neighbour` is another sandbox to hand
   * off to so the session (and sidebar) can continue, or null if none exists.
   */
  onCurrentAction?: (kind: 'stop' | 'delete', current: SidebarItem, neighbour: SidebarItem | null) => void;
  /** Performs an action on another (un-attached) sandbox, then the list refreshes. */
  onInlineAction?: (kind: 'stop' | 'delete', item: SidebarItem) => void;
}

/** Keybinding legend shown in the sidebar footer. */
const SIDEBAR_LEGEND = '↵ open  s stop  d del  x exit';

/** Clamps a scrollback offset to [0, max]. */
export function clampScroll(offset: number, max: number): number {
  return Math.max(0, Math.min(offset, max));
}

/** Absolute top line of the rendered viewport given the live base and offset. */
export function viewportTop(baseY: number, offset: number): number {
  return Math.max(0, baseY - offset);
}

export class Compositor {
  private term: InstanceType<typeof Terminal>;
  private cols: number;
  private rows: number; // full screen rows (agent uses rows-1)
  private readonly opts: CompositorOptions;

  private prevFrame: Frame | null = null;
  private prevBar = '';
  private live = '';

  private sidebarOpen = false;
  private sidebarItems: SidebarItem[] = [];
  private sidebarSelected = 0;
  private prevSidebar: string[] | null = null;
  private pendingDelete: SidebarItem | null = null;

  private mouseEncoding: MouseEncoding = 'default';
  private realMouseProtocol: MouseProtocol = 'none';
  private cursorHidden = false;
  private scrollOffset = 0;

  private renderTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private paused = false;
  private readonly disposers: Array<() => void> = [];

  constructor(opts: CompositorOptions) {
    this.opts = opts;
    this.cols = opts.cols;
    this.rows = opts.rows;
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
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('binary');
    this.mouseEncoding = trackMouseEncoding(text, this.mouseEncoding);
    this.trackCursorVisibility(text);
    this.term.write(data, () => {
      this.syncRealMouse();
      this.scheduleRender();
    });
  }

  /** Handles a stdin chunk: bridges mouse, drives the sidebar, or forwards keys. */
  input(chunk: Buffer): void {
    const s = chunk.toString('binary');
    const { events, rest } = extractSgrMouse(s);
    for (const ev of events) this.handleMouse(ev);
    if (!rest) return;
    // Ctrl-] toggles the sidebar.
    if (rest.includes(SIDEBAR_TOGGLE)) {
      this.toggleSidebar();
      const stripped = rest.split(SIDEBAR_TOGGLE).join('');
      if (!this.sidebarOpen && stripped) this.opts.sendInput(Buffer.from(stripped, 'binary'));
      return;
    }
    // While the sidebar is open it captures navigation keys.
    if (this.sidebarOpen) {
      this.navInput(Buffer.from(rest, 'binary'));
      return;
    }
    // Typing while scrolled back snaps the viewport to the live bottom.
    if (this.scrollOffset > 0) this.follow();
    this.opts.sendInput(Buffer.from(rest, 'binary'));
  }

  private handleMouse(ev: MouseEvent): void {
    const w = this.sidebarWidth();
    const protocol = this.mouseProtocol();
    const dir = wheelDirection(ev);
    // Wheel over the sidebar, or when the agent isn't tracking it → scrollback.
    if (dir !== 0 && (protocol === 'none' || ev.col <= w)) {
      this.scrollBy(dir * 3);
      return;
    }
    // Clicks in the sidebar band select a row (and never reach the agent).
    if (w > 0 && ev.col <= w) {
      if (ev.pressed && !ev.motion && !isWheel(ev)) this.selectByRow(ev.row);
      return;
    }
    const mapped = translateToAgent(ev, this.rows - 1, w);
    if (!mapped || !protocolWantsEvent(mapped, protocol)) return;
    this.opts.sendInput(encodeMouse(mapped, this.mouseEncoding));
  }

  private navInput(buf: Buffer): void {
    const s = buf.toString('binary');
    // A pending delete confirmation swallows the next key.
    if (this.pendingDelete) {
      if (s === 'y' || s === 'Y') this.confirmDelete();
      else this.cancelDelete();
      return;
    }
    // Action keys act on the selected sandbox.
    if (s === 's') return this.stopSelected();
    if (s === 'd') return this.askDelete();
    if (s === 'x' || s === 'X') return void this.opts.onSessionAction?.('detached');
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

  /** Stops the selected sandbox. Stopping the current one hands off to a
   * neighbour (so the flow continues); others stop in place. */
  private stopSelected(): void {
    const it = this.sidebarItems[this.sidebarSelected];
    if (!it) return;
    if (it.current) this.actOnCurrent('stop', it);
    else this.opts.onInlineAction?.('stop', it);
  }

  /** Routes a stop/delete of the *current* sandbox, picking a neighbour to hand
   * off to so deleting/stopping it doesn't tear down the sidebar flow. */
  private actOnCurrent(kind: 'stop' | 'delete', it: SidebarItem): void {
    const neighbour = this.sidebarItems.find((s) => !s.current) ?? null;
    this.opts.onCurrentAction?.(kind, it, neighbour);
  }

  private askDelete(): void {
    const it = this.sidebarItems[this.sidebarSelected];
    if (!it) return;
    this.pendingDelete = it;
    this.scheduleRender();
  }

  private confirmDelete(): void {
    const it = this.pendingDelete;
    this.pendingDelete = null;
    if (it) {
      if (it.current) this.actOnCurrent('delete', it);
      else this.opts.onInlineAction?.('delete', it);
    }
    this.scheduleRender();
  }

  private cancelDelete(): void {
    this.pendingDelete = null;
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
    this.scrollOffset = 0;
    this.reflow();
  }

  /**
   * Updates the list of sandboxes shown in the sidebar, keeping the highlight on
   * the *same sandbox* (by id) across refreshes, reorders, and deletions. When
   * the selected sandbox is gone (e.g. just deleted), the cursor stays in the
   * same slot — landing on the neighbour — rather than jumping elsewhere.
   */
  setSandboxes(items: SidebarItem[]): void {
    const prevId = this.sidebarItems[this.sidebarSelected]?.id;
    this.sidebarItems = items;
    let idx = prevId ? items.findIndex((it) => it.id === prevId) : -1;
    if (idx < 0) idx = Math.min(this.sidebarSelected, items.length - 1);
    this.sidebarSelected = Math.max(0, idx);
    // Drop a pending delete whose target vanished from the list.
    if (this.pendingDelete && !items.some((it) => it.id === this.pendingDelete?.id)) {
      this.pendingDelete = null;
    }
    if (this.sidebarOpen) this.scheduleRender();
  }

  /** Opens the sidebar if it isn't already (e.g. on startup as the entry menu). */
  openSidebar(): void {
    if (!this.sidebarOpen) this.toggleSidebar();
  }

  /** Opens/closes the sidebar, reflowing the agent area to fit. */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    if (this.sidebarOpen) {
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
    this.opts.write(realTerminalMouseDisable());
    // Restore autowrap, show cursor, leave alt screen.
    this.opts.write(`${ESC}[?7h${ESC}[?25h${ESC}[2J${ESC}[H${ESC}[?1049l`);
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
    this.sidebarSelected = Math.max(0, Math.min(this.sidebarSelected + delta, n - 1));
    this.scheduleRender();
  }

  private activateSelection(): void {
    const it = this.sidebarItems[this.sidebarSelected];
    if (it) this.opts.onSidebarSelect?.(it, this.sidebarSelected);
  }

  /** Maps a clicked screen row (1-based) to a sidebar item and selects it. */
  private selectByRow(screenRow: number): void {
    // Row 1 is the title and the last row is the footer legend.
    const rows = Math.max(0, this.rows - 1 - 2);
    const start = windowStart(this.sidebarSelected, this.sidebarItems.length, rows);
    const idx = start + (screenRow - 2);
    if (idx >= 0 && idx < this.sidebarItems.length) {
      this.sidebarSelected = idx;
      this.scheduleRender();
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

  private scrollBy(lines: number): void {
    const buf = this.term.buffer.active;
    const maxOffset = Math.max(0, buf.length - (this.rows - 1));
    const next = clampScroll(this.scrollOffset - lines, maxOffset);
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.disposed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderNow();
    }, 8);
  }

  private renderNow(): void {
    if (this.disposed || this.paused) return;
    const w = this.sidebarWidth();
    const agentRows = Math.max(1, this.rows - 1);
    const buf = this.term.buffer.active;
    const top = viewportTop(buf.baseY, this.scrollOffset);
    const frame = frameFromBuffer(buf as never, top, this.agentCols(), agentRows);

    // Agent screen, painted to the right of the sidebar band.
    let out = renderFrameDiff(this.prevFrame, frame, 1, w + 1);
    this.prevFrame = frame;

    // Sidebar band on the left, diffed line by line.
    if (w > 0) {
      const footer = this.pendingDelete
        ? `delete ${this.pendingDelete.id.slice(0, 8)}? y/n`
        : SIDEBAR_LEGEND;
      const lines = renderSidebar(this.sidebarItems, this.sidebarSelected, w, agentRows, footer);
      for (let r = 0; r < lines.length; r++) {
        if (this.prevSidebar && this.prevSidebar[r] === lines[r]) continue;
        out += `${ESC}[${r + 1};1H` + lines[r];
      }
      this.prevSidebar = lines;
    } else {
      this.prevSidebar = null;
    }

    // Status bar on the reserved bottom row (full width).
    const barText = renderStatusBar(this.opts.bar, this.statusLine(), this.cols);
    if (barText !== this.prevBar) {
      out += `${ESC}[${this.rows};1H${barText}`;
      this.prevBar = barText;
    }

    // Cursor: in the agent area (offset by the sidebar), only when live, the
    // agent shows it, and the sidebar isn't capturing navigation.
    if (!this.sidebarOpen && this.scrollOffset === 0 && !this.cursorHidden) {
      const cx = Math.min(this.cols, buf.cursorX + 1 + w);
      const cy = Math.min(agentRows, buf.cursorY + 1);
      out += `${ESC}[${cy};${cx}H${ESC}[?25h`;
    } else {
      out += `${ESC}[?25l`;
    }
    if (out) this.opts.write(out);
  }

  /** The live-status segment, with a scrollback hint when scrolled up. */
  private statusLine(): string {
    if (this.scrollOffset > 0) {
      const hint = `SCROLLBACK ↑${this.scrollOffset} · type to resume`;
      return this.live ? `${hint}  ·  ${this.live}` : hint;
    }
    return this.live;
  }

  /** Jumps the viewport back to the live bottom. */
  follow(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  /** Stops painting (e.g. while the menu overlay owns the screen). */
  pause(): void {
    this.paused = true;
  }

  /** Resumes painting and forces a full repaint to erase any overlay. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.prevFrame = null;
    this.prevBar = '';
    this.renderNow();
  }
}
