/**
 * High-level orchestration for starting a new sandbox and reconnecting to an
 * existing one: ties together repo inspection, the credential modal, sandbox
 * creation, repo clone + teleport branch, auto-push, and the interactive attach.
 */
import { knownAgent, yoloFlagFor, SANDBOX_REPO_PATH } from './config.js';
import {
  createSandbox,
  ensureStarted,
  getSession,
  tagBranch,
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
import { attach, setLiveStatus, type AttachOutcome } from './session.js';
import type { BarInfo } from './tui/tmux.js';
import { overlayMenu, overlayConfirm } from './tui/overlay.js';

function log(msg: string): void {
  process.stdout.write(`teleport: ${msg}\n`);
}

export interface StartOptions {
  command: string;
  args: string[];
  /** Append the agent's permission-skipping ("yolo") flag. */
  yolo?: boolean;
}

/** Full flow for `teleport <command>`. */
export async function startNew(opts: StartOptions): Promise<AttachOutcome> {
  const cwd = process.cwd();
  const repo = await inspectLocalRepo(cwd);

  // By default, insert the agent's permission-skipping flag (the sandbox is
  // throwaway); --safe disables this. Agents with no known flag run unchanged.
  const yoloFlag = opts.yolo !== false ? yoloFlagFor(opts.command) : undefined;
  const runCommand = [opts.command, yoloFlag, ...opts.args].filter(Boolean).join(' ');

  const hasRepo = !!(repo && repo.originUrl);
  if (!hasRepo) {
    const ok = await overlayConfirm(
      'Not in a git repo. Create a new blank sandbox with no repo?',
      { fullscreen: true },
    );
    if (!ok) {
      log('cancelled.');
      return 'ended';
    }
  } else if (repo) {
    if (repo.dirty || repo.ahead > 0) {
      const bits = [
        repo.dirty ? 'uncommitted changes' : null,
        repo.ahead > 0 ? `${repo.ahead} unpushed commit(s)` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      log(`warning: ${bits} won't be in the sandbox (it clones from origin).`);
    }
  }

  // Choose credentials (modal) up front; applied after the sandbox exists.
  // Escape (null) quits; the "Neither" option ('none') proceeds without creds.
  const agent = knownAgent(opts.command);
  const sources = agent ? await discoverSources(agent) : [];
  type CredChoice = (typeof sources)[number] | 'none';
  let chosen: (typeof sources)[number] | null = null;
  if (sources.length > 0) {
    const picked = await overlayMenu<CredChoice>(
      `${opts.command} credentials`,
      [
        ...sources.map((s) => ({ label: s.label, detail: s.detail, value: s as CredChoice })),
        { label: 'Skip', value: 'none' as CredChoice },
      ],
      { fullscreen: true },
    );
    if (picked === null) {
      log('cancelled.');
      return 'ended';
    }
    chosen = picked === 'none' ? null : picked;
  }

  log(`creating sandbox on the background-agents snapshot…`);
  const sandbox = await createSandbox({
    command: runCommand,
    agent: opts.command,
    repoSlug: repo?.slug ?? null,
    baseBranch: repo?.branch ?? null,
  });
  log(`sandbox ${sandbox.id} created; starting…`);
  await ensureStarted(sandbox);

  // Apply credential choice now that we have a sandbox. Start from the agent's
  // static env (e.g. CLAUDE_CODE_NO_FLICKER) and layer credential env on top.
  let env: Record<string, string> = { ...(agent?.env ?? {}) };
  if (chosen) {
    const result = await applyCredential(sandbox, chosen.payload);
    env = { ...env, ...result.env };
    log(`${opts.command} credentials: ${result.summary}`);
    if (!result.ok) log('the agent may prompt you to log in because the credential file did not verify.');
  }

  // Clone repo + create teleport branch + start auto-push.
  let cwdInSandbox: string | undefined;
  let autopush: AutoPush | undefined;
  const bar: BarInfo = {
    shortId: sandbox.id.slice(0, 8),
    agent: opts.command,
    repo: repo?.slug ?? undefined,
  };

  if (hasRepo && repo) {
    const creds = await resolveGitHubToken();
    if (!creds) {
      log('warning: no GitHub token found — cloning may fail for private repos and auto-push is disabled.');
    }
    try {
      const setup = await setupRepo(sandbox, {
        originUrl: repo.originUrl!,
        baseBranch: repo.branch ?? 'main',
        creds: creds ?? { username: '', password: '', source: 'none' },
      });
      cwdInSandbox = setup.repoPath;
      bar.branch = setup.branch;
      await tagBranch(sandbox, setup.branch);
      log(`cloned ${repo.slug} and checked out ${setup.branch}.`);
      if (creds) {
        autopush = new AutoPush(sandbox, {
          repoPath: setup.repoPath,
          branch: setup.branch,
          creds,
          onStatus: (s, d) => void setLiveStatus(sandbox, pushLabel(s, d)),
        });
        autopush.start();
      }
    } catch (err) {
      log(`warning: repo setup failed: ${err instanceof Error ? err.message : String(err)}`);
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

  return runInteractive(sandbox, runCommand, cwdInSandbox, env, bar, autopush);
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

/** Full flow for reconnecting to an existing sandbox. */
export async function reconnect(session: Session): Promise<AttachOutcome> {
  log(`reconnecting to ${session.id} (${session.state})…`);
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
  const cwdInSandbox = session.repo ? SANDBOX_REPO_PATH : undefined;
  if (session.repo && session.branch) {
    const creds = await resolveGitHubToken();
    if (creds) {
      autopush = new AutoPush(session.sandbox, {
        repoPath: SANDBOX_REPO_PATH,
        branch: session.branch,
        creds,
        onStatus: (s, d) => void setLiveStatus(session.sandbox, pushLabel(s, d)),
      });
      autopush.start();
    }
  }

  return runInteractive(session.sandbox, session.command, cwdInSandbox, env, bar, autopush);
}

async function runInteractive(
  sandbox: import('@daytonaio/sdk').Sandbox,
  command: string,
  cwd: string | undefined,
  env: Record<string, string>,
  bar: BarInfo,
  autopush?: AutoPush,
): Promise<AttachOutcome> {
  const outcome = await attach(sandbox, { command, cwd, env, bar });
  autopush?.stop();
  switch (outcome) {
    case 'switch':
      log(`switching sandbox (${sandbox.id} keeps running, auto-stops when idle).`);
      break;
    case 'detached':
      log(`detached. Reconnect with \`teleport\` (sandbox ${sandbox.id} keeps running, auto-stops when idle).`);
      break;
    case 'stopped':
      await sandbox.stop().catch((e) => log(`failed to stop: ${e instanceof Error ? e.message : e}`));
      log(`stopped ${sandbox.id}. Reconnect with \`teleport\` to restart it.`);
      break;
    case 'deleted':
      await sandbox.delete().catch((e) => log(`failed to delete: ${e instanceof Error ? e.message : e}`));
      log(`deleted ${sandbox.id}.`);
      break;
    default:
      log(`sandbox session ended. Remove the sandbox with \`teleport rm ${sandbox.id}\`.`);
  }
  return outcome;
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
