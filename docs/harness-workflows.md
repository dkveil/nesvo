# Durable workflow plans

`workflowPlans:true` advertises host-owned draft plans. A **run** owns a goal and
a revisioned DAG; a **task** has a stable host ID and a caller-supplied key within
that run. These identities are separate from terminal sessions. This increment
does not dispatch attempts or infer results from terminal state. Attempt
execution, explicit results, validation and automatic scheduling remain
subsequent F14/F18/F20 gates.

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
cannot widen authority. Workers cannot read/edit plans yet; their eventual
result API needs an exact attempt grant. Owners retain access after coordinator
exit. Coordinator adoption and attempt recovery remain later work.

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
No attempt history exists in this increment.

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
`get {runId}`, `setPlan {key,runId,expectedRevision,tasks}`, `mutation {key}`.
Replies have `type:"workflow"` and either `{run,tasks}` or `{runs,nextOffset}`;
mutations add the committed domain `cursor`. `requestId` is not an idempotency key.

Runs begin at revision 1/state `draft`; replacing a plan increments the revision.
Tasks report state `planned`, dependency state `ready|waiting`, attempts `0`
and `taskResult:null`. Dependency readiness does not imply process readiness,
an attempt, response completion or validated success.

Run, tasks, mutation outcome and domain event commit atomically through the
existing bounded SQLite journal actor. A response is announced after commit;
no native effect occurs in the transaction. A lost response does not cancel
the commit: recover its original key or repeat the identical request/key.
Reused keys with different requests return `idempotency_conflict`; stale edits
return `revision_conflict`, without partial replacement. Historical replay returns
the original view; `run get` reads the current state.

Workflow mutation keys are private to the authenticated issuer and have a
separate namespace from native operation receipts. `nesvo operation` cannot
recover metadata mutations. Future attempt dispatch must retain native receipts
for uncertain process effects; a metadata commit is not a native acknowledgement.

Limits: 64 tasks, 256 dependency edges and 24 KiB serialized task specs per plan;
titles 80 UTF-8 bytes, instructions/goals 8192 bytes, task keys 1–64 ASCII
alphanumeric/underscore/hyphen, mutation keys 1–128 bytes without controls.
CLI/MCP bound their complete request to 24 KiB; resolved views have a 40 KiB cap.
Cycles, duplicate/self/missing edges, duplicate keys, invalid controls and
oversized input are rejected. File reads are bounded during decoding.

Lists return 16 summaries per page, omitting goals/instructions. Storage caps:
1024 retained runs, 4096 metadata mutations. Exhaustion returns explicit `busy`;
accepted keys remain recoverable. No silent eviction/replay. Export/retention
controls remain recovery work. Routine domain events contain only run ID/revision
and an authorized coordinator subject, without goals/instructions.

## Verification

Storage tests cover invalid DAGs, atomic rollback/revisions, replay/conflicts,
stable IDs, scope isolation, pagination, event privacy and reopen durability.
Native SDK checks cover MCP-to-CLI recovery through an isolated host and real
coordinator/worker capabilities. CLI integration covers literal Unicode files,
edits, malformed-file rejection and unchanged native sessions. These tests make
no model calls; passing the draft API does not pass the stage-3 execution gate.
