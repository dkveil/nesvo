# Engineering conventions

These are project rules, not a requirement to introduce a framework for every abstraction. Prefer the smallest explicit boundary that makes behavior testable. Improve touched modules incrementally; do not reorganize the whole application during an unrelated feature.

## Responsibilities and dependencies

The Rust host owns processes, groups, canonical terminal dimensions and control leases. Clients own presentation, focus and local pane layout. A session ID identifies a process independently of a group's position, tab index or visible pane. A client disappearing must not destroy that process.

Keep four responsibilities separate:

1. **Domain:** groups, parent relationships, names, revisions and ownership rules. Pure computations do not import UI, sockets or process APIs.
2. **Application:** commands and state transitions, including validation, permissions and correlation IDs. One authoritative host snapshot feeds the clients; derived counts, tree paths and filters are computed from it.
3. **Adapters:** SQLite, PTY, encrypted WebSocket, secure storage and platform APIs. Validate untrusted input here; a TypeScript cast is not validation. Persist before announcing a successful durable mutation.
4. **Presentation:** React screens and Ratatui widgets render state and emit intentions. Render functions must not read files, inspect processes or perform network requests.

Use functions and concrete types by default. Add a trait/interface where multiple implementations or a meaningful test seam justify it. Do not add generic repositories, dependency-injection containers, event buses or inheritance hierarchies preemptively.

Current code maps to `src/connection`, `src/state`, group helpers, screens and terminal adapters; Rust separates groups/storage, session orchestration, process and transport modules. Route files in `src/app` remain composition points. ESLint prevents the domain/transport from importing UI and prevents screens from implementing wire encryption.

## TypeScript and React Native

- Keep `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride` enabled. Narrow `unknown` at external boundaries. Use discriminated unions for events and explicit nullable parent IDs.
- Avoid `any`, unverified assertions and silent fallback values that disguise malformed messages. Handle missing array/map entries explicitly.
- Prefer `import type` for type dependencies. Expose a small module interface; avoid reaching into another feature's internals.
- Use descriptive feature names; PascalCase for components/types, camelCase for functions and values. Keep existing file conventions when modifying a module.
- Keep state minimal. Use host revisions for conflicting metadata changes and request IDs for results; never infer a newly created session from its display name.
- Keep effects and cleanup paired. On leave/disconnect, remove subscriptions and release owned control. Reconnect with a fresh handshake; never automatically replay terminal input.
- Safe areas and the keyboard have one owner per screen/modal. Web checks do not replace testing the iPhone keyboard, WebView, camera or lifecycle.
- Expo native packages must match the installed SDK. Prefer the platform's accessibility labels, focus behavior and keyboard semantics.

## Rust

- Follow Rust API naming: `snake_case` modules/functions, `PascalCase` types/traits, `SCREAMING_SNAKE_CASE` constants. Use `Option` and `Result` for absence and failure, enums for modes and private fields for invariants.
- Use ownership and RAII to release terminal raw mode, cursor state, channels and process handles. Keep platform branches near platform adapters.
- Return contextual errors at application boundaries. Do not `unwrap`/`expect` on network, filesystem or user input; test assertions may use them. Add typed domain errors when callers need to distinguish outcomes.
- Keep public APIs narrow and document security/lifecycle guarantees. Prefer `pub(crate)` or private helpers unless a client needs the API.
- Never hold shared state locks while awaiting network I/O. Use bounded queues; define how overflow, cancellation and disconnect behave. Isolate blocking PTY/SQLite work from async network tasks when it can block other clients.
- Run `cargo fmt`, Clippy with warnings denied, and meaningful tests. Commit Cargo lockfiles for these applications and use locked builds in CI.
- Do not enable every Clippy restriction or pedantic lint wholesale. Add rules when they prevent an observed class of failure; explain local allowances.

## Protocol, persistence and tests

The [protocol contract](protocol-v2.md) is shared by mobile and TUI. Changes must preserve declared compatibility or explicitly version it. Authenticate before accepting commands; preserve challenge, direction and sequence checks. Never log pairing keys, leases or shell content as routine telemetry.

Test invariants at their boundary: group cycles and missing parents without PTYs; transactions and reload against a temporary SQLite database; real multi-client synchronization, control takeover and shell continuity against the host; keyboard intent/rendering against a deterministic TUI backend. Integration tests should assert observable behavior rather than mirror private functions.

CI checks the mobile code and native Rust builds on Windows, macOS and Linux. Report native device testing separately. A browser viewport test is not proof of iOS safe-area or keyboard correctness, and cross-compilation is not proof of runtime behavior.

Keep demo fixtures explicit. Persisted metadata does not imply that processes survive a host restart. Bounded terminal transcript replay does not imply an exact full-screen snapshot.

## Reference projects and primary guidance

The user-provided `accounting-app-js-master` was inspected locally on 2026-10-16. Its ESLint layer policies/public feature exports, strict indexed access and small tested payload mappers inform our boundaries. Its Next.js server stack and proprietary packages are not dependencies of this project.

Herdr was inspected at commit [`143bf5fd4781d164260c63fe28e7dc08054ad32f`](https://github.com/herdrdev/herdr/tree/143bf5fd4781d164260c63fe28e7dc08054ad32f). Useful design references are independent terminal identity (`src/terminal/id.rs`), client-specific views (`src/server/headless/client_views.rs`), dedicated persistence (`src/persist/writer.rs`) and checks against expensive queries during rendering (`scripts/test_ui_hot_path_architecture.py`). These are architectural references; no Herdr source is incorporated. Herdr has its own Apache-2.0 license.

- [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/): idiomatic APIs and type safety.
- [Clippy usage](https://doc.rust-lang.org/clippy/usage.html): lint groups and targeted configuration.
- [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html) and [indexed access](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html): compiler-enforced assumptions.
- [Thinking in React](https://react.dev/learn/thinking-in-react): component responsibilities and minimal state.

These sources guide choices; project-specific tradeoffs and tests decide the implementation.
