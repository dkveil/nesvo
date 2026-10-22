use super::*;
use budgets::owner_cli;
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashSet, time::Instant};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

type Owner = RunningService<RoleClient, ()>;

const SERVER_SOURCE: &str = include_str!("../../../../tests/fixtures/mcp-stdio-server.cjs");
const ISOLATED_VARIABLES: [&str; 14] = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "TEMP",
    "TMP",
    "TMPDIR",
];

fn declaration(name: &str) -> String {
    format!(
        "[[mcp.server]]\nname = \"{name}\"\ncommand = \"node\"\nargs = [\"server.cjs\"]\nenv = [\"PATH\"]\ncwd = \"tools/mcp\"\n\n"
    )
}

async fn git(directory: &Path, args: &[&str]) -> Result<()> {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.hooksPath=",
        ])
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .await
        .context("Owned MCP server Git command")?;
    ensure!(
        output.status.success(),
        "Owned MCP server Git fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn commit(directory: &Path, text: &str) -> Result<()> {
    std::fs::write(directory.join("nesvo.toml"), text)?;
    git(directory, &["add", "--", "nesvo.toml"]).await?;
    git(
        directory,
        &["commit", "--quiet", "-m", "declare MCP servers"],
    )
    .await
}

async fn repository(fixture: &Fixture) -> Result<PathBuf> {
    let directory = fixture.directory.join("mcp-servers");
    std::fs::create_dir_all(directory.join("tools").join("mcp"))?;
    std::fs::write(
        directory.join("tools").join("mcp").join("server.cjs"),
        SERVER_SOURCE,
    )?;
    git(&directory, &["init", "--quiet"]).await?;
    commit(&directory, &declaration("docs")).await?;
    Ok(directory)
}

async fn owner_frames(fixture: &Fixture, fire: &[Value], request: Value) -> Result<Value> {
    let pairing: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
    let address = pairing["url"].as_str().context("Owned host address")?;
    let key: [u8; 32] = hex::decode(pairing["key"].as_str().context("Owned pairing key")?)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Owned key length"))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(nesvo_wire::MAX_FRAME))
        .max_frame_size(Some(nesvo_wire::MAX_FRAME));
    let (mut socket, _) = connect_async_with_config(address, Some(config), true).await?;
    let Message::Text(hello) = socket.next().await.context("Host challenge frame")?? else {
        anyhow::bail!("Expected host challenge text");
    };
    let hello: Value = serde_json::from_str(hello.as_ref())?;
    let challenge = hello["challenge"]
        .as_str()
        .context("Host challenge")?
        .to_owned();
    let nonce = hex::encode(nesvo_wire::random::<32>());
    let mut outgoing = 1;
    socket
        .send(Message::Text(
            nesvo_wire::encode_client(
                json!({"type":"auth","clientNonce":nonce}),
                &key,
                &challenge,
                outgoing,
            )?
            .into(),
        ))
        .await?;
    let Message::Text(answer) = socket.next().await.context("Encrypted host proof")?? else {
        anyhow::bail!("Expected encrypted host proof");
    };
    let connected = nesvo_wire::decode_host(answer.as_ref(), &key, &challenge, 1)?;
    ensure!(
        connected["type"] == "connected" && connected["clientNonce"] == nonce,
        "Host proof and connection identity"
    );
    let request_id = format!("mcp-servers-{}", hex::encode(nesvo_wire::random::<8>()));
    let mut request = request;
    request["requestId"] = json!(request_id);
    for command in fire.iter().chain(std::iter::once(&request)) {
        outgoing += 1;
        socket
            .send(Message::Text(
                nesvo_wire::encode_client(command.clone(), &key, &challenge, outgoing)?.into(),
            ))
            .await?;
    }
    let mut sequence = 1;
    for _ in 0..256 {
        match socket.next().await.context("Owner reply")?? {
            Message::Text(text) => {
                sequence += 1;
                let event = nesvo_wire::decode_host(text.as_ref(), &key, &challenge, sequence)?;
                if event["requestId"] == request_id {
                    let _ = socket.close(None).await;
                    return Ok(event);
                }
            }
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Pong(_) => {}
            _ => anyhow::bail!("Owner connection closed before the reply"),
        }
    }
    anyhow::bail!("Bounded owner reply frame count")
}

async fn listed(fixture: &Fixture, repo: &Path) -> Result<Value> {
    let reply = owner_frames(
        fixture,
        &[],
        json!({"type":"listMcpServers","directory":repo}),
    )
    .await?;
    ensure!(reply["type"] == "mcpServers", "MCP server listing: {reply}");
    Ok(reply)
}

async fn close(fixture: &Fixture, repo: &Path, id: &str) -> Result<()> {
    owner_frames(
        fixture,
        &[json!({"type":"close","sessionId":id})],
        json!({"type":"listMcpServers","directory":repo}),
    )
    .await
    .map(|_| ())
}

async fn launch(owner: &Owner, key: &str, cwd: &Path) -> Result<String> {
    let created = waits::operation(
        owner,
        "nesvo_create_session",
        json!({"key":key,"spec":{"name":key,"program":"claude","role":"coordinator","harness":true,"cwd":cwd}}),
    )
    .await?;
    let id = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("MCP server session")?
        .to_owned();
    session_ready(owner, &id).await?;
    Ok(id)
}

fn provider_config(fixture: &Fixture, id: &str) -> Result<Value> {
    let context = PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?);
    Ok(serde_json::from_slice(&std::fs::read(
        context.with_file_name("mcp.json"),
    )?)?)
}

fn server_names(config: &Value) -> Vec<String> {
    let mut names: Vec<String> = config["mcpServers"]
        .as_object()
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
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
        "Real worktree setup envelope validation: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn pool(fixture: &Fixture) -> Result<Value> {
    Ok(owner_cli(fixture, &["mcp", "pool", "status", "--json"]).await?["data"].clone())
}

async fn warm(fixture: &Fixture, server: &str) -> Result<()> {
    waits::until(async || {
        let status = pool(fixture).await?;
        Ok(status["entries"]
            .as_array()
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry["server"] == server && entry["state"] == "warm")
            })
            .then_some(()))
    })
    .await
}

async fn idle_pool(fixture: &Fixture) -> Result<()> {
    waits::until(async || {
        let status = pool(fixture).await?;
        Ok((status["processes"] == json!({"warm":0,"leased":0})).then_some(()))
    })
    .await
}

fn attachment<'a>(status: &'a Value, session: &str, server: &str) -> Option<&'a Value> {
    status["sessions"]
        .as_array()?
        .iter()
        .find(|attachment| attachment["sessionId"] == session && attachment["server"] == server)
}

async fn journal(owner: &Owner) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut cursor = 0;
    loop {
        let page = data(call(owner, "nesvo_read_events", json!({"after":cursor})).await?)?;
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Journal events")?
                .iter()
                .cloned(),
        );
        if page["data"]["more"] != true {
            return Ok(events);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Journal cursor")?;
    }
}

async fn journaled(owner: &Owner, kind: &str, wanted: impl Fn(&Value) -> bool) -> Result<Value> {
    waits::until(async || {
        Ok(journal(owner)
            .await?
            .into_iter()
            .find(|event| event["kind"] == kind && wanted(event)))
    })
    .await
}

struct Exercise {
    environment: Value,
    initialize_ms: f64,
    tools: Vec<String>,
}

async fn exercise(entry: &Value) -> Result<Exercise> {
    let mut command = Command::new(entry["command"].as_str().context("Bridge command")?);
    for arg in entry["args"].as_array().context("Bridge arguments")? {
        command.arg(arg.as_str().context("Bridge argument")?);
    }
    command
        .env("NESVO_AGENT_CONTEXT", "provider-private-context")
        .env("POCKET_PROVIDER_SECRET", "provider-private-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let started = Instant::now();
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("Bridge input")?;
    let mut output = BufReader::new(child.stdout.take().context("Bridge output")?).lines();
    let mut exchange = async |id: u64, method: &str, params: Value| -> Result<Value> {
        input
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                )
                .as_bytes(),
            )
            .await?;
        loop {
            let line = output
                .next_line()
                .await?
                .context("Bridge closed before replying")?;
            let reply: Value = serde_json::from_str(&line)?;
            if reply["id"] == id {
                return Ok(reply["result"].clone());
            }
        }
    };
    let initialized = exchange(
        1,
        "initialize",
        json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"provider-fixture","version":"1"}}),
    )
    .await?;
    let initialize_ms = started.elapsed().as_secs_f64() * 1000.0;
    ensure!(
        initialized["serverInfo"]["name"] == "nesvo-fixture-mcp",
        "Fixture initialize reply: {initialized}"
    );
    let tools = exchange(2, "tools/list", json!({})).await?;
    let environment = exchange(
        3,
        "tools/call",
        json!({"name":"environment","arguments":{}}),
    )
    .await?;
    drop(input);
    let status = child.wait().await?;
    ensure!(status.success(), "Bridge exit {status}");
    Ok(Exercise {
        environment: serde_json::from_str(
            environment["content"][0]["text"]
                .as_str()
                .context("Fixture environment")?,
        )?,
        initialize_ms,
        tools: tools["tools"]
            .as_array()
            .context("Fixture tools")?
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect(),
    })
}

fn assert_isolated(run: &Exercise, repo: &Path) -> Result<()> {
    assert_eq!(run.tools, ["echo", "environment"]);
    let cwd = PathBuf::from(run.environment["cwd"].as_str().context("Server cwd")?);
    assert_eq!(
        cwd.canonicalize()?,
        repo.join("tools").join("mcp").canonicalize()?
    );
    for variable in run.environment["variables"]
        .as_array()
        .context("Server variables")?
    {
        let name = variable
            .as_str()
            .context("Variable name")?
            .to_ascii_uppercase();
        assert!(
            ISOLATED_VARIABLES.contains(&name.as_str()),
            "{name} leaked into the server environment"
        );
    }
    Ok(())
}

async fn bridge_exit(entry: &Value, lease: &Path) -> Result<Option<i32>> {
    let mut command = Command::new(entry["command"].as_str().context("Bridge command")?);
    command
        .arg(entry["args"][0].as_str().context("Bridge flag")?)
        .arg(lease)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(command.status().await?.code())
}

fn lease(entry: &Value) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        entry["args"][1].as_str().context("Lease file")?,
    )?)?)
}

#[tokio::test]
#[ignore = "requires native binaries, Git and Node; external stdio MCP servers through the pool without model calls"]
async fn approved_external_servers_reach_the_provider_through_the_pool() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        waits::provider(&fixture, "claude").await?;
        let owner = client(&fixture.pairing()).await?;
        let repo = repository(&fixture).await?;
        let directory = repo.to_str().context("Fixture repository path")?.to_owned();
        let declared = listed(&fixture, &repo).await?;
        assert_eq!(declared["configured"], true, "{declared}");
        assert_eq!(declared["approved"], false);
        assert_eq!(declared["servers"][0]["name"], "docs");
        assert_eq!(declared["servers"][0]["state"], "unapproved");
        assert_eq!(declared["providers"]["claude"], "launchConfig");
        let repository_key = declared["repository"].as_str().context("Repository key")?.to_owned();

        let unapproved = launch(&owner, "servers-unapproved", &repo).await?;
        assert_eq!(server_names(&provider_config(&fixture, &unapproved)?), ["nesvo"]);
        assert!(attachment(&pool(&fixture).await?, &unapproved, "docs").is_none());
        close(&fixture, &repo, &unapproved).await?;

        let described = owner_cli(&fixture, &["worktree", "describe", "--directory", &directory, "--json"]).await?;
        let digest = described["data"]["digest"].as_str().context("Setup digest")?.to_owned();
        assert_eq!(described["data"]["config"]["mcpServers"][0]["name"], "docs");
        validate(vec![described.clone()]).await?;
        owner_cli(&fixture, &["worktree", "approve-setup", "--directory", &directory, "--digest", &digest, "--json"]).await?;
        assert_eq!(listed(&fixture, &repo).await?["servers"][0]["state"], "approved");

        let cold = launch(&owner, "servers-cold", &repo).await?;
        let config = provider_config(&fixture, &cold)?;
        assert_eq!(server_names(&config), ["docs", "nesvo"]);
        let entry = config["mcpServers"]["docs"].clone();
        let bridge = PathBuf::from(entry["command"].as_str().context("Bridge path")?);
        assert_eq!(bridge.canonicalize()?, Fixture::host_binary().canonicalize()?);
        assert_eq!(entry["args"][0], "--mcp-bridge");
        assert_eq!(lease(&entry)?["lease"], Value::Null);
        let status = pool(&fixture).await?;
        let attached = attachment(&status, &cold, "docs").context("Cold attachment")?;
        assert_eq!(attached["mode"], "cold");
        assert_eq!(attached["reason"], "notPrepared");
        assert_eq!(attached["repository"], repository_key.as_str());
        let first = exercise(&entry).await?;
        assert_isolated(&first, &repo)?;
        let mut dedicated = vec![first.initialize_ms];
        let mut pooled = Vec::new();
        let mut pids = HashSet::from([first.environment["pid"].to_string()]);
        for index in 0..3 {
            warm(&fixture, "docs").await?;
            let id = launch(&owner, &format!("servers-pooled-{index}"), &repo).await?;
            let entry = provider_config(&fixture, &id)?["mcpServers"]["docs"].clone();
            assert_eq!(lease(&entry)?["lease"]["token"].as_str().map(str::len), Some(64));
            let leased = exercise(&entry).await?;
            assert_isolated(&leased, &repo)?;
            assert!(pids.insert(leased.environment["pid"].to_string()), "a pooled process served twice");
            pooled.push(leased.initialize_ms);
            assert_eq!(attachment(&pool(&fixture).await?, &id, "docs").context("Pooled attachment")?["mode"], "pooled");
            journaled(&owner, "mcp.server_attached", |event| event["sessionId"] == id.as_str() && event["payload"]["mode"] == "pooled").await?;
            if index < 2 {
                let fallback = exercise(&entry).await?;
                assert_isolated(&fallback, &repo)?;
                dedicated.push(fallback.initialize_ms);
            }
            close(&fixture, &repo, &id).await?;
        }
        eprintln!("MCP_SERVERS_TIMING {}", json!({"pooledMs":pooled,"dedicatedMs":dedicated}));

        journaled(&owner, "mcp.server_attached", |event| {
            event["sessionId"] == cold.as_str()
                && event["payload"]["mode"] == "cold"
                && event["payload"]["repository"] == repository_key.as_str()
                && event["payload"]["digest"] == digest.as_str()
        })
        .await?;
        close(&fixture, &repo, &cold).await?;
        journaled(&owner, "mcp.server_released", |event| {
            event["sessionId"] == cold.as_str() && event["payload"]["reason"] == "sessionClosed"
        })
        .await?;

        warm(&fixture, "docs").await?;
        let stale = launch(&owner, "servers-stale", &repo).await?;
        let stale_entry = provider_config(&fixture, &stale)?["mcpServers"]["docs"].clone();
        let stale_file = PathBuf::from(stale_entry["args"][1].as_str().context("Stale lease file")?);
        let stale_copy = fixture.directory.join("stale-lease.json");
        std::fs::copy(&stale_file, &stale_copy)?;
        warm(&fixture, "docs").await?;
        owner_cli(&fixture, &["worktree", "revoke-setup", "--directory", &directory, "--digest", &digest, "--json"]).await?;
        assert!(!stale_file.exists(), "revocation removes the session's lease file");
        assert_eq!(bridge_exit(&stale_entry, &stale_copy).await?, Some(3));
        journaled(&owner, "mcp.server_reaped", |event| {
            event["payload"]["server"] == "docs" && event["payload"]["reason"] == "revoked"
        })
        .await?;
        close(&fixture, &repo, &stale).await?;
        idle_pool(&fixture).await?;
        let revoked = launch(&owner, "servers-revoked", &repo).await?;
        assert_eq!(server_names(&provider_config(&fixture, &revoked)?), ["nesvo"]);
        close(&fixture, &repo, &revoked).await?;

        let five: String = ["docs", "s1", "s2", "s3", "s4"].map(declaration).concat();
        commit(&repo, &five).await?;
        let described = owner_cli(&fixture, &["worktree", "describe", "--directory", &directory, "--json"]).await?;
        let bounded_digest = described["data"]["digest"].as_str().context("Bounded digest")?.to_owned();
        owner_cli(&fixture, &["worktree", "approve-setup", "--directory", &directory, "--digest", &bounded_digest, "--json"]).await?;
        let bounded = launch(&owner, "servers-bounded", &repo).await?;
        assert_eq!(server_names(&provider_config(&fixture, &bounded)?), ["docs", "nesvo", "s1", "s2", "s3", "s4"]);
        let status = pool(&fixture).await?;
        for server in ["docs", "s1", "s2", "s3"] {
            assert_eq!(attachment(&status, &bounded, server).context("Bounded attachment")?["reason"], "notPrepared");
        }
        assert_eq!(attachment(&status, &bounded, "s4").context("Refused attachment")?["reason"], "boundReached");
        close(&fixture, &repo, &bounded).await?;

        commit(&repo, &format!("{five}{}", declaration("s5"))).await?;
        let changed = listed(&fixture, &repo).await?;
        assert_eq!(changed["approved"], false);
        assert_ne!(changed["digest"], bounded_digest.as_str());
        let unchanged = launch(&owner, "servers-changed", &repo).await?;
        assert_eq!(server_names(&provider_config(&fixture, &unchanged)?), ["nesvo"]);
        close(&fixture, &repo, &unchanged).await?;
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
