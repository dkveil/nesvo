# nesvo terminal client

A native Rust client for the same host used by the mobile app. The host owns shells and processes. The TUI renders their screens, manages groups, and sends input only after acquiring control. Exiting the TUI disconnects the client and leaves host sessions running.

## Run

From the repository root, after starting the host:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --pairing host/.local/pairing.json
```

If the pairing file advertises a LAN address, a client running on the host machine can override it with loopback:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --pairing host/.local/pairing.json --url ws://127.0.0.1:8787
```

Use the host's configured port. The pairing file grants access to its shells; treat it as a password and do not publish it. The client never prints the key. It does not create local PTYs, act as an SSH client, or use model API keys.

The palette and block logo come from `packages/brand`. Ultraviolet is the default; Graphite uses a neutral accent with the same readable text, backgrounds and status colors. The logo animates on the start menu and empty workspace when it fits. Terminal sessions and other dialogs do not acquire animation-driven redraws. Add `--no-animation` for a static logo. Narrow terminals keep the text header and actions. The binary embeds the palette, glyphs and keyframes at build time and does not require Python or runtime asset files.

The start menu offers **Enter workspace**, **Theme**, **Pair mobile**, and a **Full screen by default** toggle. Use the arrows and Enter, click an action, or press 1–4. Press **F1** or click **Menu** to return at any time. First-run guidance includes the theme choice; the selected theme and full-screen default are saved locally in `%LOCALAPPDATA%/nesvo/preferences.json` on Windows and `$XDG_CONFIG_HOME/nesvo/preferences.json` (default `~/.config/nesvo/preferences.json`) on macOS/Linux. This file contains presentation preferences, never pairing credentials. Mobile currently uses Ultraviolet.

Noninteractive mode prints one authenticated JSON snapshot with the shape `{ "type": "sessions", "sessions": [...], "groups": [...], "revision": ... }`:

```sh
cargo run --manifest-path apps/tui/Cargo.toml -- --list
```

Build a standalone executable on the target platform:

```sh
cargo build --manifest-path apps/tui/Cargo.toml --release --locked
```

The executable is `target/release/nesvo.exe` on Windows or `target/release/nesvo` on macOS/Linux. Building requires Rust 1.88 or newer. Running the executable requires neither Node nor Xcode. CI builds and tests these platforms; it does not replace manual testing in a particular terminal emulator.

## Keyboard

The start menu initially observes the first session without taking control. Entering the workspace, explicitly opening an available session, or creating one acquires its free control lease automatically and makes it ready for typing. This also completes Windows terminal startup negotiation. If another client controls the session, the view remains read-only; `t` opens a takeover confirmation. No navigation action silently takes control from another device.

| Navigation mode       | Action                                                 |
| --------------------- | ------------------------------------------------------ |
| Up / Down or j / k    | Select a session or group                              |
| Enter                 | Open a session / expand a group                        |
| Left / Right or h / l | Collapse / expand a group                              |
| i                     | Acquire available control and start typing             |
| t                     | Take control after confirmation                        |
| x                     | Release control                                        |
| n                     | Create a session: name, folder, and available program  |
| p                     | Show private phone pairing instructions and file paths |
| g / G                 | Create a root group / subgroup                         |
| r / m                 | Rename / move the selected item                        |
| d                     | Confirm deleting a session / deleting an empty group   |
| v / Tab               | Toggle two panes / change the focused pane             |
| Page Up / Page Down   | Scroll local terminal history                          |
| ?                     | Open help                                              |
| F1                    | Return to the start menu                               |
| F11                   | Toggle full-screen terminal and workspace layouts      |
| Esc                   | Detach from navigation; cancel an open form first      |
| q / Ctrl+C            | Detach from navigation                                 |

The empty workspace offers new session, group, and phone pairing actions. In the new-session form, Tab moves between name, folder, and program. Use arrow keys on the program field to choose Terminal, Claude, Gemini, or Codex. The host reports which programs are installed; unavailable programs cannot be launched. Leave the folder empty for the host workspace, enter a relative folder under that workspace, or supply an accessible absolute path. The host validates it before starting the process. Agent programs use their own CLI subscription login.

The workspace footer always identifies whether keys control the **INPUT** session or **NAVIGATION** in nesvo. In input mode, ordinary keys (including `d`, Esc, and Ctrl+C) go to the focused shell. **Ctrl+Q returns to navigation.** From navigation, Esc, `q`, or Ctrl+C detaches the client while leaving host processes running. F1 opens the start menu. F11 hides the spaces and agents sidebar and gives the terminal all available space above the one-line footer; press F11 again or click its footer label to restore the workspace. The menu's full-screen default applies when the TUI starts and can be changed without losing the theme setting. Enter submits a form; Escape cancels it. Escape exits directly from the start menu and returns from the theme picker to that menu. Pasting honors the program's bracketed-paste mode, subject to the host limit of 8192 characters / 32 KiB per message. Clicking a session or pane returns to navigation; the mouse wheel scrolls local history. The TUI does not forward mouse events to programs inside the shell.

Deleting a session is different from detaching: confirmation stops its process if running and removes it from every connected client's list. An empty group can be deleted; a group containing sessions or subgroups cannot.

Press `p` in navigation mode to see the exact private QR and pairing file paths used by this connection. Open the QR image on the computer and scan it in the mobile app. The phone must be able to reach the host's advertised LAN or private VPN address; a loopback address works only on the host computer.

## Synchronization and limits

- Sessions use host-issued IDs. Groups, subgroups, names, and moves synchronize with other clients. The two-pane layout and focus belong to this TUI only; layouts are not yet saved or shared between devices.
- A single client controls each terminal. Only the current lease owner sends text, dimensions, or terminal query responses. Observers do not resize the shell. An observed terminal larger than its pane is clipped to the available area.
- VT100 interprets cursor positioning, ANSI colors, the alternate screen, and 3000 lines of local scrollback. This is a screen emulator, not a raw output log. It does not support every modern terminal extension, such as images or the Kitty keyboard protocol.
- The session screen uses the outer terminal's default foreground and background, while preserving explicit ANSI colors from the program. Because the outer terminal's RGB palette is unavailable, the client does not answer OSC 10/11 default-color queries on behalf of a program.
- The host replays a bounded transcript, not a complete VT snapshot. Joining a running full-screen program may require that program to redraw. Restarting the host does not restore its processes.
- Disconnection disables input. Restart the client to reconnect. User input is never retried automatically.
- Host protocol v2 is required. Outside the LAN, configure your own private network/VPN; this client does not create a public relay.

## Modules and checks

`main.rs` composes the CLI, `network.rs` handles pairing and the encrypted WebSocket, `model.rs` handles state and host events, `controller.rs` translates user intentions, and `launch.rs` owns launch choices and form editing. `input.rs` encodes keys, `terminal.rs` adapts VT state, `ui.rs` and `ui_launch.rs` only render, and `ui_controls.rs` shares control geometry with mouse hit testing. `brand.rs` renders the shared logo, `theme.rs` exposes generated colors, and `runner.rs` manages the event loop and terminal RAII cleanup. Rendering performs no I/O. Transport uses bounded queues and the shared `nesvo-wire` crate.

The event loop caches terminal dimensions and updates them from resize events, avoiding repeated synchronous Windows console queries. A fixed Ratatui viewport and `output.rs` batch frame text and cursor commands into one console write. Key releases, mouse motion, and successfully forwarded terminal input do not trigger redundant local redraws; host output updates the screen. Network draining has a time budget so high-volume output cannot monopolize input handling.

```sh
cargo fmt --manifest-path apps/tui/Cargo.toml --check
cargo clippy --manifest-path apps/tui/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/tui/Cargo.toml --locked
```

Unit tests cover input and VT response ownership, mode transitions, session creation correlation, the group tree, key encoding, alternate screens, and rendering through Ratatui TestBackend. A real PTY with concurrent clients is a separate integration test.
