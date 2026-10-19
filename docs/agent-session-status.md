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
