use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowWakePolicy")]
pub struct WorkflowWakePolicy {
    pub id: Id,
    pub run_id: Id,
    pub coordinator: Id,
    pub issuer: Id,
    pub enabled: bool,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub phase: WorkflowWakePolicyPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    pub created_at: Timestamp,
    pub delivery: WorkflowWakeDelivery,
    pub held: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowWakeNotice")]
pub struct WorkflowWakeNotice {
    pub id: Id,
    pub sequence: Cursor,
    pub kind: WorkflowWakeNoticeKind,
    pub reference: WorkflowWakeNoticeReference,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub batch_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Timestamp>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowWakeNative")]
pub struct WorkflowWakeNative {
    pub phase: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowWakeBaseline")]
#[schemars(extend(
    "oneOf" = [
        {
            "not": {
                "anyOf": [
                    {"required": ["contextDigest"]},
                    {"required": ["partCount"]},
                    {"required": ["pendingInbox"]},
                    {"required": ["tasks"]},
                ],
            },
        },
        {"required": ["contextDigest", "partCount", "pendingInbox", "tasks"]},
    ]
))]
pub struct WorkflowWakeBaseline {
    #[serde(deserialize_with = "present_or_null")]
    pub checkpoint_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub checkpoint_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub context_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = 16384))]
    pub part_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_inbox: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 8))]
    pub tasks: Option<Vec<WorkflowWakeBaselineTasksItem>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowWakeBatchSummary")]
pub struct WorkflowWakeBatchSummary {
    pub id: Id,
    pub phase: WorkflowWakeBatchSummaryPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    pub created_at: Timestamp,
    pub delivery: WorkflowWakeDelivery,
    #[schemars(range(min = 1, max = 8))]
    pub notice_count: u64,
    pub native: WorkflowWakeNative,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowWakeBatch")]
pub struct WorkflowWakeBatch {
    pub id: Id,
    pub policy_id: Id,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub issuer: Id,
    pub phase: WorkflowWakeBatchSummaryPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    pub created_at: Timestamp,
    #[schemars(length(min = 1, max = 8))]
    pub notices: Vec<WorkflowWakeNotice>,
    pub receipt_id: Id,
    #[schemars(pattern("^run-wake:[a-f0-9]{32}$"))]
    pub operation_key: String,
    pub native: WorkflowWakeNative,
    pub delivery: WorkflowWakeDelivery,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(
        description = "Highest notice sequence any earlier batch claimed, which is this batch's delivery checkpoint; null for batches created before delivery checkpoints."
    )]
    pub after_sequence: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(
        description = "Latest saved checkpoint pointers when the batch was claimed. A full-delivery batch adds the current context digest, part count, unacknowledged inbox count and up to eight task key/state pairs; null for batches created before delivery checkpoints."
    )]
    pub baseline: Option<WorkflowWakeBaseline>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowWakeNotices {
    pub run: WorkflowRun,
    #[serde(deserialize_with = "present_or_null")]
    pub wake_policy: Option<WorkflowWakePolicy>,
    #[schemars(length(max = 8))]
    pub notices: Vec<WorkflowWakeNotice>,
    pub pending_count: u64,
    pub next_cursor: Cursor,
    pub more: bool,
    pub delivered_through: Cursor,
    #[schemars(length(max = 8))]
    pub batches: Vec<WorkflowWakeBatchSummary>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowWakeBatchReply {
    pub run: WorkflowRun,
    pub wake_batch: WorkflowWakeBatch,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[schemars(extend(
    "anyOf" = [
        {"required": ["messageId", "messageSequence"]},
        {"required": ["attemptId", "sessionId", "attention", "signalRevision"]},
    ]
))]
pub struct WorkflowWakeNoticeReference {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_sequence: Option<Cursor>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub task_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub attempt_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub decision_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub decision_state: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub signal_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<WorkflowWakeNoticeReferenceAttention>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowWakeBaselineTasksItem {
    #[schemars(length(min = 1, max = 128))]
    pub key: String,
    pub state: TaskState,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowWakeNoticeReferenceAttention {
    #[schemars(range(max = 3))]
    pub priority: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[schemars(range(max = 256))]
    pub blocked_children: u64,
    pub process_exited: bool,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 4294967295u64))]
    pub exit_code: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowWakeDelivery")]
pub enum WorkflowWakeDelivery {
    Delta,
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowWakePolicyPhase {
    Enabled,
    Waiting,
    Paused,
    Held,
    Disabled,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowWakeNoticeKind {
    Result,
    Decision,
    Question,
    Error,
    Blocker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowWakeBatchSummaryPhase {
    Dispatching,
    Settled,
    Failed,
    Unknown,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum TaskState {
    Planned,
    Launching,
    LaunchUnknown,
    LaunchFailed,
    Assigned,
    Reported,
    Stopped,
    Succeeded,
    Failed,
    Canceled,
}
