/**
 * Applies a chosen credential source to a sandbox: file-based credentials are
 * uploaded (chmod 600) and verified, env-based credentials are returned so the
 * caller can inject them into the agent's tmux session environment (kept out of
 * shell history). The GitHub token is never handled here — it stays on the local
 * machine and is only ever passed per-call to the git toolbox.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { statFile, whoami, writeHomeFile } from '../sandbox-ops.js';
import type { CredentialPayload } from './sources.js';

export interface ApplyResult {
  /** Env var(s) to inject into the agent session. */
  env: Record<string, string>;
  /** Human-readable summary of what happened (logged by the caller). */
  summary: string;
  /** False when a file was written but could not be verified afterwards. */
  ok: boolean;
}

/** Applies a payload, verifies file writes, and reports what happened. */
export async function applyCredential(
  sandbox: Sandbox,
  payload: CredentialPayload,
): Promise<ApplyResult> {
  const env: Record<string, string> = {};
  let summary = 'no credentials applied';
  let ok = true;

  if (payload.file) {
    const abs = await writeHomeFile(sandbox, payload.file.sandboxRelPath, payload.file.content, '600');
    const [stat, user] = await Promise.all([statFile(sandbox, abs), whoami(sandbox)]);
    ok = stat.exists && stat.size > 0;
    summary = ok
      ? `wrote ${abs} (${stat.size} bytes, owner ${stat.owner} mode ${stat.mode}; sandbox user ${user})`
      : `WARNING: credential file ${abs} is missing or empty after write (sandbox user ${user})`;

    // Companion config files (e.g. ~/.claude.json) so the agent recognises the login.
    for (const c of payload.companions ?? []) {
      const cabs = await writeHomeFile(sandbox, c.sandboxRelPath, c.content, '600');
      const cstat = await statFile(sandbox, cabs);
      summary += cstat.exists
        ? `; also wrote ${c.sandboxRelPath} (${cstat.size} bytes)`
        : `; WARNING: failed to write ${c.sandboxRelPath}`;
    }
  }

  if (payload.env) {
    env[payload.env.name] = payload.env.value;
    summary = `injecting ${payload.env.name} into the session`;
  }

  return { env, summary, ok };
}
