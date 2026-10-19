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
nesvo mcp
```

`current` reads `NESVO_SESSION_ID` injected into the managed process environment.
It never guesses from the TUI's selection. This identifier is context, not an
authorization credential. The host also injects `NESVO_AGENT_CONTEXT`, a private
file containing an independent per-process key. Headless commands prefer that
capability when no explicit `--pairing` is supplied. Missing/invalid context fails
closed; it never falls back to the owner's pairing. For an agent running inside
a managed session, `nesvo session current --json` needs no pairing argument.

The initial session capability can list/get/read/explain only its own session and
inspect its automatic repository diff. It cannot send input, acquire control,
launch/stop processes, choose arbitrary review directories, inspect global doctor
data or see unrelated sessions/groups/control notifications. It expires when the
managed process exits. Permissions are host-owned; editing `sessionId` or an
`authority` hint in a context file grants nothing. Coordinator/run/child grants
are a subsequent F11/F12 gate before automated child creation/send is exposed.

The owner can explicitly supply the private owner pairing for full human access.
Do not give that pairing to workers. Capabilities constrain the authenticated API;
they do not provide an OS sandbox against code running as the same account with
filesystem access to other private files. Tokens are launch-local, use no global
provider configuration and are never included in snapshots/diagnostics.

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
| 5    | Session/operation not found or not visible                        |
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

`nesvo mcp` exposes current shared operations over native stdio; see the
[MCP adapter](harness-mcp.md) for scope and SDK integration tests.
Send/wait/interrupt/stop, prompt/job receipts and coordinator grants remain
subsequent gates. This is not a completed orchestration interface. Existing
legacy `nesvo --list` remains compatible.
