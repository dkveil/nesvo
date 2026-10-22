# Testing

This document separates automated checks from physical-device testing. Unchecked scenarios remain unverified. A Chromium viewport test is not a native iOS keyboard or safe-area test. Recorded checks describe the tested behavior; recheck the relevant workflow and commit before reporting current CI results.

## Verified behavior — October 16, 2026

| Environment                        | Result                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / ESLint                | Passed with strict indexed access and import-layer rules                                                                                                |
| Expo dependencies                  | SDK 57 dependency alignment passed                                                                                                                      |
| Expo export                        | iOS, Android and web bundle exports passed; these are not signed native builds                                                                          |
| Client protocol tests              | Authentication replay, malformed messages, group navigation and control-lease lifecycle passed                                                          |
| Rust host unit tests               | Groups, SQLite revisions/reload, replay filtering and bounded queue behavior passed                                                                     |
| Real host integration, Windows     | Legacy authentication/PTY lifecycle and v2 multi-client synchronization passed                                                                          |
| Mobile web + real host             | Two Chromium clients: nested groups, session creation, shared output, takeover, move, reconnect and close passed                                        |
| Terminal renderer                  | ANSI/input smoke, bounded backpressure, canonical observer grid and query-response suppression passed                                                   |
| Rust TUI                           | Build, formatting, Clippy and unit tests passed locally on Windows                                                                                      |
| Ultraviolet brand                  | Shared geometry and frame tests passed; browser checks cover full-visor blink, 320px layout, session-name prefill and motion lifecycle                  |
| TUI launch form, Windows           | 22 unit tests, Clippy and build passed before workspace relocation; real PowerShell confirmed the selected folder and survived client detach            |
| Interactive TUI, Windows ConPTY    | Group/subgroup creation, real PowerShell input, two panes and detach passed                                                                             |
| TUI ↔ mobile web handoff           | A variable set in the TUI shell was read after mobile takeover and again after returning to TUI; mobile group rename appeared in TUI                    |
| Physical iPhone / Expo Go          | Launch, demo conversation, demo terminal and pairing form confirmed by user screenshots. Keyboard overlap was reported; corrections await device retest |
| Physical Android                   | Not tested                                                                                                                                              |
| iOS development build / TestFlight | No verified distribution                                                                                                                                |
| LTE/5G over private VPN            | Not tested                                                                                                                                              |

CI builds and tests the Rust programs natively on Windows, macOS and Linux. Check the relevant commit's workflow result before claiming a particular platform passed. A native CI build does not verify every interactive terminal emulator or a physical phone.

The per-push `Checks` workflow runs workspace tests with `cargo nextest run --workspace --locked --profile ci`. `.config/nextest.toml` terminates any single test after five minutes, and every job has a timeout. The ignored native cohort below runs only in the daily `Native nightly` workflow, which can also be started manually. It runs through nextest with the same profile, so a hung scenario ends after five minutes and the remaining scenarios still run.

### Declared statusline process conformance

Declared-display process tests spawn the `nesvo-process-fixture` helper, which they
build on demand, instead of PowerShell or a shell. The per-push run covers malformed
frames, reader cleanup and display byte/exit forwarding. Only the real Windows
PowerShell wrapper check stays ignored; `Native nightly` runs it serially:

```text
cargo test --package nesvo-host --bin nesvo-host --locked claude_statusline::tests::generated_windows_command_inherits_raw_standard_handles -- --ignored --exact --test-threads=1
```

Use this exact filter rather than selecting all ignored host tests: the host
target also contains opt-in provider probes and subprocess-holder entry points.
These controlled conformance checks invoke no model or authentication command.
They verify process and byte behavior, not performance under CPU saturation. The
serial `mcp_host` capture scenario separately checks the actual production helper,
root callback correlation and cleanup of a hanging declared display.

The capture case can also be selected directly after the locked native build:

```text
cargo test --package nesvo --test mcp_host --locked claude_quota_capture:: -- --ignored --test-threads=1
```

It runs the actual generated wrapper and human CLI against an owned private
host. Assertions cover unchanged display bytes/exit, rejected-payload attempt
receipts, missing journal with a readable failure sidecar, cleared live quota,
restoration of the original receipt clocks, a fresh accepted callback and
allowlisted human/JSON diagnostics. Only its validated temporary journal is
renamed; RAII attempts restoration before fixture teardown. These are controlled
provider/process checks, not an original-Claude lifecycle or model acceptance.

### Scoped automatic review context

After building the native host/client, select the actual-helper scenario with:

```text
cargo test --package nesvo --test mcp_host --locked scoped_review_context:: -- --ignored --test-threads=1
```

It creates private temporary Git repositories and invokes the production hook
from the controlled launch's actual settings. Owner diff requests verify both
the selected repository and its marker patch after external Edit/Write,
CwdChanged, rejected child/foreign callbacks, rebind and ABA invalidation.
Existing pinned-directory behavior is checked through the authenticated shared
wire codec because the current MCP diff tool omits that optional field. No model
or global Git/provider configuration is involved. Deterministic host storage and
Read-barrier tests separately cover callbacks delayed across generation changes;
the native scenario does not invent an observable pre-stdin helper barrier.

### Native repository search metadata

F31 repository metadata uses a separate Windows process-conformance check that
`Native nightly` runs. Run only its exact case; the same host test target also
contains inert, opt-in helper entries intended solely for its contained child
processes.

```text
cargo test --package nesvo-host --bin nesvo-host --locked git_repository::helper::tests::windows_waiting_helper_cancellation_contains_wrapper_descendants_before_releasing_capacity -- --ignored --exact --test-threads=1
```

The case enrolls a waiting helper before its first request byte, starts a real
owned wrapper and long-lived child, then cancels. The helper job must report no
active processes before the global inspector slot is released, and both exact
process handles must signal termination within the cancellation bound. Production
frames admit only two fixed metadata builtins; arbitrary fixture arguments and
helper entries exist only in the test binary. The native SDK case separately
exercises production helper stdout/early-main dispatch and the actual Git reads:

```text
cargo test --package nesvo --test mcp_host --locked repository_context::launch_repository_context_is_native_shared_and_refreshes_after_its_cooldown -- --ignored --exact --test-threads=1
```

Its private minimal unborn Git tree is constructed using fixed filesystem
fixtures, not `git init`, a model or injected host metadata. The actual host's Git
reads discover a nested Unicode launch directory and symbolic branch. CLI/MCP
agree before cooldown; a closed owner and reconnect cross one actual thirty-second
TTL, preserve the original process/cwd/receipt, then reveal the changed branch.
Revision and changed content prove refresh; wall-clock timestamp order is not a
monotonic guarantee. Uncertain SDK/helper cleanup stops the host while preserving
its private tree. These checks do not instrument every closed-client Git attempt
or establish physical-phone behavior. See [contract](harness-contextual-search.md).

For opt-in phase evidence before listener readiness and the controlled
fresh/restart scenario, see [host startup diagnostics](host-startup-diagnostics.md).
This evidence preserves the existing readiness deadline; an unmatched phase
does not identify the scheduling or I/O cause of a startup delay.

### Native job execution timeout scenarios

After building the native host/client, the ignored `mcp_host` integration target
uses the official MCP SDK, actual private hosts and controlled Node PTY workers.
It does not call a model or change user provider configuration. Run scenarios
serially; their private fixture teardown owns all created processes. The
`Native nightly` workflow runs the ignored scenarios daily and on manual
dispatch through nextest, one scenario at a time under the `ci` profile; the
commands below run them locally.

```powershell
cargo build --workspace --locked
cargo test --package nesvo --test mcp_host --locked job_timeouts:: -- --ignored --test-threads=1
cargo test --package nesvo --test mcp_host --locked -- --ignored --test-threads=1
```

The timeout scenarios cover CLI/MCP create/edit replay parity, approved prechecks
before arming, immutable deadlines after definition edits, worker exit while the
owner client is closed, preservation of an independent process, report disarming
while validation is pending, active human leases/drafts and quick takeover/release.
They check exact control/native receipts, one generation without retry, actual
owned process liveness, retained history and the published response schema.
Failures retain bounded phase/host/job diagnostics before cleanup. They read
through one owner MCP connection, at most four calls at a time, rather than a cold
CLI process per query, which exceeded a one-second bound on a loaded Windows
runner exactly when the evidence mattered. Each read is bounded only by the
adapter's documented request bound and records its own outcome (`observed`,
`refused`, `adapterRequestBound`, `transportUnavailable`); there is no per-call or
collection clock that would leave the evidence empty on a slow runner. They
complement the injected-clock and restart storage regressions; they are not
original-provider or native-phone acceptance. See the
[timeout contract](harness-job-timeouts.md).

### Waits without a clock of their own

A wait in the native cohort has no clock of its own. It ends on a host event: the
wanted state, or a terminal state that fails the wait at once with the settled
view. A native launch chain spans process creation, readiness hooks, delivery and
the worker's scoped CLI calls, whose duration depends on the platform, so the
host's own bounds (version probe, readiness, execution timeout, delivery
deadline, worker exit) bound it instead of a fixed per-wait window. The shared
helpers live in `apps/tui/tests/support/waits.rs`:

- `waits::until` polls one probe; `Ok(None)` is pending, `Ok(Some(_))` is the
  wanted state and an error is a terminal state that fails at once.
- `waits::occurrence` and `waits::history_occurrence` wait for a job occurrence
  state and fail once it settles (`succeeded`, `failed`, `skipped`, `canceled`).
- `waits::session` waits for `Ready`, `Released` or `Stopped`; readiness fails at
  once on `timedOut`, `exited` or a stopped process. `waits::output` and
  `waits::caller_file` wait for transcript or fixture evidence and fail once the
  writing session exits without it.
- `waits::receipt` waits for a send milestone (`delivered`, `received`,
  `started`, `settled`) by reading the receipt through `nesvo_get_operation`, with
  the host's own milestone rules, and fails at once on `failed`, `unknown`,
  `interrupted` or an earlier settlement. No long-held `nesvo_wait_prompt` with a
  guessed `timeoutMs` is used as a means; where its semantics are the subject
  under test it stays.
- `waits::delivery` waits for a task delivery phase and fails on another settled
  phase; `waits::provider` waits for the provider version probe and fails at once
  when it settles `unavailable` (the host bounds the probe itself).
- `waits::operation` makes a native create/send/interrupt/stop call. When the
  adapter's documented request bound expires (`timeout` without a receipt), it does
  not resend: it inspects the original idempotency key through
  `nesvo_get_operation` until the receipt leaves `accepted`/`dispatching`, and fails
  with the original timeout and the receipt if that settles `failed`, `unknown` or
  `interrupted`. `waits::cli` runs a CLI with no test clock, so the CLI's own
  connection and request bounds decide and its structured error is reported.

Tool calls never carry an extra test clock: an MCP call is bounded by the
adapter's documented per-kind request bound and a CLI call by the CLI's connection
and request bounds. Where one call can legitimately outlast that bound on a slow
runner, either the state is observed through a cheaper read first (a receipt or
session read instead of a held wait) or the documented recovery through the
original key decides; a timeout is never retried and never treated as success
without the receipt that proves it. Revision-conflict loops reread the revision
and continue only on `revision_conflict`. The fixed bounds that remain are
derived from host-published values (`deadlineAt`, due times, retry delays,
precheck budgets), absence windows (`holds_throughout`), documented product
bounds that the scenario asserts, cleanup confirmation after an explicit kill
and host startup readiness. Scenarios carry no outer time limit: every wait fails
on its own terminal state, so only a host that stops making progress without
settling anything reaches the CI step's `timeout-minutes`, which is then a real
defect rather than a slow runner.

The controlled-hold helper polls the exact reserved ID until the timed worker is
working. Its bound is the armed timer's published deadline, after which no hold
can precede the timeout, and it fails at once if the occurrence settles first.
Before physical creation, only the current structured MCP
`session_not_found` refusal is pending; other refusals, malformed messages,
foreign identities and transport errors remain failures. An ordinary regression
covers that boundary separately from the three native timeout scenarios.

### Native no-effect launch reconciliation

Retry scenarios retain their primary wait's exact occurrence/run/attempt/session
and original create-receipt pointers, successful-poll counters and pending-query
age even if a later read times out. Failure-only diagnostics use the already
authenticated MCP adapter, rather than starting additional diagnostic CLI
processes. Three reads run concurrently, followed by at most one correlated
attempt read; each is bounded by the adapter's documented request bound and
records its outcome. Only fixed state/identity fields and fixture-file presence
booleans are emitted. File presence is not completion proof. No prompt, path,
provider conversation, raw stderr or arbitrary nested adapter error is copied.
An adapter request bound does not protocol-cancel an already dispatched read-only
handler; the adapter's existing bounds/shutdown still own that work. A local metadata read
already running on the blocking pool likewise cannot be force-canceled.

```text
cargo test --package nesvo --test mcp_host --locked job_diagnostics::retry_evidence_tests -- --test-threads=1
cargo test --package nesvo --test mcp_host --locked job_retries:: -- --ignored --test-threads=1
```

Eight ordinary evidence tests cover retained pointers, pending-versus-completed
polls, scope mismatch, source-shaped turn IDs, delivery states, typed submission
fences and private-data exclusion. The successful native retry scenario also
checks the collector against its actual run, create receipt, session and task
delivery, without introducing an artificial acceptance timeout or another job.
The primary waits end on the occurrence state or a settled one, with no clock of
their own and no outer scenario limit. These observations distinguish boundaries; they do not by themselves identify the
cause of a historical retry delay.

The serial `mcp_host` target also includes `job_launch_reconciliation::`.

```powershell
cargo test --package nesvo --test mcp_host --locked job_launch_reconciliation:: -- --ignored --test-threads=1
```

One scenario creates a private Git repository with a required smudge filter.
After an approved precheck, the filter holds checkout until timeout cleanup owns
its claim, then fails checkout. The actual create receipt remains
`unknown/worktree_unconfirmed`: checkout may already have changed files. Owner
abandonment must refuse that evidence and retain occupied overlap. The filter
has its own five-second termination bound. Only repository-local Git
configuration changes; there are no injected native receipts or production
delay hooks.

The default-off job retry and run executor scenarios obtain their uncertain
worktree effect the same way, from a private repository whose required smudge
filter fails checkout. A folder outside Git cannot stand in for it: worktree
planning resolves the repository toplevel before any Git write, so that launch
is a proven no-effect `failed` receipt (`effectStarted:false`) that a
`launchNoEffect` policy retries.

A separate native scenario obtains actual `effectStarted:false` from failed
preflight validation. It checks owner digest/acknowledgment, CLI/MCP replay,
nonowner refusal, permanent generation retirement and an independent subsequent
worker. It does not establish that owner acknowledgment caused queue release:
an ordinary failed preflight can already be terminal. Storage regressions cover
the distinct late-known-no-effect/claimed-cleanup ordering and logical overlap
release. The native tests check preserved command/native receipts and avoid
manufactured exit proof. They use controlled PTYs, not original model calls.
See the
[launch reconciliation contract](harness-job-launch-reconciliation.md).

### Native CLI reply envelopes

Scenarios that run the real CLI against an isolated host pipe its `--json`
envelopes through `tests/fixtures/validate-harness-json.cjs`, which validates them
against `docs/harness-cli.schema.json`. Run these after a reply shape or exit-code
change:

```powershell
cargo test --package nesvo --test mcp_host --locked project_templates::project_and_template_cli_replies_match_the_published_schema -- --ignored --exact --test-threads=1
cargo test --package nesvo --test mcp_host --locked run_wakes:: -- --ignored --test-threads=1
cargo test --package nesvo --test mcp_host --locked run_checkpoints:: -- --ignored --test-threads=1
cargo test --package nesvo --test mcp_host --locked inbox:: -- --ignored --test-threads=1
```

`tests/tui.integration.test.ts` validates session query and operation envelopes
against the same schema. The project and template scenario launches one shell session in a private Git
repository with a committed `nesvo.toml`, then validates the `projects`,
`projectPinned`, `projectLayout`, `projectDefaults`, `workflowTemplates`,
`workflowTemplatesApproved`, `workflowTemplateStarted` and
`workflowTemplatesRevoked` replies. It starts the template as a draft run, so no
provider is launched. Reply kinds that no scenario prints are covered only by the
unit test `cli::reply_kind_tests::every_cli_reply_kind_has_a_published_schema_branch`,
which asserts that each kind a CLI command can print has a `data.oneOf` branch.

Initial native fixture startup retains a 60-second readiness deadline. On failure
only, `NATIVE_HOST_STARTUP_DIAGNOSTIC` records child status, stdout counters,
buffer occupancy and the presence/size of five fixed startup files. A dedicated
metadata thread has a one-second observation wait and cannot hold Tokio runtime
shutdown; owned-child kill/reap observation is bounded at two seconds. No pairing
keys, SQLite contents, prompt text or raw startup lines are sampled. Diagnostics
do not retry startup or establish the root cause of a timeout by themselves.

### Ultraviolet checks

`npm run test:brand` checks the shared palette, exact SVG-to-terminal glyph geometry and six-second motion timeline. `npm run test:brand:web` checks the rendered logo, full violet visor during blinking, session creation from the launchpad, narrow layout, reduced motion and animation suspension when hidden or offscreen. These checks run in CI alongside the existing application and terminal tests.

The branded TUI was captured from a real Windows ConPTY at 120×30 cells. The logo and controls fit; detach restored the cursor and terminal mode. Use `--no-animation` for a static logo. Unicode block appearance depends on the terminal font and cell proportions.

The start menu was also verified in an isolated Windows ConPTY: workspace entry, the Theme dialog, Pair mobile, F1 navigation, shell creation and Esc detach. Graphite persisted across a restart using private test preferences. Esc restored the alternate screen and cursor; a subsequent authenticated session listing confirmed that the shell remained on its host. The README image replays the captured ANSI output through a terminal renderer with custom block glyphs; it contains no private pairing data.

A subsequent native ConPTY check verified the compact workspace, F11 full-screen input, Ctrl+G navigation in full screen, and F11 restoration. The terminal keeps a one-line mode footer and a clickable accent-backed return handle. Esc restored the cursor and alternate screen while the shell survived. Unit tests cover the saved full-screen default, older preference files, hidden-pane geometry and preservation of default/ANSI colors; interactive macOS remains unverified.

On October 17, the updated Windows ConPTY check created a live PowerShell session in a private host and exercised the spaces/agents sidebar, tab strip, full-screen toggle, Ctrl+Q return to navigation, and Esc detach from navigation. The shell remained running, while the alternate screen and cursor were restored. TUI unit tests cover direct Escape forwarding to the shell and mouse hit testing for sidebar rows and tabs. The same interactive flow remains unverified on macOS; some terminal emulators may reserve Ctrl+Q before nesvo receives it.

The subsequent minimalist TUI pass used a fresh Windows ConPTY and private host to open the three-item start menu, change and persist the Graphite theme in Settings, create a PowerShell session through the keyboard form, return with Ctrl+Q, toggle and restore the focused view with `z`, and detach with Esc. A new authenticated listing confirmed the shell survived; alternate-screen and cursor modes were restored. Unit tests additionally cover nested group filtering, the combined group/subgroup form, agent-banner display inference, and the absence of a nesvo F11 binding. Agent-banner detection is a local display hint while the banner remains on the visible terminal screen; it does not alter the host's launcher identity or the terminal's own colors.

The latest mobile bundles include the SVG renderer and new icons. Expo Go can preview the app UI; installed application icons and splash behavior require a development or production build. The new theme and keyboard behavior still require a physical iPhone retest.

### What the synchronization tests prove

`tests/sync.integration.test.ts` uses a real host and separately authenticated clients. It verifies:

- Parent and child groups are visible on both clients.
- Invalid parents, hierarchy cycles, nonempty deletion and stale revisions are rejected.
- Same-name session creation is correlated by request ID.
- Session moves propagate without creating another process.
- Both viewers receive output; only the current private lease can input or resize.
- Explicit takeover and reacquisition invalidate older leases.
- A shell variable survives switching controllers and client disconnect.
- One connection can observe several sessions; unsubscribe stops that stream.
- SQLite preserves groups and revisions across host restart without inventing live processes.

`tests/live.browser.ts` exercises the corresponding UI with two browser contexts. It asserts passive input is read-only and verifies real command output using markers that do not appear contiguously in the input.

The renderer tests also verify that historical CSI/DCS queries cannot inject responses into the shell, while authorized live queries can. These tests cover the bundled xterm implementation; they do not prove complete compatibility with every CLI.

Switching focus between xterm and the app's command field no longer forwards terminal focus reports into the shell. The renderer regression covers that boundary, and the Windows two-browser live test verified complete PowerShell commands, takeover and reconnect after the change.

### Interactive TUI check performed

An isolated Windows ConPTY regression also verified the startup negotiation fix: the start menu opens, a newly created plain shell acquires available control, and its PowerShell prompt appears without pressing `i` or sending a command. Passive startup observation still sends no input and opening a session controlled by another device does not take over its lease.

The compact mobile browser regression verifies terminal-only sessions, reachable keyboard dismissal, retained command drafts, blur in both the command field and embedded terminal, and no horizontal overflow. It checks at least 220px of terminal height in a 390×440 viewport and 100px in a 320×300 viewport. These are layout checks, not native keyboard simulations.

The dashboard regression also checks bottom navigation between Sessions and Computers, an inset session switcher with bounded height, and the absence of dashboard tabs inside an open terminal. The modal now owns its safe-area context; notch and home-indicator spacing still require a physical iPhone retest.

A real Windows ConPTY hosted the TUI. The check created a group, subgroup and shell through keyboard forms, acquired control with `i`, assigned a PowerShell variable, and printed a marker. A mobile-size Chromium client attached to that same session, observed the marker, took control and read the variable. Renaming the subgroup in the mobile UI updated the live TUI tree.

The TUI then reacquired control, read the same variable, opened a second pane and executed another command. Ctrl+G followed by `q` restored the outer terminal. A new `--list` invocation confirmed both shells still running with no controller. This is an interactive Windows test, not a physical iPhone or interactive macOS test.

A separate isolated host verified the new launch flow: empty workspace, `p` pairing instructions, then `n` with a name, relative folder and Terminal program. The capabilities menu showed Terminal, Claude and Codex available and Gemini unavailable on that machine. PowerShell printed the selected folder; after `Ctrl+G`, `q`, a fresh `--list` still showed the process running with no controller. This did not execute an AI task or verify agent subscription login.

### Windows TUI performance diagnosis

Temporary timing instrumentation measured the same debug-build workload in Windows ConPTY: create a session, type a PowerShell command and print 60 lines. The measurements identified synchronous console operations, rather than terminal parsing, as the dominant local cost:

| Operation                             | Before                                             | After cached dimensions and batched frame output |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| Per-loop console size queries         | Median 16.5 ms, p95 44.2 ms; 11.8 s over 675 calls | Removed; initial query plus resize events        |
| Draw duration                         | Median 66.7 ms, p95 160.6 ms                       | Median 37.3 ms, p95 76.3 ms                      |
| Pure UI rendering in the updated draw | Not separately recorded                            | Median 0.79 ms, p95 2.21 ms                      |

These are diagnostic samples from one Windows environment, not an FPS guarantee or a cross-platform benchmark. The final implementation also avoids redraws for key releases, mouse motion and successfully forwarded input before host echo, and limits each network drain to a time budget. Those additional changes have regression coverage but are not included in the table's comparison. Profiling instrumentation was removed after measurement. The user still needs to retest perceived responsiveness in their terminal.

A later investigation found orphan Windows console backends after force-stopped fixtures and closure of sessions whose initial ConPTY cursor query had never been answered. Host shutdown now waits for tracked cleanup workers outside the state lock, and closing an unattached Windows session releases that startup handshake before termination. The updated host and synchronization integration runs completed without adding a console backend process; this is a lifecycle check, not a new rendering benchmark.

## Opt-in Windows input FIFO diagnostic

```powershell
cargo test -p nesvo-host --locked process::windows::tests::input_fifo_probe::native_conpty_input_fifo_diagnostic -- --exact --ignored --nocapture
```

This ignored diagnostic requires installed Node on PATH, an owned ConPTY and
private temporary files. It changes no provider configuration and invokes no
model. A bounded test-only trace records queue/write entry/completion metadata,
never input contents; ordinary binaries contain no trace channel or mutex.
The independent TCP child-readiness signal precedes the intended one-time
23-byte paste and decoder gate release. Cleanup uses the owned job and retained
process handles; an outer watchdog bounds the holder.

Inspect `scenario_attempted` and `outcome` in the emitted report. A missing
readiness/query precondition is an observation, not a successful reproduction or
proof that the suspected ordering cannot occur elsewhere. `WriteStarted` marks
the Rust call before `write_all`, not OS syscall entry. Native confirmation means
write/flush only, never provider pickup. The local Rust-helper and then silent
Node-helper observations both lacked readiness while the decoder was held;
neither attempted a paste. Both returned through owned cleanup. These results
do not establish a cause or fix for earlier job submission failures.

## Local checks

Run from the repository root. On Windows, `.cmd` avoids the PowerShell execution-policy issue.

```powershell
npm.cmd ci
npm.cmd run terminal:build
npm.cmd run dependencies:check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run test:architecture
npm.cmd run test:packaging
npm.cmd run test:brand
npm.cmd run test:client
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
npm.cmd run test:host
npm.cmd run test:sync
npm.cmd run test:tui
npm.cmd run export
```

For browser tests, start the Expo web preview first. Set `APP_URL` if it is not on port 8081. Use an installed Playwright Chromium or specify its executable:

```powershell
$env:APP_URL = 'http://localhost:8082'
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd run test:web
npm.cmd run test:create-session
npm.cmd run test:brand:web
npm.cmd run test:live
npm.cmd run test:terminal
```

Browser test screenshots and temporary pairing files belong in ignored `artifacts/`, never in Git. Do not share a pairing QR, key or private terminal content in reports.

The Rust workspace produces `target/debug/nesvo-host` and `target/debug/nesvo` (`.exe` on Windows). Integration tests use those workspace binaries, not the former per-application target directories. The Expo application is `apps/mobile`; use root forwarding scripts for normal checks and preview startup. Run direct Expo/EAS commands from that application directory.

Host fixtures opt into `--exit-on-stdin-close` and close their piped stdin during cleanup. This lets the host terminate its PTYs before exiting; forcefully terminating a Windows host can leave its console backend running. Cleanup has a deadline and reports failure instead of silently continuing after a forced stop. Normal interactive hosts retain their existing Ctrl+C shutdown behavior.

The README image in `docs/assets/` shows the native TUI in an isolated demonstration workspace. It contains no real project output or pairing credentials. For private mobile review captures, run `node scripts/capture-mobile-demo.mjs` with the web preview running. That script uses fictional data without connecting to a host and writes only to ignored `artifacts/`.

## External trigger boundary

After building both native binaries, run the real HTTP/owner CLI/official MCP SDK
and controlled-PTY scenarios serially:

```powershell
cargo test --package nesvo --test mcp_host --locked job_triggers:: -- --ignored --test-threads=1
```

The private host explicitly enables an ephemeral loopback listener; secrets reach
the bounded Node HTTP/crypto sender through stdin, never command arguments. Cases
exercise concurrent delivery replay, restart/rotation/revocation, signed GitHub
repository/event/branch filters, disabled sticky outcomes, and queue admission
through the existing job executor with the owner client closed. Actual JSON
responses are checked against the published output schema. Fixtures do not call
original models, register external webhooks or change global configuration.

Host units additionally cover raw HTTP framing, connection/body/header limits,
runtime listener availability, signature provenance, persisted retention/burst
limits, backward time, secret uniqueness and full-journal revocation. Unit/store
tests complement the native HTTP/dispatch cases; they do not replace them.

## Phone setup

1. Install dependencies and rebuild the terminal asset.
2. Run `npm.cmd start`.
3. Sign into the same Expo account in CLI and Expo Go. From `apps/mobile`, use `npx.cmd eas-cli@latest login --device` and verify with `npx.cmd expo whoami`.
4. Scan Expo's QR to open the mobile app.
5. In another terminal at the repository root, start `npm.cmd run host:lan -- --workspace PATH` with an existing workspace directory.
6. Ensure the phone can reach the advertised host address and port; start on the same Wi-Fi.
7. Scan the host's separate pairing QR inside the app.
8. Create or open a session and choose **Take over** (**Take control** to screen readers) before typing.

The app was aligned to Expo SDK 57 after an incompatibility report from the physical iPhone. Dependency checks and the iOS manifest verified the matching runtime. EAS project linkage and CLI sign-in were also verified. These infrastructure checks do not substitute for device interaction.

## Physical-device checklist

| Scenario            | Expected behavior                                                                                        | Verified |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| Launch / safe areas | Content clears the notch and home indicator                                                              | ☐        |
| Demo                | Sample content remains explicitly labeled                                                                | ☐        |
| Pairing / camera    | Permission, denial and manual JSON fallback are usable                                                   | ☐        |
| Invalid pairing     | Clear error; no shell is created                                                                         | ☐        |
| Groups / subgroups  | Create, rename, reparent and assign sessions; other client updates                                       | ☐        |
| Session launch form | Name, folder and available program choices work with the keyboard; invalid paths preserve a useful error | ☐        |
| Keyboard / composer | Input and send action stay visible; fields scroll above keyboard                                         | ☐        |
| Terminal typing     | Characters and Enter execute exactly once                                                                | ☐        |
| Editing             | Backspace, Unicode, arrows and Tab reach the intended shell                                              | ☐        |
| Ctrl+C              | Interrupts a harmless running command without closing the client                                         | ☐        |
| Keyboard hide/show  | Repeated transitions preserve input and layout                                                           | ☐        |
| Rotation            | Controller resize updates the host; observer does not resize it                                          | ☐        |
| Clipboard           | Short and multiline paste behave correctly for the active shell                                          | ☐        |
| Selection / history | Copying and scrolling do not accidentally send input                                                     | ☐        |
| VoiceOver           | Controls have useful labels and input can be reached                                                     | ☐        |
| Two sessions        | Output and input stay isolated while switching                                                           | ☐        |
| Takeover            | Other device becomes read-only and stale input is rejected                                               | ☐        |
| Background / lock   | Host continues work; foreground return reauthenticates                                                   | ☐        |
| Network loss        | Disconnection is visible; input is not queued or replayed                                                | ☐        |
| Reconnect           | Existing process and available output remain accessible                                                  | ☐        |
| Stop / shell exit   | Correct session ends; other sessions continue                                                            | ☐        |
| Host restart        | Groups persist; old processes are not reported as running                                                | ☐        |
| Computer sleep      | Unreachable host is reported honestly                                                                    | ☐        |

The keyboard fix adjusts top safe-area compensation, shrinking terminal space, modal safe areas and pairing-form scrolling. Browser compact-height regressions pass, but the original iPhone screenshots require a new device check.

## Agent CLI compatibility

- [ ] Start an installed `claude`, `gemini` or `codex` from the launch picker using its existing subscription login.
- [ ] Run a small task and handle a prompt or approval in the terminal.
- [ ] Switch sessions, return, and verify alternate-screen and Unicode rendering.
- [ ] Transfer control between TUI and phone during a running task.
- [ ] Record any redraw needed after late attachment.
- [ ] Confirm the app never asks for an AI API key or presents demo conversation as live output.

This uses the user's real subscription limits. No provider login automation or universal CLI compatibility is assumed.

## Remaining platform checks

- [ ] Android keyboard, paste, system Back, camera, rotation and reconnect.
- [ ] Native SecureStore restore and forgetting a host.
- [ ] Interactive macOS/Linux TUI, signals and platform keyboard behavior.
- [ ] Full-screen programs and high-output reconnect across all renderers.
- [ ] LTE/5G and Wi-Fi transitions after private VPN configuration.
- [ ] Development build / TestFlight installation, signing and device behavior.

## Report template

```text
Commit:
Date:
Phone and OS:
Expo Go / development build / TestFlight:
Host OS and terminal emulator:
Network: LAN / VPN / other
Scenario and steps:
Expected behavior:
Actual behavior:
Reproducible:
Attachment with pairing secrets and private terminal content removed:
```
