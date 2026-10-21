# Launch-local model and effort profiles

`sessionModelProfiles:true` supports explicit model/effort selection for a new
session or task worker. It does not edit provider defaults or reconfigure a live
process. Existing role, workspace, harness, tool-permission and admission rules
still apply. An ordinary launch with no model fields keeps its previous behavior
and idempotency fingerprint.

```powershell
nesvo session create "Coordinator" --key coordinator-model-1 --program claude --role coordinator --harness --model opus --effort low --json
nesvo session create "Codex worker" --key codex-model-1 --program codex --model gpt-6.1-sol --effort medium --json
nesvo run launch RUN_ID --task TASK_ID --key worker-model-1 --revision RUN_REVISION --program claude --shared --harness --model sonnet --effort medium --json
```

The model examples are explicit user choices, not a promise of account access.
CLI/MCP check the capability before sending model fields to an older host. MCP
`nesvo_create_session` accepts `spec.model` and `spec.effort`. The TUI `N` Agent session
form exposes the same fields as MODEL and EFFORT when the host reports support for the
selected provider and sends them in `launch{spec}`. Task launch and
executor task profiles accept the same optional fields:

```json
{
  "program": "claude",
  "workspace": "shared",
  "harness": true,
  "model": "sonnet",
  "effort": "medium"
}
```

They are included in durable launch intent and mutation/native receipt
fingerprints. Reusing a key with another model or effort conflicts. Saved
templates/recovery context retain explicit selection; they never replay a prompt
or start a process just because the profile was saved.

## Provider adapters and validation

The host requires a completed installed-CLI version probe before using an
explicit profile. `doctor.launchProfileSupport` and the capabilities event expose
the probed version, adapter support, flag form and effort source. Shell/Gemini and
unconfirmed versions are unsupported by this first adapter, rather than quietly
ignoring fields.

- Claude: verified `--model MODEL --effort LEVEL` grammar for Claude Code
  2.1.303+ within 2.1. Levels: low, medium, high, xhigh and max. `ultracode` is not
  accepted: it selects provider orchestration behavior rather than only effort.
  See [native model selection and effort](https://code.claude.com/docs/en/model-config)
  and [CLI reference](https://code.claude.com/docs/en/cli-reference).
- Codex: verified 0.156.0 adapter uses `--model MODEL` and a separate literal
  `-c 'model_reasoning_effort="LEVEL"'` argument. In this version effort is a
  model-advertised string, not a fixed universal enum. Nesvo accepts a bounded
  lowercase identifier; the native model/client validates actual support. See
  [versioned native schema](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/core/config.schema.json)
  and [configuration reference](https://developers.openai.com/codex/config-reference).

Effort requires an explicit model. This also avoids unintentionally clearing a
Codex new-thread model default by overriding only its paired effort setting.
Models are literal 1–256 UTF-8 bytes without controls, surrounding whitespace or
a leading dash. Claude levels use the fixed adapter list; Codex effort is at most
32 ASCII lowercase letters/digits/underscore/hyphen. Arguments are passed directly
to the process, never concatenated into a shell command. Codex's fixed config key
uses a quoted TOML-compatible string and coexists with native lifecycle config.
Validation happens before process/worktree effects. An invalid task profile may
retain a failed, no-effect launch receipt and its attempt history; it does not
manufacture a worker result.

## Scope and honest diagnostics

Get/list/explain show `launchProfile.requested`, `source` (launch or
providerDefaults), `scope:process`, `inheritedByChildren:false` and `resolved:null`.
Those describe the requested native arguments. They do not claim which model the
provider actually selected after managed defaults, model aliases, account
restrictions, effort caps or interactive changes. Model IDs/levels supported by
one account are not inferred from another account or a UI-focused session.

Children do not inherit Nesvo model/effort selection. Omitted values use that new
process's ordinary native provider defaults; explicit task profiles choose their
own values. The inheritance flag refers to Nesvo-managed sessions; provider-internal
subagents retain their provider's inheritance behavior. Native tool permissions remain a separate owner-only surface and are
not granted by selecting a model. Subscription login, approval/sandbox policy,
global MCP/skills and existing live sessions remain unchanged.

## Verification and remaining scope

Unit tests cover literal arguments, bounded/invalid values, supported versions,
unavailable providers, honest diagnostics and persisted recovery selection.
Native official SDK/CLI tests capture the actual provider-facing argv from
isolated original-CLI-shaped executables. They verify Unicode/spaces/literal
shell syntax, CLI/MCP replay/conflict, independent child defaults, task launch,
Codex model config beside lifecycle hooks and no automatic restart. Their actual
response envelopes pass Ajv. These fixtures make no model calls and do not prove
that a given account/model accepts a request.

An original Claude 2.1.304 Windows startup with `--model opus --effort low`
reached ready/idle, and the owned native process exposed both requested flags.
No prompt, child, permission/trust key or global setup change was submitted.
`resolved` correctly remained null. The host exited zero, but the original
five-second descendant cleanup check still saw three of 30 observed processes.
A follow-up on that same probe found those IDs absent 142 seconds after the
original report, with no relaunch or forced kill. Their exact exit latency is
unknown; the initial bounded cleanup result remains failed evidence for F39/F42.
This does not prove a model response or a resolved-model/effort telemetry signal.

General external MCP/skill profiles, configured role bundles, interactive model
selection, actual resolved-model telemetry, provider resume and full profile
permission delegation remain F37/F38 work. No UI redesign or new dependency is
introduced by these fields.
