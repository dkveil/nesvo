# Explicit host DAG executor

`runExecutor:true` adds opt-in automatic task selection to an **already active,
immutable run plan**. The host creates visible native workers and queues their
literal task instructions using the existing atomic launch/delivery adapters.
It never runs a model itself, invents task success or sends a model heartbeat.
Original installed providers retain their login and permission behavior.

```powershell
nesvo run get RUN_ID --json
nesvo run executor start RUN_ID --key execute-1 --revision RUN_REV --file profiles.json --json
nesvo run mutation --key execute-1 --json
nesvo run executor get RUN_ID --json
nesvo run task RUN_ID TASK_ID --json
```

`profiles.json` explicitly covers **every host task ID**, exactly once:

```json
{
  "tasks": [
    {
      "taskId": "IMPLEMENT_TASK_ID_FROM_RUN_GET",
      "profile": { "program": "claude", "workspace": "shared", "harness": true }
    },
    {
      "taskId": "REVIEW_TASK_ID_FROM_RUN_GET",
      "profile": { "program": "claude", "workspace": "shared", "harness": true }
    }
  ],
  "retryFailed": false,
  "retryDelayMs": 1000,
  "readinessTimeoutMs": 60000
}
```

Choose `shared` or `worktree` per task deliberately. A worktree starts from the
existing native adapter's repository revision; it does not automatically transfer
another worker's uncommitted changes. Branch/artifact handoff and file ownership
remain separate workflow work. Optional `name` and `cwd` retain ordinary native
scope checks. Agent programs are `claude|codex|gemini`; plain shells are refused
so plan prose never becomes a shell command. Supported launch-local Claude harness
configuration may be enabled/inherited; explicitly use `harness:false` for other
providers where required. This does not grant coordinator or native permissions.

The specification is immutable after start. Limits: 1–64 task profiles, 24 KiB
serialized spec, retry delay 1000–60000 ms (default 1000), readiness timeout
1–300000 ms (default 60000). Retry is **off by default**. Editing/replacing an
executor spec is not an implicit new execution; `executor_exists` requires
inspection, not new keys. Profile editing/migration remains further work.

## Scheduling and result gates

The deterministic loop observes host journal changes and bounded local timers.
It admits one native action at a time per executor, without holding State/SQLite
locks over adapter awaits. Native worker launch still atomically reserves its
attempt, retry number, parallel slot and receipt before process/worktree setup.
Its executor identity/generation/provenance commits in that same transaction.
Delivery registration checks the same current generation before acceptance.

- Only dependency-ready tasks start. A reported result still occupies its slot.
- An accepted, independently validated result releases dependent tasks; idle,
  quiet output, native response settlement and decision ACK cannot substitute.
- Existing manually assigned attempts are observed and left alone. The executor
  queues instructions only for attempts whose native launch it actually admitted.
- Launching/unknown launches retain capacity. Unknown input never gets a new key
  or fresh delivery. Existing queued/sent/paused/failed/expired intents are not
  rearmed by executor enable, reconnect or polling.
- Opt-in retries create a fresh attempt only after known failed/stopped/no-effect
  startup history, with cooldown and the current run retry/parallel/time limits.
  They cannot reset attempts, activation time, owner drain or host/provider caps.
- Decisions remain explicit and attempt-bound. Pending/expired/canceled gates
  block further success/input without native permission approval. Other eligible
  independent tasks may progress within policy.

The human-control epoch is captured when scheduling is enabled and carried into
task delivery. Quick takeover/release between automatic startup and instruction
registration still pauses input. A fresh scheduling generation cannot rearm that
paused instruction. No controller lease, user focus or draft is acquired/cleared.

## Disable, enable and restart

```powershell
nesvo run executor disable RUN_ID --key disable-1 --revision RUN_REV --json
nesvo run executor enable RUN_ID --key enable-1 --revision RUN_REV --json
```

Disable stops **new admissions**. Already committed native startup/instruction
may finish; it does not retract bytes, kill workers or replace run stop/cancel.
Enable requires an active run, a new deliberate key/current revision and fresh
authenticated authority. It increments a generation; old runtime futures cannot
admit new effects or overwrite its state. Owner may enable/disable its authorized
run; a coordinator has only its own run. Existing bounded coordinator capability
still controls worker creation even for owner-issued delegated launches. A dead
coordinator is not revived; adoption remains separate recovery work.

The waiter survives requesting-client disconnect. Host restart disables executors,
increments generations and records `paused/host_restart`; it never resumes
authority or native effects automatically. Existing launch/delivery receipts keep
their own uncertainty. Explicit enable does not prove process adoption, free an
unknown slot, rearm delivery or validate work. End-to-end process/conversation
adoption remains F41.

A job-owned run has one more pause. When a job's uncertain-effect retry probe
finds no effect, the same transaction disables that run's executor, increments its
generation and records `paused/job_retry_waiting`, so the fenced run can never
admit another launch, delivery or wake. Enabling it again is refused with
`job_generation_retired`; the retry continues in a fresh run of its own
([retry classes](harness-jobs.md#retry-classes)).

At most 16 executors are enabled and 1024 are retained. Disabling frees the runtime
slot, retaining all process/attempt/result history. Run stop/drain/time guards and
global native budgets remain authoritative. Final success/cancellation completes
and disables scheduling without inventing worker results or terminating unrelated
sessions.

## Evidence and recovery

Start/enable/disable use workflow mutation keys and exact run revisions. CLI exit
zero is immutable acceptance. Inspect current executor, run/task history and
authorized non-null native receipt IDs separately. Executor projection includes
`id`, `runId`, immutable `spec`, current `issuer`, `enabled`, `generation`, `phase`,
`reason`, `taskId` and `createdAt`.

Phases: `enabled`, `waiting`, `blocked`, `disabled`, `paused`, `completed`.
Human/unknown/decision blockers take priority over routine waiting in the current
reason. Identical notes do not emit more events or change revisions. Native
provenance does not verify a model's claimed files/checks. Receipt IDs remain
pointers, not cross-issuer grants. Owner receipt access and coordinator child/run
access are distinct.

MCP tools share this contract:

- `nesvo_start_run_executor {key,runId,expectedRevision,spec}`
- `nesvo_get_run_executor {runId}`
- `nesvo_disable_run_executor {key,runId,expectedRevision}`
- `nesvo_enable_run_executor {key,runId,expectedRevision}`

Authenticated wire: workflow action `executor`, nested request action
`start|get|disable|enable`. Clients cannot supply executor admission guards,
human epochs or native authority flags. Unsupported hosts fail capability checks
without a manual-launch fallback. No new dependency is required.

Storage regressions cover strict policy/scope/revisions, idempotency, generation
invalidation, retention/admission limits, event coalescing, restart and atomic
provenance/native rollback. Controlled official-SDK scenarios use real PTYs:
implementer asks an owner-only question, coordinator answer is refused, owner
answers, explicit result awaits independent validation, then review launches once;
disable/owner enable preserve authority and manual workers. Further scenarios
cover delayed readiness with quick human takeover, no rearm on enable, bounded
known-failure retries and no retry/capacity release for uncertain worktree effects.
These controlled providers make no model calls; full original-provider orchestration,
job scheduling and complete recovery/mobile gates remain required harness work.
The separate [wake policy](harness-wakes.md) provides delta-only coordinator
notices; [owner constraints and checkpoints](harness-checkpoints.md) pause enabled
generations when new manual text arrives. Context acknowledgement never reenables
scheduling or rearms an existing delivery. Fresh task input includes current
constraints; native and validation guards remain independent.

Native input admission refreshes already received PTY evidence before each write,
instead of relying on the last coalesced UI status tick. After an owned paste,
screen-only I/O activity waits for fresh idle editor evidence until the editor
settles, a guard refuses or 45 seconds (the provider readiness bound) have
passed since the paste, however busy the terminal stays. It
never qualifies as idle itself. The paste is not repeated; all run, lifecycle,
conversation, human and authority guards are checked again before Enter. Semantic
working/permission evidence refuses Enter immediately, retaining an unknown
partial-input receipt. A controlled screen-only provider verifies delayed redraw,
one literal paste and refusal after a real working footer even if idle returns.
