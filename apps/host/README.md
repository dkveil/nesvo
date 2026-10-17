# nesvo Rust host

Run from the repository root (Rust toolchain required). The Rust applications share the root Cargo workspace and lockfile:

```powershell
cargo run --manifest-path apps/host/Cargo.toml
# Reachable by your phone on the same trusted LAN:
cargo run --manifest-path apps/host/Cargo.toml -- --lan --advertise 192.168.1.20 --workspace C:/Users/Damian/dev
```

The Cargo package and executable are named `nesvo-host` (`nesvo-host.exe` on Windows). After building, the executable is in `target/debug/` or `target/release/`, depending on the build profile.

The default listener is loopback-only. `--lan` binds all interfaces; `--advertise` chooses the address in the pairing file. `--port` and `--bind` override the listener. Port zero chooses an unused port for tests. `POCKET_HOST_PORT` and `POCKET_HOST_ADDRESS` are equivalent environment settings. A phone needs access to that address and port through the host firewall. No port forwarding is required for a LAN test.

If startup reports that the address is already in use, a host may already be listening on the selected port (8787 by default). Reuse that host and its existing pairing file if it is yours. To run a second host, choose an unused port **and a separate pairing directory**, for example `--port 8788 --pairing-dir host/.local/secondary-8788`. Do not run two hosts against one pairing directory; it contains both the reusable key and the metadata database.

Pairing is saved in ignored `host/.local/pairing.json` when launched from the repository root. The matching `pairing.svg` can be opened locally and scanned from the phone. A standalone binary defaults to `%LOCALAPPDATA%/PocketSessions/pairing` on Windows or `$XDG_STATE_HOME/pocket-sessions` (fallback `~/.local/state/pocket-sessions`) on Unix. `--pairing-dir` overrides this directory.

The standalone data directories and `POCKET_*` environment variable names are retained for compatibility with existing installations. The nesvo rename does not change the pairing format, rotate the shared secret or move saved groups. Existing pairing files remain valid when the host address is unchanged.

Both files contain a reusable 256-bit shared secret and grant full shell access as the current OS user. This is not a one-time invitation. Keep them private, do not paste them into logs or commit them, and use `--rotate-key` then re-pair devices to revoke access. POSIX permissions are restricted; on Windows the files inherit the user directory ACL. The host prints only their locations, never the secret or QR contents.

The client and host authenticate and encrypt every command/output using NaCl-compatible XSalsa20Poly1305 secretbox, fresh random 24-byte nonces, and an authenticated connection challenge, direction and increasing sequence. Client authentication includes a fresh client nonce echoed by the host before the client trusts any event. The key is never transmitted over WebSocket. Only the initial host challenge is public. The implementation uses TweetNaCl in the app and RustCrypto `crypto_secretbox` in the host; the latter states that it has not received a security audit. This is a LAN prototype with no relay, TLS endpoint identity, per-device keys or forward secrecy. Keep the port off the public internet. Timing and message sizes remain visible.

Sessions use native OS PTYs through `portable-pty`: Windows ConPTY and Unix PTYs. Creation accepts `program: "shell" | "claude" | "gemini" | "codex"` (default `shell`) and an optional starting `cwd`. Shell uses Windows PowerShell or Unix `$SHELL` (fallback `/bin/sh`). A blank directory uses `--workspace`; relative paths resolve against it, and absolute paths can select any existing directory accessible to the host user. The host canonicalizes the path and rejects missing paths or files before starting a process.

Interactive sessions advertise `xterm-256color` and true color, and do not inherit `NO_COLOR` from the host process. CLI colors are chosen by the program running inside the session. Restart the host and create a new session to apply environment changes; existing processes keep the environment they started with.

Clients explicitly request `getCapabilities` to receive `{type:"capabilities", workspace, programs:[{id,label,available}], directoryBrowser:true, providerLimits:[...]}` with their optional `requestId` echoed. `listDirectories` returns canonical host paths for the interactive TUI folder picker. Discovery inspects PATH once at host startup. Restart the host after installation or PATH changes. Availability means the launcher was found, not that subscription login is complete. Sessions include their selected `program` in snapshots. Claude Code, Gemini CLI and Codex sessions retain their original interactive login and subscription behavior; nesvo does not provide model API credentials. Separately from sessions, the host starts a short-lived Codex app-server read-only probe every two minutes when Codex is installed. It reads account rate-limit percentages and broadcasts changes to clients. Claude and Gemini have no equivalent supported structured subscription-limit read, so their installed entries show the CLI command for checking usage instead of a guessed number. The probe does not read credential files or make model requests.

Native executables launch directly. On Windows, standard npm `.cmd`/`.ps1`/`.bat` shims resolve through the known package's `package.json` bin entry to an absolute JavaScript entrypoint plus `node.exe`. No user path is inserted into shell source. Custom wrappers without a supported package entrypoint are reported unavailable; they can still be run manually in a shell. On Unix, executable PATH entries launch directly. Programs run as the host's OS user and inherit its environment except for the interactive terminal color settings above.

Disconnecting a client leaves the shell running. A phone and the desktop TUI can watch the same sessions simultaneously. Each session has one controller with a fresh lease; an explicit takeover revokes the previous lease. Only that controller can send input or resize the canonical PTY grid. Viewers follow the same grid, and a client can subscribe to several sessions. Disconnect releases its leases without terminating processes.

Groups and subgroups are saved in `metadata.sqlite3` beside the pairing files. Run one host per pairing directory; the current metadata cache assumes a single writer. Group changes and session moves use a shared revision to reject conflicting edits. Parent cycles, missing parents and deleting nonempty groups are rejected. Groups survive host restart; session processes, their group assignments and output history do not. See the [protocol contract](../../docs/protocol-v2.md).

Reconnecting replays up to 128 KiB of recent output. This is bounded transcript replay, not a full screen snapshot; an old/full-screen application may need a redraw. Historical terminal report requests are filtered; the first controller receives original startup negotiation after its lease is granted. Eight sessions, sixty-four groups and sixteen connections are allowed. PTY event, socket output and input queues are bounded; slow clients disconnect. Input is never automatically resent.

The workspace is a default directory, not a filesystem sandbox. An authenticated shell has the OS user's normal filesystem and process access. Isolate untrusted work with a separate OS account or container.

Browser origins are limited to localhost/loopback, absent origins and local WebViews; extra exact origins can be comma-separated in `POCKET_ALLOWED_ORIGINS`. Encryption authentication is required regardless of origin. Do not enter the pairing secret into untrusted websites.

## Verification

`groups.rs` contains group invariants; `sessions.rs` owns application state, subscriptions and control leases. `pty.rs` owns native process handles and blocking I/O workers, while `process.rs` handles platform-specific lifecycle details and `launchers.rs` resolves installed tools. `replay.rs` contains pure transcript bounds and query filtering. `storage.rs` is the SQLite adapter; `protocol.rs` and `transport.rs` validate and exchange typed commands. `main.rs` composes these modules. The shared `nesvo-wire` crate has no process, database or application dependency.

```powershell
cargo fmt --manifest-path apps/host/Cargo.toml -- --check
cargo clippy --manifest-path apps/host/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/host/Cargo.toml
cargo build --manifest-path apps/host/Cargo.toml
node --import tsx --test tests/host.integration.test.ts
node --import tsx --test tests/sync.integration.test.ts
```

The integration tests start the Rust binary on ephemeral loopback ports and use the app's TweetNaCl wire codec. They cover authentication/replay rejection, browser origins, real shells, reconnect, multiple observers, private control leases, takeover, canonical dimensions, correlated creation, group revisions/cycles and SQLite reload. Launcher fixtures also verify cached discovery, unavailable tools, default/relative/external directories and Windows npm entrypoints with literal paths. They never invoke a real AI CLI. Each test creates and removes its own temporary pairing credentials and database. `NESVO_HOST_BINARY` can point the host integration test at a separate binary when the normal development executable is in use.

## Windows implementation note

`portable-pty` 0.9.0's cloned Windows process killer reverses the success check for `TerminateProcess`. `src/process.rs` uses an owned duplicate of the exact child handle with the correct return check and an already-exited race check. It never terminates by a reusable PID. See the upstream [WinChildKiller implementation](https://docs.rs/crate/portable-pty/0.9.0/source/src/win/mod.rs). ConPTY destruction runs outside shared state because closing a console may wait for pipe I/O; the input pipe is released first.
