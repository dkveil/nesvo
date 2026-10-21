# Harness CLI

Headless commands use the same paired, authenticated native host as the TUI.
Running `nesvo` without a subcommand still opens the existing TUI. Help never
loads pairing or contacts a host.

Owner `nesvo quota [--program codex|claude|gemini] [--refresh] [--json]` inspects
installed-provider observations through the shared host observer. Refresh is
bounded and asynchronous; it requires an explicit provider and returns a target
revision or cooldown. See [quota freshness and authority](harness-provider-quota.md).

Owner Claude launches can opt into a declared statusline display and scoped quota
capture with `--claude-quota-display-profile ABSOLUTE_HOST_JSON_PATH`. The default
statusline is unchanged. See [capture configuration and bounds](harness-claude-quota-capture.md).

Owner `nesvo job trigger` manages signed generic/GitHub triggers with secret files,
exact revisions and immutable delivery lookups. See the
[external trigger contract and commands](harness-job-triggers.md). A trigger only
admits an occurrence through the existing job dispatcher; it never grants a
scoped agent owner authority or turns event payloads into executable instructions.

New session/task launches can select a native `--model` and `--effort` on verified
providers. Values are launch-local and are not inherited by children or written
to provider defaults. See [model profiles and capability limits](harness-model-profiles.md).

Supported owner Claude harness launches can add exact process-scoped native
Nesvo tool permissions with `--allow-nesvo-tool TOOL_NAME` (repeat as needed).
This requires `--harness` and `sessionToolPermissions`; children do not inherit
the additions. See [scope, validation and effective configuration](harness-tool-permissions.md).

An owner can separately set `--allow-child-nesvo-tool TOOL_NAME` for a coordinator.
The host derives those additions only for its authenticated supported Claude
harness children, including task launches; a worker role remains a worker.
See [declaration, origin and lifetime](harness-child-tool-policy.md).

```powershell
nesvo --pairing C:\private\pairing.json doctor --json
nesvo --pairing C:\private\pairing.json session list --json
nesvo --pairing C:\private\pairing.json session get SESSION_ID --json
nesvo --pairing C:\private\pairing.json session explain SESSION_ID --json
nesvo --pairing C:\private\pairing.json session read SESSION_ID --max-bytes 4096 --json
nesvo --pairing C:\private\pairing.json session read SESSION_ID --after CURSOR --json
nesvo --pairing C:\private\pairing.json session diff SESSION_ID --scope unstaged --json
nesvo --pairing C:\private\pairing.json review open --session SESSION_ID --base main --json
nesvo --pairing C:\private\pairing.json review open --pull https://github.com/OWNER/REPO/pull/12 --json
nesvo --pairing C:\private\pairing.json review deliver --review REVIEW_ID --session SESSION_ID --file C:\private\review.md --json
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

An owner can explicitly attach retained run metadata to a replacement coordinator
using `nesvo run bind-coordinator`. It preserves inbox/results/constraints and
pauses automation; it does not adopt old worker processes or native authority.
See [binding recovery, revision fences and limits](harness-coordinator-recovery.md).

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

## Review sessions

`review open` creates or refreshes a host-owned review and returns version 1
`reviewOpened` data. `--session SESSION_ID` reviews that session's automatic edit
context (or `--directory PATH`, absolute or relative to the session folder);
`--directory` alone needs an absolute host folder. `--pull URL` accepts only
`https://github.com/OWNER/REPO/pull/NUMBER`. The host runs `gh pr view` and
fetches the pull request head and base with `git fetch --filter=blob:none` into
`<config>/nesvo/reviews/<owner>-<repo>-<number>` (`%LOCALAPPDATA%` on Windows,
`$XDG_CONFIG_HOME` or `~/.config` elsewhere), reusing that checkout when present.
The whole fetch is capped at 120 seconds with bounded output; one pull request
fetch runs at a time. Credentials come from `gh auth git-credential`; nothing is
pushed, merged or committed. `--base REF` overrides the base: the repository
default branch for local reviews, the pull request base otherwise.

`reviewOpened` carries `reviewId` (stable for the same session and repository, or
`pull-<owner>-<repo>-<number>`), `directory`, `source`, `base`
(`ref`, `oid`, `mergeBase` or null), `head` (`ref`, `oid`), `scope` (`branch` when a
base resolves, otherwise `unstaged`), `revision` and, for pull requests, `checks`
(the GitHub check rollup counted at `headOid`). The host broadcasts the same event
to other owner clients. Reviews live in host memory (64 most recent); reopen one
after a host restart. Scoped agent callers cannot open, inspect or deliver reviews.

Protocol `getDiff` accepts `reviewId` instead of `sessionId`, scope `branch`
(merge base of `base` against the working tree, including untracked files) and
scope `commits` with `from` and optional `to` (default `HEAD`). Every review
carries `revision`: the head tree id plus a hash of the bounded diff, unchanged
while the diff is unchanged. `reviewContext{reviewId}` returns readiness (clean or
dirty counts, conflicts, upstream ahead/behind, base ahead/behind and merge
conflicts, pushed, `blockers`, `worktreeRevision`) and per-file edit provenance for
session sources from the private Claude hook ledger: `agent`, `otherAgent`,
`uncertain` (content changed after the recorded edit or unreadable) or
`unattributed`, with `thisTurn` only for verified edits in the current turn.

`review deliver --review ID --session ID` takes `--text TEXT` or `--file PATH`
(nonempty UTF-8, at most 32768 bytes, no terminal controls) and an optional
`--key KEY` (derived from review, session and text when omitted). It returns
`reviewDelivered` with `path` and one `receipt`. Without a human lease the host
uses the durable send path (8192 bytes, same refusals and same-key replay as
`session send`). When the calling client holds the session's control lease the
host writes one bracketed paste through that lease and returns a `paste` receipt;
nothing is submitted. Another client's lease, a shell, an exited process or an
agent that is not ready and idle are refused with `control_busy`, `unsupported`,
`process_exited` or `agent_not_ready`.

## Worktree setup, run and archive

A repository declares worktree preparation in a committed `nesvo.toml` at its
root. Only the `[worktree]` table is defined; the parser accepts a strict TOML
subset (comments, basic and literal single-line strings, string arrays that may
span lines, decimal integers) and refuses unknown keys or tables:

```toml
[worktree]
# Commands for the platform shell (cmd.exe on Windows, /bin/sh elsewhere).
setup = ["npm ci", "cargo fetch --locked"]
# Started on demand with `nesvo worktree run`.
run = ["npm run dev"]
# Untracked local files copied from the source checkout root, never committed.
env_files = [".env", "apps/mobile/.env.local"]
# Deadline for all steps of one setup or run, 1-3600 seconds, default 600.
timeout_s = 600
```

At most 32 steps per list, 4096 bytes per step and 32 environment files of at most
1 MiB each (relative `/` paths outside `.git` and `.nesvo`). The digest is the
SHA-256 of the normalized values with the policy `platform-shell-v1`, so formatting
and comments do not change it. The host reads the file from `HEAD` of the source
repository, never from uncommitted edits.

Trust follows the job precheck model: approving a digest authorizes arbitrary code
with the host user's permissions, the host never approves repository files on its
own, and a changed file needs a new approval. Steps inherit the host environment
without `NESVO_*` and `POCKET_*` variables.

```powershell
nesvo worktree describe --directory C:\project --json
nesvo worktree approve-setup --directory C:\project --digest INSPECTED_DIGEST --json
nesvo worktree revoke-setup --directory C:\project --digest INSPECTED_DIGEST --json
```

`describe` returns `worktreeSetup { repository, configured, config, digest,
approved, policy }` and runs nothing. `approve-setup` refuses with
`digest_mismatch` when `HEAD` changed since inspection and returns
`worktreeSetupApproved { repository, digest, approvedAt }`; `revoke-setup` returns
`worktreeSetupRevoked { repository, digest, revoked }`. Approvals persist in
`worktrees.json` next to the host pairing data.

Approval and revocation exist only in this owner CLI. The MCP catalog has no
approve or revoke tool, so an agent cannot approve repository-declared steps for
itself; it can only describe the setup and ask the owner to approve the digest.

Every worktree launch (TUI, `session create --worktree`, MCP, workflow tasks and
scheduled launches) checks the approval before creating anything: an unapproved
declared setup fails with `worktree_setup_unapproved` and no effect. After the
worktree exists the host copies `env_files`, runs `setup` in order and writes
`<worktree>/.nesvo/setup.log` (64 KiB, a truncation marker when cut; `.nesvo` is
ignored by its own `.gitignore`). The agent process is not started while setup
runs. A failed, timed-out or cancelled setup never starts it: the receipt is
`failed` with `worktree_setup_failed`, `worktree_setup_timed_out` or
`worktree_setup_cancelled`, the log path and `reservedSessionId`. A passed setup
records `worktreeSetup { digest, result, log }` in the prepared launch. The journal
receives `worktreePrepared { sessionId, result: passed|failed|timedOut|cancelled,
log, worktree, digest }`. `session create --worktree` waits up to 3630 seconds for
the receipt.

```powershell
nesvo worktree run SESSION_ID --json
nesvo worktree cancel SESSION_ID --json
nesvo worktree archive SESSION_ID [--discard] --json
nesvo worktree list --json
```

`run` starts the approved `run` steps after a passed (or absent) setup and returns
`worktreeRunStarted { sessionId, worktree, log }` at once; the outcome is the
journal event `worktreeRan { sessionId, result, log }` and the registry run state,
with output in `.nesvo/run.log`. `cancel` terminates the active setup or run
(`worktreeCancelled { sessionId, cancelled }`). At most four setups or runs execute
at once. On Windows a step's whole process tree is terminated with it; on Unix a
background process left behind by a finished step is not stopped.

`archive` refuses while the session runs (`session_running`) and refuses
`worktree_unsaved` when the worktree has uncommitted or untracked files,
conflicts, or commits that no other branch, tag or remote reference contains.
Copied environment files that are unchanged and `.nesvo` do not count. With
`--discard` it removes the worktree and its `nesvo/` branch anyway. The reply and
the journal event `worktreeArchived` carry `sessionId`, `worktree`, `branch`,
`discarded`, `blockers` and `branchDeleted`. `list` returns `worktreeRegistry
{ worktrees:[{ sessionId, worktree, branch, repository, createdAt, digest, setup,
run, envFiles, archivedAt, discarded, present, sessionLive, active }] }`, newest
first (128); `present` compares with `git worktree list`. All worktree commands are
owner-only and need `worktrees:true`: the host refuses every one of them with
`forbidden` for a session-scoped or wake caller, including a caller targeting its own
session, and `run`, `cancel` and `archive` refuse `worktree_not_found` unless the host
registered a worktree for that session.

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

Connection failures retain `host_unavailable`, the existing exit status and
retryability. Authentication errors distinguish fixed stages (`connect`,
`challengeRead`, `challengeValidate`, `authSend`, `authRead`, `hostProof`,
`connectedValidate`) and safe causes in the message. An HTTP rejection or received
WebSocket close may include its numeric status; response bodies, close reasons,
addresses, keys, scopes and nonces are never included. Unknown internal errors
keep the adapter's generic message. These diagnostics do not prove admission
saturation or permit automatic replay. Existing connection/read/write timeouts
and host proof, nonce and protocol validation remain unchanged.

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

Argument parsing builds the complete nested command grammar on a joined,
short-lived 4 MiB thread. Generated workflow augmentation alone exceeded 500 KiB
in a measured Windows debug build; recursive construction could overflow the
smaller OS main stack before any JSON was emitted. No host connection, terminal
mode or persistent worker starts until parsing completes. This changes neither
global stack limits nor command semantics. A small-caller-stack regression checks
top-level/nested help and the native wait grammar; real CLI integration checks
also cover a timeout retaining its receipt and exit code 7.

## Saved session recovery

Owner `session recover list [--offset N]` pages saved launch descriptions of
sessions that are not running (`type:"recovery"`, `records`, `nextOffset`).
`session recover restore ID [--resume]` starts one new process from a saved
record and returns `type:"created"` with the new `sessionId`. Old prompts and
worktree creation are never replayed, and a claimed record cannot start twice.
`--resume` requires `conversationResume` and a recorded `spec.resume`; it asks
the provider for that exact conversation and adds `resume:{state:"pending"}`.
Inspect `session get` until `resume.state` is `verified` or `resumeFailed` with
its `reason`. Gemini and records without a conversation return `unsupported` and
`resume_unavailable` and leave the record saved. `session recover forget ID`
removes only the description. See [exact conversation resume](harness-recovery-context.md#exact-conversation-resume).

```powershell
nesvo session recover list --json
nesvo session recover restore SAVED_ID --resume --json
nesvo session recover forget SAVED_ID --json
```

## Owner attention inbox and decisions

Owner `inbox list [--page N] [--limit 1-32]` returns `type:"attentionInbox"` with
`items`, `page`, `limit`, `nextPage` and `total`. It aggregates agent sessions that
need you, run attempts awaiting validation or launch reconciliation, pending
decisions and finished job results (`needsValidation`, `succeeded`, `failed`).
Each item has a stable `id` (`session:SESSION_ID`, `decision:RUN_ID:DECISION_ID`,
`run:RUN_ID:ATTEMPT_ID`, `result:OCCURRENCE_ID`), a `revision`, `kind`, `priority`,
`reason`, `at` and a clipped `title` and `summary`; a page stays under 60 KiB.
`inbox ack ID@REVISION...` stores up to 32 receipts (`type:"inboxAcknowledged"`):
repeating one returns the original `acknowledgedAt`, a reconnect or host restart
never shows that revision again, and a newer revision of the item returns.
Acknowledging marks a session's attention read; it never answers a decision.

`decision list [--page N]` returns `type:"decisions"` with eight pending decisions
per page across all runs, each with `inboxId` and its `run`. `decision decide ID
--choice TEXT [--note TEXT]` answers at the current revision without a run ID and
returns `type:"decided"`; the note follows the choice after a blank line. Answered
or canceled decisions return `decision_resolved` and expired ones
`decision_expired`. Hosts without `attentionInbox` or `decisions` return
`unsupported` before sending.

```powershell
nesvo inbox list --json
nesvo inbox ack decision:RUN_ID:DECISION_ID@1 --json
nesvo decision list --json
nesvo decision decide DECISION_ID --choice "Use the main branch" --json
```

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
