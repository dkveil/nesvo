# Development

## Toolchain

Use Node.js 24.20.0 and Bun 1.4.0. Dependencies and lockfile are committed.
TypeScript 6.0.3 is pinned to the supported range of the selected ESLint integration.
Run commands from the repository root. Bun manages the workspace and scripts; Electron runs the packaged desktop and host.

```sh
bun install --frozen-lockfile
bun run dev
```

The workspace uses neutral shadcn components in the operating system's light or dark scheme. Session details open on demand, leaving the main area for the conversation. The sidebar collapses with its toggle or Ctrl+B, resizes from its edge and remembers both choices locally. A new thread starts from the main-area screen; its first message creates the session. SQLite owns session history; only selection, the sidebar state and unsent drafts remain in renderer memory.
Connection details show the host connection and separate Claude Code and Codex availability on demand. Install the native CLI and use `claude auth login` or `codex login` in a terminal. The desktop never reads or displays credentials. Missing installation, incompatible CLI behavior, missing login and provider failures are distinct states. One provider being unavailable does not block the other.

## Build and check

```sh
bun run check
bun run build
bun run smoke:desktop
bun run package:dir
```

On Linux without a display, use xvfb-run -a bun run smoke:desktop.
Native packages are unpacked directories in apps/desktop/release. P0 does not provide signed installers or automatic updates.

For a packaged Windows check in PowerShell:

```powershell
$env:NESVO_PACKAGED_EXECUTABLE = (Resolve-Path 'apps/desktop/release/win-unpacked/Nesvo.exe').Path
bun run smoke:desktop
Remove-Item Env:NESVO_PACKAGED_EXECUTABLE
```

Optional NESVO_SCREENSHOT saves the smoke scenario's visible state to an explicit path.
The scenario starts a hidden window, uses an isolated temporary directory and explicitly selects the CLI fixture. It never uses a provider account. Fixture text is test evidence, not proof of model availability.

## Standalone host

Build first. Then set NESVO_DATA_DIR to a dedicated directory and run bun run host.
Each stdin line is a JSON object validated by packages/contracts: health, claude-status, codex-status, list-sessions, list-reviews, create-session, send-message, stop-run, respond-approval, decide-delegation, decide-review or shutdown. Commands use a UUID id; send-message also has an idempotent messageId, and stop-run addresses a specific runId. Approval responses additionally identify the exact pending request and carry only accept or decline. Delegation decisions identify sessionId, runId and delegationId and carry accept or decline; they never accept renderer-supplied worker settings. Review decisions carry reviewId, version, decisionId, accept or request-changes, and required feedback for corrections.
Responses, session-changed and review-changed events are JSONL on stdout; diagnostics go to stderr. Readers must correlate responses by id instead of treating the next line as the response. Closing stdin also closes the host and its active group.

### Pipeline definition commands

The same bundle validates and changes pipeline definitions without a running host or a database:

```sh
node apps/host/dist/main.js pipelines validate --directory <project>
node apps/host/dist/main.js pipelines list --directory <project> --json
node apps/host/dist/main.js pipelines add-step --directory <project> --scope project --file step.md [--expected-hash <hash>]
node apps/host/dist/main.js pipelines add-to-pipeline --directory <project> --scope project --pipeline <name> --step <name> [--after <name>]
node apps/host/dist/main.js pipelines remove-from-pipeline --directory <project> --scope project --pipeline <name> --step <name>
```

`list` prints the `contentHash` of every definition. Replacing an existing step requires the hash that was read as `--expected-hash`; a changed file answers with its current hash, exits 2 and writes nothing, so read it again. Validation errors exit 1. When `NESVO_RUN_ID` is set, the three writing commands exit 3 without touching a file; `validate` and `list` still work. Details are in the architecture notes on definition commands.

## Pipeline demo runs

Until the pipeline engine lands, the step strip and the step result panel can be previewed with demo runs. Set NESVO_PIPELINE_DEMO=1 before starting an unpackaged desktop build; optional NESVO_PIPELINE_DEMO_DIRECTORY sets the folder the demo sessions point at. Main then adds five read-only demo sessions to Local with runs that are checking, passed, need attention after a failed command step, wait for a human gate, and stop on an uncertain action, plus one nested agent step session. Run lists, run detail, evidence reads, Stop and Resume for those runs are answered in memory by `apps/desktop/src/main/pipeline-demo.ts`; nothing reaches the host or the database, and every other command, including starting a task, still goes to the real host. A packaged build ignores the flag and never creates the demo source. Use a dedicated NESVO_DATA_DIR, because the demo sessions appear next to real ones.

## Local data

The desktop stores its host database under Electron's userData directory, in host/nesvo.sqlite.
On Windows this normally means %APPDATA%/Nesvo/host.
NESVO_DATA_DIR overrides the desktop userData directory, or the standalone host data directory.
Use different directories for standalone and desktop development. Never point test runs at your real data.
Empty working-directory input creates a dedicated folder under the host's workspaces directory. Existing directories are resolved and validated without requiring Git. Providers retain their own resume transcripts in their configured locations; Nesvo stores separate provider session identifiers and conversation snapshots.

NESVO_CLAUDE_EXECUTABLE and NESVO_CODEX_EXECUTABLE optionally select absolute native executable paths. A JavaScript CLI entry is launched using the existing Node runtime. The test suite uses these overrides for its local fixtures. Production discovery checks PATH and common native installation locations; shell wrappers are not executed.

Isolated pipeline tasks create their Git worktrees under the data directory, in `worktrees/`, on branches named `nesvo/<slug>-<runId8>`. They are removed only by an explicit removal request, which refuses a worktree with uncommitted changes unless forced and keeps the branch. A worktree holds only tracked files, so `.env`, local state and installed dependencies are absent. Nesvo copies nothing and has no file list for it; a `plan` phase step prepares the worktree from the operator's project, which every step receives as `NESVO_PROJECT_ROOT`:

```md
---
name: setup
type: command
phase: plan
---

cp "$NESVO_PROJECT_ROOT/.env" .env
bun install --frozen-lockfile
```

NESVO_GIT_EXECUTABLE optionally replaces Git with an absolute path, as the test suite does for a stand-in that never exits.

P0 has no migration from historical application data. Existing private directories and worktrees remain untouched.
Do not run git clean or delete ignored files as part of setup.

## Troubleshooting

If the initial screen reports no connection, retry once and inspect the terminal used to start development.
An incompatible database fails closed; do not delete it to hide the error.
If Claude reports an account limit, wait for the reset reported by Claude and retry. Nesvo does not substitute a simulated response, change billing, or automatically retry. A turn is bounded to ten minutes, including a parent's wait for worker approval and results. Stop terminates only the owned process tree; failed cleanup is reported as failure.
New Codex sessions can delegate without selecting a role. Access permissions remain independent and unchanged by delegation. Older sessions preserve their existing provider thread and recorded tool capability. Worker directories must already exist inside the parent directory; use separate non-overlapping directories when allowing writes. A supervised parent can delegate only read-only workers until isolated workspaces exist. One group runs at a time, and workers never launch before an individual operator decision.
Quit the desktop to stop its utility host. On macOS, closing the last window alone does not quit the app.
Development IPC and the host expose no network port. The renderer development server uses an available Vite port.
