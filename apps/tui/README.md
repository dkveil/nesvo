# nesvo terminal client

A native Rust client for the same host used by the mobile app. The host owns shells and processes. The TUI renders their screens, manages groups, and sends input only after acquiring control. Exiting the TUI disconnects the client and leaves host sessions running.

## Run

From the repository root, after starting the host:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --pairing host/.local/pairing.json
```

On Windows, `scripts/nesvo-dev.cmd` builds the current client and host source and starts the client from any working directory. Put a `nesvo-dev.cmd` shim in a directory on PATH to call it by name. Its dedicated pairing file is `host/.local/dev/pairing.json`; the script starts a hidden development host when that local pairing is unavailable and reuses a compatible running host otherwise. Set `NESVO_DEV_PAIRING` to another local host pairing file to reuse its sessions. A pairing file outside the repository's `host/.local/` directory requires a separately managed host. If the port is occupied by an incompatible process, the script reports the conflict without stopping it. Extra arguments such as `--list` are forwarded to the client.

If the pairing file advertises a LAN address, a client running on the host machine can override it with loopback:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --pairing host/.local/pairing.json --url ws://127.0.0.1:8787
```

Use the host's configured port. The pairing file grants access to its shells; treat it as a password and do not publish it. The client never prints the key. It does not create local PTYs, act as an SSH client, or use model API keys. Interactive `nesvo` refuses to launch from a terminal session created by a current nesvo host, preventing nested clients; `--list` remains usable for scripts.

The palette and block logo come from `packages/brand`. Ultraviolet is the default; Graphite uses a neutral accent with the same readable text, backgrounds and status colors. The logo animates on the start menu and empty workspace when it fits. Terminal sessions and other dialogs do not acquire animation-driven redraws. Add `--no-animation` for a static logo. Narrow terminals keep the text header and actions. The binary embeds the palette, glyphs and keyframes at build time and does not require Python or runtime asset files.

The start menu offers **Enter workspace**, **Pair mobile**, **Settings** and **Keyboard shortcuts** as clickable buttons. Use the arrows or Tab and Enter, click an action, or press 1–4. F1 returns to the menu. Settings opens over the workspace so theme changes preview its live sidebar and pane; the theme and full-screen-session default are saved locally in `%LOCALAPPDATA%/nesvo/preferences.json` on Windows and `$XDG_CONFIG_HOME/nesvo/preferences.json` (default `~/.config/nesvo/preferences.json`) on macOS/Linux. This file contains presentation preferences, never pairing credentials. Mobile currently uses Ultraviolet.

Noninteractive mode prints one authenticated JSON snapshot with the shape `{ "type": "sessions", "sessions": [...], "groups": [...], "revision": ... }`:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --list
```

Build a standalone executable on the target platform:

```sh
cargo build --manifest-path apps/tui/Cargo.toml --release --locked
```

The executable is `target/release/nesvo.exe` on Windows or `target/release/nesvo` on macOS/Linux. Building requires Rust 1.88 or newer. Running the executable requires neither Node nor Xcode. CI builds and tests these platforms; it does not replace manual testing in a particular terminal emulator.

See [review, scheduling, worktree and palette workflows](../../docs/tui-workflows.md) for the new shortcuts, host requirements, limits and verified previews.

Review sessions open as non-terminal tabs from `F4`, `N` → Review, or `nesvo review open`. They keep line comments per host review in `<config>/nesvo/review-<reviewId>.json` and send them to an agent with `s`.

## Keyboard

The start menu initially observes the first session without taking control. Entering the workspace, explicitly opening an available session, or creating one acquires its free control lease automatically and makes it ready for typing. This also completes Windows terminal startup negotiation. If another client controls the session, the view remains read-only; `t` opens a takeover confirmation. No navigation action silently takes control from another device.

| Navigation mode       | Action                                                  |
| --------------------- | ------------------------------------------------------- |
| Up / Down or j / k    | Select a row; preview its session immediately           |
| / or Ctrl+K           | Palette: sessions, groups, commands; prefixes @ $ ! #   |
| Enter                 | Open a session / collapse or expand a group             |
| Left / Right or h / l | Collapse / expand a group                               |
| i                     | Acquire available control and start typing              |
| t                     | Take control after confirmation                         |
| x                     | Release control                                         |
| n                     | Create a session: name, folder, and available program   |
| N                     | Session kind menu: agent, clean terminal or review      |
| p                     | Show private phone pairing instructions and file paths  |
| J                     | Open durable host jobs: list, details, history and form |
| W                     | Open runs: tasks, attempts, inbox, decisions, templates |
| O                     | Overview of all sessions; Enter jumps without control   |
| u in Overview         | Usage panel: provider quota, freshness, quota wake      |
| Y                     | Read-only Git view of the session repository (`Git`)    |
| T / Ctrl+T            | Project notes view / quick line into today's note       |
| S                     | Scheduled sessions: r refresh, x cancel a pending one   |
| f                     | Filter sessions by status; empty selection means all    |
| u                     | Mute / unmute attention alerts of the active session    |
| w                     | Confirm arming or disabling quota wake, when offered    |
| H                     | Replay the getting-started guide                        |
| g or G                | Create a group; choose root or a parent group           |
| r / m                 | Rename / move the selected item                         |
| d                     | Confirm deleting a session / deleting an empty group    |
| v / Tab / Shift+Tab   | Toggle two panes / focus the next / previous pane       |
| L                     | Layouts: apply, save, rename, delete, set the default   |
| 1 / 2 or F            | Sidebar: sessions / files; Files keys are listed below  |
| `[`                   | Narrower sidebar; with a diff dock open, a wider dock   |
| `]`                   | Wider sidebar; with a diff dock open, a narrower dock   |
| Page Up / Page Down   | Scroll local terminal history                           |
| F4                    | Toggle review: tab, or diff dock if narrow or old host  |
| F6 / F7               | Previous session / oldest unread attention event        |
| F8 / F9               | Launch templates / restore sessions from earlier runs   |
| ?                     | Open the keyboard reference                             |
| F1 or M               | Open the start menu (F1 also works while typing)        |
| z                     | Toggle full-screen terminal and workspace layouts       |
| Esc                   | Confirm exit from navigation; cancel an open form first |
| q / Ctrl+C            | Detach from navigation                                  |

F4, F6, F7, F8 and F9 are global: they work in navigation and while typing, but not inside dialogs or full views. F4 toggles the Git review, F6 returns to the previously entered session, F7 enters the oldest unread, unmuted attention event, F8 opens launch templates and F9 restores sessions from earlier host runs. Settings → `k` rebinds them: choose an action, press Enter, then an unused F3–F12 key (F1 and F2 are reserved); `r` restores the defaults.

`J` opens the Jobs view beside the sidebar and owns the keyboard until Esc steps back to navigation (Ctrl+C still quits); its one-row footer shows the keys of the current page. List: Up/Down or j/k select, Enter details, `n` new, `r` reload. Details: `e` edit (once jobs; recurring ones use `nesvo job edit`), Space pause/resume, `R` run now, `h` history, Esc back. History: Up/Down or j/k select, Enter inspect, `c` cancel occurrence, Esc back. Form: Tab or Down and Shift+Tab or Up move between fields, Left/Right or Space choose the agent, Ctrl+U clears a field, Enter saves, Esc discards. A failed read offers `r` to retry. See [the Jobs view](../../docs/harness-jobs.md#jobs-view-in-the-tui).

View-local keys:

- **Files sidebar** (`2` or `F`; `1` returns to Sessions): Up/Down or j/k move, Left/Right or h/l fold, Enter previews a file or folds a folder, `p` / `P` paste the relative / absolute path into the active session, `.` toggles hidden files, `r` refreshes, `o` pins the selected folder (again to unpin), Page Up / Page Down scroll the docked preview or move ten rows, Esc closes the preview and then returns to Sessions, Ctrl+P finds files. While Files is shown these replace the Sessions meanings of the arrows, `h` `j` `k` `l`, `p`, `r`, Page Up / Page Down and Esc.
- **Overview** (`O`): Up/Down or j/k, Page Up / Page Down (ten rows) and Home / End select a session, Enter jumps to it without taking control, `w` opens the quota-wake confirmation when it is offered or armed, `f` opens the status filters, `/` filters by text (Enter keeps the filter, Esc clears it), `u` toggles the usage panel when Overview is open as a full view, Esc or `O` closes it. In a layout's Overview pane, `O` focuses the pane and Esc or `O` returns focus.
- **Git view** (`Y`): Up/Down or j/k select, Tab / Shift+Tab switch between Staged, Unstaged, Untracked and Recent commits, Enter opens the selected file or commit diff, Page Down or `J` and Page Up or `K` scroll the diff by ten lines, `r` refreshes, Esc closes the diff and then the view (in a layout's Git pane it only returns focus; `Y` focuses it again), `q` closes the view.
- **Layouts** (`L`): Up/Down or j/k select, Enter applies the layout without taking control, `s` saves the current arrangement under a name, `r` renames, `d` deletes, `D` sets or clears the default, Esc or `q` closes; shipped layouts cannot be renamed or deleted. While naming, Enter confirms and Esc cancels.
- **Session kind** (`N`): Up/Down, Tab / Shift+Tab or j/k choose (j and k are typed while the PR URL row is selected), `1`–`3` pick Agent session, Clean terminal or Review directly, Enter opens, Esc cancels. Review then offers local changes of a session (`1`) and a GitHub PR URL (`2`; type or paste the URL, Enter opens, Esc goes back).
- **Review diff dock** (F4 on a host without reviews or with a content area under 88 columns; Tab in navigation focuses an open dock): Up/Down select a file, Left/Right a hunk, Space folds the hunk, Page Up / Page Down scroll, `e` expands, `s` toggles side by side from 100 columns, `c` cycles unstaged, staged and untracked, `r` refreshes, `y` copies the file's patch, `o` pins the review folder and `a` returns it to Auto, `[` / `]` widen / narrow the dock, Tab returns to navigation, Esc or F4 closes it.
- **Review tab** (F4, `N` → Review, or `nesvo review open`; Tab in navigation focuses an open tab): j/k or Up/Down move, Page Up / Page Down scroll a page and Ctrl+D / Ctrl+U half a page, `]` / `[` next / previous change, `f` / `F` next / previous file, Tab switches the file and diff panes, `/` searches, `w` wraps, `|` toggles side by side from 137 columns, `u` / `b` / `t` scope uncommitted / branch / this turn, `B` base, `v` selects lines, `c` comments, `C` summary, `e` / `d` edit / delete the comment on the line, `n` / `N` next / previous comment, `l` lists comments, `y` copies the review text, `s` sends it to an agent chosen in the palette, `r` refreshes, `q` closes the tab, F4 hides it, Esc steps back to navigation (first clearing a line selection or message). Comment, summary, search and base entry: Enter saves, Esc cancels, Ctrl+U clears, Ctrl+J or Alt/Shift+Enter add a newline to comments and summaries.

The empty workspace offers new session, group, and phone pairing actions. In the new-session form, Up/Down moves between name, folder, and program choices in both directions. Tab and Shift+Tab move through fields and footer buttons. Enter on the folder field opens a host-backed directory browser: type to filter the visible folders, Up/Down highlights a result, Enter chooses the highlighted path, Right enters the highlighted folder, Left returns to the parent, and F2 chooses the currently browsed path. Backspace edits the search; Ctrl+U clears it. **Use this folder** also chooses the currently browsed path. The initial path is the host workspace. Enter from the program field creates the session; footer buttons also respond to Enter. The host reports which programs are installed; unavailable programs cannot be launched. Older hosts without `directoryBrowser` keep the form open and show an update message instead of disconnecting. Agent programs use their own CLI subscription login. The current program is preselected when starting another session; a recognizable agent banner inside a shell also updates the local tab and sidebar label without changing the shell's colors or launcher identity.

The sidebar is one **Sessions** list: each group is a compact heading and its sessions appear immediately beneath it. Moving the selection to a session shows it in the pane without taking keyboard control; there is no separate active-session highlight. Sessions opened in the workspace keep their tabs when another session is selected. Click a tab to switch back or `+` to create another session tab. The pane does not repeat the tab name and status above the terminal. The one-line footer always identifies whether keys control the **SESSION** or **NAVIGATION** in nesvo. A violet pane border appears only while typing into that session. In input mode, ordinary keys (including `d`, Esc, Ctrl+C, Ctrl+K and Page Up / Page Down) go to the focused shell; only Ctrl+Q, F1 and the global function keys are handled by nesvo. **Ctrl+Q returns to navigation and reveals the sidebar even when full screen is enabled.** Selecting a session and pressing Enter returns to its terminal. From navigation, Esc opens a confirmation before disconnecting the client; Left/Right or Tab selects **Leave nesvo** or **Stay**, and Enter activates the selected button. **Stay** is selected by default. `q` and Ctrl+C detach directly from navigation. Host processes keep running in either case. F1 (or `M` in navigation) opens the start menu. `z` enables or disables full-screen sessions; click its violet footer handle to toggle it too. F11 is left to the outer terminal and operating system. Enter submits a form; Escape cancels it. Escape on the start menu also asks for confirmation, while Escape in Settings returns to the menu. Pasting honors the program's bracketed-paste mode, subject to the host limit of 8192 characters / 32 KiB per message. Clicking a session or pane returns to navigation; the mouse wheel scrolls local history. The TUI does not forward mouse events to programs inside the shell.

The sidebar starts with a clickable search field that opens a centered session palette. `/` and Ctrl+K open the expanded palette (sessions, groups and commands) in navigation mode; while typing in a terminal both keys belong to the shell. Type parts of a session name, agent, folder, or group; spaces combine terms and approximate spellings match by character order. Prefix the query with `@` for agents, `$` for terminals, `!` for sessions requiring attention, or `#` to find files in the Files folder (Ctrl+P in the Files sidebar starts the same search). Up/Down or Ctrl+P / Ctrl+N select and preview a result without acquiring control, Enter opens it, Tab expands a quick search and then cycles All, Sessions, Groups and Commands (Shift+Tab goes back), Ctrl+U clears the query, and Esc closes the palette. Compact rows show the program mark, session name, folder, and host-reported status. Wide terminals include the selected session's live terminal preview on the right; narrow terminals keep the results in a single column. Search does not read agent transcripts or rename sessions automatically.

Deleting a session is different from detaching: confirmation stops its process if running and removes it from every connected client's list. Delete confirmations focus **Cancel** initially; Left/Right chooses the action and Enter activates it. An empty group can be deleted; a group containing sessions or subgroups cannot. Recent terminal input/output is shown as **open**, not as agent work; **~working** appears only when a recognized agent screen shows a work indicator.

Press `p` in navigation mode to see the exact private QR and pairing file paths used by this connection. Open the QR image on the computer and scan it in the mobile app. The phone must be able to reach the host's advertised LAN or private VPN address; a loopback address works only on the host computer.

## Synchronization and limits

- Sessions use host-issued IDs. Groups, subgroups, names, and moves synchronize with other clients. Groups expand and collapse within the unified Sessions list. Tabs, the split tree (up to four panes), named layouts and focus belong to this TUI only; they are saved per paired host and never shared between devices. Applying a layout fills Agent and Terminal panes from recent live sessions without acquiring control; Files and Overview panes are placeholders until their views land.
- A single client controls each terminal. Only the current lease owner sends text, dimensions, or terminal query responses. Observers do not resize the shell. An observed terminal larger than its pane is clipped to the available area.
- VT100 interprets cursor positioning, ANSI colors, the alternate screen, and 3000 lines of local scrollback. This is a screen emulator, not a raw output log. It does not support every modern terminal extension, such as images or the Kitty keyboard protocol.
- The session screen uses the outer terminal's default foreground and background, while preserving explicit ANSI colors from the program. Because the outer terminal's RGB palette is unavailable, the client does not answer OSC 10/11 default-color queries on behalf of a program.
- The host replays a bounded transcript, not a complete VT snapshot. Joining a running full-screen program may require that program to redraw. Restarting the host does not restore its processes.
- Disconnection shows a reconnecting view for up to 20 seconds. A new authenticated connection reloads the host snapshot and restores the visible session when possible; a timeout exits with an error. User input and pending mutations are never retried automatically.
- Host protocol v2 is required. Outside the LAN, configure your own private network/VPN; this client does not create a public relay.

## Modules and checks

`main.rs` composes the CLI, `network.rs` handles pairing and the encrypted WebSocket, `model.rs` handles state and host events, `controller.rs` translates user intentions, and `launch.rs` owns launch choices and form editing. `input.rs` encodes keys, `terminal.rs` adapts VT state, `ui.rs` and `ui_launch.rs` only render, and `ui_controls.rs` shares control geometry with mouse hit testing. `jobs.rs` holds Jobs view state and host replies, `jobs_controller.rs` maps its keys, and `ui_jobs.rs` renders it. `brand.rs` renders the shared logo, `theme.rs` exposes generated colors, and `runner.rs` manages the event loop and terminal RAII cleanup. Rendering performs no I/O. Transport uses bounded queues and the shared `nesvo-wire` crate.

The event loop caches terminal dimensions and updates them from resize events, avoiding repeated synchronous Windows console queries. A fixed Ratatui viewport and `output.rs` batch frame text and cursor commands into one console write. Key releases, mouse motion, and successfully forwarded terminal input do not trigger redundant local redraws; host output updates the screen. Network draining has a time budget so high-volume output cannot monopolize input handling.

```sh
cargo fmt --manifest-path apps/tui/Cargo.toml --check
cargo clippy --manifest-path apps/tui/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/tui/Cargo.toml --locked
```

Unit tests cover input and VT response ownership, mode transitions, session creation correlation, the group tree, key encoding, alternate screens, and rendering through Ratatui TestBackend. A real PTY with concurrent clients is a separate integration test.

### Sidebar search and keyboard reference

Click the bordered Search sessions input, or navigate Up to it, to type a quick filter. Escape clears the query and returns to the session list. `/` and Ctrl+K open the expanded palette in navigation mode; F2 or Tab expands a quick search without losing its query. Main menu → Keyboard shortcuts (or `?`) shows the reference; Left/Right switch its Navigation, Sessions and Review pages. While typing in a session, use Ctrl+Q then z to toggle full screen; the reference lists this sequence. The highlighted session includes both its name and status/provider line.
