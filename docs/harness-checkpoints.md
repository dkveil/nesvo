# Checkpoints and owner constraints

`runCheckpoints:true` provides immutable metadata snapshots and current context
reconstruction. `runConstraints:true` provides append-only human constraints
and an explicit acknowledgement fence. Both use the existing authenticated host
workflow writer, CLI and MCP, with no new service, model client or dependency.

These operations never restore native processes, send input, take a lease,
acknowledge inbox messages, answer decisions or validate work. Persisted attempt
state is not proof that its original process still runs. Full conversation
adoption and native recovery remain F41 work.

## Snapshot and current context

```powershell
nesvo run get RUN_ID --json
nesvo run checkpoint save RUN_ID --key checkpoint-1 --revision RUN_REV --summary-file note.txt --json
nesvo run mutation --key checkpoint-1 --json
nesvo run checkpoint list RUN_ID --json
nesvo run checkpoint get RUN_ID CHECKPOINT_ID --json
nesvo run checkpoint get RUN_ID CHECKPOINT_ID --offset NEXT_OFFSET --json
nesvo run checkpoint context RUN_ID --checkpoint CHECKPOINT_ID --json
nesvo run checkpoint context RUN_ID --checkpoint CHECKPOINT_ID --offset NEXT_OFFSET --expected-digest DIGEST --json
```

Save accepts an optional literal `--summary` instead of `--summary-file`. This
is the caller's note, not independently confirmed progress. The source run
revision must match exactly. Saving commits the header, individual parts,
journal event and mutation recovery together. A failed part write rolls them
all back. Save does not change the run/plan revision, launch work or refresh
native authority. Same-key replay returns its original immutable acceptance.

`get` reads historical parts. `context` reads **current** parts; the optional
checkpoint supplies only a comparison baseline. An old checkpoint never
replaces current owner text, decisions, attempts, policies or native uncertainty.
The digest and `baselineDiffers` distinguish its captured source from current
metadata. `nativeEffectsRestored` is always false.

The manifest includes the original goal, owner constraint policy/text, plan,
attempt/result/validation pointers, decision state/revision references,
unconfirmed controls/wake batches, pending or unknown native receipt pointers
and automation/inbox descriptors. Actual reports and validation evidence remain
in retained attempt history; inspect those IDs through `run task`. A reported
outcome is separate from accepted validation. Idle, response settlement and a
checkpoint note never create success. Decision details and inbox bodies remain
in their authorized stores.

Pages contain at most eight parts and 24 KiB of part data. Byte limits may
produce fewer records. Continue at the returned `nextOffset`, not a guessed
increment. Current-context continuation requires the same `expectedDigest`;
`context_changed` means restart at zero. Do not mix pages from different live
versions. Historical pages use indexed stored parts, without rebuilding or
rehashing the full saved manifest on every read.

The source journal cursor describes capture before its own save event; it is
not an inbox ACK, native operation key or instruction to replay events. Missing
processes after coordinator/host exit are never assumed stopped or adopted.

MCP: `nesvo_save_run_checkpoint {key,runId,expectedRevision,summary?}`,
`nesvo_list_run_checkpoints {runId,offset?}`,
`nesvo_get_run_checkpoint {runId,checkpointId,offset?}` and
`nesvo_read_run_context {runId,checkpointId?,offset?,expectedDigest?}`.
Only owner or the run's authorized coordinator may use them. Workers receive
their own task/constraint context, not the full parent manifest.

## Manually added constraints

Only the human owner may append literal text:

```powershell
nesvo run constraints add RUN_ID --key owner-rule-1 --revision RUN_REV --file owner-rule.txt --json
nesvo run constraints list RUN_ID --json
nesvo run constraints list RUN_ID --after NEXT_CURSOR --json
```

`--text` is the inline alternative. Text is not a shell command, native permission
approval or new role grant. Coordinators cannot overwrite or discard it.
Constraints retain stable IDs, author, time and monotonic revision. This version
appends; editing/removal and retention management are not implied. Source text
survives reconnect/restart and appears in snapshots and the worker's `run context`.

Adding a constraint atomically pauses enabled executor/wake generations and
still-queued deliveries. It blocks new assignments/launch reservations and task
input until explicit acknowledgement. A model already responding may finish and
report; this is not an OS sandbox or retroactive verification of old work.
A previously reserved prompt-free launch can finish, without permission to send
its old task instruction.

After reading **all** pages, owner or authorized coordinator can attest to the
exact constraint revision:

```powershell
nesvo run constraints acknowledge RUN_ID --key read-owner-rule-1 --revision RUN_REV --constraint-revision CONSTRAINT_REV --json
```

Run and constraint revisions are different counters. Conflicts require reading
current state. Acknowledgement is an attestation, not proof of comprehension,
reenabling a policy or acceptance of a task. It does not clear drafts, answer
decisions, ACK inbox messages or grant native permission. Paused scheduling needs
a separate deliberate enable; existing paused deliveries are never rearmed.

Every new run-bound native send reserves its constraint revision/admission status
with its receipt. Paste and Enter recheck it. A later constraint invalidates old
input even after acknowledgement; input accepted while constraints were pending
also stays fenced. Partial input remains unknown with its retained draft. Neither
ACK, a fresh key nor ordinary send bypasses draft guards or resubmits an existing
task-delivery intent.

Fresh task delivery after acknowledgement prepends all current owner constraints
to the immutable instruction. None are silently truncated. The combined prompt
must fit the existing 8192 UTF-8 byte native bound; `context_too_large` requires
deliberate task reconciliation. Explicit follow-up senders must use the current
constraints themselves. Delivery implies no semantic compliance or validation.

MCP: owner-only `nesvo_add_run_constraint {key,runId,expectedRevision,text}`,
`nesvo_list_run_constraints {runId,after?}` and
`nesvo_acknowledge_run_constraints {key,runId,expectedRevision,constraintRevision}`.
Workers can inspect constraints through `nesvo_get_current_task`, but cannot
edit them or acknowledge the whole run.

## Bounds and verification

- 32 checkpoints per run, 256 per database; no silent pruning.
- At most 16384 parts / 1 MiB per manifest; note at most 2048 UTF-8 bytes.
- 16 owner constraints per run, 4096 globally; text at most 1024 UTF-8 bytes and
  2048 encoded JSON bytes. Capacity failure preserves existing records.
- Checkpoint list and constraint pages contain eight records.
- Native, workflow, constraint, part and inbox cursors/IDs are distinct. Receipt
  pointers retain issuer-scoped access.

Storage tests cover replay, historical/current constraints, scope, native revision
fences, atomic rollback, pause/ACK separation, actual SQLite reopen, capacity,
validation provenance and byte-limited pages. Native SDK scenarios use isolated
host/PTYs and inherited scoped CLI. They verify CLI/MCP replay, silent reads,
owner-only text, worker context, retained context after coordinator exit and a
constraint arriving between paste and Enter. Real envelopes pass Ajv.

These controlled programs make no model calls and do not establish original
provider compaction/resume. Instruction/model context handling, native adoption,
mobile controls and material UI still need their own evidence. No provider
permission bypass or global configuration change is installed.

Instruction V11 includes the linked context/constraint reference in each new
launch's private system-instruction bundle. Existing live V10 snapshots stay
unchanged. A local original Claude 2.1.304 literal-response probe returned the
V11 marker, bundled context-reference title and an owner constraint code after
deliberate acknowledgement. The dependent reviewer remained planned without a
worker report or validation. The response was visible but its receipt remained
`delivered` despite lifecycle pickup/Stop in the initial probe. An owned-session
hash/transcript comparison identified Claude's whole-paste envelope. After its
strict adapter fix, a fresh isolated probe reached `settled` with
`promptMatch:claudePasteWrapper`, retained result null/review planned, and observed
worker exit through explicit run stop. This proves instruction/context consumption
and correlated response settlement, not actual provider compaction, model-to-MCP
execution or native resume.
