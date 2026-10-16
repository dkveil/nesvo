This is a monorepo for an Expo/React Native application and native Rust terminal tools. Prioritize mobile usability, terminal performance and cross-platform compatibility.

The product is **nesvo**. Write repository documentation and code comments in English. Keep important architectural decisions, protocol contracts, launch instructions and verification guidance versioned with their implementation. Keep inspiration collections, competitor comparisons and research notes out of the repository. Preserve legacy pairing/storage and EAS identifiers unless a migration is explicitly implemented and tested.

Applications live in `apps/mobile`, `apps/host` and `apps/tui`; shared Rust transport encoding lives in `crates/nesvo-wire`. The host is Rust; Node.js is only used by Expo tooling and tests. Do not replace the Rust host with a Node server. AI tools run as original CLI programs on the user's host, with their own subscription login; do not add AI API keys or direct model API calls.

The approved Ultraviolet identity lives in `packages/brand`. Use its semantic tokens and exact logo geometry across clients; do not recreate the wordmark with a font or duplicate animation timelines. Preserve reduced-motion and visibility behavior. Repository docs use English; imported original SVG metadata may retain the author's language.

Run npm commands from the repository root unless a command explicitly needs the `apps/mobile` application directory. Root scripts forward to the `@nesvo/mobile` workspace. Rust uses the root Cargo workspace, one `Cargo.lock` and root `target/`. Preserve private `host/.local/` pairing data despite the source migration.

Follow `docs/engineering.md` for architecture and language conventions. Keep domain rules, application commands, adapters and rendering separate. Host state is authoritative; clients derive their views and never identify sessions by display name. Use strict TypeScript, validate protocol boundaries, keep render paths free of I/O, and test lifecycle/concurrency invariants. New Rust changes require fmt, Clippy and relevant tests on the supported CI platforms.

Mobile source follows `app → widgets → features → entities → shared`. Workspace entities may compose other entities through public interfaces. Cross-slice imports go through `index.ts`; features must not reach into sibling features. Shared contains generic UI, theme, terminal and host transport adapters, not product-domain state or navigation. ESLint and `npm run test:architecture` enforce these boundaries and filename conventions.

Use kebab-case TypeScript filenames including component files, PascalCase components/types, camelCase functions/locals and SCREAMING_SNAKE_CASE module constants. Expo Router's `_layout.tsx` and bracketed route files are framework exceptions. Rust keeps idiomatic snake_case files/modules/functions and kebab-case Cargo package names; do not apply TypeScript filename conventions to `.rs` files. Follow `.editorconfig`, installed Prettier/import sorting (`arrowParens: "avoid"`) and Rustfmt.

The mobile preview targets Expo SDK 57 to match the physical iPhone's App Store Expo Go (verified 2026-10-16). Before a major SDK upgrade, verify the store app supports it or that a compatible development build is available. The latest npm SDK can ship before Expo Go. Never fake compatibility by changing only app.config sdkVersion; align all native dependencies with `expo install` and run `expo install --check`.

Commits use conventional subjects and Damian as author. Do not add AI attribution, Co-Authored-By trailers, generated-by footers, or session links to commits and PRs.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `apps/mobile/package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npm ci
npm start                  # Expo Go preview through @nesvo/mobile
npm run web
npm run terminal:build
npm run typecheck
npm run lint
npm run format:check
npm run test:architecture
npm run dependencies:check
npm run export
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

From `apps/mobile`, use `npx expo install <package>` instead of npm/yarn/pnpm add for Expo/native dependencies; it resolves SDK-compatible versions. Use `npx expo-doctor` for diagnostics and `npx expo install --fix` when dependency corrections are required. Do not run Expo commands against the root tooling package.

Run lint and typecheck for mobile changes and the appropriate Rust checks for Rust changes before declaring the task done. Run the behavioral checks relevant to the changed boundary; do not describe browser testing as native phone testing.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `apps/mobile/src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code outside that directory; route files compose public widget/feature interfaces.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run commands from `apps/mobile`, where the app and EAS configuration live. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `apps/mobile/ios/` and `apps/mobile/android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in the mobile app configuration and config plugins.
- Expo Go only includes its bundled native modules. A native library outside that set requires a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
