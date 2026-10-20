//! Bounded run policy DTOs; authoritative admission belongs to the host.
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Read a visible run's current admission policy and activation clock.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Set future attempt limits at the exact run revision. Only owner may relax.
    Set {
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
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Get { json, .. } | Self::Set { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Get { id, .. } => Request::Get { run_id: id },
            Self::Set {
                id,
                key,
                revision,
                file,
                ..
            } => Request::Set {
                key,
                run_id: id,
                expected_revision: revision,
                limits: serde_json::from_str(&crate::workflow::read_file(&file, 4096)?).map_err(
                    |_| {
                        crate::cli::failure(
                            "invalid_argument",
                            "Run budget file must match the declared limits schema",
                        )
                    },
                )?,
            },
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    max_parallel: u16,
    max_attempts_per_task: u16,
    #[serde(deserialize_with = "Option::deserialize")]
    max_elapsed_ms: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Get {
        run_id: String,
    },
    Set {
        key: String,
        run_id: String,
        expected_revision: u64,
        limits: Limits,
    },
}
