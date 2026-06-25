/**
 * Adapter around the Daytona TypeScript SDK. The rest of the codebase only
 * talks to Daytona through this module, so SDK-specific details stay in one place.
 */
import { Daytona, type Sandbox } from '@daytonaio/sdk';
import { BASE_SNAPSHOT, LABELS, SANDBOX_PREFIX } from './config.js';
import { sandboxName } from './naming.js';

export type { Sandbox };

/** States in which a sandbox is usable / attachable right now. */
export const RUNNING_STATES = new Set(['started']);
/** States from which a sandbox can be started again. */
export const STARTABLE_STATES = new Set(['stopped', 'archived']);

let client: Daytona | null = null;

/** Lazily constructs the Daytona client, validating the API key up front. */
export function daytona(): Daytona {
  if (client) return client;
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new TeleportError(
      'DAYTONA_API_KEY is not set. Export it before running teleport.\n' +
        '  export DAYTONA_API_KEY=dtn_...',
    );
  }
  client = new Daytona({ apiKey });
  return client;
}

/** A teleport-managed session derived from a sandbox and its labels. */
export interface Session {
  id: string;
  state: string;
  command: string;
  repo: string;
  branch: string;
  base: string;
  agent: string;
  createdAt: string;
  sandbox: Sandbox;
}

export interface CreateSessionParams {
  command: string;
  agent: string;
  repoSlug: string | null;
  baseBranch: string | null;
}

/** Creates a fresh sandbox on the background-agents snapshot with teleport labels. */
export async function createSandbox(params: CreateSessionParams): Promise<Sandbox> {
  const labels: Record<string, string> = {
    [LABELS.managed]: 'true',
    [LABELS.command]: params.command,
    [LABELS.agent]: params.agent,
    [LABELS.created]: new Date().toISOString(),
  };
  if (params.repoSlug) labels[LABELS.repo] = params.repoSlug;
  if (params.baseBranch) labels[LABELS.base] = params.baseBranch;

  // Name the sandbox so it is identifiable in the Daytona dashboard. The suffix
  // keeps names unique across concurrent sessions.
  const slug = params.repoSlug?.split('/').pop() || params.agent;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const name = sandboxName(SANDBOX_PREFIX, slug, suffix);

  const sandbox = await daytona().create(
    { name, snapshot: BASE_SNAPSHOT, labels, autoStopInterval: 30 },
    { timeout: 180 },
  );
  return sandbox;
}

/** Records the resolved working branch on the sandbox labels after it is created. */
export async function tagBranch(sandbox: Sandbox, branch: string): Promise<void> {
  await sandbox.setLabels({ ...sandbox.labels, [LABELS.branch]: branch });
}

/** Lists teleport-managed sessions, optionally filtered to a single repo slug. */
export async function listSessions(repoSlug?: string | null): Promise<Session[]> {
  const filter: Record<string, string> = { [LABELS.managed]: 'true' };
  if (repoSlug) filter[LABELS.repo] = repoSlug;
  const result = await daytona().list(filter);
  return result.items.map(toSession).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Fetches a single sandbox by id and maps it to a Session. */
export async function getSession(id: string): Promise<Session> {
  const sandbox = await daytona().get(id);
  return toSession(sandbox);
}

function toSession(sandbox: Sandbox): Session {
  const l = sandbox.labels ?? {};
  return {
    id: sandbox.id,
    state: sandbox.state ?? 'unknown',
    command: l[LABELS.command] ?? '',
    repo: l[LABELS.repo] ?? '',
    branch: l[LABELS.branch] ?? '',
    base: l[LABELS.base] ?? '',
    agent: l[LABELS.agent] ?? '',
    createdAt: l[LABELS.created] ?? '',
    sandbox,
  };
}

/** Ensures a sandbox is started; starts (and waits) if stopped/archived. */
export async function ensureStarted(sandbox: Sandbox): Promise<void> {
  await sandbox.refreshData();
  if (RUNNING_STATES.has(sandbox.state ?? '')) return;
  if (STARTABLE_STATES.has(sandbox.state ?? '')) {
    await sandbox.start(180);
    await sandbox.waitUntilStarted(180);
    return;
  }
  // creating/starting/restoring: just wait for it.
  await sandbox.waitUntilStarted(180);
}

/** A custom error whose message is safe to show the user directly. */
export class TeleportError extends Error {}
