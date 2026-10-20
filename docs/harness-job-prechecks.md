# Owner-approved job prechecks

`jobPrechecks:true` advertises a command check before a job creates its model run.
The host timer works without an open client. A passed check permits the normal
guarded Run/Task/Attempt executor; skip, refusal, failure, timeout or uncertainty
does not create that run or provider session. A check never makes a worker result
successful: the ordinary explicit result/validation rules still apply.

## Trust policy

An approval authorizes **arbitrary OS code with the host user's permissions**.
Use cheap, read-only, foreground checks running as the same user. This is not a
sandbox. The approved executable, arguments, directory, environment additions,
deadline and exit-code policy are immutable. Referenced binaries, script files,
repository configuration and other data remain mutable; the digest binds the
invocation, not all code it can load. Do not automatically approve imported
repository configuration. Explicitly approving an interpreter also approves the
literal code/arguments supplied to it.

Only the authenticated owner may describe, approve, inspect, revoke or abandon
checks. Coordinator/worker principals are refused, even if native provider tool
permissions mention these methods. A job file contains only `precheckId`, never
an inline command or a self-asserted `trusted:true`. Loading/creating a job does
not register or approve code. Approval requires a separate operation with the
previously inspected normalized digest. A new command needs a new approval ID;
revoking and replaying an old approval key does not approve it again.

Approvals use `version:1` and the `isolated-platform-v1` environment policy:
explicit caller additions and no ambient environment inheritance. On Windows the
helper adds the actual OS installation directory as `SystemRoot`, queried through
Windows API. It is needed by runtimes such as Node's Windows CSPRNG initialization;
it is not copied from a caller environment value. Describe/get expose the policy
and platform key list. SystemRoot overrides and NESVO_/POCKET_ context variables
are forbidden. Names use ASCII letters/digits/underscore and must be unique
without regard to ASCII case. No ambient pairing, provider credentials or user
profiles are supplied. Commands can still read files/use OS APIs; their trust is
the owner's explicit decision, not an environment-based security boundary.

## Inspect and approve

Save a UTF-8 command JSON. For example, on a Windows host with these actual paths:

```json
{
  "title": "Ready flag",
  "executable": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "arguments": [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "if (Test-Path -LiteralPath 'C:\\project\\ready.flag' -PathType Leaf) { exit 0 }; Write-Output 'No ready flag'; exit 10"
  ],
  "cwd": "C:\\project",
  "timeoutMs": 2000,
  "passExitCodes": [0],
  "skipExitCodes": [10],
  "environment": {}
}
```

Select real absolute host paths. A Unix equivalent can approve `/usr/bin/test`
with `arguments:["-f","/home/user/project/ready.flag"]`, pass `[0]`, skip `[1]` and
an explicit existing absolute directory. The client never substitutes a focused
session's directory. A check's directory is independent of the job's later shared
checkout/worktree; a new agent worktree is not created just to run the check.

```powershell
nesvo job precheck describe --file check.json --json
# Inspect the returned normalized spec, digest and trust/environment policy.
nesvo job precheck approve --file check.json --digest INSPECTED_DIGEST --key approve-ready-1 --json
nesvo job precheck show APPROVAL_ID --json
nesvo job precheck list --json
nesvo job precheck mutation --key approve-ready-1 --json
```

Describe requires the host and performs no command execution or approval. Set
`precheckId:APPROVAL_ID` in the [durable job specification](harness-jobs.md), then
use its ordinary create/edit/schedule/run-now operations. Omission preserves
legacy behavior and serialized intent. Create/edit require an enabled approval;
execution checks it again. The original occurrence's check ID is not rewritten
by a later definition edit.

```powershell
nesvo job precheck revoke APPROVAL_ID --revision CURRENT_REVISION --key revoke-ready-1 --json
```

Revocation refuses later check authorizations. Already authorized checks may
finish; it does not undo effects, stop a model or cancel a running check. A
revoked/missing/changed approval produces a retained `precheck_not_trusted`
occurrence failure before command/model launch. Approval records are immutable
apart from revocation, with exact revisions and original mutation-key lookup.

## Results and uncertainty

The occurrence moves through `queued`, `dispatching`, `prechecking`, then either
normal model dispatch or a terminal/uncertain check outcome. Inspect:

```powershell
nesvo job history JOB_ID --json
nesvo job occurrence JOB_ID OCCURRENCE_ID --json
```

`precheck` exposes approval ID/digest, state, reason, `authorizedAt`, `observedAt`,
`finishedAt` and result. `authorizedAt` is durable permission to attempt the check,
not proof of process creation. `observedAt` timestamps the recorded state;
`finishedAt` remains null when cleanup/termination is unconfirmed, including after
restart or owner abandonment. Result `commandStarted:true` is the helper's observation of
process creation, not script or job success; null means unconfirmed. Results carry
state, exit code, reason, duration, cleanup confirmation and truncation flags.
Detail adds sanitized stdout/stderr, at most 512 UTF-8 bytes each. Summaries omit
those logs. The command's separate stdout/stderr cap is 4096 bytes each; excess
output fails the check. Output is not parsed as another command or approval.
Approvals/outputs are persisted owner data; routine events carry IDs/phases only.

Pass codes and skip codes are nonempty, unique, disjoint lists (0–255). Default
pass is `[0]`, skip `[10]`; other codes/signals fail. `precheck_skip` records a
deliberate skip; failure/timeout/output-limit retain separate causes. No retry of
the same occurrence is implicit. A later scheduled occurrence is separate intent.

Missing helper results, unconfirmed cleanup, interrupted dispatch and host restart
during a check require `reconcile`, without repeating the command or starting a
model. To abandon a precheck before any run was bound, first inspect its effects,
then explicitly acknowledge the exact stored digest:

```powershell
nesvo job abandon-precheck JOB_ID OCCURRENCE_ID --key abandon-1 --digest RECORDED_DIGEST --acknowledge-unknown-effects --json
```

This marks the occurrence canceled. It does not terminate a detached command,
undo filesystem/network effects, repeat a check or resume work. Original-key replay
returns that immutable acceptance. Unknown checks block overlapping queued work
until reconciled/abandoned. A known passed check interrupted before run binding
can also be abandoned; metadata-only run creation may already have been accepted
under `job:JOB_ID:OCCURRENCE_ID:run`, which must be inspected rather than adopted
or dispatched automatically. General job cancel/retry/reconciliation remains a
separate implementation gate.

## Process lifetime and limits

The same executable's private helper starts before provider discovery, pairing,
database or normal host runtime initialization. It waits on an owned input pipe.
The parent contains it **before** releasing the command. No shell interpolation
occurs; Windows rejects implicit `.cmd/.bat` execution. An explicitly approved
interpreter and exact arguments are supported.

- Windows: a private noninherited kill-on-close Job Object contains the waiting
  helper and descendants. Termination uses that handle; cleanup checks active
  process count and reaps the exact helper. Parent death closes the owning handle.
- Unix: the helper leads its own process group. The parent retains the unreaped
  leader until group termination, preventing reuse of its identity. Parent death
  closes the pipe; the helper kills its own group. The adapter signals the owned
  group before reaping the helper, then retires termination ownership. A
  non-signalling observation must confirm that the group has terminated before a
  passed check can dispatch. A live/reused group ID or an observation error is
  conservative uncertainty, never permission to signal that number again.
  Ordinary descendants are covered; detached
  sessions/groups or privilege-changing commands are outside this trusted
  foreground policy. `cleanupConfirmed` concerns the owned scope, not arbitrary
  detached processes or a sandbox guarantee.

Linux uses a signal-zero absence query. Darwin also reports unreaped zombies as
signal-zero targets, although they have terminated. On macOS libproc enumerates
at most 4096 group members and reads their BSD process state, including zombies;
only absent or zombie members count as terminated. Truncated membership, a live
member or any observation error cannot confirm cleanup. Neither observer sends
termination after reaping the original helper or inspects arbitrary file content.
The platform distinction follows Apple's [signal handling](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
and [libproc state implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c);
the binding uses the already locked libc, with no additional package.

Both normal command exit and failure terminate the remaining owned scope before
model dispatch. Unconfirmed cleanup retains ownership/capacity while reaping and
never counts as passed. Checks allow two concurrent scopes, up to 15 seconds of
slot wait, 100–10000 ms command budget (default 2000), 1000 ms helper protocol
allowance and 2000 ms cleanup observation. These are separate from the later run's
admission/input `maxElapsedMs`, which is not a hard process kill budget.

Command specs are at most 16 KiB, 32 literal arguments (2048 bytes each), 16
environment additions and eight codes per exit list. Approval/mutation retention
is bounded at 128/4096 without silent deletion; one check record belongs to each
retained occurrence. Quiet timer ticks execute no checks or model calls.

Four dispatch preparations and two calendar calculations can be in flight; neither
awaits inside SQLite or holds a session-state mutex. Pending calendars are tracked
by exact ID/revision/due cursor. Calendar/once pages are separate, so a page of
pending recurrence calculations cannot hide an independently due once job.

## CLI/MCP parity and verification

`nesvo_describe_precheck`, `nesvo_approve_precheck`, `nesvo_get_precheck`,
`nesvo_list_prechecks`, `nesvo_revoke_precheck`, `nesvo_get_precheck_mutation` and
`nesvo_abandon_job_precheck` use the same authenticated host domain as CLI. Clients
require the distinct capability before these operations or a checked job mutation.
Native tool allowances do not grant host owner authority.

Injected-store tests cover explicit digest/trust, immutable replay, revocation,
scope, exact once-only check phases, no run on skip/failure, cleanup uncertainty,
restart/abandon and separate timer pages. Native SDK/CLI tests use real helpers,
timers and controlled programs to check disconnected skip, literal Unicode args,
minimal environment, stderr/stdout bounds, passed dispatch, revoked refusal and
three-level ordinary process trees on timeout, root exit and abrupt parent death.
A held-check scenario proves unrelated timer work continues. Those fixtures make
no original model calls and do not certify job UI or a native phone.

No production package was added. The existing windows-sys dependency enables its
SystemInformation feature to query the OS directory without ambient inheritance.
