# Guarded task instruction delivery

`runDelivery:true` adds an explicit host-owned instruction intent after
[atomic task launch](harness-task-launch.md) or manual assignment. It delivers the
current task's immutable plan instruction to its bound **agent** worker. It never
treats instructions as shell commands, creates a process, selects by UI focus or
accepts replacement text from the caller.

When [owner constraints](harness-checkpoints.md) exist, a fresh delivery prepends
their acknowledged current text. The combined prompt retains the native 8192-byte
bound; no constraint is silently omitted. Adding a constraint pauses unclaimed
intents and fences already reserved input before both paste and Enter. Reading
or acknowledging context never rearms an old delivery or clears its draft.

```powershell
nesvo run get RUN_ID --json
nesvo run deliver RUN_ID --task TASK_ID --key instruction-1 --revision RUN_REV --timeout-ms 60000 --json
nesvo run mutation --key instruction-1 --json
nesvo run task RUN_ID TASK_ID --json
nesvo operation --id NATIVE_RECEIPT_ID --json
```

Only an active run/current assigned attempt accepts an intent. Dependency
admission, elapsed budget and unresolved decisions remain enforced. Queueing
commits identity, attempt binding, deadline, run revision and immutable acceptance
before returning. Initially `delivery.phase` is `queued`, with `receiptId:null`;
CLI exit zero means acceptance, not input or success.

## Readiness, human priority and native evidence

The bounded host waiter continues after its CLI/MCP client disconnects. It waits
for observed idle/done **and** provider readiness. Working, startup and pending
submission are blockers. No model heartbeat or unchanged-state LLM call occurs.
Readiness events wake the waiter; a local timer bounds deadlines and catches
projection changes. Identical blockers do not increment revisions or emit events.

An active human controller at acceptance pauses the intent. A later control grant
also pauses it, including a quick grant/release without a draft. Lease release
does not reactivate the instruction. Retained drafts, revoked native authority
and host shutdown likewise pause. Queueing never takes focus/control, approves
provider permissions or answers a decision.

Before input, a transaction rechecks the current run/attempt, deadline, decision
and elapsed fences, creating an ordinary native send receipt together with
`dispatching`. The same-run physical-effect permit excludes concurrent native
launch/stop/cancel. Native authority, human control epoch, readiness, lifecycle
ordering and split paste/Enter are checked by the ordinary input adapter. A race
after the readiness probe cannot override human takeover. No State lock or SQLite
transaction crosses adapter awaits.

Task history exposes `attempt.delivery`: intent/receipt IDs, native key, queue
phase/blocker, creation/deadline and current native metadata:

- `queued`: no native effect claimed; receipt is null.
- `dispatching`: native receipt reserved before paste/Enter; inspect it.
- `sent`: native write flush or correlated provider receipt observed. This is
  neither task success nor independent validation.
- `failed`: known refusal; a claimed refusal has `effectStarted:false` evidence.
- `paused`: human takeover/draft, revoked authority, shutdown or unclaimed restart.
- `expired`: readiness deadline elapsed before native claim.
- `canceled`: explicit cancellation before claim.
- `unknown`: uncertain effects; inspect, never change keys and resend.

Timeout is 1–300000 ms, default 60000. Limits: 64 queued/dispatching and 4096
retained intents, with no eviction. Each attempt has one instruction intent;
a second key returns `delivery_exists`. Read/cancel/replay cannot send. Native
receipts retain the real issuer: an ID is a pointer, not a grant into another
caller's receipt namespace.

```powershell
nesvo run cancel-delivery RUN_ID DELIVERY_ID --key cancel-instruction --revision RUN_REV --json
```

Cancellation needs the current revision and an unclaimed `queued` intent. It
cannot undo bytes or interrupt a claimed/sent operation. Inspect current task
and receipt first; native session/run controls remain separate.

## Restart and remaining execution work

Restart pauses unclaimed intents without allocating a receipt. A committed
dispatch claim becomes uncertain and is never sent again. Native receipt
recovery remains authoritative about its own uncertainty. Original workflow keys
return historical acceptance; current task history shows recovered state.

This first API does not automatically rearm paused/expired/failed intents. Inspect
known no-effect evidence and make a deliberate guarded input decision, or choose
a fresh task attempt where appropriate. Unknown effects never permit fresh-key
workarounds. Explicit rearm with retained history and process adoption remain work.

This API registers one explicit instruction. [Opt-in host execution](harness-executor.md)
can select dependency-ready tasks and queue instructions only for its own admitted
native attempts. It never invents/edits a plan or adopts manual workers. Delta-only
coordinator wakes, job queues and full provider recovery remain harness gates.
Explicit worker reports still require independent validation.

## MCP and authenticated wire

`nesvo_deliver_task`: `{key,runId,taskId,expectedRevision,timeoutMs?}`.
`nesvo_cancel_task_delivery`: `{key,runId,deliveryId,expectedRevision}`.
The authenticated workflow envelope contains
`{action:"delivery",request:{action:"queue"|"cancel",...}}`.
Worker/foreign-run access and extra prompt/session/authority fields fail closed.
Older hosts fail capability checks without falling back to ordinary send.

Storage tests cover replay, exclusive claim, transactional native rollback,
run/decision fences, cancellation/timeout, unchanged blockers and restart.
Controlled official-SDK tests exercise real PTYs, CLI/MCP key parity, literal task
delivery, worker reporting, human release without resume, working blockers,
cancellation and expiry. They call no model and do not prove an original
provider's readiness/hook integration. No new dependency or UI change is required.
