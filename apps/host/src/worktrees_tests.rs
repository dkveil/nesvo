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
    Scratch(PathBuf::from(display_path(&path.canonicalize().unwrap())))
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
        .await
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
        .await
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
        .await
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
        .await
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
    let limit = Duration::from_secs(DEFAULT_TIMEOUT_S);
    let mut running = Box::pin(execute(&steps, &scratch.0, &mut log, limit, receiver));
    let stream = tokio::select! {
        stream = held_process(&listener) => stream,
        outcome = running.as_mut() => panic!("the step ended with {outcome:?} before it was held"),
    };
    tokio::time::pause();
    tokio::time::advance(limit).await;
    assert_eq!(running.await, Outcome::TimedOut);
    tokio::time::resume();
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

fn worktree_commands(directory: &str, digest: &str, session: &str) -> Vec<Command> {
    vec![
        Command::DescribeWorktreeSetup {
            directory: directory.into(),
        },
        Command::ApproveWorktreeSetup {
            directory: directory.into(),
            digest: digest.into(),
        },
        Command::RevokeWorktreeSetup {
            directory: directory.into(),
            digest: digest.into(),
        },
        Command::RunWorktree {
            session_id: session.into(),
        },
        Command::CancelWorktree {
            session_id: session.into(),
        },
        Command::ArchiveWorktree {
            session_id: session.into(),
            discard: true,
        },
        Command::ListWorktrees,
    ]
}

#[test]
fn scoped_callers_are_forbidden_every_worktree_command_even_inside_their_scope() {
    let own = "a".repeat(32);
    let digest = "b".repeat(64);
    for authority in [
        Authority::Session {
            id: own.clone(),
            scope_id: "c".repeat(32),
        },
        Authority::RunWake {
            id: own.clone(),
            scope_id: "c".repeat(32),
        },
    ] {
        for target in [own.as_str(), "foreign"] {
            for command in worktree_commands("C:/repo", &digest, target) {
                let error = admit(&authority, &command).unwrap_err();
                assert_eq!(code(&error), "forbidden", "{error}");
                let outside = target_session(&command).is_some() && target != own;
                assert_eq!(error.to_string().contains("outside"), outside, "{error}");
                assert_eq!(
                    error.to_string().contains("requires owner authority"),
                    !outside,
                    "{error}"
                );
            }
        }
    }
}

#[tokio::test]
async fn owner_callers_pass_the_gate_and_reach_only_host_registered_worktrees() {
    let scratch = scratch();
    let store = store(&scratch);
    let config = format!(
        "[worktree]\nsetup = [{}]\n",
        toml_steps(&[fixture("echo 0")])
    );
    let repository = repository(&scratch, Some(&config)).await;
    let directory = display_path(&repository);
    let session = "e".repeat(32);
    let digest = parse(&config).unwrap().digest();
    for command in worktree_commands(&directory, &digest, &session) {
        assert!(admit(&Authority::Owner, &command).is_ok());
    }
    let approved = approve(&store, None, &directory, &digest).await.unwrap();
    assert_eq!(approved["type"], "worktreeSetupApproved");
    let (_worktree, result) = derived(&store, &repository, &session).await;
    assert_eq!(result.unwrap().unwrap().result, "passed");
    let cancelled = cancel(&store, &session).unwrap();
    assert_eq!(
        (cancelled["type"].as_str(), cancelled["cancelled"].as_bool()),
        (Some("worktreeCancelled"), Some(false))
    );
    assert_eq!(
        code(&cancel(&store, &"f".repeat(32)).unwrap_err()),
        "worktree_not_found"
    );
    assert!(archive(&store, None, &session, false, false).await.is_ok());
    assert_eq!(
        code(&cancel(&store, &session).unwrap_err()),
        "worktree_not_found"
    );
}

async fn accepted(listener: &tokio::net::TcpListener, role: &[u8]) -> tokio::net::TcpStream {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut received = vec![0; role.len()];
    stream.read_exact(&mut received).await.unwrap();
    assert_eq!(received, role);
    stream
}

async fn idle(store: &Store, session: &str) {
    tokio::time::timeout(Duration::from_secs(60), async {
        while store.running(session) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the worktree activity finishes");
}

fn record(session_id: &str) -> Record {
    Record {
        session_id: session_id.into(),
        worktree: format!("C:/worktrees/{session_id}"),
        branch: None,
        repository: "C:/source".into(),
        created_at: 1,
        digest: None,
        config: None,
        setup: Phase {
            state: "notConfigured".into(),
            log: None,
            started_at: 1,
            finished_at: Some(1),
        },
        run: None,
        env_files: Vec::new(),
        archived_at: None,
        discarded: false,
    }
}

#[tokio::test]
async fn worktree_lifecycle_events_land_in_the_event_journal() {
    let scratch = scratch();
    let store: &'static Store = Box::leak(Box::new(store(&scratch)));
    let log = event_log::Service::open(scratch.0.join("events.sqlite3"))
        .await
        .unwrap();
    let step = toml_steps(&[fixture("emit 6f6b0a")]);
    let config = format!("[worktree]\nsetup = [{step}]\nrun = [{step}]\n");
    let repository = repository(&scratch, Some(&config)).await;
    let directory = display_path(&repository);
    let digest = parse(&config).unwrap().digest();
    approve(store, Some(&log), &directory, &digest)
        .await
        .unwrap();
    let session = "4".repeat(32);
    let plan = plan_with(Some(store), &repository).await.unwrap();
    let worktree = git::create_worktree(&repository).await.unwrap();
    let fact = prepare_with(Some(store), plan, &worktree, &session, Some(log.clone()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fact.result, "passed");
    run(store, Some(log.clone()), &session).await.unwrap();
    idle(store, &session).await;
    log.settled(3).await;
    archive(store, Some(&log), &session, false, false)
        .await
        .unwrap();
    revoke(store, Some(&log), &directory, &digest)
        .await
        .unwrap();
    let events = log.settled(5).await;
    let kinds: Vec<_> = events.iter().map(|event| event.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "worktree.setup_approved",
            "worktree.prepared",
            "worktree.ran",
            "worktree.archived",
            "worktree.setup_revoked"
        ]
    );
    let repository_id = repository_key(&repository);
    for event in [&events[0], &events[4]] {
        assert_eq!(event.session_id, None);
        assert_eq!(
            event.payload,
            json!({"repository":repository_id,"digest":digest})
        );
    }
    for event in &events[1..4] {
        assert_eq!(event.session_id.as_deref(), Some(session.as_str()));
        assert_eq!(event.payload["sessionId"], session.as_str());
    }
    assert_eq!(events[1].payload["result"], "passed");
    assert_eq!(events[1].payload["digest"], digest.as_str());
    assert_eq!(events[2].payload["result"], "passed");
    assert_eq!(events[3].payload["discarded"], false);
    assert_eq!(log.health()["writeFailures"], 0);
    log.shutdown().await;
}

#[tokio::test]
async fn run_steps_come_from_the_approved_setup_not_the_agent_writable_worktree() {
    let scratch = scratch();
    let store: &'static Store = Box::leak(Box::new(store(&scratch)));
    let config = format!(
        "[worktree]\nrun = [{}]\n",
        toml_steps(&[fixture("emit 617070726f7665640a")])
    );
    let repository = repository(&scratch, Some(&config)).await;
    let repository_id = repository_key(&repository);
    let digest = parse(&config).unwrap().digest();
    store.approve(&repository_id, &digest).await.unwrap();
    let session = "2".repeat(32);
    let (worktree, result) = derived(store, &repository, &session).await;
    assert_eq!(result.unwrap().unwrap().result, "passed");
    let tampered = format!(
        "[worktree]\nrun = [{}]\n",
        toml_steps(&[fixture("emit 74616d70657265640a")])
    );
    std::fs::write(worktree.join(CONFIG_FILE), &tampered).unwrap();
    store
        .approve(&repository_id, &parse(&tampered).unwrap().digest())
        .await
        .unwrap();
    let started = run(store, None, &session).await.unwrap();
    assert_eq!(started["type"], "worktreeRunStarted");
    idle(store, &session).await;
    let text = std::fs::read_to_string(worktree.join(".nesvo/run.log")).unwrap();
    assert!(text.contains("approved\n"), "{text}");
    assert!(!text.contains("tampered"), "{text}");
    assert_eq!(store.find(&session).unwrap().run.unwrap().state, "passed");
    let listing = registry(store, |_| false).await.unwrap();
    assert!(listing["worktrees"][0].get("config").is_none());
    store.revoke(&repository_id, &digest).await.unwrap();
    assert_eq!(
        code(&run(store, None, &session).await.unwrap_err()),
        "worktree_setup_unapproved"
    );
    store.approve(&repository_id, &digest).await.unwrap();
    store
        .modify(&session, |record| record.config = None)
        .await
        .unwrap();
    assert_eq!(
        code(&run(store, None, &session).await.unwrap_err()),
        "worktree_run_unavailable"
    );
}

#[tokio::test]
async fn a_background_process_left_by_a_finished_step_is_terminated_with_it() {
    let scratch = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut log = Log::create(&scratch.0.join("run.log")).await.unwrap();
    let (_cancel, receiver) = watch::channel(false);
    let steps = vec![fixture(&format!("tree {address} root child"))];
    let running = execute(
        &steps,
        &scratch.0,
        &mut log,
        Duration::from_secs(60),
        receiver,
    );
    tokio::pin!(running);
    let (root, child) = tokio::select! {
        streams = async {
            let root = accepted(&listener, b"root\n").await;
            (root, accepted(&listener, b"child\n").await)
        } => streams,
        _ = &mut running => panic!("the step finished before its processes started"),
    };
    drop(root);
    assert_eq!(running.await, Outcome::Passed);
    closed(child).await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_step_helper_runs_nothing_before_its_frame_is_released() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let text = fixture(&format!("tree {address} root"));
    let mut command = tokio::process::Command::from(step_command(&text).unwrap());
    command.kill_on_drop(true);
    command_scope::configure(&mut command);
    let mut helper = command.spawn().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(500), listener.accept())
            .await
            .is_err(),
        "the helper waits for its frame"
    );
    drop(helper.stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(30), helper.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[cfg(windows)]
#[test]
fn windows_step_frames_carry_one_valid_step_only() {
    let frame = step_frame("echo ready");
    assert_eq!(
        read_step(&mut std::io::Cursor::new(frame.clone())).as_deref(),
        Some("echo ready")
    );
    let mut oversized = u32::try_from(STEP_BYTES + 1)
        .unwrap()
        .to_be_bytes()
        .to_vec();
    oversized.extend(vec![b'a'; STEP_BYTES + 1]);
    for invalid in [
        vec![0, 0, 0, 0],
        oversized,
        step_frame("a\nb"),
        step_frame("   "),
        [&3u32.to_be_bytes()[..], &[0xff, 0xfe, 0xfd]].concat(),
        frame[..frame.len() - 1].to_vec(),
    ] {
        assert!(read_step(&mut std::io::Cursor::new(invalid)).is_none());
    }
}

#[cfg(windows)]
#[test]
#[ignore = "internal worktree step helper entry; inert without its test-only environment gate"]
fn step_helper_entry() {
    if std::env::var_os(STEP_TEST_GATE).as_deref() == Some(std::ffi::OsStr::new("1")) {
        std::process::exit(step_helper());
    }
}

#[tokio::test]
async fn registry_eviction_keeps_every_active_record_and_refuses_when_none_is_archived() {
    let scratch = scratch();
    let store = store(&scratch);
    let repository = repository(&scratch, None).await;
    store.document.lock().unwrap().worktrees = (0..RECORD_LIMIT)
        .map(|index| record(&format!("{index:032}")))
        .collect();
    let refused = store.insert(record("new")).await.unwrap_err();
    assert_eq!(code(&refused), "worktree_registry_full");
    assert!(!store.has_room());
    assert_eq!(
        code(&plan_with(Some(&store), &repository).await.err().unwrap()),
        "worktree_registry_full"
    );
    let archived = format!("{:032}", 7);
    store.document.lock().unwrap().worktrees[7].archived_at = Some(1);
    assert!(store.has_room());
    store.insert(record("new")).await.unwrap();
    let document = store.document.lock().unwrap();
    assert_eq!(document.worktrees.len(), RECORD_LIMIT);
    assert!(
        document
            .worktrees
            .iter()
            .all(|record| record.archived_at.is_none() && record.session_id != archived)
    );
    assert_eq!(document.worktrees.last().unwrap().session_id, "new");
}

#[tokio::test]
async fn registry_writes_replace_the_file_atomically_and_keep_the_newest_state() {
    let scratch = scratch();
    let store = store(&scratch);
    let digests: Vec<String> = (0..16).map(|index| format!("{index:064x}")).collect();
    futures_util::future::try_join_all(
        digests
            .iter()
            .map(|digest| store.approve("C:/source", digest)),
    )
    .await
    .unwrap();
    let host = scratch.0.join("host");
    assert!(!host.join("worktrees.json.tmp").exists());
    let reopened = Store::open(&host).unwrap();
    assert!(
        digests
            .iter()
            .all(|digest| reopened.approved("C:/source", digest))
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(host.join("worktrees.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

fn link(target: &Path, path: &Path, directory: bool) -> bool {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, path).is_ok()
    }
    #[cfg(windows)]
    {
        if directory {
            std::os::windows::fs::symlink_dir(target, path).is_ok()
        } else {
            std::os::windows::fs::symlink_file(target, path).is_ok()
        }
    }
}

#[test]
fn environment_files_stay_inside_both_checkouts_and_within_their_size_bound() {
    let scratch = scratch();
    let root = scratch.0.join("root");
    let worktree = scratch.0.join("worktree");
    let outside = scratch.0.join("outside");
    for directory in [&root, &worktree, &outside] {
        std::fs::create_dir_all(directory).unwrap();
    }
    std::fs::write(root.join(".env"), "A=1\n").unwrap();
    let copied = copy_env_files(&root, &worktree, &[".env".into()]).unwrap();
    assert_eq!(copied[0].sha256, sha256(b"A=1\n"));
    assert_eq!(
        std::fs::read_to_string(worktree.join(".env")).unwrap(),
        "A=1\n"
    );
    let refusal = |file: &str| copy_env_files(&root, &worktree, &[file.into()]).unwrap_err();
    assert!(refusal(".env").contains("would overwrite"));
    assert!(refusal("absent.env").contains("is missing"));
    std::fs::write(
        root.join("big.env"),
        vec![b'a'; ENV_FILE_BYTES as usize + 1],
    )
    .unwrap();
    assert!(refusal("big.env").contains("at most"));
    std::fs::write(outside.join("secret"), "SECRET=1\n").unwrap();
    if link(&outside.join("secret"), &root.join("link.env"), false) {
        assert!(refusal("link.env").contains("inside the source checkout"));
    }
    if link(&outside, &root.join("linked"), true) {
        assert!(refusal("linked/secret").contains("inside the source checkout"));
    }
    std::fs::create_dir_all(root.join("apps")).unwrap();
    std::fs::write(root.join("apps/local.env"), "B=2\n").unwrap();
    if link(&outside, &worktree.join("apps"), true) {
        assert!(refusal("apps/local.env").contains("inside the worktree"));
        assert!(!outside.join("local.env").exists());
    }
}

#[test]
fn quota_launches_release_the_native_run_gate_before_worktree_setup() {
    let source = include_str!("operations.rs");
    let start = source.find("async fn dispatch_quota_create").unwrap();
    let body = &source[start..];
    let body = &body[..body.find("\n}").unwrap()];
    let released = body.find("drop(gate);").unwrap();
    let setup = body.find("crate::worktrees::prepare(").unwrap();
    assert!(
        released < setup,
        "the per-run native gate is released before setup runs"
    );
}

#[tokio::test]
async fn a_derived_worktree_is_unknown_only_once_checkout_has_started() {
    let scratch = scratch();
    let outside = scratch.0.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let mut spec = LaunchSpec {
        worktree: true,
        ..LaunchSpec::default()
    };
    let refused = derive(&outside, "s", None, &mut spec).await.unwrap_err();
    assert_eq!(
        Failure::of(&refused).unwrap().receipt("s", None),
        (
            "failed",
            json!({"code":"worktree_unconfirmed","message":"Inspect the repository before creating another worktree","effectStarted":false})
        )
    );
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
    let repository = repository(&scratch, None).await;
    std::fs::write(
        repository.join(".gitattributes"),
        "blob.txt filter=failedCheckout\n",
    )
    .unwrap();
    std::fs::write(repository.join("blob.txt"), "checkout input\n").unwrap();
    git_ok(&repository, &["add", "--", ".gitattributes", "blob.txt"]).await;
    git_ok(
        &repository,
        &["-c", "core.hooksPath=", "commit", "-q", "-m", "filtered"],
    )
    .await;
    git_ok(
        &repository,
        &["config", "filter.failedCheckout.smudge", "false"],
    )
    .await;
    git_ok(
        &repository,
        &["config", "filter.failedCheckout.required", "true"],
    )
    .await;
    let failed = derive(&repository, "s", None, &mut spec).await.unwrap_err();
    assert_eq!(
        Failure::of(&failed).unwrap().receipt("s", None),
        (
            "unknown",
            json!({"code":"worktree_unconfirmed","message":"Inspect the repository before creating another worktree"})
        )
    );
    assert!(spec.cwd.is_none() && spec.worktree);
}

fn link_directory(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(display_path(link))
                .arg(display_path(target))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
    }
}

#[tokio::test]
async fn a_linked_state_folder_is_refused_without_touching_its_target() {
    let worktree = scratch();
    let outside = scratch();
    std::fs::write(outside.0.join(".gitignore"), "keep").unwrap();
    std::fs::write(outside.0.join("setup.log"), "keep").unwrap();
    assert!(link_directory(&outside.0, &worktree.0.join(STATE_DIR)));
    assert!(state_dir(&worktree.0).await.is_err());
    assert!(
        Log::create(&worktree.0.join(STATE_DIR).join("setup.log"))
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(outside.0.join(".gitignore")).unwrap(),
        "keep"
    );
    assert_eq!(
        std::fs::read_to_string(outside.0.join("setup.log")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn a_linked_log_file_is_refused_without_truncating_its_target() {
    let worktree = scratch();
    let outside = scratch();
    let victim = outside.0.join("victim.txt");
    std::fs::write(&victim, "keep").unwrap();
    let directory = state_dir(&worktree.0).await.unwrap();
    std::fs::hard_link(&victim, directory.join("run.log")).unwrap();
    assert!(Log::create(&directory.join("run.log")).await.is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    std::fs::remove_file(directory.join(".gitignore")).unwrap();
    std::fs::hard_link(&victim, directory.join(".gitignore")).unwrap();
    assert!(state_dir(&worktree.0).await.is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&victim, directory.join("setup.log")).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&victim, directory.join("setup.log")).is_ok();
    if linked {
        assert!(Log::create(&directory.join("setup.log")).await.is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    }
}

#[tokio::test]
async fn a_plain_state_folder_truncates_and_rewrites_its_logs() {
    let worktree = scratch();
    let directory = state_dir(&worktree.0).await.unwrap();
    assert!(handle_paths_inside(&directory, &worktree.0));
    assert_eq!(
        std::fs::read_to_string(directory.join(".gitignore")).unwrap(),
        "*
"
    );
    std::fs::write(
        directory.join("run.log"),
        "an older and much longer run log",
    )
    .unwrap();
    let mut log = Log::create(&directory.join("run.log")).await.unwrap();
    log.line("fresh").await;
    log.finish().await;
    assert_eq!(
        std::fs::read_to_string(directory.join("run.log")).unwrap(),
        "fresh
"
    );
    assert_eq!(state_dir(&worktree.0).await.unwrap(), directory);
}

fn handle_paths_inside(directory: &Path, worktree: &Path) -> bool {
    directory
        .parent()
        .is_some_and(|parent| crate::handle_paths::same_path(parent, worktree))
}

#[tokio::test]
async fn a_failed_registry_write_leaves_approvals_unchanged_in_memory() {
    let scratch = scratch();
    let store = store(&scratch);
    let digest = "a".repeat(64);
    store.approve("repository", &digest).await.unwrap();
    let blocker = store.path.with_extension("json.tmp");
    std::fs::create_dir(&blocker).unwrap();
    let other = "b".repeat(64);
    assert!(store.approve("repository", &other).await.is_err());
    assert!(!store.approved("repository", &other));
    assert!(store.revoke("repository", &digest).await.is_err());
    assert!(store.approved("repository", &digest));
    std::fs::remove_dir(&blocker).unwrap();
    assert!(store.revoke("repository", &digest).await.unwrap());
    assert!(!store.approved("repository", &digest));
    let reopened = Store::open(&scratch.0.join("host")).unwrap();
    assert!(!reopened.approved("repository", &digest));
    assert!(!reopened.approved("repository", &other));
}
