/**
 * teleport entry point: parses argv and dispatches to the right flow.
 */
import { parseArgs, USAGE, type Command } from './args.js';
import {
  TeleportError,
  getSession,
  listSessions,
  DEAD_STATES,
  RUNNING_STATES,
  type Session,
} from './daytona.js';
import { startNew, reconnect, type SwitchRef } from './runner.js';
import { runDoctor } from './doctor.js';

function out(msg: string): void {
  process.stdout.write(msg + '\n');
}

function age(iso: string): string {
  if (!iso) return '?';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatSession(s: Session): string {
  const parts = [
    s.id.slice(0, 12).padEnd(12),
    (s.state || '?').padEnd(9),
    (s.command || s.agent || '?').padEnd(14),
    (s.repo || '-').padEnd(24),
    s.branch || '-',
  ];
  return parts.join('  ') + `  (${age(s.createdAt)})`;
}

async function listCommand(): Promise<number> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    out('No teleport sandboxes. Start one with `teleport <command>`.');
    return 0;
  }
  out('');
  out('  ID            STATE      COMMAND         REPO                      BRANCH');
  for (const s of sessions) out('  ' + formatSession(s));
  out('');
  return 0;
}

/**
 * `teleport` with no args: open the sidebar (the single sandbox menu). There is
 * no separate startup picker — we attach to the most-recent sandbox and open the
 * sidebar immediately, so you can browse, switch, stop, and delete from there.
 */
async function pickerCommand(switchRef: SwitchRef = {}): Promise<number> {
  // Loop so a 'switch' from the sidebar reconnects to the chosen sandbox.
  for (;;) {
    let target: Session | null = null;
    let openSidebar = false;

    // A sandbox chosen from the sidebar → land in it directly. A delete/stop
    // hand-off keeps the sidebar open so management continues uninterrupted.
    if (switchRef.id) {
      const id = switchRef.id;
      switchRef.id = undefined;
      openSidebar = switchRef.openSidebar ?? false;
      switchRef.openSidebar = undefined;
      target = await getSession(id).catch(() => null);
      if (!target) out(`Could not open sandbox ${id}.`);
    }

    // Otherwise (bare `teleport`) attach to the most-recent sandbox and open the
    // sidebar so it acts as the entry menu.
    if (!target) {
      const live = (await listSessions()).filter((s) => !DEAD_STATES.has(s.state));
      if (live.length === 0) {
        out('No open sandboxes. Run `teleport <command>` to start one.');
        return 0;
      }
      target = live.find((s) => RUNNING_STATES.has(s.state)) ?? live[0];
      openSidebar = true;
    }

    const outcome = await reconnect(target, switchRef, openSidebar);
    if (outcome !== 'switch') return 0;
  }
}

async function stopCommand(id: string): Promise<number> {
  const s = await getSession(id);
  await s.sandbox.stop();
  out(`Stopped ${id}.`);
  return 0;
}

async function rmCommand(id: string): Promise<number> {
  const s = await getSession(id);
  await s.sandbox.delete();
  out(`Deleted ${id}.`);
  return 0;
}

async function pushCommand(id?: string): Promise<number> {
  out('Auto-push runs while a session is attached. To push on demand, reconnect with `teleport`.');
  if (id) out(`(Targeted session: ${id})`);
  return 0;
}

async function dispatch(cmd: Command): Promise<number> {
  switch (cmd.type) {
    case 'help':
      out(USAGE);
      return 0;
    case 'list':
      return pickerCommand();
    case 'ls':
      return listCommand();
    case 'doctor':
      return runDoctor(process.cwd());
    case 'stop':
      return stopCommand(cmd.id);
    case 'rm':
      return rmCommand(cmd.id);
    case 'push':
      return pushCommand(cmd.id);
    case 'run': {
      const switchRef: SwitchRef = {};
      const outcome = await startNew({ command: cmd.command, args: cmd.args, yolo: cmd.yolo }, switchRef);
      // A 'switch' (sidebar pick or menu) hands off to the picker loop, which
      // reconnects straight to switchRef.id when the sidebar chose a sandbox.
      if (outcome === 'switch') return pickerCommand(switchRef);
      return 0;
    }
  }
}

/**
 * Sequence that returns the terminal to a sane state: mouse reporting off,
 * autowrap on, cursor visible, and back out of the alternate screen. The
 * compositor normally does this on teardown, but if anything throws mid-session
 * we must still run it — otherwise the user is left with a corrupted terminal
 * (stuck in alt-screen with mouse escapes leaking, as `^[[<64;…M`).
 */
const TERM_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l';

function restoreTerminal(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(TERM_RESET);
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch {
    /* best effort */
  }
}

/** Last-resort handler: restore the terminal, print a clean error, exit. */
function onFatal(err: unknown): void {
  restoreTerminal();
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nteleport: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.type === 'error') {
    process.stderr.write(parsed.message + '\n\n' + USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await dispatch(parsed);
  } catch (err) {
    if (err instanceof TeleportError) {
      process.stderr.write(`teleport: ${err.message}\n`);
    } else {
      process.stderr.write(`teleport: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
