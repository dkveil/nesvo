use super::{Tolerant, lenient};
use serde::{Deserialize, Serialize, de::IgnoredAny};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub revision: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub goal: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    #[serde(default, deserialize_with = "lenient")]
    pub runs: Vec<Tolerant<RunSummary>>,
    #[serde(default, deserialize_with = "lenient")]
    pub next_offset: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyState {
    Ready,
    Waiting,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAttempt {
    pub ordinal: u64,
    pub session_id: String,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTask {
    pub id: String,
    pub key: String,
    pub state: String,
    pub dependency_state: DependencyState,
    pub attempts: u64,
    pub current_attempt: Option<RunAttempt>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct RunView {
    #[serde(default)]
    pub run: Tolerant<RunSummary>,
    #[serde(default, deserialize_with = "lenient")]
    pub tasks: Vec<Tolerant<RunTask>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionState {
    Pending,
    Answered,
    Canceled,
    Expired,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub task_id: String,
    pub audience: String,
    pub question: String,
    pub revision: u64,
    pub state: DecisionState,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionPage {
    #[serde(default, deserialize_with = "lenient")]
    pub decisions: Vec<Tolerant<Decision>>,
    #[serde(default, deserialize_with = "lenient")]
    pub next_offset: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct InboxMessage {
    pub kind: String,
    pub body: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    #[serde(default, deserialize_with = "lenient")]
    pub pending_count: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub messages: Vec<Tolerant<InboxMessage>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct DigestStates {
    #[serde(default, deserialize_with = "lenient")]
    pub succeeded: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestTasks {
    #[serde(default, deserialize_with = "lenient")]
    pub total: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub by_state: DigestStates,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct DigestWorkspace {
    #[serde(default, deserialize_with = "lenient")]
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDigest {
    #[serde(default, deserialize_with = "lenient")]
    pub key: String,
    #[serde(default, deserialize_with = "lenient")]
    pub next_steps: Vec<Tolerant<String>>,
    #[serde(default, deserialize_with = "lenient")]
    pub workspace: Option<DigestWorkspace>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct DigestDecisions {
    #[serde(default, deserialize_with = "lenient")]
    pub pending: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub answered: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestBudget {
    #[serde(default, deserialize_with = "lenient")]
    pub time_state: String,
    #[serde(default, deserialize_with = "lenient")]
    pub active_attempts: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestEvidence {
    #[serde(default, deserialize_with = "lenient")]
    pub journal_cursor: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub checkpoint_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDigest {
    #[serde(default, deserialize_with = "lenient")]
    pub kind: String,
    #[serde(default, deserialize_with = "lenient")]
    pub source_revision: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub tasks: DigestTasks,
    #[serde(default, deserialize_with = "lenient")]
    pub task_digests: Vec<Tolerant<TaskDigest>>,
    #[serde(default, deserialize_with = "lenient")]
    pub omitted_tasks: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub decisions: DigestDecisions,
    #[serde(default, deserialize_with = "lenient")]
    pub budget: DigestBudget,
    #[serde(default, deserialize_with = "lenient")]
    pub evidence: DigestEvidence,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct DigestReply {
    #[serde(default, deserialize_with = "lenient")]
    pub digest: RunDigest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeDelivery {
    Delta,
    Full,
    #[serde(untagged)]
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakePolicy {
    pub enabled: bool,
    #[serde(default)]
    pub held: bool,
    pub phase: String,
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub delivery: Option<WakeDelivery>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeBatchPhase {
    Dispatching,
    Settled,
    Failed,
    Unknown,
    Interrupted,
    #[serde(untagged)]
    Other(String),
}

impl WakeBatchPhase {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Dispatching => "dispatching",
            Self::Settled => "settled",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
            Self::Interrupted => "interrupted",
            Self::Other(phase) => phase,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeBatch {
    pub id: String,
    pub phase: WakeBatchPhase,
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub delivery: Option<WakeDelivery>,
    #[serde(default, deserialize_with = "lenient")]
    pub notice_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeState {
    #[serde(default, deserialize_with = "lenient")]
    pub wake_policy: Option<WakePolicy>,
    #[serde(default, deserialize_with = "lenient")]
    pub pending_count: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub delivered_through: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub batches: Vec<Tolerant<WakeBatch>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WorkflowTemplate {
    pub name: String,
    pub title: String,
    pub start: String,
    pub tasks: Vec<IgnoredAny>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct WorkflowTemplates {
    #[serde(default, deserialize_with = "lenient")]
    pub repository: String,
    #[serde(default, deserialize_with = "lenient")]
    pub digest: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub approved: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub templates: Vec<Tolerant<WorkflowTemplate>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct StartedRun {
    #[serde(default, deserialize_with = "lenient")]
    pub id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct RunChanged {
    #[serde(default, deserialize_with = "lenient")]
    pub run: StartedRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InboxRequest {
    Read { run_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DecisionRequest {
    List {
        run_id: String,
        offset: u64,
    },
    Answer {
        key: String,
        run_id: String,
        decision_id: String,
        expected_revision: u64,
        answer: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WakeRequest {
    Get {
        run_id: String,
        after: Option<u64>,
    },
    Enable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Pause {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Resume {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    SetDelivery {
        key: String,
        run_id: String,
        expected_revision: u64,
        delivery: WakeDelivery,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Stop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ControlRequest {
    Start {
        key: String,
        run_id: String,
        expected_revision: u64,
        kind: ControlKind,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum RunCall {
    List {
        offset: u64,
    },
    Get {
        run_id: String,
    },
    Digest {
        run_id: String,
    },
    Inbox {
        request: InboxRequest,
    },
    Decision {
        request: DecisionRequest,
    },
    Wakes {
        request: WakeRequest,
    },
    Control {
        request: ControlRequest,
    },
    Resume {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Drain {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
}

impl RunCall {
    pub fn action(&self) -> &'static str {
        match self {
            Self::List { .. } => "list",
            Self::Get { .. } => "get",
            Self::Digest { .. } => "digest",
            Self::Inbox { .. } => "inbox",
            Self::Decision { .. } => "decision",
            Self::Wakes { .. } => "wakes",
            Self::Control { .. } => "control",
            Self::Resume { .. } => "resume",
            Self::Drain { .. } => "drain",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TemplateRequest<'a> {
    ListWorkflowTemplates {
        directory: &'a str,
    },
    ApproveWorkflowTemplates {
        directory: &'a str,
        digest: &'a str,
    },
    RevokeWorkflowTemplates {
        directory: &'a str,
        digest: &'a str,
    },
    StartWorkflowTemplate {
        directory: &'a str,
        name: &'a str,
        key: &'a str,
    },
}

impl TemplateRequest<'_> {
    pub fn reply(&self) -> &'static str {
        match self {
            Self::ListWorkflowTemplates { .. } => "workflowTemplates",
            Self::ApproveWorkflowTemplates { .. } => "workflowTemplatesApproved",
            Self::RevokeWorkflowTemplates { .. } => "workflowTemplatesRevoked",
            Self::StartWorkflowTemplate { .. } => "workflowTemplateStarted",
        }
    }
}
