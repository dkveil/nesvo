# Remote hosts and workers design

**Status: design, not implemented.** No host advertises, accepts or tests anything
described here. Capability names such as `peerGrants`, `remoteAttempts` and
`workerOutbox`, the `peer` role and the `nesvo peer` commands are proposals.
Statements about current behavior cite existing contracts; statements marked
**Assumption** need owner confirmation or an experiment.

The owner's standing decision governs this document: **one host with local
workers first, a shared contract ready for remote, and no federation before local
reliability is solved.** This design therefore defines how the existing contract
extends across machines and which local gates must pass before any stage starts.
It does not schedule that work. No row of the [harness delivery table](harness-delivery.md)
covers remote hosts; the rows it depends on are listed under prerequisites.

Reachability between machines is a separate concern. The [relay design](relay-design.md)
covers a client reaching a host behind NAT; the same relay can carry the
connections described here, because they are ordinary authenticated host
connections.

## Terms

- **Host:** one `nesvo-host` process owning one data directory, as
  [directory ownership](host-directory-ownership.md) enforces with `host.lock`.
  Its `hostId` is the public identifier already sent in `capabilities`.
- **Coordinating host:** the host whose journal owns a run, its task DAG, inbox,
  decisions, constraints, checkpoints and run budget.
- **Executing host:** a host that runs native processes for attempts owned by a
  coordinating host. Today every run is local, so both roles are the same host.
- **Remote attempt:** an attempt on the coordinating host whose worker process
  lives on an executing host. It is a binding, not a process.
- **Federation:** several hosts sharing authority over one run or failing over a
  coordinator between them. Federation is a non-goal.

## Goals

- **Multi-host clients.** The TUI and mobile app hold several pairings and show
  each host's sessions side by side. The [terminal client](terminal-client.md)
  already plans this: "Support for multiple computers will use session IDs scoped
  by host ID; synchronization does not mean migrating a process between computers."
- **Remote workers.** A coordinating host launches a worker on another machine,
  delivers task instructions to it and receives its explicit result, with the
  same receipts, fences and non-replay rules as a local worker.
- **One direction of authority.** The coordinating host initiates every
  host-to-host connection. An executing host holds no credential for the
  coordinating host, and no worker process ever holds a cross-machine credential.
- **Local authority wins.** The executing host validates every request against its
  own policy, budgets, workspace and human control, exactly as it does for a
  local coordinator today ("Host policy always wins", [MCP adapter](harness-mcp.md)).

## Non-goals

- Process migration, terminal adoption across hosts or moving a session's PTY.
- A shared or replicated SQLite database; each host keeps its own journal.
- Coordinator failover between hosts, or two hosts coordinating one run.
- Mounting or synchronizing filesystems; files never move implicitly.
- Sharing provider logins, subscription credentials or quota readings.
- An OS sandbox. Capabilities remain API authorization, not isolation
  ([harness CLI](harness-cli.md)).

## Identity and authority

| Principal                  | Holds                                                   | May act on                                                                              |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Owner                      | An owner pairing per host (shared key today)            | Everything on that host, directly                                                       |
| Coordinator process        | Its launch-local scoped capability on its own host      | Its own host only; remote children through its host, never directly                     |
| Coordinating host          | A peer grant issued by the owner on each executing host | Sessions it created through that grant, within the grant's workspace, group and budget  |
| Worker process (remote)    | A worker capability issued by its executing host        | Its own session and its mirrored attempt on that host; nothing on the coordinating host |
| Human at an executing host | Owner pairing of that host                              | Direct input, takeover and stop; always takes priority over automation                  |

### Peer grants

The owner pairing grants full shell access as the host's OS user
([host README](../apps/host/README.md)), so it must never be copied to another
host. Instead, the owner creates a **peer grant** on the executing host, proposed
as `nesvo peer grant --workspace PATH --group GROUP --max-sessions N --key KEY`.
The grant is a new scoped authority, shaped like the existing coordinator
capability:

- It authenticates with an independent key selected by the existing
  `x-nesvo-scope` handshake header, followed by the unchanged challenge, nonce and
  sequence proof. An unknown or revoked grant is rejected, never downgraded.
- Proposed permissions: `peer:create`, and `peer:read/send/interrupt/stop` for
  sessions created through that grant only. This mirrors the coordinator's
  `child:create/read/send/interrupt/stop` for its own children.
- The executing host binds each created session to the grant's canonical
  workspace and group, rejects workspace escapes and refuses the `coordinator`
  role. A remote coordinator would be federation.
- Forbidden, as for scoped callers today: `acquireControl`, `input` and `resize`
  leases, owner diagnostics, `files`, `git`, `reviews`, `notes`, `projects`,
  `worktrees` setup approval, budgets, quota observations, push registration and
  every other owner-only command.
- Revocation is an owner action on the executing host (proposed
  `nesvo peer revoke`). Existing peer connections then receive `scope_revoked`,
  as process-scoped connections do today. Running workers are not stopped.

Unlike a process capability, a peer grant does not expire at process exit; it
lives until revoked or until its optional expiry. **Assumption:** a durable,
owner-created, revocable grant is acceptable; the alternative is an owner online
for every remote launch.

### Coordinator processes and remote children

A coordinator agent keeps using its local scoped CLI and MCP tools. When its run
targets an executing host, the coordinating host performs the remote request
through its peer grant and records the child as `hostId:sessionId`. The
coordinator's grant list gains those qualified IDs; a bare session ID never
resolves to another host. Lineage (`parentSessionId`) stays a same-host concept;
cross-host lineage is a reference on the remote attempt, not a snapshot field.

## What crosses machine boundaries

Commands go down from the coordinating host; facts come up through cursors.

**Commands sent by the coordinating host through a peer grant** (all existing
command shapes, unchanged on the wire):

- `createOperation {key,spec}` and `getOperation {id|key}` for worker launch. The
  key is namespaced by the peer grant, so the existing same-key/same-spec rule
  prevents duplicate processes across reconnects and coordinating-host restarts.
- `getSession`, `readSession` and `subscribeEvents`/`readEvents` filtered to the
  grant's sessions.
- Task instruction delivery and stop/interrupt for the grant's sessions, using
  the executing host's existing human-priority and draft fences.
- A remote attempt envelope (proposed `remoteAttempts`): attempt ID, task ID,
  coordinator generation, instruction text and recovery-context digest, stored on
  the executing host so the worker's `nesvo_get_current_task` and
  `nesvo_recover_run_context` resolve locally.

**Facts read back by the coordinating host:**

- Existing domain events for the grant's sessions: `session.created`,
  `session.closed`, `process.exited`, `agent.lifecycle`, `response.settled` and
  `operation.changed` (`operationId`, `operation`, `phase`), plus `host.started`
  to detect an executing-host restart. The executing host's own `run.*` events
  never apply: its mirrored attempt envelope is not a run.
- Worktree journal events `worktreePrepared`, `worktreeRan` and `worktreeArchived`.
- A bounded **worker outbox** (proposed `workerOutbox`): the worker's calls to
  `nesvo_report_task_result`, `nesvo_send_message` and `nesvo_ask_decision` are
  recorded on the executing host as durable, attempt-scoped outbox entries. The
  coordinating host reads them by cursor, applies them through its own
  transaction and validation, then acknowledges each by exact ID and revision,
  like inbox ACK. The executing host never pushes into the coordinating host.

**Never crosses a machine boundary:**

- Owner pairing keys, scope keys, `NESVO_AGENT_CONTEXT` files and peer grant keys
  beyond the one holder.
- Control leases and `leaseId`; direct terminal `input` and `resize`. The
  coordinating host never acquires control on another host.
- Native tool permission additions (`allowedNesvoTools`, `harness.nativePermissions`):
  they are chosen by the executing host's owner policy.
- Provider credentials, `accountFingerprint` values and quota observations.
- Push tokens and attention inbox acknowledgements; each host notifies its own
  registered phones.
- Absolute host paths as instructions to resolve elsewhere. A path is meaningful
  only on the host that reported it.

## Journal and recovery

Each fact has exactly one authoritative journal:

| Fact                                                                 | Authoritative on  |
| -------------------------------------------------------------------- | ----------------- |
| Process, PTY, native receipts, control, worktree registry, setup log | Executing host    |
| Remote attempt envelope and worker outbox entries                    | Executing host    |
| Run, task DAG, attempts, inbox, decisions, constraints, checkpoints  | Coordinating host |
| Run budget, drain latch, executor and wake generations               | Coordinating host |
| Per-peer consumed cursor and outbox ACKs                             | Coordinating host |

- The coordinating host stores each peer's `nextCursor` in the same transaction
  as the facts it derives from that page, so a crash cannot apply a page twice or
  lose one. Delivery stays at least once; consumers deduplicate by
  `(hostId, sequence)`.
- A retention gap (`gap:true`, 4096-event retention per
  [durable events](harness-events.md)) never becomes complete history. The
  coordinating host reconciles each affected remote attempt by `getOperation` and
  `getSession`; anything it cannot prove becomes unknown, exactly like
  `launchUnknown` locally.
- An executing-host restart (`host.started` with a new process lifetime) ends its
  processes; persisted metadata does not resurrect them. Remote attempts bound to
  them become unknown until the owner reconciles. They are never relaunched or
  replayed automatically.
- A coordinating-host restart keeps today's behavior: executor and wake policies
  pause, queued input pauses, nothing is replayed. Peer reads resume from the
  stored cursors; remote workers keep running meanwhile.
- `nesvo run bind-coordinator` stays local: it may rebind a run to a new
  coordinator on the same coordinating host. It never moves a run to another
  host. Its `workerAuthorityRestored:false` rule applies to remote children too.

## Worktrees, files and notes

- **Worktrees** live on the executing host. Setup approval
  (`describeWorktreeSetup`, `approveWorktreeSetup`, `revokeWorktreeSetup`) is
  owner-only per host and per repository digest; a peer grant cannot approve its
  own setup, just as scoped callers receive `forbidden` today. A launch with
  `worktree:true` holds the spawn until that host's approved setup passes.
- **Ownership.** The executing host's worktree registry is authoritative;
  `archiveWorktree` runs there. The coordinating host stores only the reported
  worktree and branch names as attempt evidence.
- **Source exchange** between machines uses Git under the owner's control: the
  worker's branch is pushed to a remote the owner configured on the executing
  host, and review uses `openReview {source:{kind:"pull",url}}` or a direct owner
  connection to the executing host. **Assumption:** no host-to-host file transfer
  is needed; if it is, it becomes its own bounded, owner-approved command.
- **Files sidebar and diffs** (`listEntries`, `readFile`, `findFiles`, `getDiff`)
  stay owner reads against the host that owns the path. Clients connect to that
  host directly (or through the relay); the coordinating host does not proxy them.
- **Projects.** The `projects` registry is keyed by an absolute repository `root`
  on one host. A multi-host client keys project state by `(hostId, root)`; equal
  paths on two machines are different projects. `nesvo.toml` workflow templates
  (`workflowTemplates`) start runs only on the host that read that file.
- **Notes files.** `notes:true` notes are owner-only markdown files read and
  written by `listNotes`, `readNote`, `writeNote` and `deleteNote`; scoped callers
  receive `forbidden`, and so would a peer grant. Repository notes live in
  `<toplevel>/.nesvo/notes` and travel between machines only through Git, if the
  owner commits them. Host notes live in `<config>/nesvo/notes/<hostId>` and are
  never merged across hosts. A `writeNote` `expectedRevision` is a per-file
  content-hash check on one host, not a cross-host lock.
- **Run notes.** Inbox messages of kind `note|question|error`, checkpoint notes and
  decision notes are run records and live on the coordinating host. A remote
  worker's note enters through its outbox; message text remains untrusted context
  that grants no authority ([inbox](harness-inbox.md)).

## Quota and budgets

- **Host budgets** (`hostBudgets`) remain per host and are enforced by the
  executing host at admission. A peer grant adds its own `maxSessions`, which can
  only narrow, never widen, the executing host's policy.
- **Run budgets** (`runBudgets`) count remote attempts on the coordinating host
  exactly like local attempts: assigned, reported, launching and unknown attempts
  occupy parallel capacity. Deadlines use the coordinating host's monotonic
  clock; enforcement on the remote worker is a stop request through the grant,
  and acceptance is not exit ([run controls](harness-run-controls.md)).
- **Provider quota** stays per host. Every native spawn, including
  `createOperation`, passes the executing host's host-wide quota gate with an
  `allow`, `hold` or `unknown` verdict ([quota jobs](harness-quota-jobs.md)). A
  held `createOperation` keeps its claimed receipt in that host's hold queue, so
  the coordinating host sees a non-final receipt phase, not a failure; an
  `unknown` verdict starts the worker and marks it `quotaUnverified`. The
  coordinating host never infers that two hosts share or do not share a
  subscription. **Assumption:** the same login on two machines may draw from one
  quota; treating them as independent can over-admit, which the executing host's
  own typed refusals then report.
- Typed admission refusals from the executing host are no-effect results for the
  remote attempt, eligible for the existing proven no-effect retry rules only.

## Failure and partition behavior

| Situation                                         | Behavior                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Link lost between coordinating and executing host | Remote processes keep running. Queued delivery and new launches pause. Attempts show a derived `unreachable` state, never a result. |
| Link restored                                     | Resume from stored cursors; reconcile on gap; outbox entries apply once by exact ID.                                                |
| Executing host restarted                          | Detected by `host.started`; bound attempts become unknown; no relaunch.                                                             |
| Coordinating host down for long                   | Workers finish and write outbox entries; retention bounds apply. Entries past retention are reported as a gap on return.            |
| Human takes over a remote worker                  | Executing host fences automated sends as today; the coordinating host sees control events and cannot override.                      |
| Launch response lost                              | Repeat `createOperation` with the original key or call `getOperation`; never a new key.                                             |
| Peer grant revoked                                | `scope_revoked`; remote attempts become unknown; processes keep running for the owner of that host to handle.                       |
| Clocks disagree                                   | Wall-clock times are diagnostic only; each host uses its own monotonic clock for deadlines and freshness.                           |

No partition path replays input, re-sends a destructive command or turns a
missing report into success. Idle never means success, as for local runs.

## Prerequisites that must hold locally first

Each item names an existing gate. Remote work starts only when all hold on the
latest CI baseline (the delivery table cites CI run 39539351364 at commit 0547eeb).

1. **Native nightly cohort.** The `Native nightly` workflow ([testing](testing.md))
   passes its ignored native scenarios, including job timeouts, run controls,
   coordinator recovery and repository context, on consecutive runs without
   manual reruns. **Assumption:** the owner sets the required streak length.
2. **Recovery evidence.** F14 (durable run DAG) is verified beyond metadata-only
   tasks; F41 (layout, conversation and workflow recovery) and F40 checkpoints meet
   the gates the [coordinator recovery contract](harness-coordinator-recovery.md)
   lists: "conversation-resume, adoption, reconciliation and UI/mobile acceptance".
3. **Unknown-effect reconciliation.** F20's pending unknown-process adoption and
   F28's uncertain-effect cleanup have an owner reconciliation path locally; a
   partition produces more unknown attempts than any local failure.
4. **Receipts and results.** F17 receipts and F18 attempt-bound results are
   proven on more than one provider, not only on one provider's hooks and fixtures.
5. **Event streaming.** F16's MCP event resources (`nesvo://events`, native
   `mcp_events.rs`) run in CI and live-provider streams are verified, since remote
   attempts depend on cursor consumption.
6. **Worktree ownership.** F13 gains its fan-out task ownership view; F36 gains a
   native scenario and a non-CLI approval path, and the Unix step process that
   leaves its process group no longer escapes.
7. **Quota-aware dispatch.** F44's host gate has fresh admission sources for every
   installed provider (Gemini is unknown today) and an original-provider run.
8. **Scoped identity.** F12 provider matrix and UI are complete, because the peer
   grant extends that model.
9. **Single-writer data directories.** The `host.lock` rule from
   [directory ownership](host-directory-ownership.md) holds on every machine;
   a peer grant never targets a data directory owned by an older binary.

## Staged rollout

Each stage is capability-gated and leaves single-host behavior unchanged.

| Stage | Scope                                                                                      | Exit evidence                                                                                  |
| ----- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| M0    | Local prerequisites above                                                                  | Delivery rows and nightly streak                                                               |
| M1    | Multi-host clients: several pairings, `hostId`-scoped session IDs, no host-to-host traffic | TUI and mobile tests with two loopback hosts; physical device check recorded separately        |
| M2    | Read-only peer grants: a coordinating host observes another host's sessions and events     | Cursor persistence, gap reconciliation and revocation tests across two real hosts              |
| M3    | Remote launch for metadata-only tasks with controlled provider fixtures                    | Native scenario in the nightly cohort: lost response, restart and partition without duplicates |
| M4    | Worker outbox, task delivery and worktree-mode remote attempts                             | Outbox exactly-once application, human takeover fences, owner-approved setup on the remote     |
| M5    | Opt-in executor selection of remote targets                                                | Budget and quota refusals across hosts; restart pauses scheduling without adoption             |

Federation (shared run authority, cross-host coordinator failover) is outside
every stage and needs a separate owner decision after M5.

## Open questions for the owner

1. Is a durable, revocable peer grant acceptable, or must every remote launch be
   approved by an owner who is online at that moment?
2. Which nightly streak length and which delivery rows count as "local reliability
   is solved" for starting M2?
3. Should a remote worker's branch exchange always go through a Git remote, or is
   a bounded host-to-host patch transfer wanted later?
4. How should the coordinating host treat two machines signed in to the same
   provider account: independent, or owner-declared as one quota pool?
5. Should the mobile app aggregate attention across hosts (M1), or keep one host
   at a time until device testing of the current app is complete?
6. Should peer connections between hosts be allowed through the relay before the
   relay has per-device keys and forward secrecy?
