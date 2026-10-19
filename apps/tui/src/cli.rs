//! Read-only diagnostics over the same authenticated host connection as TUI.
use crate::network::{Connection, NetworkEvent};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Subcommand)]
pub enum Command {
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
    /// Show source, freshness, delivery and protocol diagnostics (no prompts).
    Explain {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

async fn request(connection: &mut Connection, mut command: Value, kind: &str) -> Result<Value> {
    let id = format!("diagnostic-{}", hex::encode(nesvo_wire::random::<8>()));
    command["requestId"] = json!(id);
    connection.send(command)?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = connection.events.recv().await {
            match event {
                NetworkEvent::Disconnected(message) => bail!(message),
                NetworkEvent::Message(value) if value["requestId"] == id => {
                    if value["type"] == "error" {
                        bail!(
                            "{}",
                            value["message"]
                                .as_str()
                                .unwrap_or("Host rejected diagnostic request")
                        );
                    }
                    if value["type"] == kind {
                        return Ok(value);
                    }
                }
                _ => {}
            }
        }
        bail!("Host disconnected before returning diagnostics")
    })
    .await
    .context("Diagnostic request timed out")?
}

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let (session, machine) = match command {
        Command::Doctor { json } => (None, json),
        Command::Session {
            command: SessionCommand::Explain { id, json },
        } => {
            ensure!(
                !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control),
                "Invalid session ID"
            );
            (Some(id), json)
        }
    };
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    ensure!(
        capabilities["diagnostics"] == true,
        "This host does not support diagnostics; update nesvo-host"
    );
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
