use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "claudeQuotaCapture")]
pub struct ClaudeQuotaCapture {
    #[schemars(
        length(min = 1, max = 4096),
        description = "Absolute host path to an explicit owner-declared Claude display manifest. Pins display executable, argv and presentation for this launch; does not inspect or modify global statusLine. Callback data is display evidence, not backend freshness or account permission."
    )]
    pub display_profile: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "runBudget")]
pub struct RunBudget {
    pub limits: RunBudgetLimits,
    #[serde(deserialize_with = "present_or_null")]
    pub started_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub deadline_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub exhausted_at: Option<u64>,
    pub time_state: RunBudgetTimeState,
    pub active_attempts: u64,
    pub owner_drain: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowDecision")]
pub struct WorkflowDecision {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub question: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub state: DecisionState,
    pub audience: Audience,
    pub asked_by: Map<String, Value>,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub answer: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub resolved_by: Option<Map<String, Value>>,
    #[serde(deserialize_with = "present_or_null")]
    pub resolved_at: Option<i64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowMessage")]
pub struct WorkflowMessage {
    pub id: String,
    #[schemars(range(min = 1))]
    pub sequence: u64,
    pub run_id: String,
    #[serde(deserialize_with = "present_or_null")]
    pub recipient_attempt_id: Option<String>,
    pub sender: WorkflowMessageSender,
    pub correlation_id: String,
    pub kind: WorkflowMessageKind,
    #[schemars(length(max = 4096))]
    pub body: String,
    #[serde(deserialize_with = "present_or_null")]
    pub payload: Option<Map<String, Value>>,
    pub created_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub acked_at: Option<i64>,
    #[serde(deserialize_with = "present_or_null")]
    pub acked_by: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowLaunch")]
pub struct WorkflowLaunch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Immutable requested task profile; null for pre-migration records. This is not a restored native grant or a claim that rejected settings were applied.", transform = nullable)]
    pub profile: Option<Option<WorkflowLaunchProfile>>,
    pub attempt_id: String,
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub receipt_id: String,
    #[schemars(length(max = 128))]
    pub operation_key: String,
    pub phase: LaunchPhase,
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub session_id: String,
    pub workspace: Workspace,
    pub created_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub code: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub effect_started: Option<bool>,
    #[serde(deserialize_with = "present_or_null")]
    pub directory: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub prepared_workspace: Option<Option<WorkflowLaunchPreparedWorkspace>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub quota_hold_reason: Option<Option<QuotaHoldReason>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowExecutor")]
pub struct WorkflowExecutor {
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub id: String,
    pub run_id: String,
    pub spec: WorkflowExecutorSpec,
    pub issuer: String,
    pub enabled: bool,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub phase: WorkflowExecutorPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub task_id: Option<String>,
    pub created_at: Timestamp,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowDelivery")]
pub struct WorkflowDelivery {
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub id: String,
    pub attempt_id: String,
    pub phase: WorkflowDeliveryPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub blocker: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub receipt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub operation_key: Option<String>,
    pub created_at: Timestamp,
    pub deadline_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub native: Option<WorkflowDeliveryNative>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub reuse: Option<Option<WorkflowDeliveryReuse>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowAttempt")]
pub struct WorkflowAttempt {
    pub id: String,
    pub task_id: String,
    #[schemars(range(min = 1, max = 16))]
    pub ordinal: u64,
    pub session_id: String,
    pub state: WorkflowAttemptState,
    #[serde(deserialize_with = "present_or_null")]
    pub result: Option<Map<String, Value>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub launch: Option<Option<WorkflowLaunch>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub delivery: Option<Option<WorkflowDelivery>>,
    #[serde(deserialize_with = "present_or_null")]
    pub validation: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowCoordinatorBinding")]
pub struct WorkflowCoordinatorBinding {
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub previous_session_id: Option<String>,
    #[schemars(length(min = 1))]
    pub directory: String,
    #[serde(deserialize_with = "present_or_null")]
    pub group_id: Option<String>,
    #[schemars(range(min = 1, max = 9007199254740991u64))]
    pub generation: u64,
    pub source: WorkflowCoordinatorBindingSource,
    pub updated_at: Timestamp,
    #[schemars(extend("const" = false))]
    pub native_effects_restored: bool,
    #[schemars(extend("const" = false))]
    pub worker_authority_restored: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(inline, transform = one_of)]
pub enum Workflow {
    Recovery(Box<WorkflowRecoveryContext>),
    Reply(Box<WorkflowReply>),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<WorkflowReplySignal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("const" = false))]
    pub native_effects_restored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("const" = false))]
    pub worker_authority_restored: Option<bool>,
    #[serde(flatten)]
    pub body: WorkflowBody,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(transform = one_of)]
pub enum WorkflowBody {
    ConstraintPage(Box<WorkflowConstraintPage>),
    CheckpointPage(Box<WorkflowCheckpointPage>),
    Context(Box<WorkflowContextReply>),
    WakeNotices(Box<WorkflowWakeNotices>),
    WakeBatch(Box<WorkflowWakeBatchReply>),
    Executor(Box<WorkflowExecutorReply>),
    RunList(Box<WorkflowRunList>),
    Digest(Box<WorkflowDigestReply>),
    RunDetail(Box<WorkflowRunDetail>),
    AttemptDecision(Box<WorkflowAttemptDecision>),
    TaskAttempt(Box<WorkflowTaskAttempt>),
    TaskAttempts(Box<WorkflowTaskAttempts>),
    DecisionPage(Box<WorkflowDecisionPage>),
    ControlPage(Box<WorkflowControlPage>),
    RunPolicy(Box<WorkflowRunPolicy>),
    HostBudget(Box<WorkflowHostBudget>),
    Mailbox(Box<WorkflowMailbox>),
    TriggerDelivery(Box<WorkflowTriggerDeliveryReply>),
    Trigger(Box<WorkflowTriggerReply>),
    TriggerPage(Box<WorkflowTriggerPage>),
    TriggerDeliveryPage(Box<WorkflowTriggerDeliveryPage>),
    Prechecks(Box<WorkflowPrechecks>),
    Jobs(Box<WorkflowJobs>),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRun {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub coordinator_binding: Option<Option<WorkflowCoordinatorBinding>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunHead {
    pub id: Value,
    pub title: Value,
    pub revision: Value,
    pub state: Value,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub coordinator_binding: Option<Option<WorkflowCoordinatorBinding>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunRevision {
    pub id: Value,
    pub revision: Value,
    pub state: Value,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub coordinator_binding: Option<Option<WorkflowCoordinatorBinding>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTaskHead {
    pub id: Value,
    pub key: Value,
    pub title: Value,
    pub instruction: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowConstraintSet {
    pub policy: WorkflowConstraintPolicy,
    #[schemars(length(max = 16))]
    pub records: Vec<WorkflowConstraint>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(transform = one_of)]
pub enum MailboxBody {
    Messages(Box<MailboxMessages>),
    Message(Box<MailboxMessage>),
    Acknowledged(Box<MailboxAcknowledged>),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct MailboxMessages {
    #[schemars(length(max = 8))]
    pub messages: Vec<WorkflowMessage>,
    pub next_cursor: Cursor,
    pub head_cursor: Cursor,
    pub pending_count: u64,
    pub more: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline, extend("required" = ["message", "cursor"]))]
pub struct MailboxMessage {
    pub message: WorkflowMessage,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline, extend("required" = ["acknowledged", "cursor"]))]
pub struct MailboxAcknowledged {
    #[schemars(length(min = 1, max = 32))]
    pub acknowledged: Vec<MailboxAck>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct MailboxAck {
    pub id: String,
    pub acked_at: Timestamp,
    pub acked_by: MailboxAckedBy,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct MailboxAckedBy {
    pub role: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowExecutorReply {
    pub run: WorkflowRun,
    #[serde(deserialize_with = "present_or_null")]
    pub executor: Option<WorkflowExecutor>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunList {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[schemars(length(max = 16))]
    pub runs: Vec<WorkflowRunListRunsItem>,
    #[serde(deserialize_with = "present_or_null")]
    pub next_offset: Option<i64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<WorkflowLaunch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<WorkflowDelivery>,
    pub run: WorkflowRunDetailRun,
    #[schemars(length(max = 64))]
    pub tasks: Vec<WorkflowRunDetailTasksItem>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTaskAttempt {
    pub run: WorkflowRunHead,
    pub task: WorkflowTaskHead,
    pub attempt: WorkflowAttempt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<WorkflowConstraintSet>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTaskAttempts {
    pub run: WorkflowRunRevision,
    pub task: WorkflowTaskAttemptsTask,
    #[schemars(length(max = 4))]
    pub attempts: Vec<WorkflowAttempt>,
    #[serde(deserialize_with = "present_or_null")]
    pub next_offset: Option<i64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowAttemptDecision {
    pub run: WorkflowRunHead,
    pub task: WorkflowAttemptDecisionTask,
    pub attempt: WorkflowAttemptDecisionAttempt,
    pub decision: WorkflowDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<WorkflowConstraintSet>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDecisionPage {
    pub run: WorkflowRunHead,
    #[schemars(length(max = 8))]
    pub decisions: Vec<WorkflowDecision>,
    #[serde(deserialize_with = "present_or_null")]
    pub next_offset: Option<i64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowControlPage {
    pub run: WorkflowRunRevision,
    pub control: WorkflowControlPageControl,
    #[schemars(length(max = 8))]
    pub targets: Vec<WorkflowControlPageTargetsItem>,
    #[serde(deserialize_with = "present_or_null")]
    pub next_offset: Option<i64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunPolicy {
    pub run: WorkflowRunRevision,
    pub policy: RunBudget,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowHostBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    pub budget: WorkflowHostBudgetBudget,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowMailbox {
    pub run: WorkflowRunHead,
    pub mailbox: WorkflowMailboxMailbox,
    #[serde(flatten)]
    pub body: MailboxBody,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RunBudgetLimits {
    #[schemars(range(min = 1, max = 16))]
    pub max_parallel: u64,
    #[schemars(range(min = 1, max = 16))]
    pub max_attempts_per_task: u64,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 1000, max = 604800000))]
    pub max_elapsed_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowMessageSender {
    pub role: ContextScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(
    inline,
    description = "Immutable requested task profile; null for pre-migration records. This is not a restored native grant or a claim that rejected settings were applied."
)]
pub struct WorkflowLaunchProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_quota_capture: Option<ClaudeQuotaCapture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowLaunchPreparedWorkspace {
    #[serde(deserialize_with = "present_or_null")]
    pub directory: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub derived_worktree: Option<bool>,
    #[serde(deserialize_with = "present_or_null")]
    pub prepared_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowExecutorSpec {
    #[schemars(length(min = 1, max = 64))]
    pub tasks: Vec<WorkflowExecutorSpecTasksItem>,
    pub retry_failed: bool,
    #[schemars(range(min = 1000, max = 60000))]
    pub retry_delay_ms: u64,
    #[schemars(range(min = 1, max = 300000))]
    pub readiness_timeout_ms: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDeliveryNative {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDeliveryReuse {
    pub previous_attempt_id: String,
    pub session_id: String,
    pub created_at: Timestamp,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowReplySignal {
    pub kind: SignalKind,
    #[schemars(length(max = 8), inner(length(min = 1, max = 64)))]
    pub options: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunListRunsItem {
    pub id: Value,
    pub title: Value,
    pub revision: Value,
    pub state: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunDetailRun {
    pub id: String,
    pub title: String,
    pub goal: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub state: RunState,
    #[serde(deserialize_with = "present_or_null")]
    pub task_result: Option<RunTaskResult>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub coordinator_binding: Option<Option<WorkflowCoordinatorBinding>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowRunDetailTasksItem {
    pub id: String,
    pub key: String,
    pub dependencies: Vec<String>,
    pub state: PlannedTaskState,
    pub dependency_state: DependencyState,
    #[schemars(range(max = 16))]
    pub attempts: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub task_result: Option<TaskResult>,
    pub title: Value,
    pub instruction: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTaskAttemptsTask {
    pub id: Value,
    pub spec: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowAttemptDecisionTask {
    pub id: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowAttemptDecisionAttempt {
    pub id: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowControlPageControl {
    pub id: Id,
    pub kind: ControlKind,
    pub state: ControlState,
    pub created_at: Timestamp,
    pub counts: BTreeMap<String, u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowControlPageTargetsItem {
    pub session_id: Id,
    pub attempt_id: Id,
    #[schemars(length(min = 1, max = 128))]
    pub operation_key: String,
    pub phase: ControlTargetPhase,
    #[serde(deserialize_with = "present_or_null")]
    pub receipt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub code: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowHostBudgetBudget {
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub limits: WorkflowHostBudgetBudgetLimits,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowMailboxMailbox {
    pub run_id: String,
    #[serde(deserialize_with = "present_or_null")]
    pub recipient_attempt_id: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowExecutorSpecTasksItem {
    pub task_id: String,
    pub profile: WorkflowExecutorSpecTasksItemProfile,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowHostBudgetBudgetLimits {
    #[schemars(range(min = 1, max = 16))]
    pub max_sessions: u64,
    #[schemars(range(max = 16))]
    pub max_workers: u64,
    pub providers: WorkflowHostBudgetBudgetLimitsProviders,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowExecutorSpecTasksItemProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_quota_capture: Option<ClaudeQuotaCapture>,
    pub program: Provider,
    pub workspace: Workspace,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub name: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub cwd: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub harness: Option<Option<bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 256))]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32))]
    pub effort: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowHostBudgetBudgetLimitsProviders {
    #[schemars(range(max = 16))]
    pub shell: u64,
    #[schemars(range(max = 16))]
    pub claude: u64,
    #[schemars(range(max = 16))]
    pub codex: u64,
    #[schemars(range(max = 16))]
    pub gemini: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RunBudgetTimeState {
    NotStarted,
    Untracked,
    Unlimited,
    Open,
    Exhausted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum DecisionState {
    Pending,
    Answered,
    Canceled,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum Audience {
    Owner,
    Coordinator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowMessageKind {
    Note,
    Question,
    Error,
    Result,
    Decision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum LaunchPhase {
    Accepted,
    Dispatching,
    Created,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum Workspace {
    Shared,
    Worktree,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum QuotaHoldReason {
    #[serde(rename = "quota_wait")]
    QuotaWait,
    #[serde(rename = "native_run_busy")]
    NativeRunBusy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowExecutorPhase {
    Enabled,
    Waiting,
    Blocked,
    Disabled,
    Paused,
    Completed,
    Scheduling,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowDeliveryPhase {
    Queued,
    Dispatching,
    Sent,
    Failed,
    Paused,
    Expired,
    Canceled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowAttemptState {
    Launching,
    LaunchFailed,
    LaunchUnknown,
    Assigned,
    Reported,
    Succeeded,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowCoordinatorBindingSource {
    RetainedSession,
    RecoveryRecord,
    PreviousBinding,
    Unbound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SignalKind {
    Blocked,
    Question,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RunState {
    Draft,
    Active,
    Draining,
    Drained,
    Stopping,
    Stopped,
    Canceling,
    Canceled,
    Succeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RunTaskResult {
    Succeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum PlannedTaskState {
    Planned,
    Launching,
    LaunchFailed,
    LaunchUnknown,
    Assigned,
    Reported,
    Succeeded,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum DependencyState {
    Ready,
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum TaskResult {
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ControlKind {
    Stop,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ControlState {
    Dispatching,
    AwaitingExit,
    Blocked,
    Unconfirmed,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ControlTargetPhase {
    Pending,
    Dispatching,
    StopRequested,
    Blocked,
    Unknown,
    Unavailable,
    Exited,
}
