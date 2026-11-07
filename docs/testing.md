# Selective testing policy

Damian explicitly chose limited testing for prototype delivery. Protect meaningful behavior without filling the repository with repetitive tests.

## Required checks

- TypeScript strict, ESLint and Prettier are the routine baseline.
- Test critical boundaries when their behavior changes: process lifecycle, validated messages, persistence, cancellation, permissions and revision-bound review.
- Prefer integration tests with real local resources over mocks of implementation details.
- Keep one principal desktop scenario and extend it only when the accepted product flow requires it.
- Review visual and low-risk copy changes manually. Do not add unit tests solely for JSX, styles, wrappers or getters.
- No coverage percentage, mandatory unit-test count, one-test-per-function policy or large component snapshots.

Current checks:

| Check                            | Evidence                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Host lifecycle integration       | Migration, identity, persistence, streaming, resume, approvals, delegation, Stop and cleanup |
| Schema compatibility integration | Newer database refused and version preserved                                                 |
| Desktop scenario                 | Electron/preload/host/database path, decisions, worker tree, reload and group shutdown       |

Tests use dedicated temporary directories and no provider accounts. They must not operate real project data or existing agent processes.
The desktop smoke scenario can run against either build output or an unpacked package.

P2 extends the same two host cases and the same desktop scenario. A local CLI fixture checks analysis flags and stdin, streams text, retains a resume marker, emits provider errors and spawns an owned child for cancellation checks. The host scenario verifies that partial text precedes completion, repeated message IDs do not start another turn, Stop stays responsive, failed results never become completed, restart restores history, unfinished runs recover as interrupted, and shutdown cleans the process tree.
The desktop scenario covers model selection, default and invalid directories, session-specific drafts, real IPC streaming, history after reload, continuation, Stop, visible provider failures, empty inbox, search and compact panels. It runs against both build output and unpacked packages. No unit-test suite or visual snapshot baseline was added.
Real CLI evidence is recorded separately. The fixture is not proof of subscription availability, successful model output or provider resume behavior. A provider account limit leaves real task acceptance pending even when all automated checks pass.

P3 extends these same checks with an explicit Codex app-server fixture: dynamic models, streaming and resume, provider-specific sandbox policies, session/run/request-bound approval and denial, stale decision rejection, and cleanup while waiting for approval. Denial must leave the fixture's operation marker absent; acceptance must create it only for the intended request. A version-two Claude snapshot must retain its history after migration. The desktop scenario exercises provider selection and real approval UI through the same preload/host boundary.

P4 extends the same two host cases and one desktop scenario. The fixture validates native dynamic-tool metadata and resume, returns actual child results to the parent, and runs two independently tracked worker processes with streaming output. Checks cover absence of children before approval, accept/decline, stale decisions, proposal limits, directory and symlink escape, overlapping writes, recursive tool rejection, correct success/failure attribution, child Stop with a live sibling, parent/pending cancellation, group shutdown and persisted relationships. Migration keeps existing Claude and Codex conversations without silently enabling delegation. The desktop flow exercises proposal buttons, child navigation, two live workers, Stop and compact layouts. Once an owned process is confirmed gone, its PID is retired from later cleanup checks to avoid confusing Windows PID reuse with a leak.

Real P4 evidence separately uses installed Codex through Electron, including two concurrent workers and parent continuation after one worker is stopped. Fixture success is not real-provider evidence. Native tool execution on Windows does not certify real account access on macOS or Linux.

P5 keeps the same two host cases and one desktop scenario. Focused additions exercise immutable result versions, human-only decision commands, idempotent correction, stale acceptance, parent dependency invalidation and history after restart. A supervised fixture actually changes text files in an isolated non-Git directory; its before/after diff must include the intended added/modified/deleted files while preserving unrelated dirty contents. External edits and unavailable binary diffs block acceptance. The desktop flow performs correction and acceptance through the inbox and checks the historical decision. Real Codex execution is a separate deliberate run, not a routine formatting check.

D53 adapts that same desktop scenario to decisions directly on inbox rows. It exercises operation and worker decisions while a different session was selected, then verifies the intended run changed and the unrelated conversation did not. Result links open the exact saved version inside its session. Inline feedback, correction, acceptance from the list and history after reload retain their existing evidence. No new unit tests or host test cases are added for this interface refinement.

D55 extends these existing checks for intent-driven delegation. Creation omits the role field; a valid proposal promotes a new Codex root without changing its permissions. A supervised parent can run a read-only worker, while a writable-worker proposal is rejected before creating a child. Existing native threads retain their identity and recorded capabilities. The desktop scenario uses the English interface, checks the absence of the role picker, accesses diagnostics on demand and keeps the existing cross-session decision and review assertions. Visual spacing and copy receive a focused visual check, not new unit tests.

## Before reporting completion

Run bun run check and bun run build for foundation changes.
Run bun run smoke:desktop when a desktop or host transport/lifecycle change affects that path.
After packaging, run the same scenario with NESVO_PACKAGED_EXECUTABLE set to the executable.
Run a focused regression check after a fix. Do not rerun unrelated suites without a new reason.

Record OS, commit, command and result. Automated native execution, a successful build and the owner's visual acceptance are separate evidence.
No stage is Done solely because tests pass.
