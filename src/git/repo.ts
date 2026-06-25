/**
 * Clones the user's repo into the sandbox via the Daytona git toolbox and checks
 * out the always-unique teleport working branch. Auth is passed per-call; the
 * token is never persisted in the sandbox.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { SANDBOX_REPO_PATH } from '../config.js';
import { teleportBranch } from '../naming.js';
import type { GitCredentials } from './auth.js';

export interface SetupRepoParams {
  originUrl: string;
  baseBranch: string;
  creds: GitCredentials;
}

export interface SetupRepoResult {
  repoPath: string;
  branch: string;
}

/** Clones the current branch, then creates and checks out teleport/<base>/<id>. */
export async function setupRepo(
  sandbox: Sandbox,
  params: SetupRepoParams,
): Promise<SetupRepoResult> {
  const branch = teleportBranch(params.baseBranch, sandbox.id);

  await sandbox.git.clone(
    params.originUrl,
    SANDBOX_REPO_PATH,
    params.baseBranch,
    undefined,
    params.creds.username,
    params.creds.password,
  );

  await sandbox.git.createBranch(SANDBOX_REPO_PATH, branch);
  await sandbox.git.checkoutBranch(SANDBOX_REPO_PATH, branch);

  return { repoPath: SANDBOX_REPO_PATH, branch };
}
