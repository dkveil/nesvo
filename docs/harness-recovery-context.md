# Authenticated recovery context

`runRecovery:true` adds a read-only lookup of the current managed process's
durable context. It uses the same workflow writer and current manifest as the
checkpoint API; there is no second recovery store or execution engine.

```powershell
nesvo run recover --json
nesvo run recover RUN_ID --json
nesvo run recover RUN_ID --offset NEXT_OFFSET --expected-digest DIGEST --json
```

Inside a managed process, invoke the inherited absolute `NESVO_CLI`, leaving
its scoped authentication context inherited. MCP exposes
`nesvo_recover_run_context {runId?,offset?,expectedDigest?}`. These are context
reads, not `run resume`, conversation resume, process adoption or input replay.

## Selection and authority

- A worker receives `scope:worker`, its exact `taskContext` and `bound:true`.
  This includes its current instruction, attempt, stored report/validation and
  current owner constraints. It cannot select a parent run or use nonzero parent
  offsets/digests. Superseded attempts remain refused. A worker without an
  assignment returns `bound:false`; this does not claim provider readiness.
- A coordinator with exactly one retained bound run receives `scope:coordinator`,
  `bound:true` and its first current manifest `page`. It never selects by name,
  newest creation time, UI focus or environment session hints.
- Several retained runs return `bound:false`, `selectionRequired:true` and
  up to eight authorized `{id,title,state}` choices. `hasMoreRuns` indicates more
  choices; use the separately paginated `run list` to inspect those. No run is
  silently selected. Pass an exact authorized run ID to read its context.
- No coordinator run returns an empty choice list and `bound:false`. Completed,
  canceled, stopped and draft runs remain discoverable; completed work is not
  hidden when conversational context is lost.
- An owner must always supply a run ID. Foreign IDs stay unavailable through
  ordinary run scope checks; knowing an ID grants no authority.

The outer `nativeEffectsRestored` is always false. Current manifests never
replace owner constraints from an old checkpoint. This lookup neither creates a
checkpoint nor acknowledges its source cursor. It does not refresh grants,
budgets, policy generations, inbox handling, native permission or task success.

## Current page consistency

For coordinator/owner context, `page` has the same run, current metadata, parts,
constraint policy and continuation as `run checkpoint context`. Follow its
returned `page.nextOffset` exactly, carrying `page.context.digest` as
`expectedDigest`. Use the now-known run ID for continuation rather than repeating
implicit selection. Parts are bounded to eight records / 24 KiB per page.
`context_changed` requires restarting at zero; do not combine live versions.

Read all current constraints and relevant goal/plan/result/decision/uncertainty
references before deciding further work. Inspect full reports/checks, decisions
and inbox bodies through their authorized operations. A stored succeeded report
or response settlement does not release dependent review without validation.
Neither this read nor deliberate constraint ACK rearms an old paused/unknown
native input or clears a retained draft. Missing processes remain uncertainty.

The returned selection/task context and manifest are sensitive run data, not
routine telemetry. The worker sees its own binding, not the coordinator's whole
manifest. Rendering remains free of I/O. Unsupported hosts are refused through
capability checking, without a legacy terminal-input fallback.

## Verification and remaining integration

Storage cases cover unbound/unique/ambiguous lookup, bounded choices, exact scope,
current worker constraints, no metadata/effect writes and current-page digest
fences. Native scoped CLI and the official MCP SDK exercise both roles against
real host/PTYs; actual envelopes are checked against the published JSON schema.

This is the shared lookup required by a future bounded provider recovery hook.
It is not automatically injected on compaction/resume yet. Instruction V11 and
existing live launch snapshots remain unchanged. Actual original-provider
compaction and replacement-coordinator recovery require separate integration
and evidence before F40/F41 can be marked complete.
