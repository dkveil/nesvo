//! Real official SDK client -> native MCP subprocess -> isolated native host.
use anyhow::{Context, Result, ensure};
use futures_util::FutureExt;
use rmcp::{
    RoleClient, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
        ProtocolVersion,
    },
    service::RunningService,
    transport::TokioChildProcess,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

struct Fixture {
    directory: PathBuf,
    host: Child,
    webhook_port: Option<u16>,
    startup_trace: startup_trace::Shared,
}
fn published_tool_count() -> usize {
    serde_json::from_str::<Vec<String>>(include_str!("../../../docs/harness-mcp-tools.json"))
        .expect("Bundled tool contract")
        .len()
}
#[path = "support/budgets.rs"]
mod budgets;
#[path = "support/calendars.rs"]
mod calendars;
#[path = "support/claude_quota_capture.rs"]
mod claude_quota_capture;
#[path = "support/host_ownership.rs"]
mod host_ownership;
#[path = "support/inbox.rs"]
mod inbox;
#[path = "support/input_redraw.rs"]
mod input_redraw;
#[path = "support/job_attempts.rs"]
mod job_attempts;
#[path = "support/job_cancellation.rs"]
mod job_cancellation;
#[path = "support/job_diagnostics.rs"]
mod job_diagnostics;
#[path = "support/job_launch_reconciliation.rs"]
mod job_launch_reconciliation;
#[path = "support/job_retries.rs"]
mod job_retries;
#[path = "support/job_timeouts.rs"]
mod job_timeouts;
#[path = "support/job_triggers.rs"]
mod job_triggers;
#[path = "support/jobs.rs"]
mod jobs;
#[path = "support/mcp_cancellation.rs"]
mod mcp_cancellation;
#[path = "support/model_profiles.rs"]
mod model_profiles;
#[path = "support/native_tool_permissions.rs"]
mod native_tool_permissions;
#[path = "support/prechecks.rs"]
mod prechecks;
#[path = "support/provider_quota.rs"]
mod provider_quota;
#[path = "support/quota_native_continuation.rs"]
mod quota_native_continuation;
#[path = "support/quota_session_wakes.rs"]
mod quota_session_wakes;
#[path = "support/recovery_hooks.rs"]
mod recovery_hooks;
#[path = "support/recovery_profile.rs"]
mod recovery_profile;
#[path = "support/run_budgets.rs"]
mod run_budgets;
#[path = "support/run_checkpoints.rs"]
mod run_checkpoints;
#[path = "support/run_controls.rs"]
mod run_controls;
#[path = "support/run_coordinator.rs"]
mod run_coordinator;
#[path = "support/run_delivery.rs"]
mod run_delivery;
#[path = "support/run_executor.rs"]
mod run_executor;
#[path = "support/run_launches.rs"]
mod run_launches;
#[path = "support/run_wakes.rs"]
mod run_wakes;
#[path = "support/scoped_review_context.rs"]
mod scoped_review_context;
#[path = "support/startup_trace.rs"]
mod startup_trace;
#[path = "support/task_tool_profiles.rs"]
mod task_tool_profiles;
impl Fixture {
    async fn start() -> Result<Self> {
        Self::start_variant(false).await
    }
    async fn start_variant(agent: bool) -> Result<Self> {
        Self::start_variant_with_client(agent, false).await
    }
    async fn start_variant_with_client(agent: bool, spaced_client: bool) -> Result<Self> {
        Self::start_options(agent, spaced_client, None).await
    }
    async fn start_with_webhooks() -> Result<Self> {
        Self::start_options(true, false, Some(0)).await
    }
    async fn start_options(
        agent: bool,
        spaced_client: bool,
        webhook_port: Option<u16>,
    ) -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-mcp-{}",
            hex::encode(nesvo_wire::random::<8>())
        ));
        std::fs::create_dir(&directory)?;
        let mut command = Command::new(Self::host_binary());
        if let Some(port) = webhook_port {
            command.arg("--webhook-port").arg(port.to_string());
        }
        if agent {
            install_agent_fixture(&directory, &mut command).await?;
        }
        if spaced_client {
            let client_dir = directory.join("native client łódź");
            std::fs::create_dir(&client_dir)?;
            let client = client_dir.join(if cfg!(windows) { "nesvo.exe" } else { "nesvo" });
            std::fs::copy(env!("CARGO_BIN_EXE_nesvo"), &client)?;
            command.env("NESVO_CLIENT_BINARY", client);
        }
        let (host, startup_trace) = Self::spawn_host(&directory, command).await?;
        Ok(Self {
            directory,
            host,
            webhook_port,
            startup_trace,
        })
    }
    async fn spawn_host(
        directory: &Path,
        mut command: Command,
    ) -> Result<(Child, startup_trace::Shared)> {
        command
            // Explicit owned-fixture opt-in; ordinary host startup stays quiet.
            .env("NESVO_STARTUP_DIAGNOSTICS", "1")
            .env("CODEX_HOME", directory.join("codex-home"))
            .env_remove("OPENAI_BASE_URL")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .env("CLAUDE_CONFIG_DIR", directory.join("claude-config"))
            .args(["--port", "0", "--exit-on-stdin-close", "--pairing-dir"])
            .arg(directory)
            .arg("--workspace")
            .arg(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut host = command
            .spawn()
            .context("Build nesvo-host before running this ignored native integration test")?;
        let startup_trace = startup_trace::shared();
        let started = tokio::time::Instant::now();
        let mut stdout_lines = 0u64;
        let mut stdout_bytes = 0u64;
        let mut stdout_closed = false;
        let mut output = BufReader::new(host.stdout.take().context("fixture stdout")?).lines();
        let ready = timeout(Duration::from_secs(15), async {
            while let Some(line) = output.next_line().await? {
                if startup_trace::consume(&startup_trace, &line) {
                    continue;
                }
                stdout_lines = stdout_lines.saturating_add(1);
                stdout_bytes = stdout_bytes.saturating_add(line.len() as u64);
                if line.contains("Rust host listening") {
                    return Ok::<_, anyhow::Error>(());
                }
            }
            stdout_closed = true;
            anyhow::bail!("Fixture host did not start")
        })
        .await;
        if !matches!(&ready, Ok(Ok(()))) {
            let pid = host.id();
            let status = match host.try_wait() {
                Ok(Some(status)) => {
                    json!({"state":"exited","code":status.code(),"success":status.success()})
                }
                Ok(None) => json!({"state":"running"}),
                Err(_) => json!({"state":"unavailable"}),
            };
            let observed_at_ms = started.elapsed().as_millis();
            let buffered_bytes = output.get_ref().buffer().len();
            let owned_directory = directory.to_path_buf();
            // A detached diagnostic thread cannot hold Tokio runtime shutdown
            // if filesystem metadata stalls. Never read private file contents.
            let (files_tx, files_rx) = tokio::sync::oneshot::channel();
            let _diagnostic = std::thread::Builder::new()
                .name("fixture-startup-diagnostic".into())
                .spawn(move || {
                    let files = [
                        "host.lock",
                        "pairing.json",
                        "pairing.svg",
                        "metadata.sqlite3",
                        "metadata.sqlite3-wal",
                    ]
                    .into_iter()
                    .map(|name| {
                        let facts = match std::fs::metadata(owned_directory.join(name)) {
                            Ok(metadata) => json!({"present":true,"bytes":metadata.len()}),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                json!({"present":false})
                            }
                            Err(_) => json!({"unavailable":true}),
                        };
                        (name.to_owned(), facts)
                    })
                    .collect::<serde_json::Map<String, Value>>();
                    let _ = files_tx.send(files);
                });
            let files = match timeout(Duration::from_secs(1), files_rx).await {
                Ok(Ok(files)) => Value::Object(files),
                _ => json!({"unavailable":true}),
            };
            // Failure before Fixture exists must still reap this owned child.
            // This observes cleanup; it never retries startup or extends readiness.
            let kill_requested = host.start_kill().is_ok();
            let cleanup = match timeout(Duration::from_secs(2), host.wait()).await {
                Ok(Ok(status)) => json!({"confirmed":true,"code":status.code()}),
                _ => json!({"confirmed":false}),
            };
            eprintln!(
                "NATIVE_HOST_STARTUP_DIAGNOSTIC {}",
                json!({
                    "phase":"await_listening_line","deadlineMs":15000,"elapsedMs":observed_at_ms,
                    "pid":pid,"process":status,"stdoutLines":stdout_lines,"stdoutBytes":stdout_bytes,
                    "stdoutClosed":stdout_closed,"bufferedBytes":buffered_bytes,"files":files,
                    "startupTrace":startup_trace::view(&startup_trace),
                    "ownedKillRequested":kill_requested,"cleanup":cleanup
                })
            );
            return match ready {
                Ok(Err(error)) => Err(error.context("Native fixture host startup failed before readiness; see bounded startup diagnostic")),
                Err(error) => Err(anyhow::Error::new(error).context("Native fixture host startup exceeded its 15-second readiness deadline; see bounded startup diagnostic")),
                Ok(Ok(())) => unreachable!(),
            };
        }
        // Keep draining after readiness; closing the pipe here could race the
        // host's remaining startup lines and cause a platform-specific BrokenPipe.
        let remaining_trace = startup_trace.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = output.next_line().await {
                startup_trace::consume(&remaining_trace, &line);
            }
        });
        Ok((host, startup_trace))
    }
    fn pairing(&self) -> PathBuf {
        self.directory.join("pairing.json")
    }
    fn host_binary() -> PathBuf {
        std::env::var_os("NESVO_HOST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_BIN_EXE_nesvo")).with_file_name(if cfg!(windows) {
                    "nesvo-host.exe"
                } else {
                    "nesvo-host"
                })
            })
    }
    async fn restart(&mut self, force: bool) -> Result<()> {
        if force {
            self.host.start_kill()?;
        } else {
            drop(self.host.stdin.take());
        }
        let status = timeout(Duration::from_secs(12), self.host.wait()).await??;
        ensure!(
            force || status.success(),
            "Owned host did not finish graceful shutdown"
        );
        let mut command = Command::new(Self::host_binary());
        if let Some(port) = self.webhook_port {
            command.arg("--webhook-port").arg(port.to_string());
        }
        if self.directory.join("bin").is_dir() {
            agent_fixture_environment(&self.directory, &mut command)?;
        }
        let (host, startup_trace) = Self::spawn_host(&self.directory, command).await?;
        self.host = host;
        self.startup_trace = startup_trace;
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        let host_pid = self.host.id();
        drop(self.host.stdin.take());
        let status = timeout(Duration::from_secs(10), self.host.wait())
            .await
            .with_context(|| {
                format!(
                    "Wait for owned native host {host_pid:?} shutdown in {}",
                    self.directory.display()
                )
            })?
            .with_context(|| {
                format!(
                    "Reap owned native host {host_pid:?} in {}",
                    self.directory.display()
                )
            })?;
        ensure!(
            status.success(),
            "Isolated host did not finish clean PTY shutdown"
        );
        let canonical = self.directory.canonicalize().with_context(|| {
            format!(
                "Resolve owned native fixture directory before cleanup: {}",
                self.directory.display()
            )
        })?;
        let temporary = std::env::temp_dir().canonicalize().context(
            "Resolve the OS temporary directory before validating native fixture cleanup",
        )?;
        ensure!(
            canonical.parent() == Some(temporary.as_path())
                && canonical
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("nesvo-mcp-")),
            "Refusing cleanup outside fixture"
        );
        std::fs::remove_dir_all(&canonical).with_context(|| {
            format!(
                "Remove owned native fixture tree after host exit: {}",
                canonical.display()
            )
        })?;
        Ok(())
    }
}
async fn install_agent_fixture(directory: &Path, host: &mut Command) -> Result<()> {
    let bin = directory.join("bin");
    let callers = directory.join("callers");
    std::fs::create_dir(&bin)?;
    std::fs::create_dir(&callers)?;
    let mut probe = Command::new("node");
    probe.args(["-p", "process.execPath"]);
    #[cfg(windows)]
    probe.creation_flags(0x08000000);
    let output = probe.output().await?;
    ensure!(
        output.status.success(),
        "Node is required for the controlled provider fixture"
    );
    let node = PathBuf::from(String::from_utf8(output.stdout)?.trim());
    let linked = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
    if std::fs::hard_link(&node, &linked).is_err() {
        std::fs::copy(&node, &linked)?;
    }
    let source = include_str!("../../../tests/fixtures/scoped-agent.cjs");
    for (program, package_name, main) in [
        ("claude", "@anthropic-ai/claude-code", "main.js"),
        ("codex", "@openai/codex", "codex.cjs"),
    ] {
        if cfg!(windows) {
            let package = bin.join("node_modules").join(package_name);
            std::fs::create_dir_all(&package)?;
            std::fs::write(
                package.join("package.json"),
                serde_json::to_vec(&json!({"bin":{program:main}}))?,
            )?;
            std::fs::write(package.join(main), source)?;
            std::fs::write(
                bin.join(format!("{program}.cmd")),
                "@echo off\r\necho NEVER_EXECUTE_FIXTURE_SHIM\r\n",
            )?;
        } else {
            let script = bin.join(program);
            std::fs::write(&script, source)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    agent_fixture_environment(directory, host)
}
fn agent_fixture_environment(directory: &Path, host: &mut Command) -> Result<()> {
    let mut paths = vec![directory.join("bin")];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    host.env("PATH", std::env::join_paths(paths)?)
        .env("NESVO_TEST_CALLERS", directory.join("callers"))
        .env("NESVO_CLIENT_BINARY", env!("CARGO_BIN_EXE_nesvo"));
    Ok(())
}
async fn scoped_client(context: &Path, id: &str) -> Result<RunningService<RoleClient, ()>> {
    let config = context.with_file_name("mcp.json");
    let mut command = if config.exists() {
        // Consume the actual provider-facing launch config, not a hand-built equivalent.
        let config: Value = serde_json::from_slice(&std::fs::read(config)?)?;
        let server = &config["mcpServers"]["nesvo"];
        assert_eq!(server["args"], json!(["mcp"]));
        assert_eq!(server["env"]["NESVO_AGENT_CONTEXT"], json!(context));
        let mut command = Command::new(
            server["command"]
                .as_str()
                .context("native MCP executable")?,
        );
        command.arg("mcp");
        command
    } else {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
        command.arg("mcp");
        command
    };
    command
        .env("NESVO_AGENT_CONTEXT", context)
        .env("NESVO_SESSION_ID", id);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(().serve(TokioChildProcess::new(command)?).await?)
}
async fn session_ready(client: &RunningService<RoleClient, ()>, id: &str) -> Result<()> {
    timeout(Duration::from_secs(10), async {
        loop {
            let current = data(call(client, "nesvo_get_session", json!({"sessionId":id})).await?)?;
            if current["data"]["session"]["readiness"]["phase"] == "ready"
                && current["data"]["session"]["status"]["state"] == "idle"
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("Controlled provider readiness")??;
    Ok(())
}
async fn human_control(pairing: &Path, id: &str) -> Result<Child> {
    human_control_variant(pairing, id, false).await
}
async fn human_control_variant(pairing: &Path, id: &str, draft: bool) -> Result<Child> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .args(["--import", "tsx"])
        .arg(root.join("tests/fixtures/human-control.ts"))
        .arg(pairing)
        .arg(id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    if draft {
        command.arg("--draft");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut process = command.spawn()?;
    let mut output = BufReader::new(process.stdout.take().context("human fixture stdout")?).lines();
    let ready = timeout(Duration::from_secs(10), output.next_line()).await??;
    ensure!(
        ready.as_deref() == Some("HUMAN_CONTROL_READY"),
        "Human fixture did not acquire its lease"
    );
    Ok(process)
}
async fn client(pairing: &Path) -> Result<RunningService<RoleClient, ()>> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command.arg("--pairing").arg(pairing).arg("mcp");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(().serve(TokioChildProcess::new(command)?).await?)
}
async fn recoveries(pairing: &Path) -> Result<Value> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .args(["--import", "tsx"])
        .arg(root.join("tests/fixtures/recovery-probe.ts"))
        .arg(pairing)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(10), command.output())
        .await
        .context("Owned native recovery query deadline")??;
    ensure!(
        output.status.success(),
        "Owned recovery query failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &'static str,
    args: Value,
) -> Result<CallToolResult> {
    Ok(client
        .call_tool(
            CallToolRequestParams::new(name)
                .with_arguments(args.as_object().context("fixture arguments")?.clone()),
        )
        .await?)
}
fn data(result: CallToolResult) -> Result<Value> {
    ensure!(
        result.is_error != Some(true),
        "Unexpected tool failure: {:?}",
        result.structured_content
    );
    result
        .structured_content
        .context("Missing structured result")
}

async fn observed_output(
    client: &RunningService<RoleClient, ()>,
    id: &str,
    marker: &str,
) -> Result<()> {
    timeout(Duration::from_secs(10), async {
        loop {
            let page = data(
                call(
                    client,
                    "nesvo_read_session",
                    json!({"sessionId":id,"maxBytes":8192}),
                )
                .await?,
            )?;
            if page["data"]["page"]["data"]
                .as_str()
                .is_some_and(|text| text.contains(marker))
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("The isolated shell did not produce the expected output before interruption")??;
    Ok(())
}

async fn report_from_controlled_worker(
    client: &RunningService<RoleClient, ()>,
    directory: &Path,
    id: &str,
) -> Result<Value> {
    session_ready(client, id)
        .await
        .context("Task fixture readiness before its first submission")?;
    let sent = data(
        call(
            client,
            "nesvo_send_prompt",
            json!({"sessionId":id,"key":format!("task-report-{id}"),"prompt":"report-task"}),
        )
        .await?,
    )?;
    let ended = data(
        call(
            client,
            "nesvo_wait_prompt",
            json!({"id":sent["data"]["receipt"]["id"],"sessionId":id,"timeoutMs":10000}),
        )
        .await?,
    )?;
    ensure!(
        ended["data"]["wait"]["reached"] == true,
        "Controlled report turn did not settle"
    );
    Ok(serde_json::from_slice(&std::fs::read(
        directory.join("callers").join(format!("{id}.result.json")),
    )?)?)
}

#[tokio::test]
#[ignore = "requires cargo build --workspace and an isolated native PTY host"]
async fn sdk_client_uses_native_mcp_receipts_and_shuts_down_without_control() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let mcp = client(&fixture.pairing()).await?;
        let tools = mcp.list_all_tools().await?;
        assert_eq!(tools.len(), published_tool_count());
        assert!(tools.iter().all(|tool| tool.output_schema.is_some()));
        let run=data(call(&mcp,"nesvo_create_run",json!({"key":"sdk-run","spec":{"title":"SDK plan","goal":"A literal private goal"}})).await?)?;
        assert_eq!(run["data"]["run"]["state"],"draft");
        let run_id=run["data"]["run"]["id"].as_str().context("run ID")?;
        let plan_args=json!({"key":"sdk-plan","runId":run_id,"expectedRevision":1,"tasks":[{"key":"implement","title":"Implement","instruction":"Produce a result"},{"key":"review","title":"Review","instruction":"Validate the result","dependencies":["implement"]}]});
        let plan=data(call(&mcp,"nesvo_set_run_plan",plan_args.clone()).await?)?;
        assert_eq!(plan["data"]["run"]["revision"],2);
        assert_eq!(plan["data"]["tasks"][1]["dependencies"][0],plan["data"]["tasks"][0]["id"]);
        assert_eq!(data(call(&mcp,"nesvo_set_run_plan",plan_args).await?)?,plan);
        let replay=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing()).args(["run","mutation","--key","sdk-plan","--json"]).output().await?;
        ensure!(replay.status.success(),"CLI plan recovery failed: {}",String::from_utf8_lossy(&replay.stdout));
        assert_eq!(serde_json::from_slice::<Value>(&replay.stdout)?["data"],plan["data"]);
        let stale=call(&mcp,"nesvo_set_run_plan",json!({"key":"stale","runId":run_id,"expectedRevision":1,"tasks":[]})).await?;
        assert_eq!(stale.structured_content.context("revision error")?["error"]["code"],"revision_conflict");
        let initial = data(call(&mcp, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(initial["data"]["sessions"], json!([]));
        let spec = json!({"name":"MCP shell łódź","program":"shell","cwd":fixture.directory});
        let created = data(
            call(
                &mcp,
                "nesvo_create_session",
                json!({"key":"sdk-once","spec":spec}),
            )
            .await?,
        )?;
        assert_eq!(created["data"]["receipt"]["phase"], "created");
        let id = created["data"]["receipt"]["sessionId"]
            .as_str()
            .context("created session")?;
        let replay = data(
            call(
                &mcp,
                "nesvo_create_session",
                json!({"key":"sdk-once","spec":spec}),
            )
            .await?,
        )?;
        assert_eq!(replay, created);
        let cli = Command::new(env!("CARGO_BIN_EXE_nesvo"))
            .arg("--pairing")
            .arg(fixture.pairing())
            .args([
                "session",
                "create",
                "MCP shell łódź",
                "--key",
                "sdk-once",
                "--cwd",
            ])
            .arg(&fixture.directory)
            .arg("--json")
            .output()
            .await?;
        ensure!(cli.status.success(), "CLI replay failed");
        let replay_cli: Value = serde_json::from_slice(&cli.stdout)?;
        assert_eq!(replay_cli["data"]["receipt"], created["data"]["receipt"]);
        let current = data(call(&mcp, "nesvo_get_session", json!({"sessionId":id})).await?)?;
        assert_eq!(current["data"]["session"]["controllerId"], Value::Null);
        assert_eq!(current["data"]["session"]["running"], true);
        let listing = data(call(&mcp, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(
            listing["data"]["sessions"]
                .as_array()
                .context("sessions")?
                .len(),
            1
        );
        let receipt = data(call(&mcp, "nesvo_get_operation", json!({"key":"sdk-once"})).await?)?;
        let child = data(call(&mcp,"nesvo_create_session",json!({"key":"sdk-child","spec":{"name":"MCP child","program":"shell","cwd":fixture.directory,"parentSessionId":id}})).await?)?;
        let child_id=child["data"]["receipt"]["sessionId"].as_str().context("child ID")?;
        let replay_child=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing())
            .args(["session","create","MCP child","--key","sdk-child","--parent",id,"--cwd"]).arg(&fixture.directory).arg("--json").output().await?;
        ensure!(replay_child.status.success(),"CLI child replay failed: {}",String::from_utf8_lossy(&replay_child.stdout));
        let replay_child:Value=serde_json::from_slice(&replay_child.stdout)?;
        assert_eq!(replay_child["data"]["receipt"],child["data"]["receipt"]);
        let child_view=data(call(&mcp,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
        assert_eq!(child_view["data"]["session"]["parentSessionId"],id);
        assert_eq!(child_view["data"]["session"]["controllerId"],Value::Null);
        assert_eq!(receipt["data"]["receipt"], created["data"]["receipt"]);
        assert!(receipt["data"]["cursor"].as_u64().context("cursor")? >= 3);
        // NoLogo/NoProfile PowerShell can still initialize after process creation.
        // Wait for this fixture's prompt, rather than equate PTY creation with readiness.
        #[cfg(windows)]
        observed_output(&mcp,id,"PS ").await?;
        let sent = data(call(&mcp,"nesvo_send_prompt",json!({"sessionId":id,"key":"sdk-send","prompt":"echo NESVO_MCP_SEND"})).await?)?;
        assert_eq!(sent["data"]["receipt"]["phase"],"delivered");
        assert_eq!(sent["data"]["receipt"]["result"]["nativeWriteFlushed"],true);
        let replay_send = Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing())
            .args(["session","send",id,"--key","sdk-send","--prompt","echo NESVO_MCP_SEND","--json"]).output().await?;
        ensure!(replay_send.status.success(),"CLI send replay failed: {}",String::from_utf8_lossy(&replay_send.stdout));
        let replay_send:Value=serde_json::from_slice(&replay_send.stdout)?;
        assert_eq!(replay_send["data"]["receipt"],sent["data"]["receipt"]);
        let delivered=data(call(&mcp,"nesvo_wait_prompt",json!({"id":sent["data"]["receipt"]["id"],"sessionId":id,"until":"delivered","timeoutMs":100})).await?)?;
        assert_eq!(delivered["data"]["wait"]["reached"],true);
        assert_eq!(delivered["data"]["wait"]["outcome"],"reached");
        let unsupported=call(&mcp,"nesvo_wait_prompt",json!({"key":"sdk-send","until":"settled","timeoutMs":100})).await?;
        assert_eq!(unsupported.is_error,Some(true));
        assert_eq!(unsupported.structured_content.context("wait error")?["error"]["code"],"unsupported","a shell write never claims an agent response");
        observed_output(&mcp,id,"NESVO_MCP_SEND").await?;
        let read = data(
            call(
                &mcp,
                "nesvo_read_session",
                json!({"sessionId":id,"maxBytes":256}),
            )
            .await?,
        )?;
        assert_eq!(read["data"]["page"]["format"], "terminalReplay");
        let explain = data(call(&mcp, "nesvo_explain_session", json!({"sessionId":id})).await?)?;
        assert_eq!(explain["data"]["report"]["sessions"][0]["sessionId"], id);
        let events =
            data(call(&mcp, "nesvo_read_events", json!({"after":0,"sessionId":id})).await?)?;
        assert!(
            events["data"]["events"]
                .as_array()
                .context("events")?
                .iter()
                .any(|e| e["kind"] == "operation.changed")
        );
        assert_eq!(
            call(&mcp, "nesvo_read_diff", json!({"sessionId":id}))
                .await?
                .is_error,
            Some(true),
            "a non-repository returns an actionable tool error"
        );
        let conflict = call(
            &mcp,
            "nesvo_create_session",
            json!({"key":"sdk-once","spec":{"name":"different"}}),
        )
        .await?;
        assert_eq!(
            conflict.structured_content.context("error")?["error"]["code"],
            "idempotency_conflict"
        );
        let rejected = call(&mcp, "nesvo_get_session", json!({"sessionId":"absent"})).await?;
        assert_eq!(rejected.is_error, Some(true));
        assert_eq!(
            rejected.structured_content.context("error")?["error"]["code"],
            "session_not_found"
        );
        let interrupted=data(call(&mcp,"nesvo_interrupt_session",json!({"sessionId":id,"key":"sdk-interrupt"})).await?)?;
        assert_eq!(interrupted["data"]["receipt"]["phase"],"delivered");
        assert_eq!(interrupted["data"]["receipt"]["result"]["agentStopped"],Value::Null);
        // Ctrl+C is allowed to exit the original shell, especially on Windows.
        // Exercise actual native stop on a separate process that was not interrupted.
        let stop_fixture=data(call(&mcp,"nesvo_create_session",json!({"key":"sdk-stop-fixture","spec":{"name":"Stop fixture","program":"shell","cwd":fixture.directory}})).await?)?;
        let stop_id=stop_fixture["data"]["receipt"]["sessionId"].as_str().context("stop fixture")?;
        let stopped=data(call(&mcp,"nesvo_stop_session",json!({"sessionId":stop_id,"key":"sdk-stop"})).await?)?;
        assert_eq!(stopped["data"]["receipt"]["phase"],"stopRequested");
        let replay_stop=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing())
            .args(["session","stop",stop_id,"--key","sdk-stop","--json"]).output().await?;
        ensure!(replay_stop.status.success(),"CLI stop replay failed");
        let replay_stop:Value=serde_json::from_slice(&replay_stop.stdout)?;
        assert_eq!(replay_stop["data"]["receipt"],stopped["data"]["receipt"]);
        timeout(Duration::from_secs(5), async {
            loop {
                let observed=data(call(&mcp,"nesvo_get_session",json!({"sessionId":stop_id})).await?)?;
                if observed["data"]["session"]["running"]==false {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await??;
        let already_stopped=data(call(&mcp,"nesvo_stop_session",json!({"sessionId":stop_id,"key":"sdk-already-stopped"})).await?)?;
        assert_eq!(already_stopped["data"]["receipt"]["phase"],"stopped");
        assert_eq!(already_stopped["data"]["receipt"]["result"]["processExited"],true);
        assert_eq!(already_stopped["data"]["receipt"]["result"]["nativeStopRequested"],false);
        let retained=data(call(&mcp,"nesvo_read_session",json!({"sessionId":id,"after":0,"maxBytes":8192})).await?)?;
        assert!(retained["data"]["page"]["data"].as_str().context("retained output")?.contains("NESVO_MCP_SEND"));
        mcp.cancel().await?;

        let mut legacy_command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
        legacy_command
            .arg("--pairing")
            .arg(fixture.pairing())
            .arg("mcp");
        legacy_command.env("NESVO_SESSION_ID", id);
        #[cfg(windows)]
        legacy_command.creation_flags(0x08000000);
        let legacy = ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("nesvo-legacy-fixture", "1"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
        .serve(TokioChildProcess::new(legacy_command)?)
        .await?;
        assert_eq!(legacy.list_all_tools().await?.len(), published_tool_count());
        let legacy_result = legacy
            .call_tool(
                CallToolRequestParams::new("nesvo_get_session")
                    .with_arguments(json!({"sessionId":id}).as_object().context("args")?.clone()),
            )
            .await?;
        assert_eq!(data(legacy_result)?["data"]["session"]["id"], id);
        let current = legacy
            .call_tool(
                CallToolRequestParams::new("nesvo_get_current_session")
                    .with_arguments(Default::default()),
            )
            .await?;
        assert_eq!(data(current)?["data"]["session"]["id"], id);
        legacy.cancel().await?;

        // Invalid pairing/context is an error, never a fallback to the human key.
        let mut forged: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
        forged["scopeId"] = json!("f".repeat(32));
        let context = fixture.directory.join("invalid-context.json");
        std::fs::write(&context, serde_json::to_vec(&forged)?)?;
        let scoped = client(&context).await?;
        assert_eq!(
            scoped.list_all_tools().await?.len(),
            published_tool_count(),
            "catalog/help need no host effects"
        );
        let refused = call(&scoped, "nesvo_list_sessions", json!({})).await?;
        assert_eq!(refused.is_error, Some(true));
        assert_eq!(
            refused.structured_content.context("error")?["error"]["code"],
            "host_unavailable"
        );
        scoped.cancel().await?;

        // A malformed or oversized stdio line must terminate before host dispatch.
        for input in [b"{broken json}\n".to_vec(), vec![b'x'; 65537]] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
            command
                .arg("--pairing")
                .arg(fixture.pairing())
                .arg("mcp")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut process = command.spawn()?;
            process
                .stdin
                .take()
                .context("stdio")?
                .write_all(&input)
                .await?;
            let output = timeout(Duration::from_secs(5), process.wait_with_output()).await??;
            assert!(
                output.stdout.is_empty(),
                "stdout contains only protocol frames"
            );
        }
        let disconnected = client(&fixture.pairing()).await?;
        drop(fixture.host.stdin.take());
        ensure!(
            timeout(Duration::from_secs(10), fixture.host.wait())
                .await??
                .success(),
            "host shutdown"
        );
        let unavailable = call(&disconnected, "nesvo_list_sessions", json!({})).await?;
        assert_eq!(unavailable.is_error, Some(true));
        assert_eq!(
            unavailable.structured_content.context("error")?["error"]["code"],
            "host_unavailable"
        );
        disconnected.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires native binaries and Node; controlled CLI fixture, no model calls"]
async fn coordinator_uses_its_own_context_to_create_and_control_only_granted_children() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let workspace=fixture.directory.join("workspace");
        std::fs::create_dir(&workspace)?;
        let owner=client(&fixture.pairing()).await?;
        timeout(Duration::from_secs(5),async {
            loop {
                let report=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing()).args(["doctor","--json"]).output().await?;
                let report:Value=serde_json::from_slice(&report.stdout)?;
                if report["providerVersions"].as_array().is_some_and(|versions|versions.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")) {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"coordinator","spec":{"name":"Coordinator fixture","program":"claude","role":"coordinator","harness":true,"cwd":workspace}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("coordinator ID")?;
        session_ready(&owner,root_id).await?;
        let root_view=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;
        assert_eq!(root_view["data"]["session"]["role"],"coordinator");
        assert_eq!(root_view["data"]["session"]["harness"]["enabled"],true);
        assert_eq!(root_view["data"]["session"]["harness"]["loaded"],Value::Null,"prepared configuration does not prove model pickup");
        data(call(&owner,"nesvo_send_prompt",json!({"sessionId":root_id,"key":"spawn-child","prompt":"spawn-child"})).await?)?;
        let result_path=fixture.directory.join("callers").join(format!("{root_id}.child.json"));
        let spawned=timeout(Duration::from_secs(10),async {
            loop {
                if let Ok(contents)=std::fs::read(&result_path)
                    && let Ok(value)=serde_json::from_slice::<Value>(&contents) {return value;}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.context("Managed process did not create its child through the CLI")?;
        let child_id=spawned["data"]["receipt"]["sessionId"].as_str().context("managed child")?;
        assert_eq!(spawned["data"]["receipt"]["phase"],"created");
        session_ready(&owner,child_id).await?;
        let context_for=|id:&str|->Result<PathBuf>{Ok(PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{id}.txt")))?))};
        let context=context_for(root_id)?;
        let coordinator=scoped_client(&context,root_id).await?;
        let scoped_run=data(call(&coordinator,"nesvo_create_run",json!({"key":"scoped-run","spec":{"title":"Own run","goal":"Private goal"}})).await?)?;
        assert_eq!(scoped_run["data"]["run"]["coordinatorSessionId"],root_id);
        let scoped_run_id=scoped_run["data"]["run"]["id"].clone();
        let planned=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"task-plan","runId":scoped_run_id,"expectedRevision":1,"tasks":[{"key":"implement","title":"Implement","instruction":"Controlled result only"},{"key":"review","title":"Review","instruction":"Controlled review only","dependencies":["implement"]}]})).await?)?;
        let implementation=planned["data"]["tasks"][0]["id"].clone();
        let review=planned["data"]["tasks"][1]["id"].clone();
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"task-activate","runId":scoped_run_id,"expectedRevision":2})).await?)?;
        let owner_run=data(call(&owner,"nesvo_create_run",json!({"key":"private-owner-run","spec":{"title":"Owner run","goal":"Owner-only goal"}})).await?)?;
        let unavailable=call(&coordinator,"nesvo_get_run",json!({"runId":owner_run["data"]["run"]["id"]})).await?;
        assert_eq!(unavailable.structured_content.context("run isolation")?["error"]["code"],"run_not_found");
        let forged=call(&coordinator,"nesvo_create_run",json!({"key":"forged-run","spec":{"title":"forged","goal":"x","coordinatorSessionId":"foreign"}})).await?;
        assert_eq!(forged.structured_content.context("run authority")?["error"]["code"],"forbidden");
        let runs=data(call(&coordinator,"nesvo_list_runs",json!({})).await?)?;
        assert_eq!(runs["data"]["runs"].as_array().context("scoped runs")?.len(),1);
        let listed=data(call(&coordinator,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(listed["data"]["sessions"].as_array().context("scoped list")?.len(),2);
        let child=data(call(&coordinator,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
        assert_eq!(child["data"]["session"]["parentSessionId"],root_id);
        assert_eq!(child["data"]["session"]["role"],"worker");
        assert_eq!(child["data"]["session"]["harness"]["enabled"],true,"coordinator profile is inherited by default");
        assert_eq!(child["data"]["session"]["controllerId"],Value::Null);
        assert_eq!(std::fs::canonicalize(child["data"]["session"]["cwd"].as_str().context("child cwd")?)?,workspace.canonicalize()?);
        let replay=data(call(&coordinator,"nesvo_create_session",json!({"key":"agent-child-once","spec":{"name":"Scoped child","program":"claude"}})).await?)?;
        assert_eq!(replay["data"]["receipt"],spawned["data"]["receipt"]);
        let metadata=data(call(&owner,"nesvo_create_session",json!({"key":"metadata-only","spec":{"name":"Not shared","program":"claude","cwd":workspace,"parentSessionId":root_id}})).await?)?;
        let foreign_id=metadata["data"]["receipt"]["sessionId"].as_str().context("metadata-only ID")?;
        let forbidden=call(&coordinator,"nesvo_get_session",json!({"sessionId":foreign_id})).await?;
        assert_eq!(forbidden.structured_content.context("foreign refusal")?["error"]["code"],"forbidden","parent metadata alone does not grant access");
        let visible=data(call(&coordinator,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(visible["data"]["sessions"].as_array().context("filtered list")?.len(),2,"metadata-only child must not appear in coordinator snapshots");
        let opt_out=data(call(&coordinator,"nesvo_create_session",json!({"key":"opt-out","spec":{"name":"No harness worker","program":"claude","harness":false}})).await?)?;
        let opted_id=opt_out["data"]["receipt"]["sessionId"].as_str().context("opt-out child")?;
        let opted=data(call(&coordinator,"nesvo_get_session",json!({"sessionId":opted_id})).await?)?;
        assert_eq!(opted["data"]["session"]["harness"]["enabled"],false);
        let cli_launch=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing()).args(["session","create","CLI harness worker","--program","claude","--harness","--key","cli-harness-worker","--json"]).output().await?;
        ensure!(cli_launch.status.success(),"CLI harness launch failed");
        let cli_launch:Value=serde_json::from_slice(&cli_launch.stdout)?;
        let cli_id=cli_launch["data"]["receipt"]["sessionId"].as_str().context("CLI harness ID")?;
        session_ready(&owner,cli_id).await?;
        let cli_view=data(call(&owner,"nesvo_get_session",json!({"sessionId":cli_id})).await?)?;
        assert_eq!(cli_view["data"]["session"]["harness"]["enabled"],true);
        let native_codex=data(call(&owner,"nesvo_create_session",json!({"key":"codex-adapter","spec":{"name":"Native Codex adapter fixture","program":"codex","cwd":workspace}})).await?)?;
        let codex_id=native_codex["data"]["receipt"]["sessionId"].as_str().context("Codex ID")?;
        session_ready(&owner,codex_id).await?;
        let explained=data(call(&owner,"nesvo_explain_session",json!({"sessionId":codex_id})).await?)?;
        assert_eq!(explained["data"]["report"]["sessions"][0]["integration"]["adapter"],"codex-hooks-v1");
        let codex_sent=data(call(&owner,"nesvo_send_prompt",json!({"sessionId":codex_id,"key":"native-codex-turn","prompt":"literal native Codex prompt"})).await?)?;
        let codex_done=data(call(&owner,"nesvo_wait_prompt",json!({"id":codex_sent["data"]["receipt"]["id"],"timeoutMs":5000})).await?)?;
        assert_eq!(codex_done["data"]["receipt"]["phase"],"settled");
        let unsupported=call(&owner,"nesvo_create_session",json!({"key":"unsupported-harness","spec":{"name":"Unsupported shell harness","program":"shell","harness":true}})).await?;
        assert_eq!(unsupported.structured_content.context("unsupported provider")?["error"]["receipt"]["result"]["code"],"unsupported");
        for spec in [json!({"name":"recursive","role":"coordinator"}),json!({"name":"forged-parent","parentSessionId":foreign_id})] {
            let rejected=call(&coordinator,"nesvo_create_session",json!({"key":"rejected-create","spec":spec})).await?;
            assert_eq!(rejected.structured_content.context("create refusal")?["error"]["code"],"forbidden");
        }
        let outside=call(&coordinator,"nesvo_create_session",json!({"key":"outside","spec":{"name":"outside","cwd":fixture.directory}})).await?;
        let error=outside.structured_content.context("outside failure")?;
        assert_eq!(error["error"]["receipt"]["phase"],"failed");
        assert_eq!(error["error"]["receipt"]["result"]["code"],"forbidden");
        assert_eq!(error["error"]["receipt"]["result"]["effectStarted"],false);
        let mut human=human_control(&fixture.pairing(),child_id).await?;
        let refused=call(&coordinator,"nesvo_send_prompt",json!({"sessionId":child_id,"key":"human-busy","prompt":"do not type"})).await?;
        let refused=refused.structured_content.context("human refusal")?;
        assert_eq!(refused["error"]["receipt"]["result"]["code"],"control_busy");
        assert_eq!(refused["error"]["receipt"]["result"]["effectStarted"],false);
        let refused=call(&coordinator,"nesvo_assign_task",json!({"key":"human-assignment","runId":scoped_run_id,"taskId":implementation,"sessionId":child_id,"expectedRevision":3})).await?;
        assert_eq!(refused.structured_content.context("human assignment refusal")?["error"]["code"],"control_busy");
        drop(human.stdin.take());
        ensure!(timeout(Duration::from_secs(5),human.wait()).await??.success(),"Human fixture shutdown");
        timeout(Duration::from_secs(5),async {
            loop {
                let view=data(call(&owner,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
                if view["data"]["session"]["controllerId"].is_null() {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let sent=data(call(&coordinator,"nesvo_send_prompt",json!({"sessionId":child_id,"key":"child-turn","prompt":"literal child prompt"})).await?)?;
        let completed=data(call(&coordinator,"nesvo_wait_prompt",json!({"id":sent["data"]["receipt"]["id"],"sessionId":child_id,"timeoutMs":5000})).await?)?;
        assert_eq!(completed["data"]["receipt"]["phase"],"settled");
        let events=data(call(&coordinator,"nesvo_read_events",json!({"sessionId":child_id,"after":0})).await?)?;
        assert!(events["data"]["events"].as_array().context("child events")?.iter().all(|event|event["sessionId"]==child_id));
        let child_context=context_for(child_id)?;
        let mut forged:Value=serde_json::from_slice(&std::fs::read(&child_context)?)?;
        forged["role"]=json!("coordinator");
        forged["authority"]=json!("owner");
        std::fs::write(&child_context,serde_json::to_vec(&forged)?)?;
        let worker=scoped_client(&child_context,root_id).await?;
        let forbidden_run=call(&worker,"nesvo_get_run",json!({"runId":scoped_run_id})).await?;
        assert_eq!(forbidden_run.structured_content.context("worker run denial")?["error"]["code"],"forbidden");
        let bound=data(call(&worker,"nesvo_get_current_session",json!({})).await?)?;
        assert_eq!(bound["data"]["session"]["id"],child_id,"server binding wins over forged current-session hints");
        let rejected=call(&worker,"nesvo_create_session",json!({"key":"worker-cannot-fork","spec":{"name":"forbidden"}})).await?;
        assert_eq!(rejected.structured_content.context("worker refusal")?["error"]["code"],"forbidden");
        let parent=call(&worker,"nesvo_get_session",json!({"sessionId":root_id})).await?;
        assert_eq!(parent.structured_content.context("parent refusal")?["error"]["code"],"forbidden");
        let foreign_assignment=call(&coordinator,"nesvo_assign_task",json!({"key":"foreign-assignment","runId":scoped_run_id,"taskId":implementation,"sessionId":foreign_id,"expectedRevision":3})).await?;
        assert_eq!(foreign_assignment.structured_content.context("foreign worker refusal")?["error"]["code"],"forbidden");
        let assigned=data(call(&coordinator,"nesvo_assign_task",json!({"key":"assign-implementation","runId":scoped_run_id,"taskId":implementation,"sessionId":child_id,"expectedRevision":3})).await?)?;
        let attempt=assigned["data"]["tasks"][0]["currentAttempt"]["id"].clone();
        let current=data(call(&worker,"nesvo_get_current_task",json!({})).await?)?;
        assert_eq!(current["data"]["attempt"]["id"],attempt,"forged environment hints do not change task binding");
        let report=report_from_controlled_worker(&coordinator,&fixture.directory,child_id).await?;
        assert_eq!(report["data"]["attempt"]["state"],"reported");
        let replay=data(call(&worker,"nesvo_get_run_mutation",json!({"key":"fixture-result"})).await?)?;
        assert_eq!(replay["data"],report["data"],"worker CLI and MCP share the same result receipt");
        let pending=data(call(&coordinator,"nesvo_get_run",json!({"runId":scoped_run_id})).await?)?;
        assert_eq!(pending["data"]["tasks"][0]["taskResult"],Value::Null);
        assert_eq!(pending["data"]["tasks"][1]["dependencyState"],"waiting");
        let validation=json!({"passed":true,"summary":"Checked controlled result transport","checks":[{"name":"transport-review","outcome":"passed","details":"Controlled fixture only, no production code validation"}]});
        let self_validation=call(&worker,"nesvo_validate_task_result",json!({"key":"self-validation","runId":scoped_run_id,"attemptId":attempt,"expectedRevision":5,"validation":validation})).await?;
        assert_eq!(self_validation.structured_content.context("self validation refusal")?["error"]["code"],"forbidden");
        let validated=data(call(&coordinator,"nesvo_validate_task_result",json!({"key":"validate-implementation","runId":scoped_run_id,"attemptId":attempt,"expectedRevision":5,"validation":validation})).await?)?;
        assert_eq!(validated["data"]["tasks"][1]["dependencyState"],"ready");
        let assigned=data(call(&coordinator,"nesvo_assign_task",json!({"key":"assign-review","runId":scoped_run_id,"taskId":review,"sessionId":opted_id,"expectedRevision":6})).await?)?;
        let review_attempt=assigned["data"]["tasks"][1]["currentAttempt"]["id"].clone();
        report_from_controlled_worker(&coordinator,&fixture.directory,opted_id).await?;
        let finished=data(call(&coordinator,"nesvo_validate_task_result",json!({"key":"validate-review","runId":scoped_run_id,"attemptId":review_attempt,"expectedRevision":8,"validation":validation})).await?)?;
        assert_eq!(finished["data"]["run"]["state"],"succeeded");
        let history=data(call(&coordinator,"nesvo_get_task_attempts",json!({"runId":scoped_run_id,"taskId":implementation})).await?)?;
        assert_eq!(history["data"]["attempts"][0]["validation"]["source"],"coordinatorAttestation");
        worker.cancel().await?;
        coordinator.cancel().await?;
        let reconnected=scoped_client(&context,root_id).await?;
        let replay=data(call(&reconnected,"nesvo_get_operation",json!({"key":"agent-child-once"})).await?)?;
        assert_eq!(replay["data"]["receipt"],spawned["data"]["receipt"]);
        data(call(&owner,"nesvo_stop_session",json!({"sessionId":root_id,"key":"stop-coordinator"})).await?)?;
        timeout(Duration::from_secs(5),async {
            loop {
                let view=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;
                if view["data"]["session"]["running"]==false {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let revoked=call(&reconnected,"nesvo_get_session",json!({"sessionId":child_id})).await?;
        assert_eq!(revoked.is_error,Some(true));
        let surviving=data(call(&owner,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
        assert_eq!(surviving["data"]["session"]["running"],true,"coordinator exit does not kill child sessions");
        let retained=data(call(&owner,"nesvo_get_run",json!({"runId":scoped_run_id})).await?)?;
        assert_eq!(retained["data"]["run"]["state"],"succeeded");
        reconnected.cancel().await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}
