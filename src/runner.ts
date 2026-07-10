/**
 * High-level orchestration for starting a new sandbox and reconnecting to an
 * existing one: ties together repo inspection, the credential modal, sandbox
 * creation, repo clone + sbx branch, and auto-push. A single
 * `runSessionLoop` then drives one persistent `SbxSession` (one compositor),
 * swapping sandboxes in place on a switch so there's no teardown/flash.
 */
import { knownAgent, yoloFlagFor, KNOWN_AGENTS, SANDBOX_REPO_PATH } from './config.js';
import {
  createSandbox,
  ensureStarted,
  getSession,
  listSessions,
  tagBranch,
  DEAD_STATES,
  RUNNING_STATES,
  type Session,
} from './daytona.js';
import { inspectLocalRepo } from './local-git.js';
import { discoverSources } from './auth/sources.js';
import { applyCredential } from './auth/importer.js';
import { sandboxHome, writeHomeFile } from './sandbox-ops.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveGitHubToken } from './git/auth.js';
import { setupRepo } from './git/repo.js';
import { AutoPush, type PushStatus } from './git/autopush.js';
import { SbxSession, statusBridge, type AttachSpec, type SessionDeps } from './session.js';
import type { BarInfo } from './tui/statusbar.js';
import type { SidebarItem } from './tui/sidebar.js';
import { overlayMenu, overlayConfirm } from './tui/overlay.js';

function log(msg: string): void {
  process.stdout.write(`sbx: ${msg}\n`);
}

/**
 * Condenses an error into a short, single-line message fit for the agent pane.
 * Daytona errors are long, quoted, and multi-clause (e.g. "not found: sandbox
 * container not found: …"); collapse whitespace, strip wrapping quotes, and clip.
 */
function oneLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const clean = msg
    .replace(/\s+/g, ' ')
    .replace(/^"+|"+$/g, '')
    .trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

export interface StartOptions {
  command: string;
  args: string[];
  /** Append the agent's permission-skipping ("yolo") flag. */
  yolo?: boolean;
}

/** A prepared attachment: the spec plus its auto-push handle (stopped on detach). */
interface Prepared {
  spec: AttachSpec;
  autopush?: AutoPush;
}

/**
 * How the new-sandbox flow presents its modals and progress. At startup it uses
 * the bare terminal (fullscreen overlays, stdout logging); in-session every modal
 * renders *inside the agent pane* via the compositor, so the sidebar and status
 * bar are never disturbed, and progress shows in the agent placeholder.
 */
interface Present {
  note(msg: string): void;
  confirm(question: string): Promise<boolean>;
  menu<T>(title: string, items: { label: string; detail?: string; value: T }[]): Promise<T | null>;
}

const TERMINAL_PRESENT: Present = {
  note: (m) => log(m),
  confirm: (q) => overlayConfirm(q, { fullscreen: true }),
  menu: (title, items) => overlayMenu(title, items, { fullscreen: true }),
};

function sessionPresent(session: SbxSession): Present {
  return {
    note: (m) => session.connecting(m),
    confirm: (q) => session.confirm(q),
    menu: (title, items) => session.menu(title, items),
  };
}

/** Agents offered in the in-session "new sandbox" picker. */
const NEW_AGENTS = KNOWN_AGENTS;

/** Returns the live sandbox list as sidebar items, marking the attached one.
 * Sandboxes being torn down (or errored) are dropped so a just-deleted one
 * disappears from the sidebar immediately instead of lingering. */
async function listSandboxItems(currentId: string): Promise<SidebarItem[]> {
  const sessions = await listSessions();
  return sessions
    .filter((s) => s.id === currentId || !DEAD_STATES.has(s.state))
    .map((s) => ({
      id: s.id,
      agent: s.command || s.agent || '?',
      state: s.state || '?',
      current: s.id === currentId,
      repo: s.repo || undefined,
      branch: s.branch || undefined,
      createdAt: s.createdAt || undefined,
    }));
}

/** Maps one session to a sidebar item (used for the stopped-preview view). */
function sidebarItemOf(s: Session): SidebarItem {
  return {
    id: s.id,
    agent: s.command || s.agent || '?',
    state: s.state || '?',
    current: false,
    repo: s.repo || undefined,
    branch: s.branch || undefined,
    createdAt: s.createdAt || undefined,
  };
}

/** Full flow for `sbx <command>`: create the sandbox, then run the session. */
export async function startNew(opts: StartOptions): Promise<void> {
  const first = await prepareNew(opts);
  if (first) await runSessionLoop(first);
}

/** Builds the first attachment for a brand-new sandbox, or null if cancelled. */
async function prepareNew(opts: StartOptions, present: Present = TERMINAL_PRESENT): Promise<Prepared | null> {
  const cwd = process.cwd();
  const repo = await inspectLocalRepo(cwd);

  // By default, insert the agent's permission-skipping flag (the sandbox is
  // throwaway); --safe disables this. Agents with no known flag run unchanged.
  const yoloFlag = opts.yolo !== false ? yoloFlagFor(opts.command) : undefined;
  const runCommand = [opts.command, yoloFlag, ...opts.args].filter(Boolean).join(' ');

  const hasRepo = !!(repo && repo.originUrl);
  if (!hasRepo) {
    const ok = await present.confirm('Not in a git repo. Create a new blank sandbox with no repo?');
    if (!ok) {
      present.note('cancelled.');
      return null;
    }
  } else if (repo && (repo.dirty || repo.ahead > 0)) {
    const bits = [
      repo.dirty ? 'uncommitted changes' : null,
      repo.ahead > 0 ? `${repo.ahead} unpushed commit(s)` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    present.note(`warning: ${bits} won't be in the sandbox (it clones from origin).`);
  }

  // Choose credentials (modal) up front; applied after the sandbox exists.
  // Escape (null) quits; the "Skip" option ('none') proceeds without creds.
  const agent = knownAgent(opts.command);
  const sources = agent ? await discoverSources(agent) : [];
  type CredChoice = (typeof sources)[number] | 'none';
  let chosen: (typeof sources)[number] | null = null;
  if (sources.length > 0) {
    const picked = await present.menu<CredChoice>(`${opts.command} credentials`, [
      ...sources.map((s) => ({ label: s.label, detail: s.detail, value: s as CredChoice })),
      { label: 'Skip', value: 'none' as CredChoice },
    ]);
    if (picked === null) {
      present.note('cancelled.');
      return null;
    }
    chosen = picked === 'none' ? null : picked;
  }

  present.note('creating sandbox…');
  const sandbox = await createSandbox({
    command: runCommand,
    agent: opts.command,
    repoSlug: repo?.slug ?? null,
    baseBranch: repo?.branch ?? null,
  });
  present.note(`sandbox ${sandbox.id.slice(0, 8)} created; starting…`);
  await ensureStarted(sandbox);

  // Apply credential choice now that we have a sandbox. Start from the agent's
  // static env (e.g. CLAUDE_CODE_NO_FLICKER) and layer credential env on top.
  let env: Record<string, string> = { ...(agent?.env ?? {}) };
  if (chosen) {
    const result = await applyCredential(sandbox, chosen.payload);
    env = { ...env, ...result.env };
    present.note(`${opts.command} credentials: ${result.summary}`);
  }

  // Clone repo + create sbx branch + start auto-push.
  let cwdInSandbox: string | undefined;
  let autopush: AutoPush | undefined;
  const status = statusBridge();
  const bar: BarInfo = {
    shortId: sandbox.id.slice(0, 8),
    agent: opts.command,
    repo: repo?.slug ?? undefined,
  };

  if (hasRepo && repo) {
    const creds = await resolveGitHubToken();
    if (!creds) {
      present.note('warning: no GitHub token — clone may fail for private repos; auto-push disabled.');
    }
    try {
      present.note('cloning repo…');
      const setup = await setupRepo(sandbox, {
        originUrl: repo.originUrl!,
        baseBranch: repo.branch ?? 'main',
        creds: creds ?? { username: '', password: '', source: 'none' },
      });
      cwdInSandbox = setup.repoPath;
      bar.branch = setup.branch;
      await tagBranch(sandbox, setup.branch);
      if (creds) {
        autopush = new AutoPush(sandbox, {
          repoPath: setup.repoPath,
          branch: setup.branch,
          creds,
          onStatus: (s, d) => status.update(pushLabel(s, d)),
        });
        autopush.start();
      }
    } catch (err) {
      present.note(`warning: repo setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Pre-accept Claude's folder-trust (and bypass-permissions) prompts.
  if (opts.command === 'claude') {
    const dir = cwdInSandbox ?? (await sandboxHome(sandbox));
    await prepareClaudeConfig(sandbox, dir, {
      bypass: opts.yolo !== false,
      importHostConfig: !!chosen?.payload.file,
    });
  }

  const spec: AttachSpec = {
    sandbox,
    command: runCommand,
    cwd: cwdInSandbox,
    env,
    bar,
    bindStatus: status.bind,
    listSandboxes: () => listSandboxItems(sandbox.id),
    openSidebar: false,
  };
  return { spec, autopush };
}

/**
 * Writes the sandbox's ~/.claude.json so Claude skips its launch prompts:
 *  - the account + onboarding state (imported from the host config when a
 *    subscription/file credential was chosen, so login is recognised),
 *  - the per-directory "Is this a project you trust?" dialog, and
 *  - the global "Bypass Permissions mode" acceptance (unless --safe).
 *
 * The merge is done locally and the result uploaded via the filesystem API, so
 * it does not rely on a node/python runtime existing in the sandbox.
 */
async function prepareClaudeConfig(
  sandbox: import('@daytonaio/sdk').Sandbox,
  dir: string,
  opts: { bypass: boolean; importHostConfig: boolean },
): Promise<void> {
  const readLocalJson = async (rel: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(join(homedir(), rel), 'utf8'));
    } catch {
      return {};
    }
  };

  try {
    // ~/.claude.json: account/onboarding (host) + per-dir trust + bypass accepted.
    const conf = opts.importHostConfig ? await readLocalJson('.claude.json') : {};
    const projects = (conf.projects as Record<string, Record<string, unknown>>) ?? {};
    projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    conf.projects = projects;
    if (opts.bypass) conf.bypassPermissionsModeAccepted = true;
    await writeHomeFile(sandbox, '.claude.json', JSON.stringify(conf, null, 2), '600');

    // ~/.claude/settings.json: the actual switch that skips the bypass-mode prompt.
    if (opts.bypass) {
      const settings = opts.importHostConfig ? await readLocalJson('.claude/settings.json') : {};
      settings.skipDangerousModePermissionPrompt = true;
      await writeHomeFile(sandbox, '.claude/settings.json', JSON.stringify(settings, null, 2), '600');
    }
  } catch (err) {
    log(`note: could not pre-accept claude prompts (${err instanceof Error ? err.message : err}).`);
  }
}

/**
 * `sbx` with no args: attach to the most-recent sandbox. With more than one
 * sandbox the sidebar opens as the entry menu so you can pick; with just one
 * we drop straight into its agent. When there are none, open the menu idle so
 * it still works (and you can create one).
 */
export async function openSandboxes(): Promise<void> {
  const live = (await listSessions()).filter((s) => !DEAD_STATES.has(s.state));
  if (live.length === 0) {
    // No sandboxes yet → open the new-sandbox menu straight away.
    await runSessionLoop(null, true);
    return;
  }
  // Only greet with the sidebar when there's a choice to make; a lone sandbox
  // goes straight to its agent (Ctrl-] still opens the menu).
  const openSidebar = live.length > 1;
  const target = live.find((s) => RUNNING_STATES.has(s.state)) ?? live[0];
  log(`connecting to ${target.id.slice(0, 8)}…`);
  // The chosen sandbox may have been deleted out from under us (container gone).
  // Never crash on that — open the sidebar so the user can pick another or exit.
  let first: Prepared | null = null;
  try {
    first = await prepareExisting(target, openSidebar);
  } catch (err) {
    await runSessionLoop(null, false, `couldn't reach ${target.id.slice(0, 8)} — ${oneLine(err)}`);
    return;
  }
  await runSessionLoop(first);
}

/**
 * Builds an attachment for an existing sandbox. Silent (no terminal logging): it
 * runs both for the first connect and mid-session switches, and the latter happen
 * while the compositor owns the alt screen.
 */
async function prepareExisting(session: Session, openSidebar: boolean): Promise<Prepared> {
  await ensureStarted(session.sandbox);

  const bar: BarInfo = {
    shortId: session.id.slice(0, 8),
    agent: session.agent || session.command,
    repo: session.repo || undefined,
    branch: session.branch || undefined,
  };

  // Agent static env (e.g. CLAUDE_CODE_NO_FLICKER) + best-effort re-inject of
  // env-var credentials (credential files already persist on disk).
  const agent = knownAgent(session.agent || session.command);
  const env: Record<string, string> = { ...(agent?.env ?? {}) };
  if (agent) {
    const sources = await discoverSources(agent);
    const envSource = sources.find((s) => s.payload.env);
    if (envSource?.payload.env) env[envSource.payload.env.name] = envSource.payload.env.value;
  }

  let autopush: AutoPush | undefined;
  const status = statusBridge();
  const cwdInSandbox = session.repo ? SANDBOX_REPO_PATH : undefined;
  if (session.repo && session.branch) {
    const creds = await resolveGitHubToken();
    if (creds) {
      autopush = new AutoPush(session.sandbox, {
        repoPath: SANDBOX_REPO_PATH,
        branch: session.branch,
        creds,
        onStatus: (s, d) => status.update(pushLabel(s, d)),
      });
      autopush.start();
    }
  }

  const spec: AttachSpec = {
    sandbox: session.sandbox,
    command: session.command,
    cwd: cwdInSandbox,
    env,
    bar,
    bindStatus: status.bind,
    listSandboxes: () => listSandboxItems(session.sandbox.id),
    openSidebar,
  };
  return { spec, autopush };
}

/**
 * Drives one persistent interactive session: a single compositor that the user
 * can switch sandboxes within. Each 'switch' swaps the attachment in place (no
 * teardown, no flash); stop/delete/detach/exit end the run. Result messages are
 * logged only after the terminal is restored.
 */
const IDLE_MESSAGE = 'No sandbox attached — Ctrl-] for the menu · x to exit';

async function runSessionLoop(first: Prepared | null, autoNew = false, initialNote = ''): Promise<void> {
  const deps: SessionDeps = {
    switchTarget: {},
    deleteSandbox: async (id) => {
      await (await getSession(id)).sandbox.delete();
    },
  };
  const session = new SbxSession(deps);
  if (autoNew) session.queueNew(); // open the new-sandbox menu as soon as the UI is up
  let current = first;
  let stoppedView: Session | null = null; // a stopped sandbox being previewed
  let idleNote: string | null = initialNote || null; // one-shot message for the idle view
  let endMsg = '';
  try {
    for (;;) {
      // Attached to a sandbox; previewing a stopped one; or idle (no agent).
      let outcome;
      if (current) {
        const attached = current;
        try {
          outcome = await session.attach(attached.spec);
        } catch (err) {
          // Attaching failed — most often the sandbox was deleted and its
          // container is gone, but also any transient API/connection error. Never
          // crash the whole app: drop to the sidebar with a note so the user can
          // pick another sandbox or exit. (Uses the captured `attached` ref so the
          // finally never dereferences a now-null `current`.)
          current = null;
          stoppedView = null;
          idleNote = `couldn't attach ${attached.spec.sandbox.id.slice(0, 8)} — ${oneLine(err)}`;
          continue;
        } finally {
          attached.autopush?.stop();
        }
      } else if (stoppedView) {
        outcome = await session.showStopped(sidebarItemOf(stoppedView), () => listSandboxItems(''));
      } else {
        outcome = await session.idle(idleNote ?? IDLE_MESSAGE, () => listSandboxItems(''));
        idleNote = null;
      }

      if (outcome === 'switch' && deps.switchTarget.id) {
        const id = deps.switchTarget.id;
        const openSidebar = deps.switchTarget.openSidebar ?? false;
        const start = deps.switchTarget.start ?? false;
        deps.switchTarget.id = undefined;
        deps.switchTarget.openSidebar = undefined;
        deps.switchTarget.start = undefined;
        const next = await getSession(id).catch(() => null);
        if (!next) {
          current = null;
          stoppedView = null;
          continue;
        }
        if (RUNNING_STATES.has(next.state) || start) {
          // Running, or the user pressed Return to start it → attach live.
          session.connecting(
            RUNNING_STATES.has(next.state)
              ? `connecting to ${id.slice(0, 8)}…`
              : `starting ${id.slice(0, 8)}…`,
          );
          try {
            current = await prepareExisting(next, openSidebar);
            stoppedView = null;
          } catch (err) {
            // Starting/preparing the target failed (e.g. it was just deleted).
            // Stay in sbx — drop to the sidebar with a note.
            current = null;
            stoppedView = null;
            idleNote = `couldn't reach ${id.slice(0, 8)} — ${oneLine(err)}`;
          }
        } else {
          // Navigated to a stopped sandbox → show the "press Return" notice.
          current = null;
          stoppedView = next;
        }
        continue;
      }

      if (outcome === 'new') {
        const created = await createInSession(session);
        if (created) {
          current = created;
          stoppedView = null;
        } else if (current) {
          // Cancelled: re-attach the current sandbox with the sidebar open.
          const id = current.spec.sandbox.id;
          current = await getSession(id)
            .then((s) => prepareExisting(s, true))
            .catch(() => current);
        }
        continue;
      }

      if (outcome === 'deleted') {
        // The last sandbox: delete it and drop to idle (the menu keeps working).
        if (current) await current.spec.sandbox.delete().catch(() => {});
        current = null;
        stoppedView = null;
        continue;
      }

      // A sandbox whose agent had already exited when we attached (it produced no
      // output and ended at once) must not eject the user from sbx. Drop back
      // to the sidebar instead: the spent PTY was cleared, so re-selecting the
      // sandbox relaunches its agent fresh — or they can switch, delete, or exit.
      if (outcome === 'ended' && session.wasDeadOnArrival()) {
        current = null;
        stoppedView = null;
        continue;
      }

      // 'detached' (x) or 'ended' (an agent the user was using exited) end the run.
      if (current) {
        endMsg =
          outcome === 'detached'
            ? `detached. Reconnect with \`sbx\` (${current.spec.sandbox.id} keeps running, auto-stops when idle).`
            : `session ended. Remove the sandbox with \`sbx rm ${current.spec.sandbox.id}\`.`;
      }
      break;
    }
  } finally {
    session.dispose();
    if (endMsg) log(endMsg);
  }
}

/** Sentinel value for the "custom command" choice in the new-agent picker. */
const CUSTOM_CHOICE = ' custom';

/** Asks which agent/command to run for a new sandbox (modal in the agent pane). */
async function pickNewCommand(session: SbxSession): Promise<string | null> {
  const choice = await session.menu<string>('New sandbox — choose an agent', [
    ...NEW_AGENTS.map((a) => ({ label: a, value: a })),
    { label: 'Custom command…', value: CUSTOM_CHOICE },
  ]);
  if (choice === null) return null;
  if (choice !== CUSTOM_CHOICE) return choice;
  return session.prompt('Custom command', 'e.g. aider --model gpt-4o');
}

/** Creates a new sandbox from the in-session sidebar, keeping the chrome up. */
async function createInSession(session: SbxSession): Promise<Prepared | null> {
  const command = await pickNewCommand(session);
  if (!command) return null;
  const [cmd, ...args] = command.trim().split(/\s+/);
  try {
    const prep = await prepareNew({ command: cmd, args, yolo: true }, sessionPresent(session));
    if (prep) {
      // Keep the sidebar open only when there's another sandbox to switch back
      // to; the very first sandbox (nothing else live) drops straight to its
      // agent, matching the bare-`sbx` startup behaviour.
      const others = (await listSessions()).filter(
        (s) => !DEAD_STATES.has(s.state) && s.id !== prep.spec.sandbox.id,
      );
      prep.spec.openSidebar = others.length > 0;
    }
    return prep;
  } catch (err) {
    session.connecting(`create failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function pushLabel(status: PushStatus, detail?: string): string {
  switch (status) {
    case 'pushing':
      return '…';
    case 'ok':
      return detail ? `✓ ${detail}` : '✓';
    case 'error':
      return '✗';
    default:
      return '';
  }
}
