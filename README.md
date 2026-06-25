# teleport

Run an AI coding agent inside a fresh [Daytona](https://www.daytona.io/) sandbox,
streamed to your terminal — with credential import, automatic git pushing, a live
status bar, and detach/reconnect.

```
teleport claude
```

This creates a sandbox on the **background-agents** snapshot, clones your current
git branch, starts `claude` inside it, and attaches your terminal. Disconnect any
time and reconnect later — the agent keeps working in the cloud.

## Install

```bash
npm install
npm run build
npm link        # makes `teleport` available on your PATH
```

Requires Node ≥ 20.

## Usage

```
teleport [--safe] <command> [args...]  Create (or reconnect to) a sandbox and run <command>
teleport                       List open sandboxes and reconnect (Ctrl-D deletes)
teleport ls                    List open sandboxes (non-interactive)
teleport stop <id>             Stop a sandbox (it can be restarted on reconnect)
teleport rm <id>               Delete a sandbox
teleport push [<id>]           Push pending commits now
teleport doctor                Preflight diagnostics
teleport help                  Show help
```

### Permission prompts are skipped by default

Because every sandbox runs a throwaway agent, teleport appends the agent's
permission/approval-skipping flag by default:

```
teleport claude     # -> claude --dangerously-skip-permissions
teleport codex      # -> codex --yolo
teleport gemini     # -> gemini --yolo
```

Known mappings: `claude` → `--dangerously-skip-permissions`, `codex` → `--yolo`,
`gemini` → `--yolo`, `copilot` → `--autopilot`, `kilo` → `--auto`. Agents without
a known flag run unchanged.

To keep the agent's normal prompts, pass `--safe` (alias `--no-yolo`):

```
teleport --safe claude     # -> claude   (prompts intact)
```

### What happens on `teleport claude`

1. **Repo detection.** If you're in a git repo with an `origin` remote, teleport
   clones your **current branch** into the sandbox. If you're not, it asks for
   confirmation before creating a blank sandbox.
2. **Credential modal.** For known agents (`claude`, `codex`, `opencode`) it finds
   available credential sources — an API-key env var, the macOS keychain, or a
   local credential file — and asks which to import (or none). If both an env var
   and keychain entry exist, you get all three choices.
3. **Working branch.** teleport never commits on your base branch. It checks out a
   unique branch `teleport/<base>/<sandbox-id>`, so multiple agents off the same
   base branch never collide.
4. **Auto-push.** New commits made inside the sandbox are pushed to that branch
   automatically, via Daytona's git toolbox. **Your GitHub token is never written
   into the sandbox** — it's passed per-call from your machine.
5. **Attach.** The agent runs inside a `tmux` session in the sandbox and is
   streamed over a PTY. tmux draws the bottom **status bar** natively (sandbox id,
   agent, repo, branch, push status), so it never corrupts the agent's UI. Press
   **Ctrl-\\** at any time to open the **sandbox menu** — a centered overlay with
   Switch sandbox (detach and return to the picker), Detach and exit (leave
   running), Stop sandbox and exit (keep, restart later), or Delete sandbox and
   exit (destroy). All other keys (including Esc) pass straight through to the agent.

### Detach & reconnect

Sandboxes auto-stop when idle. Reconnecting restarts a stopped sandbox and
relaunches the agent (which resumes from its on-disk state, e.g. `claude`'s saved
conversation). A live, still-running sandbox reattaches to the exact process.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DAYTONA_API_KEY` | **Required.** Your Daytona API key. |
| `TELEPORT_SNAPSHOT` | Base snapshot name. Default: `background-agents`. |
| `TELEPORT_PREFIX` | Prefix for sandbox names (e.g. `teleport-myrepo-l8k2p9`). Default: `teleport`. |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for auto-push. If unset, `gh auth token` is used. |

> The `background-agents` snapshot must exist in your Daytona org. Override the
> name with `TELEPORT_SNAPSHOT` if yours differs.

## Credential sources by agent

| Agent | Env var | macOS keychain | Local file → sandbox |
| --- | --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY` | `Claude Code-credentials` | `~/.claude/.credentials.json` |
| `codex` | `OPENAI_API_KEY` | — | `~/.codex/auth.json` |
| `opencode` | — | — | `~/.local/share/opencode/auth.json` |

For subscription (keychain/file) imports, `claude` also copies `~/.claude.json`
(account + onboarding state) so the agent recognises the login instead of
re-running onboarding. API-key (env var) imports skip it.

## Development

```bash
npm run build       # compile TypeScript -> dist/
npm test            # run unit tests (node:test + tsx)
npm run typecheck   # type-check without emitting
```

### Architecture

All Daytona SDK calls go through `src/daytona.ts` and `src/sandbox-ops.ts`. The
agent runs in a tmux session in the sandbox; locally `src/session.ts` is a dumb
PTY passthrough and the status bar is rendered by tmux (config in
`src/tui/tmux.ts`). Git clone + branch + auto-push are in `src/git/`. Credential
discovery/import is in `src/auth/`. The CLI is wired in `src/cli.ts` and
`src/runner.ts`.
