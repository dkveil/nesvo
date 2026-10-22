# nesvo wire codec

The Rust host and terminal client share this library. It depends only on serialization, authenticated encryption, secure random generation and error handling. It has no dependency on Expo, PTYs, SQLite or either application.

`encode` / `decode` are the host-facing pair; `encode_client` / `decode_host` are the client-facing pair. Each frame authenticates the connection challenge, direction and sequence number. The applications own handshake freshness, sequence counters, transport, key storage and connection lifecycle. `random` uses the OS random source.

The JSON envelope, NaCl-compatible XSalsa20Poly1305 framing and size limits are unchanged by extraction. The host also re-exports this library as `nesvo_host::wire` for existing callers. See the [protocol contract](../../docs/protocol-v2.md) for application commands.

`events` is the typed domain event model the host appends through: one `Event` variant per journal kind with `serde` wire names and `schemars` schemas. It generates [harness-events.schema.json](../../docs/harness-events.schema.json) and the [kind table](../../docs/harness-events.md#event-kinds); regenerate with `NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo-wire --test event_contracts`.

```sh
cargo test --manifest-path crates/nesvo-wire/Cargo.toml
cargo clippy --manifest-path crates/nesvo-wire/Cargo.toml --all-targets -- -D warnings
```
