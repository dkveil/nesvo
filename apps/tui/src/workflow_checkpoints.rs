use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Capture metadata once. A caller note is not task validation or input.
    Save {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long, conflicts_with = "summary_file")]
        summary: Option<String>,
        #[arg(long)]
        summary_file: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// List eight immutable snapshots without resuming processes.
    List {
        id: String,
        #[arg(long,default_value_t=0,value_parser=clap::value_parser!(u16).range(0..=32))]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Read historical parts. Current constraints are never replaced by history.
    Get {
        id: String,
        checkpoint: String,
        #[arg(long,default_value_t=0,value_parser=clap::value_parser!(u16).range(0..=16384))]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Read current context for compaction/resume. No launch, send, ACK or adoption.
    Context {
        id: String,
        #[arg(long)]
        checkpoint: Option<String>,
        #[arg(long,default_value_t=0,value_parser=clap::value_parser!(u16).range(0..=16384))]
        offset: u16,
        #[arg(long)]
        expected_digest: Option<String>,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Save { json, .. }
            | Self::List { json, .. }
            | Self::Get { json, .. }
            | Self::Context { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Save {
                id,
                key,
                revision,
                summary,
                summary_file,
                ..
            } => Request::Save {
                key,
                run_id: id,
                expected_revision: revision,
                summary: match summary_file {
                    Some(path) => Some(crate::workflow::read_file(&path, 2048)?),
                    None => summary,
                },
            },
            Self::List { id, offset, .. } => Request::List {
                run_id: id,
                offset: Some(offset),
            },
            Self::Get {
                id,
                checkpoint,
                offset,
                ..
            } => Request::Get {
                run_id: id,
                checkpoint_id: checkpoint,
                offset: Some(offset),
            },
            Self::Context {
                id,
                checkpoint,
                offset,
                expected_digest,
                ..
            } => Request::Context {
                run_id: id,
                checkpoint_id: checkpoint,
                offset: Some(offset),
                expected_digest,
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
    Save {
        key: String,
        run_id: String,
        expected_revision: u64,
        summary: Option<String>,
    },
    List {
        run_id: String,
        offset: Option<u16>,
    },
    Get {
        run_id: String,
        checkpoint_id: String,
        offset: Option<u16>,
    },
    Context {
        run_id: String,
        checkpoint_id: Option<String>,
        offset: Option<u16>,
        expected_digest: Option<String>,
    },
}
