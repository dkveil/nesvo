//! Owner trigger DTOs; external HTTP never receives owner authority.
use crate::{cli, workflow};
use anyhow::Result;
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Args)]
pub struct Mutation {
    id: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    revision: u64,
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
pub enum Command {
    /// Register a disabled trigger. The separate secret is read only from a file.
    Create {
        #[arg(long)]
        key: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        secret_file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Reauthorize current job intent/filter; accepted deliveries remain immutable.
    Edit {
        #[command(flatten)]
        mutation: Mutation,
        #[arg(long)]
        file: PathBuf,
    },
    Enable(Mutation),
    Disable(Mutation),
    /// Permanently revoke new ingress, preserving history and admitted work.
    Revoke(Mutation),
    /// Retire the former secret. This never replays delivery or grants new job intent.
    Rotate {
        #[command(flatten)]
        mutation: Mutation,
        #[arg(long)]
        secret_file: PathBuf,
    },
    Deliveries {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    Delivery {
        id: String,
        delivery_id: String,
        #[arg(long)]
        json: bool,
    },
    Mutation {
        #[arg(long)]
        key: String,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Create { json, .. }
            | Self::Show { json, .. }
            | Self::List { json, .. }
            | Self::Deliveries { json, .. }
            | Self::Delivery { json, .. }
            | Self::Mutation { json, .. } => *json,
            Self::Enable(m)
            | Self::Disable(m)
            | Self::Revoke(m)
            | Self::Edit { mutation: m, .. }
            | Self::Rotate { mutation: m, .. } => m.json,
        }
    }
    pub fn request(self) -> Result<Request> {
        let request = match self {
            Self::Create {
                key,
                file,
                secret_file,
                ..
            } => Request::Create {
                key,
                spec: read_spec(&file)?,
                secret: read_secret(&secret_file)?,
            },
            Self::Show { id, .. } => Request::Get { id },
            Self::List { offset, .. } => Request::List { offset },
            Self::Edit { mutation: m, file } => Request::Update {
                key: m.key,
                id: m.id,
                expected_revision: m.revision,
                spec: read_spec(&file)?,
            },
            Self::Enable(m) => Request::SetEnabled {
                key: m.key,
                id: m.id,
                expected_revision: m.revision,
                enabled: true,
            },
            Self::Disable(m) => Request::SetEnabled {
                key: m.key,
                id: m.id,
                expected_revision: m.revision,
                enabled: false,
            },
            Self::Revoke(m) => Request::Revoke {
                key: m.key,
                id: m.id,
                expected_revision: m.revision,
            },
            Self::Rotate {
                mutation: m,
                secret_file,
            } => Request::Rotate {
                key: m.key,
                id: m.id,
                expected_revision: m.revision,
                secret: read_secret(&secret_file)?,
            },
            Self::Deliveries { id, offset, .. } => Request::Deliveries { id, offset },
            Self::Delivery {
                id, delivery_id, ..
            } => Request::Delivery { id, delivery_id },
            Self::Mutation { key, .. } => Request::Mutation { key },
        };
        request.validate()?;
        Ok(request)
    }
}
fn read_spec(path: &std::path::Path) -> Result<Spec> {
    serde_json::from_str(&workflow::read_file(path, 16 * 1024)?)
        .map_err(|_| invalid("Trigger file must match its strict advertised schema"))
}
fn read_secret(path: &std::path::Path) -> Result<String> {
    let raw = workflow::read_file(path, 256)?;
    let secret = raw.trim_end_matches(['\r', '\n']).to_owned();
    validate_secret(&secret)?;
    Ok(secret)
}
fn invalid(message: &str) -> anyhow::Error {
    cli::failure("invalid_argument", message)
}
fn validate_secret(secret: &str) -> Result<()> {
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid(
            "Trigger secret must be a separate 64-character lowercase hexadecimal string",
        ));
    }
    Ok(())
}
fn event_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
pub const PULL_REQUEST_ACTIONS: &[&str] = &[
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
];
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Adapter {
    Webhook {
        event: String,
    },
    Github {
        repository_id: u64,
        repository: String,
        event: String,
        actions: Vec<String>,
        #[serde(deserialize_with = "explicit_branch")]
        branch: Option<String>,
    },
}
fn explicit_branch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    title: String,
    job_id: String,
    job_revision: u64,
    adapter: Adapter,
}
impl Spec {
    fn validate(&self) -> Result<()> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 80
            || self.title.chars().any(char::is_control)
            || self.job_id.len() != 32
            || !self
                .job_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.job_revision == 0
        {
            return Err(invalid(
                "Trigger title and exact authorized job identity/revision are required",
            ));
        }
        match &self.adapter {
            Adapter::Webhook { event } if event_name(event) => Ok(()),
            Adapter::Github {
                repository_id,
                repository,
                event,
                actions,
                branch,
            } => {
                let repo_parts: Vec<_> = repository.split('/').collect();
                if *repository_id == 0
                    || repo_parts.len() != 2
                    || repo_parts.iter().any(|p| {
                        p.is_empty()
                            || p.len() > 100
                            || !p
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                    })
                    || actions.len() > 16
                    || actions.iter().any(|a| !event_name(a))
                    || actions
                        .iter()
                        .enumerate()
                        .any(|(i, a)| actions[..i].contains(a))
                    || branch.as_ref().is_some_and(|b| {
                        b.is_empty()
                            || b.len() > 255
                            || b.chars().any(|c| c.is_control() || c.is_whitespace())
                    })
                {
                    return Err(invalid(
                        "GitHub trigger requires bounded explicit repository, event/action and branch filters",
                    ));
                }
                match event.as_str() {
                    "push" if actions.is_empty() => Ok(()),
                    "pull_request"
                        if !actions.is_empty()
                            && actions
                                .iter()
                                .all(|a| PULL_REQUEST_ACTIONS.contains(&a.as_str())) =>
                    {
                        Ok(())
                    }
                    "workflow_run" if actions.len() == 1 && actions[0] == "completed" => Ok(()),
                    _ => Err(invalid("Unsupported GitHub trigger event/action selection")),
                }
            }
            _ => Err(invalid("Invalid webhook event name")),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Create {
        key: String,
        spec: Spec,
        secret: String,
    },
    Update {
        key: String,
        id: String,
        expected_revision: u64,
        spec: Spec,
    },
    SetEnabled {
        key: String,
        id: String,
        expected_revision: u64,
        enabled: bool,
    },
    Rotate {
        key: String,
        id: String,
        expected_revision: u64,
        secret: String,
    },
    Revoke {
        key: String,
        id: String,
        expected_revision: u64,
    },
    Get {
        id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Deliveries {
        id: String,
        #[serde(default)]
        offset: u16,
    },
    Delivery {
        id: String,
        delivery_id: String,
    },
    Mutation {
        key: String,
    },
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Create { spec, secret, .. } => {
                spec.validate()?;
                validate_secret(secret)?;
            }
            Self::Update { spec, .. } => spec.validate()?,
            Self::Rotate { secret, .. } => validate_secret(secret)?,
            Self::List { offset } | Self::Deliveries { offset, .. } if *offset > 4096 => {
                return Err(invalid("Trigger page offset exceeds retained history"));
            }
            _ => {}
        }
        match self {
            Self::Create { key, .. }
            | Self::Update { key, .. }
            | Self::SetEnabled { key, .. }
            | Self::Rotate { key, .. }
            | Self::Revoke { key, .. }
            | Self::Mutation { key }
                if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) =>
            {
                return Err(invalid("Trigger mutation needs a bounded stable key"));
            }
            Self::Update {
                expected_revision, ..
            }
            | Self::SetEnabled {
                expected_revision, ..
            }
            | Self::Rotate {
                expected_revision, ..
            }
            | Self::Revoke {
                expected_revision, ..
            } if *expected_revision == 0 => {
                return Err(invalid("Trigger mutation needs its exact current revision"));
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trigger_dtos_refuse_secret_and_scope_ambiguity_without_normalizing_intent() {
        let base = json!({"action":"create","key":"one","secret":"a".repeat(64),"spec":{"title":"Push checks","jobId":"b".repeat(32),"jobRevision":1,"adapter":{"kind":"github","repositoryId":7,"repository":"owner/repo","event":"push","actions":[],"branch":"main"}}});
        serde_json::from_value::<Request>(base.clone())
            .unwrap()
            .validate()
            .unwrap();
        for bad in [
            "A".repeat(64),
            "x".repeat(64),
            "a".repeat(63),
            format!("{}\n", "a".repeat(64)),
        ] {
            let mut value = base.clone();
            value["secret"] = bad.into();
            assert!(
                serde_json::from_value::<Request>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        for field in ["instruction", "profile", "enabled"] {
            let mut value = base.clone();
            value["spec"][field] = json!("forbidden override");
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        for event in ["issues", "pull_request", "workflow_run"] {
            let mut value = base.clone();
            value["spec"]["adapter"]["event"] = event.into();
            assert!(
                serde_json::from_value::<Request>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        for branch in ["main branch".to_owned(), "a".repeat(256)] {
            let mut value = base.clone();
            value["spec"]["adapter"]["branch"] = branch.into();
            assert!(
                serde_json::from_value::<Request>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut pull_request = base;
        pull_request["spec"]["adapter"]["event"] = "pull_request".into();
        pull_request["spec"]["adapter"]["actions"] = json!(["opened"]);
        serde_json::from_value::<Request>(pull_request.clone())
            .unwrap()
            .validate()
            .unwrap();
        pull_request["spec"]["adapter"]["actions"] = json!(["made_up"]);
        assert!(
            serde_json::from_value::<Request>(pull_request)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
