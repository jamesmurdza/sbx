/**
 * Local status bar, drawn by teleport itself on the bottom row of the screen.
 *
 * Under the local-compositor model teleport owns the terminal grid (the agent is
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
 * Reduces a teleport working branch to the human base branch for display.
 * `teleport/<base>/<sandbox-id>` -> `<base>` (the id is already shown on the
 * left of the bar). Other branch names are shown unchanged.
 */
export function displayBranch(branch: string): string {
  if (!branch.startsWith('teleport/')) return branch;
  return branch.slice('teleport/'.length).replace(/\/[0-9a-f]{6,}$/i, '');
}

/** The plain (un-styled) left and right segments of the bar. */
export function statusSegments(info: BarInfo, live: string): { left: string; right: string } {
  const left = `⚡ ${info.shortId}  ${info.agent}`;
  const right = [
    info.repo ?? '',
    info.branch ? `↟ ${displayBranch(info.branch)}` : '',
    live.trim(),
    'Ctrl-\\ menu',
  ]
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
 * Renders the full status-bar line, padded/truncated to `cols`, wrapped in SGR
 * (blue background, bright foreground, bold id) unless `color` is false. The
 * returned string contains no trailing newline; the caller positions it.
 */
export function renderStatusBar(
  info: BarInfo,
  live: string,
  cols: number,
  opts: { color?: boolean } = {},
): string {
  const { left, right } = statusSegments(info, live);
  const line = layoutBar(left, right, cols);
  if (opts.color === false) return line;
  // bg=blue(24) fg=white(255); reset at end.
  return `${ESC}[48;5;24m${ESC}[38;5;255m${line}${ESC}[0m`;
}
