# Explicit native Nesvo tool permission additions

`sessionToolPermissions:true` supports owner-selected native permission additions
for one newly launched supported Claude harness process. The default adds no
native allow rules. This configures the original provider; host capabilities and
its independent role/workspace/run checks remain authoritative.

```powershell
nesvo session create "Coordinator" --key coordinator-1 --program claude --role coordinator --harness --allow-nesvo-tool nesvo_create_session --json
```

The same owner operation is available through MCP `nesvo_create_session`:

```json
{
  "key": "coordinator-1",
  "spec": {
    "name": "Coordinator",
    "program": "claude",
    "role": "coordinator",
    "harness": true,
    "allowedNesvoTools": ["nesvo_create_session"]
  }
}
```

This produces only the following permission addition in the existing single
launch-local inline settings object, beside lifecycle/recovery hooks:

```json
{
  "permissions": {
    "allow": ["mcp__nesvo__nesvo_create_session"]
  }
}
```

The permission rule uses Claude's documented exact
[`mcp__server__tool` syntax](https://code.claude.com/docs/en/permissions#mcp).
Its existing managed/user/project deny or ask rules and blocking hooks still
apply. This is an allow addition, **not** a restriction on every other tool or a
sandbox; preexisting provider configuration remains active. No global settings,
native permission mode, file permissions, login or MCP registration is changed.

## Validation and scope

- Select at most 32 unique exact names from the
  [published Nesvo tool catalog](harness-mcp-tools.json). Wildcards, native rules,
  tools from other MCP servers, unknown names and duplicates are rejected.
- Explicit `harness:true` and a supported Claude version/native client are
  required. CLI repeats `--allow-nesvo-tool`; it requires `--harness`.
- Only the owner can configure these additions. A coordinator/worker cannot set
  the field, even to an empty array. A coordinator's ordinary child can inherit
  the harness but never these native permission additions. Worker host authority
  still cannot spawn merely because its provider is allowed to call the tool.
- Existing processes are unchanged. Saved process recovery records omit native
  additions: creating a replacement requires a deliberate new owner launch.
  An explicitly owner-authored future job/template remains its own launch intent.
- Owner launch receipts include the exact requested list in idempotency input.
  Reusing the same key with changed rules conflicts; inspection cannot reapply
  rules to an old process. CLI/MCP check the capability before relying on it.
- This first policy surface covers session creation. DAG task profiles cannot yet
  delegate native permission additions to arbitrary child launches. General model,
  effort, external MCP/skill profile editing and controlled resume remain separate
  F37/F38 work, not implicitly enabled by this field.

`session get`, `session explain` and snapshots show
`harness.nativePermissions.{allow,scope,source,inheritedByChildren,
providerRulesStillApply,restrictsOtherTools}`. These describe Nesvo's configured
additions only. `loaded:null` still does not claim provider/model consumption.
`inheritedByChildren` describes Nesvo-managed child sessions; provider-internal
subagents follow the provider's policy and are not new host sessions.

## Verification

Native official SDK/CLI tests check the actual provider-facing inline settings,
effective configuration, ordinary child inheritance, owner-only selection,
passive worker host refusal, exact names, replay/conflict and invalid profiles
against real host/PTYs. A deterministic executable captures settings; it never
calls a model. The shared catalog contract is checked against all actual MCP
tool names, preventing permission/schema drift without an application dependency.

With the owner's explicit approval of that narrow scope, original Claude 2.1.304
on Windows completed the isolated probe: exactly one native
`mcp__nesvo__nesvo_create_session` tool call, the requested stable key and a matching
native tool result. The authenticated shell child's `parentSessionId` matched
the coordinator, its role was worker and its controller was null. The assistant
returned that same child ID; the original prompt receipt settled. The host budget
allowed two sessions/one worker, the child received no prompt, and no other tool,
CLI transport fallback, native approval key or global config change was used.
The host exited zero and all 23 observed owned descendants were gone.

This verifies the original-model visible-child gate for that provider/version
and exact policy. It does not prove multi-worker implementation/review, task
permission delegation, arbitrary native tools or cross-provider parity. Earlier
native-permission refusals remain separate failed observations. A deterministic
fixture or an assistant's claim alone would not establish this result.
