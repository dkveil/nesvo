use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeSetupReply {
    pub repository: String,
    pub configured: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub config: Option<WorktreeSetupReplyConfig>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: Option<String>,
    pub approved: bool,
    pub policy: WorktreeSetupReplyPolicy,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeSetupApprovedReply {
    pub repository: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    pub approved_at: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeSetupRevokedReply {
    pub repository: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    pub revoked: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRunStartedReply {
    pub session_id: Id,
    pub worktree: String,
    pub log: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeCancelledReply {
    pub session_id: Id,
    pub cancelled: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeArchivedReply {
    pub session_id: Id,
    pub worktree: String,
    #[serde(deserialize_with = "present_or_null")]
    pub branch: Option<String>,
    pub discarded: bool,
    pub blockers: Vec<ArchiveBlocker>,
    pub branch_deleted: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRegistryReply {
    #[schemars(length(max = 128))]
    pub worktrees: Vec<WorktreeRegistryReplyWorktreesItem>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorktreeSetupReplyConfig {
    #[schemars(length(max = 32), inner(length(min = 1, max = 4096)))]
    pub setup: Vec<String>,
    #[schemars(length(max = 32), inner(length(min = 1, max = 4096)))]
    pub run: Vec<String>,
    #[schemars(length(max = 32), inner(length(min = 1, max = 512)))]
    pub env_files: Vec<String>,
    #[schemars(range(min = 1, max = 3600))]
    pub timeout_s: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeSetupReplyPolicy {
    #[schemars(extend("const" = 1))]
    pub version: u64,
    #[schemars(extend("const" = "platform-shell-v1"))]
    pub shell: String,
    #[schemars(extend("const" = "HEAD:nesvo.toml"))]
    pub source: String,
    #[schemars(extend("const" = 65536))]
    pub log_limit: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRegistryReplyWorktreesItem {
    pub session_id: Id,
    pub worktree: String,
    #[serde(deserialize_with = "present_or_null")]
    pub branch: Option<String>,
    pub repository: String,
    pub created_at: u64,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: Option<String>,
    pub setup: WorktreeRegistryReplyWorktreesItemSetup,
    #[serde(deserialize_with = "present_or_null")]
    pub run: Option<WorktreeRegistryReplyWorktreesItemRun>,
    pub env_files: Vec<WorktreeRegistryReplyWorktreesItemEnvFilesItem>,
    #[serde(deserialize_with = "present_or_null")]
    pub archived_at: Option<u64>,
    pub discarded: bool,
    pub present: bool,
    pub session_live: bool,
    pub active: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRegistryReplyWorktreesItemSetup {
    pub state: WorktreeStepState,
    #[serde(deserialize_with = "present_or_null")]
    pub log: Option<String>,
    pub started_at: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub finished_at: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRegistryReplyWorktreesItemRun {
    pub state: WorktreeStepState,
    #[serde(deserialize_with = "present_or_null")]
    pub log: Option<String>,
    pub started_at: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub finished_at: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorktreeRegistryReplyWorktreesItemEnvFilesItem {
    pub path: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub sha256: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ArchiveBlocker {
    Conflicts,
    Dirty,
    Unpushed,
    Unborn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WorktreeStepState {
    NotConfigured,
    Running,
    Passed,
    Failed,
    TimedOut,
    Cancelled,
    Interrupted,
}
