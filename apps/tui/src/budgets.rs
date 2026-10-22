use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Read the owner's persisted admission limits, without changing live work.
    Get {
        #[arg(long)]
        json: bool,
    },
    /// Replace future admission limits at the exact budget revision.
    Set {
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
            Self::Get { json } | Self::Set { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Get { .. } => Request::Get {},
            Self::Set {
                key,
                revision,
                file,
                ..
            } => Request::Set {
                key,
                expected_revision: revision,
                limits: serde_json::from_str(&crate::workflow::read_file(&file, 4096)?).map_err(
                    |_| {
                        crate::cli::failure(
                            "invalid_argument",
                            "Budget file must match the declared limits schema",
                        )
                    },
                )?,
            },
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Providers {
    shell: u16,
    claude: u16,
    codex: u16,
    gemini: u16,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    max_sessions: u16,
    max_workers: u16,
    providers: Providers,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Get {},
    Set {
        key: String,
        expected_revision: u64,
        limits: Limits,
    },
}
