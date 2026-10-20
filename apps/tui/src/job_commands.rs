//! Headless job DTOs over the same authenticated host workflow adapter.
use crate::{cli, network::Connection, workflow_launches::Profile};
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Inspect, explicitly approve and revoke exact owner command checks.
    Precheck {
        #[command(subcommand)]
        command: crate::job_prechecks::Command,
    },
    /// Acknowledge an unknown precheck and abandon its occurrence; never resume it.
    AbandonPrecheck {
        id: String,
        occurrence: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        digest: String,
        #[arg(long, required = true)]
        acknowledge_unknown_effects: bool,
        #[arg(long)]
        json: bool,
    },
    /// Save an enabled host-owned job; does not start a model immediately.
    Create {
        #[arg(long)]
        key: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Read one definition with its exact requested profile.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Read a bounded definition page without prompts or native effects.
    List {
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Replace future intent; accepted occurrences retain their old snapshot.
    Edit {
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
    /// Enable future scheduled admissions. Does not resume native processes.
    Enable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Pause future scheduled admissions; already admitted work may finish.
    Disable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Deliberately admit a separate occurrence, also for a disabled definition.
    RunNow {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Read bounded occurrence history with run pointers and explicit outcomes.
    History {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Inspect an occurrence's immutable profile and run pointer.
    Occurrence {
        id: String,
        occurrence: String,
        #[arg(long)]
        json: bool,
    },
    /// Recover the original accepted job mutation without dispatching it again.
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
            Self::Precheck { command } => command.machine(),
            Self::AbandonPrecheck { json, .. } => *json,
            Self::Create { json, .. }
            | Self::Show { json, .. }
            | Self::List { json, .. }
            | Self::Edit { json, .. }
            | Self::Enable { json, .. }
            | Self::Disable { json, .. }
            | Self::RunNow { json, .. }
            | Self::History { json, .. }
            | Self::Occurrence { json, .. }
            | Self::Mutation { json, .. } => *json,
        }
    }
    fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Precheck { command } => Request::Prechecks {
                request: command.request()?,
            },
            Self::AbandonPrecheck {
                id,
                occurrence,
                key,
                digest,
                acknowledge_unknown_effects,
                ..
            } => Request::AbandonPrecheck {
                key,
                job_id: id,
                occurrence_id: occurrence,
                expected_digest: digest,
                acknowledge_unknown_effects,
            },
            Self::Create { key, file, .. } => Request::Create {
                key,
                spec: read_spec(&file)?,
            },
            Self::Show { id, .. } => Request::Get { job_id: id },
            Self::List { offset, .. } => Request::List { offset },
            Self::Edit {
                id,
                key,
                revision,
                file,
                ..
            } => Request::Update {
                key,
                job_id: id,
                expected_revision: revision,
                spec: read_spec(&file)?,
            },
            Self::Enable {
                id, key, revision, ..
            } => Request::SetEnabled {
                key,
                job_id: id,
                expected_revision: revision,
                enabled: true,
            },
            Self::Disable {
                id, key, revision, ..
            } => Request::SetEnabled {
                key,
                job_id: id,
                expected_revision: revision,
                enabled: false,
            },
            Self::RunNow {
                id, key, revision, ..
            } => Request::RunNow {
                key,
                job_id: id,
                expected_revision: revision,
            },
            Self::History { id, offset, .. } => Request::History { job_id: id, offset },
            Self::Occurrence { id, occurrence, .. } => Request::Occurrence {
                job_id: id,
                occurrence_id: occurrence,
            },
            Self::Mutation { key, .. } => Request::Mutation { key },
        })
    }
}
fn read_spec(path: &std::path::Path) -> Result<Spec> {
    serde_json::from_str(&crate::workflow::read_file(path, 16 * 1024)?).map_err(|_| {
        cli::failure(
            "invalid_argument",
            "Job file must match the advertised job schema",
        )
    })
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Schedule {
    Once {
        at: String,
    },
    Cron {
        expression: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
    Rrule {
        rule: String,
        start: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
}
fn default_zone() -> String {
    "Europe/Warsaw".into()
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Misfire {
    Skip,
    #[default]
    CatchUp,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Overlap {
    #[default]
    Skip,
    Queue,
}
fn grace() -> u64 {
    60_000
}
fn budget() -> u64 {
    300_000
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    title: String,
    instruction: String,
    profile: Profile,
    schedule: Schedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    precheck_id: Option<String>,
    #[serde(default)]
    misfire: Misfire,
    #[serde(default = "grace")]
    grace_ms: u64,
    #[serde(default)]
    overlap: Overlap,
    #[serde(default = "budget")]
    max_elapsed_ms: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Prechecks {
        request: crate::job_prechecks::Request,
    },
    AbandonPrecheck {
        key: String,
        job_id: String,
        occurrence_id: String,
        expected_digest: String,
        acknowledge_unknown_effects: bool,
    },
    Create {
        key: String,
        spec: Spec,
    },
    Get {
        job_id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Update {
        key: String,
        job_id: String,
        expected_revision: u64,
        spec: Spec,
    },
    SetEnabled {
        key: String,
        job_id: String,
        expected_revision: u64,
        enabled: bool,
    },
    RunNow {
        key: String,
        job_id: String,
        expected_revision: u64,
    },
    History {
        job_id: String,
        #[serde(default)]
        offset: u16,
    },
    Occurrence {
        job_id: String,
        occurrence_id: String,
    },
    Mutation {
        key: String,
    },
}
pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let request = crate::workflow::tool("jobs", json!({"request":command.request()?}))?;
    crate::workflow::capability(connection, &request).await?;
    cli::print_data(
        machine,
        cli::request(connection, request, "workflow").await?,
    )
}
