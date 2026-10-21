# Configured-account quota admission

Every native spawn passes one host quota gate. Configured-account waiting is
additional explicit owner intent for installed Codex launchers; a job without
`quotaPolicy` is admitted by the host gate alone. Neither buys credits nor
bypasses a provider refusal.

## Host-wide gate

The gate is consulted by job occurrences, run launches, the executor,
`createOperation`, interactive `launch`, plain `create` and restores. It returns
one verdict per provider:

- **allow**: a fresh admission source shows no known limit.
- **hold**: a fresh read showed an exhausted window, a backend denial or a
  spend/rate stop. Work stays queued with a reason code and the reset time and is
  re-evaluated only when a newer read arrives or the reset passes. Staleness alone
  never releases a known limit; after the reset the verdict is unknown until a
  newer read.
- **unknown**: no admission-grade evidence (read or network failure, stale or
  partial source, no account identity, no source). Work starts and the session
  list marks it `quotaUnverified:{reason}`.

Jobs without `quotaPolicy` stay `queued` while held, with occurrence
`quota:{state:"held",reason,resetsAt}`; no precheck, attempt or Run is allocated.
Run launches and the executor get `quota_wait` before an attempt or receipt exists;
the executor waits on the journal. `createOperation` keeps its claimed receipt in
the host hold queue. An interactive launch receives `{"type":"quotaHold"}` with the
reason and reset time; disconnecting abandons it before any effect. A host stop
finishes held operations as failed with no effect. Plain `create`, restores and
legacy one-shot schedules refuse with `quota_hold`.

`nesvo quota` and `nesvo_get_provider_quota` add `gate.providers` (verdict, reason,
source, `resetsAt`, `freshUntil`) and `gate.holds` (kind, ID, program, reason,
`resetsAt`, `checks`). `checks` counts re-evaluations and grows only when the gate
changes. The Jobs history shows a quota column; `quotaGate:true` advertises the
gate. Holds are process-local: after a restart each source starts with an
`awaiting_observation` hold of at most 30 seconds until its first read.

## Inspect, then opt in

Use the actual absolute host folder from the proposed task profile:

```powershell
nesvo quota --program codex --directory "C:\work\project" --refresh --json
nesvo quota --program codex --directory "C:\work\project" --json
```

`nesvo_get_provider_quota` accepts the same `program`, `directory` and `refresh`
fields. `providerQuotaContexts:true` advertises directory selectors. A refresh
returns queued, pending or cooldown; inspect a later revision rather than treating
the acknowledgement as a completed read. Refresh requests coalesce and have a
five-second per-reader cooldown. Periodic reads rotate across at most sixteen
contexts, using one original app-server reader at a time. No model, turn, login
or token-refresh request is made.

Copy the returned opaque `contextId` and `accountFingerprint` into the job file:

```json
{
  "quotaPolicy": {
    "mode": "wait",
    "contextId": "<inspected 64-character fingerprint>",
    "accountFingerprint": "<inspected 64-character fingerprint>"
  }
}
```

This is an additional field of the existing job specification, not a complete
job file. `nesvo job create --key KEY --file job.json --json` and
`nesvo_create_job` use the same specification. These operations require
`jobQuotaAdmission:true`; older quota-display or wake capabilities are insufficient.
Only the authenticated owner can set or reauthorize this policy.

## Evidence and execution

The reader resolves the same captured launcher, explicit `CODEX_HOME` and actual
directory used for native admission. It reads account metadata without refreshing
tokens, effective config without config layers, and a full quota response. Positive
admission requires a known ChatGPT/OpenAI route, matching account evidence, valid
advertised windows and the backend's explicit ordinary-use permission. A legitimate
weekly-only response can release an opted-in job. An absent five-hour window is
not synthesized as zero usage, and missing backend permission never releases work.
API-key, Bedrock, custom,
unknown or failed routing evidence cannot release a job. Known environment endpoint
or credential overrides are conservative holds; values are never published.

The occurrence exposes a separate `quota` object with waiting/eligible/notRequired
and a bounded reason. Quota waiting preserves queued or retryWaiting state and
does not allocate a precheck, dispatch attempt, Run or native receipt. Eligible
candidates are filtered before the scheduler limit, so blocked jobs do not starve
other jobs. A source failure, expiry or changed identity revokes earlier authority;
a reset timestamp alone does not release anything.

If evidence changes after a claim, the live continuation keeps the same generation,
precheck result, Run, receipt and reserved session identity. It releases dispatch
capacity and native run control while waiting. Prepared worktree facts are saved
before a later hold: release does not rerun Git. The actual prepared folder requires
fresh matching account/route evidence, followed by a final native spawn check.
Cancellation, shutdown, timeouts, revoked authority and changed constraints remain
fences, not quota-release signals. Review `preparedWorkspace` and `quotaHoldReason`
on the launch summary when diagnosing a retained continuation.

This is a configured-account check at a point in time. It does not prove an immutable
native account lease: login, configuration and provider quota can change after the
check, and the original CLI may still refuse work. Existing running-session account
history is not inferred from the reader.

## Restart and explicit reauthorization

Reader observations and fingerprint salts belong to one host process. On restart,
pending opted-in occurrences require owner authorization and old observations are
discarded. In-flight native effects keep existing unknown/reconciliation semantics;
they are not automatically replayed.

Inspect a new observation and the occurrence's current quota binding, then compare
and reauthorize exactly that occurrence:

```powershell
nesvo job authorize-quota JOB OCCURRENCE --key UNIQUE_KEY `
  --expected-context OLD_CONTEXT --expected-account OLD_ACCOUNT `
  --context NEW_CONTEXT --account NEW_ACCOUNT --json
```

MCP exposes `nesvo_authorize_job_quota` with the equivalent camelCase fields. The
original frozen specification, acceptance response and retry decision remain intact.
The same key replays the original authorization response. Reauthorization cannot
resurrect canceled, terminal or effect-uncertain work and does not launch a model.
Bound readers are not evicted to admit another configuration; a full registry returns
`busy`. Derived worktree readers are transient and are released after their launch
continuation finishes.

Verification uses deterministic clocks/SQLite plus an isolated real host, official
MCP SDK client and controlled JSON-lines/PTY providers. These tests do not substitute
for original-provider or physical-device acceptance.

```powershell
cargo build --workspace --locked
cargo test --workspace --locked
cargo test -p nesvo --test mcp_host --locked quota -- --ignored --test-threads=1
```

The controlled Codex workers report through their existing session-scoped CLI
context. Their test profile omits the Claude-only `harness:true` setting; these
scenarios do not prove original Codex MCP injection. The worktree cases inspect a
real Git worktree and reserved native identity, including release after the owner
disconnects and cancellation while a prepared workspace is still held.
