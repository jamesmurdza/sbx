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
teleport                       Open the sidebar to browse/switch/manage sandboxes
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
`gemini` → `--yolo`, `copilot` → `--autopilot`, `kilo` → `--auto`. The other
preinstalled agents — `opencode`, `goose`, `kimi`, `pi` — auto-approve in
interactive mode (or have no skip flag) and run unchanged.

To keep the agent's normal prompts, pass `--safe` (alias `--no-yolo`):

```
teleport --safe claude     # -> claude   (prompts intact)
```

### What happens on `teleport claude`

1. **Repo detection.** If you're in a git repo with an `origin` remote, teleport
   clones your **current branch** into the sandbox. If you're not, it asks for
   confirmation before creating a blank sandbox.
2. **Credential modal.** For known agents (`claude`, `codex`, `gemini`, `copilot`,
   `opencode`, `kimi`, `kilo`, `goose`, `pi` — all preinstalled in the sandbox
   image) it finds available credential sources — an API-key env var (e.g.
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`,
   `KIMI_API_KEY`), the macOS keychain, or a local credential file — and asks
   which to import (or none). Only sources that actually exist locally are offered.
3. **Working branch.** teleport never commits on your base branch. It checks out a
   unique branch `teleport/<base>/<sandbox-id>`, so multiple agents off the same
   base branch never collide.
4. **Auto-push.** New commits made inside the sandbox are pushed to that branch
   automatically, via Daytona's git toolbox. **Your GitHub token is never written
   into the sandbox** — it's passed per-call from your machine.
5. **Attach.** The agent runs in a persistent Daytona PTY session (kept alive
   server-side, so detach/reconnect re-attaches to the same running agent — no
   in-sandbox tmux). Locally teleport is a **terminal compositor**: it parses the
   agent's output into a headless emulator and renders it, drawing its own bottom
   **status bar** (sandbox id, agent, repo, branch) on a reserved row and bridging
   mouse + scroll-wheel through to agents that track them. At startup it detects
   your terminal's **light/dark background** (OSC 11) and passes it to the agent —
   answering the agent's own colour query and setting `COLORFGBG` — so agents
   theme themselves to match instead of defaulting to dark. Press **Ctrl-]** (or
   **Ctrl-\\**) to toggle the **collapsible left sidebar** — the control center
   for all your sandboxes. The agent reflows to make room, and the sidebar
   captures: **↑/↓** move — the agent view follows the highlighted sandbox live
   (a stopped one shows "press Return to start it") · **Enter** open/start the
   selected sandbox (or, on the one already shown, drop back into it so you can
   type) · **n** new sandbox (pick any preinstalled agent or a custom command) ·
   **i** info panel · **g** open the sandbox's branch on GitHub · **d** delete it
   (confirm modal, Return = delete) · **x** detach and exit · **Esc** close the
   sidebar/modal and return to the agent. **Two-pane focus:** press **→** to hand
   the keyboard to the agent pane *without* closing the sidebar — it stays visible
   (dimmed, the selection shown bold) while you type, and **←** hands focus back
   to the sidebar; a `→ agent`/`← list` hint in the title shows which way the
   arrows go. The status bar and sidebar stay up even with no agent attached
   (and while a new one is creating), so the menu always works. **Ctrl-C** is the
   agent's own interrupt while you're typing into it (or with the sidebar focus
   handed to the agent via Tab), but
   from the sidebar, a modal, the idle screen, or mid-create it quits teleport — a
   universal escape hatch that always works, even if a create is wedged. Deleting
   the *current* sandbox hands off to a neighbour; deleting *another* happens in
   place. Idle sandboxes auto-stop (configurable via `TELEPORT_AUTOSTOP`) and
   restart on reconnect. All other keys pass straight through to the agent.

### One menu: the sidebar

There is no separate startup picker. Running `teleport` with no arguments
attaches to your most-recent sandbox and opens the **sidebar** immediately, so a
single surface handles browsing, switching, and delete — in-session and at
startup alike. With no sandboxes yet, it opens the **new-sandbox menu** straight
away. (`teleport ls` still prints a non-interactive list.)

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
agent runs in a persistent Daytona PTY session; `src/session.ts` connects to it
and drives a local **terminal compositor** (`src/tui/compositor.ts`) built from a
headless emulator — `render.ts` (buffer→ANSI diff), `statusbar.ts` (the local
bar), and `mouse.ts` (mouse/scroll bridge). Git clone + branch + auto-push are in
`src/git/`. Credential discovery/import is in `src/auth/`. The CLI is wired in
`src/cli.ts` and `src/runner.ts`.
