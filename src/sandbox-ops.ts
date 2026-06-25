/**
 * Convenience operations performed *inside* a running sandbox: resolving the
 * home directory, writing files with restrictive permissions, running commands,
 * and ensuring tmux is installed.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { posix } from 'node:path';

const homeCache = new WeakMap<Sandbox, string>();

/** Resolves and caches the sandbox user's home directory. */
export async function sandboxHome(sandbox: Sandbox): Promise<string> {
  const cached = homeCache.get(sandbox);
  if (cached) return cached;
  const res = await sandbox.process.executeCommand('printf %s "$HOME"');
  const home = (res.result ?? '').trim() || '/home/daytona';
  homeCache.set(sandbox, home);
  return home;
}

/** Runs a command in the sandbox; throws with stderr/stdout if it fails. */
export async function run(
  sandbox: Sandbox,
  command: string,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<string> {
  const res = await sandbox.process.executeCommand(command, opts.cwd, opts.env, opts.timeout);
  if (typeof res.exitCode === 'number' && res.exitCode !== 0) {
    throw new Error(`command failed (exit ${res.exitCode}): ${command}\n${res.result ?? ''}`);
  }
  return res.result ?? '';
}

/**
 * Writes a file into the sandbox, relative to the user's home, creating its
 * parent directory and applying the given octal mode (default 600).
 */
export async function writeHomeFile(
  sandbox: Sandbox,
  relPath: string,
  content: string,
  mode = '600',
): Promise<string> {
  const home = await sandboxHome(sandbox);
  const abs = posix.join(home, relPath);
  const dir = posix.dirname(abs);
  await sandbox.fs.createFolder(dir, '700').catch(() => {
    /* already exists */
  });
  await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), abs);
  await sandbox.fs.setFilePermissions(abs, { mode }).catch(() => {});
  return abs;
}

/** Returns the login name of the user toolbox commands run as. */
export async function whoami(sandbox: Sandbox): Promise<string> {
  const res = await sandbox.process.executeCommand('id -un').catch(() => null);
  return (res?.result ?? '').trim();
}

export interface FileStat {
  exists: boolean;
  size: number;
  owner: string;
  mode: string;
}

/** Stats a file inside the sandbox (GNU stat); exists=false if missing. */
export async function statFile(sandbox: Sandbox, absPath: string): Promise<FileStat> {
  const res = await sandbox.process
    .executeCommand(`stat -c '%s %U %a' ${absPath} 2>/dev/null || echo MISSING`)
    .catch(() => null);
  const out = (res?.result ?? '').trim();
  if (!out || out === 'MISSING') return { exists: false, size: 0, owner: '', mode: '' };
  const [size, owner, mode] = out.split(/\s+/);
  return { exists: true, size: Number(size) || 0, owner: owner ?? '', mode: mode ?? '' };
}

/** Writes a file at an absolute sandbox path, creating its parent directory. */
export async function writeFileAbs(
  sandbox: Sandbox,
  absPath: string,
  content: string,
  mode = '644',
): Promise<void> {
  const dir = posix.dirname(absPath);
  await sandbox.fs.createFolder(dir, '755').catch(() => {
    /* already exists */
  });
  await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), absPath);
  await sandbox.fs.setFilePermissions(absPath, { mode }).catch(() => {});
}

/** Ensures `tmux` is installed in the sandbox (it draws the status bar). */
export async function ensureTmux(sandbox: Sandbox): Promise<void> {
  const check = await sandbox.process.executeCommand('command -v tmux || true');
  if ((check.result ?? '').trim()) return;
  // Install non-interactively; works on the Debian-based background-agents image.
  await run(
    sandbox,
    'sudo apt-get update -qq && sudo apt-get install -y -qq tmux',
    { timeout: 180 },
  );
}
