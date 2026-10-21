# Contributing to nesvo

The project is a prototype. The most useful contributions improve real terminal work: the phone keyboard, session continuity, correct host communication and clear connection states.

Follow the [architecture, Rust and TypeScript conventions](docs/engineering.md). TypeScript, ESLint, Clippy and CI tests on Windows/macOS/Linux enforce some of these rules.

## Environment

Read the [README](README.md) and local [AGENTS.md](AGENTS.md). The repository contains the Expo 57 application in `apps/mobile`, Rust host in `apps/host`, native TUI in `apps/tui` and shared codec in `crates/nesvo-wire`.

Install JavaScript dependencies at the root with `npm ci`; root scripts forward mobile commands to the `@nesvo/mobile` npm workspace. Build Rust packages from the root with `cargo build --workspace --locked`. Keep one root Cargo lockfile and one root npm lockfile. Build output lives in `target/`; private repository pairing files remain in `host/.local/` for compatibility.

Install Expo-related libraries with `npx expo install` from `apps/mobile` to maintain SDK compatibility. Check the matching version's documentation before changing API usage. Do not manually add generated `apps/mobile/ios/` and `apps/mobile/android/` projects; native configuration belongs in Expo configuration and plugins.

## Change scope

- Keep client code, the connection protocol and host command execution separate.
- Keep mobile routes in `apps/mobile/src/app`, compose features in widgets, keep product state in entities and generic adapters/UI in shared. Cross-slice imports use public `index.ts` entrypoints. Follow the enforced dependency directions in `eslint.config.js`.
- Use kebab-case TypeScript filenames, PascalCase components/types, camelCase functions and uppercase module constants. Keep Rust files/modules snake_case and Cargo package names kebab-case.
- Distinguish demos clearly from real sessions. Example conversations must be labeled as demos.
- Do not introduce a required AI API key. CLI tools retain their own user login mechanisms.
- Do not save pairing codes, keys or private terminal output in the repository, diagnostic logs or issue reports.
- When changing the protocol, update both sides and verify that malformed messages are rejected.
- Do not automatically resend terminal input after a disconnection. Executing a command twice changes behavior; it is not a harmless retry.
- Do not edit `apps/mobile/src/shared/terminal/generated.ts` manually. Change the renderer sources and run `npm run terminal:build`.

## Checks before a pull request

Run type checking and the tests appropriate to the change:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test:architecture
npm run test:client
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo nextest run --workspace --locked --profile ci
```

`cargo nextest run` is the per-push CI check for Rust tests; install it with `cargo install cargo-nextest --locked`. `cargo test --workspace --locked` remains acceptable locally.

Use the repository's Prettier and import-sort configuration; `.editorconfig` sets whitespace and line endings. `arrowParens: "avoid"` applies to JavaScript/TypeScript, while Rustfmt formats Rust. Avoid unrelated dependency changes or broad formatting rewrites.

For dependency changes, run `npm run dependencies:check`; for bundling changes, run `npm run export`. Build the native applications before `npm run test:host`, `npm run test:sync` or `npm run test:tui`. Browser tests require a running web preview and the configured browser executable.

Test terminal changes against a real host. Changes involving the keyboard, WebView, clipboard, camera or layout with the keyboard open require a physical phone. Use the [test matrix](docs/testing.md) and state which cases were actually run. Do not describe a web test as an iOS test.

## Commits and pull requests

Use conventional commit subjects, such as `fix: preserve terminal input after resize`. A pull request description should briefly explain the problem, the resulting behavior and the verification performed. Also identify any device testing that remains to be done.

Commits and pull request descriptions must not include AI attribution, `Co-Authored-By: Codex` trailers, “Generated with Codex” footers or `Codex-Session` links.

## Issue reports

For a bug report, include the app version, host operating system, phone model, phone OS version and short reproduction steps. Remove pairing keys and private data from attachments. For security issues, do not publish a working key or information that grants access to the host; contact the project maintainer privately first.

Contributions are provided under the project's [MIT license](LICENSE).
