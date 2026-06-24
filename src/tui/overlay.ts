/**
 * A centered modal overlay menu: draws a bordered box in the middle of the
 * terminal, on top of whatever is already on screen, and lets the user pick with
 * arrow keys. Used for the in-session Ctrl-\ menu so it floats over the agent
 * rather than clearing the screen. The caller repaints the underlying app after
 * the overlay closes.
 */
import { decodeKey } from './prompt.js';

const ESC = '\x1b';
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export interface OverlayItem<T> {
  label: string;
  value: T;
}

/** Approximate display width (treats each code point as one column). */
function width(s: string): number {
  return [...s].length;
}

function padTo(s: string, w: number): string {
  const pad = w - width(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export interface BoxGeometry {
  innerWidth: number;
  width: number;
  height: number;
  startRow: number;
  startCol: number;
}

/** Computes a centered box big enough for the title, items, and hint. */
export function computeBox(
  title: string,
  labels: string[],
  cols: number,
  rows: number,
  hint: string,
): BoxGeometry {
  const contentW = Math.max(
    width(title) + 2,
    ...labels.map((l) => width(l) + 4),
    width(hint) + 2,
    20,
  );
  const innerWidth = Math.min(contentW, Math.max(8, cols - 4));
  const boxWidth = innerWidth + 2;
  const height = labels.length + 3; // top + items + hint + bottom
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2) + 1);
  const startRow = Math.max(1, Math.floor((rows - height) / 2) + 1);
  return { innerWidth, width: boxWidth, height, startRow, startCol };
}

/** Shows a centered menu; resolves to the chosen value, or null if cancelled. */
export async function overlayMenu<T>(title: string, items: OverlayItem<T>[]): Promise<T | null> {
  const stdin = process.stdin;
  if (items.length === 0) return null;
  if (!stdin.isTTY || !stdin.setRawMode) return null;

  const hint = '↑/↓ move · Enter select · Esc cancel';
  let index = 0;

  const draw = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const g = computeBox(title, items.map((i) => i.label), cols, rows, hint);
    const at = (r: number, c: number) => `${ESC}[${r};${c}H`;
    const lines: string[] = [];

    // Top border with embedded title.
    const titleSeg = `${BOX.h} ${title} `;
    lines.push(BOX.tl + padTo(titleSeg, g.innerWidth).replace(/ +$/g, (m) => BOX.h.repeat(m.length)) + BOX.tr);

    // Item rows.
    items.forEach((it, i) => {
      const selected = i === index;
      const marker = selected ? '❯' : ' ';
      let inner = padTo(` ${marker} ${it.label}`, g.innerWidth);
      if (width(inner) > g.innerWidth) inner = [...inner].slice(0, g.innerWidth).join('');
      const body = selected ? `${ESC}[7m${inner}${ESC}[0m` : inner;
      lines.push(BOX.v + body + BOX.v);
    });

    // Hint row + bottom border.
    lines.push(BOX.v + `${ESC}[2m` + padTo(` ${hint}`, g.innerWidth) + `${ESC}[0m` + BOX.v);
    lines.push(BOX.bl + BOX.h.repeat(g.innerWidth) + BOX.br);

    let out = `${ESC}7`; // save cursor
    lines.forEach((l, i) => {
      out += at(g.startRow + i, g.startCol) + l;
    });
    out += `${ESC}8`; // restore cursor
    process.stdout.write(out);
  };

  process.stdout.write(`${ESC}[?25l${ESC}[?7l`); // hide cursor; disable autowrap
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  draw();

  return new Promise<T | null>((resolve) => {
    const cleanup = (result: T | null) => {
      stdin.off('data', onData);
      stdin.setRawMode!(wasRaw);
      process.stdout.write(`${ESC}[?25h${ESC}[?7h`); // show cursor; restore autowrap
      resolve(result);
    };
    const onData = (data: Buffer) => {
      switch (decodeKey(data)) {
        case 'up':
          index = (index - 1 + items.length) % items.length;
          draw();
          break;
        case 'down':
          index = (index + 1) % items.length;
          draw();
          break;
        case 'enter':
          cleanup(items[index].value);
          break;
        case 'cancel':
          cleanup(null);
          break;
        default:
          break;
      }
    };
    stdin.on('data', onData);
  });
}
