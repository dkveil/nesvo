# Harness CLI

Headless commands use the same paired, authenticated native host as the TUI.
Running `nesvo` without a subcommand still opens the existing TUI. Help never
loads pairing or contacts a host.

```powershell
nesvo --pairing C:\private\pairing.json doctor --json
nesvo --pairing C:\private\pairing.json session list --json
nesvo --pairing C:\private\pairing.json session get SESSION_ID --json
nesvo --pairing C:\private\pairing.json session explain SESSION_ID --json
nesvo --pairing C:\private\pairing.json session read SESSION_ID --max-bytes 4096 --json
nesvo --pairing C:\private\pairing.json session read SESSION_ID --after CURSOR --json
nesvo --pairing C:\private\pairing.json session diff SESSION_ID --scope unstaged --json
nesvo --pairing C:\private\pairing.json session current --json
nesvo --pairing C:\private\pairing.json session create "Review" --key review-1 --program claude --prompt-file C:\private\prompt.txt --json
nesvo --pairing C:\private\pairing.json operation --key review-1 --json
nesvo --pairing C:\private\pairing.json session send SESSION_ID --key review-turn-1 --prompt-file C:\private\followup.txt --json
nesvo --pairing C:\private\pairing.json session wait --key review-turn-1 --session SESSION_ID --until settled --timeout-ms 30000 --json
nesvo --pairing C:\private\pairing.json session interrupt SESSION_ID --key review-interrupt-1 --json
nesvo --pairing C:\private\pairing.json session stop SESSION_ID --key review-stop-1 --json
nesvo mcp
```

Run-scoped admission and graceful drain are available through
`nesvo run budget get|set`, `nesvo run drain` and `nesvo run resume`.
They use the run revision and existing workflow mutation keys. See
[limits, activation clock and human priority](harness-run-budgets.md).

`current` uses the authenticated host caller binding. For explicit owner/legacy
connections without that binding it uses the injected `NESVO_SESSION_ID` hint.
It never guesses from the TUI's selection. This identifier is context, not an
authorization credential. The host also injects `NESVO_AGENT_CONTEXT`, a private
file containing an independent per-process key. Headless commands prefer that
capability when no explicit `--pairing` is supplied. Missing/invalid context fails
closed; it never falls back to the owner's pairing. For an agent running inside
a managed session, `nesvo session current --json` needs no pairing argument.

The default worker capability can list/get/read/explain only its own session and
inspect its automatic repository diff. It cannot send input, acquire control,
launch/stop processes, choose arbitrary review directories, inspect global doctor
data or see unrelated sessions/groups/control notifications. It expires when the
managed process exits. Permissions are host-owned; editing `sessionId` or an
`authority`/`role` hint in a context file grants nothing.

An owner can create a coordinator with `session create "Coordinator" --key KEY
--program claude --role coordinator --json`. This requires `coordinatorScopes`.
That managed process can create worker children and read/send/interrupt/stop only
the children it created through its own authenticated capability. The host binds
their parent, defaults their workspace/group to the coordinator's, and rejects
workspace escapes, foreign groups/parents and recursive coordinator roles.
Owner-created parent metadata alone grants no access. Reconnecting preserves
the grants while the coordinator process lives; its observed exit revokes them
without stopping its children. A fixed 256 lifetime child capability bound and
the [host/provider admission budget](harness-budgets.md) apply. Bound attempts
also use [run budgets](harness-run-budgets.md); native run stop/cancel has a
separate [control and recovery contract](harness-run-controls.md).
Human control/drafts still prevent automation. These are process capabilities,
not durable run/recovery handover permissions.

The owner can explicitly supply the private owner pairing for full human access.
Do not give that pairing to workers. Capabilities constrain the authenticated API;
they do not provide an OS sandbox against code running as the same account with
filesystem access to other private files. Tokens are launch-local, use no global
provider configuration and are never included in snapshots/diagnostics.

## Launch-local agent instructions

Each managed launch receives `NESVO_AGENT_SKILL`, an owned private copy of the
versioned [Nesvo harness skill](../skills/nesvo-harness/SKILL.md). Its version/path
are recorded only in the private context file. Setting an environment path alone
does not prove that a provider loaded the instruction; per-provider injection and
actual model-to-child verification remain separate gates.

`NESVO_CLI` points to the native executable selected by the host. Discovery uses
an explicit absolute `NESVO_CLIENT_BINARY` host environment override, or a sibling
`nesvo(.exe)` beside the running host. An invalid override does not fall back to
PATH, owner pairing or a shell shim. Missing discovery leaves `NESVO_CLI` unset;
the agent must report setup failure. PowerShell agents invoke `& $env:NESVO_CLI`;
POSIX agents invoke `"$NESVO_CLI"`. No global skill/MCP configuration is installed.

`nesvo-dev` now copies a matching host/CLI pair into a unique runtime directory
for that host lifetime. Closing the temporary TUI or compiling another build
does not remove/overwrite the agent's executable. An already-running host is
preserved and retains its original runtime pair; restart it deliberately after
saving work to adopt new host features. Runtime disk cleanup/pooling is F39/F42.

On a host advertising `sessionHarness:true`, `session create NAME --program
claude --harness --key KEY` appends the versioned instruction and adds the Nesvo
stdio MCP through launch-local files. Add `--role coordinator` for child creation.
This currently requires a probed Claude Code 2.1.303 or newer in the 2.1 series;
unknown/older/other providers are refused before spawning or Git setup. The
existing subscription login and native permission checks remain in effect.

Coordinator children inherit this setting when omitted. `--no-harness` (MCP
`spec.harness:false`) explicitly opts out; the child's API role still defaults to
worker. Disabling tools does not grant authority. Existing processes are never
silently restarted or reconfigured. To change the launch setting, create a new
session deliberately; controlled conversation resume/profile migration remains
F37/F38/F41 work.

Session queries and explain expose a prompt/credential-free `harness` effective
configuration: enabled, CLI availability, instruction version, declared MCP
names, scope and `loaded:null`. Prepared launch arguments do not establish that
the provider actually loaded the tools or used the instruction. File paths and
credentials are confined to the private process context.

## Version 1 query output

The machine-readable schema is `docs/harness-cli.schema.json` (JSON Schema draft 7).
Native integration tests validate real CLI success/failure output against it.

New session queries return one JSON object on stdout and no progress text:

```json
{ "schemaVersion": 1, "ok": true, "data": { "type": "session", "session": { "id": "..." } } }
```

`data` is the authoritative host result: `sessions` for list, `session` for
get/current, `sessionRead` for read, or `diff` for a repository review. The complete
session/group/status shapes are defined in `protocol-v2.md`. Request correlation
IDs are omitted from CLI output. Fields can be added without changing version 1.
Doctor/explain retain their existing version 1 diagnostic report shape, with
`schemaVersion`, `host`, `programs`, `providerVersions` and `sessions` at the root.

Runtime and argument failures with `--json` return:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "session_not_found",
    "message": "Session no longer exists",
    "retryable": false
  }
}
```

| Exit | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | Successful query/help or accepted operation receipt               |
| 2    | Invalid arguments, or missing current process context             |
| 3    | Missing/invalid private pairing                                   |
| 4    | Host unavailable, unauthenticated or disconnected                 |
| 5    | Session/operation/control not found or not visible                |
| 6    | Host operation rejected, invalid cursor or unavailable Git review |
| 7    | Request timed out                                                 |
| 8    | Host lacks the required capability                                |

Error codes distinguish `invalid_argument`, `no_current_session`, `forbidden`, `scope_revoked`,
`pairing_unavailable`, `host_unavailable`, `disconnected`, `session_not_found`,
`invalid_cursor`, `git_unavailable`, `request_rejected`, `timeout`, `unsupported`
and `operation_failed`. Only connection/disconnect/timeout errors are marked
retryable. No command retries input. Pairing keys are never printed.

## Bounded terminal reads

`sessionRead` contains `sessionId`, `cols`, `rows` and `page`:

```json
{
  "format": "terminalReplay",
  "data": "...",
  "fromCursor": 100,
  "nextCursor": 200,
  "floorCursor": 0,
  "headCursor": 200,
  "gap": false,
  "more": false
}
```

Cursors are UTF-8 byte offsets within this process's visible terminal stream,
after host-owned status negotiation has been removed. They are not domain event
or task-result cursors. Without `--after`, read returns a recent tail page;
with `--after`, it reads forward from that cursor. Limits are 1–8192 bytes (4096
by default), with UTF-8 boundaries preserved. Raw terminal data is JSON-escaped;
the maximum page remains inside the wire frame even for control-heavy output.

Retention is bounded at 128 KiB. `gap:true` means the requested prefix expired;
`floorCursor` identifies the oldest retained byte. `more:true` means another
bounded page is available. A future or split-character cursor is rejected.
An empty page at the current head is valid. Switching to a different session ID
starts a different cursor space. Read/diagnostics do not subscribe, take control,
resize, acknowledge notifications or answer replayed terminal queries.

Human-readable read output passes through the existing terminal parser; it does
not execute ANSI/OSC from the remote program in the caller's terminal. A bounded
tail cannot promise a complete screen or transcript. Use the TUI for interactive
terminal viewing. Diff runs at the host, using its session/edit context and an
explicit staged, unstaged or untracked scope.

## Remaining delivery gates

`events --after CURSOR --session SESSION_ID --json` reads a durable domain page;
add `--watch` for NDJSON deltas without heartbeat output. See `harness-events.md`
for retention, gaps, health and reconnect behavior. This cursor space is separate
from `session read`.

`session create NAME --key KEY` uses durable launch receipts. Optional flags are
`--program shell|claude|gemini|codex`, `--cwd PATH`, `--group ID`, `--worktree` and
one of `--prompt TEXT`, `--prompt-file PATH`, or `--stdin`. Prompt input is literal
UTF-8 bounded to 8192 bytes; shell sessions reject nonempty agent prompts. No
local folder resolution is applied to a remote `--cwd`. File/stdin failures occur
before accepting an intent. No key, prompt, command or input is retried silently.

`operation OPERATION_ID --json` or `operation --key KEY --json` recovers its
receipt and domain cursor after a timeout/reconnect. Create can return accepted
or dispatching when another connection is already processing that same intent;
exit 0 does not claim agent readiness. Failed/unknown launch outcomes return exit
6 with `error.receipt` in version 1 JSON. `idempotency_conflict` means the key was
used for a different request. See [durable operations](harness-operations.md).

`session create NAME --key KEY --parent PARENT_SESSION_ID` creates a normal
background child process. The host requires a live parent and `sessionLineage`
support; an old host is refused instead of silently creating a root session.
The optional `parentSessionId` is returned in session queries and persisted in
recovery metadata. Parent input ownership remains unchanged, including when
the child has the same display name. A late observer sees the same relation.
Lineage is not permission: a worker still cannot create children or read its
parent. Coordinator grants come from authenticated child creation, never this
optional owner-supplied metadata.

`nesvo mcp` exposes current shared operations over native stdio; see the
[MCP adapter](harness-mcp.md) for scope and SDK integration tests.
Job receipts, agent instruction installation and durable run grants remain
subsequent gates. This is not a completed orchestration interface. Existing
legacy `nesvo --list` remains compatible.

## Workflow plans and attempts

`nesvo budget get|set` exposes the owner's persisted host admission limits.
Coordinators/workers cannot change global budgets, and lowering them leaves live
work untouched. See [process budgets and recovery](harness-budgets.md).

Durable plans use `nesvo run create|list|get|plan|mutation`; activate, assign,
task, context, report and validate add explicit worker attempts/results. See
[workflow identities, DAG and recovery](harness-workflows.md). These metadata
commands do not start agents or infer task outcomes from idle.

`run inbox read|send|ack` adds scoped durable messages when `workflowInbox` is
advertised. Read/ACK never send terminal input or validate tasks. See the
[inbox contract and exact-ID recovery](harness-inbox.md). Launch-local instruction
version 3 documents these commands; existing processes keep their own snapshot.

`run decision ask|list|get|answer|cancel` adds attempt-bound questions with
`workflowDecisions`. Owner-only questions cannot be answered by a coordinator.
Decision revisions/deadlines are separate from execution revisions, and an answer
does not type a native provider approval. See [decision contract](harness-decisions.md).
Launch-local instruction version 4 documents this boundary and explicit recovery.

## Literal send and receipt wait

`session send SESSION_ID --key KEY` requires one of `--prompt TEXT`,
`--prompt-file PATH` or `--stdin`. File/stdin decoding and the 8192-byte bound are
shared with create. The host's `promptReceipts` capability is checked before
dispatch; an old host is not given a legacy input fallback. Automated submission
refuses human control, unresolved drafts, pending sends and unready/busy agents.
It never acquires input ownership. The same key/payload returns the original
receipt across CLI/MCP; a new key is not a safe way to retry an unknown effect.

`session wait OPERATION_ID` or `session wait --key KEY` accepts an optional
`--session SESSION_ID` target guard, `--until delivered|received|started|settled`
(default settled), and `--timeout-ms 1..60000` (default 30000). The CLI connection
deadline includes host wait time plus five seconds. The host waits on the receipt
and exact turn rather than polling current idle. No model call is made.

A reached milestone returns version 1 operation data with receipt, domain cursor
and `wait:{until,outcome,reached}`. A host wait timeout returns exit 7 and JSON
`error.code:"timeout"` with the current `error.receipt`; failed/interrupted/unknown
before the target milestone returns exit 6 with its receipt. These outcomes do
not replay or cancel accepted input. Look up the same receipt/key after a lost
connection. Unsupported provider correlation returns exit 8, including ordinary
shell writes when waiting beyond delivered. Response settlement is not task
success. See [operation evidence and safety](harness-operations.md).

## Interrupt and stop

`session interrupt SESSION_ID --key KEY` writes one Ctrl+C through the confirmed
native writer. `delivered` proves write/flush only; `agentStopped:null` deliberately
does not claim the provider handled it. `session stop SESSION_ID --key KEY`
requests native process termination and returns `stopRequested` with
`processExited:null`. Inspect the session until the host observes process exit;
this is not validated task success. Terminal output and session identity remain
readable until explicitly closed through the existing session UI.

Both commands require `controlReceipts`, reject an active human controller,
preempt pending automated input, and never acquire a lease. They can interrupt
in-memory work and make the editor unavailable for automatic prompt reuse until
reconciled. Native failures with uncertain effects return an unknown receipt.
Same-key replay returns the original receipt without sending another signal;
restart never repeats it. These are single-process controls, separate from
[native run stop/cancel](harness-run-controls.md) and
[run budget/drain policy](harness-run-budgets.md). Passive worker scopes cannot use them.
