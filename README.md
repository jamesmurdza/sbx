# sbx — sandboxed agents

Run AI coding agents (Claude, Codex, Gemini, and others) inside fresh
[Daytona](https://www.daytona.io/) sandboxes, streamed to your terminal. `sbx`
clones your repo, imports your agent credentials, pushes commits as the agent
makes them, and lets you detach and reconnect later — the agent keeps running in
the cloud.

## Install

```bash
npm install -g @jamesmurdza/sbx   # puts `sbx` on your PATH
```

Or from source:

```bash
npm install
npm run build
npm link        # puts `sbx` on your PATH
```

Requires Node ≥ 20 and a Daytona API key:

```bash
export DAYTONA_API_KEY=dtn_...
```

## Usage

Run `sbx` from inside your git repo:

```
sbx
```

It reconnects to your most recent sandbox, or — if you have none — prompts you to
create one. Press **n** any time to start a new sandbox: pick an agent, and
sbx clones your current branch into the sandbox, imports the agent's login,
and starts it.

Everything happens in the **sidebar** (toggle with **Ctrl-]**):

| Key | Action |
| --- | --- |
| **↑ / ↓** | Move the selection; the view follows the highlighted sandbox. |
| **Enter** | Switch to (or start) the selected sandbox. |
| **→ / ←** | Move keyboard focus to the agent / back to the sidebar. |
| **n** | New sandbox. |
| **i** | Show sandbox info. |
| **g** | Open the sandbox's branch on GitHub. |
| **d** | Delete the selected sandbox. |
| **x** | Detach and exit. |
| **Esc** | Close the sidebar / modal. |

All other keys go to the agent. **Ctrl-C** interrupts the agent while you're typing
to it, but quits sbx from the sidebar or menus.

## How it works

When you start an agent, sbx:

- **Clones your repo** at your current branch (if you're in one with an `origin`
  remote). It never commits on your branch — it works on `sbx/<base>/<id>`,
  so multiple agents can run off the same base without colliding.
- **Imports credentials.** It offers the logins it finds for that agent — an
  API-key environment variable, the macOS keychain, or a credential file — and you
  pick one (or none).
- **Pushes automatically.** Commits made in the sandbox are pushed to the sbx
  branch. Your GitHub token stays on your machine and is never written into the
  sandbox.
- **Skips permission prompts** by default, since the sandbox is throwaway. Use
  `sbx --safe <agent>` to keep them.

Agents run in a persistent session that stays alive server-side, so you can
disconnect (**x**, or just close the terminal) and run `sbx` again to pick up
where you left off. Idle sandboxes auto-stop and restart on reconnect.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DAYTONA_API_KEY` | **Required.** Your Daytona API key. |
| `SBX_SNAPSHOT` | Base snapshot to create sandboxes from. Default: `background-agents`. |
| `SBX_PREFIX` | Prefix for sandbox names. Default: `sbx`. |
| `SBX_AUTOSTOP` | Minutes of idle before a sandbox auto-stops (0 disables). Default: `30`. |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for auto-push. Falls back to `gh auth token`. |

The `background-agents` snapshot must exist in your Daytona org; preinstalled
agents include `claude`, `codex`, `gemini`, `copilot`, `opencode`, `goose`,
`kimi`, `kilo`, and `pi`.

## Credentials by agent

| Agent | Env var | macOS keychain | Credential file |
| --- | --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY` | `Claude Code-credentials` | `~/.claude/.credentials.json` |
| `codex` | `OPENAI_API_KEY` | — | `~/.codex/auth.json` |
| `gemini` | `GEMINI_API_KEY` | — | `~/.gemini/oauth_creds.json` |
| `copilot` | `COPILOT_GITHUB_TOKEN` | — | — |
| `opencode` | — | — | `~/.local/share/opencode/auth.json` |
| `kimi` | `KIMI_API_KEY` | — | — |

For keychain/file logins, `claude` also copies `~/.claude.json` so it recognises
your account instead of re-running onboarding, and `gemini` copies
`~/.gemini/settings.json` alongside its OAuth token.

`kilo`, `goose`, and `pi` manage their own auth inside the sandbox, so there's
nothing to import for them.

## Other commands

```
sbx <agent>        Create a sandbox running <agent> directly (e.g. sbx claude)
sbx --safe <agent> ...with the agent's normal permission prompts kept
sbx ls             List sandboxes
sbx rm <id>        Delete a sandbox
sbx doctor         Check your setup
sbx help           Show help
```

## Development

```bash
npm run build       # compile TypeScript -> dist/
npm test            # run unit tests
npm run typecheck   # type-check without emitting
```

Daytona calls live in `src/daytona.ts` and `src/sandbox-ops.ts`. The agent runs in
a persistent Daytona PTY session that `src/session.ts` attaches to, driving a local
terminal compositor (`src/tui/`). Git clone/branch/push are in `src/git/`,
credential import in `src/auth/`, and the CLI in `src/cli.ts` and `src/runner.ts`.
