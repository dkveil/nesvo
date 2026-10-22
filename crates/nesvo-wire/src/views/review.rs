use super::{Tolerant, lenient};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewSourceKind {
    Local,
    Pull,
    #[serde(untagged)]
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    pub kind: ReviewSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl ReviewSource {
    fn new(kind: ReviewSourceKind) -> Self {
        Self {
            kind,
            session_id: None,
            url: None,
            owner: None,
            repo: None,
            number: None,
            title: None,
            rest: Map::new(),
        }
    }

    pub fn local(session_id: &str) -> Self {
        Self {
            session_id: Some(session_id.to_owned()),
            ..Self::new(ReviewSourceKind::Local)
        }
    }

    pub fn pull(url: &str) -> Self {
        Self {
            url: Some(url.to_owned()),
            ..Self::new(ReviewSourceKind::Pull)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct BaseInfo {
    #[serde(rename = "ref")]
    pub name: String,
    pub oid: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct HeadInfo {
    #[serde(default, rename = "ref")]
    pub name: Option<String>,
    #[serde(default)]
    pub oid: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub pending: u64,
    #[serde(default)]
    pub current: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenedScope {
    Branch,
    Unstaged,
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOpened {
    pub review_id: String,
    pub directory: String,
    pub source: ReviewSource,
    #[serde(default)]
    pub base: Option<BaseInfo>,
    #[serde(default)]
    pub head: HeadInfo,
    pub scope: OpenedScope,
    pub revision: String,
    #[serde(default)]
    pub checks: Option<Checks>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct BaseRelation {
    #[serde(default)]
    pub behind: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Readiness {
    #[serde(default)]
    pub blockers: Vec<String>,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base: Option<BaseRelation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ProvenanceFile {
    pub path: String,
    pub attribution: String,
    #[serde(default, rename = "thisTurn")]
    pub this_turn: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Provenance {
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub files: Vec<ProvenanceFile>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ReviewContext {
    pub readiness: Readiness,
    #[serde(default)]
    pub provenance: Option<Provenance>,
    #[serde(default)]
    pub checks: Option<Checks>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ReviewData {
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    pub files: Vec<FileDiff>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub patch: String,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReply {
    #[serde(default, deserialize_with = "lenient")]
    pub request_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub session_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub review_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub error: Option<String>,
    #[serde(default)]
    pub review: Tolerant<ReviewData>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ReviewProgress {
    #[serde(default, deserialize_with = "lenient")]
    pub stage: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryPath {
    Paste,
    Operation,
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReceipt {
    #[serde(default, deserialize_with = "lenient")]
    pub id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub operation_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDelivered {
    #[serde(default, deserialize_with = "lenient")]
    pub path: Option<DeliveryPath>,
    #[serde(default, deserialize_with = "lenient")]
    pub bytes: Option<u64>,
    #[serde(default, deserialize_with = "lenient")]
    pub receipt: DeliveryReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "openReview")]
pub struct OpenReview<'a> {
    pub source: &'a ReviewSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "getDiff", rename_all = "camelCase")]
pub struct ReviewDiffRequest<'a> {
    pub review_id: &'a str,
    pub scope: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "getDiff", rename_all = "camelCase")]
pub struct SessionDiffRequest<'a> {
    pub session_id: &'a str,
    pub scope: &'a str,
    pub directory: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "reviewContext", rename_all = "camelCase")]
pub struct ReviewContextRequest<'a> {
    pub review_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "deliverReview", rename_all = "camelCase")]
pub struct DeliverReview<'a> {
    pub review_id: &'a str,
    pub session_id: &'a str,
    pub text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "watchReviews")]
pub struct WatchReviews {}
