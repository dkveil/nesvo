use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use nesvo_host::wire;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    time::timeout,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

const DATABASE: &str = "metadata.sqlite3";
const READINESS: Duration = Duration::from_secs(60);
const REPLY: Duration = Duration::from_secs(20);

struct Directory(PathBuf);

impl Directory {
    fn create(label: &str) -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "nesvo-drill-{label}-{}",
            hex::encode(wire::random::<8>())
        ));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Host(Child);

impl Host {
    async fn start(directory: &Path) -> Result<Self> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo-host"));
        command
            .env("CODEX_HOME", directory.join("codex-home"))
            .env("CLAUDE_CONFIG_DIR", directory.join("claude-config"))
            .env_remove("POCKET_HOST_PORT")
            .env_remove("POCKET_HOST_ADDRESS")
            .env_remove("POCKET_ALLOWED_ORIGINS")
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
        let mut child = command.spawn().context("Start the drill host")?;
        let mut lines = BufReader::new(child.stdout.take().context("Host stdout")?).lines();
        timeout(READINESS, async {
            while let Some(line) = lines.next_line().await? {
                if line.contains("Rust host listening") {
                    return Ok(());
                }
            }
            bail!("Drill host exited before it listened")
        })
        .await
        .context("Drill host readiness deadline")??;
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Ok(Self(child))
    }

    async fn stop(mut self) -> Result<()> {
        drop(self.0.stdin.take());
        let status = timeout(Duration::from_secs(15), self.0.wait())
            .await
            .context("Drill host shutdown deadline")??;
        ensure!(status.success(), "Drill host did not shut down cleanly");
        Ok(())
    }

    async fn crash(mut self) -> Result<()> {
        self.0.start_kill()?;
        timeout(Duration::from_secs(15), self.0.wait())
            .await
            .context("Drill host kill deadline")??;
        Ok(())
    }
}

struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    key: [u8; 32],
    challenge: String,
    sent: u64,
    received: u64,
}

impl Client {
    async fn connect(directory: &Path) -> Result<Self> {
        let pairing: Value =
            serde_json::from_slice(&std::fs::read(directory.join("pairing.json"))?)?;
        let key: [u8; 32] = hex::decode(pairing["key"].as_str().context("Pairing key")?)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Pairing key length"))?;
        let url = pairing["url"].as_str().context("Pairing URL")?;
        let (mut socket, _) = timeout(REPLY, connect_async(url)).await??;
        let hello: Value = match timeout(REPLY, socket.next()).await? {
            Some(Ok(Message::Text(text))) => serde_json::from_str(&text)?,
            _ => bail!("Host sent no challenge"),
        };
        ensure!(
            hello["type"] == "challenge",
            "Unexpected first frame {hello}"
        );
        let challenge = hello["challenge"].as_str().context("Challenge")?.to_owned();
        let nonce = hex::encode(wire::random::<32>());
        let auth = wire::encode_client(
            json!({"type":"auth","clientNonce":nonce}),
            &key,
            &challenge,
            1,
        )?;
        socket.send(Message::Text(auth.into())).await?;
        let connected = match timeout(REPLY, socket.next()).await? {
            Some(Ok(Message::Text(text))) => wire::decode_host(&text, &key, &challenge, 1)?,
            _ => bail!("Host sent no authentication answer"),
        };
        ensure!(
            connected["type"] == "connected" && connected["clientNonce"] == nonce.as_str(),
            "Host did not accept the paired key: {connected}"
        );
        Ok(Self {
            socket,
            key,
            challenge,
            sent: 1,
            received: 1,
        })
    }

    async fn request(&mut self, mut command: Value) -> Result<Value> {
        self.sent += 1;
        let id = format!("drill-{}", self.sent);
        command["requestId"] = id.clone().into();
        let frame = wire::encode_client(command, &self.key, &self.challenge, self.sent)?;
        self.socket.send(Message::Text(frame.into())).await?;
        timeout(REPLY, async {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let payload = wire::decode_host(
                            &text,
                            &self.key,
                            &self.challenge,
                            self.received + 1,
                        )?;
                        self.received += 1;
                        if payload["requestId"] == id.as_str() {
                            return Ok(payload);
                        }
                    }
                    Some(Ok(Message::Ping(data))) => self.socket.send(Message::Pong(data)).await?,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error.into()),
                    None => bail!("Host closed the drill connection"),
                }
            }
        })
        .await
        .context("Drill reply deadline")?
    }

    async fn workflow(&mut self, request: Value) -> Result<Value> {
        let reply = self
            .request(json!({"type":"workflow","request":request}))
            .await?;
        ensure!(
            reply["type"] == "workflow",
            "Workflow request failed: {reply}"
        );
        Ok(reply)
    }
}

fn migrations(connection: &Connection) -> Result<Vec<(i64, String)>> {
    let mut statement =
        connection.prepare("SELECT version,name FROM schema_migrations ORDER BY version")?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn released_schema_version() -> Result<i64> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut count = 0i64;
    for entry in std::fs::read_dir(directory)? {
        if entry?.path().extension().is_some_and(|ext| ext == "sql") {
            count += 1;
        }
    }
    Ok(count)
}

fn back_up(source: &Path, destination: &Path) -> Result<Vec<(i64, String)>> {
    let database = source.join(DATABASE);
    let connection = Connection::open(&database)?;
    let busy: i64 =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    ensure!(
        busy == 0,
        "Checkpoint was blocked; is a host still running?"
    );
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    ensure!(integrity == "ok", "Source journal integrity: {integrity}");
    let versions = migrations(&connection)?;
    let wal = source.join(format!("{DATABASE}-wal"));
    ensure!(
        std::fs::metadata(&wal).map_or(true, |metadata| metadata.len() == 0),
        "Write-ahead log still holds frames after the checkpoint"
    );
    std::fs::copy(&database, destination.join(DATABASE))?;
    drop(connection);
    for name in ["pairing.json", "worktrees.json"] {
        if source.join(name).exists() {
            std::fs::copy(source.join(name), destination.join(name))?;
        }
    }
    Ok(versions)
}

fn restore(backup: &Path, target: &Path) -> Result<()> {
    for entry in std::fs::read_dir(backup)? {
        let entry = entry?;
        std::fs::copy(entry.path(), target.join(entry.file_name()))?;
    }
    Ok(())
}

struct Journal {
    run_create: Value,
    run: Value,
    job: Value,
    job_receipt: Value,
    operation: Value,
}

fn run_create() -> Value {
    json!({"action":"create","key":"drill-run","spec":{"title":"Backup drill","goal":"Survive a restore","coordinatorSessionId":null}})
}

async fn read_journal(client: &mut Client, run_id: &str, job_id: &str) -> Result<Journal> {
    let run_create = client
        .workflow(json!({"action":"mutation","key":"drill-run"}))
        .await?;
    let run = client
        .workflow(json!({"action":"get","runId":run_id}))
        .await?;
    let job = client
        .workflow(json!({"action":"jobs","request":{"action":"get","jobId":job_id}}))
        .await?;
    let job_receipt = client
        .workflow(json!({"action":"jobs","request":{"action":"mutation","key":"drill-job"}}))
        .await?;
    let operation = client
        .request(json!({"type":"getOperation","key":"drill-operation"}))
        .await?;
    ensure!(
        operation["type"] == "operation",
        "Operation lookup failed: {operation}"
    );
    Ok(Journal {
        run_create: strip(run_create),
        run: run["run"].clone(),
        job: job["job"].clone(),
        job_receipt: strip(job_receipt),
        operation: operation["receipt"].clone(),
    })
}

fn strip(mut reply: Value) -> Value {
    if let Some(object) = reply.as_object_mut() {
        object.remove("requestId");
        object.remove("cursor");
    }
    reply
}

async fn write_journal(client: &mut Client) -> Result<(String, String)> {
    let run = client.workflow(run_create()).await?;
    let job = client
        .workflow(json!({"action":"jobs","request":{"action":"create","key":"drill-job","spec":{"title":"Backup drill job","instruction":"Report the drill","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"external"}}}}))
        .await?;
    let missing = std::env::temp_dir().join(format!(
        "nesvo-drill-missing-{}",
        hex::encode(wire::random::<8>())
    ));
    let operation = client
        .request(json!({"type":"createOperation","key":"drill-operation","spec":{"name":"Drill","cwd":missing}}))
        .await?;
    ensure!(
        operation["receipt"]["phase"] == "failed"
            && operation["receipt"]["result"]["effectStarted"] == false,
        "Drill operation must settle without an effect: {operation}"
    );
    Ok((
        run["run"]["id"].as_str().context("Run ID")?.to_owned(),
        job["job"]["id"].as_str().context("Job ID")?.to_owned(),
    ))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "native drill: runs the host binary against temporary data directories"]
async fn journal_backup_restores_receipts_jobs_and_schema() -> Result<()> {
    let source = Directory::create("source")?;
    let backup = Directory::create("backup")?;
    let restored = Directory::create("restored")?;

    let host = Host::start(&source.0).await?;
    let mut client = Client::connect(&source.0).await?;
    let (run_id, job_id) = write_journal(&mut client).await?;
    let before = read_journal(&mut client, &run_id, &job_id).await?;
    assert_eq!(before.run_create["run"]["id"], run_id.as_str());
    assert_eq!(before.run["id"], run_id.as_str());
    assert_eq!(before.job["id"], job_id.as_str());
    assert_eq!(before.job_receipt["job"]["id"], job_id.as_str());
    assert_eq!(before.operation["phase"], "failed");
    drop(client);
    host.crash().await?;
    let wal = std::fs::metadata(source.0.join(format!("{DATABASE}-wal")))?.len();
    ensure!(
        wal > 0,
        "The unclean stop left no write-ahead log to fold in"
    );

    let versions = back_up(&source.0, &backup.0)?;
    drop(source);
    assert_eq!(
        versions.last().map(|(v, _)| *v),
        Some(released_schema_version()?)
    );
    restore(&backup.0, &restored.0)?;

    let host = Host::start(&restored.0).await?;
    let mut client = Client::connect(&restored.0).await?;
    let after = read_journal(&mut client, &run_id, &job_id).await?;
    assert_eq!(after.run_create, before.run_create);
    assert_eq!(after.job_receipt, before.job_receipt);
    assert_eq!(after.job, before.job);
    assert_eq!(after.operation, before.operation);
    for field in ["id", "title", "goal", "revision", "state", "createdAt"] {
        assert_eq!(after.run[field], before.run[field], "run.{field}");
    }
    let replay = client.workflow(run_create()).await?;
    assert_eq!(replay["run"]["id"], run_id.as_str());
    drop(client);
    host.stop().await?;

    let connection = Connection::open(restored.0.join(DATABASE))?;
    assert_eq!(migrations(&connection)?, versions);
    let runs: i64 =
        connection.query_row("SELECT COUNT(*) FROM workflow_runs", [], |row| row.get(0))?;
    assert_eq!(runs, 1);
    Ok(())
}
