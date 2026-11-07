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

## Before reporting completion

Run bun run check and bun run build for foundation changes.
Run bun run smoke:desktop when a desktop or host transport/lifecycle change affects that path.
After packaging, run the same scenario with NESVO_PACKAGED_EXECUTABLE set to the executable.
Run a focused regression check after a fix. Do not rerun unrelated suites without a new reason.

Record OS, commit, command and result. Automated native execution, a successful build and the owner's visual acceptance are separate evidence.
No stage is Done solely because tests pass.
