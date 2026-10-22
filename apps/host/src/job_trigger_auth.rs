use crate::{
    api_error::Error,
    job_triggers::{Adapter, Inbound},
};
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

pub const MAX_BODY: usize = 256 * 1024;

pub fn event_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}
pub fn delivery_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_graphic() && b != b',')
}
pub fn secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn digest(bytes: &[u8]) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}
pub fn unauthorized() -> anyhow::Error {
    Error::new(
        "trigger_unauthorized",
        "External trigger authentication is unavailable or invalid",
    )
    .into()
}
fn malformed() -> anyhow::Error {
    Error::new(
        "invalid_argument",
        "External delivery does not match its bounded provider payload contract",
    )
    .into()
}
pub fn verify(secret: &str, inbound: &Inbound) -> Result<()> {
    let signature = inbound
        .signature
        .strip_prefix("sha256=")
        .filter(|s| self::secret(s))
        .ok_or_else(unauthorized)?;
    let signature = hex::decode(signature).map_err(|_| unauthorized())?;
    ring::hmac::verify(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes()),
        &inbound.body,
        &signature,
    )
    .map_err(|_| unauthorized())
}

pub struct Parsed {
    pub matches: bool,
    pub sent_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Generic {
    schema_version: u8,
    id: String,
    event: String,
    sent_at: u64,
    payload: Value,
}

fn text<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= limit && !v.chars().any(char::is_control))
        .ok_or_else(malformed)
}
fn positive(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(malformed)
}

pub fn pull_request_action(action: &str) -> bool {
    matches!(
        action,
        "assigned"
            | "unassigned"
            | "labeled"
            | "unlabeled"
            | "opened"
            | "edited"
            | "closed"
            | "reopened"
            | "synchronize"
            | "converted_to_draft"
            | "locked"
            | "unlocked"
            | "enqueued"
            | "dequeued"
            | "milestoned"
            | "demilestoned"
            | "ready_for_review"
            | "review_requested"
            | "review_request_removed"
            | "auto_merge_enabled"
            | "auto_merge_disabled"
    )
}
fn sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn push_shape(body: &Value) -> Result<()> {
    let before = text(body, "before", 64)?;
    let after = text(body, "after", 64)?;
    if !sha(before)
        || !sha(after)
        || before.len() != after.len()
        || ["created", "deleted", "forced"]
            .iter()
            .any(|key| body.get(key).and_then(Value::as_bool).is_none())
    {
        return Err(malformed());
    }
    let commits = body
        .get("commits")
        .and_then(Value::as_array)
        .filter(|c| c.len() <= 2048)
        .ok_or_else(malformed)?;
    for commit in commits {
        let id = text(commit, "id", 64)?;
        if !sha(id) || id.len() != after.len() {
            return Err(malformed());
        }
    }
    match body.get("head_commit") {
        Some(Value::Null) => {}
        Some(commit) if commit.is_object() && text(commit, "id", 64)? == after => {}
        _ => return Err(malformed()),
    }
    Ok(())
}

pub fn parse(adapter: &Adapter, inbound: &Inbound) -> Result<Parsed> {
    match adapter {
        Adapter::Webhook { event } => {
            let body: Generic = serde_json::from_slice(&inbound.body).map_err(|_| malformed())?;
            if body.schema_version != 1
                || !delivery_id(&body.id)
                || !event_name(&body.event)
                || body.id != inbound.delivery_id
                || body.event != inbound.event
            {
                return Err(malformed());
            }
            let _ = body.payload;
            Ok(Parsed {
                matches: body.event == *event,
                sent_at: Some(body.sent_at),
            })
        }
        Adapter::Github {
            repository_id,
            repository,
            event,
            actions,
            branch,
        } => {
            let body: Value = serde_json::from_slice(&inbound.body).map_err(|_| malformed())?;
            let repo = body
                .get("repository")
                .filter(|v| v.is_object())
                .ok_or_else(malformed)?;
            let repo_id = positive(repo, "id")?;
            let repo_name = text(repo, "full_name", 201)?;
            let (action, source_branch) = match inbound.event.as_str() {
                "push" => {
                    if body.get("action").is_some()
                        || body.get("pull_request").is_some()
                        || body.get("workflow_run").is_some()
                    {
                        return Err(malformed());
                    }
                    push_shape(&body)?;
                    let reference = text(&body, "ref", 512)?;
                    let branch = reference
                        .strip_prefix("refs/heads/")
                        .filter(|v| !v.is_empty());
                    let tag = reference
                        .strip_prefix("refs/tags/")
                        .filter(|v| !v.is_empty());
                    if branch.is_none() && tag.is_none() {
                        return Err(malformed());
                    }
                    (None, branch)
                }
                "pull_request" => {
                    positive(&body, "number")?;
                    let action = text(&body, "action", 64)?;
                    if !pull_request_action(action)
                        || ["review", "comment", "thread", "workflow_run", "issue"]
                            .iter()
                            .any(|key| body.get(key).is_some())
                    {
                        return Err(malformed());
                    }
                    let request = body
                        .get("pull_request")
                        .filter(|v| v.is_object())
                        .ok_or_else(malformed)?;
                    let base = request
                        .get("base")
                        .filter(|v| v.is_object())
                        .ok_or_else(malformed)?;
                    (Some(action), Some(text(base, "ref", 255)?))
                }
                "workflow_run" => {
                    let action = text(&body, "action", 64)?;
                    if !matches!(action, "requested" | "in_progress" | "completed") {
                        return Err(malformed());
                    }
                    let run = body
                        .get("workflow_run")
                        .filter(|v| v.is_object())
                        .ok_or_else(malformed)?;
                    positive(run, "id")?;
                    if action == "completed" && text(run, "status", 64)? != "completed" {
                        return Err(malformed());
                    }
                    (Some(action), Some(text(run, "head_branch", 255)?))
                }
                _ => return Err(malformed()),
            };
            let matches = inbound.event == *event
                && repo_id == *repository_id
                && repo_name == repository
                && branch
                    .as_deref()
                    .is_none_or(|expected| source_branch == Some(expected))
                && action.is_none_or(|action| actions.iter().any(|allowed| allowed == action));
            Ok(Parsed {
                matches,
                sent_at: None,
            })
        }
    }
}
