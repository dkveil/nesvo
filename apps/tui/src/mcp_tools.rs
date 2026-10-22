use crate::{cli, mcp};
use anyhow::Result;
use rmcp::model::{Tool, ToolAnnotations};
use schemars::{
    JsonSchema, Schema, generate::SchemaSettings, json_schema, transform::RecursiveTransform,
};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use std::sync::{Arc, LazyLock};

pub type Request = (Value, &'static str);
type Translate = dyn Fn(&'static str, Value) -> Result<Request> + Send + Sync;

#[derive(Clone, Copy)]
struct Hints {
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
}

const READ: Hints = Hints {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: false,
};
const READ_OPEN_WORLD: Hints = Hints {
    open_world: true,
    ..READ
};
const WRITE: Hints = Hints {
    read_only: false,
    destructive: false,
    idempotent: true,
    open_world: true,
};
const DESTRUCTIVE: Hints = Hints {
    destructive: true,
    ..WRITE
};
const WRITE_ONCE: Hints = Hints {
    idempotent: false,
    ..WRITE
};

#[derive(Clone, Copy)]
pub enum Scope {
    Constraints,
    Checkpoints,
    Wakes,
    Executor,
    Delivery,
    RunBudget,
    HostBudget,
    Decision,
    Prechecks,
    Jobs,
    Inbox,
}

pub enum Handler {
    Typed(Box<Translate>),
    Raw(fn(&'static str, Value) -> Result<Request>),
    Workflow(&'static str),
    WorkflowRequest(&'static str),
    Scoped(Scope, &'static str),
    RunControl(Option<&'static str>),
    Adapter(fn(&str, &Value) -> Option<Result<Request>>),
}

pub struct ToolSpec {
    pub name: &'static str,
    description: &'static str,
    hints: Hints,
    input: fn() -> Map<String, Value>,
    pub handler: Handler,
}

impl ToolSpec {
    fn tool(&self) -> Tool {
        let Hints {
            read_only,
            destructive,
            idempotent,
            open_world,
        } = self.hints;
        Tool::new(self.name, self.description, (self.input)())
            .with_annotations(
                ToolAnnotations::new()
                    .read_only(read_only)
                    .destructive(destructive)
                    .idempotent(idempotent)
                    .open_world(open_world),
            )
            .with_raw_output_schema(Arc::new(output_schema()))
    }
}

fn tool<T: JsonSchema>(
    name: &'static str,
    description: &'static str,
    hints: Hints,
    handler: Handler,
) -> ToolSpec {
    ToolSpec {
        name,
        description,
        hints,
        input: input_schema::<T>,
        handler,
    }
}

fn typed<T: JsonSchema + DeserializeOwned + 'static>(
    name: &'static str,
    description: &'static str,
    hints: Hints,
    translate: fn(&'static str, T) -> Result<Request>,
) -> ToolSpec {
    tool::<T>(
        name,
        description,
        hints,
        Handler::Typed(Box::new(move |name, arguments| {
            translate(name, parse(arguments)?)
        })),
    )
}

pub fn parse<T: DeserializeOwned>(arguments: Value) -> Result<T> {
    serde_json::from_value(arguments)
        .map_err(|_| cli::failure("invalid_argument", "Arguments must match the tool schema"))
}

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

pub fn published_names() -> Vec<&'static str> {
    let mut names: Vec<_> = TOOLS.iter().map(|tool| tool.name).collect();
    names.sort_unstable();
    names
}

pub fn catalog() -> Vec<Tool> {
    static CATALOG: LazyLock<Vec<Tool>> =
        LazyLock::new(|| TOOLS.iter().map(ToolSpec::tool).collect());
    CATALOG.clone()
}

#[cfg(test)]
pub const TOOL_COUNT: usize = 114;

#[cfg(test)]
pub fn catalog_named(names: &[&str]) -> Vec<Tool> {
    catalog()
        .into_iter()
        .filter(|tool| names.contains(&tool.name.as_ref()))
        .collect()
}

fn output_schema() -> Map<String, Value> {
    let Value::Object(schema) = json!({"type":"object","required":["schemaVersion","ok"],"properties":{"schemaVersion":{"const":1},"ok":{"type":"boolean"},"data":{"type":"object"},"error":{"type":"object"}}})
    else {
        unreachable!()
    };
    schema
}

const NULLABLE_MARKER: &str = "x-nesvo-nullable";

fn input_schema<T: JsonSchema>() -> Map<String, Value> {
    let schema = SchemaSettings::draft2020_12()
        .with(|settings| {
            settings.inline_subschemas = true;
            settings.meta_schema = None;
            settings.transforms = vec![Box::new(RecursiveTransform(contract_shape))];
        })
        .into_generator()
        .into_root_schema_for::<T>();
    let Value::Object(mut schema) = schema.to_value() else {
        panic!("Tool input schemas are objects");
    };
    schema.remove("title");
    schema.entry("properties").or_insert_with(|| json!({}));
    schema.entry("required").or_insert_with(|| json!([]));
    schema
}

fn contract_shape(schema: &mut Schema) {
    schema.remove("format");
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    let required = object.get("required").cloned().unwrap_or_else(|| json!([]));
    let Some(Value::Object(properties)) = object.get_mut("properties") else {
        return;
    };
    for (name, property) in properties.iter_mut() {
        let Value::Object(property) = property else {
            continue;
        };
        let nullable = property.remove(NULLABLE_MARKER).is_some();
        let optional = !required
            .as_array()
            .is_some_and(|required| required.iter().any(|field| field == name));
        if optional && !nullable {
            omit_null(property);
        }
    }
}

fn omit_null(property: &mut Map<String, Value>) {
    if let Some(Value::Array(types)) = property.get_mut("type") {
        types.retain(|kind| kind != "null");
        if let [kind] = types.as_slice() {
            let kind = kind.clone();
            property.insert("type".into(), kind);
        }
    }
    if let Some(Value::Array(values)) = property.get_mut("enum") {
        values.retain(|value| !value.is_null());
    }
}

fn keep_null(schema: &mut Schema) {
    schema.insert(NULLABLE_MARKER.into(), true.into());
}

fn nullable(schema: &mut Schema) {
    if let Some(Value::String(kind)) = schema.get("type").cloned() {
        schema.insert("type".into(), json!([kind, "null"]));
    }
}

fn null_or(schema: &mut Schema) {
    *schema = json_schema!({"anyOf": [{"type": "null"}, schema.clone()]});
}

fn describe_tag(schema: &mut Schema) {
    let Some(description) = schema.remove("description") else {
        return;
    };
    if let Some(Value::Object(tag)) = schema
        .get_mut("properties")
        .and_then(|properties| properties.get_mut("kind"))
    {
        tag.insert("description".into(), description);
    }
}

pub static TOOLS: LazyLock<Vec<ToolSpec>> = LazyLock::new(|| {
    vec![
        tool::<args::ProviderQuota>(
            "nesvo_get_provider_quota",
            "Owner-only provider quota observations with source, freshness and completeness evidence. Optional refresh requires an installed explicit program and asynchronously queues or coalesces one bounded original-provider read; queued/pending/cooldown does not mean refreshed. Inspect a later revision. Does not request models, login, switch accounts or release queued jobs. Reader account evidence does not bind a native process account.",
            READ_OPEN_WORLD,
            Handler::Raw(mcp::provider_quota),
        ),
        typed::<args::SetQuotaWake>(
            "nesvo_set_quota_wake",
            "Owner-only explicit enable/disable of one durable native Codex quota wake; requires durableQuotaWake:true. Enable requires a live bound lifecycle, the exact captured configured reader, a fresh complete five-hour window at >=90% with a future reset, and no human lease or draft. One ordinary native send receipt may resume the same process only after a fresh matching-account read started after reset affirmatively permits usage. Unknown effects, human takeover and known identity changes never retry input. Disable does not undo an already accepted send. No Claude/Gemini support, account lock, purchase or limit bypass.",
            WRITE,
            mcp::set_quota_wake,
        ),
        typed::<args::SessionArgs>(
            "nesvo_get_quota_wake",
            "Owner-only read of the retained quota wake and its linked native send receipt identity for one stable session. Requires durableQuotaWake:true. Returns null when no arm is retained. Does not arm, refresh provider evidence, send input, resume a process or replay effects; a wake phase is not task success.",
            READ,
            mcp::get_quota_wake,
        ),
        tool::<contract::DescribePrecheck>(
            "nesvo_describe_precheck",
            "Owner-only normalization/digest of a proposed command. Does not approve or execute it. Review literal executable/cwd/argv/environment; file contents and called code remain mutable, not sandboxed.",
            READ,
            Handler::Scoped(Scope::Prechecks, "describe"),
        ),
        tool::<contract::ApprovePrecheck>(
            "nesvo_approve_precheck",
            "Explicit owner trust for this exact command/cwd/argv/environment/duration/exit policy. Arbitrary OS code, not sandboxed. Requires previously inspected normalized digest. Separate from loading a job/repository config. Never delegated to coordinators/workers; no execution now.",
            WRITE,
            Handler::Scoped(Scope::Prechecks, "approve"),
        ),
        tool::<contract::IdArgs>(
            "nesvo_get_precheck",
            "Owner-only immutable command approval, including revoked intent. No execution.",
            READ,
            Handler::Scoped(Scope::Prechecks, "get"),
        ),
        tool::<contract::Page4096>(
            "nesvo_list_prechecks",
            "Owner-only bounded approval summaries without command arguments or execution.",
            READ,
            Handler::Scoped(Scope::Prechecks, "list"),
        ),
        tool::<contract::RevokePrecheck>(
            "nesvo_revoke_precheck",
            "Owner-only exact-revision refusal of future executions. Already authorized checks may finish; does not undo effects or terminate a process.",
            WRITE,
            Handler::Scoped(Scope::Prechecks, "revoke"),
        ),
        tool::<contract::KeyArgs>(
            "nesvo_get_precheck_mutation",
            "Recover immutable original precheck approval/revocation acceptance. Does not execute/reapprove or reflect current enabled state.",
            READ,
            Handler::Scoped(Scope::Prechecks, "mutation"),
        ),
        tool::<contract::AbandonJobPrecheck>(
            "nesvo_abandon_job_precheck",
            "Owner-only explicit acknowledgement of an uncertain precheck's effects, abandoning its exact current generation before its Run was bound. Requires inspection/digest and acknowledgement. jobAttemptId requires jobPrecheckGenerations:true and is mandatory after generation 1; omission preserves legacy generation-1 requests. Does not kill detached commands, undo effects, repeat a check, resume work or create a model.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "abandonPrecheck"),
        ),
        tool::<contract::AbandonJobLaunch>(
            "nesvo_abandon_job_launch",
            "Owner-only logical abandonment of exact no-effect launch cleanup. Inspect the current generation's launchReconciliation descriptor, require available:true and its digest, and explicitly acknowledge unknown effects. jobAttemptId is always required; needs jobLaunchReconciliation:true. Only the exact native create receipt's JSON boolean effectStarted:false and finished producers qualify. Releases overlap for a separate occurrence without claiming process exit, completing a native stop, retrying, repeating prechecks or granting model/native permissions. Existing precheck effects and original native receipts remain retained. Recover the original job mutation key.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "abandonLaunchNoEffect"),
        ),
        tool::<contract::CreateJob>(
            "nesvo_create_job",
            "Owner-only durable once/cron/RRULE job definition. Host dispatches without open clients using fresh explicit task profiles; no immediate model call. Optional executionTimeoutMs requires jobExecutionTimeouts and starts at native launch admission, including preparation/readiness but excluding prechecks; an accepted explicit worker report before its deadline disarms it. Optional launchNoEffect retry policy needs jobRetries and the advertised retry kind; only confirmed pre-spawn refusals qualify. Combining with precheckId requires jobPrecheckGenerations and authorizes bounded repeated exact-command execution before each fresh generation. Separate occurrence/run/result history; not process-start success. Recover the same job mutation key.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "create"),
        ),
        tool::<contract::AuthorizeJobQuota>(
            "nesvo_authorize_job_quota",
            "Owner-only explicit reader-context/account reauthorization of one queued or retry-waiting quota occurrence. Compare the exact prior binding and select inspected new fingerprints. Requires jobQuotaAdmission:true. Original mutation replay returns its immutable acceptance; this does not retry native effects, change other occurrences, create a model or bypass provider limits.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "authorizeQuota"),
        ),
        tool::<contract::JobArgs>(
            "nesvo_get_job",
            "Owner-only read of a persisted definition and requested profile, without dispatch.",
            READ,
            Handler::Scoped(Scope::Jobs, "get"),
        ),
        tool::<contract::Page4096>(
            "nesvo_list_jobs",
            "Owner-only bounded job definition summaries. No prompts, dispatch or input ownership.",
            READ,
            Handler::Scoped(Scope::Jobs, "list"),
        ),
        tool::<contract::UpdateJob>(
            "nesvo_update_job",
            "Owner-only exact-revision replacement of future job intent, including optional launchNoEffect retry policy and executionTimeoutMs. Execution timeouts require jobExecutionTimeouts and start at native launch admission, including preparation/readiness but excluding prechecks; an accepted explicit worker report before its deadline disarms it. Existing occurrences keep their immutable spec; does not change running processes. Combining retry and precheckId requires jobPrecheckGenerations and authorizes bounded repeated exact-command execution with fresh approval checks before each generation.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "update"),
        ),
        tool::<contract::SetJobEnabled>(
            "nesvo_set_job_enabled",
            "Owner-only enable/disable of future automatic admissions. Already admitted work may finish; no terminal input or native resume. Exact revision/key required.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "setEnabled"),
        ),
        tool::<contract::JobRevision>(
            "nesvo_run_job_now",
            "Owner-only deliberate new occurrence, including a disabled definition. Distinct key is a distinct intent, subject to overlap skip/one-deep queue; not a retry of an uncertain effect.",
            WRITE,
            Handler::Scoped(Scope::Jobs, "runNow"),
        ),
        tool::<contract::CancelJobOccurrence>(
            "nesvo_cancel_job_occurrence",
            "Owner-only cancellation of one admitted job occurrence by stable job/occurrence IDs. Fences further model admissions and requests bounded precheck/native cleanup. Acceptance is intent, not proof of process exit; inspect the occurrence's current cancellation/receipts. Unknown effects require reconciliation. Original mutation replay never repeats native effects or creates a replacement run.",
            DESTRUCTIVE,
            Handler::Scoped(Scope::Jobs, "cancelOccurrence"),
        ),
        tool::<contract::JobHistory>(
            "nesvo_get_job_history",
            "Owner-only bounded occurrence history with state, reason and workflow run pointer. Started/idle is not succeeded; reported results need explicit validation.",
            READ,
            Handler::Scoped(Scope::Jobs, "history"),
        ),
        tool::<contract::JobOccurrence>(
            "nesvo_get_job_occurrence",
            "Owner-only immutable occurrence profile and run pointer, including nullable launchReconciliation and retained launchResolution evidence. An available launch descriptor/digest can be inspected before a separate explicit owner acknowledgement. Reads never release overlap, dispatch effects or adopt a process.",
            READ,
            Handler::Scoped(Scope::Jobs, "occurrence"),
        ),
        tool::<contract::JobAttempts>(
            "nesvo_get_job_attempts",
            "Owner-only read of eight retained dispatch generations for one exact job occurrence, including nullable launchReconciliation and launchResolution evidence. Ordinal 1 is the first dispatch; queued intent has no generation yet. Summaries omit precheck stdout/stderr. Does not create a retry, release overlap, repeat a command, launch/adopt a process or change native permissions.",
            READ,
            Handler::Scoped(Scope::Jobs, "attempts"),
        ),
        tool::<contract::JobAttempt>(
            "nesvo_get_job_attempt",
            "Owner-only detail of one retained job dispatch generation, including bounded precheck evidence and nullable launchReconciliation/launchResolution. jobAttemptId is distinct from a workflow task attempt/session ID. Reads never retry, release overlap, launch/adopt a process, repeat native effects or infer success from process silence.",
            READ,
            Handler::Scoped(Scope::Jobs, "attempt"),
        ),
        tool::<contract::KeyArgs>(
            "nesvo_get_job_mutation",
            "Owner-only recovery of an original job mutation acceptance. Does not reapply its effects or reflect later state.",
            READ,
            Handler::Scoped(Scope::Jobs, "mutation"),
        ),
        tool::<contract::RebindRunCoordinator>(
            "nesvo_rebind_run_coordinator",
            "Owner-only binding of retained run context to a different live native coordinator after the previous process is unavailable. Exact source ID (null for unbound), revision and mutation key required. Preserves inbox/results/constraints/budgets; pauses executor/wakes and queued input, fences earlier native input. No native worker authority, process/conversation adoption, ACK, validation, prompt or policy enable is restored. Target must match retained workspace/group. Recover the original workflow mutation key.",
            WRITE,
            Handler::WorkflowRequest("coordinator"),
        ),
        tool::<contract::AddRunConstraint>(
            "nesvo_add_run_constraint",
            "Owner-only append of literal manual constraints at the current run revision. Pauses executor/wakes and queued task input; earlier native input cannot rearm after acknowledgement. No user text is discarded or treated as task success/native permission. Existing model work may finish. Recover immutable acceptance with the original workflow mutation key.",
            WRITE,
            Handler::Scoped(Scope::Constraints, "add"),
        ),
        tool::<contract::ListRunConstraints>(
            "nesvo_list_run_constraints",
            "Read eight append-only owner constraints and current acknowledgement revision. after is a constraint revision, not an event/inbox cursor. Read does not acknowledge, clear drafts, enable scheduling or grant native authority. Workers receive own constraints in their current task context.",
            READ,
            Handler::Scoped(Scope::Constraints, "list"),
        ),
        tool::<contract::AcknowledgeRunConstraints>(
            "nesvo_acknowledge_run_constraints",
            "Deliberately attest reading the exact current constraint revision, using the current run revision. Only owner or this run's coordinator. No policy auto-enable, old delivery replay, native permission, inbox ACK or task validation. Earlier/pre-ACK native receipts remain fenced even after this acknowledgement.",
            WRITE,
            Handler::Scoped(Scope::Constraints, "acknowledge"),
        ),
        tool::<contract::SaveRunCheckpoint>(
            "nesvo_save_run_checkpoint",
            "Capture an immutable bounded run metadata manifest once at the exact source revision. Includes goal, owner constraints, plan, attempt/validation and decision/native-uncertainty pointers. A caller summary is an attestation, not verified progress. Does not send input, ACK, launch/adopt processes or replay effects. Recover with the original workflow mutation key.",
            WRITE,
            Handler::Scoped(Scope::Checkpoints, "save"),
        ),
        tool::<contract::ListRunCheckpoints>(
            "nesvo_list_run_checkpoints",
            "Read eight immutable checkpoint headers in a visible run. Source run revision and journal cursor describe capture, not current process authority. No native effects or implicit restoration.",
            READ,
            Handler::Scoped(Scope::Checkpoints, "list"),
        ),
        tool::<contract::GetRunCheckpoint>(
            "nesvo_get_run_checkpoint",
            "Read an immutable historical checkpoint page, at most eight parts / 24 KiB. Current constraint revision is reported separately; history never replaces it. Receipt pointers retain issuer scope. Persisted attempt state is not current process evidence and no native effect is restored.",
            READ,
            Handler::Scoped(Scope::Checkpoints, "get"),
        ),
        tool::<contract::ReadRunContext>(
            "nesvo_read_run_context",
            "Read current authoritative context for resume/compaction without input, process adoption, effect replay, inbox ACK or task validation. An optional checkpoint is a comparison baseline only; parts always reflect current constraints/state. Continue with returned nextOffset and the same expectedDigest; context_changed requires starting at zero, never mixing pages.",
            READ,
            Handler::Scoped(Scope::Checkpoints, "context"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_enable_run_wakes",
            "Opt in to coalesced notices for the run's live coordinator. Only new result/question/error/decision/blocker deltas produce native input; no unchanged-state model heartbeat. Pending messages remain durable, never auto-ACKed or validated. Human takeover pauses the policy. Restart disables it; explicit enable never replays old batches or grants native permission.",
            WRITE,
            Handler::Scoped(Scope::Wakes, "enable"),
        ),
        tool::<contract::GetRunWakes>(
            "nesvo_get_run_wakes",
            "Read wake policy and at most eight notice references. after is a wake-notice cursor, not an inbox cursor or ACK. No model/input effects. Inspect a batch by its actual ID for exact inbox message sequences and current native receipt phase.",
            READ,
            Handler::Scoped(Scope::Wakes, "get"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_disable_run_wakes",
            "Disable future coordinator wake input using the exact current run revision. Does not undo bytes, stop processes, ACK messages or validate results. Retain/inspect batch and receipt uncertainty.",
            WRITE,
            Handler::Scoped(Scope::Wakes, "disable"),
        ),
        tool::<contract::GetRunWakeBatch>(
            "nesvo_get_run_wake_batch",
            "Inspect one wake batch, up to eight immutable notice references, and native receipt pointer/current phase. Knowing an owner-issued ID grants no receipt authority. Input settlement is not ACK, task success, validation or native permission approval.",
            READ,
            Handler::Scoped(Scope::Wakes, "batch"),
        ),
        tool::<contract::StartRunExecutor>(
            "nesvo_start_run_executor",
            "Opt in to automatic dependency-ready task launch and immutable instruction delivery for an active run. Explicit profile for every task; agents only, shared/worktree required. No model heartbeat, self-validation or permission approval. Human/decision/time/retry/native guards still apply. Stable workflow key recovers acceptance; inspect current executor/task/native receipts. Restart disables scheduling without replay. Already admitted work may finish after disabling.",
            WRITE,
            Handler::Scoped(Scope::Executor, "start"),
        ),
        tool::<contract::RunArgs>(
            "nesvo_get_run_executor",
            "Inspect current executor policy/state. Never dispatches or acknowledges success.",
            READ,
            Handler::Scoped(Scope::Executor, "get"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_disable_run_executor",
            "Disable new executor scheduling admissions at the exact run revision. Already admitted startup/instruction may finish. Does not kill processes, undo bytes or clear uncertainty; native run stop/cancel is separate.",
            WRITE,
            Handler::Scoped(Scope::Executor, "disable"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_enable_run_executor",
            "Explicitly enable a fresh authenticated generation for an active run. Does not rearm paused deliveries or repeat existing native effects; startup after restart remains gated by actual process/authority evidence.",
            WRITE,
            Handler::Scoped(Scope::Executor, "enable"),
        ),
        tool::<contract::DeliverTask>(
            "nesvo_deliver_task",
            "Queue the immutable instruction of a current assigned task once. Host waits up to timeoutMs (default 60000, max 300000) for idle and ready, with no human control/draft or decision gate. No prompt is accepted from the caller. Acceptance is not delivery or task success. Inspect task attempt.delivery and its native receipt; unknown effects are never retried. Client disconnect keeps this intent, host restart pauses it without replay. Agent sessions only. Optional sessionId reuses this task's own worker for a new attempt only when its previous attempt and native input are settled, it is idle and ready with no human control or draft, and its conversation is the one recorded for the task; otherwise session_busy, session_foreign, identity_mismatch, attempt_unsettled or resume_pending is returned and nothing is queued.",
            WRITE,
            Handler::Scoped(Scope::Delivery, "queue"),
        ),
        tool::<contract::CancelTaskDelivery>(
            "nesvo_cancel_task_delivery",
            "Cancel an unclaimed task instruction intent in an authorized run. Requires its current run revision. Does not interrupt or replay native input; a claimed/sent/unknown intent must be inspected through its original receipt.",
            WRITE,
            Handler::Scoped(Scope::Delivery, "cancel"),
        ),
        tool::<contract::LaunchTask>(
            "nesvo_launch_task",
            "Reserve a dependency-ready task, run parallel/retry capacity and a native create identity atomically, then launch its visible worker once. Explicitly choose shared checkout or isolated worktree. No initial prompt is sent. Reply is immutable acceptance; inspect run/task history and the returned native receipt before sending work. Unknown launches keep capacity and cannot be retried with a fresh key. Does not take human focus/control or grant coordinator roles.",
            WRITE,
            Handler::WorkflowRequest("launch"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_stop_run",
            "Accept a durable stop intent for only this run's bound worker processes. Native stop receipts precede observed exits; reply is immutable acceptance, not proof of termination. Inspect nesvo_get_run_control. Human leases/drafts and owner drain are protected. Same-key replay/reconnect never dispatches again. Stopped runs may resume with fresh attempts, preserving budgets/history; unknown control must be reconciled first.",
            DESTRUCTIVE,
            Handler::RunControl(Some("stop")),
        ),
        tool::<contract::RunRevision>(
            "nesvo_cancel_run",
            "Accept durable run cancellation and native stop of its bound workers only. Does not touch the coordinator, unassigned children or foreign sessions. The run becomes canceled only after exit proof, and cannot resume. Immutable acceptance is not termination; inspect nesvo_get_run_control. Never bypass human input or resubmit uncertain effects under new keys.",
            DESTRUCTIVE,
            Handler::RunControl(Some("cancel")),
        ),
        tool::<contract::GetRunControl>(
            "nesvo_get_run_control",
            "Inspect at most eight target receipts/exit observations and aggregate native control state. Refreshes actual host exit/unavailable evidence but never sends signals or replays input. Missing processes after restart are unavailable, not assumed stopped. Page through targets; use original operationKey/receiptId for native recovery. Worker scopes cannot inspect parent control.",
            READ,
            Handler::RunControl(None),
        ),
        tool::<contract::RunArgs>(
            "nesvo_get_run_budget",
            "Read a visible run's current policy, active attempts and activation/deadline clock. Workers use their own task context. Reads may persist observed time exhaustion; never start/stop a process.",
            READ,
            Handler::Scoped(Scope::RunBudget, "get"),
        ),
        tool::<contract::SetRunBudget>(
            "nesvo_set_run_budget",
            "Replace a visible run's parallel, per-task attempt and elapsed limits at its exact run revision. Coordinator can only tighten; only owner can relax or extend an exhausted deadline. Reported results occupy parallel slots until validated. Elapsed time includes draining and resume never resets the clock. This neither grants global capacity nor kills current work. Recover the original key through nesvo_get_run_mutation.",
            WRITE,
            Handler::Scoped(Scope::RunBudget, "set"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_drain_run",
            "Block new task assignments; allow assigned workers to report and parents to validate. Does not stop, interrupt or send input to native processes. Owner drain remains owner-controlled even after coordinator drains again. Exact run revision and original mutation key are required.",
            WRITE,
            Handler::Workflow("drain"),
        ),
        tool::<contract::RunRevision>(
            "nesvo_resume_run",
            "Resume new assignments after drain without resetting time/retry history or relaxing budgets. Only owner may undo an owner drain; coordinator can resume its own drain. No process is launched and no input replayed.",
            WRITE,
            Handler::Workflow("resume"),
        ),
        tool::<args::NoArgs>(
            "nesvo_get_host_budget",
            "Read the explicit owner's persisted host admission policy and its revision. Coordinators/workers cannot inspect or raise global budgets. This changes no live process, focus or input control.",
            READ,
            Handler::Scoped(Scope::HostBudget, "get"),
        ),
        tool::<contract::SetHostBudget>(
            "nesvo_set_host_budget",
            "Owner-only replacement of future admission limits at the exact budget revision. maxSessions counts retained session slots (1–16); maxWorkers counts running worker-role processes (0–16); provider caps count running processes including coordinators (0–16). Reducing limits never terminates existing work. Same-key replay is historical and cannot restore an old active policy; recover through nesvo_get_run_mutation.",
            WRITE,
            Handler::Scoped(Scope::HostBudget, "set"),
        ),
        tool::<contract::AskDecision>(
            "nesvo_ask_decision",
            "Ask one durable question for this worker's exact current attempt. Audience owner requires an explicit human answer; coordinator permits that run's coordinator or owner. Answered is data, not native permission approval. Pending/canceled/expired gates prevent successful result reporting. No input or model wake occurs. Recover a lost reply with nesvo_get_run_mutation and the original key.",
            WRITE,
            Handler::Scoped(Scope::Decision, "ask"),
        ),
        tool::<contract::ListDecisions>(
            "nesvo_list_decisions",
            "Read up to eight retained questions and answers in a run. A worker sees only its own current attempt. Deadline expiration is persisted when observed; pagination does not approve or acknowledge anything.",
            READ,
            Handler::Scoped(Scope::Decision, "list"),
        ),
        tool::<contract::GetDecision>(
            "nesvo_get_decision",
            "Read the exact decision revision, audience and state before answering. Current-attempt authority is enforced by the host. This does not send input or imply native permission approval.",
            READ,
            Handler::Scoped(Scope::Decision, "get"),
        ),
        tool::<contract::AnswerDecision>(
            "nesvo_answer_decision",
            "Record a literal answer at the decision's exact revision. Worker self-answer and coordinator answers to owner-only questions are refused. Answer and worker notice commit together; replay the original key after uncertainty. This does not type an approval, validate work or resume native input.",
            WRITE,
            Handler::Scoped(Scope::Decision, "answer"),
        ),
        tool::<contract::CancelDecision>(
            "nesvo_cancel_decision",
            "Withdraw a pending question at its exact revision, retaining a reason. The current worker may withdraw its own question; addressed authority may cancel. Canceled is not approval: report a non-success result and deliberately retry rather than claiming success.",
            WRITE,
            Handler::Scoped(Scope::Decision, "cancel"),
        ),
        tool::<contract::ReadInbox>(
            "nesvo_read_inbox",
            "Read up to eight durable messages, without ACK or input. Worker defaults to its own current attempt; owner/coordinator defaults to the run coordinator mailbox. Optional attemptId inspects a worker mailbox. Pending messages repeat until explicit ACK. After consumer restart read from zero; cursors paginate, not acknowledge.",
            READ,
            Handler::Scoped(Scope::Inbox, "read"),
        ),
        tool::<contract::SendMessage>(
            "nesvo_send_message",
            "Persist one addressed message for a stable key/correlation. Optional attemptId targets a current worker; omission addresses the coordinator. Workers may send only to their own coordinator. Host supplies authenticated sender. Questions are messages, not approval/decision grants. No PTY/LLM execution. Recover uncertainty through nesvo_get_run_mutation with the original key.",
            WRITE,
            Handler::Scoped(Scope::Inbox, "send"),
        ),
        tool::<contract::AckMessages>(
            "nesvo_ack_messages",
            "ACK 1–32 exact IDs in the receiving mailbox. Worker defaults to its own attempt; coordinator to its run inbox. Coordinator cannot ACK on behalf of a worker; owner may explicitly override. Retry the same IDs after loss: first ACK identity/time are preserved. ACK is delivery only, never task execution or validation.",
            WRITE,
            Handler::Scoped(Scope::Inbox, "ack"),
        ),
        tool::<args::NoArgs>(
            "nesvo_list_sessions",
            "List visible session IDs, groups and lifecycle without acquiring control.",
            READ,
            Handler::Raw(mcp::sessions),
        ),
        typed::<args::SessionArgs>(
            "nesvo_get_session",
            "Inspect one visible session and its independent process/agent/turn state.",
            READ,
            mcp::session,
        ),
        tool::<args::NoArgs>(
            "nesvo_get_current_session",
            "Inspect the process session injected into this MCP launch. Never guesses from the UI focus; a context hint cannot bypass host authority.",
            READ,
            Handler::Raw(mcp::sessions),
        ),
        typed::<args::ReadSession>(
            "nesvo_read_session",
            "Read a bounded terminal replay page. Cursors are UTF-8 byte offsets, not domain-event sequences; gap means retained history expired.",
            READ,
            mcp::read_session,
        ),
        typed::<args::SessionArgs>(
            "nesvo_explain_session",
            "Explain this session's status evidence/readiness and integration health without exposing owner credentials or prompts.",
            READ,
            mcp::session,
        ),
        typed::<args::ReadDiff>(
            "nesvo_read_diff",
            "Read repository changes on the host for this session's automatic edit context. Read-only; no staging or commit.",
            READ,
            mcp::read_diff,
        ),
        typed::<args::OpenReview>(
            "nesvo_open_review",
            "Owner-only: open a host review of a session's or absolute folder's local changes, or fetch a GitHub pull request with gh into a host review checkout (120 s cap, reused when present). Exactly one source: sessionId and/or directory, or pullUrl. Replies reviewOpened with a stable reviewId, base, head and diff revision. Never edits, commits, merges or pushes.",
            WRITE,
            mcp::open_review,
        ),
        typed::<args::DeliverReview>(
            "nesvo_deliver_review",
            "Owner-only: deliver review feedback for an open reviewId to a ready idle agent session with one receipt. Without a human lease this is a durable send for a stable key (8192 bytes); a client holding control receives a bracketed paste instead. Never takes control; reuse the same key after uncertainty.",
            WRITE,
            mcp::deliver_review,
        ),
        typed::<args::WorktreeSetup>(
            "nesvo_describe_worktree_setup",
            "Owner-only: read the committed nesvo.toml [worktree] table of a repository (HEAD), its normalized setup/run/env_files/timeout_s, digest and approval state. Runs nothing; requires host worktrees:true. Approving or revoking a digest is a human act through the owner CLI (nesvo worktree approve-setup/revoke-setup) and has no agent tool.",
            READ,
            mcp::describe_worktree_setup,
        ),
        tool::<args::SessionArgs>(
            "nesvo_run_worktree",
            "Owner-only: start the approved run steps of a session's host-created worktree after a passed setup. Replies worktreeRunStarted with the log path; the result is a worktreeRan event and the registry run state, not task success.",
            WRITE,
            Handler::Raw(mcp::worktree_session),
        ),
        tool::<args::SessionArgs>(
            "nesvo_cancel_worktree",
            "Owner-only: cancel the active setup or run steps of a session's worktree. Terminates the step process tree; a cancelled setup never starts the agent.",
            WRITE,
            Handler::Raw(mcp::worktree_session),
        ),
        tool::<args::WorktreeSession>(
            "nesvo_archive_worktree",
            "Owner-only: remove a closed session's host-created worktree and its nesvo/ branch. Refuses dirty, unpushed or conflicted work unless discard is true; discarding deletes that work permanently.",
            DESTRUCTIVE,
            Handler::Raw(mcp::worktree_session),
        ),
        typed::<args::NoArgs>(
            "nesvo_list_worktrees",
            "Owner-only: list host-created worktrees (newest 128) with session, branch, presence, setup and run states, logs and archive facts.",
            READ,
            mcp::list_worktrees,
        ),
        typed::<args::WorktreeSetup>(
            "nesvo_list_workflow_templates",
            "Owner-only: read the committed nesvo.toml [[workflow]] templates of a repository (HEAD) with tasks, tool profiles, workspace modes, budgets, digest and approval state. Starts nothing; requires host workflowTemplates:true. Approving or revoking a digest is a human act through the owner CLI (nesvo workflow approve-templates/revoke-templates) and has no agent tool.",
            READ,
            mcp::list_workflow_templates,
        ),
        typed::<args::StartWorkflowTemplate>(
            "nesvo_start_workflow_template",
            "Owner-only: create a run and its tasks from an approved template through the existing run create/plan/budget/activate/executor commands. Unapproved or changed digests are refused. Reuse the same key after uncertainty; a different template under that key is an idempotency conflict. A started run is not task success.",
            WRITE,
            mcp::start_workflow_template,
        ),
        typed::<args::ReadEvents>(
            "nesvo_read_events",
            "Read durable metadata events after a domain cursor. Preserve nextCursor; gap is incomplete history, never success. No terminal transcript.",
            READ,
            mcp::read_events,
        ),
        typed::<args::CreateSession>(
            "nesvo_create_session",
            "Create one background process for a stable idempotency key. Reuse the same key/spec after timeout, never invent another key to retry. Created is not agent readiness or task success. Host authorization still applies.",
            WRITE,
            mcp::create_session,
        ),
        typed::<args::SendPrompt>(
            "nesvo_send_prompt",
            "Submit one literal prompt to a ready idle session for a durable key. Never takes control; human drafts, pending input and decision dialogs are refused. Reuse the same key/prompt after uncertainty; delivery is not agent pickup or task success.",
            WRITE,
            mcp::send_prompt,
        ),
        typed::<args::WaitPrompt>(
            "nesvo_wait_prompt",
            "Passively wait for one send receipt by id or your original key. Exactly one selector. Binds the matching response, never old idle. Settled means response ended, not validated task success. A timeout returns the receipt and never retries input.",
            READ,
            mcp::wait_prompt,
        ),
        typed::<args::SessionControl>(
            "nesvo_interrupt_session",
            "Submit one Ctrl+C with a durable key; never takes human control. Delivery proves only a native write, not that the agent stopped. May discard the agent's current work. Inspect the same receipt after uncertainty.",
            DESTRUCTIVE,
            mcp::control_session,
        ),
        typed::<args::SessionControl>(
            "nesvo_stop_session",
            "Request native stop of this managed process once for a durable key. Destructive: can lose in-memory work. Refuses human control, retains terminal output/session record. stopRequested is not observed process exit or task success.",
            DESTRUCTIVE,
            mcp::control_session,
        ),
        tool::<contract::RunRevision>(
            "nesvo_activate_run",
            "Freeze a nonempty draft DAG at an expected revision. Does not start any process or send prompts.",
            WRITE,
            Handler::Workflow("activate"),
        ),
        tool::<contract::AssignTask>(
            "nesvo_assign_task",
            "Bind one existing worker process to a dependency-ready task. Only host-granted children for coordinators. Refuses human control/drafts/pending input. No prompt is sent. Retain the returned attempt identity; one process per attempt.",
            WRITE,
            Handler::Workflow("assign"),
        ),
        tool::<contract::GetTaskAttempts>(
            "nesvo_get_task_attempts",
            "Read a task and four retained attempts per page. Owner/coordinator only. Follow nextOffset; reported success remains unvalidated until separately accepted.",
            READ,
            Handler::Workflow("task"),
        ),
        tool::<args::NoArgs>(
            "nesvo_get_current_task",
            "Read this authenticated worker's current task and attempt. Never uses UI focus or environment identity hints. A superseded attempt is refused.",
            READ,
            Handler::Workflow("context"),
        ),
        tool::<contract::RecoverRunContext>(
            "nesvo_recover_run_context",
            "Read current recovery metadata for the authenticated worker or uniquely bound coordinator run. Multiple runs require explicit selection; owner needs runId. Follow returned current-page nextOffset/expectedDigest. Never adopts processes, replays input, ACKs constraints/messages or validates results.",
            READ,
            Handler::Workflow("recover"),
        ),
        tool::<contract::ReportTaskResult>(
            "nesvo_report_task_result",
            "Report this worker's exact current attempt result. Include files/artifacts/checks/limitations, using empty arrays when none. Claims are not verification or validation. Reuse the original key after uncertainty; stale senders/replacement reports are refused. Result bound 4 KiB UTF-8.",
            WRITE,
            Handler::Workflow("report"),
        ),
        tool::<contract::ValidateTaskResult>(
            "nesvo_validate_task_result",
            "Record owner/coordinator attestation of the current reported result. Success needs a succeeded report and passed validation checks. Without hostChecks the host records evidence without executing checks; hostChecks:true first runs the task's approved nesvo.toml checks in its worktree, records a hostChecks attestation and refuses success when one fails. Accepted results release dependencies; idle never does. Validation bound 2 KiB UTF-8.",
            WRITE,
            Handler::Workflow("validate"),
        ),
        tool::<contract::CreateRun>(
            "nesvo_create_run",
            "Create a durable draft run once for a stable key. No agent or task is started; scoped coordinators are bound by the host.",
            WRITE,
            Handler::Workflow("create"),
        ),
        tool::<contract::Page1024>(
            "nesvo_list_runs",
            "List a bounded page of visible workflow summaries. Follow nextOffset; does not expose goal/instruction text.",
            READ,
            Handler::Workflow("list"),
        ),
        tool::<contract::RunArgs>(
            "nesvo_get_run",
            "Read a visible run and its draft DAG by stable run ID. Planned/dependency-ready never means executed or successful.",
            READ,
            Handler::Workflow("get"),
        ),
        tool::<contract::RunArgs>(
            "nesvo_get_run_digest",
            "Read a visible run's bounded 8 KiB digest: the final record stored when the run settled (succeeded, canceled, stopped or drained), otherwise a live working-state snapshot. Summarizes tasks, attempts, outcomes, decisions, budget and evidence pointers (journal cursor, worktree branches, checkpoints). Worker claims stay claims; reading never validates, acknowledges or dispatches.",
            READ,
            Handler::Workflow("digest"),
        ),
        tool::<contract::SetRunPlan>(
            "nesvo_set_run_plan",
            "Atomically replace a draft DAG at an expected revision. Task keys retain IDs. Dependencies are task keys, not names. Cycles/missing edges are refused. Reuse the original key after uncertainty.",
            WRITE,
            Handler::Workflow("setPlan"),
        ),
        tool::<contract::KeyArgs>(
            "nesvo_get_run_mutation",
            "Recover the historical result of your workflow metadata mutation by its original key. Separate from native process-operation receipts; never starts an agent.",
            READ,
            Handler::Workflow("mutation"),
        ),
        typed::<args::GetOperation>(
            "nesvo_get_operation",
            "Recover a durable operation by its ID or your original idempotency key. Exactly one selector. Never resend with a fresh key after an unknown result.",
            READ,
            mcp::get_operation,
        ),
        tool::<contract::CreateJobTrigger>(
            "nesvo_create_job_trigger",
            "Owner-only registration of a disabled external job trigger with a separate secret and exact current job intent. No listener activation, webhook account registration, model call or provider grant. Enable separately after inspection.",
            WRITE,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::UpdateJobTrigger>(
            "nesvo_update_job_trigger",
            "Owner-only exact-revision trigger filter/job-intent reauthorization. Same job and provider only; existing delivery receipts remain immutable and payload never chooses tools or instructions.",
            WRITE,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::HexIdArgs>(
            "nesvo_get_job_trigger",
            "Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
            READ,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::Page4096>(
            "nesvo_list_job_triggers",
            "Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
            READ,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::SetJobTriggerEnabled>(
            "nesvo_set_job_trigger_enabled",
            "Owner-only explicit enable/disable for future external delivery. Does not cancel admitted occurrences or bypass job enablement. Revocation is permanent.",
            WRITE,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::RotateJobTrigger>(
            "nesvo_rotate_job_trigger",
            "Owner-only exact-revision credential rotation with a never-used random secret. Retired credentials no longer authenticate, including delivery replay. Does not retry events or reauthorize changed job intent.",
            WRITE,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::RevokeJobTrigger>(
            "nesvo_revoke_job_trigger",
            "Owner-only permanent revocation of this trigger credential. Preserves accepted delivery history; does not stop already admitted workers or cancel occurrences.",
            DESTRUCTIVE,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::JobTriggerDeliveries>(
            "nesvo_get_job_trigger_deliveries",
            "Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
            READ,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::JobTriggerDelivery>(
            "nesvo_get_job_trigger_delivery",
            "Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
            READ,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::KeyArgs>(
            "nesvo_get_job_trigger_mutation",
            "Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
            READ,
            Handler::Adapter(mcp::job_trigger),
        ),
        tool::<contract::Page4096>(
            "nesvo_list_recovery",
            "Owner-only: list a bounded page of saved launch descriptions for sessions that are not running. A record shows spec.resume when an exact provider conversation was observed. Follow nextOffset. Never starts a process.",
            READ,
            Handler::Adapter(crate::session_recovery::command),
        ),
        tool::<contract::RestoreSession>(
            "nesvo_restore_session",
            "Owner-only: start one new process from a saved description in its recorded folder. Old prompts and worktree creation are never replayed. resume:true asks the provider for the exact recorded conversation; the session stays closed to automated input until the provider confirms that conversation, otherwise it is marked resumeFailed. Gemini and records without a conversation are refused. A claimed record is never restarted twice.",
            WRITE_ONCE,
            Handler::Adapter(crate::session_recovery::command),
        ),
        tool::<contract::HexIdArgs>(
            "nesvo_forget_recovery",
            "Owner-only: forget one saved description. Running processes, conversations and project files are untouched.",
            DESTRUCTIVE,
            Handler::Adapter(crate::session_recovery::command),
        ),
        tool::<contract::ListAttentionInbox>(
            "nesvo_list_attention_inbox",
            "Owner-only: one page of needs-you items across sessions, runs, pending decisions and finished job results, sorted by priority. Each item has a stable id and a revision; follow nextPage. Acknowledged revisions stay hidden; a newer revision of the same item returns. Needs attentionInbox:true.",
            READ,
            Handler::Adapter(cli::attention::command),
        ),
        tool::<contract::AckAttentionInbox>(
            "nesvo_ack_attention_inbox",
            "Owner-only: acknowledge 1–32 inbox items by id and revision. Acknowledgements are durable receipts: repeating one returns the original acknowledgedAt, and reconnecting never shows the same revision again. Acknowledging does not answer a decision or validate a result.",
            WRITE,
            Handler::Adapter(cli::attention::command),
        ),
        tool::<contract::ListPendingDecisions>(
            "nesvo_list_pending_decisions",
            "Owner-only: pending decisions across all runs, oldest first, eight per page with their run and inbox id. No run ID is needed. Needs decisions:true.",
            READ,
            Handler::Adapter(cli::attention::command),
        ),
        tool::<contract::Decide>(
            "nesvo_decide",
            "Owner-only: answer one pending decision by its ID at its current revision. choice is the literal answer the worker receives; an optional note follows it after a blank line. Answered or canceled decisions are refused with decision_resolved and expired ones with decision_expired, so a retry never answers twice. Not a native permission grant.",
            WRITE,
            Handler::Adapter(cli::attention::command),
        ),
        tool::<args::NoArgs>(
            "nesvo_list_projects",
            "Owner-only: list the host's project registry (at most 256 repository roots), pinned first then by last activity, with default branch, open session count and their session IDs. Requires host projects:true. Reading never launches, pins or changes anything.",
            READ,
            Handler::Adapter(crate::project_commands::command),
        ),
        tool::<contract::ProjectRoot>(
            "nesvo_project_defaults",
            "Owner-only: read one project's defaults: the usual launch folder (most launches), recent folders, the host-wide default layout name and the worktree setup state (nesvo.toml configured and approved digest, open worktrees). Approving setup stays a human act through the owner CLI.",
            READ,
            Handler::Adapter(crate::project_commands::command),
        ),
    ]
});

pub mod args {
    use super::contract::{
        Cursor, DiffScope, Id, Key, LaunchSpec, Milestone, QuotaProgram, WorktreeDirectory,
    };
    use schemars::JsonSchema;
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct NoArgs {}

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SessionArgs {
        #[schemars(with = "Id")]
        pub session_id: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetQuotaWake {
        #[schemars(with = "Id")]
        pub session_id: String,
        pub enabled: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    #[schemars(extend("allOf" = [
        {"if": {"required": ["refresh"], "properties": {"refresh": {"const": true}}}, "then": {"required": ["program"]}},
        {"if": {"required": ["directory"]}, "then": {"required": ["program"], "properties": {"program": {"const": "codex"}}}}
    ]))]
    pub struct ProviderQuota {
        #[schemars(with = "Option<QuotaProgram>")]
        pub program: Option<String>,
        #[schemars(
            length(min = 1, max = 4096),
            description = "Absolute host folder to resolve a separate Codex configured-account reader. Does not start a model or alter configuration."
        )]
        pub directory: Option<String>,
        #[serde(default)]
        pub refresh: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReadSession {
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(with = "Option<Cursor>")]
        pub after: Option<u64>,
        #[schemars(range(min = 1, max = 8192), extend("default" = 4096))]
        pub max_bytes: Option<u16>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReadDiff {
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(with = "Option<DiffScope>", extend("default" = "unstaged"))]
        pub scope: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct OpenReview {
        #[schemars(with = "Option<Id>")]
        pub session_id: Option<String>,
        #[schemars(
            length(min = 1, max = 4096),
            description = "Absolute host folder, or relative to the session folder"
        )]
        pub directory: Option<String>,
        #[schemars(
            length(min = 1, max = 512),
            description = "https://github.com/OWNER/REPO/pull/NUMBER"
        )]
        pub pull_url: Option<String>,
        #[schemars(
            length(min = 1, max = 256),
            description = "Base ref for the branch scope; defaults to the repository default branch or the pull request base"
        )]
        pub base: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct DeliverReview {
        #[schemars(with = "Id")]
        pub review_id: String,
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(
            length(min = 1, max = 20480),
            description = "Literal review text; MCP arguments are capped at 24 KiB. No terminal controls."
        )]
        pub text: String,
        #[schemars(
            length(min = 1, max = 128),
            description = "Idempotency key; derived from review, session and text when omitted"
        )]
        pub key: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorktreeSetup {
        #[schemars(with = "WorktreeDirectory")]
        pub directory: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorktreeSession {
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(
            description = "Explicitly delete unsaved work; never set without the owner's decision",
            extend("default" = false)
        )]
        pub discard: Option<bool>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct StartWorkflowTemplate {
        #[schemars(with = "WorktreeDirectory")]
        pub directory: String,
        #[schemars(pattern(r"^[A-Za-z0-9_-]{1,64}$"))]
        pub name: String,
        #[schemars(length(min = 1, max = 96))]
        pub key: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReadEvents {
        #[schemars(with = "Option<Id>")]
        pub session_id: Option<String>,
        #[schemars(with = "Cursor")]
        pub after: u64,
        #[schemars(range(min = 1, max = 32), extend("default" = 32))]
        pub limit: Option<u16>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct CreateSession {
        #[schemars(with = "Key")]
        pub key: String,
        #[schemars(with = "LaunchSpec")]
        pub spec: Value,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SendPrompt {
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(with = "Key")]
        pub key: String,
        #[schemars(
            length(min = 1, max = 8192),
            description = "Literal prompt, at most 8192 UTF-8 bytes. Multiline/tab requires observed bracketed paste. No terminal controls."
        )]
        pub prompt: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SessionControl {
        #[schemars(with = "Id")]
        pub session_id: String,
        #[schemars(with = "Key")]
        pub key: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WaitPrompt {
        #[schemars(with = "Option<Id>")]
        pub id: Option<String>,
        #[schemars(with = "Option<Key>")]
        pub key: Option<String>,
        #[schemars(with = "Option<Id>")]
        pub session_id: Option<String>,
        #[schemars(with = "Option<Milestone>", extend("default" = "settled"))]
        pub until: Option<String>,
        #[schemars(range(min = 1, max = 60_000), extend("default" = 30_000))]
        pub timeout_ms: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct GetOperation {
        #[schemars(with = "Option<Id>")]
        pub id: Option<String>,
        #[schemars(with = "Option<Key>")]
        pub key: Option<String>,
    }
}

#[expect(
    dead_code,
    reason = "contract types describe forwarded arguments; the workflow and adapter parsers own validation"
)]
mod contract {
    use super::{describe_tag, keep_null, null_or, nullable, published_names};
    use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
    use serde::Deserialize;
    use std::{borrow::Cow, collections::BTreeMap};

    const ID: &str = "Stable host-issued ID for the named field; run/task/attempt/session IDs are distinct, never names or UI focus";
    const CAPTURE: &str = "Absolute host path to an owner-declared bounded display manifest. Explicit Claude-only opt-in; pins declared executable/argv/presentation for this launch, without guessing or modifying global statusLine. Callback is display evidence only, not fresh account permission.";
    const TASK_TOOLS: &str = "Exact task-native additions: coordinator policy subset or explicit owner coordinatorless intent; [] chooses none. Does not grant host authority or bypass provider policy.";
    const SECRET: &str = "Separate random secret TEXT, never owner pairing. Request-only, not returned. GitHub HMAC key uses the 64 ASCII bytes, not hex decoding. Never reuse across trigger routes or rotations.";

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    #[schemars(description = ID)]
    pub struct Id(#[schemars(length(min = 1, max = 128))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct Key(#[schemars(length(min = 1, max = 128))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct Revision(#[schemars(range(min = 1))] u64);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct Cursor(#[schemars(range(max = 9_007_199_254_740_991_u64))] u64);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct Digest(#[schemars(length(min = 64, max = 64))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct Sha256Hex(
        #[schemars(length(min = 64, max = 64), pattern(r"^[0-9a-f]{64}$"))] String,
    );

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct HexId(#[schemars(pattern(r"^[0-9a-f]{32}$"))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    #[schemars(description = SECRET)]
    pub struct TriggerSecret(#[schemars(pattern(r"^[0-9a-f]{64}$"))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct TriggerName(
        #[schemars(length(min = 1, max = 64), pattern(r"^[A-Za-z0-9_.:-]+$"))] String,
    );

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    #[schemars(description = "Absolute host folder inside the Git repository")]
    pub struct WorktreeDirectory(#[schemars(length(min = 1, max = 4096))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    #[schemars(
        description = "IANA time zone. Gaps are skipped; folds use the first instant only.",
        extend("default" = "Europe/Warsaw")
    )]
    pub struct TimeZone(#[schemars(length(max = 64))] String);

    #[derive(Deserialize, JsonSchema)]
    #[serde(transparent)]
    pub struct EnvironmentValue(#[schemars(length(max = 2048))] String);

    #[derive(Deserialize)]
    #[serde(transparent)]
    pub struct ToolName(String);

    impl JsonSchema for ToolName {
        fn schema_name() -> Cow<'static, str> {
            "ToolName".into()
        }

        fn json_schema(_: &mut SchemaGenerator) -> Schema {
            json_schema!({"type": "string", "enum": published_names()})
        }
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Program {
        Shell,
        Claude,
        Codex,
        Gemini,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum AgentProgram {
        Claude,
        Codex,
        Gemini,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum QuotaProgram {
        Codex,
        Claude,
        Gemini,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Role {
        Worker,
        Coordinator,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Workspace {
        Shared,
        Worktree,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum DiffScope {
        Staged,
        Unstaged,
        Untracked,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Milestone {
        Delivered,
        Received,
        Started,
        Settled,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Misfire {
        Skip,
        CatchUp,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Overlap {
        Skip,
        Queue,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum RetryOn {
        LaunchNoEffect,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum QuotaMode {
        Wait,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum Audience {
        Owner,
        Coordinator,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum MessageKind {
        Note,
        Question,
        Error,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum TaskOutcome {
        Succeeded,
        Failed,
        Blocked,
        Canceled,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub enum CheckOutcome {
        Passed,
        Failed,
        Skipped,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "snake_case")]
    pub enum GithubEvent {
        Push,
        PullRequest,
        WorkflowRun,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct QuotaCapture {
        #[schemars(length(min = 1, max = 4096), description = CAPTURE)]
        display_profile: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct LaunchSpec {
        #[schemars(length(min = 1, max = 80))]
        name: String,
        #[schemars(extend("default" = "shell"))]
        program: Option<Program>,
        #[schemars(
            description = "Only owner access may grant coordinator at launch; a coordinator cannot create coordinators",
            extend("default" = "worker")
        )]
        role: Option<Role>,
        #[schemars(
            description = "Launch-local Nesvo MCP/instructions on supported Claude; inherits coordinator setting when omitted"
        )]
        harness: Option<bool>,
        #[schemars(
            length(max = 32),
            extend("uniqueItems" = true),
            description = "Owner-only exact native permission additions for this explicit harness process, not inherited by children or restored processes. Does not grant host authority or bypass provider deny/ask rules."
        )]
        allowed_nesvo_tools: Option<Vec<ToolName>>,
        #[schemars(
            length(max = 32),
            extend("uniqueItems" = true),
            description = "Owner-only immutable coordinator policy for authenticated supported Claude harness children. Not copied from the coordinator's own native permissions. Never delegates host roles, allows recursive coordinators or applies merely from parent metadata. Other programs/opt-out children receive no additions."
        )]
        child_allowed_nesvo_tools: Option<Vec<ToolName>>,
        #[schemars(
            length(min = 1, max = 256),
            description = "Explicit launch-local native model alias/ID, not resolved account availability"
        )]
        model: Option<String>,
        #[schemars(
            length(min = 1, max = 32),
            description = "Requires explicit model; provider-specific native reasoning level"
        )]
        effort: Option<String>,
        claude_quota_capture: Option<QuotaCapture>,
        cwd: Option<String>,
        #[schemars(transform = keep_null)]
        group_id: Option<String>,
        #[schemars(
            description = "Lineage only; scoped creation binds the authenticated parent automatically",
            transform = keep_null
        )]
        parent_session_id: Option<String>,
        #[schemars(
            description = "Literal agent prompt, at most 8192 UTF-8 bytes; not a shell command"
        )]
        prompt: Option<String>,
        #[serde(default)]
        worktree: bool,
        #[serde(default)]
        auto_title: bool,
        #[serde(default)]
        muted: bool,
        #[serde(default)]
        resume_picker: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct TaskProfile<P> {
        #[schemars(length(min = 1, max = 80))]
        name: Option<String>,
        #[schemars(length(max = 4096))]
        cwd: Option<String>,
        program: P,
        workspace: Workspace,
        harness: Option<bool>,
        #[schemars(length(min = 1, max = 256))]
        model: Option<String>,
        #[schemars(length(min = 1, max = 32))]
        effort: Option<String>,
        #[schemars(length(max = 32), extend("uniqueItems" = true), description = TASK_TOOLS)]
        allowed_nesvo_tools: Option<Vec<ToolName>>,
        claude_quota_capture: Option<QuotaCapture>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct PrecheckSpec {
        #[schemars(extend("const" = 1, "default" = 1))]
        version: Option<i64>,
        #[schemars(length(min = 1, max = 80))]
        title: String,
        #[schemars(
            length(min = 1, max = 4096),
            description = "Absolute executable on host; Windows requires .exe/.com. No implicit shell."
        )]
        executable: String,
        #[schemars(
            length(min = 1, max = 4096),
            description = "Exact absolute host directory, not an ambient/focused session path"
        )]
        cwd: String,
        #[schemars(length(max = 32), inner(length(max = 2048)), extend("default" = []))]
        arguments: Option<Vec<String>>,
        #[schemars(range(min = 100, max = 10_000), extend("default" = 2000))]
        timeout_ms: Option<u64>,
        #[schemars(length(min = 1, max = 8), extend("uniqueItems" = true))]
        pass_exit_codes: Option<Vec<u8>>,
        #[schemars(length(min = 1, max = 8), extend("uniqueItems" = true))]
        skip_exit_codes: Option<Vec<u8>>,
        #[schemars(
            description = "Explicit additions to isolated-platform-v1. No ambient inheritance. Windows adds OS-derived SystemRoot. Overrides and NESVO_/POCKET_ keys forbidden; ASCII alphanumeric/underscore names, unique without regard to case. Not a sandbox.",
            extend("maxProperties" = 16)
        )]
        environment: Option<BTreeMap<String, EnvironmentValue>>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Schedule {
        Once {
            #[schemars(
                length(max = 64),
                description = "Future RFC3339 instant with an explicit UTC offset, at most 366 days ahead"
            )]
            at: String,
        },
        Cron {
            #[schemars(
                length(min = 1, max = 256),
                description = "Five fields: minute hour day month weekday"
            )]
            expression: String,
            time_zone: Option<TimeZone>,
        },
        Rrule {
            #[schemars(
                length(min = 1, max = 1024),
                description = "Uppercase Gregorian RFC5545 RRULE; MINUTELY or coarser, COUNT<=10000, UTC UNTIL. Bounded search can explicitly refuse complex/old dense rules."
            )]
            rule: String,
            #[schemars(
                length(min = 19, max = 19),
                description = "Existing local DTSTART as YYYY-MM-DDTHH:MM:SS"
            )]
            start: String,
            time_zone: Option<TimeZone>,
        },
        #[schemars(
            description = "No timer schedule; requires jobExternalTriggers:true. Only explicit run-now or authenticated configured external delivery admits an occurrence.",
            transform = describe_tag
        )]
        External,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RetryPolicy {
        #[schemars(
            description = "Retries an exact failed native create receipt with effectStarted:false, and an uncertain launch only after journal probes find no attempt or session and fence its Run; found work is adopted, never relaunched; no process or result retry"
        )]
        on: RetryOn,
        #[schemars(
            range(min = 1, max = 8),
            description = "Total dispatch generations, including the first"
        )]
        max_attempts: u64,
        #[schemars(range(min = 1000, max = 3_600_000))]
        initial_delay_ms: u64,
        #[schemars(
            range(min = 1000, max = 86_400_000),
            description = "At least initialDelayMs; capped exponential delay is persisted once per outgoing retry decision"
        )]
        max_delay_ms: u64,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct QuotaPolicy {
        mode: QuotaMode,
        context_id: Sha256Hex,
        account_fingerprint: Sha256Hex,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobSpec {
        #[schemars(length(min = 1, max = 80))]
        title: String,
        #[schemars(length(min = 1, max = 8192))]
        instruction: String,
        profile: TaskProfile<AgentProgram>,
        schedule: Schedule,
        #[schemars(
            length(min = 32, max = 32),
            description = "Previously owner-approved immutable command ID. Combining with retry explicitly authorizes bounded repeated execution before each fresh generation and requires jobPrecheckGenerations:true. Each begin checks current approval and records fresh authorization; prior passes cannot release a new Run."
        )]
        precheck_id: Option<String>,
        retry: Option<RetryPolicy>,
        #[schemars(extend("default" = "catchUp"))]
        misfire: Option<Misfire>,
        #[schemars(range(max = 86_400_000), extend("default" = 60_000))]
        grace_ms: Option<u64>,
        #[schemars(extend("default" = "skip"))]
        overlap: Option<Overlap>,
        #[schemars(
            range(min = 1000, max = 604_800_000),
            extend("default" = 300_000),
            description = "Per-Run admission/input budget, not a hard process timeout"
        )]
        max_elapsed_ms: Option<u64>,
        #[schemars(
            range(min = 1000, max = 604_800_000),
            description = "Optional per-generation execution window from native launch admission, including preparation/readiness and excluding prechecks. An accepted explicit worker report before the deadline disarms it while validation may remain pending. Expiry requests exact bound-worker cleanup subject to human control; acceptance is not observed exit. Requires jobExecutionTimeouts:true. Omission adds no execution timeout; maxElapsedMs remains independent."
        )]
        execution_timeout_ms: Option<u64>,
        #[schemars(
            description = "Explicit owner opt-in to wait for configured-reader quota evidence; currently Codex only. Bind inspected contextId/accountFingerprint, never credentials. Requires jobQuotaAdmission:true; providerQuotaObservations or quotaWake alone is insufficient. Omission preserves legacy intent. This observation is not an immutable native-account lease or a guarantee that the provider will accept work."
        )]
        quota_policy: Option<QuotaPolicy>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct IdArgs {
        id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct KeyArgs {
        key: Key,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct HexIdArgs {
        id: HexId,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RunArgs {
        run_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobArgs {
        job_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct Page4096 {
        #[schemars(range(max = 4096), extend("default" = 0))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct Page1024 {
        #[schemars(range(max = 1024), extend("default" = 0))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RunRevision {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct DescribePrecheck {
        spec: PrecheckSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ApprovePrecheck {
        key: Key,
        spec: PrecheckSpec,
        expected_digest: Digest,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RevokePrecheck {
        id: Id,
        key: Key,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AbandonJobPrecheck {
        key: Key,
        job_id: Id,
        occurrence_id: Id,
        job_attempt_id: Option<Id>,
        expected_digest: Digest,
        #[schemars(extend("const" = true))]
        acknowledge_unknown_effects: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AbandonJobLaunch {
        key: Key,
        job_id: Id,
        occurrence_id: Id,
        job_attempt_id: Id,
        expected_digest: Sha256Hex,
        #[schemars(extend("const" = true))]
        acknowledge_unknown_effects: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct CreateJob {
        key: Key,
        spec: JobSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AuthorizeJobQuota {
        key: Key,
        job_id: Id,
        occurrence_id: Id,
        expected_context_id: Sha256Hex,
        expected_account_fingerprint: Sha256Hex,
        context_id: Sha256Hex,
        account_fingerprint: Sha256Hex,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct UpdateJob {
        key: Key,
        job_id: Id,
        expected_revision: Revision,
        spec: JobSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetJobEnabled {
        key: Key,
        job_id: Id,
        expected_revision: Revision,
        enabled: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobRevision {
        key: Key,
        job_id: Id,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CancelJobOccurrence {
        key: Key,
        job_id: Id,
        occurrence_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobHistory {
        job_id: Id,
        #[schemars(range(max = 4096), extend("default" = 0))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobOccurrence {
        job_id: Id,
        occurrence_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobAttempts {
        job_id: Id,
        occurrence_id: Id,
        #[schemars(range(max = 4096), extend("default" = 0))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobAttempt {
        job_id: Id,
        occurrence_id: Id,
        job_attempt_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RebindRunCoordinator {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        #[schemars(required, transform = null_or)]
        expected_coordinator_session_id: Option<Id>,
        coordinator_session_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AddRunConstraint {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        #[schemars(length(min = 1, max = 1024))]
        text: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ListRunConstraints {
        run_id: Id,
        #[schemars(range(max = 16))]
        after: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AcknowledgeRunConstraints {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        #[schemars(range(min = 1, max = 16))]
        constraint_revision: u64,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SaveRunCheckpoint {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        #[schemars(length(min = 1, max = 2048))]
        summary: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ListRunCheckpoints {
        run_id: Id,
        #[schemars(range(max = 32))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetRunCheckpoint {
        run_id: Id,
        checkpoint_id: Id,
        #[schemars(range(max = 16384))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReadRunContext {
        run_id: Id,
        checkpoint_id: Option<Id>,
        #[schemars(range(max = 16384))]
        offset: Option<u64>,
        #[schemars(pattern(r"^[a-f0-9]{64}$"))]
        expected_digest: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetRunWakes {
        run_id: Id,
        after: Option<Cursor>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetRunWakeBatch {
        run_id: Id,
        batch_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ExecutorTask {
        task_id: Id,
        profile: TaskProfile<AgentProgram>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ExecutorSpec {
        #[schemars(length(min = 1, max = 64))]
        tasks: Vec<ExecutorTask>,
        #[serde(default)]
        retry_failed: bool,
        #[schemars(range(min = 1000, max = 60_000), extend("default" = 1000))]
        retry_delay_ms: Option<u64>,
        #[schemars(range(min = 1, max = 300_000), extend("default" = 60_000))]
        readiness_timeout_ms: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct StartRunExecutor {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        spec: ExecutorSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct DeliverTask {
        key: Key,
        run_id: Id,
        task_id: Id,
        expected_revision: Revision,
        #[schemars(range(min = 1, max = 300_000))]
        timeout_ms: Option<u64>,
        session_id: Option<Id>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CancelTaskDelivery {
        key: Key,
        run_id: Id,
        delivery_id: Id,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct LaunchTask {
        key: Key,
        run_id: Id,
        task_id: Id,
        expected_revision: Revision,
        profile: TaskProfile<Program>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetRunControl {
        run_id: Id,
        control_id: Id,
        #[schemars(range(max = 4096))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RunLimits {
        #[schemars(range(min = 1, max = 16))]
        max_parallel: u64,
        #[schemars(range(min = 1, max = 16))]
        max_attempts_per_task: u64,
        #[schemars(required, range(min = 1000, max = 604_800_000), transform = nullable)]
        max_elapsed_ms: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetRunBudget {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        limits: RunLimits,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct ProviderLimits {
        #[schemars(range(max = 16))]
        shell: u64,
        #[schemars(range(max = 16))]
        claude: u64,
        #[schemars(range(max = 16))]
        codex: u64,
        #[schemars(range(max = 16))]
        gemini: u64,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct HostLimits {
        #[schemars(range(min = 1, max = 16))]
        max_sessions: u64,
        #[schemars(range(max = 16))]
        max_workers: u64,
        providers: ProviderLimits,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetHostBudget {
        key: Key,
        expected_revision: Revision,
        limits: HostLimits,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AskDecision {
        key: Key,
        attempt_id: Id,
        audience: Audience,
        #[schemars(length(min = 1, max = 2048))]
        question: String,
        #[schemars(range(min = 1000, max = 604_800_000))]
        timeout_ms: u64,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ListDecisions {
        run_id: Id,
        attempt_id: Option<Id>,
        #[schemars(range(max = 4096))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetDecision {
        run_id: Id,
        decision_id: Id,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AnswerDecision {
        key: Key,
        run_id: Id,
        decision_id: Id,
        expected_revision: Revision,
        #[schemars(length(min = 1, max = 2048))]
        answer: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct CancelDecision {
        key: Key,
        run_id: Id,
        decision_id: Id,
        expected_revision: Revision,
        #[schemars(length(min = 1, max = 2048))]
        reason: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReadInbox {
        run_id: Id,
        attempt_id: Option<Id>,
        after: Option<Cursor>,
        #[serde(default)]
        include_acked: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SendMessage {
        key: Key,
        run_id: Id,
        attempt_id: Option<Id>,
        correlation_id: Key,
        #[schemars(extend("default" = "note"))]
        kind: Option<MessageKind>,
        #[schemars(length(min = 1, max = 4096))]
        body: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AckMessages {
        run_id: Id,
        attempt_id: Option<Id>,
        #[schemars(length(min = 1, max = 32), extend("uniqueItems" = true))]
        ids: Vec<Id>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AssignTask {
        key: Key,
        run_id: Id,
        task_id: Id,
        session_id: Id,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct GetTaskAttempts {
        run_id: Id,
        task_id: Id,
        #[schemars(range(max = 16))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RecoverRunContext {
        run_id: Option<Id>,
        #[schemars(range(max = 16384))]
        offset: Option<u64>,
        #[schemars(length(max = 128))]
        expected_digest: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct Check {
        #[schemars(length(min = 1, max = 128))]
        name: String,
        outcome: CheckOutcome,
        #[schemars(length(min = 1, max = 1024))]
        details: String,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct TaskResult {
        outcome: TaskOutcome,
        #[schemars(length(min = 1, max = 2048))]
        summary: String,
        #[schemars(length(max = 32), inner(length(min = 1, max = 1024)))]
        files: Vec<String>,
        #[schemars(length(max = 16), inner(length(min = 1, max = 1024)))]
        artifacts: Vec<String>,
        #[schemars(length(max = 16))]
        checks: Vec<Check>,
        #[schemars(length(max = 16), inner(length(min = 1, max = 1024)))]
        limitations: Vec<String>,
        #[schemars(length(max = 8), inner(length(min = 1, max = 1024)))]
        next_steps: Option<Vec<String>>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ReportTaskResult {
        key: Key,
        attempt_id: Id,
        result: TaskResult,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct Validation {
        passed: bool,
        #[schemars(length(min = 1, max = 1024))]
        summary: String,
        #[schemars(length(max = 16))]
        checks: Vec<Check>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ValidateTaskResult {
        key: Key,
        run_id: Id,
        attempt_id: Id,
        expected_revision: Revision,
        validation: Validation,
        host_checks: Option<bool>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RunSpec {
        #[schemars(length(min = 1, max = 80))]
        title: String,
        #[schemars(length(min = 1, max = 8192))]
        goal: String,
        #[schemars(transform = keep_null)]
        coordinator_session_id: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct CreateRun {
        key: Key,
        spec: RunSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct PlanTask {
        #[schemars(pattern(r"^[A-Za-z0-9_-]{1,64}$"))]
        key: String,
        #[schemars(length(min = 1, max = 80))]
        title: String,
        #[schemars(length(min = 1, max = 8192))]
        instruction: String,
        #[schemars(length(max = 64))]
        dependencies: Option<Vec<String>>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetRunPlan {
        key: Key,
        run_id: Id,
        expected_revision: Revision,
        #[schemars(length(max = 64))]
        tasks: Vec<PlanTask>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum TriggerAdapter {
        Webhook {
            event: TriggerName,
        },
        #[schemars(extend("oneOf" = [
            {"properties": {"event": {"const": "push"}, "actions": {"maxItems": 0}}},
            {"properties": {"event": {"const": "pull_request"}, "actions": {"minItems": 1, "items": {"enum": crate::job_triggers::PULL_REQUEST_ACTIONS}}}},
            {"properties": {"event": {"const": "workflow_run"}, "actions": {"const": ["completed"]}}}
        ]))]
        Github {
            #[schemars(range(min = 1))]
            repository_id: u64,
            #[schemars(length(max = 201), pattern(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))]
            repository: String,
            event: GithubEvent,
            #[schemars(length(max = 16), extend("uniqueItems" = true))]
            actions: Vec<TriggerName>,
            #[schemars(
                required,
                length(min = 1, max = 255),
                pattern(r"^\S+$"),
                transform = nullable
            )]
            branch: Option<String>,
        },
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct TriggerSpec {
        #[schemars(length(min = 1, max = 80))]
        title: String,
        job_id: HexId,
        job_revision: Revision,
        adapter: TriggerAdapter,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct CreateJobTrigger {
        key: Key,
        spec: TriggerSpec,
        secret: TriggerSecret,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct UpdateJobTrigger {
        key: Key,
        id: HexId,
        expected_revision: Revision,
        spec: TriggerSpec,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SetJobTriggerEnabled {
        key: Key,
        id: HexId,
        expected_revision: Revision,
        enabled: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RotateJobTrigger {
        key: Key,
        id: HexId,
        expected_revision: Revision,
        secret: TriggerSecret,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct RevokeJobTrigger {
        key: Key,
        id: HexId,
        expected_revision: Revision,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct JobTriggerDeliveries {
        id: HexId,
        #[schemars(range(max = 4096), extend("default" = 0))]
        offset: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct JobTriggerDelivery {
        id: HexId,
        delivery_id: Key,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct RestoreSession {
        id: HexId,
        #[serde(default)]
        resume: bool,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct ListAttentionInbox {
        #[schemars(range(max = 1024), extend("default" = 0))]
        page: Option<u64>,
        #[schemars(range(min = 1, max = 32), extend("default" = 16))]
        limit: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct AttentionMark {
        #[schemars(length(min = 1, max = 200))]
        id: String,
        revision: u64,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct AckAttentionInbox {
        #[schemars(length(min = 1, max = 32))]
        items: Vec<AttentionMark>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct ListPendingDecisions {
        #[schemars(range(max = 512), extend("default" = 0))]
        page: Option<u64>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Decide {
        #[schemars(length(min = 1, max = 128))]
        decision_id: String,
        #[schemars(length(min = 1, max = 2048))]
        choice: String,
        #[schemars(length(min = 1, max = 1024))]
        note: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct ProjectRoot {
        #[schemars(
            length(min = 1, max = 4096),
            description = "Absolute host path of the repository root, as listed"
        )]
        root: String,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};

    const CATALOGUE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/harness-mcp-tools.json"
    );
    const DOCS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/harness-mcp.md");

    fn catalogue() -> String {
        serde_json::to_string_pretty(&published_names()).expect("Tool names serialize") + "\n"
    }

    fn effect(hints: Hints) -> &'static str {
        if hints.read_only {
            "read-only"
        } else if hints.destructive {
            "destructive"
        } else {
            "write"
        }
    }

    fn first_sentence(description: &str) -> &str {
        description
            .find(". ")
            .map_or(description, |end| &description[..=end])
    }

    fn docs_table() -> String {
        let header = ["Tool", "Effect", "Summary"];
        let rows: Vec<[&str; 3]> = TOOLS
            .iter()
            .map(|tool| {
                [
                    tool.name,
                    effect(tool.hints),
                    first_sentence(tool.description),
                ]
            })
            .collect();
        let widths: Vec<usize> = (0..header.len())
            .map(|column| {
                rows.iter()
                    .map(|row| row[column].chars().count())
                    .chain([header[column].chars().count()])
                    .max()
                    .unwrap_or_default()
            })
            .collect();
        let line = |cells: [&str; 3]| {
            let cells: Vec<String> = cells
                .iter()
                .zip(&widths)
                .map(|(cell, width)| format!("{cell:<width$}"))
                .collect();
            format!("| {} |\n", cells.join(" | "))
        };
        let rule: Vec<String> = widths.iter().map(|width| "-".repeat(*width)).collect();
        let mut table = line(header);
        table.push_str(&format!("| {} |\n", rule.join(" | ")));
        for row in rows {
            table.push_str(&line(row));
        }
        table
    }

    fn with_docs_table(document: &str) -> String {
        let lines: Vec<&str> = document.lines().collect();
        let start = lines
            .iter()
            .position(|line| line.starts_with("| Tool "))
            .expect("docs/harness-mcp.md keeps one tool table");
        let end = lines[start..]
            .iter()
            .position(|line| !line.starts_with('|'))
            .map_or(lines.len(), |offset| start + offset);
        format!(
            "{}\n{}{}\n",
            lines[..start].join("\n"),
            docs_table(),
            lines[end..].join("\n")
        )
    }

    fn committed(path: &str) -> String {
        fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("{path}: {error}"))
            .replace("\r\n", "\n")
    }

    #[test]
    fn tool_table_publishes_each_tool_once() {
        let names = published_names();
        assert!(
            names.windows(2).all(|pair| pair[0] < pair[1]),
            "Tool names must be unique"
        );
        assert_eq!(names.len(), TOOL_COUNT);
        assert_eq!(catalog().len(), TOOL_COUNT);
    }

    #[test]
    fn committed_catalogue_and_docs_table_match_the_tool_table() {
        let catalogue = catalogue();
        let docs = with_docs_table(&committed(DOCS));
        if env::var("NESVO_UPDATE_CONTRACTS").as_deref() == Ok("1") {
            fs::write(CATALOGUE, &catalogue).expect("Write the tool catalogue");
            fs::write(DOCS, &docs).expect("Write the docs tool table");
        }
        assert_eq!(
            committed(CATALOGUE),
            catalogue,
            "docs/harness-mcp-tools.json drifted from the tool table; rerun with NESVO_UPDATE_CONTRACTS=1"
        );
        assert_eq!(
            committed(DOCS),
            docs,
            "The docs/harness-mcp.md tool table drifted from the tool table; rerun with NESVO_UPDATE_CONTRACTS=1"
        );
    }

    fn string_values(schema: &Map<String, Value>) -> bool {
        schema
            .get("enum")
            .and_then(Value::as_array)
            .map(|values| values.iter().all(Value::is_string))
            .or_else(|| schema.get("const").map(Value::is_string))
            .unwrap_or(false)
    }

    fn intentional(
        path: &str,
        legacy: &Map<String, Value>,
        derived: &Map<String, Value>,
        accepted: &mut Vec<String>,
    ) -> Map<String, Value> {
        let mut derived = derived.clone();
        if !legacy.contains_key("type")
            && derived.get("type") == Some(&json!("string"))
            && string_values(&derived)
        {
            derived.remove("type");
            accepted.push(format!(
                "{path}: string enum/const also declares type string"
            ));
        }
        if legacy.get("const") == Some(&json!("wait"))
            && derived.get("enum") == Some(&json!(["wait"]))
        {
            derived.remove("enum");
            derived.insert("const".into(), json!("wait"));
            accepted.push(format!("{path}: one-variant enum instead of const"));
        }
        derived
    }

    fn differences(
        path: String,
        legacy: &Value,
        derived: &Value,
        found: &mut Vec<String>,
        accepted: &mut Vec<String>,
    ) {
        match (legacy, derived) {
            (Value::Object(legacy), Value::Object(derived)) => {
                let derived = intentional(&path, legacy, derived, accepted);
                let keys: Vec<&String> = legacy
                    .keys()
                    .chain(derived.keys().filter(|key| !legacy.contains_key(*key)))
                    .collect();
                for key in keys {
                    differences(
                        format!("{path}/{key}"),
                        legacy.get(key).unwrap_or(&Value::Null),
                        derived.get(key).unwrap_or(&Value::Null),
                        found,
                        accepted,
                    );
                }
            }
            (Value::Array(legacy), Value::Array(derived)) if legacy.len() == derived.len() => {
                for (index, (legacy, derived)) in legacy.iter().zip(derived).enumerate() {
                    differences(format!("{path}/{index}"), legacy, derived, found, accepted);
                }
            }
            _ if legacy != derived => found.push(format!("{path}: {legacy} -> {derived}")),
            _ => {}
        }
    }

    #[test]
    fn derived_tools_match_the_hand_written_contract() {
        let legacy: Vec<Value> =
            serde_json::from_str(include_str!("mcp_tools_legacy.json")).expect("Legacy fixture");
        let derived: Vec<Value> = catalog()
            .iter()
            .map(|tool| serde_json::to_value(tool).expect("Tool serializes"))
            .collect();
        assert_eq!(legacy.len(), derived.len());
        let (mut found, mut accepted) = (Vec::new(), Vec::new());
        for (legacy, derived) in legacy.iter().zip(&derived) {
            let name = legacy["name"].as_str().unwrap_or_default();
            differences(name.into(), legacy, derived, &mut found, &mut accepted);
        }
        println!(
            "{} accepted differences:\n{}",
            accepted.len(),
            accepted.join("\n")
        );
        assert!(found.is_empty(), "{}", found.join("\n"));
    }
}
