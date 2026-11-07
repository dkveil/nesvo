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
Schema v4 preserves host identity, provider threads and conversation snapshots. Earlier migrations retain provider modes and pending approvals; v4 adds parent/run relationships, worker scopes, delegation capability and proposals. Existing conversations default to delegation disabled. A snapshot atomically contains the user message, agent message, run ID, provider ID, state and revision. Accepting a worker commits both parent and child snapshots in one transaction before launch. Text is flushed in short batches and at termination. If final persistence fails, a bounded retry and unsaved snapshots prevent new messages from overwriting results. Restart marks unfinished runs and proposals interrupted and invalidates pending operation approvals.
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
Only one group runs at a time, with at most two children beside its parent. Stop targets the owned Windows process tree or POSIX process group and waits for close; the host's shutdown watchdog allows cleanup to finish. Windows cleanup skips a parent whose exit is already known, avoiding another tree-kill request against its retired PID. Descendants already orphaned before the parent exits are not guaranteed to be contained by PID-tree cleanup. Abrupt OS termination is not equivalent to graceful shutdown; stronger containment needs a separate native job mechanism.
The host is local and lives with the desktop. There is no network listener, remote authentication or background daemon.
A closed host is not silently restarted. UI reports failure and lets the operator retry or reopen the app.
Review results and decisions are described below.

## Codex adapter and approval boundaries

Codex uses its installed app-server over a private stdio connection, with existing CLI authentication. Model choices come from its model catalog rather than a hard-coded list. Each turn owns a process and resumes the persisted provider thread ID when continuing a conversation. The application never attaches to another running Codex process.
The native local tool executor remains enabled. Before starting a thread, the adapter disables inherited MCP servers and unrelated plugin, hook and delegation features in its own process, then verifies the effective configuration. No global configuration is rewritten. Unsupported MCP server names fail explicitly instead of constructing ambiguous configuration overrides.

Read-only mode uses the provider's read-only sandbox and never grants elevated operations. It can run commands that read data; it is not the same tool allowlist as Claude. Supervised mode uses workspace-write with the provider's untrusted approval policy and user reviewer. Workspace edits may proceed without a prompt. Commands and file changes that the provider asks to approve become visible requests, with one-time accept or decline actions. This mode does not promise a prompt for every edit.

Decisions carry the Nesvo session ID, current run ID and provider request ID. The host accepts them only while that exact request is pending on the active run. Stop, completion and recovery invalidate requests. Persistence precedes forwarding an approval, and unsupported provider requests fail closed. Provider approval is separate from the later review inbox and does not accept a completed task.

## Visible delegation

New read-only Codex orchestrators register the native `nesvo_delegate` dynamic tool at thread creation. Its input schema is generated from the shared Zod contract. This native interface requires the installed app-server's experimental API capability; it is enabled only for a delegation-capable orchestrator connection. Resume uses the provider's stored tool metadata. Existing threads are never replaced or silently upgraded. Workers and standalone sessions receive no delegation tool.

```text
Codex parent -> native tool call -> validated worker proposals
                                    |
React decisions -> typed preload -> host decide-delegation
                                    |
                             persist parent + child
                                    |
                             launch owned worker
                                    |
                         child status/text/error -> parent tool result
```

The adapter validates the tool, namespace, call ID, thread and turn. The service limits all calls within one parent run to two proposals. Each proposal shows task, scope, relative directory, provider, model and mode. Only a matching session/run/proposal decision can accept or decline it. Acceptance creates and launches the visible child; stale decisions fail. Child results remain associated with their proposal and session IDs, including declined, stopped and failed outcomes.

The parent is read-only. Workers use the existing Codex modes or Claude's read-only capabilities and cannot create children. Directories are canonicalized, checked inside the parent's root and revalidated at acceptance. If either worker can write, its directory must not overlap another worker's directory. Assignment text is not a security boundary; provider sandboxes still define actual permissions. Read-only workers can share a directory.

Stopping a child leaves its sibling and parent active. Stopping the parent cancels pending proposals and active children. Parent termination waits for child cleanup; shutdown cancels the whole group. Restart retains relationships and marks unfinished work interrupted without launching it. Only one group may be active globally. A ten-minute native parent deadline includes operator waiting and child work; each conversation retains at most 100 proposals. Worker summaries passed back to the parent are capped at 12,000 characters with explicit truncation, while complete conversations stay available in the UI.

The workspace page composes conversation and delegation widgets through a React slot. Sidebar rows expose the parent/child tree, child views link back to their parent, and session details explain the actual delegation capability. No Effect or process API enters the renderer.

## Result review

Schema v5 adds a separate reviews table; full historical diffs are not copied with every session streaming update. A result records its session, run, independent content version, task, answer, captured diff and optional human decision. Review.revision orders status events; Review.version identifies the immutable content. Session.revision is never an acceptance token. The terminal session and result are committed in one SQLite transaction before either event is published. Recovery does not synthesize missing results from unfinished runs.

The narrow list-reviews and decide-review commands are available to the operator through validated IPC. Provider tools cannot call them. Decisions carry result ID, content version and an idempotent decision ID. A correction commits the decision, prepared session run and invalidation of older results together, then starts the same provider thread. Repeating its ID cannot spawn a second correction. A new result version starts pending; earlier decisions remain in history. The host rejects decisions on replaced versions or while a group is active.

Writable runs reserve their active slot before asynchronously capturing a baseline. Stop cancels this phase and cannot be followed by a late provider launch. After provider termination, the service captures the result state and saves a bounded unified diff. Filesystem reads never modify project files, Git objects or the index, and work without Git. Limits and excluded generated directories are explicit. Exact-byte hashes include paths, types and file modes; capture rejects symlinks, special files, concurrent mutations and incomplete reads. Binary changes and truncated patches remain unavailable rather than appearing clean. Accepting a writable result recaptures its directory and compares the recorded fingerprint. This checks the eligible files at decision time; it does not lock files against later outside edits.

Each version's diff describes its own turn, including a correction's incremental changes. Older diffs remain accessible. Read-only parent results link to the specific child results used for the summary instead of attributing child writes to the parent. Parent acceptance also checks writable dependency fingerprints. Accepting a parent does not accept its children. A child continuation supersedes dependent parent results; continuing a parent without new delegation supplies current child summaries and carries those references forward. A fresh delegation group establishes its own child references.

All successful new turns enter the prototype inbox. This stage does not add per-project review policy switches, automatic result submission tools, merge, background resumption or provider-specific skills. The optional policy/module settings remain a later product decision.
