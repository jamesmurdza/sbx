# teleport

Run AI coding agents inside fresh [Daytona](https://www.daytona.io/) sandboxes,
streamed to your terminal — with credential import, automatic git pushing, a live
status bar, and detach/reconnect.

You drive everything from one screen: **just run `teleport`** and use the sidebar.

## Install

```bash
npm install
npm run build
npm link        # makes `teleport` available on your PATH
```

Requires Node ≥ 20 and a Daytona API key:

```bash
export DAYTONA_API_KEY=dtn_...
```

## Usage

From inside a git repo, run:

```
teleport
```

That's it — no arguments. teleport opens the **sidebar**, your control center for
every sandbox:

- If you have sandboxes already, it reconnects to the most recent one.
- If you don't, it opens the **new-sandbox menu** so you can create one.

### Create a sandbox

Press **n**, pick an agent (`claude`, `codex`, `gemini`, `copilot`, `opencode`,
`goose`, `kimi`, `kilo`, `pi` — all preinstalled), and teleport will:

1. **Clone your current branch.** If you're in a git repo with an `origin`
   remote, it clones that repo at your current branch into the sandbox. (Not in a
   repo? It offers a blank sandbox instead.)
2. **Import credentials.** It finds the login that agent can use — an API-key env
   var (e.g. `ANTHROPIC_API_KEY`), the macOS keychain, or a local credential
   file — and asks which to use (or none). Only sources you actually have are
   offered.
3. **Work on a safe branch.** It never commits on your base branch; it checks out
   `teleport/<base>/<sandbox-id>`, so multiple agents off the same base never
   collide.
4. **Auto-push.** Commits made in the sandbox are pushed to that branch
   automatically. **Your GitHub token is never written into the sandbox** — it's
   passed per-call from your machine.
5. **Run the agent.** The agent starts in permission-skipping mode by default
   (the sandbox is throwaway) and your terminal attaches to it.

### The sidebar

teleport is a local **terminal compositor**: it renders the agent full-screen and
draws its own bottom **status bar** (sandbox id, agent, repo, branch). Press
**Ctrl-]** to toggle the sidebar; the agent reflows to make room.

| Key | Action |
| --- | --- |
| **↑ / ↓** | Move the selection — the agent view follows the highlighted sandbox live (a stopped one shows "press Return to start it"). |
| **Enter** | Switch to / start the selected sandbox. The sidebar stays open. |
| **→** | Hand the keyboard to the agent (the sidebar stays visible); **←** hands it back. A small `→` / `←` in the top-right shows which way focus goes. |
| **n** | New sandbox (pick an agent or a custom command). |
| **i** | Info panel for the selected sandbox. |
| **g** | Open that sandbox's branch on GitHub. |
| **d** | Delete the selected sandbox (confirm; Return = delete). |
| **x** | Detach and exit teleport. |
| **Esc** | Close the sidebar / modal and return to the agent. |

The status bar and sidebar stay up even with no agent attached, so the menu always
works. **Ctrl-C** is the agent's own interrupt while you're typing into it, but
from the sidebar, a modal, or the idle screen it quits teleport — an escape hatch
that always works. All other keys pass straight through to the agent.

### Detach & reconnect

Disconnect any time (**x**, or just close your terminal) — the agent keeps working
in the cloud. Run `teleport` again to reconnect. Idle sandboxes auto-stop and
restart on reconnect, resuming from their on-disk state (e.g. `claude`'s saved
conversation); a still-running sandbox reattaches to the exact live process.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DAYTONA_API_KEY` | **Required.** Your Daytona API key. |
| `TELEPORT_SNAPSHOT` | Base snapshot name. Default: `background-agents`. |
| `TELEPORT_PREFIX` | Prefix for sandbox names. Default: `teleport`. |
| `TELEPORT_AUTOSTOP` | Minutes of idle before a sandbox auto-stops (0 disables). Default: `30`. |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for auto-push. If unset, `gh auth token` is used. |

> The `background-agents` snapshot must exist in your Daytona org. Override the
> name with `TELEPORT_SNAPSHOT` if yours differs.

## Credential sources by agent

| Agent | Env var | macOS keychain | Local file → sandbox |
| --- | --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY` | `Claude Code-credentials` | `~/.claude/.credentials.json` |
| `codex` | `OPENAI_API_KEY` | — | `~/.codex/auth.json` |
| `gemini` | `GEMINI_API_KEY` | — | `~/.gemini/oauth_creds.json` |
| `opencode` | — | — | `~/.local/share/opencode/auth.json` |

For subscription (keychain/file) imports, `claude` also copies `~/.claude.json`
(account + onboarding state) so the agent recognises the login instead of
re-running onboarding. API-key (env var) imports skip it.

## Other commands

The sidebar covers day-to-day use, but a few non-interactive commands exist:

```
teleport <command> [args...]   Create a sandbox running <command> directly (e.g. teleport claude)
teleport --safe <command>      ...with the agent's normal permission prompts left intact
teleport ls                    List sandboxes (non-interactive)
teleport stop <id>             Stop a sandbox (restarts on reconnect)
teleport rm <id>               Delete a sandbox
teleport doctor                Preflight diagnostics
teleport help                  Show help
```

## Development

```bash
npm run build       # compile TypeScript -> dist/
npm test            # run unit tests (node:test + tsx)
npm run typecheck   # type-check without emitting
```

### Architecture

All Daytona SDK calls go through `src/daytona.ts` and `src/sandbox-ops.ts`. The
agent runs in a persistent Daytona PTY session (kept alive server-side, so
detach/reconnect re-attaches to the same process); `src/session.ts` connects to it
and drives the local **terminal compositor** (`src/tui/compositor.ts`) built from a
headless emulator — `render.ts` (buffer→ANSI diff), `statusbar.ts` (the local
bar), `sidebar.ts`, and `mouse.ts` (mouse/scroll bridge). Git clone + branch +
auto-push are in `src/git/`. Credential discovery/import is in `src/auth/`. The CLI
is wired in `src/cli.ts` and `src/runner.ts`.
