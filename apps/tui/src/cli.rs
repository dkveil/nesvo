//! Headless operations over the same authenticated host connection as TUI.
use crate::network::{Connection, NetworkEvent, Pairing};
use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};

#[derive(Subcommand)]
pub enum Command {
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
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}
fn failure(code: &str, message: &str) -> anyhow::Error {
    Failure {
        code: code.into(),
        message: message.into(),
    }
    .into()
}
pub fn emit_failure(machine: bool, code: &str, message: &str) -> i32 {
    if machine {
        println!(
            "{}",
            json!({"schemaVersion":1,"ok":false,"error":{"code":code,"message":message,"retryable":matches!(code,"host_unavailable"|"disconnected"|"timeout")}})
        );
    } else {
        eprintln!("{code}: {message}");
    }
    match code {
        "invalid_argument" | "no_current_session" => 2,
        "pairing_unavailable" => 3,
        "host_unavailable" | "disconnected" => 4,
        "session_not_found" => 5,
        "timeout" => 7,
        "unsupported" => 8,
        _ => 6,
    }
}
impl Command {
    fn machine(&self) -> bool {
        match self {
            Self::Doctor { json } | Self::Events { json, .. } => *json,
            Self::Session { command } => match command {
                SessionCommand::List { json }
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
            Some(error) => emit_failure(machine, &error.code, &error.message),
            None => emit_failure(
                machine,
                "operation_failed",
                "Operation could not be completed",
            ),
        },
    }
}

async fn request(connection: &mut Connection, mut command: Value, kind: &str) -> Result<Value> {
    let id = format!("cli-{}", hex::encode(nesvo_wire::random::<8>()));
    command["requestId"] = json!(id);
    connection
        .send(command)
        .map_err(|_| failure("disconnected", "Host connection is closed"))?;
    tokio::time::timeout(Duration::from_secs(10), async {
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

fn valid_id(id: &str) -> Result<()> {
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
        SessionCommand::Explain { .. } => unreachable!("diagnostics are dispatched separately"),
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

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let (session, machine) = match command {
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
