use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowConstraintPolicy")]
pub struct WorkflowConstraintPolicy {
    #[schemars(range(max = 16))]
    pub revision: u64,
    #[schemars(range(max = 16))]
    pub acknowledged_revision: u64,
    pub pending: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowConstraint")]
pub struct WorkflowConstraint {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(range(min = 1, max = 16))]
    pub revision: u64,
    #[schemars(length(min = 1, max = 1024))]
    pub text: String,
    #[schemars(length(min = 1, max = 128))]
    pub issuer: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowCheckpoint")]
pub struct WorkflowCheckpoint {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(range(min = 1, max = 32))]
    pub ordinal: u64,
    #[schemars(length(min = 1, max = 128))]
    pub issuer: String,
    pub created_at: u64,
    #[schemars(range(min = 1))]
    pub source_run_revision: u64,
    pub source_cursor: u64,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 2048))]
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowContextMetadata")]
pub struct WorkflowContextMetadata {
    #[schemars(extend("const" = 1))]
    pub schema_version: u64,
    pub kind: WorkflowContextMetadataKind,
    #[schemars(range(min = 1))]
    pub source_run_revision: u64,
    pub source_cursor: u64,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    #[schemars(range(max = 16384))]
    pub part_count: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub baseline_differs: Option<bool>,
    #[schemars(extend("const" = false))]
    pub native_effects_restored: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "workflowContextPart")]
pub enum WorkflowContextPart {
    Run(ContextRun),
    ConstraintPolicy(WorkflowConstraintPolicy),
    Constraint(WorkflowConstraint),
    Task(ContextTask),
    Attempt(ContextAttempt),
    Decision(ContextDecision),
    Control(ContextControl),
    WakeBatch(ContextWakeBatch),
    NativeOperation(ContextNativeOperation),
    Automation(ContextAutomation),
    Inbox(ContextInbox),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ContextRun {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(max = 80))]
    pub title: String,
    #[schemars(length(max = 8192))]
    pub goal: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub state: ContextRunState,
    pub budget: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextTask {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(max = 128))]
    pub key: String,
    #[schemars(length(max = 80))]
    pub title: String,
    #[schemars(length(max = 8192))]
    pub instruction: String,
    #[schemars(length(max = 64), inner(length(min = 1, max = 128)))]
    pub dependencies: Vec<String>,
    pub state: TaskState,
    pub dependency_state: DependencyState,
    #[schemars(range(max = 16))]
    pub attempts: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub current_attempt: Option<ContextCurrentAttempt>,
    #[serde(deserialize_with = "present_or_null")]
    pub task_result: Option<TaskResult>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextCurrentAttempt {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(range(min = 1, max = 16))]
    pub ordinal: u64,
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
    pub state: TaskState,
    #[serde(deserialize_with = "present_or_null")]
    pub reported_outcome: Option<ReportedOutcome>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextAttempt {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(min = 1, max = 128))]
    pub task_id: String,
    #[schemars(range(min = 1, max = 16))]
    pub ordinal: u64,
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
    pub state: TaskState,
    #[serde(deserialize_with = "present_or_null")]
    pub reported_outcome: Option<ReportedOutcome>,
    #[serde(deserialize_with = "present_or_null")]
    pub validation_passed: Option<bool>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub launch_receipt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub launch_phase: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub delivery_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub delivery_phase: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub delivery_receipt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub delivery_native_phase: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextDecision {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(min = 1, max = 128))]
    pub attempt_id: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub state: DecisionState,
    pub audience: Audience,
    pub expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextControl {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    pub kind: ControlKind,
    #[schemars(length(max = 128))]
    pub state: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub attempt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub phase: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub receipt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub operation_key: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextWakeBatch {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(min = 1, max = 128))]
    pub policy_id: String,
    #[schemars(length(max = 128))]
    pub phase: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub reason: Option<String>,
    #[schemars(length(min = 1, max = 128))]
    pub receipt_id: String,
    #[schemars(length(max = 128))]
    pub native_phase: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextNativeOperation {
    #[schemars(length(min = 1, max = 128))]
    pub receipt_id: String,
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
    pub operation: NativeOperation,
    #[schemars(length(max = 128))]
    pub phase: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextAutomation {
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    pub r#type: AutomationKind,
    pub enabled: bool,
    #[schemars(range(min = 1))]
    pub generation: u64,
    #[schemars(length(max = 128))]
    pub phase: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ContextInbox {
    pub pending_coordinator_messages: u64,
    pub message_head: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ContextRunState {
    Draft,
    Active,
    Draining,
    Stopping,
    Stopped,
    Canceling,
    Canceled,
    Succeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum AutomationKind {
    Executor,
    Wakes,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowRecoveryPage")]
pub struct WorkflowRecoveryPage {
    pub run: Map<String, Value>,
    #[serde(deserialize_with = "present_or_null")]
    pub checkpoint: Option<WorkflowCheckpoint>,
    pub context: WorkflowContextMetadata,
    #[schemars(length(max = 8))]
    pub parts: Vec<WorkflowContextPart>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 16384))]
    pub next_offset: Option<u64>,
    pub current_constraints: WorkflowConstraintPolicy,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowRecoveryTask")]
pub struct WorkflowRecoveryTask {
    pub run: WorkflowRecoveryTaskRun,
    pub task: WorkflowTaskHead,
    pub attempt: WorkflowAttempt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<WorkflowConstraintSet>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub working_state: Option<Option<Map<String, Value>>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowRecoveryContext", transform = workflow_tag)]
#[schemars(extend(
    "oneOf" = [
        {
            "required": ["taskContext"],
            "properties": {
                "scope": {"const": "worker"},
                "bound": {"const": true},
                "selectionRequired": {"const": false},
            },
            "not": {"anyOf": [{"required": ["page"]}, {"required": ["runs"]}]},
        },
        {
            "required": ["page"],
            "properties": {
                "scope": {"enum": ["owner", "coordinator"]},
                "bound": {"const": true},
                "selectionRequired": {"const": false},
            },
            "not": {"anyOf": [{"required": ["taskContext"]}, {"required": ["runs"]}]},
        },
        {
            "properties": {
                "scope": {"enum": ["worker", "coordinator"]},
                "bound": {"const": false},
                "selectionRequired": {"const": false},
                "runs": {"maxItems": 0},
                "hasMoreRuns": {"const": false},
            },
            "not": {"anyOf": [{"required": ["page"]}, {"required": ["taskContext"]}]},
        },
        {
            "required": ["runs", "hasMoreRuns"],
            "properties": {
                "scope": {"const": "coordinator"},
                "bound": {"const": false},
                "selectionRequired": {"const": true},
                "runs": {"minItems": 1},
            },
            "not": {"anyOf": [{"required": ["page"]}, {"required": ["taskContext"]}]},
        },
    ]
))]
pub struct WorkflowRecoveryContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
    pub scope: ContextScope,
    pub bound: bool,
    pub selection_required: bool,
    #[schemars(extend("const" = false))]
    pub native_effects_restored: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<WorkflowRecoveryPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_context: Option<WorkflowRecoveryTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 8))]
    pub runs: Option<Vec<WorkflowRecoveryContextRunsItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more_runs: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(
    inline,
    description = "Constraint pages name their continuation flag hasMore; every other paged reply with a continuation flag names it more. Both mean another page follows the returned cursor."
)]
pub struct WorkflowConstraintPage {
    pub run: WorkflowRun,
    pub constraints: WorkflowConstraintPolicy,
    #[schemars(length(max = 8))]
    pub records: Vec<WorkflowConstraint>,
    pub next_cursor: u64,
    pub has_more: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowCheckpointPage {
    pub run: WorkflowRun,
    #[schemars(length(max = 8))]
    pub checkpoints: Vec<WorkflowCheckpoint>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 32))]
    pub next_offset: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowContextReply {
    pub run: WorkflowRun,
    #[serde(deserialize_with = "present_or_null")]
    pub checkpoint: Option<WorkflowCheckpoint>,
    pub context: WorkflowContextMetadata,
    #[schemars(length(max = 8))]
    pub parts: Vec<WorkflowContextPart>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 16384))]
    pub next_offset: Option<u64>,
    pub current_constraints: WorkflowConstraintPolicy,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRecoveryTaskRun {
    pub id: Value,
    pub title: Value,
    pub revision: Value,
    pub state: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowRecoveryContextRunsItem {
    pub id: String,
    pub title: String,
    pub state: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowContextMetadataKind {
    Current,
    Historical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ContextScope {
    Owner,
    Coordinator,
    Worker,
}
