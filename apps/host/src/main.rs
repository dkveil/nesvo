mod agent_context;
mod agent_events;
mod api_error;
mod attention;
mod attention_projection;
mod budgets;
mod caller;
mod codex_context;
mod command_scope;
mod event_log;
mod git;
mod groups;
mod host_lock;
mod job_attempts;
mod job_calendar;
mod job_calendar_adapter;
mod job_cancellations;
mod job_definitions;
mod job_precheck_adapter;
mod job_precheck_records;
mod job_prechecks;
mod job_retries;
mod job_runtime;
mod jobs;
mod launch_profile;
mod launchers;
mod notifications;
mod operations;
mod orchestration;
mod process;
mod program_status;
mod protocol;
mod pty;
mod readiness;
mod receipts;
mod recipes;
mod replay;
mod sessions;
mod status;
mod status_latency;
mod status_rules;
mod storage;
mod submission;
mod terminal_protocol;
mod titles;
mod tool_permissions;
mod transport;
mod turns;
mod usage;
mod wake_attention;
mod workflow_attempts;
mod workflow_budget;
mod workflow_checkpoint_parts;
mod workflow_checkpoints;
mod workflow_constraints;
mod workflow_context;
mod workflow_control_runtime;
mod workflow_controls;
mod workflow_coordinator;
mod workflow_coordinator_runtime;
mod workflow_decisions;
mod workflow_delivery;
mod workflow_delivery_runtime;
mod workflow_executor;
mod workflow_executor_runtime;
mod workflow_inbox;
mod workflow_launch_runtime;
mod workflow_launches;
mod workflow_recovery;
mod workflow_wake_batches;
mod workflow_wake_events;
mod workflow_wake_runtime;
mod workflow_wakes;
use nesvo_host::wire;

use anyhow::{Context, Result, ensure};
use clap::Parser;
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{ErrorKind, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc, oneshot},
};

#[derive(Parser)]
#[command(
    version,
    about = "nesvo private terminal companion. Shells run only when requested in a paired client."
)]
struct Args {
    #[arg(long, hide = true)]
    agent_context_hook: Option<PathBuf>,
    #[arg(long, hide = true)]
    codex_context_hook: bool,
    /// Print the source build identity without starting a host.
    #[arg(long)]
    build_id: bool,
    #[arg(long)]
    lan: bool,
    #[arg(long)]
    bind: Option<IpAddr>,
    #[arg(long, default_value_t = 8787, env = "POCKET_HOST_PORT")]
    port: u16,
    #[arg(long, env = "POCKET_HOST_ADDRESS")]
    advertise: Option<String>,
    #[arg(long, default_value = ".")]
    workspace: PathBuf,
    #[arg(long)]
    rotate_key: bool,
    #[arg(long)]
    pairing_dir: Option<PathBuf>,
    #[arg(long, env = "POCKET_ALLOWED_ORIGINS", value_delimiter = ',')]
    allowed_origins: Vec<String>,
    /// Let a local parent process request graceful shutdown by closing stdin.
    #[arg(long, hide = true)]
    exit_on_stdin_close: bool,
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    version: u8,
    url: String,
    key: String,
}

fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

fn local_ip() -> Option<IpAddr> {
    // UDP connect selects the default route; it sends no datagram.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn repository_pairing_directory(root: &Path) -> Option<PathBuf> {
    ["apps/host/Cargo.toml", "host/Cargo.toml"]
        .iter()
        .any(|manifest| root.join(manifest).is_file())
        // Source layout changes must not move existing pairing credentials.
        .then(|| root.join("host/.local"))
}

fn stdin_close_signal() -> oneshot::Receiver<()> {
    let (sender, receiver) = oneshot::channel();
    thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buffer = [0; 256];
        while let Ok(length) = stdin.read(&mut buffer) {
            if length == 0 {
                break;
            }
        }
        let _ = sender.send(());
    });
    receiver
}

fn main() -> Result<()> {
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new(job_precheck_adapter::FLAG))
    {
        return job_precheck_adapter::stdio();
    }
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new(job_calendar_adapter::FLAG))
    {
        return job_calendar_adapter::stdio();
    }
    let args = Args::parse();
    if args.codex_context_hook {
        if std::env::var_os("NESVO_LIFECYCLE_REPORT")
            .map(PathBuf::from)
            .is_none_or(|path| agent_context::receive_codex(&path).is_err())
        {
            eprintln!(
                "nesvo Codex hook delivery failed; inspect this session with nesvo session explain"
            );
        }
        return Ok(());
    }
    if let Some(report) = args.agent_context_hook {
        // Tracking must never prevent an agent tool from completing.
        if agent_context::receive(&report).is_err() {
            eprintln!(
                "nesvo hook delivery failed; inspect this session with nesvo session explain"
            );
        }
        return Ok(());
    }
    if args.build_id {
        println!("{}", env!("NESVO_BUILD_ID"));
        return Ok(());
    }
    // High-frequency hook invocations do only synchronous bounded file work.
    // Construct the multi-thread runtime exclusively for the actual host.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("Cannot start host runtime")?
        .block_on(run(args))
}

async fn run(args: Args) -> Result<()> {
    let workspace = fs::canonicalize(&args.workspace).context("Workspace does not exist")?;
    ensure!(workspace.is_dir(), "Workspace must be a directory");
    let bind = args.bind.unwrap_or(IpAddr::V4(if args.lan {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    }));
    let listen_address = SocketAddr::new(bind, args.port);
    let listener = TcpListener::bind(listen_address).await.map_err(|error| {
        let message = if error.kind() == ErrorKind::AddrInUse {
            format!(
                "Could not listen on {listen_address}: address already in use. If a nesvo host is running, reuse it. To start another, choose an unused --port and a separate --pairing-dir."
            )
        } else {
            format!("Could not bind the terminal host to {listen_address}")
        };
        anyhow::Error::new(error).context(message)
    })?;
    let actual_port = listener.local_addr()?.port();
    let advertised = args.advertise.unwrap_or_else(|| {
        if bind.is_unspecified() {
            local_ip()
                .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
                .to_string()
        } else {
            bind.to_string()
        }
    });
    let advertised = if advertised.contains(':') && !advertised.starts_with('[') {
        format!("[{advertised}]")
    } else {
        advertised
    };
    let url = format!("ws://{advertised}:{actual_port}");
    let parsed_url = url::Url::parse(&url).context("Invalid advertised address")?;
    ensure!(
        parsed_url.username().is_empty()
            && parsed_url.password().is_none()
            && parsed_url.path() == "/"
            && parsed_url.query().is_none()
            && parsed_url.fragment().is_none(),
        "Advertise must contain only an IP address or hostname"
    );
    let pairing_dir = args.pairing_dir.unwrap_or_else(|| {
        if let Some(directory) = repository_pairing_directory(Path::new(".")) {
            directory
        } else if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                // Preserve the existing data directory and pairing credentials.
                .join("PocketSessions")
                .join("pairing")
        } else {
            std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
                })
                .unwrap_or_else(|| PathBuf::from(".local"))
                // Preserve the existing data directory and pairing credentials.
                .join("pocket-sessions")
        }
    });
    fs::create_dir_all(&pairing_dir)?;
    let host_lock = Arc::new(host_lock::HostLock::acquire(&pairing_dir)?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pairing_dir, fs::Permissions::from_mode(0o700))?;
    }
    let pairing_path = pairing_dir.join("pairing.json");
    let existing = if args.rotate_key {
        None
    } else {
        fs::read(&pairing_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Pairing>(&data).ok())
            .and_then(|pairing| hex::decode(pairing.key).ok())
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
    };
    let key = existing.unwrap_or_else(wire::random::<32>);
    let pairing = Pairing {
        version: 1,
        url,
        key: hex::encode(key),
    };
    let pairing_json = serde_json::to_vec_pretty(&pairing)?;
    private_write(&pairing_path, &pairing_json)?;
    let qr = QrCode::new(serde_json::to_vec(&pairing)?)?;
    let svg = qr
        .render::<svg::Color>()
        .min_dimensions(420, 420)
        .quiet_zone(true)
        .build();
    let qr_path = pairing_dir.join("pairing.svg");
    private_write(&qr_path, svg.as_bytes())?;

    let metadata = storage::MetadataStore::open(&pairing_dir.join("metadata.sqlite3"))?;
    let event_log = event_log::Service::open_with_owner(
        pairing_dir.join("metadata.sqlite3"),
        host_lock.clone(),
    )
    .await?;
    event_log
        .append(vec![event_log::Observation {
            session_id: None,
            kind: "host.started",
            at: status::now_millis(),
            payload: serde_json::json!({"buildId":env!("NESVO_BUILD_ID")}),
        }])
        .await?;
    let launchers = launchers::Launchers::discover();
    let claude_installed = launchers.available(launchers::Program::Claude);
    let codex_probe = launchers.probe_command(launchers::Program::Codex);
    let version_probes = launchers.version_probes();
    let state = Arc::new(Mutex::new(sessions::State::new(
        workspace.clone(),
        metadata,
        launchers,
    )));
    let (event_tx, event_rx) = mpsc::channel(128);
    state.lock().unwrap().set_caller_url(pairing.url.clone());
    state.lock().unwrap().set_event_log(event_log.clone());
    {
        let state = state.clone();
        tokio::spawn(async move {
            for (program, executable, args) in version_probes {
                let version = launchers::read_version(program, executable, args).await;
                state.lock().unwrap().provider_version(version);
            }
        });
    }
    tokio::spawn(sessions::dispatch_output(state.clone(), event_rx));
    tokio::spawn(jobs::run(state.clone(), event_tx.clone()));
    tokio::spawn(job_runtime::run(
        state.clone(),
        event_tx.clone(),
        event_log.clone(),
    ));
    tokio::spawn(notifications::run(state.clone()));
    if claude_installed {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                let windows = usage::read_claude_limits().await;
                state
                    .lock()
                    .unwrap()
                    .update_provider_limits(launchers::Program::Claude, windows);
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }
    if let Some(command) = codex_probe {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                let windows = usage::read_codex_limits(&command).await.unwrap_or_default();
                state.lock().unwrap().update_codex_limits(windows);
                tokio::time::sleep(Duration::from_secs(120)).await;
            }
        });
    }
    let permits = Arc::new(Semaphore::new(16));
    println!("nesvo Rust host listening on {bind}:{actual_port}");
    println!("Workspace: {}", workspace.display());
    println!("Private pairing file: {}", pairing_path.display());
    println!("Private pairing QR: {}", qr_path.display());
    println!("Pairing grants shell access. Keep both files private. Ctrl+C closes all sessions.");
    let mut stdin_closed = args.exit_on_stdin_close.then(stdin_close_signal);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = async {
                if let Some(receiver) = &mut stdin_closed {
                    let _ = receiver.await;
                }
            }, if args.exit_on_stdin_close => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                let Ok(permit) = permits.clone().try_acquire_owned() else { drop(socket); continue; };
                let state = state.clone();
                let events = event_tx.clone();
                let allowed_origins = args.allowed_origins.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = transport::handle(socket, key, state, events, allowed_origins).await;
                });
            }
        }
    }
    // Closed sessions may still be releasing ConPTY resources in background
    // workers. Keep the output dispatcher alive while they finish, without
    // holding the state lock that it needs to drain PTY output.
    let mut cleanup_workers = {
        let mut state = state.lock().unwrap();
        state.shutdown()
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut panicked = 0;
    loop {
        let mut pending = Vec::new();
        for worker in cleanup_workers {
            if worker.is_finished() {
                if worker.join().is_err() {
                    panicked += 1;
                }
            } else {
                pending.push(worker);
            }
        }
        cleanup_workers = pending;
        if cleanup_workers.is_empty() || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    ensure!(
        cleanup_workers.is_empty(),
        "Timed out waiting for {} terminal cleanup workers",
        cleanup_workers.len()
    );
    ensure!(
        panicked == 0,
        "{panicked} terminal cleanup workers panicked"
    );
    tokio::time::timeout(Duration::from_secs(3), event_log.shutdown())
        .await
        .context("Event journal shutdown timed out")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_layout_migration_preserves_repository_pairing_directory() {
        let fixture = std::env::temp_dir().join(format!(
            "nesvo-path-test-{}",
            hex::encode(wire::random::<8>())
        ));
        fs::create_dir_all(fixture.join("host")).unwrap();
        assert_eq!(repository_pairing_directory(&fixture), None);
        fs::write(fixture.join("host/Cargo.toml"), "").unwrap();
        let expected = Some(fixture.join("host/.local"));
        assert_eq!(repository_pairing_directory(&fixture), expected);
        fs::remove_file(fixture.join("host/Cargo.toml")).unwrap();
        fs::create_dir_all(fixture.join("apps/host")).unwrap();
        fs::write(fixture.join("apps/host/Cargo.toml"), "").unwrap();
        assert_eq!(repository_pairing_directory(&fixture), expected);
        fs::remove_dir_all(fixture).unwrap();
    }
}
