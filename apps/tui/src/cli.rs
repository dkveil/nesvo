//! Headless operations over the same authenticated host connection as TUI.
use crate::network::{Connection, NetworkEvent, Pairing};
use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};

#[derive(Subcommand)]
pub enum Command {
    /// Serve scoped host tools over MCP stdio. No global provider setup is changed.
    Mcp,
    /// Inspect a durable operation by ID, or find the caller's idempotency key.
    Operation {
        #[arg(required_unless_present = "key", conflicts_with = "key")]
        id: Option<String>,
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
    /// Inspect a session by its stable identifier.
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
}
#[derive(Subcommand)]
pub enum SessionCommand {
    /// Launch once for a stable caller-supplied idempotency key; never acquires control.
    Create(CreateOptions),
    /// Submit one literal prompt with a durable key; never takes human control.
    Send(SendOptions),
    /// Write one Ctrl+C without taking control. Does not claim the agent stopped.
    Interrupt(ControlOptions),
    /// Request native process stop once; retain the session and terminal output.
    Stop(ControlOptions),
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
    /// Read NESVO_SESSION_ID from this process context, never the UI selection.
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
        "session_not_found" | "operation_not_found" => 5,
        "timeout" => 7,
        "unsupported" => 8,
        _ => 6,
    }
}
impl Command {
    fn machine(&self) -> bool {
        match self {
            Self::Mcp => false,
            Self::Doctor { json } | Self::Events { json, .. } | Self::Operation { json, .. } => {
                *json
            }
            Self::Session { command } => match command {
                SessionCommand::Create(options) => options.json,
                SessionCommand::Send(options) => options.json,
                SessionCommand::Interrupt(options) | SessionCommand::Stop(options) => options.json,
                SessionCommand::List { json }
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
        let mut connection = Connection::open(pairing).await.map_err(|_| {
            failure(
                "host_unavailable",
                "Cannot authenticate with the paired host; check that it is running and reachable",
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
fn print_data(machine: bool, mut value: Value) -> Result<()> {
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
            let id=std::env::var("NESVO_SESSION_ID").map_err(|_|failure("no_current_session","No Nesvo session context; run inside a managed session or supply an explicit ID"))?;
            valid_id(&id)?;
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
        Command::Mcp => {
            return Err(failure(
                "invalid_argument",
                "MCP uses its own stdio entrypoint",
            ));
        }
        Command::Operation { id, key, json } => {
            operation_capability(connection).await?;
            return print_data(
                json,
                request(
                    connection,
                    json!({"type":"getOperation","id":id,"key":key}),
                    "operation",
                )
                .await?,
            );
        }
        Command::Session {
            command: SessionCommand::Create(options),
        } => return create(options, connection).await,
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
            }
        }
    }
    Ok(())
}
