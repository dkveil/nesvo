# Structured provider protocols

Evidence for the "structured" host mode (REV-259, packet REV-266 P00). Everything below comes from recordings in `tests/fixtures/structured/<provider>/<os>/{session,resume}.jsonl`, produced by `scripts/probes/`.

Pins: Claude Code 2.1.319, Codex CLI 0.156.0, Node 24.20.0, Windows 11 (10.0.26200). macOS column is empty until the same probes are run there.

## Running the probes

```
node scripts/probes/claude-stream.mjs [--os <name>] [--timeout-ms <n>]
node scripts/probes/codex-app-server.mjs [--os <name>] [--timeout-ms <n>]
```

`--os` defaults to `windows`, `macos` or `linux` from the host and selects the fixture directory. Each fixture line is `{"dir":"in"|"out","ms":<elapsed>,"msg":<raw JSON message>}`: `in` is provider to client, `out` is client to provider, messages are verbatim.

Claude probe deviations from the bare `claude -p ... --permission-mode default` command, all required to observe an approval request:

- `--permission-prompt-tool stdio`: without it `-p` never emits `control_request`.
- `--setting-sources project` and `--settings scripts/probes/claude-probe-settings.json` (rule `ask: Bash(echo:*)`): `echo` is auto-allowed by default and user allow rules would also skip the prompt. The ask rule arrives with `decision_reason_rule_source: "flagSettings"`.

Codex probe: `thread/start` with `approvalPolicy: "untrusted"`. The resume run is a second `codex app-server` process (`thread/resume` on the saved thread id, then a new turn), likewise for Claude (`--resume <session_id>` in a new process).

## Event map

| Need | Claude (`stream-json`) | Codex (`app-server`, JSON-RPC lines, no `jsonrpc` field) | Available |
|---|---|---|---|
| Init / session id | `{"type":"system","subtype":"init","session_id",...}` first non-hook line; also carries `cwd`, `model`, `permissionMode`, `claude_code_version`, `tools`, `mcp_servers` | `thread/start` response `result.thread.id`, then notification `thread/started` (`params.thread.id`, `sessionId`, `model`, `cwd`, `path` to rollout file) | Claude yes, Codex yes |
| Command list | `init.slash_commands` (names only, includes skills and built-ins), `init.terminal_slash_commands`; later changes via `{"type":"system","subtype":"commands_changed"}` | none | Claude yes, Codex no |
| Skill list | `init.skills` (names only), `init.agents`, `init.plugins` | request `skills/list {cwds:[...]}` returns `result.data[].skills[]` (`name`, `description`) and `errors`; notification `skills/changed` exists in schema, not observed | Claude yes (names), Codex yes (with descriptions) |
| Text block | `{"type":"assistant","message":{"content":[{"type":"text","text"}]}}` (complete block, no deltas without `--include-partial-messages`, not probed) | `item/started` + `item/agentMessage/delta` (`delta`) + `item/completed` with `item.type:"agentMessage"`, `item.text`, `item.phase` (`commentary` or `final_answer`) | yes / yes |
| Tool call | `assistant.message.content[]` block `{"type":"tool_use","id","name","input"}`; progress via `tool_progress` (`tool_use_id`, `elapsed_time_seconds`) and `system/task_started`, `system/task_notification` | `item/started` with `item.type:"commandExecution"` (`id`, `command`, `cwd`, `commandActions`, `status`); live output `item/commandExecution/outputDelta` (`delta`) | yes / yes |
| Tool result | `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}` | `item/completed` with `item.type:"commandExecution"` (`aggregatedOutput`, `exitCode`, `durationMs`, `status`) | yes / yes |
| Approval request | `{"type":"control_request","request_id","request":{"subtype":"can_use_tool","tool_name","input","description","tool_use_id","decision_reason_type","decision_reason_rule_source"}}` | server request `item/commandExecution/requestApproval` (`id`, `params.itemId`, `command`, `cwd`, `proposedExecpolicyAmendment`, `availableDecisions`); other server requests in schema: `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` | yes / yes (only command approval observed) |
| Approval response | `{"type":"control_response","response":{"subtype":"success","request_id","response":{"behavior":"allow","updatedInput":<input>}}}` | `{"id":<request id>,"result":{"decision":"accept"}}`; resolution echoed as `serverRequest/resolved` (`requestId`) | yes / yes |
| End of turn | `{"type":"result","subtype":"success","session_id","stop_reason","total_cost_usd","usage","permission_denials","terminal_reason"}` | notification `turn/completed` (`params.turn.status`, `durationMs`, `items` summary with final agent message) | yes / yes |
| Resume | new process with `--resume <session_id>`; same `session_id` returned in `init`, prior context kept (model recalled the earlier command) | new process, `thread/resume {threadId}`; response has `thread`, `model`, `approvalPolicy`, `sandbox`, `initialTurnsPage`; context kept | yes / yes |
| Interrupt | not probed; SDK control channel defines a `control_request` interrupt subtype | not probed; request `turn/interrupt {threadId,turnId}` exists in schema | unverified |
| Token usage and quota | `result.usage`, `rate_limit_event` | `thread/tokenUsage/updated`, `account/rateLimits/updated` | yes / yes |

All rows: provider version above, OS Windows. macOS: pending.

## Gaps and findings

- Codex has no command list at all: slash commands are TUI-only, `skills/list` is the only discovery call. A chat UI must ship its own command palette for Codex.
- Claude exposes names only for commands and skills (no descriptions or arguments) in `init`.
- Claude `-p` auto-allows read-only commands such as `echo`; approval requests only appear for tools that need them (or with an `ask` rule). The host must not assume one `control_request` per tool call.
- `--permission-prompt-tool stdio` is mandatory to receive `control_request` in headless mode.
- Hook activity pollutes both streams (`system/hook_started`, `hook_response`, `hook_progress` for Claude; `hook/started`, `hook/completed` for Codex). Clients must ignore unknown events.
- Claude init lists the user's slash commands, skills and agents from the environment, so it varies per machine.
- Codex emits many `mcpServer/startupStatus/updated` notifications during startup; they are not tied to a turn.
- Codex shell commands run as `powershell.exe -Command '<cmd>'` on Windows; `commandActions[].type` was `unknown` for `echo`.
- Codex `agentMessage` items arrive twice per turn: a `commentary` phase before the tool call and a `final_answer` after it. A reliable "final text" signal is `phase:"final_answer"` or `turn/completed.items`.
- Codex `thread/start` returns `result` before `thread/started` notification; the first usable id is in the response.
- Not probed: file-change approvals, permission-profile approvals, `item/tool/requestUserInput`, interrupt, partial-message streaming, `--resume` after a crash.
