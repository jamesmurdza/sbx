/**
 * Discovers available credential sources for a known agent on the LOCAL machine:
 * an API-key env var, the macOS keychain, and/or a local credential file.
 * Only sources that actually exist are returned, so the modal can offer exactly
 * the right choices (e.g. env + keychain -> three options including "Neither").
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { AgentDef } from '../config.js';

const exec = promisify(execFile);

/** A file to write into the sandbox, relative to the user's home. */
export interface SandboxFile {
  sandboxRelPath: string;
  content: string;
}

/** What importing a source actually does inside the sandbox. */
export interface CredentialPayload {
  /** Inject an env var into the agent's session. */
  env?: { name: string; value: string };
  /** Upload a credential file (path relative to the sandbox home). */
  file?: SandboxFile;
  /** Additional config files copied alongside the credential file. */
  companions?: SandboxFile[];
}

export interface DiscoveredSource {
  kind: 'env' | 'keychain' | 'file';
  label: string;
  detail: string;
  payload: CredentialPayload;
}

/** Reads a generic password from the macOS keychain, or null if absent. */
async function keychainSecret(service: string): Promise<string | null> {
  if (platform() !== 'darwin') return null;
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ]);
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Probes a keychain item and reports why it did or didn't resolve (for doctor). */
export async function probeKeychain(
  service: string,
): Promise<{ found: boolean; detail: string }> {
  if (platform() !== 'darwin') return { found: false, detail: 'not macOS' };
  try {
    const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w']);
    const v = stdout.trim();
    return v
      ? { found: true, detail: `found (${v.length} chars)` }
      : { found: false, detail: 'item found but password is empty' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { found: false, detail: `security: ${(err.stderr || err.message || 'error').trim()}` };
  }
}

/** Reads a local file's contents, or null if missing/unreadable. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Reads the agent's companion config files that exist locally. */
async function readCompanions(agent: AgentDef): Promise<SandboxFile[]> {
  if (!agent.companionFiles) return [];
  const files: SandboxFile[] = [];
  for (const f of agent.companionFiles) {
    const content = await readIfExists(join(homedir(), f.local));
    if (content) files.push({ sandboxRelPath: f.sandbox, content });
  }
  return files;
}

/** Returns all credential sources detected for the given agent. */
export async function discoverSources(agent: AgentDef): Promise<DiscoveredSource[]> {
  const sources: DiscoveredSource[] = [];
  // Companion config files travel with file/keychain (subscription) imports.
  const companions = await readCompanions(agent);

  // 1. API key env var.
  if (agent.apiKeyEnv) {
    const value = process.env[agent.apiKeyEnv];
    if (value && value.trim()) {
      sources.push({
        kind: 'env',
        label: 'Environment variable',
        detail: agent.apiKeyEnv,
        payload: { env: { name: agent.apiKeyEnv, value } },
      });
    }
  }

  // 2. macOS keychain -> sandbox credential file.
  if (agent.keychainService && agent.sandboxCredFile) {
    const secret = await keychainSecret(agent.keychainService);
    if (secret) {
      sources.push({
        kind: 'keychain',
        label: 'macOS Keychain',
        detail: agent.keychainService,
        payload: { file: { sandboxRelPath: agent.sandboxCredFile, content: secret }, companions },
      });
    }
  }

  // 3. Local credential file -> sandbox credential file.
  if (agent.localCredFile && agent.sandboxCredFile) {
    const content = await readIfExists(join(homedir(), agent.localCredFile));
    if (content) {
      sources.push({
        kind: 'file',
        label: 'Local file',
        detail: `~/${agent.localCredFile}`,
        payload: { file: { sandboxRelPath: agent.sandboxCredFile, content }, companions },
      });
    }
  }

  return sources;
}
