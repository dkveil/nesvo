# Host protocol v2

Implementation contract for the Rust host, mobile client and TUI. Wire pairing remains version 1: the existing authenticated secretbox envelope, fresh server challenge, client nonce, direction and sequence checks are unchanged. Application protocol version 2 is announced after authentication.

## Connection and snapshots

- `auth { clientNonce }` → `connected { clientNonce, clientId, protocolVersion: 2 }`; `clientId` is a JSON number, scoped to this connection.
- Then `sessions { sessions, groups, revision }`. `list` requests the same snapshot. Snapshots are broadcast when session metadata, groups or observed status changes.
- Session: existing `id,name,cwd,createdAt,cols,rows,running`, optional `uptimeSeconds` (non-negative integer, monotonic process age frozen at exit), plus `program: "shell" | "claude" | "gemini" | "codex"`, `groupId: string|null`, `controllerId: number|null`. Lease secrets are never in snapshots. Current hosts always supply `program`; clients can treat a missing value in an older snapshot as `shell`.
- Group: `{ id, parentId: string|null, name, order: number }`. Root is `null`, not a synthetic group.
- `revision` is the durable metadata revision. Group CRUD and session moves increment it; terminal output/control and session create/close do not.
- Optional `requestId` on any well-formed command is echoed on its application errors. It must be nonempty, have at most 128 UTF-8 bytes and contain no control characters. Malformed wire/protocol messages close the connection. Do not automatically retry input or destructive requests after reconnect.
- Errors: `{ type:"error", message, requestId? }`; stale revisions have `code:"revision_conflict"` and `revision` with the current value.

## Sessions and groups

| Command                                                                        | Result                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `getCapabilities { requestId? }`                                               | Targeted `capabilities { workspace, programs:[{id,label,available}], directoryBrowser:true, providerLimits?, requestId? }`. |
| `listDirectories { path?, requestId? }`                                        | Targeted `directories { path, parent, entries:[{name,path}], requestId? }`; entries are subdirectories only.                |
| `create { name, program?, cwd?, groupId?, requestId? }`                        | Targeted `created { sessionId, requestId? }`, then broadcast snapshot. No automatic subscription/control.                   |
| `renameSession { sessionId, name, requestId? }`                                | Targeted `updated { revision, requestId? }`, then snapshot; runtime name does not increment metadata revision.              |
| `close { sessionId, requestId? }`                                              | Terminates the session and broadcasts a snapshot.                                                                           |
| `createGroup { name, parentId, order?, expectedRevision, requestId? }`         | Targeted `groupCreated { groupId, revision, requestId? }`, then snapshot.                                                   |
| `updateGroup { groupId, name, parentId, order, expectedRevision, requestId? }` | Targeted `updated { revision, requestId? }`, then snapshot. Full replacement of editable fields.                            |
| `deleteGroup { groupId, expectedRevision, requestId? }`                        | Targeted `updated`, then snapshot. Only an empty group with no child groups can be deleted.                                 |
| `moveSession { sessionId, groupId, expectedRevision, requestId? }`             | Targeted `updated`, then snapshot.                                                                                          |

Group and parent IDs are strings or `null` for the root. `create` may omit `groupId`; `createGroup` may omit `order` to use zero. Names: trimmed, 1–80 Unicode characters, no control characters. Order: integer 0–1,000,000. Parents must exist; self-parenting and descendant cycles are rejected. Maximum 64 groups and 8 live/exited sessions in this iteration. SQLite stores groups/revision alongside the pairing files. Sessions and their group assignments live as long as the host process; database persistence does not preserve processes after restart.

`program` is one of `shell`, `claude`, `gemini`, or `codex`; omission selects `shell`. A missing or blank `cwd` uses the host's workspace. Relative paths resolve against that workspace; absolute paths can select any existing directory accessible to the host user. Paths are canonicalized before process creation. The workspace is a default, not a sandbox. An unavailable program or invalid directory returns an application error with the supplied `requestId`, without creating a session.

Capabilities contain all four program IDs. Discovery inspects PATH once at startup; requests only read the cache, and installation/PATH changes require a host restart. `available` means a supported launcher was found, not that subscription login is complete. The host starts the original CLI without injecting model API credentials or automating authentication. Native executables launch directly. Windows npm wrappers resolve through the known package's JavaScript bin entry and `node.exe`; unsupported custom wrappers are unavailable. No user-supplied command string or directory is interpolated into shell source.

`providerLimits` is an optional array containing only installed Claude, Gemini and Codex launchers. Each entry is `{ id, status:"checking"|"ready"|"unavailable", windows:[{usedPercent,durationMins,resetsAt}] }`; `resetsAt` is a Unix timestamp in seconds or `null`. `ready` means one or two current usage windows are available. Older hosts may omit the field. On startup and every two minutes, the host uses Codex's local, read-only app-server `account/rateLimits/read` request to update Codex's cached windows. It broadcasts a fresh `capabilities` event when that cache changes, without a `requestId`. The mobile and TUI clients accept these updates. A failure clears stale values and shows `unavailable`. Claude and Gemini currently expose subscription quota in interactive CLI commands, not a supported structured read interface, so their installed entries remain `unavailable`; clients should point users to `/usage` and `/stats model` respectively rather than invent percentages. The host never reads credential files, sends credentials to clients or uses model APIs for this panel.

The directory browser starts at the host workspace if `path` is omitted. Each response has the canonical absolute `path`, its optional `parent`, and up to 512 sorted child directories. The TUI sends a new request when the user opens a child or parent and applies only the matching `requestId`. Older hosts omit `directoryBrowser`; the TUI keeps the launch form open and asks for a host update instead of sending an unsupported command. Newly launched PTYs receive `NESVO_SESSION=1`; interactive TUI startup refuses to run inside one of those sessions, while `--list` remains available for scripts.

## Observed session status

Session snapshots also include `status: { state, source, updatedAt }`. Older hosts may omit it; a client must not manufacture semantic agent state from `running` alone. `updatedAt` is the host's epoch-millisecond timestamp of the last state/source transition, not the last output byte. Status never increments the durable metadata revision.

| Source     | States                                   | Meaning                                                                                                                                 |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `activity` | `working`, `idle`, `unknown`             | Recent input/output, quiet shell, or unrecognized CLI state. This is I/O observation, not proof that an agent is thinking or waiting.   |
| `screen`   | `working`, `idle`, `blocked`, `question` | Conservative inference from a recognized program's current visible terminal screen. It can be wrong and must never authorize an action. |
| `process`  | `done`, `failed`, `unknown`              | The child exited with code zero/nonzero, or its exit status could not be read. Late output cannot revive its state.                     |

The host samples status every 250 ms and broadcasts one snapshot only when a state/source changes. A shell becomes `idle` after 1.5 seconds without input/output; an unrecognized CLI becomes `unknown`. Quiet output never implies completion or a permission request. Explicit `close` removes a session, while a naturally exited process remains visible until closed. Detection uses the program selected at creation: launching an AI CLI later from a generic shell does not enable provider-specific screen rules.

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

`attach {sessionId,cols,rows}` remains supported for the original client: it releases that connection's other control leases/subscriptions, acquires the requested session if free, and emits `attached`, `control`, then replay. Its lease accepts legacy input/resize without `leaseId`; supplying an incorrect lease is always rejected. A lease obtained through v2 `acquireControl` never accepts missing `leaseId`.

Output remains bounded transcript replay, not a full VT screen snapshot. Historical terminal queries are filtered after the first controller attachment. Multi-device observers share canonical dimensions but a late attachment to a full-screen program may need redraw. A canonical screen engine is a subsequent compatibility-tested change. Transport backpressure limits and slow-client disconnection remain in force.

## Rust client codec

The shared `nesvo-wire` crate exports `nesvo_wire::{encode_client,decode_host}` with the same arguments as `encode`/`decode`; those existing wrappers retain host direction. The host keeps `nesvo_host::wire` as a compatibility re-export, while the TUI depends directly on the shared crate. Use a fresh random client nonce for every connection and verify the echoed nonce before trusting events. `encode_client` starts at sequence 1 for auth; `decode_host` starts at sequence 1 for connected.

### Confirmed agent status evidence

Session status may include additive `evidence: "hook"` alongside `source: "screen"`. Updated clients can display this as confirmed lifecycle evidence; older clients continue to accept the status as inferred. The source enum sent to legacy clients is unchanged. See [agent session status](agent-session-status.md).
