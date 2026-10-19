# Harness delivery

This checklist tracks the approved 44-feature harness contract. A checked feature
requires implementation, boundary tests and recorded evidence; partial work does
not count as delivered. Preserve the approved compact navigation and native host.

## Stages and dependencies

0. Inventory, reproduce status failures and measure an isolated host baseline.
1. Reliable status evidence and projections: F01–F08, F29, F32.
2. Shared host API, CLI and MCP: F09–F12, F16–F17, F37–F38.
3. Durable orchestration: F13–F15, F18–F20, F26, F40.
4. Host jobs and triggers: F21–F25, F27–F28, F44.
5. Navigation, review and environment: F30–F31, F33–F36.
6. Recovery and mobile: F41, F43.
7. Resource isolation and performance: F39, F42.

Status identity and readiness precede safe dispatch; durable receipts/events
precede orchestration and jobs; resume evidence precedes hibernation. Cross-cutting
foundations may land earlier, but feature gates still require their full tests.

## Feature inventory

Inventory at baseline `0c898c3` (2026-10-19). Existing behavior is a starting point,
not evidence that the expanded acceptance criteria pass.

| ID  | Feature                                         | Baseline                                                      | Delivery / tests / commits                                                                               |
| --- | ----------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| F01 | OSC 7501 parser and host query responder        | Missing                                                       | Partial: 0946401; live Windows negotiation gate open                                                     |
| F02 | Provider lifecycle adapters                     | Partial: Claude launch hooks; other providers screen hints    | Pending real provider verification                                                                       |
| F03 | Status doctor and session explain               | Missing                                                       | Implemented diagnostics/version/correlation; provider matrix pending                                     |
| F04 | Versioned detection rules and screen corpus     | Partial: hard-coded current-screen rules                      | Partial: 3e851ba; wider provider corpus pending                                                          |
| F05 | Launch, conversation and event identity         | Partial: private launch report directory; wall-clock sequence | Partial: 173162e; Claude scoped journal; attempt identity in F17/F18                                     |
| F06 | Evidence freshness and last-known state         | Partial: short hook/screen grace                              | Partial: 7445eb3; freshness/disconnect policy pending                                                    |
| F07 | Starting, readiness and timeout                 | Missing                                                       | Implemented: readiness/timeout; platform/device matrix pending                                           |
| F08 | Process, agent, turn, task and unread semantics | Partial: process exit and attention separate                  | Partial: 6d80847; separate axes, completion unread pending                                               |
| F09 | Stable session CLI                              | Partial: TUI flags and list only                              | Partial: queries plus durable create/operation lookup; send/wait/interrupt/stop pending                  |
| F10 | MCP over host operations                        | Missing                                                       | Partial: native stdio SDK adapter; task/effect/subscription/provider gates pending                       |
| F11 | Visible child sessions                          | Missing                                                       | Pending                                                                                                  |
| F12 | Scoped caller identity and agent instructions   | Missing                                                       | Partial: launch-local passive capabilities; coordinator grants/skill pending                             |
| F13 | Fan-out with explicit worktree ownership        | Partial: individual worktree launch                           | Pending                                                                                                  |
| F14 | Durable run/task/attempt DAG                    | Missing                                                       | Pending                                                                                                  |
| F15 | Durable inbox and ACK                           | Missing                                                       | Pending                                                                                                  |
| F16 | Resumable bounded event subscriptions           | Missing: terminal replay is not domain event replay           | Partial: durable scoped journal/streams and CLI watch; receipt/result integration pending                |
| F17 | Receipts, idempotency and correlated wait       | Partial: request IDs, no durable receipts                     | Partial: shared create/send receipts and CLI/MCP correlated wait; job dispatch/provider coverage pending |
| F18 | Attempt-bound worker result                     | Missing                                                       | Pending                                                                                                  |
| F19 | Questions and decision gates                    | Missing                                                       | Pending                                                                                                  |
| F20 | Worker budgets, cancellation and drain          | Partial: fixed eight-session limit                            | Pending                                                                                                  |
| F21 | Once and recurring host jobs                    | Partial: host-owned once schedules                            | Pending                                                                                                  |
| F22 | Timezone, cron/RRULE and DST                    | Missing                                                       | Pending                                                                                                  |
| F23 | Missed-run policy and grace window              | Missing                                                       | Pending                                                                                                  |
| F24 | Safe fresh/reuse session dispatch               | Partial: fresh launch with prompt                             | Pending                                                                                                  |
| F25 | Bounded precheck                                | Missing                                                       | Pending                                                                                                  |
| F26 | Delta-only coordinator wakeups                  | Missing                                                       | Pending                                                                                                  |
| F27 | Authenticated webhook and GitHub triggers       | Missing                                                       | Pending                                                                                                  |
| F28 | Durable job attempts, retry and overlap         | Partial: schedule result field                                | Pending                                                                                                  |
| F29 | Shared needs-you and group rollups              | Partial: attention and shared snapshot                        | Implemented canonical projections/rollups; device matrix pending                                         |
| F30 | Stable attention/unread/MRU ranking             | Partial: palette and attention navigation                     | Pending                                                                                                  |
| F31 | Contextual fuzzy search                         | Partial: session/group/command search                         | Pending                                                                                                  |
| F32 | Incremental preview and process/turn times      | Partial: bounded replay and monotonic process age             | Implemented distinct process/turn times and bounded passive read; device matrix pending                  |
| F33 | Revision-bound diff feedback                    | Missing                                                       | Pending                                                                                                  |
| F34 | Verified session/turn edit provenance           | Partial: agent edit folder context only                       | Pending                                                                                                  |
| F35 | Revision-bound checks and review readiness      | Missing                                                       | Pending                                                                                                  |
| F36 | Trusted worktree setup/run/archive              | Partial: create worktree only                                 | Pending                                                                                                  |
| F37 | Provider-aware launch profiles                  | Partial: templates                                            | Pending                                                                                                  |
| F38 | Session-scoped MCP and skills                   | Missing                                                       | Pending                                                                                                  |
| F39 | Isolated safe MCP pooling                       | Missing                                                       | Pending                                                                                                  |
| F40 | Durable goal/progress checkpoint                | Missing                                                       | Pending                                                                                                  |
| F41 | Layout, conversation and workflow recovery      | Partial: saved launch recovery records                        | Pending                                                                                                  |
| F42 | Safe resumable hibernation                      | Missing                                                       | Pending                                                                                                  |
| F43 | Mobile fleet, decisions and jobs                | Partial: existing mobile sessions/control                     | Pending                                                                                                  |
| F44 | Trustworthy quota-aware dispatch                | Partial: usage cache and quota wake                           | Pending                                                                                                  |

## Verification log

- Windows checkout clean at baseline; branch `feat/harness-statuses-orchestration`.
- Installed CLI probes: Claude Code 2.1.303; Codex CLI 0.156.0. Gemini was not
  discoverable on PATH. This does not verify subscription login or hook delivery.
- SQLite owns groups, preferences/templates/recovery and once schedules; live
  sessions are host-memory processes. A database record does not preserve a PTY.
- Current lifecycle reader runs every 500 ms independently of PTY dispatch;
  status publication is coalesced at 250 ms. Hook errors are currently swallowed.
- Native Windows is the initial verification environment. Other interactive
  platforms and physical mobile checks require separate evidence.
- Baseline `cargo test --workspace --locked` (target `target/verification`):
  121 TUI, 45 host and 3 wire tests passed. These existing tests did not establish
  real provider hook delivery.
- Isolated real Claude 2.1.303, without a model prompt: `unknown → working →
unknown` by 2.3 s. Output included a folder-trust screen and OSC 7501 probe.
  The baseline neither classifies this blocker nor answers that probe. A trust
  screen is not evidence that lifecycle hooks have loaded; root cause of the
  user's already-trusted conversations still needs verification.
- Idle baseline: eight real PowerShell PTYs, no clients, 60.41 s observation,
  host CPU 0.129% of one logical core, working set 16.65 → 16.60 MB, 17 immediate
  child processes unchanged. Host memory/process numbers exclude descendants;
  this fixture did not reproduce historical 100% CPU. No provider prompt was
  submitted. Reproduce with `node --import tsx tests/harness-probe.ts baseline`
  on Windows; raw measurements stay in ignored `artifacts/harness`.

Each green stage records commands, provider versions, measurements, limitations
and commit IDs here, then pushes its branch. No automatic main merge or PR.

### F01 implementation checkpoint

- Added bounded OSC 7501 reports, independent child records, hierarchical clear,
  reset/prompt/exit handling, host-owned probe/DA1 ordering, first ConPTY cursor
  negotiation, and legacy-compatible structured provenance in both clients.
- Parser/record tests, a real native PTY provider fixture, reconnect, replay
  isolation and child-vs-parent state checks pass. Added `base64` 0.22.1, already
  present transitively, for strict protocol text decoding.
- fmt/Clippy pass; 122 TUI, 51 host, 3 wire, 18 client, 17 native integration
  checks and 4 architecture checks pass locally on Windows. Mobile typecheck and
  lint pass. The full formatter found three pre-existing unformatted documents
  (agent-diff-context, tui-workflows, TUI README), tracked for a separate cleanup.
- Real Claude 2.1.303: startup hook delivered after trust/MCP consent; one short
  no-tool turn produced working and Stop/idle hook evidence and exited normally.
  No external MCP server was approved. This does not yet establish live OSC
  reporting in Windows ConPTY; that provider negotiation gate remains open.
- The real turn exposed an existing freshness bug: screen idle can replace a
  fresh working hook before Stop. F06 must address this before the status stage
  can pass. No complete lifecycle/provider matrix or latency p95 is claimed.

### F03 and F06 checkpoints

- `0946401`: F01 protocol parser/host owner and client provenance checkpoint.
- `7445eb3`: F06 rejects idle screen fallback while a confirmed turn works,
  unless actual Ctrl+C/Esc and a fresh prompt establish an interruption. Unit
  regression covers silence beyond two minutes. Full source-freshness policy,
  stale/disconnected projections and a complete live lifecycle matrix remain open.
- F03 exposes read-only `doctor` and `session explain ID` (human/JSON) through
  an advertised authenticated host capability. Missing/malformed/oversized hook
  files and helper failure markers are observable without logging payloads.
  Native CLI integration verifies correct IDs, build identity, no control
  acquisition, unknown-session failure and no credential disclosure.
- F03 still needs provider-version caching, matched-rule IDs (F04), and migrated
  conversation/ordering identity (F05) before its full acceptance criteria pass.

### F04 implementation checkpoint

- Embedded, schema-validated literal rules have stable IDs and revision
  `2026-10-19.1`. Eleven rules cover startup trust/MCP consent, quota and existing
  provider prompt/permission/work shapes. `session explain` includes the matched
  rule. The build identity hashes the catalog too. No dynamic code is executed.
- Current-visible-screen tests cover startup consent and cleared history; legacy
  Codex question detection remains a separately tested fallback. Login/model
  selection/transcript-viewer corpus and wider provider-version coverage remain
  open. A fixture does not certify every version/language.
- Real Claude 2.1.303 now reported blocked on startup consent instead of returning
  to unknown. After consent, an explicitly bracketed-pasted short prompt showed
  confirmed working → confirmed idle, with no intermediate idle. Expected reply
  text did not appear contiguously in the input. Graceful cleanup passed. Earlier
  probe failures were retained as failures: a CR in the same fast input packet
  was treated as pasted text, not submission; the fixture now separates paste
  and Enter. No change to production PTY key encoding was needed.
- Native diagnostics observed one OSC probe and zero program reports for this
  Claude/Windows combination. Live negotiation remains unverified; do not claim
  that this provider uses the new protocol merely because fixture reports work.
- Current tests: 54 host unit checks and 18 native host/sync/CLI checks passed,
  plus 18 client contract checks. Existing mobile typecheck/lint remain green.

### F07 implementation checkpoint

- A separate host readiness tracker distinguishes process creation, startup,
  consent waiting, semantic initialization, timeout and exit. The 45-second
  timeout uses monotonic session age. Consent pauses it; a later valid signal
  recovers a timeout. Exit cannot be revived by a delayed report.
- Additive wire data preserves older clients' status enums. TUI sidebar and both
  switchers show `starting`/`start fail`; existing mobile badges show
  `Uruchamianie`/`Błąd startu` without changing layout. `session explain` carries
  the reason. Initialization alone does not establish turn readiness or permission.
- Deterministic tests cover no-semantic-output, prolonged consent, resumed
  startup, timeout, recovery and exit; clients validate optional readiness and
  preserve old snapshots. Rust: 123 TUI, 55 host, 3 wire passed; mobile typecheck,
  lint, 19 client and architecture checks pass. Native-device UI remains untested.

### F02 helper-cost checkpoint

- Lifecycle helper and `--build-id` now return before constructing a Tokio
  multi-thread runtime. Only the actual host constructs that runtime. This
  removes avoidable thread initialization on every tool-boundary hook.
- Windows debug-build sample: 20 measured helper processes after three warmups,
  no model requests; median wall time 16.71 → 14.59 ms, p95 23.12 → 15.15 ms.
  These include process creation, are local diagnostic samples, and do not explain
  or certify a fix for the user's historical CPU spike. Reproduce using
  `python tests/hook-helper-benchmark.py target/verification/debug/nesvo-host.exe`.
- Actual Windows ConPTY smoke passed on isolated data: onboarding, shell input,
  focus/menu, palette, filters, live/expanded diff, launch settings, recovery,
  150×44 / 100×32 / 80×24 resize and clean terminal exit. Captures are ignored
  artifacts under `artifacts/harness-conpty-20261019/current-previews`.
- F02 remains partial: Claude lifecycle has real delivery evidence; Codex/Gemini
  adapter/version coverage and disabled-hook scenarios still need work.

### F05 implementation checkpoint

- New Claude launches use a bounded SQLite lifecycle journal with host session,
  launch nonce, provider conversation and generation. Ordered batches preserve
  short turns between polls; retention overflow is explicit. No new dependency:
  this uses the host's existing SQLite adapter. Legacy JSON helper scopes remain
  compatible, and JSON shadow writes cannot overwrite journal authority.
- Empty agent IDs are root; nonempty/malformed children cannot alter parent
  status or review context. Foreign conversation Stop/context and mismatched
  host-session reads are rejected. Clear/resume/compact can bind a new generation.
  Source ordering no longer depends on UTC timestamps. Task/attempt correlation
  remains a future F17/F18 boundary; asynchronous emitter order is not invented.
- Tests cover fast ordered turns, stale identities, ownership, retention/gaps,
  empty/child IDs and a regressing wall clock. 123 TUI, 59 host and 3 wire unit
  checks pass; Clippy and 18 native integration checks pass on Windows.
- Real Claude 2.1.303 verified generation 1, provider identity, launch sequence,
  no gap, readiness starting → trust waiting → MCP waiting → ready, then one
  short working → Stop/idle turn with normal cleanup. No intermediate idle was
  observed and no external MCP tool was approved.

### Additional status verification

- F06 now latches evidence of an interrupted idle prompt. Neither an old hook
  nor an old protocol working record revives it when the short detection window
  expires; a newer structured report still wins. Both paths have regressions.
- F03 caches installed-provider versions from bounded asynchronous `--version`
  probes. No prompt, login or setting write is involved, and diagnostics do not
  spawn a CLI. Native launcher fixtures verify a real process version reaches
  the cached diagnostic report. Provider/parser/build identity is now visible;
  the full provider lifecycle/version matrix remains a stage gate.

### F08 lifecycle checkpoint

- Process lifetime, current/historical agent observations, startup and response
  turn state are separate. Turn IDs derive from launch identity and event sequence;
  old idle does not start or settle a new turn. Stop establishes response settlement,
  never task success. Questions/quota/permissions wait; interruption, replacement,
  history gaps and process exit have explicit outcomes. A two-second final drain
  handles Stop committed immediately before exit without reviving the process.
- Host snapshots include additive lifecycle data; mobile validates it while older
  clients ignore it. Diagnostics expose a bounded 16-entry turn history. Run/task
  results remain unassigned until the durable orchestration stage. Completion
  unread integration and full multi-provider lifecycle coverage remain open.
- New native integration uses a clearly labeled controlled CLI process and the
  real launch-scoped settings/helper/journal/PTY/host transport. It verifies
  question, child/foreign Stop isolation, fast turns between polls, late observer,
  final process drain and no implied task success without any model request.
- Rust unit checks: 123 TUI, 62 host, 3 wire passed; client checks: 20, with
  typecheck/lint/architecture passing. This fixture supplements, rather than
  replaces, recorded real Claude verification.

### F29 canonical attention checkpoint

- Host owns current actionable attention and ancestor group rollups. Current
  question/permission/auth/setup/quota, startup failure, process failure and blocked
  OSC children have explicit reasons. Historical unread events do not overwrite
  current agent state. Multiple blocked children count as one affected session.
- TUI sidebar, both search paths, filters and group indicators consume the shared
  projection; mobile filters/counts and existing badges consume the same fields.
  Older host snapshots retain a fallback. No layout or input/focus contract changed.
- Regressions cover cleared blockers, working parents, nested/cyclic metadata,
  unchanged focus/collapse state and strict mobile payload validation. Native
  helper/PTY integration checks current question and its clearance through the wire.
- Windows: fmt/Clippy, 124 TUI + 64 host + 3 wire tests, 21 client checks,
  19 native integration checks, mobile typecheck/lint and 4 architecture checks pass.
  This is not physical iOS/Android verification.

### F06 publication latency measurement

- Diagnostics retain at most 256 coalesced batches per session, measuring the
  oldest newly received structural event through snapshot enqueue. No-client
  batches are distinguished; replay and diagnostic reads add no samples.
  This measures host scheduling/queueing, not provider emission or network/UI
  delivery. The lifecycle poll's wait before observation is outside this scope.
- Controlled real helper/journal/PTY/transport fixture: 27 connected batches,
  53 events, p95 261.95 ms, max 262.91 ms on Windows debug build. The <=1 second
  gate passes for this local fixture; no claim is made about WAN latency.
- Deterministic retention/coalescing tests pass. Native fixture submits no model
  requests. It alternates questions and fast turns to exercise publication.

### F08 unread response checkpoint

- Confirmed lifecycle Stop creates one turn-correlated unread response event.
  Duplicate/stale Stop, process exit and terminal silence do not invent results.
  New working state stays current while the historical response can remain unread.
  A later question supersedes the notification without losing current blockers.
- The legacy wire kind remains `done` with additive response subject/turn ID;
  new UI/push wording says response ended, without implying validated task success.
- Windows fmt/Clippy, 124 TUI + 66 host + 3 wire tests, 21 client checks,
  typecheck/lint and 19 native integration checks pass. The late-observer fixture
  checks the same turn-correlated notification after reconnect. Native OSC done
  remains a protocol facet; multi-provider outcome coverage is still a stage gate.

### F09/F32 shared read foundation

- Added correlated host get/read queries with bounded incremental terminal pages,
  UTF-8 byte cursors, explicit retention gaps and frame-safe control-heavy data.
  This is output observation, not a resumable domain event log (F16).
- Typed application failures support headless callers. The host injects its stable
  process session ID for `current`; that context is not authorization. This shared
  foundation lands before effectful CLI/MCP dispatch to keep one host API.
- The stage 1 provider matrix remains open (especially native Codex/Gemini and
  ConPTY OSC negotiation); dependencies may progress without relabeling that gate.
  F32 turn-time presentation and preview retention behavior are still tracked.

### F09 read-only CLI checkpoint

- Owner-paired CLI supports list/get/current/read/diff and existing doctor/explain,
  with stable versioned JSON, typed failures and exit codes. Help works without
  pairing. Queries use the same host commands; they do not acquire leases or ack
  results. `current` uses process context rather than a UI-focused session.
- Native Windows integration validates real success/error output against the
  checked-in draft-7 schema: IDs, bounded pages/cursors, missing context/session,
  bad limits, future cursor and unavailable Git. Six native TUI/CLI checks pass;
  Rust fmt/Clippy and 124 TUI + 67 host + 3 wire checks pass.
- Added direct **test-only** Ajv 6.15.0, already installed transitively through the
  repository tooling, to validate these machine contracts. No new native runtime
  dependency or provider installation. Effectful CLI operations and scoped MCP
  remain pending F12/F17 foundations; read-only coverage is not full F09 delivery.

### F32 time and preview checkpoint

- The approved single-row age column remains process age. Search preview metadata
  now explicitly labels process age separately from active turn duration and
  settled/interrupted response duration. Rendering uses labels prepared by the
  monotonic event-loop clock; a settled response does not keep accumulating time.
- Preview keeps its bounded initial replay/live chunks and does not change active
  session/control before confirmation. New read cursors provide a bounded passive
  incremental path for CLI/MCP callers, with explicit retention gaps rather than a
  claim of a complete screen/transcript. Recovery does not share cursor space.
- Unit regressions cover independent/frozen clocks and legacy hosts. 125 TUI tests
  and Clippy pass; existing render/focus checks cover 80×24, 100×32 and 150×44.

### F12 scoped caller foundation

- Each managed process receives a private, independent launch key/context file.
  A scope selector participates in the existing authenticated handshake; forged
  IDs, wrong keys and replayed authentication fail. Explicit owner pairing remains
  compatible. Headless CLI selects process context without copying owner secrets.
- Initial capability is passive own-session read/diff/explain. Mutations/global
  diagnostics/pinned folders are denied before synchronous or asynchronous
  dispatch. Snapshots, ancestor rollups and background control events are filtered
  by authority. Exit revokes the capability; context hints never grant authority.
- Native fixture verifies foreign-session/group isolation, control/input/launch
  denial, key mismatch/replay and revocation. Native CLI verifies automatic context
  selection, own current/list/explain, forged hints and unknown scope rejection.
  Cleanup removes only the owned credential and preserves unexpected contents.
- F12 remains partial: coordinator/run/child grants and versioned agent skill are
  subsequent commits. This API capability is not a same-account OS sandbox.
- Windows verification: 125 TUI + 68 host + 3 wire tests, 21 native integration
  checks, fmt/Clippy, mobile typecheck/lint, formatter and 4 architecture checks
  pass. Full native run measured status publication p95 252.36 ms (29 batches).
  A stale queued-snapshot assumption in the fixture was replaced with correlated
  list responses; the actual post-child/foreign-Stop state is now checked directly.

### Cross-platform CI findings

- First branch CI run `39315017157` passed app/browser jobs but found pre-existing
  native gaps: non-Windows clipboard code compiled without Crossterm's `osc52`
  feature, and Windows fixture assertions compared canonical long paths against
  the runner's equivalent 8.3 temp aliases.
- Enabled the existing clipboard feature (Base64 0.22.1 was already locked) and
  canonicalized both sides of fixture path comparisons. No production folder
  resolution or global system configuration changed. These are targeted repairs;
  macOS/Linux runtime claims await the subsequent matrix run.

### Verified checkpoint and late-exit timing

- CI run `39320283775` at `a44f196` passed the app, browser and native Windows,
  Ubuntu and macOS jobs, including native PTY/transport/CLI checks. This is CI
  evidence, not physical mobile or interactive Unix terminal verification.
- Local real ConPTY smoke passed after scoped authentication: onboarding, input,
  menu focus, diff/review, search, filters, launch dialogs, 150×44/100×32/80×24,
  resize and clean terminal restoration. Current renderer PNGs are kept in ignored
  `artifacts/harness-conpty-20261019/current-previews` with explicit fixture data.
- F32 repair: the final lifecycle drain retains the duration frozen at process
  exit. Late Stop can settle response evidence but cannot add post-exit time;
  late prompt evidence is reconciled to the exited process. Pure turn tests and
  the real helper/PTY late-exit fixture verify the distinction.

### F16 durable event checkpoint

- Added the bounded domain journal to the existing private SQLite database with
  monotonic sequences, snapshot reads, 4096-event retention and explicit cursor
  expiry. One bounded worker owns I/O outside the host mutex; acknowledged writes
  and informational observations have distinct failure semantics. Health exposes
  dropped observations/write failures. No new library dependency was added.
- Authenticated read/subscribe/unsubscribe share one host path; streams register
  before reading, filter subjects by authority, enforce page/concurrency limits,
  cancel on disconnect/replacement and stop at retention gaps. CLI `events` and
  quiet NDJSON `--watch` use these operations and the versioned output schema.
- Real helper/PTY tests verify fast response replay for late observers, private
  subject streams, unsubscribe and persisted sequences across host restart. Native
  CLI verifies schema/delta delivery, quiet idle and no control acquisition.
  Synthetic process-exit text also advances the separate terminal byte cursor.
- Windows: fmt/Clippy, 125 TUI + 71 host + 3 wire checks, 22 native integration
  checks, 21 client checks and formatter pass. Previous checkpoint `e5699dc`
  passed all platform CI jobs. Critical receipt/task transactions remain F17/F18;
  this observation stream alone is not completion of those features.

### F17 create receipt checkpoint

- `b53a4d5` adds caller-bound create intents, single dispatch claims, durable
  receipt lookup and atomic operation events. Concurrent duplicates return the
  same reserved process; changed payloads conflict. Restart marks unsettled
  effects unknown and never replays them. Created remains historical process
  creation, separate from readiness, a response or task success.
- Native CLI create/operation lookup uses the shared host path, stable JSON,
  literal arguments and bounded UTF-8 file/stdin prompts. Tests cover same-key
  replay, Unicode/space paths and rejected shell prompts with no effect. Scope
  tests deny automated launch/foreign-receipt lookup by passive workers.
- SQLite tests inject event insertion failure to verify intent rollback, reject
  stale claims and verify uncertain restart outcomes. Native PTY tests cover two
  simultaneous callers, lost response, failed validation and restart without
  resurrection. No model calls or user host/configuration were used.
- Windows verification: fmt/Clippy, 125 TUI + 73 host + 3 wire tests and all 24
  native integration checks pass. Status publication p95 was 263.349 ms across 27
  controlled batches. Prior checkpoint `18b076f` passed all platform CI jobs in
  run `39323440469`. New commit platform CI remains separate verification.
- Added direct `ring 0.17.14` solely for SHA-256 fingerprints, reusing the version
  already locked through TLS. Receipt retention prevents old keys from being
  redispatched; no receipt deletion API is exposed. Send/delivery/start receipts,
  turn-correlated wait, job deduplication and MCP remain open delivery gates.
- Publication target is now the existing `origin/main`, explicitly confirmed by
  the user after `origin/master` was found not to exist. No force push or PR.

### F10 native MCP adapter checkpoint

- Added `nesvo mcp`, a stdio adapter over the shared authenticated host request
  and receipt path. Nine tools cover passive session/current/read/explain/diff/
  event queries plus durable create/lookup. Per-call authority remains host-owned;
  the catalog confers no permissions. No global provider configuration is written.
- Official `rmcp 3.5.1` handles modern metadata and legacy initialization. Defaults
  are disabled; only native server/I/O is enabled at runtime. Test-only client
  features exercise separate executable processes. `tokio-util` is direct solely
  to cap the SDK codec at 64 KiB rather than use its unbounded default reader.
- The official client/native test passes locally on Windows: modern and
  2025-11-25 clients, shared CLI/MCP idempotency key, real shell without a control
  lease, passive reads, errors, false scope, malformed/oversized frames, host loss,
  EOF and host PTY cleanup. CI runs this test explicitly after building binaries.
- F10 remains partial: subscription bridging, complete effects/task interface,
  cancellation audit and model-driven evaluations await their foundations.
  Coordinator/child creation still requires F11/F12, not a copied owner key.
- Prior `2ba79dc` on main passed every CI job in run `39326234140`.
- New Windows checks: fmt/Clippy, all 126 TUI + 73 host + 3 wire unit tests,
  the explicit native SDK integration and all 24 existing native host/sync/CLI
  checks pass. Controlled status publication p95 was 259.783 ms over 27 batches.
  Real ConPTY smoke also passes, including UI/input/menu/review, three dimensions
  (150×44, 100×32, 80×24), resize and clean terminal restoration.

### F17 native send/wait checkpoint

- Prompt intents share the durable receipt/event transaction and are claimed once.
  The PTY writer confirms complete write/flush, separately from provider pickup.
  Launch-local Claude v2 hooks record only a private prompt fingerprint; matching
  launch/generation/sequence/prompt evidence binds the exact response turn.
- Wait registers before reading and uses journal notifications, a bounded timeout,
  caller scope and fixed receipt target. Idle/unmatched prompts cannot finish it;
  a fast response is available to a late waiter. No model polling or input replay.
- Human takeover cancels pending Enter, unknown partial effects block automatic
  editor reuse, late native ACK cannot regress a settled turn, and restart never
  replays an intent. Legacy journals remain compatible without invented evidence.
- Native helper/PTY/wire tests cover literal Unicode/multiline input, same-key
  replay, timeout despite idle, late wait, mismatched prompt, human control/draft
  protection and final Stop near process exit. These use labeled provider fixtures,
  not real model runs. Current host unit tests: 79 passed on Windows.
- CLI/MCP adapters, actual-provider prompt matching, job dispatch receipts and
  explicit task results remain tracked gates. Prior `571392a` passed all platform
  CI jobs in run `39328005069`.
- Windows validation: fmt/Clippy, 126 TUI + 79 host + 3 wire unit tests and all
  25 native host/sync/CLI checks pass. Controlled publication p95: 262.555 ms
  (26 batches, 53 events; excludes provider/network latency).

### F09/F10 prompt adapters

- CLI adds literal `session send` through arguments, bounded file or stdin and
  `session wait` by receipt/key with optional target guard and explicit milestone.
  MCP adds `nesvo_send_prompt`/`nesvo_wait_prompt` over the exact same host path.
  Old hosts fail capability checks; no legacy input fallback is introduced.
- Wait deadlines include the requested host timeout. Timeout/failed/unknown
  outcomes preserve a recoverable receipt, and unsupported provider correlation
  fails explicitly. Neither adapter takes human control or retries terminal input.
- Official SDK/native MCP tests verify send → CLI same-key replay → delivered
  wait and reject shell response completion. Native CLI tests exercise file/stdin
  sends, replay and schema-valid waits. Controlled helper/PTY tests also send
  multiline Unicode through the actual CLI and verify exit 7/receipt on timeout.
- Provider matching on actual Claude and other installed CLI versions, scoped
  coordinator grants, interrupt/stop and MCP streaming remain separate gates.
- Windows checks: fmt/Clippy, all 208 Rust unit tests, explicit native SDK test,
  all 25 host/sync/CLI integration checks and repository formatter pass. Native
  scoped wait rejects foreign receipt IDs without revealing their existence.

### F17 startup fence repair

- CI `39331457639` passed app/browser/Linux/macOS, but its Windows fixture found
  a transient `lifecycle_pending` rejection immediately after new-session readiness.
  SessionStart can be published before the following startup event is consumed.
- A send now subscribes before reading its source fence and waits at most two
  seconds for journal progress. Only a rejected check before queue admission is
  retried; accepted paste/Enter bytes are never retried. Human takeover cancels
  the wait. A conversation change after paste blocks Enter and leaves unknown
  outcome/editor reconciliation rather than silently targeting a new generation.
- Local Windows Clippy, host unit checks and the native helper/PTY/CLI send
  regression pass with the repair. Full platform CI evidence remains separate.
