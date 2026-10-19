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

| ID  | Feature                                         | Baseline                                                      | Delivery / tests / commits         |
| --- | ----------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| F01 | OSC 7501 parser and host query responder        | Missing                                                       | Pending                            |
| F02 | Provider lifecycle adapters                     | Partial: Claude launch hooks; other providers screen hints    | Pending real provider verification |
| F03 | Status doctor and session explain               | Missing                                                       | Pending                            |
| F04 | Versioned detection rules and screen corpus     | Partial: hard-coded current-screen rules                      | Pending                            |
| F05 | Launch, conversation and event identity         | Partial: private launch report directory; wall-clock sequence | Pending                            |
| F06 | Evidence freshness and last-known state         | Partial: short hook/screen grace                              | Pending                            |
| F07 | Starting, readiness and timeout                 | Missing                                                       | Pending                            |
| F08 | Process, agent, turn, task and unread semantics | Partial: process exit and attention separate                  | Pending                            |
| F09 | Stable session CLI                              | Partial: TUI flags and list only                              | Pending                            |
| F10 | MCP over host operations                        | Missing                                                       | Pending                            |
| F11 | Visible child sessions                          | Missing                                                       | Pending                            |
| F12 | Scoped caller identity and agent instructions   | Missing                                                       | Pending                            |
| F13 | Fan-out with explicit worktree ownership        | Partial: individual worktree launch                           | Pending                            |
| F14 | Durable run/task/attempt DAG                    | Missing                                                       | Pending                            |
| F15 | Durable inbox and ACK                           | Missing                                                       | Pending                            |
| F16 | Resumable bounded event subscriptions           | Missing: terminal replay is not domain event replay           | Pending                            |
| F17 | Receipts, idempotency and correlated wait       | Partial: request IDs, no durable receipts                     | Pending                            |
| F18 | Attempt-bound worker result                     | Missing                                                       | Pending                            |
| F19 | Questions and decision gates                    | Missing                                                       | Pending                            |
| F20 | Worker budgets, cancellation and drain          | Partial: fixed eight-session limit                            | Pending                            |
| F21 | Once and recurring host jobs                    | Partial: host-owned once schedules                            | Pending                            |
| F22 | Timezone, cron/RRULE and DST                    | Missing                                                       | Pending                            |
| F23 | Missed-run policy and grace window              | Missing                                                       | Pending                            |
| F24 | Safe fresh/reuse session dispatch               | Partial: fresh launch with prompt                             | Pending                            |
| F25 | Bounded precheck                                | Missing                                                       | Pending                            |
| F26 | Delta-only coordinator wakeups                  | Missing                                                       | Pending                            |
| F27 | Authenticated webhook and GitHub triggers       | Missing                                                       | Pending                            |
| F28 | Durable job attempts, retry and overlap         | Partial: schedule result field                                | Pending                            |
| F29 | Shared needs-you and group rollups              | Partial: attention and shared snapshot                        | Pending                            |
| F30 | Stable attention/unread/MRU ranking             | Partial: palette and attention navigation                     | Pending                            |
| F31 | Contextual fuzzy search                         | Partial: session/group/command search                         | Pending                            |
| F32 | Incremental preview and process/turn times      | Partial: bounded replay and monotonic process age             | Pending                            |
| F33 | Revision-bound diff feedback                    | Missing                                                       | Pending                            |
| F34 | Verified session/turn edit provenance           | Partial: agent edit folder context only                       | Pending                            |
| F35 | Revision-bound checks and review readiness      | Missing                                                       | Pending                            |
| F36 | Trusted worktree setup/run/archive              | Partial: create worktree only                                 | Pending                            |
| F37 | Provider-aware launch profiles                  | Partial: templates                                            | Pending                            |
| F38 | Session-scoped MCP and skills                   | Missing                                                       | Pending                            |
| F39 | Isolated safe MCP pooling                       | Missing                                                       | Pending                            |
| F40 | Durable goal/progress checkpoint                | Missing                                                       | Pending                            |
| F41 | Layout, conversation and workflow recovery      | Partial: saved launch recovery records                        | Pending                            |
| F42 | Safe resumable hibernation                      | Missing                                                       | Pending                            |
| F43 | Mobile fleet, decisions and jobs                | Partial: existing mobile sessions/control                     | Pending                            |
| F44 | Trustworthy quota-aware dispatch                | Partial: usage cache and quota wake                           | Pending                            |

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
