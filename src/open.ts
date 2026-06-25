/**
 * Opens a URL in the user's default browser (best-effort, cross-platform).
 * teleport runs locally, so this launches the local browser.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export function openUrl(url: string): void {
  try {
    const os = platform();
    const cmd = os === 'darwin' ? 'open' : os === 'win32' ? 'cmd' : 'xdg-open';
    const args = os === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best effort — never throw into the UI */
  }
}

/** GitHub web URL for a repo slug (owner/name) + branch, or null if incomplete. */
export function githubBranchUrl(repo?: string, branch?: string): string | null {
  if (!repo || !branch) return null;
  return `https://github.com/${repo}/tree/${branch}`;
}
