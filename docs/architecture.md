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
Node host -> owned Codex app-server over stdio -> text/activity/approval/result

Standalone Node entry -> JSONL transport -> the same host service
```

Bun installs dependencies, runs scripts and builds the standalone host. It is not a runtime requirement for a packaged desktop.
Electron provides its own embedded Node for the utility process. The standalone host uses Node 24.
The host imports no Electron code; its desktop transport adapter belongs to the desktop main process.

Effect owns the database, session service, capability probes and request stream lifetime. Finalizers cancel owned provider work before closing SQLite. They run on normal shutdown and transport completion.
SQLite uses a versioned bootstrap and transaction, WAL, foreign keys and a busy timeout. An unsupported newer schema is rejected before migration.
Schema v3 preserves host identity and conversation snapshots, adds provider modes and pending approvals, and migrates existing Claude sessions to read-only mode. A snapshot atomically contains the user message, agent message, run ID, provider ID, state and revision. Text is flushed in short batches and at termination. If final persistence fails, a bounded retry and an unsaved snapshot prevent a new message from overwriting the result. Restart marks unfinished runs interrupted and invalidates their pending approvals.
SQLite remains on Node's built-in driver. Drizzle integration waits for stable support for this driver; no release candidate is installed. Database types would not replace public Zod request validation.

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
Claude enables only Read, Glob and Grep in plan mode, denies unanswered permission requests, disables hooks and supplies an empty strict MCP configuration. It never enables permission bypass. Interactive approval in P3 is provider-specific; Claude retains its P2 capabilities. Provider-aware skill support belongs to P6.
Only one turn runs at a time. Stop targets the owned Windows process tree or POSIX process group and waits for close; the host's shutdown watchdog allows cleanup to finish. On Windows, descendants already orphaned before the parent exits are not guaranteed to be contained by PID-tree cleanup. Abrupt OS termination is not equivalent to graceful shutdown; stronger containment needs a separate native job mechanism.
The host is local and lives with the desktop. There is no network listener, remote authentication or background daemon.
A closed host is not silently restarted. UI reports failure and lets the operator retry or reopen the app.
Worker lifetimes and review revision rules remain separate approved stages.

## Codex adapter and approval boundaries

Codex uses its installed app-server over a private stdio connection, with existing CLI authentication. Model choices come from its model catalog rather than a hard-coded list. Each turn owns a process and resumes the persisted provider thread ID when continuing a conversation. The application never attaches to another running Codex process.
The native local tool executor remains enabled. Before starting a thread, the adapter disables inherited MCP servers and unrelated plugin, hook and delegation features in its own process, then verifies the effective configuration. No global configuration is rewritten. Unsupported MCP server names fail explicitly instead of constructing ambiguous configuration overrides.

Read-only mode uses the provider's read-only sandbox and never grants elevated operations. It can run commands that read data; it is not the same tool allowlist as Claude. Supervised mode uses workspace-write with the provider's untrusted approval policy and user reviewer. Workspace edits may proceed without a prompt. Commands and file changes that the provider asks to approve become visible requests, with one-time accept or decline actions. This mode does not promise a prompt for every edit.

Decisions carry the Nesvo session ID, current run ID and provider request ID. The host accepts them only while that exact request is pending on the active run. Stop, completion and recovery invalidate requests. Persistence precedes forwarding an approval, and unsupported provider requests fail closed. Provider approval is separate from the later review inbox and does not accept a completed task.
