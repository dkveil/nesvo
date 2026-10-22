# Attempt-bound questions and decisions

`workflowDecisions:true` adds durable questions addressed to the run coordinator
or explicit human owner. Each decision belongs to one task and exact worker
attempt, with its own revision, deadline, answer/cancellation and authenticated
responder. A task's successful report requires all its decisions answered.
Questions, native provider permission dialogs and task validation are separate
contracts; answering one never grants blanket permission for other operations.

Assigned workers may ask and receive answers while a run is `draining`, so an
existing assignment can finish without reopening new admissions. The same
audience, revision and success gates apply. Drain never answers a question.

## CLI and MCP

Inside the authenticated worker:

```powershell
nesvo run context --json
nesvo run decision ask ATTEMPT_ID --key question-1 --audience owner --question-file question.txt --timeout-ms 300000 --json
nesvo run mutation --key question-1 --json
nesvo run decision get RUN_ID DECISION_ID --json
nesvo run decision list RUN_ID --json
```

The CLI defaults to audience `owner` and a five-minute deadline. `coordinator`
explicitly allows that run's coordinator or the owner to answer. A worker can
read only its own current attempt's questions and cannot answer itself. Its
attempt identity comes from `run context`, never names, UI focus or supplied
role hints. A coordinator cannot answer or cancel an owner-only question.

The addressed authority records an answer at the **decision** revision:

```powershell
nesvo run decision answer RUN_ID DECISION_ID --key answer-1 --revision DECISION_REV --answer-file answer.txt --json
nesvo run decision cancel RUN_ID DECISION_ID --key cancel-1 --revision DECISION_REV --reason "Cannot continue" --json
```

Ask/answer accept a literal `--question`/`--answer` instead of a UTF-8 file.
`list` takes `--attempt ATTEMPT_ID` and `--offset N`; parents can inspect retained
history in their run. A worker may withdraw its own question, including one
addressed to the owner. Cancellation retains its reason and is not approval.

MCP tools: `nesvo_ask_decision`, `nesvo_list_decisions`, `nesvo_get_decision`,
`nesvo_answer_decision`, `nesvo_cancel_decision`. They use the same host authority,
keys, files/text bounds and revisions as the CLI. An unsupported host is refused
without a fallback. Launch-local instruction version 4 explains these operations;
existing native processes retain the instruction snapshot they actually launched.

## Lifecycle and atomic delivery

Only an active run's current assigned worker can ask. One pending question per
attempt is allowed. State is `pending → answered|canceled|expired`; a resolved
record is immutable except for identical-key historical replay. An answer or
explicit cancellation requires the exact current decision revision and attempt.
It cannot be applied to a newer attempt or overwrite another responder.

A question and its coordinator inbox notice commit together. Answer/cancel and
the receiving worker's notice also commit together. The host-reserved message
kind `decision` carries decision/task/attempt IDs, audience and state. ACKing a
notice only confirms handled delivery. Parent notices for owner-only questions
allow coordination but do not authorize the parent to answer. Full inbox/storage
capacity rejects the whole mutation, leaving no accepted answer with a lost notice.

Pending, canceled or expired decisions block a `succeeded` worker report.
Non-success reporting closes still-pending decisions as canceled/expired in the
same result transaction. After cancellation/expiry, deliberate validation and a
fresh worker attempt are required to retry; asking another question cannot erase
that history. An answered question permits reporting but does not validate work
or release DAG dependencies. Ordinary independent result validation still applies.

Deadlines are persisted absolute host timestamps, between one second and seven
days. An authorized decision read or mutation materializes due expirations before
the requested action. Expiration commits independently of a rejected late answer;
once observed, restart or clock rollback cannot restore pending state. Passive
attempt summaries expose stored pending/unresolved counts and `blocksSuccess`;
use decision get/list for current deadlines. There is no background timer, timeout
model call or repeated native input. Unobserved deadlines depend on the host
wall clock; scheduler clock/sleep policy is separate F22 work. Automatic timeout
notifications remain open. The separate opt-in [wake policy](harness-wakes.md)
can coalesce durable decision notices and current worker blocker changes.

An expired decision remains readable. Expiration stores a terminal state/event
without requiring inbox capacity, so a full inbox cannot extend its validity.
No body is copied to routine domain events. Full question/answer data stays in
authorized retained records and inbox notices, under existing filesystem limits.

## Recovery, wire and bounds

Ask/answer/cancel use the **workflow mutation namespace**, recovered with
`run mutation --key ORIGINAL_KEY`. They do not increment execution/run revisions.
Repeating the identical request/key returns its original committed outcome;
different intent under the key is rejected. A replayed pending view is historical,
not a renewed deadline: get the current decision separately. Worker recovery
still checks the exact current-attempt fence after retry. Native operation
receipts remain a separate namespace and are not replaced by decision records.

The existing `workflow` envelope carries
`request:{action:"decision",request:{action:...}}`. Nested actions:

- `ask {key,attemptId,audience,question,timeoutMs}`;
- `list {runId,attemptId?,offset?}`;
- `get {runId,decisionId}`;
- `answer {key,runId,decisionId,expectedRevision,answer}`;
- `cancel {key,runId,decisionId,expectedRevision,reason}`.

Replies contain `run,task:{id},attempt:{id},decision`, plus committed domain
`cursor` for keyed mutations. Lists contain `run,decisions,nextOffset`, with an
own-attempt hint for workers/filtered reads. `decision` records include bound
identities, audience, question, creation/deadline, revision/state, askedBy,
answer/reason and resolvedAt/resolvedBy. Transport `requestId` is not a key.

Text is nonempty, at most 2048 UTF-8 bytes and 3072 JSON-encoded bytes, without
terminal controls except CR/LF/tab. Key bounds follow the workflow contract.
Lists return eight records per page. Retention is 16 decisions per attempt and
4096 globally, with explicit capacity failure and no silent eviction. No new
dependency or change to global provider configuration is introduced.

## Verification and remaining gates

Storage checks cover authority, result gating independent of ACK, exact revisions,
same-key replay, deadline/reopen/clock rollback, cancellation, stale worker fences,
atomic inbox failures, literal/encoded limits, pagination and event privacy.
The controlled native SDK fixture asks through the worker's actual CLI, denies
coordinator/self answers to owner questions, answers through owner MCP, recovers
the original CLI key and checks unchanged PTY output. It makes no model calls.

These are workflow decisions, with no native permission bridge. The host does
not suspend a running process, enforce an OS sandbox or interpret answer text as
instructions. [Native task delivery](harness-task-delivery.md) applies decision
gates before input; [wake batching](harness-wakes.md) never answers a decision.
The TUI Runs view (`W`) answers the selected run's first pending decision, and the
mobile Decisions screen answers owner decisions across runs one revision at a time;
neither has an interactive or device acceptance run yet.
Real-provider model-driven escalation remains an explicit stage-3 acceptance gap.
