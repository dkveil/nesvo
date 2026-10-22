use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[schemars(extend("anyOf" = [{"required": ["sessionId"]}, {"required": ["reviewId"]}]))]
pub struct DiffReply {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub session_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<Id>,
    pub review: DiffReplyReview,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewOpenedReply {
    pub review_id: Id,
    pub directory: String,
    pub source: ReviewOpenedReplySource,
    #[serde(deserialize_with = "present_or_null")]
    pub base: Option<ReviewOpenedReplyBase>,
    pub head: ReviewOpenedReplyHead,
    pub scope: ReviewScope,
    #[schemars(length(min = 1, max = 64))]
    pub revision: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub checks: Option<Option<ReviewOpenedReplyChecks>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewDeliveredReply {
    pub review_id: Id,
    pub session_id: Id,
    pub path: DeliveryPath,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(length(max = 128), transform = nullable)]
    pub key: Option<Option<String>>,
    #[schemars(range(min = 1, max = 32768))]
    pub bytes: u64,
    pub receipt: DeliveredReceipt,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DiffReplyReview {
    pub directory: String,
    pub scope: DiffScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub revision: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub head: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<DiffReplyReviewBase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<DiffReplyReviewRange>,
    pub files: Vec<Value>,
    pub truncated: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewOpenedReplySource {
    pub kind: ReviewSourceKind,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 1024))]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewOpenedReplyBase {
    pub r#ref: String,
    pub oid: String,
    pub merge_base: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewOpenedReplyHead {
    pub r#ref: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub oid: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ReviewOpenedReplyChecks {
    pub head_oid: String,
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub pending: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DiffReplyReviewBase {
    pub r#ref: String,
    pub oid: String,
    pub merge_base: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DiffReplyReviewRange {
    pub from: String,
    pub to: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ReviewScope {
    Branch,
    Unstaged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum DeliveryPath {
    Operation,
    Paste,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum DiffScope {
    Staged,
    Unstaged,
    Untracked,
    Branch,
    Commits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ReviewSourceKind {
    Local,
    Pull,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(inline)]
pub enum DeliveredReceipt {
    Operation(Receipt),
    Paste(PasteReceipt),
}
