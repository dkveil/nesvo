use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "attentionItem")]
pub struct AttentionItem {
    #[schemars(length(max = 200), pattern("^(session|decision|run|result):"))]
    pub id: String,
    pub kind: AttentionItemKind,
    pub revision: Cursor,
    #[schemars(range(min = 1, max = 3))]
    pub priority: u64,
    pub reason: String,
    pub at: Cursor,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<Provider>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub run_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<Audience>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence_id: Option<Id>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "attentionReceipt")]
pub struct AttentionReceipt {
    #[schemars(length(max = 200))]
    pub id: String,
    pub revision: Cursor,
    pub acknowledged_at: Timestamp,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct AttentionInboxReply {
    #[schemars(length(max = 32))]
    pub items: Vec<AttentionItem>,
    #[schemars(range(max = 1024))]
    pub page: u64,
    #[schemars(range(min = 1, max = 32))]
    pub limit: u64,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 1))]
    pub next_page: Option<u64>,
    pub total: Cursor,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct InboxAcknowledgedReply {
    #[schemars(length(min = 1, max = 32))]
    pub acknowledged: Vec<AttentionReceipt>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DecisionsReply {
    #[schemars(length(max = 8))]
    pub decisions: Vec<InboxDecision>,
    #[schemars(range(max = 512))]
    pub page: u64,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 1))]
    pub next_page: Option<u64>,
    pub total: Cursor,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DecidedReply {
    pub run: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Map<String, Value>>,
    #[schemars(transform = answered)]
    pub decision: WorkflowDecision,
    pub cursor: Cursor,
    #[schemars(pattern("^decision:"))]
    pub inbox_id: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct InboxDecision {
    #[schemars(pattern("^decision:"))]
    pub inbox_id: String,
    pub run: InboxDecisionRun,
    #[serde(flatten)]
    pub decision: WorkflowDecision,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct InboxDecisionRun {
    pub id: Id,
    pub title: String,
    pub state: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

fn answered(schema: &mut Schema) {
    *schema = schemars::json_schema!({
        "allOf": [schema.clone(), {"type": "object", "properties": {"state": {"const": "answered"}}}]
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum AttentionItemKind {
    Session,
    Decision,
    Run,
    Result,
}
