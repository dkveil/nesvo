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
fn emit_failure_receipt(machine: bool, code: &str, message: &str, receipt: Option<&Value>) -> i32 {
    if machine {
        let mut error = json!({"schemaVersion":1,"ok":false,"error":{"code":code,"message":message,"retryable":matches!(code,"host_unavailable"|"disconnected"|"timeout")}});
        if let Some(receipt) = receipt {
            error["error"]["receipt"] = receipt.clone();
        }
        println!("{error}");
    } else {
        eprintln!("{code}: {message}");
    }
    match code {
        "invalid_argument" | "no_current_session" => 2,
        "pairing_unavailable" => 3,
        "host_unavailable" | "disconnected" => 4,
        "session_not_found"
        | "operation_not_found"
        | "run_not_found"
        | "mutation_not_found"
        | "task_not_found"
        | "message_not_found"
        | "decision_not_found"
        | "control_not_found"
        | "attempt_not_found" => 5,
        "job_not_found" | "occurrence_not_found" => 5,
        "timeout" => 7,
        "unsupported" => 8,
        _ => 6,
    }
}
impl Command {
    fn machine(&self) -> bool {
        match self {
            Self::Mcp => false,
            Self::Run { command } => command.machine(),
            Self::Job { command } => command.machine(),
            Self::Budget { command } => command.machine(),
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
                6
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
        Some("sendOperation") => Duration::from_secs(15),
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
fn read_prompt(
    literal: Option<String>,
    file: Option<std::path::PathBuf>,
    stdin: bool,
) -> Result<String> {
    use std::io::Read;
    let mut prompt = String::new();
    if let Some(path) = file {
        let file = std::fs::File::open(path)
            .map_err(|_| failure("invalid_argument", "Cannot read prompt file"))?;
        file.take(8193)
            .read_to_string(&mut prompt)
            .map_err(|_| failure("invalid_argument", "Prompt file must contain UTF-8 text"))?;
    } else if stdin {
        std::io::stdin()
            .lock()
            .take(8193)
            .read_to_string(&mut prompt)
            .map_err(|_| failure("invalid_argument", "Prompt stdin must contain UTF-8 text"))?;
    } else if let Some(value) = literal {
        prompt = value;
    }
    if prompt.len() > 8192 || prompt.contains('\0') {
        return Err(failure(
            "invalid_argument",
            "Prompt exceeds 8192 UTF-8 bytes or contains NUL",
        ));
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
        Some(error) => {
            let mut value = json!({"schemaVersion":1,"ok":false,"error":{"code":error.code,"message":error.message,"retryable":matches!(error.code.as_str(),"host_unavailable"|"disconnected"|"timeout")}});
            if let Some(receipt) = &error.receipt {
                value["error"]["receipt"] = receipt.clone();
            }
            value
        }
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

#[cfg(test)]
#[path = "quota_cli_tests.rs"]
mod quota_tests;

#[cfg(test)]
#[path = "quota_wake_cli_tests.rs"]
mod quota_wake_tests;
