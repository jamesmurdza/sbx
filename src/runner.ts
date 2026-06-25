/**
 * High-level orchestration for starting a new sandbox and reconnecting to an
 * existing one: ties together repo inspection, the credential modal, sandbox
 * creation, repo clone + teleport branch, and auto-push. A single
 * `runSessionLoop` then drives one persistent `TeleportSession` (one compositor),
 * swapping sandboxes in place on a switch so there's no teardown/flash.
 */
import { knownAgent, yoloFlagFor, SANDBOX_REPO_PATH } from './config.js';
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
import { TeleportSession, statusBridge, type AttachSpec, type SessionDeps } from './session.js';
import type { BarInfo } from './tui/statusbar.js';
import type { SidebarItem } from './tui/sidebar.js';
import { overlayMenu, overlayConfirm, overlayPrompt } from './tui/overlay.js';

function log(msg: string): void {
  process.stdout.write(`teleport: ${msg}\n`);
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
 * the bare terminal (fullscreen overlays, stdout logging); in-session it floats
 * overlays over the live compositor and shows progress in the agent placeholder.
 */
interface Present {
  fullscreen: boolean;
  wrap<T>(fn: () => Promise<T>): Promise<T>;
  note(msg: string): void;
}

const TERMINAL_PRESENT: Present = {
  fullscreen: true,
  wrap: (fn) => fn(),
  note: (m) => log(m),
};

/** Agents offered in the in-session "new sandbox" picker. */
const NEW_AGENTS = ['claude', 'codex', 'opencode'];

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
    }));
}

/** Full flow for `teleport <command>`: create the sandbox, then run the session. */
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
    const ok = await present.wrap(() =>
      overlayConfirm('Not in a git repo. Create a new blank sandbox with no repo?', {
        fullscreen: present.fullscreen,
      }),
    );
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
    const picked = await present.wrap(() =>
      overlayMenu<CredChoice>(
        `${opts.command} credentials`,
        [
          ...sources.map((s) => ({ label: s.label, detail: s.detail, value: s as CredChoice })),
          { label: 'Skip', value: 'none' as CredChoice },
        ],
        { fullscreen: present.fullscreen },
      ),
    );
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

  // Clone repo + create teleport branch + start auto-push.
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
 * `teleport` with no args: attach to the most-recent sandbox with the sidebar
 * open as the entry menu, or — when there are none — open the menu idle so it
 * still works (and you can create one).
 */
export async function openSandboxes(): Promise<void> {
  const live = (await listSessions()).filter((s) => !DEAD_STATES.has(s.state));
  if (live.length === 0) {
    await runSessionLoop(null);
    return;
  }
  const target = live.find((s) => RUNNING_STATES.has(s.state)) ?? live[0];
  log(`connecting to ${target.id.slice(0, 8)}…`);
  const first = await prepareExisting(target, true);
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

async function runSessionLoop(first: Prepared | null): Promise<void> {
  const deps: SessionDeps = {
    switchTarget: {},
    deleteSandbox: async (id) => {
      await (await getSession(id)).sandbox.delete();
    },
  };
  const session = new TeleportSession(deps);
  let current = first;
  let endMsg = '';
  try {
    for (;;) {
      // Attached to a sandbox, or idle (chrome up, no agent) when there is none.
      let outcome;
      if (current) {
        try {
          outcome = await session.attach(current.spec);
        } finally {
          current.autopush?.stop();
        }
      } else {
        outcome = await session.idle(IDLE_MESSAGE, () => listSandboxItems(''));
      }

      if (outcome === 'switch' && deps.switchTarget.id) {
        const id = deps.switchTarget.id;
        const openSidebar = deps.switchTarget.openSidebar ?? false;
        deps.switchTarget.id = undefined;
        deps.switchTarget.openSidebar = undefined;
        session.connecting(`connecting to ${id.slice(0, 8)}…`);
        const next = await getSession(id).catch(() => null);
        current = next ? await prepareExisting(next, openSidebar) : null;
        continue;
      }

      if (outcome === 'new') {
        const created = await createInSession(session);
        if (created) {
          current = created;
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
        continue;
      }

      // 'detached' (x) or 'ended' (agent exited) end the run.
      if (current) {
        endMsg =
          outcome === 'detached'
            ? `detached. Reconnect with \`teleport\` (${current.spec.sandbox.id} keeps running, auto-stops when idle).`
            : `session ended. Remove the sandbox with \`teleport rm ${current.spec.sandbox.id}\`.`;
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

/** Asks which agent/command to run for a new sandbox (over the live compositor). */
async function pickNewCommand(session: TeleportSession): Promise<string | null> {
  const choice = await session.modal(() =>
    overlayMenu<string>(
      'New sandbox — choose an agent',
      [
        ...NEW_AGENTS.map((a) => ({ label: a, value: a })),
        { label: 'Custom command…', value: CUSTOM_CHOICE },
      ],
      { fullscreen: false },
    ),
  );
  if (choice === null) return null;
  if (choice !== CUSTOM_CHOICE) return choice;
  return session.modal(() =>
    overlayPrompt('Custom command', { fullscreen: false, placeholder: 'e.g. aider --model gpt-4o' }),
  );
}

/** Creates a new sandbox from the in-session sidebar, keeping the chrome up. */
async function createInSession(session: TeleportSession): Promise<Prepared | null> {
  const command = await pickNewCommand(session);
  if (!command) return null;
  const [cmd, ...args] = command.trim().split(/\s+/);
  const present: Present = {
    fullscreen: false,
    wrap: (fn) => session.modal(fn),
    note: (m) => session.connecting(m),
  };
  try {
    return await prepareNew({ command: cmd, args, yolo: true }, present);
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
