# Owner reconciliation of a no-effect job launch

`jobLaunchReconciliation:true` adds one owner-only metadata operation to
[durable jobs](harness-jobs.md). It retires an exact dispatch generation when its
native create receipt proves `effectStarted:false`, but later timeout or control
uncertainty still occupies the occurrence. It sends no input or native signal and
never turns unknown cleanup into a confirmed exit.

## Inspect, acknowledge, then recover acceptance

Read the current occurrence and its exact generation, then inspect the native
launch, timeout/cancellation and control receipts referenced by those records:

```powershell
nesvo job occurrence JOB_ID OCCURRENCE_ID --json
nesvo job attempt JOB_ID OCCURRENCE_ID JOB_ATTEMPT_ID --json
nesvo operation --id LAUNCH_RECEIPT_ID --json
nesvo run get RUN_ID --json
```

A nullable `launchReconciliation` descriptor appears on occurrence and generation
summary/detail reads. It contains exactly:

- `kind:"launchNoEffect"` and `jobId`, `occurrenceId`, `jobAttemptId`, `runId`,
  `attemptId`, `sessionId`, `launchReceiptId`.
- `available`, nullable `reason` and nullable `digest`.

Only `available:true`, `reason:null` supplies a digest for acknowledgment. The
digest is a lowercase 64-character SHA-256 value binding the inspected frozen
specification, identities and relevant native/precheck/cleanup evidence. It is
not an authorization token. Internal proof material and private claim tokens are
never returned. Unavailable evidence uses `launch_reconciliation_unavailable`;
an already resolved generation uses `generation_resolved`. Other inspection
records retain their more specific failure and cleanup reasons.

After reviewing the retained effects and uncertainty, explicitly acknowledge the
exact generation and digest:

```powershell
nesvo job abandon-launch JOB_ID OCCURRENCE_ID --job-attempt-id JOB_ATTEMPT_ID --key owner-launch-resolution-1 --digest DIGEST --acknowledge-unknown-effects --json
nesvo job mutation --key owner-launch-resolution-1 --json
```

The matching MCP tool is `nesvo_abandon_job_launch` with `jobId`, `occurrenceId`,
`jobAttemptId`, `key`, `expectedDigest` and `acknowledgeUnknownEffects:true`.
Both adapters require the strict capability above; older hosts are refused
before dispatch. This does not alter `abandonPrecheck`, its optional-generation
compatibility, existing mutation fingerprints or provider tool grants.

An accepted operation atomically records an immutable `launchResolution` and
sets the occurrence/generation to `canceled` with reason
`launch_owner_abandoned`. The resolution has the same eight identity fields plus
`digest`, `mutationKey` and `acknowledgedAt` (Unix milliseconds). Older immutable
acceptance bodies may omit both additive properties entirely. Retrying the same
accepted mutation key returns its original body, even after later observations
or restart. A different request under that key remains a conflict.

## Required evidence and permanent fences

Acceptance requires the exact current generation and its sole native task,
attempt, session and create receipt. The failed create receipt must contain the
JSON boolean `effectStarted:false`; missing data, string `"false"` and unknown
creation are insufficient. Native create and generation producers must have
finished and released their claims. There may be no later generation or sourced
retry decision, result, validation, instruction delivery, decision or process
exit. A current or retained coordinator binding, or additional run-native input
outside the exact worker/control scope, also refuses this narrow operation.
Selected prechecks require their own exact passed/cleanup-confirmed proof.

Timeout/cancellation and native control producers must have relinquished their
claims. Pending exit or a positive native stop/write/exit observation refuses
abandonment. A finished unknown cleanup receipt can remain unknown when the
independent create proof establishes that no worker was started. The owner is
acknowledging that retained uncertainty, not rewriting its receipt.

The operation preserves native receipts, controls, timeout/cancellation records,
precheck results, worktree branches/files and process-exit history. In particular,
`effectStarted:false` is the native worker-creation boundary: an approved
precheck or partially prepared worktree can already have had effects. No rollback,
worktree removal, fake process exit, timer disarming or successful cleanup is
invented.

The resolved Run permanently fences fresh worker admission, automated input,
executor enablement and native controls. The retirement guard returns
`job_generation_retired`; existing Run, timeout or cancellation guards can refuse
earlier with their own reason codes.
Historical accepted-key replay still precedes that fence. Retry, cancellation,
timeout observation and restart cannot reopen the resolved generation. A
separate queued occurrence may proceed once this logical overlap is released;
it receives its own identities and does not reuse the abandoned worker.

## Refusals and limits

Malformed digest or omitted/false acknowledgment gives `invalid_argument`.
Changed digest, unavailable evidence or a noncurrent generation gives
`occurrence_conflict`; inspect again rather than minting keys blindly. Nonowners
are refused with `forbidden` at the host boundary. Clients lacking the strict
capability can instead refuse compatibility before sending an operation.

This is deliberately narrower than general uncertain-effect reconciliation.
Unknown/positive worker creation, live claims, actual workers, reported results,
ambiguous prechecks and broader retry classes remain separate gates. No model,
global configuration, dependency or TUI/mobile surface is added by this operation.
