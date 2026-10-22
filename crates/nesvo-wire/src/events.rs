use schemars::{JsonSchema, generate::SchemaSettings, transform::RestrictFormats};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

macro_rules! events {
    ($($variant:ident($payload:ty) = $kind:literal),+ $(,)?) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "kind", content = "payload")]
        pub enum Event {
            $(#[serde(rename = $kind)] $variant($payload),)+
        }

        impl Event {
            pub const KINDS: &'static [&'static str] = &[$($kind),+];

            pub fn kind(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $kind,)+
                }
            }

            pub fn payload(&self) -> serde_json::Result<Value> {
                match self {
                    $(Self::$variant(payload) => serde_json::to_value(payload),)+
                }
            }
        }
    };
}

events! {
    HostStarted(HostStarted) = "host.started",
    HostBudgetChanged(RevisionChanged) = "host.budget_changed",
    ProviderQuotaChanged(RevisionChanged) = "provider.quota_changed",
    SessionCreated(SessionCreated) = "session.created",
    SessionClosed(SessionClosed) = "session.closed",
    ProcessExited(ProcessExited) = "process.exited",
    ResponseSettled(ResponseSettled) = "response.settled",
    AgentLifecycle(AgentLifecycle) = "agent.lifecycle",
    AgentAttention(AgentAttention) = "agent.attention",
    OperationChanged(OperationChanged) = "operation.changed",
    JobChanged(JobChanged) = "job.changed",
    PrecheckApprovalChanged(PrecheckApprovalChanged) = "precheck.approval.changed",
    JobTriggerChanged(JobTriggerChanged) = "job.trigger_changed",
    JobTriggerDelivery(JobTriggerDelivery) = "job.trigger_delivery",
    RunCreated(RunRevision) = "run.created",
    RunPlanChanged(RunRevision) = "run.plan_changed",
    RunActivated(RunRevision) = "run.activated",
    RunAttemptAssigned(RunRevision) = "run.attempt_assigned",
    RunResultReported(RunRevision) = "run.result_reported",
    RunResultValidated(RunRevision) = "run.result_validated",
    RunDraining(RunRevision) = "run.draining",
    RunResumed(RunRevision) = "run.resumed",
    RunCheckpointSaved(RunCheckpointSaved) = "run.checkpoint_saved",
    RunConstraintsAdded(RunConstraints) = "run.constraints_added",
    RunConstraintsAcknowledged(RunConstraints) = "run.constraints_acknowledged",
    RunControlRequested(RunControl) = "run.control_requested",
    RunControlProgress(RunControl) = "run.control_progress",
    RunControlCompleted(RunControl) = "run.control_completed",
    RunControlUnconfirmed(RunControl) = "run.control_unconfirmed",
    RunCoordinatorRebound(RunCoordinatorRebound) = "run.coordinator_rebound",
    RunDecisionAsked(RunDecision) = "run.decision_asked",
    RunDecisionAnswered(RunDecision) = "run.decision_answered",
    RunDecisionCanceled(RunDecision) = "run.decision_canceled",
    RunDecisionsExpired(RunCount) = "run.decisions_expired",
    RunDeliveryChanged(RunDelivery) = "run.delivery_changed",
    RunDigestRecorded(RunDigestRecorded) = "run.digest_recorded",
    RunExecutorChanged(RunExecutor) = "run.executor_changed",
    RunMessageSent(RunMessage) = "run.message_sent",
    RunMessagesAcknowledged(RunCount) = "run.messages_acknowledged",
    RunLaunchReserved(RunAttempt) = "run.launch_reserved",
    RunLaunchRecovered(RunAttempt) = "run.launch_recovered",
    RunLaunchObserved(RunAttempt) = "run.launch_observed",
    RunWorkspacePrepared(RunAttempt) = "run.workspace_prepared",
    RunQuotaHoldChanged(RunAttempt) = "run.quota_hold_changed",
    RunSessionReused(RunSessionReused) = "run.session_reused",
    RunTimeBudgetExhausted(RunChanged) = "run.time_budget_exhausted",
    RunBudgetChanged(RunChanged) = "run.budget_changed",
    RunWakeChanged(RunWake) = "run.wake_changed",
    WorkflowTemplatesApproved(RepositoryDigest) = "workflow.templates_approved",
    WorkflowTemplatesRevoked(RepositoryDigest) = "workflow.templates_revoked",
    WorktreeSetupApproved(RepositoryDigest) = "worktree.setup_approved",
    WorktreeSetupRevoked(RepositoryDigest) = "worktree.setup_revoked",
    WorktreePrepared(WorktreePrepared) = "worktree.prepared",
    WorktreeRan(WorktreeRan) = "worktree.ran",
    WorktreeArchived(WorktreeArchived) = "worktree.archived",
}

pub fn journaled_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= 64
        && kind
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b"._".contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub sequence: u64,
    pub session_id: Option<String>,
    pub at: u64,
    #[serde(flatten)]
    pub event: Event,
}

pub fn schema() -> Value {
    let mut schema = SchemaSettings::draft07()
        .for_serialize()
        .with_transform(RestrictFormats::default())
        .into_generator()
        .into_root_schema_for::<EventRecord>();
    schema.insert("$id".into(), "urn:nesvo:harness-events:v1".into());
    schema.insert("title".into(), "Nesvo domain event record v1".into());
    schema.to_value()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    Shell,
    Claude,
    Gemini,
    Codex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Idle,
    Done,
    Blocked,
    Question,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostStarted {
    pub build_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionChanged {
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCreated {
    pub program: Program,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub parent_session_id: Option<Option<String>>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionClosed {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessExited {
    pub exit_code: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponseSettled {
    pub turn_id: String,
    pub task_result: (),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLifecycle {
    pub event: String,
    pub state: AgentState,
    pub generation: u64,
    pub source_sequence: u64,
    pub submission_evidence: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAttention {
    pub priority: u8,
    pub reason: Option<String>,
    pub blocked_children: u64,
    pub process_exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationChanged {
    pub operation_id: String,
    pub operation: String,
    pub phase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobChanged {
    pub job_id: String,
    pub occurrence_id: Option<String>,
    pub phase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrecheckApprovalChanged {
    pub approval_id: String,
    pub phase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobTriggerChanged {
    pub trigger_id: String,
    pub phase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobTriggerDelivery {
    pub trigger_id: String,
    pub delivery_id: String,
    pub disposition: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRevision {
    pub run_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCheckpointSaved {
    pub run_id: String,
    pub checkpoint_id: String,
    pub source_run_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunConstraints {
    pub run_id: String,
    pub constraint_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControl {
    pub run_id: String,
    pub control_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCoordinatorRebound {
    pub run_id: String,
    pub previous_session_id: Option<String>,
    pub session_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunDecision {
    pub run_id: String,
    pub decision_id: String,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCount {
    pub run_id: String,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunDelivery {
    pub run_id: String,
    pub delivery_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunDigestRecorded {
    pub run_id: String,
    pub revision: u64,
    pub state: String,
    pub fingerprint: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunExecutor {
    pub run_id: String,
    pub executor_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunMessage {
    pub run_id: String,
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunAttempt {
    pub run_id: String,
    pub attempt_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSessionReused {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub previous_attempt_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunChanged {
    pub run_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunWake {
    pub run_id: String,
    pub policy_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryDigest {
    pub repository: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreePrepared {
    pub session_id: String,
    pub result: String,
    pub log: String,
    pub worktree: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRan {
    pub session_id: String,
    pub result: String,
    pub log: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeArchived {
    pub session_id: String,
    pub worktree: String,
    pub branch: Option<String>,
    pub discarded: bool,
    pub blockers: Vec<String>,
    pub branch_deleted: bool,
}
