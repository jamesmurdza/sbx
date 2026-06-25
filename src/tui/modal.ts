/**
 * A modal (menu or text prompt) rendered *inside the agent pane* of the
 * compositor — never over the sidebar or status bar. It produces a Frame for the
 * agent region, so the compositor's normal diff paints it and the sidebar stays
 * completely untouched (the whole point: things in the main view must not affect
 * the sidebar).
 */
import { blankFrame, type Cell, type Frame } from './render.js';

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export interface ModalMenuItem {
  label: string;
  detail?: string;
  value: unknown;
}

export type ModalState =
  | {
      kind: 'menu';
      title: string;
      items: ModalMenuItem[];
      selected: number;
      resolve: (v: unknown) => void;
    }
  | {
      kind: 'prompt';
      title: string;
      placeholder: string;
      value: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'info';
      title: string;
      lines: string[];
      resolve: () => void;
    };

function width(s: string): number {
  return [...s].length;
}

function truncate(s: string, w: number): string {
  return width(s) > w ? [...s].slice(0, Math.max(0, w)).join('') : s;
}

/** A row of exactly `w` cells from `text`, padded with spaces, all with `sgr`. */
function cells(text: string, w: number, sgr = ''): Cell[] {
  const row: Cell[] = [...truncate(text, w)].map((ch) => ({ ch, sgr }));
  while (row.length < w) row.push({ ch: ' ', sgr });
  return row;
}

function border(left: string, fill: string, right: string, innerWidth: number): Cell[] {
  const row: Cell[] = [{ ch: left, sgr: '' }];
  for (let i = 0; i < innerWidth; i++) row.push({ ch: fill, sgr: '' });
  row.push({ ch: right, sgr: '' });
  return row;
}

/** The box rows (each `innerWidth + 2` cells wide) for a modal. */
function boxRows(state: ModalState, innerWidth: number): Cell[][] {
  const rows: Cell[][] = [];

  // Top border with the title embedded (bold).
  const top: Cell[] = [{ ch: BOX.tl, sgr: '' }];
  const titleCells = [...` ${state.title} `].map((ch) => ({ ch, sgr: '1' }));
  for (let i = 0; i < innerWidth; i++) {
    top.push(i < titleCells.length ? titleCells[i] : { ch: BOX.h, sgr: '' });
  }
  top.push({ ch: BOX.tr, sgr: '' });
  rows.push(top);

  const content = (inner: Cell[]) => [{ ch: BOX.v, sgr: '' }, ...inner, { ch: BOX.v, sgr: '' }];

  if (state.kind === 'menu') {
    state.items.forEach((it, i) => {
      const sel = i === state.selected;
      const text = `${sel ? '❯ ' : '  '}${it.label}${it.detail ? `  ${it.detail}` : ''}`;
      rows.push(content(cells(` ${text}`, innerWidth, sel ? '7' : '')));
    });
    rows.push(content(cells(' ↑/↓ · Enter · Esc', innerWidth, '2')));
  } else if (state.kind === 'info') {
    for (const line of state.lines) rows.push(content(cells(` ${line}`, innerWidth)));
    rows.push(content(cells(' Esc to close', innerWidth, '2')));
  } else {
    const shown = state.value || state.placeholder;
    rows.push(content(cells(` ${shown}${state.value ? '█' : ''}`, innerWidth, state.value ? '' : '2')));
    rows.push(content(cells(' Enter submit · Esc cancel', innerWidth, '2')));
  }

  rows.push(border(BOX.bl, BOX.h, BOX.br, innerWidth));
  return rows;
}

/** Renders the modal as a Frame of `cols`×`rows` (the agent region), box centred. */
export function modalFrame(state: ModalState, cols: number, rows: number): Frame {
  const contentWidths =
    state.kind === 'menu'
      ? state.items.map((it) => width(it.label) + (it.detail ? width(it.detail) + 2 : 0) + 4)
      : state.kind === 'info'
        ? state.lines.map((l) => width(l) + 2)
        : [width(state.placeholder) + 2, 40];
  const innerWidth = Math.min(
    Math.max(width(state.title) + 2, ...contentWidths, 24),
    Math.max(8, cols - 4),
  );

  const box = boxRows(state, innerWidth);
  const frame = blankFrame(cols, rows);
  const top = Math.max(0, Math.floor((rows - box.length) / 2));
  const left = Math.max(0, Math.floor((cols - (innerWidth + 2)) / 2));
  for (let r = 0; r < box.length && top + r < rows; r++) {
    const line = box[r];
    for (let c = 0; c < line.length && left + c < cols; c++) frame[top + r][left + c] = line[c];
  }
  return frame;
}
