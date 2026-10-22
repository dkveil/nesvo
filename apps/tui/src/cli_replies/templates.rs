use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "workflowTemplate")]
pub struct WorkflowTemplate {
    #[schemars(pattern("^[A-Za-z0-9_-]{1,64}$"))]
    pub name: String,
    #[schemars(length(min = 1, max = 80))]
    pub title: String,
    #[schemars(length(min = 1, max = 8192))]
    pub goal: String,
    pub start: TemplateStart,
    #[serde(deserialize_with = "present_or_null")]
    pub budget: Option<WorkflowTemplateBudget>,
    #[schemars(length(min = 1, max = 64))]
    pub tasks: Vec<WorkflowTemplateTasksItem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplatesReply {
    pub repository: String,
    #[schemars(extend("const" = "HEAD:nesvo.toml"))]
    pub source: String,
    pub configured: bool,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: Option<String>,
    pub approved: bool,
    #[schemars(length(max = 32))]
    pub templates: Vec<WorkflowTemplate>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplatesApprovedReply {
    pub repository: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    pub approved_at: Timestamp,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplatesRevokedReply {
    pub repository: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    pub revoked: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplateStartedReply {
    #[schemars(pattern("^[A-Za-z0-9_-]{1,64}$"))]
    pub template: String,
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: String,
    #[schemars(length(min = 1, max = 96))]
    pub key: String,
    pub start: TemplateStart,
    pub run: WorkflowTemplateStartedReplyRun,
    #[schemars(length(max = 64))]
    pub tasks: Vec<WorkflowTemplateStartedReplyTasksItem>,
    #[schemars(length(max = 64))]
    pub profiles: Vec<WorkflowTemplateStartedReplyProfilesItem>,
    #[serde(deserialize_with = "present_or_null")]
    pub executor: Option<WorkflowExecutor>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplateBudget {
    #[schemars(range(min = 1, max = 16))]
    pub max_parallel: u64,
    #[schemars(range(min = 1, max = 16))]
    pub max_attempts_per_task: u64,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 1000, max = 604800000))]
    pub max_elapsed_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplateTasksItem {
    #[schemars(pattern("^[A-Za-z0-9_-]{1,64}$"))]
    pub key: String,
    #[schemars(length(min = 1, max = 80))]
    pub title: String,
    #[schemars(length(min = 1, max = 8192))]
    pub instruction: String,
    #[schemars(length(max = 64), inner(pattern("^[A-Za-z0-9_-]{1,64}$")))]
    pub dependencies: Vec<String>,
    pub program: Provider,
    pub workspace: Workspace,
    #[serde(deserialize_with = "present_or_null")]
    pub harness: Option<bool>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 32), inner(length(max = 128), pattern("^nesvo_[a-z_]+$")))]
    pub allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 8), inner(length(min = 1, max = 256)))]
    pub checks: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTemplateStartedReplyRun {
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
pub struct WorkflowTemplateStartedReplyTasksItem {
    pub id: Value,
    pub key: Value,
    pub state: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WorkflowTemplateStartedReplyProfilesItem {
    pub task_id: Id,
    pub profile: WorkflowTemplateStartedReplyProfilesItemProfile,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTemplateStartedReplyProfilesItemProfile {
    pub program: Value,
    pub workspace: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum TemplateStart {
    Draft,
    Active,
    Executor,
}
