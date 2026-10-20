# Harness delivery

This checklist tracks the approved 44-feature harness contract. A checked feature
requires implementation, boundary tests and recorded evidence; partial work does
not count as delivered. Preserve the approved compact navigation and native host.

## Stages and dependencies

0. Inventory, reproduce status failures and measure an isolated host baseline.
1. Reliable status evidence and projections: F01â€“F08, F29, F32.
2. Shared host API, CLI and MCP: F09â€“F12, F16â€“F17, F37â€“F38.
3. Durable orchestration: F13â€“F15, F18â€“F20, F26, F40.
4. Host jobs and triggers: F21â€“F25, F27â€“F28, F44.
5. Navigation, review and environment: F30â€“F31, F33â€“F36.
6. Recovery and mobile: F41, F43.
7. Resource isolation and performance: F39, F42.

Status identity and readiness precede safe dispatch; durable receipts/events
precede orchestration and jobs; resume evidence precedes hibernation. Cross-cutting
foundations may land earlier, but feature gates still require their full tests.

## Feature inventory

Inventory at baseline `0c898c3` (2026-10-19). Existing behavior is a starting point,
not evidence that the expanded acceptance criteria pass.

| ID  | Feature                                         | Baseline                                                      | Delivery / tests / commits                                                                                                                                                                            |
| --- | ----------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | OSC 7501 parser and host query responder        | Missing                                                       | Partial: 0946401; live Windows negotiation gate open                                                                                                                                                  |
| F02 | Provider lifecycle adapters                     | Partial: Claude launch hooks; other providers screen hints    | Partial: Claude and Codex 0.156 native adapters; real provider matrix/Gemini pending                                                                                                                  |
| F03 | Status doctor and session explain               | Missing                                                       | Implemented diagnostics/version/correlation; provider matrix pending                                                                                                                                  |
| F04 | Versioned detection rules and screen corpus     | Partial: hard-coded current-screen rules                      | Partial: 3e851ba; wider provider corpus pending                                                                                                                                                       |
| F05 | Launch, conversation and event identity         | Partial: private launch report directory; wall-clock sequence | Partial: 173162e; Claude scoped journal; attempt identity in F17/F18                                                                                                                                  |
| F06 | Evidence freshness and last-known state         | Partial: short hook/screen grace                              | Partial: 7445eb3; freshness/disconnect policy pending                                                                                                                                                 |
| F07 | Starting, readiness and timeout                 | Missing                                                       | Implemented: readiness/timeout; platform/device matrix pending                                                                                                                                        |
| F08 | Process, agent, turn, task and unread semantics | Partial: process exit and attention separate                  | Partial: 6d80847; separate axes, completion unread pending                                                                                                                                            |
| F09 | Stable session CLI                              | Partial: TUI flags and list only                              | Partial: all native session commands implemented; coordinator/provider end-to-end gates pending                                                                                                       |
| F10 | MCP over host operations                        | Missing                                                       | Partial: native stdio SDK adapter and cancellation; effect/subscription/provider gates pending                                                                                                        |
| F11 | Visible child sessions                          | Missing                                                       | Partial: persisted lineage and original Claude metadata DAG/replacement verified; source-work/provider matrix pending                                                                                 |
| F12 | Scoped caller identity and agent instructions   | Missing                                                       | Partial: scoped identity, V11 instructions and native metadata DAG/recovery verified; source-work/UI/provider matrix pending                                                                          |
| F13 | Fan-out with explicit worktree ownership        | Partial: individual worktree launch                           | Partial: task launch with explicit shared/worktree mode, dirty-source preservation; ownership UI/setup/archive pending                                                                                |
| F14 | Durable run/task/attempt DAG                    | Missing                                                       | Partial: host executor and original Claude metadata DAG/replacement verified; production code, adoption and UI pending                                                                                |
| F15 | Durable inbox and ACK                           | Missing                                                       | Implemented core: durable messages/result context and exact native ACK across replacement; UI integration pending                                                                                     |
| F16 | Resumable bounded event subscriptions           | Missing: terminal replay is not domain event replay           | Partial: durable scoped journal/streams and CLI watch; receipt/result integration pending                                                                                                             |
| F17 | Receipts, idempotency and correlated wait       | Partial: request IDs, no durable receipts                     | Partial: shared create/send receipts and CLI/MCP correlated wait; job dispatch/provider coverage pending                                                                                              |
| F18 | Attempt-bound worker result                     | Missing                                                       | Partial: native Claude attempt results/validation verified; source checks and provider/UI matrix pending                                                                                              |
| F19 | Questions and decision gates                    | Missing                                                       | Partial: native Claude owner decision/recovery verified; timeout/cancel core tested; permission UI pending                                                                                            |
| F20 | Worker budgets, cancellation and drain          | Partial: fixed eight-session limit                            | Partial: retained/live/provider/run budgets and native control verified; scheduled dispatch/queue UI pending                                                                                          |
| F21 | Once and recurring host jobs                    | Partial: host-owned once schedules                            | Partial: durable once/cron/RRULE definitions, occurrences and CLI/MCP executor dispatch; UI and legacy migration pending                                                                              |
| F22 | Timezone, cron/RRULE and DST                    | Missing                                                       | Partial: IANA calendars (Warsaw default), gap skip/first fold, UTC COUNT/UNTIL and bounded helper; general dense RRULE seek and UI pending                                                            |
| F23 | Missed-run policy and grace window              | Missing                                                       | Partial: skip/catch-up with grace and latest-slot recurring coalescing; original-model and interactive job UI acceptance pending                                                                      |
| F24 | Safe fresh/reuse session dispatch               | Partial: fresh launch with prompt                             | Partial: guarded fresh task workers and immutable profiles; safe reuse pending                                                                                                                        |
| F25 | Bounded precheck                                | Missing                                                       | Partial: explicit owner command approval, bounded scopes, retained skip/failure/uncertainty and CLI/MCP; job UI/native-provider matrix pending                                                        |
| F26 | Delta-only coordinator wakeups                  | Missing                                                       | Partial: opt-in durable coalescing/native receipt and human/budget fences; original-model/checkpoint/UI gates pending                                                                                 |
| F27 | Authenticated webhook and GitHub triggers       | Missing                                                       | Partial: signed loopback HTTP, durable admission, GitHub adapter and owner CLI/MCP implemented; native Windows fixtures pass; publication/platform and external-account deployment gates separate     |
| F28 | Durable job attempts, retry and overlap         | Partial: schedule result field                                | Partial: history, no-effect retry, overlap, cancellation, execution timeouts and owner no-effect launch resolution; broader retry, uncertain effects, cleanup and job UI pending                      |
| F29 | Shared needs-you and group rollups              | Partial: attention and shared snapshot                        | Implemented canonical projections/rollups; device matrix pending                                                                                                                                      |
| F30 | Stable attention/unread/MRU ranking             | Partial: palette and attention navigation                     | Pending                                                                                                                                                                                               |
| F31 | Contextual fuzzy search                         | Partial: session/group/command search                         | Pending                                                                                                                                                                                               |
| F32 | Incremental preview and process/turn times      | Partial: bounded replay and monotonic process age             | Implemented distinct process/turn times and bounded passive read; device matrix pending                                                                                                               |
| F33 | Revision-bound diff feedback                    | Missing                                                       | Pending                                                                                                                                                                                               |
| F34 | Verified session/turn edit provenance           | Partial: agent edit folder context only                       | Pending                                                                                                                                                                                               |
| F35 | Revision-bound checks and review readiness      | Missing                                                       | Pending                                                                                                                                                                                               |
| F36 | Trusted worktree setup/run/archive              | Partial: create worktree only                                 | Pending                                                                                                                                                                                               |
| F37 | Provider-aware launch profiles                  | Partial: templates                                            | Partial: model/effort, owner policy and task native-tool subsets; broader config/skills/UI/resume pending                                                                                             |
| F38 | Session-scoped MCP and skills                   | Missing                                                       | Partial: opt-in Claude instruction/MCP, task subsets and effective config; external MCP/skills/resume pending                                                                                         |
| F39 | Isolated safe MCP pooling                       | Missing                                                       | Pending: ownership and cancellation cleanup prerequisites checked; MCP pooling not implemented                                                                                                        |
| F40 | Durable goal/progress checkpoint                | Missing                                                       | Partial: native Claude compaction/recovery, saved owner constraints and coordinator replacement verified; native resume/adoption/UI pending                                                           |
| F41 | Layout, conversation and workflow recovery      | Partial: saved launch recovery records                        | Partial: native metadata recovery and Windows process ownership verified; conversation/layout/mobile recovery pending                                                                                 |
| F42 | Safe resumable hibernation                      | Missing                                                       | Pending: process ownership/cleanup prerequisite verified; resume eligibility and hibernation not implemented                                                                                          |
| F43 | Mobile fleet, decisions and jobs                | Partial: existing mobile sessions/control                     | Pending                                                                                                                                                                                               |
| F44 | Trustworthy quota-aware dispatch                | Partial: usage cache and quota wake                           | Partial: typed observations, configured-account job admission, retained native launch and durable one-shot session continuation; Claude/Gemini admission and original-provider acceptance remain open |

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
- Isolated real Claude 2.1.303, without a model prompt: `unknown â†’ working â†’
unknown` by 2.3 s. Output included a folder-trust screen and OSC 7501 probe.
  The baseline neither classifies this blocker nor answers that probe. A trust
  screen is not evidence that lifecycle hooks have loaded; root cause of the
  user's already-trusted conversations still needs verification.
- Idle baseline: eight real PowerShell PTYs, no clients, 60.41 s observation,
  host CPU 0.129% of one logical core, working set 16.65 â†’ 16.60 MB, 17 immediate
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
  confirmed working â†’ confirmed idle, with no intermediate idle. Expected reply
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
  `Uruchamianie`/`BĹ‚Ä…d startu` without changing layout. `session explain` carries
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
  no model requests; median wall time 16.71 â†’ 14.59 ms, p95 23.12 â†’ 15.15 ms.
  These include process creation, are local diagnostic samples, and do not explain
  or certify a fix for the user's historical CPU spike. Reproduce using
  `python tests/hook-helper-benchmark.py target/verification/debug/nesvo-host.exe`.
- Actual Windows ConPTY smoke passed on isolated data: onboarding, shell input,
  focus/menu, palette, filters, live/expanded diff, launch settings, recovery,
  150Ă—44 / 100Ă—32 / 80Ă—24 resize and clean terminal exit. Captures are ignored
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
  no gap, readiness starting â†’ trust waiting â†’ MCP waiting â†’ ready, then one
  short working â†’ Stop/idle turn with normal cleanup. No intermediate idle was
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
  and Clippy pass; existing render/focus checks cover 80Ă—24, 100Ă—32 and 150Ă—44.

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
  menu focus, diff/review, search, filters, launch dialogs, 150Ă—44/100Ă—32/80Ă—24,
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
  (150Ă—44, 100Ă—32, 80Ă—24), resize and clean terminal restoration.

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
- Official SDK/native MCP tests verify send â†’ CLI same-key replay â†’ delivered
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
  no resurrection. SDK-to-MCP â†’ CLI child replay creates only once. A TUI model
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
  remain required. This checkpoint does not complete stage 3 or F01â€“F44.

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
  and F01â€“F44 delivery remain open; no overall completion is claimed.

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

### F38 instruction V10: wake recovery and bundled control reference

- New launches receive exact wake enable/disable/get/batch CLI/MCP grammar,
  current-versus-historical policy recovery, reference-only input and distinct
  native/inbox cursors. Instructions distinguish first delivery of never-claimed
  backlog from prohibited replay of claimed/failed/unknown batches. No wake
  settlement, ACK or idle state validates a task or approves native permission.
- The core skill has 476 lines. Run budget/drain/control rules moved unchanged
  into a linked reference, copied per launch. Native system-prompt injection
  includes both core and reference up front; no extra file-read permission is
  needed to obtain these safety rules. Existing live snapshots stay untouched.
  Unit checks verify literal argv, complete private copies and owned-file-only
  cleanup. A replaced reference-directory symlink is never followed for cleanup;
  a dedicated Unix regression is included for CI, without claiming a local
  Windows native symlink test.
- Offline iteration 10 compared one V10 and frozen V9 sample for wake recovery:
  8/8 versus 2/8 assertions. V9 conservatively admits the new wake contract is
  absent rather than inventing it; those capability failures do not imply unsafe
  behavior. A second paired native-control regression read the moved reference
  and passed 5/5 for both versions. The other nine cases were retained, not rerun.
  Canonical ungraded views preceded output review/grading; the app queued the
  viewer, without claiming human visibility or feedback. No token/time/model
  accounting was supplied, so none was estimated. Composite capability checks
  and shared non-discriminating safety checks are documented in the evaluation.
- Fresh original Claude Code 2.1.304 returned the injected V10 marker, a unique
  literal response and the bundled reference title without file/tool use or
  approval. Its actual prompt-correlated native receipt settled, while task result
  remained null and dependent review planned. Native run stop observed exit;
  the isolated host exited zero and all 21 observed owned descendants ended
  (390 ms bounded cleanup check). This proves instruction/reference consumption,
  not original-model handling of a wake or completed model-to-MCP orchestration.
- Local Windows checks passed fmt, warnings-denied Clippy, 295 unit checks,
  all 15 controlled native SDK scenarios, 30 host/sync/CLI integration checks,
  production build and repository formatting. No dependency or visual change;
  full original-provider matrix, checkpoint recovery, mobile controls and remaining
  F01â€“F44/plugin gates stay open.

### F26 canonical native blocker verification and CLI parity

- A fourth controlled native wake scenario uses the worker's actual inherited
  CLI to ask an owner-only decision and its lifecycle helper to publish a
  question. The live session's canonical attention and the durable wake reference
  agree on the current worker/attempt and question reason. An explicit owner
  metadata answer leads to a reported result and canonical blocker resolution;
  these references coalesce while the coordinator is busy. A later wake leaves
  both coordinator messages pending and the task unvalidated. No provider-native
  permission is answered and no model is called by this fixture.
- Actual policy/batch/inbox envelopes containing decision, blocker, resolution
  and result references pass the published Ajv schema. CLI enable/disable replay
  now explicitly recovers the same MCP acceptance with original keys/revisions,
  without another policy generation or native input.
- Published wake implementation `7bda3ea` passed all five jobs in
  [CI 39372002388](https://github.com/dkveil/nesvo/actions/runs/39372002388), including
  the complete controlled native suite on Windows, Linux and macOS. Those checks
  do not establish original-provider model orchestration on these platforms.
  Local V10 verification additionally passed all 15 preceding native cases;
  the four-case wake subset, including the added canonical scenario and CLI
  parity assertions, passed together. Instruction V10 head `a9c9308` has its own
  CI run; inspect its actual conclusion before claiming it passed.

### F40 immutable checkpoints, current context and manual constraints

- Added checkpoint save/list/get/context and constraint add/list/acknowledge
  through the shared host writer, CLI and seven MCP tools (59 total). A snapshot
  records source run revision/journal cursor and bounded goal, constraint, plan,
  attempt/validation/decision and native-uncertainty references. Notes and worker
  reports never become accepted progress without actual validation. Reads do not
  launch, send, ACK, adopt or replay any native effect.
- Historical snapshots stay immutable. Current context always uses latest owner
  text/state, even with an older baseline; digest-checked pagination prevents
  mixed live versions. Saved parts use indexed reads with at most eight records /
  24 KiB per page. Limits explicitly refuse capacity without discarding history.
- Only owner may append manual text. An addition atomically pauses executor/wake
  generations and unclaimed deliveries. Exact-revision handling acknowledgement
  grants no native authority and never rearms old input. Native send acceptance
  freezes its admitted context revision in the same transaction; both paste and
  Enter recheck it, including ordinary run-bound follow-ups. Fresh task delivery
  includes all current constraints within the existing 8192-byte prompt bound.
- Ten storage cases cover exact replay/current-state separation, scopes, partial
  write/rearm fences, caller-note versus validation, real SQLite reopen, digest
  pagination, transaction rollback (including policy pause), capacity and long
  byte-bounded parts. Two official-SDK scenarios exercise actual scoped CLI/MCP,
  real host/PTY, silent context reads, owner-only text, current worker context,
  retained context after coordinator exit and a constraint arriving after paste
  but before Enter. ACK/new keys cannot submit that retained draft. Real response
  envelopes pass Ajv against the published contract.
- Local Windows checks passed fmt, warnings-denied Clippy, 305 unit checks,
  production build, all 18 serial controlled native SDK scenarios, 30 host/sync/CLI
  integration checks and repository formatting. Original
  provider compaction/context consumption, conversation adoption, constraint
  editing/retention management and mobile/UI still need acceptance work; F40 is
  partial and the full 44-feature/plugin goal stays open. Existing V10 instruction
  snapshots are not silently reconfigured; new instruction grammar is a separate
  delivery step. No dependency or material visual change.
- Earlier heads 7bda3ea, a9c9308 and 8ac715a all completed their five CI jobs
  successfully (39372002388, 39372778660 and 39373234715). These include controlled
  native suites on Windows/Linux/macOS, app and browser checks. Real provider
  behavior was only probed locally on Windows; no wider account/device coverage
  is inferred from CI.

### Instruction V11: current context and constraint recovery

- F12/F40: root instruction remains below 500 lines (486). A linked reference
  specifies checkpoint capture/current reconstruction, strict CLI/MCP grammar,
  pagination/digest restart, append-only owner constraints and exact handling ACK.
  It explicitly preserves current rules, native uncertainty, receipt authority,
  budgets and independent validation. New launches privately bundle both named
  references up front; old live instruction snapshots stay unchanged. Named-file
  cleanup preserves unowned content and refuses replaced reference directories.
- One offline paired case: V11 meets 8/8 new-contract assertions; frozen V10
  conservatively admits the missing API (0/8), preserving existing draft/role/
  validation safeguards. This measures contract availability in one sample, not
  comparative safety or statistical reliability. Eleven prior cases are retained,
  not rerun. Canonical ungraded viewer preceded inline semantic/programmatic
  grading; completion cost/timing was unavailable and omitted.
- An isolated original Claude 2.1.304 response returned V11, the context reference
  heading and the exact owner-only context code. No tools, reports, file edits or
  native approvals were requested. Task stayed assigned/result null; review stayed
  planned. Native receipt stayed delivered despite UserPromptSubmit/Stop; do not
  claim settlement from output. This discrepancy remains under investigation.
  Explicit run stop observed worker exit, host exited zero, and all 21 observed
  owned descendants disappeared (297 ms cleanup check). No user host/config was
  changed. Provider compaction/resume and model-to-MCP child creation remain open.
- Local checks passed warnings-denied Clippy, fmt, 305 unit tests, production
  build, all 18 serial native SDK cases and 30 host/sync/CLI checks. Private-bundle
  tests also passed after extending cleanup coverage to both reference names;
  Unix symlink behavior awaits this commit's CI. Repository formatting passed.

### Windows argument parsing boundary

- F09/F17: native `session wait` intermittently exited with Windows stack-overflow
  code `0xc00000fd` instead of timeout JSON/exit 7. An isolated original-provider
  probe also received empty CLI output; its owned host exited zero and all 19
  observed descendants disappeared, so no completion evidence was claimed.
- Local debug assembly measured the generated workflow command augmentation at
  518776 stack bytes, before parent/nested grammar frames. Parsing now runs on
  a joined, short-lived 4 MiB thread before host/terminal activity. Global linker,
  runtime worker stacks and command/JSON semantics stay unchanged.
- A 512 KiB caller-stack regression exercises full and nested help plus wait
  parsing without I/O. The real native timeout/fast-response scenario passed
  again with expected JSON/exit code; fmt and warnings-denied Clippy passed.
  This does not claim that every possible stack/resource failure is eliminated.
- Both preceding commits completed all five CI jobs: 645d7b1 (39376016534),
  61d1b27 (39376742750). Controlled native tests passed Windows/Linux/macOS;
  account/model/device coverage is still reported separately.

### Claude whole-paste receipt correlation

- F02/F03/F17/F40: an original Claude 2.1.304 task with owner constraints returned
  a response while its receipt stayed delivered. A second isolated probe compared
  private hashes and only its exact owned conversation: the hook/transcript had
  a complete pasted-content envelope; its exact inner body matched native input.
  Only the synthetic probe prompt and its owned conversation were sampled;
  credentials and unrelated conversations were excluded.
- The Claude adapter retains the raw digest and a separate bounded complete-
  envelope body digest. Exact raw matches win. Malformed/mismatched/inline tags,
  extra surrounding content, unsupported IDs, oversized bodies and control bytes
  gain no alternate match. One outer layer only; literal inner content survives.
  No sent input or global provider configuration is rewritten. Optional journal
  columns preserve raw-only legacy launches without live schema migration.
- Receipts retain the matched method. Read-only session diagnostics distinguish
  awaiting pickup from a mismatched prompt by sequence/boolean, exposing neither
  hash nor content. Old/foreign/generation events and unrelated Stop still cannot
  settle input. Received/settled is never accepted task success.
- Four new unit regressions cover parsing/bounds/nesting, exact versus wrapped
  pickup, private helper fingerprints and legacy journal compatibility. The real
  SDK checkpoint scenario now delivers the full immutable instruction plus owner
  constraints through the native PTY, settles the correct receipt and preserves
  result null/review planned. Controlled Claude fixture payloads model the observed
  envelope while native bytes remain literal.
- A fresh sequential original-Claude probe after the parser fix returned V11,
  the bundled reference heading and owner context code; its exact receipt reached
  settled with `claudePasteWrapper`. Explicit run stop observed exit; host exited
  zero and all 21 observed owned descendants were gone (282 ms cleanup check).
  No tools, reports, edits or native approval were requested. An earlier attempt
  hit the documented empty-output parser failure and remains failed evidence.
  Provider compaction/resume, model-to-MCP child creation and remaining full-goal
  acceptance gates are still open; this response does not substitute for them.
- Final local Windows checks passed fmt, warnings-denied Clippy, production
  build, 310 unit checks, all 18 serial native SDK scenarios, 30 host/sync/CLI
  checks and formatting. After labeling the adapter `claude-hooks-v3` and covering
  a maximum-size wrapped body, helper and native checkpoint/receipt checks passed
  again. No new dependency, global database migration or material UI change.
  CI for dd4e57c was still running when recorded; this commit's CI is separate.

### Authenticated recovery bindings

- F12/F40: `run recover [RUN_ID]` and `nesvo_recover_run_context` use the same
  scoped host lookup and current manifest. Workers receive only their current
  attempt/constraints; owner needs an explicit run ID. A coordinator's single
  retained run resolves without UI hints. Multiple retained runs require selection
  from bounded authorized choices; completed/canceled history stays discoverable.
  No title/newest-run guessing, permission escalation or native adoption occurs.
- Current pages retain exact returned offsets/digest fences. Reads never ACK
  constraints/messages, validate reports, reenable policies, clear drafts or write
  operation receipts. Unbound workers are explicit; stale attempts remain refused.
  `runRecovery` gates the new API and the catalog contains 60 tools. The contract
  and actual JSON envelope shapes are versioned with the implementation.
- Four storage cases cover authority, unbound/unique/ambiguous lookup, bounded
  choices, completed history, current worker constraints, unchanged cursors/effect
  counts and changed-context pagination. The official native SDK scenario checks
  inherited CLI/MCP parity, worker isolation, owner selection and ambiguity on real
  host/PTYs; real response envelopes pass Ajv. Native reads preserve PTY contents.
- Local Windows checks passed fmt, warnings-denied Clippy, production build,
  314 unit tests, all 18 serial controlled native SDK cases and 30 host/sync/CLI
  integration cases. After keeping completed runs in default discovery, storage
  tests/full units/build and the scoped native scenario passed again. No new
  dependency, model call, global provider setting or material UI change.
- CI for a3c5c21 passed all five jobs (39378350943). Earlier dd4e57c CI
  39377999746 failed a Windows host-challenge timeout in the wrong-secret test;
  its native CLI timeout case passed. The successor passed the same suite, but
  that timeout is retained as a coverage/flakiness observation, not erased.
- This supplies the binding lookup required by bounded provider recovery hooks;
  it does not inject context on native compaction/resume yet. Instruction V11 and
  old live snapshots stay unchanged. Actual provider compaction/adoption, the
  model-to-MCP permission gate and all remaining full-goal/plugin work stay open.

### Launch-local native context recovery

- F12/F38/F40: supported opt-in Claude harness launches append a bounded native
  `SessionStart` recovery hook beside the existing lifecycle hook in one inline
  settings object (`claude-hooks-v4`). It uses the configured executable and exact
  private scope as literal arguments. Plain Claude/Codex and global settings stay
  unchanged; instruction V11 and previous live snapshots are retained.
- Root startup/resume/clear/compact reads current authenticated context; children,
  fork and unrelated events do no host I/O. Coordinator manifests collect every
  current page with digest/offset fences and at most one changed-context restart.
  Worker context remains isolated. Neither path replays input, ACKs, enables
  policies, validates reports, adopts processes or requests a model turn.
- Input is bounded to 2 MiB; a 2.2 second overall deadline also exits when stdin
  EOF is withheld. Context has 32-page/64-KiB bounds and a 9,500 UTF-16-unit inline
  ceiling beneath Claude's documented 10,000-character file spill. Oversized or
  unavailable context returns fixed guidance, never a silently incomplete plan.
  Explicit selection is required for ambiguous bindings.
- Bounded launch-private diagnostics distinguish prepared/unbound/selection/
  unavailable, missing, malformed and unreadable. Prepared never claims model
  consumption (`loaded:null`). Existing lifecycle I/O observes a stable update
  time without rendering I/O, repeated state dirties or LLM heartbeats. A real
  provider probe exposed different host/hook TEMP roots; report writing now uses
  the exact private context location rather than ambient TEMP equality.
- Six unit regressions and a real native SDK scenario cover collection, provider
  framing, role isolation, literal Unicode/spaced executable paths, changed temp
  roots, absence of PTY/revision/policy effects, ambiguity, oversized context,
  scoped authentication and unclosed stdin. Controlled fixtures are not models.
- Original Claude 2.1.304 on Windows returned a fresh host-only owner code after
  actual `/compact`, verified in the exact owned assistant transcript. The hook
  reported constraint revision two, while run revision/task planned/pending
  constraints stayed unchanged. No tools, files, reports or approvals were used.
  Native exit was observed; host/bridge exited zero and all 34 observed owned
  descendants were gone. Earlier failed probes (temp-root diagnostics and a test
  bridge startup redraw) are retained rather than presented as successes.
- Larger context retrieval by a model, native resume/clear matrix, replacement
  coordinator recovery and the actual model-to-MCP child permission gate remain
  open. This is not full F40/F41 completion. No new dependency or material UI
  change. Previous fcedbc5 CI passed all five jobs (39380036529).
- Final local Windows verification passed fmt, warnings-denied Clippy, production
  build, 320 unit checks, all 19 serial native SDK scenarios, 30 host/sync/CLI
  cases and formatting. The new native scenario passed again with an explicit
  changed temp root. This commit's cross-platform CI remains separate evidence.

### Explicit owner native tool permission additions

- F12/F37/F38: `sessionToolPermissions` adds owner-only create spec
  `allowedNesvoTools` and CLI `--allow-nesvo-tool` (repeat, explicit `--harness`).
  At most 32 unique exact published Nesvo tool names; no wildcard, foreign MCP
  namespace, arbitrary native rule or permission-mode switch. Default launches
  add none. Older hosts fail the capability check before relying on this field.
- A supported Claude process receives exact `mcp__nesvo__TOOL` allow additions
  beside lifecycle/recovery hooks in the same inline settings. Provider deny/ask
  rules still apply. These additions neither restrict all other tools nor grant
  new host roles, workspace scope or run authority. No global settings change.
- Scoped callers cannot grant additions to children, even via an empty list.
  Ordinary children may inherit the harness but never these additions. Saved
  process recovery omits them; replacement needs a deliberate owner launch.
  Explicit owner-authored job/template intent is separate. Effective configured
  additions are exposed in get/explain/snapshots; loaded stays null. Existing live
  processes and instruction V11 remain unchanged.
- A public exact tool-name contract is tested against all 60 actual MCP tools.
  Native official SDK/CLI cases verify captured provider settings, child
  inheritance, passive-worker host refusal, validation, repeated original key
  and changed-policy conflict against isolated real host/PTYs. Fixtures are not
  models. Legacy default launch serialization/idempotency stays unchanged.
- Local Windows checks passed production build, fmt, warnings-denied Clippy,
  321 unit tests, 20 serial native SDK cases, 30 host/sync/CLI cases and formatting.
  The previous recovery commit 5b3d01b passed all five CI jobs (39384288622).
- Original-model child creation remains pending the exact isolated native-policy
  choice requested from the owner. A guarded probe is prepared outside the repo;
  it has not run or approved a native prompt. No CLI transport fallback or broad
  allow is substituted. General task/profile permission delegation, external
  MCP/skills, model/effort settings and controlled resume remain F37/F38 work.

### Original Claude creates one visible child through native MCP

- After explicit owner approval of the recommended exact create-tool addition,
  original Claude 2.1.304 on Windows invoked
  `mcp__nesvo__nesvo_create_session` exactly once with the requested stable key.
  The original transcript contained its matching tool result and the assistant
  returned the same child ID verified by the authenticated host.
- The passive shell child had the coordinator's parentSessionId, worker role and
  no controller. Host budget allowed two sessions/one worker. The child received
  no prompt; no other tool, CLI transport fallback, native approval key, source
  edit or global configuration change was used. The initial send settled.
- The owned host exited zero and all 23 observed descendants were gone. This
  closes the narrow original-model F11/F12 child-creation gate for that exact
  provider/version/policy. Multi-worker implementation/review, inherited task
  tool policy, provider parity and the remaining stage gates are still open.
- Published 88943b0 CI passed all five jobs (39386643756), separately from this
  original-model test. Earlier permission-gated failures remain recorded above.

### Single upgraded host owns its data directory

- F41 prerequisite for safe orchestration recovery: a nonblocking exclusive OS
  file lock is acquired before reading/rotating keys, rewriting pairing or opening
  metadata. It stays alive through the single writer's drain/error paths.
- The native Windows test refused a second host on another port using
  `--rotate-key`, preserved pairing and proved the first host still reachable.
  Terminating only the test's empty host released ownership; restart used the same
  key with an existing lock filename. The unit case also verifies live exclusion
  and drop/reacquire. No user host/session was stopped.
- Uses existing windows-sys with filesystem/I/O features and adds Unix libc as a
  direct dependency for flock (already locked transitively), preserving Rust 1.88.
  CI must separately verify Unix runtime behavior. Older binaries that never take
  the lock are not fenced; acquiring a directory is not proof old workers exited.
  See [ownership and upgrade limits](host-directory-ownership.md).

### Explicit owner coordinator metadata recovery

- F15/F40/F41 prerequisite for the stage-three coordinator-restart gate:
  `runCoordinatorRecovery`, CLI `run bind-coordinator` and owner-only MCP
  `nesvo_rebind_run_coordinator` bind retained run metadata to a different live
  native coordinator. Source ID (explicit null for unbound), stable mutation key
  and current revision are required. Same canonical workspace/group evidence
  comes from a retained session, saved launch context or previous binding.
- One transaction changes run coordinator/revision/generation, invalidates and
  pauses executor/wake generations and pauses queued input. Earlier native input
  keeps its acceptance generation and is fenced before paste/Enter. No ACK,
  result validation, input replay, worker/process adoption, policy enable or
  budget reset occurs. A human lease/draft on the target stays intact.
- Additive binding table and idempotent input-generation migration retain old
  data. Missing/malformed source evidence is refused; an absent host session does
  not claim physical process exit. Immutable key replay cannot undo a newer
  binding. Native uncertainty/slots remain unreconciled, and old worker terminal
  grants are not transferred. Downgrading bypasses the new fence and is not a
  supported mixed-host recovery mode. See the
  [contract, CLI/MCP examples and limits](harness-coordinator-recovery.md).
- Five storage regressions cover authority, migration, source evidence, replay,
  constraints/inbox/budget preservation and old pump/input generations. Three
  native official SDK/CLI cases verify live/stale/wrong-workspace refusals,
  preserved target human draft, retained questions/results, actual host restart,
  pending owner rules and an actual partial-paste/Enter fence. Real envelopes
  pass Ajv; these providers are deterministic fixtures, not original models.
- Local Windows verification passed fmt, warnings-denied Clippy, production
  build, 327 unit tests and 30 host/sync/CLI cases. Twenty-three native suite cases
  passed; the catalog compatibility case then passed after correcting all three
  stale count assertions for the added 61st tool. Original failed runs are retained.
  Final formatting, Clippy and all five storage cases including malformed-record
  refusal also passed. No new UI/global setting/dependency is
  introduced by coordinator binding; directory ownership landed as ff56427.
- Full conversation resume, deliberate worker adoption, unknown-effect owner
  reconciliation, provider orchestration and UI/mobile gates remain open. This
  metadata operation does not complete F40/F41 or the full 44-feature goal.

### Coordinator restart CI readiness correction

- 782e3b1 CI (39391343352) passed the app/browser jobs and the native OS-lock
  cases, but macOS/Linux each failed the replacement-coordinator scenario. The
  test created an immutable harness intent immediately after listener startup,
  before the asynchronous provider-version probe completed; the host correctly
  refused unsupported/unconfirmed harness setup without native effects.
- The replacement helper now observes doctor provider readiness before creating
  its intent, including after restart. It uses bounded polling of actual state,
  not a fixed delay or a fresh-key retry of a failed intent. Local targeted checks
  and successor CI are recorded separately; the failed run remains evidence.
- Corrected the documented workflow-mutation recovery spelling to `run mutation
--key KEY --json`.

### Native human-control helper acknowledgement boundary

- Earlier 782e3b1 Windows CI also failed a quick human-wake case with an unqualified
  deadline. Successor 2e71036 CI (39392682133) passed app/browser/macOS/Linux, but
  Windows failed a different human-delivery case with the same unqualified error.
  Its coordinator-restart scenarios passed. These failures remain recorded; the
  original timeout phase was not proven.
- The owned human helper now waits for a host control event confirming release
  (or an already observed revocation) before exiting. It no longer relies on a
  Node WebSocket close handshake to end the helper process. Acquisition/release
  have explicit bounded failure messages; wake mutation/provider/human deadlines
  gain phase labels. No host policy, native session, lease rule or timeout limit
  was relaxed, and no fixture error is treated as success.
- Targeted native wake and queued-delivery cases passed locally. The shared-helper
  native suite and successor CI remain separate required checks.

### Versioned launch-local model and effort selection

- F37: session CLI/MCP create, task launch and immutable executor profiles accept
  explicit model/effort. Native adapters require probed Claude 2.1.303+ within
  2.1 or Codex 0.156.0. Shell/Gemini/unconfirmed versions refuse these fields;
  ordinary default launches and prior fingerprints stay unchanged.
- Arguments remain literal, before prompt delimiters. Codex uses a fixed quoted
  model_reasoning_effort config entry beside lifecycle hooks. Effort requires an
  explicit model, avoiding accidental paired new-thread default changes. Claude
  accepts its verified levels; Codex uses bounded model-advertised identifiers.
  Provider account/model support still belongs to the original CLI.
- `sessionModelProfiles` gates new clients against old hosts; get/list/explain
  show requested selection and resolved:null rather than claiming a model result.
  Doctor/capabilities expose versioned adapter support. Managed children use their
  own native defaults when fields are absent; tasks/executor keep explicit values.
  Saved template/recovery selection survives without input or auto restart.
- Storage/argument and actual encoded-capability contracts pass. The official
  native SDK/CLI scenario captures real executable argv, Unicode/spaces/literal
  shell text, Codex config/hook coexistence, child defaults, task profiles,
  immutable replay/conflict and invalid-value refusals. Real session/doctor and
  workflow envelopes pass Ajv against the expanded schema. Fixtures make no
  model requests. See [profiles, sources and limits](harness-model-profiles.md).
- Original Claude 2.1.304 Windows startup with opus/low reached ready/idle and
  exposed both native flags; no prompt, child or approval key was submitted.
  Host exited zero. Three of 30 observed descendants outlasted the initial
  five-second cleanup window; the same IDs were absent in a follow-up 142 seconds
  later, without relaunch/killing. Exact exit latency is unknown. The failed
  bounded cleanup observation remains open F39/F42 evidence, not a passed gate.
- Full model responses/resolved telemetry, broader profile/MCP/skill editing,
  owner task permission delegation, controlled resume and UI still remain open.
  No dependency, material UI or global provider configuration change.
- Final local Windows checks passed production build, fmt, warnings-denied
  Clippy, 329 unit tests, all 25 serial native SDK scenarios (including the new
  human-ACK helper), 30 host/sync/CLI cases, JSON envelope validation and formatting.
  Cross-platform CI for this head is separate from these local results.

### Owner-declared direct-child native tool policy

- F12/F19/F37/F38: `childToolPolicy`, CLI `--allow-child-nesvo-tool` and owner
  `spec.childAllowedNesvoTools` declare a separate immutable coordinator policy.
  Up to 32 unique exact catalog names. Default behavior and parent own-list
  noninheritance remain unchanged; ordinary children cannot set either field,
  including empty lists. No new tool, dependency or instruction version.
- The native authority adapter derives a grant only for authenticated supported
  Claude harness children and host task dispatch under that coordinator. Parent
  metadata alone, another coordinator, harness opt-out and other programs cannot
  select it. Child policy is not recursive and grants no worker host role. The
  coordinator's own native additions stay separate. Provider deny/ask rules and
  human/workspace/attempt guards continue to apply.
- Get/list/explain expose declared child policy, exact native allow/source and
  originSessionId. Process recovery omits both addition fields; a new owner
  launch must select policy deliberately. Task-profile subsets, general MCP/skill
  profiles, broader permission UI/resume and the original-model orchestration
  gate remain open. See [contract and examples](harness-child-tool-policy.md).
- Official SDK/CLI coverage inspects actual inline settings, independent
  coordinators, opt-out/shell behavior, parent-metadata refusal, task dispatch,
  worker refusal despite native allow and raw authenticated recovery metadata.
  Model/effort persistence is verified through that same unprojected native read.
  The first recovery-probe wrapper failed CommonJS top-level await; it now uses
  an explicit async entrypoint. Both targeted native scenarios pass; no model
  calls or global configuration changes were used.
- Published model-profile/helper head 2708c4f passed all five CI jobs
  (39394840185), including Windows's previously failing human-control scenarios.
  Earlier failed CI runs remain recorded rather than retroactively called green.
- Final local Windows checks passed fmt, warnings-denied Clippy, production
  build, 330 unit tests, all 26 serial native SDK scenarios and 30 host/sync/CLI
  checks. Raw recovery/model-policy scenarios pass the expanded JSON contract.
  Formatting and successor CI are checked separately; original-model use of this
  broader child policy remains unapproved and unrun.

### Original-provider recovery acceptance preparation

- Published child-policy head cd26ebf passed all five CI jobs (39398486223):
  native Windows/macOS/Linux suites, app checks and browser synchronization.
- A [bounded metadata-only original-provider scenario](harness-native-recovery-probe.md)
  is prepared for two sequential coordinators and two workers. It combines a
  retained owner question, coordinator replacement, exact worker result,
  addressed reviewer context and native MCP evidence. No model run is implied
  by preparation; the earlier single passive-child approval has been consumed.
- The private evidence correlator accepts a matching actual call/result and
  refuses absent/errored/foreign results, wrong attempts and duplicate mutations.
  Prepared prompts use the actual validation schema and require a nonempty
  metadata-check attestation, without claiming source/test validation.
- This scenario and stage-three production completion remain separate. The
  run/tool scope must be explicitly approved before original-model launch.

### Owned Windows descendant lifetime

- F39/F42 prerequisite: a private handle-owned Windows job now contains normal
  descendants spawned after native root enrollment. Explicit stop and natural
  root exit request that job's termination; host death closes its private job
  handles. Another session keeps its independent job. No PID/name tree killing,
  provider permissions or Unix behavior changed.
- A real ConPTY test starts Rust root/child/grandchild helpers and an independent
  session, pins creation-validated handles, and verifies both stop and natural
  exit without leaving those descendants. No Node/model or shell is required.
  Targeted Windows test passes; full native suites/CI follow separately.
- Post-spawn enrollment has a known early-descendant race and does not claim
  WMI/brokered processes. See [ownership and boundaries](windows-process-ownership.md).
  This is a resource prerequisite, not completed pooling or hibernation.
- The separately approved original-model recovery probe failed in its controller
  before the first prompt: it treated string lifecycle `blockReason` as an object.
  One coordinator had started, no run/worker/model prompt was submitted, the host
  exited zero and every observed descendant was gone. Its original failure report
  is retained; no original-model retry or orchestration pass is claimed.
- Abrupt death of a separate owned PTY-holder process also releases its observed
  three job members without cooperative shutdown. Both native Windows ownership
  scenarios pass. Final local checks pass fmt, warnings-denied Clippy, production
  build, 332 unit tests, all 26 official native SDK scenarios and 30 host/sync/CLI
  checks. Cross-platform CI remains separate evidence.

### Shared native recovery profile and partial original-model result

- Windows process-ownership head aba7480 passed all five CI jobs (39403223036),
  including the native Windows job lifetime tests. Unix paths remained unchanged.
- Original Claude 2.1.304 revision-two probe verified native MCP implementer launch,
  question, owner decision, exact result and replacement-coordinator validation
  through three correlated owned provider conversations. No tool outside the
  approved native set was selected. These were metadata markers, not source work.
- The reviewer launch correctly failed with `budget_exhausted/effectStarted:false`:
  the private test confused three retained slots with three concurrent processes.
  Stopped coordinator/worker records still occupied slots. No retry relaxed this
  policy. The run timed out, host exit was zero and all 89 observed descendants
  were gone. This partial result does not complete the stage-three provider gate.
- A shared versioned fixture profile now supplies four lifetime retained slots,
  three live provider slots, two worker slots, one parallel attempt and the exact
  same 17/6 tool lists. An official SDK/CLI scenario executes the whole metadata
  DAG across coordinator replacement, question/result/inbox/ACK, exact validation
  and fresh reviewer authority. It separately reproduces retention refusal before
  admitting the review's sole attempt. The targeted real-PTY scenario passes;
  full suite and any new original-model authorization are separate checks.
- Final local verification passes fmt, warnings-denied Clippy, 332 units and all
  27 serial native SDK scenarios, including the complete shared-profile case.
  Production binaries build after the SDK processes finish. An intermediate
  concurrent rebuild was refused by Windows's executable lock; the subsequent
  sequential build/test succeeds. No original model was retried by these checks.

### Original Claude shared-profile recovery acceptance

- With standing owner authorization for needed probes of the checked profile,
  revision three passed on original Claude 2.1.304/native Windows. Both visible
  tasks reported explicit metadata results and the replacement coordinator
  validated their exact attempts. Four owned original provider conversations
  supplied matching native MCP call/non-error result IDs, not model claims or
  controller-only API effects. The final reply recovered the host-only goal proof.
- A separate read-only audit of the same exact conversation IDs confirmed the
  accepted dependency attempt/summary in the coordinator's reviewer context
  message, and successful reviewer read/ACK of that exact message. Old/new parent
  identities remain distinct; replacement did not adopt the old worker terminal.
- Host exit was zero; all 135 observed owned descendants were gone within the
  bounded 15-second cleanup check. Earlier failed controller/retention probes
  and the older five-second cleanup observation remain recorded honestly.
- This is a passing bounded metadata orchestration/recovery gate. Production
  coding/worktree/checks, general adoption/resume, broader profiles, UI/mobile and
  the remaining feature gates still require implementation and verification.
  The owner authorizes subsequent necessary checked-profile probes without
  per-run reconfirmation; its exact scope, process/time bounds and unknown-effect
  reconciliation remain in force. See [scope and evidence](harness-native-recovery-probe.md).

### Post-recovery idle host baseline

- Native Windows, same opt-in `tests/harness-probe.ts baseline`, eight real idle
  PowerShell PTYs, client disconnected, three-second startup stabilization and
  60.37-second observation. Host CPU was 0.181% of one logical core; host working
  set 18.74 â†’ 18.68 MiB, threads 50 â†’ 46, immediate children unchanged at 17.
  Cleanup completed normally. No original model or user session was involved.
- The earlier 60.41-second baseline was 0.129% of one core and 16.65 â†’ 16.60 MB
  as previously reported. These single quantized host-only intervals are not a
  statistical regression verdict or total process-tree memory/CPU measurement.
  Original baseline artifacts are preserved outside the repository alongside
  the new report. This observation does not reproduce or explain the historical
  100% CPU report and does not complete MCP pooling/hibernation benchmarks.
- Shared-profile head a9175f2 passed all five CI jobs (39405551767), including
  its complete recovery scenario on Windows, macOS and Linux. Original model
  behavior remains verified only for the stated native Windows/Claude version.

### F37/F38 task native-tool profile selection

- Added optional task/executor `profile.allowedNesvoTools`, native CLI repeated
  `--allow-nesvo-tool` and explicit `--clear-nesvo-tools`. Omission preserves the
  old serialized intent and child defaults; empty selections are distinct.
- A bound run can select only a subset of its immutable coordinator owner policy,
  including owner/executor dispatch under that coordinator. Owner coordinatorless
  runs may explicitly select catalog tools for supported new Claude harness workers.
  Native allow rules never grant a worker host coordinator authority. Internal
  grant provenance is never deserialized into raw owner-only create fields.
- Selection is checked before worktree/native effects and again before spawn.
  Rejected profiles retain failed no-effect receipts. Requested profiles survive
  in task attempt history through an additive SQLite migration; legacy profiles
  stay null and saved mutation replies are unchanged. Process recovery does not
  restore grants or replay effects. See [contract](harness-task-tool-profiles.md).
- Native Windows: fmt, warnings-denied workspace Clippy, 336 unit tests, build,
  all 28 serial official SDK scenarios and all 30 Node host/sync/CLI cases passed.
  The new controlled scenario inspects actual inline native settings for subsets,
  empty/default inheritance, owner coordinatorless selection, executor dispatch,
  CLI/MCP immutable replay/conflict, refusal before worktree effects, worker scope
  and restart history. Actual envelopes pass the published JSON schema.
- No model calls, user sessions, global provider edits or new dependencies were
  involved. This does not claim original-model subset-selection evidence or finish
  external MCP/skills, controlled resume or all F37/F38 requirements.
- Parent db85e62 and e8f623d each passed all five CI jobs (39407190711 and
  39406487557). New cross-platform CI evidence is recorded after this feature push.

### F21/F23/F24/F28 durable once jobs

- Added owner-only persisted job definitions, immutable occurrences, exact-revision
  edits/toggles, explicit run-now, bounded history and original mutation lookup.
  CLI and nine MCP operations use one authenticated Rust host implementation.
  Attempts, reserved session identities and native launch receipts are exposed
  alongside each occurrence's run pointer. No global provider config is changed.
- The host dispatcher reuses existing Run/Task/Attempt admission and executor
  readiness/input guards. An explicit worker result still awaits matching passed
  validation; idle/start never means succeeded. Past-due skip/catch-up and overlap
  skip/one-deep queue are bounded. Claimed uncertainty becomes reconciliation on
  restart and never a duplicate native launch. Quiet ticks write/publish nothing.
- A controlled native SDK/CLI test closed owner clients before due, observed its
  worker report without a TUI, validated that exact result, exercised distinct
  queued/manual intent, edits/toggles, actual inline tool settings and retained
  history after restart without a process retry. Real envelopes pass the schema.
- A separate native restart regression first failed: catch-up attempted a harness
  while provider version discovery was still running. The scheduler now waits for
  the existing bounded probes. The identical controlled delayed-version scenario
  then passed with one native attempt/result, without retry or policy relaxation.
- This slice preserves legacy once APIs/storage pending a tested migration.
  Recurrence/IANA calendars, reuse, prechecks/triggers, retry/hard timeout/cleanup,
  quota queues and job UI remain open. See [job contract](harness-jobs.md).
- No new production package was added. A dev-only Chrono reference reuses the
  already locked host package to format exact integration-test future instants.
  Native model, physical-device and interactive job-UI coverage are not claimed.

### Verification environment and previous feature CI

- Feature 3e89fd8 passed Linux/macOS host, app and browser CI. Its initial Windows
  job failed six native SDK deadlines, starting with a wake submission that stayed
  pending. One diagnostic rerun of the unchanged Windows job passed; all five jobs
  are now green (39410085254). The first failure is retained; no root-cause fix or
  absence of intermittent Windows behavior is claimed by that rerun.
- Local verification hit a full C: disk during compilation, before native tests.
  Official Cargo clean for only nesvo/nesvo-host in the owned target/verification
  removed 26.7 GiB of generated package artifacts, preserving sources, host data,
  private evidence and logs. Subsequent checks use CARGO_INCREMENTAL=0 locally to
  avoid rebuilding an unbounded incremental cache; product profiles are unchanged.
- The once-job scheduler baseline (before the small startup-discovery gate):
  eight real idle PowerShell PTYs, no clients, 60.36 seconds; host CPU 0.181% of
  one logical core, working set 19.13 to 19.07 MiB, threads 50 to 45, immediate
  children 17 to 17. Cleanup passed. Host build 047be01d6913b82a. This is a single
  quantized host-only observation, not total-tree or statistical regression proof,
  and does not reproduce historical 100% CPU. Original reports stay outside Git.

### Durable once-job local acceptance

- Final native Windows checks passed: fmt, warnings-denied workspace Clippy,
  345 unit tests (136 TUI, 206 host, 3 wire), production build, all 30 serial
  official MCP SDK scenarios and all 30 Node host/sync/CLI cases. Three host
  helper tests remain intentionally ignored in the ordinary unit selection.
- The complete native suite includes the delayed-version restart regression and
  exact job occurrence/run/attempt/reserved-session/native receipt correlation.
  Blocker changes and resolution publish one job delta; unchanged timer ticks
  add no job events. Actual CLI/MCP envelopes pass the versioned schema.
- Catalog tests now compare the actual 70-tool transport catalog to its versioned
  exact-name contract (with uniqueness), including older SDK negotiation and
  invalid pairing/catalog-without-effects checks. The intermediate stale manual
  count failure is preserved in local verification logs, not hidden as a pass.
- No original model was invoked by these new tests. This local acceptance does
  not finish the remaining scheduled-job, provider, UI or full-goal gates.

### F21/F22/F23 host recurring calendars

- Added cron and Gregorian RRULE schedules to persisted jobs and the shared
  owner CLI/MCP API, with an explicit stored IANA zone (Europe/Warsaw default).
  Generated gaps are omitted before COUNT; a fold uses only its first UTC
  instant. UNTIL is inclusive UTC. Next due and deduplication use persisted UTC
  instants, without an open client or OS timezone dependence.
- Calendar work uses a private pure mode of the same executable, entered before
  host/provider/pairing/storage startup. Two bounded slots, 750 ms, limited pipes
  and candidate/period limits prevent a difficult rule from blocking SQLite or
  the server. Failed children are killed/reaped. Quiet ticks start no helpers.
  Unsupported/overlong searches fail explicitly, never as false rule exhaustion.
- Timer application checks revision/enabled/original cursor atomically. Sleep
  coalesces to the latest slot, exposing coalescedFromAt for audit. Snapshot specs,
  overlap, misfire/grace, immutable key replay and native recovery remain guarded.
  A durable blocked calendar requires an explicit repair; temporary slot pressure
  leaves pending intent for the next ordinary tick. Completion of a calendar is
  separate from success of its last attempt.
- Local DST/count/month-day/ordinal tests and differential interval-seek tests
  cover Warsaw spring/fall transitions and expired UNTIL windows. SQLite tests
  cover latest-slot coalescing, stale edit/disable results, durable failure,
  original-key replay after helper failure and finite exhaustion without extras.
  New CLI/MCP capability gating preserves once-only host compatibility.
- A real helper/SDK/CLI test dispatched a finite recurrence with owner clients
  closed, retained its explicit worker report, replayed the original acceptance
  after calendar exhaustion, and reopened without creating a replacement native
  process. Expensive and invalid calendars were refused before model effects.
  Initial native execution passed behavior but exposed the stale once-only JSON
  schema; that contract was extended and the same actual envelopes then passed.
- The source-reviewed pinned chrono-tz, croner and ical-rs dependencies and precise
  input/DST/work bounds are documented in [calendar contract](harness-job-calendars.md).
  General old dense RRULE seeking, recurrence UI, legacy schedule migration and
  remaining stage-four gates are still open; this does not finish F01–F44.

Local native Windows acceptance for the calendar slice: fmt, warnings-denied
workspace Clippy, 357 unit tests (137 TUI, 217 host, 3 wire; three ordinary host
helpers ignored), all 31 serial official native MCP SDK scenarios, all 30 Node
host/sync/CLI cases and real JSON schema envelopes passed. No original model was
invoked by these calendar tests. Previous once-job feature 43f771d passed all five
CI jobs on its first attempt (39416507971). Cross-platform acceptance for this
calendar feature is recorded after publication; native-device and job UI coverage
are not claimed by these controlled host tests.

### F25/F21 owner-approved prechecks and timer responsiveness

- Host implementation: `4ff6977`; client/catalog/schema parity follows in its
  separate feature commit.
- Added separate immutable owner command approvals, normalized SHA256 inspection,
  explicit expected-digest acceptance, exact-revision revocation and immutable
  mutation lookup. Job definitions reference only an approval ID; imported job
  configuration cannot self-approve an inline command. Worker/coordinator roles
  are refused. Old profiles omit precheckId and preserve their serialized intent.
- Precheck authorization and outcome are durable before model-run creation.
  Skip/refusal/error/timeout/output limit cannot dispatch a model. A passed result
  also needs observed process creation and confirmed owned-scope cleanup. Restart,
  interruption and unknown effects require reconciliation, not a repeated command.
  Explicit owner abandonment never resumes/undoes the check and does not invent
  physical termination. observedAt differs from confirmed finishedAt.
- A waiting helper is contained before receiving the command. Windows uses a
  private handle-owned kill-on-close Job Object; Unix uses an owned process-group
  leader retained until termination, plus parent-pipe lifetime. Command/env/pipe/
  duration/concurrency/retention bounds are explicit. These trusted foreground
  checks are not a sandbox; detached or privilege-changing Unix processes are
  outside that policy. See [precheck contract](harness-job-prechecks.md).
- Minimal Windows Node startup initially aborted with exit134. A separate direct
  Node probe reproduced CSPRNG initialization failure with an empty environment;
  adding SystemRoot succeeded. The production helper now obtains that one path
  from Windows API, without inheriting ambient session/auth context. Describe
  exposes isolated-platform-v1 and platform keys. A windows-sys feature was added;
  there is no new production package or model API dependency.
- Dispatch preparation is bounded to four asynchronous tasks; two calendar
  calculations are independent of clock polling. Recurrence/once pages are
  separate. A held-check native scenario and an injected-store mixed-page case
  guard against starving an unrelated due job. Quiet ticks do no check/model work.
- Native SDK/CLI fixtures verify disconnected skip, pass-before-dispatch, immutable
  replay, revoked refusal, literal Unicode/quoted args, context isolation, bounded
  logs and three-level ordinary command descendants on timeout, normal root exit
  and abrupt parent death. Unknown cleanup does not acquire a completion timestamp;
  explicit abandonment keeps the original effect record. No original model or
  physical-device/job-UI certification is inferred from these controlled fixtures.
- Calendar parent726686c passed all five CI jobs on first attempt39421611304,
  including31 native SDK scenarios on Windows/Linux/macOS. New feature acceptance
  is recorded below after its complete local/native verification. Catalog now77
  exact-name tools; original checked native-recovery permission profile is unchanged.

Local native Windows acceptance: fmt, warnings-denied workspace Clippy, 366 unit
tests (138 TUI, 225 host, 3 wire; three ordinary host helpers ignored), production
build, all 34 serial official MCP SDK scenarios and all 30 Node host/sync/CLI
cases passed. Final test-only additions exercise all seven CLI/MCP operation
pairs against the same owner state, validate the real JSON envelopes and check
all six registry operations against both non-owner roles. The seven domain tests
and three native precheck scenarios passed again with those assertions. No model
was invoked and no private user session was used. Cross-platform CI acceptance
for this slice is recorded after publication; job UI, general cancellation/retry
and the remaining F01–F44 gates remain open.

Initial CI `39435549446` exposed Unix-only Clippy `drop_non_drop` in the two scope
release expressions. Unix Scope contains an identity guard without a destructor;
Windows Scope contains its owned Job handle. Explicit Option take now discards
the value without an unnecessary drop call, preserving release order on both
platforms and without suppressing a lint. Windows fmt/Clippy, production rebuild
and all three native precheck lifecycle/parity scenarios passed after that fix.
The initial failing log is retained; final platform results follow separately.

A subsequent lifetime review tightened Unix cleanup proof: successful SIGKILL
submission alone is not group termination evidence. After reaping the helper,
termination ownership is retired and only signal-zero existence observation is
allowed. Remaining processes or observation errors retain uncertainty/capacity;
a recycled numeric group never receives a termination signal. A Unix OS-boundary
regression test checks that a live group is not reported empty. The native
timeout/root-exit/parent-death scenarios exercise the complete process adapter.
Windows fmt/Clippy, all 366 unit tests and all three native precheck scenarios
passed after that lifetime change; final platform CI remains the next gate.

The stronger observation passed Linux native cases but CI `39437673001` exposed
two macOS precheck outcome timeouts. Darwin's signal-zero implementation includes
unreaped zombies; it is not a live-work predicate. The macOS adapter now uses
bounded libproc group membership and BSD state, treating only absent/zombie
members as terminated and refusing incomplete/error observations. A native macOS
regression test retains a zombie before its parent wait; SDK failure diagnostics
also retain the last occurrence history without increasing deadlines. Actual
platform results for this correction are recorded separately.

CI `39439527256` passed the macOS unreaped-zombie regression, but its inherited
runner-group test encountered a protected member (`EPERM`). Observation correctly
refused to claim cleanup. The live-group regression now enrolls its own bounded
child group, matching production ownership instead of querying unrelated runner
processes. The production permission/error policy remains conservative.

An isolated native Windows idle observation on source `1cd6af3`: eight real
PowerShell PTYs, no clients, 60.40 seconds; host CPU 0.310% of one logical core,
working set 19.51 to 19.46 MiB, threads 50 to 45 and immediate children 17 to 17.
Fixture cleanup passed. This single quantized host-only observation is not a
total-tree measurement, statistical regression proof or a reproduction of the
historical 100% CPU report. Original reports remain outside Git.

Final precheck acceptance: CI [`39440402809`](https://github.com/dkveil/nesvo/actions/runs/39440402809)
on exact source `c0ec448` passed all five jobs, including the complete 34 serial
native MCP SDK scenarios on Windows, Linux and macOS. This verifies the owned
Darwin live-group and zombie observations together with real descendant cleanup;
the earlier failures remain recorded above. No unchanged failed run was rerun as
replacement evidence. This completes this precheck slice's platform gate, not
the remaining F01–F44, job UI, original-provider or device acceptance gates.

### F28 owner occurrence cancellation

- Stable owner cancellation targets one occurrence, independently of later
  definition revisions. Its acceptance and mutation key are immutable; current
  history exposes cancellation progress separately. Coordinators/workers are
  refused before lookup. CLI `job cancel` and MCP `nesvo_cancel_job_occurrence`
  share the request and require `jobCancellation:true`; the catalog has 78 tools.
- Queued/unbound dispatches cancel transactionally. Bound runs are immediately
  fenced against attempt admission, automated input, executor enablement and
  result validation. Cleanup uses the existing native run-control permit and
  exact target/receipt/exit machinery, preserving human leases and dirty drafts.
  Accepting cancellation is never exit proof. No native stop is automatically
  repeated after unknown dispatch or restart.
- Prechecks receive cooperative cancellation through their owned scope, retain
  actual output/results, and never dispatch a model after accepted cancellation.
  Unknown cleanup stays unfinished/reconcile. Explicit acknowledged abandonment
  retains uncertainty. Store guard reads have a one-second budget and cannot
  suspend polling the process future's own deadlines or cleanup.
- Ten store tests cover admission/validation races, immutable replay, cancellation
  tokens versus native projections, event deduplication, real-evidence settlement,
  restart and abandonment. Two native scenarios verify queued/precheck cancellation
  with three-level process cleanup and bound-worker cancellation with exact stop
  receipts plus independent PID disappearance. They check CLI/MCP parity, current
  schema envelopes, no replacement attempts and no restart replay. Existing native
  run-control coverage checks human lease/draft protection on the same stop path.
- Local Windows verification: warnings-denied workspace Clippy and 384 ordinary
  unit tests passed (140 TUI, 241 host, 3 wire; three ordinary host helpers ignored).
  All 36 serial official native MCP SDK scenarios passed in 180.66 seconds and all
  30 Node host/sync/CLI cases passed in 34.85 seconds. Review then found a slow-store
  supervision gap; two additional unit cases now cover it and all four native
  precheck scenarios passed again on the final supervision code (30.25 seconds). Final CI
  platform acceptance is recorded after publication. No original model was invoked,
  production dependency added, user session touched or UI/device behavior certified.

This is the occurrence-cancellation slice. F28 retry/backoff, hard execution timeout,
history-preserving session cleanup and the other F01–F44/plugin gates remain open.

Cancellation reconciliation follow-up: if dispatch never obtained its own native
control, an existing explicit stop/cancel can still supply exact termination
evidence. Only the latest completed control together with a stopped/canceled
bound run can settle the occurrence; a stop request or stale completed control
after resume is insufficient. This reads existing proof and never resends a
signal. The immutable original cancellation/key remains unchanged and current
history points to the observed control. An additional store test covers both
stop/cancel, pending exit, queue release and no duplicate control. Windows fmt,
warnings-denied Clippy, all 385 unit tests and both native cancellation scenarios
passed (9.28 seconds for the two SDK cases). Final platform CI remains pending.

Cancellation platform failures were retained rather than rerun unchanged:
CI [`39444844579`](https://github.com/dkveil/nesvo/actions/runs/39444844579), exact
`43c16cc`, passed Windows/Linux/app/browser but failed one macOS assertion. An
executor observation advanced the run revision between a snapshot and a refused
enable request; either `revision_conflict` or `job_canceled` safely refuses that
request. The regression now accepts either guard while still requiring canceled
state, the exact original native identity and no replacement attempt/session.
CI [`39445494252`](https://github.com/dkveil/nesvo/actions/runs/39445494252), exact
`a16d3d8`, passed Linux/macOS/app/browser but Windows exceeded the existing
eight-second independent-job deadline while slow prechecks ran; stderr also
reported SQLite writer contention. The exact timeout phase was not retained.

`c12aca1` removes two confirmed sources of unnecessary writer competition:
read-only cancellation/calendar supervision uses deferred transactions, and
legacy scheduler ticks first check due work without reserving the writer. Actual
due claims reserve the writer and recheck eligibility, retaining cancellation
safety. Three deterministic WAL tests hold another real writer and verify quiet
reads, absence of writes/waits, and cancellation before claim reservation. The
native fairness test keeps its eight-second deadline and now retains the last
occurrence view on timeout. This fixes verified contention, not a proven complete
explanation of the earlier Windows timeout. Local full native verification passed
the fairness case; fresh platform evidence must still be recorded separately.

### F28 first dispatch generation journal

The host records generation 1 transactionally at claim, before precheck/native
effects, and binds its Run once. Owner-only CLI `job attempts`/`job attempt` and
MCP `nesvo_get_job_attempts`/`nesvo_get_job_attempt` require `jobAttempts:true`.
Eight-row summary pages omit result/validation and raw command output; detail
retains the actual original evidence. The catalog now contains 80 tools without
changing the frozen native permission profile. A job generation ID is distinct
from a native workflow attempt/session ID. Unclaimed queued/skipped/canceled
intent does not manufacture execution history. Current occurrence pointers may
evolve; original accepted mutation responses remain byte-for-byte unchanged.

Recovery backfills historical claims before changing unfinished occurrence
phases, preserves the same journal identity, and never creates another native
attempt. Cancellation guards also fence Runs referenced by journal history.
Generation-2 admission, retry policy/backoff, per-generation repeated prechecks,
hard execution timeout and history-preserving retirement remain unimplemented.
This is groundwork for F28, not completion of F28 or the full goal.

Five metadata tests cover immutable Run binding, first timestamps, bounded and
tuple-scoped history, exact retained precheck/result/validation evidence and the
historical-Run cancellation guard. The legacy-disk fixture removes the new table
from a populated synthetic old-schema database and exercises real initialization,
recovery and two disk reopens, preserving original mutation bytes. It does not
claim execution of an old release binary or adoption of surviving processes.
The additional native SDK scenario checks owner CLI/MCP parity, worker denial,
actual launch/report pointers, schema envelopes, unchanged acceptance replay and
restart without another generation, Run, native attempt or session.

Local Windows fmt, warnings-denied workspace Clippy, production build and all
395 unit tests passed (142 TUI, 250 host, 3 wire; three ordinary helpers ignored).
The first 37-case native run passed 36 cases and exposed a wrong test path: Run
summaries publish `reportedOutcome`, while full result evidence belongs to the
task-attempt endpoint. Correcting the assertion retained the full-result check
through that detail endpoint. The corrected journal case and revised cancellation
case passed individually; the subsequent full-suite and platform results are
recorded separately. All 30 Node host/sync/CLI cases passed in 34.81 seconds.
No original model, new production dependency, UI change or device test was involved.

The corrected full serial native SDK suite then passed all 37 cases in 183.67
seconds, including fairness, both cancellation cases and first-generation history.
Cross-platform CI remains the publication gate; local Windows is not proof of
Linux/macOS execution.

Final generation-1 platform acceptance: CI
[`39450113725`](https://github.com/dkveil/nesvo/actions/runs/39450113725), exact
`5e617a1`, passed all five jobs. All 37 serial native MCP SDK scenarios passed
on Linux (173.56 seconds), macOS (179.16 seconds) and Windows (281.59 seconds),
including the corrected revision refusal, unchanged eight-second fairness gate
and actual first-generation restart history. The earlier failed sources and
their logs remain recorded above; this is fresh verification of changed source,
not an unchanged rerun. Other F28 and full-goal acceptance gates remain open.

### F28 exact dispatch preparation fences

New scheduler claims persist a private random preparation token and exact current
generation pointer before returning work. Every asynchronous producer checks that
tuple, token and synchronized phase before changing metadata; completed/retired
claims cannot obtain another token. Restart clears tokens and migration gives
existing journal rows a current pointer without inventing dispatch authority.
Run creation, plan, budget and activation now check preparation inside the same
writer transaction before immutable-key replay. Plan/budget/activation also check
the exact bound Run. Public owner mutation recovery retains its existing contract.

Ordinary native admission separately requires the current generation's Run; it
does not depend on the already retired preparation token. Historical evidence
remains inspectable. Cancellation and human control guards remain in force.
Unavailable approvals retire preparation; in-flight canceled prechecks still
retain their actual outcome before token retirement. This adds no provider grant,
public request field, dependency, UI change or generation-2 dispatch.

Five additional metadata tests exercise all stale producer variants, all four
guarded preparation actions, zero writes/events on refusal, valid preparation,
wrong-Run refusal, token retirement/replay, historical Run admission and migration
of the previously published journal. A future-shaped second generation is only a
database test fixture. Local Windows warnings-denied Clippy and all 400 unit tests
passed (142 TUI, 255 host, 3 wire; three ordinary helpers ignored). Native SDK,
public CLI/host regressions and final platform results are recorded separately.
Per-generation precheck storage, retry/backoff and the other F28 gates remain open.

Final local dispatch-fence verification: production build and fmt passed; all
37 serial native MCP SDK scenarios passed in 185.80 seconds, including canceled
prechecks, exact bound-worker stop, fairness and first-generation restart history.
All 30 Node host/sync/CLI regression cases passed in 34.05 seconds. Review found
no additional production defect. No original model or device was invoked for
these checks; exact published platform evidence follows separately.

Final dispatch-fence platform acceptance: CI
[`39452970064`](https://github.com/dkveil/nesvo/actions/runs/39452970064), exact
`4b3fe2e`, passed all five jobs. Each native platform passed the complete 37-case
serial SDK suite: Linux 170.07 seconds, macOS 187.95 seconds and Windows 275.61
seconds. This includes guarded preparation, existing process/control boundaries,
job/precheck cancellation, fairness and restart history together with the full
workspace checks and public CLI regressions. This closes the dispatch-fence
slice's platform gate; retry/backoff and all remaining goal gates stay open.

### F28 bounded retry after a proven no-effect launch refusal

An optional frozen occurrence policy selects `on:launchNoEffect`, 1–8 total
generations and capped exponential backoff. It defaults off. Only an exact
terminal `create` receipt with the JSON boolean `effectStarted:false`, its
matching reserved session/native attempt and no result, delivery, exit or other
native receipt can qualify. A launch label alone is insufficient. Actual
launcher/PTY errors and uncertain worktree effects remain reconciliation cases.
No model permission or global provider configuration changes are introduced.

The decision, original deadline and failed generation are persisted together,
before releasing overlap. `retryWaiting` remains active for the logical
occurrence; its source generation remains failed with its first completion
evidence. Public optional `retry` facts are immutable, including in old history
details. Ordinary automated admission on the old Run is fenced immediately.
At the deadline a transaction rechecks evidence, cancellation, authority and
limits, then allocates a fresh generation token, Run namespace and native
attempt/receipt/session. Every Run still permits exactly one native attempt;
executor retry multiplication is disabled. Queue and retry candidates share a
bounded eligibility-time order. Disabling future definition terms does not
revoke already admitted occurrence intent; cancellation explicitly does.
The source executor is paused transactionally with a new generation fence and
its ordinary Run event, releasing executor capacity. New owner constraints,
coordinator changes, explicit pauses and changed Run admission limits block the
new generation instead of being silently discarded by a fresh Run.

Canceling a proven no-effect waiting retry completes without fabricating a
native stop. A restart retains the same pending deadline and rechecks it before
claim; an interrupted claimed generation has no recovered dispatch authority.
CLI/MCP creation or update requires both `jobRetries:true` and
`jobRetryKinds:["launchNoEffect"]`. Existing no-policy acceptance bodies and
first-generation mutation keys retain their serialization/replay contract. No
tool or native grant is added to the 80-tool catalog.

Retry combined with `precheckId` is explicitly refused until command evidence
and approvals can be stored per generation. Failed worker reports, hard process
timeouts, cleanup policies and broader retry classes remain unimplemented. This
slice does not complete F28 or the full goal.

Local Windows fmt, warnings-denied workspace Clippy, production build and all
421 unit tests passed (145 TUI, 273 host, 3 wire; three ordinary helpers ignored).
Seventeen retry-storage tests cover exact typed evidence, immutable history,
backoff/caps, rollback, competing writers, owner context/budget changes, executor
retirement, fair overlap admission, capacity and disk recovery. Host policy
validation and three CLI/MCP/capability tests also passed. An independent review
caught the owner-context bypass before publication; new constraints, coordinator
bindings and changed admission limits now block retry.

All three new native SDK scenarios passed individually in 33.98 seconds. The
full serial suite then passed all 40 scenarios in 218.21 seconds, including the
existing precheck/cancellation/fairness cases. The new scenarios use actual
failed/false native validation receipts followed by a controlled Node worker,
fresh Run/attempt/receipt/session IDs, unchanged mutation replay, retained
generation bodies and real CLI/MCP/schema parity. They also exercise default-off,
total-attempt bounds, actual unknown worktree effects, waiting cancellation
without a native stop, and restart using the original persisted deadline. No
original model, new production dependency, UI change or device test was involved.
All 30 Node host/synchronization/public CLI regressions passed in 35.67 seconds.
The implementation is published as `a743533` (host), `f6cbf1f` (CLI/MCP contract)
and `e41b33d` (native acceptance). Exact published platform results follow
separately; local Windows verification does not certify Linux or macOS.

Separate prior-run observation: docs-only CI
[`39455698230`](https://github.com/dkveil/nesvo/actions/runs/39455698230), exact
`a9b0f39` with the previously verified `4b3fe2e` Rust source, passed Linux,
macOS, app and browser but Windows timed out waiting for the disconnected
calendar worker report (36/37 SDK scenarios, 370.79 seconds total). That log
retained no occurrence/receipt phase, so no production cause or connection to
the new retry slice is established. The calendar test's original 22-second
acceptance deadline is unchanged. A diagnostic-only follow-up reads the owned
host, job/history, provider status and linked Run/receipt/PTY after failure,
within a bounded diagnostic window. It admits no effects or fallback success.
Local fmt/Clippy and the unchanged passing calendar scenario passed in 13.61
seconds; that pass does not reproduce or explain the earlier Windows failure.

Retry source CI
[`39459087624`](https://github.com/dkveil/nesvo/actions/runs/39459087624), exact
`e41b33d`, passed app/browser and all host checks on Linux/macOS, including all
40 serial SDK scenarios (208.79 and 211.32 seconds). Windows passed fmt, Clippy,
units and build, but the SDK suite passed 38/40 in 305.63 seconds: the waiting
retry/restart case reached generation 2 with `worker_result_pending` without a
report by its deadline, and the existing disconnected once-job report also
timed out. The calendar case passed in that run. This does not pass the Windows
reliability gate, and retry is not claimed accepted on all three platforms.

The last retry occurrence view does not establish that input was delivered:
`worker_result_pending` also covers queued/dispatching delivery. A follow-up
preserves bounded job/history, task-attempt delivery, session/PTY, Run/receipt,
provider and journal diagnostics after the unchanged acceptance deadline.
Controlled subprocess errors now retain stage/status/signal/error/stdout/stderr
within fixed output bounds. These observations add no native admission and do
not change deadlines, PTY timing, parsing or report semantics. No production
cause is proven by the original logs; fresh diagnostic-source results must be
recorded separately rather than rerunning unchanged source or claiming a fix.

The follow-up diagnostic source passed local Windows all-target warnings-denied
Clippy, formatting and all 40 serial SDK scenarios in 220.44 seconds. Its three
retry scenarios also passed in 33.36 seconds. The successful run exercises the
same unchanged acceptance gates; it does not reproduce the earlier Windows
failure or establish a production fix. Published diagnostic CI remains pending.

Final diagnostic-source verification: CI
[`39462535954`](https://github.com/dkveil/nesvo/actions/runs/39462535954), exact
`a2acdee`, passed all five jobs. All 40 serial SDK scenarios passed on Linux
(204.14 seconds), macOS (201.48 seconds) and Windows (316.94 seconds), including
the two previously failing report waits and calendar case. This is fresh
verification of the changed diagnostic source, without relaxing acceptance
deadlines, native grants or process semantics. The current source passes the
three-platform test gate. Earlier report timeouts remain unexplained; a green
run does not prove a production fix, and the retained diagnostics must be used
if they recur. Per-generation prechecks, wider retry classes, hard execution
timeouts, cleanup and the remaining full-goal acceptance gates stay open.

### F25/F28 independent prechecks for each retry generation

An explicit job combining `retry.launchNoEffect` and `precheckId` now authorizes
bounded repeated execution of the exact approved command. Each claimed generation
must freshly read an enabled, canonical approval, persist its own authorization,
execute the bounded command and retain its actual outcome. A prior pass cannot
release the next worker. This extends only the existing proven no-effect native
launch retry class; a failed/skipped/unknown command does not become a retry.

Generation 1 keeps its published storage and response shape. A separate table
retains later command snapshots, approval revision, authorization/observation/
finish times and bounded output, keyed by exact journal identity and occurrence.
The composite foreign key enforces generation membership. Occurrence views show
the current precheck; attempt detail/history show that generation's evidence.
Accepted mutation bodies and omitted legacy fields remain unchanged.

Both retry source proof and Run binding require the exact current command snapshot
and terminal `passed` result with actual JSON booleans `commandStarted:true` and
`cleanupConfirmed:true`. The due claim rechecks approval availability separately.
Revocation blocks future execution without erasing old evidence or preventing
logical cancellation of a proven cleaned-up waiting retry. A generation claimed
before revocation still checks approval again before starting its command.

Current dispatch tokens fence begin, finish and interrupted callbacks. Cancellation
also retains the exact command generation internally, and a previous callback
cannot settle a new cleanup request. Restart clears producer tokens and marks only
the current running command unknown. Explicit abandonment after generation 1
requires its exact `jobAttemptId`, digest and owner acknowledgement; an identical
digest or omitted ID is insufficient. Replay of an already accepted mutation keeps
the original body and performs no new action.

CLI/MCP require strict `jobPrecheckGenerations:true` for combined specs or explicit
abandonment IDs, in addition to the existing operation capabilities. The existing
abandon tool gains an optional argument and the CLI adds `--job-attempt-id`; there
is no new tool, provider grant, model call or production dependency. Job UI,
original-provider coverage, broader retry classes and the remaining full-goal
gates are still open. Verification evidence for this slice follows below.

The initial Windows source passed formatting, all-target warnings-denied Clippy,
438 unit tests (148 TUI, 287 host, 3 wire; three ordinary subprocess helpers
ignored), production builds and all 43 serial native SDK scenarios in 250.43
seconds. The three new repeated-precheck scenarios separately passed in 32.07
seconds. Seven storage test groups and six retry/proof tests cover current-only
authorization, typed cleanup evidence, immutable history, exact cancellation and
abandonment, revocation, rollback and reopen. The native tests exercise actual
command processes/descendants, no-effect launch refusal, one successful later
worker, skip, revocation and restart via CLI/MCP with schema-checked envelopes.
No original model, native phone or three-platform acceptance is claimed by these
local fixtures. Later input diagnostics and fixture-ordering verification are
recorded separately.

### F03/F17 bounded submission-failure diagnostics and fixture readiness

Prior docs-only CI
[`39464718115`](https://github.com/dkveil/nesvo/actions/runs/39464718115), exact
`bc25ea3` with the previously verified Rust source, passed Linux/macOS and
app/browser. Windows passed the build checks but 38/40 SDK scenarios: the
disconnected once-job report and startup catch-up report timed out. The retained
disconnected-job diagnostic shows an active ready/idle worker, a created native
launch receipt, no task report and delivery `unknown` with
`submission_unconfirmed/effectStarted:true`. The PTY replay contains only startup
output. This establishes submission uncertainty, not a missing task result after
confirmed delivery. It does not identify which native write or guard failed.

Send errors now retain an optional fixed `submissionStage`, and native write
confirmation distinguishes timeout, closed channel and failed write/flush with
typed safe codes. All existing write/readiness/paste deadlines, native grants,
queued-effect uncertainty and first terminal receipt preservation remain intact.
Shared control writes deliberately retain their earlier conservative projection.
Four unit tests cover confirmation outcomes, paste/submit stages, redaction and
control compatibility. The [operation contract](harness-operations.md) describes
the additive error-only metadata.

The controlled agent fixture also published semantic readiness before attaching
and starting its stdin consumer. It now installs the unchanged parser and resumes
input before an event-loop callback publishes readiness. Deferred readiness and
hook order/payloads remain unchanged; no delay or retry was added. This closes a
fixture ordering gap. Node buffering and the earlier coarse diagnostic do not
prove that gap caused the Windows timeout. A passing follow-up is separate
verification, not evidence that the earlier production uncertainty is resolved.

Local Windows verification of the input diagnostic/readiness source passed
formatting, warnings-denied all-target Clippy, 442 unit tests (148 TUI, 291 host,
3 wire), production builds and all 30 host/sync/CLI tests in 34.35 seconds. Its
full serial SDK run passed 42/43 in 249.22 seconds: the checkpoint scenario
returned generic `host_unavailable` while opening a paired-host connection. That
message collapses connection/handshake failures and does not identify a cause.
The checkpoint now retains safe caller/tool/phase context and owned host status
before cleanup, without new connections, effects, deadlines or retry. The changed
diagnostic case passed individually in 5.03 seconds; that does not reproduce or
explain its earlier failure. Earlier logs and failures remain retained. An
occurrence index additionally bounds the no-unexpected-precheck proof lookup;
host units and all-target Clippy passed after that migration was added.

The final local source, including the index and checkpoint diagnostic contexts,
passed all 43 serial SDK scenarios in 249.60 seconds without changing acceptance
deadlines, native permissions, retry semantics or prompt parsing. Formatting and
all-target Clippy passed on this source; host units/build passed after the index.
The earlier complete 442-unit and 30-integration checks remain as recorded above.
This passes the local Windows regression gate for the current slice. The earlier
connection/submission failures remain unexplained; neither the passing targeted
case nor this full run proves a production fix. Final source CI on Windows,
macOS and Linux is pending, and the remaining full-goal gates stay open.

### F03/F10 request cancellation and connection diagnostics

Published baseline CI
[`39469654684`](https://github.com/dkveil/nesvo/actions/runs/39469654684), exact
`42ffe01`, passed Linux, macOS, app and browser. Windows passed formatting,
warnings-denied Clippy, units, build and development-host checks, then 42/43
serial SDK scenarios in 376.35 seconds. The second explicit manual occurrence
timed out waiting for `needsValidation` after the scheduled first occurrence had
reported, been validated and reached `succeeded`. The old test omitted follow-up
diagnostics at that later wait, so it cannot identify admission, launch,
readiness, native submission or reporting as the cause. The existing bounded
read-only diagnostic now covers that deadline, startup catch-up and both
occurrence-state waits. Acceptance deadlines, polling and native effects are
unchanged. The earlier failure remains open rather than being rerun away.

`ceef60a` retains safe typed connection stages/causes in CLI/MCP
`host_unavailable` messages, with numeric HTTP/close status only. Eight bounded
real loopback tests cover validation, reflected/wrong-context proofs, nonce,
protocol, identity, close/rejection and read/upgrade timeout behavior. Raw error
chains, peer text and authentication data stay private. Existing timeout and
authentication rules are preserved. This improves evidence; it does not prove
socket admission saturation or the cause of any earlier generic failure.

Inspection of the pinned SDK found a separate concrete resource-retention bug:
request cancellation signals its context token while the handler task remains
detached. The adapter ignored that token, so its host slot/socket could persist
until an ordinary wait completed. `a432114` wraps the complete invocation with
that token and drops the pending connection/slot on cancellation. It never
interrupts, rolls back or repeats an accepted host mutation. A pre-cancel unit
test and an official SDK/native-host/controlled-PTY scenario cover cancellation
and same-process capacity recovery while one original response remains active,
then settles naturally exactly once. The native scenario passed in 2.38 seconds.
Its early test drafts incorrectly assumed queued reads already occupied slots;
the final test proves observed capacity, replaces only read-only busy rejections
within fixed bounds, and keeps the original ten-second acceptance window.
It does not directly gauge host connections or cancel a mutation during
authentication/acceptance. Those paths have static review, not native coverage.
MCP pooling and the complete F10/F39 gates remain open.

`4e26e7c` adds test-only metadata FIFO traces and an opt-in, watchdog-bounded
ConPTY diagnostic. Both the initial Rust helper and the revised silent Node
helper lacked out-of-band readiness with the decoder held; neither attempted
the paste. Both holders returned through owned cleanup. No sampled child-exit
handle was available, and neither result proves a blocked OS write, a production
cause, or that the ordering cannot occur in another provider. Normal binaries
contain no trace channel/lock, and native FIFO, parser and timing semantics are
unchanged. See the [diagnostic contract](testing.md#opt-in-windows-input-fifo-diagnostic).

Local Windows formatting, all-target warnings-denied Clippy, production builds
and 453 unit tests passed (157 TUI, 293 host, 3 wire; five host diagnostics/helpers
ignored). No production dependency, catalog tool, UI or provider grant was added.
All 44 serial official SDK/native-host/PTY scenarios passed in 250.42 seconds,
including both once-job report paths and the cancellation regression. This is
verification of the changed source, not a reproduced cause or production fix for
the prior Windows manual-queue timeout. Earlier CI failures and remaining
full-goal gates stay open. Host/sync/CLI integration results and publication CI
are recorded separately below.

All 30 local host/sync/CLI integration tests passed in 35.05 seconds using the
same built native binaries. This covers real shell continuity, authentication,
multi-client leases, durable operations and current workflow adapters. The
checks introduce no new original-model or native phone coverage. Source
publication CI is pending; do not infer three-platform acceptance from the local
Windows result or erase the prior manual-queue failure.

### F41 Unix host-lock ownership lifetime

Baseline CI
[`39473421754`](https://github.com/dkveil/nesvo/actions/runs/39473421754), exact
`b04cccd`, passed Linux, Windows, app and browser. The Windows serial SDK gate
passed on that run; this does not explain the earlier manual-queue timeout.
macOS failed one host unit test while reacquiring a data-directory lock after
dropping its previous owner (291 passed, one failed, one ignored). The native
SDK gate was consequently not executed on macOS.

Unix `flock` belongs to a shared open file description. A duplicate/forked
descriptor can retain it after the Rust guard's descriptor closes; close-on-exec
does not cover the fork-to-exec interval. The guard now explicitly unlocks its
live description on drop, then closes normally. Acquisition remains exclusive
and nonblocking; the persistent lock file is never unlinked. Windows locking,
session ownership and abrupt host-death cleanup are unchanged.

A deterministic Unix-only regression retains a duplicate description across
guard drop, acquires a successor, and verifies that closing the old duplicate
does not release the successor. It isolates that descriptor lifetime; the failed
macOS runner's particular descriptor history was not observed and remains a
hypothesis. Local Windows workspace tests pass, including the existing
ownership test. Unix runtime verification awaits publication CI. No dependency
or process/session recovery claim is added by this fix.

### F28 exact-worker execution deadlines

Optional `executionTimeoutMs` adds an immutable 1-second through 7-day execution
window per native job generation, with strict `jobExecutionTimeouts:true`
CLI/MCP gating. Omission/null preserves previous specifications and fingerprints;
the existing `maxElapsedMs` remains the separate Run admission/input budget.
Native admission atomically binds the deadline to exact job/occurrence/generation,
Run, attempt, session and launch receipt IDs. It includes native preparation and
readiness, excludes approved prechecks, and cannot be reset by definition edits,
budget extensions, reads or replay.

Enforcement and the first-report boundary use a process-local monotonic clock;
public wall timestamps remain diagnostic facts. An accepted explicit report
disarms the timer regardless of outcome, independently of validation. At/after
the deadline fresh reports and further automated admission/input are fenced.
Accepted historical mutation replay still returns its original body. Independent
bounded supervision waits on journal changes/deadlines and sends no model input.
Only result persistence retries after a writer error; native stop is never
reconstructed from an uncertain callback.

Cleanup reuses exact native controls/receipts and requires actual exit evidence
before terminal timeout failure. One claim targets only its frozen worker.
Active leases, retained drafts and prior takeover epochs block automatic stop
inside the same State lock as the physical effect; release never authorizes a
deferred signal. Existing exact owner controls can be linked read-only, while
conflicting controls block cleanup. Unknown/blocked cleanup retains overlap.
Early trusted exit fails honestly without inventing a task result or timeout
signal. Recovery honors already persisted passive proof, then invalidates
unfinished timer authority without rearming or process adoption.

Current occurrence and generation summary/detail include nullable execution
evidence with control pointers and explicit states. Private tokens and monotonic
origins are excluded. The shared workflow job request is boxed internally to
avoid inflating every workflow message after the optional policy was added;
Serde wire bodies and mutation fingerprints remain unchanged. There is no new
dependency, MCP tool, native permission grant, UI change or provider call. See
the [timeout contract](harness-job-timeouts.md) for fields, owner operations and
the conservative late no-effect/reconciliation limitation.

Local Windows formatting, warnings-denied all-target Clippy and 477 units pass
(161 TUI, 313 host, 3 wire; five host helpers/diagnostics ignored). Thirteen
storage, six control and one runtime test groups cover strict compatibility,
clock boundaries, current-only claims, report ordering/replay, actual-exit proof,
human priority, callback uncertainty and recovery. The initial three native
CLI/MCP/PTY scenarios passed in 55.73 seconds. After that run, review added two
storage regressions for lost native callbacks and trusted exits persisted before
restart; final complete native regression evidence is recorded separately below.
Broader retry classes, explicit uncertain-cleanup reconciliation, reported-worker
cleanup, job UI and original-provider acceptance remain open. This is not full
F28 or full-goal completion.

Final local source (`29d7fda` plus native scenarios `059a844`) passed all 47 serial
official SDK/native-host/PTY scenarios in 317.08 seconds. This reruns the three
new timeout paths after both review fixes, alongside prior job reports, retries,
prechecks, cancellation, ownership, coordinator recovery and human-input gates.
Existing acceptance deadlines and native effect/retry semantics were retained.
The host-lock fix is `eafc57f`; its new Unix-only descriptor test still awaits
native Unix CI. No original model or phone was invoked, and this Windows pass
does not explain the earlier intermittent submission/connection failures.

All 30 host/sync/CLI integration tests also passed on the same built native
binaries in 33.22 seconds. Controlled status publication measured p95 261.034 ms
and maximum 262.383 ms from host receipt to snapshot enqueue; provider latency
is outside that measurement. Formatting and the changed Markdown/JSON checks
passed, and the production source passes warnings-denied all-target Clippy,
477 units and locked workspace builds. No dependency or global configuration
changed. Three-platform publication CI remains a separate gate; the previous
macOS failure and earlier Windows submission uncertainty remain retained above.

### Publication evidence for `56be276`

Exact run [39478975908](https://github.com/dkveil/nesvo/actions/runs/39478975908)
passed app, browser, Linux and macOS. Both Unix jobs passed their native Rust and
SDK gates, including the explicit host-lock ownership regression. This closes
the previously pending runtime verification of that lock change on those
runners; it does not prove an unobserved descriptor history caused the older
macOS failure.

Windows passed formatting, Clippy, 477 units, native builds and the development
host probe, then failed six of 47 serial SDK scenarios (41 passed; 390.13 seconds).
The six failures occurred at initial host startup, before scenario-specific
acceptance: waiting-retry cancellation/restart, all three execution-timeout
scenarios and both base job scenarios. Each returned only `deadline has elapsed`
after approximately 15 seconds. Later native scenarios passed; the subsequent
Node integration step was skipped. The exact Windows job is `118822251497`.

The available log does not establish whether host initialization, child stdout
delivery or the parent readiness reader stalled. Provider version probes are
spawned rather than awaited before readiness. No production cause or resolution
is claimed, and the earlier local Windows pass remains separate evidence. The
next fixture diagnostics retain the original 15-second readiness deadline and
successful stdout draining. Only failure observations add bounded process,
stdout-counter and fixed-file-metadata facts, without private contents or startup
retries. This publication failure remains an open reliability gate.

### F28 owner resolution of an exact no-effect launch

`jobLaunchReconciliation:true` adds owner CLI `job abandon-launch` and MCP
`nesvo_abandon_job_launch`, sharing required generation ID, mutation key,
lowercase evidence digest and explicit unknown-effects acknowledgment. Current
occurrence and exact generation reads expose fixed-shape nullable
`launchReconciliation` and immutable `launchResolution`. Accepted-key replay
preserves its original response before fresh admission checks; existing
`abandonPrecheck` fingerprints and compatibility remain unchanged. The published
catalog now contains 81 tools; this does not add a native provider permission.

The transaction requires an exact current sole-worker generation, typed false
native create proof and ended generation/create/cleanup producers. Positive
native effects, outcome/delivery/decision/exit proof, later generations, sourced
retry decisions, ambiguous prechecks and expanded coordinator/native scope
refuse acceptance. The digest binds relevant immutable identities and retained
effect facts rather than polling timestamps. An unavailable descriptor has a
stable generic reason, so current occurrence changes do not rewrite unavailable
historical generation views. Incomplete legacy specifications remain readable
without gaining fresh authority. Ordinary ineligible generations return before
deep receipt/history scans.

Acceptance records logical `canceled/launch_owner_abandoned`, releases overlap
for a separate occurrence and permanently retires that Run from fresh effects.
Native create/control/cleanup/timeout/precheck/process facts remain unchanged;
no fake exit, cleanup completion, rollback, retry or model input is generated.
Timer/cancellation callbacks, retry claims, passive refresh and restart cannot
reopen it. The permanent guard also covers coordinator wake enablement, batch
claim and final dispatch if a coordinator is bound later through metadata-only
recovery. Reads and immutable mutation replay remain available. See the
[owner reconciliation contract](harness-job-launch-reconciliation.md).

Storage regressions cover the late known-no-effect/claimed-cleanup ordering,
atomic overlap release, live producers, exact generation changes, accepted
replay, retained artifacts/evidence and permanent recovery/wake fences. Native
verification must preserve a separate boundary: failed worktree checkout is
`unknown/worktree_unconfirmed`, because it can leave artifacts. It is not a
known-no-effect receipt and cannot be abandoned by this operation. Neither a
negative test of that uncertainty nor an ordinary terminal preflight failure
proves live queue release after late known-no-effect evidence. The distinct
coverage and local results are recorded below. Broader
uncertain-effect reconciliation, reported-worker cleanup, job UI, provider and
device gates remain open; this is not full F28 or full-goal completion.

Local Windows checks pass formatting, locked workspace builds and 495 units
(164 TUI, 328 host, 3 wire; five host helpers/diagnostics ignored). Fifteen host
storage regressions cover the new resolution boundary; three TUI groups cover
CLI/MCP parity, strict capability refusal and exact additive schemas. Independent
review found and repaired unavailable-history instability, legacy initializer
compatibility and the coordinator-wake retirement bypass before publication.
No dependency, global provider configuration or UI changed.

The same frozen production binaries passed all 47 existing serial official-SDK,
native-host and controlled-PTY scenarios in 417.87 seconds. Both native
reconciliation scenarios then passed separately in 14.52 seconds. The negative
case preserves actual late unknown checkout effects and occupied overlap; the
positive case obtains genuine typed-false preflight evidence, owner CLI/MCP
acceptance/replay and exactly one deliberately new worker/report. Native receipt
equality compares the receipt itself, not its enclosing moving event cursor.
Late known-no-effect queue release remains storage-level coverage, not a claimed
native timing reproduction. No original model or phone was invoked. This local
pass does not explain the preceding Windows publication startup failures.

All 30 native host/sync/CLI Node integration tests also passed, run serially in
80.93 seconds against the same binaries. Controlled status publication measured
p95 261.901 ms and maximum 263.138 ms from host receipt to snapshot enqueue;
provider delay is excluded. Final all-target warnings-denied Clippy and changed
Markdown/JSON/fixture formatting pass. Local tools were Rust/Cargo 1.98.1,
Node 24.20.0 and Git for Windows 2.55.0. Publication CI for this source remains
a separate gate; no unchanged failed workflow was rerun to erase prior evidence.

Implementation is `b77b28f`, the two native scenarios are `6d89234`, and bounded
startup diagnostics are `53baf8c`. Startup deadlines, provider permissions and
unknown-effect classification remain unchanged. This does not certify all
F01–F44, plugin inspirations, platforms or physical devices.

### Publication evidence for `e9652ce`

Exact run [39486090561](https://github.com/dkveil/nesvo/actions/runs/39486090561)
passed app, browser and Linux; Linux passed all 49 native scenarios. macOS passed
48/49 in 293.22 seconds. Its sole failure compared an entire control read while
the enclosing current Run revision legitimately advanced from 9 to 10. Control,
target and pagination facts were identical. The assertion now compares those
stable fields separately; no production behavior or deadline is changed.

Windows passed 48/49 native cases in 518.01 seconds. The lone slow-precheck
fairness case returned OS error 32 without a path. This was not an initial
host-readiness timeout, and no startup diagnostic fired. The fixture now waits
for exact cleanup evidence after releasing its held checks and adds path/stage
context to writes and teardown. The original eight-second fairness assertion is
unchanged. The old log does not prove which file was locked or what caused it;
the fixture repair alone is not a production root-cause claim. Node integration
steps after those failed SDK gates were skipped on both runners. Earlier Windows
startup failures remain separate evidence; no unchanged workflow was rerun.

### F27 external trigger admission

Generic signed webhooks and the GitHub adapter use one restricted journal writer
and the existing occurrence dispatcher. The dedicated listener is explicit and
loopback-only, with finite HTTP/storage/rate bounds. Owner CLI and ten MCP tools
share revision-checked administration, immutable delivery receipts and secret
rotation/revocation; the current catalog contains 91 tools. External-only jobs
have no phantom timer due date. Accepted delivery does not promise model success.

Independent review repaired full-journal revocation lockout, unsigned GitHub
event-header relabeling, parser-normalized HTTP framing and stale listener-health
reporting. Domain tests cover exact-byte signatures, credential epochs, persisted
dedupe/burst/retention, backward clocks, sticky ignored outcomes, current job-spec
authorization and atomic overlap admission. HTTP tests use real TCP framing.
The new additive database tables and one transitive HTTP dependency are described
in the [trigger contract](harness-job-triggers.md).

Initial local Windows verification passed 531 units (167 TUI, 361 host, 3 wire;
five host helpers ignored), locked builds and three new real HTTP/official SDK/
CLI/controlled-PTY cases in 17.63 seconds. Two reconciliation regressions also
passed in 9.68 seconds with the stable-field assertion. This initial evidence
precedes the separately identified shutdown-drain correction and its final gate.
No original model, public webhook account, phone, user process or global provider
configuration was used. UI administration and publication/platform acceptance
remain separate; this is not full F27 or full-goal completion.

### Graceful command-scope drain

The CI investigation also exposed a separate source-level lifecycle gap: main
discarded the job-runtime task and did not await active command-scope cleanup.
This does not prove that gap caused the older unlocalized Windows sharing error.
The retained runtime now fences final native admission, cooperatively stops
active/waiting checks, and keeps the journal alive through exact finish writes.
Its five-second total budget reserves 100 ms to observe task abort if normal
drain cannot be confirmed. Failure remains explicit; no cleanup or process exit
is invented. Deferred command-scope observers still occupy their permits.

Final same-lock paste/Enter admission now refuses shutdown, closing the race
between an earlier submission check and a later physical write. Owner cancel,
guard loss and host shutdown remain distinct. A released command frame retains
unknown `commandStarted`, even when its owned process scope was actually reaped.
The new guarantee concerns command scopes and runtime-owned task sets, not the
completion of separately detached executor/worktree setup; their native receipt
uncertainty is preserved. See [shutdown contract](harness-job-prechecks.md).

Local Windows final units pass: 535 total (167 TUI, 365 host, 3 wire), with five
host helpers ignored. Warnings-denied all-target Clippy and locked builds pass.
The new native graceful-exit test passes in 2.46 seconds, checking a real
three-level command tree, image-file release and retained refusal after restart,
with no Run, model or replay. Full-suite/publication evidence is recorded
separately rather than inferred from that focused pass.

The final frozen production binaries passed all 53 serial official-SDK/private
host/controlled-PTY scenarios in 339.54 seconds on Windows. This includes all
three signed HTTP trigger cases, exact reconciliation, command cancellation,
graceful shutdown, timer fairness, coordinator replacement, native permission
isolation and human-input protection. No failing case was dropped or rerun to
hide a result. This is local evidence; publication CI is a separate platform gate.

All 30 host/sync/CLI Node integration cases pass against those same binaries in
45.64 seconds. Controlled lifecycle publication measured p95 261.801 ms, maximum
263.143 ms from host receipt to snapshot enqueue; provider delay is excluded.
Windows development probe/immutable-runtime checks, final Rustfmt, changed
Markdown/JSON/fixture formatting and whitespace checks pass. Tools are Rust/Cargo
1.98.1, Node 24.20.0 and Git for Windows 2.55.0. Original-provider/device coverage,
public webhook deployment and the broader F01–F44/plugin gates stay open.

F27 host implementation is `e288679`, CLI/MCP/schema parity is `a325d52`, and
native HTTP acceptance is `19535e4`. Stable control assertions are `64e9ee7`;
cooperative shutdown, late-input fences and native cleanup acceptance are
`6fa12aa`. Publication CI for this source is a distinct gate; local green results
do not replace the retained failed evidence for earlier heads.

### Published external-trigger CI and delivery diagnostics

Run `39492826440` for `d7a1ad2` passed app/browser and all native Linux/macOS gates.
Windows passed units/build/Clippy and 52 of 53 serial native SDK cases. Its bound
job-cancellation scenario failed before cancellation: the occurrence remained
running with `instruction_not_sent` rather than reaching `needsValidation`.
That summary does not identify the delivery blocker and does not prove a
cancellation defect, quota issue, startup timeout or the older sharing error.

Failure-only bounded diagnostics now retain the exact occurrence/run/attempt,
delivery blocker, native phase/code/effect/submission stage and session readiness
metadata. They omit prompt, transcript, paths and raw provider errors. The seven
second wait and twenty second scenario budget remain unchanged. The focused
local Windows scenario passes with the expanded diagnostics in 6.68 seconds;
that local result does not erase the published failure or prove its cause.

### F44 typed provider observations and bounded refresh

Installed providers now have source/revision/freshness diagnostics through owner
`nesvo quota`, `nesvo_get_provider_quota` and doctor. Codex uses bounded full
read-only app-server snapshots, preserving account/context and nullable backend
permission privately. Claude retains the original quota-cache source timestamp;
regular-file checks and bounded reads reject special-file stalls. Gemini remains
explicitly unsupported rather than displaying invented usage. There is no new
dependency, global configuration mutation, auth RPC or model call.

Failures and unchanged reads advance attempt revision separately from last
success. Monotonic read-start bounds, cache-source age and a projected clock
high-water prevent rollback from reviving expired data. Incomplete or malformed
secondary windows cannot disappear into affirmative evidence. Owner refreshes
coalesce with periodic reads and have a five-second cooldown. Account/context
fingerprints use an ephemeral host-secret HMAC; raw identity/home/error content
is excluded from the published view. See the
[observation contract](harness-provider-quota.md).

Legacy quota wake now disarms on human acquisition, known reader identity/context
change and shutdown; native queue-trace regressions verify zero wake writes after
these fences. Failed observations do not refresh the old wake timestamp. The
public API explicitly describes reader evidence only: configured-account job
admission and durable receipt-backed quota continuation remain required F44 work.

Local Windows locked build, warnings-denied all-target Clippy and 574 units pass
(172 TUI, 399 host, 3 wire; five host helpers ignored). Both new native SDK/CLI/
private-host/controlled-RPC quota cases pass in 35.12 seconds: coalesced refresh,
cooldown, unchanged revision, failure-after-success freshness, malformed windows,
sparse notification timeout, privacy and scoped refusal. These do not establish
original-provider account binding or native-device/platform acceptance. Full
suite and publication evidence are recorded separately.

All 55 serial official-SDK/private-host/controlled-PTY/RPC cases then passed on
the same frozen Windows binaries in 469.41 seconds. This includes the previously
failing cancellation setup, both quota cases, restart/recovery, signed HTTP
triggers, exact command-scope cleanup and human-input fences. No test or native
failure path was dropped. The result is local evidence, not a cause determination
for the older Windows CI failure or acceptance of the new source on other OSes.

Provider observation/host fences are `dfe43d4`; shared CLI/MCP/schema support is
`23408f6`; native quota/scope acceptance is `003a613`. The separate cancellation
failure diagnostics are `78679bc`. Full F44/job dispatch and the complete goal
remain open.

All 30 host/sync/CLI Node cases passed serially against these same binaries in
89.21 seconds. Both Windows development-host probe and immutable-runtime tests
pass. Controlled status publication measured p95 251.062 ms, maximum 264.414 ms
from host receipt to snapshot enqueue; provider delay is excluded. Final fmt,
changed-file Prettier and whitespace checks pass. No original model or physical
device was used, and the new source's publication CI remains a distinct gate.

### F44 configured-account jobs and retained native admission

The observation checkpoint `57a70a1` completed all five publication CI jobs:
[39499001497](https://github.com/dkveil/nesvo/actions/runs/39499001497), including
Windows, Linux, macOS, browser and app. This does not identify the cause of the
older cancellation setup failure and does not validate the later changes below.

The owner can opt a Codex job into a configured-account quota queue using the
actual directory's inspected opaque context/account fingerprints. CLI/MCP share
the same policy, explicit capability and per-occurrence reauthorization. Route
inspection uses read-only account/config metadata and keeps independently useful
quota display when routing is unknown. Queued and retry-waiting jobs allocate no
precheck, attempt or Run while held; SQL filtering precedes the candidate limit.
Same-poll overlap siblings are rechecked inside the transaction.

Late holds preserve exact claims, precheck results, Run, launch receipt, reserved
session and already prepared workspace. Waiting releases dispatch/native-control
capacity; cancellation, timeout, frozen constraints, scope changes and retained
human takeover remain fences. Prepared workspace facts survive restart as unknown
evidence without automatic Git/native replay. Reader authority is process-local;
pending opted-in occurrences require explicit owner reauthorization after restart.
See [configured-account jobs](harness-quota-jobs.md) for commands and limitations.

This admission is a point-in-time configured-account observation. It is not an
immutable native-account lease or a promise that the original provider accepts
work. Claude cache admission, Gemini quota integration, legacy direct-PTY wake
migration and the remaining F01–F44/plugin gates stay open. No new dependency or
global provider configuration is introduced by this slice.

Local Windows verification passes 620 units (179 TUI, 438 host, 3 wire; five
special host helpers remain ignored), a locked workspace build and warnings-denied
all-target Clippy. All five focused official-SDK/private-host/controlled-RPC/PTY
quota scenarios pass in 63.64 seconds. They cover independent directory/account
bindings, queue fairness, failed observations, cancellation, immutable replay and
one retained worktree/receipt/session after the owner disconnects.

The first focused run exposed a Windows Git/native path alias mismatch during
the final worktree check. Reader keys now normalize the extended Windows path
form used by native validation to the same cwd passed to the CLI; a deterministic
regression and the unchanged native release assertion both pass. The initial
failure is retained as evidence rather than replacing that assertion with a looser
claim. Native timeout diagnostics retain allowlisted original receipt/launch/job
codes before cleanup without prompts, accounts or paths. No original model or
physical device was used for this acceptance slice.

The full serial SDK cohort passed 57 of 58 cases in 393.91 seconds; its sole
failure was the existing retry test's hardcoded 92-tool catalog assertion after
the catalog gained `nesvo_authorize_job_quota` (93 tools). Correcting that explicit
expectation, without changing native behavior or removing any assertion, passes
the complete failed scenario in 8.76 seconds on the same production binaries.
The original failed cohort is retained; this is combined per-scenario evidence,
not a claim that the original single invocation passed all 58.

All 30 serial host/sync/CLI Node cases pass in 45.26 seconds, the 23 client
protocol/control/replay cases pass, and both Windows dev-host probe/runtime tests
pass. Controlled publication measured p95 262.972 ms and maximum 263.057 ms from
host receipt to snapshot enqueue, excluding provider delay. Final all-target
Clippy, formatting and whitespace checks pass. Publication CI for this new source
is a separate pending gate; older `57a70a1` CI success is not substituted for it.

Configured-account host/storage/native support is `78587cc`; the shared CLI/MCP
policy and owner authorization are `da28b50`; actual contextual queue/worktree
acceptance and failure evidence are `28bbd0c`.

### F44 durable one-shot session continuation

The former quota status tick no longer writes directly to a PTY. Explicit owner
intent now persists one arm for the actual native launch/directory/home, opaque
reader/account binding, root conversation generation and human-control epoch.
A newer affirmative read must start after the frozen reset before one atomic
claim reserves one normal send receipt. Paste and Enter retain the standard
durable/live fences, native write confirmations and unknown-outcome behavior.
Current quota/editor evidence, semantic revision and human ownership are checked
at both writes. A late pause addresses the exact arm, never its replacement.
Restart pauses rather than restores authority; history and predecessor links
remain inspectable. See [quota wakes](harness-quota-wakes.md).

The predecessor's real prompt correlation remains retained until matching native
pickup of the continuation supplies its lifecycle sequence. It then becomes
interrupted with explicit linkage, never task success. A newer original program
status signal for work, permission, question or auth blocks input even if an old
quota banner remains visible. Two real traced-PTY State regressions verify zero
paste writes or exactly one confirmed paste without Enter, respectively.

Private Claude callback storage now accepts only the already-bound root launch
and current conversation generation, keeps independently optional typed windows
and replaces malformed/missing snapshots without storing raw payloads. Its own
receipt sequence and callback time cannot establish backend freshness, account
identity or permission. The user's statusline is not replaced. This is an
observation foundation, not completed Claude job/wake admission.

CLI/MCP share explicit read/enable/disable operations, a strict
`durableQuotaWake:true` gate and the additive 95-tool/schema contract. No visual
layout, global provider configuration or dependency changes were introduced.

Local Windows acceptance passed a serial 60-case official-SDK/private-host/
controlled-PTY/RPC cohort in 423.40 seconds on the first production freeze.
Subsequent exact-arm pause and generation-diagnostic hardening has separate
final-source evidence: 656 units pass (184 TUI, 469 host, 3 wire; five special host
helpers ignored), a locked workspace build, warnings-denied all-target Clippy,
and all seven quota SDK/native scenarios pass in 93.02 seconds. These include
configured account isolation, retained late worktrees, cancellation and both
new one-shot session cases. This distinguishes the full earlier cohort from the
focused final-source rerun instead of claiming a second full 60-case invocation.

All 30 serial Node host/sync/CLI cases passed in 45.90 seconds, all 23 client
contract/control/replay cases passed, and both Windows development-host probes
passed. Controlled publication measured p95 262.857 ms and maximum 263.197 ms
from host receipt to snapshot enqueue; provider delay is excluded. Formatting
and whitespace checks pass. No original model or physical phone was used.

One bounded read-only original Codex observation on an isolated host confirms
working account/context metadata and affirmative ordinary-usage permission,
but this account currently supplies only the weekly quota window. It remains a
partial snapshot: no five-hour threshold/reset or complete-window job eligibility
is invented. The probe created no managed session and issued no model, login or
authentication-refresh request. Original Claude's read-only auth status proves
its configured subscription route/home here, but supplies no individual account
identity; its statusline receipt is not a cold backend quota reader.

Publication CI for the preceding `e7571f0` source completed Linux/browser/app but
failed one identical initial context-A fixture assertion on both Windows and
macOS: `ordinaryUsageAllowed:null` before any job effect. The old fixture compared
lexical paths while the host canonicalizes cwd. It now resolves real filesystem
paths (and macOS Unicode normalization), with safe failure metadata. Local
Windows final-source acceptance passes the unchanged behavioral assertions.
The old logs do not prove which alias caused either failure, and new macOS/CI
acceptance remains a separate gate.

Claude callback support is `29a3ac9`; durable session/source/receipt fences and
their unit/PTY regressions are `f4073d3`; CLI/MCP parity is `6cf99b0`.
Controlled native session/fixture acceptance is `54c1a84`.
Claude/Gemini admission, original-provider continuation acceptance, job/mobile
presentation and the remaining F01–F44/plugin gates remain open. No whole-goal
completion is claimed.
