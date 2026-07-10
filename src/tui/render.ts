/**
 * Pure buffer → ANSI rendering for the local compositor.
 *
 * The agent's output is parsed into a headless emulator; each frame we read its
 * screen into a `Frame` (rows of styled cells) and emit terminal output. To keep
 * fast output smooth we diff against the previous frame and only repaint rows
 * that changed. Positioning uses absolute cursor moves + clear-to-EOL only — no
 * DEC save/restore or scroll tricks — which we know renders reliably even on the
 * finicky terminals that broke earlier overlay code.
 */

const ESC = '\x1b';

/** A single rendered cell: its character and its SGR parameter string ('' = default). */
export interface Cell {
  ch: string;
  sgr: string;
}

/** A full screen frame: `rows` arrays of `cols` cells. */
export type Frame = Cell[][];

const BLANK: Cell = { ch: ' ', sgr: '' };

/** True when two cells render identically. */
function cellEq(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && a.sgr === b.sgr;
}

/** True when two rows render identically. */
function rowEq(a: Cell[], b: Cell[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!cellEq(a[i], b[i])) return false;
  return true;
}

/** Emits one row as ANSI, minimising SGR changes; resets style at both ends. */
export function emitRow(cells: Cell[]): string {
  let out = `${ESC}[0m`;
  let cur = '';
  for (const cell of cells) {
    if (cell.sgr !== cur) {
      out += cell.sgr ? `${ESC}[${cell.sgr}m` : `${ESC}[0m`;
      cur = cell.sgr;
    }
    out += cell.ch || ' ';
  }
  return out + `${ESC}[0m`;
}

/**
 * Produces ANSI to turn `prev` into `next`, repainting only changed rows. `row0`
 * is the 1-based terminal row the frame's first line maps to (1 for a top-anchored
 * agent region). Each changed row is positioned absolutely, repainted, and
 * cleared to end of line. Returns '' when nothing changed.
 */
export function renderFrameDiff(prev: Frame | null, next: Frame, row0 = 1, col0 = 1): string {
  let out = '';
  for (let r = 0; r < next.length; r++) {
    if (prev && prev[r] && rowEq(prev[r], next[r])) continue;
    out += `${ESC}[${row0 + r};${col0}H` + emitRow(next[r]) + `${ESC}[0K`;
  }
  return out;
}

/** Builds a blank frame of the given size (used as the initial previous frame). */
export function blankFrame(cols: number, rows: number): Frame {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ...BLANK })));
}

/** An 8-bit-per-channel RGB colour. */
export type RGB = [number, number, number];

/** The terminal's foreground/background colours, used to blend a faded pane. */
export interface FadeColors {
  fg: RGB;
  bg: RGB;
}

/** How far each cell is pulled toward the background when faded (0 = none, 1 = gone). */
const FADE_AMOUNT = 0.55;

/** The xterm palette's first 16 (system) colours as RGB. */
const SYSTEM_COLORS: RGB[] = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/** Resolves an xterm 256-colour palette index to RGB. */
function paletteRgb(n: number): RGB {
  if (n < 16) return SYSTEM_COLORS[n];
  if (n >= 232) {
    const v = 8 + 10 * (n - 232); // 24-step greyscale ramp
    return [v, v, v];
  }
  const i = n - 16; // 6×6×6 colour cube
  return [CUBE_STEPS[Math.floor(i / 36) % 6], CUBE_STEPS[Math.floor(i / 6) % 6], CUBE_STEPS[i % 6]];
}

/** Linearly blends `c` toward `bg` by `amount` (0 keeps `c`, 1 becomes `bg`). */
function towardBg(c: RGB, bg: RGB, amount: number): RGB {
  return [
    Math.round(c[0] + (bg[0] - c[0]) * amount),
    Math.round(c[1] + (bg[1] - c[1]) * amount),
    Math.round(c[2] + (bg[2] - c[2]) * amount),
  ];
}

/** Mutable SGR state: active single-number attributes plus explicit fg/bg. */
interface FadeStyle {
  attrs: string[];
  fg: RGB | null;
  bg: RGB | null;
}

const num = (s: string | undefined): number => (s ? parseInt(s, 10) || 0 : 0);

/** Applies one SGR parameter list (the digits inside `ESC[…m`) to `s` in place. */
function applySgr(params: string, s: FadeStyle): void {
  const p = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '0') {
      s.attrs.length = 0;
      s.fg = null;
      s.bg = null;
    } else if (c === '22') {
      s.attrs = s.attrs.filter((a) => a !== '1' && a !== '2');
    } else if (c === '23' || c === '24' || c === '27' || c === '28' || c === '29') {
      const off = String(Number(c) - 20); // 23→3, 24→4, 27→7, …
      s.attrs = s.attrs.filter((a) => a !== off);
    } else if (c === '39') {
      s.fg = null;
    } else if (c === '49') {
      s.bg = null;
    } else if (c === '38' || c === '48') {
      const isFg = c === '38';
      if (p[i + 1] === '2') {
        const rgb: RGB = [num(p[i + 2]), num(p[i + 3]), num(p[i + 4])];
        if (isFg) s.fg = rgb;
        else s.bg = rgb;
        i += 4;
      } else if (p[i + 1] === '5') {
        const rgb = paletteRgb(num(p[i + 2]));
        if (isFg) s.fg = rgb;
        else s.bg = rgb;
        i += 2;
      }
    } else if (c === '1' || c === '2' || c === '3' || c === '4' || c === '7' || c === '8' || c === '9') {
      if (!s.attrs.includes(c)) s.attrs.push(c);
    }
  }
}

/**
 * Turns an SGR `style` into a faded SGR string: the shown colours (accounting for
 * inverse video) are each blended toward the terminal background, so foreground
 * *and* background fade by the same amount — a uniform, perceptually even fade,
 * unlike SGR "faint". Bold/faint are dropped so they can't re-brighten, and
 * inverse is resolved into explicit colours. `isSpace` marks a run that paints no
 * glyph; with no background it renders nothing, so it's left untouched ('').
 */
function fadedSgr(s: FadeStyle, colors: FadeColors, amount: number, isSpace: boolean): string {
  const inverse = s.attrs.includes('7');
  const dispFg = inverse ? s.bg ?? colors.bg : s.fg ?? colors.fg;
  const dispBg = inverse ? s.fg ?? colors.fg : s.bg; // null → keep the default background
  if (isSpace && dispBg === null) return '';
  const outFg = towardBg(dispFg, colors.bg, amount);
  const keep = s.attrs.filter((a) => a !== '1' && a !== '2' && a !== '7');
  const out = [...keep, '38', '2', ...outFg.map(String)];
  if (dispBg !== null) out.push('48', '2', ...towardBg(dispBg, colors.bg, amount).map(String));
  return out.join(';');
}

/** Parses a `cellSgr` string into an SGR style (attributes first, then colours). */
function styleFromSgr(sgr: string): FadeStyle {
  const s: FadeStyle = { attrs: [], fg: null, bg: null };
  if (sgr) applySgr(sgr, s);
  return s;
}

/**
 * Returns a faded copy of `frame`: every cell's colours are blended toward the
 * terminal background so the pane recedes evenly when it's the inactive one.
 * Unlike SGR faint this fades foreground *and* background uniformly.
 */
export function fadeFrame(frame: Frame, colors: FadeColors, amount = FADE_AMOUNT): Frame {
  return frame.map((row) =>
    row.map((cell) => ({
      ch: cell.ch,
      sgr: fadedSgr(styleFromSgr(cell.sgr), colors, amount, cell.ch === ' ' || cell.ch === ''),
    })),
  );
}

const SGR_SEQ = /\x1b\[([0-9;]*)m/y;

/**
 * Fades a styled ANSI *line* (text with embedded `ESC[…m` SGR sequences) the same
 * way `fadeFrame` fades cells: it tracks SGR state across the line and re-emits
 * each text run with its colours blended toward the background. Used to fade the
 * sidebar band — which is composed as lines, not cells — so it recedes exactly
 * like the content pane instead of relying on bold/faint. Non-SGR escapes and the
 * literal characters (so column width) are preserved.
 */
export function fadeAnsiLine(line: string, colors: FadeColors, amount = FADE_AMOUNT): string {
  const s: FadeStyle = { attrs: [], fg: null, bg: null };
  let out = '';
  let runStart = 0;
  let i = 0;
  const flush = (end: number): void => {
    if (end <= runStart) return;
    const text = line.slice(runStart, end);
    const sgr = fadedSgr(s, colors, amount, /^ *$/.test(text));
    out += sgr ? `\x1b[0m\x1b[${sgr}m${text}` : `\x1b[0m${text}`;
  };
  while (i < line.length) {
    if (line[i] === '\x1b') {
      SGR_SEQ.lastIndex = i;
      const m = SGR_SEQ.exec(line);
      if (m) {
        flush(i);
        applySgr(m[1], s);
        i = SGR_SEQ.lastIndex;
        runStart = i;
        continue;
      }
    }
    i++;
  }
  flush(i);
  return out + '\x1b[0m';
}

/**
 * Parses an OSC 10/11 colour reply (`…rgb:RRRR/GGGG/BBBB…`, 1–4 hex digits per
 * channel) into RGB, or null if it doesn't match. Used to learn the real
 * terminal fg/bg for the fade blend.
 */
export function rgbFromOsc(osc: string): RGB | null {
  const m = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(osc);
  if (!m) return null;
  const scale = (h: string): number => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255);
  return [scale(m[1]), scale(m[2]), scale(m[3])];
}

/** A blank frame with `text` centered (dimmed) — used for "connecting…" notices. */
export function placeholderFrame(text: string, cols: number, rows: number): Frame {
  const frame = blankFrame(cols, rows);
  const chars = [...text].slice(0, cols);
  const row = Math.floor((rows - 1) / 2);
  const col0 = Math.max(0, Math.floor((cols - chars.length) / 2));
  for (let i = 0; i < chars.length; i++) frame[row][col0 + i] = { ch: chars[i], sgr: '2' };
  return frame;
}

/**
 * Minimal subset of xterm's IBufferCell that we read. Declared locally so this
 * module needs no xterm type import (and so the adapter is easy to fake in tests).
 */
export interface BufferCell {
  getChars(): string;
  getWidth(): number;
  isFgRGB(): number | boolean;
  isBgRGB(): number | boolean;
  isFgPalette(): number | boolean;
  isBgPalette(): number | boolean;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number | boolean;
  isDim(): number | boolean;
  isItalic(): number | boolean;
  isUnderline(): number | boolean;
  isInverse(): number | boolean;
  isInvisible(): number | boolean;
  isStrikethrough(): number | boolean;
}

/** Builds the SGR parameter string for a cell ('' when fully default). */
export function cellSgr(cell: BufferCell): string {
  const p: number[] = [];
  if (cell.isBold()) p.push(1);
  if (cell.isDim()) p.push(2);
  if (cell.isItalic()) p.push(3);
  if (cell.isUnderline()) p.push(4);
  if (cell.isInverse()) p.push(7);
  if (cell.isInvisible()) p.push(8);
  if (cell.isStrikethrough()) p.push(9);
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isFgPalette()) {
    p.push(38, 5, cell.getFgColor());
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    p.push(48, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isBgPalette()) {
    p.push(48, 5, cell.getBgColor());
  }
  return p.join(';');
}

/**
 * A minimal view of an xterm BufferLine: `getCell(x, cell?)` reuse pattern.
 * `length` is the column count.
 */
export interface BufferLine {
  readonly length: number;
  getCell(x: number, cell?: BufferCell): BufferCell | undefined;
}

/** A minimal view of an xterm active buffer addressable by absolute line index. */
export interface BufferView {
  getLine(y: number): BufferLine | undefined;
}

/**
 * Reads `rows` lines starting at absolute line `top` from an xterm buffer into a
 * `Frame`. Wide-character trailing cells (width 0) are skipped; empty cells
 * become spaces. Missing lines render as blanks.
 */
export function frameFromBuffer(buf: BufferView, top: number, cols: number, rows: number): Frame {
  const frame: Frame = [];
  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(top + r);
    const row: Cell[] = [];
    if (!line) {
      for (let c = 0; c < cols; c++) row.push({ ...BLANK });
      frame.push(row);
      continue;
    }
    // Track *visual* columns: a wide glyph is one cell occupying two columns,
    // and its trailing half is a width-0 cell we skip. Padding/stopping by
    // visual width (not cell count) keeps every row exactly `cols` columns wide
    // so it never overruns and wraps.
    let vis = 0;
    for (let c = 0; c < cols && vis < cols; c++) {
      const cell = line.getCell(c);
      if (!cell) {
        row.push({ ...BLANK });
        vis += 1;
        continue;
      }
      const w = cell.getWidth();
      if (w === 0) continue; // trailing half of a wide glyph
      if (vis + w > cols) break; // a wide glyph that would overflow the last col
      const ch = cell.getChars();
      row.push({ ch: ch === '' ? ' ' : ch, sgr: cellSgr(cell) });
      vis += w;
    }
    while (vis < cols) {
      row.push({ ...BLANK });
      vis += 1;
    }
    frame.push(row);
  }
  return frame;
}
