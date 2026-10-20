# Native run stop and cancel

`runControls:true` adds durable stop/cancel intents for a run's **bound worker
processes**. It builds on [run budgets/drain](harness-run-budgets.md) and native
[operation receipts](harness-operations.md). Metadata acceptance, native stop
requests and observed exit are distinct evidence.

```powershell
nesvo run stop RUN_ID --key stop-run-1 --revision RUN_REV --json
nesvo run mutation --key stop-run-1 --json
nesvo run control RUN_ID CONTROL_ID --json
nesvo run control RUN_ID CONTROL_ID --offset NEXT_OFFSET --json
nesvo operation --id TARGET_RECEIPT_ID --json
nesvo run cancel RUN_ID --key cancel-run-1 --revision RUN_REV --json
```

MCP exposes `nesvo_stop_run`, `nesvo_cancel_run` and `nesvo_get_run_control` with
the same host authority, revisions, keys and per-target evidence. The mutation's
reply is its **immutable acceptance view**, also returned by replay/recovery.
Use control get for current outcomes; exit code zero is not proof of termination.
Old hosts fail capability checks instead of falling back to unjournaled signals.

## Scope and human priority

The target set is frozen from this run's attempt bindings before any signal.
It includes still-unconfirmed historical attempt processes, which cannot be
reassigned to another attempt. It excludes the coordinator, unassigned children,
foreign sessions, processes with persisted host exit proof and native launch
receipts proving no effects occurred. Physical task launch
and control of one run use the same runtime permit, returning `busy` while
another physical effect is active; reads remain passive. Display names,
parent metadata and focus do not grant authority. Workers cannot stop/cancel
their parent run. Coordinators can operate only their own visible run and the
native children they were granted; native authorization is rechecked per target.

Owner-controlled drain/stop cannot be overridden by a coordinator. Run control
also protects a human draft retained after its input lease is released. Neither
an active lease nor that draft is cleared to make an automated stop succeed.
The person may deliberately inspect and resolve the draft or request an
individual native session stop, which can lose work; a run-control retry is not
implicit permission for that action. Control does not acquire a terminal lease,
switch focus, approve provider permission or kill unassigned related sessions.

## Run and attempt states

- Stop changes an active/draining/drained run to `stopping`, blocking new
  assignments and automated sends. Once **all frozen targets have exit proof**,
  it becomes `stopped`. Resume is explicit, preserves clock/retry/history and
  remains owner-only after an owner stop. Unreported interrupted attempts become
  `stopped` and need a fresh process/attempt for retry. Reported results remain
  available for explicit validation after resume, avoiding automatic reexecution
  of completed work. They still occupy parallel slots until validated.
- Cancel changes an active/draining/drained/stopping run to `canceling`, then
  `canceled` after all target exits are proven. A draft with no bound workers can
  be canceled immediately. Cancellation cannot resume. Pending/unfinished
  attempts close without inventing a worker result, task success or passing check.
- Answered decisions and accepted task results remain history. Pending decisions
  close as canceled/expired when native control completes, with a specific reason;
  no answer or native permission is inferred. Reported result data is retained
  even when cancellation closes its attempt.

A succeeded run is not reclassified by these commands; individual session
cleanup remains available separately. Global retained-session slots are not
silently freed by process termination. Closing retained output is a deliberate
separate action; workflow history and exit proof remain durable.

## Durable effect pipeline and recovery

The run revision, control ID, frozen targets, per-target native keys, domain
event and original mutation result commit together before dispatch. A private
single-use claim selects bounded target pages. Each target uses an ordinary
durable native stop receipt under a stable `run-control:CONTROL_ID:ATTEMPT_ID`
key. Native effects occur outside SQLite transactions and state locks are not
held across async journal/network work. No shell command is assembled from names.

Per-target phases are `pending`, `dispatching`, `stopRequested`, `blocked`,
`unknown`, `unavailable` and `exited`. Aggregate control state is `dispatching`,
`awaitingExit`, `blocked`, `unconfirmed` or `completed`.

`stopRequested` confirms that the native stop was requested; it does not claim an
exit. Trusted host `process.exited` observations atomically persist exit proof
and advance matching controls, including with no clients connected. Control get
can also reconcile a retained host process already observed exited. Provider
text, OSC idle/done, a disconnected client and a missing process after restart
are not substitutes for exit proof. Exit proof is tied to the stable managed
process ID and retained with its attempt, independent of the bounded event log.

Same-key replay, reads and reconnect never send signals. A known no-effect
refusal such as `control_busy` can be followed by a deliberately authorized new
intent **after the blocker is resolved** and the run revision reread. A pending
or uncertain previous control rejects a new key with `control_unconfirmed`.
Inspect its targets and original native receipts instead of automatically retrying.

Restart invalidates pending dispatch claims, records unconfirmed state and never
replays their native actions. Proven exits/completed control survive restart.
An unadopted missing process is `unavailable`, not assumed dead. Original native
receipt IDs can be recovered through their stored issuer/key correlation even
when the parent reply was lost. Owner may inspect another caller's receipt by
its returned ID; keys alone remain caller-scoped. This is controlled uncertainty,
not process/conversation adoption; that remains F41 work.

## Wire and bounds

Inside the authenticated workflow envelope:

```json
{
  "action": "control",
  "request": {
    "action": "start",
    "kind": "stop",
    "runId": "HOST_RUN_ID",
    "key": "stop-run-1",
    "expectedRevision": 7
  }
}
```

Get uses `{action:"control",request:{action:"get",runId,controlId,offset:0}}`.
Replies contain `run`, `control`, up to eight `targets` and nullable `nextOffset`.
Control includes ID, kind, state, creation time and counts of observed target
phases. Targets identify session/attempt, original native operation key, phase,
nullable receipt ID and bounded failure code. Offset is 0–4096; native claims
also page eight targets. Storage admits at most 1024 control intents and 8192
retained target rows, within existing run/attempt/mutation bounds. Full retention
returns `busy` without discarding history. No render path performs I/O.

## Verification and remaining work

Storage tests distinguish acceptance/request/exit, preserve reported results
through stop/resume, close decisions without fabricated results, cover recovery
and missing processes, and keep pagination/scope stable. A controlled native SDK
scenario physically stops bound shells, preserves the coordinator/unassigned/
foreign sessions, checks a held human lease and retained draft, proves replay
does not signal after release, resumes on fresh attempts, then cancels with real
exit observations. CLI schemas cover empty draft cancellation and stable recovery.
These fixtures make no model calls and do not change user provider configuration.

An additional Windows smoke used the original installed Claude Code 2.1.304
without an initial prompt or trust approval. A bound startup process waiting on
folder trust was stopped through CLI; a later control read confirmed exit and
original-key recovery preserved historical acceptance. The isolated host and its
observed descendants exited cleanly. This covers native startup process control,
not model work, provider-hook readiness or post-restart process adoption.

Automatic DAG pre-launch reservations/dispatch, coordinator adoption, unknown
orphan-process recovery, job policy and the actual-provider matrix remain open
stage gates. These commands do not claim to complete the entire harness goal.
