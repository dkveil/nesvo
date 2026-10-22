# Engineering conventions

These are project rules, not a requirement to introduce a framework for every abstraction. Prefer the smallest explicit boundary that makes behavior testable. Improve touched modules incrementally; do not reorganize the whole application during an unrelated feature.

## Workspace layout

| Path                | Responsibility                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/mobile`       | Expo application, npm workspace `@nesvo/mobile`                                                       |
| `apps/host`         | Rust `nesvo-host` executable; authoritative processes and metadata                                    |
| `apps/tui`          | Rust `nesvo` executable; native terminal client                                                       |
| `crates/nesvo-wire` | Shared authenticated frame codec and typed domain events; no sockets, processes or credential storage |
| `tests`             | Cross-application contracts, integration and browser checks                                           |
| `scripts`           | Repository tooling, terminal bundle generation, lint conventions and the CI contract gates            |

Install JavaScript dependencies at the repository root using its `package-lock.json`. Root npm scripts forward application commands to `@nesvo/mobile`. Rust packages share the root Cargo workspace, dependency declarations, `Cargo.lock` and `target/` directory. Use locked builds; do not recreate independent application lockfiles.

The source move does not migrate credentials. The repository host still uses the private `host/.local/` pairing directory by default, and existing external data directories and EAS identifiers remain compatible.

## Responsibilities and dependencies

The Rust host owns processes, groups, canonical terminal dimensions and control leases. Clients own presentation, focus and local pane layout. A session ID identifies a process independently of a group's position, tab index or visible pane. A client disappearing must not destroy that process.

Keep four responsibilities separate:

1. **Domain:** groups, parent relationships, names, revisions and ownership rules. Pure computations do not import UI, sockets or process APIs.
2. **Application:** commands and state transitions, including validation, permissions and correlation IDs. One authoritative host snapshot feeds the clients; derived counts, tree paths and filters are computed from it.
3. **Adapters:** SQLite, PTY, encrypted WebSocket, secure storage and platform APIs. Validate untrusted input here; a TypeScript cast is not validation. Persist before announcing a successful durable mutation.
4. **Presentation:** React screens and Ratatui widgets render state and emit intentions. Render functions must not read files, inspect processes or perform network requests.

Use functions and concrete types by default. Add a trait/interface where multiple implementations or a meaningful test seam justify it. Do not add generic repositories, dependency-injection containers, event buses or inheritance hierarchies preemptively.

## Mobile layers and public interfaces

The mobile application uses feature slices under `apps/mobile/src`:

| Layer      | Current responsibilities                                                                                    | Allowed dependencies                             |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `app`      | Expo Router routes and application composition                                                              | Widgets, features, entities, shared              |
| `widgets`  | App shell and session dashboard                                                                             | Features, entities, shared                       |
| `features` | Pair host, create session, manage groups, terminal session, attention inbox, answer decision, notifications | Entities, shared                                 |
| `entities` | Session, group and inbox models; workspace state and commands                                               | Other entities through public interfaces, shared |
| `shared`   | Generic UI/theme, terminal rendering and host transport adapters                                            | Shared only                                      |

`entities/workspace` coordinates connection state and session/group commands. It consumes the public interfaces of the session and group slices. `shared` must not accumulate product rules, demo sessions, group hierarchy logic or application navigation. Its host transport represents validated protocol data; mapping that data into product state belongs to entities.

Cross-slice imports use the target slice's `index.ts`. Relative internal imports stay within their own slice. Do not bypass a public interface through `features/create-session/new-session-sheet` or similar deep imports. A feature must not import a sibling feature; compose them in a widget or route. Keep public exports small and intentional.

`eslint.config.js` enforces layer direction and public entrypoints with `eslint-plugin-boundaries`, and blocks Router imports in entities/shared. The host transport cannot import React, React Native, Router, UI or product slices. `npm run test:architecture` checks repository conventions separately from runtime tests. TypeScript aliases mirror these layers; an alias is not permission to cross a forbidden boundary.

## TypeScript and React Native

- Keep `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride` enabled. Narrow `unknown` at external boundaries. Use discriminated unions for events and explicit nullable parent IDs.
- Avoid `any`, unverified assertions and silent fallback values that disguise malformed messages. Handle missing array/map entries explicitly.
- Prefer `import type` for type dependencies. Expose a small module interface; avoid reaching into another feature's internals.
- Use `kebab-case` TypeScript filenames and feature directories, including component files: `new-session-sheet.tsx` exports `NewSessionSheet`. Platform suffixes remain explicit, for example `terminal-view.web.tsx` and `random.native.ts`.
- Use `PascalCase` components/types, `camelCase` functions/local values and `SCREAMING_SNAKE_CASE` module constants. Expo Router's `_layout.tsx` and bracketed dynamic route filenames are framework exceptions; keep non-route code out of `app`.
- ESLint rejects explicit `any`, unused variables unless intentionally prefixed with `_`, leaked JSX conditionals, invalid filenames and forbidden imports. Prefer explicit booleans or a ternary when a numeric value could otherwise render in JSX.
- Keep state minimal. Use host revisions for conflicting metadata changes and request IDs for results; never infer a newly created session from its display name.
- Keep effects and cleanup paired. On leave/disconnect, remove subscriptions and release owned control. Reconnect with a fresh handshake; never automatically replay terminal input.
- Safe areas and the keyboard have one owner per screen/modal. Web checks do not replace testing the iPhone keyboard, WebView, camera or lifecycle.
- Expo native packages must match the installed SDK. Prefer the platform's accessibility labels, focus behavior and keyboard semantics.

## Rust

- Follow Rust API naming: `snake_case` files/modules/functions, `PascalCase` types/traits, `SCREAMING_SNAKE_CASE` constants. Cargo package and crate-directory names use kebab-case, such as `nesvo-wire`; Rust imports use `nesvo_wire`. Do not apply TypeScript filename rules to Rust. Use `Option` and `Result` for absence and failure, enums for modes and private fields for invariants.
- The host separates group rules, SQLite storage, session orchestration, launcher discovery, native PTY I/O, replay handling and transport. The TUI separates its app model, input/controller, launch form, network adapter, terminal emulator, pure render functions and lifecycle runner. Both depend directly on `nesvo-wire`; the TUI must not depend on the host application.
- Use ownership and RAII to release terminal raw mode, cursor state, channels and process handles. Keep platform branches near platform adapters.
- Return contextual errors at application boundaries. Do not `unwrap`/`expect` on network, filesystem or user input; test assertions may use them. Add typed domain errors when callers need to distinguish outcomes.
- Keep public APIs narrow and document security/lifecycle guarantees. Prefer `pub(crate)` or private helpers unless a client needs the API.
- Never hold shared state locks while awaiting network I/O. Use bounded queues; define how overflow, cancellation and disconnect behave. Isolate blocking PTY/SQLite work from async network tasks when it can block other clients.
- Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` and meaningful tests from the root. Commit the single workspace `Cargo.lock` and use locked builds in CI.
- Do not enable every Clippy restriction or pedantic lint wholesale. Add rules when they prevent an observed class of failure; explain local allowances.

## Formatting and tooling

`.editorconfig` sets UTF-8, LF, final newlines and spaces: two-space indentation for text/code and four for Rust. Rustfmt owns Rust formatting. Prettier owns JavaScript/TypeScript, JSON, Markdown and configuration formatting: semicolons, single quotes, trailing commas, 100-column target and `arrowParens: "avoid"`.

The configured import sorter groups React, React Native, third-party packages, application aliases and relative imports, with separation and sorted specifiers. Run the installed formatter instead of maintaining a competing manual order. Generated `apps/mobile/src/shared/terminal/generated.ts` is rebuilt with `npm run terminal:build`; never edit it by hand.

Root commands are the common entrypoints: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:architecture`, `npm run dependencies:check` and `npm run export`. Run native Expo/EAS commands from `apps/mobile` when they are not exposed by a root script. The [testing guide](testing.md) lists behavioral checks and their scope.

## Protocol, persistence and tests

The [protocol contract](protocol-v2.md) is shared by mobile and TUI. Changes must preserve declared compatibility or explicitly version it. Authenticate before accepting commands; preserve challenge, direction and sequence checks. Never log pairing keys, leases or shell content as routine telemetry.

The host journal schema lives in numbered SQL files under `apps/host/migrations/`, registered in order in `apps/host/src/migrations.rs` and recorded in `schema_migrations`. Add a schema change as the next number in one new file and register it; startup applies pending files in order inside the journal's immediate transaction and refuses a database recorded by a newer host. Never edit, renumber or delete a merged migration; correct it with a later one. The per-module initializers are frozen at the pre-migration shape and only adopt databases created before the ledger existed; the legacy-only ones (`orchestration::initialize`, `job_retries::initialize_legacy_schema`, `workflow_controls::initialize_legacy_schema`) refuse a journal that already has the ledger, and adoption runs them before creating it.

Test invariants at their boundary: group cycles and missing parents without PTYs; transactions and reload against a temporary SQLite database; real multi-client synchronization, control takeover and shell continuity against the host; keyboard intent/rendering against a deterministic TUI backend. Integration tests should assert observable behavior rather than mirror private functions.

CI checks the mobile code and native Rust builds on Windows, macOS and Linux on every push; the ignored native scenarios run in the daily `Native nightly` workflow. Report native device testing separately. A browser viewport test is not proof of iOS safe-area or keyboard correctness, and cross-compilation is not proof of runtime behavior.

Keep demo fixtures explicit. Persisted metadata does not imply that processes survive a host restart. Bounded terminal transcript replay does not imply an exact full-screen snapshot.

## Generated contracts

Two public contracts are generated from Rust types. Domain events are typed once in `nesvo_wire::events::Event`, one variant per kind with a payload struct; the host appends only through that model and clients keep reading the same JSON. `crates/nesvo-wire/tests/fixtures/events.jsonl` holds golden wire records captured from the host before the model existed, per-kind tests prove the model and the host append path reproduce them byte for byte, and `tests/client-contract.test.ts` validates the golden records against the schema. MCP tools are defined once in `apps/tui/src/mcp_tools.rs`, each with its name, description, typed argument struct deriving `serde::Deserialize` and `schemars::JsonSchema`, effect hints and handler binding; the input schemas sent to clients, `docs/harness-mcp-tools.json` (the sorted names, which the host also reads for permission validation), `docs/harness-mcp-catalog.json` (the full published catalog: name, description, input schema, output schema and annotations of every tool) and the tool table in [harness-mcp.md](harness-mcp.md) are derived from that table, and the tool count is asserted once beside it. The catalog snapshot replaced the hand-written transition fixture; it differs from that fixture only where the derived schemas also declare `type: string` on string enum and const values and where `quotaPolicy.mode` is a one-value enum instead of a const, which accept the same arguments. Any further change to a tool's schema or annotations now shows up as a reviewed diff of the snapshot. Most tools forward their arguments to the workflow, scoped or adapter parser shared with the CLI instead of parsing them into the struct, so `every_tool_example_passes_its_contract_struct_and_its_handler` builds a valid example of each tool from its input schema (with per-tool patches where a value must also be semantically valid), deserializes it through the struct and through the handler, and checks that both refuse an unpublished field.

Regenerate after changing either model and commit the outputs. `NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo-wire --test event_contracts` rewrites `docs/harness-events.schema.json` and the kind table in [harness-events.md](harness-events.md#event-kinds); a new or changed kind also adds its golden record. `NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo --bin nesvo mcp_tools` rewrites `docs/harness-mcp-tools.json`, `docs/harness-mcp-catalog.json` and the tool table. Both generators replace only the text between their `<!-- generated:…:start -->` and `<!-- generated:…:end -->` markers, so prose around a generated table is kept. Both JSON files are written in Prettier's layout, so `prettier --check` passes on them unchanged. CI runs both tests without the variable and fails on drift.

## Workflow actions

Every `uses:` in `.github/workflows` names a full 40-character commit SHA, first-party `actions/*` included; a moving tag such as `@v4` can change what a running pipeline executes without a commit here. Workflow YAML carries no comments, so this table records the release each commit stands for.

| Action                      | Release         | Commit                                     |
| --------------------------- | --------------- | ------------------------------------------ |
| `actions/checkout`          | v7.0.1          | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node`        | v7.1.0          | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/upload-artifact`   | v7.0.2          | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/download-artifact` | v8.0.2          | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |
| `dtolnay/rust-toolchain`    | `stable` branch | `b725eda525362e7cf34af9a7243cac1e3f01a7ec` |
| `taiki-e/install-action`    | v2.87.29        | `8cca0918f8471c33515202b73f56ab27f2bed283` |

To change a pin, resolve the new tag with `gh api repos/OWNER/REPO/git/ref/tags/TAG` (follow `git/tags/SHA` when the object type is `tag`), then update every workflow that uses the action and this table in one commit.

Every `actions/checkout` step sets `persist-credentials: false`, so no later step can read the repository token from `.git/config`. The one step that needs a token, publishing the GitHub release, receives it through its own `GH_TOKEN` environment.

## Contributor gates

These rules apply to every change. Reviewers enforce all of them; only the ones marked automated fail CI on their own.

- **No code comments.** Source carries no comments that restate what the code does, no section banners and no commented-out code. One line is allowed only where code cannot express why: a library gotcha, a workaround or a counter-intuitive decision. Workflow YAML carries none (see [workflow actions](#workflow-actions)). The `app` job fails a push or pull request that adds a comment outside the allowed forms (automated, see [comment and attribution gates](#comment-and-attribution-gates)).
- **No attribution.** Commit messages and pull request descriptions name no AI tool: no co-author trailers, generated-with footers or session links ([commits and pull requests](../CONTRIBUTING.md#commits-and-pull-requests)). The `app` job fails a push or pull request whose commit messages carry one (automated, see [comment and attribution gates](#comment-and-attribution-gates)); pull request descriptions are reviewed, and a squash merge turns them into a commit message the gate then reads.
- **Migrations run the full suite.** A change that adds a file under `apps/host/migrations/` or touches `migrations.rs` runs `cargo nextest run --workspace --locked --profile ci` before merge, never a filtered subset: every journal-backed module opens the migrated schema, so a filtered run can pass while another module fails.
- **CLI reply shapes have schema scenarios.** A new or changed `--json` reply kind adds its `data.oneOf` branch to `docs/harness-cli.schema.json`; `every_cli_reply_kind_has_a_published_schema_branch` fails otherwise (automated). Where a native scenario can print the reply, the scenario pipes it through `tests/fixtures/validate-harness-json.cjs` ([native CLI reply envelopes](testing.md#native-cli-reply-envelopes)).
- **Contention tests are deterministic.** A test of a lock, busy retry or writer race holds the competing side with a barrier or channel and releases it only after the code under test is observed waiting; it never relies on timing to create the overlap ([SQLite writer admission](harness-transactions.md)).
- **Waits end on events, not clocks.** Tests and native scenarios wait for a host event, receipt or state change under a deadline. No fixed sleep or fixed observation window decides success; the deadline only bounds a failure, and nextest ends any single test after five minutes (`.config/nextest.toml`).
- **Generated contracts stay generated.** Change the Rust model, regenerate with `NESVO_UPDATE_CONTRACTS=1` and commit the outputs ([generated contracts](#generated-contracts)); CI fails on drift (automated).

## Comment and attribution gates

`scripts/contract-gates.mjs` runs as a step of the `app` job in `ci.yml`, before dependencies are installed, and `npm run contract-gates -- --base origin/main` runs it locally. It judges what a push or pull request introduces: the commit messages in `base..head` and the net diff from their merge base to the head. The base is the previous tip (`github.event.before`) on a push and the base commit on a pull request. A new branch, a null base or a base that no longer exists (a force push) falls back to the head commit alone. A base missing from a shallow clone is an error instead of a weaker check, which is why the job checks out the full history. Tag pushes skip the step; the tagged commit was judged on its branch.

Only lines the range adds are judged, so an existing comment fails nothing until a change rewrites or moves it. The gate reads the files at the head and lexes them, so comment markers inside strings, raw strings, templates, regular expressions and URLs are not comments.

Comments in Rust, TypeScript, JavaScript, YAML and TOML files (`.rs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.yml`, `.yaml`, `.toml`) are rejected, except:

- `///` doc comments on the items of a Rust type that derives clap's `Parser`, `Args`, `Subcommand` or `ValueEnum`, or schemars' `JsonSchema`, because they become CLI help and schema descriptions.
- A one-line `// SAFETY:` comment directly above an `unsafe` block or above the statement that holds it (the keyword within the next three lines). A second comment line, a lower-case marker and a trailing form are rejected.
- The whole lines in `scripts/contract-gates/allowlist.json`, matched by exact trimmed text in Rust, TypeScript and JavaScript files wherever they appear, so moving or splitting a file keeps them valid. They are the WHY comments that predate the gate, and the list should only shrink.

Never allowed: `//!` and block comments, trailing comments, and `#` comments in YAML (shell comments inside `run` blocks included) and TOML. `generated.ts` and the `node_modules`, `target`, `dist`, `.expo` and `artifacts` directories are skipped.

The attribution gate rejects a commit message line that starts a `Co-Authored-By:` trailer, a `Generated with` or `Generated by` footer, or a `<Tool>-Session:` trailer, and a message that links an assistant session. A message that merely opens a sentence with those words has to be rephrased.

A failure prints one line per finding, `path:line: reason: excerpt` for a comment and `commit <sha> message line <n>: reason: excerpt` for a message, and the job fails. `tests/contract-gates.test.mjs`, part of `npm run test:architecture`, covers the lexers, the rules, the diff parser and the command against temporary repositories.

## Language documentation

- [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/): idiomatic APIs and type safety.
- [Clippy usage](https://doc.rust-lang.org/clippy/usage.html): lint groups and targeted configuration.
- [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html) and [indexed access](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html): compiler-enforced assumptions.
- [Thinking in React](https://react.dev/learn/thinking-in-react): component responsibilities and minimal state.

Project-specific tradeoffs and tests decide the implementation.
