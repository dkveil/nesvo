use super::*;

mod process_fixture {
    include!("../../../crates/nesvo-process-fixture/src/locate.rs");
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let path = std::env::temp_dir().join(format!(
        "nesvo-worktrees-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    Scratch(path)
}

fn fixture(arguments: &str) -> String {
    format!(
        "\"{}\" {arguments}",
        display_path(process_fixture::executable())
    )
}

fn toml_steps(steps: &[String]) -> String {
    steps
        .iter()
        .map(|step| format!("'{step}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

async fn git_ok(directory: &Path, arguments: &[&str]) -> String {
    let output = git::run(directory, arguments, 64 * 1024, Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(output.code, Some(0), "git {arguments:?}");
    String::from_utf8_lossy(&output.bytes).into_owned()
}

async fn repository(scratch: &Scratch, config: Option<&str>) -> PathBuf {
    let repository = scratch.0.join("source");
    std::fs::create_dir_all(&repository).unwrap();
    git_ok(&repository, &["init", "-q", "-b", "main"]).await;
    for (key, value) in [
        ("user.name", "Nesvo Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git_ok(&repository, &["config", key, value]).await;
    }
    std::fs::write(repository.join("README.md"), "source\n").unwrap();
    if let Some(config) = config {
        std::fs::write(repository.join(CONFIG_FILE), config).unwrap();
    }
    git_ok(&repository, &["add", "."]).await;
    git_ok(
        &repository,
        &["-c", "core.hooksPath=", "commit", "-q", "-m", "initial"],
    )
    .await;
    repository
}

fn store(scratch: &Scratch) -> Store {
    let directory = scratch.0.join("host");
    std::fs::create_dir_all(&directory).unwrap();
    Store::open(&directory).unwrap()
}

fn code(error: &anyhow::Error) -> &'static str {
    error_code(error).unwrap_or("untyped")
}

async fn derived(
    store: &Store,
    repository: &Path,
    session_id: &str,
) -> (PathBuf, Result<Option<SetupFact>>) {
    let plan = plan_with(Some(store), repository).await.unwrap();
    let worktree = git::create_worktree(repository).await.unwrap();
    let result = prepare_with(Some(store), plan, &worktree, session_id, None).await;
    (worktree, result)
}

#[test]
fn config_parsing_accepts_the_declared_subset_and_rejects_everything_else() {
    let config = parse(
        "\u{feff}# project setup\n[worktree] # table\nsetup = [\n  \"npm ci\", # install\n  'cargo fetch --locked',\n]\r\nrun = [\"echo \\\"dev\\\" \\u00e9\"]\nenv_files = [\".env\", \"apps/mobile/.env.local\"]\ntimeout_s = 1_200\n",
    )
    .unwrap();
    assert_eq!(
        config,
        Config {
            setup: vec!["npm ci".into(), "cargo fetch --locked".into()],
            run: vec!["echo \"dev\" é".into()],
            env_files: vec![".env".into(), "apps/mobile/.env.local".into()],
            timeout_s: 1200,
        }
    );
    assert_eq!(
        parse("").unwrap(),
        Config {
            timeout_s: 600,
            ..Config::default()
        }
    );
    assert!(parse("[worktree]\n").unwrap().is_empty());
    for invalid in [
        "setup = []\n",
        "[other]\n",
        "[worktree]\n[worktree]\n",
        "[worktree]\nsetup = []\nsetup = []\n",
        "[worktree]\nshell = []\n",
        "[worktree]\nsetup = \"npm ci\"\n",
        "[worktree]\nsetup = [1]\n",
        "[worktree]\nsetup = [\"\"]\n",
        "[worktree]\nsetup = [\"a\\nb\"]\n",
        "[worktree]\nsetup = [\"\"\"x\"\"\"]\n",
        "[worktree]\nsetup = [\"unterminated]\n",
        "[worktree]\nsetup = [\"a\" \"b\"]\n",
        "[worktree]\nsetup = [] extra\n",
        "[worktree]\ntimeout_s = 0\n",
        "[worktree]\ntimeout_s = 3601\n",
        "[worktree]\ntimeout_s = 012\n",
        "[worktree]\ntimeout_s = -1\n",
        "[worktree]\nenv_files = [\"../secret\"]\n",
        "[worktree]\nenv_files = [\"/etc/passwd\"]\n",
        "[worktree]\nenv_files = [\"C:/x\"]\n",
        "[worktree]\nenv_files = [\".git/config\"]\n",
        "[worktree]\nenv_files = [\".nesvo/setup.log\"]\n",
        "[worktree]\nenv_files = [\"a\\\\b\"]\n",
        "[worktree]\nenv_files = [\".env\", \".env\"]\n",
    ] {
        assert!(parse(invalid).is_err(), "{invalid:?}");
    }
    let many = format!(
        "[worktree]\nsetup = [{}]\n",
        vec!["\"x\""; STEP_LIMIT + 1].join(",")
    );
    assert!(parse(&many).is_err());
    assert!(parse(&"#".repeat(CONFIG_LIMIT + 1)).is_err());
    let error = parse("[worktree]\n\nsetup = [1]\n")
        .unwrap_err()
        .to_string();
    assert!(error.contains("line 3"), "{error}");
}

#[test]
fn digest_binds_every_declared_field_but_not_formatting() {
    let compact =
        parse("[worktree]\nsetup=[\"a\"]\nrun=[\"b\"]\nenv_files=[\".env\"]\ntimeout_s=60\n")
            .unwrap();
    let spaced = parse(
        "# same\n[worktree]\n  setup = [ 'a', ]\n  run = [\n 'b'\n]\n  env_files = ['.env']\n  timeout_s = 60\n",
    )
    .unwrap();
    assert_eq!(compact.digest(), spaced.digest());
    assert_eq!(compact.digest().len(), 64);
    for changed in [
        Config {
            setup: vec!["a ".into()],
            ..compact.clone()
        },
        Config {
            run: vec![],
            ..compact.clone()
        },
        Config {
            env_files: vec![".env.local".into()],
            ..compact.clone()
        },
        Config {
            timeout_s: 61,
            ..compact.clone()
        },
    ] {
        assert_ne!(changed.digest(), compact.digest());
    }
}

#[tokio::test]
async fn approval_gate_refuses_before_creating_a_worktree_and_follows_revocation() {
    let scratch = scratch();
    let store = store(&scratch);
    let repository = repository(&scratch, Some("[worktree]\nsetup = [\"echo ready\"]\n")).await;
    let before = std::fs::read_dir(&scratch.0).unwrap().count();
    let refused = plan_with(Some(&store), &repository).await.err().unwrap();
    assert_eq!(code(&refused), "worktree_setup_unapproved");
    assert_eq!(
        Failure::of(&refused).unwrap().receipt("s", None),
        (
            "failed",
            json!({"code":"worktree_setup_unapproved","message":refused.to_string().chars().take(240).collect::<String>(),"effectStarted":false})
        )
    );
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), before);
    assert_eq!(
        code(&plan_with(None, &repository).await.err().unwrap()),
        "unsupported"
    );
    let directory = display_path(&repository);
    let described = describe(&store, &directory).await.unwrap();
    assert_eq!(described["configured"], true);
    assert_eq!(described["approved"], false);
    let digest = described["digest"].as_str().unwrap().to_owned();
    assert_eq!(
        code(
            &approve(&store, None, &directory, &"0".repeat(64))
                .await
                .unwrap_err()
        ),
        "digest_mismatch"
    );
    let approved = approve(&store, None, &directory, &digest).await.unwrap();
    assert_eq!(approved["digest"], digest.as_str());
    assert!(
        plan_with(Some(&store), &repository)
            .await
            .unwrap()
            .prepared
            .is_some()
    );
    assert_eq!(
        describe(&store, &directory).await.unwrap()["approved"],
        true
    );
    let reopened = Store::open(&scratch.0.join("host")).unwrap();
    assert!(reopened.approved(&repository_key(&repository), &digest));
    std::fs::write(
        repository.join(CONFIG_FILE),
        "[worktree]\nsetup = [\"echo uncommitted\"]\n",
    )
    .unwrap();
    assert!(plan_with(Some(&store), &repository).await.is_ok());
    let revoked = revoke(&store, None, &directory, &digest).await.unwrap();
    assert_eq!(revoked["revoked"], true);
    assert_eq!(
        code(&plan_with(Some(&store), &repository).await.err().unwrap()),
        "worktree_setup_unapproved"
    );
    let plain = scratch.0.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let plain_scratch = Scratch(plain.clone());
    let unconfigured = self::repository(&plain_scratch, None).await;
    assert!(
        plan_with(None, &unconfigured)
            .await
            .unwrap()
            .prepared
            .is_none()
    );
    assert_eq!(
        code(&plan_with(None, &scratch.0).await.err().unwrap()),
        "worktree_unconfirmed"
    );
}

#[tokio::test]
async fn setup_passes_copies_environment_files_and_archives_cleanly() {
    let scratch = scratch();
    let store = store(&scratch);
    let steps = vec![fixture("emit 68656c6c6f0a"), fixture("echo 0")];
    let config = format!(
        "[worktree]\nsetup = [{}]\nenv_files = [\".env\", \"apps/local.env\"]\ntimeout_s = 120\n",
        toml_steps(&steps)
    );
    let repository = repository(&scratch, Some(&config)).await;
    std::fs::write(repository.join(".env"), "TOKEN=local\n").unwrap();
    std::fs::create_dir_all(repository.join("apps")).unwrap();
    std::fs::write(repository.join("apps/local.env"), "MODE=dev\n").unwrap();
    let digest = parse(&config).unwrap().digest();
    store
        .approve(&repository_key(&repository), &digest)
        .unwrap();
    let (worktree, result) = derived(&store, &repository, "a".repeat(32).as_str()).await;
    let fact = result.unwrap().unwrap();
    assert_eq!(
        (fact.result, fact.digest.as_str()),
        ("passed", digest.as_str())
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join(".env")).unwrap(),
        "TOKEN=local\n"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("apps/local.env")).unwrap(),
        "MODE=dev\n"
    );
    let text = std::fs::read_to_string(worktree.join(".nesvo/setup.log")).unwrap();
    assert!(text.starts_with("copied environment file .env\n"), "{text}");
    assert!(text.contains("hello\n"), "{text}");
    assert!(!text.contains("truncated"), "{text}");
    assert_eq!(
        fact.log,
        display_path(&worktree.join(".nesvo").join("setup.log"))
    );
    let record = store.find(&"a".repeat(32)).unwrap();
    assert_eq!(record.setup.state, "passed");
    assert_eq!(record.digest.as_deref(), Some(digest.as_str()));
    assert_eq!(
        record.branch.as_deref().map(|b| b.starts_with("nesvo/")),
        Some(true)
    );
    assert_eq!(record.env_files.len(), 2);
    assert!(
        git_ok(&worktree, &["status", "--porcelain"])
            .await
            .lines()
            .all(|line| !line.contains(".nesvo"))
    );
    assert!(
        archive(&store, None, &"a".repeat(32), false, false)
            .await
            .is_ok(),
        "host-owned environment copies and logs are not unsaved work"
    );
}

#[tokio::test]
async fn failed_setup_refuses_the_spawn_with_a_receipt_and_registry_state() {
    let scratch = scratch();
    let store = store(&scratch);
    let config = format!(
        "[worktree]\nsetup = [{}]\n",
        toml_steps(&[fixture("emit 6e6f0a"), fixture("echo 3"), fixture("echo 0")])
    );
    let repository = repository(&scratch, Some(&config)).await;
    store
        .approve(
            &repository_key(&repository),
            &parse(&config).unwrap().digest(),
        )
        .unwrap();
    let session = "b".repeat(32);
    let (worktree, result) = derived(&store, &repository, &session).await;
    let error = result.unwrap_err();
    assert_eq!(code(&error), "worktree_setup_failed");
    let (phase, receipt) = Failure::of(&error).unwrap().receipt(&session, Some("dir"));
    assert_eq!(phase, "failed");
    assert_eq!(receipt["reservedSessionId"], session.as_str());
    assert_eq!(
        receipt["log"],
        display_path(&worktree.join(".nesvo").join("setup.log")).as_str()
    );
    let log = std::fs::read_to_string(worktree.join(".nesvo/setup.log")).unwrap();
    assert!(log.contains("no\n"), "{log}");
    assert!(log.contains("step failed with exit code 3"), "{log}");
    assert_eq!(log.matches("$ ").count(), 2, "{log}");
    assert_eq!(store.find(&session).unwrap().setup.state, "failed");
    assert_eq!(
        code(
            &run(Box::leak(Box::new(store)), None, &session)
                .await
                .unwrap_err()
        ),
        "worktree_not_prepared"
    );
    let missing = "[worktree]\nenv_files = [\".env\"]\n".to_owned();
    let other = Scratch(scratch.0.join("missing"));
    std::fs::create_dir_all(&other.0).unwrap();
    let repository = self::repository(&other, Some(&missing)).await;
    let store = self::store(&other);
    store
        .approve(
            &repository_key(&repository),
            &parse(&missing).unwrap().digest(),
        )
        .unwrap();
    let (worktree, result) = derived(&store, &repository, &"c".repeat(32)).await;
    assert_eq!(code(&result.unwrap_err()), "worktree_setup_failed");
    assert!(
        std::fs::read_to_string(worktree.join(".nesvo/setup.log"))
            .unwrap()
            .contains("environment file .env is missing")
    );
}

async fn held_process(listener: &tokio::net::TcpListener) -> tokio::net::TcpStream {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut role = [0; 5];
    stream.read_exact(&mut role).await.unwrap();
    assert_eq!(&role, b"root\n");
    stream
}

async fn closed(mut stream: tokio::net::TcpStream) {
    let mut byte = [0];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut byte))
        .await
        .expect("the terminated step releases its socket");
    assert!(matches!(read, Ok(0) | Err(_)));
}

#[tokio::test]
async fn a_pending_setup_holds_the_spawn_until_cancellation_terminates_it() {
    let scratch = scratch();
    let store = store(&scratch);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = format!(
        "[worktree]\nsetup = [{}]\n",
        toml_steps(&[fixture(&format!("tree {address} root"))])
    );
    let repository = repository(&scratch, Some(&config)).await;
    store
        .approve(
            &repository_key(&repository),
            &parse(&config).unwrap().digest(),
        )
        .unwrap();
    let session = "d".repeat(32);
    let plan = plan_with(Some(&store), &repository).await.unwrap();
    let worktree = git::create_worktree(&repository).await.unwrap();
    let preparing = prepare_with(Some(&store), plan, &worktree, &session, None);
    tokio::pin!(preparing);
    let stream = tokio::select! {
        stream = held_process(&listener) => stream,
        _ = &mut preparing => panic!("setup finished while its step was still running"),
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut preparing)
            .await
            .is_err(),
        "the spawn stays held while setup runs"
    );
    assert_eq!(store.find(&session).unwrap().setup.state, "running");
    assert!(store.running(&session));
    assert!(store.cancel(&session));
    let error = preparing.await.unwrap_err();
    assert_eq!(code(&error), "worktree_setup_cancelled");
    closed(stream).await;
    assert_eq!(store.find(&session).unwrap().setup.state, "cancelled");
    assert!(!store.running(&session));
}

#[tokio::test]
async fn a_step_beyond_its_deadline_times_out_and_is_terminated() {
    let scratch = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut log = Log::create(&scratch.0.join("run.log")).await.unwrap();
    let (_cancel, receiver) = watch::channel(false);
    let steps = vec![fixture(&format!("tree {address} root")), fixture("echo 0")];
    let running = execute(
        &steps,
        &scratch.0,
        &mut log,
        Duration::from_millis(1500),
        receiver,
    );
    let (outcome, stream) = tokio::join!(running, held_process(&listener));
    assert_eq!(outcome, Outcome::TimedOut);
    closed(stream).await;
    log.finish().await;
    let text = std::fs::read_to_string(scratch.0.join("run.log")).unwrap();
    assert!(text.contains("timed out"), "{text}");
    assert_eq!(text.matches("$ ").count(), 1);
    let (_cancel, receiver) = watch::channel(true);
    let mut log = Log::create(&scratch.0.join("cancel.log")).await.unwrap();
    assert_eq!(
        execute(
            &steps,
            &scratch.0,
            &mut log,
            Duration::from_secs(5),
            receiver
        )
        .await,
        Outcome::Cancelled
    );
}

#[tokio::test]
async fn archive_refuses_unsaved_work_unless_discarded_and_registry_tracks_states() {
    let scratch = scratch();
    let store = store(&scratch);
    let repository = repository(&scratch, None).await;
    let clean = "e".repeat(32);
    let dirty = "f".repeat(32);
    let committed = "1".repeat(32);
    let (clean_path, result) = derived(&store, &repository, &clean).await;
    assert!(result.unwrap().is_none());
    let (dirty_path, _) = derived(&store, &repository, &dirty).await;
    let (committed_path, _) = derived(&store, &repository, &committed).await;
    let listing = registry(&store, |id| id == clean).await.unwrap();
    let entries = listing["worktrees"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().all(|entry| entry["present"] == true));
    assert!(
        entries
            .iter()
            .all(|entry| entry["setup"]["state"] == "notConfigured")
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry["sessionLive"] == true)
            .count(),
        1
    );
    assert_eq!(
        code(
            &archive(&store, None, &clean, false, true)
                .await
                .unwrap_err()
        ),
        "session_running"
    );
    std::fs::write(dirty_path.join("notes.txt"), "unsaved").unwrap();
    let refusal = archive(&store, None, &dirty, false, false)
        .await
        .unwrap_err();
    assert_eq!(code(&refusal), "worktree_unsaved");
    assert!(refusal.to_string().contains("dirty"));
    assert!(dirty_path.exists());
    std::fs::write(committed_path.join("feature.txt"), "work").unwrap();
    git_ok(&committed_path, &["add", "."]).await;
    git_ok(
        &committed_path,
        &["-c", "core.hooksPath=", "commit", "-q", "-m", "feature"],
    )
    .await;
    let refusal = archive(&store, None, &committed, false, false)
        .await
        .unwrap_err();
    assert!(refusal.to_string().contains("unpushed"), "{refusal}");
    let branch = store.find(&clean).unwrap().branch.unwrap();
    let archived = archive(&store, None, &clean, false, false).await.unwrap();
    assert_eq!(archived["type"], "worktreeArchived");
    assert_eq!(archived["discarded"], false);
    assert_eq!(archived["branchDeleted"], true);
    assert!(!clean_path.exists());
    assert!(
        !git_ok(&repository, &["branch", "--list", &branch])
            .await
            .contains(&branch)
    );
    let discarded = archive(&store, None, &dirty, true, false).await.unwrap();
    assert_eq!(discarded["discarded"], true);
    assert_eq!(discarded["blockers"], json!(["dirty"]));
    assert!(!dirty_path.exists());
    assert_eq!(
        code(
            &archive(&store, None, &dirty, true, false)
                .await
                .unwrap_err()
        ),
        "worktree_not_found"
    );
    let listing = registry(&store, |_| false).await.unwrap();
    let states: Vec<(bool, bool)> = listing["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["present"] == true, entry["archivedAt"].is_u64()))
        .collect();
    assert_eq!(states, vec![(true, false), (false, true), (false, true)]);
    let reopened = Store::open(&scratch.0.join("host")).unwrap();
    assert_eq!(reopened.records().len(), 3);
}

#[tokio::test]
async fn setup_logs_are_capped_at_64_kib_with_a_visible_marker() {
    let scratch = scratch();
    let path = scratch.0.join("setup.log");
    let mut log = Log::create(&path).await.unwrap();
    log.line("$ step").await;
    for _ in 0..9 {
        log.write(&[b'a'; 8192]).await;
    }
    log.line("after the cap").await;
    log.finish().await;
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.len() <= LOG_LIMIT, "{}", text.len());
    assert!(text.starts_with("$ step\naaaa"));
    assert!(!text.contains("after the cap"));
    assert!(text.ends_with("[log truncated at 65536 bytes]\n"));
}

#[test]
fn the_repository_worktree_config_parses_within_bounds() {
    let config = parse(include_str!("../../../nesvo.toml")).unwrap();
    assert!(!config.setup.is_empty() && !config.run.is_empty());
    assert!(config.env_files.is_empty());
    assert_eq!(config.timeout_s, 900);
}
