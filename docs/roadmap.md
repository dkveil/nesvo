# Approved prototype roadmap

Accepted by Damian on November 7, 2026. Target demonstration: November 16, 2026.
The product enables technical orchestration with visible workers and operator-controlled review.

P0, P1, the delivered Codex scope of P3 and P4 are accepted. D50 authorized Codex while the Claude quota blocks successful-task evidence in P2. D51 accepted the delivered P3 scope; D52 accepted P4 and authorized P5. P5 includes the delivered D55 English interface, compact views and intent-driven delegation refinement, awaiting owner acceptance. The missing Claude evidence stays in P2; acceptance is not a claim that this task succeeded.

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

Cursor, remote hosts/VPS, mobile control, automatic merge and a general plugin marketplace are deferred.
The prototype prioritizes operator satisfaction, visible control and a coherent working flow.

D60 authorizes P6.2: slash selection, one skill per message, native Codex invocation and persisted source attribution. The selected skill is verified again in the isolated execution process; unavailable selections fail without silently running an ordinary prompt. The supported Claude picker remains discovery-only until exact invocation is verified. The stage requires a real Codex task and owner review; it does not authorize P7 through P10.

P6.2 is delivered at 684558b and In Review in REV-275. The slash picker selects one native Codex skill per message; the host revalidates it before the provider turn and saves its resolved source in history. A real Windows task proved instruction delivery and persistence after application restart. Native application and unpacked-package scenarios passed independently on Windows, macOS and Linux using fixtures; see docs/platforms.md. Claude's supported picker remains discovery-only. Damian's acceptance is still required; later stages have not started.
