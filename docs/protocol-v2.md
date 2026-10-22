# Host protocol v2

Implementation contract for the Rust host, mobile client and TUI. Wire pairing remains version 1: the existing authenticated secretbox envelope, fresh server challenge, client nonce, direction and sequence checks are unchanged. Application protocol version 2 is announced after authentication.

## Connection and snapshots

`sessionToolPermissions` adds owner-only create spec `allowedNesvoTools:string[]`
for an explicit supported Claude harness process. At most 32 unique exact names
from the published MCP catalog, with no wildcard/native-rule syntax. Scoped
callers cannot add or inherit these native permissions, which never change host
authority. Effective additions appear in `harness.nativePermissions`; saved
process recovery omits them. See [contract](harness-tool-permissions.md).

`runRecovery` adds read-only workflow `{action:"recover",runId?,offset?,expectedDigest?}`.
It resolves current authenticated worker context or a uniquely bound coordinator
run, with explicit selection for ambiguity and owner calls. It shares current
manifest pagination/digest fences and never adopts or replays native effects.
See [recovery context](harness-recovery-context.md).

Launch-local Claude harness recovery uses the same read-only `runRecovery` API
from a bounded native `SessionStart` hook. `harness.recovery.status` reports
preparation/unavailability metadata only, never model consumption or native effect
restoration. Older hosts remain capability-gated; there is no terminal-input fallback.

`runCheckpoints` and `runConstraints` add authenticated workflow actions
`{action:"checkpoints",request:{action:"save"|"list"|"get"|"context",...}}` and
`{action:"constraints",request:{action:"add"|"list"|"acknowledge",...}}`.
They preserve literal manual owner text, historical/current context separation,
bounded digest-checked pages and native input revision fences. Context reads
never restore effects or adopt a process. See [contract](harness-checkpoints.md).

`runWakes` adds explicit delta-only coordinator notices inside authenticated
workflow requests: `{action:"wakes",request:{action:"enable"|"disable"|"get"|"batch",...}}`.
See [wake contract](harness-wakes.md) for current-attempt attention sources,
coalesced native receipt provenance, human/budget fences and restart non-replay.
`runWakeDelivery` adds owner-only `pause`, `resume` and
`setDelivery {delivery:"delta"|"full"}` wake actions; see
[owner hold and delivery mode](harness-wakes.md#owner-hold-and-delivery-mode).

`runExecutor` adds opt-in deterministic scheduling inside authenticated workflow
requests: `{action:"executor",request:{action:"start"|"get"|"disable"|"enable",...}}`.
See [executor contract](harness-executor.md) for immutable profiles, authority,
generation fences, native provenance, budgets and non-replay after restart.

`runDelivery` adds explicit queued task instruction and pre-claim cancellation
inside authenticated workflow requests. See [task delivery](harness-task-delivery.md)
for receipt correlation, readiness, human priority and restart behavior.

`taskNativeToolProfiles` adds optional task/executor `profile.allowedNesvoTools`
with distinct omission/empty/subset semantics. Native grants remain internal;
task history records requested `launch.profile` (null on legacy rows).
See [task tool profiles](harness-task-tool-profiles.md) for scope and migration.

`durableJobs` and `jobScheduleKinds:["once","cron","rrule","external"]` add owner-only authenticated
`{action:"jobs",request:{action:"create"|"get"|"list"|"update"|"setEnabled"|
"runNow"|"history"|"occurrence"|"mutation",...}}` workflow requests. Definitions,
immutable occurrences and their workflow/native receipt pointers are separate.
See [job contract](harness-jobs.md) for bounded dispatch, misfires, overlap,
validation, crash non-replay, CLI/MCP parity and current limitations.

Strict `jobExternalTriggers:true` and `jobTriggerProviders:["webhook","github"]`
add owner-only `{action:"jobs",request:{action:"triggers",request:{...}}}` for
registration, revision-checked administration and retained delivery reads.
`schedule:{kind:"external"}` has no timer due date. The separately opted-in
loopback HTTP listener uses restricted journal ingress rather than owner commands;
`jobTriggerListener:{enabled,address}` reports runtime availability in capabilities
and doctor. Additive tables preserve old job fingerprints. See the
[external trigger contract](harness-job-triggers.md) for signatures, replay,
immutable ignored receipts and deployment boundaries.

Optional job capabilities extend this request family: `jobPrechecks` adds owner
approvals and prechecks, `jobCancellation` adds `cancelOccurrence`, and
`jobAttempts` adds the read-only `attempts`/`attempt` generation journal. Creation
or update with an explicit `spec.retry` additionally requires `jobRetries:true`
and a well-typed `jobRetryKinds` array containing `launchNoEffect`. Policies are
default-off, bounded and supported only for proven no-effect native launch
refusals. Occurrences may expose `retryWaiting`; occurrences and generation
views may expose nullable immutable `retry` decision facts. Older accepted
responses may omit those fields. These additive capabilities do not change
protocol framing, agent tool grants or automatic replay rules.

An explicit non-null `spec.executionTimeoutMs` requires strict boolean
`jobExecutionTimeouts:true`. The optional duration is 1000 through 604800000
milliseconds; omission/null preserves existing admission-budget behavior. It is
frozen with each occurrence and armed atomically at native launch admission,
after any approved precheck. Enforcement uses the current host's monotonic
clock; public wall-clock `armedAt`/`deadlineAt` are diagnostic evidence. Current
occurrence and exact job-attempt detail add nullable `executionTimeout`, with
stable generation/native/control pointers and cleanup state. Private claims and
monotonic origins are never exposed. A valid explicit worker report accepted
before expiration disarms the timer independently of later validation. A due
timer cannot override a human takeover, and a stop receipt alone cannot prove
process exit. Restart invalidates unfinished timer authority and requires
reconciliation, without rearming or replaying effects. See the
[execution timeout contract](harness-job-timeouts.md) for exact fields, states
and owner cleanup behavior. This adds no MCP tool, grant or framing version.

Strict `jobLaunchReconciliation:true` adds owner-only job request
`abandonLaunchNoEffect` with required `jobAttemptId`, `expectedDigest` and
`acknowledgeUnknownEffects:true`, alongside the job/occurrence IDs and mutation
key. CLI `job abandon-launch` and MCP `nesvo_abandon_job_launch` share that
operation. Nullable `launchReconciliation` and `launchResolution` extend current
occurrence and exact generation views; old accepted envelopes may omit them.
Acceptance retires only the proven no-effect generation and releases logical
overlap without rewriting native, precheck or cleanup evidence. Fresh effects
on that Run remain permanently fenced. See the
[launch reconciliation contract](harness-job-launch-reconciliation.md).

Combining `spec.retry` with `precheckId` additionally requires the strict boolean
`jobPrecheckGenerations:true`. Each claimed generation separately authorizes and
executes the immutable approved command; an older pass cannot release a newer
worker. Generation-1 precheck bodies retain their legacy shape; later prechecks
also expose nullable `approvalRevision`. Occurrence views resolve the current
precheck, while attempt detail/history resolve that exact generation. The existing
`abandonPrecheck` request accepts optional `jobAttemptId`; omission is compatible
only with generation 1. Later unknown prechecks require their exact current ID,
digest and explicit owner acknowledgement. Accepted mutation replay keeps its
original body and does not repeat effects. Revocation prevents a future command
admission; it does not erase a previously recorded command result.

`runLaunch` adds `{action:"launch",request:{key,runId,taskId,expectedRevision,profile}}`
inside authenticated workflow requests. It reserves the attempt, run capacity,
native receipt and session identity atomically before physical startup. New
attempt states `launching`, `launchFailed` and `launchUnknown` distinguish
reservation, proven no-effect refusal and uncertainty. Current task history
includes native receipt pointers separately from immutable mutation acceptance.
See [atomic task launch](harness-task-launch.md) for strict profile fields,
scope, recovery, same-run control serialization and compatibility.

Hosts advertising `workflowPlans` also accept authenticated `workflow` requests
with a nested `request` tagged by `action`. The [draft workflow contract](harness-workflows.md)
and [durable inbox](harness-inbox.md)/[decision contracts](harness-decisions.md)
specify IDs, DAG validation,
atomic revisions, scoped metadata recovery, addressed delivery, exact ACK and
bounds. These requests have no PTY effects and produce no unsolicited workflow
packets for legacy clients.

`hostBudgets` additionally advertises owner-only `hostBudget` actions inside the
workflow envelope. [Host admission policy](harness-budgets.md) defines exact budget
revisions, recovery, shared runtime projection and the absence of native effects
from policy mutations. This does not change legacy client authentication/input.

`runBudgets` and `runDrain` advertise per-run admission policy and drain/resume
workflow actions. [Run budgets](harness-run-budgets.md) define the activation
clock, typed refusals and owner drain latch. Policy responses use `run,policy`;
ordinary run/context views include `run.budget`. Neither metadata mutation
starts or terminates a process. Automated native send checks the bound attempt's
time/decision gates before paste and again before submit. Direct human input
and existing native interrupt/stop authorization remain separate.

`runControls` adds nested `control` requests with `start` and `get` actions.
Start durably freezes bound worker targets before native stop dispatch; its
keyed reply is immutable acceptance, not process exit. Get returns up to eight
targets and `nextOffset`, including original native receipt IDs and explicit
unknown/unavailable outcomes. Trusted host exit observations finalize stop/cancel
even without a client. Same-key replay, reconnect and reads never signal. See
[native run controls](harness-run-controls.md) for exact wire shape, authority,
human draft protection, state transitions, bounded retention and recovery.

Session-scoped native callers may send one `x-nesvo-scope` WebSocket handshake
header with the public random scope ID from their private context file. The host
selects that launch's independent key before the existing challenge/nonce/sequence
proof; an unknown/expired scope is rejected, never downgraded to owner. Without
the header, legacy owner pairing behaves as before. A scope ID or claimed parent
session ID alone grants no access. Authorization precedes both synchronous and
asynchronous host dispatch. Scoped snapshots and background control events are
filtered at publication; group rollups are recomputed for the visible set.

The default worker capability is read-only and expires at process exit. Its
capabilities response includes `caller:{sessionId,role:"worker",
permissions:["session:read"],expires:"processExit"}`. Owner-only advanced launch
may request `role:"coordinator"` when `coordinatorScopes:true` is advertised.
Coordinators additionally receive `child:create/read/send/interrupt/stop` for
explicitly granted children created by that launch. The host validates the role,
parent, workspace/group and live actor again before native effects; untrusted
file claims or parent metadata cannot add grants. Global diagnostics, direct
input/leases, arbitrary review directories and unrelated subjects stay forbidden.
Existing connections after observed process exit get `scope_revoked`. Context
credentials never appear in snapshots. This is API authorization, not an OS sandbox.

- `auth { clientNonce }` → `connected { clientNonce, clientId, protocolVersion: 2 }`; `clientId` is a JSON number, scoped to this connection.
- Then `sessions { sessions, groups, revision }`. `list` requests the same snapshot. Snapshots are broadcast when session metadata, groups or observed status changes.
- Session: existing `id,name,cwd,createdAt,cols,rows,running`, optional `uptimeSeconds` (non-negative integer, monotonic process age frozen at exit), plus `program: "shell" | "claude" | "gemini" | "codex"`, `groupId: string|null`, `controllerId: number|null`. Lease secrets are never in snapshots. Current hosts always supply `program`; clients can treat a missing value in an older snapshot as `shell`.
- Group: `{ id, parentId: string|null, name, order: number }`. Root is `null`, not a synthetic group.
- Additive `parentSessionId:string|null` describes immutable process lineage, independent of groups. Missing/null means no parent. A child is a normal visible process with its own ID, output and control lease; opening it never starts another process. This metadata confers no authority. `sessionLineage:true` advertises advanced launch support; a requested parent must be a live process when launching. Historical recovery metadata retains lineage, without claiming processes survived host restart.
- Additive `role:"worker"|"coordinator"` is host-owned launch metadata. Absence on an older host means no advertised coordinator support. Editing a context file's role does not change it. Recovery retains the requested role but does not resurrect private grants or an old process identity.
- Additive `resume:{state:"pending"|"verified"|"resumeFailed",conversationId,reason?}` marks a session launched with an exact `spec.resume`, which `restoreSession` with `exact:true` sets, and the `created` reply to that command carries the same object; other sessions omit it. `reason` accompanies only `resumeFailed`. Automated input is refused with `resume_pending` or `resume_failed` until the first root session-start hook reports source `resume` and the same `conversationId`; process exit or 60 seconds without that report turns `pending` into `resumeFailed`, with or without a lifecycle tracker. An exact launch or restore is refused with `resume_unverifiable` when the provider's lifecycle hooks will not be installed. See [exact conversation resume](harness-recovery-context.md#exact-conversation-resume).
- Additive `hibernation:{state:"hibernated",hibernatedAt,conversationId,trigger:"owner"|"idlePolicy",lastResumeFailure:string|null}` marks a hibernated session: its provider process is stopped while the host keeps the same `id`, name, folder, group, lineage, attention and frozen `uptimeSeconds`. Such a session has `running:false`, `controllerId:null`, `readiness.phase:"exited"`, no `lifecycle` and no `resume`, and its `status.freshness` (for clients that negotiate freshness) is `source:"journal"`, `stale:true` with `lastKnown` set to the state observed before hibernation. Hibernated sessions appear only in owner snapshots, count toward the retained-session budget and are left out of `listRecovery`. See [hibernation](harness-recovery-context.md#safe-resumable-hibernation).
- `sessionHarness:true` supports optional `spec.harness:boolean` on advanced launches. Absence inherits a scoped coordinator's setting, otherwise defaults off; explicit false opts out. The present adapter accepts probed Claude Code 2.1.303+ in the 2.1 series and requires a native client executable. Other versions/providers fail before effects. Additive session/explain `harness` metadata describes enabled/CLI availability/instruction version/declared MCP names/launch scope without paths or keys; `loaded:null` avoids claiming provider consumption. Configuration is immutable for the process lifetime; default omitted launch fields preserve historical receipt hashes.
- Additive `currentAttention` on each session is the host's current actionable projection: `priority:0..3`, `reason:null|permission|question|auth|quota|setup|unknown|startup|failure|child`, `status:SessionStatus|null`, and `blockedChildren:0..256`. Priority zero has no reason/indicator. This is separate from historical unread `attention` and never changes the root agent state. For example, a working parent with blocked protocol children has a blocked aggregate indicator and reason `child`.
- Each group and the snapshot root carry `attentionSummary:{sessions,needsYou,highest}`. Counts include descendant sessions once, independently of client collapse/filter state. `highest` is the highest-priority current projection or null. These derived values do not increment metadata revision. New clients consume them; legacy hosts retain client-side fallback behavior. Startup failure and process failure need attention; successful process exit or a settled response do not imply task success.
- A settled lifecycle response can create an unread attention event with legacy `kind:"done"`, additive `subject:"response"` and `turnId`. This means the response ended, not that a task succeeded. Duplicate Stop reports for the same turn do not repeat the notification. New work preserves historical unread data while current attention follows the new state; an ordinary successful process exit alone no longer creates a response notification.
- `revision` is the durable metadata revision. Group CRUD and session moves increment it; terminal output/control and session create/close do not.
- Optional `requestId` on any well-formed command is echoed on its application errors. It must be nonempty, have at most 128 UTF-8 bytes and contain no control characters. Malformed wire/protocol messages close the connection. Do not automatically retry input or destructive requests after reconnect.
- Errors: `{ type:"error", message, requestId? }`; stale revisions have `code:"revision_conflict"` and `revision` with the current value.

## Sessions and groups

Session snapshots and query output may include optional
`repositoryContext:{source,state,name,branch,observedAt,revision}`. Omission is
valid for older hosts or optional snapshot-byte clipping. All six inner fields
are required when present. `source` is exactly `launchDirectory`: the canonical
directory passed to the native launch, independently of later agent cwd or review
selection. The current cwd never changes this object or its `root`. States are `checking|ready|detached|notRepository|unavailable|stale`.
Repository/branch labels are nullable, nonempty, control-free UTF-8 strings of
at most 128/256 bytes. `ready` has both labels; `detached` has only a repository
name. Other states have null labels. Ready/detached/notRepository have a
nonnegative JavaScript-safe Unix-millisecond observation time; stale retains the
original time. Checking/unavailable have null observation time. `revision` is a
JavaScript-safe metadata revision, independent of workspace revision or native
conversation generation. This advisory object grants no authority or readiness,
commit or task-result proof. See [contextual search](harness-contextual-search.md).
Ready and detached contexts from a projects-capable host add `root`: the
absolute, canonical top-level path of the repository's main checkout (a linked
worktree reports the checkout it belongs to), at most 4096 control-free bytes.
Other states omit it. Clients key per-project state by `root` when present and
by the repository name otherwise.

An F31-capable host adds optional `searchRoot:{source,reason,path,observedAt}`,
projected and clipped together with `repositoryContext` from the same optional
bytes. It states which directory roots the contextual search and why; a
`currentCwd` path is a search term, while repository labels, `root` and the
derived project stay bound to the launch repository:

| `source`          | `reason`       | `path`                 | `observedAt` |
| ----------------- | -------------- | ---------------------- | ------------ |
| `currentCwd`      | `insideRoot`   | canonical provider cwd | Unix ms      |
| `launchDirectory` | `outsideRoot`  | `null` (never exposed) | Unix ms      |
| `launchDirectory` | `noCurrentCwd` | `null`                 | `null`       |

The current cwd comes only from hook payloads that carry one (Claude and Codex
`cwd`), written by the helper after the launch journal accepted that event.
The host uses it only while the process runs and the report names the
currently bound provider conversation; a lower journal sequence never replaces a
newer cwd, and `observedAt` is the first observation of that path, not renewed
by repeats. The allowed root is the launch directory's repository toplevel (the
nearest ancestor holding a `.git` entry, found without running Git) or the
launch directory itself. A cwd outside it is recorded as `outsideRoot` and not
used. A cwd change starts no Git work and never moves Git inspection. Clients that do not know the field ignore it. See
[contextual search](harness-contextual-search.md#current-provider-cwd).

The TUI ignores malformed optional context without rejecting a legacy session;
mobile keeps its existing strict optional-field rule and rejects malformed-present
context with the fixed validation error. Both accept omission and preserve the
original snapshot. Neither inspects local Git. The existing default admission
budget is eight retained sessions and the hard ceiling is sixteen; optional
context changes neither budget nor the authenticated plaintext limit.

`domainEvents:true` adds `readEvents`, `subscribeEvents` and `unsubscribeEvents`.
Their bounded durable cursors, retention gaps, subject authorization and health
contract are defined in `harness-events.md`. These domain cursors cannot be used
as terminal `readSession` byte cursors. Only the requesting/subscribing connection
receives event packets, so legacy mobile clients never receive unknown packets
without opting in.

`attentionInbox:true` adds owner `attentionInbox {page?,limit?}` (reply
`attentionInbox {items,page,limit,nextPage,total}`, at most 32 items and 60 KiB)
and `acknowledgeInbox {items:[{id,revision}]}` (reply `inboxAcknowledged
{acknowledged:[{id,revision,acknowledgedAt}]}`). Item IDs are stable
(`session:`, `decision:RUN:DECISION`, `run:RUN:ATTEMPT`, `result:OCCURRENCE`);
acknowledgements are durable receipts per revision, so a reconnect never repeats an
acknowledged item. Session revisions advance when the session's attention reason
changes or more children block, and are process-local: a host restart clears
session receipts while journal item receipts survive. Hosts may add item kinds,
programs and decision states: mobile drops
an inbox item of unknown `kind` or a decision of unknown `state` one by one, counts
them as `skipped` for the inbox badge, omits an item `program` outside the published
`claude`, `codex` and `gemini` (a `shell` value included), and keeps
the connection; malformed known items still reject the frame. `decisions:true` adds `decisions {page?}` (reply `decisions
{decisions,page,nextPage,total}`) and `decide {decisionId,choice,note?}` (reply
`decided`), which need no run ID, replay the original `decided` reply for the
exact answer that resolved the decision and otherwise refuse `decision_resolved`
or `decision_expired`. `jobPages:true` adds `page` to the owner job `list` and
`history` reads, with `page` and `nextPage` in the reply. A client that sends
`attentionInbox` or `decisions` opts in to `attentionInboxChanged
{reason,itemId?}`; no other client receives it. `registerPush` accepts optional
`kinds:["decisionPending","resultReady"]`; only phones that registered a kind
receive those metadata-only pushes (`data:{hostId,kind,itemId}`); `resultReady` is
pushed once per occurrence even when validation later settles it, and a
registration without `kinds` clears any kinds the phone chose earlier, so it keeps
receiving session attention pushes only. Mobile
requests each kind only when its own capability is advertised: `decisionPending`
needs `decisions:true` and `resultReady` needs `attentionInbox:true`, because a
result push opens an inbox item while a decision push needs the decision commands.
`pushDevices:true` adds the read-only owner command `pushDevices {requestId?}` (reply
`pushDevices {devices:[{device,kinds}]}`, at most 8 entries in registration order).
`device` is only the last six characters of the push token, so the list never
reveals a token; a phone recognizes itself by comparing the suffix of its own
token. `kinds` holds the chosen metadata push kinds (empty for session attention
only). Mobile drops unknown kinds one by one and keeps the device. Scoped callers
are refused like every other owner command. The mobile app shows the list in its
notification settings and re-reads it after each `pushRegistered`.

Mobile reads jobs only through the owner `workflow` request
`{action:"jobs",request:{action:"list"|"get"|"history",...}}` and only when
`jobPages:true`, always with `page`. Its decoder tolerates additions item by item:
an unknown occurrence `state` drops that occurrence and counts it as skipped, an
unknown `schedule.kind` or `calendarState` keeps the job with a null value, an
absent `calendarState` or `calendarError` (both optional in the published schema)
decodes as null, an
unknown retry `class` or `profile.program` is omitted, and a malformed known field
still rejects the frame.

Hosts advertising `sessionQueries:true` accept `getSession {sessionId}` and
`readSession {sessionId,after?,maxBytes?}`. Both echo request IDs. The former
returns `session {session}` using the snapshot DTO. The latter returns
`sessionRead {sessionId,cols,rows,page}` with bounded UTF-8 stream cursors, explicit
retention gaps and at most 8192 raw bytes per page; see `harness-cli.md` for the
complete page contract. Neither operation subscribes or acquires control. `list`
now echoes a supplied request ID as well, preserving the legacy snapshot shape.
Typed application errors include `session_not_found`, `invalid_cursor` and
`invalid_argument`. Older hosts are gated by capability before these new commands.

| Command                                                                        | Result                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `getCapabilities { requestId? }`                                               | Targeted `capabilities { workspace, programs:[{id,label,available}], directoryBrowser:true, providerLimits?, requestId? }`. |
| `listDirectories { path?, requestId? }`                                        | Targeted `directories { path, parent, entries:[{name,path}], requestId? }`; entries are subdirectories only.                |
| `create { name, program?, cwd?, groupId?, requestId? }`                        | Targeted `created { sessionId, requestId? }`, then broadcast snapshot. No automatic subscription/control.                   |
| `renameSession { sessionId, name, requestId? }`                                | Targeted `updated { revision, requestId? }`, then snapshot; runtime name does not increment metadata revision.              |
| `close { sessionId, requestId? }`                                              | Terminates the session and broadcasts a snapshot.                                                                           |
| `listRecovery { offset?, requestId? }`                                         | Targeted `recovery { records:[{id,spec,state}], nextOffset, requestId? }` for sessions that are not running.                |
| `restoreSession { id, exact?, requestId? }`                                    | Targeted `created { sessionId, resume?, requestId? }`, `recovery`, then a snapshot; `exact:true` resumes the conversation.  |
| `forgetRecovery { id, requestId? }`                                            | Targeted `recovery` page without that record; only the saved description is removed.                                        |
| `hibernateSession { sessionId, key, requestId? }`                              | Owner only. Targeted `sessionHibernation { sessionId, state:"hibernated", hibernation, replayed }`, then a snapshot.        |
| `resumeSession { sessionId, key, requestId? }`                                 | Owner only. Targeted `sessionHibernation { sessionId, state:"resumed", resume, replayed }` after the provider verifies.     |
| `createGroup { name, parentId, order?, expectedRevision, requestId? }`         | Targeted `groupCreated { groupId, revision, requestId? }`, then snapshot.                                                   |
| `updateGroup { groupId, name, parentId, order, expectedRevision, requestId? }` | Targeted `updated { revision, requestId? }`, then snapshot. Full replacement of editable fields.                            |
| `deleteGroup { groupId, expectedRevision, requestId? }`                        | Targeted `updated`, then snapshot. Only an empty group with no child groups can be deleted.                                 |
| `moveSession { sessionId, groupId, expectedRevision, requestId? }`             | Targeted `updated`, then snapshot.                                                                                          |

Group and parent IDs are strings or `null` for the root. `create` may omit `groupId`; `createGroup` may omit `order` to use zero. Names: trimmed, 1–80 Unicode characters, no control characters. Order: integer 0–1,000,000. Parents must exist; self-parenting and descendant cycles are rejected. Maximum 64 groups and 8 live/exited sessions in this iteration. SQLite stores groups/revision alongside the pairing files. Sessions and their group assignments live as long as the host process; database persistence does not preserve processes after restart.

`program` is one of `shell`, `claude`, `gemini`, or `codex`; omission selects `shell`. A missing or blank `cwd` uses the host's workspace. Relative paths resolve against that workspace; absolute paths can select any existing directory accessible to the host user. Paths are canonicalized before process creation. The workspace is a default, not a sandbox. An unavailable program or invalid directory returns an application error with the supplied `requestId`, without creating a session.

Capabilities contain all four program IDs. Discovery inspects PATH once at startup; requests only read the cache, and installation/PATH changes require a host restart. `available` means a supported launcher was found, not that subscription login is complete. The host starts the original CLI without injecting model API credentials or automating authentication. Native executables launch directly. Windows npm wrappers resolve through the known package's JavaScript bin entry and `node.exe`; unsupported custom wrappers are unavailable. No user-supplied command string or directory is interpolated into shell source.

Provider availability: additive `providers` is `{claude,codex,gemini}`, each `{state, version?, reason?}`. `noCli` means startup discovery found no supported launcher (the same cache as `programs[].available:false`); a client refuses that launch and shows `reason`. `ok` means the launcher exists and the provider's stored login file is present; it is not a validated session. `notLoggedIn` is reported only on deterministic local absence: Claude has no `.credentials.json` in `CLAUDE_CONFIG_DIR` or `~/.claude`, no Anthropic credential variable, no `apiKeyHelper` in that directory's `settings.json`, and the host is not macOS (Keychain); Codex has no `auth.json` in `CODEX_HOME` or `~/.codex`, no `OPENAI_API_KEY`/`CODEX_API_KEY`, and its `config.toml` does not set `cli_auth_credentials_store`; Gemini has no `oauth_creds.json` or `google_accounts.json` in `GEMINI_CLI_HOME` or `~/.gemini`, no Gemini or Google credential variable, and no selected auth type in `settings.json`. Everything else is `unknown` with a reason: an environment credential (never validated), a keyring or helper the host does not inspect, an unreadable or over-256 KiB file, a pending login check, or a failed version probe. `unknown` and `notLoggedIn` still launch; the provider asks for sign-in itself. `version` repeats a ready `providerVersions` entry. Credential files are only checked for presence and never read; only the bounded settings/config files are scanned for those key names. The check runs on a background thread outside the state lock, is cached and refreshes at most every two seconds when capabilities are read; it never runs a provider command or contacts the network. Clients see a changed login after the next `getCapabilities`.

`providerLimits` retains its compatible installed-provider display array: `{id,status:"checking"|"ready"|"unavailable",windows:[{usedPercent,durationMins,resetsAt}]}`. Current sources are bounded Codex full app-server snapshots and the existing Claude quota-only status-line cache; Gemini explicitly has no implemented structured source. Stale or unavailable values clear from this live panel. Additive `providerQuotaObservations:true` advertises owner-only `{type:"getProviderQuota",program?:"codex"|"claude"|"gemini",refresh?:false}` and the `providerQuota` reply with detailed `providers` and nullable asynchronous `refresh` acceptance. `refresh:true` requires an explicit installed provider with a supported source. Revisions count every attempt; failures do not renew the last successful snapshot. Original cache age and monotonic read freshness remain separate. Metadata, backend usage permission and native-session account binding are distinct. See the [quota observation contract](harness-provider-quota.md) for exact bounds, fields and limitations. Owner diagnostics include `providerQuota`; scoped session diagnostics do not.

For a full Codex response, `complete:true` validates all supplied window objects;
it does not require two fixed plan windows. Missing/null slots add no window or
numeric capacity. Zero/one-window observations still need explicit backend
ordinary-use permission for eligibility, and every reported denial/reset remains
a hold. Sparse notifications cannot create or refresh that authority. Five-hour
wake additionally requires an actual unique 300-minute window.

Additive `claudeQuotaCapture:true` advertises optional owner-selected
`claudeQuotaCapture:{displayProfile:absoluteHostPath}` on supported Claude create
and workflow/task/job profiles. It pins an explicitly declared display executable,
arguments and presentation in one private launch scope; omission preserves the
native statusline. Scoped callers cannot select or implicitly inherit it. Session
diagnostics distinguish requested configuration from `nativeQuotaCallback` receipt;
neither establishes fresh backend permission or an account lease. See the
[launch-local capture contract](harness-claude-quota-capture.md). There is no new
MCP tool or global provider configuration mutation.

Owner `claudeQuotaCapture` diagnostics add bounded `delivery` and `reader`
objects. Delivery retains latest started/completed/rejected attempts with an
independent sequence, entry generation, fixed outcomes and receipt clocks;
reader health remains separate from the accepted `nativeQuotaCallback`.
Older hosts may omit the objects. Failures never refresh an accepted snapshot,
and a retained historical storage failure is not current permission evidence.
The [capture contract](harness-claude-quota-capture.md#capture-delivery-diagnostics)
defines the enums, privacy and best-effort persistence limits.

Additive `durableQuotaWake:true` advertises owner-only `{type:"getQuotaWake",sessionId}`
and the durable implementation of `{type:"setWake",sessionId,enabled}`. The getter
returns `{type:"quotaWake",sessionId,quotaWake:null|view}`; the setter retains
`{type:"wakeConfigured",sessionId,wakeAt}` and adds nullable `quotaWake`. Its view
contains `id`, `sessionId`, `launchId`, `generation`, `phase`, nullable `reason`,
nullable `predecessorId`, opaque `source:{readerId,contextId,accountFingerprint,revision,resetAt}`
and nullable `operationId`/`operationPhase`. Reset uses Unix seconds, not a local
elapsed clock. Older `quotaWake:true` alone does not advertise this contract.
Reading/replaying receipts never dispatches a continuation. Restart pauses every
retained arm rather than adopting another process. See [one-shot quota wake](harness-quota-wakes.md).

The directory browser starts at the host workspace if `path` is omitted. Each response has the canonical absolute `path`, its optional `parent`, and up to 512 sorted child directories. The TUI sends a new request when the user opens a child or parent and applies only the matching `requestId`. Older hosts omit `directoryBrowser`; the TUI keeps the launch form open and asks for a host update instead of sending an unsupported command. Newly launched PTYs receive `NESVO_SESSION=1`; interactive TUI startup refuses to run inside one of those sessions, while `--list` remains available for scripts.

## Reviews

Additive `reviews:true` advertises host-side review sessions. Scoped session callers receive `forbidden` for every command below except `getDiff` with only a `sessionId` they may read. Errors are `{type:"error", code, message, requestId?}`.

| Command                                                                   | Reply                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `openReview { source, base?, requestId? }`                                | `reviewProgress { stage }` events, then `reviewOpened`                 |
| `reviewContext { reviewId, requestId? }`                                  | `reviewContext { reviewId, directory, readiness, provenance, checks }` |
| `deliverReview { reviewId, sessionId, text, key?, leaseId?, requestId? }` | `reviewDelivered { reviewId, sessionId, path, key, bytes, receipt }`   |
| `watchReviews { requestId? }`                                             | `reviewsWatched`                                                       |
| `getDiff { sessionId?, reviewId?, scope, directory?, base?, from?, to? }` | `diff { sessionId, reviewId?, review \| error }`                       |

`source` is `{kind:"local", sessionId?, directory?}` (a session's context folder, or an absolute folder) or `{kind:"pull", url}` for `https://github.com/OWNER/REPO/pull/N`. A pull request runs `gh pr view` and fetches the head and base into a partial checkout under `<config>/nesvo/reviews/<owner>-<repo>-<n>`, reused when present, with `reviewProgress.stage` `metadata`, `fetch` and `checkout`. Fetch, checkout and the initial branch diff share one 120 s deadline; when it passes the command fails with `timeout`. One pull request fetch runs per host (`busy` otherwise); review Git work shares the connection's single Git slot with `getDiff`.

`reviewOpened { reviewId, directory, source, base:{ref, oid, mergeBase}|null, head:{ref|null, oid|null}, scope:"branch"|"unstaged", revision, checks:{headOid, total, passed, failed, pending}|null }`. `reviewId` is deterministic: `local-<16 hex>` or `pull-<owner>-<repo>-<n>`. A local `source` echoes `{kind, sessionId, context}`; a pull `source` adds `owner`, `repo`, `number`, `title`, `state`, `headRef`, `baseRef` and `headOid`. The host keeps the last 64 reviews in memory; reopen them after a host restart.

The opener receives `reviewOpened` only as its reply. The same event without `requestId` reaches the other owner clients that opted in: a connection becomes a review watcher after it sends `watchReviews` or any review command (`openReview`, `reviewContext`, `deliverReview`, or `getDiff` with `reviewId`) and stops being one when it disconnects. Clients that never opt in, such as the mobile app, receive no review events. The TUI sends `watchReviews` once when the host advertises `reviews`.

`readiness` reports `worktreeRevision`, `head`, `branch`, `upstream`, `ahead`, `behind`, `staged`, `unstaged`, `untracked`, `conflicted`, `truncated`, `clean`, `base:{ref, oid, ahead, behind, mergeConflicts, conflictPaths}|null`, `pushed`, `blockers` and `ready`. Blockers are `unborn`, `conflicts`, `baseConflicts`, `dirty`, `behindBase`, `behindUpstream` and `unpushed`. `provenance` carries `evidence` (`hooks`, `unavailable` or `notSession`), `sessionId`, `turn`, `complete`, `truncated` and up to 128 `files` with `path`, `changed`, `attribution` (`agent`, `otherAgent`, `uncertain`, `unattributed`), `thisTurn`, `subagent`, `sessions` and `editedAt`. Local checks are not run.

`deliverReview` targets a ready, idle agent session. Without a control lease the text becomes a durable operation (`path:"operation"`, at most 8192 bytes, `too_large` beyond, `key` defaulting to a hash of review, session and text). With the caller's own `leaseId` it is pasted with bracketed paste and not submitted (`path:"paste"`, up to 32 KiB); another client's lease gives `control_busy`.

With `reviewId`, `getDiff` takes its folder and default base from the review. `scope:"branch"` diffs the merge base of `base` (default the repository's default branch) against the working tree including untracked files; `scope:"commits"` diffs `from` to `to` (default `HEAD`). The `review` object adds `revision` (`<tree12>-<hash16>`), `head`, `base:{ref, oid, mergeBase}` for the branch scope and `range:{from, to}` for the commits scope.

## Files sidebar

Additive `files:true` advertises three owner-only read commands. Scoped session callers receive `forbidden`, the same policy as `listDirectories`. Every path is an absolute host path (at most 4096 bytes, no control characters) and is canonicalized before use. Requests run off the shared state lock, at most two per connection; a third concurrent request receives `busy`. Errors are `{type:"error", code, message, requestId?}` with `invalid_argument`, `not_found`, `not_directory`, `not_readable`, `not_file`, `binary`, `outside_root`, `busy` or `files_failed`.

| Command                                              | Result                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `listEntries { directory, showHidden?, requestId? }` | `entries { directory, root, entries:[{name, kind, size, modifiedMs, status, ignored}], truncated, statusTruncated, requestId? }` |
| `readFile { path, offset?, limit?, requestId? }`     | `file { path, size, offset, length, text, truncated, encoding:"utf8", requestId? }`                                              |
| `findFiles { root, query, limit?, requestId? }`      | `files { root, matches:[{path, score}], scanned, truncated, requestId? }`                                                        |

`listEntries` lists one level. `kind` is `file`, `dir`, `symlink` or `other`; `size` is the byte length of files and zero otherwise; `modifiedMs` is Unix milliseconds or `null`. Directories sort first, then names case-insensitively. At most 20,000 directory items are scanned and 2,000 entries returned; `truncated` reports either cap. Names that are not UTF-8 or contain control characters are skipped. Hidden entries (a leading dot, or the Windows hidden attribute) are omitted unless `showHidden` is true.

Inside a Git work tree `root` is the canonical repository toplevel, otherwise `null` and every `status` is `null`. Status letters come from one `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` per toplevel (4 MiB output, 10 s), cached for 2 s, so a refresh within that window may repeat the previous letters. `status` is `M`, `A`, `D`, `R`, `?`, `!` or `null`. A directory carries the strongest letter of its descendants (`M` over `A`, `R`, `D`, `?`). Entries matched by an ignore rule, or inside an ignored directory, have `ignored:true` and `status:"!"`. Tracked files deleted from the work tree appear as synthetic `D` entries with `modifiedMs:null`. `statusTruncated` is true when the status output was cut or Git failed.

`readFile` returns UTF-8 text, at most 64 KiB per call (`limit` defaults to and is clamped at 65,536 bytes). A NUL byte in the first 8 KiB or in the requested window refuses the file with `binary`. A window that starts inside a multi-byte character advances `offset` past it, and a window that ends inside one stops before it; the next page starts at `offset + length`. Other invalid bytes become U+FFFD. `outside_root` refuses a link whose target leaves the repository toplevel of the requested file's folder, or that folder itself outside a repository.

`findFiles` walks `root` once honouring `.ignore`, plus `.gitignore` and Git excludes inside a repository, and skipping hidden entries (maximum depth 32, no link following, sorted by name), stopping after 5,000 entries; the walk is cached for 2 s per root. `matches` contains files and links whose relative `/`-separated path contains the query characters in order, ignoring case and whitespace. Each matched character scores 1, plus 6 at a path-segment start, 3 after `_`, `-`, `.`, a space or a lower-to-upper case change, 6 when consecutive and 2 inside the basename; the best alignment over segment starts wins and long paths lose `length / 8`. Results sort by score, then shorter path; `limit` defaults to 50 and is clamped at 200. `query` is at most 256 bytes; an empty query lists the shortest paths.

## Commit history

Additive `git:true` advertises one owner-only read command for the TUI Git view; scoped session callers receive `forbidden`, as for `listDirectories`. It shares the two-per-connection file request limit (a third concurrent request receives `busy`) and does not take the review Git lock.

| Command                                         | Result                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `listCommits { directory, limit?, requestId? }` | `commits { directory, commits:[{oid, shortOid, summary, author, committedMs, parents:[oid]}], truncated, requestId? }` |

`directory` is an absolute host folder inside a Git work tree and is echoed as sent. The command runs one `git log HEAD` without signatures, decorations or colour (10 s, 1 KiB of output per commit), newest first. `limit` defaults to 50 and is clamped to 1..200; `truncated` is true when more commits exist or the output was cut. `summary` is the subject line (200 characters), `author` the author name (80 characters), `committedMs` the committer time in Unix milliseconds and `parents` the parent ids (empty for a root commit, at most 8). An unborn branch returns an empty list. Errors are `{type:"error", code, message, requestId?}` with `invalid_argument`, `not_found`, `not_directory`, `not_repository`, `timeout`, `git_failed` or `busy`. A commit's diff is `getDiff { reviewId, scope:"commits", from: parent, to: oid }`.

## Notes

Additive `notes:true` advertises four owner-only commands over plain markdown files; scoped session callers receive `forbidden`. Requests run off the shared state lock, at most two per connection (a third concurrent request receives `busy`).

| Command                                                   | Result                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `listNotes { root, requestId? }`                          | `notes { root, directory, location, repository, notes:[{name, path, size, modifiedMs, firstLine}], truncated, requestId? }` |
| `readNote { path, requestId? }`                           | `note { path, name, text, size, modifiedMs, revision, requestId? }`                                                         |
| `writeNote { path, text, expectedRevision?, requestId? }` | `noteSaved { path, name, revision, size, modifiedMs, created, requestId? }`                                                 |
| `deleteNote { path, requestId? }`                         | `noteDeleted { path, name, requestId? }`                                                                                    |

`root` is an absolute host folder. Inside a Git work tree the notes folder is `<toplevel>/.nesvo/notes` (`location:"repository"`); the host never adds ignore rules, so committing it is the owner's choice. Otherwise it is `<config>/nesvo/notes/<hostId>` (`location:"host"`, `repository:null`). A missing folder lists as empty and is created by the first write. Notes are flat files whose names use letters, digits, spaces, `-`, `_` or `.`, end in `.md` and do not start with a dot; at most 500 are returned, newest first, and `firstLine` is the first non-empty line (120 characters).

A note `path` must be absolute, without `.` or `..` segments, and name a file directly inside one of those folders. Each request walks the folder levels without following links: a linked level is refused with `outside_notes`, a level that is not a folder with `not_directory`, and only a write creates missing levels. Notes are UTF-8 text without NUL, at most 64 KiB. `revision` is the SHA-256 of the content in lowercase hex. A write replaces the file atomically (temporary file, sync, rename); with `expectedRevision` it succeeds only while the note still has that revision, and without it only while the note does not exist. Otherwise it is refused with `stale_revision` and the current `revision` (`null` when the note is gone). Errors are `{type:"error", code, message, revision?, requestId?}` with `invalid_argument`, `not_found`, `not_directory`, `not_file`, `not_readable`, `not_writable`, `not_text`, `binary`, `too_large`, `outside_notes`, `stale_revision`, `unsupported`, `busy` or `notes_failed`.

## Worktrees

Additive `worktrees:true` advertises owner-only worktree commands; scoped session callers receive `forbidden`. Requests share the four-per-connection event request limit (`busy` beyond it). Errors are `{type:"error", code, message, requestId?}`.

| Command                                      | Result                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `describeWorktreeSetup { directory }`        | `worktreeSetup { repository, configured, config, digest, approved, policy }`           |
| `approveWorktreeSetup { directory, digest }` | `worktreeSetupApproved { repository, digest, approvedAt }`                             |
| `revokeWorktreeSetup { directory, digest }`  | `worktreeSetupRevoked { repository, digest, revoked }`                                 |
| `runWorktree { sessionId }`                  | `worktreeRunStarted { sessionId, worktree, log }`                                      |
| `cancelWorktree { sessionId }`               | `worktreeCancelled { sessionId, cancelled }`                                           |
| `archiveWorktree { sessionId, discard? }`    | `worktreeArchived { sessionId, worktree, branch, discarded, blockers, branchDeleted }` |
| `listWorktrees`                              | `worktreeRegistry { worktrees:[...] }`                                                 |

`config` is `{ setup, run, envFiles, timeoutS }` from the committed `nesvo.toml`. A `launch` with `worktree:true` holds the agent spawn until the approved setup passes; a refused or failed setup replies `{type:"error", code, message, sessionId}` with the reserved session ID and starts no process. Journal events `worktree.prepared`, `worktree.ran` and `worktree.archived` carry `sessionId`, `result` or archive facts and the log path; an approval and an effective revocation journal `worktree.setup_approved` and `worktree.setup_revoked` with `repository` and `digest`. The [harness CLI](harness-cli.md#worktree-setup-run-and-archive) describes the file format, trust policy and refusals.

## Projects

Additive `projects:true` advertises an owner-only project registry keyed by repository root path; scoped session callers receive `forbidden`. The host derives entries from resolved session repository contexts, launch folders and the worktree registry, persists them in the metadata database (migration `0009_projects`) and keeps at most 256 roots, evicting the least recently active unpinned root first. At most 64 roots can be pinned (`project_limit`). Roots are matched after canonicalization; an unknown root is `project_not_found`.

| Command                              | Result                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `listProjects`                       | `projects { projects:[{ root, name, defaultBranch, lastActivityAt, pinned, openSessions, sessions }], limit }` |
| `pinProject { root }`                | `projectPinned { root, pinned:true }`                                                                          |
| `unpinProject { root }`              | `projectPinned { root, pinned:false }`                                                                         |
| `projectDefaults { root }`           | `projectDefaults { root, name, defaultLayout, launchFolder, folders, worktreeSetup }`                          |
| `setProjectLayout { root, layout? }` | `projectLayout { root, defaultLayout }`                                                                        |

The list is sorted pinned first, then by last activity. `defaultBranch` is the branch last seen in the main checkout; `sessions` holds up to 64 running session IDs whose context root, worktree record or launch folder belongs to the project. `launchFolder` is the folder with the most distinct session launches (the root when none is recorded) and `folders` lists up to eight. `worktreeSetup` is `{ available, configured, digest, approved, openWorktrees, error? }` from the committed `nesvo.toml` and the worktree registry; reading it runs nothing. `defaultLayout` is a host-wide layout name of at most 40 characters that clients may use when they hold no local project default.

## MCP server pool

Additive `mcpPool:true` advertises an owner-only, read-only view of the host's warm stdio MCP server pool; scoped session callers receive `forbidden`.

| Command         | Result                                                        |
| --------------- | ------------------------------------------------------------- |
| `mcpPoolStatus` | `mcpPool { available, bounds, processes, entries, sessions }` |

`bounds` is `{ processes, warmPerKey, idleMs, connectMs, sessions }`. `processes` is `{ warm, leased }`. Each entry is `{ entryId, server, program, digest, root, state:"warm"|"leased", sessionId, ageMs }`; a lease token or endpoint is never listed. `sessions` holds up to 256 recent per-session outcomes `{ sessionId, server, program, mode:"pooled"|"cold"|"dedicated", reason, entryId }`, removed when the session closes. Journal events `mcp.pool_attached`, `mcp.pool_released` and `mcp.pool_reaped` record leases and reaping. The [MCP guide](harness-mcp.md#warm-server-pool) describes eligibility, isolation, bounds and the `mcp_pool_unavailable` cold fallback.

## Observed session status

Session snapshots also include `status: { state, source, updatedAt }`. Older hosts may omit it; a client must not manufacture semantic agent state from `running` alone. `updatedAt` is the host's epoch-millisecond timestamp of the last state/source transition, not the last output byte. Status never increments the durable metadata revision.

| Source     | States                                   | Meaning                                                                                                                                 |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `activity` | `working`, `idle`, `unknown`             | Recent input/output, quiet shell, or unrecognized CLI state. This is I/O observation, not proof that an agent is thinking or waiting.   |
| `screen`   | `working`, `idle`, `blocked`, `question` | Conservative inference from a recognized program's current visible terminal screen. It can be wrong and must never authorize an action. |
| `process`  | `done`, `failed`, `unknown`              | The child exited with code zero/nonzero, or its exit status could not be read. Late output cannot revive its state.                     |

The host samples status every 250 ms and broadcasts one snapshot only when a state/source changes. A shell becomes `idle` after 1.5 seconds without input/output; an unrecognized CLI becomes `unknown`. A shell that emits OSC 133 prompt marks reports `source: screen` instead: `idle` once its prompt is drawn and `working` from a command-start mark until the next finish or prompt mark, however quiet the command is; [provider status signals](provider-signals.md) lists every signal's source. Quiet output never implies completion or a permission request. Explicit `close` removes a session, while a naturally exited process remains visible until closed. Detection uses the program selected at creation: launching an AI CLI later from a generic shell does not enable provider-specific screen rules.

For known CLI programs, a host-side VT parser tracks the canonical dimensions with zero scrollback. Detection examines at most the last 12 nonempty visible lines. Current rules recognize selected English Codex approval/question/footer layouts, Gemini execution permission choices and Claude permission/prompt layouts. All required markers must coexist on the current screen; ordinary question prose, cleared screens and historical scrollback are not sufficient. Other versions, languages, layouts and terminal programs may remain `unknown`. This parser is used only for status hints; bounded transcript replay is still not an exact screen snapshot.

Screen rules are deliberately narrow and version-sensitive. Codex's [question overlay](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs) and Gemini's [confirmation renderer](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx) define the corresponding UI markers. Tests use synthetic screens and local fixture processes; they do not start or authenticate real AI tools. The host does not install CLI hooks, alter provider configuration or make model API requests.

## Watching and control

- `subscribe { sessionId }`: add this session to this client's subscriptions; multiple are allowed. Reply `subscribed { sessionId, cols, rows }`, a `control` event, then bounded historical `output { sessionId, data, replay:true }`. Subscribe never changes PTY dimensions or takes control.
- `unsubscribe { sessionId }`: remove a subscription; reply `unsubscribed { sessionId }`. Does not implicitly release a control lease.
- `acquireControl { sessionId, cols, rows, takeOver?:boolean }`: acquire a fresh lease or explicitly replace another controller when `takeOver:true`. Automatically subscribes if necessary. Reply/broadcast `control` below. Normal acquisition rejects a session already owned by another client. The first controller of a session receives another `subscribed` acknowledgment to reset its view, then `control`, then original startup replay so it can answer ConPTY negotiation. Other subscribers never receive this extra replay. Later acquisitions send only `control`.
- `releaseControl { sessionId, leaseId }`: exact current owner and lease required; broadcast `control` with no owner.
- `input { sessionId, data, leaseId }` and `resize { sessionId, cols, rows, leaseId }`: only the current owner with the current lease can act. A previous lease is rejected even if that same connection reacquires control.
- `control { sessionId, controllerId:number|null, cols, rows, leaseId? }`: all connected clients receive ownership/dimensions; only the owner receives `leaseId`. Every acquisition generates a fresh opaque lease ID. Resize broadcasts the new canonical dimensions.
- Disconnect releases all control leases owned by that connection and removes its subscriptions. Processes continue running. Connection heartbeats detect disappeared clients; explicit takeover does not wait for that timeout.
- PTY dimensions are canonical, 10–300 columns and 2–150 rows. Viewers render those dimensions locally and must not issue resize. One client may control several sessions, while only its focused view supplies user input.
- Only the controller may forward terminal query replies. Passive viewers must suppress all generated terminal input as well as keyboard input.
- Original startup replay to the first controller adds `allowResponses:true` to its `output` events. A controller may answer queries from live output or this explicitly marked startup replay. Other historical replay must not trigger responses.

## Legacy compatibility and replay limits

Capabilities are sent in response to `getCapabilities` and, on hosts supporting `providerLimits`, after a change in the cached Codex limits. Existing `create` requests without `program` continue to create a shell. These are additive commands within application protocol v2: an older v2 host can still reject `getCapabilities` and close the connection. Upgrade host and clients together for the launcher picker; `protocolVersion:2` alone does not establish support for this extension.

Feature flags in `capabilities` are strict booleans unless noted: a client sends the matching
commands only when the flag is `true` and treats absence as unsupported. The host advertises more
flags than clients gate on; these are the ones current clients check:

| Flag                 | Gates                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `files`              | `listEntries`, `readFile` and `findFiles` ([files sidebar](#files-sidebar))                             |
| `git`                | `listCommits` ([commit history](#commit-history))                                                       |
| `reviews`            | review sessions and their commands ([reviews](#reviews))                                                |
| `worktrees`          | owner worktree setup, run, cancel, archive and registry commands ([worktrees](#worktrees))              |
| `recovery`           | `listRecovery`, `restoreSession` and `forgetRecovery`                                                   |
| `conversationResume` | `exact:true` on `restoreSession`, a field older hosts do not know                                       |
| `attentionInbox`     | `attentionInbox`, `acknowledgeInbox` and the `resultReady` push kind                                    |
| `decisions`          | `decisions`, `decide` and the `decisionPending` push kind                                               |
| `jobPages`           | `page` on the owner job `list` and `history` reads                                                      |
| `pushDevices`        | the read-only owner `pushDevices` listing of registered phones                                          |
| `notes`              | `listNotes`, `readNote`, `writeNote` and `deleteNote` ([notes](#notes))                                 |
| `projects`           | the project registry commands ([projects](#projects))                                                   |
| `mcpPool`            | `mcpPoolStatus` ([MCP server pool](#mcp-server-pool))                                                   |
| `workflowTemplates`  | `nesvo.toml` run templates ([templates](harness-workflows.md#templates-from-nesvotoml))                 |
| `workflowHostChecks` | `hostChecks:true` on result validation ([host-run checks](harness-workflows.md#host-run-checks))        |
| `runDigests`         | the run `digest` read ([run digest](harness-workflows.md#run-digest-and-working-state))                 |
| `runWakeDelivery`    | owner wake `pause`, `resume` and `setDelivery` ([wakes](harness-wakes.md#owner-hold-and-delivery-mode)) |
| `sessionFreshness`   | the opt-in freshness record below                                                                       |
| `providers`          | an object, not a flag: per-provider availability ([sessions and groups](#sessions-and-groups))          |
| `hibernation`        | owner `hibernateSession` and `resumeSession`                                                            |

`hibernationIdlePolicy:{enabled,idleAfterMs}` declares the host's optional idle hibernation
policy, which is off unless the host was started with `--hibernate-idle-minutes`. `close` on a
hibernated session forgets it and its saved description; `restoreSession` with its ID relaunches
it fresh (or exact) under a new ID and ends the hibernation; `forgetRecovery` with its ID ends the
hibernation without relaunching.

`attach {sessionId,cols,rows}` remains supported for the original client: it releases that connection's other control leases/subscriptions, acquires the requested session if free, and emits `attached`, `control`, then replay. Its lease accepts legacy input/resize without `leaseId`; supplying an incorrect lease is always rejected. A lease obtained through v2 `acquireControl` never accepts missing `leaseId`.

Output remains bounded transcript replay, not a full VT screen snapshot. Historical terminal queries are filtered after the first controller attachment. Multi-device observers share canonical dimensions but a late attachment to a full-screen program may need redraw. A canonical screen engine is a subsequent compatibility-tested change. Transport backpressure limits and slow-client disconnection remain in force.

## Rust client codec

The shared `nesvo-wire` crate exports `nesvo_wire::{encode_client,decode_host}` with the same arguments as `encode`/`decode`; those existing wrappers retain host direction. The host keeps `nesvo_host::wire` as a compatibility re-export, while the TUI depends directly on the shared crate. Use a fresh random client nonce for every connection and verify the echoed nonce before trusting events. `encode_client` starts at sequence 1 for auth; `decode_host` starts at sequence 1 for connected.

### Confirmed agent status evidence

Session status may include additive `evidence: "hook"` alongside `source: "screen"`. Updated clients can display this as confirmed lifecycle evidence; older clients continue to accept the status as inferred. The source enum sent to legacy clients is unchanged. See [agent session status](agent-session-status.md).

`sessionFreshness:true` in capabilities advertises an opt-in freshness record.
A client that sends `getCapabilities {sessionFreshness:true}` (older hosts ignore
the field) receives one fresh snapshot and, from then on, in `sessions` and
`session` replies, each session's
`status.freshness:{source,observedAt,ageMs,stale,boundMs,lastKnown}`;
`sessionFreshnessBounds` lists `{source,staleAfterMs,measuredFrom}`. Sources,
bounds, the disconnect policy and what clients show are defined once in
[agent session status](agent-session-status.md#freshness).

Program Status Protocol reports use `source:"screen"` with additive
`confirmedSource:"osc7501"` (not a new legacy source/evidence enum). A session may
also include `programStatus:{root,childCount,blockedChildren,blockedChildApps}`.
The root carries validated report fields; child text is excluded to keep snapshots
bounded. These observations confer no control privileges. Host-owned OSC 7501 and
primary DA1 queries are consumed from live output before backlog/subscriber
delivery. Clients never answer them, including on first-attachment replay.

Sessions may include additive `readiness:{phase,initialized,reason}`. Phases are
`notApplicable` (generic shell), `starting`, `waiting` (consent/question), `ready`,
`timedOut`, and `exited`. It is separate from `status`, process exit and task
success. A managed CLI needs semantic evidence before initialization is recorded.
Startup times out after 45 monotonic seconds without it; an explicit blocker can
wait indefinitely, and clearing consent starts a new window. Late readiness can
recover from timeout. Initialized does not authorize sending into a busy or
blocked session. Older clients ignore this field; updated clients show starting
and startup failure while preserving the legacy unknown agent state underneath.

`lifecycle` is optional additive metadata with separate `process`, `agent` and
`turn` projections. `agent.current` is null without semantic evidence or after
process exit; `lastKnown` is explicitly historical. Block reasons are permission,
question, auth, quota, setup or unknown. A turn has a launch/sequence ID,
generation, accepted/started/waiting/settled/interrupted/failed phase and observed
elapsed seconds. Settled means the response ended, not that a task succeeded.
UserPromptSubmit starts a turn; an old idle state does not. Hook samples are
observed at host receipt, so sub-poll durations can be zero. Process age remains
independent. Task association is currently null until the orchestration model.

The host briefly drains final lifecycle events after process exit. A pending
Stop can establish response settlement while the process remains exited; it
never revives the agent or supplies a task result. Cursor gaps interrupt pending
turn correlation until a new submitted prompt. Diagnostic turn history is bounded
to 16 entries and retained only while the host session exists; it is not durable
workflow history.

The `diagnostics {report}` reply to `getDiagnostics` adds `geminiIntegration` with `ready`,
`verifiedVersion`, `version`, `extension`, `extensionSource`, `turnIdentity` and `reason`. `ready`
is true only when the installed Gemini CLI is the verified version and the `nesvo-lifecycle`
extension is linked to this host's unmodified source. Otherwise `extension` is `notLinked`,
`linkedElsewhere`, `stale`, `sourceChanged`, `unreadable`, `homeUnavailable` or
`sourceUnavailable`, or `checking` before the first background read, and `reason` states the cause. The host re-reads the extension files off the state lock at most every 2 seconds. `turnIdentity` is always `unsupported`: Gemini
hooks carry no turn ID, so no host turn or settled response is derived. See
[agent session status](agent-session-status.md).

### Durable operation receipts

`operationReceipts:true` enables asynchronous `createOperation {key,spec}` and
`getOperation {id|key}`. Both return `type:"operation"` with a durable receipt;
lookup also returns the domain cursor from the same database snapshot. Accepted,
dispatching, created, failed and unknown phases do not imply agent readiness or
task success. Same caller/key/spec never creates another process; conflicting
specs are rejected. Unconfirmed effects are never retried automatically. Scoped
passive workers cannot create or inspect another issuer's receipt. See
[durable operations](harness-operations.md) for transactions, restart and limits.
