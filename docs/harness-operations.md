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
cannot send; wait/lookup can only see their issuer's receipts. CLI and MCP use
this same host boundary. Coordinators may submit only to explicitly granted
children, with their live launch identity rechecked before each native chunk.
Owner-supplied parent metadata is not a grant. See [caller policy](harness-cli.md).

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

The lifecycle tick persists these phases before it projects the same events onto the
session, so a session never reads idle while its settled turn's receipt is still open.

Send-producer failures may add `result.submissionStage`:
`prepare`, `pasteFence`, `pasteFlush`, `pasteDelay`, `submitFence` or `submitFlush`.
Native writer confirmation distinguishes `native_write_timeout`,
`native_write_closed` and `native_write_failed` with fixed safe messages. These
codes identify missing/failed write evidence, not provider pickup. The confirmation
deadline remains five seconds per write; paste/submit separation remains 150 ms.
Once the paste entered the queue, every failure remains `unknown` with
`effectStarted:true`, including timeout or preemption before Enter. It must not be
retried as a no-effect failure. `submission_preempted` during the separation keeps
that same conservative outcome. Unclassified adapter errors retain the existing
redacted `submission_unconfirmed` message plus the stage; no raw prompt or OS error
is added. The field is optional: old receipts and session/timer-originated first
outcomes remain unchanged, and a later producer observation does not rewrite an
already retained terminal send outcome. Interrupt/stop write classification is
unchanged.

Untyped adapter failures at either submission fence may additionally retain
`submissionFence:{substage,reason}`. `substage` is `runGuard`, `lifecycleRead` or
`queueAdmission`; fixed reasons are `sqlBusy`, `sqlLocked`, `io`, `invalidData`,
`joinFailed`, `queueFull`, `queueClosed` or `unknown`. They identify the failing
adapter boundary without serializing SQL, paths, prompts or raw error strings.
Domain refusals keep their existing code/message and omit this diagnostic. The
public `submission_unconfirmed` code and conservative effect/phase classification
remain unchanged. The fence has no wall-clock guess of its own: it rechecks
queue-domain `lifecycle_pending`/`editor_pending` refusals and a `lifecycleRead`
that is `sqlBusy` or `sqlLocked` (for example while a hook commits) until the
evidence settles or a guard refuses (run budget, preemption, human control, exit,
host stop). Only as a hang guard does it end once the session has shown no
terminal activity for the host's 45-second provider readiness bound, after one
final check that reports that check's own refusal or busy reason. Busy retries
back off from 31 to 250 ms. No bytes are queued before the fence passes.
Lookup/replay returns the same retained diagnostic and never retries input.
An absent field on older receipts does not identify which boundary failed;
event-journal health alone does not cover the separate lifecycle journal read.

The private Claude hook journal records only SHA-256 prompt fingerprints. The
`claude-hooks-v3` adapter adds the optional whole-paste fingerprint. Matching
normalizes line endings and surrounding whitespace; it does not rewrite sent
bytes. Correlation also fences launch, conversation generation and source
sequence. Unmatched prompts, child/foreign events, old idle/Stop and later
conversations cannot settle a send. Claude 2.1.304 was observed wrapping a whole
multiline paste in matching `<pasted_content id="…">` lines in its hook payload,
as described in the [upstream hook contract](https://code.claude.com/docs/en/hooks#userpromptsubmit-input).
The adapter retains the raw fingerprint and, only for that bounded complete
envelope, a separate exact-body fingerprint. Raw matches take precedence. It
does not strip inline tags, repeatedly unwrap nested content, change sent bytes,
collapse internal whitespace or accept unrelated prompts. Envelope IDs must be
1–16 hexadecimal characters and the body must fit the original 8192-byte/control
bounds; unsupported forms stay unconfirmed. Matching receipts identify
`promptMatch:exact|claudePasteWrapper`, without prompt text or hash disclosure.
`session explain --json` exposes `inputOperation.correlationEvidence` with the
last pickup sequence/match boolean and matched method, so an unmatched pickup
is distinguishable from no pickup. This evidence grants no success or authority.
An old journal without the fingerprint column stays compatible but advertises
no correlation. Other providers currently have no prompt-correlation adapter.
An older fingerprint journal without the optional paste column stays writable
and readable with raw matching only; no live per-launch schema is rewritten.

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

## Idempotent process controls

`controlReceipts:true` adds owner-only `interruptOperation {key,sessionId}` and
`stopOperation {key,sessionId}` over the same durable intent/claim engine. An
active human controller blocks both before any native effect. Pending automated
submission is preempted, but no human lease is taken or silently released.

Interrupt writes one Ctrl+C and confirms only native write/flush (`delivered`,
`agentStopped:null`). Stop invokes the native managed-process killer and confirms
the request (`stopRequested`, `processExited:null`), retaining the process record
and terminal replay. Observe `process.exited`/session running separately. It does
not assert that every descendant is drained, that work was saved, or that a task
succeeded. Run-level budgets, descendant cancellation and drain are F20 policy.

Before-effect validation returns failed; native uncertainty returns unknown.
Neither a lost reply nor restart reissues a signal. Confirmed control receipts
remain historical across restart and do not consume pending-send capacity.
Operation kind is part of key identity, so a key cannot change from a send into
a stop even with an otherwise identical target. CLI/MCP capability checks never
fall back to legacy takeover/input/close requests on an older host.

If the host already observed process exit before a stop, it returns `stopped`
with `processExited:true`, `nativeStopRequested:false` and `effectStarted:false`.
This is an observed no-op, not a fabricated signal acknowledgement. Interrupt
still rejects an exited process. Ctrl+C may itself exit a shell on Windows;
subsequent stop/replay remains explicit and harmless. Process exit is not task
success, and a native kill failure without exit evidence remains unknown.

## Evidence

Native host/CLI integration covers concurrent same-key create from two clients,
one actual shell, no acquired input ownership, key conflict, failed validation,
lost reply/disconnect lookup, restart/replay without process resurrection, caller
scope rejection, Unicode and folder spaces. SQLite tests inject an event-write
failure to prove rollback, reject stale claim reuse and preserve unknown outcomes
across reopen. Tests use isolated hosts and no model calls.

## Editor redraw between paste and Enter

Queue admission refreshes received PTY status/readiness before each write rather
than relying on the last coalesced publication tick. Publication remains coalesced.
After an owned paste invalidates screen-only idle evidence, Enter waits for fresh
idle editor evidence, bounded only by the guards above and the readiness hang
guard counted from the session's latest terminal activity; a slow redraw is not a
refusal. I/O activity never qualifies as idle.
Every check retains run, authority, conversation and human-control fences; paste
is never repeated. Semantic work/permission evidence refuses Enter immediately,
retaining unknown partial input for deliberate reconciliation.

The controlled native SDK regression delays editor redraw by 600 ms and verifies
one literal paste/Enter across same-key replay. A second process shows a working
footer after paste: Enter remains refused even when its editor later returns idle.
The elapsed-budget wake scenario holds the redraw and expires the budget as soon
as the host reports the pasted input, so the run guard, not editor or provider
timing, refuses Enter.
This checks the real PTY/event loop without calling a model or taking user control.

## Backup and restore

The pairing directory (see [host configuration](../apps/host/README.md)) holds the durable
state: `metadata.sqlite3` (journal, receipts, runs, jobs and session metadata in WAL mode),
`pairing.json` (the pairing key) and, once worktrees exist, `worktrees.json`. In WAL mode
committed transactions may still sit in `metadata.sqlite3-wal`; `-shm` is a rebuildable index.

1. Stop the host. A crashed host is acceptable: its committed writes are in the WAL.
2. Fold the WAL into the main file: `sqlite3 metadata.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"`
   must print `0` in the first column, and `PRAGMA integrity_check;` must print `ok`.
3. Copy `metadata.sqlite3`, `pairing.json` and `worktrees.json` when present. Never copy the main
   file alone while a non-empty `-wal` exists, and never copy `-shm`.
4. To restore, place the copies in an empty directory and start the host with `--pairing-dir`
   pointing at it. Startup applies pending migrations in order and refuses a database recorded
   by a newer host. Restoring `pairing.json` keeps paired clients working; omitting it issues a
   new key.

Receipts, run and job definitions and their keyed mutation replays come back unchanged, so a
same-key retry replays rather than repeating. Receipts unsettled at backup time become unknown,
as after any restart; processes never survive. The `apps/host/tests/journal_drill.rs` drill
kills a host after writing a run, a job and an operation receipt, follows this procedure and
asserts every record, the key replay and the `schema_migrations` ledger on the restored host.
Run it with `cargo test -p nesvo-host --test journal_drill -- --ignored`; the weekly
`Journal drill` workflow runs it on Linux and Windows.
