/**
 * Mouse / scroll bridging for the local compositor.
 *
 * In the raw-passthrough model mouse "just works": the agent's DECSET enable
 * sequence reaches the real terminal, and the terminal's mouse reports flow
 * straight back. Once teleport interposes a headless emulator, that path is
 * severed in both directions, so we re-bridge it explicitly:
 *
 *   1. We force SGR mouse reporting (1006) on the *real* terminal whenever the
 *      agent has any mouse mode active, so incoming events are easy to decode
 *      unambiguously (see `realTerminalMouseEnable`).
 *   2. We decode those SGR reports, drop/adjust for the reserved status row,
 *      then re-encode into whatever protocol+encoding the *agent* asked for and
 *      forward them to the PTY.
 *
 * This module is pure (no I/O) so the protocol handling is unit-testable.
 */

const ESC = '\x1b';

/** Mouse protocol the agent requested, mirrored from xterm's mouseTrackingMode. */
export type MouseProtocol = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** Encoding the agent requested (tracked by scanning its output). */
export type MouseEncoding = 'default' | 'utf8' | 'sgr' | 'urxvt';

export interface MouseEvent {
  /** Raw button code as in the protocol (0=left,1=mid,2=right,64/65=wheel, +flags). */
  button: number;
  /** 1-based column. */
  col: number;
  /** 1-based row (in real-terminal coordinates). */
  row: number;
  /** True for a press / wheel tick, false for a release. */
  pressed: boolean;
  /** True when this is a motion (drag) report. */
  motion: boolean;
}

const WHEEL_FLAG = 64; // buttons 64 (up) / 65 (down) carry the wheel bit

/** True if the event is a scroll-wheel tick. */
export function isWheel(e: MouseEvent): boolean {
  return (e.button & WHEEL_FLAG) !== 0 && (e.button & 0b11) <= 1 && e.button >= 64 && e.button <= 65;
}

/** +1 = wheel up, -1 = wheel down, 0 = not a wheel event. */
export function wheelDirection(e: MouseEvent): -1 | 0 | 1 {
  if (!isWheel(e)) return 0;
  return e.button === 64 ? 1 : -1;
}

/**
 * Splits a stdin chunk into decoded SGR mouse events and the remaining
 * passthrough bytes (keystrokes etc.). Only SGR (1006) reports are decoded,
 * because that is the encoding we force on the real terminal. Unrecognised
 * bytes — including partial sequences — are returned in `rest` in order.
 */
export function extractSgrMouse(data: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  let rest = '';
  let i = 0;
  // SGR mouse: ESC [ < b ; x ; y (M|m)
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/y;
  while (i < data.length) {
    if (data[i] === ESC) {
      re.lastIndex = i;
      const m = re.exec(data);
      if (m && m.index === i) {
        const button = Number(m[1]);
        events.push({
          button,
          col: Number(m[2]),
          row: Number(m[3]),
          pressed: m[4] === 'M',
          motion: (button & 32) !== 0,
        });
        i = re.lastIndex;
        continue;
      }
    }
    rest += data[i];
    i += 1;
  }
  return { events, rest };
}

/**
 * Maps a real-terminal mouse event into the agent's coordinate space. The agent
 * occupies rows 1..agentRows (the bottom row is the status bar) and columns
 * (colOffset+1)..end (a left sidebar of `colOffset` columns sits before it).
 * Returns null when the event lands outside the agent area (status bar or
 * sidebar), so it is swallowed rather than forwarded with bad coordinates.
 */
export function translateToAgent(e: MouseEvent, agentRows: number, colOffset = 0): MouseEvent | null {
  if (e.row > agentRows) return null; // on the status bar
  const col = e.col - colOffset;
  if (col < 1) return null; // on the sidebar
  return col === e.col ? e : { ...e, col };
}

/** Whether the agent's protocol wants this event forwarded at all. */
export function protocolWantsEvent(e: MouseEvent, protocol: MouseProtocol): boolean {
  switch (protocol) {
    case 'none':
      return false;
    case 'x10':
      return e.pressed && !e.motion; // press only
    case 'vt200':
      return !e.motion; // press + release, no motion
    case 'drag':
      return !e.motion || (e.button & 0b11) !== 0b11; // press/release + drag while button held
    case 'any':
      return true;
  }
}

/** Encodes an event in the agent's encoding+protocol for forwarding to the PTY. */
export function encodeMouse(e: MouseEvent, encoding: MouseEncoding): string {
  if (encoding === 'sgr') {
    return `${ESC}[<${e.button};${e.col};${e.row}${e.pressed ? 'M' : 'm'}`;
  }
  if (encoding === 'urxvt') {
    // ESC [ Cb ; Cx ; Cy M  (decimal, +32 on the button only)
    return `${ESC}[${e.button + 32};${e.col};${e.row}M`;
  }
  // default / utf8 (X10-style): ESC [ M  Cb  Cx  Cy, each value +32.
  // For release in the legacy encoding the button is reported as 3 (0b11).
  const b = e.pressed ? e.button : 3;
  const enc = (n: number): string => {
    const v = n + 32;
    if (encoding === 'utf8' && v > 127) return Buffer.from(String.fromCodePoint(v), 'utf8').toString('binary');
    return String.fromCharCode(Math.min(v, 255));
  };
  return `${ESC}[M${enc(b)}${enc(e.col)}${enc(e.row)}`;
}

/**
 * Tracks the agent's requested mouse *encoding* by scanning its output for the
 * relevant DECSET/DECRST toggles (1005 utf8, 1006 sgr, 1015 urxvt). The protocol
 * itself (1000/1002/1003) is read from xterm's `modes.mouseTrackingMode`, so it
 * is not tracked here. Returns the updated encoding.
 */
export function trackMouseEncoding(output: string, prev: MouseEncoding): MouseEncoding {
  let enc = prev;
  const re = /\x1b\[\?(\d+)(h|l)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    const code = Number(m[1]);
    const on = m[2] === 'h';
    if (code === 1006) enc = on ? 'sgr' : 'default';
    else if (code === 1015) enc = on ? 'urxvt' : 'default';
    else if (code === 1005) enc = on ? 'utf8' : 'default';
  }
  return enc;
}

/**
 * DECSET sequences to set up mouse reporting on the *real* terminal in SGR
 * encoding (1006). We always capture button presses + the wheel (1000) — even
 * when the agent itself wants no mouse — so the scroll wheel can always drive
 * local scrollback. Motion tracking (1003) is added only when the agent asked
 * for drag/any, to avoid flooding stdin with movement events otherwise.
 *
 * The cost, as with tmux's mouse mode, is that native text selection is taken
 * over by the application while attached.
 */
export function realTerminalMouseSequences(protocol: MouseProtocol): string {
  const motion = protocol === 'drag' || protocol === 'any';
  return `${ESC}[?1000h${ESC}[?1003${motion ? 'h' : 'l'}${ESC}[?1006h`;
}

/** The DECRST sequence to turn the real terminal's mouse reporting back off. */
export function realTerminalMouseDisable(): string {
  return `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l`;
}
