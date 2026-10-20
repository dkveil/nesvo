# Recovering a run's coordinator binding

`runCoordinatorRecovery:true` adds an owner-only, explicit metadata operation.
It attaches retained Run/Task/Attempt context to a different live native
coordinator when the previous coordinator is unavailable to this host. The run
keeps its goal, plan, dependency gates, results, unacknowledged inbox messages,
owner constraints, attempts and budget history.

```powershell
nesvo run get RUN_ID --json
nesvo session create "Replacement coordinator" --key replacement-1 --program claude --role coordinator --harness --cwd C:\work\project --json
nesvo run bind-coordinator RUN_ID --from OLD_SESSION_ID --session NEW_SESSION_ID --key rebind-1 --revision CURRENT_RUN_REVISION --json
```

The new session must have the retained canonical workspace and exact group. It
needs a live launch-local scoped capability and the coordinator role. A worker,
arbitrary session ID, matching display name or UI focus is insufficient. An old
coordinator still running in this host is refused. For an originally unbound run,
use explicit `--unbound` instead of `--from`.

CLI and MCP `nesvo_rebind_run_coordinator` use the same host transaction:

```json
{
  "key": "rebind-1",
  "runId": "RUN_ID",
  "expectedRevision": 7,
  "expectedCoordinatorSessionId": "OLD_SESSION_ID",
  "coordinatorSessionId": "NEW_SESSION_ID"
}
```

`expectedCoordinatorSessionId` is required; explicitly use JSON null for an
unbound run. Only the authenticated owner may rebind. Coordinators and workers
cannot use this operation to acquire another run. The source ID and revision are
compared atomically. Retrying the original key returns its immutable acceptance,
even after a later replacement; it never applies an old binding again. Changed
intent with that key conflicts. After a timeout, inspect `nesvo run mutation --key KEY --json`
or repeat the exact original request instead of inventing a new key.

## What changes and what remains uncertain

The transaction increments run revision and coordinator generation. It pauses
executor/wake policies, invalidates their old generations and pauses queued task
input. Native run-bound sends accepted under an earlier coordinator generation
are fenced before paste and again before Enter. A partially pasted draft stays
an unknown effect; replay cannot rearm it and a fresh key cannot erase it.
Independent already running model work is not interrupted.

The replacement can read current run context and inbox, including old report
references. It cannot control/read old worker terminals merely because it now
owns run metadata: existing native parent/capability grants remain unchanged.
The target's human control lease and any draft are preserved. The operation does
not type, ACK messages/constraints, validate results, reset budgets, adopt a
process, enable policies or reapply native permission additions. Response flags
`nativeEffectsRestored:false` and `workerAuthorityRestored:false` make that explicit.

`run.coordinatorBinding` records source evidence, generation, workspace/group and
binding time. A retained session supplies `retainedSession`; after host restart,
trusted saved launch context supplies `recoveryRecord`; a later replacement may
use `previousBinding`. Missing/malformed context is refused instead of guessing.
These describe workspace evidence. An absent old process in host memory is not
proof of OS process exit. Unknown worker effects/slots stay unreconciled.

Run reads and `run recover` provide metadata context, not native conversation
resume. The replacement is a newly created process. Use its scoped CLI/MCP to
read `run recover RUN_ID`; the existing native recovery hook can read that context
on a later supported recovery event. Binding itself does not trigger a model
turn or inject a prompt. Exact provider conversation resume, deliberate worker
adoption and owner reconciliation of unknown effects remain separate F41 work.

## Storage and compatibility

An additive `workflow_coordinator_bindings` table retains current binding facts.
The native-input context table receives an idempotent
`coordinator_generation INTEGER NOT NULL DEFAULT 0` migration. Existing input has
generation zero and stays usable before any replacement; after replacement it
cannot silently acquire current authority. Back up data before downgrading:
older binaries do not implement this generation fence. Use one upgraded host per
data directory as described in [directory ownership](host-directory-ownership.md).

The CLI checks capability before sending the new command; the MCP catalog has 61
tools. Existing response fields stay compatible; binding summary fields are
additive. No new dependency, global provider setting or UI change is required by
this metadata operation.

## Verification

Storage tests cover migration, scopes, missing/retained source context, atomic
workspace/revision refusal, immutable replay, owner constraints, inbox, budgets,
attempts and old executor/wake/input generations. Native official MCP SDK/CLI
tests use isolated host processes and real PTYs with a controlled provider:

- An unavailable coordinator is replaced, with CLI/MCP replay parity and actual
  response envelopes validated by Ajv. A live old coordinator, worker target,
  wrong workspace, stale revision and scoped caller are refused.
- New coordinator context/inbox retains pending questions/result references;
  old worker terminal authority and a target human lease/draft are preserved.
- An actual graceful host restart retains results, inbox and pending owner rules;
  only the explicitly created replacement runs afterward. No worker is restarted
  or historical input replayed.
- Rebinding after an actual owner paste stops Enter with `coordinator_changed`;
  the original receipt remains unknown, a fresh-key send is blocked by the draft
  and no fixture response is produced.

These fixtures are not original models. Windows is verified locally; CI provides
separate Unix runtime evidence. Full F40/F41 completion requires the remaining
conversation-resume, adoption, reconciliation and UI/mobile acceptance gates.
