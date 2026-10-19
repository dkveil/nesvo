# Durable session operations

The host advertises `operationReceipts:true` when its durable event worker is
available. This is additive to protocol v2; legacy `create`/`launch` requests keep
their existing behavior and do not gain idempotency automatically.

## Commands and acknowledgements

An authenticated owner sends:

```json
{
  "type": "createOperation",
  "key": "my-workflow-attempt-1",
  "requestId": "transport-correlation",
  "spec": { "name": "Review", "program": "claude", "prompt": "Review this checkout" }
}
```

`spec` uses the existing advanced launch contract. Prompt and command arguments
stay literal. The host validates folder/group/provider/capacity and uses the same
native launch engine as TUI/schedules. Worktree creation runs outside the host
state mutex. No model API, shell-concatenated command or extra session engine is
introduced. A background launch does not acquire a control lease or move UI focus.

The result is `{type:"operation",receipt:{id,operation,phase,sessionId,result}}`.
`sessionId` is reserved durably before any effect; it is not proof of a running
process until the phase/result says so. Phases:

| Phase       | Meaning                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| accepted    | Intent and reservation committed; effect has not been claimed yet                                  |
| dispatching | One claim committed before attempting native/Git effects                                           |
| created     | Native process and recovery metadata were created; agent readiness and task result remain separate |
| failed      | Launch validation rejected before effects; `result.effectStarted:false`                            |
| unknown     | An effect may have happened but the final outcome was not confirmed                                |

Success means historical process creation, not that the process is still alive,
the agent accepted its prompt or the task succeeded. Fetch the session/lifecycle
separately. A later exit or explicit close does not erase the receipt.

## Idempotency, scope and lookup

Keys are 1–128 UTF-8 bytes without control characters, namespaced by authenticated
caller identity. Owner devices deliberately share the owner namespace, including
across reconnect. Repeating the same normalized launch spec and key returns the
same receipt and reserved session; concurrent requests cannot claim it twice.
Reusing a key for a different spec returns `idempotency_conflict`. Use a key per
intended attempt, not a name generated anew on every timeout.

`getOperation` takes exactly one `id` or `key`. A key lookup is always within the
caller's namespace. ID lookup is restricted by issuer unless owner-authorized.
It returns `{type:"operation",receipt,cursor}` with receipt and event cursor read
in one SQLite snapshot. Register a domain stream first, then read the receipt and
consume events after that cursor; fast completion cannot disappear between them.
`operation.changed` records include operation ID/type/phase and reserved session
subject. They never include the original prompt or tool arguments.

The initial managed-process capability cannot create a process. It can only look
up receipts in its own issuer namespace; guessing another operation ID reveals
neither the receipt nor its existence. Coordinator/child grants are subsequent
F11/F12 delivery. Explicit owner pairing is for the human, never for workers.

## Crash and timeout semantics

Receipt mutations and their events commit in one transaction on the existing
private SQLite database. SHA-256 fingerprints compare normalized request bytes;
the receipt does not store the prompt/request body. The direct `ring 0.17.14`
dependency reuses the version already locked by TLS; no new cryptographic format
or independently implemented hash is introduced.

The bounded worker admits at most 256 outstanding intents, and a connection has
four concurrent operation/event read slots. Final receipts are retained for
idempotency across restarts; deleting them would permit an old key to run again.
There is currently no receipt deletion/compaction API. Storage failures increment
the journal health counter and never produce a false confirmed receipt.

Disconnecting a client does not cancel an already accepted owner intent. If a
response is lost or a request times out, **look up the same key before retrying**.
On host restart, unsettled accepted/dispatching receipts become `unknown` with a
restart reason and an atomic event. They are never redispatched automatically.
A stale process claim cannot write a later result. Inspect live sessions/recovery
and any created worktree before deliberately starting a new attempt/key.

If native startup fails after worktree creation, the worktree is preserved for
inspection. A process whose recovery write fails is killed and cleaned up rather
than becoming an untracked background PTY. Initial Windows cursor negotiation has
one owner in the stream decoder; prompted launches do not inject a second reply.

## Prompt submission and correlated wait

The additive `promptReceipts:true` capability enables owner-authorized
`sendOperation {key,sessionId,prompt}` and passive
`waitOperation {id|key,sessionId?,until?,timeoutMs?}`. Managed passive contexts
cannot send; wait/lookup can only see their issuer's receipts. CLI/MCP adapters
and coordinator grants are tracked separately from this host boundary.

Send accepts literal UTF-8 up to 8192 bytes and rejects terminal controls other
than line endings/tab. Multiline/tab input requires observed bracketed-paste
support. It never acquires control. A human controller, an unreconciled human
draft, an existing pending send, or an agent without ready/idle evidence blocks
submission. The host rechecks ownership, lifecycle generation and pending source
events immediately before each input chunk. Paste and Enter are separate writes;
human takeover between them cancels Enter. A queued/partial write with uncertain
outcome makes the editor unsafe for automatic reuse, including with a new key.
There is no automatic clear-draft/reconciliation command at this checkpoint.

Delivery acknowledges the actual native writer's complete write and flush, not
just queue admission. The durable send phases add:

| Phase       | Evidence                                                                |
| ----------- | ----------------------------------------------------------------------- |
| delivered   | Paste and submit were written/flushed; provider pickup is not implied   |
| received    | The launch-local provider hook observed the matching prompt             |
| started     | A subsequent provider tool event proves processing                      |
| waiting     | That correlated response needs a question, permission or quota decision |
| settled     | Provider Stop for that response; task result remains null               |
| interrupted | A newer prompt superseded the matched response                          |

The private Claude v2 journal records only a SHA-256 prompt fingerprint. Matching
normalizes line endings and surrounding whitespace; it does not rewrite sent
bytes. Correlation also fences launch, conversation generation and source
sequence. Unmatched prompts, child/foreign events, old idle/Stop and later
conversations cannot settle a send. Provider-specific pasted-content rewriting
may prevent matching and remains unconfirmed; it is never guessed into success.
An old journal without the fingerprint column stays compatible but advertises
no correlation. Other providers currently have no prompt-correlation adapter.

`until` is `delivered`, `received`, `started` or default `settled`. Wait uses the
receipt's exact operation/turn, registers before its transactional receipt read,
and rereads on journal notification. It catches already-finished fast responses
without polling or consulting the UI-focused session. Results contain the
receipt, cursor and `wait:{until,outcome,reached}`; outcome is `reached`, `timeout`
or a terminal phase. Timeout is 1–60000 ms (default 30000); 32 waits globally and
four journal operations per connection are allowed. Disconnect cancels only the
wait. Unsupported correlation returns `unsupported` rather than interpreting
idle as completion. No wait retries input or performs a model call.

Lifecycle transitions and their domain events commit atomically. A late native
write ACK merges its evidence without regressing a faster received/settled
response. Restart marks unresolved tracked sends unknown and never resends;
confirmed delivery-only receipts remain historical delivery. Failed/unknown
receipts are not authorization to submit a new key blindly. Job dispatch
deduplication, explicit worker results and provider coverage remain F17/F18/F28
gates; response settlement is never validated task success.

## Evidence

Native host/CLI integration covers concurrent same-key create from two clients,
one actual shell, no acquired input ownership, key conflict, failed validation,
lost reply/disconnect lookup, restart/replay without process resurrection, caller
scope rejection, Unicode and folder spaces. SQLite tests inject an event-write
failure to prove rollback, reject stale claim reuse and preserve unknown outcomes
across reopen. Tests use isolated hosts and no model calls.
