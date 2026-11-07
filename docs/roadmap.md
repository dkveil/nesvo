# Approved prototype roadmap

Accepted by Damian on November 7, 2026. Target demonstration: November 16, 2026.
The product enables technical orchestration with visible workers and operator-controlled review.

P0, P1, the delivered Codex scope of P3 and P4 are accepted. D50 authorized Codex while the Claude quota blocks successful-task evidence in P2. D51 accepted the delivered P3 scope; D52 accepted P4 and authorized P5. P5 is being refined after owner feedback D53. The missing Claude evidence stays in P2; acceptance is not a claim that this task succeeded.

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

P4 uses new read-only Codex orchestrators with a native delegation tool and at most two visible workers per run. The operator decides on each proposal before launch. Workers can use Codex or Claude capabilities already implemented; real P4 demonstration uses Codex while Claude remains quota-limited. Worker scopes stay within the parent directory, and overlapping writable directories are rejected. Stop on the parent cancels its group; Stop on a worker leaves its sibling running. Existing conversations keep their provider threads and do not acquire delegation silently.

Damian accepted P4 and authorized P5 in D52. Real Windows Codex execution demonstrated two concurrent workers, correct result attribution, independent child Stop and preserved history. See docs/platforms.md for separate automated native evidence.

P5 adds saved results with independent content versions and human decisions. The inbox shows the response, author, scope and a before/after workspace diff for writable runs. Corrections return to the same session and require a new acceptance. Prior dirty files are the baseline, not attributed to the new run. Read-only results are reviewed as responses; parent summaries reference exact child result versions. The host rejects stale decisions and never merges files. P5 ends with a separate owner review.

P5 implementation 32c1861 passed real Codex execution on Windows: a file change, inbox feedback, correction in the same thread, rejection of the old version, acceptance of version 2 and preserved decision after reload. Native application and unpacked-package checks passed independently on all three operating systems using fixtures. See docs/platforms.md and REV-270 for evidence. P6 has not started and waits for Damian's P5 acceptance.

D53 replaces the inbox detail screen with direct actions on compact rows. Each row identifies and links to the requesting session, briefly explains the action and exposes the appropriate decisions. Correction feedback expands inline. Full result versions, diffs and decision history live in the conversation. Existing operation and worker approvals remain distinct from result acceptance. This is a P5 refinement, not acceptance of P5 or authorization for P6.

P0 execution tasks: REV-266 baseline/master; REV-260 workspace/rules; REV-271 desktop/host/contracts; REV-262 launch/platforms.
Detailed checklists and evidence criteria are stored in each stage issue. P6 skill discovery also uses REV-261.

Cursor, remote hosts/VPS, mobile control, automatic merge and a general plugin marketplace are deferred.
The prototype prioritizes operator satisfaction, visible control and a coherent working flow.
