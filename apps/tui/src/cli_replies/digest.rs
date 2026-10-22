use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "workflowDigest")]
pub struct WorkflowDigest {
    #[schemars(extend("const" = 1))]
    pub schema_version: u64,
    pub kind: WorkflowDigestKind,
    pub run_id: String,
    pub title: String,
    pub state: String,
    #[schemars(range(min = 1))]
    pub source_revision: u64,
    pub produced_at: u64,
    pub tasks: WorkflowDigestTasks,
    #[schemars(length(max = 64))]
    pub task_digests: Vec<WorkflowDigestTaskDigestsItem>,
    pub omitted_tasks: u64,
    pub truncated: bool,
    pub decisions: WorkflowDigestDecisions,
    #[schemars(length(max = 4))]
    pub open_decisions: Vec<Value>,
    pub budget: Map<String, Value>,
    pub inbox: WorkflowDigestInbox,
    pub evidence: WorkflowDigestEvidence,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestReply {
    pub run: WorkflowRunHead,
    pub digest: WorkflowDigest,
    #[schemars(length(min = 64, max = 64))]
    pub fingerprint: String,
    pub stored: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestTasks {
    #[schemars(range(max = 64))]
    pub total: u64,
    pub by_state: BTreeMap<String, u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestTaskDigestsItem {
    pub id: String,
    pub key: String,
    pub state: String,
    #[serde(deserialize_with = "present_or_null")]
    pub attempt: Option<Map<String, Value>>,
    #[serde(deserialize_with = "present_or_null")]
    pub outcome: Option<ReportedOutcome>,
    #[serde(deserialize_with = "present_or_null")]
    pub validation: Option<Map<String, Value>>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 240))]
    pub summary: Option<String>,
    #[schemars(length(max = 4))]
    pub files: Vec<String>,
    pub files_total: u64,
    pub checks: WorkflowDigestTaskDigestsItemChecks,
    pub limitations: u64,
    #[schemars(length(max = 3))]
    pub next_steps: Vec<String>,
    pub decisions_answered: u64,
    pub native_operations: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub workspace: Option<WorkflowDigestTaskDigestsItemWorkspace>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestDecisions {
    pub total: Value,
    pub pending: Value,
    pub answered: Value,
    pub closed: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestInbox {
    pub pending_coordinator_messages: Value,
    pub message_head: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestEvidence {
    pub journal_cursor: u64,
    pub checkpoint_count: u64,
    #[schemars(length(max = 4))]
    pub checkpoints: Vec<Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestTaskDigestsItemChecks {
    pub passed: Value,
    pub failed: Value,
    pub skipped: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowDigestTaskDigestsItemWorkspace {
    pub kind: Workspace,
    #[serde(deserialize_with = "present_or_null")]
    pub directory: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub branch: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorkflowDigestKind {
    Final,
    WorkingState,
}
