# Approved prototype roadmap

Accepted by Damian on November 7, 2026. Target demonstration: November 16, 2026.
The product enables technical orchestration with visible workers and operator-controlled review.

P0, P1, the delivered Codex scope of P3 and P4 are accepted. D50 authorized Codex while the Claude quota blocks successful-task evidence in P2. D51 accepted the delivered P3 scope; D52 accepted P4 and authorized P5. P5 includes the delivered D55 English interface, compact views and intent-driven delegation refinement, awaiting owner acceptance. The missing Claude evidence stays in P2; acceptance is not a claim that this task succeeded.

Current delivery: D62 P7 is implemented and In Review for Damian. The dated and numbered entries below retain prior delivery history; later explicit decisions supersede earlier stage restrictions. Native evidence and the remaining local fixture-cleanup observation are recorded in docs/platforms.md.

[Authoritative roadmap](https://linear.app/reveil/document/nesvo-zatwierdzona-roadmapa-prototypu-7-16112026-387e254e033d)
and [decision register](https://linear.app/reveil/document/nesvo-rejestr-decyzji-wlasciciela-przed-roadmapa-2026-11-07-729784d12add).

| Stage | Target | Deliverable                                                       | Owner acceptance                           | Issue                                              |
| ----- | ------ | ----------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| P0    | Nov 8  | Workspace, desktop/host foundation, contracts, tooling and rules  | Start project and approve structure        | [REV-259](https://linear.app/reveil/issue/REV-259) |
| P1    | Nov 8  | Session list, chat, delegation space and inbox layout             | Approve navigation and base UI             | [REV-267](https://linear.app/reveil/issue/REV-267) |
| P2    | Nov 9  | Real Claude session, streaming, Stop and conversation persistence | Complete a real small task                 | [REV-268](https://linear.app/reveil/issue/REV-268) |
| P3    | Nov 10 | Codex, model choice and actual provider permissions               | Use both providers, approve and deny       | [REV-269](https://linear.app/reveil/issue/REV-269) |
| P4    | Nov 11 | Visible delegation to up to two workers                           | Approve, observe and stop a worker         | [REV-272](https://linear.app/reveil/issue/REV-272) |
| P5    | Nov 12 | Review inbox, summary, diff and revision-bound acceptance         | Request correction and accept its revision | [REV-270](https://linear.app/reveil/issue/REV-270) |
| P6    | Nov 13 | Provider-aware skill discovery and use                            | Use a known skill in real work             | [REV-275](https://linear.app/reveil/issue/REV-275) |
| P7    | Nov 14 | Durable history, relations and review recovery                    | Reopen and continue review safely          | [REV-273](https://linear.app/reveil/issue/REV-273) |
| P8    | Nov 14 | Native packages for three operating systems                       | Receive separate runtime evidence          | [REV-264](https://linear.app/reveil/issue/REV-264) |
| P9    | Nov 15 | Full demonstration rehearsal and fixes                            | Complete the flow independently            | [REV-274](https://linear.app/reveil/issue/REV-274) |
| P10   | Nov 16 | Pinned demonstration version and instructions                     | Accept version for demonstration           | [REV-277](https://linear.app/reveil/issue/REV-277) |

Dates are delivery targets, not permission to skip acceptance or silently reduce scope.
Every stage waits for Damian's acceptance of the previous stage unless he explicitly authorizes an exception, as recorded for P3 in D50. Corrections stay within the current stage.
Provider modes are based on real capabilities; never simulate unsupported features.

P4 originally used explicitly selected read-only Codex orchestrators with a native delegation tool and at most two visible workers per run. D55 removes that role prerequisite for new Codex sessions while retaining permissions and operator approval. Workers can use Codex or Claude capabilities already implemented; real P4 demonstration uses Codex while Claude remains quota-limited. Worker scopes stay within the parent directory, and overlapping writable directories are rejected. Stop on the parent cancels its group; Stop on a worker leaves its sibling running. Existing conversations keep their provider threads and recorded delegation capabilities.

Damian accepted P4 and authorized P5 in D52. Real Windows Codex execution demonstrated two concurrent workers, correct result attribution, independent child Stop and preserved history. See docs/platforms.md for separate automated native evidence.

P5 adds saved results with independent content versions and human decisions. The inbox shows the response, author, scope and a before/after workspace diff for writable runs. Corrections return to the same session and require a new acceptance. Prior dirty files are the baseline, not attributed to the new run. Read-only results are reviewed as responses; parent summaries reference exact child result versions. The host rejects stale decisions and never merges files. P5 ends with a separate owner review.

P5 implementation 32c1861 passed real Codex execution on Windows: a file change, inbox feedback, correction in the same thread, rejection of the old version, acceptance of version 2 and preserved decision after reload. Native application and unpacked-package checks passed independently on all three operating systems using fixtures. See docs/platforms.md and REV-270 for evidence. P6 has not started and waits for Damian's P5 acceptance.

D53 replaces the inbox detail screen with direct actions on compact rows. Each row identifies and links to the requesting session, briefly explains the action and exposes the appropriate decisions. Correction feedback expands inline. Full result versions, diffs and decision history live in the conversation. Existing operation and worker approvals remain distinct from result acceptance. This is a P5 refinement, not acceptance of P5 or authorization for P6.

The D53 refinement at ed8a1f7 passed real Windows Codex execution for inline file approval, result correction and acceptance, exact session links and history after reload. Native application and unpacked-package scenarios passed independently on Windows, macOS and Linux. Updated screenshots and evidence are in REV-270.

D54 delivers a further P5 visual refinement: a flat black workspace, compact sidebar and header, a focused empty-session composer and restrained panels. The inline decision flow and saved result details remain intact. The desktop scenario passed on Windows during the refinement; the final layout at a9c6b2d passed a focused visual check including normal and compact dialogs, drafts, inline feedback and session links. P5 is In Review and still requires owner acceptance; no later stage is authorized by these visual references.

P0 execution tasks: REV-266 baseline/master; REV-260 workspace/rules; REV-271 desktop/host/contracts; REV-262 launch/platforms.
D55 is a P5 correction, not a new stage. The application defaults to English, presents compact decision rows and moves routine diagnostics on demand. New Codex sessions start without a role choice; a valid worker proposal makes orchestration visible without changing access permissions. A writable parent may delegate read-only workers only until isolated workspaces exist, preserving attribution of file changes. Unsupported proposals are rejected explicitly rather than silently downgraded. P5 is In Review for this correction; P6 remains unstarted.

D56 records the owner's need for visible agent activity and a clearer diff viewer. D57 authorizes both a persisted per-turn activity timeline and a saved-result diff side panel together as a P5 refinement, with one final owner review. The timeline uses actual provider events with terminal timestamps and bounded history. The side panel identifies the exact saved result version, with file navigation and numbered changes. Both are delivered at 6399a3d, with real Windows Codex evidence and separate native application/package checks on all three operating systems. Live working-tree diffs remain outside this package. P5 is In Review; P6 has not started.
Detailed checklists and evidence criteria are stored in each stage issue. P6 skill discovery also uses REV-261.

D58 extends P5 with a read-only session file explorer: on-demand directories, bounded filename search, current text preview, refresh and navigation back to an exact saved result diff. It does not add file editing or a live working-tree diff. P6 remains Backlog: provider-aware discovery, selection and a verified skill invocation are not yet implemented. The installed Codex protocol exposes skills/list and skill turn input, which is a foundation to investigate in P6 rather than evidence of a working Nesvo skill flow.

D59 explicitly authorizes P6.1 discovery after the file explorer delivery. The session Skills panel lists names, descriptions, sources and reported or declared availability, with filtering and refresh. Codex uses its native skill catalog under the session isolation profile. Claude uses bounded local metadata inventory without launching its CLI, with unverified provider availability and incomplete sources stated explicitly. Discovery does not execute skills or modify configuration. P6.2 invocation and its real-task acceptance remain separate, unimplemented work.

P6.1 is delivered at 653ad2d and In Review in REV-261. Actual Windows discovery and separate native application/package checks on Windows, macOS and Linux passed; see docs/platforms.md. P6 remains In Progress because invocation and its owner acceptance are still pending.

Cursor, mobile control, automatic merge and a general plugin marketplace are deferred. D63 below supersedes the earlier deferral of remote hosts/VPS.
The prototype prioritizes operator satisfaction, visible control and a coherent working flow.

D60 authorizes P6.2: slash selection, one skill per message, native Codex invocation and persisted source attribution. The selected skill is verified again in the isolated execution process; unavailable selections fail without silently running an ordinary prompt. The supported Claude picker remains discovery-only until exact invocation is verified. The stage requires a real Codex task and owner review; it does not authorize P7 through P10.

P6.2 is delivered at 684558b and In Review in REV-275. The slash picker selects one native Codex skill per message; the host revalidates it before the provider turn and saves its resolved source in history. A real Windows task proved instruction delivery and persistence after application restart. Native application and unpacked-package scenarios passed independently on Windows, macOS and Linux using fixtures; see docs/platforms.md. Claude's supported picker remains discovery-only. Damian's acceptance is still required; later stages have not started.

D61 extends P6 with the owner-authorized common local library. Both providers see supported Claude, Codex and shared sources, with physical deduplication, origin labels and explicit incompatibility reasons. Codex retains native invocation through process-local extra roots; Claude receives a validated static snapshot labeled Shared instructions. Selected content hashes are revalidated, session permissions stay unchanged and user configuration is never rewritten. The earlier D60 Claude discovery-only limitation is superseded by this explicit instruction-delivery mode, not by native Claude invocation. Real Windows Codex use of a Claude-source skill passed; real Claude success is still blocked by the weekly account limit. Delivery and platform evidence are recorded in docs/platforms.md and REV-275.

D62 explicitly authorizes P7 after the owner reviewed its goal: reopen the app and safely continue the same work. The stage restores the last session/Inbox and saved-diff location, keeps durable conversation/worker/review identities and explains host shutdown, host recovery and provider disconnection. A data directory has one host owner. There is no automatic replay; continuation requires a new operator message in the existing provider thread. Review retry identity survives restart. P8 through P10 remain separate stages, and successful real Claude evidence remains open independently.

P7 implementation and regression checks at 1ef58dd passed the existing host cases and native application/package scenarios separately on Windows, macOS and Linux. Real Windows Codex demonstrated parent/worker and pending-review recovery, acceptance retry and deliberate continuation in the same thread after closing an active session. The latest saved worker group takes precedence over earlier parent review dependencies. Local fixture cleanup remained intermittently unstable; targeted probes and an instrumented full scenario did not reproduce it, so its cause is not claimed as fixed. Screenshots, evidence and the explicit observation are in REV-273. P7 is In Review. D63 separately authorizes the next remote-host stage without changing P7's owner-review status.

## D63: Local and VPS extension

The owner authorized this extension before P8 on November 8. Local stays the default and uses its existing lifecycle. A Linux host owns its provider processes and state independently of desktop connections. Reconnecting reads current state without replaying messages, decisions or Stop. A session and all its workers stay on one host; accounts, files and skills are not copied between machines.

| Stage | Delivery                                                    | Owner review                                                        |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| R1    | Independent host, private channel and reconnect             | Disconnect during worker execution, recover the same run and result |
| R2    | Computers, host routing and unified Inbox                   | Use two hosts without mixing sessions or decisions                  |
| R3    | SSH with identity verification and installation preparation | Exercise connection failures and recovery in an isolated setup      |
| R4    | Actual VPS installation and provider login                  | Complete real work after disconnecting the desktop                  |

R1 is In Review: transport fc280cd, integration 48542bb, documentation de6cf4e. Linux Docker and native Ubuntu CI passed the reconnect/worker/approval scenario; Windows passed local checks and the existing built-desktop scenario. See docs/platforms.md for exact evidence and limits. Subsequent stages require owner acceptance. P8 through P10 follow this extension; November 16 remains the demonstration target. Cross-host delegation, session migration and repository/skill synchronization remain deferred. No actual VPS has been supplied yet. Runtime fixtures and CI evidence must not be presented as proof on that VPS.

Linear rejected a new R1 issue because the workspace issue limit was reached. R1 status and evidence are tracked in the project discussion and approved roadmap document, without repurposing unrelated issues.

D64 authorizes continuing R2 and R3 without intermediate acceptance pauses after the owner's explicit instruction on November 8. Computers, host-specific routing, SSH verification and installation preparation form the next delivery. Keep separate evidence and small commits; final owner review still applies. R4 requires an available VPS and does not authorize a purchase, credential copying or global SSH configuration changes. This supersedes the earlier R2/R3 pause requirements.

R2 and R3 are delivered and In Review at runtime 5dfba75, with the focused remote scenario at 72f46f1. Computers preserves Local as the default, routes sessions/files/skills/decisions by host and combines their Inbox. Verified SSH attaches to an existing private Linux daemon. Offline history survives reopening; reconnect refreshes newer authoritative state without replay. The service-unit generator and installation instructions are ready. Actual Windows-to-Linux SSH and separate native desktop/package checks on Windows, macOS and Linux passed; see docs/platforms.md. R4 remains pending an available VPS, its installed provider accounts and real systemd/logout evidence. Final owner acceptance is still separate from these checks.

## D65: Provider limits and accounts

The owner authorized a narrow left rail for current Claude Code and Codex subscription limits, with an account icon below. The delivery reads each selected computer's native account/usage metadata without model turns, shows remaining allowance and reset times, and distinguishes unavailable, stale and offline observations. The account panel exposes the reported identity and plan without adding login management or billing. Claude's experimental capability must fail visibly if unsupported. This stage does not widen R4 or require another server. Implementation is delivered at 3ef253f, da74148 and c0afdd3; existing host/desktop coverage is extended at 7e5fb3f. Platform and actual-provider evidence are recorded separately in docs/platforms.md. Owner review remains required.

## D66: Mobile companion before the demonstration

The owner approved M1 through M3 as one continuous delivery on November 8, with a single final review after emulator testing. This supersedes the earlier mobile deferral. M1 adds Expo, explicit device pairing and computer/session selection; M2 adds authoritative history, activity and reconnect; M3 adds messages in existing conversations, Stop and one-time operation/worker decisions. Full file editing, a mobile diff workspace, push notifications and store distribution remain deferred. The phone controls work on existing hosts and does not run provider CLIs. Reconnect never retries a mutation automatically.

The clean mobile workspace is apps/mobile-client. Shared Zod contracts define a narrow authenticated gateway; tokens can be revoked, external connections require TLS, and emulator development uses loopback only. The main mobile scenario must run on an actual Android emulator, with screenshots and separate fixture/real-provider evidence. iOS, physical devices and an actual VPS must not be claimed without their own execution evidence. REV-263 tracks implementation and REV-276 tracks the complete mobile acceptance scenario. P8 through P10 remain the final packaging, rehearsal and demonstration stages.

M1 through M3 are implemented with small checkpoints through c20ca03, with the native Android scenario at d8b3365. The current connection uses a running Desktop gateway for Local and already-connected SSH computers; a standalone VPS mobile gateway is not included. Setup is in docs/mobile.md and separate fixture, real Codex and platform evidence is in docs/platforms.md. Final owner acceptance remains required.
