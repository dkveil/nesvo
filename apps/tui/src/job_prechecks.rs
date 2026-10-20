//! Exact owner command approval over the authoritative host API.
use crate::{cli, workflow};
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
fn version() -> u8 {
    1
}
fn timeout() -> u64 {
    2000
}
fn pass() -> Vec<i32> {
    vec![0]
}
fn skip() -> Vec<i32> {
    vec![10]
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    #[serde(default = "version")]
    version: u8,
    title: String,
    executable: String,
    #[serde(default)]
    arguments: Vec<String>,
    cwd: String,
    #[serde(default = "timeout")]
    timeout_ms: u64,
    #[serde(default = "pass")]
    pass_exit_codes: Vec<i32>,
    #[serde(default = "skip")]
    skip_exit_codes: Vec<i32>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Describe {
        spec: Spec,
    },
    Approve {
        key: String,
        spec: Spec,
        expected_digest: String,
    },
    Get {
        id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Revoke {
        key: String,
        id: String,
        expected_revision: u64,
    },
    Mutation {
        key: String,
    },
}
#[derive(Subcommand)]
pub enum Command {
    /// Inspect normalized literal command and digest without granting execution.
    Describe {
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Explicit owner trust of this exact command/cwd/args/env; no sandbox implied.
    Approve {
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        key: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        json: bool,
    },
    /// Inspect an immutable approval, including revoked records.
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
    /// Refuse new uses; already authorized checks may finish.
    Revoke {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
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
fn spec(path: &std::path::Path) -> Result<Spec> {
    serde_json::from_str(&workflow::read_file(path, 16 * 1024)?).map_err(|_| {
        cli::failure(
            "invalid_argument",
            "Precheck file must match the exact command schema",
        )
    })
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Describe { json, .. }
            | Self::Approve { json, .. }
            | Self::Show { json, .. }
            | Self::List { json, .. }
            | Self::Revoke { json, .. }
            | Self::Mutation { json, .. } => *json,
        }
    }
    pub fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Describe { file, .. } => Request::Describe { spec: spec(&file)? },
            Self::Approve {
                file, key, digest, ..
            } => Request::Approve {
                key,
                spec: spec(&file)?,
                expected_digest: digest,
            },
            Self::Show { id, .. } => Request::Get { id },
            Self::List { offset, .. } => Request::List { offset },
            Self::Revoke {
                id, key, revision, ..
            } => Request::Revoke {
                id,
                key,
                expected_revision: revision,
            },
            Self::Mutation { key, .. } => Request::Mutation { key },
        })
    }
}
