/**
 * Local status bar, drawn by sbx itself on the bottom row of the screen.
 *
 * Under the local-compositor model sbx owns the terminal grid (the agent is
 * rendered from a headless emulator into rows 1..rows-1), so the bar is just an
 * ANSI line we paint on the last row from data we already have locally. This
 * replaces the previous approach where a tmux instance *inside the sandbox* drew
 * the bar and read live status from a pushed file.
 */

const ESC = '\x1b';

export interface BarInfo {
  shortId: string;
  agent: string;
  repo?: string;
  branch?: string;
}

/** Approximate display width (treats each code point as one column). */
export function width(s: string): number {
  return [...s].length;
}

/** Truncates to at most `w` columns (code points). */
function truncate(s: string, w: number): string {
  return width(s) > w ? [...s].slice(0, Math.max(0, w)).join('') : s;
}

/**
 * Reduces a sbx working branch to the human base branch for display.
 * `sbx/<base>/<sandbox-id>` -> `<base>` (the id is already shown on the
 * left of the bar). Other branch names are shown unchanged.
 */
export function displayBranch(branch: string): string {
  if (!branch.startsWith('sbx/')) return branch;
  return branch.slice('sbx/'.length).replace(/\/[0-9a-f]{6,}$/i, '');
}

/** The plain (un-styled) left and right segments of the bar. */
export function statusSegments(info: BarInfo): { left: string; right: string } {
  const left = `⚡ ${info.shortId}  ${info.agent}`;
  const right = [info.branch ? `↟ ${displayBranch(info.branch)}` : '', 'Ctrl-] sidebar']
    .filter(Boolean)
    .join('  ·  ');
  return { left, right };
}

/**
 * Lays out `left` and `right` into a single line exactly `cols` columns wide:
 * left-justified left segment, right-justified right segment, padded with
 * spaces between. When space is tight the right segment is dropped before the
 * left is truncated, so the sandbox id always stays visible.
 */
export function layoutBar(left: string, right: string, cols: number): string {
  if (cols <= 0) return '';
  const padded = ` ${left} `;
  const rightPadded = right ? ` ${right} ` : '';
  // Enough room for both with at least one space of gap?
  if (width(padded) + width(rightPadded) + 1 <= cols) {
    const gap = cols - width(padded) - width(rightPadded);
    return padded + ' '.repeat(gap) + rightPadded;
  }
  // Otherwise keep the left segment and fill the rest with spaces.
  const leftOnly = truncate(padded, cols);
  return leftOnly + ' '.repeat(Math.max(0, cols - width(leftOnly)));
}

/**
 * Renders the full status-bar line, padded/truncated to `cols`, as black text on
 * the terminal's green (unless `color` is false). Using the palette's green
 * (ANSI colour 2) rather than a hardcoded RGB keeps the bar in step with the
 * terminal theme. The returned string has no trailing newline; the caller
 * positions it.
 */
export function renderStatusBar(info: BarInfo, cols: number, opts: { color?: boolean } = {}): string {
  const { left, right } = statusSegments(info);
  const line = layoutBar(left, right, cols);
  if (opts.color === false) return line;
  return `${ESC}[30;42m${line}${ESC}[0m`;
}
