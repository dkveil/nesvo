# Nesvo

A desktop workspace for technical sessions, visible delegation and operator review.

The approved prototype targets Windows, macOS and Linux. P0 currently provides a runnable desktop, a separate local host, validated contracts and persistent host identity. Agent sessions, delegation and review arrive in later owner-approved stages.

## Start

Install Node.js 24.20.0 and Bun 1.4.0, then run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

The desktop should display **Połączono z lokalnym hostem**. Refresh checks the actual host and database. Closing the application stops its host. On macOS, use Quit to exit the application; closing the last window keeps it available in the dock.

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

No provider account or API key is required for P0.

## Working agreement

Small conventional commits go directly to master during the prototype. Each stage ends with Damian's acceptance. See [roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md), [testing](docs/testing.md) and [platform evidence](docs/platforms.md).

The active repository contains no previous branding. The baseline is preserved in Git; see [baseline](docs/baseline.md). Existing checkouts may contain ignored historical files and private runtime data. Use only the documented workspace commands.
