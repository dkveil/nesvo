# Job execution timeouts

`jobExecutionTimeouts:true` adds optional `executionTimeoutMs` to owner-created
[durable jobs](harness-jobs.md). The host supervises the exact native worker for
each dispatch generation without an open CLI, MCP client, TUI or phone. Expiration
fences further automated work and requests native cleanup through the existing
guarded stop receipts. Process exit remains separately observed evidence.

## Select a limit

`executionTimeoutMs` is an integer from 1000 to 604800000 milliseconds: one second
to seven days. Omission adds no execution timeout. The existing `maxElapsedMs`
continues to configure the Run's independent admission/input budget.

For example, save this UTF-8 JSON specification with a deliberately selected
future RFC3339 time:

```json
{
  "title": "Bounded review",
  "instruction": "Review the current Git changes without editing files. Report an explicit Nesvo task result with checks and limitations.",
  "profile": {
    "program": "claude",
    "workspace": "shared",
    "harness": true,
    "allowedNesvoTools": ["nesvo_get_current_task", "nesvo_report_task_result"]
  },
  "schedule": {
    "kind": "once",
    "at": "2026-12-01T09:00:00+01:00"
  },
  "overlap": "queue",
  "maxElapsedMs": 300000,
  "executionTimeoutMs": 600000
}
```

```powershell
nesvo job create --key bounded-review-1 --file job.json --json
nesvo job show JOB_ID --json
nesvo job history JOB_ID --json
nesvo job occurrence JOB_ID OCCURRENCE_ID --json
nesvo job attempt JOB_ID OCCURRENCE_ID JOB_ATTEMPT_ID --json
```

Create/update CLI and MCP requests check `jobExecutionTimeouts:true` whenever
they select the optional limit. An older host is refused before sending that
intent. Existing tool names and mutation keys are retained; there is no legacy
fallback that substitutes an elapsed admission budget for a selected execution
timeout.

The occurrence freezes its specification when admitted. Definition edits affect
future occurrences. Each generation receives its own Run, native attempt,
session, launch receipt and execution deadline. Updating the definition or
extending a Run budget does not reset an already armed execution window. A read,
reconnect or replay of an accepted mutation never rearms it. Legacy records
without the optional policy retain their previous behavior.

## Clock and execution boundary

The execution window starts at native launch admission, when the host atomically
reserves the exact native attempt, session and launch receipt. It includes native
preparation, worktree preparation and provider readiness as well as worker
execution. It excludes a preceding command precheck, whose own timeout and cleanup
remain governed by [the precheck contract](harness-job-prechecks.md).

| Limit                | Begins at               | Behavior at exhaustion                                        |
| -------------------- | ----------------------- | ------------------------------------------------------------- |
| `maxElapsedMs`       | Run activation          | Blocks further admission and automated input                  |
| `executionTimeoutMs` | Native launch admission | Fences the generation and requests exact bound-worker cleanup |

Within the current host process, a monotonic elapsed clock governs execution
expiry and the first-report boundary. Moving the wall clock backward cannot
extend the window; moving it forward cannot expire the window early. Public
`armedAt`, `deadlineAt`, `requestedAt` and `observedAt` are wall-clock Unix
milliseconds for inspection. `deadlineAt` is the original admission wall time
plus the frozen duration, rather than a clock to renew during polling. Wall-clock
adjustments may therefore make later observation timestamps precede an earlier
recorded timestamp. Private monotonic values and dispatch tokens are never
included in public evidence.

The timeout supervisor runs independently of job dispatch, calendars and command
prechecks. It admits at most two cleanup dispatches concurrently. With no timer
or pending exit observation it waits for journal changes. Timer activity sends
no model input. Unavailable storage or native control remains visible uncertainty
and does not authorize an unverified stop.

An already admitted native launch can finish its owned critical section before
control enumerates the exact worker. Expiration records the deadline and cleanup
intent; the process can remain alive while stop admission, human protection or
exit confirmation is pending. The host never converts a stop request into exit
proof.

## Reports and validation

A valid explicit worker report accepted before the execution deadline disarms
the timeout, regardless of the reported outcome. The report still requires the
ordinary matching validation to become accepted task success. A worker awaiting
validation is not terminated merely because the former execution window ends.
Reported/completed processes remain available for owner inspection until
deliberate separate cleanup.

The host checks the monotonic deadline at the successful report boundary after
result validation and dependent metadata work, in the same transaction as the
result. A fresh report at or after the deadline is refused even if the timer has
not yet polled. If timeout admission wins first, it fences fresh reports,
validation, worker admission, executor enablement and automated input. The
deadline fence reports `job_execution_timeout`; existing Run/attempt state
guards continue to apply.

Replay of an earlier accepted report or validation returns its original immutable
acceptance. It never obtains another native effect. Neither idle output, response
settlement, process creation nor physical process exit supplies a task result or
passed validation.

If trusted exit evidence arrives before any timeout claim and there is no report
or prior owner control, the timer disarms with `reason:process_exited`. The exact
native attempt becomes stopped and the occurrence/generation becomes
`failed` with `reason:worker_exited_without_result`. This also preserves honest
history when exit is observed before a delayed timeout poll: no timeout stop is
invented as the cause of that exit.

## Human priority and cleanup

Cleanup targets the frozen generation's exact native attempt/session/launch
receipt. It excludes unrelated workers and does not change focus, acquire a
lease, clear a draft, approve provider permission or dispatch additional model
input. Native launch and control share the Run's existing physical-effect permit.

An active human lease, retained human draft or any prior human takeover of that
fresh worker blocks automatic timeout termination. The takeover guard is checked
atomically with native stop dispatch. Quick takeover followed by release still
blocks it. Releasing a lease alone never sends a deferred stop, and a blocked or
uncertain timeout never obtains another automatic stop claim.

The owner can inspect the original control and native receipts, then deliberately
resolve the worker through the existing owner controls. A trusted exit of the
exact worker can settle blocked or uncertain timeout cleanup. A pre-existing
exact owner stop/cancel control may be linked as evidence without dispatching its
effect again; conflicting control scope remains blocked. An owner control or
occurrence cancellation accepted before timeout admission supersedes the armed
timer. A timeout already owning cleanup refuses a fresh occurrence cancellation;
inspect the retained records rather than creating a replacement key.

Overlap remains occupied while timeout cleanup is blocked, awaiting exit or
unconfirmed. Only confirmed exact-worker exit permits the timeout occurrence to
become terminal `failed` with `reason:execution_timeout`. Native stop acceptance
is not sufficient to release a queued replacement. Retained terminal output,
session history and native receipts are preserved.

## Inspect execution evidence

Current occurrence and generation summary/detail reads expose nullable
`executionTimeout`. It is null when no native execution timeout was armed; old
immutable acceptance envelopes may omit the additive property entirely. A
non-null object always includes:

- `jobId`, `occurrenceId`, `jobAttemptId`, `runId`, `attemptId`, `sessionId` and
  `launchReceiptId`: the frozen identities; `jobAttemptId` identifies the dispatch
  generation, while `attemptId` identifies its native workflow attempt.
- `executionTimeoutMs`, `armedAt` and `deadlineAt`: immutable selected duration and
  public wall-clock admission/deadline evidence.
- `state`, nullable `requestedAt`, `observedAt` and nullable `reason`: current
  timeout observation. `requestedAt` stays null until timeout admission.
- `controlKey` and nullable `controlId`: the stable workflow control identity and
  its bound native control when preparation has been observed.

| Timeout state  | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `armed`        | Frozen execution window; no cleanup claim yet                             |
| `disarmed`     | Explicit report, proven no-effect launch, owner control or actual exit    |
| `dispatching`  | One cleanup claim owns the exact target                                   |
| `awaitingExit` | Native stop was requested; exact-worker exit remains unconfirmed          |
| `blocked`      | Human protection or conflicting control prevents automatic cleanup        |
| `unconfirmed`  | Native outcome, target binding, storage observation or recovery is unsure |
| `completed`    | Exact-worker exit is confirmed after timeout admission                    |

While cleanup is pending, the occurrence/generation uses `canceling` with reason
`execution_timeout`, `execution_timeout_pending` or `execution_timeout_blocked`.
Unknown cleanup uses `reconcile` with `execution_timeout_unconfirmed`. The timeout
object retains its own more specific observation and control pointer. Generation
history retains that generation's evidence even after current pointers change.

```powershell
nesvo run get RUN_ID --json
nesvo run mutation --key CONTROL_KEY --json
nesvo run control RUN_ID CONTROL_ID --json
nesvo operation --id NATIVE_STOP_RECEIPT_ID --json
```

Inspect per-target control receipts and actual exit observations along with the
timeout object. A missing control ID or receipt never grants permission to
redispatch an uncertain effect. Original job mutation keys recover their accepted
views; current occurrence/generation reads expose later observations.

`run mutation --key CONTROL_KEY` recovers acceptance when the timeout created its
own control. If it linked an existing exact owner control, the reserved timeout
key need not have a mutation; inspect `controlId` or use that owner's original
mutation key instead. `mutation_not_found` is not permission to dispatch again.

## Restart and retries

On host restart, passive projection first honors already persisted reports,
proven no-effect launch receipts and trusted exact-process exits. Remaining
unfinished armed or claimed timeout records lose dispatch authority and become
`unconfirmed` with `reason:host_restarted`. The occurrence requires reconciliation.
The old process-local monotonic origin cannot establish fresh expiry or process
adoption in a new host. Restart never rearms a timer,
repeats a stop, resets the deadline or silently releases overlap capacity.
Already disarmed/completed evidence remains retained.

The existing optional `retry.on:launchNoEffect` policy still requires the exact
failed create receipt's JSON boolean `effectStarted:false` and its other approval,
profile and generation guards. While the timer is still armed, such a confirmed
no-effect launch disarms it with `reason:launch_no_effect`; a qualifying retry
receives a fresh generation and independent window. Once timeout cleanup has
been claimed, later no-effect evidence remains available for owner reconciliation;
it does not authorize automatic retry or invent a process exit. Expired execution, provider failure,
human blockage, missing/unknown cleanup and elapsed-budget exhaustion do not
qualify for that retry class. A separate deliberate `run-now` remains a new
occurrence with its own intent and overlap checks.

## Acceptance scope

Required acceptance checks cover optional-field compatibility and capability
refusal, exact generation/target bindings, monotonic boundaries under wall-clock
changes, report/timeout ordering and accepted replay, early exit without a result,
one-use cleanup claims, human takeover and release, restart uncertainty, overlap
retention and native exit evidence. Controlled native fixtures must exercise
client disconnection and both timeout cleanup and a report awaiting validation.
Verification results are recorded separately from this contract.
