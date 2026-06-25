/**
 * Read-only introspection of the user's LOCAL git repository (the cwd where
 * `teleport` was invoked). Used to decide whether to clone, which branch to
 * clone, and whether to warn about unpushed/dirty state.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface LocalRepoInfo {
  /** Absolute toplevel of the repo. */
  root: string;
  /** Current branch name (or null if detached HEAD). */
  branch: string | null;
  /** origin remote fetch URL, normalised to https form. */
  originUrl: string | null;
  /** owner/name parsed from the origin URL, used as the repo label/tag. */
  slug: string | null;
  /** True if the working tree has uncommitted changes. */
  dirty: boolean;
  /** Number of commits ahead of the upstream (0 if no upstream / unknown). */
  ahead: number;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** Returns repo info if cwd is inside a git repo with usable state, else null. */
export async function inspectLocalRepo(cwd: string): Promise<LocalRepoInfo | null> {
  let root: string;
  try {
    root = await git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null; // not a git repo
  }

  let branch: string | null = null;
  try {
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    branch = b === 'HEAD' ? null : b;
  } catch {
    branch = null;
  }

  let originUrl: string | null = null;
  try {
    originUrl = normaliseRemoteUrl(await git(['remote', 'get-url', 'origin'], root));
  } catch {
    originUrl = null;
  }

  let dirty = false;
  try {
    dirty = (await git(['status', '--porcelain'], root)).length > 0;
  } catch {
    dirty = false;
  }

  let ahead = 0;
  try {
    const counts = await git(['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], root);
    // output: "<behind>\t<ahead>"
    const parts = counts.split(/\s+/);
    ahead = Number(parts[1] ?? 0) || 0;
  } catch {
    ahead = 0; // no upstream configured
  }

  return { root, branch, originUrl, slug: slugFromUrl(originUrl), dirty, ahead };
}

/** Normalises an SSH or https git remote URL to an https URL (no embedded creds). */
export function normaliseRemoteUrl(url: string): string {
  let u = url.trim();
  // git@github.com:owner/repo.git  ->  https://github.com/owner/repo.git
  const sshMatch = u.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    u = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  // ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo.git
  u = u.replace(/^ssh:\/\/git@/, 'https://');
  // Strip any embedded credentials: https://user:tok@host/... -> https://host/...
  u = u.replace(/^(https?:\/\/)[^/@]+@/, '$1');
  return u;
}

/** Parses "owner/repo" from a normalised remote URL. */
export function slugFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
