use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Deserialize, Serialize, ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum Audience {
    Owner,
    Coordinator,
}
#[derive(Subcommand)]
pub enum Command {
    /// Ask for a scoped decision. Defaults to explicit human-owner authority.
    Ask {
        attempt: String,
        #[arg(long)]
        key: String,
        #[arg(long, value_enum, default_value = "owner")]
        audience: Audience,
        #[arg(
            long,
            required_unless_present = "question_file",
            conflicts_with = "question_file"
        )]
        question: Option<String>,
        #[arg(long)]
        question_file: Option<PathBuf>,
        #[arg(long,default_value_t=300_000,value_parser=clap::value_parser!(u64).range(1000..=604_800_000))]
        timeout_ms: u64,
        #[arg(long)]
        json: bool,
    },
    /// Read scoped decisions, including retained resolved questions.
    List {
        run: String,
        #[arg(long)]
        attempt: Option<String>,
        #[arg(long)]
        offset: Option<u16>,
        #[arg(long)]
        json: bool,
    },
    /// Read one decision before answering its exact revision.
    Get {
        run: String,
        decision: String,
        #[arg(long)]
        json: bool,
    },
    /// Record an answer. This never types a native provider approval.
    Answer {
        run: String,
        decision: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(
            long,
            required_unless_present = "answer_file",
            conflicts_with = "answer_file"
        )]
        answer: Option<String>,
        #[arg(long)]
        answer_file: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Cancel a question; cancellation is not approval to complete the attempt.
    Cancel {
        run: String,
        decision: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        json: bool,
    },
}
fn literal(value: Option<String>, file: Option<PathBuf>) -> Result<String> {
    match file {
        Some(path) => crate::workflow::read_file(&path, 2048),
        None => value.ok_or_else(|| {
            crate::cli::failure(
                "invalid_argument",
                "A literal value or bounded UTF-8 file is required",
            )
        }),
    }
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Ask { json, .. }
            | Self::List { json, .. }
            | Self::Get { json, .. }
            | Self::Answer { json, .. }
            | Self::Cancel { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Ask {
                attempt,
                key,
                audience,
                question,
                question_file,
                timeout_ms,
                ..
            } => Request::Ask {
                key,
                attempt_id: attempt,
                audience,
                question: literal(question, question_file)?,
                timeout_ms,
            },
            Self::List {
                run,
                attempt,
                offset,
                ..
            } => Request::List {
                run_id: run,
                attempt_id: attempt,
                offset,
            },
            Self::Get { run, decision, .. } => Request::Get {
                run_id: run,
                decision_id: decision,
            },
            Self::Answer {
                run,
                decision,
                key,
                revision,
                answer,
                answer_file,
                ..
            } => Request::Answer {
                key,
                run_id: run,
                decision_id: decision,
                expected_revision: revision,
                answer: literal(answer, answer_file)?,
            },
            Self::Cancel {
                run,
                decision,
                key,
                revision,
                reason,
                ..
            } => Request::Cancel {
                key,
                run_id: run,
                decision_id: decision,
                expected_revision: revision,
                reason,
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
    Ask {
        key: String,
        attempt_id: String,
        audience: Audience,
        question: String,
        timeout_ms: u64,
    },
    List {
        run_id: String,
        attempt_id: Option<String>,
        offset: Option<u16>,
    },
    Get {
        run_id: String,
        decision_id: String,
    },
    Answer {
        key: String,
        run_id: String,
        decision_id: String,
        expected_revision: u64,
        answer: String,
    },
    Cancel {
        key: String,
        run_id: String,
        decision_id: String,
        expected_revision: u64,
        reason: String,
    },
}
