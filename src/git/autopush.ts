/**
 * Watches the sandbox repo for new commits on the teleport working branch and
 * pushes them to GitHub via the git toolbox (token passed per-call, never stored
 * in the sandbox). Pushing is debounced by the poll interval and serialised so
 * overlapping pushes never run. The original/base branch is never pushed.
 */
import type { Sandbox } from '@daytonaio/sdk';
import { run } from '../sandbox-ops.js';
import type { GitCredentials } from './auth.js';

export type PushStatus = 'idle' | 'pushing' | 'ok' | 'error';

export interface AutoPushOptions {
  repoPath: string;
  branch: string;
  creds: GitCredentials;
  intervalMs?: number;
  onStatus?: (status: PushStatus, detail?: string) => void;
}

export class AutoPush {
  private timer: NodeJS.Timeout | null = null;
  private lastPushedSha: string | null = null;
  private busy = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly opts: AutoPushOptions,
  ) {}

  start(): void {
    const interval = this.opts.intervalMs ?? 5000;
    this.timer = setInterval(() => void this.tick(), interval);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll: push if HEAD advanced past the last push and the branch matches. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = (await run(this.sandbox, `git -C ${this.opts.repoPath} rev-parse HEAD`)).trim();
      const current = (
        await run(this.sandbox, `git -C ${this.opts.repoPath} rev-parse --abbrev-ref HEAD`)
      ).trim();

      // Safety: only ever push our own teleport branch.
      if (current !== this.opts.branch) return;
      if (!head || head === this.lastPushedSha) return;

      this.opts.onStatus?.('pushing');
      await this.sandbox.git.push(this.opts.repoPath, this.opts.creds.username, this.opts.creds.password);
      this.lastPushedSha = head;
      this.opts.onStatus?.('ok', head.slice(0, 7));
    } catch (err) {
      this.opts.onStatus?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  /** Pushes immediately if there is anything new (used by `teleport push`). */
  async pushNow(): Promise<void> {
    await this.tick();
  }
}
