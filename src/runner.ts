/**
 * High-level orchestration for starting a new session and reconnecting to an
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
import { run, sandboxHome } from './sandbox-ops.js';
import { resolveGitHubToken } from './git/auth.js';
import { setupRepo } from './git/repo.js';
import { AutoPush, type PushStatus } from './git/autopush.js';
import { attach, setLiveStatus } from './session.js';
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
export async function startNew(opts: StartOptions): Promise<void> {
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
      return;
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
      return;
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

  // Apply credential choice now that we have a sandbox.
  let env: Record<string, string> = {};
  if (chosen) {
    const result = await applyCredential(sandbox, chosen.payload);
    env = result.env;
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

  // Pre-trust the working directory so Claude skips its folder-trust prompt.
  if (opts.command === 'claude') {
    await trustClaudeDir(sandbox, cwdInSandbox ?? (await sandboxHome(sandbox)));
  }

  await runInteractive(sandbox, runCommand, cwdInSandbox, env, bar, autopush);
}

/**
 * Marks a directory as trusted in the sandbox's ~/.claude.json so Claude does
 * not show its "Is this a project you trust?" prompt on launch. Best-effort.
 */
async function trustClaudeDir(sandbox: import('@daytonaio/sdk').Sandbox, dir: string): Promise<void> {
  try {
    const home = await sandboxHome(sandbox);
    const confPath = `${home}/.claude.json`;
    const js =
      `const fs=require('fs');const p=${JSON.stringify(confPath)};` +
      `let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){}` +
      `c.projects=c.projects||{};const d=${JSON.stringify(dir)};` +
      `c.projects[d]={...(c.projects[d]||{}),hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};` +
      `fs.writeFileSync(p,JSON.stringify(c,null,2));`;
    await run(sandbox, `node -e '${js.replace(/'/g, `'\\''`)}'`);
  } catch (err) {
    log(`note: could not pre-trust ${dir} for claude (${err instanceof Error ? err.message : err}).`);
  }
}

/** Full flow for reconnecting to an existing session. */
export async function reconnect(session: Session): Promise<void> {
  log(`reconnecting to ${session.id} (${session.state})…`);
  await ensureStarted(session.sandbox);

  const bar: BarInfo = {
    shortId: session.id.slice(0, 8),
    agent: session.agent || session.command,
    repo: session.repo || undefined,
    branch: session.branch || undefined,
  };

  // Best-effort re-inject env-var credentials (files already persist on disk).
  let env: Record<string, string> = {};
  const agent = knownAgent(session.agent || session.command);
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

  await runInteractive(session.sandbox, session.command, cwdInSandbox, env, bar, autopush);
}

async function runInteractive(
  sandbox: import('@daytonaio/sdk').Sandbox,
  command: string,
  cwd: string | undefined,
  env: Record<string, string>,
  bar: BarInfo,
  autopush?: AutoPush,
): Promise<void> {
  const outcome = await attach(sandbox, { command, cwd, env, bar });
  autopush?.stop();
  switch (outcome) {
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
      log(`session ended. Remove the sandbox with \`teleport rm ${sandbox.id}\`.`);
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
