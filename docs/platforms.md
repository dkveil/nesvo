# Platform verification

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
