# Nesvo: review and session workflows

## Running the development build

On Windows run `nesvo-dev` (the installed shim for `scripts/nesvo-dev.cmd`). It builds the client and host from local source. An already running host is reused: building does not replace its process. Save work before deliberately stopping an older host, then start the launcher again. Features missing from an older host are disabled with an explanation; no sessions are silently terminated to upgrade it.

For an isolated test, build with `cargo build --workspace --target-dir target/verification`, start `target/verification/debug/nesvo-host.exe --port 0 --pairing-dir host/.local/review-test`, then in another terminal run `target/verification/debug/nesvo.exe --pairing host/.local/review-test/pairing.json`. Keep the host running. Pairing files grant access to its sessions and must stay private.

## Keyboard and focus

These shortcuts apply in navigation mode. `Ctrl+Q` returns from terminal input to navigation; normal input, including `Ctrl+K` and Escape, belongs to the program while typing.

| Key                       | Action                                                 |
| ------------------------- | ------------------------------------------------------ |
| `/`                       | Compact session/group search                           |
| `F2` in search            | Expand without losing the query                        |
| `Ctrl+K`                  | Open expanded palette                                  |
| `Tab` in expanded palette | All, sessions, groups, commands                        |
| Arrows / Enter / Escape   | Highlight / confirm / dismiss                          |
| `D`                       | Open or close Git changes                              |
| `f`                       | Select status filters; empty selection means all       |
| `n`, then `F2`            | New session and advanced launch options                |
| `S`                       | Scheduled sessions; refresh or cancel a pending launch |
| `H`                       | Replay onboarding                                      |
| `w` when offered          | Confirm arming or disabling quota wake                 |

Search highlights preview sessions without activating another tab. Enter confirms the result. Snapshots preserve selection by identity. The sidebar retains its existing immediate preview navigation. Modals isolate keyboard and mouse focus. Settings previews the workspace and offers Ultraviolet, Graphite, Ocean, Sage, Amber and Rose.

## Git review

`D` opens changes from the active session's repository on the host. The dock becomes a full workspace review on narrow screens. `e` expands review; `s` switches side-by-side when at least 100 columns are available. Up/Down selects files, Left/Right selects a hunk, Space folds that hunk, Page Up/Down scrolls, `c` switches scope, `r` refreshes, Tab changes focus and Escape closes.

Scopes are explicitly **unstaged**, **staged**, or **untracked**, not an inferred agent turn. Rename, deletion, additions, binary indicators and a clean repository are handled. File statistics describe the included patch and can be partial. Limits are 128 files, 8 KiB per patch, 24 KiB of total raw patches, and a serialized response below the wire limit of 64 KiB. Truncated results are labelled. Git commands time out after 10 seconds; unusually slow repositories can return an error. Non-UTF-8 filenames are not supported by the JSON path representation.

Review is read-only. Git runs asynchronously outside the host state lock, with argument arrays and literal pathspecs. Refresh retains the selected path and review position when possible. There is no stage, discard, commit or agent-turn snapshot operation.

## Worktrees and scheduled launches

In the advanced new-session form, Space toggles Worktree. Tab/Shift+Tab moves between the checkbox, initial prompt, start time and buttons. A worktree uses a generated `nesvo/…` branch from HEAD and a sibling directory. Existing uncommitted source edits are not copied. Worktrees remain after session deletion for manual inspection and cleanup; creation is disabled outside a Git repository with a commit.

A blank start time launches immediately. `16:02` means **today at 16:02 in the host's local timezone**, and must be in the future. An RFC3339 timestamp with an explicit offset is also accepted. Times beyond 366 days are rejected. Prompts are literal CLI arguments, not shell commands. Terminal/shell sessions cannot use an agent prompt. Provider trust, authentication or permission questions can still require interaction.

The host persists scheduled jobs in SQLite and runs them independently of clients. It must stay running; this does not wake the computer or install an OS scheduler. There are at most 64 pending jobs. Jobs over 60 seconds late become missed. A launch interrupted by a host restart is marked interrupted, never silently retried. `S` shows the latest 128 jobs and supports refreshing and cancelling pending jobs. A failed launch may leave a prepared worktree; it is never automatically deleted.

## Quota wake

Installed providers retain their existing usage sources. Codex has a native account limit reading; Claude and Gemini currently direct users to their CLI usage commands. Unsupported readings are not presented as zero usage.

For a native Codex session, an explicit wake confirmation becomes available at **90% or more of the 300-minute window**, with a known reset. Arming requires a fresh reading and no other controller. The host sends one continuation only when a current-screen rate-limit marker is present and a fresh reading after reset confirms available quota, including other account windows. Silence is never evidence of completion or a quota limit.

Manual input cancels the plan. Plans expire five minutes after the reset, including when readings are stale, and do not survive host restart. Detection is deliberately conservative and depends on recognized English CLI messages. Automatic wake is not supported for Claude/Gemini or an agent launched inside an ordinary shell. An actual account reset cycle was not exercised in this verification.

## Protocol and mobile reuse

Capabilities advertise `gitDiff`, `advancedLaunch`, `schedules`, and `quotaWake`. Commands are `getDiff`, `launch`, `scheduleSession`, `listSchedules`, `cancelSchedule`, and `setWake`. Responses retain request correlation. Session data adds optional `rateLimited` and `wakeAt`; old clients ignore additive fields. Schedule notifications go only to clients that explicitly requested schedules, preserving compatibility with the existing mobile decoder.

The mobile client can reuse the host-side review and launch data after adding capability-gated protocol handling. Its touch layout and current stack have not been redesigned. Shared semantic program colors and theme definitions stay in `packages/brand`.

## Verification and previews

Verification targets Windows: Rust unit/render tests at 80×24, 100×32 and 150×44, Clippy, host/client protocol integration and a real ConPTY smoke run. Integration uses a local fixture CLI to exercise literal prompts and unattended scheduled startup, without a model request.

`docs/previews/*.png` captures the real Ratatui application running against an isolated real host through ConPTY. The terminal cells are rasterized with Cascadia Mono. The repository changes and session names are deliberate test fixtures, not screenshots of actual agent work. No mock UI or invented production output is used. The test host and processes are cleaned up after capture; user hosts are left running.

No new Rust crate was added. Tokio's existing `fs` feature was enabled for bounded asynchronous untracked-file reads. Python capture dependencies are development-only and are not required to run Nesvo. macOS and Linux were not interactively verified in this change.
