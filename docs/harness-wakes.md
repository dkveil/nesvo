# Delta-only coordinator wakes

`runWakes:true` adds an explicit, disabled-by-default policy for notifying a
run's existing native coordinator. The host observes durable messages and
canonical worker attention. It coalesces new references into guarded native
input; it never calls a model on an unchanged-state timer.

This is separate from the [DAG executor](harness-executor.md), which selects
worker tasks, and from [inbox ACK](harness-inbox.md), which acknowledges exact
message IDs. A wake never validates work, answers a decision or approves a
provider permission prompt. Original provider login and permissions still apply.

## Enable and inspect

Use an active or draining run with a bound, live native coordinator:

```powershell
nesvo run get RUN_ID --json
nesvo run wake enable RUN_ID --key wake-on-1 --revision RUN_REV --json
nesvo run wake get RUN_ID --json
nesvo run mutation --key wake-on-1 --json
nesvo run wake disable RUN_ID --key wake-off-1 --revision RUN_REV --json
```

MCP equivalents are `nesvo_enable_run_wakes`, `nesvo_disable_run_wakes`,
`nesvo_get_run_wakes` and `nesvo_get_run_wake_batch`. Enable/disable accept
`{key,runId,expectedRevision}`. Get accepts `{runId,after?}`; batch accepts
`{runId,batchId}`. These use the same authenticated workflow adapter as the CLI.

Only the owner or that run's live, authorized coordinator can manage/read this
policy. A worker, foreign coordinator, display name or parent metadata grants
no access. The target is the run's host-bound coordinator; callers cannot
supply another session, replacement prompt, shell command or role.

An enable/disable reply is immutable mutation acceptance. After a lost reply,
recover the original workflow key and then inspect the current policy. Same-key
replay does not start another loop, renew authority or restore an old enabled
state. A deliberate enable of a paused/disabled policy needs a fresh key and
current run revision; enabling an already enabled policy conflicts.

## Sources, cursors and coalescing

Only coordinator-addressed `result`, `decision`, `question` and `error` messages
produce message notices. A manual `note` or worker-addressed message does not.
Result/decision pointers come from host-authored records. Caller bodies and
correlation strings never become native wake instructions.

The same current-attention projection used by the session view supplies blocker
changes, including resolution. Changes are tied to the current task attempt;
foreign sessions and superseded attempts do not notify this run. Idle/working
traffic, source timestamps and repeated identical blockers produce no wake.
Actual process exit without a reported result becomes `missing_result` or
`process_exit` attention; it does not fabricate a task failure or success. A
reported clean exit does not bypass independent validation.

On explicit enable, pending relevant inbox messages and currently recorded/live
worker blockers are seeded. A previously disabled policy does not accumulate
every transient attention change. Message and canonical-attention notice writes
commit with their source transaction. Failed publication remains pending with
bounded local retry; a failed durable notice insertion does not silently accept
the source mutation. No status/render path performs SQLite or network I/O.

`run wake get` returns at most eight notice references, `nextCursor`, `hasMore`
and `pendingCount` (notices not yet assigned a batch). Continue with
`--after NEXT_CURSOR`; this cursor belongs to wake notices, not domain events,
terminal bytes or inbox messages. A cursor ahead of the run is rejected.
References include the actual inbox `messageId`/`messageSequence` or the current
attempt/session and canonical attention. Reading does not claim or send them.

After a 250 ms coalescing window, up to eight oldest unclaimed references form
one batch. Only one native wake per coordinator may be in flight across runs.
The fixed host prompt names the run, batch and notice kind/IDs. The recipient
can inspect it with:

```powershell
nesvo run wake batch RUN_ID BATCH_ID --json
nesvo run inbox read RUN_ID --json
nesvo run get RUN_ID --json
```

Batch metadata retains its exact notice set and native receipt pointer. The
batch's phase and `native.phase` reflect observed progress separately from
management acceptance. Receipt IDs remain issuer-scoped: a coordinator may
read its authorized run batch, but an owner-issued receipt pointer does not
grant access to the owner's private operation record.

After reconciling a message with current task/attempt/result evidence, consumers
ACK only its exact inbox ID. A wake, batch claim, terminal response settlement
or new coordinator process is never ACK. Unread messages stay pending even
after a settled wake, and claimed notices are never sent again automatically.

## Native admission and recovery

The existing native input path requires live authority, provider readiness and
idle evidence, with no pending submission, retained draft or human controller.
Busy/startup/permission states wait for suitable evidence; the host does not
press approval keys. Quick human takeover and release pauses the generation
even if the user typed nothing. Releasing a lease does not rearm the policy.

The host checks authority/human priority during local waiting, then checks
policy generation, current run state and elapsed budget again before both
paste and Enter. No model is invoked by these local checks. Stop/cancel,
elapsed exhaustion, authority loss or a retained draft prevents new input.
Drain permits coordinator handling while still blocking new task assignment.
Host/provider process budgets still govern any later worker launch.

Notice bindings, native receipt reservation and batch provenance commit
atomically before bytes. Partial writes remain `unknown`; no new key, budget
extension or policy enable repastes or submits an existing uncertain batch.
The existing draft must be deliberately reconciled. A fresh enable can first
deliver never-claimed backlog once all admission guards pass.

Disable prevents future admitted writes; it does not undo existing bytes,
interrupt a model already responding, stop workers or ACK anything. A failed,
interrupted or unknown native wake pauses its own policy generation. An older
batch cannot disable a deliberately enabled newer generation.

Host restart disables policies and invalidates generations. Known native
settlement is retained; unconfirmed in-flight batches become unknown. No
coordinator is adopted/relaunched and no claimed notice is replayed. Full
replacement-process adoption remains F41 work.

Bounds: 16 enabled policies, 1024 retained policies, 8192 retained notices and
8192 retained batches per host database. Each reference is at most 1024 encoded
bytes. Capacity failure is explicit; history is not silently pruned. Retention
management beyond these refusal bounds remains further work.

## Verification and limits

Storage tests exercise transactional rollback, scopes, immutable replay versus
current state, exact batching, canonical deduplication, clean exit without
invented success, quiet-loop stability, elapsed-clock regression, real database
reopen and retention refusal. Native SDK tests use the official MCP client,
actual CLI subprocesses and isolated host/PTYs with controlled non-model
programs. They verify busy-to-idle delivery, no unchanged-state input, no implicit
ACK/validation, human takeover fences and budget expiry between paste and Enter.
Actual CLI/MCP envelopes are validated with Ajv against the published schema.

These fixtures do not establish a model's handling of a wake or completed
original-provider orchestration. The existing original Claude native permission
gate remains open; no permission bypass is installed. UI/mobile policy controls,
durable checkpoint compaction and complete recovery are separate feature work.
