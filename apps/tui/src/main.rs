mod brand;
mod cli;
mod controller;
mod input;
mod launch;
mod model;
mod network;
mod output;
mod palette;
mod preferences;
mod review;
mod runner;
mod selection;
mod session_row;
mod shortcuts;
mod status;
mod terminal;
mod theme;
mod toolbox;
mod ui;
mod ui_controls;
mod ui_launch;
mod ui_palette;
mod workspace_layout;

use anyhow::{Context, Result, ensure};
use clap::Parser;
use network::{Connection, NetworkEvent, Pairing};
use std::{io::IsTerminal, path::PathBuf, time::Duration};

#[derive(Parser)]
#[command(
    version,
    about = "nesvo: native terminal client for your shared sessions host"
)]
struct Arguments {
    /// Private pairing file written by the host. Its key is never printed.
    #[arg(long, default_value = "host/.local/pairing.json", global = true)]
    pairing: PathBuf,
    /// Override only the connection address, e.g. ws://127.0.0.1:8787.
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: Option<cli::Command>,
    /// Print one authenticated session/group snapshot as JSON, then disconnect.
    #[arg(long)]
    list: bool,
    /// Check that the paired host supports this client, then exit.
    #[arg(long)]
    check_host: bool,
    /// Keep the empty-workspace logo still; active terminal views never animate.
    #[arg(long)]
    no_animation: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    if arguments.command.is_none() && !arguments.list && !arguments.check_host {
        ensure!(
            std::env::var_os("NESVO_SESSION").is_none(),
            "nesvo is already running inside this terminal session. Open a separate terminal to start another client."
        );
    }
    if arguments.command.is_none() && !arguments.list && !arguments.check_host {
        ensure!(
            std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
            "Interactive mode needs a terminal. Use --list for a JSON snapshot."
        );
    }
    let pairing = Pairing::load(&arguments.pairing, arguments.url.as_deref()).with_context(|| {
        format!(
            "Cannot load pairing from {}. Start nesvo-host first, then pass its private pairing.json with --pairing.",
            arguments.pairing.display()
        )
    })?;
    let mut connection = Connection::open(pairing).await?;
    if let Some(command) = arguments.command {
        return cli::run(command, &mut connection).await;
    }
    if arguments.check_host {
        connection.send(serde_json::json!({"type":"getCapabilities"}))?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = connection.events.recv().await {
                match event {
                    NetworkEvent::Message(value) if value["type"] == "capabilities" => {
                        println!("{}", serde_json::to_string(&value)?);
                        return Ok(());
                    }
                    NetworkEvent::Disconnected(message) => anyhow::bail!(message),
                    _ => {}
                }
            }
            anyhow::bail!("Host disconnected before reporting capabilities")
        })
        .await
        .context("Host capabilities check timed out")??;
        return Ok(());
    }
    if arguments.list {
        let snapshot = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = connection.events.recv().await {
                match event {
                    NetworkEvent::Message(value) if value["type"] == "sessions" => {
                        return Ok(value);
                    }
                    NetworkEvent::Disconnected(message) => anyhow::bail!(message),
                    _ => {}
                }
            }
            anyhow::bail!("Host disconnected before sending a snapshot")
        })
        .await
        .context("Timed out waiting for the host snapshot")??;
        println!("{}", serde_json::to_string(&snapshot)?);
        return Ok(());
    }
    let pairing_path =
        std::path::absolute(&arguments.pairing).context("Cannot resolve pairing file path")?;
    runner::run(
        &mut connection,
        &pairing_path,
        arguments.url.as_deref(),
        !arguments.no_animation,
    )
}

#[cfg(test)]
mod workflow_tests;
