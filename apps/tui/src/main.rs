mod brand;
mod budgets;
mod capture_explain;
mod cli;
mod controller;
mod files_controller;
mod files_tree;
mod git_pane;
mod input;
mod job_commands;
mod job_prechecks;
mod job_time;
mod job_trigger_tools;
mod job_triggers;
mod jobs;
mod jobs_controller;
mod launch;
mod layouts;
mod mcp;
mod model;
mod network;
mod output;
mod overview;
mod palette;
mod preferences;
mod recovery_hook;
mod review;
mod review_comments;
mod review_session;
mod runner;
mod selection;
mod session_kind;
mod session_recovery;
mod session_row;
mod shortcuts;
mod status;
mod terminal;
mod theme;
mod toolbox;
mod ui;
mod ui_controls;
mod ui_files;
mod ui_git;
mod ui_jobs;
mod ui_launch;
mod ui_layouts;
mod ui_overview;
mod ui_palette;
mod ui_review;
mod ui_session_kind;
mod usage_panel;
mod workflow;
mod workflow_budget;
mod workflow_checkpoints;
mod workflow_constraints;
mod workflow_controls;
mod workflow_decisions;
mod workflow_delivery;
mod workflow_executor;
mod workflow_inbox;
mod workflow_launches;
mod workflow_wakes;
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
    #[arg(long, global = true)]
    pairing: Option<PathBuf>,
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
    let arguments = parse_arguments(std::env::args_os().collect())?.unwrap_or_else(|error| {
        if error.use_stderr() && std::env::args_os().any(|arg| arg == "--json") {
            std::process::exit(cli::emit_failure(
                true,
                "invalid_argument",
                "Invalid CLI arguments; use --help",
            ));
        }
        if error.use_stderr() {
            let _ = error.print();
            std::process::exit(cli::EXIT_BAD_REQUEST);
        }
        error.exit()
    });
    let headless = arguments.command.is_some() || arguments.list || arguments.check_host;
    let pairing_path = arguments.pairing.unwrap_or_else(|| {
        if headless && let Some(context) = std::env::var_os("NESVO_AGENT_CONTEXT") {
            return context.into();
        }
        PathBuf::from("host/.local/pairing.json")
    });
    if let Some(command) = arguments.command {
        // The headless dispatcher contains the SDK server and nested command
        // futures. Keep it off the entrypoint stack, including before parsing
        // --help on Windows' smaller default main-thread stack.
        let code = Box::pin(cli::execute(
            command,
            &pairing_path,
            arguments.url.as_deref(),
        ))
        .await;
        if code != 0 {
            std::process::exit(code);
        }
        return Ok(());
    }
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
    let pairing = Pairing::load(&pairing_path, arguments.url.as_deref()).with_context(|| {
        format!(
            "Cannot load pairing from {}. Start nesvo-host first, then pass its private pairing.json with --pairing.",
            pairing_path.display()
        )
    })?;
    let mut connection = Connection::open(pairing).await?;
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
        std::path::absolute(&pairing_path).context("Cannot resolve pairing file path")?;
    runner::run(
        &mut connection,
        &pairing_path,
        arguments.url.as_deref(),
        !arguments.no_animation,
    )
}

fn parse_arguments(args: Vec<std::ffi::OsString>) -> Result<Result<Arguments, clap::Error>> {
    // Generated Clap augmentation is recursive across command families. The
    // workflow family alone uses >500 KiB in a Windows debug build; keep that
    // short-lived construction off the smaller OS main stack. Do not change
    // global linker/runtime stacks or keep a parser thread after startup.
    std::thread::Builder::new()
        .name("nesvo-arguments".into())
        .stack_size(4 * 1024 * 1024)
        .spawn(move || Arguments::try_parse_from(args))
        .context("Cannot start CLI argument parser")?
        .join()
        .map_err(|_| anyhow::anyhow!("CLI argument parser failed"))
}

#[cfg(test)]
mod argument_stack_tests {
    #[test]
    fn full_command_grammar_parses_from_a_small_caller_stack_without_host_io() {
        std::thread::Builder::new()
            .stack_size(512 * 1024)
            .spawn(|| {
                for args in [
                    vec!["nesvo", "--help"],
                    vec!["nesvo", "run", "checkpoint", "context", "--help"],
                    vec![
                        "nesvo",
                        "session",
                        "wait",
                        "id",
                        "--timeout-ms",
                        "100",
                        "--json",
                    ],
                ] {
                    let parsed =
                        super::parse_arguments(args.into_iter().map(Into::into).collect()).unwrap();
                    if let Err(error) = parsed {
                        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
                    }
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

#[cfg(test)]
mod workflow_tests;
