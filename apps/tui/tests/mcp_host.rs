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
}
impl Fixture {
    async fn start() -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-mcp-{}",
            hex::encode(nesvo_wire::random::<8>())
        ));
        std::fs::create_dir(&directory)?;
        let binary = std::env::var_os("NESVO_HOST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_BIN_EXE_nesvo")).with_file_name(if cfg!(windows) {
                    "nesvo-host.exe"
                } else {
                    "nesvo-host"
                })
            });
        let mut command = Command::new(binary);
        command
            .args(["--port", "0", "--exit-on-stdin-close", "--pairing-dir"])
            .arg(&directory)
            .arg("--workspace")
            .arg(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut host = command
            .spawn()
            .context("Build nesvo-host before running this ignored native integration test")?;
        let mut output = BufReader::new(host.stdout.take().context("fixture stdout")?).lines();
        timeout(Duration::from_secs(15), async {
            while let Some(line) = output.next_line().await? {
                if line.contains("Rust host listening") {
                    return Ok::<_, anyhow::Error>(());
                }
            }
            anyhow::bail!("Fixture host did not start")
        })
        .await??;
        // Keep draining after readiness; closing the pipe here could race the
        // host's remaining startup lines and cause a platform-specific BrokenPipe.
        tokio::spawn(async move { while matches!(output.next_line().await, Ok(Some(_))) {} });
        Ok(Self { directory, host })
    }
    fn pairing(&self) -> PathBuf {
        self.directory.join("pairing.json")
    }
    async fn close(&mut self) -> Result<()> {
        drop(self.host.stdin.take());
        let status = timeout(Duration::from_secs(10), self.host.wait()).await??;
        ensure!(
            status.success(),
            "Isolated host did not finish clean PTY shutdown"
        );
        let canonical = self.directory.canonicalize()?;
        ensure!(
            canonical.parent() == Some(std::env::temp_dir().canonicalize()?.as_path())
                && canonical
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("nesvo-mcp-")),
            "Refusing cleanup outside fixture"
        );
        std::fs::remove_dir_all(canonical)?;
        Ok(())
    }
}
async fn client(pairing: &Path) -> Result<RunningService<RoleClient, ()>> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command.arg("--pairing").arg(pairing).arg("mcp");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(().serve(TokioChildProcess::new(command)?).await?)
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

#[tokio::test]
#[ignore = "requires cargo build --workspace and an isolated native PTY host"]
async fn sdk_client_uses_native_mcp_receipts_and_shuts_down_without_control() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let mcp = client(&fixture.pairing()).await?;
        let tools = mcp.list_all_tools().await?;
        assert_eq!(tools.len(), 11);
        assert!(tools.iter().all(|tool| tool.output_schema.is_some()));
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
        assert_eq!(receipt["data"]["receipt"], created["data"]["receipt"]);
        assert!(receipt["data"]["cursor"].as_u64().context("cursor")? >= 3);
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
        assert_eq!(legacy.list_all_tools().await?.len(), 11);
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
            11,
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
