# nesvo

Use the same terminal sessions from your computer and phone. This repository contains an Expo / React Native client for iOS and Android, a Rust host that owns processes, and a native Rust terminal client for Windows, macOS and Linux.

This is an early implementation. Demo conversations are explicitly labeled; they are not responses from an AI provider. Real shells run on your computer through the Rust host.

[Architecture](docs/architecture.md) · [Engineering conventions](docs/engineering.md) · [Protocol](docs/protocol-v2.md) · [Testing](docs/testing.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Available now

- Create, observe and stop multiple real terminal sessions.
- Organize sessions into groups and nested subgroups; rename groups, move sessions and delete empty groups.
- Synchronize groups and session identities across mobile and TUI clients. Group metadata persists in SQLite.
- Watch the same shell on several devices. Explicitly acquire or transfer control; only the current controller can type or resize its PTY.
- Use a native TUI with a group tree, one or two terminal panes, keyboard navigation, mouse selection and local scrollback.
- Pair through a private QR code or JSON file and exchange authenticated, encrypted WebSocket messages.
- Keep shells running when a client disconnects, as long as the host process and computer remain active.
- Try a clearly labeled mobile demo without a host or AI account.

The mobile terminal uses bundled xterm.js in a WebView. The TUI uses Ratatui, Crossterm and vt100. The host uses portable-pty, Tokio and SQLite. Node.js is used for Expo tooling and tests, not as the terminal server.

Installed Claude Code and Codex CLIs run normally inside the host's shell and retain their own subscription login. This application does not request AI API keys or call models on your behalf. Normal shell commands, Git and development tools also run on the host.

## Start the mobile preview

Install Node.js with npm and a stable Rust toolchain. The TUI requires Rust 1.88 or newer; native Rust dependencies may require your platform's C/C++ build tools. Android Studio and Xcode are not required for a browser preview or Expo Go on a physical phone.

From the repository root on Windows:

```powershell
npm.cmd ci
npm.cmd start
```

On macOS/Linux, use `npm ci` and `npm start`. The `.cmd` suffix on Windows avoids PowerShell's script execution-policy issue without changing that policy.

Install Expo Go on your phone and scan Expo's QR code. For the first test, use the same reachable LAN as the computer. The app targets **Expo SDK 57**, matching the iPhone's App Store Expo Go during verification on October 16, 2026. Do not upgrade until the store app or a development build supports the new SDK; all native packages must match it.

Expo Go on a physical iPhone also requires the same Expo account in the app and CLI. Sign in on the computer, then sign into that account in Expo Go:

```powershell
npx.cmd eas-cli@latest login --device
npx.cmd expo whoami
```

Complete any account confirmation in the browser. Opening the Expo dashboard alone does not prove that CLI authentication completed. [Expo sign-in requirements](https://docs.expo.dev/troubleshooting/expo-go-sign-in-required/).

For the web preview, run `npm.cmd run web`. Browser testing helps with layout and communication; it does not verify the native iPhone keyboard, camera, safe areas, clipboard or WebView lifecycle.

## Connect a real shell

Start the host in another terminal, using an existing workspace directory:

```powershell
cargo run --manifest-path host/Cargo.toml -- --lan --workspace "C:\Users\Damian\dev"
```

On macOS/Linux, use a local workspace path. The first build takes longer. `--lan` listens on the network; the phone must reach the advertised address and port through the firewall. See the [host guide](host/README.md) for options.

In the mobile app, open pairing and scan the **host's** QR code or paste its JSON. Create a session, choose **Przejmij sterowanie** (take control), then run `pwd` or `ls`. Other clients can watch output without sending input or resizing the shell. Use **Grupy** (groups) to organize sessions.

There are two QR codes: Expo's opens the development app; the host's grants access to its terminal sessions. Opening Expo Go does not pair the host.

Going back to the session list or disconnecting leaves the process alive. Stopping a session terminates its process. Restarting the host does not restore running shells; only group metadata persists.

## Start the native terminal client

With the same host running, open another terminal:

```powershell
cargo run --manifest-path tui/Cargo.toml -- --pairing host/.local/pairing.json
```

If the host advertised a LAN address, a local client can override just the connection address:

```powershell
cargo run --manifest-path tui/Cargo.toml -- --pairing host/.local/pairing.json --url ws://127.0.0.1:8787
```

Use the host's actual port. In navigation mode: `n` creates a shell, `g` creates a group, `G` creates a subgroup, `i` acquires available control, `t` confirms takeover, and `v` toggles two panes. **Ctrl+G returns from terminal input to navigation; `q` detaches without stopping the shells.**

See the [TUI guide](tui/README.md) for all shortcuts and the [terminal architecture](docs/terminal-client.md) for implemented and planned capabilities. No tmux or WSL is required for the native Windows client.

## Scope and limitations

- The host creates its own sessions; it cannot take over an arbitrary terminal already running in another application.
- SSH connection management, automatic VPN setup and a public relay are not implemented. A privately configured VPN can provide reachability; LTE/5G operation has not yet been verified.
- Group metadata is durable. Pane layouts are local to each TUI and are not persisted or synchronized yet.
- Reconnection replays a bounded transcript, not a complete VT screen snapshot. Late attachment to full-screen programs may require a redraw.
- Agent conversation, approval and change-review views remain demos. Real Claude Code or Codex currently runs through the terminal.
- There is no local Claude Code/Codex runtime on the iPhone.
- Ready-to-install, signed releases and TestFlight distribution are not available yet.

EAS can build iOS applications on hosted macOS while development happens on Windows. TestFlight requires Apple Developer enrollment, signing and App Store Connect configuration. The project currently uses Expo Go on the physical iPhone. [Development builds](https://docs.expo.dev/develop/development-builds/introduction/) and [iOS submission](https://docs.expo.dev/submit/ios/).

## Repository map

```text
src/app/               Expo Router routes and navigation composition
src/state/             application state and shared host connection
src/connection/        validated protocol, authentication and transport
src/groups.ts          pure group-tree helpers
src/terminal/          bundled xterm.js renderer and native/web adapters
host/                  Rust process owner, protocol, groups and SQLite
tui/                   native Rust client: model, input, rendering and transport
scripts/               build tooling
tests/                 client, host and browser integration checks
docs/                  architecture, protocol, conventions and verification
```

After changing renderer sources, run `npm.cmd run terminal:build` to rebuild the generated asset.

Common checks:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:client
cargo test --manifest-path host/Cargo.toml --locked
cargo test --manifest-path tui/Cargo.toml --locked
cargo build --manifest-path host/Cargo.toml --locked
npm.cmd run test:host
npm.cmd run test:sync
```

CI runs native Rust checks on Windows, macOS and Linux. The [testing guide](docs/testing.md) distinguishes automated checks from physical-device verification.

The pairing file contains a reusable shell-access secret. Keep it private. `.local/`, build outputs and local verification artifacts are ignored by Git. `--workspace` sets the initial directory; it is not a sandbox. Read [SECURITY.md](SECURITY.md) before using the host.

License: [MIT](LICENSE). Dependencies retain their own licenses and notices. Herdr and the user-provided accounting application informed architectural decisions; their source code is not incorporated into this repository.

Some internal storage and Expo identifiers retain their original values to preserve existing pairing and project linkage. See [branding and compatibility](docs/branding.md).
