/**
 * The collapsible sandbox sidebar, drawn on the left column band by the
 * compositor. Like the status bar this is local chrome rendered from local data
 * (`listSessions()`), so it needs nothing pushed into the sandbox. Pure and
 * unit-testable: it maps a list of items + a selection into styled ANSI lines,
 * each exactly `width` visual columns (content + a right separator column).
 */
import { width } from './statusbar.js';

const ESC = '\x1b';
const SEP = '│';

export interface SidebarItem {
  /** Full sandbox id (used to reconnect); displayed shortened. */
  id: string;
  /** Agent/command name. */
  agent: string;
  /** Sandbox state (e.g. started/stopped). */
  state: string;
  /** True for the sandbox currently attached. */
  current: boolean;
  /** Repo slug (owner/name), if any — for the info panel and the GitHub link. */
  repo?: string;
  /** Working branch, if any. */
  branch?: string;
  /** ISO creation timestamp, if known. */
  createdAt?: string;
}

/** Default width (columns) of the sidebar band when open. */
export const SIDEBAR_WIDTH = 26;
/** Minimum columns the agent must keep; the sidebar shrinks/hides below this. */
export const MIN_AGENT_COLS = 24;

function truncate(s: string, w: number): string {
  return width(s) > w ? [...s].slice(0, Math.max(0, w)).join('') : s;
}

function padTrunc(s: string, w: number): string {
  const t = truncate(s, w);
  return t + ' '.repeat(Math.max(0, w - width(t)));
}

/**
 * Chooses the first visible item index so `selected` stays in view when there
 * are more items than rows.
 */
export function windowStart(selected: number, count: number, rows: number): number {
  if (count <= rows) return 0;
  const half = Math.floor(rows / 2);
  return Math.max(0, Math.min(selected - half, count - rows));
}

/** How many footer rows actually fit (the legend can be multiple lines). */
function footerCount(height: number, footer: string[]): number {
  if (footer.length === 0) return 0;
  return Math.min(footer.length, Math.max(0, height - 1));
}

/**
 * The title row: " SANDBOXES" on the left and an optional focus-direction hint
 * (e.g. a single "→"/"←" arrow) right-justified, so the two-pane focus affordance
 * is always visible. Falls back to just the title when there isn't room.
 */
function titleRow(inner: number, hint: string): string {
  const left = ' SANDBOXES';
  const right = hint ? `${hint} ` : '';
  if (width(left) + width(right) + 1 <= inner) {
    return left + ' '.repeat(inner - width(left) - width(right)) + right;
  }
  return padTrunc(left, inner);
}

/** The plain (un-styled) sidebar lines — used for layout tests. */
export function sidebarLines(
  items: SidebarItem[],
  selected: number,
  width: number,
  height: number,
  footer: string[] = [],
  tabHint = '',
): string[] {
  const inner = Math.max(1, width - 1); // last column is the separator
  const fc = footerCount(height, footer);
  const lines: string[] = [titleRow(inner, tabHint) + SEP];
  const rows = Math.max(0, height - 1 - fc);
  const start = windowStart(selected, items.length, rows);
  for (let i = 0; i < rows; i++) {
    const idx = start + i;
    if (idx >= items.length) {
      lines.push(' '.repeat(inner) + SEP);
      continue;
    }
    const it = items[idx];
    const cursor = idx === selected ? '❯' : ' ';
    lines.push(padTrunc(`${cursor} ${it.id.slice(0, 8)}  ${it.agent}`, inner) + SEP);
  }
  for (let i = 0; i < fc; i++) lines.push(padTrunc(` ${footer[i]}`, inner) + SEP);
  return lines.slice(0, height);
}

/**
 * Renders the sidebar as styled ANSI lines. When `focused` (the sidebar pane has
 * keyboard focus) the title is bold and the selected row is inverse; when the
 * agent pane has focus instead, the title is dimmed and the selection is only
 * bold — a clear "this pane is inactive" look while it stays visible. Other rows
 * and the footer are dimmed. With `color:false` it returns the same text without
 * SGR (for tests).
 */
export function renderSidebar(
  items: SidebarItem[],
  selected: number,
  width: number,
  height: number,
  footer: string[] = [],
  opts: { color?: boolean; focused?: boolean; tabHint?: string } = {},
): string[] {
  const focused = opts.focused ?? true;
  const plain = sidebarLines(items, selected, width, height, footer, opts.tabHint ?? '');
  if (opts.color === false) return plain;
  const fc = footerCount(height, footer);
  const rows = Math.max(0, height - 1 - fc);
  const start = windowStart(selected, items.length, rows);
  const firstFooter = plain.length - fc;
  return plain.map((line, i) => {
    const body = line.slice(0, -1); // strip the separator char before styling
    const sep = `${ESC}[2m${SEP}${ESC}[22m`;
    if (i === 0) return `${ESC}[${focused ? 1 : 2}m${body}${ESC}[22m${sep}`;
    if (fc > 0 && i >= firstFooter) return `${ESC}[2m${body}${ESC}[22m${sep}`;
    const idx = start + (i - 1);
    const it = items[idx];
    if (idx === selected && it) {
      // Inverse when the sidebar is focused; bold (still visible) when not.
      return focused ? `${ESC}[7m${body}${ESC}[27m${sep}` : `${ESC}[1m${body}${ESC}[22m${sep}`;
    }
    if (it) return `${ESC}[2m${body}${ESC}[22m${sep}`; // non-selected rows are dimmed
    return body + sep;
  });
}
