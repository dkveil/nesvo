<h1 align="center">nesvo</h1>

<p align="center">
  <strong>A terminal workspace. The same sessions on your phone.</strong>
</p>

<p align="center">
  <a href="#quick-start">quick start</a> ·
  <a href="apps/tui/README.md">terminal client</a> ·
  <a href="#docs">docs</a> ·
  <a href="CONTRIBUTING.md">contribute</a>
</p>

<p align="center">
  <a href="https://github.com/dkveil/nesvo/actions/workflows/ci.yml"><img src="https://github.com/dkveil/nesvo/actions/workflows/ci.yml/badge.svg" alt="Build and test status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555555?labelColor=222222" alt="MIT license" /></a>
</p>

---

**Keep the process on your computer. Pick up the same session from your phone.**

nesvo brings a native terminal workspace and a mobile companion to the same Rust host. Group your sessions, watch their output on multiple devices, and hand over control when you switch screens.

<p align="center">
  <img src="docs/assets/terminal-workspace.png" alt="nesvo Ultraviolet terminal start menu" width="1100" />
</p>

<p align="center"><sub>The native terminal client's start menu. Mobile connects to the same host and sessions.</sub></p>

## what you can do

- **Pick up the same shell** — move between TUI and mobile without starting another process. Your working directory, variables and running commands stay on the host.
- **Give your work some structure** — create groups and subgroups, rename them, and move sessions between them. Changes appear on connected clients; groups persist in SQLite.
- **Watch together, control deliberately** — multiple clients see the output. One controls input and terminal size. Takeover revokes the previous controller immediately.
- **Keep working after detach** — closing a client leaves its shells running while the host stays active. Restarting the host does not restore those processes.
- **Choose a directory and program** — launch a regular terminal, Claude Code, Gemini or Codex in an existing folder. The host detects installed CLIs. AI tools keep their own subscription login; nesvo does not require model API keys.
- **Stay in the terminal** — the Rust TUI has a group tree, two-pane views, keyboard and mouse navigation. Windows uses native ConPTY; no tmux or WSL is required.
- **See what needs attention** — both clients show activity, detected questions and approvals, and process completion or failure. Screen-based hints are distinguished from observed activity and exit results.

## quick start

**Early development:** build from source. Signed installers and TestFlight distribution are not available yet.

Clone the repository and start the host in your project directory:

```sh
git clone https://github.com/dkveil/nesvo.git
cd nesvo
cargo run --package nesvo-host -- --lan --workspace /path/to/your/project
```

Use an existing local path; on Windows, for example, `--workspace "C:\projects\my-app"`. Rust 1.88+ and your platform's native build tools are required.

In another terminal, open the desktop client:

```sh
cargo run --package nesvo -- --pairing host/.local/pairing.json
```

The start menu offers workspace, theme and phone pairing. **F1 returns to the menu; Esc detaches without stopping sessions.** In navigation, `n` creates a session, `d` deletes with confirmation, `g` / `G` create groups / subgroups and `v` splits the view. New sessions are ready for input automatically; **Ctrl+G returns to navigation**. [All shortcuts →](apps/tui/README.md#keyboard)

For the mobile preview, install Node.js and run:

```sh
npm ci
npm start
```

Use `npm.cmd` on Windows if PowerShell blocks npm's script. Open the project in a compatible Expo Go, then scan the **host's separate QR code** inside nesvo. Select **Przejmij sterowanie** (take control) before typing.

Start on the same LAN. The pairing code grants shell access; keep it private. [Phone setup, Expo sign-in and networking →](docs/quick-start.md)

## how it works

```mermaid
flowchart LR
    TUI["nesvo · terminal client"] <-->|Encrypted WebSocket| Host["nesvo-host · Rust"]
    Mobile["nesvo · iOS / Android"] <-->|Encrypted WebSocket| Host
    Host <--> Groups[("SQLite · groups")]
    Host <--> PTY["ConPTY / Unix PTY"]
    PTY <--> Tools["Your shell · Claude Code · Gemini · Codex"]
```

The host owns processes and shared state. Each client owns its view and focus. Closing a pane or switching devices does not move or duplicate the shell.

**Rust** for the host and TUI. **Expo / React Native + TypeScript** for mobile. **xterm.js** in the mobile WebView; **Ratatui + Crossterm + vt100** in the TUI. Node.js is used for tooling and tests.

The monorepo has separate build boundaries:

```text
apps/mobile/       Expo app, domain slices and mobile adapters
apps/host/         Rust host, process lifecycle and persistence
apps/tui/          Rust terminal interface
crates/nesvo-wire/ Shared Rust encrypted-frame codec
packages/brand/    Shared Ultraviolet tokens, vector mark and animation frames
tests/             Cross-client integration and architecture checks
```

One npm workspace lock and one Cargo workspace lock keep each ecosystem consistent. The clients communicate with the host through the [versioned protocol](docs/protocol-v2.md); the TUI does not depend on the host implementation.

## current boundaries

Groups, live sessions and control synchronize today. Pane layouts are local to each TUI: the split tree (up to four panes), tabs and named layouts are saved per paired host, with layouts and a default per repository, and are never shared between devices. Reconnect replays bounded output rather than a complete terminal screen snapshot, so full-screen programs may need a redraw.

Agent status detection is conservative and depends on the CLI's visible screen. Unrecognized states remain unknown; silence never means a task is complete. Status hints do not approve commands or answer questions automatically.

SSH connection management, automatic relay/VPN setup and native agent conversation views are future work. Existing external terminals cannot be adopted. Physical-device and interactive platform checks are tracked in the [testing guide](docs/testing.md); CI does not replace them.

## docs

| Start here                                         | Go deeper                                       |
| -------------------------------------------------- | ----------------------------------------------- |
| [Quick start and phone setup](docs/quick-start.md) | [Architecture](docs/architecture.md)            |
| [TUI usage and shortcuts](apps/tui/README.md)      | [Synchronization protocol](docs/protocol-v2.md) |
| [Host configuration](apps/host/README.md)          | [Engineering conventions](docs/engineering.md)  |
| [Testing and verification](docs/testing.md)        | [Design direction](docs/design.md)              |
| [Mobile priorities](docs/mobile-roadmap.md)        | Proposed scope and delivery order               |
| [Security](SECURITY.md)                            | [Contributing](CONTRIBUTING.md)                 |

## development

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test:client
npm run test:architecture
cargo test --workspace --locked
```

See [testing](docs/testing.md#local-checks) for real-host, browser and TUI integration checks. CI covers native Rust builds on Windows, macOS and Linux.

## license

[MIT](LICENSE). Dependencies retain their own licenses and notices.
