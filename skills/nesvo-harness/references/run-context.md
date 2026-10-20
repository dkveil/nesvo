# Run context and owner constraints reference

Use only advertised `runCheckpoints`/`runConstraints` capabilities. These metadata
APIs preserve context; they never restore native effects or adopt a process.
Owner or that run's authorized coordinator can inspect the full manifest.
Workers use `run context --json` / `nesvo_get_current_task {}` for their own task,
attempt and current `constraints:{policy,records}`; they cannot inspect the whole
parent manifest or acknowledge its policy. Parent metadata grants no role.

## Capture and inspect immutable history

```powershell
& $env:NESVO_CLI run get RUN_ID --json
& $env:NESVO_CLI run checkpoint save RUN_ID --key checkpoint-1 --revision RUN_REV --summary-file "C:\private\note.txt" --json
& $env:NESVO_CLI run mutation --key checkpoint-1 --json
& $env:NESVO_CLI run checkpoint list RUN_ID --json
& $env:NESVO_CLI run checkpoint list RUN_ID --offset NEXT_OFFSET --json
& $env:NESVO_CLI run checkpoint get RUN_ID CHECKPOINT_ID --json
& $env:NESVO_CLI run checkpoint get RUN_ID CHECKPOINT_ID --offset NEXT_OFFSET --json
```

Save has optional `--summary` instead of `--summary-file`; it is the caller's
literal note (at most 2048 UTF-8 bytes), not verified progress. Exact current run
revision is required. Saving does not change that revision or plan. Header,
individual parts, journal event and workflow mutation acceptance commit together.
Recover a lost save reply through `run mutation` using the original key, then
inspect current metadata separately. Same-key replay is historical acceptance.
Do not invent a new key after uncertainty or confuse workflow/native key spaces.

MCP grammar:

- `nesvo_save_run_checkpoint {key,runId,expectedRevision,summary?}`
- `nesvo_list_run_checkpoints {runId,offset?}`
- `nesvo_get_run_checkpoint {runId,checkpointId,offset?}`
- `nesvo_read_run_context {runId,checkpointId?,offset?,expectedDigest?}`

`get` returns frozen historical parts. To rebuild **current** context after a
context reset, read:

```powershell
& $env:NESVO_CLI run checkpoint context RUN_ID --checkpoint CHECKPOINT_ID --json
& $env:NESVO_CLI run checkpoint context RUN_ID --checkpoint CHECKPOINT_ID --offset NEXT_OFFSET --expected-digest DIGEST --json
```

The checkpoint is an optional comparison baseline, never replacement state.
Follow the returned `nextOffset` exactly: pages contain at most eight parts and
24 KiB of part data, so increments may be smaller than eight. Keep the returned
digest for every current-context continuation; `context_changed` means restart
at zero. Do not mix live versions. Historical pages remain immutable. List pages
contain eight checkpoint headers. Bounds: 32 snapshots/run, 256/database,
16384 parts / 1 MiB per manifest. Capacity refusal never silently prunes history.

The manifest carries the original goal, current owner constraints, plan,
attempt/result/validation references, decisions, unresolved controls/wakes and
pending or unknown native receipt pointers, automation and inbox descriptors.
Read actual reports/checks via retained `run task` history, decision bodies via
their authorized API and pending inbox bodies via exact-ID handling. A checkpoint
note, reported outcome, idle screen or response settlement is not accepted task
success. Review still needs actual current evidence and independent validation.

`sourceRunRevision` and `sourceCursor` describe capture; the latter precedes its
own save event and is not an inbox ACK or native key. `baselineDiffers`/`digest`
describe metadata differences. `nativeEffectsRestored` stays false. Never infer
exit/no effect from a missing process after restart, replay old input, recreate
unknown launches or silently adopt a replacement coordinator. Receipt IDs remain
issuer-scoped pointers, not permission to read an owner's receipt. Checkpoints
do not extend run budgets, reset retry counts or reenable any scheduling policy.

## Read and deliberately acknowledge human changes

Only the human owner can append constraints, using `run constraints add RUN_ID
--key OWNER_KEY --revision RUN_REV --file PATH --json` (or literal `--text`),
MCP `nesvo_add_run_constraint {key,runId,expectedRevision,text}`. Coordinators and
workers cannot edit/remove/discard owner text or impersonate the owner. This
version is append-only. Bounds: 16 constraints/run, 4096/database; 1024 UTF-8 bytes
and 2048 encoded JSON bytes per text. Capacity refusal preserves existing text.

```powershell
& $env:NESVO_CLI run constraints list RUN_ID --json
& $env:NESVO_CLI run constraints list RUN_ID --after NEXT_CURSOR --json
& $env:NESVO_CLI run constraints acknowledge RUN_ID --key handled-constraints-1 --revision RUN_REV --constraint-revision CONSTRAINT_REV --json
```

MCP `nesvo_list_run_constraints {runId,after?}` and
`nesvo_acknowledge_run_constraints {key,runId,expectedRevision,constraintRevision}`.
Read **all** pages before attesting to the exact current constraint revision.
Each constraint list page contains at most eight records; use its `nextCursor`
while `hasMore`. Run revision and constraint revision are different counters.
Re-read on conflict; recover lost mutations through their original workflow key.
Acknowledgement attests handling; it cannot prove comprehension or compliance.

An owner addition atomically pauses enabled executor/wake generations and queued
deliveries, blocking new assignments/launch reservations and run-bound input.
An already responding model can finish/report; this is not an OS sandbox or
retroactive validation. A previously reserved prompt-free launch may finish,
without authority to send an old task instruction. Fresh task delivery after
acknowledgement prepends **all** current owner text to the immutable instruction.
The combined prompt must fit 8192 UTF-8 bytes: `context_too_large` requires
deliberate task reconciliation, never truncating/omitting constraints. Deliberate
ordinary follow-ups must themselves include the current applicable constraints.

Every native send freezes constraint revision/admission at acceptance. Guards
recheck before paste and Enter. A later owner change permanently fences that
old operation, including input accepted while constraints were pending. Even
after acknowledgement it cannot be rearmed. Partial paste remains unknown with
its retained draft: no Enter, clearing draft, new-key send, old delivery requeue
or transport fallback to force it. Inspect the original receipt under actual
authority and request deliberate reconciliation. `delivery_exists` still holds.

Acknowledgement neither reenables executor/wakes nor rearms paused deliveries;
fresh policy enable is a separate deliberate action with current authority and
revision. It does not clear drafts, ACK messages, answer decisions, approve
native provider permission, validate tasks, reset budgets or release dependent
review. Constraint text is task context, never a new capability or blanket
permission. Restart pauses policies without automatic adoption/replay. Do not
claim provider compaction/resume from metadata restoration alone.
