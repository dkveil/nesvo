# Nesvo: review and session workflows

## Running the development build

On Windows run `nesvo-dev` (the installed shim for `scripts/nesvo-dev.cmd`). It builds the client and host from local source. An already running host is reused: building does not replace its process. Save work before deliberately stopping an older host, then start the launcher again. Features missing from an older host are disabled with an explanation; no sessions are silently terminated to upgrade it.

For an isolated test, build with `cargo build --workspace --target-dir target/verification`, start `target/verification/debug/nesvo-host.exe --port 0 --pairing-dir host/.local/review-test`, then in another terminal run `target/verification/debug/nesvo.exe --pairing host/.local/review-test/pairing.json`. Keep the host running. Pairing files grant access to its sessions and must stay private.

## Keyboard and focus

F4 opens Git review directly from terminal input as well as navigation; F4 or Escape closes it and restores input when opened from a terminal. The session sidebar is hidden during review. F6–F9 are also global. Other shortcuts apply in navigation mode. Global bindings can be changed in Settings → `k`; dialogs retain exclusive focus. `Ctrl+Q` returns from terminal input to navigation; normal input, including `Ctrl+K` and Escape, belongs to the program while typing.

| Key                       | Action                                                 |
| ------------------------- | ------------------------------------------------------ |
| `/`                       | Compact session/group search                           |
| `F2` in search            | Expand without losing the query                        |
| `Ctrl+K`                  | Open expanded palette                                  |
| `Tab` in expanded palette | All, sessions, groups, commands                        |
| Arrows / Enter / Escape   | Highlight / confirm / dismiss                          |
| `F4`                      | Open or close Git changes                              |
| `F6`                      | Toggle to the previously entered session               |
| `F7`                      | Enter the oldest unread, unmuted attention event       |
| `F8`                      | Saved launch templates                                 |
| `F9`                      | Explicitly restore sessions from previous host runs    |
| `u`                       | Mute/unmute alerts for the current session             |
| `f`                       | Select status filters; empty selection means all       |
| `n`, then `F2`            | New session and advanced launch options                |
| `N`                       | Session kind: agent with profile, terminal or review   |
| `S`                       | Scheduled sessions; refresh or cancel a pending launch |
| `J`                       | Jobs: list, details, history, form                     |
| `H`                       | Replay onboarding                                      |
| `w` when offered          | Confirm arming or disabling quota wake                 |

Search highlights preview sessions without activating another tab. Enter confirms the result. Snapshots preserve selection by identity. Sidebar arrows retain immediate preview navigation. Clicking a session row, tab or terminal explicitly enters that session, acquiring control only if it is free. Clicking an already controlled terminal preserves typing mode. Passive mouse movement over review never changes keyboard focus. Modals isolate keyboard and mouse focus. Settings previews the workspace and offers Ultraviolet, Graphite, Ocean, Sage, Amber and Rose.

## Git review

`F4` opens changes from the active session's repository on the host. The dock becomes a full workspace review on narrow screens. `e` expands review; `s` switches side-by-side when at least 100 columns are available. Up/Down selects files, Left/Right selects a hunk, Space folds that hunk, Page Up/Down scrolls, `c` switches scope, `r` refreshes, Tab changes focus and Escape closes.

Scopes are explicitly **unstaged**, **staged**, or **untracked**, not an inferred agent turn. Rename, deletion, additions, binary indicators and a clean repository are handled. File statistics describe the included patch and can be partial. Limits are 128 files, 8 KiB per patch, 24 KiB of total raw patches, and a serialized response below the wire limit of 64 KiB. Truncated results are labelled. Git commands time out after 10 seconds; unusually slow repositories can return an error. Non-UTF-8 filenames are not supported by the JSON path representation.

The visible review automatically refreshes every three seconds when no request is in flight. Refresh pauses behind dialogs and overlays. `r` still requests an immediate refresh.

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

The host adds `reqwest` 0.12 with Rustls and JSON for bounded asynchronous Expo push requests. Mobile adds SDK-matched `expo-notifications` 57.0.23 for native permission, registration and notification responses. Tokio's existing `fs` feature was enabled for bounded asynchronous untracked-file reads. Python capture dependencies are development-only and are not required to run Nesvo. macOS and Linux were not interactively verified in this change.

## Attention, titles and navigation history

The sidebar never reorders when attention arrives. `*` marks an unread event, `-` a muted session. Screen-derived events retain `~`; process exit is a separate evidence source. Repeated redraws and silence cannot create completed-work events. Entering a session acknowledges only the observed sequence, so a later question is not accidentally hidden. Muting is shared by clients and survives explicit process restoration.

Empty palette searches prioritize recently entered sessions. Merely highlighting a result does not alter history. Blank agent names opt into titles derived from the initial prompt or bounded OSC 0/2 title messages. A manual rename disables automatic titles. Native shell sessions still require a name.

Healthy host snapshots never reopen the active pane or change input mode. A late control grant after another keyboard/mouse action cannot steal focus from menus. After disconnect, input ownership must be explicitly reacquired. Local tabs, visible panes, fullscreen choice, collapsed groups and recent IDs persist per paired host. Deleted process IDs are discarded; restoring a process after a host restart creates a new ID rather than pretending the old process survived.

## Templates and recovery

`F3` in New session saves a named template on the host: program, working folder, group, prompt and worktree choice. A template opens an editable form via F8; it never launches on selection. At most 32 templates and 48 KiB of serialized template content are allowed. Template prompts are stored locally in the host metadata database.

The host saves launch descriptions independently of running processes. After restart it starts no old process automatically. F9 lists saved descriptions; Enter asks to start a new process in the recorded working directory. Previous prompts and worktree creation are not replayed. `c` instead opens Claude's `--resume` or Codex's `resume` conversation picker. The user chooses the conversation inside the provider CLI. Gemini conversation restoration is not implemented. A launch interrupted during restoration is labelled interrupted and cannot be automatically retried. `x` forgets a saved description or deletes a template without deleting project files. Large recovery lists are paginated (`]` next, `r` first page).

The launcher compares host source build identities. An older but compatible running host remains available to its sessions; the launcher reports the mismatch instead of terminating it. Stop that host deliberately when ready to use newly built host features.

## Mobile notifications

Native builds expose Settings → session notifications. Consent registers an Expo token through the authenticated host connection; disabling removes it on the host before clearing the phone preference. Up to eight tokens are stored in private host metadata. The app retains one host registration; disable the previous host before registering another. Disable notifications before forgetting or changing that host. Expo Go and web show an availability explanation.

The host sends only an opaque host ID, process ID, event sequence and generic event description to Expo. Terminal output, prompts, names, paths and pairing keys are excluded. A bounded queue sends each attention episode once, suppressing acknowledged, replaced or muted events before dispatch. A tap reconnects the saved host and opens the matching existing session; mismatched hosts and deleted sessions show a message. Mobile session controls offer mute/unmute and acknowledge the visible event.

Delivery uses a fixed HTTPS endpoint, ten-second timeouts, no redirects and bounded response bodies. The host checks Expo receipts after fifteen minutes and removes DeviceNotRegistered tokens. Transport failures are not blindly retried, to avoid repeating an ambiguously accepted notification. Queue and receipt tracking are in memory: a host shutdown or overflow can drop a notification. Attention remains visible in session state while the host is running. Neither an Expo ticket nor a receipt proves that a person saw the notification.

Push delivery requires a native build with valid APNs/FCM provisioning for the existing EAS project. SDK-matched package checks, iOS/Android/web bundle export and browser checks passed; delivery to a locked physical phone was not verified. Reference: [Expo notifications for SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) and [Expo push delivery](https://docs.expo.dev/push-notifications/sending-notifications/).

## Latest verification

Windows verification includes 96 TUI tests, 38 host tests, 3 wire tests, 16 mobile transport/domain tests, 17 real host/TUI/synchronization integration tests, architecture checks, formatting, Clippy, TypeScript and ESLint. A real ConPTY run verifies input ownership, Git review, palette, filters, templates/recovery dialogs, launch options, resize at 150×44, 100×32 and 80×24, and terminal restoration on exit. Host restart integration verifies persistent template identity, explicit restoration, muted-state recovery, and rejection of duplicate restoration. Browser testing covers the mobile web preview; it does not substitute for device push testing.

## Claude subscription usage

The host reads `CLAUDE_CONFIG_DIR/.rate-limits.json` (default `~/.claude/.rate-limits.json`) every 15 seconds, only when Claude is installed. This cache contains `{ "at": <Unix seconds>, "rate_limits": { "five_hour": { "used_percentage": 42, "resets_at": <Unix seconds> }, "seven_day": { ... } } }`. It rejects data older than 15 minutes, elapsed reset windows, invalid percentages, and oversized files. Missing data is unavailable, never zero.

To produce the cache, copy `scripts/nesvo_usage_cache.py` beside your Python Claude statusline script and call `from nesvo_usage_cache import cache_usage; cache_usage(data)` after reading its stdin JSON. It preserves the existing statusline output and stores only subscription windows. Claude supplies the fields on statusline updates; an idle session may have no fresh reading. See [Claude statusline data](https://code.claude.com/docs/en/statusline). No credential reading or model requests are involved. Gemini remains unavailable until there is a verified provider source; installed providers appear in the footer with an em dash when no current reading exists.

## Compact workspace and review target

The workspace header and footer each use one row. Click unused sidebar space or its heading to return to navigation without switching sessions. Git review defaults to a narrow panel; `[` / `]` resize it and `e` expands it. `o` edits the review directory on the host (empty resets to the session launch directory). The panel displays its directory and scope; it does not infer repositories from agent prose. `c` switches unstaged/staged/untracked. Refresh continues in fullscreen mode and retries requests unanswered for 15 seconds.

## Pointer scrolling, appearance and copy

Wheel input above a session preserves focus. Ordinary terminals use local scrollback; applications requesting mouse reporting receive coordinates relative to their pane using their selected SGR/UTF-8/legacy encoding, only while the client owns control. A read-only client cannot scroll a remote application's internal view. Applications without local history or mouse reporting cannot expose history through that mechanism.

Settings → Theme opens the full list with live preview. Enter applies the selection; Escape restores the original. Preview values are not persisted. The sidebar uses a compact solid-cell rendering of the canonical pixel wordmark; the intro retains its shared subtle logo animation and adds live session/connection context. No continuous workspace animation is added.

Shortcut keycaps use balanced inner padding and an outer gap in the footer, review, palette, workflow overlays and keyboard reference. Review hints wrap as complete key/description pairs. Diff additions/deletions have brighter text while retaining the existing backgrounds. In focused review, `y` copies the selected file's complete available patch (including only the returned portion when marked partial). Windows uses a hidden clipboard helper off the render loop with a five-second timeout and a single in-flight request; other platforms request OSC 52 clipboard copying, subject to terminal support. No remote host command is involved. Clipboard content delivery was not verified against the user's clipboard.

## Selection and focus refinements

Drag with the left mouse button inside the terminal or diff body, then release to copy the visible selection. Selection is client-local, bounded to that pane, and uses a frozen screen snapshot so incoming output cannot change the copied text mid-drag. Unicode and reverse selections are supported; this copies displayed cells (including diff gutters), not hidden scrollback. Keyboard input or resize cancels the selection. A successful clipboard write shows `Copied to clipboard.` in the bottom bar for three seconds; failures show an error instead.

`Ctrl+Q` explicitly reveals the sidebar even after entering review from a fullscreen session. `[` moves the right review panel's left boundary left (wider); `]` moves it right (narrower), starting from its actual current width. Folder and empty-state hints use the same padded keycaps. The compact wordmark uses solid half-block cells. Main-menu selection has a slow border pulse, without an arrow; `--no-animation` disables it, and no menu animation runs in the active workspace.
