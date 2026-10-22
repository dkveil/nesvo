# Provider status signals

This page states, for every provider and every status signal the host publishes,
which mechanism produces the signal today and how that mechanism is proven. The
status fields themselves are defined in [host protocol v2](protocol-v2.md#observed-session-status)
and [agent session status](agent-session-status.md); this page is the audit of where
each value comes from.

## Mechanisms and proof levels

| Mechanism | Meaning                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| hook      | A launch-local provider lifecycle hook writes to the private launch journal; the host reads it every 500 ms (`status.evidence: hook`). |
| capture   | The opt-in Claude statusline capture records quota windows in the same journal.                                                        |
| read      | The host reads provider state itself: the Codex app-server quota snapshot, or the conversation ID recorded from a startup hook.        |
| screen    | A versioned rule in `apps/host/status-rules/v1.json` (or a tested code fallback) matched on the host's VT model of the current screen. |
| marks     | Shell prompt marks (OSC 133 `A`, `C`, `D;code`) parsed from live output; published as `source: screen`.                                |
| program   | A Program Status Protocol report (OSC 7501) from any program, published as `source: screen` with `confirmedSource: osc7501`.           |
| exit      | The observed process exit status.                                                                                                      |
| activity  | Terminal input/output timing only; never a semantic state.                                                                             |
| none      | Nothing produces the signal; the host keeps the last state or `unknown`.                                                               |

Proof levels: **U** a host unit test feeds the provider's documented payload or a
screen synthesized from the installed provider package through the production
mapper; **N** a native scenario drives the real host, PTY and helper with the
controlled fixture in `tests/fixtures`; **O** only an owner run with a real
account can prove delivery, listed below with the exact command.

## Matrix

| Signal                       | Claude                                                                                    | Codex 0.156.0                                                              | Gemini 0.65.0                                                                           | Shell                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Turn started                 | hook `UserPromptSubmit` (U, N)                                                            | hook `UserPromptSubmit` with `turn_id` fence (U, N)                        | none: hooks carry no turn ID; `BeforeAgent` only means working (U)                      | none; marks `C` mean a command started (U, N)                          |
| Turn ended with outcome      | hook `Stop` settled, `StopFailure` failed or quota, Ctrl+C then `Stop` interrupted (U, N) | hook `Stop` settled, `Interrupt` interrupted (U, N); no failure hook       | none: `AfterAgent` is idle without an outcome (U)                                       | marks `D;code` record the last exit code, no outcome (U, N)            |
| Idle                         | hook `Stop`, `SessionStart`, `Notification idle_prompt`; screen prompt rule (U, N)        | hook `Stop`, `SessionStart`; screen prompt rule (U, N)                     | hook `AfterAgent`, `SessionStart clear`; screen empty-prompt rule (U)                   | marks `A` at once (U, N); otherwise activity after 1.5 s quiet         |
| Working                      | hook prompt and tool events; screen interrupt footer (U, N)                               | hook prompt and tool events; screen working footer (U, N)                  | hook `BeforeAgent`, `BeforeTool`, `AfterTool`; screen cancel timer (U)                  | marks `C` until `D` or `A`, even when quiet (U, N); otherwise activity |
| Waiting for input (question) | hook `PreToolUse AskUserQuestion`, `Notification elicitation_dialog` (U, N)               | hook `PreToolUse request_user_input`; screen question layout (U)           | screen model selection only (U); no question hook                                       | none, by design                                                        |
| Permission prompt            | hook `PermissionRequest`, `Notification permission_prompt`; screen approval rules (U)     | hook `PermissionRequest`; screen approval rule (U)                         | hook `Notification ToolPermission`; screen approval rules (U)                           | not applicable                                                         |
| Setup and login blockers     | screen folder trust and MCP consent rules (U)                                             | none                                                                       | screen sign-in, authentication wait and folder trust rules (U)                          | not applicable                                                         |
| Error or crash               | hook `StopFailure`; exit (U)                                                              | exit only (U); no failure hook                                             | exit only (U); no failure hook                                                          | exit (U)                                                               |
| Quota or rate limit          | hook `StopFailure rate_limit`; capture; screen limit rule (U, N)                          | read app-server snapshot; screen limit rule and continuation editor (U, N) | screen limit rule (U); no structured source                                             | not applicable                                                         |
| Conversation ID for resume   | hook `SessionStart` (U, N)                                                                | hook `SessionStart` (U)                                                    | host-generated `--session-id`, rebound only by `SessionStart clear` (U); resume refused | not applicable                                                         |
| Freshness                    | hook bound 4000 ms (U)                                                                    | hook bound 4000 ms (U)                                                     | hook bound 4000 ms (U)                                                                  | no freshness claim                                                     |

Every provider publishes the same fields: `status {state, source, updatedAt}`,
`lifecycle.agent {current, lastKnown, blockReason, freshness}`, `lifecycle.turn`
(null for Gemini and shells), `readiness` and, for clients that negotiate it,
`status.freshness`. A field that a provider cannot back stays null or `unknown`
rather than being derived from silence.

## Gaps closed with fixtures

- Shell prompt marks. The output path now reads OSC 133 `C` (command started) and
  `D;code` (command finished) next to the existing `A` (prompt). A shell whose
  prompt emits these marks is idle as soon as the prompt is drawn and stays working
  through a quiet foreground command, instead of turning idle after 1.5 seconds.
  Input at the prompt drops the prompt mark so typing falls back to activity; input
  during a command does not end it. `nesvo session explain` shows
  `status.shellMarks {mark, lastExitCode}`. The exit code is diagnostic only: it
  never becomes `failed`, a task result or attention. Wire output stays
  `source: screen` so existing clients decode it unchanged. Proof:
  `shell_prompt_marks_are_reported_across_chunks_and_stay_visible`,
  `shell_prompt_marks_keep_quiet_commands_working_and_report_the_last_exit_code` and
  the native scenario `provider_signals::shell_prompt_marks_drive_working_idle_and_last_exit_code_through_the_native_pty`.
- Gemini working and idle screens. Catalog revision 2026-10-22.1 adds the 0.65.0
  response timer `(esc to cancel, Ns)` as working and the empty input placeholder as
  idle. The idle rule refuses when the timer, a focused or waiting embedded shell, or
  an `Allow once` choice is visible, using a new `none` condition (an absence list
  alone is rejected as a rule). By default Gemini hides its input while any approval
  or quota dialog is pending, so an empty prompt is not visible then. This gives
  unlinked installs working and idle evidence and settles a cancelled response:
  Gemini has no interrupt hook, so Esc followed by a newly drawn empty prompt now
  ends confirmed work, while an empty prompt alone still cannot. Proof:
  `gemini_065_synthesized_work_prompt_and_quota_screens_match_and_guards_hold` and
  `gemini_cancellation_settles_only_after_a_real_escape_and_a_new_empty_prompt`.
- Gemini quota screen. The 0.65.0 `Usage limit reached for …` dialog already
  matched the shared limit rule; it is now covered by the same synthesized test.

## Not available from the provider

- Codex 0.156.0 and Gemini 0.65.0 have no failure hook; errors show only as process
  exit or a later state.
- Gemini hooks carry no turn or prompt identity, so no host turn, prompt receipt or
  settled response is derived.
- A shell cannot tell a quiet command from one waiting on stdin; no waiting state is
  inferred.

Codex `notify` is not wired. An owner's Codex configuration can already set
`notify` for another program, and a launch override would replace it for managed
sessions; forwarding to the original program would make the host helper run
owner-configured commands, and the payload carries prompt and response text in the
command line. It would also add no evidence that the existing `Stop` hook lacks:
both report the same completed turn and pass the same turn fence, and whether
`notify` is subject to the hook trust review in 0.156.0 has not been shown. This
stays an owner decision.

## Owner live-run items

Each item needs a real login on the owner's machine. Run it against a host the owner
starts, never a test fixture, and compare the named field.

| Provider | Command                                                                                                                                                                                                                   | Field to check                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `nesvo session create "Live Claude" --key live-claude --program claude --json`, then `nesvo session send ID --key live-claude-1 --prompt "Run pwd" --json` and approve                                                    | `nesvo session explain ID --json`: `sessions[0].integration.delivery` is `received`; `status.hook.state` goes `blocked` then `idle`; `turn.phase` is `settled`                           |
| Claude   | Launch with `--claude-quota-display-profile ABSOLUTE_HOST_JSON_PATH`, send one prompt                                                                                                                                     | `sessions[0].nativeQuotaCallback.snapshot` is present; `nesvo quota --program claude --json`                                                                                             |
| Codex    | `nesvo session create "Live Codex" --key live-codex --program codex --json`; in that session run `/hooks` and accept the review; then `nesvo session send ID --key live-codex-1 --prompt "Run pwd" --json`                | `sessions[0].integration.delivery` is `received` and `turn.phase` is `settled`; a missing delivery stays `notObserved`                                                                   |
| Codex    | `nesvo quota --program codex --refresh --json`                                                                                                                                                                            | `providers[0]` windows and `refresh` acceptance                                                                                                                                          |
| Gemini   | `gemini extensions link PAIRING_DIR/gemini-extension`, accept the hook review, then `nesvo session create "Live Gemini" --key live-gemini --program gemini --json` and one prompt with a tool approval, `/clear` and exit | `geminiIntegration.ready` is `true`; `status.hook.state` goes `working`, `blocked`, `idle`; `status.matchedRule.rule` shows `gemini_work_v1` or `gemini_prompt_v1` when the screen leads |
| Gemini   | Press Esc during a response in the same session                                                                                                                                                                           | `status.selected` becomes `idle` with `source: screen` and `matchedRule.rule` `gemini_prompt_v1`                                                                                         |
| Shell    | In a shell profile that emits OSC 133 (for example Windows Terminal's PowerShell integration), run `Start-Sleep 30`                                                                                                       | `status.selected` stays `working` with reason `shell prompt marks (OSC 133); no task outcome inferred`; `shellMarks.lastExitCode` after a failing command                                |
