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
The tool count is the length of the [catalog](harness-mcp-tools.json). Task instruction intents use
`nesvo_deliver_task` and `nesvo_cancel_task_delivery`; optional `sessionId` reuses
the task's own settled worker with the same refusals as `run deliver --session`; see
[guarded task delivery](harness-task-delivery.md).

`runDigests` adds read-only `nesvo_get_run_digest {runId}`, the same bounded
final or working-state digest as `nesvo run digest`; `nesvo_report_task_result`
accepts optional `nextSteps`. See
[run digest and working state](harness-workflows.md#run-digest-and-working-state).

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

`nesvo_validate_task_result` takes an optional `hostChecks:true` when the host
advertises `workflowHostChecks`. The host then runs the task's approved
`nesvo.toml` checks in the worker's host-created worktree before the validation
transaction and commits a `hostChecks` attestation (exit code, duration, bounded
output tail per check) distinct from the worker's claimed result; a failed check
refuses success. It adds no tool, and the tool count is unchanged. Callers cannot
supply the attestation. See [host-run checks](harness-workflows.md#host-run-checks).

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

**Generated contract.** Every tool is defined once in `apps/tui/src/mcp_tools.rs`: name,
description, a typed argument struct deriving `serde::Deserialize` and
`schemars::JsonSchema`, effect hints and the handler binding. The input schemas sent to
clients, the [name catalog](harness-mcp-tools.json) and the table below (effect and the
first sentence of each description) are derived from it. After a tool change run
`NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo --bin nesvo mcp_tools` and commit both
files; CI runs the same test without the variable and fails on drift.

| Tool                              | Effect      | Summary                                                                                                                                                                                                                       |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nesvo_get_provider_quota          | read-only   | Owner-only provider quota observations with source, freshness and completeness evidence.                                                                                                                                      |
| nesvo_set_quota_wake              | write       | Owner-only explicit enable/disable of one durable native Codex quota wake; requires durableQuotaWake:true.                                                                                                                    |
| nesvo_get_quota_wake              | read-only   | Owner-only read of the retained quota wake and its linked native send receipt identity for one stable session.                                                                                                                |
| nesvo_describe_precheck           | read-only   | Owner-only normalization/digest of a proposed command.                                                                                                                                                                        |
| nesvo_approve_precheck            | write       | Explicit owner trust for this exact command/cwd/argv/environment/duration/exit policy.                                                                                                                                        |
| nesvo_get_precheck                | read-only   | Owner-only immutable command approval, including revoked intent.                                                                                                                                                              |
| nesvo_list_prechecks              | read-only   | Owner-only bounded approval summaries without command arguments or execution.                                                                                                                                                 |
| nesvo_revoke_precheck             | write       | Owner-only exact-revision refusal of future executions.                                                                                                                                                                       |
| nesvo_get_precheck_mutation       | read-only   | Recover immutable original precheck approval/revocation acceptance.                                                                                                                                                           |
| nesvo_abandon_job_precheck        | write       | Owner-only explicit acknowledgement of an uncertain precheck's effects, abandoning its exact current generation before its Run was bound.                                                                                     |
| nesvo_abandon_job_launch          | write       | Owner-only logical abandonment of exact no-effect launch cleanup.                                                                                                                                                             |
| nesvo_create_job                  | write       | Owner-only durable once/cron/RRULE job definition.                                                                                                                                                                            |
| nesvo_authorize_job_quota         | write       | Owner-only explicit reader-context/account reauthorization of one queued or retry-waiting quota occurrence.                                                                                                                   |
| nesvo_get_job                     | read-only   | Owner-only read of a persisted definition and requested profile, without dispatch.                                                                                                                                            |
| nesvo_list_jobs                   | read-only   | Owner-only bounded job definition summaries.                                                                                                                                                                                  |
| nesvo_update_job                  | write       | Owner-only exact-revision replacement of future job intent, including optional launchNoEffect retry policy and executionTimeoutMs.                                                                                            |
| nesvo_set_job_enabled             | write       | Owner-only enable/disable of future automatic admissions.                                                                                                                                                                     |
| nesvo_run_job_now                 | write       | Owner-only deliberate new occurrence, including a disabled definition.                                                                                                                                                        |
| nesvo_cancel_job_occurrence       | destructive | Owner-only cancellation of one admitted job occurrence by stable job/occurrence IDs.                                                                                                                                          |
| nesvo_get_job_history             | read-only   | Owner-only bounded occurrence history with state, reason and workflow run pointer.                                                                                                                                            |
| nesvo_get_job_occurrence          | read-only   | Owner-only immutable occurrence profile and run pointer, including nullable launchReconciliation and retained launchResolution evidence.                                                                                      |
| nesvo_get_job_attempts            | read-only   | Owner-only read of eight retained dispatch generations for one exact job occurrence, including nullable launchReconciliation and launchResolution evidence.                                                                   |
| nesvo_get_job_attempt             | read-only   | Owner-only detail of one retained job dispatch generation, including bounded precheck evidence and nullable launchReconciliation/launchResolution.                                                                            |
| nesvo_get_job_mutation            | read-only   | Owner-only recovery of an original job mutation acceptance.                                                                                                                                                                   |
| nesvo_rebind_run_coordinator      | write       | Owner-only binding of retained run context to a different live native coordinator after the previous process is unavailable.                                                                                                  |
| nesvo_add_run_constraint          | write       | Owner-only append of literal manual constraints at the current run revision.                                                                                                                                                  |
| nesvo_list_run_constraints        | read-only   | Read eight append-only owner constraints and current acknowledgement revision.                                                                                                                                                |
| nesvo_acknowledge_run_constraints | write       | Deliberately attest reading the exact current constraint revision, using the current run revision.                                                                                                                            |
| nesvo_save_run_checkpoint         | write       | Capture an immutable bounded run metadata manifest once at the exact source revision.                                                                                                                                         |
| nesvo_list_run_checkpoints        | read-only   | Read eight immutable checkpoint headers in a visible run.                                                                                                                                                                     |
| nesvo_get_run_checkpoint          | read-only   | Read an immutable historical checkpoint page, at most eight parts / 24 KiB.                                                                                                                                                   |
| nesvo_read_run_context            | read-only   | Read current authoritative context for resume/compaction without input, process adoption, effect replay, inbox ACK or task validation.                                                                                        |
| nesvo_enable_run_wakes            | write       | Opt in to coalesced notices for the run's live coordinator.                                                                                                                                                                   |
| nesvo_get_run_wakes               | read-only   | Read wake policy and at most eight notice references.                                                                                                                                                                         |
| nesvo_disable_run_wakes           | write       | Disable future coordinator wake input using the exact current run revision.                                                                                                                                                   |
| nesvo_get_run_wake_batch          | read-only   | Inspect one wake batch, up to eight immutable notice references, and native receipt pointer/current phase.                                                                                                                    |
| nesvo_start_run_executor          | write       | Opt in to automatic dependency-ready task launch and immutable instruction delivery for an active run.                                                                                                                        |
| nesvo_get_run_executor            | read-only   | Inspect current executor policy/state.                                                                                                                                                                                        |
| nesvo_disable_run_executor        | write       | Disable new executor scheduling admissions at the exact run revision.                                                                                                                                                         |
| nesvo_enable_run_executor         | write       | Explicitly enable a fresh authenticated generation for an active run.                                                                                                                                                         |
| nesvo_deliver_task                | write       | Queue the immutable instruction of a current assigned task once.                                                                                                                                                              |
| nesvo_cancel_task_delivery        | write       | Cancel an unclaimed task instruction intent in an authorized run.                                                                                                                                                             |
| nesvo_launch_task                 | write       | Reserve a dependency-ready task, run parallel/retry capacity and a native create identity atomically, then launch its visible worker once.                                                                                    |
| nesvo_stop_run                    | destructive | Accept a durable stop intent for only this run's bound worker processes.                                                                                                                                                      |
| nesvo_cancel_run                  | destructive | Accept durable run cancellation and native stop of its bound workers only.                                                                                                                                                    |
| nesvo_get_run_control             | read-only   | Inspect at most eight target receipts/exit observations and aggregate native control state.                                                                                                                                   |
| nesvo_get_run_budget              | read-only   | Read a visible run's current policy, active attempts and activation/deadline clock.                                                                                                                                           |
| nesvo_set_run_budget              | write       | Replace a visible run's parallel, per-task attempt and elapsed limits at its exact run revision.                                                                                                                              |
| nesvo_drain_run                   | write       | Block new task assignments; allow assigned workers to report and parents to validate.                                                                                                                                         |
| nesvo_resume_run                  | write       | Resume new assignments after drain without resetting time/retry history or relaxing budgets.                                                                                                                                  |
| nesvo_get_host_budget             | read-only   | Read the explicit owner's persisted host admission policy and its revision.                                                                                                                                                   |
| nesvo_set_host_budget             | write       | Owner-only replacement of future admission limits at the exact budget revision.                                                                                                                                               |
| nesvo_ask_decision                | write       | Ask one durable question for this worker's exact current attempt.                                                                                                                                                             |
| nesvo_list_decisions              | read-only   | Read up to eight retained questions and answers in a run.                                                                                                                                                                     |
| nesvo_get_decision                | read-only   | Read the exact decision revision, audience and state before answering.                                                                                                                                                        |
| nesvo_answer_decision             | write       | Record a literal answer at the decision's exact revision.                                                                                                                                                                     |
| nesvo_cancel_decision             | write       | Withdraw a pending question at its exact revision, retaining a reason.                                                                                                                                                        |
| nesvo_read_inbox                  | read-only   | Read up to eight durable messages, without ACK or input.                                                                                                                                                                      |
| nesvo_send_message                | write       | Persist one addressed message for a stable key/correlation.                                                                                                                                                                   |
| nesvo_ack_messages                | write       | ACK 1–32 exact IDs in the receiving mailbox.                                                                                                                                                                                  |
| nesvo_list_sessions               | read-only   | List visible session IDs, groups and lifecycle without acquiring control.                                                                                                                                                     |
| nesvo_get_session                 | read-only   | Inspect one visible session and its independent process/agent/turn state.                                                                                                                                                     |
| nesvo_get_current_session         | read-only   | Inspect the process session injected into this MCP launch.                                                                                                                                                                    |
| nesvo_read_session                | read-only   | Read a bounded terminal replay page.                                                                                                                                                                                          |
| nesvo_explain_session             | read-only   | Explain this session's status evidence/readiness and integration health without exposing owner credentials or prompts.                                                                                                        |
| nesvo_read_diff                   | read-only   | Read repository changes on the host for this session's automatic edit context.                                                                                                                                                |
| nesvo_open_review                 | write       | Owner-only: open a host review of a session's or absolute folder's local changes, or fetch a GitHub pull request with gh into a host review checkout (120 s cap, reused when present).                                        |
| nesvo_deliver_review              | write       | Owner-only: deliver review feedback for an open reviewId to a ready idle agent session with one receipt.                                                                                                                      |
| nesvo_describe_worktree_setup     | read-only   | Owner-only: read the committed nesvo.toml [worktree] table of a repository (HEAD), its normalized setup/run/env_files/timeout_s, digest and approval state.                                                                   |
| nesvo_run_worktree                | write       | Owner-only: start the approved run steps of a session's host-created worktree after a passed setup.                                                                                                                           |
| nesvo_cancel_worktree             | write       | Owner-only: cancel the active setup or run steps of a session's worktree.                                                                                                                                                     |
| nesvo_archive_worktree            | destructive | Owner-only: remove a closed session's host-created worktree and its nesvo/ branch.                                                                                                                                            |
| nesvo_list_worktrees              | read-only   | Owner-only: list host-created worktrees (newest 128) with session, branch, presence, setup and run states, logs and archive facts.                                                                                            |
| nesvo_list_workflow_templates     | read-only   | Owner-only: read the committed nesvo.toml [[workflow]] templates of a repository (HEAD) with tasks, tool profiles, workspace modes, budgets, digest and approval state.                                                       |
| nesvo_start_workflow_template     | write       | Owner-only: create a run and its tasks from an approved template through the existing run create/plan/budget/activate/executor commands.                                                                                      |
| nesvo_read_events                 | read-only   | Read durable metadata events after a domain cursor.                                                                                                                                                                           |
| nesvo_create_session              | write       | Create one background process for a stable idempotency key.                                                                                                                                                                   |
| nesvo_send_prompt                 | write       | Submit one literal prompt to a ready idle session for a durable key.                                                                                                                                                          |
| nesvo_wait_prompt                 | read-only   | Passively wait for one send receipt by id or your original key.                                                                                                                                                               |
| nesvo_interrupt_session           | destructive | Submit one Ctrl+C with a durable key; never takes human control.                                                                                                                                                              |
| nesvo_stop_session                | destructive | Request native stop of this managed process once for a durable key.                                                                                                                                                           |
| nesvo_activate_run                | write       | Freeze a nonempty draft DAG at an expected revision.                                                                                                                                                                          |
| nesvo_assign_task                 | write       | Bind one existing worker process to a dependency-ready task.                                                                                                                                                                  |
| nesvo_get_task_attempts           | read-only   | Read a task and four retained attempts per page.                                                                                                                                                                              |
| nesvo_get_current_task            | read-only   | Read this authenticated worker's current task and attempt.                                                                                                                                                                    |
| nesvo_recover_run_context         | read-only   | Read current recovery metadata for the authenticated worker or uniquely bound coordinator run.                                                                                                                                |
| nesvo_report_task_result          | write       | Report this worker's exact current attempt result.                                                                                                                                                                            |
| nesvo_validate_task_result        | write       | Record owner/coordinator attestation of the current reported result.                                                                                                                                                          |
| nesvo_create_run                  | write       | Create a durable draft run once for a stable key.                                                                                                                                                                             |
| nesvo_list_runs                   | read-only   | List a bounded page of visible workflow summaries.                                                                                                                                                                            |
| nesvo_get_run                     | read-only   | Read a visible run and its draft DAG by stable run ID.                                                                                                                                                                        |
| nesvo_get_run_digest              | read-only   | Read a visible run's bounded 8 KiB digest: the final record stored when the run settled (succeeded, canceled, stopped or drained), otherwise a live working-state snapshot.                                                   |
| nesvo_set_run_plan                | write       | Atomically replace a draft DAG at an expected revision.                                                                                                                                                                       |
| nesvo_get_run_mutation            | read-only   | Recover the historical result of your workflow metadata mutation by its original key.                                                                                                                                         |
| nesvo_get_operation               | read-only   | Recover a durable operation by its ID or your original idempotency key.                                                                                                                                                       |
| nesvo_create_job_trigger          | write       | Owner-only registration of a disabled external job trigger with a separate secret and exact current job intent.                                                                                                               |
| nesvo_update_job_trigger          | write       | Owner-only exact-revision trigger filter/job-intent reauthorization.                                                                                                                                                          |
| nesvo_get_job_trigger             | read-only   | Owner-only retained trigger metadata/delivery inspection.                                                                                                                                                                     |
| nesvo_list_job_triggers           | read-only   | Owner-only retained trigger metadata/delivery inspection.                                                                                                                                                                     |
| nesvo_set_job_trigger_enabled     | write       | Owner-only explicit enable/disable for future external delivery.                                                                                                                                                              |
| nesvo_rotate_job_trigger          | write       | Owner-only exact-revision credential rotation with a never-used random secret.                                                                                                                                                |
| nesvo_revoke_job_trigger          | destructive | Owner-only permanent revocation of this trigger credential.                                                                                                                                                                   |
| nesvo_get_job_trigger_deliveries  | read-only   | Owner-only retained trigger metadata/delivery inspection.                                                                                                                                                                     |
| nesvo_get_job_trigger_delivery    | read-only   | Owner-only retained trigger metadata/delivery inspection.                                                                                                                                                                     |
| nesvo_get_job_trigger_mutation    | read-only   | Owner-only retained trigger metadata/delivery inspection.                                                                                                                                                                     |
| nesvo_list_recovery               | read-only   | Owner-only: list a bounded page of saved launch descriptions for sessions that are not running.                                                                                                                               |
| nesvo_restore_session             | write       | Owner-only: start one new process from a saved description in its recorded folder.                                                                                                                                            |
| nesvo_forget_recovery             | destructive | Owner-only: forget one saved description.                                                                                                                                                                                     |
| nesvo_list_attention_inbox        | read-only   | Owner-only: one page of needs-you items across sessions, runs, pending decisions and finished job results, sorted by priority.                                                                                                |
| nesvo_ack_attention_inbox         | write       | Owner-only: acknowledge 1–32 inbox items by id and revision.                                                                                                                                                                  |
| nesvo_list_pending_decisions      | read-only   | Owner-only: pending decisions across all runs, oldest first, eight per page with their run and inbox id.                                                                                                                      |
| nesvo_decide                      | write       | Owner-only: answer one pending decision by its ID at its current revision.                                                                                                                                                    |
| nesvo_list_projects               | read-only   | Owner-only: list the host's project registry (at most 256 repository roots), pinned first then by last activity, with default branch, open session count and their session IDs.                                               |
| nesvo_project_defaults            | read-only   | Owner-only: read one project's defaults: the usual launch folder (most launches), recent folders, the host-wide default layout name and the worktree setup state (nesvo.toml configured and approved digest, open worktrees). |

Worktree setup approval and revocation have no MCP tool; they exist only in the owner
CLI (`nesvo worktree approve-setup` and `revoke-setup`) and need owner authority. The
host refuses every worktree command with `forbidden` for session-scoped and wake
callers, so an agent running with its scoped capability cannot approve its own
repository-declared steps. Owner authority is not a human check: an agent that holds
the owner pairing file has it and can run
`nesvo --pairing C:\private\pairing.json worktree approve-setup`. A one-time
confirmation code or interactive confirmation is the planned human gate. Workflow
template approval follows the same rule (`nesvo workflow approve-templates` and
`revoke-templates`); the two template tools are owner-only too.

`attentionInbox` and `decisions` gate the four owner inbox tools. Acknowledging
hides one item revision durably and never answers a decision; `nesvo_decide`
replays the original reply when the exact answer is repeated, refuses any other
answer for answered or canceled decisions with `decision_resolved` and expired ones
with `decision_expired`, so a retried call never answers twice. See
[owner attention inbox](harness-cli.md#owner-attention-inbox-and-decisions).

`projects` gates `nesvo_list_projects` and `nesvo_project_defaults`. Both only read
the host registry; pinning, unpinning and setting a host-wide default layout stay
owner CLI acts. See [projects](harness-cli.md#projects).

`conversationResume` adds `resume:true` to `nesvo_restore_session`. The session
accepts no automated input until the provider confirms the exact conversation;
otherwise `resume.state` becomes `resumeFailed` with a reason. See
[exact conversation resume](harness-recovery-context.md#exact-conversation-resume).

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

## Event resources and subscriptions

The adapter advertises `resources` with `subscribe:true` so an orchestrating agent
can wait for host [domain events](harness-events.md) instead of polling
`nesvo_read_events`. No tool was added; the tool catalog is unchanged.

| Resource URI                  | Host page                                                |
| ----------------------------- | -------------------------------------------------------- |
| `nesvo://events`              | `readEvents` for every subject this caller may read      |
| `nesvo://events/operations`   | the same page keeping only `operation.changed` receipts  |
| `nesvo://events/session/{id}` | `readEvents` with `sessionId`, filtered by the host      |
| `nesvo://events/run/{runId}`  | the caller's page keeping `run.*` events of that `runId` |

`resources/list` returns the first two; `resources/templates/list` returns the
session and run templates. Each URI accepts `?after=CURSOR&limit=1-32` (default
`after=0`, `limit=32`); IDs are 1–128 ASCII letters, digits, `-` or `_`. Any other
URI, duplicate or unknown query key fails with `-32002` resource not found.
`resources/read` makes one bounded `readEvents` request through a fresh
authenticated connection and returns one `application/json` text content:
`{schemaVersion:1,ok:true,data}` with the host page fields (`events`, `nextCursor`,
`headCursor`, `floorCursor`, `gap`, `more`, `health`) plus `resource`; host
transport fields (`type`, `subscribed`, `requestId`) are removed. Run and
operation filtering happens after the host's subject authorization, so a page can
be empty with `more:true`; keep reading from `nextCursor`. Reads share the four
host-call slots, honor request cancellation and are never cached (`ttlMs:0`,
private scope). Host refusals keep their stable code in the JSON-RPC error `data`.

Subscribing opens one dedicated host `subscribeEvents` stream per URI. Without
`after` the stream starts at the current journal head; with `after` it resumes
from that cursor. Scoped callers get exactly the `readEvents` authority: a worker
defaults to its own subject and a foreign `sessionId` is refused. Protocol
`2026-07-28` clients use `subscriptions/listen` with `resourceSubscriptions`;
only valid event URIs, at most four, are acknowledged. A stream slot is reserved
for every acknowledged URI before any host connection opens, so `busy` opens
nothing. The streams then open in parallel; a host refusal of any URI releases
the streams already opened for the others and fails the whole listen request.
The SDK acknowledges before the host streams open, so that refusal arrives as the
listen request's error response.
Initialize-era clients (`2025-11-25` and older) use `resources/subscribe` and
`resources/unsubscribe`. Subscribing again to the same URI opens the replacement
first and releases the previous stream only after it is ready; a failed
replacement keeps the previous stream. At most four streams are active per adapter
process; a fifth URI fails with `busy` before connecting, while a replacement
reuses its URI's slot.

Each change is a `notifications/resources/updated` for the subscribed URI whose
`params._meta["nesvo/events"]` is:

```json
{
  "schemaVersion": 1,
  "resource": "nesvo://events/operations",
  "readUri": "nesvo://events/operations?after=41",
  "after": 41,
  "nextCursor": 44,
  "headCursor": 44,
  "sequences": [42, 44],
  "dropped": 0,
  "gap": false,
  "ready": false
}
```

The first notification has `ready:true` and `after` set to the starting cursor
(the journal head, or the `after` query); changes after it are always delivered.
The bridge reads the first host page before the stream counts as open and merges
it into that ready notification. Without `after` the page is normally empty, so
`sequences` is `[]`; with `?after=N` and a backlog, the ready notification already
lists the first page's matching `sequences` and its `nextCursor`, and reading its
`readUri` returns that backlog. A first page that already reports a retention gap
fails the subscribe or listen request with `cursor_expired`. Later notifications
are sent only when a page contains matching events. `after` is the cursor before
the first undelivered match, so reading `readUri` (then `nextCursor` while `more`) returns
exactly the delta. The bridge keeps one pending delta per stream and never stops
reading the host: while the client is slow, deltas coalesce, `after` keeps the
oldest undelivered cursor, at most 32 `sequences` are listed and `dropped` counts
older listed sequences that were removed. A dropped sequence is still covered by
`after`; nothing is lost while the journal retains it. `gap:true` means the
host retention expired before the cursor; the final notification then carries
`closed:{code:"cursor_expired"}` and the client must reconcile authoritative state
before subscribing again. Host loss (`disconnected`), expired process authority
(`scope_revoked`) and other stream errors also end that stream with a final
`closed` notification; resubscribe with `?after=` from the last notified cursor.
The host checks process authority again before every page it sends, and replaces
the first page after expiry with the `scope_revoked` error. No event is delivered
past revocation, but an idle stream reports `scope_revoked` only on the next
journal change.
Delivery is at least once; deduplicate by domain sequence.

Cancelling a `subscriptions/listen` request, `resources/unsubscribe` and stdin EOF
release the host subscription by closing its connection. Notifications are
change hints, never task results, acknowledgements or permission to replay input.

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

The event resource scenario (`support/mcp_events.rs`) drives one `2026-07-28`
discover client and one `2025-11-25` initialize client against a controlled host.
It checks the resource catalog, not-found URIs, bounded reads, acknowledgment of
valid URIs only, the `ready` cursor, a create receipt's `operation.changed`
notification on both paths, delta reads from `readUri` and `nextCursor`, and
stream release after `resources/unsubscribe`. Notifications are awaited with
deadlines, never fixed sleeps. Live-provider event streams remain unverified.

Actual provider prompt-correlation coverage, full durable run recovery and actual provider-to-child orchestration remain F10/F17
gates. A model-driven evaluation corpus for those workflows is also pending.
