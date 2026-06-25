/**
 * Interactive session lifecycle.
 *
 * The agent runs in a *persistent Daytona PTY session* (a fixed id per sandbox).
 * Daytona keeps that PTY process alive server-side across client disconnects, so
 * detaching just drops the WebSocket and reconnecting re-attaches to the same
 * running agent — no in-sandbox tmux is involved.
 *
 * Locally teleport is a terminal compositor: PTY output is parsed into a headless
 * emulator and rendered to the screen, with teleport drawing its own status bar
 * on the bottom row and bridging mouse/scroll (see ./tui/compositor).
 *
 * Ctrl-\ (or Ctrl-]) is intercepted locally to toggle the sandbox sidebar — the
 * control center for switching between sandboxes and stopping/deleting/detaching
 * them. Stop/delete/detach of the *current* sandbox end the attach and are
 * carried out by the caller; actions on other sandboxes happen in place.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { PTY_SESSION_ID } from './config.js';
import { sandboxHome } from './sandbox-ops.js';
import { Compositor } from './tui/compositor.js';
import type { BarInfo } from './tui/statusbar.js';
import type { SidebarItem } from './tui/sidebar.js';

/** Ctrl-\ (FS, 0x1c) — toggles the teleport sandbox sidebar. */
const MENU_KEY = 0x1c;

export interface AttachOptions {
  /** Command run in the PTY when the session does not already exist. */
  command: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Env vars injected into the agent session (e.g. API keys). */
  env?: Record<string, string>;
  /** Static fields shown in the status bar. */
  bar: BarInfo;
  /**
   * Called once with a function that updates the live status-bar segment, so the
   * caller (auto-push) can push status into the compositor without a round-trip
   * through the sandbox.
   */
  bindStatus?: (update: (text: string) => void) => void;
  /** Provider for the sidebar's sandbox list (polled while attached). */
  listSandboxes?: () => Promise<SidebarItem[]>;
  /**
   * Holder the attach writes the chosen sandbox id into when the user picks a
   * different sandbox from the sidebar; the caller reads it on a 'switch'
   * outcome to reconnect directly (instead of re-opening the picker).
   */
  switchTarget?: { id?: string };
  /** Stops another (un-attached) sandbox by id, for the sidebar's `s` action. */
  stopSandbox?: (id: string) => Promise<void>;
  /** Deletes another (un-attached) sandbox by id, for the sidebar's `d` action. */
  deleteSandbox?: (id: string) => Promise<void>;
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

/**
 * Decouples a status *producer* (auto-push) from the *consumer* (the compositor,
 * which only exists once attached). `update` may be called before `bind`; the
 * latest value is replayed when a sink binds.
 */
export interface StatusBridge {
  update(text: string): void;
  bind(sink: (text: string) => void): void;
}

export function statusBridge(): StatusBridge {
  let sink: (text: string) => void = () => {};
  let last = '';
  return {
    update(text) {
      last = text;
      sink(text);
    },
    bind(fn) {
      sink = fn;
      if (last) fn(last);
    },
  };
}

/** A connected PTY handle plus whether it was freshly created (vs reconnected). */
interface PtyAttach {
  pty: Awaited<ReturnType<Sandbox['process']['createPty']>>;
  fresh: boolean;
}

/**
 * Connects to the sandbox's persistent agent PTY, creating it (and launching the
 * agent) if it does not already exist or has exited. `fresh` is true when a new
 * session was created and the agent command still needs to be started.
 */
async function attachPty(
  sandbox: Sandbox,
  opts: { cwd?: string; envs: Record<string, string>; cols: number; rows: number; onData: (d: Uint8Array) => void },
): Promise<PtyAttach> {
  const proc = sandbox.process;
  const info = await proc.getPtySessionInfo(PTY_SESSION_ID).catch(() => null);
  if (info?.active) {
    const pty = await proc.connectPty(PTY_SESSION_ID, { onData: opts.onData });
    await pty.waitForConnection().catch(() => {});
    return { pty, fresh: false };
  }
  // A dead/inactive session of the same id would block re-creation — clear it.
  if (info) await proc.killPtySession(PTY_SESSION_ID).catch(() => {});
  const pty = await proc.createPty({
    id: PTY_SESSION_ID,
    cwd: opts.cwd,
    envs: opts.envs,
    cols: opts.cols,
    rows: opts.rows,
    onData: opts.onData,
  });
  await pty.waitForConnection().catch(() => {});
  return { pty, fresh: true };
}

/** Attaches the local terminal to the sandbox's agent PTY. Resolves on detach/exit. */
export async function attach(sandbox: Sandbox, opts: AttachOptions): Promise<AttachOutcome> {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const agentRows = Math.max(1, rows - 1); // bottom row is the status bar

  // A UTF-8 locale, truecolor, and a real TERM let the agent emit the colours and
  // wide/Unicode characters the emulator then renders. C.UTF-8 is always present.
  const localeLang = 'C.UTF-8';
  const envs: Record<string, string> = {
    HOME: await sandboxHome(sandbox),
    LANG: localeLang,
    LC_ALL: localeLang,
    LC_CTYPE: localeLang,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...opts.env,
  };

  // Resolve the outcome on the first of: agent exit, or a sidebar action.
  let settled = false;
  let resolveOutcome!: (o: AttachOutcome) => void;
  const outcome = new Promise<AttachOutcome>((r) => (resolveOutcome = r));
  const settle = (o: AttachOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(o);
  };

  // Performs a stop/delete on another sandbox, then refreshes the sidebar list.
  const inlineAction = (kind: 'stop' | 'delete', id: string) => {
    void (async () => {
      try {
        if (kind === 'stop') await opts.stopSandbox?.(id);
        else await opts.deleteSandbox?.(id);
      } catch {
        /* surfaced via the refreshed list */
      }
      await refresh();
    })();
  };

  let comp!: Compositor;
  comp = new Compositor({
    cols,
    rows,
    bar: opts.bar,
    write: (d) => process.stdout.write(d),
    sendInput: (d) => void pty.sendInput(d),
    onAgentSize: (c2, r2) => void pty.resize(c2, r2).catch(() => {}),
    onSidebarSelect: (item) => {
      // Selecting the current sandbox just closes the sidebar; picking any other
      // detaches and tells the caller to reconnect to it (by full id).
      if (item.current) {
        comp.toggleSidebar();
        return;
      }
      if (opts.switchTarget) opts.switchTarget.id = item.id;
      settle('switch');
    },
    // Detach/stop/delete of the *current* sandbox ends the attach.
    onSessionAction: (action) => settle(action),
    // Stop/delete of *another* sandbox happens in place.
    onInlineAction: (kind, item) => inlineAction(kind, item.id),
  });
  const compositor = comp;
  opts.bindStatus?.((text) => compositor.setLiveStatus(text));

  const { pty, fresh } = await attachPty(sandbox, {
    cwd: opts.cwd,
    envs,
    cols,
    rows: agentRows,
    onData: (data) => compositor.feed(data),
  });

  compositor.start();

  if (fresh) {
    // Replace the login shell with the agent so the PTY ends when the agent exits.
    await pty.sendInput(`exec ${opts.command}\n`);
  } else {
    // Reconnected to a running agent: nudge a SIGWINCH so an alt-screen TUI
    // repaints its current screen into our fresh emulator.
    await pty.resize(cols - 1, agentRows).catch(() => {});
    await pty.resize(cols, agentRows).catch(() => {});
  }

  // Poll the sandbox list to keep the sidebar current.
  const refresh = async () => {
    if (!opts.listSandboxes) return;
    try {
      compositor.setSandboxes(await opts.listSandboxes());
    } catch {
      /* ignore transient list failures */
    }
  };
  void refresh();
  const refreshTimer = opts.listSandboxes ? setInterval(() => void refresh(), 3000) : null;

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();

  // Ctrl-\ and Ctrl-] both toggle the sidebar (the control center for switching
  // and stop/delete/detach); all other keys go to the compositor.
  const onStdin = (chunk: Buffer) => {
    if (isMenuTrigger(chunk)) {
      compositor.toggleSidebar();
      return;
    }
    compositor.input(chunk);
  };

  const onResize = () => {
    // The compositor reflows and resizes the PTY (via onAgentSize) to the new
    // agent area, accounting for the sidebar.
    compositor.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  };

  stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);
  pty.wait().then(() => settle('ended')).catch(() => settle('ended'));

  const result = await outcome;

  // Teardown: stop listening, restore the terminal, and drop the WebSocket
  // *without* killing the PTY — the agent keeps running server-side so a later
  // reconnect (or 'switch') re-attaches to it. Stop/delete of the sandbox itself
  // is the caller's job.
  if (refreshTimer) clearInterval(refreshTimer);
  stdin.off('data', onStdin);
  process.stdout.off('resize', onResize);
  compositor.stop();
  if (stdin.setRawMode) stdin.setRawMode(wasRaw);
  stdin.pause();
  await pty.disconnect().catch(() => {});

  return result;
}
