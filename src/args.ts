/**
 * Pure command-line parser. Kept side-effect free so it can be unit tested.
 *
 *   teleport                 -> list/reconnect picker
 *   teleport <cmd> [args...] -> create-or-reconnect and run <cmd>
 *   teleport ls              -> non-interactive session list
 *   teleport stop <id>       -> stop a sandbox
 *   teleport rm <id>         -> delete a sandbox
 *   teleport push [<id>]     -> push pending commits now
 *   teleport doctor          -> preflight diagnostics
 *   teleport help            -> usage
 */

export type Command =
  | { type: 'list' }
  | { type: 'ls' }
  | { type: 'doctor' }
  | { type: 'help' }
  | { type: 'stop'; id: string }
  | { type: 'rm'; id: string }
  | { type: 'push'; id?: string }
  | { type: 'run'; command: string; args: string[]; yolo: boolean };

export type ParseResult = Command | { type: 'error'; message: string };

const RESERVED = new Set(['ls', 'stop', 'rm', 'push', 'doctor', 'help']);

export function parseArgs(argv: string[]): ParseResult {
  // Peel leading teleport options before the command. Permission-skipping
  // ("yolo") is the default because every session runs in a throwaway sandbox;
  // --safe / --no-yolo opts back into the agent's normal prompts.
  let yolo = true;
  let sawFlag = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--yolo' || a === '--dangerous' || a === '-y') {
      yolo = true;
      sawFlag = true;
      i++;
    } else if (a === '--no-yolo' || a === '--safe') {
      yolo = false;
      sawFlag = true;
      i++;
    } else {
      break;
    }
  }
  const [first, ...rest] = argv.slice(i);

  if (first === undefined) {
    if (sawFlag) return { type: 'error', message: 'that flag requires a command, e.g. `teleport claude`.' };
    return { type: 'list' };
  }
  if (first === '--help' || first === '-h' || first === 'help') return { type: 'help' };
  if (first === 'ls') return { type: 'ls' };
  if (first === 'doctor') return { type: 'doctor' };

  if (first === 'stop' || first === 'rm') {
    const id = rest[0];
    if (!id) return { type: 'error', message: `\`teleport ${first}\` requires a sandbox id.` };
    return { type: first, id };
  }

  if (first === 'push') {
    return { type: 'push', id: rest[0] };
  }

  // Anything else is a command to run inside a sandbox.
  if (RESERVED.has(first)) {
    // Defensive: should be handled above.
    return { type: 'error', message: `Unhandled subcommand: ${first}` };
  }
  return { type: 'run', command: first, args: rest, yolo };
}

export const USAGE = `teleport — run an AI agent in a fresh Daytona sandbox

Usage:
  teleport [--safe] <command> [args...]  Create (or reconnect to) a sandbox and run <command>
  teleport                       List open sessions and reconnect
  teleport ls                    List open sessions (non-interactive)
  teleport stop <id>             Stop a sandbox
  teleport rm <id>               Delete a sandbox
  teleport push [<id>]           Push pending commits for a session now
  teleport doctor                Run preflight diagnostics
  teleport help                  Show this help

Options:
  --safe, --no-yolo              Keep the agent's permission/approval prompts.
                                 By default teleport skips them (sandbox is
                                 throwaway): claude --dangerously-skip-permissions,
                                 codex --yolo, gemini --yolo, etc.
  --yolo, --dangerous, -y        Explicitly request the default (skip prompts).

Environment:
  DAYTONA_API_KEY                Required. Daytona API key.
  TELEPORT_SNAPSHOT              Base snapshot (default: background-agents).
  TELEPORT_PREFIX                Sandbox name prefix (default: teleport).
  GH_TOKEN / GITHUB_TOKEN        GitHub token for auto-push (else uses \`gh auth token\`).
`;
