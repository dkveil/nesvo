use super::*;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

mod process_fixture {
    include!("../../../crates/nesvo-process-fixture/src/locate.rs");
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn journal() -> (Scratch, event_log::Service) {
    let path = std::env::temp_dir().join(format!(
        "nesvo-mcp-pool-tests-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    let log = event_log::Service::open(path.join("events.sqlite3"))
        .await
        .unwrap();
    (Scratch(path), log)
}

fn pool(bounds: Bounds, log: &event_log::Service) -> Arc<Pool> {
    let pool = Pool::new(bounds);
    let _ = pool.journal.set(log.clone());
    pool
}

fn bounds() -> Bounds {
    Bounds {
        connect: Duration::from_secs(10),
        ..BOUNDS
    }
}

fn session(mark: char) -> String {
    mark.to_string().repeat(32)
}

fn spec(server: &str, args: &[&str]) -> Spec {
    Spec {
        program: Program::Claude,
        server: server.into(),
        command: process_fixture::executable().to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        env: BTreeMap::from([("MODE".to_owned(), "fixture".to_owned())]),
        root: std::env::temp_dir(),
    }
}

fn lines() -> Spec {
    spec("echo", &["lines", "3e20"])
}

trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

#[cfg(windows)]
async fn connect(address: &str) -> Box<dyn Duplex> {
    Box::new(
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(address)
            .unwrap(),
    )
}

#[cfg(unix)]
async fn connect(address: &str) -> Box<dyn Duplex> {
    Box::new(tokio::net::UnixStream::connect(address).await.unwrap())
}

struct Bridge {
    read: BufReader<tokio::io::ReadHalf<Box<dyn Duplex>>>,
    write: tokio::io::WriteHalf<Box<dyn Duplex>>,
}

impl Bridge {
    async fn open(lease: &Value, token: &str) -> Self {
        let (read, mut write) =
            tokio::io::split(connect(lease["endpoint"].as_str().unwrap()).await);
        write
            .write_all(format!("{token}\n").as_bytes())
            .await
            .unwrap();
        Self {
            read: BufReader::new(read),
            write,
        }
    }

    async fn attach(lease: &Value) -> Self {
        Self::open(lease, lease["token"].as_str().unwrap()).await
    }

    async fn exchange(&mut self, line: &str) -> String {
        self.write
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        let mut reply = String::new();
        tokio::time::timeout(Duration::from_secs(10), self.read.read_line(&mut reply))
            .await
            .unwrap()
            .unwrap();
        reply.trim_end().to_owned()
    }

    async fn closed(&mut self) -> bool {
        let mut rest = Vec::new();
        matches!(
            tokio::time::timeout(Duration::from_secs(10), self.read.read_to_end(&mut rest)).await,
            Ok(Ok(0) | Err(_))
        )
    }
}

async fn until(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the pool reaches the expected state");
}

fn processes(pool: &Pool) -> Value {
    pool.status()["processes"].clone()
}

async fn settle(pool: &Pool, warm: u64, leased: u64) {
    until(|| processes(pool) == json!({"warm":warm,"leased":leased})).await;
}

#[tokio::test]
async fn a_second_session_attaches_to_the_warm_process_prepared_by_the_first() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    let first = pool.attach(&lines(), &session('1'));
    assert_eq!(
        first,
        json!({"mode":"cold","code":"mcp_pool_unavailable","reason":"notPrepared"})
    );
    settle(&pool, 1, 0).await;
    let warm = pool.status()["entries"][0]["entryId"].clone();
    let second = pool.attach(&lines(), &session('2'));
    assert_eq!(second["mode"], "pooled");
    assert_eq!(second["entryId"], warm);
    let mut bridge = Bridge::attach(&second).await;
    assert_eq!(bridge.exchange("ping").await, "> ping");
    settle(&pool, 1, 1).await;
    let status = pool.status();
    let leased = status["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["state"] == "leased")
        .unwrap();
    assert_eq!(leased["sessionId"], session('2'));
    assert_eq!(
        status["sessions"][1],
        json!({"sessionId":session('2'),"server":"echo","program":"claude","mode":"pooled","reason":null,"entryId":warm})
    );
    let events = log.settled(1).await;
    assert_eq!(events[0].kind, "mcp.pool_attached");
    assert_eq!(events[0].session_id.as_deref(), Some(session('2').as_str()));
    assert_eq!(events[0].payload["entryId"], warm);
    assert_eq!(events[0].payload["server"], "echo");
    assert_eq!(events[0].payload["program"], "claude");
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn releasing_a_lease_kills_its_process_and_never_reuses_it() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let lease = pool.attach(&lines(), &session('2'));
    let mut bridge = Bridge::attach(&lease).await;
    let temp = PathBuf::from(bridge.exchange("env TMP").await);
    assert!(temp.is_dir());
    drop(bridge);
    until(|| processes(&pool) == json!({"warm":1,"leased":0})).await;
    until(|| !temp.exists()).await;
    let next = pool.attach(&lines(), &session('3'));
    assert_eq!(next["mode"], "pooled");
    assert_ne!(next["entryId"], lease["entryId"]);
    let events = log.settled(3).await;
    assert_eq!(events[1].kind, "mcp.pool_released");
    assert_eq!(events[1].session_id.as_deref(), Some(session('2').as_str()));
    assert_eq!(
        events[1].payload,
        json!({"entryId":lease["entryId"],"server":"echo","reason":"disconnected"})
    );
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn each_lease_gets_a_fresh_environment_and_temp_root() {
    let (_scratch, log) = journal().await;
    let pool = pool(
        Bounds {
            warm_per_key: 2,
            ..bounds()
        },
        &log,
    );
    let host_only = std::env::vars()
        .map(|(name, _)| name)
        .find(|name| {
            name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !INHERITED
                    .iter()
                    .chain(&["TEMP", "TMP", "TMPDIR", "SystemRoot", "MODE"])
                    .any(|kept| kept.eq_ignore_ascii_case(name))
        })
        .expect("the test process has a host-only variable");
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let first = pool.attach(&lines(), &session('2'));
    settle(&pool, 1, 1).await;
    let second = pool.attach(&lines(), &session('3'));
    assert_eq!(first["mode"], "pooled");
    assert_eq!(second["mode"], "pooled");
    let mut seen = Vec::new();
    for lease in [&first, &second] {
        let mut bridge = Bridge::attach(lease).await;
        let temp = PathBuf::from(bridge.exchange("env TMP").await);
        assert_eq!(temp.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            temp.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(TEMP_PREFIX)
        );
        assert_eq!(bridge.exchange("env TMPDIR").await, temp.to_str().unwrap());
        assert_eq!(bridge.exchange("env MODE").await, "fixture");
        assert_eq!(bridge.exchange(&format!("env {host_only}")).await, "-");
        assert_eq!(bridge.exchange("env NESVO_SESSION_ID").await, "-");
        seen.push(temp);
    }
    assert_ne!(seen[0], seen[1]);
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn idle_warm_processes_are_reaped_past_the_bound() {
    let (_scratch, log) = journal().await;
    let pool = pool(
        Bounds {
            idle: Duration::from_millis(600),
            ..bounds()
        },
        &log,
    );
    pool.attach(&lines(), &session('1'));
    let events = log.settled(1).await;
    assert_eq!(events[0].kind, "mcp.pool_reaped");
    assert_eq!(events[0].session_id, None);
    let entry = events[0].payload["entryId"].as_str().unwrap();
    assert!(entry.len() == 32 && entry.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        events[0].payload,
        json!({"entryId":entry,"server":"echo","digest":lines().digest(),"reason":"idle"})
    );
    assert_eq!(processes(&pool), json!({"warm":0,"leased":0}));
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn a_changed_config_digest_reaps_the_stale_warm_process_before_reuse() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let stale = pool.status()["entries"][0].clone();
    let mut changed = lines();
    changed.env.insert("MODE".into(), "changed".into());
    let reply = pool.attach(&changed, &session('2'));
    assert_eq!(reply["reason"], "notPrepared");
    settle(&pool, 1, 0).await;
    let status = pool.status();
    assert_ne!(status["entries"][0]["digest"], stale["digest"]);
    assert_ne!(status["entries"][0]["entryId"], stale["entryId"]);
    let events = log.settled(1).await;
    assert_eq!(events[0].kind, "mcp.pool_reaped");
    assert_eq!(events[0].payload["entryId"], stale["entryId"]);
    assert_eq!(events[0].payload["reason"], "digestChanged");
    let lease = pool.attach(&changed, &session('3'));
    let mut bridge = Bridge::attach(&lease).await;
    assert_eq!(bridge.exchange("env MODE").await, "changed");
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn the_process_bound_refuses_without_blocking_and_falls_back_to_cold() {
    let (_scratch, log) = journal().await;
    let pool = pool(
        Bounds {
            processes: 1,
            ..bounds()
        },
        &log,
    );
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let other = pool.attach(&spec("other", &["lines", "3e20"]), &session('2'));
    assert_eq!(
        other,
        json!({"mode":"cold","code":"mcp_pool_unavailable","reason":"boundReached"})
    );
    assert_eq!(processes(&pool), json!({"warm":1,"leased":0}));
    let lease = pool.attach(&lines(), &session('3'));
    assert_eq!(lease["mode"], "pooled");
    assert_eq!(processes(&pool), json!({"warm":0,"leased":1}));
    let refused = pool.attach(&lines(), &session('4'));
    assert_eq!(refused["code"], UNAVAILABLE);
    assert_eq!(refused["reason"], "boundReached");
    assert_eq!(pool.status()["sessions"][3]["mode"], "cold");
    assert_eq!(pool.status()["sessions"][3]["reason"], "boundReached");
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn credential_bearing_servers_stay_dedicated_with_a_visible_reason() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    let mut harness = lines();
    harness.server = "nesvo".into();
    harness
        .env
        .insert("NESVO_AGENT_CONTEXT".into(), "/private/context.json".into());
    let mut token = lines();
    token.env.insert("GITHUB_TOKEN".into(), "x".into());
    let mut relative = lines();
    relative.command = PathBuf::from("server");
    for (spec, reason, mark) in [
        (&harness, "sessionCredential", '1'),
        (&token, "credentialEnvironment", '2'),
        (&relative, "relativeCommand", '3'),
    ] {
        assert_eq!(
            pool.attach(spec, &session(mark)),
            json!({"mode":"dedicated","reason":reason})
        );
    }
    let status = pool.status();
    assert_eq!(status["processes"], json!({"warm":0,"leased":0}));
    assert_eq!(
        status["sessions"][0],
        json!({"sessionId":session('1'),"server":"nesvo","program":"claude","mode":"dedicated","reason":"sessionCredential","entryId":null})
    );
    pool.release_session(&session('1'));
    assert_eq!(pool.status()["sessions"].as_array().unwrap().len(), 2);
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn a_wrong_token_is_refused_and_the_leased_process_is_retired() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let lease = pool.attach(&lines(), &session('2'));
    let mut bridge = Bridge::open(&lease, &"0".repeat(64)).await;
    assert!(bridge.closed().await);
    until(|| processes(&pool) == json!({"warm":1,"leased":0})).await;
    let events = log.settled(2).await;
    assert_eq!(events[1].kind, "mcp.pool_released");
    assert_eq!(events[1].payload["reason"], "refused");
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn closing_the_session_cancels_its_lease() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let lease = pool.attach(&lines(), &session('2'));
    let mut bridge = Bridge::attach(&lease).await;
    assert_eq!(bridge.exchange("ready").await, "> ready");
    pool.release_session(&session('2'));
    assert!(bridge.closed().await);
    until(|| processes(&pool) == json!({"warm":1,"leased":0})).await;
    let events = log.settled(2).await;
    assert_eq!(events[1].session_id.as_deref(), Some(session('2').as_str()));
    assert_eq!(events[1].payload["reason"], "sessionClosed");
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn dropping_the_pool_kills_every_pooled_process_tree() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let pool = Pool::new(bounds());
    let tree = spec("tree", &["tree", &address, "root", "leaf"]);
    assert_eq!(pool.attach(&tree, &session('1'))["reason"], "notPrepared");
    let mut observers = Vec::new();
    for _ in 0..2 {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut stream = BufReader::new(stream);
        let mut role = String::new();
        stream.read_line(&mut role).await.unwrap();
        observers.push((role.trim_end().to_owned(), stream));
    }
    let mut roles: Vec<_> = observers.iter().map(|(role, _)| role.clone()).collect();
    roles.sort();
    assert_eq!(roles, ["leaf", "root"]);
    drop(pool);
    for (role, mut stream) in observers {
        let mut rest = Vec::new();
        let closed = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut rest))
            .await
            .unwrap_or_else(|_| panic!("{role} survived its pool"));
        assert!(matches!(closed, Ok(0) | Err(_)), "{role} kept writing");
    }
}

#[tokio::test]
async fn shutdown_journals_every_pooled_process_and_refuses_new_attaches() {
    let (_scratch, log) = journal().await;
    let pool = pool(bounds(), &log);
    pool.attach(&lines(), &session('1'));
    settle(&pool, 1, 0).await;
    let lease = pool.attach(&lines(), &session('2'));
    let mut bridge = Bridge::attach(&lease).await;
    assert_eq!(bridge.exchange("ready").await, "> ready");
    settle(&pool, 1, 1).await;
    pool.shutdown().await;
    assert!(bridge.closed().await);
    assert_eq!(
        pool.attach(&lines(), &session('3')),
        json!({"mode":"cold","code":"mcp_pool_unavailable","reason":"closed"})
    );
    let status = pool.status();
    assert_eq!(status["available"], false);
    assert_eq!(status["processes"], json!({"warm":0,"leased":0}));
    let events = log.settled(3).await;
    let mut kinds: Vec<_> = events[1..]
        .iter()
        .map(|event| (event.kind.clone(), event.payload["reason"].clone()))
        .collect();
    kinds.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        kinds,
        [
            ("mcp.pool_reaped".to_owned(), json!("shutdown")),
            ("mcp.pool_released".to_owned(), json!("shutdown"))
        ]
    );
    log.shutdown().await;
}

#[test]
fn status_publishes_the_documented_bounds_table() {
    let status = Pool::new(BOUNDS).status();
    assert_eq!(
        status["bounds"],
        json!({"processes":4,"warmPerKey":1,"idleMs":600_000,"connectMs":30_000,"sessions":256})
    );
    assert_eq!(status["available"], true);
    assert_eq!(status["processes"], json!({"warm":0,"leased":0}));
}
