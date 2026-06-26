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
import { detectBackground, colorfgbg, colorReplies, type TermBackground } from './tui/theme.js';
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
  /**
   * Written by the sidebar when the user picks a different sandbox. `start`
   * forces a stopped sandbox to be started (Enter); without it, navigating to a
   * stopped sandbox just shows a "press Return to start" message.
   */
  switchTarget: { id?: string; openSidebar?: boolean; start?: boolean };
  /** Deletes a sandbox by id (sidebar `d`). */
  deleteSandbox: (id: string) => Promise<void>;
}

/** How long the selection must settle before the agent view follows it. */
const PREVIEW_DEBOUNCE_MS = 150;

/**
 * How an attach ended. 'switch'/'detached'/'ended' leave the sandbox running;
 * 'deleted' tells the caller to delete the sandbox; 'new' creates one.
 */
export type AttachOutcome = 'switch' | 'detached' | 'ended' | 'deleted' | 'new';

type Pty = Awaited<ReturnType<Sandbox['process']['createPty']>>;

/** Status-bar fields shown while idle (no agent attached). */
const IDLE_BAR: BarInfo = { shortId: 'teleport', agent: '—' };

/** Builds status-bar fields from a sidebar item (for an instant switch). */
function barFromItem(item: SidebarItem): BarInfo {
  return { shortId: item.id.slice(0, 8), agent: item.agent, repo: item.repo, branch: item.branch };
}

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
  /** Id of the sandbox currently shown in the agent pane (or null when idle). */
  private shownId: string | null = null;
  /**
   * Id of the sandbox we last *intended* to show — set the instant the user
   * navigates/switches, before the (async) attach completes. The live preview
   * dedups against this, not `shownId` (which only updates once an attach lands),
   * so rapid back-to-back switches always settle on the final selection instead
   * of getting stranded on an in-flight one.
   */
  private intendedId: string | null = null;
  /** Detected real-terminal background, for agent theming (light/dark). */
  private background: TermBackground | null = null;
  /** Debounce timer for the live preview as the selection moves. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolver for the in-flight attach; sidebar callbacks call it. */
  private settle: ((o: AttachOutcome) => void) | null = null;
  /**
   * An action requested while no wait was active (e.g. `n` during the async
   * "creating…" window). Replayed when the next wait starts so the keypress isn't
   * silently lost.
   */
  private pendingOutcome: AttachOutcome | null = null;
  private readonly stdin = process.stdin;
  private wasRaw = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** Shows a centered notice in the agent area (e.g. while a switch connects). */
  connecting(label: string): void {
    this.compositor?.resetAgent(label);
  }

  /** Queues the new-sandbox flow to run as soon as the session UI is up. */
  queueNew(): void {
    this.pendingOutcome = 'new';
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
    this.shownId = null;
    this.intendedId = null;
    if (!this.started) await this.startInteractive(compositor);
    compositor.setBar(IDLE_BAR);
    compositor.resetAgent(message);
    compositor.openSidebar();
    void this.refresh();
    return this.waitOutcome(null);
  }

  /**
   * Shows a "stopped — press Return to start" notice for a sandbox the user
   * navigated to, with the chrome up and the sidebar still navigable (so they can
   * keep browsing). Resolves on the next sidebar action.
   */
  async showStopped(item: SidebarItem, listSandboxes: () => Promise<SidebarItem[]>): Promise<AttachOutcome> {
    const compositor = this.ensureCompositor(barFromItem(item));
    this.listProvider = listSandboxes;
    this.shownId = item.id;
    this.intendedId = item.id;
    if (!this.started) await this.startInteractive(compositor);
    compositor.setBar(barFromItem(item));
    compositor.resetAgent(`⏸  ${item.id.slice(0, 8)} is stopped — press Return to start it`);
    compositor.openSidebar();
    void this.refresh();
    return this.waitOutcome(null);
  }

  /** Attaches a sandbox and resolves when it ends (switch/detach/stop/delete/exit). */
  async attach(spec: AttachSpec): Promise<AttachOutcome> {
    const compositor = this.ensureCompositor(spec.bar);
    this.listProvider = spec.listSandboxes;
    this.shownId = spec.sandbox.id;
    this.intendedId = spec.sandbox.id;
    spec.bindStatus?.((text) => compositor.setLiveStatus(text));

    // Start the UI (and detect the terminal background) before building the env,
    // so COLORFGBG reflects the real theme on the very first agent too.
    if (!this.started) {
      await this.startInteractive(compositor);
      compositor.resetAgent('connecting…');
    } else {
      compositor.setBar(spec.bar);
    }

    const envs = await this.buildEnv(spec);

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
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.pendingOutcome = null;
    this.stdin.off('data', this.onStdin);
    process.stdout.off('resize', this.onResize);
    this.compositor?.stop(); // disables mouse + leaves the alt screen
    // Drain any buffered input (mouse reports / type-ahead) while still in raw
    // mode, so it isn't handed to the shell as stray "command" characters.
    this.stdin.pause();
    try {
      while (this.stdin.read() !== null) {
        /* discard */
      }
    } catch {
      /* not all streams support read() — best effort */
    }
    if (this.stdin.setRawMode) this.stdin.setRawMode(this.wasRaw);
  }

  // --- internals ------------------------------------------------------------

  private async buildEnv(spec: AttachSpec): Promise<Record<string, string>> {
    // A UTF-8 locale, truecolor, and a real TERM let the agent emit the colours
    // and wide/Unicode characters the emulator renders. C.UTF-8 is always present.
    const localeLang = 'C.UTF-8';
    // COLORFGBG lets agents that don't query OSC 11 still pick light/dark from the
    // env; prefer the detected background, else pass through the local value.
    const fgbg = this.background ? colorfgbg(this.background.isDark) : process.env.COLORFGBG;
    return {
      HOME: await sandboxHome(spec.sandbox),
      LANG: localeLang,
      LC_ALL: localeLang,
      LC_CTYPE: localeLang,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(fgbg ? { COLORFGBG: fgbg } : {}),
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
      onSelectionChange: (item) => this.onSelectionChange(item),
      onSessionAction: (action) => this.requestOutcome(action),
      onNew: () => this.requestOutcome('new'),
      onInfo: (item) => this.showInfo(item),
      onOpenBranch: (item) => this.openBranch(item),
      onDeleteCurrent: (current, neighbour) => this.onDeleteCurrent(current, neighbour),
      onDeleteOther: (item) => this.onDeleteOther(item.id),
    });
    return this.compositor;
  }

  private async startInteractive(compositor: Compositor): Promise<void> {
    this.wasRaw = this.stdin.isRaw ?? false;
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.resume();
    // Detect the real terminal's background *before* the alt screen + agent
    // start, so agents theme themselves correctly (the emulator can't answer
    // their OSC 11 query, and COLORFGBG needs to be in their env).
    this.background = await detectBackground(this.stdin, process.stdout).catch(() => null);
    if (this.background) compositor.setColorReplies(colorReplies(this.background));
    compositor.start();
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
    // Ctrl-C is a universal escape hatch *except* when you're typing into the
    // agent (where it's the agent's own interrupt). So in the sidebar, in a
    // modal, while idle, or mid-create — any state that isn't the live agent —
    // a lone Ctrl-C quits teleport instead of getting swallowed. This guarantees
    // there's always a way out, even if an async step (e.g. creating a sandbox)
    // is wedged. Esc still just cancels the sidebar/modal.
    if (chunk.length === 1 && chunk[0] === 0x03 && this.compositor && !this.compositor.agentFocused()) {
      this.quit();
      return;
    }
    this.compositor?.input(chunk);
  };

  /**
   * Quits teleport from anywhere. If a wait is active (idle / attached / stopped
   * view) we settle it as 'detached' so the loop unwinds and disposes cleanly.
   * If we're stuck in an async window with no active wait (e.g. a hung create),
   * dispose directly and exit the process — the escape hatch must always work.
   */
  private quit(): void {
    if (this.settle) {
      this.settle('detached');
      return;
    }
    this.dispose();
    process.exit(0);
  }

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

  /**
   * Requests an outcome from a sidebar action. If a wait is active it resolves
   * immediately; otherwise (a transient async window like "creating…") it is
   * queued and replayed when the next wait starts, so the action isn't lost.
   */
  private requestOutcome(o: AttachOutcome): void {
    if (this.settle) this.settle(o);
    else this.pendingOutcome = o;
  }

  /** Resolves on the first of: agent exit (if a PTY), or a sidebar action. */
  private async waitOutcome(pty: Pty | null): Promise<AttachOutcome> {
    // Cancel any pending preview from the previous state.
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    try {
      return await new Promise<AttachOutcome>((resolve) => {
        let done = false;
        const settle = (o: AttachOutcome) => {
          if (done) return;
          done = true;
          resolve(o);
        };
        this.settle = settle; // sidebar callbacks resolve this wait
        // Replay an action queued while no wait was active.
        if (this.pendingOutcome) {
          const o = this.pendingOutcome;
          this.pendingOutcome = null;
          settle(o);
          return;
        }
        pty
          ?.wait()
          .then(() => settle('ended'))
          .catch(() => settle('ended'));
      });
    } finally {
      this.settle = null;
    }
  }

  private isStopped(item: SidebarItem): boolean {
    return item.state !== 'started';
  }

  /**
   * The highlighted row changed (↑/↓ / click): after a short settle, make the
   * agent view follow the selection. Running sandboxes attach live; stopped ones
   * show a "press Return to start" message (the loop decides — `start` is false).
   */
  private onSelectionChange(item: SidebarItem): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (item.id === this.intendedId) return; // already shown (or being switched to)
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.requestSwitch(item, { start: false, openSidebar: true });
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Enter / click on a row. */
  private onSelect(item: SidebarItem): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    // The shown sandbox: close the sidebar to interact with it.
    if (item.id === this.shownId && !this.isStopped(item)) {
      this.compositor?.toggleSidebar();
      return;
    }
    // Enter starts a stopped sandbox; running ones just attach and land.
    this.requestSwitch(item, { start: this.isStopped(item), openSidebar: false });
  }

  /** Reflects the target in the chrome instantly, then asks the caller to swap. */
  private requestSwitch(item: SidebarItem, opts: { start: boolean; openSidebar: boolean }): void {
    if (item.id === this.intendedId && !this.isStopped(item)) {
      // Already shown (or mid-switch) and running → just (un)collapse the sidebar.
      if (!opts.openSidebar) this.compositor?.closeSidebar();
      return;
    }
    // Record the intent now (before the async attach) so back-to-back switches
    // dedup/settle against the latest target, not the one still attaching.
    this.intendedId = item.id;
    this.compositor?.setBar(barFromItem(item));
    this.deps.switchTarget.id = item.id;
    this.deps.switchTarget.openSidebar = opts.openSidebar;
    this.deps.switchTarget.start = opts.start;
    this.requestOutcome('switch');
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
      this.requestOutcome('deleted');
      return;
    }
    void this.deps.deleteSandbox(current.id).catch(() => {});
    this.deps.switchTarget.id = neighbour.id;
    this.deps.switchTarget.openSidebar = true;
    this.requestOutcome('switch');
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
