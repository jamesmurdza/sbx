/**
 * Interactive session lifecycle. The agent runs inside a tmux session in the
 * sandbox; tmux draws the status bar natively. Locally we are a PTY passthrough:
 * stdin -> sandbox, sandbox -> stdout, plus resize forwarding.
 *
 * Pressing Ctrl-\ does NOT go to the agent — teleport intercepts it locally and
 * opens a sandbox menu (Switch / Detach / Stop / Delete). Switch and Detach
 * leave tmux running; Stop/Delete are performed by the caller after the attach
 * returns. Switch additionally tells the caller to return to the sandbox picker.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { TMUX_CONF_PATH, TMUX_SESSION, TMUX_STATUS_FILE } from './config.js';
import { ensureTmux, sandboxHome, writeFileAbs } from './sandbox-ops.js';
import { tmuxConf, type BarInfo } from './tui/tmux.js';
import { overlayMenu } from './tui/overlay.js';

const ESC = '\x1b';
/** Ctrl-\ (FS, 0x1c) — the key that opens the teleport sandbox menu. */
const MENU_KEY = 0x1c;

export interface AttachOptions {
  /** Command to run under tmux when the session does not already exist. */
  command: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Env vars injected into the agent session (e.g. API keys). */
  env?: Record<string, string>;
  /** Static fields shown in the tmux status bar. */
  bar: BarInfo;
}

/**
 * How an attach ended. 'switch'/'detached'/'ended' leave the sandbox running;
 * 'stopped' and 'deleted' tell the caller to stop or delete the sandbox.
 * 'switch' additionally tells the caller to return to the sandbox picker.
 */
export type AttachOutcome = 'switch' | 'detached' | 'ended' | 'stopped' | 'deleted';

/** True when a stdin chunk is exactly the menu trigger (Ctrl-\). */
export function isMenuTrigger(chunk: Buffer): boolean {
  return chunk.length === 1 && chunk[0] === MENU_KEY;
}

/** Single-quotes a string for safe use in a POSIX shell command. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Attaches the local terminal to the sandbox session. Resolves on detach/exit. */
export async function attach(sandbox: Sandbox, opts: AttachOptions): Promise<AttachOutcome> {
  await ensureTmux(sandbox);

  // Write the tmux config and initialise the live-status file.
  await writeFileAbs(sandbox, TMUX_CONF_PATH, tmuxConf(opts.bar), '644');
  await sandbox.process.executeCommand(`: > ${TMUX_STATUS_FILE}`).catch(() => {});

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const sessionId = `teleport-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // A UTF-8 locale + the real TERM are essential for tmux to render wide/Unicode
  // characters (box-drawing, emoji) and accept multibyte input correctly. Use
  // C.UTF-8 (always present in glibc) rather than forwarding the host locale,
  // which the sandbox may not have generated (causing setlocale warnings).
  const localeLang = 'C.UTF-8';
  const envs: Record<string, string> = {
    // Pin HOME to the dir we wrote credentials into, so the agent reads them
    // from the same place even if the interactive shell would default elsewhere.
    HOME: await sandboxHome(sandbox),
    LANG: localeLang,
    LC_ALL: localeLang,
    LC_CTYPE: localeLang,
    TERM: process.env.TERM || 'xterm-256color',
    ...opts.env,
  };

  // While the menu is open we suppress agent output (it would scribble over the
  // menu) and force a full tmux repaint when we resume.
  let menuOpen = false;

  const pty = await sandbox.process.createPty({
    id: sessionId,
    cwd: opts.cwd,
    envs,
    cols,
    rows,
    onData: (data: Uint8Array) => {
      if (!menuOpen) process.stdout.write(Buffer.from(data));
    },
  });

  if (typeof (pty as { waitForConnection?: () => Promise<void> }).waitForConnection === 'function') {
    await pty.waitForConnection();
  }

  // exec so that when tmux detaches/exits the PTY closes and pty.wait() resolves.
  // -u forces tmux into UTF-8 mode regardless of how it detects the locale.
  const cwdArg = opts.cwd ? `-c ${shquote(opts.cwd)}` : '';
  const cmd =
    `exec tmux -u -f ${TMUX_CONF_PATH} new-session -A -s ${TMUX_SESSION} ${cwdArg} ` +
    `${shquote(opts.command)}\n`;
  await pty.sendInput(cmd);

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();

  // The action requested via the menu (stop/delete/detach), if any.
  let pendingAction: AttachOutcome | null = null;

  /** Forces tmux to fully repaint the screen (after the menu closes). */
  const forceRepaint = async () => {
    const c = process.stdout.columns ?? 80;
    const r = process.stdout.rows ?? 24;
    process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`);
    await pty.resize(c, Math.max(1, r - 1)).catch(() => {});
    await new Promise((res) => setTimeout(res, 40));
    await pty.resize(c, r).catch(() => {});
  };

  /** Shows the centered sandbox menu and returns the action, or null to resume. */
  const openMenu = async (): Promise<AttachOutcome | null> => {
    const choice = await overlayMenu('teleport — sandbox menu', [
      { label: 'Switch sandbox', value: 'switch' as const },
      { label: 'Detach and exit', value: 'detached' as const },
      { label: 'Stop sandbox and exit', value: 'stopped' as const },
      { label: 'Delete sandbox and exit', value: 'deleted' as const },
    ]);
    if (choice === 'switch' || choice === 'detached' || choice === 'stopped' || choice === 'deleted')
      return choice;
    return null;
  };

  const onStdin = (chunk: Buffer) => {
    if (menuOpen) return;
    if (isMenuTrigger(chunk)) {
      void handleMenu();
      return;
    }
    void pty.sendInput(chunk);
  };

  const handleMenu = async () => {
    if (menuOpen) return;
    menuOpen = true;
    stdin.off('data', onStdin); // let the overlay own stdin while the menu is up
    let action: AttachOutcome | null = null;
    try {
      action = await openMenu();
    } catch {
      action = null;
    }
    menuOpen = false;
    stdin.on('data', onStdin);
    stdin.resume();
    if (action) {
      pendingAction = action;
      // Detach the client so pty.wait() resolves; the caller performs stop/delete.
      await sandbox.process.executeCommand(`tmux detach-client -s ${TMUX_SESSION}`).catch(() => {});
    } else {
      await forceRepaint();
    }
  };

  const onResize = () => {
    if (!menuOpen) void pty.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  };
  stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);

  try {
    await pty.wait();
  } finally {
    stdin.off('data', onStdin);
    process.stdout.off('resize', onResize);
    if (stdin.setRawMode) stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stdout.write(`${ESC}[?25h`); // ensure cursor visible
    await pty.disconnect().catch(() => {});
  }

  if (pendingAction) return pendingAction;

  // No explicit action: detached if the tmux session still exists, else ended.
  const alive = await sandbox.process
    .executeCommand(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null && echo alive || true`)
    .then((r) => (r.result ?? '').includes('alive'))
    .catch(() => false);

  return alive ? 'detached' : 'ended';
}

/** Updates the live status text shown on the right of the tmux status bar. */
export async function setLiveStatus(sandbox: Sandbox, text: string): Promise<void> {
  const safe = text.replace(/'/g, `'\\''`);
  await sandbox.process.executeCommand(`printf '%s' '${safe}' > ${TMUX_STATUS_FILE}`).catch(() => {});
}
