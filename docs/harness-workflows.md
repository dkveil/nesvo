# Durable workflow plans

`workflowPlans:true` advertises host-owned draft plans. A **run** owns a goal and
a revisioned DAG; a **task** has a stable host ID and a caller-supplied key within
that run. An **attempt** binds exactly one managed worker process to a task.
`workflowAttempts:true` adds assignment, explicit worker results and owner/
coordinator validation. Automatic native dispatch, configurable budgets,
cancellation and decision gates remain F14/F19/F20 work. Idle never means success.

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
execution of those checks. Workers cannot validate themselves. Host-run checks
and revision-bound evidence remain F35 work.

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
`validate {key,runId,attemptId,expectedRevision,validation}`.
Replies have `type:"workflow"` and `{run,tasks}`, `{runs,nextOffset}`,
`{run,task,attempt}`, or `{run,task,attempts,nextOffset}`;
mutations add the committed domain `cursor`. `requestId` is not an idempotency key.

Runs begin at revision 1/state `draft`; plan/execution mutations increment the
revision. Inbox send/ACK have their own message/domain cursors and do not alter
the execution revision.
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
These are storage safety bounds, not configurable execution budgets.
Exhaustion returns explicit `busy`;
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
task. Reopen/late-result/history tests cover retry fences. This does not pass
the full stage-3 gate: actual provider execution, decisions, coordinator adoption,
automatic dispatch and budget/cancel policy remain open.
