/**
 * `teleport doctor` — preflight diagnostics. Reports pass/warn/fail for each
 * requirement with remediation hints. Exits non-zero if a hard requirement
 * fails, so it is usable in scripts/CI.
 */
import { BASE_SNAPSHOT, AGENTS } from './config.js';
import { daytona } from './daytona.js';
import { inspectLocalRepo } from './local-git.js';
import { resolveGitHubToken } from './git/auth.js';
import { discoverSources, probeKeychain } from './auth/sources.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  label: string;
  detail: string;
}

const ICON: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };

export async function runDoctor(cwd: string): Promise<number> {
  const checks: Check[] = [];

  // 1. Daytona API key + reachability.
  if (!process.env.DAYTONA_API_KEY) {
    checks.push({
      level: 'fail',
      label: 'DAYTONA_API_KEY',
      detail: 'not set — export DAYTONA_API_KEY=dtn_...',
    });
  } else {
    try {
      await daytona().list({ teleport: 'true' });
      checks.push({ level: 'ok', label: 'Daytona API', detail: 'authenticated and reachable' });
    } catch (err) {
      checks.push({
        level: 'fail',
        label: 'Daytona API',
        detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  checks.push({ level: 'ok', label: 'Base snapshot', detail: BASE_SNAPSHOT });

  // 2. GitHub token (warn only — git features degrade gracefully).
  const creds = await resolveGitHubToken();
  checks.push(
    creds
      ? { level: 'ok', label: 'GitHub token', detail: `found via ${creds.source}` }
      : {
          level: 'warn',
          label: 'GitHub token',
          detail: 'none found — auto-push disabled (run `gh auth login` or set GH_TOKEN)',
        },
  );

  // 3. Per-agent credential sources.
  for (const agent of Object.values(AGENTS)) {
    const sources = await discoverSources(agent);
    checks.push(
      sources.length > 0
        ? {
            level: 'ok',
            label: `${agent.name} creds`,
            detail: sources.map((s) => s.kind).join(', '),
          }
        : { level: 'warn', label: `${agent.name} creds`, detail: 'none detected locally' },
    );
    // On macOS, explain the keychain result explicitly (found / denied / missing).
    if (process.platform === 'darwin' && agent.keychainService) {
      const probe = await probeKeychain(agent.keychainService);
      checks.push({
        level: probe.found ? 'ok' : 'warn',
        label: `${agent.name} keychain`,
        detail: `"${agent.keychainService}" — ${probe.detail}`,
      });
    }
  }

  // 4. Local git repo state.
  const repo = await inspectLocalRepo(cwd);
  if (!repo) {
    checks.push({ level: 'warn', label: 'Git repo', detail: 'cwd is not a git repo (blank sandbox)' });
  } else if (!repo.originUrl) {
    checks.push({ level: 'warn', label: 'Git repo', detail: 'no origin remote — cannot clone' });
  } else {
    const flags = [repo.dirty ? 'dirty' : null, repo.ahead > 0 ? `${repo.ahead} unpushed` : null]
      .filter(Boolean)
      .join(', ');
    checks.push({
      level: flags ? 'warn' : 'ok',
      label: 'Git repo',
      detail: `${repo.slug ?? repo.root} @ ${repo.branch ?? 'detached'}${flags ? ` (${flags}; won't be in sandbox)` : ''}`,
    });
  }

  // Report.
  process.stdout.write('\nteleport doctor\n\n');
  for (const c of checks) {
    process.stdout.write(`  ${ICON[c.level]} ${c.label.padEnd(16)} ${c.detail}\n`);
  }
  process.stdout.write('\n');

  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
