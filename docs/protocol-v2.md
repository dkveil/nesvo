# Host protocol v2

Implementation contract for the Rust host, mobile client and TUI. Wire pairing remains version 1: the existing authenticated secretbox envelope, fresh server challenge, client nonce, direction and sequence checks are unchanged. Application protocol version 2 is announced after authentication.

## Connection and snapshots

- `auth { clientNonce }` → `connected { clientNonce, clientId, protocolVersion: 2 }`; `clientId` is a JSON number, scoped to this connection.
- Then `sessions { sessions, groups, revision }`. `list` requests the same snapshot. Snapshots are broadcast when session metadata or groups change.
- Session: existing `id,name,cwd,createdAt,cols,rows,running`, plus `groupId: string|null`, `controllerId: number|null`. Lease secrets are never in snapshots.
- Group: `{ id, parentId: string|null, name, order: number }`. Root is `null`, not a synthetic group.
- `revision` is the durable metadata revision. Group CRUD and session moves increment it; terminal output/control and session create/close do not.
- Optional `requestId` on any well-formed command is echoed on its application errors. It must be nonempty, have at most 128 UTF-8 bytes and contain no control characters. Malformed wire/protocol messages close the connection. Do not automatically retry input or destructive requests after reconnect.
- Errors: `{ type:"error", message, requestId? }`; stale revisions have `code:"revision_conflict"` and `revision` with the current value.

## Sessions and groups

| Command                                                 | Result                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `create { name, cwd?, groupId?:string                   | null, requestId? }`                                                                                            | Targeted `created { sessionId, requestId? }`, then broadcast snapshot. No automatic subscription/control. |
| `renameSession { sessionId, name, requestId? }`         | Targeted `updated { revision, requestId? }`, then snapshot; runtime name does not increment metadata revision. |
| `close { sessionId, requestId? }`                       | Terminates the session and broadcasts a snapshot.                                                              |
| `createGroup { name, parentId:string                    | null, order?:number, expectedRevision, requestId? }`                                                           | Targeted `groupCreated { groupId, revision, requestId? }`, then snapshot.                                 |
| `updateGroup { groupId, name, parentId:string           | null, order:number, expectedRevision, requestId? }`                                                            | Targeted `updated { revision, requestId? }`, then snapshot. Full replacement of editable fields.          |
| `deleteGroup { groupId, expectedRevision, requestId? }` | Targeted `updated`, then snapshot. Only an empty group with no child groups can be deleted.                    |
| `moveSession { sessionId, groupId:string                | null, expectedRevision, requestId? }`                                                                          | Targeted `updated`, then snapshot.                                                                        |

Names: trimmed, 1–80 Unicode characters, no control characters. Order: integer 0–1,000,000. Parents must exist; self-parenting and descendant cycles are rejected. Maximum 64 groups and 8 live/exited sessions in this iteration. SQLite stores groups/revision alongside the pairing files. Sessions and their group assignments live as long as the host process; database persistence does not preserve processes after restart.

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

`attach {sessionId,cols,rows}` remains supported for the original client: it releases that connection's other control leases/subscriptions, acquires the requested session if free, and emits `attached`, `control`, then replay. Its lease accepts legacy input/resize without `leaseId`; supplying an incorrect lease is always rejected. A lease obtained through v2 `acquireControl` never accepts missing `leaseId`.

Output remains bounded transcript replay, not a full VT screen snapshot. Historical terminal queries are filtered after the first controller attachment. Multi-device observers share canonical dimensions but a late attachment to a full-screen program may need redraw. A canonical screen engine is a subsequent compatibility-tested change. Transport backpressure limits and slow-client disconnection remain in force.

## Rust client codec

The host library exports `nesvo_host::wire::{encode_client,decode_host}` with the same arguments as the existing `encode`/`decode`; existing wrappers retain host direction. Use a fresh random client nonce for every connection and verify the echoed nonce before trusting events. `encode_client` starts at sequence 1 for auth; `decode_host` starts at sequence 1 for connected.
