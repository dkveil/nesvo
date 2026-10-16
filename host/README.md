# Pocket Sessions Rust companion

Run from the repository root (Rust toolchain required):

```powershell
cargo run --manifest-path host/Cargo.toml
# Reachable by your phone on the same trusted LAN:
cargo run --manifest-path host/Cargo.toml -- --lan --advertise 192.168.1.20 --workspace C:/Users/Damian/dev
```

The default listener is loopback-only. `--lan` binds all interfaces; `--advertise` chooses the address in the pairing file. `--port` and `--bind` override the listener. Port zero chooses an unused port for tests. `POCKET_HOST_PORT` and `POCKET_HOST_ADDRESS` are equivalent environment settings. A phone needs access to that address and port through the host firewall. No port forwarding is required for a LAN test.

Pairing is saved in ignored `host/.local/pairing.json` when launched from the repository root. The matching `pairing.svg` can be opened locally and scanned from the phone. A standalone binary defaults to `%LOCALAPPDATA%/PocketSessions/pairing` on Windows or `$XDG_STATE_HOME/pocket-sessions` (fallback `~/.local/state/pocket-sessions`) on Unix. `--pairing-dir` overrides this directory.

Both files contain a reusable 256-bit shared secret and grant full shell access as the current OS user. This is not a one-time invitation. Keep them private, do not paste them into logs or commit them, and use `--rotate-key` then re-pair devices to revoke access. POSIX permissions are restricted; on Windows the files inherit the user directory ACL. The host prints only their locations, never the secret or QR contents.

The client and host authenticate and encrypt every command/output using NaCl-compatible XSalsa20Poly1305 secretbox, fresh random 24-byte nonces, and an authenticated connection challenge, direction and increasing sequence. Client authentication includes a fresh client nonce echoed by the host before the client trusts any event. The key is never transmitted over WebSocket. Only the initial host challenge is public. The implementation uses TweetNaCl in the app and RustCrypto `crypto_secretbox` in the host; the latter states that it has not received a security audit. This is a LAN prototype with no relay, TLS endpoint identity, per-device keys or forward secrecy. Keep the port off the public internet. Timing and message sizes remain visible.

Sessions use native OS PTYs through `portable-pty`: Windows ConPTY with PowerShell, and Unix PTY with `$SHELL`. Shells launch only after a user creates a session. No model calls, API credentials, Claude/Codex startup or subscription authentication are automated. Installed tools can be launched manually in a session.

Disconnecting the phone leaves the shell running. Reconnecting replays up to 128 KiB of recent output. This is bounded transcript replay, not a full screen snapshot; an old/full-screen application may need a redraw. Historical terminal report requests are suppressed on subsequent attachments, preventing replay from generating fresh terminal input; first attachment preserves startup negotiation. Sessions do not survive host restart or OS shutdown. History stays in memory. Eight sessions and sixteen connections are allowed, with one active controller per session. PTY event, socket output and input queues are bounded; slow clients disconnect. Input is never automatically resent.

The workspace constrains only the initial directory, not commands inside the shell. An authenticated shell has the OS user's normal filesystem and process access. Isolate untrusted work with a separate OS account or container.

Browser origins are limited to localhost/loopback, absent origins and local WebViews; extra exact origins can be comma-separated in `POCKET_ALLOWED_ORIGINS`. Encryption authentication is required regardless of origin. Do not enter the pairing secret into untrusted websites.

## Verification

```powershell
cargo fmt --manifest-path host/Cargo.toml -- --check
cargo clippy --manifest-path host/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path host/Cargo.toml
cargo build --manifest-path host/Cargo.toml
node --import tsx --test tests/host.integration.test.ts
```

The integration test starts the Rust binary on an ephemeral loopback port and uses the app's TweetNaCl wire codec. It verifies wrong-key rejection, replay rejection, browser origin checks, real shell output, state surviving reconnect, competing controllers, terminal dimensions and two-session cleanup. It creates and removes its own temporary pairing credentials.

## Windows implementation note

`portable-pty` 0.9.0's cloned Windows process killer reverses the success check for `TerminateProcess`. `src/process.rs` uses an owned duplicate of the exact child handle with the correct return check and an already-exited race check. It never terminates by a reusable PID. See the upstream [WinChildKiller implementation](https://docs.rs/crate/portable-pty/0.9.0/source/src/win/mod.rs). ConPTY destruction runs outside shared state because closing a console may wait for pipe I/O; the input pipe is released first.
