# Agent session status

Claude sessions launched by Nesvo install session-scoped hooks alongside the existing automatic diff context hooks. Global Claude settings are not edited. The helper observes UserPromptSubmit, tool boundaries, PermissionRequest, AskUserQuestion, Notification, Stop and StopFailure. SessionStart and Stop mean idle; they do not mean that the process exited or that a task succeeded. Subagent events cannot mark the parent idle. Silence never clears a confirmed running state.

Only state and a sequence timestamp are stored in the private session directory. Prompts, responses and tool arguments are not persisted. Reports are atomically replaced and read asynchronously every 500 ms, outside the host mutex and PTY dispatch loop. Status broadcasts remain coalesced. Process exit has final precedence. Fresh visible UI evidence can supersede hook state after a short transition grace period, covering interruption and approval dialogs without treating ordinary output as semantic progress.

The wire contract remains compatible with older v2 clients: confirmed reports use `source: screen` with additive `evidence: hook`. Older clients show an inferred state; updated clients show confirmed running/idle/blocked/question/failed. Attention events retain a legacy-compatible source. TUI labels prefixed with `~` are screen inferences; open/quiet are terminal I/O observations only.

## Coverage and limits

- New Claude sessions: lifecycle events, with current-screen fallback. Restarting the Nesvo client alone cannot install hooks into an already running Claude process. Launch a new Claude session for hook support.
- Existing Claude sessions: current prompt and permission-mode footer identify idle; the interrupt footer identifies work. A real cursor at the prompt is required for idle.
- Codex: existing conservative current-screen inference for working, idle, questions and approvals. No direct lifecycle adapter is claimed.
- Gemini: existing approval screen inference. Its BeforeAgent/AfterAgent hooks are the preferred future adapter, but require a separate launch-scoped settings implementation; no global settings are overwritten.
- Agents started manually inside a generic shell do not inherit a dedicated provider adapter.
- Hooks disabled by user/managed settings fall back to screen inference. Unknown is deliberately retained when there is no trustworthy evidence.

References: [Claude hooks](https://code.claude.com/docs/en/hooks), [Gemini hook reference](https://geminicli.com/docs/hooks/reference/).

## Program Status Protocol (F01)

The host consumes live OSC 7501 (draft 0.4) and answers its feature probe before
the primary-device-attributes sentinel. It owns both replies, including when no
client is connected. Those queries and reports are removed before client output
and transcript storage; subscribing/replaying cannot re-answer or reapply them.
On Windows the first ConPTY cursor query is answered at the canonical origin,
allowing startup without an attached terminal. Later cursor queries retain the
existing controller contract.

Parsing is incremental across PTY chunks, bounded to 4096 bytes per sequence,
256 LRU records and the protocol's field/text limits. Reports with invalid IDs,
base64 or control characters are rejected. Bidi formatting is removed from decoded
labels. Root and child records remain independent, with inherited app identity;
clear removes a subtree, RIS clears all records, and OSC 133 A/process exit ends
live records. Completed/error records survive as informational facets. They do
not establish task success. Reply bytes are constant, ordered and bounded; text
from a report is never written to terminal input or interpreted as commands.

Snapshots expose a bounded `programStatus` facet: root report, child count,
blocked-child count and up to 32 inherited app IDs. Root state is projected into
legacy `status.source: screen`, with additive `confirmedSource: osc7501`.
Older clients still accept it as inference; updated clients distinguish reported
state. Full child messages are not broadcast in aggregate. Program-reported
`done` currently projects to idle while preserving the completion record;
turn/unread/task modeling is tracked separately under F08.

The protocol parser is verified with hostile/fragmented fixtures and a real PTY
provider fixture, including independent children and reconnect. Real Claude
2.1.303 delivered a SessionStart hook after folder/MCP consent. This establishes
hook delivery, not a claim that every installed provider/version emits OSC 7501.
Real OSC negotiation/provider coverage remains an explicit stage-1 gate.

Dependency: `base64` 0.22.1 (already present transitively in Cargo.lock) provides
strict padded/unpadded UTF-8 field decoding without a custom codec.
