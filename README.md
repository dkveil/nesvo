# Nesvo

A desktop workspace for technical sessions, visible delegation and operator review.

The approved prototype targets Windows, macOS and Linux. The desktop connects installed Claude Code and Codex for technical conversations, streaming, Stop and persistent history. Codex adds provider-specific modes and one-time operation approvals. P0 and the initial P1 layout are accepted; P2 and P3 retain separate owner acceptance.

## Start

Install Node.js 24.20.0 and Bun 1.4.0, then run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

The desktop opens your saved sessions in a neutral dark workspace. Use Nowa sesja to choose a provider, model, mode and optional directory, then send a message. A directory does not need Git; leaving it empty creates a separate local working folder. The bottom bar shows the host connection and lets you refresh each provider's availability. Closing the application stops its active turn and host. On macOS, use Quit to exit; closing the last window keeps the application available in the dock.

The desktop uses Electron's embedded Node runtime. The Node version above is for development tools and the standalone host.

## Workspace

```text
apps/desktop     Electron main/preload and React renderer
apps/host        Effect services, SQLite and standalone entry
packages/contracts  Zod schemas and inferred types
docs             Architecture, workflow and acceptance plan
scripts          One desktop integration scenario
```

## Commands

| Command               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| bun run dev           | Start the desktop with development reload              |
| bun run check         | Types, lint, formatting and two host integration cases |
| bun run build         | Build the standalone host and desktop                  |
| bun run smoke:desktop | Check the built desktop, real host and shutdown        |
| bun run package:dir   | Produce an unpacked native desktop package             |
| bun run format        | Format current workspace files                         |

Install the native Claude Code or Codex CLI and sign in using `claude auth login` or `codex login`. Nesvo uses that existing login and requires no new model API key. It checks the installed CLI and authentication before execution. Claude choices are CLI aliases; Codex choices come from its local model catalog. Actual account access is confirmed by the provider, and the running model is shown in session details.

Claude runs in analysis mode with Read, Glob and Grep. Codex read-only mode can read files and run read commands without write or elevation grants. Codex supervised mode allows workspace changes and displays the operation approvals requested by Codex; it does not ask before every edit. Decisions apply once to a particular request and run. One turn runs at a time. Account limits and authentication failures remain visible; Stop preserves partial text and never means successful completion. Workers and the review inbox remain later stages.

## P2 acceptance walkthrough

1. Confirm that Claude Code is detected and logged in, then create a session in a small known directory.
2. Ask it to summarize a file and observe the streamed response. Confirm the actual model in session details.
3. Reload or restart the application and continue the same conversation.
4. Start another response and press Stop. Confirm the stopped state and preserved partial output.
5. Switch sessions, check separate drafts, and open navigation/details in a smaller window.

On November 7, the local Claude account reported its weekly limit until November 8 at 20:00 Europe/Warsaw. Actual CLI startup, limit handling, reload and Stop were verified; successful Claude output still requires account availability. Damian explicitly authorized starting Codex in P3 while retaining this pending P2 evidence (D50). See [platform evidence](docs/platforms.md).

## P3 acceptance walkthrough

1. Refresh Codex availability and create a Codex session with a model from its catalog.
2. In read-only mode, ask about a small file, reload and continue the same conversation.
3. Create a supervised session in a disposable directory. Inspect a requested operation, decline it, and confirm its intended change did not happen.
4. Request a new operation and allow it once. Check the resulting file. A stopped or completed request cannot be approved again.
5. Press Stop during work or while awaiting a decision. Reopen the app and inspect the retained history.
6. Switch to Claude and confirm its distinct capabilities and account state. Successful Claude work and the owner's full two-provider acceptance remain separate gates.

## Working agreement

Small conventional commits go directly to master during the prototype. Each stage ends with Damian's acceptance. See [roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md), [testing](docs/testing.md) and [platform evidence](docs/platforms.md).

The active repository contains no previous branding. The baseline is preserved in Git; see [baseline](docs/baseline.md). Existing checkouts may contain ignored historical files and private runtime data. Use only the documented workspace commands.
