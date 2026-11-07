# Nesvo

A desktop workspace for technical sessions, visible delegation and operator review.

The approved prototype targets Windows, macOS and Linux. P0 provides a separate local host, validated contracts and persistent host identity. P1 adds an interactive layout for sessions, conversations, delegation and the review inbox, with clearly labeled demonstration data.

## Start

Install Node.js 24.20.0 and Bun 1.4.0, then run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

The desktop opens a sample orchestration session in a neutral dark workspace. The bottom bar shows the real connection to the local host; its refresh button checks the host and database. Closing the application stops its host. On macOS, use Quit to exit the application; closing the last window keeps it available in the dock.

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

No provider account or API key is required for P1. Session creation and messages are local UI previews that reset on reload. The sample model list does not represent installed provider capabilities. Approval and review actions are visibly inactive; no agents or project commands run.

## P1 acceptance walkthrough

1. Switch between the orchestrator and its two workers in the session list or delegation panel.
2. Open Do odbioru, inspect the sample result and return to its session.
3. Use Nowa sesja to choose a provider, sample model and role, with or without a working directory.
4. Add a local preview message; switch sessions and check that each composer keeps its own draft.
5. Open session details from the header. Resize the window to use slide-out session navigation on smaller widths.

Damian's P1 acceptance is required before real provider integration in P2.

## Working agreement

Small conventional commits go directly to master during the prototype. Each stage ends with Damian's acceptance. See [roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md), [testing](docs/testing.md) and [platform evidence](docs/platforms.md).

The active repository contains no previous branding. The baseline is preserved in Git; see [baseline](docs/baseline.md). Existing checkouts may contain ignored historical files and private runtime data. Use only the documented workspace commands.
