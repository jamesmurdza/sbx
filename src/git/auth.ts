/**
 * Resolves a GitHub token on the LOCAL machine. The token is never written into
 * the sandbox — it is only passed per-call to the Daytona git toolbox.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitCredentials {
  username: string;
  /** The token, used as the password in basic auth to GitHub over https. */
  password: string;
  source: string;
}

/** Tries `gh auth token`, then GH_TOKEN / GITHUB_TOKEN. Returns null if none. */
export async function resolveGitHubToken(): Promise<GitCredentials | null> {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken && envToken.trim()) {
    return { username: 'x-access-token', password: envToken.trim(), source: 'GH_TOKEN env' };
  }
  try {
    const { stdout } = await exec('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (token) {
      return { username: 'x-access-token', password: token, source: 'gh auth token' };
    }
  } catch {
    /* gh not installed or not logged in */
  }
  return null;
}
