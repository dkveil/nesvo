# Native host MCP adapter

`nesvo mcp` serves MCP over stdio. It uses the existing Rust authenticated host
transport and the same command/error/receipt path as the CLI. It never embeds a
model client, starts another host, writes global provider configuration or adds
an HTTP listener. Running `nesvo` normally retains the TUI.

`nesvo_get_provider_quota` is an owner-only installed-provider query with optional
bounded asynchronous refresh. Reader metadata is distinct from native-session
account binding and job admission. See the [quota contract](harness-provider-quota.md).

Ten owner-only `nesvo_*_job_trigger*` tools administer generic/GitHub trigger
definitions and read immutable delivery receipts through the shared host API.
They do not enable the separate listener or register an external account. See
[external triggers](harness-job-triggers.md) for exact commands, signature and
secret scope, replay behavior and explicit listener activation.

`nesvo_rebind_run_coordinator` is the owner-only metadata recovery operation for
an unavailable coordinator. It preserves retained run context and pauses input
without adopting worker terminals. See the
[CLI/MCP recovery contract](harness-coordinator-recovery.md).

## Launch and authority

An agent-launched server should inherit `NESVO_AGENT_CONTEXT` from its managed
process, just like the CLI. Example per-session provider configuration:

```json
{
  "mcpServers": {
    "nesvo": {
      "command": "C:\\path\\to\\nesvo.exe",
      "args": ["mcp"]
    }
  }
}
```

This is an example, not an installed global registration. Use the provider's
per-launch configuration: supported Claude sessions can opt in with
`spec.harness:true` (CLI `--harness`), or inherit the coordinator's setting.
Explicit false opts out. Unknown hosts fail the `sessionHarness` check; unsupported
provider versions fail host validation. Broader declarative profiles are F37/F38
work. Do not put owner pairing keys
in worker prompts, arguments, logs or this JSON. For manual human testing only,
`--pairing PRIVATE_PATH mcp` explicitly selects owner access. Otherwise managed
context is selected automatically; invalid context fails closed. Catalog/help
work without a host. Each tool call authenticates afresh, so revocation is not
bypassed by an authorization cache.

Failed authentication retains `host_unavailable` and fixed stage/cause diagnostics
shared with the [CLI](harness-cli.md). Only numeric HTTP/close status may accompany
them; peer bodies, close reasons, addresses and authentication material are omitted.
An unknown internal error retains the adapter's generic fallback message. The
diagnostic does not establish host admission saturation or authorize input replay.

Host policy always wins. The default passive worker reads its own session but
cannot create children or inspect owner receipts. An owner may launch a session
with `spec.role:"coordinator"` when `coordinatorScopes` is advertised. Its private
capability permits worker-child creation and child reads/send/interrupt/stop only
for host-granted child IDs. Workspace/group boundaries, human priority and
process-exit revocation apply as described in the [CLI guide](harness-cli.md).
Advertising a tool is not permission. Current session uses the authenticated
host binding; an owner/legacy context can use the injected ID as a hint. Neither
path uses UI focus, and changing the hint or private-file role cannot grant access.

## Current tools

`sessionToolPermissions` adds owner-only `spec.allowedNesvoTools` to session
creation. Exact native allow additions are process-scoped and never inherited by
children. They do not grant host authority or override provider deny/ask rules.
See [tool permission contract](harness-tool-permissions.md) and the
[exact name catalog](harness-mcp-tools.json).

`runCheckpoints` adds save/list/get and current-context reconstruction through
`nesvo_save_run_checkpoint`, `nesvo_list_run_checkpoints`,
`nesvo_get_run_checkpoint` and `nesvo_read_run_context`. `runConstraints` adds
owner-only `nesvo_add_run_constraint`, `nesvo_list_run_constraints` and explicit
`nesvo_acknowledge_run_constraints`. Historical snapshots never replace current
owner text; no native effect, inbox ACK or validation is restored. See
[checkpoint/constraint contract](harness-checkpoints.md).

`runBudgets` adds `nesvo_get_run_budget` and `nesvo_set_run_budget`; `runDrain`
adds `nesvo_drain_run` and `nesvo_resume_run`. Limits count assigned/reported
attempts, preserve retry history and use an activation-based elapsed clock.
Only the owner may relax limits or undo an owner drain. These metadata tools
do not kill processes, grant native approval or replay input. See
[run budget contract](harness-run-budgets.md).

`runControls` adds `nesvo_stop_run`, `nesvo_cancel_run` and
`nesvo_get_run_control`. The first two declare destructive effects and use exact
run revisions, stable workflow mutation keys and per-target native receipts.
Only host-observed exit completes a control; reads/replays do not signal.
See [native run controls](harness-run-controls.md).

`runLaunch` adds `nesvo_launch_task`, reserving dependency-ready task/attempt,
run capacity and native create identity atomically before startup. It requires
explicit shared/worktree mode and never sends an initial prompt. Acceptance,
native creation and provider readiness remain distinct. Instruction V11 teaches
launch, queued delivery, executor, wake and context recovery, uncertain-slot retention
and known no-effect startup failure. Its launch-private bundle includes the
linked run policy/control and context/constraints references without requiring
another provider file-read permission. Older live snapshots remain unchanged. See
[task launch](harness-task-launch.md).
The current [catalog](harness-mcp-tools.json) contains 92 tools. Task instruction intents use
`nesvo_deliver_task` and `nesvo_cancel_task_delivery`; see
[guarded task delivery](harness-task-delivery.md).

`runRecovery` adds read-only `nesvo_recover_run_context {runId?,offset?,expectedDigest?}`.
It resolves the authenticated worker binding or a uniquely bound coordinator run;
several runs require explicit selection, and owner calls require runId. It never
adopts processes or replays effects. See [recovery context](harness-recovery-context.md).

`runExecutor` adds `nesvo_start_run_executor`, `nesvo_get_run_executor`,
`nesvo_disable_run_executor` and `nesvo_enable_run_executor`. Immutable explicit
task profiles opt into host selection, guarded native launch and queued input.
Manual workers remain untouched; retries default off, and unknown effects retain
slots. Independent result validation still gates review. Disable stops new
admissions; restart pauses scheduling without adoption/replay. See
[executor contract](harness-executor.md).

`runWakes` adds `nesvo_enable_run_wakes`, `nesvo_disable_run_wakes`,
`nesvo_get_run_wakes` and `nesvo_get_run_wake_batch`. Explicit opt-in groups new
coordinator inbox/current-worker attention references without periodic model
calls. Native input retains human, draft, readiness, generation and elapsed
budget fences. Wake settlement never ACKs or validates work. See
[wake contract](harness-wakes.md).

`hostBudgets` adds owner-only `nesvo_get_host_budget` and `nesvo_set_host_budget`.
Both use the shared host admission policy and workflow recovery namespace;
changing policy never terminates existing work. See [budget contract](harness-budgets.md).

The five workflow tools (`nesvo_create_run`, `nesvo_list_runs`, `nesvo_get_run`,
`nesvo_set_run_plan`, `nesvo_get_run_mutation`) are gated by `workflowPlans`.
They use durable draft metadata and the same CLI recovery keys/revision checks.
See [workflow contract](harness-workflows.md). Tool visibility does not grant
access to another coordinator's runs or permit native dispatch.

`workflowAttempts` adds activate/assign, task history, authenticated current task,
worker report and coordinator/owner validation tools. Results are claims until
separately accepted; no native process/prompt dispatch occurs in these metadata
commands. Instruction version 2 documents the recovery namespaces, result shape,
attempt fences and human priority. Older live launches keep their original
instruction snapshot; they are not silently reconfigured.

`workflowInbox` adds `nesvo_read_inbox`, `nesvo_send_message` and
`nesvo_ack_messages`. These are durable, scope-checked metadata operations.
Instruction version 3 covers pending-read recovery and exact-ID ACK, separate
from native effects and result validation. See the [inbox contract](harness-inbox.md)
for recipient rules, bounds and restart behavior.

`workflowDecisions` adds `nesvo_ask_decision`, `nesvo_list_decisions`,
`nesvo_get_decision`, `nesvo_answer_decision` and `nesvo_cancel_decision`.
Instruction version 4 covers addressed authority, deadlines, exact decision
revisions, cancellation and metadata recovery. None types a native permission
approval or validates task success. See the [decision contract](harness-decisions.md).

Instruction version 5 adds run policy inspection/edit grammar, parallel slots
through validation, activation-based time/retry history, owner-only relaxation
and owner drain/resume boundaries. It distinguishes workflow-key recovery from
uncertain native-send receipts. Instruction version 6 adds the implemented
run stop/cancel and paged control grammar, native receipt-ID recovery, unknown
process handling, human draft protection and owner-controlled stop/resume.
Reported work survives stop for explicit validation after resume, while
cancellation is terminal. Each new opted-in launch receives its own versioned
snapshot; existing sessions/global instructions are not rewritten.

Create accepts optional `spec.parentSessionId` for a live process parent, gated
by `sessionLineage`. It creates an ordinary background session without changing
parent input ownership. The relation appears in session data and survives client
reconnect/recovery metadata storage; it grants no API authority. CLI `--parent`
uses the same normalized intent/key, so cross-adapter replay cannot duplicate it.

For opt-in Claude launches the host supplies `--mcp-config` and
`--append-system-prompt-file` before the prompt separator. It does not replace
default system instructions, suppress global tools, skip permissions, or write
global configuration. The generated stdio server inherits only the scoped
authentication path, not an owner pairing argument/key. Effective configuration
is visible through session queries/explain; prepared is separate from loaded.
These native flags are documented in the official
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

| Tool                      | Host operation                                     |
| ------------------------- | -------------------------------------------------- |
| nesvo_list_sessions       | list visible sessions/groups/lifecycle             |
| nesvo_get_session         | inspect one stable process identity                |
| nesvo_get_current_session | get the authenticated process session              |
| nesvo_read_session        | bounded terminal replay with byte cursors          |
| nesvo_explain_session     | status/readiness/provider diagnostics              |
| nesvo_read_diff           | host-side read-only diff with an explicit scope    |
| nesvo_read_events         | bounded durable metadata page with domain cursors  |
| nesvo_create_session      | durable idempotent background create               |
| nesvo_send_prompt         | durable literal prompt submission without control  |
| nesvo_wait_prompt         | passive correlated send milestone wait             |
| nesvo_interrupt_session   | durable single Ctrl+C without taking human control |
| nesvo_stop_session        | durable native process stop request                |
| nesvo_get_operation       | lookup by operation ID or original caller key      |

Tools declare input/output schemas and effect hints. Results include text and
`structuredContent` with `schemaVersion:1`, `ok`, and `data` or `error`. Host/tool
failures use `isError:true` with stable codes; failed/unknown effects include the
receipt. Protocol/schema errors are distinct. Created means historical process
creation, not readiness, delivery or task success. After a lost response query
the original key, never invent a new one to retry. Domain and terminal cursors
are independent. Event gaps explicitly mean incomplete history. Reads neither
acknowledge results nor acquire control.

Send requires `sessionId`, stable `key` and literal `prompt` (8192 UTF-8 bytes,
no terminal controls). Wait takes exactly one `id` or original `key`, optional
`sessionId` guard, `until:delivered|received|started|settled` and `timeoutMs` within
1–60000. It binds receipt/turn evidence, never current idle. Milestone timeout or
terminal failure returns a tool error with the current receipt; unsupported
provider correlation returns `unsupported`. A shell write can confirm delivery
only. Set the MCP client's request timeout above the chosen wait plus connection
overhead. Accepted sends survive a lost reply and are never replayed. Human
ownership/drafts and unready/busy agents remain host-side refusals. Full safety
and phase semantics are in [durable operations](harness-operations.md).

Interrupt/stop require `sessionId` and stable `key`. Both declare destructive
hints, require owner or explicit coordinator-child authority and refuse an active
human controller. Interrupt
delivery is not proof the agent stopped; `stopRequested` is not observed process
exit. The session and output remain available. Repeating a key through CLI/MCP
does not signal twice, including after the process exits. Run-level cancel/drain
and durable run permissions remain separate policy boundaries.

## Protocol, bounds and dependencies

The official `rmcp 3.5.1` SDK declares Rust 1.88, matching the workspace. It handles
current `2026-07-28` metadata and legacy initialization. Native SDK client tests
exercise both the modern protocol and `2025-11-25`. A minimum-version compiler
run is not claimed.

- Direct `rmcp` dependency: defaults disabled, only server and stdio/async I/O.
  Version negotiation, schemas and wire lifecycle come from the maintained SDK,
  rather than a handwritten protocol. Client/child-process features are test-only.
  No macros, HTTP server, OAuth or model SDK is enabled.
- Direct `tokio-util` codec (already required by rmcp): the SDK default stdio reader
  has no line cap. Its codec is configured to reject lines above 64 KiB; malformed
  input closes the adapter before dispatching that input. Arguments are bounded
  to 24 KiB. Host-specific limits remain authoritative. Four calls can contact the
  host concurrently; extra calls fail busy instead of forming an unbounded queue.

Stdout contains only MCP frames, stderr generic diagnostics. Prompts/keys are not
logged. EOF ends the adapter. Disconnect/cancellation never requests input replay
or agent shutdown. Accepted host creates can still finish; inspect their receipts.
The SDK's per-request cancellation token wraps the complete invocation, including
authentication and passive waits. A cancellation drops that invocation's host
connection and releases its MCP slot. An already accepted host operation retains
its original identity and continues independently; cancellation is not native
interrupt, rollback or permission to replay. Inspect the original receipt or
workflow mutation after an uncertain response. A cancellation already observed
before invocation takes precedence over validation and slot acquisition.
Dropping a client-side future alone is not the protocol cancellation notification.
The SDK controls whether a canceled request receives a wire response. Broader
protocol conformance remains an explicit audit item before the complete F10 gate.

References verified for this implementation:
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[official Rust SDK](https://github.com/modelcontextprotocol/rust-sdk).

## Verification and open gates

```powershell
cargo build --workspace --locked
cargo test --package nesvo --test mcp_host --locked -- --ignored --test-threads=1
```

The test needs built native binaries, so CI explicitly runs it after build on
Windows/macOS/Linux. Scenarios run serially on shared runners because each owns
a native host, probes and multiple PTYs; concurrent-client checks within each
scenario remain concurrent. An official SDK client connects to a separate native MCP
subprocess and isolated host. It checks catalog, create/replay, the same receipt
through CLI, passive read/diagnostics/events, Git errors, wrong scope rejection,
legacy initialization, host loss, bad/oversized stdio and clean PTY cleanup.
Native prompt tests cover MCP send, CLI same-key replay, delivered wait and
unsupported shell response correlation. A separate controlled Claude helper/PTY
fixture exercises CLI Unicode/multiline send and timeout without false idle.
The coordinator fixture is an explicitly controlled CLI process, not a model. It
creates a child using its own inherited context through the real CLI, then an SDK
client verifies matching receipts across MCP/CLI, child-only visibility, literal
send/correlated wait, human control refusal, reconnect and process-exit revocation.
Owner-supplied lineage, forged role/authority/current hints and workspace escape
cannot grant access. No model calls or changes to user sessions/provider settings.

The cancellation regression uses an original held fixture response, two cohorts
of four passive requests and actual SDK cancellation notifications in one MCP
process. A fifth read must observe `busy` with four pending requests. Read-only
requests rejected as busy may be replaced within fixed bounds; native submission
is never repeated. After cancellation the same process serves host queries, and
the original receipt/turn remain unchanged until explicit fixture release. Journal
events and terminal markers require one send, no interrupt/stop/failure, and one
natural settlement. The scenario keeps a ten-second acceptance deadline; this is
controlled PTY coverage, not an original-model or general protocol conformance claim.

Actual provider prompt-correlation coverage, MCP event streaming,
full durable run recovery and actual provider-to-child orchestration remain F10/F17
gates. A model-driven evaluation corpus for those workflows is also pending.
