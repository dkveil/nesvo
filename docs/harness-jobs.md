# Durable host jobs

`durableJobs:true` and `jobScheduleKinds:["once","cron","rrule"]` advertise owner-only durable
definitions and separate occurrences. The host runs them without an open TUI or
phone. Fresh worker admission and instruction delivery use the existing
Run/Task/Attempt executor, native receipts, readiness, workspace, process budgets
and human-input guards. No model API keys or direct model calls are added.

Once and [recurring IANA calendars](harness-job-calendars.md) are available. Safe reuse,
prechecks, authenticated triggers, automatic retries, hard runtime timeout/cleanup,
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
substitute for run cancellation. A dedicated job-cancel adapter remains pending.

## Misfires and overlap

- `misfire:skip` accepts normal polling lateness up to five seconds; later due
  instants produce a retained skipped occurrence with `reason:missed_window`.
- `misfire:catchUp` accepts lateness within `graceMs` (default 60 seconds, maximum
  24 hours); it records a skip outside that window. There is no unlimited backlog.
- `overlap:skip` records a skip while an admitted occurrence for the same job is
  queued, dispatching, running, awaiting validation or awaiting reconciliation.
- `overlap:queue` retains at most one additional queued occurrence. Further
  admissions record `queue_full` skips. Queued intent is not reinterpreted as a
  new clock misfire when the preceding occurrence finishes. Native uncertainty
  blocks the queued occurrence until the original work is reconciled.

Recurring downtime coalesces to the latest eligible clock slot and exposes
`coalescedFromAt` when intermediate slots were merged. See the calendar contract
for DST, search bounds and durable calendar errors. `calendarState:exhausted`
means no more automatic terms; it does not mean the last worker succeeded.

At most eight due definitions are materialized per calendar/once pass and four queued occurrences are
claimed per host tick. Claims are transactional before native work. Definition,
occurrence and mutation retention are bounded (64, 4096 and 4096 respectively);
history is never silently discarded. Full occurrence retention stops new
admissions, while existing occurrence reconciliation can still proceed. Deletion/
archive policies and broader overlap modes remain future work.

## Outcomes and crash safety

`queued`, `dispatching`, `running`, `needsValidation` and `reconcile` are distinct
from terminal `succeeded`, `failed`, `skipped` and `canceled`. Process creation,
PTY silence and idle are never job success. A succeeded worker report still needs
an explicit matching result validation; the existing workflow rules require
passed checks. `maxElapsedMs` is the run's admission/input budget. It does not
claim a hard process timeout or automatic termination after a completed result.
Completed worker processes remain available for owner inspection and count toward
host process budgets until explicitly stopped/closed; cleanup policy is pending.

Each occurrence uses deterministic workflow keys prefixed
`job:JOB_ID:OCCURRENCE_ID` for `run`, `plan`, `budget`, `activate` and `executor`.
Its run pointer is persisted before native executor admission. A metadata failure
is retained as a refusal; an unconfirmed native dispatch requires reconciliation.
After restart, unfinished native claims are marked `reconcile`, never automatically
restarted. Retained results may still be inspected/validated. Unclaimed eligible
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
`nesvo_run_job_now`, `nesvo_get_job_history`, `nesvo_get_job_occurrence` and
`nesvo_get_job_mutation`. Coordinators and workers are refused; no ambient focused
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
