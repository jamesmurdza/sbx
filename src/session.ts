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
import { openUrl, githubBranchUrl } from './open.js';

/** Ctrl-\ (FS, 0x1c) — toggles the teleport sandbox sidebar. */
const MENU_KEY = 0x1c;

/** Everything needed to attach one sandbox into the persistent compositor. */
export interface AttachSpec {
  sandbox: Sandbox;
  /** Command run in the PTY when the session does not already exist. */
  command: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Env vars injected into the agent session (e.g. API keys). */
  env?: Record<string, string>;
  /** Static fields shown in the status bar. */
  bar: BarInfo;
  /**
   * Called with a function that updates the live status-bar segment, so the
   * caller (auto-push) can push status into the compositor.
   */
  bindStatus?: (update: (text: string) => void) => void;
  /** Provider for the sidebar's sandbox list (polled while attached). */
  listSandboxes: () => Promise<SidebarItem[]>;
  /** Open the sidebar immediately (entry menu for bare `teleport`, or a hand-off). */
  openSidebar?: boolean;
}

/** Global hooks shared across every attachment in one interactive session. */
export interface SessionDeps {
  /** Written by the sidebar when the user picks a different sandbox to switch to. */
  switchTarget: { id?: string; openSidebar?: boolean };
  /** Deletes a sandbox by id (sidebar `d`). */
  deleteSandbox: (id: string) => Promise<void>;
}

/**
 * How an attach ended. 'switch'/'detached'/'ended' leave the sandbox running;
 * 'deleted' tells the caller to delete the sandbox; 'new' creates one.
 */
export type AttachOutcome = 'switch' | 'detached' | 'ended' | 'deleted' | 'new';

type Pty = Awaited<ReturnType<Sandbox['process']['createPty']>>;

/** Status-bar fields shown while idle (no agent attached). */
const IDLE_BAR: BarInfo = { shortId: 'teleport', agent: '—' };

/** Compact "5m ago" / "3h ago" / "2d ago" from an ISO timestamp. */
function relativeAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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

/**
 * A persistent interactive session: owns the terminal compositor, stdin, and
 * resize handling for the *whole* run, and swaps the agent PTY underneath when
 * the user switches sandboxes. Because the compositor (and its sidebar) is built
 * once and reused, switching never leaves the alt screen — there is no flash to a
 * bare terminal and the sidebar stays put.
 */
export class TeleportSession {
  private readonly deps: SessionDeps;
  private compositor: Compositor | null = null;
  private started = false;
  private currentPty: Pty | null = null;
  private listProvider: () => Promise<SidebarItem[]> = async () => [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolver for the in-flight attach; sidebar callbacks call it. */
  private settle: ((o: AttachOutcome) => void) | null = null;
  private readonly stdin = process.stdin;
  private wasRaw = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** Shows a centered notice in the agent area (e.g. while a switch connects). */
  connecting(label: string): void {
    this.compositor?.resetAgent(label);
  }

  /**
   * Modal interactions render *inside the agent pane* (via the compositor), so
   * the sidebar and status bar are never touched — nothing in the main view can
   * disturb the sidebar.
   */
  async menu<T>(title: string, items: { label: string; detail?: string; value: T }[]): Promise<T | null> {
    if (!this.compositor) return null;
    return (await this.compositor.menu(title, items)) as T | null;
  }

  async prompt(title: string, placeholder = ''): Promise<string | null> {
    return this.compositor ? this.compositor.prompt(title, placeholder) : null;
  }

  async confirm(question: string): Promise<boolean> {
    return (
      (await this.menu(question, [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ])) === true
    );
  }

  /**
   * Runs the chrome (status bar + sidebar) with *no* agent attached, showing a
   * centered message. Used when there are no sandboxes (or the last one was just
   * deleted) so the menu still works. Resolves on the next sidebar action.
   */
  async idle(message: string, listSandboxes: () => Promise<SidebarItem[]>): Promise<AttachOutcome> {
    const compositor = this.ensureCompositor(IDLE_BAR);
    this.listProvider = listSandboxes;
    if (!this.started) this.startInteractive(compositor);
    compositor.setBar(IDLE_BAR);
    compositor.resetAgent(message);
    compositor.openSidebar();
    void this.refresh();
    return this.waitOutcome(null);
  }

  /** Attaches a sandbox and resolves when it ends (switch/detach/stop/delete/exit). */
  async attach(spec: AttachSpec): Promise<AttachOutcome> {
    const compositor = this.ensureCompositor(spec.bar);
    this.listProvider = spec.listSandboxes;
    spec.bindStatus?.((text) => compositor.setLiveStatus(text));

    const envs = await this.buildEnv(spec);

    if (!this.started) {
      this.startInteractive(compositor);
      compositor.resetAgent('connecting…');
    } else {
      compositor.setBar(spec.bar);
    }
    if (spec.openSidebar) compositor.openSidebar();
    else compositor.closeSidebar();

    const size = compositor.agentSize();
    const { pty, fresh } = await attachPty(spec.sandbox, {
      cwd: spec.cwd,
      envs,
      cols: size.cols,
      rows: size.rows,
      onData: (data) => compositor.feed(data),
    });
    this.currentPty = pty;

    if (fresh) {
      // Replace the login shell with the agent so the PTY ends when it exits.
      await pty.sendInput(`exec ${spec.command}\n`);
    } else {
      // Nudge a SIGWINCH so an alt-screen TUI repaints into the fresh emulator.
      await pty.resize(Math.max(1, size.cols - 1), size.rows).catch(() => {});
      await pty.resize(size.cols, size.rows).catch(() => {});
    }

    void this.refresh();

    const result = await this.waitOutcome(pty);

    // Drop the WebSocket *without* killing the PTY — the agent keeps running
    // server-side so a reconnect re-attaches to it. The compositor stays alive.
    await pty.disconnect().catch(() => {});
    this.currentPty = null;
    return result;
  }

  /** Tears down the compositor and restores the terminal at the end of the run. */
  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.stdin.off('data', this.onStdin);
    process.stdout.off('resize', this.onResize);
    this.compositor?.stop();
    if (this.stdin.setRawMode) this.stdin.setRawMode(this.wasRaw);
    this.stdin.pause();
  }

  // --- internals ------------------------------------------------------------

  private async buildEnv(spec: AttachSpec): Promise<Record<string, string>> {
    // A UTF-8 locale, truecolor, and a real TERM let the agent emit the colours
    // and wide/Unicode characters the emulator renders. C.UTF-8 is always present.
    const localeLang = 'C.UTF-8';
    return {
      HOME: await sandboxHome(spec.sandbox),
      LANG: localeLang,
      LC_ALL: localeLang,
      LC_CTYPE: localeLang,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...spec.env,
    };
  }

  private ensureCompositor(bar: BarInfo): Compositor {
    if (this.compositor) return this.compositor;
    this.compositor = new Compositor({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      bar,
      write: (d) => process.stdout.write(d),
      // Ignore send failures (a brief disconnect) — must not crash via rejection.
      sendInput: (d) => void this.currentPty?.sendInput(d).catch(() => {}),
      onAgentSize: (c, r) => void this.currentPty?.resize(c, r).catch(() => {}),
      onSidebarSelect: (item) => this.onSelect(item),
      onSessionAction: (action) => this.settle?.(action),
      onNew: () => this.settle?.('new'),
      onInfo: (item) => this.showInfo(item),
      onOpenBranch: (item) => this.openBranch(item),
      onDeleteCurrent: (current, neighbour) => this.onDeleteCurrent(current, neighbour),
      onDeleteOther: (item) => this.onDeleteOther(item.id),
    });
    return this.compositor;
  }

  private startInteractive(compositor: Compositor): void {
    compositor.start();
    this.wasRaw = this.stdin.isRaw ?? false;
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('data', this.onStdin);
    process.stdout.on('resize', this.onResize);
    this.refreshTimer = setInterval(() => void this.refresh(), 3000);
    this.started = true;
  }

  // Ctrl-\ / Ctrl-] toggle the sidebar; everything else goes to the compositor.
  private readonly onStdin = (chunk: Buffer): void => {
    if (isMenuTrigger(chunk)) {
      this.compositor?.toggleSidebar();
      return;
    }
    this.compositor?.input(chunk);
  };

  private readonly onResize = (): void => {
    this.compositor?.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  };

  private async refresh(): Promise<void> {
    try {
      this.compositor?.setSandboxes(await this.listProvider());
    } catch {
      /* ignore transient list failures */
    }
  }

  /** Resolves on the first of: agent exit (if a PTY), or a sidebar action. */
  private async waitOutcome(pty: Pty | null): Promise<AttachOutcome> {
    try {
      return await new Promise<AttachOutcome>((resolve) => {
        let done = false;
        const settle = (o: AttachOutcome) => {
          if (done) return;
          done = true;
          resolve(o);
        };
        this.settle = settle; // sidebar callbacks resolve this wait
        pty
          ?.wait()
          .then(() => settle('ended'))
          .catch(() => settle('ended'));
      });
    } finally {
      this.settle = null;
    }
  }

  private onSelect(item: SidebarItem): void {
    // Selecting the current sandbox just closes the sidebar; any other switches.
    if (item.current) {
      this.compositor?.toggleSidebar();
      return;
    }
    this.deps.switchTarget.id = item.id;
    this.settle?.('switch');
  }

  /** Shows a read-only info panel for the selected sandbox in the agent pane. */
  private showInfo(item: SidebarItem): void {
    const lines = [
      `ID       ${item.id}`,
      `Agent    ${item.agent}`,
      `State    ${item.state}`,
      `Repo     ${item.repo ?? '—'}`,
      `Branch   ${item.branch ?? '—'}`,
      `Created  ${item.createdAt ? relativeAge(item.createdAt) : '—'}`,
    ];
    void this.compositor?.info(`Sandbox ${item.id.slice(0, 8)}`, lines);
  }

  /** Opens the selected sandbox's branch on GitHub in the local browser. */
  private openBranch(item: SidebarItem): void {
    const url = githubBranchUrl(item.repo, item.branch);
    if (!url) {
      void this.compositor?.info('Open on GitHub', ['This sandbox has no git repo/branch.']);
      return;
    }
    openUrl(url);
    void this.compositor?.info('Open on GitHub', [`Opened in your browser:`, url]);
  }

  // Deleting the *current* sandbox hands off to a neighbour so the flow
  // continues; with no neighbour it ends the session ('deleted').
  private onDeleteCurrent(current: SidebarItem, neighbour: SidebarItem | null): void {
    if (!neighbour) {
      this.settle?.('deleted');
      return;
    }
    void this.deps.deleteSandbox(current.id).catch(() => {});
    this.deps.switchTarget.id = neighbour.id;
    this.deps.switchTarget.openSidebar = true;
    this.settle?.('switch');
  }

  // Deleting another sandbox happens in place; errors surface in the bar.
  private onDeleteOther(id: string): void {
    void (async () => {
      try {
        await this.deps.deleteSandbox(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.compositor?.setLiveStatus(`✗ delete failed: ${msg.replace(/^"|"$/g, '')}`);
      }
      await this.refresh();
    })();
  }
}
