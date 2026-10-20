# Run admission, elapsed budgets and drain

`runBudgets:true` adds a persisted policy for each durable run. `runDrain:true`
adds graceful drain/resume. Both use the existing authenticated workflow journal;
the global [host policy](harness-budgets.md) remains independently enforced.

```powershell
nesvo run budget get RUN_ID --json
nesvo run budget set RUN_ID --key run-policy-1 --revision RUN_REV --file policy.json --json
nesvo run drain RUN_ID --key run-drain-1 --revision RUN_REV --json
nesvo run resume RUN_ID --key run-resume-1 --revision RUN_REV --json
nesvo run mutation --key run-policy-1 --json
```

`policy.json` is a complete replacement, bounded to 4 KiB:

```json
{ "maxParallel": 2, "maxAttemptsPerTask": 3, "maxElapsedMs": 1800000 }
```

All three fields are required. `maxParallel` and `maxAttemptsPerTask` are 1–16.
`maxElapsedMs` is explicit `null` for unlimited, or 1000–604800000 (1 second–7
days). Unknown fields and malformed/out-of-range policy are refused. Defaults
are 8 parallel attempts, 16 total attempts per task and unlimited elapsed time.
The attempt limit includes the first attempt, rather than counting only retries.

## Admission and authority

Assigned attempts **and reported results awaiting validation** occupy parallel
slots. Silence, idle, output reads and inbox ACK never release a slot. Explicit
parent/owner validation releases it; only accepted success unlocks dependencies.
Failed attempts retain history and a new attempt requires a fresh worker process.

Only the owner or this run's live authorized coordinator may inspect/edit policy.
Coordinators can tighten limits, but cannot raise parallel/attempt allowances,
extend a finite deadline or remove it. Only the owner may relax policy. Workers
receive their own run policy in task context without acquiring parent authority.
Global host/provider limits and the prohibition on recursive worker fan-out still
apply. Lowering policy does not kill current work, claim a human lease, move
focus, clear a draft or invalidate an already assigned result.

These limits govern **attempt binding**, atomic task launch and subsequent
automated input. [Task launch](harness-task-launch.md) reserves capacity before
native setup; `launching` and `launchUnknown` count alongside assigned/reported
attempts. A proven no-effect startup failure frees its slot but retains retry
history. Native sessions created outside a run remain governed by host policy;
ordinary child creation is not a run reservation. Background DAG dispatch remains
separate F14 work.

## Clock and observed exhaustion

The clock starts atomically on actual activation, not draft creation or policy
editing. Elapsed time includes drain and disconnect; resume and ordinary edits
never reset activation time. Legacy active runs with no recorded activation show
`untracked`; finite elapsed policy is refused rather than inventing a timestamp.

Run get/context, policy reads/edits, admission and automated input observe the
deadline. First observed exhaustion is persisted independently of a rejected
assignment, so database reopen or a backward wall-clock jump cannot reopen it.
An explicit owner extension may reopen a deadline only when its new deadline is
later than both current time and the recorded exhaustion. Removing the finite
limit is also an explicit owner relaxation. Old keyed replies remain historical;
replaying them cannot restore earlier permissive policy.

No idle timer, model heartbeat or polling process is introduced. This is an
admission/input boundary, not a claim that current native work is terminated at
the deadline. Already assigned workers can still report and parents can validate
after exhaustion. Explicit [native run controls](harness-run-controls.md) provide
stop/cancel with observed exit; scheduler/dispatcher deadlines remain required work.

## Drain and native input

Drain changes `active` to `draining`, rejecting new assignments. Current workers
may finish/report and parents may validate. With no assigned/reported attempts
left, the state becomes `drained` when planned work remains; if all tasks are
accepted it becomes `succeeded`. Neither state is inferred from process silence.
Resume reopens a draining/drained or explicitly stopped run without changing
clock, history or budgets. A canceled run cannot resume.

An owner drain latches owner control durably. A coordinator cannot clear it by
draining again or resuming. The owner may also latch an already drained run.
A coordinator can resume its own drain. A completed run cannot be revived.
Drain/resume are metadata changes, not native stop/cancel or permission approval.

Automated `session send` checks a bound worker's current attempt, open time
budget and unresolved decision gates before paste and again before Enter.
Superseded/reported/completed attempts cannot receive another automated prompt.
Pending, canceled and expired decisions remain blocking. These checks accompany
the existing lifecycle, human-control and draft fences. They are checked at each
queue admission, not a retroactive recall of bytes already accepted by the PTY.
If paste started but submit is refused, the original native receipt is uncertain;
inspect it and the terminal rather than automatically sending another key.
Direct human PTY input and native interrupt/stop retain their existing contract.

## Wire, revisions and recovery

Inside `workflow.request`:

- `runBudget {request:{action:"get",runId}}`.
- `runBudget {request:{action:"set",key,runId,expectedRevision,limits}}`.
- `drain|resume {key,runId,expectedRevision}`.

Policy replies contain `run` and `policy`; ordinary run/context replies contain
`run.budget`. Policy includes limits, `startedAt`, `deadlineAt`, `exhaustedAt`,
`timeState`, `activeAttempts` and `ownerDrain`. Timestamps are nullable Unix
milliseconds. Exhaustion is an observation independent of run revision; explicit
policy/drain/resume changes increment run revision. State, event and keyed result
commit together. Stale revisions and key collisions never partially edit policy.
Read current policy after recovering historical replies. Workers cannot recover
parent policy keys. `requestId` is transport correlation, not mutation identity.

MCP exposes `nesvo_get_run_budget`, `nesvo_set_run_budget`, `nesvo_drain_run` and
`nesvo_resume_run` with the same semantics and strict fields. Old hosts fail
capability checks without a legacy mutation fallback. Typed refusals include
`parallel_budget_exhausted`, `retry_budget_exhausted`, `time_budget_exhausted`,
`clock_unavailable`, `run_state_conflict`, `revision_conflict` and `forbidden`.
Native send wraps a specific refusal in the existing `operation_failed` receipt;
`effectStarted:false` means no native input was admitted for that operation.

## Verification scope

Storage tests exercise reported-slot retention, explicit validation/retry,
owner-only relaxation, durable exhaustion/reopen/clock rollback, historical
replay, legacy clock handling, owner drain control and success during drain.
The controlled native fixture uses CLI and official MCP SDK clients, visible
native workers, actual worker result reporting, and time/decision send refusals
with unchanged terminal output. CLI output is checked against the versioned
JSON schema, including invalid/missing/oversized policy. No model calls, global
provider configuration edits, additional dependencies or UI changes are needed.
