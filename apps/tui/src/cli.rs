//! Headless operations over the same authenticated host connection as TUI.
use crate::network::{Connection, NetworkEvent, Pairing, open_failure_message};
use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};

#[derive(Subcommand)]
pub enum Command {
    /// Durable host-owned jobs and immutable occurrence history.
    Job {
        #[command(subcommand)]
        command: crate::job_commands::Command,
    },
    /// Inspect or replace the owner's persisted host admission budgets.
    Budget {
        #[command(subcommand)]
        command: crate::budgets::Command,
    },
    /// Serve scoped host tools over MCP stdio. No global provider setup is changed.
    Mcp,
    /// Durable workflow plans (separate run/task identities, no automatic launch).
    Run {
        #[command(subcommand)]
        command: crate::workflow::Command,
    },
    /// Inspect a durable operation by ID, or find the caller's idempotency key.
    Operation {
        #[arg(
            required_unless_present_any = ["key", "receipt_id"],
            conflicts_with_all = ["key", "receipt_id"]
        )]
        id: Option<String>,
        /// Explicit receipt ID; the positional ID spelling remains supported.
        #[arg(long = "id", conflicts_with = "key")]
        receipt_id: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Read or watch the durable domain journal (not terminal replay).
    Events {
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long,default_value_t=32,value_parser=clap::value_parser!(u16).range(1..=32))]
        limit: u16,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        watch: bool,
        #[arg(long)]
        json: bool,
    },
    /// Explain host/provider integration health without changing any session.
    Doctor {
        #[arg(long)]
        json: bool,
    },
    /// Inspect owner quota observations; refresh queues one bounded provider read.
    Quota {
        #[arg(long, value_parser = ["codex", "claude", "gemini"])]
        program: Option<String>,
        /// Absolute host folder whose Codex configuration should be observed.
        #[arg(long, requires = "program")]
        directory: Option<String>,
        #[arg(long, requires = "program")]
        refresh: bool,
        #[arg(long)]
        json: bool,
    },
    /// Inspect a session by its stable identifier.
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    #[command(about = "Open host-side review sessions and deliver review feedback to an agent")]
    Review {
        #[command(subcommand)]
        command: ReviewCommand,
    },
    #[command(
        about = "Owner-only worktree setup approval, on-demand run steps, cancellation and archive"
    )]
    Worktree {
        #[command(subcommand)]
        command: WorktreeCommand,
    },
    #[command(about = "Owner project registry: list, pin, unpin and read per-repository defaults")]
    Project {
        #[command(subcommand)]
        command: crate::project_commands::Command,
    },
    #[command(about = "Owner needs-you inbox across sessions, runs, decisions and job results")]
    Inbox {
        #[command(subcommand)]
        command: attention::InboxCommand,
    },
    #[command(about = "Owner pending decisions across runs, answered without a run ID")]
    Decision {
        #[command(subcommand)]
        command: attention::DecisionCommand,
    },
    #[command(
        about = "Owner-only nesvo.toml workflow templates: inspect, approve, revoke and start as runs"
    )]
    Workflow {
        #[command(subcommand)]
        command: WorkflowCommand,
    },
}
#[derive(Subcommand)]
pub enum WorkflowCommand {
    #[command(
        about = "Show the committed [[workflow]] templates of a repository with their digest and approval; starts nothing"
    )]
    Templates {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Approve one inspected template digest; its templates can then be started")]
    ApproveTemplates {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Revoke an approved template digest; later starts using it are refused")]
    RevokeTemplates {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Create a run and its tasks from an approved template; repeat the same key after uncertainty"
    )]
    Start {
        name: String,
        #[arg(long)]
        directory: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        json: bool,
    },
}
impl WorkflowCommand {
    fn machine(&self) -> bool {
        match self {
            Self::Templates { json, .. }
            | Self::ApproveTemplates { json, .. }
            | Self::RevokeTemplates { json, .. }
            | Self::Start { json, .. } => *json,
        }
    }
}
#[derive(Subcommand)]
pub enum WorktreeCommand {
    #[command(
        about = "Show the committed nesvo.toml of a repository with its digest and approval; runs nothing"
    )]
    Describe {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Approve one inspected setup digest; its steps then run before each worktree agent launch"
    )]
    ApproveSetup {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Revoke an approved setup digest; later worktree launches using it are refused"
    )]
    RevokeSetup {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Start the approved run steps in a session's host-created worktree")]
    Run {
        session: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Cancel the active setup or run steps of a session's worktree")]
    Cancel {
        session: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Remove a session's worktree and branch; refuses dirty, unpushed or conflicted work unless --discard"
    )]
    Archive {
        session: String,
        #[arg(long)]
        discard: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List host-created worktrees with their sessions, setup and run states")]
    List {
        #[arg(long)]
        json: bool,
    },
}
impl WorktreeCommand {
    fn machine(&self) -> bool {
        match self {
            Self::Describe { json, .. }
            | Self::ApproveSetup { json, .. }
            | Self::RevokeSetup { json, .. }
            | Self::Run { json, .. }
            | Self::Cancel { json, .. }
            | Self::Archive { json, .. }
            | Self::List { json } => *json,
        }
    }
}
#[derive(Subcommand)]
pub enum ReviewCommand {
    #[command(
        about = "Open the local changes of a session or folder, or fetch a GitHub pull request into a host review checkout"
    )]
    Open {
        #[arg(long, conflicts_with = "pull", required_unless_present_any = ["pull", "directory"])]
        session: Option<String>,
        #[arg(long, conflicts_with = "pull")]
        directory: Option<String>,
        #[arg(long)]
        pull: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Deliver review text to an agent session with one receipt; never takes control"
    )]
    Deliver {
        #[arg(long)]
        review: String,
        #[arg(long)]
        session: String,
        #[arg(long, conflicts_with = "text", required_unless_present = "text")]
        file: Option<std::path::PathBuf>,
        #[arg(long)]
        text: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        json: bool,
    },
}
#[derive(Subcommand)]
pub enum SessionCommand {
    /// Launch once for a stable caller-supplied idempotency key; never acquires control.
    Create(Box<CreateOptions>),
    /// Submit one literal prompt with a durable key; never takes human control.
    Send(SendOptions),
    /// Write one Ctrl+C without taking control. Does not claim the agent stopped.
    Interrupt(ControlOptions),
    /// Request native process stop once; retain the session and terminal output.
    Stop(ControlOptions),
    /// Inspect or explicitly arm/disable one durable quota wake for native Codex.
    Wake {
        id: String,
        /// Arm once from fresh exact-reader evidence at >=90% of a known five-hour window.
        #[arg(long, conflicts_with = "disable")]
        enable: bool,
        /// Disable future wake admission; inspect any already accepted send receipt.
        #[arg(long, conflicts_with = "enable")]
        disable: bool,
        #[arg(long)]
        json: bool,
    },
    /// Wait for one send receipt, never an old idle state or the focused session.
    Wait {
        #[arg(required_unless_present = "key", conflicts_with = "key")]
        id: Option<String>,
        #[arg(long)]
        key: Option<String>,
        /// Optional guard: receipt must belong to this stable session ID.
        #[arg(long)]
        session: Option<String>,
        #[arg(long, value_enum, default_value_t=Until::Settled)]
        until: Until,
        #[arg(long, default_value_t=30_000, value_parser=clap::value_parser!(u64).range(1..=60_000))]
        timeout_ms: u64,
        #[arg(long)]
        json: bool,
    },
    /// List authoritative session IDs and groups; never acquires control.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Inspect one session by stable ID.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Read the authenticated process binding, never the UI selection.
    Current {
        #[arg(long)]
        json: bool,
    },
    /// Read a bounded terminal replay page, without subscribing or controlling it.
    Read {
        id: String,
        #[arg(long)]
        after: Option<u64>,
        #[arg(long,default_value_t=4096,value_parser=clap::value_parser!(u16).range(1..=8192))]
        max_bytes: u16,
        #[arg(long)]
        json: bool,
    },
    /// Inspect host-side repository changes read-only.
    Diff {
        id: String,
        #[arg(long,value_enum,default_value_t=Scope::Unstaged)]
        scope: Scope,
        #[arg(long)]
        json: bool,
    },
    /// Show source, freshness, delivery and protocol diagnostics (no prompts).
    Explain {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "List, restore or forget saved sessions from previous host runs; never replays input"
    )]
    Recover {
        #[command(subcommand)]
        command: crate::session_recovery::Command,
    },
}

#[derive(clap::Args)]
pub struct CreateOptions {
    name: String,
    #[arg(long)]
    key: String,
    #[arg(long,default_value="shell",value_parser=["shell","claude","gemini","codex"])]
    program: String,
    #[arg(long)]
    cwd: Option<String>,
    #[arg(long)]
    group: Option<String>,
    /// Lineage only: this does not grant access to the parent or its children.
    #[arg(long)]
    parent: Option<String>,
    /// Only owner access can grant coordinator capabilities at launch.
    #[arg(long,default_value="worker",value_parser=["worker","coordinator"])]
    role: String,
    /// Load the launch-local Nesvo instruction and MCP (supported Claude versions).
    #[arg(long, conflicts_with = "no_harness")]
    harness: bool,
    /// Owner-only native approval addition for one exact Nesvo MCP tool; repeat as needed.
    #[arg(long = "allow-nesvo-tool", requires = "harness")]
    allowed_nesvo_tools: Vec<String>,
    /// Owner-only policy for authenticated Claude children; requires coordinator role.
    #[arg(long = "allow-child-nesvo-tool")]
    child_allowed_nesvo_tools: Vec<String>,
    /// Launch-local model alias/ID; does not modify provider defaults.
    #[arg(long)]
    model: Option<String>,
    /// Provider reasoning effort for an explicit model; unsupported versions refuse.
    #[arg(long, requires = "model")]
    effort: Option<String>,
    /// Owner-only explicit Claude display manifest; does not change global settings.
    #[arg(long)]
    claude_quota_display_profile: Option<String>,
    /// Explicitly opt out when the coordinator profile would inherit the harness.
    #[arg(long, conflicts_with = "harness")]
    no_harness: bool,
    #[arg(long)]
    worktree: bool,
    #[arg(long,conflicts_with_all=["prompt_file","stdin"])]
    prompt: Option<String>,
    #[arg(long, conflicts_with = "stdin")]
    prompt_file: Option<std::path::PathBuf>,
    #[arg(long)]
    stdin: bool,
    #[arg(long)]
    json: bool,
}

#[derive(clap::Args)]
pub struct ControlOptions {
    id: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    json: bool,
}
#[derive(clap::Args)]
pub struct SendOptions {
    id: String,
    #[arg(long)]
    key: String,
    #[arg(long,required_unless_present_any=["prompt_file","stdin"],conflicts_with_all=["prompt_file","stdin"])]
    prompt: Option<String>,
    #[arg(long, conflicts_with = "stdin")]
    prompt_file: Option<std::path::PathBuf>,
    #[arg(long)]
    stdin: bool,
    #[arg(long)]
    json: bool,
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Until {
    Delivered,
    Received,
    Started,
    Settled,
}
impl Until {
    fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Received => "received",
            Self::Started => "started",
            Self::Settled => "settled",
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Scope {
    Unstaged,
    Staged,
    Untracked,
}
impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unstaged => "unstaged",
            Self::Staged => "staged",
            Self::Untracked => "untracked",
        }
    }
}

#[derive(Debug)]
struct Failure {
    code: String,
    message: String,
    receipt: Option<Value>,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}
pub(crate) fn failure(code: &str, message: &str) -> anyhow::Error {
    Failure {
        code: code.into(),
        message: message.into(),
        receipt: None,
    }
    .into()
}
pub fn emit_failure(machine: bool, code: &str, message: &str) -> i32 {
    emit_failure_receipt(machine, code, message, None)
}
pub(crate) const EXIT_BAD_REQUEST: i32 = 1;
pub(crate) const EXIT_HOST_UNREACHABLE: i32 = 2;
pub(crate) const EXIT_AUTHORITY: i32 = 3;
pub(crate) const EXIT_HOST_ERROR: i32 = 4;
pub(crate) const EXIT_MOVED_ON: i32 = 5;

const BAD_REQUEST_CODES: &[&str] = &[
    "invalid_argument",
    "input_too_large",
    "invalid_cursor",
    "idempotency_conflict",
    "no_current_session",
    "not_repository",
    "outside_root",
    "too_large",
];
const HOST_UNREACHABLE_CODES: &[&str] = &[
    "pairing_unavailable",
    "host_unavailable",
    "disconnected",
    "timeout",
    "host_stopping",
];
const AUTHORITY_CODES: &[&str] = &[
    "forbidden",
    "scope_revoked",
    "coordinator_required",
    "control_busy",
];
const MOVED_ON_CODES: &[&str] = &[
    "revision_conflict",
    "cursor_expired",
    "digest_mismatch",
    "decision_pending",
    "decision_resolved",
    "coordinator_alive",
    "run_draining",
    "submission_preempted",
    "original_submission_closed",
    "occurrence_conflict",
    "quota_binding_conflict",
];

pub(crate) fn exit_code(code: &str) -> i32 {
    if BAD_REQUEST_CODES.contains(&code)
        || code.ends_with("_not_found")
        || code.ends_with("_too_large")
    {
        EXIT_BAD_REQUEST
    } else if HOST_UNREACHABLE_CODES.contains(&code) {
        EXIT_HOST_UNREACHABLE
    } else if AUTHORITY_CODES.contains(&code) || code.ends_with("_unauthorized") {
        EXIT_AUTHORITY
    } else if MOVED_ON_CODES.contains(&code)
        || code.starts_with("stale_")
        || [
            "_changed",
            "_state_conflict",
            "_expired",
            "_revoked",
            "_retired",
        ]
        .iter()
        .any(|suffix| code.ends_with(suffix))
    {
        EXIT_MOVED_ON
    } else {
        EXIT_HOST_ERROR
    }
}

fn failure_envelope(code: &str, message: &str, receipt: Option<&Value>) -> Value {
    let mut envelope = json!({"schemaVersion":1,"ok":false,"error":{"code":code,"message":message,"retryable":matches!(code,"host_unavailable"|"disconnected"|"timeout")}});
    if let Some(receipt) = receipt {
        envelope["error"]["receipt"] = receipt.clone();
    }
    envelope
}

pub(crate) fn failure_receipt(code: &str, message: &str, receipt: Option<&Value>) -> Value {
    let mut envelope = failure_envelope(code, message, receipt);
    envelope["error"]["exitCode"] = exit_code(code).into();
    envelope
}

fn emit_failure_receipt(machine: bool, code: &str, message: &str, receipt: Option<&Value>) -> i32 {
    if machine {
        println!("{}", failure_receipt(code, message, receipt));
    } else {
        eprintln!("{code}: {message}");
    }
    exit_code(code)
}
impl Command {
    fn machine(&self) -> bool {
        match self {
            Self::Mcp => false,
            Self::Run { command } => command.machine(),
            Self::Job { command } => command.machine(),
            Self::Budget { command } => command.machine(),
            Self::Worktree { command } => command.machine(),
            Self::Inbox { command } => command.machine(),
            Self::Project { command } => command.machine(),
            Self::Decision { command } => command.machine(),
            Self::Workflow { command } => command.machine(),
            Self::Review { command } => match command {
                ReviewCommand::Open { json, .. } | ReviewCommand::Deliver { json, .. } => *json,
            },
            Self::Doctor { json }
            | Self::Quota { json, .. }
            | Self::Events { json, .. }
            | Self::Operation { json, .. } => *json,
            Self::Session { command } => match command {
                SessionCommand::Create(options) => options.json,
                SessionCommand::Send(options) => options.json,
                SessionCommand::Interrupt(options) | SessionCommand::Stop(options) => options.json,
                SessionCommand::List { json }
                | SessionCommand::Wake { json, .. }
                | SessionCommand::Wait { json, .. }
                | SessionCommand::Get { json, .. }
                | SessionCommand::Current { json }
                | SessionCommand::Read { json, .. }
                | SessionCommand::Diff { json, .. }
                | SessionCommand::Explain { json, .. } => *json,
                SessionCommand::Recover { command } => command.machine(),
            },
        }
    }
}
pub async fn execute(command: Command, pairing_path: &Path, url: Option<&str>) -> i32 {
    if matches!(
        command,
        Command::Run {
            command: crate::workflow::Command::RecoverHook
        }
    ) {
        return crate::recovery_hook::execute(pairing_path, url).await;
    }
    if matches!(command, Command::Mcp) {
        return match crate::mcp::serve(pairing_path.to_owned(), url.map(str::to_owned)).await {
            Ok(()) => 0,
            Err(_) => {
                eprintln!("MCP transport stopped; no operation was retried");
                EXIT_HOST_ERROR
            }
        };
    }
    let machine = command.machine();
    let result = async {
        let pairing = Pairing::load(pairing_path, url).map_err(|_| {
            failure(
                "pairing_unavailable",
                "Cannot load a valid private pairing file; start the host and pass --pairing PATH",
            )
        })?;
        let mut connection = Connection::open(pairing).await.map_err(|error| {
            failure(
                "host_unavailable",
                &open_failure_message(
                    &error,
                    "Cannot authenticate with the paired host; check that it is running and reachable",
                ),
            )
        })?;
        run(command, &mut connection).await
    }
    .await;
    match result {
        Ok(()) => 0,
        Err(error) => match error.downcast_ref::<Failure>() {
            Some(error) => {
                emit_failure_receipt(machine, &error.code, &error.message, error.receipt.as_ref())
            }
            None => emit_failure(
                machine,
                "operation_failed",
                "Operation could not be completed",
            ),
        },
    }
}

pub(crate) async fn request(
    connection: &mut Connection,
    mut command: Value,
    kind: &str,
) -> Result<Value> {
    let timeout = match command["type"].as_str() {
        Some("waitOperation") => Duration::from_millis(
            command["timeoutMs"].as_u64().unwrap_or(30_000).min(60_000) + 5_000,
        ),
        Some("sendOperation" | "deliverReview") => Duration::from_secs(15),
        Some("openReview") => Duration::from_secs(130),
        Some("createOperation") if command["spec"]["worktree"] == true => {
            Duration::from_secs(WORKTREE_LAUNCH_WAIT_S)
        }
        Some("archiveWorktree") => Duration::from_secs(90),
        Some(
            "listWorktrees"
            | "describeWorktreeSetup"
            | "approveWorktreeSetup"
            | "revokeWorktreeSetup"
            | "listWorkflowTemplates"
            | "approveWorkflowTemplates"
            | "revokeWorkflowTemplates"
            | "startWorkflowTemplate"
            | "projectDefaults",
        ) => Duration::from_secs(30),
        _ => Duration::from_secs(10),
    };
    let id = format!("cli-{}", hex::encode(nesvo_wire::random::<8>()));
    command["requestId"] = json!(id);
    connection
        .send(command)
        .map_err(|_| failure("disconnected", "Host connection is closed"))?;
    tokio::time::timeout(timeout, async {
        while let Some(event) = connection.events.recv().await {
            match event {
                NetworkEvent::Disconnected(_) => {
                    return Err(failure(
                        "disconnected",
                        "Host disconnected before replying; no input was retried",
                    ));
                }
                NetworkEvent::Message(value) if value["requestId"] == id => {
                    if value["type"] == "error" {
                        return Err(failure(
                            value["code"].as_str().unwrap_or("request_rejected"),
                            value["message"].as_str().unwrap_or("Host rejected request"),
                        ));
                    }
                    if value["type"] == kind {
                        if let Some(error) = value["error"].as_str() {
                            return Err(failure("git_unavailable", error));
                        }
                        return Ok(value);
                    }
                }
                _ => {}
            }
        }
        Err(failure("disconnected", "Host disconnected before replying"))
    })
    .await
    .map_err(|_| {
        failure(
            "timeout",
            "Host request timed out; no operation was retried",
        )
    })?
}

pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(failure("invalid_argument", "Invalid session ID"));
    }
    Ok(())
}
pub(crate) fn print_data(machine: bool, mut value: Value) -> Result<()> {
    if let Some(object) = value.as_object_mut() {
        object.remove("requestId");
    }
    if machine {
        println!("{}", json!({"schemaVersion":1,"ok":true,"data":value}));
        std::io::stdout().flush()?;
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

pub(crate) fn provider_quota_query(program: Option<&str>, refresh: bool) -> Result<Value> {
    if program.is_some_and(|program| !matches!(program, "codex" | "claude" | "gemini")) {
        return Err(failure(
            "invalid_argument",
            "Quota program must be codex, claude or gemini",
        ));
    }
    if refresh && program.is_none() {
        return Err(failure(
            "invalid_argument",
            "A quota refresh requires an explicit program",
        ));
    }
    let mut query = json!({"type":"getProviderQuota","refresh":refresh});
    if let Some(program) = program {
        query["program"] = program.into();
    }
    Ok(query)
}
pub(crate) fn provider_quota_context_query(
    program: Option<&str>,
    refresh: bool,
    directory: Option<&str>,
) -> Result<Value> {
    let mut query = provider_quota_query(program, refresh)?;
    if let Some(directory) = directory {
        if program != Some("codex")
            || directory.is_empty()
            || directory.len() > 4096
            || directory.chars().any(char::is_control)
        {
            return Err(failure(
                "invalid_argument",
                "Quota directory requires Codex and a valid host folder",
            ));
        }
        query["directory"] = directory.into();
    }
    Ok(query)
}

pub(crate) fn check_provider_quota_capability(capabilities: &Value) -> Result<()> {
    if capabilities["providerQuotaObservations"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support quota observations; update nesvo-host",
        ));
    }
    Ok(())
}

pub(crate) fn quota_wake_query(
    session_id: &str,
    enabled: Option<bool>,
) -> Result<(Value, &'static str)> {
    valid_id(session_id)?;
    Ok(match enabled {
        Some(enabled) => (
            json!({"type":"setWake","sessionId":session_id,"enabled":enabled}),
            "wakeConfigured",
        ),
        None => (
            json!({"type":"getQuotaWake","sessionId":session_id}),
            "quotaWake",
        ),
    })
}

pub(crate) fn check_quota_wake_capability(capabilities: &Value) -> Result<()> {
    if capabilities
        .get("durableQuotaWake")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(failure(
            "unsupported",
            "Host does not support durable quota wakes; update nesvo-host",
        ));
    }
    Ok(())
}

pub(crate) async fn quota_wake_capability(connection: &mut Connection) -> Result<()> {
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    check_quota_wake_capability(&capabilities)
}

pub(crate) async fn provider_quota_capability(connection: &mut Connection) -> Result<()> {
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    check_provider_quota_capability(&capabilities)
}

fn provider_quota_text(value: &Value) -> String {
    let mut lines = Vec::new();
    if let Some(refresh) = value.get("refresh").filter(|refresh| refresh.is_object()) {
        let program = refresh["program"].as_str().unwrap_or("provider");
        let state = refresh["state"].as_str().unwrap_or("unknown");
        let revision = refresh["revision"].as_u64().unwrap_or(0);
        let detail = match state {
            "queued" => "accepted; inspect a later revision".to_owned(),
            "pending" => "already in progress; inspect a later revision".to_owned(),
            "cooldown" => format!(
                "retry after {} ms",
                refresh["retryAfterMs"].as_u64().unwrap_or(0)
            ),
            _ => "inspect the observation".to_owned(),
        };
        lines.push(format!(
            "Refresh: {program} {state} · revision {revision} · {detail}"
        ));
    }
    if let Some(providers) = value["providers"].as_array() {
        for provider in providers {
            let program = provider["program"].as_str().unwrap_or("provider");
            let freshness = provider["freshness"].as_str().unwrap_or("unknown");
            let freshness = if freshness == "fresh" {
                "fresh".to_owned()
            } else if provider["observedAt"].is_null() {
                format!("no observation ({freshness})")
            } else {
                format!("last-known ({freshness})")
            };
            let completeness = if provider["complete"] == true {
                "complete"
            } else {
                "partial"
            };
            let status = provider["status"].as_str().unwrap_or("unavailable");
            let reason = provider["reason"].as_str().unwrap_or("unavailable");
            lines.push(format!(
                "{program}: {freshness}, {completeness} · {status} · {reason}"
            ));
            lines.push(format!(
                "  Source: {} · revision {} · age {}",
                provider["source"].as_str().unwrap_or("unsupported"),
                provider["revision"].as_u64().unwrap_or(0),
                provider["ageMs"]
                    .as_u64()
                    .map_or_else(|| "unknown".to_owned(), |age| format!("{age} ms"))
            ));
            let permission = match provider["ordinaryUsageAllowed"].as_bool() {
                Some(false) => "backend denied ordinary usage",
                Some(true) => "reader permission observed; native account binding is unverified",
                None => "backend permission unavailable",
            };
            lines.push(format!("  {permission}"));
            lines.push(format!(
                "  Reader eligibility: {} · {}",
                if provider["ordinaryUsageEligible"] == true {
                    "eligible"
                } else {
                    "held"
                },
                provider["eligibilityReason"]
                    .as_str()
                    .unwrap_or("unavailable")
            ));
            if let Some(windows) = provider["windows"].as_array() {
                for window in windows {
                    lines.push(format!(
                        "  {} min: {}% used · reset {}",
                        window["durationMins"].as_u64().unwrap_or(0),
                        window["usedPercent"].as_u64().unwrap_or(0),
                        window["resetsAt"]
                            .as_i64()
                            .map_or_else(|| "unavailable".to_owned(), |at| at.to_string())
                    ));
                }
            }
        }
        if providers.is_empty() {
            lines.push("No installed provider observations available.".into());
        }
    }
    lines.join("\n")
}
async fn events(
    after: u64,
    limit: u16,
    session: Option<String>,
    watch: bool,
    machine: bool,
    connection: &mut Connection,
) -> Result<()> {
    if let Some(id) = &session {
        valid_id(id)?;
    }
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["domainEvents"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support durable events; update nesvo-host",
        ));
    }
    let mut query = json!({"type":if watch{"subscribeEvents"}else{"readEvents"},"after":after,"limit":limit,"sessionId":session});
    if !watch {
        return print_data(machine, request(connection, query, "events").await?);
    }
    let id = format!("cli-events-{}", hex::encode(nesvo_wire::random::<8>()));
    query["requestId"] = id.clone().into();
    connection
        .send(query)
        .map_err(|_| failure("disconnected", "Host connection is closed"))?;
    loop {
        let event = tokio::select! {
            event=connection.events.recv()=>event,
            _=tokio::signal::ctrl_c()=>return Ok(()),
        };
        match event {
            Some(NetworkEvent::Message(mut value)) if value["requestId"] == id => {
                if value["type"] == "error" {
                    return Err(failure(
                        value["code"].as_str().unwrap_or("request_rejected"),
                        value["message"]
                            .as_str()
                            .unwrap_or("Event subscription failed"),
                    ));
                }
                if value["type"] != "events" {
                    continue;
                }
                let gap = value["gap"] == true;
                if let Some(object) = value.as_object_mut() {
                    object.remove("requestId");
                }
                print_data(machine, value)?;
                if gap {
                    return Err(failure(
                        "cursor_expired",
                        "Event retention expired; reconcile current state before resuming",
                    ));
                }
            }
            Some(NetworkEvent::Disconnected(_)) | None => {
                return Err(failure(
                    "disconnected",
                    "Event connection closed; resume from the last received cursor",
                ));
            }
            _ => {}
        }
    }
}
async fn session_query(command: SessionCommand, connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["sessionQueries"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support session queries; update nesvo-host",
        ));
    }
    let (query, kind, machine) = match command {
        SessionCommand::List { json } => (json!({"type":"list"}), "sessions", json),
        SessionCommand::Get { id, json } => {
            valid_id(&id)?;
            (json!({"type":"getSession","sessionId":id}), "session", json)
        }
        SessionCommand::Current { json } => {
            let id = current_session(&caps)?;
            (json!({"type":"getSession","sessionId":id}), "session", json)
        }
        SessionCommand::Read {
            id,
            after,
            max_bytes,
            json,
        } => {
            valid_id(&id)?;
            (
                json!({"type":"readSession","sessionId":id,"after":after,"maxBytes":max_bytes}),
                "sessionRead",
                json,
            )
        }
        SessionCommand::Diff { id, scope, json } => {
            valid_id(&id)?;
            if caps["gitDiff"] != true {
                return Err(failure("unsupported", "Host does not support Git diff"));
            }
            (
                json!({"type":"getDiff","sessionId":id,"scope":scope.as_str()}),
                "diff",
                json,
            )
        }
        SessionCommand::Explain { .. }
        | SessionCommand::Recover { .. }
        | SessionCommand::Wake { .. }
        | SessionCommand::Interrupt(_)
        | SessionCommand::Stop(_)
        | SessionCommand::Create(_)
        | SessionCommand::Send(_)
        | SessionCommand::Wait { .. } => {
            unreachable!("effectful commands and diagnostics are dispatched separately")
        }
    };
    let mut response = request(connection, query, kind).await?;
    if let Some(value) = response.as_object_mut() {
        value.remove("requestId");
    }
    if kind == "sessionRead" && !machine {
        let rows = response["rows"].as_u64().unwrap_or(24).clamp(2, 150) as u16;
        let cols = response["cols"].as_u64().unwrap_or(80).clamp(10, 300) as u16;
        let mut parser = vt100::Parser::new(rows, cols, 0);
        parser.process(
            response["page"]["data"]
                .as_str()
                .unwrap_or_default()
                .as_bytes(),
        );
        println!("{}", parser.screen().contents());
        if response["page"]["gap"] == true {
            eprintln!("Output retention gap; this page is not a complete screen snapshot");
        }
        return Ok(());
    }
    print_data(machine, response)
}

pub(crate) fn current_session(capabilities: &Value) -> Result<String> {
    let id = capabilities["caller"]["sessionId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| std::env::var("NESVO_SESSION_ID").ok())
        .ok_or_else(|| {
            failure(
                "no_current_session",
                "No bound process context; run inside a managed session or supply an explicit ID",
            )
        })?;
    valid_id(&id)?;
    Ok(id)
}

pub(crate) async fn operation_capability(connection: &mut Connection) -> Result<Value> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["operationReceipts"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support durable operations; update nesvo-host",
        ));
    }
    Ok(caps)
}
const REVIEW_TEXT_LIMIT: usize = 32 * 1024;
const PROMPT_LIMIT: usize = 8192;
const WORKTREE_LAUNCH_WAIT_S: u64 = 3630;

pub(crate) fn worktree_setup_query(
    action: &str,
    directory: &str,
    digest: Option<&str>,
) -> Result<(Value, &'static str)> {
    if !bounded(directory, 4096) {
        return Err(failure(
            "invalid_argument",
            "Use an absolute host folder inside a Git repository",
        ));
    }
    if let Some(digest) = digest
        && (digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(failure(
            "invalid_argument",
            "Use the 64-character digest reported by describe",
        ));
    }
    let (kind, response) = match (action, digest) {
        ("describe", None) => ("describeWorktreeSetup", "worktreeSetup"),
        ("approve", Some(_)) => ("approveWorktreeSetup", "worktreeSetupApproved"),
        ("revoke", Some(_)) => ("revokeWorktreeSetup", "worktreeSetupRevoked"),
        _ => {
            return Err(failure(
                "invalid_argument",
                "Invalid worktree setup request",
            ));
        }
    };
    let mut query = json!({"type":kind,"directory":directory});
    if let Some(digest) = digest {
        query["digest"] = digest.into();
    }
    Ok((query, response))
}

pub(crate) fn worktree_session_query(
    action: &str,
    session: &str,
    discard: bool,
) -> Result<(Value, &'static str)> {
    valid_id(session)?;
    Ok(match (action, discard) {
        ("run", false) => (
            json!({"type":"runWorktree","sessionId":session}),
            "worktreeRunStarted",
        ),
        ("cancel", false) => (
            json!({"type":"cancelWorktree","sessionId":session}),
            "worktreeCancelled",
        ),
        ("archive", discard) => (
            json!({"type":"archiveWorktree","sessionId":session,"discard":discard}),
            "worktreeArchived",
        ),
        _ => return Err(failure("invalid_argument", "Invalid worktree request")),
    })
}

pub(crate) async fn worktree_capability(connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["worktrees"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support worktree setup, run and archive; update nesvo-host",
        ));
    }
    Ok(())
}

async fn worktree(command: WorktreeCommand, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let (query, kind) = match &command {
        WorktreeCommand::Describe { directory, .. } => {
            worktree_setup_query("describe", directory, None)?
        }
        WorktreeCommand::ApproveSetup {
            directory, digest, ..
        } => worktree_setup_query("approve", directory, Some(digest))?,
        WorktreeCommand::RevokeSetup {
            directory, digest, ..
        } => worktree_setup_query("revoke", directory, Some(digest))?,
        WorktreeCommand::Run { session, .. } => worktree_session_query("run", session, false)?,
        WorktreeCommand::Cancel { session, .. } => {
            worktree_session_query("cancel", session, false)?
        }
        WorktreeCommand::Archive {
            session, discard, ..
        } => worktree_session_query("archive", session, *discard)?,
        WorktreeCommand::List { .. } => (json!({"type":"listWorktrees"}), "worktreeRegistry"),
    };
    worktree_capability(connection).await?;
    print_data(machine, request(connection, query, kind).await?)
}

pub(crate) async fn workflow_templates_capability(connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["workflowTemplates"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support nesvo.toml workflow templates; update nesvo-host",
        ));
    }
    Ok(())
}

async fn workflow_templates(command: WorkflowCommand, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let (query, kind) = match &command {
        WorkflowCommand::Templates { directory, .. } => {
            crate::runs::template_command("list", directory, None, None)?
        }
        WorkflowCommand::ApproveTemplates {
            directory, digest, ..
        } => crate::runs::template_command("approve", directory, Some(digest), None)?,
        WorkflowCommand::RevokeTemplates {
            directory, digest, ..
        } => crate::runs::template_command("revoke", directory, Some(digest), None)?,
        WorkflowCommand::Start {
            name,
            directory,
            key,
            ..
        } => crate::runs::template_command("start", directory, None, Some((name, key)))?,
    };
    workflow_templates_capability(connection).await?;
    print_data(machine, request(connection, query, kind).await?)
}

fn bounded(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

pub(crate) fn open_review_query(
    session: Option<&str>,
    directory: Option<&str>,
    pull: Option<&str>,
    base: Option<&str>,
) -> Result<Value> {
    if let Some(session) = session {
        valid_id(session)?;
    }
    if directory.is_some_and(|directory| !bounded(directory, 4096))
        || pull.is_some_and(|url| !bounded(url, 512))
        || base.is_some_and(|base| !bounded(base, 256) || base.starts_with('-'))
    {
        return Err(failure("invalid_argument", "Invalid review source or base"));
    }
    let source = match (session, directory, pull) {
        (None, None, Some(url)) => json!({"kind":"pull","url":url}),
        (session, directory, None) if session.is_some() || directory.is_some() => {
            let mut source = json!({"kind":"local"});
            if let Some(session) = session {
                source["sessionId"] = session.into();
            }
            if let Some(directory) = directory {
                source["directory"] = directory.into();
            }
            source
        }
        _ => {
            return Err(failure(
                "invalid_argument",
                "Choose a session or directory, or exactly one pull request URL",
            ));
        }
    };
    let mut query = json!({"type":"openReview","source":source});
    if let Some(base) = base {
        query["base"] = base.into();
    }
    Ok(query)
}

pub(crate) fn deliver_review_query(
    review: &str,
    session: &str,
    text: &str,
    key: Option<&str>,
) -> Result<Value> {
    valid_id(review)?;
    valid_id(session)?;
    if let Some(key) = key {
        valid_id(key)?;
    }
    if text.trim().is_empty()
        || text.len() > REVIEW_TEXT_LIMIT
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(failure(
            "invalid_argument",
            "Review text must be nonempty UTF-8, at most 32768 bytes, without terminal controls",
        ));
    }
    let mut query =
        json!({"type":"deliverReview","reviewId":review,"sessionId":session,"text":text});
    if let Some(key) = key {
        query["key"] = key.into();
    }
    Ok(query)
}

pub(crate) const STDIN_SOURCE: &str = "-";

pub(crate) fn read_text_input(path: &Path, limit: usize) -> Result<String> {
    if path == Path::new(STDIN_SOURCE) {
        read_bounded_text(std::io::stdin().lock(), limit)
    } else {
        let file = std::fs::File::open(path)
            .map_err(|_| failure("invalid_argument", "Cannot read the text file"))?;
        read_bounded_text(file, limit)
    }
}

pub(crate) fn read_bounded_text(source: impl std::io::Read, limit: usize) -> Result<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    source
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("invalid_argument", "Cannot read the text input"))?;
    if bytes.len() > limit {
        return Err(failure(
            "input_too_large",
            &format!("Text input exceeds the {limit}-byte host limit"),
        ));
    }
    String::from_utf8(bytes).map_err(|_| failure("invalid_argument", "Text input must be UTF-8"))
}

pub(crate) async fn review_capability(connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["reviews"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support review sessions; update nesvo-host",
        ));
    }
    Ok(())
}

async fn review(command: ReviewCommand, connection: &mut Connection) -> Result<()> {
    let (query, kind, machine) = match command {
        ReviewCommand::Open {
            session,
            directory,
            pull,
            base,
            json,
        } => (
            open_review_query(
                session.as_deref(),
                directory.as_deref(),
                pull.as_deref(),
                base.as_deref(),
            )?,
            "reviewOpened",
            json,
        ),
        ReviewCommand::Deliver {
            review,
            session,
            file,
            text,
            key,
            json,
        } => {
            let text = match (text, file) {
                (Some(text), None) => text,
                (None, Some(path)) => read_text_input(&path, REVIEW_TEXT_LIMIT)?,
                _ => {
                    return Err(failure(
                        "invalid_argument",
                        "Pass exactly one of --text or --file",
                    ));
                }
            };
            (
                deliver_review_query(&review, &session, &text, key.as_deref())?,
                "reviewDelivered",
                json,
            )
        }
    };
    review_capability(connection).await?;
    let response = request(connection, query, kind).await?;
    if kind == "reviewDelivered" {
        check_receipt(&response)?;
    }
    print_data(machine, response)
}

fn read_prompt(
    literal: Option<String>,
    file: Option<std::path::PathBuf>,
    stdin: bool,
) -> Result<String> {
    let prompt = match (file, stdin) {
        (Some(path), _) => read_text_input(&path, PROMPT_LIMIT)?,
        (None, true) => read_text_input(Path::new(STDIN_SOURCE), PROMPT_LIMIT)?,
        (None, false) => literal.unwrap_or_default(),
    };
    if prompt.len() > PROMPT_LIMIT {
        return Err(failure(
            "input_too_large",
            "Prompt exceeds the 8192-byte host limit",
        ));
    }
    if prompt.contains('\0') {
        return Err(failure("invalid_argument", "Prompt must not contain NUL"));
    }
    Ok(prompt)
}
async fn create(options: CreateOptions, connection: &mut Connection) -> Result<()> {
    let prompt = read_prompt(options.prompt, options.prompt_file, options.stdin)?;
    let caps = operation_capability(connection).await?;
    let mut spec = json!({"name":options.name,"program":options.program,"cwd":options.cwd,"groupId":options.group,"worktree":options.worktree,"prompt":prompt});
    if let Some(path) = options.claude_quota_display_profile {
        let capture = json!({"displayProfile":path});
        if !crate::workflow_launches::valid_capture(&capture, &spec["program"]) {
            return Err(failure(
                "invalid_argument",
                "Claude quota capture requires Claude and an absolute host display-profile path",
            ));
        }
        if caps["claudeQuotaCapture"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot configure explicit Claude quota capture; update nesvo-host",
            ));
        }
        spec["claudeQuotaCapture"] = capture;
    }
    if options.model.is_some() || options.effort.is_some() {
        if caps["sessionModelProfiles"] != true {
            return Err(failure(
                "unsupported",
                "Host lacks launch-local model profile support; update nesvo-host",
            ));
        }
        if let Some(model) = options.model {
            spec["model"] = model.into();
        }
        if let Some(effort) = options.effort {
            spec["effort"] = effort.into();
        }
    }
    if options.role == "coordinator" {
        if caps["coordinatorScopes"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot enforce coordinator scopes; update nesvo-host",
            ));
        }
        spec["role"] = options.role.into();
    }
    if options.harness || options.no_harness {
        if caps["sessionHarness"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot configure session-scoped harness tools; update nesvo-host",
            ));
        }
        spec["harness"] = options.harness.into();
    }
    if !options.allowed_nesvo_tools.is_empty() {
        if caps["sessionToolPermissions"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot enforce process-scoped tool permission additions; update nesvo-host",
            ));
        }
        spec["allowedNesvoTools"] = options.allowed_nesvo_tools.into();
    }
    if !options.child_allowed_nesvo_tools.is_empty() {
        if caps["childToolPolicy"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot enforce an owner child-tool policy; update nesvo-host",
            ));
        }
        spec["childAllowedNesvoTools"] = options.child_allowed_nesvo_tools.into();
    }
    if let Some(parent) = options.parent {
        valid_id(&parent)?;
        if caps["sessionLineage"] != true {
            return Err(failure(
                "unsupported",
                "Host cannot preserve parent-session lineage; update nesvo-host",
            ));
        }
        spec["parentSessionId"] = parent.into();
    }
    let response = request(
        connection,
        json!({"type":"createOperation","key":options.key,"spec":spec}),
        "operation",
    )
    .await?;
    check_receipt(&response)?;
    print_data(options.json, response)
}

pub(crate) async fn prompt_capability(connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["promptReceipts"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support correlated prompt receipts; update nesvo-host",
        ));
    }
    Ok(())
}
pub(crate) async fn control_capability(connection: &mut Connection) -> Result<()> {
    let caps = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["controlReceipts"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support durable interruption/stop; update nesvo-host",
        ));
    }
    Ok(())
}
async fn control(
    options: ControlOptions,
    command_type: &str,
    connection: &mut Connection,
) -> Result<()> {
    valid_id(&options.id)?;
    control_capability(connection).await?;
    let response = request(
        connection,
        json!({"type":command_type,"sessionId":options.id,"key":options.key}),
        "operation",
    )
    .await?;
    check_receipt(&response)?;
    print_data(options.json, response)
}
async fn send(options: SendOptions, connection: &mut Connection) -> Result<()> {
    valid_id(&options.id)?;
    let prompt = read_prompt(options.prompt, options.prompt_file, options.stdin)?;
    prompt_capability(connection).await?;
    let response = request(
        connection,
        json!({"type":"sendOperation","sessionId":options.id,"key":options.key,"prompt":prompt}),
        "operation",
    )
    .await?;
    check_receipt(&response)?;
    print_data(options.json, response)
}
pub(crate) fn check_wait(response: &Value) -> Result<()> {
    if response["wait"]["reached"] == false {
        let outcome = response["wait"]["outcome"].as_str().unwrap_or("unknown");
        return Err(Failure {
            code: if outcome == "timeout" {
                "timeout"
            } else {
                "operation_failed"
            }
            .into(),
            message: format!(
                "Wait ended with {outcome}; inspect the same receipt before another submission"
            ),
            receipt: Some(response["receipt"].clone()),
        }
        .into());
    }
    Ok(())
}

pub(crate) fn check_receipt(response: &Value) -> Result<()> {
    if matches!(
        response["receipt"]["phase"].as_str(),
        Some("failed" | "unknown" | "interrupted")
    ) {
        return Err(Failure {
            code: "operation_failed".into(),
            message: format!(
                "Inspect operation {} before creating another request",
                response["receipt"]["id"].as_str().unwrap_or("unknown")
            ),
            receipt: Some(response["receipt"].clone()),
        }
        .into());
    }
    Ok(())
}
pub(crate) fn error_value(error: &anyhow::Error) -> Value {
    match error.downcast_ref::<Failure>() {
        Some(error) => failure_envelope(&error.code, &error.message, error.receipt.as_ref()),
        None => {
            json!({"schemaVersion":1,"ok":false,"error":{"code":"operation_unconfirmed","message":"Look up the same idempotency key before retrying","retryable":false}})
        }
    }
}

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let (session, machine) = match command {
        Command::Quota {
            program,
            refresh,
            directory,
            json,
        } => {
            let query =
                provider_quota_context_query(program.as_deref(), refresh, directory.as_deref())?;
            provider_quota_capability(connection).await?;
            if directory.is_some()
                && request(
                    connection,
                    json!({"type":"getCapabilities"}),
                    "capabilities",
                )
                .await?["providerQuotaContexts"]
                    != true
            {
                return Err(failure(
                    "unsupported",
                    "Host does not support configured-directory quota observations",
                ));
            }
            let response = request(connection, query, "providerQuota").await?;
            if json {
                return print_data(true, response);
            }
            println!("{}", provider_quota_text(&response));
            std::io::stdout().flush()?;
            return Ok(());
        }
        Command::Run { command } => return crate::workflow::run(command, connection).await,
        Command::Job { command } => return crate::job_commands::run(command, connection).await,
        Command::Budget { command } => {
            return crate::workflow::run(
                crate::workflow::Command::HostBudget { command },
                connection,
            )
            .await;
        }
        Command::Mcp => {
            return Err(failure(
                "invalid_argument",
                "MCP uses its own stdio entrypoint",
            ));
        }
        Command::Review { command } => return review(command, connection).await,
        Command::Worktree { command } => return worktree(command, connection).await,
        Command::Inbox { command } => return attention::run_inbox(command, connection).await,
        Command::Project { command } => {
            return crate::project_commands::run(command, connection).await;
        }
        Command::Decision { command } => {
            return attention::run_decision(command, connection).await;
        }
        Command::Workflow { command } => return workflow_templates(command, connection).await,
        Command::Operation {
            id,
            receipt_id,
            key,
            json,
        } => {
            operation_capability(connection).await?;
            return print_data(
                json,
                request(
                    connection,
                    json!({"type":"getOperation","id":id.or(receipt_id),"key":key}),
                    "operation",
                )
                .await?,
            );
        }
        Command::Session {
            command: SessionCommand::Create(options),
        } => return create(*options, connection).await,
        Command::Session {
            command: SessionCommand::Send(options),
        } => return send(options, connection).await,
        Command::Session {
            command: SessionCommand::Interrupt(options),
        } => return control(options, "interruptOperation", connection).await,
        Command::Session {
            command: SessionCommand::Stop(options),
        } => return control(options, "stopOperation", connection).await,
        Command::Session {
            command:
                SessionCommand::Wake {
                    id,
                    enable,
                    disable,
                    json,
                },
        } => {
            let enabled = if enable {
                Some(true)
            } else if disable {
                Some(false)
            } else {
                None
            };
            let (query, kind) = quota_wake_query(&id, enabled)?;
            quota_wake_capability(connection).await?;
            return print_data(json, request(connection, query, kind).await?);
        }
        Command::Session {
            command:
                SessionCommand::Wait {
                    id,
                    key,
                    session,
                    until,
                    timeout_ms,
                    json,
                },
        } => {
            if let Some(target) = &session {
                valid_id(target)?;
            }
            prompt_capability(connection).await?;
            let response = request(connection,json!({"type":"waitOperation","id":id,"key":key,"sessionId":session,"until":until.as_str(),"timeoutMs":timeout_ms}),"operation").await?;
            check_wait(&response)?;
            return print_data(json, response);
        }
        Command::Events {
            after,
            limit,
            session,
            watch,
            json,
        } => return events(after, limit, session, watch, json, connection).await,
        Command::Doctor { json } => (None, json),
        Command::Session {
            command: SessionCommand::Explain { id, json },
        } => {
            valid_id(&id)?;
            (Some(id), json)
        }
        Command::Session {
            command: SessionCommand::Recover { command },
        } => return crate::session_recovery::run(command, connection).await,
        Command::Session { command } => return session_query(command, connection).await,
    };
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if capabilities["diagnostics"] != true {
        return Err(failure(
            "unsupported",
            "This host does not support diagnostics; update nesvo-host",
        ));
    }
    let response = request(
        connection,
        json!({"type":"getDiagnostics", "sessionId":session}),
        "diagnostics",
    )
    .await?;
    let report = &response["report"];
    if machine {
        println!("{}", serde_json::to_string(report)?);
    } else {
        println!(
            "nesvo host {} · protocol {}",
            report["host"]["buildId"].as_str().unwrap_or("unknown"),
            report["host"]["protocolVersion"]
        );
        if let Some(versions) = report["providerVersions"].as_array() {
            for item in versions {
                println!(
                    "{}: {}",
                    item["program"].as_str().unwrap_or("provider"),
                    item["version"]
                        .as_str()
                        .unwrap_or_else(|| item["status"].as_str().unwrap_or("unavailable"))
                );
            }
        }
        if let Some(sessions) = report["sessions"].as_array() {
            if sessions.is_empty() {
                println!("No live session records; create a session to inspect provider delivery.");
            }
            for session in sessions {
                println!(
                    "{} · {} · {} ({})",
                    session["sessionId"].as_str().unwrap_or("?"),
                    session["program"].as_str().unwrap_or("?"),
                    session["status"]["selected"]["state"]
                        .as_str()
                        .unwrap_or("unknown"),
                    session["status"]["selected"]["source"]
                        .as_str()
                        .unwrap_or("unknown")
                );
                println!(
                    "  {}",
                    session["status"]["reason"]
                        .as_str()
                        .unwrap_or("No explanation")
                );
                if session["harness"]["enabled"] == true {
                    println!(
                        "  Harness: launch-local Nesvo MCP + instruction v{} prepared; provider loading not yet verified",
                        session["harness"]["instructionVersion"]
                    );
                }
                println!(
                    "  Integration: {} · delivery {} · helper error {}",
                    session["integration"]["adapter"].as_str().unwrap_or("none"),
                    session["integration"]["delivery"]["outcome"]
                        .as_str()
                        .unwrap_or("notObserved"),
                    session["integration"]["delivery"]["helperError"]
                );
                println!(
                    "  OSC 7501: {} probes, {} reports",
                    session["terminalProtocol"]["queries"], session["terminalProtocol"]["reports"]
                );
                for line in crate::capture_explain::lines(&session["claudeQuotaCapture"]) {
                    println!("  {line}");
                }
                if session["harness"]["recovery"]["configured"] == true {
                    println!(
                        "  Recovery: {} · {}",
                        session["harness"]["recovery"]["status"]["outcome"]
                            .as_str()
                            .unwrap_or("unobserved"),
                        session["harness"]["recovery"]["status"]["source"]
                            .as_str()
                            .unwrap_or("no source")
                    );
                }
            }
        }
    }
    Ok(())
}

pub(crate) mod attention {
    use super::{failure, print_data, request};
    use crate::network::Connection;
    use anyhow::Result;
    use clap::Subcommand;
    use rmcp::model::{Tool, ToolAnnotations};
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::sync::Arc;

    #[derive(Subcommand)]
    pub enum InboxCommand {
        #[command(
            about = "List one page of needs-you items across sessions, runs, decisions and job results"
        )]
        List {
            #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=1024))]
            page: u16,
            #[arg(long, default_value_t = 16, value_parser = clap::value_parser!(u16).range(1..=32))]
            limit: u16,
            #[arg(long)]
            json: bool,
        },
        #[command(
            about = "Acknowledge items as ID@REVISION; the receipt keeps them hidden across reconnects"
        )]
        Ack {
            #[arg(required = true, num_args = 1..=32)]
            items: Vec<String>,
            #[arg(long)]
            json: bool,
        },
    }

    #[derive(Subcommand)]
    pub enum DecisionCommand {
        #[command(about = "List pending decisions across all runs, oldest first")]
        List {
            #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=512))]
            page: u16,
            #[arg(long)]
            json: bool,
        },
        #[command(
            about = "Answer one pending decision by ID; resolved or expired decisions are refused"
        )]
        Decide {
            id: String,
            #[arg(
                long,
                required_unless_present = "choice_file",
                conflicts_with = "choice_file"
            )]
            choice: Option<String>,
            #[arg(long)]
            choice_file: Option<std::path::PathBuf>,
            #[arg(long, conflicts_with = "note_file")]
            note: Option<String>,
            #[arg(long)]
            note_file: Option<std::path::PathBuf>,
            #[arg(long)]
            json: bool,
        },
    }

    const CHOICE_LIMIT: usize = 2048;
    const NOTE_LIMIT: usize = 1024;

    impl DecisionCommand {
        pub fn resolved(self) -> Result<Self> {
            Ok(match self {
                Self::Decide {
                    id,
                    choice,
                    choice_file,
                    note,
                    note_file,
                    json,
                } => Self::Decide {
                    id,
                    choice: match choice_file {
                        Some(path) => Some(super::read_text_input(&path, CHOICE_LIMIT)?),
                        None => choice,
                    },
                    choice_file: None,
                    note: match note_file {
                        Some(path) => Some(super::read_text_input(&path, NOTE_LIMIT)?),
                        None => note,
                    },
                    note_file: None,
                    json,
                },
                command => command,
            })
        }
    }

    impl InboxCommand {
        pub fn machine(&self) -> bool {
            match self {
                Self::List { json, .. } | Self::Ack { json, .. } => *json,
            }
        }
    }

    impl DecisionCommand {
        pub fn machine(&self) -> bool {
            match self {
                Self::List { json, .. } | Self::Decide { json, .. } => *json,
            }
        }
    }

    fn bounded_text(value: &str, max: usize) -> bool {
        !value.trim().is_empty()
            && value.len() <= max
            && !value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    }

    fn mark(item: &str) -> Result<Value> {
        let parsed = item.rsplit_once('@').and_then(|(id, revision)| {
            let revision = revision.parse::<u64>().ok()?;
            (!id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
                .then(|| json!({"id":id,"revision":revision}))
        });
        parsed.ok_or_else(|| {
            failure(
                "invalid_argument",
                "Acknowledge items as ID@REVISION from inbox list",
            )
        })
    }

    pub fn inbox_query(command: &InboxCommand) -> Result<(Value, &'static str)> {
        Ok(match command {
            InboxCommand::List { page, limit, .. } => (
                json!({"type":"attentionInbox","page":page,"limit":limit}),
                "attentionInbox",
            ),
            InboxCommand::Ack { items, .. } => {
                if items.is_empty() || items.len() > 32 {
                    return Err(failure("invalid_argument", "Acknowledge 1–32 items"));
                }
                let items = items
                    .iter()
                    .map(|item| mark(item))
                    .collect::<Result<Vec<_>>>()?;
                (
                    json!({"type":"acknowledgeInbox","items":items}),
                    "inboxAcknowledged",
                )
            }
        })
    }

    pub fn decision_query(command: &DecisionCommand) -> Result<(Value, &'static str)> {
        Ok(match command {
            DecisionCommand::List { page, .. } => {
                (json!({"type":"decisions","page":page}), "decisions")
            }
            DecisionCommand::Decide {
                id,
                choice: Some(choice),
                choice_file: None,
                note,
                note_file: None,
                ..
            } => {
                super::valid_id(id)
                    .map_err(|_| failure("invalid_argument", "Invalid decision ID"))?;
                if !bounded_text(choice, CHOICE_LIMIT)
                    || note
                        .as_deref()
                        .is_some_and(|note| !bounded_text(note, NOTE_LIMIT))
                {
                    return Err(failure(
                        "invalid_argument",
                        "Choice must be 1–2048 bytes and a note at most 1024 bytes",
                    ));
                }
                let mut query = json!({"type":"decide","decisionId":id,"choice":choice});
                if let Some(note) = note {
                    query["note"] = note.clone().into();
                }
                (query, "decided")
            }
            DecisionCommand::Decide { .. } => {
                return Err(failure(
                    "invalid_argument",
                    "Pass exactly one of --choice or --choice-file",
                ));
            }
        })
    }

    pub fn check_capability(capabilities: &Value, query: &Value) -> Result<()> {
        let flag = match query["type"].as_str() {
            Some("decisions" | "decide") => "decisions",
            _ => "attentionInbox",
        };
        if capabilities[flag] != true {
            return Err(failure(
                "unsupported",
                "Host does not support the owner attention inbox and decisions; update nesvo-host",
            ));
        }
        Ok(())
    }

    pub async fn capability(connection: &mut Connection, query: &Value) -> Result<()> {
        let capabilities = request(
            connection,
            json!({"type":"getCapabilities"}),
            "capabilities",
        )
        .await?;
        check_capability(&capabilities, query)
    }

    async fn send(
        machine: bool,
        (query, kind): (Value, &str),
        connection: &mut Connection,
    ) -> Result<()> {
        capability(connection, &query).await?;
        print_data(machine, request(connection, query, kind).await?)
    }

    pub async fn run_inbox(command: InboxCommand, connection: &mut Connection) -> Result<()> {
        send(command.machine(), inbox_query(&command)?, connection).await
    }

    pub async fn run_decision(command: DecisionCommand, connection: &mut Connection) -> Result<()> {
        send(
            command.machine(),
            decision_query(&command.resolved()?)?,
            connection,
        )
        .await
    }

    pub const TOOLS: [&str; 4] = [
        "nesvo_list_attention_inbox",
        "nesvo_ack_attention_inbox",
        "nesvo_list_pending_decisions",
        "nesvo_decide",
    ];

    fn object(properties: Value, required: &[&str]) -> serde_json::Map<String, Value> {
        serde_json::from_value(json!({"type":"object","additionalProperties":false,"properties":properties,"required":required}))
            .expect("constant attention input schema")
    }

    pub fn catalog() -> Vec<Tool> {
        [
            (
                TOOLS[0],
                "Owner-only: one page of needs-you items across sessions, runs, pending decisions and finished job results, sorted by priority. Each item has a stable id and a revision; follow nextPage. Acknowledged revisions stay hidden; a newer revision of the same item returns. Needs attentionInbox:true.",
                object(
                    json!({"page":{"type":"integer","minimum":0,"maximum":1024,"default":0},"limit":{"type":"integer","minimum":1,"maximum":32,"default":16}}),
                    &[],
                ),
                true,
            ),
            (
                TOOLS[1],
                "Owner-only: acknowledge 1–32 inbox items by id and revision. Acknowledgements are durable receipts: repeating one returns the original acknowledgedAt, and reconnecting never shows the same revision again. Acknowledging does not answer a decision or validate a result.",
                object(
                    json!({"items":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["id","revision"],"properties":{"id":{"type":"string","minLength":1,"maxLength":200},"revision":{"type":"integer","minimum":0}}}}}),
                    &["items"],
                ),
                false,
            ),
            (
                TOOLS[2],
                "Owner-only: pending decisions across all runs, oldest first, eight per page with their run and inbox id. No run ID is needed. Needs decisions:true.",
                object(
                    json!({"page":{"type":"integer","minimum":0,"maximum":512,"default":0}}),
                    &[],
                ),
                true,
            ),
            (
                TOOLS[3],
                "Owner-only: answer one pending decision by its ID at its current revision. choice is the literal answer the worker receives; an optional note follows it after a blank line. Answered or canceled decisions are refused with decision_resolved and expired ones with decision_expired, so a retry never answers twice. Not a native permission grant.",
                object(
                    json!({"decisionId":{"type":"string","minLength":1,"maxLength":128},"choice":{"type":"string","minLength":1,"maxLength":2048},"note":{"type":"string","minLength":1,"maxLength":1024}}),
                    &["decisionId", "choice"],
                ),
                false,
            ),
        ]
        .into_iter()
        .map(|(name, description, schema, read_only)| {
            Tool::new(name, description, schema)
                .with_annotations(
                    ToolAnnotations::new()
                        .read_only(read_only)
                        .destructive(false)
                        .idempotent(true)
                        .open_world(!read_only),
                )
                .with_raw_output_schema(Arc::new(
                    serde_json::from_value(json!({"type":"object","required":["schemaVersion","ok"],"properties":{"schemaVersion":{"const":1},"ok":{"type":"boolean"},"data":{"type":"object"},"error":{"type":"object"}}}))
                        .expect("constant attention result schema"),
                ))
        })
        .collect()
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Page {
        #[serde(default)]
        page: u16,
        #[serde(default)]
        limit: Option<u16>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Marks {
        items: Vec<Item>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Item {
        id: String,
        revision: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Decide {
        decision_id: String,
        choice: String,
        note: Option<String>,
    }

    fn parse<T: serde::de::DeserializeOwned>(arguments: &Value) -> Result<T> {
        serde_json::from_value(arguments.clone()).map_err(|_| {
            failure(
                "invalid_argument",
                "Attention arguments must match the strict tool schema",
            )
        })
    }

    pub fn command(name: &str, arguments: &Value) -> Option<Result<(Value, &'static str)>> {
        let index = TOOLS.iter().position(|tool| *tool == name)?;
        Some((|| match index {
            0 => {
                let Page { page, limit } = parse(arguments)?;
                let limit = limit.unwrap_or(16);
                if page > 1024 || !(1..=32).contains(&limit) {
                    return Err(failure("invalid_argument", "page 0–1024, limit 1–32"));
                }
                inbox_query(&InboxCommand::List {
                    page,
                    limit,
                    json: true,
                })
            }
            1 => {
                let Marks { items } = parse(arguments)?;
                inbox_query(&InboxCommand::Ack {
                    items: items
                        .into_iter()
                        .map(|item| format!("{}@{}", item.id, item.revision))
                        .collect(),
                    json: true,
                })
            }
            2 => {
                let Page { page, limit } = parse(arguments)?;
                if page > 512 || limit.is_some() {
                    return Err(failure("invalid_argument", "page must be 0–512"));
                }
                decision_query(&DecisionCommand::List { page, json: true })
            }
            _ => {
                let Decide {
                    decision_id,
                    choice,
                    note,
                } = parse(arguments)?;
                decision_query(&DecisionCommand::Decide {
                    id: decision_id,
                    choice: Some(choice),
                    choice_file: None,
                    note,
                    note_file: None,
                    json: true,
                })
            }
        })())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use clap::Parser;

        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: crate::cli::Command,
        }

        fn parsed(arguments: &[&str]) -> crate::cli::Command {
            let mut argv = vec!["nesvo"];
            argv.extend_from_slice(arguments);
            Cli::try_parse_from(argv).unwrap().command
        }

        #[test]
        fn inbox_and_decision_cli_build_strict_owner_requests() {
            let crate::cli::Command::Inbox { command } =
                parsed(&["inbox", "list", "--page", "2", "--limit", "8", "--json"])
            else {
                panic!("inbox command expected");
            };
            assert!(command.machine());
            assert_eq!(
                inbox_query(&command).unwrap(),
                (
                    json!({"type":"attentionInbox","page":2,"limit":8}),
                    "attentionInbox"
                )
            );
            let crate::cli::Command::Inbox { command } =
                parsed(&["inbox", "ack", "decision:run:one@3", "session:abc@0"])
            else {
                panic!("inbox command expected");
            };
            assert_eq!(
                inbox_query(&command).unwrap(),
                (
                    json!({"type":"acknowledgeInbox","items":[{"id":"decision:run:one","revision":3},{"id":"session:abc","revision":0}]}),
                    "inboxAcknowledged"
                )
            );
            let crate::cli::Command::Decision { command } = parsed(&[
                "decision", "decide", "abc", "--choice", "main", "--note", "keep API",
            ]) else {
                panic!("decision command expected");
            };
            assert_eq!(
                decision_query(&command).unwrap(),
                (
                    json!({"type":"decide","decisionId":"abc","choice":"main","note":"keep API"}),
                    "decided"
                )
            );
            let crate::cli::Command::Decision { command } = parsed(&["decision", "list"]) else {
                panic!("decision command expected");
            };
            assert_eq!(
                decision_query(&command).unwrap(),
                (json!({"type":"decisions","page":0}), "decisions")
            );
            for argv in [
                vec!["nesvo", "inbox", "ack"],
                vec!["nesvo", "inbox", "list", "--limit", "33"],
                vec!["nesvo", "decision", "list", "--page", "513"],
                vec!["nesvo", "decision", "decide", "abc"],
            ] {
                assert!(Cli::try_parse_from(argv).is_err());
            }
            for item in ["no-revision", "@1", "id@-1", "id@x"] {
                assert!(
                    inbox_query(&InboxCommand::Ack {
                        items: vec![item.into()],
                        json: true
                    })
                    .is_err(),
                    "{item}"
                );
            }
            assert!(
                decision_query(&DecisionCommand::Decide {
                    id: "abc".into(),
                    choice: Some(" ".into()),
                    choice_file: None,
                    note: None,
                    note_file: None,
                    json: true
                })
                .is_err()
            );
            let unresolved = DecisionCommand::Decide {
                id: "abc".into(),
                choice: None,
                choice_file: Some("-".into()),
                note: None,
                note_file: None,
                json: true,
            };
            assert!(decision_query(&unresolved).is_err());
            let path = std::env::temp_dir().join(format!(
                "nesvo-choice-{}.txt",
                hex::encode(nesvo_wire::random::<8>())
            ));
            std::fs::write(&path, "use the main branch").unwrap();
            let from_file = DecisionCommand::Decide {
                id: "abc".into(),
                choice: None,
                choice_file: Some(path.clone()),
                note: None,
                note_file: Some(path.clone()),
                json: true,
            }
            .resolved()
            .unwrap();
            assert_eq!(
                decision_query(&from_file).unwrap().0,
                json!({"type":"decide","decisionId":"abc","choice":"use the main branch","note":"use the main branch"})
            );
            std::fs::write(&path, "x".repeat(1025)).unwrap();
            let too_long = DecisionCommand::Decide {
                id: "abc".into(),
                choice: Some("yes".into()),
                choice_file: None,
                note: None,
                note_file: Some(path.clone()),
                json: true,
            }
            .resolved()
            .err()
            .unwrap();
            assert_eq!(
                crate::cli::error_value(&too_long)["error"]["code"],
                "input_too_large"
            );
            std::fs::remove_file(&path).unwrap();
            for argv in [
                vec!["nesvo", "decision", "decide", "abc", "--choice-file", "-"],
                vec![
                    "nesvo",
                    "decision",
                    "decide",
                    "abc",
                    "--choice",
                    "y",
                    "--note-file",
                    "-",
                ],
            ] {
                assert!(Cli::try_parse_from(argv).is_ok());
            }
            assert!(
                Cli::try_parse_from([
                    "nesvo",
                    "decision",
                    "decide",
                    "abc",
                    "--choice",
                    "y",
                    "--choice-file",
                    "-"
                ])
                .is_err()
            );
        }

        #[test]
        fn attention_outputs_are_published_in_the_cli_schema() {
            let schema: Value =
                serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json"))
                    .unwrap();
            let kinds: Vec<&str> = schema["oneOf"][1]["properties"]["data"]["oneOf"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|shape| shape["properties"]["type"]["const"].as_str())
                .collect();
            for kind in [
                "attentionInbox",
                "inboxAcknowledged",
                "decisions",
                "decided",
            ] {
                assert!(kinds.contains(&kind), "{kind}");
            }
            let definitions = &schema["definitions"];
            assert_eq!(
                definitions["attentionItem"]["properties"]["kind"]["enum"],
                json!(["session", "decision", "run", "result"])
            );
            assert_eq!(
                definitions["attentionReceipt"]["required"],
                json!(["id", "revision", "acknowledgedAt"])
            );
        }

        #[test]
        fn attention_commands_are_gated_by_capability_flags() {
            let inbox = json!({"type":"attentionInbox"});
            let decide = json!({"type":"decide"});
            assert!(check_capability(&json!({}), &inbox).is_err());
            assert!(check_capability(&json!({"decisions":true}), &inbox).is_err());
            assert!(check_capability(&json!({"attentionInbox":true}), &decide).is_err());
            assert!(check_capability(&json!({"attentionInbox":true}), &inbox).is_ok());
            assert!(check_capability(&json!({"decisions":true}), &decide).is_ok());
        }

        #[test]
        fn attention_mcp_tools_map_to_the_same_strict_requests() {
            assert_eq!(
                command("nesvo_list_attention_inbox", &json!({}))
                    .unwrap()
                    .unwrap(),
                (
                    json!({"type":"attentionInbox","page":0,"limit":16}),
                    "attentionInbox"
                )
            );
            assert_eq!(
                command(
                    "nesvo_ack_attention_inbox",
                    &json!({"items":[{"id":"result:o","revision":2}]})
                )
                .unwrap()
                .unwrap()
                .0["items"],
                json!([{"id":"result:o","revision":2}])
            );
            assert_eq!(
                command("nesvo_list_pending_decisions", &json!({"page":1}))
                    .unwrap()
                    .unwrap(),
                (json!({"type":"decisions","page":1}), "decisions")
            );
            assert_eq!(
                command("nesvo_decide", &json!({"decisionId":"d","choice":"yes"}))
                    .unwrap()
                    .unwrap(),
                (
                    json!({"type":"decide","decisionId":"d","choice":"yes"}),
                    "decided"
                )
            );
            for (name, arguments) in [
                ("nesvo_list_attention_inbox", json!({"limit":0})),
                ("nesvo_list_attention_inbox", json!({"runId":"r"})),
                ("nesvo_ack_attention_inbox", json!({"items":[]})),
                ("nesvo_list_pending_decisions", json!({"limit":8})),
                ("nesvo_decide", json!({"decisionId":"d"})),
                (
                    "nesvo_decide",
                    json!({"decisionId":"d","choice":"x","runId":"r"}),
                ),
            ] {
                assert!(command(name, &arguments).unwrap().is_err(), "{name}");
            }
            assert!(command("nesvo_list_sessions", &json!({})).is_none());
            let names: Vec<String> = catalog().iter().map(|tool| tool.name.to_string()).collect();
            assert_eq!(names, TOOLS);
        }
    }
}

#[cfg(test)]
#[path = "quota_cli_tests.rs"]
mod quota_tests;

#[cfg(test)]
#[path = "quota_wake_cli_tests.rs"]
mod quota_wake_tests;

#[cfg(test)]
mod worktree_tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: Command,
    }

    #[test]
    fn worktree_cli_builds_strict_owner_requests() {
        let digest = "a".repeat(64);
        assert_eq!(
            worktree_setup_query("describe", "/repo", None).unwrap(),
            (
                json!({"type":"describeWorktreeSetup","directory":"/repo"}),
                "worktreeSetup"
            )
        );
        assert_eq!(
            worktree_setup_query("approve", "/repo", Some(&digest)).unwrap(),
            (
                json!({"type":"approveWorktreeSetup","directory":"/repo","digest":digest}),
                "worktreeSetupApproved"
            )
        );
        assert_eq!(
            worktree_session_query("archive", "s", true).unwrap(),
            (
                json!({"type":"archiveWorktree","sessionId":"s","discard":true}),
                "worktreeArchived"
            )
        );
        assert_eq!(
            worktree_session_query("run", "s", false).unwrap().1,
            "worktreeRunStarted"
        );
        for (action, directory, digest) in [
            ("approve", "/repo", None),
            ("describe", "/repo", Some(digest.as_str())),
            ("approve", "/repo", Some("short")),
            ("approve", "", Some(digest.as_str())),
            ("revoke", "bad\npath", Some(digest.as_str())),
            ("delete", "/repo", None),
        ] {
            assert!(worktree_setup_query(action, directory, digest).is_err());
        }
        assert!(worktree_session_query("run", "s", true).is_err());
        assert!(worktree_session_query("archive", "bad\nid", false).is_err());
        let parsed =
            Cli::try_parse_from(["nesvo", "worktree", "archive", "s", "--discard", "--json"])
                .unwrap();
        assert!(parsed.command.machine());
        let Command::Worktree {
            command: WorktreeCommand::Archive { discard, .. },
        } = parsed.command
        else {
            panic!("archive parses as a worktree command");
        };
        assert!(discard);
        for valid in [
            vec!["nesvo", "worktree", "describe", "--directory", "/repo"],
            vec![
                "nesvo",
                "worktree",
                "approve-setup",
                "--directory",
                "/repo",
                "--digest",
                &digest,
            ],
            vec!["nesvo", "worktree", "run", "s"],
            vec!["nesvo", "worktree", "cancel", "s"],
            vec!["nesvo", "worktree", "list", "--json"],
        ] {
            assert!(Cli::try_parse_from(valid).is_ok());
        }
        for invalid in [
            vec!["nesvo", "worktree", "approve-setup", "--directory", "/repo"],
            vec!["nesvo", "worktree", "run"],
            vec!["nesvo", "worktree", "run", "s", "--discard"],
        ] {
            assert!(Cli::try_parse_from(invalid).is_err());
        }
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let published: Vec<&str> = schema["oneOf"][1]["properties"]["data"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|variant| variant["properties"]["type"]["const"].as_str())
            .collect();
        for kind in [
            "worktreeSetup",
            "worktreeSetupApproved",
            "worktreeSetupRevoked",
            "worktreeRunStarted",
            "worktreeCancelled",
            "worktreeArchived",
            "worktreeRegistry",
        ] {
            assert!(published.contains(&kind), "{kind}");
        }
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: Command,
    }

    #[test]
    fn review_cli_builds_bounded_open_and_deliver_requests() {
        assert_eq!(
            open_review_query(Some("s"), None, None, Some("main")).unwrap(),
            json!({"type":"openReview","source":{"kind":"local","sessionId":"s"},"base":"main"})
        );
        assert_eq!(
            open_review_query(None, None, Some("https://github.com/a/b/pull/1"), None).unwrap(),
            json!({"type":"openReview","source":{"kind":"pull","url":"https://github.com/a/b/pull/1"}})
        );
        for (session, directory, pull, base) in [
            (None, None, None, None),
            (Some("s"), None, Some("https://github.com/a/b/pull/1"), None),
            (Some("s"), None, None, Some("--upload-pack=x")),
            (Some("bad\nid"), None, None, None),
            (None, Some(""), None, None),
        ] {
            assert!(open_review_query(session, directory, pull, base).is_err());
        }
        assert_eq!(
            deliver_review_query("r", "s", "line\n\tnext", Some("k")).unwrap(),
            json!({"type":"deliverReview","reviewId":"r","sessionId":"s","text":"line\n\tnext","key":"k"})
        );
        let long = "x".repeat(REVIEW_TEXT_LIMIT + 1);
        for text in ["", " ", "\u{1b}[201~", long.as_str()] {
            assert!(deliver_review_query("r", "s", text, None).is_err());
        }
        let parsed = Cli::try_parse_from([
            "nesvo",
            "review",
            "deliver",
            "--review",
            "r",
            "--session",
            "s",
            "--text",
            "x",
            "--json",
        ])
        .unwrap();
        assert!(parsed.command.machine());
        for invalid in [
            vec!["nesvo", "review", "open"],
            vec!["nesvo", "review", "open", "--session", "s", "--pull", "u"],
            vec![
                "nesvo",
                "review",
                "deliver",
                "--review",
                "r",
                "--session",
                "s",
                "--text",
                "x",
                "--file",
                "f",
            ],
            vec![
                "nesvo",
                "review",
                "deliver",
                "--review",
                "r",
                "--session",
                "s",
            ],
        ] {
            assert!(Cli::try_parse_from(invalid).is_err());
        }
    }
}

#[cfg(test)]
mod agent_convention_tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: Command,
    }

    fn code_of(error: &anyhow::Error) -> String {
        error_value(error)["error"]["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn exit_codes_map_representative_host_errors() {
        for (code, exit) in [
            ("invalid_argument", 1),
            ("input_too_large", 1),
            ("invalid_cursor", 1),
            ("idempotency_conflict", 1),
            ("no_current_session", 1),
            ("session_not_found", 1),
            ("decision_not_found", 1),
            ("context_too_large", 1),
            ("pairing_unavailable", 2),
            ("host_unavailable", 2),
            ("disconnected", 2),
            ("timeout", 2),
            ("host_stopping", 2),
            ("forbidden", 3),
            ("scope_revoked", 3),
            ("coordinator_required", 3),
            ("control_busy", 3),
            ("trigger_unauthorized", 3),
            ("busy", 4),
            ("unsupported", 4),
            ("operation_failed", 4),
            ("git_unavailable", 4),
            ("quota_wait", 4),
            ("request_rejected", 4),
            ("revision_conflict", 5),
            ("stale_attempt", 5),
            ("stale_operation", 5),
            ("coordinator_changed", 5),
            ("decision_state_conflict", 5),
            ("attempt_state_conflict", 5),
            ("run_state_conflict", 5),
            ("decision_pending", 5),
            ("decision_resolved", 5),
            ("decision_expired", 5),
            ("cursor_expired", 5),
            ("quota_wake_expired", 5),
            ("context_changed", 5),
            ("job_generation_retired", 5),
            ("run_binding_changed", 5),
        ] {
            assert_eq!(exit_code(code), exit, "{code}");
            assert_eq!(emit_failure(false, code, "fixture"), exit, "{code}");
        }
    }

    #[test]
    fn failure_receipts_carry_exit_code_and_stable_code_for_cli_only() {
        let receipt = json!({"id":"op","phase":"failed"});
        let value = failure_receipt("revision_conflict", "Revision changed", Some(&receipt));
        assert_eq!(
            value,
            json!({"schemaVersion":1,"ok":false,"error":{"code":"revision_conflict","message":"Revision changed","retryable":false,"exitCode":5,"receipt":receipt}})
        );
        assert_eq!(
            failure_receipt("disconnected", "Closed", None)["error"]["retryable"],
            true
        );
        let mcp = error_value(&failure("forbidden", "No"));
        assert!(mcp["error"].get("exitCode").is_none());
        assert_eq!(mcp["error"]["code"], "forbidden");
    }

    #[test]
    fn failure_schema_publishes_the_exit_code_contract() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let error = &schema["oneOf"][0]["properties"]["error"];
        assert_eq!(error["properties"]["exitCode"]["type"], "integer");
        assert_eq!(
            error["properties"]["exitCode"]["enum"],
            json!([1, 2, 3, 4, 5])
        );
        assert!(
            !error["required"]
                .as_array()
                .unwrap()
                .contains(&json!("exitCode"))
        );
        let workflow = schema["oneOf"][1]["properties"]["data"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variant| variant["properties"]["type"]["const"] == "workflow")
            .unwrap();
        assert_eq!(
            workflow["properties"]["signal"]["properties"]["kind"]["enum"],
            json!(["blocked", "question"])
        );
    }

    #[test]
    fn text_input_reads_stdin_marker_and_files_and_refuses_over_the_cap() {
        assert_eq!(
            read_bounded_text(std::io::Cursor::new("line\nnext"), 16).unwrap(),
            "line\nnext"
        );
        assert_eq!(
            read_bounded_text(std::io::Cursor::new("x".repeat(16)), 16).unwrap(),
            "x".repeat(16)
        );
        let over = read_bounded_text(std::io::Cursor::new("x".repeat(17)), 16).unwrap_err();
        assert_eq!(code_of(&over), "input_too_large");
        assert_eq!(exit_code(&code_of(&over)), EXIT_BAD_REQUEST);
        let split = read_bounded_text(std::io::Cursor::new("ééé"), 5).unwrap_err();
        assert_eq!(code_of(&split), "input_too_large");
        let binary = read_bounded_text(std::io::Cursor::new(vec![0xff, 0xfe]), 16).unwrap_err();
        assert_eq!(code_of(&binary), "invalid_argument");
        let path = std::env::temp_dir().join(format!(
            "nesvo-text-input-{}.txt",
            hex::encode(nesvo_wire::random::<8>())
        ));
        std::fs::write(&path, "review text").unwrap();
        assert_eq!(read_text_input(&path, 64).unwrap(), "review text");
        assert_eq!(
            code_of(&read_text_input(&path, 4).unwrap_err()),
            "input_too_large"
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            code_of(&read_text_input(&path, 64).unwrap_err()),
            "invalid_argument"
        );
        assert_eq!(
            read_prompt(Some("inline".into()), None, false).unwrap(),
            "inline"
        );
        let long = read_prompt(Some("x".repeat(PROMPT_LIMIT + 1)), None, false).unwrap_err();
        assert_eq!(code_of(&long), "input_too_large");
    }

    #[test]
    fn long_text_arguments_accept_the_stdin_marker_and_keep_inline_forms() {
        for valid in [
            vec![
                "nesvo",
                "session",
                "send",
                "s",
                "--key",
                "k",
                "--prompt-file",
                "-",
            ],
            vec![
                "nesvo", "session", "send", "s", "--key", "k", "--prompt", "x",
            ],
            vec![
                "nesvo",
                "session",
                "create",
                "n",
                "--key",
                "k",
                "--prompt-file",
                "-",
            ],
            vec![
                "nesvo",
                "review",
                "deliver",
                "--review",
                "r",
                "--session",
                "s",
                "--file",
                "-",
            ],
            vec![
                "nesvo",
                "run",
                "create",
                "t",
                "--key",
                "k",
                "--goal-file",
                "-",
            ],
            vec![
                "nesvo",
                "run",
                "decision",
                "answer",
                "r",
                "d",
                "--key",
                "k",
                "--revision",
                "1",
                "--answer-file",
                "-",
            ],
            vec![
                "nesvo", "run", "blocked", "--run", "r", "--key", "k", "--file", "-",
            ],
            vec![
                "nesvo",
                "run",
                "ask",
                "--run",
                "r",
                "--key",
                "k",
                "--question",
                "Which?",
                "--options",
                "a,b,c",
                "--json",
            ],
        ] {
            assert!(Cli::try_parse_from(&valid).is_ok(), "{valid:?}");
        }
        for invalid in [
            vec!["nesvo", "run", "blocked", "--run", "r", "--key", "k"],
            vec![
                "nesvo", "run", "blocked", "--run", "r", "--key", "k", "--reason", "x", "--file",
                "-",
            ],
            vec!["nesvo", "run", "ask", "--run", "r", "--key", "k"],
            vec!["nesvo", "run", "ask", "--key", "k", "--question", "x"],
        ] {
            assert!(Cli::try_parse_from(&invalid).is_err(), "{invalid:?}");
        }
        assert!(
            Cli::try_parse_from([
                "nesvo",
                "run",
                "ask",
                "--run",
                "r",
                "--key",
                "k",
                "--question",
                "x",
                "--json"
            ])
            .unwrap()
            .command
            .machine()
        );
    }
}
