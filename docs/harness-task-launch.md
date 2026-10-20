# Atomic task worker launch

`runLaunch:true` advertises a host-owned task launch that reserves a dependency-ready
task, its attempt/retry identity, parallel capacity and native create receipt in
one SQLite transaction **before** process or worktree setup. It composes the
[workflow DAG](harness-workflows.md), [run policy](harness-run-budgets.md) and
[native operation receipts](harness-operations.md).

```powershell
nesvo run launch RUN_ID --task TASK_ID --key task-launch-1 --revision RUN_REV --program claude --shared --harness --json
nesvo run launch RUN_ID --task TASK_ID --key isolated-review-1 --revision RUN_REV --program codex --worktree --no-harness --json
nesvo run mutation --key task-launch-1 --json
nesvo run get RUN_ID --json
nesvo run task RUN_ID TASK_ID --json
nesvo operation --id NATIVE_RECEIPT_ID --json
```

The two launch examples describe distinct deliberate intents; do not run both
to retry an uncertain effect. `--shared` or `--worktree` is mandatory and mutually
exclusive. Optional name defaults to the task title; cwd defaults to the caller's
authorized workspace. Provider installation/profile, workspace, group and native
admission guards still apply. No initial prompt, coordinator role, foreign parent
or arbitrary launch arguments are accepted by this API.

## Admission, scope and native effects

Only an active run with accepted dependency results can reserve a new attempt.
Current reported/assigned attempts, in-progress launches and uncertain launches
occupy parallel capacity. Retry count includes admitted startup attempts; no
history is overwritten. Exact revisions and original workflow keys retain their
existing conflict/replay semantics. Transaction failure rolls back the native
receipt, attempt, run revision, mutation view and domain events together.

An authenticated coordinator launches only into its own run. The owner may launch
into a coordinatorless run, or explicitly delegate a fresh worker into the bound
live coordinator's run. That uses the coordinator's existing bounded capability,
workspace/profile and child grants; editing parent metadata alone still grants
nothing. Owner-originated native receipts remain owner-issued. The coordinator
can inspect its granted child and run history, while the owner can inspect the
owner-issued receipt. No worker can recursively create a coordinator.

Physical launch and stop/cancel for **the same run** share a short-lived runtime
permit, preventing a native process from appearing between a control's target
snapshot and its completion. A conflicting request receives `busy` without a
new reservation/control; inspect existing keys/receipts before deliberately
retrying. There is no unbounded waiting queue. Different runs and passive reads
remain independent. Weak permit entries retain only active effects. No State
lock or SQLite transaction is held across Git/native adapter awaits.

Graceful drain may arrive after admission: the reserved attempt already occupies
capacity and may finish native setup as admitted work. It does not bypass the
elapsed budget or human/decision gates on subsequent prompt submission. Global
host/provider caps are still checked by ordinary native creation, including
before actual spawn. A later refusal after worktree setup may be uncertain and
does not silently free the run slot or create another worktree.

## Acceptance, current state and recovery

The first reply is an immutable reservation acceptance view. Its `launch` object
contains `attemptId`, `sessionId`, `receiptId`, `operationKey`, native `phase`,
explicit workspace mode, creation time and nullable failure/effect/path evidence.
It can still say `accepted/launching` after native setup has finished. Same-key
replay and `run mutation` return that same historical view without dispatch.

Read current run/task history and the original native receipt separately:

- `launching`: a reserved native startup; parallel capacity is occupied.
- `assigned`: observed native creation bound the preallocated process/attempt.
  It does not prove provider readiness or successful work. Inspect the actual
  readiness/status and deliberately send context through guarded `session send`,
  or queue the immutable instruction through [task delivery](harness-task-delivery.md).
  Do not assign the process again or automatically type based on acceptance.
- `launchFailed`: the native receipt proves `failed` with `effectStarted:false`.
  The parallel slot is free; retry identity/history remain. A new deliberate
  attempt requires a resolved blocker, current revision and retry admission.
  This is a startup refusal, not a worker result or task success.
- `launchUnknown`: native/worktree effects remain uncertain. Capacity stays
  occupied; changing keys, ordinary session creation, replay or a missing process
  cannot resolve that uncertainty. Inspect the original receipt and native state.

Restart invalidates unfinished native claims through ordinary receipt recovery
and marks unfinished attempts uncertain, except proven no-effect refusals. It
never replays native startup. A historically created receipt does not prove
process adoption after restart. Process/conversation adoption and explicit
unknown-launch reconciliation remain F41 work.

Run control includes reserved launch identities in its attempt scope. It excludes
only actual exit proof or native startup receipts proving no effect. Known
startup refusal is not fabricated exit proof. An unknown missing process stays
unavailable/unconfirmed; completed/validated worker processes remain controlled
until actually exited. Human control and retained drafts still win.

## MCP, wire and compatibility

`nesvo_launch_task` uses the same host authority and workflow recovery namespace:

```json
{
  "key": "task-launch-1",
  "runId": "HOST_RUN_ID",
  "taskId": "HOST_TASK_ID",
  "expectedRevision": 7,
  "profile": { "program": "claude", "workspace": "shared", "harness": true }
}
```

Optional profile fields are `name`, `cwd` and `harness`; program and workspace are
required. Native wire shape is `{action:"launch",request:{...}}` inside the
authenticated workflow envelope. Older hosts fail the `runLaunch` capability
check; clients do not silently create an unreserved session instead. Existing
manual `run assign` can bind an already controlled worker; it remains a separate
metadata operation, not atomic pre-spawn admission.

## Verification and remaining gates

Storage tests cover atomic rollback, replay, dependency/scope/revision refusals,
retry and parallel accounting, recovery, two SQLite writers and result validation.
Native SDK tests use real isolated PTYs and a controlled provider without model
calls: simultaneous same-key launch, matching CLI replay, no control acquisition,
worker reporting, explicit validation, isolated review worktree, source-edit
preservation, known no-effect failure and observed run cancellation. They also
check that owner delegation cannot revive an exited coordinator capability.
CLI output is checked against the versioned JSON schema. Git test settings affect only the
temporary owned repository; user/global configuration is preserved.

No background DAG executor, model wake loop or UI redesign is implied. Explicit
task delivery can wait safely after launch. Automatic DAG selection,
file ownership presentation, worktree
setup/archive and process adoption remain separate required harness work. No
new dependency was needed.
