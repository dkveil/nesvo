# Durable workflow inbox

`workflowInbox:true` adds addressed messages to the existing authenticated
workflow API. Messages belong to a durable run, with one coordinator mailbox
and one mailbox per worker attempt. These are retained host records, not terminal
input. Reading, sending and acknowledging never dispatch a prompt, approve a
permission request, validate a result or wake a model.

## CLI and MCP

```powershell
nesvo run inbox read RUN_ID --json
nesvo run inbox send RUN_ID --key note-1 --correlation TASK_ID --message-file note.txt --json
nesvo run inbox send RUN_ID --attempt ATTEMPT_ID --key question-1 --correlation TASK_ID --kind question --message "Please clarify the result" --json
nesvo run inbox ack RUN_ID MESSAGE_ID --json
nesvo run mutation --key note-1 --json
```

The MCP equivalents are `nesvo_read_inbox`, `nesvo_send_message` and
`nesvo_ack_messages`. They share host authorization and state with the CLI.
Read accepts `--after CURSOR`, `--include-acked` and `--attempt ATTEMPT_ID`.
Send requires one literal `--message` or bounded UTF-8 `--message-file`, a stable
key and a correlation ID. Manual kinds are `note|question|error`; `result` is
reserved for the host's attempt-result notification. Message text is untrusted
context and cannot grant API authority or answer a permission gate.

Without `--attempt`, an owner/coordinator reads or ACKs the coordinator mailbox;
a worker reads or ACKs its own current attempt. An omitted send target addresses
the coordinator. Workers may send only to their own run's coordinator. Owners
and the authenticated run coordinator can send to a current attempt in that run.
They can inspect retained attempt mailboxes; only the receiving worker or an
explicit human owner can ACK a worker mailbox. A coordinator cannot consume a
worker's messages on its behalf. Superseded workers lose context, mailbox and
metadata-recovery access through the existing current-attempt fence.

The host derives sender role, process and attempt identity from authentication.
No sender field or UI selection grants authority. A coordinator process exit
revokes its capability; the run mailbox and pending messages remain readable by
the owner. Replacement-coordinator adoption remains F41 work.

## Delivery, recovery and exact ACK

A read returns `run`, `mailbox`, `messages`, `nextCursor`, `headCursor`, `more`
and `pendingCount`. A worker also receives its own `attempt.id`. Each message has
a stable ID, monotonically ordered `sequence`, run/recipient identity, trusted
sender identity, caller correlation ID, kind, literal body, optional result
payload, creation time and first ACK identity/time. Sequence establishes order;
wall-clock time is informational. Domain-event cursors and inbox sequences are
different cursor spaces.

Read pending messages from zero after a consumer restart. Use `nextCursor` only
to continue a bounded read traversal. Moving past a message does not acknowledge
it: `pendingCount` includes older unacknowledged messages. `--include-acked`
includes retained history. A cursor ahead of that mailbox's head is rejected.

Reconcile each delivered ID against current task/attempt state and existing
operation receipts. Only after durable handling, ACK the exact IDs handled.
`ack` accepts 1–32 distinct IDs and validates the entire batch before writing.
It cannot sweep unread messages, ACK by cursor or partially ACK a batch containing
an unavailable ID. New arrivals remain pending. A repeated ACK retains the first
`ackedAt` and `ackedBy`; retrying those same IDs after a lost reply is safe.
ACK is naturally idempotent and needs no new mutation key. It remains available
when retained-message or metadata-mutation capacity is full.

Send stores its message, domain event and keyed metadata outcome atomically.
Recover a lost send reply with **`run mutation --key ORIGINAL_KEY`**, or repeat
the identical request/key. This is separate from native `operation --key` receipt
recovery. A different request under the same key is rejected. Recovery rechecks
run/current-worker authority and never sends a second message or native input.
Inbox send/ACK do not increment the run's execution revision.

The first accepted worker report inserts one `result` notification in the same
SQLite transaction as its report and mutation outcome. Its payload references
the actual task, attempt and reported outcome. Report replay cannot insert a
duplicate. A full inbox rolls back the report instead of accepting a result with
a lost notification. ACKing this notice leaves the task merely reported until
the separate authorized validation API accepts it. A stale notice cannot validate
a newer attempt, and native idle is never task success.

## Wire and bounds

The existing `workflow` envelope carries nested inbox actions:

```json
{
  "type": "workflow",
  "requestId": "transport-correlation",
  "request": {
    "action": "inbox",
    "request": { "action": "read", "runId": "RUN_ID" }
  }
}
```

Nested actions are `read {runId,attemptId?,after?,includeAcked?}`,
`send {key,runId,attemptId?,correlationId,kind?,body}` and
`ack {runId,attemptId?,ids}`. Replies use `type:"workflow"`, with the base
run/mailbox identity and either the read page, `message,cursor`, or
`acknowledged:[{id,ackedAt,ackedBy}],cursor`. Send/ACK cursors are committed
domain-event cursors. `requestId` is transport correlation, not a mutation key.

Bodies are nonempty and at most 4096 UTF-8 bytes. Terminal controls other than
CR/LF/tab are rejected. Encoded immutable message data is capped at 6 KiB;
escaping can therefore reject some bodies within the raw-byte bound. Keys and
correlation IDs are 1–128 bytes without controls. Reads return eight messages
per page, and the retained-message cap is 8192 across the journal. Limits fail
explicitly; nothing is silently pruned or auto-ACKed. Export/retention policy
remains F41 work. No new dependency, polling task or model call is introduced.

Routine domain events contain message IDs/counts and run identity, without the
body. Full content lives in the authorized inbox store, subject to the same
same-account filesystem limitations as the host's other private records.

## Verification and remaining work

Storage tests cover reopen durability, first-ACK preservation, new arrivals,
pagination, atomic invalid batches, sender/scope isolation, stale attempt fences,
result/notification atomicity, explicit capacity failures and body/event bounds.
CLI integration validates literal Unicode files, schema output, replay/recovery,
ACK retry and unchanged run revisions/native session sets.

The native SDK fixture uses an isolated host, private contexts, real MCP/CLI
subprocesses and controlled Claude-compatible PTYs, without model calls. It
restarts an MCP consumer, leaves a result pending while the coordinator is
working, checks that inbox delivery does not alter terminal replay, and confirms
owner access after coordinator exit. These checks do not establish production
provider/model orchestration or full native-process recovery. Automatic native
dispatch/wakes (F14/F26), approval decisions (F19), replacement-process adoption
(F41) and TUI/mobile inbox views remain separate work.
