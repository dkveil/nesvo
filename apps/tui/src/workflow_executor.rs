//! Explicit immutable task profiles for the host-owned DAG executor.
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Start automatic scheduling for an active run using explicit agent profiles.
    Start {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Read executor state without dispatching anything.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Disable new scheduling admissions. Already admitted native work may finish.
    Disable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Deliberately enable a new generation without replaying existing effects.
    Enable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Start { json, .. }
            | Self::Get { json, .. }
            | Self::Disable { json, .. }
            | Self::Enable { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Start {
                id,
                key,
                revision,
                file,
                ..
            } => Request::Start {
                key,
                run_id: id,
                expected_revision: revision,
                spec: serde_json::from_str(&crate::workflow::read_file(&file, 24 * 1024)?)
                    .map_err(|_| {
                        crate::cli::failure(
                            "invalid_argument",
                            "Executor file must contain explicit bounded task profiles",
                        )
                    })?,
            },
            Self::Get { id, .. } => Request::Get { run_id: id },
            Self::Disable {
                id, key, revision, ..
            } => Request::Disable {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Enable {
                id, key, revision, ..
            } => Request::Enable {
                key,
                run_id: id,
                expected_revision: revision,
            },
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskProfile {
    task_id: String,
    profile: crate::workflow_launches::Profile,
}
fn retry_delay() -> u64 {
    1000
}
fn readiness_timeout() -> u64 {
    60000
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    tasks: Vec<TaskProfile>,
    #[serde(default)]
    retry_failed: bool,
    #[serde(default = "retry_delay")]
    retry_delay_ms: u64,
    #[serde(default = "readiness_timeout")]
    readiness_timeout_ms: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Start {
        key: String,
        run_id: String,
        expected_revision: u64,
        spec: Spec,
    },
    Get {
        run_id: String,
    },
    Disable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Enable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
}
