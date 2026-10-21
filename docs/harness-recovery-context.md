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

## Launch-local Claude recovery hook

Opt-in harness launches on supported Claude 2.1.303+ add a second `SessionStart`
command to the same inline settings as lifecycle collection (`claude-hooks-v4`).
Plain Claude remains `claude-hooks-v3`; Codex is unchanged. The command uses the
host-configured native executable and exact private scoped context as literal
arguments, including on Windows. It never reads owner pairing as a fallback or
changes global provider settings. Existing live launches keep their configuration.

Root `startup`, `resume`, `clear` and `compact` events perform the authenticated
read. Child/fork/other events perform no connection or authentication. The hidden
`run recover-hook` adapter reads at most 2 MiB of stdin with a 2.2 second overall
deadline beneath the provider's 3 second hook timeout. An unclosed input pipe does
not hold CLI shutdown. Errors exit zero, emit a fixed diagnostic and return native
`SessionStart.additionalContext` guidance to explicitly read current context.

The coordinator collects all manifest pages using exact returned offsets/run ID/
digest, with at most one restart on `context_changed`, 32 pages and 64 KiB. Worker
recovery reads its complete current task bundle. The final serialized response is
also bounded to 64 KiB; additional context is limited to 9,500 UTF-16 units. This
stays below [Claude's documented 10,000-character spill to a file and partial
preview](https://code.claude.com/docs/en/hooks#add-context-for-claude). If the whole
context cannot fit, the hook sends only fixed unavailability guidance, never a
partial goal/plan that silently drops later owner constraints. Explicit paginated
CLI/MCP reads remain available for larger contexts. Multiple runs return bounded
choices and selection guidance; no default run is guessed.

Context framing grants no native permissions or new task admission. It does not
start a model request (`initialUserMessage` is absent), replay input, adopt a
process, ACK, enable policies or validate results. Persisted task instructions are
context, not a new request to start/restart work.

`session get`, `session explain` and `doctor` expose
`harness.recovery.{configured,status}`. Status contains fixed outcome/source,
optional run/constraint revision and stable file update time, not prompts, keys
or context bodies. `prepared` proves only that the helper produced the context,
not that the provider/model consumed it; `loaded` stays null. Missing, unreadable
and malformed reports stay explicit. The existing lifecycle I/O task observes
this bounded file outside the state lock/render path, without a model heartbeat.
Reports live beside the exact private scoped context; the writer does not assume
the provider hook's `TEMP`/`TMP` is the host's original temporary directory.

## Exact conversation resume

Session recovery is separate from run context recovery. The host records the
provider conversation ID observed by the lifecycle hooks in the session's saved
launch description (`spec.resume {provider, conversationId}`), and keeps it
across a host restart. Restoring with an explicit resume request starts a new
process with `claude --resume ID` or `codex resume ID` in the saved folder. It
sends no prompt and never opens a picker, picks the latest conversation or forks.
Gemini is refused with a visible reason.

The new session stays closed to automated input (`resume_pending`) until its
first root session-start hook reports source `resume` and the expected ID. A
different ID, another source, process exit or no hook within 60 seconds marks it
`resume.state:"resumeFailed"` with the reason; automated input is then refused
(`resume_failed`) and the session never poses as a continuation. The saved record
keeps the original conversation ID for another attempt. See the
[CLI](harness-cli.md#saved-session-recovery) and [MCP](harness-mcp.md#current-tools)
surfaces.

## Verification and remaining integration

Storage cases cover unbound/unique/ambiguous lookup, bounded choices, exact scope,
current worker constraints, no metadata/effect writes and current-page digest
fences. Native scoped CLI and the official MCP SDK exercise both roles against
real host/PTYs; actual envelopes are checked against the published JSON schema.

The real native SDK scenario also executes the actual launch hook from a Unicode
path containing spaces, collects later owner constraints beyond page one, checks
worker isolation, ambiguity, oversized context, ignored child events, owner/missing
authentication refusal and withheld stdin EOF. It verifies no native input or run
revision/ACK/policy changes, including a different hook temp root. Its provider is
a controlled executable, not a model.

An isolated Windows run on original Claude 2.1.304 verified native `/compact`:
a new owner code was written only to host constraints, then appeared in the
model's answer after recovery. Evidence came from the exact owned provider
conversation's assistant record, not echoed terminal text. The compact hook
reported prepared/revision two; the run revision stayed unchanged, its task
stayed planned and constraints remained pending. No tools, reports, source edits
or native approval were requested. Native exit was observed; host and owner
bridge exited zero and all 34 observed owned descendants were gone.

Earlier probes exposed the differing hook temp directory and a human-input
startup redraw race in the test bridge; their failed evidence is retained.
Instruction V11 and existing live snapshots remain unchanged. This verifies one
original-provider compact path, not the full resume/clear matrix, large-context
model consumption, replacement-coordinator adoption or F40/F41 completion.
Provider resume does not imply native process adoption, and a prepared hook
never clears an uncertain operation.
