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
Prompts, response text and tool arguments are not journaled here.

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
