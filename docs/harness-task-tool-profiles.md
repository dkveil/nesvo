# Native tool selection for task profiles

`taskNativeToolProfiles:true` adds optional `profile.allowedNesvoTools:string[]`
to task launch and each executor task profile. This is a new-process selection,
not an edit of a running session. It adds exact Nesvo native permission rules on
supported Claude harness launches; it does not restrict all other provider tools,
bypass provider deny/ask rules, grant host authority or create an OS sandbox.

## Selection and inheritance

| Request          | Bound coordinator run                                    | Owner coordinatorless run                           |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Field omitted    | Preserve the coordinator's existing child-policy default | No native additions                                 |
| `[]`             | Explicitly choose no additions                           | Explicitly choose no additions                      |
| Exact tool names | Subset of the coordinator's immutable owner child policy | Explicit owner selection from the published catalog |

At most 32 unique exact names are accepted. Wildcards, raw native permission
rules, other servers' tools and unknown names are refused. A bound run always
uses its actual authenticated coordinator policy, including an owner or executor
launch into that run. Owner access does not override that policy through a task
profile. A deliberate fresh coordinator launch is required to declare a different
policy. A worker cannot launch tasks or gain coordinator authority by selecting
`nesvo_create_session`.

Selecting the field, including `[]`, requires a supported Claude harness launch.
A coordinator's omitted `harness` inherits its launch setting; an owner
coordinatorless selection must explicitly use `harness:true`. Provider version,
native client, workspace, run, attempt and process budgets are still checked.

Selection is validated before Git worktree setup or native spawn, then checked
again against the live authority before spawn. An initial refusal retains the
reserved attempt and a failed native receipt with `effectStarted:false`.
Uncertainty after setup keeps the existing unknown-effect reconciliation rules;
never use a new key as an automatic retry.

## CLI and MCP

```powershell
nesvo run launch RUN_ID --task TASK_ID --key worker-1 --revision RUN_REV --program claude --shared --allow-nesvo-tool nesvo_get_current_task --allow-nesvo-tool nesvo_report_task_result --json
nesvo run launch RUN_ID --task OTHER_TASK_ID --key worker-2 --revision CURRENT_RUN_REV --program claude --shared --clear-nesvo-tools --json
```

These are distinct intents, not retries. `--allow-nesvo-tool` repeats;
`--clear-nesvo-tools` conflicts with it. Ordinary launch without either flag keeps
its old serialized intent and fingerprint. CLI and MCP require the new capability
before relying on a selection, including an empty one.

Equivalent MCP `nesvo_launch_task` profile:

```json
{
  "program": "claude",
  "workspace": "shared",
  "allowedNesvoTools": ["nesvo_get_current_task", "nesvo_report_task_result"]
}
```

`nesvo_start_run_executor` and `nesvo run executor start --file ...` accept the same
field in each `spec.tasks[].profile`. Stored executor configuration remains
requested intent; each fresh dispatch rechecks the current coordinator policy.
The session-create fields `allowedNesvoTools`/`childAllowedNesvoTools` remain
owner-only. Task selections do not become those raw owner fields during launch
normalization: the host derives an internal native grant with its own provenance.

## Inspection and persistence

The immutable launch acceptance and `run task` / `nesvo_get_task_attempts` history
include `launch.profile`, the requested profile. An additive SQLite migration
leaves old records at `profile:null`; it never guesses their settings or rewrites
saved mutation replies. Omission, empty selection and different exact selections
have distinct workflow fingerprints. Replaying the original key returns its saved
acceptance without creating another process or applying new settings.

Session get/explain show the actual configured `harness.nativePermissions`:
bound selections retain `source:ownerChildPolicy` and their coordinator origin;
owner coordinatorless selections use `source:ownerLaunch`; empty selections use
`source:none`. These fields do not claim model consumption (`loaded:null`).

Historical task/executor profiles survive host restart for inspection. They do
not restore process authority. Saved process-recovery descriptions still omit
native additions and child-policy declarations, and restart does not automatically
spawn or replay input. Metadata coordinator rebind remains separate from adopting
a worker's native process.

## Verification and current limits

Unit tests cover profile fingerprints, omitted/empty CLI flags, immutable replay
and migration of existing rows. The native official MCP SDK/CLI test launches a
real isolated host and controlled CLI-shaped PTYs, inspects actual provider-facing
settings, and checks subset/default/empty behavior, owner coordinatorless intent,
executor dispatch, refusal before worktree effects, worker scope, restart history
and absence of automatic authority restoration. It calls no models and changes no
global provider configuration.

Original-model integration previously verified the separate default child policy
through the bounded coordinator recovery profile. That result does not certify
this new subset selector with a real model. External MCP servers/skills, controlled
native resume and broader provider support remain F37/F38 work. No new dependency
is required for this selector.
