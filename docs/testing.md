# Selective testing policy

Damian explicitly chose limited testing for prototype delivery. Protect meaningful behavior without filling the repository with repetitive tests.

## Required checks

- TypeScript strict, ESLint and Prettier are the routine baseline.
- Test critical boundaries when their behavior changes: process lifecycle, validated messages, persistence, cancellation, permissions and revision-bound review.
- Prefer integration tests with real local resources over mocks of implementation details.
- Keep one principal desktop scenario and extend it only when the accepted product flow requires it.
- Review visual and low-risk copy changes manually. Do not add unit tests solely for JSX, styles, wrappers or getters.
- No coverage percentage, mandatory unit-test count, one-test-per-function policy or large component snapshots.

Current P0 checks:

| Check                            | Evidence                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Host lifecycle integration       | Invalid input rejected, health correlated, identity survives restart, clean shutdown      |
| Schema compatibility integration | Newer database refused and version preserved                                              |
| Desktop scenario                 | Actual Electron/preload/host/database path, refresh, isolated renderer and child shutdown |

Tests use dedicated temporary directories and no provider accounts. They must not operate real project data or existing agent processes.
The desktop smoke scenario can run against either build output or an unpacked package.

## Before reporting completion

Run bun run check and bun run build for foundation changes.
Run bun run smoke:desktop when a desktop or host transport/lifecycle change affects that path.
After packaging, run the same scenario with NESVO_PACKAGED_EXECUTABLE set to the executable.
Run a focused regression check after a fix. Do not rerun unrelated suites without a new reason.

Record OS, commit, command and result. Automated native execution, a successful build and the owner's visual acceptance are separate evidence.
No stage is Done solely because tests pass.
