# Contributing to nesvo

The project is a prototype. The most useful contributions improve real terminal work: the phone keyboard, session continuity, correct host communication and clear connection states.

Follow the [architecture, Rust and TypeScript conventions](docs/engineering.md). TypeScript, ESLint, Clippy and CI tests on Windows/macOS/Linux enforce some of these rules.

## Environment

Read the [README](README.md) and local [AGENTS.md](AGENTS.md). The client uses Expo 57 / React Native, and the host is a separate Rust program. Start with `npm install`; build the host with Cargo from the `host/` directory.

Install Expo-related libraries with `npx expo install` to maintain SDK compatibility. Check the documentation for the matching version before changing API usage. Do not manually add generated `ios/` and `android/` projects; native configuration belongs in Expo configuration and the appropriate plugins.

## Change scope

- Keep client code, the connection protocol and host command execution separate.
- Distinguish demos clearly from real sessions. Example conversations must be labeled as demos.
- Do not introduce a required AI API key. CLI tools retain their own user login mechanisms.
- Do not save pairing codes, keys or private terminal output in the repository, diagnostic logs or issue reports.
- When changing the protocol, update both sides and verify that malformed messages are rejected.
- Do not automatically resend terminal input after a disconnection. Executing a command twice changes behavior; it is not a harmless retry.
- Do not edit `src/terminal/generated.ts` manually. Change the renderer sources and run `node scripts/build-terminal.mjs`.

## Checks before a pull request

Run type checking and the tests appropriate to the change:

```powershell
npx tsc --noEmit
cargo test --manifest-path host/Cargo.toml
```

Also lint the client using the repository scripts; the Expo command is `npx expo lint`. If the tool proposes an installation or configuration change, treat it as a separate dependency change and review the resulting diff.

Test terminal changes against a real host. Changes involving the keyboard, WebView, clipboard, camera or layout with the keyboard open require a physical phone. Use the [test matrix](docs/testing.md) and state which cases were actually run. Do not describe a web test as an iOS test.

## Commits and pull requests

Use conventional commit subjects, such as `fix: preserve terminal input after resize`. A pull request description should briefly explain the problem, the resulting behavior and the verification performed. Also identify any device testing that remains to be done.

Commits and pull request descriptions must not include AI attribution, `Co-Authored-By: Codex` trailers, “Generated with Codex” footers or `Codex-Session` links.

## Issue reports

For a bug report, include the app version, host operating system, phone model, phone OS version and short reproduction steps. Remove pairing keys and private data from attachments. For security issues, do not publish a working key or information that grants access to the host; contact the project maintainer privately first.

Contributions are provided under the project's [MIT license](LICENSE).
