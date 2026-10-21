mod agent_context;
mod agent_events;
mod api_error;
mod attention;
mod attention_inbox;
mod attention_projection;
mod budgets;
mod caller;
mod claude_quota;
mod claude_quota_diagnostics;
mod claude_statusline;
mod codex_context;
mod command_scope;
mod commits;
mod event_log;
mod files;
mod gemini_adapter;
mod git;
mod git_repository;
mod groups;
mod host_lock;
mod job_attempts;
mod job_calendar;
mod job_calendar_adapter;
mod job_cancellations;
mod job_definitions;
mod job_launch_resolutions;
mod job_precheck_adapter;
mod job_precheck_records;
mod job_prechecks;
mod job_quota;
mod job_retries;
mod job_runtime;
mod job_timeout_runtime;
mod job_timeouts;
mod job_trigger_auth;
mod job_triggers;
mod job_webhook_http;
mod jobs;
mod launch_profile;
mod launchers;
mod migrations;
mod notes;
mod notifications;
mod operations;
mod orchestration;
mod process;
mod program_status;
mod projects;
mod protocol;
mod provider_quota;
mod provider_quota_runtime;
mod pty;
mod quota_contexts;
mod quota_wake_runtime;
mod quota_wakes;
mod readiness;
mod receipts;
mod recipes;
mod replay;
mod resume;
mod review;
mod scoped_context;
mod session_repository;
mod sessions;
mod startup_trace;
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
mod workflow_templates;
mod workflow_wake_batches;
mod workflow_wake_events;
mod workflow_wake_runtime;
mod workflow_wakes;
mod worktrees;
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
    /// Launch-owned status-line metadata receiver; never installs global settings.
    #[arg(long, hide = true)]
    claude_quota_hook: Option<PathBuf>,
    #[arg(long, hide = true)]
    claude_statusline: Option<PathBuf>,
    #[arg(long, hide = true)]
    claude_statusline_child: bool,
    #[arg(long, hide = true)]
    claude_statusline_profile: bool,
    #[arg(long, hide = true)]
    codex_context_hook: bool,
    #[arg(long, hide = true)]
    gemini_context_hook: bool,
    /// Print the source build identity without starting a host.
    #[arg(long)]
    build_id: bool,
    #[arg(long)]
    lan: bool,
    #[arg(long)]
    bind: Option<IpAddr>,
    #[arg(long, default_value_t = 8787, env = "POCKET_HOST_PORT")]
    port: u16,
    /// Enable authenticated job webhooks on 127.0.0.1; use 0 for an ephemeral port.
    #[arg(long)]
    webhook_port: Option<u16>,
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
    #[cfg(windows)]
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new(git_repository::HELPER_FLAG))
    {
        std::process::exit(git_repository::helper_stdio());
    }
    #[cfg(windows)]
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new(worktrees::STEP_HELPER_FLAG))
    {
        std::process::exit(worktrees::step_helper());
    }
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
    if let Some(manifest) = args.claude_statusline {
        std::process::exit(claude_statusline::run(&manifest));
    }
    if args.claude_statusline_child {
        std::process::exit(claude_statusline::child());
    }
    if args.claude_statusline_profile {
        std::process::exit(claude_statusline::profile_child());
    }
    if let Some(report) = args.claude_quota_hook {
        if claude_quota::receive(&report, std::io::stdin()).is_err() {
            eprintln!("nesvo quota callback delivery failed; inspect session diagnostics");
        }
        return Ok(());
    }
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
    if args.gemini_context_hook {
        gemini_adapter::receive_hook(args.pairing_dir.as_deref());
        println!("{{}}");
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
    let trace = startup_trace::Trace::from_env();
    let span = trace.begin(startup_trace::Phase::RuntimeCreate);
    let runtime = span.result(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .context("Cannot start host runtime"),
    )?;
    runtime.block_on(run(args, trace))
}

async fn run(args: Args, trace: startup_trace::Trace) -> Result<()> {
    use startup_trace::Phase;
    let span = trace.begin(Phase::WorkspaceResolve);
    let workspace = fs::canonicalize(&args.workspace).context("Workspace does not exist")?;
    ensure!(workspace.is_dir(), "Workspace must be a directory");
    span.end(true);
    let bind = args.bind.unwrap_or(IpAddr::V4(if args.lan {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    }));
    let listen_address = SocketAddr::new(bind, args.port);
    let span = trace.begin(Phase::ListenerBind);
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
    span.end(true);
    let span = trace.begin(Phase::AdvertiseResolve);
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
    span.end(true);
    let span = trace.begin(Phase::PairingDirectory);
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
    span.end(true);
    let span = trace.begin(Phase::HostLock);
    let host_lock = Arc::new(host_lock::HostLock::acquire(&pairing_dir)?);
    span.end(true);
    #[cfg(unix)]
    {
        let span = trace.begin(Phase::PairingPermissions);
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pairing_dir, fs::Permissions::from_mode(0o700))?;
        span.end(true);
    }
    let span = trace.begin(Phase::PairingPrepare);
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
    span.end(true);

    if let Err(error) = worktrees::configure(&pairing_dir) {
        eprintln!("Worktree registry is unavailable: {error}");
    }
    if let Err(error) = workflow_templates::configure(&pairing_dir) {
        eprintln!("Workflow template approvals are unavailable: {error}");
    }
    if let Err(error) = gemini_adapter::prepare(&pairing_dir) {
        eprintln!("Gemini lifecycle extension source is unavailable: {error}");
    }
    let span = trace.begin(Phase::MetadataOpen);
    let metadata = span.result(storage::MetadataStore::open(
        &pairing_dir.join("metadata.sqlite3"),
    ))?;
    let span = trace.begin(Phase::JournalOpen);
    let event_log = span.result(
        event_log::Service::open_with_owner(
            pairing_dir.join("metadata.sqlite3"),
            host_lock.clone(),
        )
        .await,
    )?;
    if let Err(error) = projects::configure(&pairing_dir.join("metadata.sqlite3")) {
        eprintln!("Project registry is unavailable: {error}");
    }
    let span = trace.begin(Phase::StartupEventAppend);
    span.result(
        event_log
            .append(vec![event_log::Observation {
                session_id: None,
                kind: "host.started",
                at: status::now_millis(),
                payload: serde_json::json!({"buildId":env!("NESVO_BUILD_ID")}),
            }])
            .await,
    )?;
    let span = trace.begin(Phase::LauncherDiscover);
    let launchers = launchers::Launchers::discover();
    let version_probes = launchers.version_probes();
    span.end(true);
    let span = trace.begin(Phase::StateInitialize);
    let state = Arc::new(Mutex::new(sessions::State::new(
        workspace.clone(),
        metadata,
        launchers,
    )));
    let (event_tx, event_rx) = mpsc::channel(128);
    state.lock().unwrap().set_caller_url(pairing.url.clone());
    state.lock().unwrap().set_event_log(event_log.clone());
    span.end(true);
    let webhooks = match args.webhook_port {
        Some(port) => {
            let span = trace.begin(Phase::WebhookBind);
            let listener = job_webhook_http::Listener::bind(port, event_log.clone()).await?;
            state
                .lock()
                .unwrap()
                .set_job_trigger_listener(Some(listener.address()));
            let exited = listener.exit_notification();
            let listener_state = state.clone();
            tokio::spawn(async move {
                let failed = job_webhook_http::wait_for_exit(exited).await;
                listener_state
                    .lock()
                    .unwrap()
                    .set_job_trigger_listener(None);
                if failed {
                    eprintln!("Job webhook listener stopped: webhook_listener_unavailable");
                }
            });
            span.end(true);
            Some(listener)
        }
        None => None,
    };
    let span = trace.begin(Phase::RuntimesInstall);
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
    let job_runtime =
        job_runtime::Runtime::start(state.clone(), event_tx.clone(), event_log.clone());
    tokio::spawn(job_timeout_runtime::run(state.clone(), event_log.clone()));
    tokio::spawn(notifications::run(state.clone()));
    tokio::spawn(attention_inbox::watch(state.clone(), event_log.clone()));
    let quota_runtime = provider_quota_runtime::Runtime::start(state.clone());
    let quota_wake_runtime = quota_wake_runtime::Runtime::start(state.clone(), event_log.clone());
    let repository_runtime = session_repository::Runtime::start(state.clone());
    let permits = Arc::new(Semaphore::new(16));
    span.end(true);
    let span = trace.begin(Phase::ReadinessAnnounce);
    println!("nesvo Rust host listening on {bind}:{actual_port}");
    span.end(true);
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
    // Fence final native spawn/input under the same lock before stopping either
    // producer. Command checks still need the event journal to persist cleanup.
    state.lock().unwrap().begin_shutdown();
    quota_runtime.request_shutdown();
    quota_wake_runtime.request_shutdown();
    job_runtime.request_shutdown();
    repository_runtime.request_shutdown();
    let (job_shutdown, webhook_shutdown) = tokio::join!(job_runtime.shutdown(), async {
        if let Some(listener) = webhooks {
            let result = listener.shutdown().await;
            state.lock().unwrap().set_job_trigger_listener(None);
            result
        } else {
            Ok(())
        }
    });
    if !quota_runtime.shutdown().await {
        eprintln!("Provider quota observation cleanup is unconfirmed");
    }
    if !quota_wake_runtime.shutdown().await {
        eprintln!("Quota wake dispatch cleanup is unconfirmed");
    }
    if !repository_runtime.shutdown().await {
        eprintln!("Session repository metadata cleanup is unconfirmed");
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
    webhook_shutdown?;
    job_shutdown?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_listener_requires_explicit_port_even_when_lan_mode_is_requested() {
        let default = Args::try_parse_from(["nesvo-host"]).unwrap();
        assert_eq!(default.webhook_port, None);
        let lan = Args::try_parse_from(["nesvo-host", "--lan"]).unwrap();
        assert_eq!(lan.webhook_port, None);
        let ephemeral = Args::try_parse_from(["nesvo-host", "--webhook-port", "0"]).unwrap();
        assert_eq!(ephemeral.webhook_port, Some(0));
        assert!(Args::try_parse_from(["nesvo-host", "--webhook-port", "65536"]).is_err());
    }

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

    mod boundary {
        use std::{
            fs,
            path::{Path, PathBuf},
            process::Command,
        };

        const JOURNAL_CLIENTS: &[&str] =
            &["apps/host/src/transport.rs", "apps/host/src/sessions.rs"];
        const JOURNAL_SERVICE_API: &[&str] = &[
            "Service",
            "Observation",
            "Event",
            "Page",
            "monotonic_millis",
        ];
        const JOURNAL_INTERNAL_PATHS: &[&str] =
            &["migrations::", "schema_migrations", "event_log as "];
        const TUI_HOST_MODULES: &[&str] = &["protocol"];

        fn repository_root() -> PathBuf {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .canonicalize()
                .unwrap()
        }

        fn committed_sources(root: &Path) -> Vec<String> {
            let listed = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["ls-files", "--", "apps/host/src/*.rs", "apps/tui/src/*.rs"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .filter(|sources| !sources.is_empty());
            listed.unwrap_or_else(|| {
                let mut sources = Vec::new();
                for directory in ["apps/host/src", "apps/tui/src"] {
                    walk(root, &root.join(directory), &mut sources);
                }
                sources
            })
        }

        fn walk(root: &Path, directory: &Path, sources: &mut Vec<String>) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, sources);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    let relative = path.strip_prefix(root).unwrap();
                    sources.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }

        fn is_identifier(character: char) -> bool {
            character.is_ascii_alphanumeric() || character == '_'
        }

        fn referenced_items(source: &str, module: &str) -> Vec<String> {
            let prefix = format!("{module}::");
            let mut items = Vec::new();
            for (index, _) in source.match_indices(&prefix) {
                if source[..index].ends_with(is_identifier) {
                    continue;
                }
                let rest = &source[index + prefix.len()..];
                if let Some(group) = rest.strip_prefix('{') {
                    let group = &group[..group.find('}').unwrap_or(group.len())];
                    items.extend(group.split(',').filter_map(|item| {
                        let segment = item.trim().split("::").next()?.split(' ').next()?;
                        (!segment.is_empty()).then(|| segment.to_owned())
                    }));
                } else {
                    let end = rest.find(|c: char| !is_identifier(c)).unwrap_or(rest.len());
                    items.push(rest[..end].to_owned());
                }
            }
            items
        }

        fn journal_violations(source: &str) -> Vec<String> {
            let mut violations: Vec<String> = referenced_items(source, "event_log")
                .into_iter()
                .filter(|item| !JOURNAL_SERVICE_API.contains(&item.as_str()))
                .map(|item| format!("event_log::{item}"))
                .collect();
            violations.extend(
                JOURNAL_INTERNAL_PATHS
                    .iter()
                    .filter(|path| source.contains(**path))
                    .map(|path| (*path).to_owned()),
            );
            violations
        }

        fn host_import_violations(source: &str) -> Vec<String> {
            let mut violations: Vec<String> = source
                .match_indices("nesvo_host")
                .filter(|(index, _)| !source[..*index].ends_with(is_identifier))
                .filter(|(index, name)| !source[index + name.len()..].starts_with("::"))
                .map(|_| "nesvo_host without a module path".to_owned())
                .collect();
            violations.extend(
                referenced_items(source, "nesvo_host")
                    .into_iter()
                    .filter(|item| !TUI_HOST_MODULES.contains(&item.as_str()))
                    .map(|item| format!("nesvo_host::{item}")),
            );
            violations.extend(
                source
                    .match_indices("host/src/")
                    .map(|(index, prefix)| &source[index + prefix.len()..])
                    .filter(|rest| {
                        !TUI_HOST_MODULES
                            .iter()
                            .any(|module| rest.starts_with(&format!("{module}.rs")))
                    })
                    .map(|rest| {
                        let end = rest.find(['"', ')']).unwrap_or(rest.len());
                        format!("host/src/{}", &rest[..end])
                    }),
            );
            violations
        }

        #[test]
        fn boundary_scanner_flags_journal_internals_and_host_imports() {
            assert_eq!(
                journal_violations(
                    "use crate::event_log::{Service, Store};\nlet head = crate::event_log::append_transaction(&tx, events);\ncrate::migrations::apply_pending(&tx);\nlet code = \"event_log_unavailable\";\ncrate::event_log::monotonic_millis();"
                ),
                [
                    "event_log::Store",
                    "event_log::append_transaction",
                    "migrations::"
                ]
            );
            assert_eq!(
                host_import_violations(
                    "use nesvo_host::protocol::Command;\nuse nesvo_host::{protocol, sessions::State};\nuse nesvo_host as host;\n#[path = \"../../host/src/event_log.rs\"]\nmod journal;\n#[path = \"../../host/src/protocol.rs\"]\nmod protocol;"
                ),
                [
                    "nesvo_host without a module path",
                    "nesvo_host::sessions",
                    "host/src/event_log.rs"
                ]
            );
        }

        #[test]
        fn boundary_transport_and_sessions_reach_the_journal_only_through_its_service_api() {
            let root = repository_root();
            let sources = committed_sources(&root);
            for client in JOURNAL_CLIENTS {
                assert!(
                    sources.iter().any(|source| source == client),
                    "{client} is part of the scanned source list"
                );
                let violations =
                    journal_violations(&fs::read_to_string(root.join(client)).unwrap());
                assert!(
                    violations.is_empty(),
                    "{client} must reach the event journal only through event_log::{JOURNAL_SERVICE_API:?}, never its store, schema or migrations; found {violations:?}"
                );
            }
        }

        #[test]
        fn boundary_tui_sources_import_no_host_module_except_protocol() {
            let root = repository_root();
            let tui_sources: Vec<String> = committed_sources(&root)
                .into_iter()
                .filter(|source| source.starts_with("apps/tui/src/"))
                .collect();
            assert!(
                tui_sources
                    .iter()
                    .any(|source| source == "apps/tui/src/main.rs"),
                "the TUI sources are part of the scanned source list"
            );
            for source in tui_sources {
                let violations =
                    host_import_violations(&fs::read_to_string(root.join(&source)).unwrap());
                assert!(
                    violations.is_empty(),
                    "{source} may use host modules {TUI_HOST_MODULES:?} only and otherwise depends on nesvo-wire; found {violations:?}"
                );
            }
        }
    }
}
