use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Owner-only literal constraint. Pauses future automation, preserving history.
    Add {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long, required_unless_present = "file", conflicts_with = "file")]
        text: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Read eight append-only owner constraints; this never acknowledges them.
    List {
        id: String,
        #[arg(long)]
        after: Option<u64>,
        #[arg(long)]
        json: bool,
    },
    /// Deliberately confirm reading this exact revision. Does not reenable input.
    Acknowledge {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        constraint_revision: u64,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Add { json, .. } | Self::List { json, .. } | Self::Acknowledge { json, .. } => {
                *json
            }
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Add {
                id,
                key,
                revision,
                text,
                file,
                ..
            } => Request::Add {
                key,
                run_id: id,
                expected_revision: revision,
                text: match file {
                    Some(path) => crate::workflow::read_file(&path, 1024)?,
                    None => text.ok_or_else(|| {
                        crate::cli::failure(
                            "invalid_argument",
                            "Constraint text or file is required",
                        )
                    })?,
                },
            },
            Self::List { id, after, .. } => Request::List { run_id: id, after },
            Self::Acknowledge {
                id,
                key,
                revision,
                constraint_revision,
                ..
            } => Request::Acknowledge {
                key,
                run_id: id,
                expected_revision: revision,
                constraint_revision,
            },
        })
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
    Add {
        key: String,
        run_id: String,
        expected_revision: u64,
        text: String,
    },
    List {
        run_id: String,
        after: Option<u64>,
    },
    Acknowledge {
        key: String,
        run_id: String,
        expected_revision: u64,
        constraint_revision: u64,
    },
}
