# Architecture

## Process boundaries

```text
React renderer (plain TypeScript, base shadcn)
  |
  | window.nesvo: session commands, health, subscriptions
  v
Sandboxed preload (narrow typed API)
  |
  | Electron IPC, caller checked by main
  v
Electron main (window and host process lifetime)
  |
  | utilityProcess messages, Zod commands/responses/events
  v
Node host (Effect scope and services)
  |
  v
SQLite (identity and versioned conversation snapshots)

Node host -> owned Claude Code CLI -> normalized text/activity/result

Standalone Node entry -> JSONL transport -> the same host service
```

Bun installs dependencies, runs scripts and builds the standalone host. It is not a runtime requirement for a packaged desktop.
Electron provides its own embedded Node for the utility process. The standalone host uses Node 24.
The host imports no Electron code; its desktop transport adapter belongs to the desktop main process.

Effect owns the database, session service, capability probes and request stream lifetime. Finalizers cancel owned provider work before closing SQLite. They run on normal shutdown and transport completion.
SQLite uses a versioned bootstrap and transaction, WAL, foreign keys and a busy timeout. An unsupported newer schema is rejected before migration.
Schema v2 preserves the v1 host identity and adds validated JSON conversation snapshots in a sessions table. A snapshot atomically contains the user message, agent message, run ID, provider ID, state and revision. Text is flushed in short batches and at termination. If final persistence fails, a bounded retry and an unsaved snapshot prevent a new message from overwriting the result. Restart marks unfinished runs interrupted.

## Ownership

| Area                 | Owns                                                 | Must not own                                           |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| contracts            | Zod schemas, inferred data types, narrow desktop API | Runtime services, UI state, provider implementations   |
| desktop main/preload | Window, IPC boundary, child process lifetime         | Domain decisions or credentials in renderer            |
| renderer             | Presentation and operator interaction                | Effect, filesystem, process control or database access |
| host                 | Authoritative state, resources and provider adapters | UI components or Electron dependency                   |

Requests carry unique correlation IDs. Session events are separate from responses and carry monotonically increasing revisions. The renderer subscribes before loading history and merges only newer snapshots. Send acknowledges promptly; the main request loop never waits for model completion, so health, Stop and shutdown remain responsive. Duplicate message IDs do not launch a second turn.
The renderer cannot send arbitrary host requests. It can only call the API exposed by preload.
Main denies external window creation, renderer navigation and permission requests.

## Growth by domain

Introduce sessions, delegation, review and skills modules as their stages are accepted.
Each host module keeps its domain rules, application service and adapters close together. Simple rules remain plain TypeScript; Effect composes I/O and lifetime.
Do not create a second schema system: public messages use the shared Zod contracts.

The renderer grows with a light feature-sliced structure:

```text
app -> pages/widgets -> features -> entities -> shared
```

Create only the layers needed by actual features. Imports move downward; cross-slice imports use public entry points.
Sibling features do not reach into each other's implementation. Shared contains generic UI and utilities, not session state or orchestration rules.
P1 composes a workspace page from session navigation, conversation, details and review widgets. Creation and live host status are features; session presentation types live in entities/session. Public slice entry points define the imports.

P2 removes demonstration sessions from the product. The page owns selection, drafts and subscription state; shared contracts define authoritative session data. Test fixtures live only under host tests and are explicitly selected by the desktop scenario. Inbox remains empty until real review is implemented.

## Claude adapter and P2 limits

The adapter uses the documented print/stream-json interface, existing login and explicit session-id/resume arguments. It validates required CLI capabilities, streams main-session text, ignores subagent output, reconciles final text and treats is_error as authoritative even when result subtype says success. Model aliases are not a promise of account entitlement.
P2 enables only Read, Glob and Grep in plan mode, denies unanswered permission requests, disables hooks and supplies an empty strict MCP configuration. It never enables permission bypass. Interactive tool approval and edits belong to P3; provider-aware skill support belongs to P6.
Only one turn runs at a time. Stop targets the owned Windows process tree or POSIX process group and waits for close; the host's shutdown watchdog allows cleanup to finish. On Windows, descendants already orphaned before the parent exits are not guaranteed to be contained by PID-tree cleanup. Abrupt OS termination is not equivalent to graceful shutdown; stronger containment needs a separate native job mechanism.
The host is local and lives with the desktop. There is no network listener, remote authentication or background daemon.
A closed host is not silently restarted. UI reports failure and lets the operator retry or reopen the app.
Worker lifetimes and review revision rules remain separate approved stages.
