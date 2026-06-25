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
  extractSgrMouse,
  translateToAgent,
  protocolWantsEvent,
  encodeMouse,
  trackMouseEncoding,
  wheelDirection,
  realTerminalMouseSequences,
  realTerminalMouseDisable,
  type MouseEncoding,
  type MouseProtocol,
} from './mouse.js';

const { Terminal } = pkg;
const ESC = '\x1b';

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
}

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

  /** Handles a stdin chunk: bridges mouse, scrolls, or forwards keystrokes. */
  input(chunk: Buffer): void {
    const s = chunk.toString('binary');
    const { events, rest } = extractSgrMouse(s);
    if (rest) {
      // Typing while scrolled back snaps the viewport to the live bottom.
      if (this.scrollOffset > 0) this.follow();
      this.opts.sendInput(Buffer.from(rest, 'binary'));
    }
    const protocol = this.mouseProtocol();
    for (const ev of events) {
      const dir = wheelDirection(ev);
      // Wheel while the agent is NOT tracking the wheel → local scrollback.
      if (dir !== 0 && protocol === 'none') {
        this.scrollBy(dir * 3);
        continue;
      }
      const mapped = translateToAgent(ev, this.rows - 1);
      if (!mapped || !protocolWantsEvent(mapped, protocol)) continue;
      this.opts.sendInput(encodeMouse(mapped, this.mouseEncoding));
    }
  }

  /** Live status text shown on the right of the bar (e.g. push status). */
  setLiveStatus(text: string): void {
    this.live = text;
    this.scheduleRender();
  }

  /** Resizes the emulator + screen and forces a full repaint. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, Math.max(1, rows - 1));
    this.prevFrame = null; // force full repaint
    this.prevBar = '';
    this.scrollOffset = 0;
    this.opts.write(`${ESC}[2J`);
    this.renderNow();
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
    const agentRows = this.rows - 1;
    const buf = this.term.buffer.active;
    const top = viewportTop(buf.baseY, this.scrollOffset);
    const frame = frameFromBuffer(buf as never, top, this.cols, agentRows);

    let out = renderFrameDiff(this.prevFrame, frame, 1);
    this.prevFrame = frame;

    // Status bar on the reserved bottom row.
    const barText = renderStatusBar(this.opts.bar, this.statusLine(), this.cols);
    if (barText !== this.prevBar) {
      out += `${ESC}[${this.rows};1H${barText}`;
      this.prevBar = barText;
    }

    // Cursor: only when live (not scrolled back) and the agent shows it.
    if (this.scrollOffset === 0 && !this.cursorHidden) {
      const cx = Math.min(this.cols, buf.cursorX + 1);
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
