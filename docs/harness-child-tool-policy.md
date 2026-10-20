# Owner policy for native child tool additions

`childToolPolicy:true` allows the owner to choose a separate immutable Nesvo tool
allow list for a coordinator's authenticated direct Claude harness children.
Default launches declare no policy and preserve existing behavior. This is
separate from the coordinator's own `allowedNesvoTools` list.

```powershell
nesvo session create "Coordinator" --key coordinator-policy-1 --program claude --role coordinator --harness --allow-nesvo-tool nesvo_create_session --allow-child-nesvo-tool nesvo_get_current_task --allow-child-nesvo-tool nesvo_report_task_result --json
```

Equivalent owner MCP `nesvo_create_session` specification:

```json
{
  "key": "coordinator-policy-1",
  "spec": {
    "name": "Coordinator",
    "program": "claude",
    "role": "coordinator",
    "harness": true,
    "allowedNesvoTools": ["nesvo_create_session"],
    "childAllowedNesvoTools": ["nesvo_get_current_task", "nesvo_report_task_result"]
  }
}
```

The coordinator receives its own exact create-tool native allow addition. When
that authenticated coordinator creates a supported Claude harness worker, the
host derives the child's two additions from the owner policy. A task launched
under that coordinator, including an owner/executor dispatch using its native
authority, follows the same path. No prompt or automatic task admission follows
merely from declaring policy.

## Authority and scope

- Only owner launch can set `childAllowedNesvoTools`, including an empty array.
  An explicit coordinator role is required. Up to 32 unique exact names use the
  same public catalog/validation as direct native additions. CLI repeats
  `--allow-child-nesvo-tool`; older hosts fail the capability check.
- The coordinator cannot supply either native-addition field while creating a
  child, replace its declared policy, choose a foreign parent/policy or create
  another coordinator. The effective grant is a native authority-adapter value;
  it is never deserialized from a caller or inserted into the raw request during
  repeated normalization.
- A `parentSessionId` supplied by the owner as lineage alone applies no policy and
  grants no coordinator authority. Only authenticated coordinator creation (or
  explicit host workflow authority under it) selects that process's policy.
  Two coordinators' policies remain independent.
- Policy applies only to supported Claude children with the Nesvo harness enabled.
  Explicit harness opt-out and other programs receive no additions. A coordinator
  itself need not use the Claude harness to declare owner policy: native CLI
  coordinators can explicitly create supported harness children.
- Child processes do not receive a further child-policy declaration. The policy
  does not recur, grant a worker a coordinator role, bypass workspace/run/attempt
  checks or override human control. A native allow for an owner-only tool remains
  refused by the host. Provider deny/ask rules still apply.
- Like direct additions, this does not restrict all other provider tools or
  create an OS sandbox. Provider-internal subagents retain native provider policy;
  they are not independently managed Nesvo children.

Get/list/explain show the coordinator's `harness.childToolPolicy.{allow,scope,
recursive,source}`. Each configured child shows
`harness.nativePermissions.source:ownerChildPolicy` and `originSessionId` for its
authenticated coordinator. Its own child-policy list stays empty. `loaded:null`
still does not claim model consumption. Existing processes are unchanged.

## Lifetime and recovery

The declaration belongs to the coordinator process's authenticated context and
cannot be edited in place. Original-key create replay never changes an existing
process or its child's additions; changed declaration conflicts. An already
created worker keeps its configured additions for that process lifetime, but no
new host authority follows from its parent's exit or metadata rebinding.

Saved process recovery descriptions omit native allow additions and child-policy
declarations. Replacing a coordinator requires a deliberate new owner selection;
binding old run metadata does not restore it. Explicit owner-authored templates
or jobs retain their separately declared future launch intent. Model/effort
selection is a distinct profile field with its own inheritance contract.

## Verification and limits

Controlled official SDK/CLI tests inspect actual provider-facing inline settings,
independent parent/child allow lists, child-policy origin, owner/workflow task
launch, harness opt-out, passive shell behavior, metadata-only parent IDs,
independent coordinators, forbidden replacement/recursive grants, invalid names
and worker host refusal despite native allow. Ordinary default-inheritance tests
still verify that a parent's own allow list is never copied. Fixtures are
original-CLI-shaped executables, not original models.

After an actual host restart a raw authenticated native recovery read verifies
that saved coordinator descriptions omit both native-addition fields. This read
uses the shared frame codec without a UI projection discarding new fields. The
same probe verifies that explicit model/effort selection is retained independently.

This feature supplies a reviewable native tool policy for an original-model
orchestration test. It does not authorize that broader test automatically or
complete the full F19/F37/F38 policy surface. Per-task subsets, general role
bundles, external MCP/skills and policy editing/resume remain separate work.
