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

| ID  | Feature                                         | Baseline                                                      | Delivery / tests / commits                                                                                                    |
| --- | ----------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F01 | OSC 7501 parser and host query responder        | Missing                                                       | Partial: 0946401; live Windows negotiation gate open                                                                          |
| F02 | Provider lifecycle adapters                     | Partial: Claude launch hooks; other providers screen hints    | Partial: Claude and Codex 0.156 native adapters; real provider matrix/Gemini pending                                          |
| F03 | Status doctor and session explain               | Missing                                                       | Implemented diagnostics/version/correlation; provider matrix pending                                                          |
| F04 | Versioned detection rules and screen corpus     | Partial: hard-coded current-screen rules                      | Partial: 3e851ba; wider provider corpus pending                                                                               |
| F05 | Launch, conversation and event identity         | Partial: private launch report directory; wall-clock sequence | Partial: 173162e; Claude scoped journal; attempt identity in F17/F18                                                          |
| F06 | Evidence freshness and last-known state         | Partial: short hook/screen grace                              | Partial: 7445eb3; freshness/disconnect policy pending                                                                         |
| F07 | Starting, readiness and timeout                 | Missing                                                       | Implemented: readiness/timeout; platform/device matrix pending                                                                |
| F08 | Process, agent, turn, task and unread semantics | Partial: process exit and attention separate                  | Partial: 6d80847; separate axes, completion unread pending                                                                    |
| F09 | Stable session CLI                              | Partial: TUI flags and list only                              | Partial: all native session commands implemented; coordinator/provider end-to-end gates pending                               |
| F10 | MCP over host operations                        | Missing                                                       | Partial: native stdio SDK adapter; task/effect/subscription/provider gates pending                                            |
| F11 | Visible child sessions                          | Missing                                                       | Partial: persisted lineage and scoped background child launch; actual provider gate pending                                   |
| F12 | Scoped caller identity and agent instructions   | Missing                                                       | Partial: worker/coordinator capabilities, human priority and revocation; instructions/provider gate pending                   |
| F13 | Fan-out with explicit worktree ownership        | Partial: individual worktree launch                           | Partial: task launch with explicit shared/worktree mode, dirty-source preservation; ownership UI/setup/archive pending        |
| F14 | Durable run/task/attempt DAG                    | Missing                                                       | Partial: opt-in deterministic host executor; full provider orchestration/adoption gates remain                                |
| F15 | Durable inbox and ACK                           | Missing                                                       | Implemented core: scoped messages, atomic result notices, exact ACK and replay/reopen; dispatch/UI pending                    |
| F16 | Resumable bounded event subscriptions           | Missing: terminal replay is not domain event replay           | Partial: durable scoped journal/streams and CLI watch; receipt/result integration pending                                     |
| F17 | Receipts, idempotency and correlated wait       | Partial: request IDs, no durable receipts                     | Partial: shared create/send receipts and CLI/MCP correlated wait; job dispatch/provider coverage pending                      |
| F18 | Attempt-bound worker result                     | Missing                                                       | Partial: scoped explicit results, validation and retry fences; actual provider execution gate pending                         |
| F19 | Questions and decision gates                    | Missing                                                       | Partial: attempt-bound authority, exact revisions, timeout/cancel and inbox notices; native/UI gates pending                  |
| F20 | Worker budgets, cancellation and drain          | Partial: fixed eight-session limit                            | Partial: host/provider/run budgets, drain/resume and receipt-backed native stop/cancel; automatic dispatch/job queues pending |
| F21 | Once and recurring host jobs                    | Partial: host-owned once schedules                            | Pending                                                                                                                       |
| F22 | Timezone, cron/RRULE and DST                    | Missing                                                       | Pending                                                                                                                       |
| F23 | Missed-run policy and grace window              | Missing                                                       | Pending                                                                                                                       |
| F24 | Safe fresh/reuse session dispatch               | Partial: fresh launch with prompt                             | Pending                                                                                                                       |
| F25 | Bounded precheck                                | Missing                                                       | Pending                                                                                                                       |
| F26 | Delta-only coordinator wakeups                  | Missing                                                       | Partial: opt-in durable coalescing/native receipt and human/budget fences; original-model/checkpoint/UI gates pending         |
| F27 | Authenticated webhook and GitHub triggers       | Missing                                                       | Pending                                                                                                                       |
| F28 | Durable job attempts, retry and overlap         | Partial: schedule result field                                | Pending                                                                                                                       |
| F29 | Shared needs-you and group rollups              | Partial: attention and shared snapshot                        | Implemented canonical projections/rollups; device matrix pending                                                              |
| F30 | Stable attention/unread/MRU ranking             | Partial: palette and attention navigation                     | Pending                                                                                                                       |
| F31 | Contextual fuzzy search                         | Partial: session/group/command search                         | Pending                                                                                                                       |
| F32 | Incremental preview and process/turn times      | Partial: bounded replay and monotonic process age             | Implemented distinct process/turn times and bounded passive read; device matrix pending                                       |
| F33 | Revision-bound diff feedback                    | Missing                                                       | Pending                                                                                                                       |
| F34 | Verified session/turn edit provenance           | Partial: agent edit folder context only                       | Pending                                                                                                                       |
| F35 | Revision-bound checks and review readiness      | Missing                                                       | Pending                                                                                                                       |
| F36 | Trusted worktree setup/run/archive              | Partial: create worktree only                                 | Pending                                                                                                                       |
| F37 | Provider-aware launch profiles                  | Partial: templates                                            | Pending                                                                                                                       |
| F38 | Session-scoped MCP and skills                   | Missing                                                       | Partial: opt-in Claude instruction/MCP, inheritance and effective config; broader profiles/resume pending                     |
| F39 | Isolated safe MCP pooling                       | Missing                                                       | Pending                                                                                                                       |
| F40 | Durable goal/progress checkpoint                | Missing                                                       | Partial: durable goal/plan/result/validation history; compaction/adoption/manual constraint edits pending                     |
| F41 | Layout, conversation and workflow recovery      | Partial: saved launch recovery records                        | Pending                                                                                                                       |
| F42 | Safe resumable hibernation                      | Missing                                                       | Pending                                                                                                                       |
| F43 | Mobile fleet, decisions and jobs                | Partial: existing mobile sessions/control                     | Pending                                                                                                                       |
| F44 | Trustworthy quota-aware dispatch                | Partial: usage cache and quota wake                           | Pending                                                                                                                       |

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

### F09/F10 durable interruption and stop

- Added shared owner-authorized native process controls, CLI `session interrupt`
  / `session stop` and MCP equivalents. Accepted intent and claim precede effects;
  keys include operation kind. Replays return the original receipt without a
  second Ctrl+C/stop, including after process exit or host restart.
- Active human ownership refuses effects. Automated pending input is preempted;
  editor reuse requires reconciliation. Interrupt delivery proves write/flush,
  while stopRequested proves a native request, not observed exit or task success.
  Session identity and terminal replay remain readable. Passive workers remain
  unable to signal or stop anything; run/descendant cancel/drain is separate F20.
- SQLite regression verifies transition kinds and historical controls after
  restart. Native SDK and CLI tests exercise interrupt/stop/replay and retained
  output; helper/PTY tests refuse both while a human holds the session. No model
  calls, real user process termination or provider/global settings changes.
- Windows validation: fmt/Clippy, 126 TUI + 80 host + 3 wire unit tests, the
  explicit native SDK test, all 25 host/sync/CLI checks and formatter pass.
  Controlled publication p95: 263.307 ms (26 batches, 53 structural events).

### Native stop/teardown repair

- Windows CI `39333069514` found that Ctrl+C can exit the shell before the next
  stop. An already observed exit now produces `stopped` with no native effect,
  rather than a failed or fabricated stop request. The SDK fixture independently
  checks interrupt, actual stop on an un-interrupted process, already-stopped
  no-op, replay and retained output.
- Very early native stop also exposed ConPTY teardown before its startup cursor
  handshake completed. Stop/close/shutdown now share one bounded writer barrier
  and decoder-owned initial reply. A late startup query is consumed without a
  duplicate response; cleanup no longer assumes a terminal was attached.
- Local Windows Clippy, the decoder regression, native SDK and CLI checks pass.
  This repairs an observed platform boundary, not an assertion-only test change;
  broader CI evidence will be recorded separately.

### F11 process lineage

- Advanced launch carries optional immutable parentSessionId, preserved in
  session snapshots and prompt-free recovery metadata. A child is one ordinary
  visible native process with its own control lease. Parent must be live at
  launch; lineage never grants authority. CLI `--parent` and MCP use the same
  normalized idempotent request and require advertised lineage capability.
- Default lineage is omitted from serialization so existing durable launch-key
  fingerprints remain identical. Same-name parent/child IDs stay distinct.
  Host restart preserves historical metadata, not the live process or old grants;
  recovery lineage remapping remains F41.
- Native tests verify background child creation while a human controls the parent,
  late-observer lineage, invalid parent refusal, restart metadata and replay with
  no resurrection. SDK-to-MCP → CLI child replay creates only once. A TUI model
  regression keeps input focus/lease when the same-name child arrives first.
- Coordinator grants and the agent instruction/real-provider child-launch gate
  are the next F12 boundary; this checkpoint does not label them complete.
- Windows checks: fmt/Clippy, 127 TUI + 82 host + 3 wire tests, explicit native
  SDK test, all 25 native host/sync/CLI checks, mobile typecheck/lint, 22 client
  checks, 4 architecture checks and formatter pass. No new dependencies or UI
  layout change. Actual device/provider orchestration remains an open gate.

### MCP fixture observation ordering

- Windows CI `39334491119` passed the native stop/no-op paths but caught a test
  assuming flushed PTY input meant PowerShell had already produced output.
  Ctrl+C could arrive during shell startup, before the expected retained marker.
- The native SDK test now waits for the isolated Windows shell prompt before
  sending, then observes the marker before interrupting. It reads retained output
  with an explicit bounded byte cursor. No production delivery/receipt semantics
  were weakened or replaced by a sleep; observed output is separate evidence.

### F12 coordinator process capabilities

- Owner-authorized coordinator roles grant worker-child capabilities only after
  authenticated child creation. Parent metadata is separate from authority.
  Children inherit canonical workspace/group boundaries, cannot recursively
  request coordinator authority, and a fixed 256 lifetime grant bound applies.
- CLI/MCP share stable normalized create intents and issuer-bound receipts.
  Dynamic workspace/group resolution follows the claim, preserving replay when
  parent metadata changes. Live actor authority is checked again before create,
  native controls and every prompt chunk. Current-session queries use host binding
  rather than a forgeable environment hint when scoped.
- A controlled provider fixture invokes the real CLI from its managed process,
  using only its own context. Native SDK tests verify CLI/MCP replay, child-only
  views/events, matched send/wait, human control refusal, forged claims/foreign
  lineage/workspace rejection, reconnect and revocation. Coordinator exit leaves
  child processes visible to their human owner. No model calls or global changes.
- This is API capability control, not same-account filesystem sandboxing, durable
  run authority or a real model orchestration proof. Versioned instructions and
  per-launch provider configuration are next; F12 remains partial.
- Published baseline `f9277b1` passed all CI jobs (39335396956), including native
  Windows/macOS/Linux. Current changes require their own platform evidence.
- Local Windows validation: fmt/Clippy, 127 TUI + 83 host + 3 wire unit checks,
  both explicit SDK/native tests and all 25 host/sync/CLI integration checks pass.
  Mobile typecheck/lint, 23 client and 4 architecture checks pass. Controlled
  status publication p95: 251.973 ms (26 batches; provider latency excluded).

### F12 versioned instruction and CLI discovery

- Embedded `skills/nesvo-harness/SKILL.md` version 1 is copied to each private
  process context and exposed through `NESVO_AGENT_SKILL`. Guidance covers actual
  supported commands, authoritative identity, receipt recovery, human priority,
  bounded reads, and response settlement versus verified task success. No global
  skill files, provider login/configuration or user sessions are changed.
- Native CLI discovery selects an absolute owner-provided host override or the
  running host's sibling executable. Invalid overrides never use PATH fallback.
  Launchers clear inherited foreign caller hints before binding the new context.
  The controlled managed process now creates its child through production
  `NESVO_CLI` discovery rather than a fixture-specific client path.
- Development hosts retain immutable matching host/CLI runtime pairs, independent
  of the temporary TUI executable and later builds. PowerShell fixtures verify
  this and are included in Windows CI alongside the native host probe regression.
- Two bounded offline instruction scenarios were evaluated with/without the
  skill. With the skill, original-key recovery syntax and role/completion rules
  were correct in all six assertions; the baseline lacked recovery grammar and
  also made an adjacent recursive-coordinator claim. This is instruction review,
  not actual provider execution or a statistical quality/performance guarantee.
- Windows fmt/Clippy, all 214 Rust unit checks, both native SDK tests and isolated
  PowerShell runtime/probe checks pass. Provider loading and real model-to-child
  launch remain open until per-session configuration is wired and verified.

### F38 opt-in native Claude harness

- CLI `--harness` and MCP `spec.harness:true` configure Nesvo MCP and instruction
  files per process on probed Claude Code 2.1.303+ (2.1 series). Host validation
  refuses unsupported providers/versions or missing native CLI before effects.
  Additive omitted defaults retain legacy receipt fingerprints.
- Scoped children inherit the coordinator setting; explicit false/`--no-harness`
  opts out. Configuration is immutable for a live process; no implicit restart,
  permission bypass, default-system-prompt replacement or global MCP mutation.
- Session/explain JSON exposes effective configuration with `loaded:null` to
  distinguish prepared arguments from actual provider consumption. Native SDK
  tests consume the generated MCP config and the controlled provider reads the
  actual instruction. Tests cover CLI opt-in, inherited config, explicit opt-out,
  unsupported provider refusal, literal argv and private no-key MCP files.
- The official Claude CLI reference was checked for native append-file/MCP flags.
  Windows fmt/Clippy, 127 TUI + 85 host + 3 wire unit checks and both native SDK
  tests pass. Broader profile settings, dynamic declared tools and controlled
  resume remain tracked separately; this checkpoint does not complete F38.
- Real Windows smoke discovered Claude Code 2.1.304 (the CLI updated since the
  earlier 2.1.303 baseline). A single opt-in coordinator was launched against an
  existing isolated Git fixture with no edits or permission bypass. It remained
  at `readiness:waiting`, reason `folder trust`, with rule `claude_trust_v1` and
  no lifecycle hook yet. No model response or child was observed; the host
  cleaned up successfully. This is an explicit provider gate, not a passing
  orchestration test. No global trust/settings entry was written by the test.
- Prior capability commit `d962c52` passed all CI jobs in run `39337845395`,
  including both SDK/native tests on Windows, macOS and Linux.
- All 25 Windows host/sync/CLI integration checks also pass with the launch
  adapter. Controlled receipt-to-publication p95: 261.772 ms (26 batches).

### F05 native provider turn fence

- Codex CLI 0.156.0 and its release-tagged hook schemas expose native `turn_id`;
  the lifecycle journal now accepts an explicit provider-turn fence. Repeated
  prompt pickup, old prompt pickup after a newer turn, and late tool/Stop events
  from a prior turn cannot regress the active work. Native identity is checked
  in the same transaction as journal acceptance, without wall-clock ordering.
- A bounded 4096-entry launch-local seen-turn set prevents forgotten IDs from
  becoming fresh work. Exhaustion fails explicitly rather than weakening the
  fence; prompt text is not stored. Old journals and Claude's existing optional
  prompt-digest path retain compatibility.
- The journal regression passes with the old-generation and legacy journal
  checks. This is the prerequisite for the Codex adapter, not a claim that its
  per-launch configuration or actual provider lifecycle gate is complete.

### F02 Codex 0.156 launch-local adapter

- Version-gated Codex native hooks share the host's private journal, status,
  readiness, prompt correlation and explicit native Interrupt handling. A local
  executor (`--no-daemon`) keeps another app-server from owning the hook context.
  Native turn IDs fence duplicate/late events. Compaction preserves an active
  native fence and does not manufacture idle; Stop/Interrupt retire it.
- User/project hooks remain alongside the session layer; native hook trust and
  disabled/managed policy are respected. No bypass flag, global config write,
  model API or transcript-format parsing. Commands use owned literal helper
  paths; Windows stdin/Unicode forwarding is verified through the actual helper.
- The controlled Codex process consumes the generated config, emits real helper
  reports and receives a literal prompt via MCP/native PTY. Its matching receipt
  settles through the shared host wait. This is an explicit provider fixture,
  not an LLM integration claim. The installed 0.156.0 CLI also accepts the TOML
  using `features list`; `--strict-config` is unsupported for that subcommand,
  so no strict-validation claim is made.
- Real Windows Codex startup without a prompt left `readiness:starting`, hook
  delivery missing after 12 seconds, with no helper error; only the Codex screen
  marker was observed. No hook-trust or readiness claim follows from that probe.
  Its isolated host exited cleanly. Actual trust/start/working/question/permission/
  interrupt/Stop paths remain an open stage-1 gate, as does Gemini availability.
- Windows fmt/Clippy, 127 TUI + 89 host + 3 wire unit checks, both SDK/native
  tests and all 25 host/sync/CLI integration checks pass. The opt-in installed
  Codex parser test passes separately (no model/hook execution). Controlled
  receipt-to-publication p95: 261.562 ms over 26 batches.
- `3e0ca01` and the native-fence baseline `0000309` passed all platform CI jobs
  (39339263905 and 39339747442). The new adapter needs its own CI evidence.

### F44 legacy wake preemption repair

- Auditing the existing quota wake found a direct-input path without the shared
  human/draft/pending-submission guard. It now refuses wake while a user holds
  control, an unresolved draft exists, another submission is pending, or current
  state is no longer quota-blocked. The armed wake remains pending within its
  existing grace window rather than overwriting the editor.
- A regression uses one owned native shell with an explicit quota projection,
  never a model. It verifies all three preemption cases against the actual wake
  path. This closes the immediate human-priority hole; migration of the legacy
  direct write to durable dispatch receipts, full quota trust and provider queue
  policies remain F24/F44 work. This repair is not the complete quota feature.

### F14 durable draft plans and shared API

- Runs/goals and task DAGs now persist through the existing SQLite journal
  actor, with stable IDs, revision guards and atomic metadata mutation recovery.
  Cycle, missing-edge, duplicate-key and size checks precede commit. Plan state
  remains separate from process state; no draft is treated as executed/successful.
- Five MCP tools and `nesvo run` use the same scoped host path. Coordinators
  access only their own runs; workers cannot read plans or claim authority from
  lineage metadata. Native process receipts remain a separate recovery namespace.
- Windows fmt/Clippy, 128 TUI + 93 host + 3 wire unit checks, both SDK/native
  integrations and all 26 host/sync/CLI integrations pass. Controlled status
  receipt-to-publication p95: 252.491 ms (26 batches). SDK checks also verify
  MCP-to-CLI plan recovery, coordinator isolation and worker denial. No model
  calls or layout changes; no new dependencies. See [contract](harness-workflows.md).
- Native attempts, dispatch, explicit task results/validation and automatic DAG
  progression remain open; this is a partial F14 checkpoint, not the stage-3 gate.
- `acbb7af` passed every CI job in run 39340978030. The following wake-guard
  commit's first Windows run failed because a CLI test received an error without
  its expected receipt; Linux/macOS/app/browser passed. Local reproduction passed
  and a bounded rerun is pending. The test now prints its structured failure
  before dereferencing the receipt, so another failure has useful diagnostics.

### F14/F18 explicit attempts and independent validation

- Activated plans now bind exact worker processes to dependency-ready tasks.
  Coordinator ownership and private child grants are checked by the host;
  assignment refuses human control/drafts/pending input and has no PTY effects.
  Creating/sending to a worker remains a deliberate native-receipt operation;
  automatic dispatch and configurable execution budgets remain open.
- Only the bound worker can read its task context and report its first explicit
  outcome/files/artifacts/checks/limitations. The coordinator/owner independently
  records validation evidence. This is explicitly an attestation, not host-run
  checks. A report/idle/response Stop cannot release dependencies. Accepted
  validation does; all accepted tasks complete a run without killing sessions.
- Rejected attempts can be retried on fresh workers. Immutable history, exact
  current-attempt fences and same-key recovery survive database reopen. Late
  results from an old attempt cannot overwrite a retry. Bounded history is
  paginated; capacity exhaustion never discards records or repeats input.
- CLI and six additional MCP tools use the same path. Instruction version 2
  includes task discovery/report/validation, recovery namespaces and honest
  evidence rules. Existing live launches retain their original instruction
  snapshot. An offline version-1/version-2 scenario preserves both versions'
  refusal to self-validate; only version 2 supplies the new commands/namespace.
  This small instruction check is not model/provider or performance evidence.
- Windows unit checks pass (128 TUI + 96 host + 3 wire), along with both official
  SDK/native integrations. A controlled worker discovers/reports its assigned
  task through its actual inherited native CLI; independent validation releases
  a controlled reviewer. No model calls, global configuration or visual changes;
  no new dependencies. Full provider/decision/inbox/restart execution acceptance
  remains open. See [workflow contract](harness-workflows.md).
- The bounded rerun for `ecd99d3` passed all CI jobs (39341315170); its original
  Windows receipt failure remains unclassified rather than being called fixed.
  Draft-plan baseline `4c99ba0` passed all jobs in 39343029888, including native
  SDK coverage on Windows, Linux and macOS. New attempt code needs its own CI.
- All 26 Windows host/sync/CLI integrations pass with attempt-capable hosts.
  Controlled status receipt-to-publication p95 is 263.076 ms over 26 batches;
  this excludes native helper, model and network latency.

### F15 durable inbox and exact acknowledgement

- Added run coordinator and attempt-specific mailboxes through the same bounded
  SQLite journal actor. Send, mutation recovery and domain event commit together;
  report and its single result notice are atomic. Neither message ACK nor native
  idle validates a task. Inbox actions leave execution revisions unchanged.
- Host-derived senders, receiver-only worker ACK, run visibility and current
  attempt fences prevent forged identities and superseded-worker recovery.
  Reading never ACKs; first exact-ID acknowledgement survives retry/reopen, and
  later arrivals remain pending. Capacity failures are explicit; ACK remains
  usable at full retention. Routine events omit message bodies.
- CLI and three additional MCP tools share the contract and mutation keys.
  Instruction version 3 explains pending-read recovery, exact ACK, stale results
  and native-versus-metadata recovery. One offline scenario compares versions
  2/3; it tests supported command knowledge, not provider/model performance.
- Six inbox storage tests include full-capacity rollback, reopen, stale workers,
  pagination and atomic invalid batches. Native SDK coverage restarts an MCP
  consumer and retains a pending result while its coordinator is working, with
  no inbox-to-PTY effect. It uses controlled native workers, not model calls.
  See [the inbox contract](harness-inbox.md) for bounds and remaining gates.
- The attempt baseline `2f19776` passed all CI jobs in 39344710968, including
  Windows/Linux/macOS SDK coverage. Inbox Windows checks pass: fmt, Clippy with
  warnings denied, 128 TUI + 102 host + 3 wire unit tests, all three official
  SDK/native integrations and all 26 host/sync/CLI integration checks. Controlled
  host receipt-to-publication p95 is 252.207 ms over 26 batches, excluding native
  helper/model/network latency. Inbox commit `b5c85af` passed all jobs in
  39347001213, including native SDK checks on Windows, Linux and macOS.

### Durable writer-admission regression

- The journal and existing metadata store share a SQLite file through separate
  connections. A deterministic competing-writer test reproduces an immediate
  `database is locked` read-to-write upgrade with the former deferred receipt
  transaction. Immediate writer admission passes the same barrier test and
  retains same-key replay, without sleeps or native/model effects.
- Receipt initialization/accept/claim/finish and workflow/inbox mutations now
  reserve write access before reading mutable state. Pure reads retain ordinary
  read transactions. Existing bounded journal queues and contention timeout stay
  in place; no automatic input or effect retry is added. See
  [transaction contract](harness-transactions.md).
- A native coordinator fixture previously returned `operation_unconfirmed` once
  and passed its bounded isolated rerun. That occurrence had no SQL error code,
  so its exact cause remains unclassified; the new regression proves the writer
  conflict separately instead of declaring every earlier flake fixed.

### F19 attempt-bound questions and decisions

- Added durable worker questions addressed explicitly to the owner or run
  coordinator, with independent revisions, literal answers, cancellation reasons
  and deadlines. Workers cannot self-answer; a coordinator cannot answer or
  suppress an owner-only question. Current-attempt fences prevent late identity
  substitution. ACK is delivery only and cannot release a decision gate.
- Question/answer/cancel and their receiving inbox notice commit atomically.
  The host reserves `decision` notices and supplies trusted identity; routine
  events omit bodies. Pending/canceled/expired gates block succeeded reporting.
  Non-success reports close remaining questions; retry requires explicit review
  and a fresh worker. Answers still require independent result validation and
  never type a native provider permission approval.
- Deadlines persist on authorized observation, independently of rejected late
  answers. Reopen/observed clock rollback cannot resurrect a resolved question.
  No timer, model wake/polling loop or automatic native dispatch was introduced.
  Passive summaries count stored unresolved decisions; list/get materialize
  expiration. Automatic timeout delivery, unobserved wall-clock policy and
  TUI/mobile decision queues remain explicit follow-up gates.
- CLI and five additional MCP tools share bounded records and workflow recovery
  keys. Instruction version 4 adds supported decision grammar and authority
  boundaries. One offline v3/v4 comparison checks command knowledge; both retain
  conservative safety. It is not statistical/model/provider evidence.
- Windows checks: fmt and Clippy with warnings denied; 128 TUI + 108 host + 3 wire
  unit tests, including five decision storage regressions and the competing-writer
  regression; all three official SDK/native integrations and all 26 host/sync/CLI
  checks. The controlled native worker asks through its actual CLI, owner answers
  through MCP, exact-key recovery and versioned JSON schemas are verified, and
  PTY replay remains unchanged. No model calls/global settings or UI changes.
  Controlled publication p95 is 252.763 ms over 26 batches, excluding native
  helper/model/network latency. Decision commit `c9ee53e` passed all jobs in
  39348747416; writer-admission `7008595` passed all jobs in 39348280045. Both
  include native SDK verification on Windows, Linux and macOS.
- Full stage-3 acceptance is still open: actual provider/model escalation,
  automatic dispatcher/wakes, run budgets/cancel/drain and replacement-process
  adoption remain. See [decision contract](harness-decisions.md).

### F20 persisted host and provider admission budgets

- Replaced the fixed eight-session admission check with owner-controlled,
  revisioned host policy: retained session slots, running worker-role processes
  and running processes per provider. Default policy preserves eight, with a
  bounded ceiling of 16. Exited sessions release live process capacity while
  retained terminal output still consumes a slot. Lowering limits preserves work,
  input control and focus; coordinators/workers cannot raise global policy.
- Policy, domain event and original-key result commit together. Startup loads
  the committed policy into shared native state; live guards read that projection
  without SQLite/render I/O. Historical same-key replay returns its old result
  while the active projection remains current. Reopen/full-capacity tests verify
  persistence, refusal without partial changes and recoverability.
- All native launch paths use the shared guard, including legacy creation.
  Metadata admission reserves name/path bytes and startup headroom before spawn;
  actual candidate snapshots are checked before persistence/announcement. This
  preserves existing frame/retention bounds rather than silently raising wire
  limits. Unpaged worst-case snapshot growth remains explicit transport work.
- Added CLI `budget get|set` and two owner-only MCP tools, sharing workflow keys
  and exact budget revisions. No new dependencies, model calls, provider-global
  settings or material UI changes. See [budget contract](harness-budgets.md).
- Windows storage/admission tests and native SDK exercise ten retained sessions,
  nine running workers, policy reduction without termination, scoped refusals,
  observed exit/provider-slot reuse and eleven retained sessions. CLI/MCP replay
  agrees without restoring obsolete limits. CLI/legacy checks validate JSON,
  bounded input files and rejection of an old create request without disrupting
  existing sessions. Run/time/retry budgets, cancel/stop/drain and automatic DAG
  dispatch remain F20/F14 requirements; this is not the full stage-3 gate.
- Windows validation: fmt, Clippy with warnings denied, 128 TUI + 112 host + 3
  wire unit checks, all four official SDK/native integrations and all 27
  host/sync/CLI checks. A corrupt-policy fault test verifies that an authorized
  failed read disables new admissions instead of retaining obsolete limits.
  The final budget SDK scenario and eleven CLI/legacy checks also pass after
  that error-path hardening. Controlled receipt-to-publication p95 is 263.611 ms
  over 26 batches, excluding native helper/model/network latency. This budget
  implementation passed all five jobs in CI run `39351048166`, including native
  SDK coverage on Windows, Linux and macOS.

### F20 per-run admission and graceful drain

- Added durable parallel, per-task attempt and elapsed limits, independent of
  global host/provider process caps. Reported results occupy parallel slots until
  explicit validation. Owner/coordinator may tighten policy; only owner may
  relax limits. Worker scopes cannot self-extend or recursively create workers.
- Activation records the elapsed clock; drain/resume and policy edits preserve
  it. First observed exhaustion commits independently of rejected admission and
  survives reopen/clock rollback. Only explicit owner extension/removal can
  reopen time admission. Legacy runs without activation evidence stay untracked.
  Existing work may report/validate after exhaustion; no model timer is added.
- Drain refuses new assignments while current reports/validation finish, then
  becomes drained or explicitly validated success. An owner drain has a durable
  owner-only resume latch, preserved even if a coordinator drains again. Native
  work, human leases, drafts and focus are not changed by metadata controls.
- Added CLI `run budget get|set`, `run drain|resume` and four MCP tools (38 total).
  Shared run revisions, workflow keys, strict bounded policy files and versioned
  JSON schemas cover CLI/MCP parity and historical recovery without replay.
- Automated native sends check current attempt, time budget and unresolved
  decision gates before paste and again before submit, alongside existing human
  and lifecycle fences. Refusals preserve typed receipts and no-effect evidence;
  direct human input and native interrupt/stop remain independent.
- Windows validation: fmt, Clippy with warnings denied, 128 TUI + 116 host + 3
  wire unit checks; all five controlled SDK/native scenarios and 28 host/sync/CLI
  checks. The new native fixture waits for actual provider discovery instead of
  racing startup; it uses CLI/MCP policy replay, a real controlled worker result,
  owner drain authority and elapsed input refusal with unchanged terminal bytes.
  Controlled status publication p95 was 252.235 ms over 26 batches, excluding
  native helper/model/network latency. No model calls, dependency additions,
  global provider configuration edits or UI changes were required.
- This is not the complete F20/stage-3 gate: native run-wide stop/cancel,
  automatic pre-launch DAG reservations, coordinator adoption and actual provider
  escalation remain required. Native sessions without run bindings obey global
  process budgets; they are not silently attributed to a run. See
  [run policy and remaining scope](harness-run-budgets.md). Commit `ce68ead`
  passed all five jobs in run `39352987299`, including Windows, Linux and macOS.

### F38 instruction version 5: run policy and human priority

- Launch-local instruction version 5 documents the implemented budget,
  drain/resume and recovery grammar; obsolete budget-unavailable statements were
  removed. Coordinators inspect policy before creating extra workers, without
  confusing a read with an atomic pre-launch reservation. Owner-only relaxation,
  owner drain, reported-slot retention and preserved activation/retry history are
  explicit. Unknown native input and human drafts remain separate blockers.
- Added one targeted offline case against the version-4 snapshot, with an initial
  review artifact before grading and a final candidate rerun after wording
  cleanup. The final candidate satisfies 5/5 expectations, baseline 2/5. Both
  preserve conservative authority/recovery safety; new command/accounting
  knowledge distinguishes them. This is one sample per version, not statistical,
  actual-provider or model-execution evidence. Timing/token metrics were not
  exposed and were omitted. Existing five offline cases are retained, not claimed
  rerun in this targeted iteration. Review/evaluation outputs stay outside Git.
- Updated the injected snapshot version and native fixture checks together.
  Windows fmt, Clippy with warnings denied, 247 unit checks and all five native
  SDK cases pass. After final wording cleanup, caller snapshot tests and all five
  native SDK cases pass against rebuilt binaries. New launches receive this
  snapshot; live user sessions/global provider settings are not rewritten.
  No dependency or visual layout changes. Stage-3 native control/dispatcher and
  actual provider integration gates remain open.

### F20 native run stop/cancel and observed exit

- Added durable run-control intents with a frozen set of bound worker targets,
  bounded eight-target dispatch/read pages, stable per-target native receipt keys
  and exact run revisions. Original workflow replies remain immutable acceptance;
  current control reads distinguish requested stops, known refusals, uncertain or
  unavailable processes, and proven exits. Reads/replays/reconnect never signal.
- Trusted host exit observations persist independently of event-log retention
  and finalize controls even without clients. Restart invalidates dispatch claims
  without replay. A missing unadopted process remains unavailable, not dead.
  The original native receipt ID remains recoverable after a lost parent reply.
  Only the latest control may finalize the run, preventing an older stop from
  overwriting a newer cancellation.
- Native authorization is rechecked per target. Coordinators cannot target
  themselves, unassigned children or foreign sessions. Active human control and
  retained drafts both block automated run stops. Known no-effect refusals need
  a resolved blocker and deliberately authorized new intent; uncertain effects
  refuse a fresh-key workaround.
- Stop becomes resumable `stopped` only after observed exits, preserving the
  activation clock, budgets, reported work and owner-only resume latch. Unreported
  stopped work can retry on a fresh process/attempt. Cancel becomes terminal
  `canceled`; neither operation invents answers, passing checks or task success.
  Current workers may ask/answer decisions during graceful drain (`7e471ed`),
  avoiding a deadlock while finishing admitted work.
- Added CLI `run stop|cancel|control`, three MCP tools (41 total), `runControls`
  capability and versioned JSON schemas. Native receipt lookup accepts both
  positional IDs and explicit `operation --id`; conflicting selectors are rejected.
  CLI doctor prints the actual injected instruction version. No dependencies,
  global provider configuration edits or material visual changes were introduced.
- Windows final validation: fmt, Clippy with warnings denied, 128 TUI + 124 host +
  3 wire unit checks; seven new control storage regressions; six controlled native
  SDK scenarios and 29 host/sync/CLI checks. Controlled status publication p95 was
  251.148 ms over 26 batches, excluding provider/model/network latency.
- An isolated original Claude Code 2.1.304 startup process was bound then stopped
  through the actual CLI. Acceptance was `stopping/dispatching`; control later
  reached `stopped/completed` with target exit proof, while its native receipt
  still accurately said `stopRequested`. Recovery returned the original acceptance.
  The process was waiting on folder trust: no prompt, model call or trust approval
  occurred. The test host exited cleanly and all three observed owned descendants
  were gone. This proves startup process control, not agent work/hook readiness.
- Native command growth exposed Windows entrypoint stack overflow even for help.
  `4c0e9ef` heap-pins the headless dispatcher rather than raising stack limits.
  The startup and original-provider smoke pass with that boundary. CI `39354638300`
  separately failed four parallel host startup deadlines on Windows while its
  other jobs passed. `3dc1744` serializes host-heavy scenarios on shared runners,
  retaining concurrency inside scenarios. Follow-up CI is still running; local
  parallel and serial SDK executions pass. No all-platform result is inferred.
- Automatic pre-launch reservations/dispatch, job admission queues, unknown
  process adoption and the complete real-provider matrix remain required gates.
  See [native run control contract](harness-run-controls.md).

### F38 instruction version 6: native control and recovery

- Launch-local V6 explains supported stop/cancel, bounded control inspection,
  workflow-key versus native receipt-ID recovery, owner stop/resume, preserved
  reported work and explicit post-restart uncertainty. Existing live launches and
  provider-global settings are not rewritten.
- Added targeted offline case 7 against the V5 snapshot. The initial ungraded
  reviewer preceded reading/grading outputs; final semantic review and executable
  command checks find V6 satisfies 5/5 expectations, V5 2/5. Both preserve safe
  authority/recovery behavior; the distinguishing assertions concern newly
  implemented grammar and stop/cancel semantics. One sample per version is not
  statistical or actual-provider/model evidence. Timing/token metadata was absent
  and omitted. Earlier six cases remain retained inputs, not claimed rerun.
  Evaluation/reviewer artifacts remain outside Git.

### F14/F20 atomic task launch and native identity reservation

- Added CLI `run launch` and MCP `nesvo_launch_task` (`runLaunch`, 42 tools).
  A dependency-ready task, attempt/retry number, parallel slot, native create
  receipt and future session ID commit together before native/Git setup. Fault
  injection proves receipt/attempt/mutation/events rollback together. Separate
  SQLite writers see reserved capacity before a process exists.
- Native launch uses the ordinary receipt claim/finish pipeline. Immutable
  workflow acceptance is recovered separately from current native creation and
  actual readiness. Same-key replay/read/reconnect cannot create another worker.
  `launching`/`launchUnknown` retain capacity; only proven no-effect startup failure
  frees its parallel slot while keeping retry/history. No startup failure is
  fabricated into a worker result or task success. Restart invalidates unfinished
  native claims and keeps unknown launches blocked for explicit reconciliation.
- Physical launch and stop/cancel of one run share an ephemeral permit; conflicts
  return `busy` without an unbounded queue. Reads/different runs remain separate.
  Control targets include reserved native identities and exclude proven no-effect
  startup failures, without confusing those with observed process exit. Worker
  reporting, human priority, run drain/time policy and explicit validation remain
  enforced. Global native caps are rechecked at ordinary creation.
- Shared checkout or isolated worktree must be chosen explicitly. Owner launch
  into a coordinator's run delegates only the fresh worker through that live
  coordinator's existing bounded capability. Native receipts retain their real
  issuer: coordinator child/run access cannot read owner receipts merely by ID.
  No prompt is typed and no focus/control is acquired by launch.
- Controlled native SDK coverage: simultaneous same-key requests, matching CLI
  replay, dependency/parallel refusals, actual worker report and independent
  validation, owner-delegated review worktree, source-edit preservation, issuer
  isolation and observed run cancellation without targeting the coordinator.
  A further owner launch after deliberately stopping that coordinator fails with
  durable `scope_revoked/effectStarted:false`, freeing its parallel slot without
  reviving expired authority or starting another process.
  Windows test Git settings affect only an owned temporary repository; no global
  configuration is changed. CLI schemas validate reservation, current history,
  native-ID lookup, required workspace mode and intent conflicts.
- Windows validation: fmt, Clippy with warnings denied, 128 TUI + 133 host + 3
  wire unit checks, all seven controlled native SDK scenarios and 30
  host/sync/CLI checks. No new dependency or visual change was needed. The preceding
  native-control commit `4d1ddfc` passed all five jobs in CI `39356883349`, including
  Windows/macOS/Linux. CI `39356651211` exposed a distinct pairing-file/startup
  race in an authentication fixture; `f00cbaf` waits for actual listening before
  authentication, retaining the authentication deadline. That commit passed all
  five jobs in CI `39357940895`. Controlled status publication p95 was 252.557 ms
  over 26 batches, excluding provider/model/network latency. New task-launch
  platform CI is not claimed before it runs.
- An isolated original Claude Code 2.1.304 smoke used actual `run launch`, native
  receipt inspection and original-key recovery. Reservation was `launching` with
  native phase `accepted`; current state became `assigned/created`. The provider
  remained correctly blocked on folder trust, with no prompt/model/trust approval.
  Native run stop then reached observed exit; the owned host and three observed
  descendants exited cleanly. This proves startup/binding/control, not agent work,
  hook readiness or model consumption of the injected instruction.
- Automatic DAG execution/prompt dispatch, worktree ownership presentation/setup/
  archive, unknown-process adoption and job policy remain required stage gates.
  See [atomic task launch](harness-task-launch.md).

### F38 instruction V7: atomic launch and receipt authority

- V7 prefers atomic launch for new task workers, distinguishes legacy manual
  binding, teaches explicit workspace choice, immutable acceptance/current native
  evidence, unknown-slot retention, known no-effect startup retry accounting and
  deliberate input only after assigned/readiness/human gates.
- Offline case 8 compared one final candidate with the frozen V6 snapshot.
  Initial evaluation exposed an overly broad cross-caller receipt statement.
  The candidate now explicitly says receipt IDs are pointers, not grants; only
  owner may inspect another issuer's native receipt. The expanded prompt and both
  versions were rerun, with draft outputs archived and not counted twice.
- Final semantic grading and programmatic command checks: V7 6/6, V6 3/6.
  Recovery, human/validation safety and receipt authority pass in both; newly
  implemented grammar and accounting distinguish V7. Initial ungraded reviewer
  preceded reading/grading final outputs. This targeted single sample is not
  statistical or provider/model evidence. Timing/token metadata was unavailable
  and omitted. Earlier seven cases remain retained inputs, not claimed rerun;
  research/reviewer artifacts stay outside Git.

### F14 guarded task instruction intents

- Added CLI `run deliver` / `run cancel-delivery`, two MCP tools (44 total),
  `runDelivery` capability and versioned queue/native receipt projections.
  An explicit intent targets only the immutable instruction/current assigned
  agent worker. It cannot replace text, select by UI focus or execute task prose
  in a shell. Queue acceptance, native delivery, explicit result and validation
  are separate facts. Automatic DAG task selection remains pending.
- A bounded host waiter survives client disconnect, waiting for actual provider
  readiness and idle with run/decision/elapsed/native authority fences. A native
  send receipt commits with the exclusive delivery claim before paste/Enter.
  Unchanged blockers emit no repeated events; no model heartbeat is sent.
  Same-run native launch/stop/cancel share the existing physical-effect permit.
- Human control at acceptance or later takeover pauses the intent, including a
  quick grant/release without a draft. Releasing the lease does not reactivate it.
  An epoch fence is checked again under the same State lock as native submission.
  Queued cancellation/expiry has no native receipt. Replay/new keys cannot
  dispatch twice. Restart pauses unclaimed work and retains claimed uncertainty;
  automatic rearm and recovered process adoption remain open.
- Windows verification: fmt, Clippy with warnings denied, 128 TUI + 140 host +
  3 wire unit checks, seven delivery storage regressions, all eight controlled
  native SDK scenarios and 30 host/sync/CLI checks. After expanding quick takeover
  coverage, the delivery SDK scenario passes again. CLI schema checks also cover
  queue recovery and refusal to execute an instruction in a shell. Status
  publication p95 was 252.502 ms over 26 controlled batches, measured from host
  receipt to snapshot enqueue, excluding model/network latency. An initial local
  integration invocation selected stale default binaries; the recorded passing
  run explicitly selects rebuilt verification binaries. No production regression
  or cross-platform result is inferred from that invocation.
- An isolated original Claude Code 2.1.304 launch used the existing repository
  cwd, launch-local MCP/instruction configuration and this task delivery API.
  Observed readiness preceded input; actual hooks correlated prompt reception
  and `settled`, and the provider emitted the requested literal response marker.
  Task result correctly remained null. No agent tools, source changes or trust/
  permission approvals occurred. Native run stop reached observed exit; the owned
  host exited zero, with all 21 observed descendants gone after a 296 ms bounded
  cleanup observation. An earlier immediate snapshot briefly saw asynchronous
  MCP shutdown; those processes subsequently exited too. This proves original
  Claude prompt/response correlation, not model consumption/use of MCP tools or
  complete multi-agent orchestration. Other provider/device gates remain open.
- No dependency, global provider setting or material UI change was added.
  Previous task-launch commit `a2836fa` passed all five CI jobs in `39359771560`,
  including Windows, macOS and Linux. New delivery platform CI is not claimed
  before it runs. See [task delivery contract](harness-task-delivery.md).

### F38 instruction V8: queued task delivery and safe cancellation

- V8 documents `runDelivery`, exact CLI/MCP queue and queued-only cancellation,
  immutable plan instruction/agent-only targets, null-receipt acceptance,
  current task history and authorized native receipt recovery. It explains
  bounded readiness waiting across client disconnect, one retained intent per
  attempt, human takeover/release pauses and non-replay after restart. Explicit
  results/validation still precede review. New launches receive V8; live snapshots
  and provider-global settings are not rewritten.
- Targeted offline case 9 compared one V8 sample with a frozen V7 snapshot.
  An ungraded canonical viewer preceded reading/grading outputs. Semantic review
  and programmatic command checks find V8 satisfies 6/6 expectations, V7 2/6.
  Both versions preserve conservative safety: V7 explicitly admits the new
  queue/cancel grammar and accounting are absent rather than inventing commands.
  Recovery/receipt authority and result validation are non-discriminating. The
  human/restart assertion is composite: V7 preserves human priority but lacks the
  new restart contract. Its formal failure is not a finding of unsafe behavior;
  future cases should separate those concerns.
- One sample per version is not statistical or actual-provider/model-tool proof.
  Earlier eight cases remain retained inputs, not claimed rerun. Notifications
  provided no duration/token/model metrics; those were omitted. Evaluation and
  canonical viewer outputs stay outside Git. User review is available through
  the saved artifact; the app queued its tab rather than confirming visibility.
- After rebuilding the native binaries with final V8 instructions, Windows fmt,
  Clippy with warnings denied, all 271 unit checks and eight controlled native
  SDK scenarios pass. The fixture verifies the injected V8 snapshot; it does not
  prove an original model read or used these new commands. The preceding original
  Claude prompt/response evidence used V7. No dependency or visual change.

### F14 opt-in deterministic native executor

- Added explicit `run executor start|get|disable|enable`, four MCP tools (48
  total) and `runExecutor` capability. Immutable agent profiles cover every task
  ID and deliberately choose shared checkout or worktree. Original providers
  keep native login/permission behavior; no host model client or dependency.
- Host journal/timers select dependency-ready tasks through atomic launch and
  queued-input adapters. Executor generation/provenance commit with native
  reservation. Only executor-admitted attempts receive automatic instructions;
  manual workers remain untouched. Independent accepted results still gate review.
- Retries default off. Explicit known-failure retry preserves attempt, parallel
  and elapsed budgets. Durable cooldown starts at first observed eligible failure,
  not old process creation; reads, clock regression and restart do not reset it.
  Unknown launches/input retain capacity/history and never receive a fresh key.
- Disable prevents new admissions; already committed startup/input may finish.
  Restart disables scheduling and invalidates generations, without adoption or
  replay. Human takeover/release, decisions, authority loss and run limits remain
  dispatch fences. Enable cannot rearm an existing delivery or revive a coordinator.
- Nine storage regressions cover scope/revision/policy, replay, transactional
  provenance rollback, generations, coalescing, admission/retention, corrupted
  storage, restart and failure-based cooldown. Twelve controlled official-SDK
  scenarios pass on Windows with real isolated PTYs; four added cases cover DAG
  escalation/validation, human pause, known/unknown retries and input redraw.
  They do not make model calls. CLI schema integration additionally checks exact
  executor replay, current state, disable/enable and no manual-worker adoption.
- An early original-Claude probe retained unknown partial input when Enter was
  refused; it was not resent. Admission now refreshes received PTY evidence before
  each write and briefly waits for fresh idle evidence after screen-only paste.
  A regression demonstrated that relying on the last status timer tick admitted
  Enter too early. The corrected native test waits for delayed redraw, sends once
  and refuses semantic working evidence even if idle returns later. Human and
  conversation/run guards remain in place throughout the bounded wait.
- Fresh original Claude Code 2.1.304 on an isolated host answered the literal
  prompt and its injected V8 instruction marker; a correlated native receipt
  settled. Its task result stayed null and dependent review stayed planned.
  Native run stop observed process exit; host exited zero and all 21 observed
  owned descendants ended within the bounded shutdown observation. This proves
  original prompt/response and instruction consumption, not model-driven tool use.
- Windows fmt, warnings-denied Clippy, all 280 unit checks and all 12 controlled
  native SDK scenarios pass after the final runtime changes. No visual/config
  change. Actual multi-provider model-to-MCP orchestration, delta-only coordinator
  wakes, manual checkpoints, job scheduling and complete recovery/mobile gates
  remain required. This checkpoint does not complete stage 3 or F01–F44.

### F38 instruction V9: opt-in executor and uncertainty boundaries

- New managed launches receive V9 with exact CLI/MCP executor grammar, complete
  task-profile file, strict agent/workspace choices and default/range guidance.
  It explains immutable specs, issuer/generation fences, current versus historical
  inspection, deliberate enable and retained unknown slots. Live snapshots and
  provider-global settings remain unchanged; no owner credentials are supplied.
- The instruction keeps manual workers untouched and refuses enable/new keys as
  a paused-delivery rearm or unknown-effect bypass. Disable means no new admission,
  not undo/kill; independent accepted result validation still precedes review.
  Host scheduling does not imply model heartbeats, scheduled jobs or native approval.
- Targeted offline case 10 compared one V9 sample with frozen V8. The canonical
  ungraded viewer was generated before reading/grading outputs. Semantic review
  plus programmatic command/profile checks found V9 8/8, V8 2/8. V8 conservatively
  states the new executor grammar/defaults are absent instead of inventing them;
  formal capability failures are not unsafe baseline behavior. Manual/human and
  validation/approval safeguards pass both versions. Recovery/retry assertions
  combine older safeguards and new semantics and should be split in future cases.
- One sample per version is not statistical, actual model tool-use or a replay
  of the previous nine cases. No duration/token/model accounting was supplied;
  unavailable metrics are omitted. Evaluation sources, answers, checks and the
  canonical viewer stay outside Git. The app queued the review tab, without
  confirming the user viewed it or supplied feedback.
- Fresh original Claude Code 2.1.304 answered its injected V9 marker and the unique
  literal response in an isolated executor-launched process. A real prompt-correlated
  receipt settled, while task result stayed null and review stayed planned. Native
  stop observed exit; host exited zero, with all 21 observed owned descendants gone
  in the bounded shutdown check. This proves instruction consumption and guarded
  original-provider input, not model-driven CLI/MCP orchestration. The controlled
  fixture separately verifies V9 injection; all 12 native SDK cases and 30
  host/sync/CLI integration checks pass. No dependency or visual change.

### F11/F12 original model tool intent and native permission gate

- An additional isolated original Claude Code 2.1.304 coordinator with V9 selected
  the actual Nesvo Create Session MCP tool, literal Claude worker spec and stable
  `native-model-child-once` key. The provider showed its native permission prompt
  before executing the tool. No child existed and no approval/fallback CLI was
  supplied. This is model tool-selection evidence, not a completed child launch.
- The prompt-correlated receipt became `waiting`, the turn reason was permission,
  agent state blocked and readiness waiting. No human controller lease was taken.
  Thus the blocker propagated through the original helper/host path, rather than
  being misreported as unknown, task failure or completion. The test then shut
  down its owned host; exit was zero and all 21 observed owned descendants ended.
- Full original model-to-MCP-to-visible-child acceptance remains open pending
  actual native permission handling; neither the fixture nor tool intent satisfies
  it. Global provider settings and user sessions were preserved. Do not silently
  allow tools or switch to another transport to evade the permission gate.

### Published executor verification checkpoint

- Published directly on the authorized existing `main`: `12bc547` fresh editor
  admission, `b0b9304` deterministic native executor and `35b498b` V9 instructions.
  All commits use Damian's author identity and contain no AI attribution.
- [CI 39367123182](https://github.com/dkveil/nesvo/actions/runs/39367123182)
  completed successfully for code head `35b498b`: Windows, Linux and macOS native
  jobs, app checks and browser checks (five jobs). Local checks also passed fmt,
  warnings-denied Clippy, 280 unit checks, 12 controlled native SDK scenarios,
  30 host/sync/CLI integration checks and repository formatting.
- Original-provider probes here ran on Windows only. The CI native jobs use
  controlled providers and do not establish real account/login/model behavior on
  other platforms. Completed model-driven child creation, remaining stage gates
  and F01–F44 delivery remain open; no overall completion is claimed.

### F26 opt-in coalesced coordinator notices

- Added `run wake enable|disable|get|batch`, four equivalent MCP tools (52
  total), `runWakes` capability and published schema. Wake policy/generation,
  exact notice bindings and native receipt reservation persist before input.
  Only coordinator-addressed result/decision/question/error and changed current
  worker attention produce notices; no body/correlation text enters the fixed
  native prompt. Quiet polling and identical wait states do not churn revisions.
- Up to eight references coalesce after 250 ms. Busy coordinators wait; human
  takeover/release, retained drafts, authority loss, run stop and elapsed budget
  fence input. The budget is checked again between paste and Enter. A partial
  write stays unknown and cannot be replayed by enable, a new key or relaxing
  policy. Reads, receipt settlement and restart never ACK or validate results.
- Native tests use isolated controlled programs, actual PTYs, the official MCP
  SDK and inherited scoped CLI. Three new cases prove busy-to-idle batching,
  unchanged-state silence, exact metadata/no implicit ACK, owner receipt privacy,
  quick human takeover fencing and time-budget refusal after paste. Six actual
  CLI/MCP response envelopes pass Ajv against the published contract. No real
  model behavior is inferred from these fixtures.
- Twelve dedicated storage cases cover replay/current state, scopes, canonical
  deduplication, exact batching, rollback, elapsed clock regression, real SQLite
  reopen, stale generations, clean exit without a result and retention refusal.
  The attention publisher separately tests ACKed durability and coalesced retry.
- Local Windows checks passed: fmt, warnings-denied Clippy, 295 unit checks,
  all 15 native SDK scenarios (serial), 30 host/sync/CLI integration checks,
  production build and repository formatting. Controlled status publication p95
  was 253.928 ms across 26 batches, excluding provider/model/network latency.
  No new dependency or visual change. Original-model wake handling, checkpoint
  compaction, full recovery and mobile controls remain open acceptance work;
  existing live V9 instruction snapshots remain unchanged.
