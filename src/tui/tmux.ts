/**
 * Builds the tmux configuration that renders the teleport status bar. tmux owns
 * the screen, so the bar is drawn natively and can never be corrupted by the
 * agent's output (unlike a client-side overlay). Static fields (sandbox id,
 * agent, repo, branch) are baked into the config; live push status is read from
 * a file the status line `cat`s every couple of seconds.
 */
import { TMUX_STATUS_FILE } from '../config.js';

export interface BarInfo {
  shortId: string;
  agent: string;
  repo?: string;
  branch?: string;
}

/** Escapes a value for safe inclusion inside a double-quoted tmux option. */
function esc(v: string): string {
  return v.replace(/[\\"$#]/g, '\\$&');
}

/**
 * Reduces a teleport working branch to the human base branch for display.
 * `teleport/<base>/<sandbox-id>` -> `<base>` (the id is already shown on the
 * left of the bar, and the `teleport/` prefix is constant). Other branch names
 * are shown unchanged.
 */
export function displayBranch(branch: string): string {
  if (!branch.startsWith('teleport/')) return branch;
  return branch.slice('teleport/'.length).replace(/\/[0-9a-f]{6,}$/i, '');
}

/** Returns the tmux.conf contents for a session. */
export function tmuxConf(info: BarInfo): string {
  const left = ` ⚡ ${info.shortId}  ${info.agent} `;
  const rightParts = [
    info.repo ? esc(info.repo) : '',
    info.branch ? `↟ ${esc(displayBranch(info.branch))}` : '',
    `#(cat ${TMUX_STATUS_FILE} 2>/dev/null)`,
    'Ctrl-\\\\ menu',
  ].filter(Boolean);
  const right = ' ' + rightParts.join('  ·  ') + ' ';

  return [
    // Terminal capabilities: 256 colours + truecolor passthrough so the agent's
    // colours and Unicode render correctly inside tmux.
    'set -g default-terminal "screen-256color"',
    'set -ga terminal-overrides ",*256col*:Tc"',
    'set -g status on',
    'set -g status-interval 2',
    'set -g status-justify left',
    'set -g status-position bottom',
    'set -g status-style "bg=colour24,fg=colour255"',
    `set -g status-left "#[bold]${esc(left)}#[nobold]"`,
    'set -g status-left-length 80',
    `set -g status-right "${right}"`,
    'set -g status-right-length 200',
    'set -g window-status-current-format ""',
    'set -g window-status-format ""',
    'set -g destroy-unattached off',
    // Ctrl-\ is intentionally NOT bound here: teleport intercepts it locally to
    // open its session menu (Detach / Stop / Delete / Cancel).
    '',
  ].join('\n');
}

/** Shell-escapes status text and returns a command to update the status file. */
export function writeStatusCommand(text: string): string {
  const safe = text.replace(/'/g, `'\\''`);
  return `printf '%s' '${safe}' > ${TMUX_STATUS_FILE}`;
}
