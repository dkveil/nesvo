# Durable launch operations

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

This checkpoint covers **create** receipts. Delivered/started prompt receipts,
turn-correlated wait, send/job deduplication and worker results are separate open
F17/F18/F28 gates. Do not interpret `created` as those acknowledgements.

## Evidence

Native host/CLI integration covers concurrent same-key create from two clients,
one actual shell, no acquired input ownership, key conflict, failed validation,
lost reply/disconnect lookup, restart/replay without process resurrection, caller
scope rejection, Unicode and folder spaces. SQLite tests inject an event-write
failure to prove rollback, reject stale claim reuse and preserve unknown outcomes
across reopen. Tests use isolated hosts and no model calls.
