# Bounded original-provider coordinator recovery probe

This is a prepared acceptance scenario for F12/F15/F18/F19/F26/F40/F41. It is
metadata-only, not an implementation/review of source code or a completed stage
three gate. Preparing this document does not authorize a model launch.

## Proposed owner scope

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
