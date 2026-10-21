# Durable workflow plans

`workflowPlans:true` advertises host-owned draft plans. A **run** owns a goal and
a revisioned DAG; a **task** has a stable host ID and a caller-supplied key within
that run. An **attempt** binds exactly one managed worker process to a task.
`workflowAttempts:true` adds assignment, explicit worker results and owner/
coordinator validation. [Attempt-bound decisions](harness-decisions.md) add
explicit questions without granting native permission approval. [Run admission
budgets and drain](harness-run-budgets.md) preserve native work and human priority.
[Atomic task launch](harness-task-launch.md) reserves attempts and native create
identities before starting a worker. [Native run controls](harness-run-controls.md) add explicit stop/cancel with
per-target receipts and observed exit. [Task instruction delivery](harness-task-delivery.md)
adds an explicit bounded readiness wait after assignment. The opt-in
[host executor](harness-executor.md) selects dependency-ready tasks; the separate
[wake policy](harness-wakes.md) groups new coordinator notices. Both default to
no automatic action until explicitly enabled.
Idle never means success.

The [checkpoint/constraint contract](harness-checkpoints.md) preserves goal,
plan and evidence pointers for context reconstruction. Manually added owner
constraints pause future automation; acknowledging their exact revision does
not rearm old input or validate work. Current context always uses latest owner
text, even when an older checkpoint is supplied as a baseline.

## CLI and MCP

```powershell
nesvo run create "Feature review" --key feature-run --goal-file goal.txt --json
nesvo run plan RUN_ID --key feature-plan --revision 1 --file plan.json --json
nesvo run get RUN_ID --json
nesvo run list --offset 0 --json
nesvo run mutation --key feature-plan --json
```

Create accepts `--goal TEXT` instead of a UTF-8 file, and optional
`--coordinator SESSION_ID`. This must identify a live coordinator process.
A scoped coordinator is always bound to itself; client role/parent metadata
cannot widen authority. Workers access only their current attempt/result, never
other tasks or the coordinator's plan. Owners retain access after coordinator
exit. Coordinator adoption and live process recovery remain later work.

Equivalent MCP tools: `nesvo_create_run`, `nesvo_list_runs`, `nesvo_get_run`,
`nesvo_set_run_plan`, `nesvo_get_run_mutation`. Both adapters use the same host
revisions/keys. Unsupported hosts fail without a legacy fallback.

`plan.json` is a task array; dependencies refer to **keys**, never titles:

```json
[
  { "key": "implement", "title": "Implement", "instruction": "Produce an explicit result" },
  {
    "key": "review",
    "title": "Review",
    "instruction": "Validate the implementation",
    "dependencies": ["implement"]
  }
]
```

The returned view resolves dependencies to stable **host task IDs**. Editing
titles or reordering retains IDs while keys remain in the plan. Removing and
reintroducing a key in a later draft creates a new ID; re-read the projection.
Once activated, the plan cannot be replaced. Previous attempts are retained.
Run/attempt mailboxes and result notices use the [durable inbox](harness-inbox.md).
Workers access their own mailbox and can message their coordinator, without
reading other tasks or changing the plan.

## Templates from nesvo.toml

`workflowTemplates:true` advertises run templates committed in a repository's
`nesvo.toml`, next to the [worktree setup](harness-cli.md) table. A template adds
no run semantics: starting it only calls the existing create, plan, budget,
activate and executor commands with derived keys.

```toml
[[workflow]]
name = "review"                # 1-64 letters, digits, '_' or '-'; unique
title = "Branch review"        # optional, defaults to name; 80 bytes
goal = "Review the branch and report blocking issues"
start = "active"               # draft (default) | active | executor
max_parallel = 2               # optional run budget, 1-16 (default 8)
max_attempts_per_task = 3      # optional, 1-16 (default 16)
max_elapsed_ms = 1_800_000     # optional, 1000-604800000 (default unlimited)

[[workflow.task]]
key = "implement"
title = "Implement"            # optional, defaults to key
instruction = "Implement the change and report evidence"
program = "claude"             # claude | codex | gemini
workspace = "worktree"         # shared | worktree
harness = true                 # optional
allowed_nesvo_tools = ["nesvo_get_current_task", "nesvo_report_task_result"]
checks = ["cargo test --locked"] # optional host-run checks, see below

[[workflow.task]]
key = "review"
instruction = "Validate the implementation"
depends_on = ["implement"]
program = "codex"
workspace = "shared"
```

The same strict subset parser as the worktree table reads `HEAD:nesvo.toml`
(never uncommitted edits); booleans are accepted for `harness`. At most 32
templates and 64 tasks each; instructions and goals are 8192 bytes. A task declares
at most 8 `checks`, each a nonempty single-line command of at most 256 bytes for the
platform shell. Unknown keys or tables, duplicate names or keys, missing, self or
duplicate dependencies and cycles are refused with `workflow_templates_invalid` and a
line number. The worktree setup ignores `[[workflow]]` entries and keeps its own digest.

The template digest is the SHA-256 of the normalized templates, so formatting and
comments do not change it; declared `checks` are part of it, a template without
checks keeps its earlier digest. Approval follows the worktree setup flow: it is an
owner CLI act stored in `workflow-templates.json` next to the host pairing data, and a
changed template needs a new approval.

```powershell
nesvo workflow templates --directory C:\project --json
nesvo workflow approve-templates --directory C:\project --digest INSPECTED_DIGEST --json
nesvo workflow revoke-templates --directory C:\project --digest INSPECTED_DIGEST --json
nesvo workflow start review --directory C:\project --key review-1 --json
```

Wire commands are `listWorkflowTemplates {directory}` →
`workflowTemplates {repository, source, configured, digest, approved, templates}`,
`approveWorkflowTemplates {directory, digest}` →
`workflowTemplatesApproved {repository, digest, approvedAt}` (`digest_mismatch`
when HEAD changed), `revokeWorkflowTemplates {directory, digest}` →
`workflowTemplatesRevoked {repository, digest, revoked}` and
`startWorkflowTemplate {directory, name, key}` →
`workflowTemplateStarted {template, digest, key, start, run, tasks, profiles, executor}`.
All four are owner-only; session-scoped and wake callers receive `forbidden`.

Start re-reads HEAD and refuses `workflow_templates_unapproved` when the current
digest is not approved, or `workflow_template_not_found`. It then creates a
coordinatorless draft run (`KEY/create`), sets the plan (`KEY/plan`), replaces the
run budget when the template declares one (`KEY/budget`), activates for
`active|executor` (`KEY/activate`) and, for `executor`, starts the
[host executor](harness-executor.md) with each task's profile (`KEY/executor`), with
the repository root as `cwd`. `profiles` maps every host task ID to that profile,
ready for `run launch` or `run executor start` on a draft or active run. Repeating
the same key replays each step; a changed template under an old key fails with
`idempotency_conflict` at the first changed step, and each step can be recovered with
`run mutation --key KEY/STEP`. The start key is 1-96 bytes. When the template declares
`checks`, start also records the run ID with the repository, template name, approved
digest and each task's checks in `workflow-templates.json` (newest 1024 runs); host
checks later run those recorded commands, never a re-read or agent-edited file.

MCP exposes `nesvo_list_workflow_templates` and `nesvo_start_workflow_template`
with the same owner-only semantics; there is no approval or revocation tool. The
TUI Runs view (`W`) lists runs with tasks, attempts, inbox and pending decisions,
pauses (run stop), resumes, drains and answers decisions through the existing
commands, and starts approved templates from its "Start from template" row.

## Attempts and result validation

```powershell
nesvo run activate RUN_ID --key activate --revision REV --json
nesvo run assign RUN_ID --task TASK_ID --session WORKER_ID --key assign --revision REV --json
nesvo run task RUN_ID TASK_ID --offset 0 --json
```

Assignment requires a live worker, with no human controller, unresolved draft
or pending submission. Coordinators can use only host-granted worker children.
Only tasks with accepted dependencies are eligible. Assignment neither creates
a process nor sends input. Create a fresh worker without an initial prompt,
assign it, then deliberately send the instruction through the ordinary guarded
session API. Native operation receipts remain responsible for uncertain effects.

Inside the authenticated worker, `nesvo run context --json` returns its own
task/attempt binding. `nesvo run report ATTEMPT_ID --key KEY --file RESULT.json
--json` stores its first explicit result. `RESULT.json` requires:

```json
{
  "outcome": "succeeded",
  "summary": "Description of actual work and evidence",
  "files": ["src/example.rs"],
  "artifacts": [],
  "checks": [{ "name": "unit", "outcome": "passed", "details": "Actual command/result" }],
  "limitations": ["Any unverified behavior"]
}
```

Outcomes: `succeeded|failed|blocked|canceled`; check outcomes:
`passed|failed|skipped`. File/artifact/check claims are not host-verified
provenance. Result bound: 4 KiB, summary 2048 bytes, 32 files, 16 artifacts,
checks and limitations; list text 1024 bytes, check name 128 bytes. Use empty
arrays when none apply, without fabricating performed checks.

Only an owner/coordinator can validate the current reported attempt:
`nesvo run validate RUN_ID ATTEMPT_ID --key KEY --revision REV --file VALIDATION.json
--json`. Validation is `{passed,summary,checks}` within 2 KiB, with a 1024-byte
summary. Success requires a succeeded report and nonempty passed validation
checks. The host records explicit `ownerAttestation|coordinatorAttestation`, not
execution of those checks. Workers cannot validate themselves. Add `--host-checks`
to have the host run the task's approved checks first (see below); revision-bound
evidence remains F35 work.

Attempt state: `assigned → reported → succeeded|failed`. A reported success
still has `taskResult:null` until accepted. Accepted results release dependents;
all accepted tasks mark the run succeeded, without terminating processes.
A rejected attempt permits a fresh worker/retry. A process owns only one
attempt; previous results remain immutable. Late results from superseded
attempts return `stale_attempt`, without changing the current task.

Additional MCP tools: `nesvo_activate_run`, `nesvo_assign_task`,
`nesvo_get_task_attempts`, `nesvo_get_current_task`, `nesvo_report_task_result`,
`nesvo_validate_task_result`. Task history pages contain four attempts and a
`nextOffset`; context replies include only the bound task/current attempt.

## Host-run checks

```powershell
nesvo run validate RUN_ID ATTEMPT_ID --key KEY --revision REV --file VALIDATION.json --host-checks --json
```

`workflowHostChecks:true` advertises this. Before the validation transaction, the
host runs the `checks` recorded for the attempt's task when its run was started from
an approved template, inside the worker's host-created worktree, through the same
step containment as [worktree setup and run](harness-cli.md#worktree-setup-run-and-archive):
platform shell, no `NESVO_*`/`POCKET_*` variables, a kill-on-close job on Windows and
a process group on Unix, one of the four shared step slots and the worktree's busy
fence (a concurrent setup, run or archive returns `busy`; `nesvo worktree cancel
SESSION_ID` cancels the checks). All checks share the approved setup `timeout_s`
(600 s without a declared setup). Checks run in order; after a timeout or
cancellation the remaining ones are `skipped`. Full output goes to
`.nesvo/checks.log` in the worktree (64 KiB).

The validation then commits `attempt.validation.hostChecks`, also returned as the
reply's `hostChecks`:

```json
{
  "source": "hostAttestation",
  "attemptId": "ATTEMPT_ID",
  "sessionId": "WORKER_ID",
  "taskKey": "implement",
  "template": "review",
  "digest": "TEMPLATE_DIGEST",
  "worktree": "C:/worktrees/WORKER_ID",
  "log": "C:/worktrees/WORKER_ID/.nesvo/checks.log",
  "passed": false,
  "startedAt": 1761120000000,
  "finishedAt": 1761120004200,
  "checks": [
    {
      "index": 0,
      "command": "cargo test --locked",
      "outcome": "failed",
      "exitCode": 101,
      "durationMs": 4100,
      "tail": "test result: FAILED. 1 failed\n",
      "tailTruncated": true
    }
  ]
}
```

Check outcomes are `passed|failed|timedOut|cancelled|skipped`; `exitCode` is null when
no exit was observed. `tail` is the last 512 bytes of the check's output, lossy
UTF-8 with carriage returns removed and other control characters shown as `?`; it
never exceeds that bound. This attestation is separate from the worker's claimed
`result.checks` and from the owner's or coordinator's own `checks`. With host checks
the caller's `checks` may be empty. `passed:true` becomes `succeeded` only when every
host check passed; otherwise the attempt is `failed`, the evidence keeps the caller's
`passed:true` and adds `refusedBy:"hostChecks"`, and dependents stay blocked.

Refusals happen before any check runs and record nothing: `host_checks_unavailable`
when the worker has no host-created worktree or the run was not started from a
template of that repository that declares checks, `host_checks_missing` when the
task declares none, `workflow_templates_unapproved` when the recorded template digest
is no longer approved, `worktree_setup_unapproved` when the worktree's recorded setup
digest was revoked or no longer matches its saved config, `worktree_not_prepared`
before a passed setup. Approval stays the owner CLI act described above. A repeated
key replays the committed reply without running the checks again; a refused or lost
transaction after the checks ran records nothing, so repeat the same key. A
validation request with `hostChecks:true` that bypasses this runner, or whose
attestation names another attempt or worker, fails with `host_checks_unavailable`;
clients cannot supply an attestation. The checks run approved command strings, not
reviewed scripts: an agent can change what `cargo test` or `npm run lint` executes
inside its worktree.

MCP parity: `nesvo_validate_task_result` accepts `hostChecks:true` with the same
semantics and key namespace as the CLI flag. Older hosts fail the capability check
instead of recording an attestation-only validation.

## Wire and persistence

Authenticated requests use the nested envelope:

```json
{
  "type": "workflow",
  "requestId": "transport-correlation",
  "request": {
    "action": "setPlan",
    "key": "feature-plan",
    "runId": "STABLE_RUN_ID",
    "expectedRevision": 1,
    "tasks": []
  }
}
```

Actions: `create {key,spec:{title,goal,coordinatorSessionId?}}`, `list {offset?}`,
`get {runId}`, `setPlan {key,runId,expectedRevision,tasks}`, `mutation {key}`,
`activate {key,runId,expectedRevision}`,
`assign {key,runId,taskId,sessionId,expectedRevision}`,
`task {runId,taskId,offset?}`, `context {}`,
`report {key,attemptId,result}`,
`validate {key,runId,attemptId,expectedRevision,validation,hostChecks?}`.
Replies have `type:"workflow"` and `{run,tasks}`, `{runs,nextOffset}`,
`{run,task,attempt}`, or `{run,task,attempts,nextOffset}`;
mutations add the committed domain `cursor`. `requestId` is not an idempotency key.

Runs begin at revision 1/state `draft`; plan/execution mutations increment the
revision. Inbox send/ACK and decision actions have their own message/domain
cursors and decision revisions; they do not alter the execution revision.
Activation changes state to `active`. Workers report against their exact current
attempt, without overwriting concurrent results; coordinator mutations require
the current revision. Tasks expose dependency state `ready|waiting`, attempt
count/current summary and a separate validated `taskResult`. Dependency
eligibility does not imply process readiness or native dispatch.

Run, tasks, mutation outcome and domain event commit atomically through the
existing bounded SQLite journal actor. A response is announced after commit;
no native effect occurs in the transaction. A lost response does not cancel
the commit: recover its original key or repeat the identical request/key.
Reused keys with different requests return `idempotency_conflict`; stale edits
return `revision_conflict`, without partial replacement. Historical replay returns
the original view; `run get` reads the current state. Assignment rechecks native
preconditions, so prefer `run mutation` when recovering its historical outcome.
Worker recovery still checks the current attempt fence; it cannot resurrect an
old attempt after a retry.

Workflow mutation keys are private to the authenticated issuer and have a
separate namespace from native operation receipts. `nesvo operation` cannot
recover metadata mutations. Future attempt dispatch must retain native receipts
for uncertain process effects; a metadata commit is not a native acknowledgement.

Limits: 64 tasks, 256 dependency edges and 24 KiB serialized task specs per plan;
titles 80 UTF-8 bytes, instructions/goals 8192 bytes, task keys 1–64 ASCII
alphanumeric/underscore/hyphen, mutation keys 1–128 bytes without controls.
CLI/MCP bound their complete request to 24 KiB; resolved views have a 64 KiB cap.
Cycles, duplicate/self/missing edges, duplicate keys, invalid controls and
oversized input are rejected. File reads are bounded during decoding.

Lists return 16 summaries per page, omitting goals/instructions. Storage caps:
1024 retained runs, 4096 metadata mutations/attempts, 16 attempts per task.
These are storage safety bounds; configurable parallel/retry/time policy is
separate and never exceeds them. Storage exhaustion returns `busy`; the default
16-attempt policy returns `retry_budget_exhausted` at its boundary.
accepted keys remain recoverable. No silent eviction/replay. Export/retention
controls remain recovery work. Routine domain events contain only run ID/revision
and an authorized coordinator subject, without goals/instructions.

## Verification

Storage tests cover invalid DAGs, atomic rollback/revisions, replay/conflicts,
stable IDs, scope isolation, pagination, event privacy and reopen durability.
Native SDK checks cover MCP-to-CLI recovery through an isolated host and real
coordinator/worker capabilities. CLI integration covers literal Unicode files,
edits, malformed-file rejection and unchanged native sessions. These tests make
no model calls. Controlled native workers also discover/report their own task
through the actual CLI; independent coordinator validation releases a reviewer
task. Reopen/late-result/history tests cover retry fences. Host-check tests run
process-fixture checks that pass, fail and time out in a worktree, refuse unapproved
or changed digests and tasks without checks, keep tails within their bound and fail
closed without a host attestation. This does not pass
the full stage-3 gate: actual provider escalation, decision UI, coordinator adoption
and unknown-process recovery remain open. [Opt-in host execution](harness-executor.md)
now supplies automatic DAG selection with explicit native profiles and retained
result/validation gates; these manual metadata APIs do not enable it implicitly.
