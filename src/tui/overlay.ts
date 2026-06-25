/**
 * A centered modal overlay menu: draws a bordered box in the middle of the
 * terminal and lets the user pick with arrow keys.
 *
 * Two modes:
 *  - overlay (default): drawn on top of whatever is on screen (used for the
 *    in-session Ctrl-\ menu, floating over the agent). The caller repaints after.
 *  - fullscreen: switches to the alternate screen first so the box appears on a
 *    clean background; the previous screen is restored exactly on close (used for
 *    the startup credential modal, session picker, and confirmations).
 */
import { decodeKey } from './prompt.js';

const ESC = '\x1b';
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export interface OverlayItem<T> {
  label: string;
  detail?: string;
  value: T;
}

export interface OverlayOptions<T = unknown> {
  /** Use the alternate screen so the box shows on a clean, restorable background. */
  fullscreen?: boolean;
  /**
   * When set, Ctrl-D on the highlighted item invokes this handler. Returning
   * true removes the item from the list and keeps the menu open (used by the
   * session picker to delete a sandbox in place).
   */
  onDelete?: (item: OverlayItem<T>, index: number) => Promise<boolean>;
}

/** Approximate display width (treats each code point as one column). */
function width(s: string): number {
  return [...s].length;
}

function padTo(s: string, w: number): string {
  const pad = w - width(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

function truncate(s: string, w: number): string {
  return width(s) > w ? [...s].slice(0, w).join('') : s;
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
  lineWidths: number[],
  cols: number,
  rows: number,
  hint: string,
): BoxGeometry {
  const contentW = Math.max(width(title) + 2, ...lineWidths.map((w) => w + 4), width(hint) + 2, 20);
  const innerWidth = Math.min(contentW, Math.max(8, cols - 4));
  const boxWidth = innerWidth + 2;
  const height = lineWidths.length + 3; // top + items + hint + bottom
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2) + 1);
  const startRow = Math.max(1, Math.floor((rows - height) / 2) + 1);
  return { innerWidth, width: boxWidth, height, startRow, startCol };
}

/** Shows a centered menu; resolves to the chosen value, or null if cancelled. */
export async function overlayMenu<T>(
  title: string,
  items: OverlayItem<T>[],
  opts: OverlayOptions<T> = {},
): Promise<T | null> {
  const stdin = process.stdin;
  if (items.length === 0) return null;
  if (!stdin.isTTY || !stdin.setRawMode) return null;

  const list = items.slice(); // mutable copy so onDelete can remove items
  const baseHint = '↑/↓ move · Enter select · Esc cancel';
  let hint = opts.onDelete ? `${baseHint} · Ctrl-D delete` : baseHint;
  let index = 0;
  let busy = false;

  const draw = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const widths = list.map((it) => width(it.label) + (it.detail ? width(it.detail) + 2 : 0));
    const g = computeBox(title, widths, cols, rows, hint);
    const at = (r: number, c: number) => `${ESC}[${r};${c}H`;
    const lines: string[] = [];

    // Top border with embedded title.
    const titleSeg = `${BOX.h} ${title} `;
    lines.push(
      BOX.tl + padTo(titleSeg, g.innerWidth).replace(/ +$/g, (m) => BOX.h.repeat(m.length)) + BOX.tr,
    );

    // Item rows (label + optional dim detail), truncated to fit.
    list.forEach((it, i) => {
      const selected = i === index;
      const marker = selected ? '❯' : ' ';
      const text = truncate(`${marker} ${it.label}`, g.innerWidth - 1);
      let inner = ` ${text}`;
      if (it.detail) {
        const room = g.innerWidth - width(inner) - 2;
        if (room > 1) inner = padTo(inner, width(inner)) + `  ${ESC}[2m${truncate(it.detail, room)}${ESC}[22m`;
      }
      // Pad the visible part to innerWidth (ignoring the dim escape codes).
      const visibleLen = width(inner.replace(/\x1b\[[0-9;]*m/g, ''));
      const body = inner + ' '.repeat(Math.max(0, g.innerWidth - visibleLen));
      lines.push(BOX.v + (selected ? `${ESC}[7m${body}${ESC}[0m` : body) + BOX.v);
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

  // Enter alt-screen for fullscreen mode; always hide cursor + disable autowrap.
  process.stdout.write((opts.fullscreen ? `${ESC}[?1049h${ESC}[2J${ESC}[H` : '') + `${ESC}[?25l${ESC}[?7l`);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  draw();

  return new Promise<T | null>((resolve) => {
    const cleanup = (result: T | null) => {
      stdin.off('data', onData);
      stdin.setRawMode!(wasRaw);
      // Pause stdin so a resumed TTY does not keep the event loop alive after a
      // standalone menu closes (otherwise the process hangs instead of exiting).
      // In-session callers re-resume stdin immediately after.
      stdin.pause();
      // Restore previous screen (fullscreen), show cursor, restore autowrap.
      process.stdout.write(`${ESC}[?25h${ESC}[?7h` + (opts.fullscreen ? `${ESC}[?1049l` : ''));
      resolve(result);
    };
    const onData = (data: Buffer) => {
      if (busy) return;
      switch (decodeKey(data)) {
        case 'up':
          index = (index - 1 + list.length) % list.length;
          draw();
          break;
        case 'down':
          index = (index + 1) % list.length;
          draw();
          break;
        case 'enter':
          cleanup(list[index].value);
          break;
        case 'cancel':
          cleanup(null);
          break;
        case 'delete':
          if (opts.onDelete) void handleDelete();
          break;
        default:
          break;
      }
    };

    const handleDelete = async () => {
      busy = true;
      const savedHint = hint;
      hint = 'deleting…';
      draw();
      let removed = false;
      try {
        removed = await opts.onDelete!(list[index], index);
      } catch {
        removed = false;
      }
      hint = savedHint;
      if (removed) {
        list.splice(index, 1);
        if (list.length === 0) {
          cleanup(null);
          return;
        }
        if (index >= list.length) index = list.length - 1;
      }
      busy = false;
      draw();
    };

    stdin.on('data', onData);
  });
}

/** A centered Yes/No confirmation. */
export async function overlayConfirm(
  question: string,
  opts: OverlayOptions & { defaultYes?: boolean } = {},
): Promise<boolean> {
  if (!process.stdin.isTTY) return opts.defaultYes ?? false;
  const yes = { label: 'Yes', value: true };
  const no = { label: 'No', value: false };
  const items = opts.defaultYes ? [yes, no] : [no, yes];
  const result = await overlayMenu(question, items, opts);
  return result ?? false;
}
