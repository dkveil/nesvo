# Platform verification

## D66 mobile companion

M1 through M3 add an Expo React Native companion in `apps/mobile-client`, an authenticated workspace gateway and desktop device controls. Runtime checkpoints are 35b1ad5, 1445169 and 332388e; 4f67812 and f87b55b refine the Android keyboard and post-send scrolling. Setup and deployment boundaries are in [mobile.md](mobile.md).

Windows passed the final strict typecheck, ESLint, Prettier, build, the existing host checks and the complete built-Electron desktop scenario with Electron 45.2.3 / Node 24.22.2. The Linux-only daemon case is explicitly skipped locally. [Foundation CI at c20ca03](https://github.com/dkveil/nesvo/actions/runs/42486970936) passed on Ubuntu, including all host cases. The new single transport case uses actual HTTP/WebSocket clients and checks one-use pairing, private token hashes, pinned gateway identity, authentication, forbidden commands, persistence and durable revocation.

Focused Android 16 / API 36 emulator checks through Expo Go SDK 58 passed pairing, history, visible nonterminal output, operation approval and denial, worker decisions, gateway disconnect while provider processes stayed alive, reconnect without extra turns, Stop with both provider and descendant gone, cold app restart, SecureStore restoration, device revocation and removal of the exact connection. The owned Nesvo_D66 AVD is separate from user emulators. The native scenario is tracked at d8b3365.

The final uninterrupted Android automation attempt did not pass: after all steps through Stop succeeded, its cold-launch step left the Android launcher in the foreground while Expo Go remained alive, with no recorded crash. Cold restart, saved credentials, revocation and exact connection removal passed in a separate focused native run. These combined functional results are not reported as one uninterrupted smoke pass. The remaining observation concerns Expo Go foreground launch in the emulator harness; it does not establish a production-app cause.

A separate native Android run used installed Codex 0.156.0 with model gpt-6-sol and the existing login. A message sent from the phone asked it to read tasks.txt; the response correctly reported five tasks and two pending. Exactly one operator message, the returned activity and unchanged file bytes were verified. Controlled-provider screenshots and test results remain distinct from this successful real task. The real task precedes c20ca03's inspection-shutdown adjustment; the later focused and regression checks cover that adjustment.

An early Android scenario reproduced the pre-existing Windows process-closure failure. Temporary tracing showed successful taskkill and closed pipes but no child exit notification. Commit c20ca03 allows healthy, completed inspections to end stdin and wait up to 300 ms for actual closure before the unchanged forced cleanup. A focused built-Electron check verified metadata, an approved operation and active Stop with both provider and descendant gone. Installed Codex metadata closed normally after EOF without a model turn. Production instrumentation was removed. This avoids the observed abrupt inspection shutdown; it does not establish an upstream cause or promise that every hard-kill path is immune.

The delivery uses a running Desktop as the gateway to Local or already-connected SSH hosts. External access requires trusted HTTPS; the emulator uses loopback HTTP through ADB reverse. No standalone VPS mobile gateway, physical-device/TLS deployment, iOS runtime, app-store build or mobile saved-result review is claimed. Screenshots and the final review record are in the [D66 acceptance document](https://linear.app/reveil/document/d66-nesvo-mobile-m1-m3-odbior-2026-11-08-6507212751ba). Owner acceptance remains separate.

## D65 provider limits and accounts

The metadata readers, validated per-host route and compact account rail are delivered at 3ef253f, da74148 and c0afdd3. Existing host/desktop scenarios are extended at 7e5fb3f; 568ad02 adds usage isolation assertions to the existing SSH scenario. These checks use controlled provider responses, not real account access.

Windows passed strict types, ESLint, Prettier, build, both existing host cases and the complete built-Electron desktop scenario. Usage checks cover account metadata, reported percentages/reset times, concurrent request coalescing, cache reuse, no model turns, process cleanup, unchanged history and unavailable data after restart. A separate actual SSH run to an isolated Linux daemon passed different Local/remote usage responses and rejected an offline request without reconnecting. Existing remote work/review/recovery assertions and owned cleanup also passed.

An independent Windows read through the built Electron application used installed Claude Code and Codex with their existing sign-ins. Both returned real account metadata and quota windows without prompts or model tasks. The observation at approximately 12:52 Europe/Warsaw on November 8 reported Claude weekly usage at 100%, a model-specific weekly window at 27%, and Codex weekly usage at 58%. These are timestamped observations, not current availability guarantees. Public evidence omits account identities. Claude's experimental native usage capability remains version-dependent; this successful metadata read does not close P2's pending successful-model evidence.

The final pacing correction cce3d0b passed strict types, scoped lint/format, build and both Windows host cases again. A focused scratch check of the actual service with controlled time and provider stubs verified concurrent coalescing, independent 30-second/four-minute cache boundaries, five-to-sixty-minute failure backoff, success reset and abort. No permanent unit-test suite was added. Screenshots and sanitized real metadata are in the [D65 acceptance document](https://linear.app/reveil/document/d65-limity-dostawcow-i-konto-odbior-2026-11-08-636753a48e10). Owner acceptance remains separate.

[Foundation CI at cce3d0b](https://github.com/dkveil/nesvo/actions/runs/42478888118) passed on Ubuntu, including all three host cases. The [native workflow at 7e5fb3f](https://github.com/dkveil/nesvo/actions/runs/42477813284) passed the complete application and unpacked-package scenario separately on macOS and Linux. Windows passed installation, check and build, but both attempts failed before Electron launch while downloading the Windows Electron archive with HTTP 504. The workflow is therefore failed; local Windows desktop evidence is separate, and no D65 Windows packaged-runtime pass is claimed. Native package results precede cce3d0b's pacing correction, whose checks are recorded above. This infrastructure failure was not worked around by changing dependency versions or weakening tests.

## R2 and R3 computers and SSH

D64 connects Local and prepared Linux computers through separate desktop routes. Implementation commits 20647b7, 77d9b83, b803865 and 26da03c cover the renderer, service preparation, SSH boundary and connection manager; 5dfba75 rejects executable paths that systemd cannot accept.

Local Windows passed strict types, ESLint, Prettier, build, the two existing host cases and the principal built-desktop scenario using Electron 45.2.3 / embedded Node 24.22.2. The Linux-only daemon case is explicitly skipped on Windows. [Foundation checks at 5dfba75](https://github.com/dkveil/nesvo/actions/runs/42460828848) passed on Ubuntu, including all three host cases.

[Native checks at 5dfba75](https://github.com/dkveil/nesvo/actions/runs/42460828744) passed separately on Windows, macOS and Linux: clean installation, check, build, the principal desktop scenario, packaging and the same scenario against the unpacked application. [Foundation checks at 72f46f1](https://github.com/dkveil/nesvo/actions/runs/42461542772) passed with the added remote test harness included in lint. Runtime code is unchanged after 5dfba75; subsequent changes add evidence, documentation and that opt-in scenario.

A separate focused Windows scenario at 72f46f1 uses actual native OpenSSH, an isolated Linux Docker SSH server and Node 24.20.0 daemon under UID 1000. The repository mount is read-only; keys, verified known-hosts file and desktop profile are temporary. Unknown and changed server keys are rejected. Sessions, file reads, skill catalogs and Inbox decisions target the correct host; Local state remains independent. Remote workers and pending approvals survive client disconnect and app restart. A second bridge stops a worker while the desktop is detached: its cache stays unchanged until reconnect restores the exact newer terminal revision and messages. Configuration pins and offline snapshots persist, reconnect does not replay provider turns, and removal leaves the daemon running. Controlled provider fixtures do not use real accounts. Owned resource cleanup passed.

The service-unit generator is checked by the real systemd parser, including supported literal path characters and rejection of unsupported executable names. This is syntax evidence, not a running systemd service or a logout/reboot test. An actual VPS, provider login and persistent-service acceptance remain R4 and require an available server. The SSH client was exercised on Windows; native desktop/package results on other systems are recorded separately.

## R1 independent Linux host

D63/R1 transport code fc280cd and the focused integration at 48542bb separate daemon ownership from detachable clients. The Linux scenario passed locally in Docker with Node 24.22.2, UID 1000, no network and a read-only repository mount. Real Unix sockets, SQLite and controlled provider processes verified a worker surviving detach, stable run/approval/review identities, offline completion, private reply routing, malformed connection rejection, competing data/runtime owners, live foreign socket preservation and explicit daemon shutdown/restart without replay.

[Foundation CI at de6cf4e](https://github.com/dkveil/nesvo/actions/runs/42458523910) passed on Ubuntu with pinned Node 24.20.0: all three host cases, strict types, lint, formatting and the complete build. Local Windows passed `bun run check` with the two existing cases and an explicit Linux-only skip for the daemon case, plus `bun run build` and the principal built-Electron desktop scenario. That scenario used Electron 45.2.3 / embedded Node 24.22.2 and existing Claude/Codex delegation fixtures. No new macOS or unpacked-package run is claimed for R1.

This evidence does not establish successful model execution, SSH authentication, systemd/logout persistence or operation on an actual VPS. R1 adds no desktop Computers view. R2, R3 and R4 retain their separate owner reviews. R1 is In Review; its project discussion and approved Linear roadmap carry status because the workspace issue limit prevented creating an R1 issue.

## P7 history and recovery

D62 implementation and regression checks at 1ef58dd preserve conversation, parent/worker, native-thread and review identities after reopening. The last session/Inbox and exact saved-diff file are restored as local navigation preferences. One Electron instance and one host own each data directory. Host shutdown, startup recovery and provider disconnection remain distinct from operator Stop or confirmed provider failure. Opening the app never replays work or decisions; continuation requires a new message.

Windows passed strict types, ESLint, Prettier, build and the same two host integration cases. The added boundaries cover exclusive data ownership, transport EOF, partial output after provider EOF, exact review-decision retry, completed children beside an interrupted parent and the newest child group taking precedence over older parent review dependencies. External changes to that group's writable result block acceptance. Existing filesystem checks honor both count and time budgets and require an explicit time-limit reason for early truncation.

Two separate built-Electron checks used installed Codex 0.156.0 and gpt-6-sol on Windows. The first completed a visible parent/worker task, reopened the pending Inbox, accepted a child result, reopened again and repeated its saved decision without another turn. It then closed an active session and continued the same native thread after a new message. One initialization encountered a provider routing failure during a network outage; preserved data and a deliberate new message allowed that part to continue. A final lifecycle recheck at ee5bd0a repeated interruption and same-thread continuation after the process-cleanup correction. Source files and sampled provider configuration remained unchanged during that recheck. Screenshots and both evidence records are attached to REV-273. Their sample plan is test material, not a platform readiness report. No successful real Claude task is claimed.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42429731090) passed. The [native application and unpacked-package workflow](https://github.com/dkveil/nesvo/actions/runs/42429552873) passed separately on Windows, macOS and Linux at 1ef58dd. Each platform ran the host cases and the principal desktop scenario in both forms, with explicit provider fixtures. A subsequent CI-only change increased the job ceiling from 15 to 20 minutes after a Windows run approached the old ceiling; provider deadlines were not increased.

Local Windows fixture runs intermittently reported unconfirmed provider-process closure at different steps, despite passing real Codex execution and all native runners. Targeted probes passed 100 utility-only file operations and 25 operations through the actual renderer. A subsequent principal scenario with temporary lifecycle tracing and production taskkill descriptors also passed, including full restart, exact saved-diff location, review retries, no automatic turns and owned cleanup. These non-reproductions do not establish the cause or eliminate the intermittent failure. Temporary diagnostics were removed; the process boundary keeps an unconfirmed close as a failure rather than fabricating success. This remains an explicit observation for owner review, not a claimed fix.

P7 is In Review in REV-273. Unsent drafts remain transient, and hard OS termination does not guarantee containment of already orphaned descendants. P8 through P10 and successful real Claude evidence remain separate.

## P6 shared local skill library

D61 implementation and checks at ed800b4 combine known local Claude, Codex and shared roots into one provider-aware library. Windows passed strict types, ESLint, Prettier, build, the same two host cases and the principal desktop scenario. The scenarios cover both cross-provider directions, source and hash persistence, changed-file rejection, physical deduplication, unsupported metadata behind aliases or shared-only roots, Stop during preparation and existing approval/review/delegation flows.

A separate built-Electron Windows task used installed Codex 0.156.0 with gpt-6-sol and a controlled skill from .claude/skills. The response applied its requested format and included a unique code present only in the skill body. Selected origin, delivery and hash survived a full application restart. Sample files and sampled provider configuration files remained unchanged.

One real Claude Code 2.1.319 / Haiku attempt selected a .codex/skills file through the explicit Shared instructions mode. It stopped at the account's weekly limit, reported by the CLI as resetting at 20:00 Europe/Warsaw. Fixture checks establish the instruction wrapper and selected resume; they do not establish a successful real Claude response. This remains open in P2 and the P6 acceptance evidence.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42425603561) passed. The [native application and unpacked-package workflow](https://github.com/dkveil/nesvo/actions/runs/42425603288) passed independently on Windows, macOS and Linux. Native platform scenarios use provider fixtures; real cross-provider model evidence remains Windows Codex-only. The superseded run at ef2f4ca exposed an ambiguous test query on macOS; ed800b4 makes the selected fixture source unique before keyboard input without changing product behavior.

Screenshots and real-evidence.json are attached to REV-275. Their sample plan is test material, not a report of Nesvo platform readiness. D61 is In Review for Damian; later stages remain separate. The D60 discovery-only limitation for Claude below describes the earlier stage and is superseded by explicit Shared instructions, not native Claude skill execution.

## P6.2 native skill invocation

Implementation 684558b connects the slash picker to explicit native Codex skill input. Windows passed strict types, ESLint, Prettier, build, the same two host cases and the principal desktop scenario. The checks cover disabled or stale selection rejection before thread creation, source persistence, selected resume, message idempotency, Stop during validation, keyboard selection, per-session drafts and existing approval/review/delegation flows. A focused compact-window check also verified identical slash reopening and preservation of trailing task text.

A separate built-Electron task on Windows used installed Codex 0.156.0 with gpt-6-sol and a controlled project skill in read-only mode. The model reviewed a sample plan and returned the format and unique code present only in the skill body. The application preserved the exact messages, resolved source and provider thread after a full restart. Sample files and sampled provider configuration files remained unchanged. The plan shown in screenshots is test material, not a statement about Nesvo platform readiness. Claude availability probing used a fixture; no successful Claude model task is claimed.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42418919155) passed at 684558b. The [native application and package workflow](https://github.com/dkveil/nesvo/actions/runs/42418918823) passed host checks, built-application execution and unpacked-package execution independently on Windows, macOS and Linux. These checks use provider fixtures; the real skill task above is Windows-only. Screenshots and real-invocation-evidence.json are attached to REV-275. P6.2 is In Review for Damian; successful checks do not constitute owner acceptance. The supported Claude picker remains discovery-only.

## P6.1 skill discovery

Implementation 653ad2d delivers native Codex skill discovery and a bounded Claude filesystem inventory through the session Skills panel. Windows passed strict types, ESLint, Prettier, build, the same two host integration cases and the principal desktop scenario. Checks cover provider metadata, disabled entries, unsupported/malformed replies, isolated configuration, no model-turn requests, independent Stop, refresh and late responses after switching sessions. Final cosmetic metadata changes received a focused visual check.

A separate built-Electron check on Windows read installed Codex and actual Claude skill files for the repository session. Codex returned 154 enabled entries (153 personal, one system); Claude returned 109 local entries with unverified availability and explicit incomplete-source issues. Counts describe this session context, not a fixed global catalog. The check covered search, source paths, compact layout and Escape focus. No session messages or model tasks were created; sampled Codex and Claude configuration files stayed byte-identical. Claude availability probing used a fixture, while its skill inventory read real files. This is discovery evidence, not skill-execution or successful Claude model-task evidence.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42415396734) passed at 653ad2d. The [native workflow](https://github.com/dkveil/nesvo/actions/runs/42415396668) separately passed host checks, built-application execution and unpacked-package execution on Windows, macOS and Linux. Native checks use provider fixtures and isolated skill metadata. Screenshots and the real discovery record are attached to REV-261. P6.1 is In Review for Damian; P6.2 invocation remains unimplemented.

## P5 read-only file explorer

D58 implementation 975b61e adds a session-scoped directory tree, bounded filename search and current text preview alongside exact saved result diffs. Windows passed strict types, ESLint, Prettier, build, the existing host cases and the principal desktop scenario. After a real repository check exposed search starvation, breadth-first traversal and filtering unrelated files before metadata access reduced the sample query from 3005 to 1644 ms and included the sibling package. Partial scans remain explicit. The focused principal host case passed again with the sibling-under-cap assertion.

A separate built-Electron visual check read actual repository source files on Windows, including nested navigation, filename search, syntax/line numbers, compact layout and Escape/focus return. It used provider availability fixtures and launched no model task. Screenshots and evidence are attached to REV-270. The principal scenario additionally verifies current content after an outside edit and an unchanged historical saved result when switching panels.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42412678718) passed at 975b61e. The [native workflow](https://github.com/dkveil/nesvo/actions/runs/42412678233) ran the host checks, built application and unpacked package separately on Windows, macOS and Linux; all runtime checks passed. These are real filesystem and Electron checks with provider fixtures, not new real-provider or skill evidence. The earlier workflow at 853af7f was superseded after the search correction. P5 is In Review; P6 skill discovery, selection and verified invocation remain unimplemented.

## P5 durable activity and saved diff panel

D57 delivers both refinements at implementation checkpoint 6399a3d. Windows passed strict types, ESLint, Prettier, build, the existing host integrations and the principal desktop scenario. The scenario covers actual provider event frames, Stop/reload timing, exact historical result versions, numbered changes, selected files, keyboard focus and compact layout. A targeted retention check covers the latest 100 items per run, global 300-item retention, explicit omitted-history markers and late updates for evicted items.

A separate Windows run used the built Electron app, installed native Codex, gpt-6-sol and existing login. It read two files, edited their status and task counts, then verified them. Five native activities were persisted. Activity IDs and timestamps, the provider thread and the exact saved diff survived renderer reload. An unrelated file stayed unchanged, the correct result was accepted, and owned processes and temporary data were cleaned up. Screenshots show this real run; scenario screenshots and CI use explicit fixtures. No real Claude success is claimed while the existing account limit remains unresolved.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42409855720) passed. The [native workflow](https://github.com/dkveil/nesvo/actions/runs/42410069676) separately passed checks, built-app execution and unpacked-package execution on Windows, macOS and Linux at 6399a3d. Desktop distributions include the saved-diff viewer's dependency license notices. Subsequent commits update documentation only. P5 is In Review for Damian; P6 has not started.

## P5 English interface and intent-driven delegation

D55 removes the role picker for new root Codex sessions, preserves access permissions and derives the orchestrator role from a valid worker proposal. The interface and current host-generated messages default to English. Compact inbox rows keep the requesting session, a concrete action summary and decisions together; connection diagnostics are available on demand.

Local Windows passed strict types, ESLint, Prettier, build, the existing two host cases and the expanded principal desktop scenario. The first desktop attempt found a stale exact-text selector after the history label was compacted; the corrected scenario passed with the persisted-decision assertions intact. Final visual checks covered a standard window, a compact dialog, retained drafts, inline feedback and exact result navigation. These screenshots use explicit provider fixtures.

A separate Windows test used the standalone Node host, installed Codex 0.156.0, gpt-6-sol and the existing login. Creation omitted the role field. The supervised parent proposed one read-only worker and became an orchestrator without changing permissions; no child existed before approval. The approved worker correctly read a random marker and counted five tasks. The parent returned that result and continued the same native thread in a follow-up. The input file remained unchanged, host shutdown returned zero and the isolated directory was removed. This proves the host/native-provider boundary, not a real-provider Electron run. Writable parents can currently delegate only read-only workers until workspace isolation exists.

Implementation checkpoint 611fb93 passed [foundation checks](https://github.com/dkveil/nesvo/actions/runs/42407313200). Separate [native application and unpacked-package checks](https://github.com/dkveil/nesvo/actions/runs/42407312931) passed on Windows, macOS and Linux. Each OS ran the host checks and the principal desktop scenario in both the built application and the unpacked package, using explicit provider fixtures. Real Codex account evidence remains Windows-only. D56 activity-history and diff-viewer work is a researched follow-up requirement, not part of the implemented D55 feature set. P5 still requires Damian's acceptance; P6 has not started.

## P5 visual refinement

D54 updates the existing workspace without changing providers, host execution or permissions. The black shell, compact navigation, centered empty-session composer and quieter decision panels are in commits 0fe1f19 and a9c6b2d.

Windows passed desktop type checks, scoped ESLint, repository formatting and the build. The existing desktop scenario passed during the visual refinement, including operation approvals, worker decisions, correction, exact session links, reload and process cleanup. Final spacing and copy were then checked in the built app at a9c6b2d: the new-session dialog fits a standard window without scrolling, a compact window can reach the submit button, the empty composer retains its draft, and inline feedback and the session link work. Screenshots use explicit provider fixtures, with no model-account invocation. No new unit tests or host cases were added.

This visual revision was inspected on Windows only. The separate macOS/Linux application and package evidence below applies to the earlier D53 implementation; it is not a claim that the latest appearance was checked there. P5 remains subject to Damian's acceptance and P6 has not started.

## P5 inline action refinement

D53 replaces the inbox detail screen with session-linked rows and direct decisions. Local Windows passed type checks, ESLint, Prettier, build and the adapted desktop scenario. The scenario verified operation and worker decisions while another session was selected, exact result links, inline corrections, old-version controls and acceptance history after reload. Existing host checks are unchanged.

A separate Windows run with installed Codex and gpt-6-sol completed native file approvals directly from the list, the initial text change, feedback entered beside its row, correction in the same provider thread, version 2 acceptance and preserved history after renderer reload. Session links opened the correct saved version, including the historical result. An unrelated file was unchanged. Selected real-run screenshots and JSON evidence are attached to REV-270; fixture screenshots remain separate.

[Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42402718927) passed at ed8a1f7. [Native application and unpacked-package checks](https://github.com/dkveil/nesvo/actions/runs/42402720155) passed independently on Windows, macOS and Linux at the same implementation. Each OS checked the full desktop scenario in the built app and unpacked package with explicit provider fixtures. Real account evidence is Windows-only. P5 still requires Damian's acceptance.

## P5 result review

Damian accepted P4 and authorized P5 in D52. P5 remains subject to his separate acceptance.

On Windows, installed Codex 0.156.0 with the existing login and model gpt-6-sol completed a real Electron flow in an isolated non-Git directory. It changed note.txt from the existing baseline to Status: draft and Owner: Damian. The saved version 1 contained the actual before/after diff. Operator feedback through the inbox resumed the same provider thread and changed only the first line to Status: ready. Version 2 started pending with its own incremental diff; version 1 retained the correction decision. Accepting version 1 was rejected. Version 2 was accepted through the UI and retained its decision after renderer reload. An unrelated file remained unchanged. Native file-operation approvals were exercised separately from result acceptance. Screenshots and the recorded run are attached to REV-270.

Local Windows passed strict types, ESLint, Prettier, build, both host integration cases and the expanded desktop scenario. The selective checks cover correction idempotency, old-version rejection, dirty baseline preservation, external edits, incomplete binary diffs, parent/worker result references and durable decisions. Independent host review found and corrected missing dependency fingerprint checks and lost child references on parent correction; both have focused regression coverage inside the existing host cases.

The [foundation checks](https://github.com/dkveil/nesvo/actions/runs/42399007104) passed at implementation 32c1861. The [native application and unpacked-package checks](https://github.com/dkveil/nesvo/actions/runs/42399013114) passed independently on Windows, macOS and Linux at that same implementation. Every platform ran the two host cases and the full desktop flow in both the built app and the unpacked native package. These checks use explicit provider fixtures. Real account execution is verified on Windows only; successful Claude work remains open in P2. P5 is ready for Damian's review; automated acceptance of a sample result is not his acceptance of the stage.

## P4 visible delegation

Damian accepted the delivered Codex scope in P3 and authorized P4 in D51. Successful Claude task evidence remains in P2. He accepted P4 and authorized P5 in D52.

Windows real-account evidence uses installed Codex 0.156.0, the existing login and model gpt-6-sol through Electron. The first group proposed two workers, created no child before approval, ran two workers concurrently and returned A=42 and B=17 from separate temporary files. The parent attributed both results correctly. The next turn resumed the same parent thread and again ran two workers. Stopping worker A through the UI left worker B able to finish with B=17; the parent reported A as stopped rather than successful. Both runs retained conversations and relationships after reload.

A separate real native protocol check confirmed dynamic-tool invocation both on a new thread and on resume. Existing threads are kept without silently adding tools. Local Windows passed strict types, ESLint, Prettier, build, two host integration cases and the expanded desktop scenario. The process cleanup guard also passed the host cases. Screenshot evidence and the real run results are attached to REV-272.

The [native application and unpacked-package checks](https://github.com/dkveil/nesvo/actions/runs/42395148521), at implementation 1a769aa, passed independently on Windows, macOS and Linux. Each OS passed the two host cases, built desktop scenario and unpacked-package scenario. [Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42395149152) passed at the same revision. These fixtures validate lifecycle, decisions and UI; they do not establish real account availability on macOS/Linux. Real Claude work remains unverified while its account is limited. No native check or real automated run substitutes for Damian's P4 acceptance.

## P3 Codex integration

Damian authorized Codex before Claude quota recovery (D50). That exception did not accept either stage; he later accepted the delivered Codex scope and authorized P4 in D51. The missing successful Claude evidence remains open in P2.

On Windows, installed Codex 0.156.0 with the existing ChatGPT login and model gpt-6-sol passed real Electron execution: read a temporary file and correctly counted five tasks, retained the same provider thread after reload and answered the follow-up with two remaining tasks, and stopped an initialized real run. A separate supervised conversation produced native command approvals. Declining left the named temporary file absent; accepting a new one-time request created that exact file with the expected content. Both outcomes were checked on disk, not inferred from the model's response.

The actual native tool executor remains enabled; MCP servers, plugins, hooks and hidden delegation are disabled for this stage. Native approvals identify the local environment as `local`; unknown remote environments are rejected. These native observations are covered by the adapter and the focused integration fixture.

Local type checks, ESLint, Prettier, build, both host integrations and the main desktop scenario passed. The final P3 [native application and unpacked package run](https://github.com/dkveil/nesvo/actions/runs/42392369277), at 7003660, passed Windows, macOS and Linux with explicit fixtures, including the local-environment approval adjustment. [Foundation checks](https://github.com/dkveil/nesvo/actions/runs/42392369244) also passed at the same implementation revision.

Real account execution was verified on Windows only. Native runner fixtures do not certify real provider setup or account access on macOS/Linux. Claude successful-task evidence remains pending its account reset, independently of the later P3 Codex acceptance.

## P2 Claude integration

P1 was accepted on November 7 when Damian authorized P2. The P2 implementation is available for inspection; a successful real model task and owner acceptance remain pending.

Local Windows passed type checks, ESLint, Prettier, the build, both host integrations and the full desktop scenario with the explicit CLI fixture. The actual installed Claude Code 2.1.319 was then exercised through Electron using the existing account: initialization selected claude-opus-5-5, its weekly-limit error remained visible after reload, and Stop ended a separately initialized real CLI turn with status stopped.
The account reported a reset at November 8, 20:00 Europe/Warsaw. No successful model answer or real-provider conversation continuation is claimed. Provider-independent streaming and restart/resume passed with the fixture.

The first native run passed Linux. Windows and macOS exposed fixture path comparisons involving short Windows names and macOS temporary-directory aliases; the checks now canonicalize their temporary roots. The corrected [native desktop and package run](https://github.com/dkveil/nesvo/actions/runs/42389661881), at e421257, passed Windows, macOS and Linux. Each runner checked the built application and the unpacked native package using the explicit CLI fixture.

Windows process-tree Stop was checked with a live descendant. Containment of descendants orphaned before cleanup, or after abrupt host termination, is not guaranteed; this is separate from the verified graceful Stop/shutdown path.

## P1 workspace preview

P0 was accepted when Damian authorized P1. Damian later accepted the initial P1 layout before P2 began.

Implementation 4b9475c passed [native desktop and package checks on Windows, macOS and Linux](https://github.com/dkveil/nesvo/actions/runs/42383138729), as well as [foundation checks](https://github.com/dkveil/nesvo/actions/runs/42383139075).
The single desktop scenario covers navigation, session creation, drafts, the sample inbox and compact panels. Local Windows also passed the unpacked package scenario.
Windows screenshots were visually inspected and attached to REV-267. The final sidebar header spacing adjustment was checked locally.
The subsequent dark appearance refinement passed local Windows type, lint, desktop build and the same desktop scenario. Five Windows views were visually inspected: conversation, review, creation, compact navigation and worker approval. This refinement uses dark native chrome, flat navigation and session details on demand; the native evidence above applies to the earlier implementation.
All provider and review content in P1 remains demonstration data; these checks do not certify real agent execution.

## P0 foundation evidence

P0 separates automated native evidence from the owner's acceptance of the completed product.

| Platform    | P0 evidence                                                                                                                        | Remaining acceptance               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Windows x64 | Local development launch, build, host integrations, Electron smoke, native package and child shutdown passed; clean CI also passed | Damian's P0 acceptance             |
| macOS       | Native runner: clean installation, checks, build, desktop execution, package execution and child shutdown passed                   | Owner access and visual acceptance |
| Linux       | Native runner with Xvfb: clean installation, checks, build, desktop execution, package execution and child shutdown passed         | Owner access and visual acceptance |

Verified toolchain: Bun 1.4.0, standalone Node 24.20.0, Electron 45.2.3 with embedded Node 24.22.2.
The platform workflow checks the foundation on separate Windows, macOS and Linux runners and retains unpacked artifacts.
Runner execution is not a claim that Damian has personally tested the application on that OS.

Evidence for implementation commit d715552, recorded November 7, 2026:

- [Foundation checks: passed](https://github.com/dkveil/nesvo/actions/runs/42381004036).
- [Native checks on all three platforms: passed](https://github.com/dkveil/nesvo/actions/runs/42381038496).
- Each native job ran both the build and unpacked package through the same desktop scenario.
- Local Windows also passed with the development renderer served by Vite.

P8 remains responsible for complete product flows in native packages on each platform: sessions, Stop, history and review.
P0 does not certify provider installation, signing, distribution or the future agent workflow.
