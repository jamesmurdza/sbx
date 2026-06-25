/**
 * teleport entry point: parses argv and dispatches to the right flow.
 */
import { parseArgs, USAGE, type Command } from './args.js';
import { TeleportError, getSession, listSessions, type Session } from './daytona.js';
import { startNew, reconnect } from './runner.js';
import { runDoctor } from './doctor.js';
import { overlayMenu } from './tui/overlay.js';

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

/** `teleport` with no args: pick a sandbox to reconnect to, or start fresh. */
async function pickerCommand(): Promise<number> {
  // Loop so "Switch sandbox" from the in-sandbox menu returns here to pick again.
  for (;;) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      out('No open sandboxes. Run `teleport <command>` to start one.');
      return 0;
    }

    const choice = await overlayMenu<Session | 'new' | null>(
      'Open sandboxes — reconnect (Ctrl-D deletes):',
      [
        ...sessions.map((s) => ({
          label: formatSession(s),
          value: s as Session | 'new' | null,
        })),
        { label: 'Start a new sandbox here', value: 'new' as const },
      ],
      {
        fullscreen: true,
        onDelete: async (item) => {
          const s = item.value;
          if (!s || s === 'new') return false; // only real sandboxes are deletable
          try {
            await s.sandbox.delete();
            return true;
          } catch {
            return false;
          }
        },
      },
    );

    if (!choice) return 0;
    if (choice === 'new') {
      out('Run `teleport <command>` to start a new sandbox.');
      return 0;
    }
    const outcome = await reconnect(choice);
    if (outcome !== 'switch') return 0;
    // 'switch': loop back to re-render the picker with a fresh sandbox list.
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
      const outcome = await startNew({ command: cmd.command, args: cmd.args, yolo: cmd.yolo });
      // "Switch sandbox" from the in-sandbox menu drops back to the picker.
      if (outcome === 'switch') return pickerCommand();
      return 0;
    }
  }
}

async function main(): Promise<void> {
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
