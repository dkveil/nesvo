# Bounded original-provider coordinator recovery probe

This is a prepared acceptance scenario for F12/F15/F18/F19/F26/F40/F41. It is
metadata-only, not an implementation/review of source code or a completed stage
three gate. Preparing this document does not authorize a model launch.

## Revision 1 scope (ended before the first prompt)

- One isolated host with private pairing, native temporary files and immutable
  binary copies. The workspace is an owned ignored scratch directory under
  `target/verification`, not the user's active checkout.
- At most two sequential coordinator processes and two worker processes over
  the whole scenario, three concurrent sessions and one parallel task attempt.
  Each task permits one attempt. The run elapsed budget is 180 seconds; cleanup
  and bounded startup observation are separate. No automatic retry of this run.
- Original Claude, requested model `opus`, effort `low`. Requested selection is
  not evidence of the actual resolved model. No extra credits or login changes.
- Exact launch-local native tool additions listed below; no provider permission
  mode changes, native approval/trust key presses or CLI fallback by models.
  `ToolSearch` may discover only Nesvo tools. No file edits, shell commands or
  provider-internal subagents are requested or approved.
- Existing provider configuration remains active. Native allow additions and an
  owned workspace are not an OS sandbox or a restriction on all other tools.
- The controller may answer only the worker's exact attempt-bound data question:
  `May I submit the fixed metadata-only probe report, without files or commands?`
  with `Yes. Submit only the fixed metadata-only report; do not read, edit or
execute files.` This is not consent to a native permission dialog or another
  question. Unexpected auth/quota/permission boundaries end the probe.

The coordinator's own exact Nesvo tool names (17):

```text
nesvo_get_current_session
nesvo_recover_run_context
nesvo_read_run_context
nesvo_get_run
nesvo_get_run_budget
nesvo_get_run_mutation
nesvo_get_run_wake_batch
nesvo_get_task_attempts
nesvo_read_inbox
nesvo_ack_messages
nesvo_send_message
nesvo_launch_task
nesvo_deliver_task
nesvo_validate_task_result
nesvo_stop_session
nesvo_get_session
nesvo_get_operation
```

The owner selects the same explicit child policy separately for each new
coordinator. Its direct authenticated Claude harness children receive only these
six native additions:

```text
nesvo_get_current_task
nesvo_report_task_result
nesvo_ask_decision
nesvo_get_decision
nesvo_read_inbox
nesvo_ack_messages
```

## Observable scenario

1. The owner prepares a two-task implementer → reviewer dependency. Coordinator
   one launches and delivers only the implementer's immutable metadata task.
2. The implementer asks the exact owner question and ends its turn. The controller
   waits for settled input, then stops only coordinator one, leaving the worker.
3. The owner deliberately starts coordinator two with the same explicit policy
   and rebinds run metadata at the exact revision. This restores neither native
   authority over the old worker nor old wake/input generations.
4. Coordinator two recovers the stored goal/inbox. A fresh proof exists only in
   host goal data, never its prompt. The owner answers the exact question once and
   sends one explicit resume to the old worker. Its original attempt reports.
5. Coordinator two reads and validates that attempt's exact literal marker. The
   only passed check attests to that metadata comparison, not tests or code. The
   owner stops the old worker after acceptance to release physical capacity.
6. Coordinator two starts the reviewer as its own new child, sends an addressed
   inbox message with the accepted attempt identity and result, then delivers the
   task. The reviewer reads/ACKs context and reports its own distinct attempt.
   Coordinator two validates its metadata marker and stops only its new child.

At most one explicit context follow-up after owner-observed slot release is
permitted. There are no unchanged-state heartbeat prompts or automatic retries.

## Required evidence and cleanup

Acceptance matches each original provider tool-use ID to a non-error native tool
result and the actual run/task/attempt identities: both launches/deliveries,
worker reports, coordinator validations, owner question and recovered context.
The final reply must contain the proof from host goal data. Reports have empty
files/artifacts/checks and explicitly declare their metadata-only limitation.
Parent identities must show the implementer under the old coordinator and the
reviewer under the replacement. Model text alone or controller API calls do not
prove model use of MCP.

Cleanup stops only these owned sessions and closes the owned host stdin. Every
observed descendant is recorded with its creation timestamp, then checked for up
to 15 seconds. A surviving matching identity fails cleanup; it is not silently
killed by PID or called a passing gate. Workflow and cleanup outcomes are
separate. Original failed reports are preserved and never overwritten.

The prepared private probe validates this policy against the published catalog
and refuses launch without its separate explicit owner-approval flag. Its
`--describe` path and pure evidence-correlator checks launch no process/model.
Native deny/ask rules can still block the proposed additions; a refusal is an
external observation, not permission to widen policy or change transport.

## Revision 1 result

The owner approved this exact scope. One coordinator started, but the controller
treated string lifecycle `blockReason` as an object and failed before submitting
any prompt or creating a run/worker. Host exit was zero and every observed owned
descendant was gone. The original failed report is preserved. This is not an
original-model orchestration result and does not authorize an automatic retry.

The unused scratch directory had no exact accepted native Claude trust record;
the existing repository workspace did have one. This is a configuration fact,
not proof of which blocker caused that lost observation. No trust/settings were
modified. A future controller handles the documented string/null projection,
stops on setup/auth/quota/permission and records bounded safe lifecycle metadata.
Eight pure guard cases verify those data and refusal paths without model launch.

## Revision 2 proposal (requires a new owner decision)

Repeat the same single bounded scenario, including the exact 17 coordinator and
six child tools, at most two sequential coordinator starts/two worker starts,
three concurrent sessions and a 180-second run budget. This is a new explicit
test authorization; the revision 1 start is not hidden or counted as success.

The sole workspace change is using the existing trusted repository directory as
the providers' cwd. No source reads, edits, file/code tasks or shell commands are
requested or approved. Private host/pairing/temp and immutable runtime copies
remain isolated. The fixed reports and validations attest only to metadata
markers. This is still not an OS sandbox: inherited provider/global permissions
remain active, and the final native transcript audit must reject tool use outside
the declared set. No trust key, native permission key or global modification may
be used to make startup work. Any unexpected native boundary ends this probe.

The corrected controller must pass its catalog, lifecycle-projection and native
call/result identity checks before launch. The new Windows session-job cleanup
must also pass its native PTY and host/MCP regression tests first. Revision 2 is
prepared before separate approval; its later result is recorded below.

## Revision 2 result and shared preflight

With separate owner approval, original Claude 2.1.304 on Windows completed the
implementer portion across coordinator replacement: actual native MCP launch and
delivery, an attempt-bound owner question, the preconsented literal owner answer,
the original worker's exact result, recovered context and replacement-coordinator
validation. Three exact owned provider conversations were correlated with native
tool-use/result IDs. Every observed assistant tool belonged to the approved
Nesvo policy or Nesvo-only discovery. This is partial metadata-only evidence,
not source implementation or a completed run.

The review task's first launch was refused with `budget_exhausted` and
`effectStarted:false`. The controller mistakenly set `maxSessions:3`, which
counts retained records, including stopped processes. Old coordinator, old
worker and replacement consumed those slots even with fewer live processes.
The host correctly enforced its documented policy. No new key/attempt or policy
relaxation retried that launch. The run timed out, host exit was zero and all 89
observed owned descendants were gone. Original reports and partial native
evidence are preserved; this is not a passing whole-workflow result.

The versioned [shared fixture profile](../tests/fixtures/native-recovery-profile.json)
now distinguishes four retained slots for four lifetime session identities from
three live provider processes, two running workers and one parallel task. The
17/6 tool names and 180-second run budget remain the same.

A full official MCP SDK/CLI preflight uses that exact profile and real PTYs,
without original models. It delivers the first task, preserves/answers a pending
question across replacement, rejects native adoption of the old worker, reports
and validates its exact attempt, sends/ACKs addressed reviewer context, delivers
the review task and validates its distinct result. Both child inline native
permission lists and policy origins are inspected. A deliberate three-slot
refusal leaves the review task planned; four slots then admit its first attempt.
The targeted scenario and all 27 serial native SDK scenarios pass. Fixtures do
not prove model behavior.

## Revision 3 proposal (requires a new owner decision)

One new original-model attempt may use the MCP-tested shared profile directly,
with no copied hard-coded retention limit. Native process/tool/parallel/time
bounds and existing trusted cwd remain as in revision 2. Four retained records
support the already proposed two coordinator/two worker starts; this does not
raise the three-live-process ceiling. Unexpected native permissions, unknown
effects or a known failed task launch stop the probe; no policy change or retry
is permitted. The controller retains original conversation pointers before
cleanup even if later validation fails. No revision 3 original-model launch is
implied by the passing SDK preflight or by this preparation.

## Standing owner authorization

After reviewing the passing shared-profile preflight, the owner authorized
necessary subsequent probes of that checked profile without asking again for
each run. This supersedes the earlier per-run reconfirmation requirement within
this profile's existing scope. Preserve its exact tool, task, process and time
bounds and isolated host configuration. Record each original outcome rather than
overwriting it. The live-process bound counts managed provider session roots;
OS/provider helpers are observed separately for cleanup. An unknown native effect
still requires reconciliation of its original identity, never an automatic retry.

## Revision 3 result

The shared checked profile passed on original Claude 2.1.304, native Windows.
The host run contains succeeded implement/review tasks with distinct explicit
results and coordinator attestations of the fixed metadata markers. Four exact
original provider conversations were correlated with their native MCP call and
non-error result IDs for both launches/deliveries, the owner question, worker
reports, replacement recovery and validations. The final replacement reply
included the fresh proof stored only in host goal data.

A separate read-only audit of those same exact conversation IDs confirmed that
the replacement's addressed context message contained the accepted dependency
attempt ID and summary, and that the reviewer read and ACKed that same message
ID through successful native MCP calls. Parent identities place the implementer
under the original coordinator and the reviewer under its replacement. No
undeclared assistant tool or provider-internal subagent was selected.

The host exited zero and all 135 observed owned descendants were gone within the
15-second cleanup observation. Workflow and cleanup both passed. Earlier failed
revision 1/2 reports and the older five-second cleanup failure remain preserved.
This confirms the bounded metadata scenario, not code editing, verified tests,
general native-worker adoption, arbitrary profiles or full F01–F44 completion.
