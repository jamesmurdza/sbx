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
