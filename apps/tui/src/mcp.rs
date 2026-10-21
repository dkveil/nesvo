//! MCP is a transport adapter to the authenticated host, never a session engine.
use crate::{
    cli, mcp_events,
    network::{Connection, Pairing, open_failure_message},
};
use anyhow::Result;
use futures_util::{StreamExt, future};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation,
        ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
        ReadResourceRequestParams, ReadResourceResponse, ServerCapabilities, ServerConfig,
        SubscribeRequestParams, SubscriptionFilter, Tool, ToolAnnotations,
        UnsubscribeRequestParams,
    },
    service::{RequestContext, RxJsonRpcMessage, SubscriptionContext, TxJsonRpcMessage},
    transport::async_rw::JsonRpcMessageCodec,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::{
    codec::{FramedRead, FramedWrite},
    sync::CancellationToken,
};

const MAX_MESSAGE: usize = 64 * 1024;

#[cfg(test)]
#[path = "quota_job_cli_tests.rs"]
mod quota_job_cli_tests;

fn published_tools() -> Vec<String> {
    // Compile-time bundled contract, never a client-supplied document.
    serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json"))
        .expect("Bundled MCP catalog contract is valid")
}

fn valid_permission_additions(value: &Value) -> bool {
    let Some(tools) = value.as_array() else {
        return false;
    };
    let known = published_tools();
    let mut seen = std::collections::HashSet::new();
    tools.len() <= 32
        && tools.iter().all(|v| {
            v.as_str()
                .is_some_and(|t| known.iter().any(|k| k == t) && seen.insert(t))
        })
}

fn capture_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["displayProfile"],"properties":{"displayProfile":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute host path to an owner-declared bounded display manifest. Explicit Claude-only opt-in; pins declared executable/argv/presentation for this launch, without guessing or modifying global statusLine. Callback is display evidence only, not fresh account permission."}}})
}
fn launch_schema() -> Value {
    json!({
        "type":"object", "required":["name"], "additionalProperties":false,
        "properties": {
            "name":{"type":"string","minLength":1,"maxLength":80},
            "program":{"enum":["shell","claude","codex","gemini"],"default":"shell"},
            "role":{"enum":["worker","coordinator"],"default":"worker","description":"Only owner access may grant coordinator at launch; a coordinator cannot create coordinators"},
            "harness":{"type":"boolean","description":"Launch-local Nesvo MCP/instructions on supported Claude; inherits coordinator setting when omitted"},
            "allowedNesvoTools":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","enum":published_tools()},"description":"Owner-only exact native permission additions for this explicit harness process, not inherited by children or restored processes. Does not grant host authority or bypass provider deny/ask rules."},
            "childAllowedNesvoTools":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","enum":published_tools()},"description":"Owner-only immutable coordinator policy for authenticated supported Claude harness children. Not copied from the coordinator's own native permissions. Never delegates host roles, allows recursive coordinators or applies merely from parent metadata. Other programs/opt-out children receive no additions."},
            "model":{"type":"string","minLength":1,"maxLength":256,"description":"Explicit launch-local native model alias/ID, not resolved account availability"},
            "effort":{"type":"string","minLength":1,"maxLength":32,"description":"Requires explicit model; provider-specific native reasoning level"},
            "claudeQuotaCapture":capture_schema(),
            "cwd":{"type":"string"}, "groupId":{"type":["string","null"]},
            "parentSessionId":{"type":["string","null"],"description":"Lineage only; scoped creation binds the authenticated parent automatically"},
            "prompt":{"type":"string","description":"Literal agent prompt, at most 8192 UTF-8 bytes; not a shell command"},
            "worktree":{"type":"boolean","default":false},
            "autoTitle":{"type":"boolean","default":false},
            "muted":{"type":"boolean","default":false},
            "resumePicker":{"type":"boolean","default":false}
        }
    })
}

fn task_profile_schema(include_shell: bool) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,"required":["program","workspace"],"properties":{"name":{"type":"string","minLength":1,"maxLength":80},"cwd":{"type":"string","maxLength":4096},"program":{"enum":["claude","codex","gemini"]},"workspace":{"enum":["shared","worktree"]},"harness":{"type":"boolean"},"model":{"type":"string","minLength":1,"maxLength":256},"effort":{"type":"string","minLength":1,"maxLength":32},"allowedNesvoTools":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","enum":published_tools()},"description":"Exact task-native additions: coordinator policy subset or explicit owner coordinatorless intent; [] chooses none. Does not grant host authority or bypass provider policy."}}});
    schema["properties"]["claudeQuotaCapture"] = capture_schema();
    if include_shell {
        schema["properties"]["program"]["enum"] = json!(["shell", "claude", "codex", "gemini"]);
    }
    schema
}
fn precheck_command_schema() -> Value {
    let codes = json!({"type":"array","minItems":1,"maxItems":8,"uniqueItems":true,"items":{"type":"integer","minimum":0,"maximum":255}});
    json!(object(
        json!({
            "version":{"type":"integer","const":1,"default":1},"title":{"type":"string","minLength":1,"maxLength":80},
            "executable":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute executable on host; Windows requires .exe/.com. No implicit shell."},
            "cwd":{"type":"string","minLength":1,"maxLength":4096,"description":"Exact absolute host directory, not an ambient/focused session path"},
            "arguments":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2048},"default":[]},
            "timeoutMs":{"type":"integer","minimum":100,"maximum":10000,"default":2000},
            "passExitCodes":codes,"skipExitCodes":codes,
        "environment":{"type":"object","maxProperties":16,"additionalProperties":{"type":"string","maxLength":2048},"description":"Explicit additions to isolated-platform-v1. No ambient inheritance. Windows adds OS-derived SystemRoot. Overrides and NESVO_/POCKET_ keys forbidden; ASCII alphanumeric/underscore names, unique without regard to case. Not a sandbox."}
        }),
        &["title", "executable", "cwd"]
    ))
}
fn job_spec_schema() -> Value {
    let zone = json!({"type":"string","maxLength":64,"default":"Europe/Warsaw","description":"IANA time zone. Gaps are skipped; folds use the first instant only."});
    let schedule = json!({"oneOf":[
        object(json!({"kind":{"const":"once"},"at":{"type":"string","maxLength":64,"description":"Future RFC3339 instant with an explicit UTC offset, at most 366 days ahead"}}), &["kind","at"]),
        object(json!({"kind":{"const":"cron"},"expression":{"type":"string","minLength":1,"maxLength":256,"description":"Five fields: minute hour day month weekday"},"timeZone":zone}), &["kind","expression"]),
        object(json!({"kind":{"const":"rrule"},"rule":{"type":"string","minLength":1,"maxLength":1024,"description":"Uppercase Gregorian RFC5545 RRULE; MINUTELY or coarser, COUNT<=10000, UTC UNTIL. Bounded search can explicitly refuse complex/old dense rules."},"start":{"type":"string","minLength":19,"maxLength":19,"description":"Existing local DTSTART as YYYY-MM-DDTHH:MM:SS"},"timeZone":zone}), &["kind","rule","start"]),
        object(json!({"kind":{"const":"external","description":"No timer schedule; requires jobExternalTriggers:true. Only explicit run-now or authenticated configured external delivery admits an occurrence."}}), &["kind"])
    ]});
    let retry = object(
        json!({
            "on":{"enum":["launchNoEffect"],"description":"Only an exact failed native create receipt with effectStarted:false; no unknown-effect, process or result retry"},
            "maxAttempts":{"type":"integer","minimum":1,"maximum":8,"description":"Total dispatch generations, including the first"},
            "initialDelayMs":{"type":"integer","minimum":1000,"maximum":3600000},
            "maxDelayMs":{"type":"integer","minimum":1000,"maximum":86400000,"description":"At least initialDelayMs; capped exponential delay is persisted once per outgoing retry decision"}
        }),
        &["on", "maxAttempts", "initialDelayMs", "maxDelayMs"],
    );
    let mut schema = json!({"type":"object","additionalProperties":false,"required":["title","instruction","profile","schedule"],"properties":{"title":{"type":"string","minLength":1,"maxLength":80},"instruction":{"type":"string","minLength":1,"maxLength":8192},"profile":task_profile_schema(false),"schedule":schedule,"precheckId":{"type":"string","minLength":32,"maxLength":32,"description":"Previously owner-approved immutable command ID. Combining with retry explicitly authorizes bounded repeated execution before each fresh generation and requires jobPrecheckGenerations:true. Each begin checks current approval and records fresh authorization; prior passes cannot release a new Run."},"retry":retry,"misfire":{"enum":["skip","catchUp"],"default":"catchUp"},"graceMs":{"type":"integer","minimum":0,"maximum":86400000,"default":60000},"overlap":{"enum":["skip","queue"],"default":"skip"},"maxElapsedMs":{"type":"integer","minimum":1000,"maximum":604800000,"default":300000,"description":"Per-Run admission/input budget, not a hard process timeout"},"executionTimeoutMs":{"type":"integer","minimum":1000,"maximum":604800000,"description":"Optional per-generation execution window from native launch admission, including preparation/readiness and excluding prechecks. An accepted explicit worker report before the deadline disarms it while validation may remain pending. Expiry requests exact bound-worker cleanup subject to human control; acceptance is not observed exit. Requires jobExecutionTimeouts:true. Omission adds no execution timeout; maxElapsedMs remains independent."}}});
    schema["properties"]["quotaPolicy"] = json!({
        "type":"object","additionalProperties":false,"required":["mode","contextId","accountFingerprint"],
        "properties":{"mode":{"const":"wait"},"contextId":quota_binding_schema(),"accountFingerprint":quota_binding_schema()},
        "description":"Explicit owner opt-in to wait for configured-reader quota evidence; currently Codex only. Bind inspected contextId/accountFingerprint, never credentials. Requires jobQuotaAdmission:true; providerQuotaObservations or quotaWake alone is insufficient. Omission preserves legacy intent. This observation is not an immutable native-account lease or a guarantee that the provider will accept work."
    });
    schema
}
fn quota_binding_schema() -> Value {
    json!({"type":"string","pattern":"^[0-9a-f]{64}$","minLength":64,"maxLength":64})
}
fn object(properties: Value, required: &[&str]) -> serde_json::Map<String, Value> {
    let mut schema = serde_json::Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), properties);
    schema.insert("required".into(), json!(required));
    schema.insert("additionalProperties".into(), false.into());
    schema
}
fn provider_quota_schema() -> serde_json::Map<String, Value> {
    let mut schema = object(
        json!({"program":{"enum":["codex","claude","gemini"]},"directory":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute host folder to resolve a separate Codex configured-account reader. Does not start a model or alter configuration."},"refresh":{"type":"boolean","default":false}}),
        &[],
    );
    schema.insert("allOf".into(), json!([{"if":{"required":["refresh"],"properties":{"refresh":{"const":true}}},"then":{"required":["program"]}},{"if":{"required":["directory"]},"then":{"required":["program"],"properties":{"program":{"const":"codex"}}}}]));
    schema
}
fn catalog() -> Vec<Tool> {
    let id = json!({"type":"string","minLength":1,"maxLength":128,"description":"Stable host-issued ID for the named field; run/task/attempt/session IDs are distinct, never names or UI focus"});
    let cursor = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64});
    let key = json!({"type":"string","minLength":1,"maxLength":128});
    let revision = json!({"type":"integer","minimum":1});
    let worktree_directory = json!({"type":"string","minLength":1,"maxLength":4096,"description":"Absolute host folder inside the Git repository"});
    let checks = json!({"type":"array","maxItems":16,"items":{"type":"object","additionalProperties":false,"required":["name","outcome","details"],"properties":{"name":{"type":"string","minLength":1,"maxLength":128},"outcome":{"enum":["passed","failed","skipped"]},"details":{"type":"string","minLength":1,"maxLength":1024}}}});
    let strings = |count: usize| json!({"type":"array","maxItems":count,"items":{"type":"string","minLength":1,"maxLength":1024}});
    let definitions = [
        (
            "nesvo_get_provider_quota",
            "Owner-only provider quota observations with source, freshness and completeness evidence. Optional refresh requires an installed explicit program and asynchronously queues or coalesces one bounded original-provider read; queued/pending/cooldown does not mean refreshed. Inspect a later revision. Does not request models, login, switch accounts or release queued jobs. Reader account evidence does not bind a native process account.",
            provider_quota_schema(),
            true,
        ),
        (
            "nesvo_set_quota_wake",
            "Owner-only explicit enable/disable of one durable native Codex quota wake; requires durableQuotaWake:true. Enable requires a live bound lifecycle, the exact captured configured reader, a fresh complete five-hour window at >=90% with a future reset, and no human lease or draft. One ordinary native send receipt may resume the same process only after a fresh matching-account read started after reset affirmatively permits usage. Unknown effects, human takeover and known identity changes never retry input. Disable does not undo an already accepted send. No Claude/Gemini support, account lock, purchase or limit bypass.",
            object(
                json!({"sessionId":id,"enabled":{"type":"boolean"}}),
                &["sessionId", "enabled"],
            ),
            false,
        ),
        (
            "nesvo_get_quota_wake",
            "Owner-only read of the retained quota wake and its linked native send receipt identity for one stable session. Requires durableQuotaWake:true. Returns null when no arm is retained. Does not arm, refresh provider evidence, send input, resume a process or replay effects; a wake phase is not task success.",
            object(json!({"sessionId":id}), &["sessionId"]),
            true,
        ),
        (
            "nesvo_describe_precheck",
            "Owner-only normalization/digest of a proposed command. Does not approve or execute it. Review literal executable/cwd/argv/environment; file contents and called code remain mutable, not sandboxed.",
            object(json!({"spec":precheck_command_schema()}), &["spec"]),
            true,
        ),
        (
            "nesvo_approve_precheck",
            "Explicit owner trust for this exact command/cwd/argv/environment/duration/exit policy. Arbitrary OS code, not sandboxed. Requires previously inspected normalized digest. Separate from loading a job/repository config. Never delegated to coordinators/workers; no execution now.",
            object(
                json!({"key":key,"spec":precheck_command_schema(),"expectedDigest":{"type":"string","minLength":64,"maxLength":64}}),
                &["key", "spec", "expectedDigest"],
            ),
            false,
        ),
        (
            "nesvo_get_precheck",
            "Owner-only immutable command approval, including revoked intent. No execution.",
            object(json!({"id":id}), &["id"]),
            true,
        ),
        (
            "nesvo_list_prechecks",
            "Owner-only bounded approval summaries without command arguments or execution.",
            object(
                json!({"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_revoke_precheck",
            "Owner-only exact-revision refusal of future executions. Already authorized checks may finish; does not undo effects or terminate a process.",
            object(
                json!({"id":id,"key":key,"expectedRevision":revision}),
                &["id", "key", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_precheck_mutation",
            "Recover immutable original precheck approval/revocation acceptance. Does not execute/reapprove or reflect current enabled state.",
            object(json!({"key":key}), &["key"]),
            true,
        ),
        (
            "nesvo_abandon_job_precheck",
            "Owner-only explicit acknowledgement of an uncertain precheck's effects, abandoning its exact current generation before its Run was bound. Requires inspection/digest and acknowledgement. jobAttemptId requires jobPrecheckGenerations:true and is mandatory after generation 1; omission preserves legacy generation-1 requests. Does not kill detached commands, undo effects, repeat a check, resume work or create a model.",
            object(
                json!({"key":key,"jobId":id,"occurrenceId":id,"jobAttemptId":id,"expectedDigest":{"type":"string","minLength":64,"maxLength":64},"acknowledgeUnknownEffects":{"type":"boolean","const":true}}),
                &[
                    "key",
                    "jobId",
                    "occurrenceId",
                    "expectedDigest",
                    "acknowledgeUnknownEffects",
                ],
            ),
            false,
        ),
        (
            "nesvo_abandon_job_launch",
            "Owner-only logical abandonment of exact no-effect launch cleanup. Inspect the current generation's launchReconciliation descriptor, require available:true and its digest, and explicitly acknowledge unknown effects. jobAttemptId is always required; needs jobLaunchReconciliation:true. Only the exact native create receipt's JSON boolean effectStarted:false and finished producers qualify. Releases overlap for a separate occurrence without claiming process exit, completing a native stop, retrying, repeating prechecks or granting model/native permissions. Existing precheck effects and original native receipts remain retained. Recover the original job mutation key.",
            object(
                json!({"key":key,"jobId":id,"occurrenceId":id,"jobAttemptId":id,"expectedDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"acknowledgeUnknownEffects":{"type":"boolean","const":true}}),
                &[
                    "key",
                    "jobId",
                    "occurrenceId",
                    "jobAttemptId",
                    "expectedDigest",
                    "acknowledgeUnknownEffects",
                ],
            ),
            false,
        ),
        (
            "nesvo_create_job",
            "Owner-only durable once/cron/RRULE job definition. Host dispatches without open clients using fresh explicit task profiles; no immediate model call. Optional executionTimeoutMs requires jobExecutionTimeouts and starts at native launch admission, including preparation/readiness but excluding prechecks; an accepted explicit worker report before its deadline disarms it. Optional launchNoEffect retry policy needs jobRetries and the advertised retry kind; only confirmed pre-spawn refusals qualify. Combining with precheckId requires jobPrecheckGenerations and authorizes bounded repeated exact-command execution before each fresh generation. Separate occurrence/run/result history; not process-start success. Recover the same job mutation key.",
            object(
                json!({"key":key,"spec":job_spec_schema()}),
                &["key", "spec"],
            ),
            false,
        ),
        (
            "nesvo_authorize_job_quota",
            "Owner-only explicit reader-context/account reauthorization of one queued or retry-waiting quota occurrence. Compare the exact prior binding and select inspected new fingerprints. Requires jobQuotaAdmission:true. Original mutation replay returns its immutable acceptance; this does not retry native effects, change other occurrences, create a model or bypass provider limits.",
            object(
                json!({"key":key,"jobId":id,"occurrenceId":id,"expectedContextId":quota_binding_schema(),"expectedAccountFingerprint":quota_binding_schema(),"contextId":quota_binding_schema(),"accountFingerprint":quota_binding_schema()}),
                &[
                    "key",
                    "jobId",
                    "occurrenceId",
                    "expectedContextId",
                    "expectedAccountFingerprint",
                    "contextId",
                    "accountFingerprint",
                ],
            ),
            false,
        ),
        (
            "nesvo_get_job",
            "Owner-only read of a persisted definition and requested profile, without dispatch.",
            object(json!({"jobId":id}), &["jobId"]),
            true,
        ),
        (
            "nesvo_list_jobs",
            "Owner-only bounded job definition summaries. No prompts, dispatch or input ownership.",
            object(
                json!({"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_update_job",
            "Owner-only exact-revision replacement of future job intent, including optional launchNoEffect retry policy and executionTimeoutMs. Execution timeouts require jobExecutionTimeouts and start at native launch admission, including preparation/readiness but excluding prechecks; an accepted explicit worker report before its deadline disarms it. Existing occurrences keep their immutable spec; does not change running processes. Combining retry and precheckId requires jobPrecheckGenerations and authorizes bounded repeated exact-command execution with fresh approval checks before each generation.",
            object(
                json!({"key":key,"jobId":id,"expectedRevision":revision,"spec":job_spec_schema()}),
                &["key", "jobId", "expectedRevision", "spec"],
            ),
            false,
        ),
        (
            "nesvo_set_job_enabled",
            "Owner-only enable/disable of future automatic admissions. Already admitted work may finish; no terminal input or native resume. Exact revision/key required.",
            object(
                json!({"key":key,"jobId":id,"expectedRevision":revision,"enabled":{"type":"boolean"}}),
                &["key", "jobId", "expectedRevision", "enabled"],
            ),
            false,
        ),
        (
            "nesvo_run_job_now",
            "Owner-only deliberate new occurrence, including a disabled definition. Distinct key is a distinct intent, subject to overlap skip/one-deep queue; not a retry of an uncertain effect.",
            object(
                json!({"key":key,"jobId":id,"expectedRevision":revision}),
                &["key", "jobId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_cancel_job_occurrence",
            "Owner-only cancellation of one admitted job occurrence by stable job/occurrence IDs. Fences further model admissions and requests bounded precheck/native cleanup. Acceptance is intent, not proof of process exit; inspect the occurrence's current cancellation/receipts. Unknown effects require reconciliation. Original mutation replay never repeats native effects or creates a replacement run.",
            object(
                json!({"key":key,"jobId":id,"occurrenceId":id}),
                &["key", "jobId", "occurrenceId"],
            ),
            false,
        ),
        (
            "nesvo_get_job_history",
            "Owner-only bounded occurrence history with state, reason and workflow run pointer. Started/idle is not succeeded; reported results need explicit validation.",
            object(
                json!({"jobId":id,"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),
                &["jobId"],
            ),
            true,
        ),
        (
            "nesvo_get_job_occurrence",
            "Owner-only immutable occurrence profile and run pointer, including nullable launchReconciliation and retained launchResolution evidence. An available launch descriptor/digest can be inspected before a separate explicit owner acknowledgement. Reads never release overlap, dispatch effects or adopt a process.",
            object(
                json!({"jobId":id,"occurrenceId":id}),
                &["jobId", "occurrenceId"],
            ),
            true,
        ),
        (
            "nesvo_get_job_attempts",
            "Owner-only read of eight retained dispatch generations for one exact job occurrence, including nullable launchReconciliation and launchResolution evidence. Ordinal 1 is the first dispatch; queued intent has no generation yet. Summaries omit precheck stdout/stderr. Does not create a retry, release overlap, repeat a command, launch/adopt a process or change native permissions.",
            object(
                json!({"jobId":id,"occurrenceId":id,"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),
                &["jobId", "occurrenceId"],
            ),
            true,
        ),
        (
            "nesvo_get_job_attempt",
            "Owner-only detail of one retained job dispatch generation, including bounded precheck evidence and nullable launchReconciliation/launchResolution. jobAttemptId is distinct from a workflow task attempt/session ID. Reads never retry, release overlap, launch/adopt a process, repeat native effects or infer success from process silence.",
            object(
                json!({"jobId":id,"occurrenceId":id,"jobAttemptId":id}),
                &["jobId", "occurrenceId", "jobAttemptId"],
            ),
            true,
        ),
        (
            "nesvo_get_job_mutation",
            "Owner-only recovery of an original job mutation acceptance. Does not reapply its effects or reflect later state.",
            object(json!({"key":key}), &["key"]),
            true,
        ),
        (
            "nesvo_rebind_run_coordinator",
            "Owner-only binding of retained run context to a different live native coordinator after the previous process is unavailable. Exact source ID (null for unbound), revision and mutation key required. Preserves inbox/results/constraints/budgets; pauses executor/wakes and queued input, fences earlier native input. No native worker authority, process/conversation adoption, ACK, validation, prompt or policy enable is restored. Target must match retained workspace/group. Recover the original workflow mutation key.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"expectedCoordinatorSessionId":{"anyOf":[{"type":"null"},id.clone()]},"coordinatorSessionId":id}),
                &[
                    "key",
                    "runId",
                    "expectedRevision",
                    "expectedCoordinatorSessionId",
                    "coordinatorSessionId",
                ],
            ),
            false,
        ),
        (
            "nesvo_add_run_constraint",
            "Owner-only append of literal manual constraints at the current run revision. Pauses executor/wakes and queued task input; earlier native input cannot rearm after acknowledgement. No user text is discarded or treated as task success/native permission. Existing model work may finish. Recover immutable acceptance with the original workflow mutation key.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"text":{"type":"string","minLength":1,"maxLength":1024}}),
                &["key", "runId", "expectedRevision", "text"],
            ),
            false,
        ),
        (
            "nesvo_list_run_constraints",
            "Read eight append-only owner constraints and current acknowledgement revision. after is a constraint revision, not an event/inbox cursor. Read does not acknowledge, clear drafts, enable scheduling or grant native authority. Workers receive own constraints in their current task context.",
            object(
                json!({"runId":id,"after":{"type":"integer","minimum":0,"maximum":16}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_acknowledge_run_constraints",
            "Deliberately attest reading the exact current constraint revision, using the current run revision. Only owner or this run's coordinator. No policy auto-enable, old delivery replay, native permission, inbox ACK or task validation. Earlier/pre-ACK native receipts remain fenced even after this acknowledgement.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"constraintRevision":{"type":"integer","minimum":1,"maximum":16}}),
                &["key", "runId", "expectedRevision", "constraintRevision"],
            ),
            false,
        ),
        (
            "nesvo_save_run_checkpoint",
            "Capture an immutable bounded run metadata manifest once at the exact source revision. Includes goal, owner constraints, plan, attempt/validation and decision/native-uncertainty pointers. A caller summary is an attestation, not verified progress. Does not send input, ACK, launch/adopt processes or replay effects. Recover with the original workflow mutation key.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"summary":{"type":"string","minLength":1,"maxLength":2048}}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_list_run_checkpoints",
            "Read eight immutable checkpoint headers in a visible run. Source run revision and journal cursor describe capture, not current process authority. No native effects or implicit restoration.",
            object(
                json!({"runId":id,"offset":{"type":"integer","minimum":0,"maximum":32}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_get_run_checkpoint",
            "Read an immutable historical checkpoint page, at most eight parts / 24 KiB. Current constraint revision is reported separately; history never replaces it. Receipt pointers retain issuer scope. Persisted attempt state is not current process evidence and no native effect is restored.",
            object(
                json!({"runId":id,"checkpointId":id,"offset":{"type":"integer","minimum":0,"maximum":16384}}),
                &["runId", "checkpointId"],
            ),
            true,
        ),
        (
            "nesvo_read_run_context",
            "Read current authoritative context for resume/compaction without input, process adoption, effect replay, inbox ACK or task validation. An optional checkpoint is a comparison baseline only; parts always reflect current constraints/state. Continue with returned nextOffset and the same expectedDigest; context_changed requires starting at zero, never mixing pages.",
            object(
                json!({"runId":id,"checkpointId":id,"offset":{"type":"integer","minimum":0,"maximum":16384},"expectedDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_enable_run_wakes",
            "Opt in to coalesced notices for the run's live coordinator. Only new result/question/error/decision/blocker deltas produce native input; no unchanged-state model heartbeat. Pending messages remain durable, never auto-ACKed or validated. Human takeover pauses the policy. Restart disables it; explicit enable never replays old batches or grants native permission.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_run_wakes",
            "Read wake policy and at most eight notice references. after is a wake-notice cursor, not an inbox cursor or ACK. No model/input effects. Inspect a batch by its actual ID for exact inbox message sequences and current native receipt phase.",
            object(json!({"runId":id,"after":cursor}), &["runId"]),
            true,
        ),
        (
            "nesvo_disable_run_wakes",
            "Disable future coordinator wake input using the exact current run revision. Does not undo bytes, stop processes, ACK messages or validate results. Retain/inspect batch and receipt uncertainty.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_run_wake_batch",
            "Inspect one wake batch, up to eight immutable notice references, and native receipt pointer/current phase. Knowing an owner-issued ID grants no receipt authority. Input settlement is not ACK, task success, validation or native permission approval.",
            object(json!({"runId":id,"batchId":id}), &["runId", "batchId"]),
            true,
        ),
        (
            "nesvo_start_run_executor",
            "Opt in to automatic dependency-ready task launch and immutable instruction delivery for an active run. Explicit profile for every task; agents only, shared/worktree required. No model heartbeat, self-validation or permission approval. Human/decision/time/retry/native guards still apply. Stable workflow key recovers acceptance; inspect current executor/task/native receipts. Restart disables scheduling without replay. Already admitted work may finish after disabling.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"spec":{"type":"object","additionalProperties":false,"required":["tasks"],"properties":{"tasks":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["taskId","profile"],"properties":{"taskId":id,"profile":task_profile_schema(false)}}},"retryFailed":{"type":"boolean","default":false},"retryDelayMs":{"type":"integer","minimum":1000,"maximum":60000,"default":1000},"readinessTimeoutMs":{"type":"integer","minimum":1,"maximum":300000,"default":60000}}}}),
                &["key", "runId", "expectedRevision", "spec"],
            ),
            false,
        ),
        (
            "nesvo_get_run_executor",
            "Inspect current executor policy/state. Never dispatches or acknowledges success.",
            object(json!({"runId":id}), &["runId"]),
            true,
        ),
        (
            "nesvo_disable_run_executor",
            "Disable new executor scheduling admissions at the exact run revision. Already admitted startup/instruction may finish. Does not kill processes, undo bytes or clear uncertainty; native run stop/cancel is separate.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_enable_run_executor",
            "Explicitly enable a fresh authenticated generation for an active run. Does not rearm paused deliveries or repeat existing native effects; startup after restart remains gated by actual process/authority evidence.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_deliver_task",
            "Queue the immutable instruction of a current assigned task once. Host waits up to timeoutMs (default 60000, max 300000) for idle and ready, with no human control/draft or decision gate. No prompt is accepted from the caller. Acceptance is not delivery or task success. Inspect task attempt.delivery and its native receipt; unknown effects are never retried. Client disconnect keeps this intent, host restart pauses it without replay. Agent sessions only.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"expectedRevision":revision,"timeoutMs":{"type":"integer","minimum":1,"maximum":300000}}),
                &["key", "runId", "taskId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_cancel_task_delivery",
            "Cancel an unclaimed task instruction intent in an authorized run. Requires its current run revision. Does not interrupt or replay native input; a claimed/sent/unknown intent must be inspected through its original receipt.",
            object(
                json!({"key":key,"runId":id,"deliveryId":id,"expectedRevision":revision}),
                &["key", "runId", "deliveryId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_launch_task",
            "Reserve a dependency-ready task, run parallel/retry capacity and a native create identity atomically, then launch its visible worker once. Explicitly choose shared checkout or isolated worktree. No initial prompt is sent. Reply is immutable acceptance; inspect run/task history and the returned native receipt before sending work. Unknown launches keep capacity and cannot be retried with a fresh key. Does not take human focus/control or grant coordinator roles.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"expectedRevision":revision,"profile":task_profile_schema(true)}),
                &["key", "runId", "taskId", "expectedRevision", "profile"],
            ),
            false,
        ),
        (
            "nesvo_stop_run",
            "Accept a durable stop intent for only this run's bound worker processes. Native stop receipts precede observed exits; reply is immutable acceptance, not proof of termination. Inspect nesvo_get_run_control. Human leases/drafts and owner drain are protected. Same-key replay/reconnect never dispatches again. Stopped runs may resume with fresh attempts, preserving budgets/history; unknown control must be reconciled first.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_cancel_run",
            "Accept durable run cancellation and native stop of its bound workers only. Does not touch the coordinator, unassigned children or foreign sessions. The run becomes canceled only after exit proof, and cannot resume. Immutable acceptance is not termination; inspect nesvo_get_run_control. Never bypass human input or resubmit uncertain effects under new keys.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_run_control",
            "Inspect at most eight target receipts/exit observations and aggregate native control state. Refreshes actual host exit/unavailable evidence but never sends signals or replays input. Missing processes after restart are unavailable, not assumed stopped. Page through targets; use original operationKey/receiptId for native recovery. Worker scopes cannot inspect parent control.",
            object(
                json!({"runId":id,"controlId":id,"offset":{"type":"integer","minimum":0,"maximum":4096}}),
                &["runId", "controlId"],
            ),
            true,
        ),
        (
            "nesvo_get_run_budget",
            "Read a visible run's current policy, active attempts and activation/deadline clock. Workers use their own task context. Reads may persist observed time exhaustion; never start/stop a process.",
            object(json!({"runId":id}), &["runId"]),
            true,
        ),
        (
            "nesvo_set_run_budget",
            "Replace a visible run's parallel, per-task attempt and elapsed limits at its exact run revision. Coordinator can only tighten; only owner can relax or extend an exhausted deadline. Reported results occupy parallel slots until validated. Elapsed time includes draining and resume never resets the clock. This neither grants global capacity nor kills current work. Recover the original key through nesvo_get_run_mutation.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"limits":{"type":"object","additionalProperties":false,"required":["maxParallel","maxAttemptsPerTask","maxElapsedMs"],"properties":{"maxParallel":{"type":"integer","minimum":1,"maximum":16},"maxAttemptsPerTask":{"type":"integer","minimum":1,"maximum":16},"maxElapsedMs":{"type":["integer","null"],"minimum":1000,"maximum":604_800_000}}}}),
                &["key", "runId", "expectedRevision", "limits"],
            ),
            false,
        ),
        (
            "nesvo_drain_run",
            "Block new task assignments; allow assigned workers to report and parents to validate. Does not stop, interrupt or send input to native processes. Owner drain remains owner-controlled even after coordinator drains again. Exact run revision and original mutation key are required.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_resume_run",
            "Resume new assignments after drain without resetting time/retry history or relaxing budgets. Only owner may undo an owner drain; coordinator can resume its own drain. No process is launched and no input replayed.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_host_budget",
            "Read the explicit owner's persisted host admission policy and its revision. Coordinators/workers cannot inspect or raise global budgets. This changes no live process, focus or input control.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_set_host_budget",
            "Owner-only replacement of future admission limits at the exact budget revision. maxSessions counts retained session slots (1–16); maxWorkers counts running worker-role processes (0–16); provider caps count running processes including coordinators (0–16). Reducing limits never terminates existing work. Same-key replay is historical and cannot restore an old active policy; recover through nesvo_get_run_mutation.",
            object(
                json!({"key":key,"expectedRevision":revision,"limits":{"type":"object","additionalProperties":false,"required":["maxSessions","maxWorkers","providers"],"properties":{"maxSessions":{"type":"integer","minimum":1,"maximum":16},"maxWorkers":{"type":"integer","minimum":0,"maximum":16},"providers":{"type":"object","additionalProperties":false,"required":["shell","claude","codex","gemini"],"properties":{"shell":{"type":"integer","minimum":0,"maximum":16},"claude":{"type":"integer","minimum":0,"maximum":16},"codex":{"type":"integer","minimum":0,"maximum":16},"gemini":{"type":"integer","minimum":0,"maximum":16}}}}}}),
                &["key", "expectedRevision", "limits"],
            ),
            false,
        ),
        (
            "nesvo_ask_decision",
            "Ask one durable question for this worker's exact current attempt. Audience owner requires an explicit human answer; coordinator permits that run's coordinator or owner. Answered is data, not native permission approval. Pending/canceled/expired gates prevent successful result reporting. No input or model wake occurs. Recover a lost reply with nesvo_get_run_mutation and the original key.",
            object(
                json!({"key":key,"attemptId":id,"audience":{"enum":["owner","coordinator"]},"question":{"type":"string","minLength":1,"maxLength":2048},"timeoutMs":{"type":"integer","minimum":1000,"maximum":604_800_000}}),
                &["key", "attemptId", "audience", "question", "timeoutMs"],
            ),
            false,
        ),
        (
            "nesvo_list_decisions",
            "Read up to eight retained questions and answers in a run. A worker sees only its own current attempt. Deadline expiration is persisted when observed; pagination does not approve or acknowledge anything.",
            object(
                json!({"runId":id,"attemptId":id,"offset":{"type":"integer","minimum":0,"maximum":4096}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_get_decision",
            "Read the exact decision revision, audience and state before answering. Current-attempt authority is enforced by the host. This does not send input or imply native permission approval.",
            object(
                json!({"runId":id,"decisionId":id}),
                &["runId", "decisionId"],
            ),
            true,
        ),
        (
            "nesvo_answer_decision",
            "Record a literal answer at the decision's exact revision. Worker self-answer and coordinator answers to owner-only questions are refused. Answer and worker notice commit together; replay the original key after uncertainty. This does not type an approval, validate work or resume native input.",
            object(
                json!({"key":key,"runId":id,"decisionId":id,"expectedRevision":revision,"answer":{"type":"string","minLength":1,"maxLength":2048}}),
                &["key", "runId", "decisionId", "expectedRevision", "answer"],
            ),
            false,
        ),
        (
            "nesvo_cancel_decision",
            "Withdraw a pending question at its exact revision, retaining a reason. The current worker may withdraw its own question; addressed authority may cancel. Canceled is not approval: report a non-success result and deliberately retry rather than claiming success.",
            object(
                json!({"key":key,"runId":id,"decisionId":id,"expectedRevision":revision,"reason":{"type":"string","minLength":1,"maxLength":2048}}),
                &["key", "runId", "decisionId", "expectedRevision", "reason"],
            ),
            false,
        ),
        (
            "nesvo_read_inbox",
            "Read up to eight durable messages, without ACK or input. Worker defaults to its own current attempt; owner/coordinator defaults to the run coordinator mailbox. Optional attemptId inspects a worker mailbox. Pending messages repeat until explicit ACK. After consumer restart read from zero; cursors paginate, not acknowledge.",
            object(
                json!({"runId":id,"attemptId":id,"after":cursor,"includeAcked":{"type":"boolean","default":false}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_send_message",
            "Persist one addressed message for a stable key/correlation. Optional attemptId targets a current worker; omission addresses the coordinator. Workers may send only to their own coordinator. Host supplies authenticated sender. Questions are messages, not approval/decision grants. No PTY/LLM execution. Recover uncertainty through nesvo_get_run_mutation with the original key.",
            object(
                json!({"key":key,"runId":id,"attemptId":id,"correlationId":key,"kind":{"enum":["note","question","error"],"default":"note"},"body":{"type":"string","minLength":1,"maxLength":4096}}),
                &["key", "runId", "correlationId", "body"],
            ),
            false,
        ),
        (
            "nesvo_ack_messages",
            "ACK 1–32 exact IDs in the receiving mailbox. Worker defaults to its own attempt; coordinator to its run inbox. Coordinator cannot ACK on behalf of a worker; owner may explicitly override. Retry the same IDs after loss: first ACK identity/time are preserved. ACK is delivery only, never task execution or validation.",
            object(
                json!({"runId":id,"attemptId":id,"ids":{"type":"array","minItems":1,"maxItems":32,"uniqueItems":true,"items":id}}),
                &["runId", "ids"],
            ),
            false,
        ),
        (
            "nesvo_list_sessions",
            "List visible session IDs, groups and lifecycle without acquiring control.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_get_session",
            "Inspect one visible session and its independent process/agent/turn state.",
            object(json!({"sessionId":id}), &["sessionId"]),
            true,
        ),
        (
            "nesvo_get_current_session",
            "Inspect the process session injected into this MCP launch. Never guesses from the UI focus; a context hint cannot bypass host authority.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_read_session",
            "Read a bounded terminal replay page. Cursors are UTF-8 byte offsets, not domain-event sequences; gap means retained history expired.",
            object(
                json!({"sessionId":id,"after":cursor,"maxBytes":{"type":"integer","minimum":1,"maximum":8192,"default":4096}}),
                &["sessionId"],
            ),
            true,
        ),
        (
            "nesvo_explain_session",
            "Explain this session's status evidence/readiness and integration health without exposing owner credentials or prompts.",
            object(json!({"sessionId":id}), &["sessionId"]),
            true,
        ),
        (
            "nesvo_read_diff",
            "Read repository changes on the host for this session's automatic edit context. Read-only; no staging or commit.",
            object(
                json!({"sessionId":id,"scope":{"enum":["staged","unstaged","untracked"],"default":"unstaged"}}),
                &["sessionId"],
            ),
            true,
        ),
        (
            "nesvo_open_review",
            "Owner-only: open a host review of a session's or absolute folder's local changes, or fetch a GitHub pull request with gh into a host review checkout (120 s cap, reused when present). Exactly one source: sessionId and/or directory, or pullUrl. Replies reviewOpened with a stable reviewId, base, head and diff revision. Never edits, commits, merges or pushes.",
            object(
                json!({"sessionId":id,"directory":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute host folder, or relative to the session folder"},"pullUrl":{"type":"string","minLength":1,"maxLength":512,"description":"https://github.com/OWNER/REPO/pull/NUMBER"},"base":{"type":"string","minLength":1,"maxLength":256,"description":"Base ref for the branch scope; defaults to the repository default branch or the pull request base"}}),
                &[],
            ),
            false,
        ),
        (
            "nesvo_deliver_review",
            "Owner-only: deliver review feedback for an open reviewId to a ready idle agent session with one receipt. Without a human lease this is a durable send for a stable key (8192 bytes); a client holding control receives a bracketed paste instead. Never takes control; reuse the same key after uncertainty.",
            object(
                json!({"reviewId":id,"sessionId":id,"text":{"type":"string","minLength":1,"maxLength":20480,"description":"Literal review text; MCP arguments are capped at 24 KiB. No terminal controls."},"key":{"type":"string","minLength":1,"maxLength":128,"description":"Idempotency key; derived from review, session and text when omitted"}}),
                &["reviewId", "sessionId", "text"],
            ),
            false,
        ),
        (
            "nesvo_describe_worktree_setup",
            "Owner-only: read the committed nesvo.toml [worktree] table of a repository (HEAD), its normalized setup/run/env_files/timeout_s, digest and approval state. Runs nothing; requires host worktrees:true. Approving or revoking a digest is a human act through the owner CLI (nesvo worktree approve-setup/revoke-setup) and has no agent tool.",
            object(json!({"directory":worktree_directory}), &["directory"]),
            true,
        ),
        (
            "nesvo_run_worktree",
            "Owner-only: start the approved run steps of a session's host-created worktree after a passed setup. Replies worktreeRunStarted with the log path; the result is a worktreeRan event and the registry run state, not task success.",
            object(json!({"sessionId":id}), &["sessionId"]),
            false,
        ),
        (
            "nesvo_cancel_worktree",
            "Owner-only: cancel the active setup or run steps of a session's worktree. Terminates the step process tree; a cancelled setup never starts the agent.",
            object(json!({"sessionId":id}), &["sessionId"]),
            false,
        ),
        (
            "nesvo_archive_worktree",
            "Owner-only: remove a closed session's host-created worktree and its nesvo/ branch. Refuses dirty, unpushed or conflicted work unless discard is true; discarding deletes that work permanently.",
            object(
                json!({"sessionId":id,"discard":{"type":"boolean","default":false,"description":"Explicitly delete unsaved work; never set without the owner's decision"}}),
                &["sessionId"],
            ),
            false,
        ),
        (
            "nesvo_list_worktrees",
            "Owner-only: list host-created worktrees (newest 128) with session, branch, presence, setup and run states, logs and archive facts.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_list_workflow_templates",
            "Owner-only: read the committed nesvo.toml [[workflow]] templates of a repository (HEAD) with tasks, tool profiles, workspace modes, budgets, digest and approval state. Starts nothing; requires host workflowTemplates:true. Approving or revoking a digest is a human act through the owner CLI (nesvo workflow approve-templates/revoke-templates) and has no agent tool.",
            object(json!({"directory":worktree_directory}), &["directory"]),
            true,
        ),
        (
            "nesvo_start_workflow_template",
            "Owner-only: create a run and its tasks from an approved template through the existing run create/plan/budget/activate/executor commands. Unapproved or changed digests are refused. Reuse the same key after uncertainty; a different template under that key is an idempotency conflict. A started run is not task success.",
            object(
                json!({"directory":worktree_directory,"name":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},"key":{"type":"string","minLength":1,"maxLength":96}}),
                &["directory", "name", "key"],
            ),
            false,
        ),
        (
            "nesvo_read_events",
            "Read durable metadata events after a domain cursor. Preserve nextCursor; gap is incomplete history, never success. No terminal transcript.",
            object(
                json!({"sessionId":id,"after":cursor,"limit":{"type":"integer","minimum":1,"maximum":32,"default":32}}),
                &["after"],
            ),
            true,
        ),
        (
            "nesvo_create_session",
            "Create one background process for a stable idempotency key. Reuse the same key/spec after timeout, never invent another key to retry. Created is not agent readiness or task success. Host authorization still applies.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"spec":launch_schema()}),
                &["key", "spec"],
            ),
            false,
        ),
        (
            "nesvo_send_prompt",
            "Submit one literal prompt to a ready idle session for a durable key. Never takes control; human drafts, pending input and decision dialogs are refused. Reuse the same key/prompt after uncertainty; delivery is not agent pickup or task success.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128},"prompt":{"type":"string","minLength":1,"maxLength":8192,"description":"Literal prompt, at most 8192 UTF-8 bytes. Multiline/tab requires observed bracketed paste. No terminal controls."}}),
                &["sessionId", "key", "prompt"],
            ),
            false,
        ),
        (
            "nesvo_wait_prompt",
            "Passively wait for one send receipt by id or your original key. Exactly one selector. Binds the matching response, never old idle. Settled means response ended, not validated task success. A timeout returns the receipt and never retries input.",
            object(
                json!({"id":id,"key":{"type":"string","minLength":1,"maxLength":128},"sessionId":id,"until":{"enum":["delivered","received","started","settled"],"default":"settled"},"timeoutMs":{"type":"integer","minimum":1,"maximum":60000,"default":30000}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_interrupt_session",
            "Submit one Ctrl+C with a durable key; never takes human control. Delivery proves only a native write, not that the agent stopped. May discard the agent's current work. Inspect the same receipt after uncertainty.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["sessionId", "key"],
            ),
            false,
        ),
        (
            "nesvo_stop_session",
            "Request native stop of this managed process once for a durable key. Destructive: can lose in-memory work. Refuses human control, retains terminal output/session record. stopRequested is not observed process exit or task success.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["sessionId", "key"],
            ),
            false,
        ),
        (
            "nesvo_activate_run",
            "Freeze a nonempty draft DAG at an expected revision. Does not start any process or send prompts.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_assign_task",
            "Bind one existing worker process to a dependency-ready task. Only host-granted children for coordinators. Refuses human control/drafts/pending input. No prompt is sent. Retain the returned attempt identity; one process per attempt.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"sessionId":id,"expectedRevision":revision}),
                &["key", "runId", "taskId", "sessionId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_task_attempts",
            "Read a task and four retained attempts per page. Owner/coordinator only. Follow nextOffset; reported success remains unvalidated until separately accepted.",
            object(
                json!({"runId":id,"taskId":id,"offset":{"type":"integer","minimum":0,"maximum":16}}),
                &["runId", "taskId"],
            ),
            true,
        ),
        (
            "nesvo_get_current_task",
            "Read this authenticated worker's current task and attempt. Never uses UI focus or environment identity hints. A superseded attempt is refused.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_recover_run_context",
            "Read current recovery metadata for the authenticated worker or uniquely bound coordinator run. Multiple runs require explicit selection; owner needs runId. Follow returned current-page nextOffset/expectedDigest. Never adopts processes, replays input, ACKs constraints/messages or validates results.",
            object(
                json!({"runId":id,"offset":{"type":"integer","minimum":0,"maximum":16384},"expectedDigest":{"type":"string","maxLength":128}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_report_task_result",
            "Report this worker's exact current attempt result. Include files/artifacts/checks/limitations, using empty arrays when none. Claims are not verification or validation. Reuse the original key after uncertainty; stale senders/replacement reports are refused. Result bound 4 KiB UTF-8.",
            object(
                json!({"key":key,"attemptId":id,"result":{"type":"object","additionalProperties":false,"required":["outcome","summary","files","artifacts","checks","limitations"],"properties":{"outcome":{"enum":["succeeded","failed","blocked","canceled"]},"summary":{"type":"string","minLength":1,"maxLength":2048},"files":strings(32),"artifacts":strings(16),"checks":checks,"limitations":strings(16)}}}),
                &["key", "attemptId", "result"],
            ),
            false,
        ),
        (
            "nesvo_validate_task_result",
            "Record owner/coordinator attestation of the current reported result. Success needs a succeeded report and passed validation checks. The host records evidence, without executing checks. Accepted results release dependencies; idle never does. Validation bound 2 KiB UTF-8.",
            object(
                json!({"key":key,"runId":id,"attemptId":id,"expectedRevision":revision,"validation":{"type":"object","additionalProperties":false,"required":["passed","summary","checks"],"properties":{"passed":{"type":"boolean"},"summary":{"type":"string","minLength":1,"maxLength":1024},"checks":checks}}}),
                &[
                    "key",
                    "runId",
                    "attemptId",
                    "expectedRevision",
                    "validation",
                ],
            ),
            false,
        ),
        (
            "nesvo_create_run",
            "Create a durable draft run once for a stable key. No agent or task is started; scoped coordinators are bound by the host.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"spec":{"type":"object","additionalProperties":false,"required":["title","goal"],"properties":{"title":{"type":"string","minLength":1,"maxLength":80},"goal":{"type":"string","minLength":1,"maxLength":8192},"coordinatorSessionId":{"type":["string","null"]}}}}),
                &["key", "spec"],
            ),
            false,
        ),
        (
            "nesvo_list_runs",
            "List a bounded page of visible workflow summaries. Follow nextOffset; does not expose goal/instruction text.",
            object(
                json!({"offset":{"type":"integer","minimum":0,"maximum":1024,"default":0}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_get_run",
            "Read a visible run and its draft DAG by stable run ID. Planned/dependency-ready never means executed or successful.",
            object(json!({"runId":id}), &["runId"]),
            true,
        ),
        (
            "nesvo_set_run_plan",
            "Atomically replace a draft DAG at an expected revision. Task keys retain IDs. Dependencies are task keys, not names. Cycles/missing edges are refused. Reuse the original key after uncertainty.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"runId":id,"expectedRevision":{"type":"integer","minimum":1},"tasks":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["key","title","instruction"],"properties":{"key":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},"title":{"type":"string","minLength":1,"maxLength":80},"instruction":{"type":"string","minLength":1,"maxLength":8192},"dependencies":{"type":"array","maxItems":64,"items":{"type":"string"}}}}}}),
                &["key", "runId", "expectedRevision", "tasks"],
            ),
            false,
        ),
        (
            "nesvo_get_run_mutation",
            "Recover the historical result of your workflow metadata mutation by its original key. Separate from native process-operation receipts; never starts an agent.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["key"],
            ),
            true,
        ),
        (
            "nesvo_get_operation",
            "Recover a durable operation by its ID or your original idempotency key. Exactly one selector. Never resend with a fresh key after an unknown result.",
            object(
                json!({"id":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &[],
            ),
            true,
        ),
    ];
    definitions.into_iter().map(|(name,description,schema,read_only)| {
        Tool::new(name,description,schema).with_annotations(ToolAnnotations::new().read_only(read_only).destructive(matches!(name,"nesvo_interrupt_session"|"nesvo_stop_session"|"nesvo_archive_worktree"|"nesvo_stop_run"|"nesvo_cancel_run"|"nesvo_cancel_job_occurrence")).idempotent(true).open_world(!read_only || name == "nesvo_get_provider_quota"))
            .with_raw_output_schema(Arc::new(serde_json::from_value(json!({"type":"object","required":["schemaVersion","ok"],"properties":{"schemaVersion":{"const":1},"ok":{"type":"boolean"},"data":{"type":"object"},"error":{"type":"object"}}})).expect("constant result schema")))
    }).chain(crate::job_trigger_tools::catalog()).chain(crate::session_recovery::catalog()).chain(cli::attention::catalog()).chain(crate::project_commands::catalog()).collect()
}

#[cfg(test)]
#[path = "quota_mcp_tests.rs"]
mod quota_tests;

#[cfg(test)]
mod workflow_template_tests {
    use super::*;

    #[test]
    fn workflow_template_mcp_matches_cli_wire_and_has_no_approval_tool() {
        assert_eq!(
            command(
                "nesvo_list_workflow_templates",
                json!({"directory":"/repo"})
            )
            .unwrap(),
            crate::runs::template_command("list", "/repo", None, None).unwrap()
        );
        assert_eq!(
            command(
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review","key":"k1"})
            )
            .unwrap(),
            (
                json!({"type":"startWorkflowTemplate","directory":"/repo","name":"review","key":"k1"}),
                "workflowTemplateStarted"
            )
        );
        for (name, value) in [
            ("nesvo_list_workflow_templates", json!({})),
            (
                "nesvo_list_workflow_templates",
                json!({"directory":"/repo","digest":"a".repeat(64)}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"bad name","key":"k"}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review","key":""}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review"}),
            ),
        ] {
            assert!(command(name, value.clone()).is_err(), "{name} {value}");
        }
        for name in [
            "nesvo_approve_workflow_templates",
            "nesvo_revoke_workflow_templates",
        ] {
            assert!(catalog().iter().all(|tool| tool.name != name), "{name}");
        }
        for (name, read_only) in [
            ("nesvo_list_workflow_templates", true),
            ("nesvo_start_workflow_template", false),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
        }
    }
}

#[cfg(test)]
mod worktree_tests {
    use super::*;

    #[test]
    fn worktree_mcp_matches_cli_wire_and_refuses_extra_arguments() {
        let digest = "b".repeat(64);
        for name in [
            "nesvo_approve_worktree_setup",
            "nesvo_revoke_worktree_setup",
        ] {
            assert!(
                command(name, json!({"directory":"/repo","digest":digest})).is_err(),
                "{name}"
            );
            assert!(catalog().iter().all(|tool| tool.name != name), "{name}");
            assert!(!published_tools().iter().any(|tool| tool == name), "{name}");
        }
        assert_eq!(
            command(
                "nesvo_describe_worktree_setup",
                json!({"directory":"/repo"})
            )
            .unwrap(),
            cli::worktree_setup_query("describe", "/repo", None).unwrap()
        );
        assert_eq!(
            command(
                "nesvo_archive_worktree",
                json!({"sessionId":"s","discard":true})
            )
            .unwrap(),
            cli::worktree_session_query("archive", "s", true).unwrap()
        );
        assert_eq!(
            command("nesvo_archive_worktree", json!({"sessionId":"s"})).unwrap(),
            cli::worktree_session_query("archive", "s", false).unwrap()
        );
        assert_eq!(
            command("nesvo_run_worktree", json!({"sessionId":"s"})).unwrap(),
            cli::worktree_session_query("run", "s", false).unwrap()
        );
        assert_eq!(
            command("nesvo_list_worktrees", json!({})).unwrap(),
            (json!({"type":"listWorktrees"}), "worktreeRegistry")
        );
        for (name, value) in [
            ("nesvo_describe_worktree_setup", json!({})),
            (
                "nesvo_describe_worktree_setup",
                json!({"directory":"/repo","digest":digest}),
            ),
            (
                "nesvo_run_worktree",
                json!({"sessionId":"s","discard":false}),
            ),
            ("nesvo_cancel_worktree", json!({})),
            (
                "nesvo_archive_worktree",
                json!({"sessionId":"s","force":true}),
            ),
            (
                "nesvo_archive_worktree",
                json!({"sessionId":"s","discard":"yes"}),
            ),
            ("nesvo_list_worktrees", json!({"repository":"/repo"})),
        ] {
            assert!(command(name, value.clone()).is_err(), "{name} {value}");
        }
    }

    #[test]
    fn worktree_catalog_marks_reads_and_the_destructive_archive() {
        for (name, read_only, destructive) in [
            ("nesvo_describe_worktree_setup", true, false),
            ("nesvo_run_worktree", false, false),
            ("nesvo_cancel_worktree", false, false),
            ("nesvo_archive_worktree", false, true),
            ("nesvo_list_worktrees", true, false),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], destructive);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
            assert_eq!(
                published_tools()
                    .iter()
                    .filter(|tool| tool.as_str() == name)
                    .count(),
                1
            );
        }
    }
}

#[cfg(test)]
mod quota_wake_tests {
    use super::*;

    #[test]
    fn quota_wake_mcp_matches_cli_wire_and_requires_exact_mutation_arguments() {
        for enabled in [false, true] {
            assert_eq!(
                command(
                    "nesvo_set_quota_wake",
                    json!({"sessionId":"s","enabled":enabled})
                )
                .unwrap(),
                cli::quota_wake_query("s", Some(enabled)).unwrap()
            );
        }
        assert_eq!(
            command("nesvo_get_quota_wake", json!({"sessionId":"s"})).unwrap(),
            cli::quota_wake_query("s", None).unwrap()
        );
        for value in [
            json!({}),
            json!({"sessionId":"s"}),
            json!({"enabled":true}),
            json!({"sessionId":null,"enabled":true}),
            json!({"sessionId":"s","enabled":null}),
            json!({"sessionId":"s","enabled":"true"}),
            json!({"sessionId":"s","enabled":1}),
            json!({"sessionId":"s","enabled":true,"owner":true}),
            json!({"sessionId":"s","enabled":true,"accountId":"injected"}),
            json!({"sessionId":"s","enabled":true,"readerId":"ambient"}),
            json!({"sessionId":"s","enabled":true,"prompt":"new task"}),
            json!({"sessionId":"s","enabled":true,"key":"replay-input"}),
            json!({"sessionId":"s","enabled":true,"type":"sendOperation"}),
            json!({"sessionId":"bad\nidentity","enabled":true}),
            json!([]),
            json!(null),
        ] {
            assert!(command("nesvo_set_quota_wake", value).is_err());
        }
        for value in [
            json!({}),
            json!({"sessionId":"s","enabled":true}),
            json!({"sessionId":"s","refresh":true}),
            json!({"sessionId":"s","scopeId":"foreign"}),
            json!({"sessionId":null}),
        ] {
            assert!(command("nesvo_get_quota_wake", value).is_err());
        }
    }

    #[test]
    fn quota_wake_catalog_is_strict_and_get_remains_read_only() {
        for (name, required, read_only) in [
            (
                "nesvo_set_quota_wake",
                json!(["sessionId", "enabled"]),
                false,
            ),
            ("nesvo_get_quota_wake", json!(["sessionId"]), true),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert_eq!(tool["inputSchema"]["required"], required);
            assert_eq!(
                tool["inputSchema"]["properties"].as_object().unwrap().len(),
                if read_only { 1 } else { 2 }
            );
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert_eq!(tool["annotations"]["openWorldHint"], !read_only);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .contains("durableQuotaWake:true")
            );
            assert_eq!(
                published_tools()
                    .iter()
                    .filter(|tool| tool.as_str() == name)
                    .count(),
                1
            );
        }
        assert_eq!(catalog().len(), 113);
        assert_eq!(published_tools().len(), 113);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetQuotaWake {
    session_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderQuota {
    program: Option<String>,
    directory: Option<String>,
    #[serde(default)]
    refresh: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    session_id: String,
    after: Option<u64>,
    max_bytes: Option<u16>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diff {
    session_id: String,
    scope: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenReview {
    session_id: Option<String>,
    directory: Option<String>,
    pull_url: Option<String>,
    base: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliverReview {
    review_id: String,
    session_id: String,
    text: String,
    key: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeSetup {
    directory: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeSession {
    session_id: String,
    discard: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowTemplateStart {
    directory: String,
    name: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Events {
    session_id: Option<String>,
    after: u64,
    limit: Option<u16>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    key: String,
    spec: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    id: Option<String>,
    key: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Send {
    session_id: String,
    key: String,
    prompt: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    session_id: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    id: Option<String>,
    key: Option<String>,
    session_id: Option<String>,
    until: Option<String>,
    timeout_ms: Option<u64>,
}
fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T> {
    serde_json::from_value(arguments)
        .map_err(|_| cli::failure("invalid_argument", "Arguments must match the tool schema"))
}
fn command(name: &str, arguments: Value) -> Result<(Value, &'static str)> {
    if serde_json::to_vec(&arguments)?.len() > 24 * 1024 {
        return Err(cli::failure(
            "invalid_argument",
            "Tool arguments exceed 24 KiB",
        ));
    }
    if let Some(request) = crate::job_trigger_tools::command(name, &arguments) {
        return request.map(|request| (request, "workflow"));
    }
    if let Some(request) = cli::attention::command(name, &arguments) {
        return request;
    }
    if let Some(request) = crate::session_recovery::command(name, &arguments) {
        return request;
    }
    if let Some(request) = crate::project_commands::command(name, &arguments) {
        return request;
    }
    Ok(match name {
        "nesvo_set_quota_wake" => {
            let request: SetQuotaWake = parse(arguments)?;
            cli::quota_wake_query(&request.session_id, Some(request.enabled))?
        }
        "nesvo_get_quota_wake" => {
            let request: Session = parse(arguments)?;
            cli::quota_wake_query(&request.session_id, None)?
        }
        "nesvo_get_provider_quota" => {
            if arguments
                .get("directory")
                .is_some_and(|value| !value.is_string())
            {
                return Err(cli::failure(
                    "invalid_argument",
                    "Quota directory must be a host folder",
                ));
            }
            if arguments
                .get("program")
                .is_some_and(|value| !value.is_string())
            {
                return Err(cli::failure(
                    "invalid_argument",
                    "Quota program must be a provider name",
                ));
            }
            let query: ProviderQuota = parse(arguments)?;
            (
                cli::provider_quota_context_query(
                    query.program.as_deref(),
                    query.refresh,
                    query.directory.as_deref(),
                )?,
                "providerQuota",
            )
        }
        "nesvo_rebind_run_coordinator" => (
            crate::workflow::tool("coordinator", json!({"request":arguments}))?,
            "workflow",
        ),
        "nesvo_add_run_constraint"
        | "nesvo_list_run_constraints"
        | "nesvo_acknowledge_run_constraints"
        | "nesvo_save_run_checkpoint"
        | "nesvo_list_run_checkpoints"
        | "nesvo_get_run_checkpoint"
        | "nesvo_read_run_context" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Context arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Context action is selected by the tool name",
                ));
            }
            let (group, action) = match name {
                "nesvo_add_run_constraint" => ("constraints", "add"),
                "nesvo_list_run_constraints" => ("constraints", "list"),
                "nesvo_acknowledge_run_constraints" => ("constraints", "acknowledge"),
                "nesvo_save_run_checkpoint" => ("checkpoints", "save"),
                "nesvo_list_run_checkpoints" => ("checkpoints", "list"),
                "nesvo_get_run_checkpoint" => ("checkpoints", "get"),
                _ => ("checkpoints", "context"),
            };
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool(group, json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_enable_run_wakes"
        | "nesvo_get_run_wakes"
        | "nesvo_disable_run_wakes"
        | "nesvo_get_run_wake_batch" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Wake arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Wake action is selected by the tool name",
                ));
            }
            let action = match name {
                "nesvo_enable_run_wakes" => "enable",
                "nesvo_get_run_wakes" => "get",
                "nesvo_disable_run_wakes" => "disable",
                _ => "batch",
            };
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("wakes", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_start_run_executor"
        | "nesvo_get_run_executor"
        | "nesvo_disable_run_executor"
        | "nesvo_enable_run_executor" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Executor arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Executor action is selected by the tool name",
                ));
            }
            let action = match name {
                "nesvo_start_run_executor" => "start",
                "nesvo_get_run_executor" => "get",
                "nesvo_disable_run_executor" => "disable",
                _ => "enable",
            };
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("executor", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_deliver_task" | "nesvo_cancel_task_delivery" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Delivery arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Delivery action is selected by the tool name",
                ));
            }
            fields.insert(
                "action".into(),
                if name == "nesvo_deliver_task" {
                    "queue"
                } else {
                    "cancel"
                }
                .into(),
            );
            (
                crate::workflow::tool("delivery", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_launch_task" => (
            crate::workflow::tool("launch", json!({"request":arguments}))?,
            "workflow",
        ),
        "nesvo_stop_run" | "nesvo_cancel_run" | "nesvo_get_run_control" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure(
                        "invalid_argument",
                        "Run control arguments must be an object",
                    )
                })?
                .clone();
            if fields.contains_key("action") || fields.contains_key("kind") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Control action is selected by the tool name",
                ));
            }
            if name == "nesvo_get_run_control" {
                fields.insert("action".into(), "get".into());
            } else {
                fields.insert("action".into(), "start".into());
                fields.insert(
                    "kind".into(),
                    if name == "nesvo_stop_run" {
                        "stop"
                    } else {
                        "cancel"
                    }
                    .into(),
                );
            }
            (
                crate::workflow::tool("control", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_get_host_budget"
        | "nesvo_set_host_budget"
        | "nesvo_get_run_budget"
        | "nesvo_set_run_budget" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Budget arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Budget action is selected by the tool name",
                ));
            }
            fields.insert(
                "action".into(),
                if matches!(name, "nesvo_get_host_budget" | "nesvo_get_run_budget") {
                    "get"
                } else {
                    "set"
                }
                .into(),
            );
            (
                crate::workflow::tool(
                    if name.contains("host_budget") {
                        "hostBudget"
                    } else {
                        "runBudget"
                    },
                    json!({"request":fields}),
                )?,
                "workflow",
            )
        }
        "nesvo_drain_run" | "nesvo_resume_run" => (
            crate::workflow::tool(
                if name == "nesvo_drain_run" {
                    "drain"
                } else {
                    "resume"
                },
                arguments,
            )?,
            "workflow",
        ),
        "nesvo_ask_decision"
        | "nesvo_list_decisions"
        | "nesvo_get_decision"
        | "nesvo_answer_decision"
        | "nesvo_cancel_decision" => {
            let action = match name {
                "nesvo_ask_decision" => "ask",
                "nesvo_list_decisions" => "list",
                "nesvo_get_decision" => "get",
                "nesvo_answer_decision" => "answer",
                _ => "cancel",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Decision arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Decision action is selected by the tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("decision", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_describe_precheck"
        | "nesvo_approve_precheck"
        | "nesvo_get_precheck"
        | "nesvo_list_prechecks"
        | "nesvo_revoke_precheck"
        | "nesvo_get_precheck_mutation" => {
            let action = match name {
                "nesvo_describe_precheck" => "describe",
                "nesvo_approve_precheck" => "approve",
                "nesvo_get_precheck" => "get",
                "nesvo_list_prechecks" => "list",
                "nesvo_revoke_precheck" => "revoke",
                _ => "mutation",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Precheck arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Precheck action is selected by tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool(
                    "jobs",
                    json!({"request":{"action":"prechecks","request":fields}}),
                )?,
                "workflow",
            )
        }
        "nesvo_create_job"
        | "nesvo_get_job"
        | "nesvo_list_jobs"
        | "nesvo_update_job"
        | "nesvo_set_job_enabled"
        | "nesvo_run_job_now"
        | "nesvo_cancel_job_occurrence"
        | "nesvo_get_job_history"
        | "nesvo_get_job_occurrence"
        | "nesvo_get_job_attempts"
        | "nesvo_get_job_attempt"
        | "nesvo_get_job_mutation"
        | "nesvo_abandon_job_precheck"
        | "nesvo_abandon_job_launch"
        | "nesvo_authorize_job_quota" => {
            let action = match name {
                "nesvo_create_job" => "create",
                "nesvo_get_job" => "get",
                "nesvo_list_jobs" => "list",
                "nesvo_update_job" => "update",
                "nesvo_set_job_enabled" => "setEnabled",
                "nesvo_run_job_now" => "runNow",
                "nesvo_cancel_job_occurrence" => "cancelOccurrence",
                "nesvo_get_job_history" => "history",
                "nesvo_get_job_occurrence" => "occurrence",
                "nesvo_get_job_attempts" => "attempts",
                "nesvo_get_job_attempt" => "attempt",
                "nesvo_abandon_job_precheck" => "abandonPrecheck",
                "nesvo_abandon_job_launch" => "abandonLaunchNoEffect",
                "nesvo_authorize_job_quota" => "authorizeQuota",
                _ => "mutation",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| cli::failure("invalid_argument", "Job arguments must be an object"))?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Job action is selected by the tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("jobs", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_read_inbox" | "nesvo_send_message" | "nesvo_ack_messages" => {
            let action = match name {
                "nesvo_read_inbox" => "read",
                "nesvo_send_message" => "send",
                _ => "ack",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Inbox arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Inbox action is selected by the tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("inbox", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_create_run"
        | "nesvo_list_runs"
        | "nesvo_get_run"
        | "nesvo_set_run_plan"
        | "nesvo_get_run_mutation"
        | "nesvo_activate_run"
        | "nesvo_assign_task"
        | "nesvo_get_task_attempts"
        | "nesvo_get_current_task"
        | "nesvo_recover_run_context"
        | "nesvo_report_task_result"
        | "nesvo_validate_task_result" => {
            let action = match name {
                "nesvo_create_run" => "create",
                "nesvo_list_runs" => "list",
                "nesvo_get_run" => "get",
                "nesvo_set_run_plan" => "setPlan",
                "nesvo_activate_run" => "activate",
                "nesvo_assign_task" => "assign",
                "nesvo_get_task_attempts" => "task",
                "nesvo_get_current_task" => "context",
                "nesvo_recover_run_context" => "recover",
                "nesvo_report_task_result" => "report",
                "nesvo_validate_task_result" => "validate",
                _ => "mutation",
            };
            (crate::workflow::tool(action, arguments)?, "workflow")
        }
        "nesvo_list_sessions" | "nesvo_get_current_session" => {
            let args: serde_json::Map<String, Value> = parse(arguments)?;
            if !args.is_empty() {
                return Err(cli::failure(
                    "invalid_argument",
                    "This tool takes no arguments",
                ));
            }
            if name == "nesvo_get_current_session" {
                (json!({"type":"getSession"}), "session")
            } else {
                (json!({"type":"list"}), "sessions")
            }
        }
        "nesvo_get_session" | "nesvo_explain_session" => {
            let s: Session = parse(arguments)?;
            cli::valid_id(&s.session_id)?;
            if name == "nesvo_get_session" {
                (
                    json!({"type":"getSession","sessionId":s.session_id}),
                    "session",
                )
            } else {
                (
                    json!({"type":"getDiagnostics","sessionId":s.session_id}),
                    "diagnostics",
                )
            }
        }
        "nesvo_read_session" => {
            let a: Read = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            if !(1..=8192).contains(&a.max_bytes.unwrap_or(4096)) {
                return Err(cli::failure("invalid_argument", "maxBytes must be 1–8192"));
            }
            (
                json!({"type":"readSession","sessionId":a.session_id,"after":a.after,"maxBytes":a.max_bytes}),
                "sessionRead",
            )
        }
        "nesvo_read_diff" => {
            let a: Diff = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            let scope = a.scope.as_deref().unwrap_or("unstaged");
            if !matches!(scope, "staged" | "unstaged" | "untracked") {
                return Err(cli::failure("invalid_argument", "Invalid diff scope"));
            }
            (
                json!({"type":"getDiff","sessionId":a.session_id,"scope":scope}),
                "diff",
            )
        }
        "nesvo_open_review" => {
            let a: OpenReview = parse(arguments)?;
            (
                cli::open_review_query(
                    a.session_id.as_deref(),
                    a.directory.as_deref(),
                    a.pull_url.as_deref(),
                    a.base.as_deref(),
                )?,
                "reviewOpened",
            )
        }
        "nesvo_deliver_review" => {
            let a: DeliverReview = parse(arguments)?;
            (
                cli::deliver_review_query(&a.review_id, &a.session_id, &a.text, a.key.as_deref())?,
                "reviewDelivered",
            )
        }
        "nesvo_describe_worktree_setup" => {
            let a: WorktreeSetup = parse(arguments)?;
            cli::worktree_setup_query("describe", &a.directory, None)?
        }
        "nesvo_run_worktree" | "nesvo_cancel_worktree" | "nesvo_archive_worktree" => {
            let a: WorktreeSession = parse(arguments)?;
            let action = match name {
                "nesvo_run_worktree" => "run",
                "nesvo_cancel_worktree" => "cancel",
                _ => "archive",
            };
            if action != "archive" && a.discard.is_some() {
                return Err(cli::failure(
                    "invalid_argument",
                    "Only archive accepts discard",
                ));
            }
            cli::worktree_session_query(action, &a.session_id, a.discard.unwrap_or(false))?
        }
        "nesvo_list_worktrees" => {
            let _: Empty = parse(arguments)?;
            (json!({"type":"listWorktrees"}), "worktreeRegistry")
        }
        "nesvo_list_workflow_templates" => {
            let a: WorktreeSetup = parse(arguments)?;
            crate::runs::template_command("list", &a.directory, None, None)?
        }
        "nesvo_start_workflow_template" => {
            let a: WorkflowTemplateStart = parse(arguments)?;
            crate::runs::template_command("start", &a.directory, None, Some((&a.name, &a.key)))?
        }
        "nesvo_read_events" => {
            let a: Events = parse(arguments)?;
            if let Some(id) = &a.session_id {
                cli::valid_id(id)?;
            }
            if !(1..=32).contains(&a.limit.unwrap_or(32)) {
                return Err(cli::failure("invalid_argument", "Event limit must be 1–32"));
            }
            (
                json!({"type":"readEvents","sessionId":a.session_id,"after":a.after,"limit":a.limit}),
                "events",
            )
        }
        "nesvo_create_session" => {
            let a: Create = parse(arguments)?;
            let valid = a.spec.as_object().is_some_and(|spec| {
                spec.get("name").is_some_and(Value::is_string)
                    && spec.iter().all(|(key, value)| match key.as_str() {
                        "name" | "cwd" | "prompt" | "model" | "effort" => value.is_string(),
                        "program" => value
                            .as_str()
                            .is_some_and(|v| matches!(v, "shell" | "claude" | "codex" | "gemini")),
                        "groupId" | "parentSessionId" => value.is_null() || value.is_string(),
                        "role" => value
                            .as_str()
                            .is_some_and(|role| matches!(role, "worker" | "coordinator")),
                        "harness" | "worktree" | "autoTitle" | "muted" | "resumePicker" => {
                            value.is_boolean()
                        }
                        "allowedNesvoTools" | "childAllowedNesvoTools" => {
                            valid_permission_additions(value)
                        }
                        "claudeQuotaCapture" => {
                            crate::workflow_launches::valid_capture(value, &a.spec["program"])
                        }
                        _ => false,
                    })
            });
            if !valid {
                return Err(cli::failure(
                    "invalid_argument",
                    "Launch spec fields must match the declared schema",
                ));
            }
            (
                json!({"type":"createOperation","key":a.key,"spec":a.spec}),
                "operation",
            )
        }
        "nesvo_interrupt_session" | "nesvo_stop_session" => {
            let a: Control = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            cli::valid_id(&a.key)?;
            (
                json!({"type":if name=="nesvo_interrupt_session"{"interruptOperation"}else{"stopOperation"},"sessionId":a.session_id,"key":a.key}),
                "operation",
            )
        }
        "nesvo_send_prompt" => {
            let a: Send = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            cli::valid_id(&a.key)?;
            if a.prompt.trim().is_empty()
                || a.prompt.len() > 8192
                || a.prompt
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
            {
                return Err(cli::failure(
                    "invalid_argument",
                    "Prompt must be nonempty UTF-8 within 8192 bytes, without terminal controls",
                ));
            }
            (
                json!({"type":"sendOperation","sessionId":a.session_id,"key":a.key,"prompt":a.prompt}),
                "operation",
            )
        }
        "nesvo_wait_prompt" => {
            let a: Wait = parse(arguments)?;
            if a.id.is_some() == a.key.is_some() {
                return Err(cli::failure(
                    "invalid_argument",
                    "Supply one operation ID or key",
                ));
            }
            for id in [&a.id, &a.key, &a.session_id].into_iter().flatten() {
                cli::valid_id(id)?;
            }
            let until = a.until.as_deref().unwrap_or("settled");
            let timeout = a.timeout_ms.unwrap_or(30_000);
            if !matches!(until, "delivered" | "received" | "started" | "settled")
                || !(1..=60_000).contains(&timeout)
            {
                return Err(cli::failure(
                    "invalid_argument",
                    "Invalid wait milestone or timeout (1–60000 ms)",
                ));
            }
            (
                json!({"type":"waitOperation","id":a.id,"key":a.key,"sessionId":a.session_id,"until":until,"timeoutMs":timeout}),
                "operation",
            )
        }
        "nesvo_get_operation" => {
            let a: Operation = parse(arguments)?;
            if a.id.is_some() == a.key.is_some() {
                return Err(cli::failure(
                    "invalid_argument",
                    "Supply one operation ID or key",
                ));
            }
            (
                json!({"type":"getOperation","id":a.id,"key":a.key}),
                "operation",
            )
        }
        _ => return Err(cli::failure("invalid_argument", "Unknown Nesvo tool")),
    })
}

struct HostTools {
    pairing: PathBuf,
    url: Option<String>,
    slots: Semaphore,
    events: mcp_events::EventBridge,
}
impl HostTools {
    async fn invoke_until_cancelled(
        &self,
        name: &str,
        arguments: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cli::failure(
                "canceled",
                "Tool call canceled; inspect the original mutation or receipt before another request",
            )),
            result = self.invoke(name, arguments) => result,
        }
        // Dropping invoke releases its slot and connection. Accepted host work
        // keeps its original identity and is never replayed or interrupted here.
    }

    async fn invoke(&self, name: &str, arguments: Value) -> Result<Value> {
        let (mut command, kind) = command(name, arguments)?;
        let _permit = self.slots.try_acquire().map_err(|_| {
            cli::failure(
                "busy",
                "Four host calls are already pending; wait for a result before retrying",
            )
        })?;
        let pairing=Pairing::load(&self.pairing,self.url.as_deref()).map_err(|_|cli::failure("pairing_unavailable","Cannot load the private caller context; never substitute an owner key for a worker"))?;
        let mut connection = Connection::open(pairing).await.map_err(|error| {
            cli::failure(
                "host_unavailable",
                &open_failure_message(&error, "Cannot authenticate with the paired host"),
            )
        })?;
        if name == "nesvo_get_current_session" {
            let caps = cli::request(
                &mut connection,
                json!({"type":"getCapabilities"}),
                "capabilities",
            )
            .await?;
            command["sessionId"] = cli::current_session(&caps)?.into();
        }
        if matches!(kind, "quotaWake" | "wakeConfigured") {
            cli::quota_wake_capability(&mut connection).await?;
        } else if kind == "providerQuota" {
            cli::provider_quota_capability(&mut connection).await?;
            if command.get("directory").is_some()
                && cli::request(
                    &mut connection,
                    json!({"type":"getCapabilities"}),
                    "capabilities",
                )
                .await?["providerQuotaContexts"]
                    != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host does not support configured-directory quota observations",
                ));
            }
        } else if kind == "workflow" {
            crate::workflow::capability(&mut connection, &command).await?;
        } else if cli::attention::TOOLS.contains(&name) {
            cli::attention::capability(&mut connection, &command).await?;
        } else if crate::session_recovery::TOOLS.contains(&name) {
            crate::session_recovery::capability(&mut connection, &command).await?;
        } else if crate::project_commands::TOOLS.contains(&name) {
            crate::project_commands::capability(&mut connection).await?;
        } else if matches!(name, "nesvo_interrupt_session" | "nesvo_stop_session") {
            cli::control_capability(&mut connection).await?;
        } else if matches!(name, "nesvo_send_prompt" | "nesvo_wait_prompt") {
            cli::prompt_capability(&mut connection).await?;
        } else if matches!(kind, "reviewOpened" | "reviewDelivered") {
            cli::review_capability(&mut connection).await?;
        } else if kind.starts_with("worktree") {
            cli::worktree_capability(&mut connection).await?;
        } else if kind.starts_with("workflowTemplate") {
            cli::workflow_templates_capability(&mut connection).await?;
        } else if kind == "operation" {
            let caps = cli::operation_capability(&mut connection).await?;
            if name == "nesvo_create_session"
                && command["spec"].get("claudeQuotaCapture").is_some()
                && caps["claudeQuotaCapture"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot configure explicit Claude quota capture; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"].get("childAllowedNesvoTools").is_some()
                && caps["childToolPolicy"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce an owner child-tool policy; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && (command["spec"].get("model").is_some()
                    || command["spec"].get("effort").is_some())
                && caps["sessionModelProfiles"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host lacks launch-local model profile support; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"].get("allowedNesvoTools").is_some()
                && caps["sessionToolPermissions"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce process-scoped tool permission additions; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["harness"].is_boolean()
                && caps["sessionHarness"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot configure session-scoped harness tools; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["role"] == "coordinator"
                && caps["coordinatorScopes"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce coordinator scopes; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["parentSessionId"].is_string()
                && caps["sessionLineage"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot preserve parent-session lineage; update nesvo-host",
                ));
            }
        }
        let mut result = cli::request(&mut connection, command, kind).await?;
        if matches!(
            name,
            "nesvo_create_session"
                | "nesvo_send_prompt"
                | "nesvo_interrupt_session"
                | "nesvo_stop_session"
                | "nesvo_deliver_review"
        ) {
            cli::check_receipt(&result)?;
        }
        if name == "nesvo_wait_prompt" {
            cli::check_wait(&result)?;
        }
        if let Some(o) = result.as_object_mut() {
            o.remove("requestId");
        }
        Ok(json!({"schemaVersion":1,"ok":true,"data":result}))
    }
}
impl ServerHandler for HostTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .build(),
        )
            .with_server_info(Implementation::new("nesvo",env!("CARGO_PKG_VERSION")))
            .with_instructions("Host session IDs are stable process identities, not UI focus. Capabilities come from the private launch context. Never request owner credentials to bypass a refusal. After a timeout inspect the original idempotency key; unknown, idle and response settlement never mean task success.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        catalog().into_iter().find(|t| t.name == name)
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        if request.is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "Tool catalog fits one page; omit cursor",
                None,
            ));
        }
        Ok(ListToolsResult::with_all_items(catalog()))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let result = match self
            .invoke_until_cancelled(
                &request.name,
                Value::Object(request.arguments.unwrap_or_default()),
                &context.ct,
            )
            .await
        {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(cli::error_value(&error)),
        };
        Ok(result.into())
    }
    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, ErrorData> {
        mcp_events::single_page(request.as_ref())?;
        Ok(mcp_events::resources())
    }
    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourceTemplatesResult, ErrorData> {
        mcp_events::single_page(request.as_ref())?;
        Ok(mcp_events::templates())
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, ErrorData> {
        mcp_events::read(
            &self.pairing,
            self.url.as_deref(),
            &self.slots,
            &request.uri,
            &context.ct,
        )
        .await
        .map(Into::into)
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(mcp_events::EventBridge::accepted(requested))
    }
    async fn listen(&self, context: SubscriptionContext) -> std::result::Result<(), ErrorData> {
        self.events
            .listen(&self.pairing, self.url.as_deref(), context)
            .await
    }
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<(), ErrorData> {
        self.events
            .subscribe(
                &self.pairing,
                self.url.as_deref(),
                request.uri,
                context.peer,
            )
            .await
    }
    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<(), ErrorData> {
        self.events.unsubscribe(&request.uri).await
    }
}

pub async fn serve(pairing: PathBuf, url: Option<String>) -> Result<()> {
    // The SDK's default stdio reader has no line limit. Use its codec with a cap;
    // malformed/oversized input closes this adapter before dispatching that input.
    let input = FramedRead::new(
        tokio::io::stdin(),
        JsonRpcMessageCodec::<RxJsonRpcMessage<RoleServer>>::new_with_max_length(MAX_MESSAGE),
    )
    .take_while(|message| future::ready(message.is_ok()))
    .filter_map(|message| future::ready(message.ok()));
    let output = FramedWrite::new(
        tokio::io::stdout(),
        JsonRpcMessageCodec::<TxJsonRpcMessage<RoleServer>>::default(),
    );
    let tools = HostTools {
        pairing,
        url,
        slots: Semaphore::new(4),
        events: mcp_events::EventBridge::default(),
    };
    let closed = tools.events.closed();
    let input = Box::pin(
        input.chain(
            futures_util::stream::once(async move {
                closed.cancel();
                None
            })
            .filter_map(future::ready),
        ),
    );
    tools.serve((output, input)).await?.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_before_invoke_precedes_validation_and_slot_acquisition() {
        let tools = HostTools {
            pairing: PathBuf::new(),
            url: None,
            slots: Semaphore::new(0),
            events: mcp_events::EventBridge::default(),
        };
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        for name in ["nesvo_get_current_session", "unknown-tool"] {
            let error = tools
                .invoke_until_cancelled(name, json!({}), &cancellation)
                .await
                .unwrap_err();
            assert_eq!(
                cli::error_value(&error),
                json!({
                    "schemaVersion":1,
                    "ok":false,
                    "error":{
                        "code":"canceled",
                        "message":"Tool call canceled; inspect the original mutation or receipt before another request",
                        "retryable":false,
                    },
                })
            );
            assert_eq!(tools.slots.available_permits(), 0);
        }
    }

    fn retry_job_spec() -> Value {
        json!({"title":"Retry","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}})
    }
    #[test]
    fn declared_claude_display_capture_is_strict_and_advertised_on_existing_tools() {
        let capture = json!({"displayProfile":"/owner/display.json"});
        let (request,kind)=command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"claude","claudeQuotaCapture":capture}})).unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(request["spec"]["claudeQuotaCapture"], capture);
        assert!(command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"codex","claudeQuotaCapture":capture}})).is_err());
        assert!(command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"claude","claudeQuotaCapture":{"displayProfile":"/owner/display.json","shell":"extra"}}})).is_err());
        assert_eq!(
            launch_schema()["properties"]["claudeQuotaCapture"],
            capture_schema()
        );
        assert_eq!(
            task_profile_schema(false)["properties"]["claudeQuotaCapture"],
            capture_schema()
        );
        assert_eq!(capture_schema()["additionalProperties"], false);
    }
    #[test]
    fn job_execution_timeout_create_and_edit_share_cli_mcp_shape_and_optional_schema() {
        use clap::Parser;
        let path = std::env::temp_dir().join(format!(
            "nesvo-job-execution-timeout-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for selected in [
            None,
            Some(Value::Null),
            Some(json!(1_000)),
            Some(json!(604_800_000)),
        ] {
            let mut spec = retry_job_spec();
            spec["maxElapsedMs"] = json!(12_345);
            if let Some(value) = selected {
                spec["executionTimeoutMs"] = value;
            }
            std::fs::write(&path, serde_json::to_vec(&spec).unwrap()).unwrap();
            for (mut args, name, arguments) in [
                (
                    vec!["nesvo", "job", "create", "--key", "timeout"],
                    "nesvo_create_job",
                    json!({"key":"timeout","spec":spec}),
                ),
                (
                    vec![
                        "nesvo",
                        "job",
                        "edit",
                        "j",
                        "--key",
                        "timeout",
                        "--revision",
                        "1",
                    ],
                    "nesvo_update_job",
                    json!({"key":"timeout","jobId":"j","expectedRevision":1,"spec":spec}),
                ),
            ] {
                args.extend(["--file", path.to_str().unwrap(), "--json"]);
                let parsed = crate::Arguments::try_parse_from(args).unwrap();
                let Some(cli::Command::Job { command: cli }) = parsed.command else {
                    panic!("Expected job command");
                };
                let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()}))
                    .unwrap();
                let (mcp, kind) = command(name, arguments).unwrap();
                assert_eq!(kind, "workflow");
                assert_eq!(
                    cli, mcp,
                    "Both callers must reach the shared capability gate with identical intent"
                );
                assert_eq!(mcp["request"]["request"]["spec"]["maxElapsedMs"], 12_345);
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("executionTimeoutMs"),
                    spec.get("executionTimeoutMs")
                        .filter(|value| !value.is_null())
                );
            }
        }
        std::fs::remove_file(path).unwrap();
        for name in ["nesvo_create_job", "nesvo_update_job"] {
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            let spec = &schema["inputSchema"]["properties"]["spec"];
            let timeout = &spec["properties"]["executionTimeoutMs"];
            assert_eq!(timeout["type"], "integer");
            assert_eq!(timeout["minimum"], 1_000);
            assert_eq!(timeout["maximum"], 604_800_000);
            assert!(timeout.get("default").is_none());
            assert!(
                !spec["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|field| field == "executionTimeoutMs")
            );
            assert_eq!(spec["properties"]["maxElapsedMs"]["default"], 300_000);
            for value in [
                json!(999),
                json!(604_800_001_u64),
                json!(-1),
                json!(1_000.5),
                json!("1000"),
                json!(true),
            ] {
                let mut invalid = retry_job_spec();
                invalid["executionTimeoutMs"] = value;
                let mut arguments = json!({"key":"timeout","spec":invalid});
                if name == "nesvo_update_job" {
                    arguments["jobId"] = json!("j");
                    arguments["expectedRevision"] = json!(1);
                }
                assert!(command(name, arguments).is_err());
            }
        }
    }
    #[test]
    fn job_retry_create_and_edit_share_cli_mcp_shape_and_preserve_legacy_specs() {
        use clap::Parser;
        let path = std::env::temp_dir().join(format!(
            "nesvo-job-retry-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let retry =
            json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
        for (policy, precheck) in [
            (None, false),
            (None, true),
            (Some(retry.clone()), false),
            (Some(retry.clone()), true),
        ] {
            let mut spec = retry_job_spec();
            if let Some(policy) = policy {
                spec["retry"] = policy;
            }
            if precheck {
                spec["precheckId"] = json!("01234567890123456789012345678901");
            }
            std::fs::write(&path, serde_json::to_vec(&spec).unwrap()).unwrap();
            for (mut args, name, mut arguments) in [
                (
                    vec!["nesvo", "job", "create", "--key", "retry"],
                    "nesvo_create_job",
                    json!({"key":"retry","spec":spec}),
                ),
                (
                    vec![
                        "nesvo",
                        "job",
                        "edit",
                        "j",
                        "--key",
                        "retry",
                        "--revision",
                        "1",
                    ],
                    "nesvo_update_job",
                    json!({"key":"retry","jobId":"j","expectedRevision":1,"spec":spec}),
                ),
            ] {
                args.extend(["--file", path.to_str().unwrap(), "--json"]);
                let parsed = crate::Arguments::try_parse_from(args).unwrap();
                let Some(cli::Command::Job { command: cli }) = parsed.command else {
                    panic!("Expected job command");
                };
                let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()}))
                    .unwrap();
                let (mcp, kind) = command(name, arguments.clone()).unwrap();
                assert_eq!(kind, "workflow");
                assert_eq!(cli, mcp);
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("retry"),
                    spec.get("retry")
                );
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("precheckId"),
                    spec.get("precheckId")
                );
                if spec.get("retry").is_none() {
                    arguments["spec"]["retry"] = Value::Null;
                    assert_eq!(command(name, arguments).unwrap().0, mcp);
                }
            }
        }
        std::fs::remove_file(path).unwrap();
        for name in ["nesvo_create_job", "nesvo_update_job"] {
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            let spec = &schema["inputSchema"]["properties"]["spec"];
            assert!(spec.get("not").is_none());
            assert_eq!(
                spec["properties"]["retry"]["required"],
                json!(["on", "maxAttempts", "initialDelayMs", "maxDelayMs"])
            );
            assert_eq!(spec["properties"]["retry"]["additionalProperties"], false);
            assert_eq!(
                spec["properties"]["retry"]["properties"]["on"]["enum"],
                json!(["launchNoEffect"])
            );
        }
    }
    #[test]
    fn job_retry_policy_refuses_unknown_incomplete_or_out_of_bounds_intent() {
        let valid =
            json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
        let mut invalid = vec![json!({}), json!("launchNoEffect"), json!([])];
        for field in ["on", "maxAttempts", "initialDelayMs", "maxDelayMs"] {
            let mut policy = valid.clone();
            policy.as_object_mut().unwrap().remove(field);
            invalid.push(policy);
        }
        for (field, value) in [
            ("on", json!("failed")),
            ("on", json!(["launchNoEffect"])),
            ("maxAttempts", json!(0)),
            ("maxAttempts", json!(9)),
            ("maxAttempts", json!(1.5)),
            ("maxAttempts", json!("3")),
            ("initialDelayMs", json!(999)),
            ("initialDelayMs", json!(3_600_001)),
            ("maxDelayMs", json!(999)),
            ("maxDelayMs", json!(86_400_001)),
            ("unknown", json!(true)),
        ] {
            let mut policy = valid.clone();
            policy[field] = value;
            invalid.push(policy);
        }
        for policy in invalid {
            let mut spec = retry_job_spec();
            spec["retry"] = policy;
            for precheck in [false, true] {
                if precheck {
                    spec["precheckId"] = json!("01234567890123456789012345678901");
                }
                assert!(command("nesvo_create_job", json!({"key":"retry","spec":spec})).is_err());
                assert!(
                    command(
                        "nesvo_update_job",
                        json!({"key":"retry","jobId":"j","expectedRevision":1,"spec":spec})
                    )
                    .is_err()
                );
            }
        }
        for policy in [
            json!({"on":"launchNoEffect","maxAttempts":1,"initialDelayMs":1000,"maxDelayMs":1000}),
            json!({"on":"launchNoEffect","maxAttempts":8,"initialDelayMs":3600000,"maxDelayMs":86400000}),
        ] {
            let mut spec = retry_job_spec();
            spec["retry"] = policy;
            assert!(command("nesvo_create_job", json!({"key":"retry","spec":spec})).is_ok());
        }
    }
    #[test]
    fn job_attempt_reads_share_cli_mcp_shape_without_mutation_authority() {
        use clap::Parser;
        for (args, name, arguments, expected) in [
            (
                vec!["nesvo", "job", "attempts", "j", "o", "--json"],
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o"}),
                json!({"action":"attempts","jobId":"j","occurrenceId":"o","offset":0}),
            ),
            (
                vec![
                    "nesvo", "job", "attempts", "j", "o", "--offset", "8", "--json",
                ],
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o","offset":8}),
                json!({"action":"attempts","jobId":"j","occurrenceId":"o","offset":8}),
            ),
            (
                vec!["nesvo", "job", "attempt", "j", "o", "generation", "--json"],
                "nesvo_get_job_attempt",
                json!({"jobId":"j","occurrenceId":"o","jobAttemptId":"generation"}),
                json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"generation"}),
            ),
        ] {
            let parsed = crate::Arguments::try_parse_from(args).unwrap();
            let Some(cli::Command::Job { command: cli }) = parsed.command else {
                panic!("Expected job command");
            };
            assert!(cli.machine());
            let cli =
                crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
            let (mcp, kind) = command(name, arguments.clone()).unwrap();
            assert_eq!(kind, "workflow");
            assert_eq!(cli, mcp);
            assert_eq!(mcp["request"]["request"], expected);
            for field in ["key", "owner", "retry", "action", "sessionId"] {
                let mut forged = arguments.clone();
                forged[field] = json!("forged");
                assert!(command(name, forged).is_err());
            }
            for field in ["jobId", "occurrenceId"] {
                let mut missing = arguments.clone();
                missing.as_object_mut().unwrap().remove(field);
                assert!(command(name, missing).is_err());
            }
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(schema["inputSchema"]["additionalProperties"], false);
            assert_eq!(
                schema["inputSchema"]["properties"]
                    .as_object()
                    .unwrap()
                    .len(),
                3
            );
            assert_eq!(schema["annotations"]["readOnlyHint"], true);
            assert_eq!(schema["annotations"]["destructiveHint"], false);
            if name == "nesvo_get_job_attempts" {
                assert_eq!(
                    schema["inputSchema"]["required"],
                    json!(["jobId", "occurrenceId"])
                );
                assert_eq!(
                    schema["inputSchema"]["properties"]["offset"]["maximum"],
                    4096
                );
            } else {
                assert_eq!(
                    schema["inputSchema"]["required"],
                    json!(["jobId", "occurrenceId", "jobAttemptId"])
                );
                assert!(command(name, json!({"jobId":"j","occurrenceId":"o"})).is_err());
            }
        }
        assert!(
            command(
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o","offset":65536})
            )
            .is_err()
        );
        assert!(
            crate::Arguments::try_parse_from([
                "nesvo", "job", "attempts", "j", "o", "--offset", "4097"
            ])
            .is_err()
        );
    }
    #[test]
    fn precheck_abandon_cli_and_mcp_preserve_legacy_and_exact_generation_intent() {
        use clap::Parser;
        let legacy = json!({"key":"abandon-once","jobId":"j","occurrenceId":"o","expectedDigest":"d".repeat(64),"acknowledgeUnknownEffects":true});
        for generation in [None, Some("generation-2")] {
            let digest = "d".repeat(64);
            let mut args = vec![
                "nesvo",
                "job",
                "abandon-precheck",
                "j",
                "o",
                "--key",
                "abandon-once",
                "--digest",
                &digest,
                "--acknowledge-unknown-effects",
                "--json",
            ];
            let mut arguments = legacy.clone();
            if let Some(id) = generation {
                args.extend(["--job-attempt-id", id]);
                arguments["jobAttemptId"] = json!(id);
            }
            let parsed = crate::Arguments::try_parse_from(args).unwrap();
            let Some(cli::Command::Job { command: cli }) = parsed.command else {
                panic!("Expected job command");
            };
            assert!(cli.machine());
            let cli =
                crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
            let (mcp, kind) = command("nesvo_abandon_job_precheck", arguments.clone()).unwrap();
            assert_eq!(kind, "workflow");
            assert_eq!(cli, mcp);
            let mut expected = arguments;
            expected["action"] = json!("abandonPrecheck");
            assert_eq!(mcp["request"]["request"], expected);
            if generation.is_none() {
                assert!(mcp["request"]["request"].get("jobAttemptId").is_none());
                assert_eq!(
                    serde_json::to_string(&mcp["request"]["request"]).unwrap(),
                    concat!(
                        "{\"acknowledgeUnknownEffects\":true,\"action\":\"abandonPrecheck\",",
                        "\"expectedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",",
                        "\"jobId\":\"j\",\"key\":\"abandon-once\",\"occurrenceId\":\"o\"}"
                    )
                );
            }
        }
        for value in [json!(true), json!(2), json!([]), json!({})] {
            let mut fields = legacy.clone();
            fields["jobAttemptId"] = value;
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        for required in [
            "key",
            "jobId",
            "occurrenceId",
            "expectedDigest",
            "acknowledgeUnknownEffects",
        ] {
            let mut fields = legacy.clone();
            fields.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        for (field, value) in [
            ("action", json!("runNow")),
            ("owner", json!(true)),
            ("expectedDigest", json!(7)),
            ("acknowledgeUnknownEffects", json!("true")),
        ] {
            let mut fields = legacy.clone();
            fields[field] = value;
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        let schema = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_abandon_job_precheck")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["properties"]["jobAttemptId"]["type"],
            "string"
        );
        assert_eq!(
            schema["inputSchema"]["required"],
            json!([
                "key",
                "jobId",
                "occurrenceId",
                "expectedDigest",
                "acknowledgeUnknownEffects"
            ])
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
        assert_eq!(catalog().len(), 113);
    }
    #[test]
    fn launch_abandon_cli_and_mcp_require_the_same_explicit_generation_and_acknowledgement() {
        use clap::Parser;
        let digest = "a".repeat(64);
        let args = [
            "nesvo",
            "job",
            "abandon-launch",
            "j",
            "o",
            "--job-attempt-id",
            "generation",
            "--key",
            "abandon-launch-once",
            "--digest",
            &digest,
            "--acknowledge-unknown-effects",
            "--json",
        ];
        let parsed = crate::Arguments::try_parse_from(args).unwrap();
        let Some(cli::Command::Job { command: cli }) = parsed.command else {
            panic!("Expected exact launch abandonment");
        };
        assert!(cli.machine());
        let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
        let arguments = json!({"key":"abandon-launch-once","jobId":"j","occurrenceId":"o","jobAttemptId":"generation","expectedDigest":digest,"acknowledgeUnknownEffects":true});
        let (mcp, kind) = command("nesvo_abandon_job_launch", arguments.clone()).unwrap();
        assert_eq!(kind, "workflow");
        assert_eq!(cli, mcp);
        let mut expected = arguments.clone();
        expected["action"] = json!("abandonLaunchNoEffect");
        assert_eq!(mcp["request"]["request"], expected);

        for flag in ["--job-attempt-id", "--acknowledge-unknown-effects"] {
            let mut omitted = args.to_vec();
            let position = omitted
                .iter()
                .position(|argument| *argument == flag)
                .unwrap();
            omitted.remove(position);
            if flag == "--job-attempt-id" {
                omitted.remove(position);
            }
            assert!(crate::Arguments::try_parse_from(omitted).is_err());
        }
        for required in [
            "key",
            "jobId",
            "occurrenceId",
            "jobAttemptId",
            "expectedDigest",
            "acknowledgeUnknownEffects",
        ] {
            let mut fields = arguments.clone();
            fields.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_abandon_job_launch", fields).is_err());
        }
        for (field, value) in [
            ("jobAttemptId", Value::Null),
            ("jobAttemptId", json!(1)),
            ("expectedDigest", json!("a".repeat(63))),
            ("expectedDigest", json!("g".repeat(64))),
            ("expectedDigest", json!("A".repeat(64))),
            ("expectedDigest", Value::Null),
            ("acknowledgeUnknownEffects", json!(false)),
            ("acknowledgeUnknownEffects", json!("true")),
            ("acknowledgeUnknownEffects", json!(1)),
            ("action", json!("abandonPrecheck")),
            ("owner", json!(true)),
            ("proof", json!({"effectStarted":false})),
        ] {
            let mut fields = arguments.clone();
            fields[field] = value;
            assert!(command("nesvo_abandon_job_launch", fields).is_err());
        }
        let schema = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_abandon_job_launch")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["required"],
            json!([
                "key",
                "jobId",
                "occurrenceId",
                "jobAttemptId",
                "expectedDigest",
                "acknowledgeUnknownEffects"
            ])
        );
        assert_eq!(
            schema["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            schema["inputSchema"]["properties"]["acknowledgeUnknownEffects"]["const"],
            true
        );
        assert_eq!(
            schema["inputSchema"]["properties"]["expectedDigest"]["pattern"],
            "^[0-9a-f]{64}$"
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
    }

    #[test]
    fn launch_reconciliation_output_schema_is_additive_exact_and_keeps_proof_private() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let definitions = &schema["definitions"];
        for (name, extra) in [
            ("jobLaunchReconciliation", ["available", "reason", "digest"]),
            (
                "jobLaunchResolution",
                ["digest", "mutationKey", "acknowledgedAt"],
            ),
        ] {
            let object = &definitions[name];
            assert_eq!(object["type"], "object");
            assert_eq!(object["additionalProperties"], false);
            assert_eq!(object["properties"].as_object().unwrap().len(), 11);
            let required = object["required"].as_array().unwrap();
            assert_eq!(required.len(), 11);
            assert_eq!(object["properties"]["kind"]["const"], "launchNoEffect");
            for field in [
                "kind",
                "jobId",
                "occurrenceId",
                "jobAttemptId",
                "runId",
                "attemptId",
                "sessionId",
                "launchReceiptId",
            ]
            .into_iter()
            .chain(extra)
            {
                assert!(required.contains(&json!(field)));
                assert!(object["properties"].get(field).is_some());
            }
            for private in ["token", "proof", "deadlineMonotonicMs", "claimToken"] {
                assert!(object["properties"].get(private).is_none());
            }
            assert_eq!(object["properties"]["digest"]["minLength"], 64);
            assert_eq!(object["properties"]["digest"]["maxLength"], 64);
            assert_eq!(object["properties"]["digest"]["pattern"], "^[0-9a-f]{64}$");
        }
        assert_eq!(
            definitions["jobLaunchReconciliation"]["properties"]["available"]["type"],
            "boolean"
        );
        assert_eq!(
            definitions["jobLaunchReconciliation"]["properties"]["digest"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(
            definitions["jobLaunchResolution"]["properties"]["digest"]["type"],
            "string"
        );
        for (field, definition) in [
            ("launchReconciliation", "jobLaunchReconciliation"),
            ("launchResolution", "jobLaunchResolution"),
        ] {
            let occurrence = &definitions["jobOccurrence"];
            assert!(
                !occurrence["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            );
            assert_eq!(occurrence["properties"][field]["anyOf"][0]["type"], "null");
            assert_eq!(
                occurrence["properties"][field]["anyOf"][1]["$ref"],
                format!("#/definitions/{definition}")
            );
            let summary = &definitions["jobAttemptSummary"];
            assert!(
                !summary["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            );
            assert_eq!(
                summary["properties"][field]["$ref"],
                format!("#/definitions/jobOccurrence/properties/{field}")
            );
        }
        assert_eq!(
            definitions["jobAttemptDetail"]["allOf"][0]["$ref"],
            "#/definitions/jobAttemptSummary"
        );
    }

    #[test]
    fn occurrence_cancel_cli_and_mcp_share_exact_owner_intent() {
        use clap::Parser;
        let parsed = crate::Arguments::try_parse_from([
            "nesvo",
            "job",
            "cancel",
            "job-stable-id",
            "occurrence-stable-id",
            "--key",
            "cancel-once",
            "--json",
        ])
        .unwrap();
        let Some(cli::Command::Job { command: cli }) = parsed.command else {
            panic!("Expected job command");
        };
        assert!(cli.machine());
        let cli =
            crate::workflow::tool("jobs", json!({"request": cli.request().unwrap()})).unwrap();
        let arguments = json!({
            "key": "cancel-once",
            "jobId": "job-stable-id",
            "occurrenceId": "occurrence-stable-id"
        });
        let (mcp, result_kind) = command("nesvo_cancel_job_occurrence", arguments.clone()).unwrap();
        assert_eq!(result_kind, "workflow");
        assert_eq!(cli, mcp);
        assert_eq!(
            mcp["request"]["request"],
            json!({"action":"cancelOccurrence","key":"cancel-once","jobId":"job-stable-id","occurrenceId":"occurrence-stable-id"})
        );

        for required in ["key", "jobId", "occurrenceId"] {
            let mut missing = arguments.clone();
            missing.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_cancel_job_occurrence", missing).is_err());
        }
        for (field, value) in [
            ("action", json!("runNow")),
            ("owner", json!(true)),
            ("sessionId", json!("focused-session")),
            ("expectedRevision", json!(1)),
            ("key", json!(7)),
        ] {
            let mut changed = arguments.clone();
            changed[field] = value;
            assert!(command("nesvo_cancel_job_occurrence", changed).is_err());
        }

        let tool = catalog()
            .into_iter()
            .find(|tool| tool.name == "nesvo_cancel_job_occurrence")
            .unwrap();
        let schema = serde_json::to_value(tool).unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["required"],
            json!(["key", "jobId", "occurrenceId"])
        );
        assert_eq!(
            schema["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["destructiveHint"], true);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
    }
    #[test]
    fn catalog_and_boundary_reject_ambiguous_or_unbounded_requests() {
        let published: Vec<String> =
            serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json")).unwrap();
        let mut names = catalog()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert!(
            names.windows(2).all(|pair| pair[0] < pair[1]),
            "Published MCP names must be unique"
        );
        assert_eq!(
            names, published,
            "Host permission validation and actual MCP tools must share one exact catalog contract"
        );
        for extra in [
            json!({"sessionId":"foreign"}),
            json!({"owner":true}),
            json!({"key":"rearm"}),
            json!({"checkpointId":"old"}),
        ] {
            assert!(command("nesvo_recover_run_context", extra).is_err());
        }
        assert!(command("nesvo_set_host_budget",json!({"key":"k","expectedRevision":1,"limits":{"maxSessions":2,"maxWorkers":1,"providers":{"shell":1,"claude":1,"codex":1,"gemini":1},"role":"owner"}})).is_err());
        assert!(command("nesvo_answer_decision",json!({"runId":"r","decisionId":"d","key":"k","expectedRevision":1,"answer":"x","audience":"owner"})).is_err());
        assert!(
            command(
                "nesvo_send_message",
                json!({"runId":"r","key":"k","correlationId":"c","body":"x","sender":"owner"})
            )
            .is_err()
        );
        assert!(command("nesvo_ack_messages", json!({"runId":"r","ids":"all"})).is_err());
        assert!(
            command(
                "nesvo_read_session",
                json!({"sessionId":"s","maxBytes":8193})
            )
            .is_err()
        );
        assert!(
            command(
                "nesvo_create_session",
                json!({"key":"k","spec":{"name":"n","prompt":[]}})
            )
            .is_err()
        );
        assert!(command("nesvo_list_sessions", json!({"owner":true})).is_err());
        assert!(command("nesvo_get_session", json!({"sessionId":"s","owner":true})).is_err());
        assert!(command("nesvo_get_operation", json!({"id":"a","key":"b"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","key":"b"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","until":"idle"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","timeoutMs":60001})).is_err());
        assert!(
            command(
                "nesvo_send_prompt",
                json!({"sessionId":"a","key":"k","prompt":"\u{1b}[201~"})
            )
            .is_err()
        );
        assert!(
            command(
                "nesvo_create_session",
                json!({"key":"k","spec":{"name":"n","shellCommand":"no"}})
            )
            .is_err()
        );
        let (open, kind) = command(
            "nesvo_open_review",
            json!({"pullUrl":"https://github.com/a/b/pull/1","base":"main"}),
        )
        .unwrap();
        assert_eq!(kind, "reviewOpened");
        assert_eq!(
            open,
            cli::open_review_query(
                None,
                None,
                Some("https://github.com/a/b/pull/1"),
                Some("main")
            )
            .unwrap()
        );
        let (deliver, kind) = command(
            "nesvo_deliver_review",
            json!({"reviewId":"r","sessionId":"s","text":"see a.rs:3"}),
        )
        .unwrap();
        assert_eq!(kind, "reviewDelivered");
        assert_eq!(
            deliver,
            cli::deliver_review_query("r", "s", "see a.rs:3", None).unwrap()
        );
        for (name, arguments) in [
            ("nesvo_open_review", json!({})),
            (
                "nesvo_open_review",
                json!({"sessionId":"s","pullUrl":"https://github.com/a/b/pull/1"}),
            ),
            ("nesvo_open_review", json!({"sessionId":"s","owner":true})),
            (
                "nesvo_deliver_review",
                json!({"reviewId":"r","sessionId":"s","text":"\u{1b}[201~"}),
            ),
            (
                "nesvo_deliver_review",
                json!({"reviewId":"r","sessionId":"s","text":"x","leaseId":"stolen"}),
            ),
            ("nesvo_deliver_review", json!({"reviewId":"r","text":"x"})),
        ] {
            assert!(command(name, arguments).is_err(), "{name}");
        }
        let (literal, kind) = command(
            "nesvo_create_session",
            json!({"key":"k","spec":{"name":"n","prompt":"$(literal) `literal` łódź"}}),
        )
        .unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(literal["spec"]["prompt"], "$(literal) `literal` łódź");
    }
}
