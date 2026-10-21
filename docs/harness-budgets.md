# Host process admission budgets

`hostBudgets:true` exposes the owner's persisted admission policy through
`nesvo budget get|set` and MCP `nesvo_get_host_budget|nesvo_set_host_budget`.
Defaults preserve eight session slots, eight running workers and eight running
processes per provider. Increasing the policy can admit more than the former
constant eight; the current unpaged transport/retention safety ceiling is 16.
The separate [run policy](harness-run-budgets.md) adds parallel/retry/time
budgets and drain/resume. [Native run controls](harness-run-controls.md) add
explicit stop/cancel without treating acceptance as process exit.

The mobile snapshot validator accepts up to 16 retained records, including exited
processes, matching the host ceiling rather than the default admission policy.
It does not truncate larger valid lists. Record validation, duplicate-ID checks
and the authenticated 64 KiB plaintext bound still apply. Older mobile builds
with the previous eight-record decoder need an update before using a policy
above eight; this change does not raise the host's configured budget.

```powershell
nesvo budget get --json
nesvo budget set --key host-budget-1 --revision BUDGET_REV --file budget.json --json
nesvo run mutation --key host-budget-1 --json
```

`budget.json` is a complete replacement, not an implicit merge:

```json
{
  "maxSessions": 16,
  "maxWorkers": 10,
  "providers": { "shell": 4, "claude": 6, "codex": 4, "gemini": 2 }
}
```

File reads are bounded to 4 KiB. Unknown/missing fields, malformed JSON and
out-of-range limits are refused. `maxSessions` is 1–16; worker/provider caps
are 0–16. Zero disables admission in that category. These are managed-process
budgets, not account token quotas or an OS sandbox for processes launched inside
an agent. Provider configuration includes caps even for unavailable programs;
it does not claim those programs are installed or quota readings exist.

## Counts and human priority

- **maxSessions** counts retained session records, including exited processes.
  Retaining a terminal's output still consumes memory and snapshot capacity.
  Close that retained session deliberately to free the slot; nothing is silently
  evicted. Durable operation/task history is a separate store.
- **maxWorkers** counts host-observed running processes whose API role is worker,
  including ordinary shells and owner-created agents. Coordinators use session
  and provider capacity but not a worker slot. Provider-internal invisible
  subagents are not independent Nesvo sessions.
- **providers** counts all host-observed running sessions of that program,
  including coordinators. Observed exit releases its live worker/provider
  capacity while preserving its retained session slot.

Owner creates, authenticated coordinator child creates, legacy client creates,
recovery launches and existing one-shot scheduler launches use the same native
admission guard. Native launch rechecks the current policy under the state lock;
concurrent clients cannot independently consume the same last slot. Coordinator
child/workspace grants and the worker prohibition on recursive fan-out still
apply. A budget change never grants a new role or raises an agent's authority.

Only explicit owner authority may inspect/change global policy. Workers and
coordinators cannot raise it themselves or recover another owner's mutation key.
Lowering limits does not interrupt, terminate, clear drafts, acquire control or
change focus. Already admitted work is allowed to finish; later admissions fail
until usage permits them. Policy updates can acknowledge while a previously
admitted native launch completes; they do not recall that launch.

Before spawning, admission reserves exact encoded name/path bytes plus 8 KiB
for startup fields within a 48 KiB snapshot budget. Actual candidate metadata is
checked again before persistence, leaving headroom inside the existing 64 KiB
plaintext frame. A rejected candidate is cleaned up before announcement. Because the existing
snapshot protocol is unpaged, 16 is a safety ceiling, not a guarantee that every
long-path/status combination fits. Further growth and worst-case dynamic
snapshot paging remain explicit transport/performance work. No render function
reads policy files, queries SQLite or starts a polling task.

## Revisions, recovery and persistence

Each policy has its own revision, independent of group metadata and run revisions.
Set requires the exact budget revision and a stable workflow mutation key.
The policy, domain event and keyed outcome commit together through the bounded
journal thread, with immediate SQLite writer admission. No native effect occurs
in that transaction. Reconnect/restart restores the committed policy; the native
state consults a shared in-memory projection published before the reply.
If refreshing that projection fails, new admissions stop instead of retaining
obsolete permissive limits; live processes and their input control remain intact.

Same-key replay returns the original historical outcome. It **does not restore
that historical policy**: the projection always reloads current committed limits.
Use get for the active policy. Different intent under an existing key is rejected;
stale edits do not change state. Lost replies recover through the existing
`run mutation` namespace, separate from native operation receipts. All global
budget history remains owner-scoped.

The workflow wire action is `hostBudget {request:{action:"get"}}` or
`hostBudget {request:{action:"set",key,expectedRevision,limits}}`, inside the
existing authenticated `workflow` envelope. Replies contain
`budget:{revision,limits}` and a domain `cursor` for mutations. `requestId` is
transport correlation, not an idempotency key. Old hosts fail capability checks
without a legacy fallback.

`budget_exhausted` refuses native admission without signaling existing processes.
A durable create reports `operation_failed`, with the specific budget cause and
`effectStarted:false` in its receipt result when refused before native setup.
If Git/native setup already began before a later admission failure, the existing
unknown-outcome rules still require inspection; never invent a new key to retry.
Legacy commands receive the typed budget error. Existing scheduler capacity
failures retain that scheduler's failure policy; budget queuing/backoff is later
job work, not a new automatic retry here.

## Verification and remaining F20 work

Storage/admission checks cover count categories, boundary limits, owner scope,
revisions, full-retention refusal, rollback, historical-key recovery, cache replay
and database reopen. The native SDK fixture creates ten retained sessions with
nine running workers, lowers limits without killing them, checks scoped create
refusals, observes exit/reuse, then retains eleven sessions. CLI and MCP share
policy keys; stale replay cannot restore capacity. This is a controlled native
fixture, without model calls or global provider configuration changes.

The CLI/legacy-client fixture checks versioned JSON output, bounded file reads,
refusal of old create commands and unchanged existing sessions. No new dependency
or UI layout is introduced. The run policy implements per-run concurrency,
elapsed/retry budgets and drain/resume. Native run stop/cancel has a separate
receipt/exit contract. Scheduler budget queues and automatic DAG dispatch remain
F20/F14/stage-4 requirements, with native
ownership, receipts and human priority preserved by this admission foundation.
