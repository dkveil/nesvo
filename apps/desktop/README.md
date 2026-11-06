# nesvo desktop

Tauri 2 desktop client for the host protocol v2. The Rust side (`src-tauri`) holds the pairing key, authenticates with `nesvo-wire` and forwards decoded `sessions` snapshots to the React UI. TypeScript protocol types in `src/shared/api/contracts` are generated from `docs/*.schema.json` by `npm run contracts:types`.

## Run

```
npm ci
cargo install tauri-cli --version "^2" --locked
npm run desktop:dev
```

Start a host on a spare port, for example `cargo run --manifest-path apps/host/Cargo.toml -- --port 8791 --pairing-dir <dir>`, paste the contents of `<dir>/pairing.json` into the app and keep the port at 8791.

## Checks

```
npm run desktop:lint
npm run desktop:typecheck
npm run desktop:test
```

`desktop:lint` also runs `cargo fmt --check` and `cargo clippy -D warnings` for `src-tauri`, which is its own Cargo workspace; the root `cargo clippy --workspace` does not cover it.

## Build

```
npm run desktop:build
```

Produces the Windows installer or macOS bundle under `src-tauri/target/release/bundle`. Set `CARGO_TARGET_DIR` to keep build output elsewhere.
