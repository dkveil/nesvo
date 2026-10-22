use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

type Owner = RunningService<RoleClient, ()>;

async fn provider_ready(fixture: &Fixture) -> Result<()> {
    waits::provider(fixture, "claude")
        .await
        .context("Controlled Claude launcher readiness")?;
    Ok(())
}

fn launch_settings(fixture: &Fixture, id: &str) -> Result<Value> {
    let argv: Vec<String> = serde_json::from_slice(&std::fs::read(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.launch-argv.json")),
    )?)?;
    ensure!(
        argv.iter().filter(|arg| *arg == "--settings").count() == 1,
        "One actual launch-local settings argument"
    );
    let offset = argv
        .iter()
        .position(|arg| arg == "--settings")
        .context("Actual launch settings")?;
    Ok(serde_json::from_str(
        argv.get(offset + 1).context("Settings JSON argument")?,
    )?)
}

async fn hook(settings: &Value, event: &str, payload: Value, cwd: &Path) -> Result<()> {
    let entry = &settings["hooks"][event][0]["hooks"][0];
    let executable = entry["command"]
        .as_str()
        .context("Actual native context helper")?;
    let args: Vec<String> = entry["args"]
        .as_array()
        .context("Actual helper arguments")?
        .iter()
        .map(|arg| {
            arg.as_str()
                .map(str::to_owned)
                .context("Literal native helper argument")
        })
        .collect::<Result<_>>()?;
    ensure!(
        args.first()
            .is_some_and(|arg| arg == "--agent-context-hook"),
        "Use the production context receiver, not a test substitute"
    );
    ensure!(
        Path::new(executable).is_absolute(),
        "Host helper must be absolute"
    );
    let bytes = serde_json::to_vec(&payload)?;
    ensure!(
        bytes.len() <= 16 * 1024,
        "Controlled hook fixture is bounded"
    );
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("Native hook input")?;
    input.write_all(&bytes).await?;
    input.flush().await?;
    drop(input);
    ensure!(
        child.wait().await?.success(),
        "Production context helper must succeed"
    );
    Ok(())
}

async fn unborn_repository_with_untracked_marker(
    fixture: &Fixture,
    name: &str,
    marker: &str,
) -> Result<PathBuf> {
    let directory = fixture.directory.join(name);
    std::fs::create_dir(&directory)?;
    let mut command = Command::new("git");
    command
        .args(["init", "--quiet"])
        .arg(&directory)
        .current_dir(&fixture.directory)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let status = command.spawn()?.wait().await?;
    ensure!(
        status.success(),
        "Initialize only this owned temporary repository"
    );
    std::fs::write(
        directory.join("review marker łódź.txt"),
        format!("{marker}\n"),
    )?;
    Ok(directory.canonicalize()?)
}

async fn automatic(owner: &Owner, id: &str) -> Result<Value> {
    let response = data(
        call(
            owner,
            "nesvo_read_diff",
            json!({
                "sessionId": id, "scope": "untracked",
            }),
        )
        .await?,
    )?;
    let review = &response["data"]["review"];
    ensure!(review.is_object(), "Automatic owner diff response");
    Ok(review.clone())
}

fn assert_review(review: &Value, directory: &Path, source: &str, marker: &str) -> Result<()> {
    let actual = PathBuf::from(
        review["directory"]
            .as_str()
            .context("Host review repository")?,
    );
    assert_eq!(actual.canonicalize()?, directory.canonicalize()?);
    assert_eq!(review["source"], source);
    assert_eq!(review["scope"], "untracked");
    let files = review["files"]
        .as_array()
        .context("Host review file list")?;
    assert!(
        files.iter().any(|file| {
            file["path"] == "review marker łódź.txt"
                && file["patch"]
                    .as_str()
                    .is_some_and(|patch| patch.contains(marker))
        }),
        "The host must inspect the selected repository, not only echo its label"
    );
    Ok(())
}

async fn identity(owner: &Owner, id: &str, provider: &str, generation: u64) -> Result<Value> {
    waits::until(async || {
        let response = data(call(owner, "nesvo_explain_session", json!({"sessionId": id})).await?)?;
        let view = response["data"]["report"]["sessions"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["sessionId"] == id))
            .context("Current owned session diagnostics")?
            .clone();
        if view["conversationIdentity"]["providerSessionId"] == provider
            && view["conversationIdentity"]["generation"] == generation
        {
            return Ok(Some(view));
        }
        ensure!(
            !waits::exited(owner, id).await?,
            "Session {id} exited before generation {generation}: {view}"
        );
        Ok(None)
    })
    .await
    .context("Public current generation projection")
}

async fn pinned_over_owner_frames_because_mcp_omits_pin(
    fixture: &Fixture,
    id: &str,
    directory: &Path,
) -> Result<Value> {
    async {
        let pairing: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
        ensure!(
            pairing["version"] == 1 && pairing["scopeId"].is_null(),
            "Owned pairing format"
        );
        let address = pairing["url"].as_str().context("Owned host address")?;
        let parsed = url::Url::parse(address)?;
        ensure!(
            matches!(parsed.scheme(), "ws" | "wss")
                && parsed.host_str().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.path() == "/"
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "Owned host address shape"
        );
        let encoded_key = pairing["key"].as_str().context("Owned pairing key")?;
        ensure!(
            encoded_key.len() == 64 && encoded_key.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Owned key encoding"
        );
        let key: [u8; 32] = hex::decode(encoded_key)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Owned key length"))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(nesvo_wire::MAX_FRAME))
            .max_frame_size(Some(nesvo_wire::MAX_FRAME));
        let (mut socket, _) = connect_async_with_config(address, Some(config), true).await?;
        let hello = socket.next().await.context("Host challenge frame")??;
        let Message::Text(hello) = hello else {
            anyhow::bail!("Expected host challenge text");
        };
        let hello: Value = serde_json::from_str(hello.as_ref())?;
        let challenge = hello["challenge"].as_str().context("Host challenge")?;
        ensure!(
            hello["type"] == "challenge"
                && hello["version"] == 1
                && challenge.len() == 64
                && challenge.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Host challenge validation"
        );
        let nonce = hex::encode(nesvo_wire::random::<32>());
        socket
            .send(Message::Text(
                nesvo_wire::encode_client(
                    json!({"type":"auth","clientNonce":nonce}),
                    &key,
                    challenge,
                    1,
                )?
                .into(),
            ))
            .await?;
        let answer = socket.next().await.context("Encrypted host proof")??;
        let Message::Text(answer) = answer else {
            anyhow::bail!("Expected encrypted host proof");
        };
        let connected = nesvo_wire::decode_host(answer.as_ref(), &key, challenge, 1)?;
        ensure!(
            connected["type"] == "connected"
                && connected["clientNonce"] == nonce
                && connected["protocolVersion"] == 2
                && connected["clientId"].as_u64().is_some(),
            "Host proof and connection identity"
        );
        let request_id = format!("scoped-review-{}", hex::encode(nesvo_wire::random::<8>()));
        socket
            .send(Message::Text(
                nesvo_wire::encode_client(
                    json!({"type":"getDiff","sessionId":id,"scope":"untracked",
                "directory":directory,"requestId":request_id}),
                    &key,
                    challenge,
                    2,
                )?
                .into(),
            ))
            .await?;
        let mut sequence = 1;
        for _ in 0..64 {
            let message = socket.next().await.context("Owner diff response")??;
            match message {
                Message::Text(text) => {
                    sequence += 1;
                    let event = nesvo_wire::decode_host(text.as_ref(), &key, challenge, sequence)?;
                    if event["requestId"] == request_id {
                        ensure!(
                            event["type"] == "diff" && event["review"].is_object(),
                            "Owned pinned diff must succeed"
                        );
                        let review = event["review"].clone();
                        let _ = socket.close(None).await;
                        return Ok::<_, anyhow::Error>(review);
                    }
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                Message::Pong(_) => {}
                _ => anyhow::bail!("Owner diff connection closed or sent an unexpected frame"),
            }
        }
        anyhow::bail!("Bounded owner diff response frame count");
    }
    .await
    .context("Owned pinned GetDiff")
}

#[tokio::test]
#[ignore = "native host/client, Node and owned Git repos; production scoped context helper; no models"]
async fn scoped_context_helpers_follow_current_root_without_losing_external_edits_or_pins()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        provider_ready(&fixture).await?;
        let launch = unborn_repository_with_untracked_marker(&fixture, "launch repo łódź", "F05_LAUNCH_MARKER").await?;
        let external = unborn_repository_with_untracked_marker(&fixture, "external edited repo 日本語", "F05_EXTERNAL_MARKER").await?;
        let cwd = unborn_repository_with_untracked_marker(&fixture, "changed cwd repo łódź", "F05_CWD_MARKER").await?;
        let pin = unborn_repository_with_untracked_marker(&fixture, "explicit pin repo", "F05_PIN_MARKER").await?;
        let owner = client(&fixture.pairing()).await?;
        let created = waits::operation(&owner, "nesvo_create_session", json!({
            "key":"f05-scoped-review-once",
            "spec":{"name":"Scoped review context","program":"claude","role":"coordinator",
                "harness":true,"cwd":launch},
        })).await?;
        let id = created["data"]["receipt"]["sessionId"].as_str().context("Owned session ID")?;
        session_ready(&owner, id).await?;
        let settings = launch_settings(&fixture, id)?;
        let provider_a = format!("fixture-{id}");
        identity(&owner, id, &provider_a, 1).await?;
        assert_review(&automatic(&owner, id).await?, &launch, "Auto: launch folder", "F05_LAUNCH_MARKER")?;

        for tool in ["Edit", "Write"] {
            hook(&settings, "PostToolUse", json!({
                "hook_event_name":"PostToolUse","session_id":provider_a,"agent_id":"",
                "tool_name":tool,"tool_input":{"file_path":external.join("review marker łódź.txt"),
                    "content":"PRIVATE_CONTEXT_CONTENT_NOT_STORED"},
            }), &launch).await?;
            assert_review(&automatic(&owner, id).await?, &external, "Auto: edited file", "F05_EXTERNAL_MARKER")?;
        }
        hook(&settings, "CwdChanged", json!({
            "hook_event_name":"CwdChanged","session_id":provider_a,"agent_id":"","new_cwd":cwd,
        }), &launch).await?;
        assert_review(&automatic(&owner, id).await?, &cwd, "Auto: agent directory", "F05_CWD_MARKER")?;
        assert_review(&pinned_over_owner_frames_because_mcp_omits_pin(&fixture, id, &pin).await?, &pin, "Pinned", "F05_PIN_MARKER")?;
        assert_review(&automatic(&owner, id).await?, &cwd, "Auto: agent directory", "F05_CWD_MARKER")?;

        for rejected in [
            json!({"hook_event_name":"CwdChanged","session_id":provider_a,
                "agent_id":"child-context","new_cwd":external}),
            json!({"hook_event_name":"PostToolUse","session_id":provider_a,
                "agent_id":"child-context","tool_name":"Write",
                "tool_input":{"file_path":external.join("review marker łódź.txt")}}),
            json!({"hook_event_name":"CwdChanged","session_id":"foreign-context-root",
                "agent_id":"","new_cwd":external}),
            json!({"hook_event_name":"CwdChanged","agent_id":"","new_cwd":external}),
        ] {
            let event = rejected["hook_event_name"].as_str().context("Rejected hook event")?;
            hook(&settings, event, rejected.clone(), &launch).await?;
            assert_review(&automatic(&owner, id).await?, &cwd, "Auto: agent directory", "F05_CWD_MARKER")?;
        }

        let provider_b = "replacement-context-root";
        hook(&settings, "SessionStart", json!({
            "hook_event_name":"SessionStart","session_id":provider_b,"agent_id":"","source":"clear",
        }), &launch).await?;
        identity(&owner, id, provider_b, 2).await?;
        assert_review(&automatic(&owner, id).await?, &launch, "Auto: launch folder", "F05_LAUNCH_MARKER")?;
        assert_review(&pinned_over_owner_frames_because_mcp_omits_pin(&fixture, id, &pin).await?, &pin, "Pinned", "F05_PIN_MARKER")?;

        for stale in [
            json!({"hook_event_name":"CwdChanged","session_id":provider_a,
                "agent_id":"","new_cwd":external}),
            json!({"hook_event_name":"PostToolUse","session_id":provider_a,
                "agent_id":"","tool_name":"Edit",
                "tool_input":{"file_path":external.join("review marker łódź.txt")}}),
        ] {
            let event = stale["hook_event_name"].as_str().context("Old provider hook event")?;
            hook(&settings, event, stale.clone(), &launch).await?;
            assert_review(&automatic(&owner, id).await?, &launch, "Auto: launch folder", "F05_LAUNCH_MARKER")?;
        }
        hook(&settings, "CwdChanged", json!({
            "hook_event_name":"CwdChanged","session_id":provider_b,"agent_id":"","new_cwd":cwd,
        }), &launch).await?;
        assert_review(&automatic(&owner, id).await?, &cwd, "Auto: agent directory", "F05_CWD_MARKER")?;
        hook(&settings, "PostToolUse", json!({
            "hook_event_name":"PostToolUse","session_id":provider_b,"agent_id":"",
            "tool_name":"Write","tool_input":{"file_path":external.join("review marker łódź.txt")},
        }), &launch).await?;
        assert_review(&automatic(&owner, id).await?, &external, "Auto: edited file", "F05_EXTERNAL_MARKER")?;

        hook(&settings, "SessionStart", json!({
            "hook_event_name":"SessionStart","session_id":provider_a,"agent_id":"","source":"resume",
        }), &launch).await?;
        identity(&owner, id, &provider_a, 3).await?;
        assert_review(&automatic(&owner, id).await?, &launch, "Auto: launch folder", "F05_LAUNCH_MARKER")?;
        hook(&settings, "CwdChanged", json!({
            "hook_event_name":"CwdChanged","session_id":provider_b,"agent_id":"","new_cwd":external,
        }), &launch).await?;
        assert_review(&automatic(&owner, id).await?, &launch, "Auto: launch folder", "F05_LAUNCH_MARKER")?;
        hook(&settings, "PostToolUse", json!({
            "hook_event_name":"PostToolUse","session_id":provider_a,"agent_id":"",
            "tool_name":"Write","tool_input":{"file_path":external.join("review marker łódź.txt")},
        }), &launch).await?;
        assert_review(&automatic(&owner, id).await?, &external, "Auto: edited file", "F05_EXTERNAL_MARKER")?;
        assert_review(&pinned_over_owner_frames_because_mcp_omits_pin(&fixture, id, &pin).await?, &pin, "Pinned", "F05_PIN_MARKER")?;

        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
