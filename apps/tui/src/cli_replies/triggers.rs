use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobTriggerSpec")]
pub struct JobTriggerSpec {
    #[schemars(length(min = 1, max = 80))]
    pub title: String,
    pub job_id: Id,
    #[schemars(range(min = 1))]
    pub job_revision: u64,
    pub adapter: TriggerAdapter,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobTrigger")]
pub struct JobTrigger {
    pub id: Id,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub enabled: bool,
    pub revoked: bool,
    #[schemars(range(min = 1))]
    pub credential_generation: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub spec: JobTriggerSpec,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobTriggerDelivery")]
pub struct JobTriggerDelivery {
    pub id: Id,
    pub trigger_id: Id,
    #[schemars(length(min = 1, max = 128))]
    pub delivery_id: String,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub body_digest: String,
    #[schemars(range(min = 1))]
    pub credential_generation: u64,
    #[schemars(range(min = 1))]
    pub trigger_revision: u64,
    pub job_id: Id,
    #[schemars(range(min = 1))]
    pub job_revision: u64,
    pub accepted_at: Timestamp,
    pub disposition: JobTriggerDeliveryDisposition,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub occurrence_id: Option<Id>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTriggerReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    pub trigger: JobTrigger,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTriggerPage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[schemars(length(max = 16))]
    pub triggers: Vec<JobTrigger>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 4096))]
    pub next_offset: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowTriggerDeliveryPage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[schemars(length(max = 16))]
    pub deliveries: Vec<JobTriggerDelivery>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 4096))]
    pub next_offset: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[schemars(extend("not" = {"anyOf": [{"required": ["run"]}, {"required": ["tasks"]}]}))]
pub struct WorkflowTriggerDeliveryReply {
    pub delivery: JobTriggerDelivery,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[schemars(inline)]
pub enum TriggerAdapter {
    Webhook(WebhookAdapter),
    Github(GithubAdapter),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WebhookAdapter {
    #[schemars(length(min = 1, max = 64), pattern("^[A-Za-z0-9_.:-]+$"))]
    pub event: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[schemars(extend(
    "oneOf" = [
        {"properties": {"event": {"const": "push"}, "actions": {"maxItems": 0}}},
        {
            "properties": {
                "event": {"const": "pull_request"},
                "actions": {
                    "minItems": 1,
                    "items": {
                        "enum": [
                            "assigned",
                            "unassigned",
                            "labeled",
                            "unlabeled",
                            "opened",
                            "edited",
                            "closed",
                            "reopened",
                            "synchronize",
                            "converted_to_draft",
                            "locked",
                            "unlocked",
                            "enqueued",
                            "dequeued",
                            "milestoned",
                            "demilestoned",
                            "ready_for_review",
                            "review_requested",
                            "review_request_removed",
                            "auto_merge_enabled",
                            "auto_merge_disabled",
                        ],
                    },
                },
            },
        },
        {"properties": {"event": {"const": "workflow_run"}, "actions": {"const": ["completed"]}}},
    ]
))]
pub struct GithubAdapter {
    #[schemars(range(min = 1))]
    pub repository_id: u64,
    #[schemars(length(max = 201))]
    pub repository: String,
    pub event: GithubEvent,
    #[schemars(length(max = 16), extend("uniqueItems" = true), inner(length(min = 1, max = 64)))]
    pub actions: Vec<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 255), pattern(r"^\S+$"))]
    pub branch: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum GithubEvent {
    Push,
    PullRequest,
    WorkflowRun,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobTriggerDeliveryDisposition {
    Queued,
    Skipped,
    Ignored,
}
