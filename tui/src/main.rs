mod controller;
mod input;
mod model;
mod network;
mod runner;
mod terminal;
mod ui;

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
    #[arg(long, default_value = "host/.local/pairing.json")]
    pairing: PathBuf,
    /// Override only the connection address, e.g. ws://127.0.0.1:8787.
    #[arg(long)]
    url: Option<String>,
    /// Print one authenticated session/group snapshot as JSON, then disconnect.
    #[arg(long)]
    list: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    if !arguments.list {
        ensure!(
            std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
            "Interactive mode needs a terminal. Use --list for a JSON snapshot."
        );
    }
    let pairing = Pairing::load(&arguments.pairing, arguments.url.as_deref())?;
    let mut connection = Connection::open(pairing).await?;
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
    runner::run(&mut connection)
}
