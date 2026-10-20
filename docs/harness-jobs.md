# Durable host jobs

`durableJobs:true` and `jobScheduleKinds:["once","cron","rrule"]` advertise owner-only durable
definitions and separate occurrences. The host runs them without an open TUI or
phone. Fresh worker admission and instruction delivery use the existing
Run/Task/Attempt executor, native receipts, readiness, workspace, process budgets
and human-input guards. No model API keys or direct model calls are added.

Once, [recurring IANA calendars](harness-job-calendars.md) and
[owner-approved command prechecks](harness-job-prechecks.md) are available. Safe reuse,
authenticated triggers, broader retry classes, hard runtime timeout/cleanup,
quota queues and job UI remain separate implementation gates. Existing legacy
once schedules and their storage/API remain unchanged until a tested migration
can preserve their launch semantics. The new `job` commands list the new records.

## Create a once job

Save a UTF-8 JSON specification. This PowerShell example selects a time two minutes
in the future; use an explicitly chosen RFC3339 offset for a different instant.

```powershell
$jobSpec = @{
  title = 'Read-only review'
  instruction = 'Summarize the current Git changes without editing files. Report an explicit Nesvo task result with your checks and limitations.'
  profile = @{
    program = 'claude'
    workspace = 'shared'
    harness = $true
    allowedNesvoTools = @('nesvo_get_current_task', 'nesvo_report_task_result')
  }
  schedule = @{
    kind = 'once'
    at = [DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o')
  }
  misfire = 'catchUp'
  graceMs = 60000
  overlap = 'skip'
  maxElapsedMs = 300000
}
$jobFile = Join-Path $env:TEMP ('nesvo-job-' + [guid]::NewGuid() + '.json')
[IO.File]::WriteAllText($jobFile, ($jobSpec | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
nesvo job create --key review-once-1 --file $jobFile --json
```

Use the host's native client and pairing options as with other headless commands.
The job time must be in the future, at most 366 days ahead. An offset is required;
this initial API does not interpret an ambiguous local time or silently pick a
timezone. It stores the resolved UTC millisecond due instant. Host-off time does
not execute jobs; only an eligible catch-up after host startup can execute one.

The profile requires an agent and explicit `shared` or `worktree` workspace mode.
Model/effort and [task-native tool selections](harness-task-tool-profiles.md) use
their existing adapters. A new job is explicit owner intent for a coordinatorless
worker, not a grant for a model to create jobs. Native provider deny/ask policies
still apply; a permission dialog can block an unattended job. No automatic
approval key or permission-mode change is performed.

## Inspect and control definitions

```powershell
nesvo job list --json
nesvo job show JOB_ID --json
nesvo job edit JOB_ID --key edit-1 --revision JOB_REV --file job.json --json
nesvo job disable JOB_ID --key pause-1 --revision JOB_REV --json
nesvo job enable JOB_ID --key enable-1 --revision CURRENT_REV --json
nesvo job run-now JOB_ID --key deliberate-manual-run-1 --revision CURRENT_REV --json
nesvo job history JOB_ID --json
nesvo job occurrence JOB_ID OCCURRENCE_ID --json
nesvo job mutation --key deliberate-manual-run-1 --json
```

Definition edits use exact configuration revisions. They affect future intent;
already admitted occurrences retain their original instruction/profile and job
revision. Editing a once schedule explicitly sets a new future automatic due
instant. A manual `run-now` creates an independent occurrence and does not consume
or move that automatic due instant. It is allowed for a disabled definition.
Disabling pauses new automatic admissions; already claimed work and explicitly
admitted manual occurrences may finish. It does not stop a native process.

The returned occurrence's `runId` leads to ordinary run/task/attempt/native receipt
inspection. `attemptId`, `sessionId` and `launchReceiptId` directly correlate its
current native attempt when allocated; they are null before admission. A reserved
session ID alone is not proof that a process started: inspect its launch receipt.
Use the existing owner `nesvo run stop` or `nesvo run cancel` with
their own exact revision/key to control that run. A definition toggle is not a
substitute for occurrence cancellation.

## Inspect retained dispatch generations

Hosts advertising `jobAttempts:true` expose owner-only attempt history for an
exact job occurrence:

```powershell
nesvo job attempts JOB_ID OCCURRENCE_ID --json
nesvo job attempts JOB_ID OCCURRENCE_ID --offset NEXT_OFFSET --json
nesvo job attempt JOB_ID OCCURRENCE_ID JOB_ATTEMPT_ID --json
```

The matching tools are `nesvo_get_job_attempts` and `nesvo_get_job_attempt`.
Each page contains at most eight summaries and a nullable `nextOffset`; offsets
are bounded to 4096. Detail reads require all three stable IDs. These reads never
run a precheck, launch/adopt a process, retry input or change native permissions.
Older hosts are refused before the new request is sent.

A `jobAttemptId` identifies a retained dispatch generation of an occurrence.
It is distinct from that occurrence's workflow `attemptId`, which identifies the
native worker's task attempt. Current occurrence reads expose nullable
`jobAttemptId` and `jobAttemptOrdinal` alongside the existing native pointers.
An unclaimed queued occurrence has no generation. The host records generation 1
when work is claimed. An explicit `launchNoEffect` retry policy
can admit later generations of the same occurrence after a confirmed native
pre-spawn refusal, as described below. A deliberate `run-now` creates a separate
occurrence.

Summaries include the generation state/reason, generation `createdAt` (the
original intent time for generation 1), actual
`claimedAt`, nullable `finishedAt`, bound `runId`/`runState`, native attempt/session/
launch receipt pointers and bounded precheck evidence without stdout/stderr.
Detail adds retained precheck output, the worker's explicit `result` and its
`validation` evidence, including the validator's source and session when present.
Null native pointers do not prove that an uncertain effect never happened;
`reconcile` remains distinct from success and confirmed cleanup.

Original mutation replay preserves its historical acceptance, including absent
generation pointers in older records. Read the current occurrence and exact
generation for later observations. Reads and mutation replay never allocate a
generation or repeat native effects. Restart retains journal identity and pending
retry decisions; interrupted native effects still require reconciliation.

Each new dispatch also has a private host-only preparation token tied to its
exact current generation. Precheck supervision/completion, Run binding and
scheduler completion messages must present the same generation and token. Run
creation, plan, budget and activation check it inside their writer transaction,
before recovering even an existing mutation response; non-creation operations
also require the exact bound Run. A delayed producer cannot prepare a different
Run or overwrite a newer assignment. Tokens are retired when preparation ends
and cleared on recovery; historical rows never acquire replacement tokens.
They are not CLI/MCP authority and are never returned in public history.

Historical Runs stay inspectable, while automated native admissions reject a
Run whose job generation is no longer current. A retired preparation token does
not stop already admitted native work. Human direct terminal input retains its
existing control contract. Prechecks stay in generation 1 unless the immutable
spec explicitly combines `precheckId` with a retry policy. Hosts advertising
`jobPrecheckGenerations:true` support a fresh execution of the exact approved
command before every later generation. Each generation records its own
authorization and outcome; an earlier pass cannot release a later Run. Current
occurrence detail shows the current generation's precheck, while attempt detail
retains that exact generation's record. Generation 1 keeps its legacy JSON shape;
later precheck records may include the observed `approvalRevision` or null when
that revision is unavailable.

## Retry confirmed launch refusals

Hosts advertising both `jobRetries:true` and
`jobRetryKinds:["launchNoEffect"]` accept an optional retry policy in create/edit
specifications. The CLI and MCP check both capabilities only when the serialized
spec contains a policy. Older hosts and malformed capability values are refused
before the new request is sent. Omitting `retry` preserves a single dispatch and
the existing serialized intent.

Combining `retry` with `precheckId` additionally requires strict boolean
`jobPrecheckGenerations:true` and `jobPrechecks:true`. That explicit combination
authorizes bounded repeated execution of the exact approved command, including
any side effects it may have, before each fresh generation. Each command begin
reads the current approval again and records new authorization; no previous
command authorization or passed result is reused. A precheck without a retry
policy still has a single generation.

Add all four explicit fields to the job JSON file before creating or editing it:

```json
{
  "retry": {
    "on": "launchNoEffect",
    "maxAttempts": 3,
    "initialDelayMs": 1000,
    "maxDelayMs": 10000
  }
}
```

This fragment is the optional member of the full specification shown above.
`on` currently accepts only the string `launchNoEffect`. `maxAttempts` is 1–8 and
includes the first dispatch generation. `initialDelayMs` is 1000–3600000;
`maxDelayMs` is at least `initialDelayMs` and at most 86400000. No field defaults
inside the policy. The host persists each capped exponential backoff decision
once: the first retry waits `initialDelayMs`, then the delay doubles up to
`maxDelayMs`. A read, reconnect, mutation replay or restart does not reset it.

Only an exact failed native create receipt containing JSON boolean
`effectStarted:false` qualifies. This is the native pre-spawn validation refusal
class. An exception from spawning, PTY setup or worktree preparation remains an
unknown outcome unless that exact no-effect evidence exists. Provider exit,
result failure, idle/silence, timeouts, missing receipts and unknown effects do
not qualify. Retrying does not relax provider permissions, workspace constraints,
budgets or input guards. When a precheck is present, the failed source generation
must also have its own passed command outcome with `commandStarted:true` and
`cleanupConfirmed:true`. Skip, failure, timeout, abandonment, interruption and
unknown command cleanup do not qualify for automatic retry. An arbitrary passed
command can have lasting effects; the native no-effect receipt concerns the
worker create operation only.

During backoff the logical occurrence is `retryWaiting`; its outgoing journal
generation remains `failed`. The current occurrence and attempt summary/detail
may expose nullable `retry` facts: `jobAttemptId`, `attemptId`, `launchReceiptId`,
`decidedAt`, `notBefore` and `nextOrdinal`. They identify the immutable outgoing
decision and its evidence; they are not instructions to execute again. Current
state distinguishes waiting, canceled work and a later generation. Once the cursor
advances, the current occurrence's `retry` is null until another qualifying failure;
the old attempt retains its facts.

The host checks approval availability again when a retry becomes due and at the
fresh command begin. Revocation while waiting blocks admission with a visible
reason and preserves the failed source generation. Revocation after claim but
before begin refuses the new generation without executing the command. A
committed begin remains evidence of admitted execution even if the approval is
later revoked; cancellation is the explicit cleanup request.

Each retry gets a fresh dispatch generation, Run, native task attempt and launch
receipt. A checked generation begins without a precheck result or Run; its own
newly passed command with confirmed start and cleanup is required before Run
binding. Prior Runs, attempts, prechecks and receipts remain inspectable. `maxElapsedMs`
applies independently to each Run as an admission/input budget; it does not impose
a hard process timeout. Exhausting the generation limit retains the final failure.
Canceling while waiting fences further admissions for that occurrence and keeps
the outgoing decision as historical evidence. A separate `run-now` remains a new
occurrence with its own intent and overlap checks.

## Cancel one occurrence

Hosts advertising `jobCancellation:true` accept stable occurrence cancellation
through the owner CLI or `nesvo_cancel_job_occurrence`:

```powershell
nesvo job cancel JOB_ID OCCURRENCE_ID --key cancel-review-1 --json
nesvo job occurrence JOB_ID OCCURRENCE_ID --json
nesvo job history JOB_ID --json
nesvo job mutation --key cancel-review-1 --json
```

The exact `jobId`, `occurrenceId` and caller mutation `key` identify the intent;
no focused session, definition revision or provider permission grants authority.
Coordinators and workers cannot cancel jobs. Older hosts are refused before the
new request is sent. Canceling an occurrence does not disable its definition or
create a replacement occurrence.

An unbound queued/dispatching occurrence can cancel immediately. A precheck stays
`canceling` until its exact owned process scope is observed terminated; its actual
output/result is retained even if it passed just before cancellation. A bound run
is fenced immediately against new attempts, executor enablement, automated input
and result validation. An already admitted native launch can finish its critical
section before cancellation enumerates the exact run targets under the native
run permit. Human direct PTY input and its control/draft protection are preserved.

At most two native cancellation dispatches run concurrently. No stop is retried
automatically after a restart or unknown outcome. `cancellation.controlId` and
`controlKey` correlate existing native control evidence and its immutable mutation.
A blocked human-controlled worker remains pending until explicit owner action or
real process exit; releasing a lease alone never sends a deferred stop. An unknown
precheck can still be explicitly abandoned using the separate acknowledged
precheck operation. This sets cancellation `abandoned`, retaining the uncertain
effect/cleanup evidence rather than fabricating physical termination.

Cancellation fences further admissions for that occurrence and requests cleanup
of an active bounded precheck or bound native run. Acceptance is not evidence of
process exit. Inspect the occurrence's current `cancellation`, precheck outcome,
run control and native receipts: cleanup can remain pending, be refused by human
input/control guards, or require reconciliation after uncertainty or restart.
Cancellation does not undo command effects or claim control over detached code.
It does not reinterpret an already completed result as canceled.

The original key recovers the immutable accepted cancellation; history and
occurrence reads show later observations. Replay and read requests never resend
native stop effects. After an uncertain outcome, inspect those original records
instead of issuing a fresh run or cancellation key automatically.

An uncertain cancellation can also settle when a separate explicit owner run
control provides confirmed termination of the exact bound run. The latest control
must be completed and the run must be stopped/canceled; `stopRequested` is
insufficient. Current cancellation then exposes that existing `controlId` and
`reason:run_termination_observed`, retaining its original requested `controlKey`
and immutable acceptance. Observation never dispatches an additional stop.

## Misfires and overlap

- `misfire:skip` accepts normal polling lateness up to five seconds; later due
  instants produce a retained skipped occurrence with `reason:missed_window`.
- `misfire:catchUp` accepts lateness within `graceMs` (default 60 seconds, maximum
  24 hours); it records a skip outside that window. There is no unlimited backlog.
- `overlap:skip` records a skip while an admitted occurrence for the same job is
  queued, dispatching, prechecking, running, canceling, waiting to retry, awaiting validation or awaiting reconciliation.
- `overlap:queue` retains at most one additional queued occurrence. Further
  admissions record `queue_full` skips. Queued intent is not reinterpreted as a
  new clock misfire when the preceding occurrence finishes. Native uncertainty
  blocks the queued occurrence until the original work is reconciled.

Recurring downtime coalesces to the latest eligible clock slot and exposes
`coalescedFromAt` when intermediate slots were merged. See the calendar contract
for DST, search bounds and durable calendar errors. `calendarState:exhausted`
means no more automatic terms; it does not mean the last worker succeeded.

At most eight due definitions are materialized per calendar/once pass and four eligible new/retry generations are
claimed per host tick. Claims are transactional before native work. Dispatch
preparation is bounded to four in-flight tasks; two independent calendar calculations
and two command scopes have their own bounds, preserving timer progress. Definition,
occurrence and mutation retention are bounded (64, 4096 and 4096 respectively);
history is never silently discarded. Full occurrence retention stops new
admissions, while existing occurrence reconciliation can still proceed. Deletion/
archive policies and broader overlap modes remain future work.

## Outcomes and crash safety

`queued`, `dispatching`, `prechecking`, `running`, `needsValidation`, `canceling`, `retryWaiting` and `reconcile` are distinct
from terminal `succeeded`, `failed`, `skipped` and `canceled`. Process creation,
PTY silence and idle are never job success. A succeeded worker report still needs
an explicit matching result validation; the existing workflow rules require
passed checks. `maxElapsedMs` is the run's admission/input budget. It does not
claim a hard process timeout or automatic termination after a completed result.
Completed worker processes remain available for owner inspection and count toward
host process budgets until explicitly stopped/closed; cleanup policy is pending.

Each occurrence uses deterministic workflow keys prefixed
`job:JOB_ID:OCCURRENCE_ID` for `run`, `plan`, `budget`, `activate` and `executor`.
The first generation preserves its original keys; later generations use distinct
keys and Runs. Each run pointer is persisted before native executor admission. A metadata failure
is retained as a refusal; an unconfirmed native dispatch requires reconciliation.
After restart, unfinished native claims are marked `reconcile`, never automatically
restarted. Persisted eligible retry decisions remain subject to their original
backoff and current occurrence state. Retained results may still be inspected/validated. Unclaimed eligible
queued intent can run once; it has not previously performed a native effect.
The scheduler waits for the host's bounded provider-version probes before
admitting due work. Discovery still in progress must not be treated as an
unsupported CLI. The chosen missed-run window still applies after that wait.

Job mutation keys have their own owner namespace. Original-key replay returns the
immutable accepted view, even after time, revisions or process state change.
Changed intent conflicts. A saved acceptance can still say `queued` after work
finished: inspect current history and the exact original run/receipts before
another deliberate run. No new key is an automatic unknown-effect retry.

Job events contain IDs/phases, not prompt bodies. Read APIs are bounded; definition
and occurrence detail expose their requested profiles to the owner. No global
provider configuration is edited or restored from a historical occurrence.

## CLI/MCP parity and verification

The same authenticated host implementation serves `nesvo_create_job`,
`nesvo_get_job`, `nesvo_list_jobs`, `nesvo_update_job`, `nesvo_set_job_enabled`,
`nesvo_run_job_now`, `nesvo_cancel_job_occurrence`, `nesvo_get_job_history`, `nesvo_get_job_occurrence` and
`nesvo_get_job_mutation`, plus the read-only `nesvo_get_job_attempts` and
`nesvo_get_job_attempt`. Coordinators and workers are refused; no ambient focused
session or parent metadata grants job authority. Clients check the capability.

Injected-clock SQLite tests cover future/absolute instants, grace/skip, overlap,
immutable occurrence profiles, exact-key replay, competing writers, reopen,
scope, transaction rollback and no writes/events on quiet ticks. A real native
SDK/CLI/host test closes all owner clients before due, observes a controlled worker
report, requires explicit validation, checks queued/manual behavior and actual
inline settings, validates real JSON envelopes and restarts without a duplicate
process. It uses original-shaped controlled executables, not a model.
A separate restart case reproduced a catch-up refusal while actual version
discovery was delayed, then passed with exactly one native attempt after the
startup gate. No automatic retry, relaxed profile or extra permission was used.

The once-job implementation added no production dependencies; the later calendar
adapter's three pinned packages and their purpose are documented in the
[calendar contract](harness-job-calendars.md). The TUI integration test adds a dev-only
reference to the already locked `chrono` used by the host, for exact future
RFC3339 timestamps and a before-disconnect assertion. It adds no new package and
does not put calendar I/O into rendering. Original-model job execution, interactive
job UI, native device behavior and the remaining stage-four features are not
certified by this fixture.
