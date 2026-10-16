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

### Ultraviolet checks

`npm run test:brand` checks the shared palette, exact SVG-to-terminal glyph geometry and six-second motion timeline. `npm run test:brand:web` checks the rendered logo, full violet visor during blinking, session creation from the launchpad, narrow layout, reduced motion and animation suspension when hidden or offscreen. These checks run in CI alongside the existing application and terminal tests.

The branded TUI was captured from a real Windows ConPTY at 120×30 cells. The logo and controls fit; detach restored the cursor and terminal mode. Use `--no-animation` for a static logo. Unicode block appearance depends on the terminal font and cell proportions.

The start menu was also verified in an isolated Windows ConPTY: workspace entry, the Theme dialog, Pair mobile, F1 navigation, shell creation and Esc detach. Graphite persisted across a restart using private test preferences. Esc restored the alternate screen and cursor; a subsequent authenticated session listing confirmed that the shell remained on its host. The README image replays the captured ANSI output through a terminal renderer with custom block glyphs; it contains no private pairing data.

A subsequent native ConPTY check verified the compact workspace, F11 full-screen input, Ctrl+G navigation in full screen, and F11 restoration. The terminal keeps a one-line mode footer and a clickable accent-backed return handle. Esc restored the cursor and alternate screen while the shell survived. Unit tests cover the saved full-screen default, older preference files, hidden-pane geometry and preservation of default/ANSI colors; interactive macOS remains unverified.

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

## Phone setup

1. Install dependencies and rebuild the terminal asset.
2. Run `npm.cmd start`.
3. Sign into the same Expo account in CLI and Expo Go. From `apps/mobile`, use `npx.cmd eas-cli@latest login --device` and verify with `npx.cmd expo whoami`.
4. Scan Expo's QR to open the mobile app.
5. In another terminal at the repository root, start `npm.cmd run host:lan -- --workspace PATH` with an existing workspace directory.
6. Ensure the phone can reach the advertised host address and port; start on the same Wi-Fi.
7. Scan the host's separate pairing QR inside the app.
8. Create or open a session and choose **Przejmij sterowanie** (take control) before typing.

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
