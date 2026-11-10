# Architecture

## Workspace shell

The desktop shell is one resizable sidebar and a conversation column. The sidebar carries the sidebar toggle and product name in the title row, a search row with the new-session action, the Inbox entry, the session list and a footer. The footer holds one usage ring per provider and the account entry on the left, and the selected computer (opening Computers) and Phone access on the right. Sessions are grouped by computer when more than one computer is known; each row shows a project chip, the working-directory basename, the status or relative time of the last update, the title, a cloud mark for remote sessions and a provider glyph, with workers nested under their parent. The header shows a breadcrumb of project chip, directory and session title and keeps the thread details, skills, files and context toggles at the right.

The native title bar is hidden. The sidebar title row and the main header form one borderless 40 px drag region; buttons, inputs, popovers, dialogs and the sidebar resize handle opt out of dragging. Windows and Linux keep the operating system's window controls through a transparent title bar overlay whose symbol colour follows the colour scheme, and the header reserves the overlay width from the `titlebar-area-*` environment values. macOS keeps inset traffic lights and the first row gains a left inset. Double-click maximize and snap behaviour stay native. The preload API is unchanged; macOS and Linux behaviour is configured but has not been verified on those systems.

Each usage ring shows the remaining share of the provider's most used reported window, coloured by level (at least 50% left, at least 20%, below 20%), with a tooltip that lists every window with its reset time and says when the limits were last checked. Stale observations fade with a warning dot, offline computers show the last observation in grey with an offline dot, a pending first read pulses, and unavailable data shows only a dashed track; none of these is drawn as zero. The thread details card, opened from the header, repeats the same indicators as bars so the limits stay reachable while the sidebar is collapsed; the rest of the card belongs to a later stage.

The sidebar defaults to 256 px and can be dragged, moved with the arrow, Home and End keys, or reset by double-clicking its edge, between 208 px and the window width minus 640 px. Collapsing hides it completely, moves focus to the header toggle and is available from either toggle or Ctrl+B. The open state and width are local view preferences stored in the renderer, like the last session and saved-diff location; the host remains authoritative for all session data. Compact widths keep the existing sheet navigation. The window follows the operating system's light or dark scheme. Colours, surfaces, the glass composer and popovers, spacing and status colours are CSS custom properties in `styles.css`, consumed through Tailwind theme tokens rather than literal colours in components, and the interface uses the Inter variable font. The look and layout follow T3 Code (MIT) and are reimplemented with base shadcn components; no T3 source, assets or names were copied.

## New thread

New session opens a screen in the main area instead of a dialog: a heading with the chosen project folder (or "No project") below it, one composer and a row of chips. The chips are popovers for the provider and model (a provider rail built from the per-host status and a searchable list from each provider's reported catalog), the computer to run on (Local and connected SSH computers, with the existing Computers flow for adding one), the working directory (the existing input and host validation; an empty value means the host's isolated folder) and permissions (a segmented control limited to Read-only and Workspace edits, with Workspace edits disabled for Claude because Claude runs read-only analysis in Nesvo). Enter sends and Shift+Enter inserts a newline.

The first message creates the session through the existing create and send APIs with exactly the chosen provider, model, host, directory and mode; the trimmed first line of the message becomes the title, capped at 100 characters. No role is sent. A creation failure, such as an invalid directory, stays on the screen with the draft; a send failure after creation appears inside the new thread and never re-creates it. The composer offers the same `/` skill menu as a session. Its catalog comes from `discover-skills` with the chosen provider and folder on the chosen computer, resolved like `create-session` (an empty folder uses the host's shared workspaces root), so no session is created to list skills. The first message carries the selected skill ID and hash; `send-message` revalidates it against the created session before any provider turn, and a mismatch leaves the draft and selection inside the new thread with the error. Changing provider, computer or folder clears the selection. Attachments are not shown because the contracts and host do not provide them.

The model picker has a Reasoning column. Provider status reports effort support: Codex reports it per model from the `supportedReasoningEfforts` and `defaultReasoningEffort` fields of its `model/list` catalog, and the column lists exactly those values with the catalog default marked. The Codex default entry carries no efforts because Nesvo does not pass a model for it and the effective model depends on the user's Codex configuration. Claude Code reports `unsupported` with a reason, because Nesvo runs it without an effort setting; the column shows that reason and no choices. A Codex model with efforts always sends an explicit effort, starting from the catalog default. `create-session` accepts an optional effort only for a specific Codex model, and the host confirms it against a fresh catalog read before saving the session and again before every turn, because the app-server accepts and echoes arbitrary effort strings. A withdrawn effort fails the run before any thread or turn starts. The session stores the effort; every turn passes it as `model_reasoning_effort` on `thread/start` or `thread/resume` and as `effort` on `turn/start`, and a thread response that reports a different effort fails the run before the turn starts.

The new-thread screen shows no Git branch. A host-only reader module (`apps/host/src/workspace/git-branch.ts`) reads the current branch in a short-lived Node child process with non-blocking, regular-file-only reads capped at 4 KiB, killed after two seconds or on cancellation. No request, preload method or renderer path reaches it: the folder validation and `realpath` it would need still run synchronously in the host before the child starts, so a hung network filesystem could block the host. The branch chip moves to its own stage, UI1f, which moves that validation and resolution into the child process before the read is exposed again.

Host health lists the capability `reasoning-effort`. Electron records it per computer at synchronization and refuses an effort request locally for a host that does not list it, because an older host rejects unknown fields without a request ID and the SSH client treats that as a protocol failure. Status from such a host defaults to Claude-style `unsupported` effort with an update reason and models without efforts, so the picker offers no effort.

## Mobile companion

D66 adds an Expo React Native client in `apps/mobile-client` and a narrow opt-in HTTP/WebSocket gateway. The reusable gateway belongs to `apps/host/src/mobile`; Electron supplies its lifetime and an adapter to the existing ComputerManager. It routes to Local or an already-connected SSH host without creating another host runtime or database. Mobile and desktop share Zod contracts, session revisions and action identities; native views remain separate from the desktop component library.

The gateway is off at startup. Short-lived one-use pairing grants create revocable device tokens whose hashes are persisted atomically. HTTP uses Bearer authentication; an alternative WebSocket endpoint authenticates in a bounded first frame. The mobile app uses a bounded NDJSON HTTP event stream with redirects rejected because native WebSockets can follow redirects before exposing the connection to JavaScript. Public connections require TLS. Snapshot/event delivery subscribes before reading state and buffers intervening events; reconnect replaces the client view with authoritative state. The phone stores credentials in SecureStore, rejects external plaintext, suspends streams in the background and never replays mutations. [Mobile setup](mobile.md) describes the execution model, limits and deployment options.

## Idle provider inspection shutdown

Completed Codex metadata and bootstrap inspections close stdin and allow up to 300 ms for the actual process close event before the existing forced cleanup. This applies only to healthy RPC peers without pending requests. Active cancellation, Stop and run finalization keep their process-tree cleanup. Neither a successful termination command nor a missing PID substitutes for confirmed closure.

## Provider account usage

D65 adds a host-scoped, read-only `provider-usage` request with shared Zod contracts. A dedicated service coalesces concurrent requests and caches successful Claude observations for four minutes and Codex observations for 30 seconds. Unsuccessful reads back off from five minutes to one hour, report their next eligible check and reset the delay after success. Manual and post-turn refreshes share this host gate. It runs independently of session execution and joins the host's existing bounded probe lifecycle. Account metadata and quota observations stay in memory; they are not written to session history or offline computer snapshots.

Codex uses an owned app-server process for `initialize`, `account/read` with token refresh disabled, and `account/rateLimits/read`. Claude uses an owned, non-persistent control connection for `initialize` and `get_usage` with `skip_behaviors: true`, disabled hooks, strict empty MCP configuration and no tools. Neither path sends a user message or starts a model turn. Nesvo uses each installed provider's existing login without reading credential stores directly. Deadlines, bounded output, cancellation and confirmed process cleanup apply to both readers. Claude's usage command is experimental; unsupported versions return an explicit unavailable result.

Only reported windows become percentages. Native durations, reset timestamps, account labels and plans are preserved; malformed or unavailable data never becomes zero usage. Provider permission is retained only when explicitly reported and never inferred from a percentage or reset time. Usage data does not grant or block session permissions. Additional billing/credit balances are outside this stage.

Electron validates and routes the request to Local or the selected connected computer. An offline request fails without reconnecting automatically. Renderer observations are keyed by host, with generation checks against late responses. The visible application refreshes the selected computer every two minutes, after a finished turn and on demand, subject to the host cache. The rail shows remaining allowance in the most-used reported window. Details show every window, last check and reset time; observations become stale after five minutes, disconnection or a passed reset. Expiry never fabricates a refreshed allowance. The account icon opens both providers and remains available in compact layouts.

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

Effect owns the database, session service, capability probes and request stream lifetime. Finalizers cancel owned provider work before closing SQLite. In the embedded/stdio host, they run on normal shutdown and owner transport completion. The independent host below supplies a process-owned request stream instead of an individual client's stream.
SQLite uses a versioned bootstrap and transaction, WAL, foreign keys and a busy timeout. An unsupported newer schema is rejected before migration.
Schema v4 preserves host identity, provider threads and conversation snapshots. Earlier migrations retain provider modes and pending approvals; v4 adds parent/run relationships, worker scopes, delegation capability and proposals. Existing conversations default to delegation disabled. A snapshot atomically contains the user message, agent message, run ID, provider ID, state and revision. Accepting a worker commits both parent and child snapshots in one transaction before launch. Text is flushed in short batches and at termination. If final persistence fails, a bounded retry and unsaved snapshots prevent new messages from overwriting results. Restart marks unfinished runs and proposals interrupted and invalidates pending operation approvals.
SQLite remains on Node's built-in driver. Drizzle integration waits for stable support for this driver; no release candidate is installed. Database types would not replace public Zod request validation.

Schema v6 adds durable tool activity to session snapshots. Each item is identified by its run and native provider item ID, with normalized kind, title, paths, status and timestamps. Output and details are bounded; private reasoning and raw provider payloads are not persisted as activity. Text and activity updates share the existing batched persistence path. Terminal updates cannot regress to running. Stop and restart finalize unfinished items without inventing successful completion, and older sessions default to empty activity and unknown completion timestamps.

Activity retains the latest 100 entries per run and 300 per session. Run-specific markers identify omitted history, including wholly evicted runs; late updates cannot reinsert evicted entries during an active run. Output is limited to its last 4,000 characters, details to 2,000, and paths to ten. Known credential patterns and terminal control sequences are filtered; this is not a guarantee that arbitrary tool output contains no sensitive data.

## Independent host connections

D63/R1 adds a Linux daemon with one existing host runtime behind a process-owned request queue. Clients attach through a private Unix socket and a version/identity handshake. Client EOF removes reply routing and subscriptions; only daemon shutdown ends the owner queue and triggers provider cleanup. Transport request IDs are mapped per connection; semantic message/decision IDs are preserved. Pending operations keep their runtime budget after their client disconnects.

The same OS user owns the private socket, repositories, provider logins and data. No TCP port is opened. The bridge uses JSONL and never reconnects or replays commands automatically. The stable instance ID detects a mismatched database; it is not an authentication credential. Full startup, reconnect and resource-limit behavior is documented in [independent-host.md](independent-host.md).

D64/R2 and R3 add Computers in Electron main. Local keeps its owned utility process; each remote connection owns an OpenSSH child attached to the Linux bridge. OpenSSH requires an existing verified host key and public-key authentication. The renderer cannot supply shell commands. The daemon instance ID is pinned after its first verified handshake and persisted before the connection becomes available. [Linux host setup](ssh-host.md) describes installation and the generated systemd user unit.

Every desktop session and review carries a host ID separately from its native record ID. IPC validates that target, and command routing never depends on the selected conversation. Sidebar and Inbox aggregate all computers; workers, files, skills and decisions remain on the originating host. Local is the default for a new session. Provider availability is inspected independently per connected host.

Connection setup subscribes before fetching both authoritative snapshots, buffers intervening events and merges by revision before enabling commands. Generation checks reject late responses from replaced connections. Disconnect invalidates that connection without rewriting run statuses or replaying requests. The UI labels offline work as last known and disables mutations and live reads while retaining saved conversations and diffs.

Remote configuration and the bounded offline cache use separate atomic files under the desktop profile. Configuration records connection parameters and the host identity, never private key bytes or provider credentials. Cache save failures are visible but cannot prevent disconnection or removal. Reopening restores saved remote histories as disconnected; explicit Connect reloads the host's current state. Removing a computer deletes its desktop registration and cache, not its remote data or running service. App shutdown terminates Local work and closes remote SSH children only.

## Restart and recovery

D62 adds an exclusive owner for each host data directory. Electron takes its single-instance lock before creating a host. The host independently holds an exclusive transaction on a separate ownership.sqlite connection before opening the application database or reconciling sessions. The operating system releases this ownership when the process closes or dies; no stale PID file is deleted and no unknown process is killed. Effect keeps ownership until provider cleanup and database closure finish.

Reloading the renderer does not stop the host or replay requests. The renderer subscribes before loading authoritative history and merges by revision; review actions remain disabled while session or result loading failed or remains pending. Local navigation preferences restore the last session/Inbox and saved review ID/file. Missing or invalid preferences fall back safely. They do not store run status, permissions, commands or review decisions. Unsent drafts remain transient.

Optional interruption metadata records the run ID, reason and time on the session and agent message. Controlled host shutdown, unfinished records found at startup and unexpected provider disconnection have distinct reasons. Explicit provider errors remain failures, and operator Stop remains stopped. Partial output and prior interruption causes remain in history after a new turn. Incomplete outcomes never create successful reviews.

Startup reconciles unfinished sessions, activities, expired operation approvals and parent/worker proposals in one transaction. New proposals preserve the exact child run ID; legacy matching is conservative. A durably completed worker remains completed even when its parent did not receive the terminal event before shutdown. A resumed parent references saved reviews from its latest delegation group with actual children, even if that parent run never produced a review. Older parent dependencies are a fallback only when the latest group created no child. Current child review versions and writable fingerprints still participate in acceptance checks.

Continuation requires a new operator message and keeps the existing provider thread. The prompt explains the previous unconfirmed outcome and available worker state so that the provider can inspect current files before doing more work. Opening the app or pressing Continue conversation never sends a provider task. Already committed messages, worker decisions and review decisions are not replayed. Stable IDs and transactional correction preparation make retries idempotent, including after restart.

## Scheduled jobs

D68 adds host-owned scheduled jobs. Schema version 7 stores definitions in `scheduled_jobs` and their history in `scheduled_job_runs`, inside the same bootstrap transaction as earlier migrations; a failed migration rolls back completely and keeps the previous version. Runs are unique per job and scheduled time, manual runs per request ID, and deleting a job removes only its runs. Sessions gain nullable `scheduled_job_id` and `scheduled_job_run_id` links that become null when the job or run disappears, so sessions and reviews remain ordinary history. Each job keeps its latest 100 finished runs, ordered by recording time. A host accepts at most 20 jobs.

`ScheduledJobService` runs in the host scope, including the Linux daemon. One timer is armed for the earliest next run and capped at 2^31−1 ms; every change re-arms it, and the clock is injectable. A tick collapses every missed occurrence of a due job into a single decision with the shared schedule module. An occurrence more than two minutes late becomes one `skipped/missed` record; there is no catch-up. Otherwise an active run of the same job records `skipped/overlap`, and a busy host records `skipped/busy`. The host is busy when the session service would refuse a new message (closing, an active group or a review decision in progress) or when an operator command arrived in the last ten minutes. Otherwise the run is claimed as `starting` in the same transaction that advances the next run time, and the launcher port is called only after commit. A launch refused as busy becomes `skipped/busy`.

Startup marks `starting` and `running` runs `interrupted` with reason `restart` inside the session recovery transaction and never relaunches them; the first tick then records anything missed while the host was down. Saving a changed schedule or time zone, or reactivating a job, computes the next run from the current time, so a paused job never accumulates missed runs. Saves, activation changes and deletions compare the expected revision. Run now records a manual run only when the host is not busy and the job has no active run; otherwise it returns a busy error without a record. Health reports the `scheduled-jobs` capability. Until the session launcher is connected, a claimed run is marked failed.

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

The workspace composes the activity and result widgets through conversation slots. A lazy-loaded saved-diff widget renders the selected review ID with @pierre/diffs. Its virtualized viewer receives only the saved patch, never current filesystem content. File selection, line wrapping, raw-patch fallback and metadata-only changes stay within that exact version. On wide windows it docks beside the conversation; compact windows hide the covered conversation from keyboard navigation until the panel closes. Accept/correct commands remain in the result and inbox, bound to their existing review revisions. No live working-tree diff or merge is introduced.

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

New root Codex sessions register the native `nesvo_delegate` dynamic tool at thread creation regardless of read-only or supervised permissions. Creation accepts the legacy role field for compatibility but always starts a standalone session; the first valid worker proposal makes its role orchestrator. Intent is expressed through the task and tool use, not keyword detection or a role picker. Its input schema is generated from the shared Zod contract. This native interface requires the installed app-server's experimental API capability; it is enabled only for a delegation-capable connection. Resume uses the provider's stored tool metadata. Existing threads retain their identity and recorded capability without silent upgrades. Workers receive no delegation tool.

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

Delegation never changes the parent's selected permissions. Workers use the existing Codex modes or Claude's read-only capabilities and cannot create children. Directories are canonicalized, checked inside the parent's root and revalidated at acceptance. If either worker can write, its directory must not overlap another worker's directory. A supervised parent can delegate read-only workers only; proposed writable children are rejected before publication and rechecked at acceptance. This avoids mixing parent and child edits in the parent's review snapshot before workspace isolation exists. Assignment text is not a security boundary; provider sandboxes still define actual permissions. Read-only workers can share a directory.

Stopping a child leaves its sibling and parent active. Stopping the parent cancels pending proposals and active children. Parent termination waits for child cleanup; shutdown cancels the whole group. Restart retains relationships and marks unfinished work interrupted without launching it. Only one group may be active globally. A ten-minute native parent deadline includes operator waiting and child work; each conversation retains at most 100 proposals. Worker summaries passed back to the parent are capped at 12,000 characters with explicit truncation, while complete conversations stay available in the UI.

The workspace page composes conversation and delegation widgets through a React slot. Sidebar rows expose the parent/child tree, child views link back to their parent, and session details explain the actual delegation capability. No Effect or process API enters the renderer.

## Result review

Schema v5 adds a separate reviews table; full historical diffs are not copied with every session streaming update. A result records its session, run, independent content version, task, answer, captured diff and optional human decision. Review.revision orders status events; Review.version identifies the immutable content. Session.revision is never an acceptance token. The terminal session and result are committed in one SQLite transaction before either event is published. Recovery does not synthesize missing results from unfinished runs.

The narrow list-reviews and decide-review commands are available to the operator through validated IPC. Provider tools cannot call them. Decisions carry result ID, content version and an idempotent decision ID. A correction commits the decision, prepared session run and invalidation of older results together, then starts the same provider thread. Repeating its ID cannot spawn a second correction. A new result version starts pending; earlier decisions remain in history. The host rejects decisions on replaced versions or while a group is active.

Writable runs reserve their active slot before asynchronously capturing a baseline. Stop cancels this phase and cannot be followed by a late provider launch. After provider termination, the service captures the result state and saves a bounded unified diff. Filesystem reads never modify project files, Git objects or the index, and work without Git. Limits and excluded generated directories are explicit. Exact-byte hashes include paths, types and file modes; capture rejects symlinks, special files, concurrent mutations and incomplete reads. Binary changes and truncated patches remain unavailable rather than appearing clean. Accepting a writable result recaptures its directory and compares the recorded fingerprint. This checks the eligible files at decision time; it does not lock files against later outside edits.

Each version's diff describes its own turn, including a correction's incremental changes. Older diffs remain accessible. Read-only parent results link to the specific child results used for the summary instead of attributing child writes to the parent. Parent acceptance also checks writable dependency fingerprints. Accepting a parent does not accept its children. A child continuation supersedes dependent parent results; continuing a parent without new delegation supplies current child summaries and carries those references forward. A fresh delegation group establishes its own child references.

All successful new turns enter the prototype inbox. This stage does not add per-project review policy switches, automatic result submission tools, merge, background resumption or provider-specific skills. The optional policy/module settings remain a later product decision.

The action inbox is a projection of authoritative sessions and reviews. It lists pending operation approvals, current-run worker proposals and saved results with distinct action types. Every row links to the requesting session and exposes its decisions inline. Operation callbacks carry the row's session, run and request IDs; the page validates those IDs against current state independently of the selected conversation. Full versions and diffs are disclosures in the conversation, composed through a widget slot. A session link opens and scrolls to the exact request or result. The shared review decision feature preserves feedback drafts and the existing idempotent decision handling. No new host command or stored action record is introduced. History shows saved review decisions; transient operation approvals are not fabricated as historical records.

## Session file explorer

D58 adds three narrow, Zod-validated commands: list-workspace-directory, search-workspace-files and read-workspace-file. The host resolves the root from its stored session; callers supply only a session ID and a relative path. The renderer receives directory entries or a bounded text preview, never a filesystem or shell handle. No database migration or provider capability change is required.

The host rejects traversal, absolute paths, device names, alternate streams and symbolic links, including junctions and replaced roots. Generated and private entries are excluded consistently from listing, search and direct reads. These exclusions are a named file policy, not a general secret classifier or full Git-ignore implementation. Reads verify file identity and metadata before and after access. Binary/non-UTF-8 and oversized files return explicit non-preview states. Requests are asynchronous and capped at eight concurrent operations, 500 directory entries, 200 search matches, 5,000 visited entries, depth 32, three seconds and 256 KiB of preview content. Partial results are marked; Stop remains independent of filesystem work.

The lazy-loaded workspace-files widget opens folders on demand, debounces filename search and drops obsolete responses. The existing virtualized code renderer provides syntax colors, line numbers and wrapping. Refresh reloads the current preview and tree. Compact windows show the file panel in place of the conversation; Escape returns focus to the opener. Current workspace content is labeled separately from the saved result panel. Switching between them retains the exact saved review ID and version, including historical results. The explorer does not edit files, compute a live diff, execute skills or alter review acceptance.

## Shared skill library

D61 extends the P6 discovery and selection boundary into a common local catalog. The discover-skills command accepts a stored session ID; callers cannot supply paths or provider names. Two concurrent inspections are allowed independently of message streaming and Stop. Shutdown owns discovery cancellation and provider-process cleanup. Catalogs are transient and require no database migration.

The catalog combines bounded Claude personal, project-ancestor and managed files, legacy commands, shared .agents/skills roots, CODEX_HOME and project .codex/skills roots, optional /etc/codex/skills and the isolated native Codex catalog. Canonical physical files are deduplicated while preserving all observed origins; different files with the same name remain separate. An observed disabled state wins across aliases. The UI shows origin, scope, delivery and specific incompatibility reasons. Coverage is partial: plugin, synced, bundled, runtime-loaded, worktree-fallback and non-file managed sources are not exhaustively inspected. A discovered file is not automatically usable.

Filesystem traversal is bounded by 500 entries, 4,000 visits, depth eight and a shared three-second inventory deadline. The final compatibility inspection has a five-second budget with eight concurrent reads. SKILL.md snapshots are regular, canonical, stable UTF-8 files capped at 64 KiB; frontmatter and optional Codex sidecar metadata have separate bounds. YAML disallows aliases and explicit tags and has depth/node limits. A test-only NESVO_TEST_SKILLS_HOME redirects default home roots inside fixture processes; it never changes real provider configuration.

Discovery may start an isolated Codex app-server even for a Claude session to incorporate its reported catalog. Process-local skills/extraRoots/set makes local skill directories available before skills/list. No thread or model turn is started and no user configuration is rewritten. Unsupported extra-root registration leaves the ordinary native catalog available with an explicit issue; execution of an unavailable selected skill still fails. Plugin, MCP and hook isolation remains unchanged.

## Explicit skill selection

Both composers open the shared catalog with slash or Choose skill and support filtering, keyboard selection and removal. Typing `/` at the start of an empty draft opens an inline list above the composer with `/name` and a one-line description; command-name matches rank before description matches. A draft that starts with a complete `/name` followed by text resolves that name on send; when no single available skill matches, the send stops with a visible reason instead of delivering the text as a plain prompt. One selection belongs to each session draft, survives switching and failed sends, and clears only after acknowledgement of that unchanged draft. The request contains an opaque skill ID and the displayed content hash, never a caller-supplied source path or instruction body. Idempotency compares text, ID and hash.

The host reserves the normal active run before asynchronous preparation, reloads the catalog and verifies compatibility and the selected snapshot. Changed, disabled or unavailable selections fail explicitly. Stop during preparation cannot produce a late provider launch. Persisted message references include canonical source, origins, delivery and hash; old messages remain readable.

For Codex, the execution process registers the selected extra root where supported, refreshes the native catalog and requires the exact enabled native name/path identity before starting or resuming a thread. The host rereads the actual native path, compares its canonical target and hash, checks cross-provider compatibility and saves the selected reference before the turn. Input retains separate native text and skill items. There is no prompt-only fallback. Hash checks detect changes before dispatch; they do not freeze later native reads or supporting resources.

For Claude, selected static content is delivered explicitly as Shared instructions in the user message, together with the source, base directory and hash. This is not native slash resolution, a Skill tool invocation or plugin execution. The validated body is a per-turn snapshot, avoiding resumed system-prompt retention. History stores the original user text and reference, not a second copy of the body. Read, Glob, Grep, plan mode and hook/MCP isolation remain unchanged; supporting files still require existing provider permissions.

Claude delivery and Claude/shared-origin files used by Codex pass a conservative portability check. Legacy commands, disabled manual invocation, dynamic shell interpolation, unresolved argument/environment placeholders, unsupported hooks/context/agent/model directives and declared tool dependencies that this delivery cannot provide are blocked with reasons. The existing Claude read-only tool declaration subset is supported only for Claude. Codex-only native entries retain native execution semantics. Compatibility does not guarantee that the model follows every instruction or that referenced resources are available.

Desktop main routes scheduled job commands through `window.nesvo.scheduledJobs` (`list`, `save`, `setActive`, `delete`, `runNow`, `listRuns`), each taking the desktop host ID first. The preload and main both validate with the shared command schemas, main checks the caller, and `ComputerManager` sends the command to Local or a connected SSH computer, rejecting offline computers without reconnecting. Host responses carry no host ID; main adds it in the desktop projection. Delete takes the expected revision, as the host command requires. Job changes, removals and run changes ride the existing subscription as desktop events; main drops a job change whose revision is not newer than the last one seen, and rejects any response that arrives after the connection generation changed. Each computer's `capabilities` come from its health. Main refuses scheduled job calls for a computer whose health lacks `scheduled-jobs` and the renderer sees the list in the computer state. Schedule preview is a pure renderer helper over the shared schedule module, not an IPC call. The mobile gateway ignores scheduled job events.
