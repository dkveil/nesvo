# Durable domain events

The host owns a bounded SQLite journal in its existing private metadata database.
This is distinct from both terminal replay byte cursors and the provider's
launch-scoped hook sequence. Domain sequence order does not depend on UTC time.
Database work runs in one bounded worker outside the host state mutex. WAL and
FULL synchronous commits are configured for that connection; no render path
performs I/O.

## Reading and subscriptions

Hosts advertising `domainEvents:true` accept these authenticated commands:

- `readEvents {after,limit?,sessionId?,requestId?}` reads one bounded page.
- `subscribeEvents {after,limit?,sessionId?,requestId?}` starts a resumable stream.
  A connection has at most one stream; replacing it aborts the old stream.
- `unsubscribeEvents {requestId?}` stops that connection's stream and returns
  `eventsUnsubscribed`.

All pages have type `events`, the request ID, `events`, `nextCursor`, `headCursor`,
`floorCursor`, `gap`, `more`, `subscribed` and `health`. Each event contains a
monotonic `sequence`, nullable `sessionId`, `kind`, host observation time `at`,
and a bounded metadata object `payload`. Current kinds include `host.started`,
`session.created`, `session.closed`, `process.exited`, `agent.lifecycle` and
`response.settled`. A response event references its turn and has no task outcome.
Durable receipts add `operation.changed` (`operationId`, `operation`, `phase`) and
workflow mutations add `run.*` events (`runId`, `revision`) whose subject is the
run's coordinator session. `run.digest_recorded` also carries the run state,
digest fingerprint and byte size; read the digest itself with `nesvo run digest`.
Worktree trust and lifecycle add `worktree.*` events and workflow template trust adds
`workflow.templates_*` events. Prompts, response text and tool arguments are not
journaled here. Every kind and its payload fields are listed in
[Event kinds](#event-kinds). New kinds join the stream without a capability change:
consumers ignore kinds they do not recognize instead of failing the page.

The default/maximum page is 32 events, each with at most 1024 encoded payload
bytes. Output fits the authenticated frame budget. A future cursor or a limit
outside 1–32 is rejected. Sequence and timestamps are JSON-safe integers. Pages
are read under one database snapshot. `more:true` means another bounded page is
available; otherwise `nextCursor` advances to the current journal head, including
when a subject filter has no matches.

Keep the last received `nextCursor` and pass it after reconnect. Delivery is
at least once; consumers deduplicate by domain sequence. Subscribe registers its
change observer before reading: a completion between snapshot and waiting cannot
be lost. Quiet streams wait on change notification rather than polling. Client
disconnect, explicit unsubscribe and replacement release the subscription.

## Retention, authority and health

Retention is 4096 events. `floorCursor` is the last expired sequence. A request
older than that returns `gap:true` with retained data; a subscription stops after
that page. Reconcile authoritative session/workflow state before resuming from
the reported head. A gap never silently becomes a complete history.

Owner pairing can read all subjects, including exited sessions after host restart.
A process capability defaults to its own subject and cannot select a foreign
subject. Expired process authority stops a stream with `scope_revoked`. Filtering
is performed before pages leave the host. Scope/parent hints never grant access.

The worker queue has 128 bounded requests; a connection permits at most four
concurrent journal operations. Full outgoing client queues use the existing
disconnect/backpressure behavior. Informational provider/session observations
fail open and increment `health.observationDrops` or `health.writeFailures` on
failure; these counters are also in doctor and trigger stream notification.
They describe the current host lifetime. Such loss requires reconciliation and
must not be mistaken for a complete audit or task result.

Critical workflow results use the worker's acknowledged transactional append path
and are not confirmed until persisted. Receipt/task integration of that path is
part of F17/F18; informational lifecycle Stop alone never proves task success.
Orderly shutdown drains pending journal work. SQLite or protocol failures do not
execute a model prompt or replay terminal input.

## CLI

```powershell
nesvo --pairing C:\private\pairing.json events --after 0 --json
nesvo --pairing C:\private\pairing.json events --session SESSION_ID --after CURSOR --json
nesvo --pairing C:\private\pairing.json events --after CURSOR --watch --json
```

Watch emits one versioned JSON object per line and stops on Ctrl+C. An expired
watch cursor prints its gap page followed by `cursor_expired` and exits nonzero.
Without `--watch`, the single page's `gap` is available for explicit reconciliation.
Inside a managed process, the same CLI uses its private context automatically.
The output schema is shared with the other CLI queries.

## MCP

`nesvo mcp` exposes the same pages as `nesvo://events` resources and forwards a
dedicated `subscribeEvents` stream per subscribed URI as
`notifications/resources/updated` with the delta's `after`, `nextCursor` and
`readUri` in `_meta["nesvo/events"]`. Subject authority, bounds, gaps and
at-least-once delivery are unchanged. See the
[MCP event resources](harness-mcp.md#event-resources-and-subscriptions).

## Event kinds

Version 1 evolves additively. A release can add a kind or add a payload field; it never
removes or renames a kind or field, changes a field's type or meaning, or makes a new field
required for an existing kind. Readers skip records whose kind they do not know and ignore
payload fields they do not use, so an older client keeps working against a newer host. The
committed schema is closed (`additionalProperties: false`) so that it describes exactly what
the current host writes; it is a drift check for the host, not a rule for readers to reject
newer records. A change outside these additive rules bumps the schema `$id` from
`urn:nesvo:harness-events:v1` to `urn:nesvo:harness-events:v2`.

<!-- generated:event-kinds:start -->

This table is generated from `nesvo_wire::events::Event`, which the host uses for every
append, together with [harness-events.schema.json](harness-events.schema.json). Regenerate
both with `NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo-wire --test event_contracts`;
CI fails when either drifts. Each record carries `sequence`, `sessionId`, `kind`, `at` and
`payload`. A kind marked `no` fails the journal kind rule (lowercase letters, `.` and `_`) and
is never persisted.

| Kind                           | Payload fields                                                                                                                           | Journaled |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `host.started`                 | `buildId` string                                                                                                                         | yes       |
| `host.budget_changed`          | `revision` integer                                                                                                                       | yes       |
| `provider.quota_changed`       | `revision` integer                                                                                                                       | yes       |
| `session.created`              | `program` Program; `parentSessionId` string or null, optional                                                                            | yes       |
| `session.closed`               | none                                                                                                                                     | yes       |
| `process.exited`               | `exitCode` integer or null                                                                                                               | yes       |
| `response.settled`             | `turnId` string; `taskResult` null                                                                                                       | yes       |
| `agent.lifecycle`              | `event` string; `state` AgentState; `generation` integer; `sourceSequence` integer; `submissionEvidence` boolean                         | yes       |
| `agent.attention`              | `priority` integer; `reason` string or null; `blockedChildren` integer; `processExited` boolean; `exitCode` integer or null              | yes       |
| `operation.changed`            | `operationId` string; `operation` string; `phase` string                                                                                 | yes       |
| `job.changed`                  | `jobId` string; `occurrenceId` string or null; `phase` string                                                                            | yes       |
| `precheck.approval.changed`    | `approvalId` string; `phase` string                                                                                                      | yes       |
| `job.trigger_changed`          | `triggerId` string; `phase` string                                                                                                       | yes       |
| `job.trigger_delivery`         | `triggerId` string; `deliveryId` string; `disposition` string                                                                            | yes       |
| `run.created`                  | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.plan_changed`             | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.activated`                | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.attempt_assigned`         | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.result_reported`          | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.result_validated`         | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.draining`                 | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.resumed`                  | `runId` string; `revision` integer                                                                                                       | yes       |
| `run.checkpoint_saved`         | `runId` string; `checkpointId` string; `sourceRunRevision` integer                                                                       | yes       |
| `run.constraints_added`        | `runId` string; `constraintRevision` integer                                                                                             | yes       |
| `run.constraints_acknowledged` | `runId` string; `constraintRevision` integer                                                                                             | yes       |
| `run.control_requested`        | `runId` string; `controlId` string                                                                                                       | yes       |
| `run.control_progress`         | `runId` string; `controlId` string                                                                                                       | yes       |
| `run.control_completed`        | `runId` string; `controlId` string                                                                                                       | yes       |
| `run.control_unconfirmed`      | `runId` string; `controlId` string                                                                                                       | yes       |
| `run.coordinator_rebound`      | `runId` string; `previousSessionId` string or null; `sessionId` string; `generation` integer                                             | yes       |
| `run.decision_asked`           | `runId` string; `decisionId` string; `state` string                                                                                      | yes       |
| `run.decision_answered`        | `runId` string; `decisionId` string; `state` string                                                                                      | yes       |
| `run.decision_canceled`        | `runId` string; `decisionId` string; `state` string                                                                                      | yes       |
| `run.decisions_expired`        | `runId` string; `count` integer                                                                                                          | yes       |
| `run.delivery_changed`         | `runId` string; `deliveryId` string                                                                                                      | yes       |
| `run.digest_recorded`          | `runId` string; `revision` integer; `state` string; `fingerprint` string; `bytes` integer                                                | yes       |
| `run.executor_changed`         | `runId` string; `executorId` string                                                                                                      | yes       |
| `run.message_sent`             | `runId` string; `messageId` string                                                                                                       | yes       |
| `run.messages_acknowledged`    | `runId` string; `count` integer                                                                                                          | yes       |
| `run.launch_reserved`          | `runId` string; `attemptId` string                                                                                                       | yes       |
| `run.launch_recovered`         | `runId` string; `attemptId` string                                                                                                       | yes       |
| `run.launch_observed`          | `runId` string; `attemptId` string                                                                                                       | yes       |
| `run.workspace_prepared`       | `runId` string; `attemptId` string                                                                                                       | yes       |
| `run.quota_hold_changed`       | `runId` string; `attemptId` string                                                                                                       | yes       |
| `run.session_reused`           | `runId` string; `taskId` string; `attemptId` string; `previousAttemptId` string; `sessionId` string                                      | yes       |
| `run.time_budget_exhausted`    | `runId` string                                                                                                                           | yes       |
| `run.budget_changed`           | `runId` string                                                                                                                           | yes       |
| `run.wake_changed`             | `runId` string; `policyId` string                                                                                                        | yes       |
| `workflow.templates_approved`  | `repository` string; `digest` string                                                                                                     | yes       |
| `workflow.templates_revoked`   | `repository` string; `digest` string                                                                                                     | yes       |
| `worktree.setup_approved`      | `repository` string; `digest` string                                                                                                     | yes       |
| `worktree.setup_revoked`       | `repository` string; `digest` string                                                                                                     | yes       |
| `worktree.prepared`            | `sessionId` string; `result` string; `log` string; `worktree` string; `digest` string                                                    | yes       |
| `worktree.ran`                 | `sessionId` string; `result` string; `log` string                                                                                        | yes       |
| `worktree.archived`            | `sessionId` string; `worktree` string; `branch` string or null; `discarded` boolean; `blockers` array of string; `branchDeleted` boolean | yes       |
| `mcp.pool_attached`            | `entryId` string; `server` string; `program` Program; `digest` string; `root` string                                                     | yes       |
| `mcp.pool_released`            | `entryId` string; `server` string; `reason` string                                                                                       | yes       |
| `mcp.pool_reaped`              | `entryId` string; `server` string; `digest` string; `reason` string                                                                      | yes       |

Enumerated payload types:

- `AgentState`: `working`, `idle`, `done`, `blocked`, `question`, `failed`, `unknown`.
- `Program`: `shell`, `claude`, `gemini`, `codex`.

<!-- generated:event-kinds:end -->
