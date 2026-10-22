use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Read pending messages; repeated reads keep them until explicit ACK.
    Read {
        run: String,
        #[arg(long)]
        attempt: Option<String>,
        #[arg(long)]
        after: Option<u64>,
        #[arg(long)]
        include_acked: bool,
        #[arg(long)]
        json: bool,
    },
    /// Send one durable message. An omitted target addresses the coordinator.
    Send {
        run: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        correlation: String,
        #[arg(long)]
        attempt: Option<String>,
        #[arg(long,default_value="note",value_parser=["note","question","error"])]
        kind: String,
        #[arg(
            long,
            required_unless_present = "message_file",
            conflicts_with = "message_file"
        )]
        message: Option<String>,
        #[arg(long)]
        message_file: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Acknowledge exact message IDs; retrying the same IDs is safe after loss.
    Ack {
        run: String,
        #[arg(required=true,num_args=1..=32)]
        ids: Vec<String>,
        #[arg(long)]
        attempt: Option<String>,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Read { json, .. } | Self::Send { json, .. } | Self::Ack { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Read {
                run,
                attempt,
                after,
                include_acked,
                ..
            } => Request::Read {
                run_id: run,
                attempt_id: attempt,
                after,
                include_acked: Some(include_acked),
            },
            Self::Send {
                run,
                key,
                correlation,
                attempt,
                kind,
                message,
                message_file,
                ..
            } => {
                let body = match message_file {
                    Some(path) => crate::workflow::read_file(&path, 4096)?,
                    None => message.ok_or_else(|| {
                        crate::cli::failure(
                            "invalid_argument",
                            "A message or UTF-8 message file is required",
                        )
                    })?,
                };
                let kind = match kind.as_str() {
                    "question" => Kind::Question,
                    "error" => Kind::Error,
                    _ => Kind::Note,
                };
                Request::Send {
                    key,
                    run_id: run,
                    attempt_id: attempt,
                    correlation_id: correlation,
                    kind,
                    body,
                }
            }
            Self::Ack {
                run, ids, attempt, ..
            } => Request::Ack {
                run_id: run,
                attempt_id: attempt,
                ids,
            },
        })
    }
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Note,
    Question,
    Error,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Read {
        run_id: String,
        attempt_id: Option<String>,
        after: Option<u64>,
        include_acked: Option<bool>,
    },
    Send {
        key: String,
        run_id: String,
        attempt_id: Option<String>,
        correlation_id: String,
        #[serde(default)]
        kind: Kind,
        body: String,
    },
    Ack {
        run_id: String,
        attempt_id: Option<String>,
        ids: Vec<String>,
    },
}
