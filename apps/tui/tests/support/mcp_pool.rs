use super::*;

async fn cli(pairing: &Path, args: &[&str]) -> Result<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .arg("--pairing")
        .arg(pairing)
        .args(args)
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().await?;
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn validate(envelopes: Vec<Value>) -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .arg(root.join("tests/fixtures/validate-harness-json.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut process = command.spawn()?;
    process
        .stdin
        .take()
        .context("schema input")?
        .write_all(&serde_json::to_vec(&envelopes)?)
        .await?;
    let output = process.wait_with_output().await?;
    ensure!(
        output.status.success(),
        "Real MCP pool envelope validation: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires native binaries and Node; harness fixture without model calls"]
async fn pool_status_shows_the_harness_server_dedicated_and_refuses_scoped_callers() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let pairing = fixture.pairing();
        waits::provider(&fixture, "claude").await?;
        let empty = cli(&pairing, &["mcp", "pool", "status", "--json"]).await?;
        assert_eq!(empty["ok"], true, "{empty}");
        assert_eq!(empty["data"]["type"], "mcpPool");
        assert_eq!(empty["data"]["processes"], json!({"warm":0,"leased":0}));
        assert_eq!(empty["data"]["bounds"]["warmPerKey"], 1);
        let owner = client(&pairing).await?;
        let root = waits::operation(&owner,"nesvo_create_session",json!({"key":"pool-root","spec":{"name":"Pool coordinator","role":"coordinator","program":"claude","harness":true}})).await?;
        let root_id = root["data"]["receipt"]["sessionId"]
            .as_str()
            .context("pool root")?
            .to_owned();
        session_ready(&owner, &root_id).await?;
        let status = cli(&pairing, &["mcp", "pool", "status", "--json"]).await?;
        let sessions = status["data"]["sessions"].as_array().context("sessions")?;
        assert!(
            sessions.iter().any(|attachment| attachment["sessionId"] == root_id.as_str()
                && attachment["server"] == "nesvo"
                && attachment["mode"] == "dedicated"
                && attachment["reason"] == "sessionCredential"),
            "{status}"
        );
        assert_eq!(status["data"]["processes"], json!({"warm":0,"leased":0}));
        let context = PathBuf::from(std::fs::read_to_string(
            fixture
                .directory
                .join("callers")
                .join(format!("{root_id}.txt")),
        )?);
        let scoped = super::inbox::scoped_cli(&context, &["mcp", "pool", "status", "--json"])
            .await
            .err();
        assert!(scoped.is_some_and(|error| error.to_string().contains("forbidden")));
        validate(vec![empty, status]).await?;
        owner.cancel().await?;
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
