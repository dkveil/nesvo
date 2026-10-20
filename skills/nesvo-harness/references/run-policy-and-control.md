# Run policy and native control reference

## Run budgets and graceful drain

When the host advertises `runBudgets`, inspect `run budget get RUN_ID --json`.
Workers see only their own policy in `run context`. Parallel limits count both
assigned workers and reported results awaiting validation; an idle screen or
inbox ACK does not release capacity. A failed result needs deliberate validation
and a fresh worker for a retry. The attempt limit includes the first attempt.
Global retained-session, running-worker and provider process caps are independent
owner policy. A coordinator cannot raise those caps or recursively grant roles.

`run budget set RUN_ID --key POLICY_KEY --revision RUN_REV --file POLICY_JSON
--json` replaces all three policy fields, with a 4 KiB file bound:

```json
{ "maxParallel": 2, "maxAttemptsPerTask": 3, "maxElapsedMs": 1800000 }
```

Parallel/attempt limits are 1–16; elapsed is explicit null or 1000–604800000 ms.
Coordinators can only tighten policy. Only the human owner may relax it or
extend/remove an exhausted time limit. Do not substitute owner pairing or edit
private context when a limit blocks work. Surface the specific budget and wait
for authorized policy changes. Exhaustion blocks new assignments and automated
input; existing workers may still report honestly and parents may validate them.
Activation starts the clock. Drain, resume, reconnect and metadata edits never
reset it; a backward clock jump or replayed reply does not reopen exhaustion.

With `runDrain`, `run drain RUN_ID --key DRAIN_KEY --revision RUN_REV --json`
blocks new assignments while current reports/validation finish. It does not
interrupt, stop or kill native processes. An owner drain remains owner-controlled
even if a coordinator drains again. Only owner can resume it; a coordinator may
`run resume RUN_ID --key RESUME_KEY --revision RUN_REV --json` for its own drain.
Resume preserves budgets/history and performs no launch or input replay. A fully
validated completed run cannot be revived. Do not invent run-wide stop/cancel
commands from drain; native run control requires the separate capability below.

Policy/drain/resume replies recover with `run mutation --key ORIGINAL_KEY
--json`, followed by `run get`/`run budget get` for current state. Recovered policy
or drain data is historical, not permission to restore it. Use the exact run
revision, distinct from the global budget and decision revisions. After a native
send returns unknown, inspect `operation --key ORIGINAL_SEND_KEY --json` and the
terminal before any new intent: paste may exist even if Enter was refused by a
new decision/deadline. Resolve a blocker without overwriting a human draft.

## Native run control

With `runControls`, `run stop RUN_ID --key KEY --revision RUN_REV --json`
accepts a durable request to stop only that run's bound worker processes.
`run cancel RUN_ID --key KEY --revision RUN_REV --json` also closes remaining
planned work. Neither targets the coordinator, unassigned children or foreign
sessions. A metadata parent or matching display name grants no native control.
Do not use these actions merely because a worker is quiet.

The first reply is immutable **acceptance**, not proof of termination. Recover
it with `run mutation --key ORIGINAL_KEY --json`, then inspect `run control
RUN_ID CONTROL_ID --json`. Pages contain up to eight targets and `nextOffset`;
continue with `--offset NEXT_OFFSET` when supplied. Targets identify their
original native operation key and nullable receipt ID. For an uncertain target,
inspect `operation --id RECEIPT_ID --json` and current session/terminal evidence.
An owner inspecting a coordinator's native operation should use its returned
receipt ID; native keys alone remain caller-scoped.

`stopRequested` is not exit. Only host-observed exit permits completion; missing
processes after restart are unavailable, not assumed stopped. Pending/unknown
control rejects another key with `control_unconfirmed`. Reads, reconnect and
same-key replay never send signals. A new deliberate intent after a known
no-effect refusal requires resolving the blocker and rereading the run revision.
Never force uncertain effects, clear a human draft or take over a lease. Run
control also protects a retained human draft after the lease is released.

A completed stop becomes `stopped` and may be explicitly resumed, preserving
budgets/history and the owner latch. Unreported stopped work needs a fresh
worker/attempt; reported results remain for actual validation after resume,
without automatic reexecution. A completed cancellation becomes `canceled`
and cannot resume. Both preserve results/history without inventing task success
or checks. Pending decisions close without inferring answers or permissions.
Only the owner can resume an owner stop. Coordinator permissions do not expand
because a control request was accepted or a process disappeared.
