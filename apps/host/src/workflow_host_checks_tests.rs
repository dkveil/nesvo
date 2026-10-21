use super::*;
use crate::orchestration::Scope;
use serde_json::json;
use tokio::io::AsyncReadExt;

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
        "nesvo-host-checks-{}",
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

const REPOSITORY: &str = "C:/source";
const DIGEST: &str = "abababababababababababababababababababababababababababababababab";

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

fn worker(session: &str) -> Actor {
    Actor {
        issuer: session.into(),
        scope: Scope::Worker(session.into()),
    }
}

fn request(value: Value) -> Request {
    serde_json::from_value(value).unwrap()
}

fn code(error: &anyhow::Error) -> &'static str {
    error_code(error).unwrap_or("untyped")
}

struct Harness {
    scratch: Scratch,
    log: Service,
    run_id: String,
    revision: u64,
    attempts: Vec<(String, String)>,
}

fn record(session: &str, worktree: &Path, setup: Option<(&str, Value)>) -> Value {
    let (digest, config) = setup.map_or((Value::Null, Value::Null), |(digest, config)| {
        (json!(digest), config)
    });
    let mut record = json!({
        "sessionId":session,"worktree":display_path(worktree),"branch":null,"repository":REPOSITORY,
        "createdAt":1,"digest":digest,
        "setup":{"state":if digest.is_null(){"notConfigured"}else{"passed"},"log":null,"startedAt":1,"finishedAt":1},
        "run":null,"envFiles":[],"archivedAt":null,"discarded":false
    });
    if !config.is_null() {
        record["config"] = config;
    }
    record
}

fn worktree_store(directory: &Path, records: Vec<Value>, approvals: &[&str]) -> worktrees::Store {
    let approvals: Vec<Value> = approvals
        .iter()
        .map(|digest| json!({"repository":REPOSITORY,"digest":digest,"approvedAt":1}))
        .collect();
    std::fs::write(
        directory.join("worktrees.json"),
        serde_json::to_vec(&json!({"version":1,"approvals":approvals,"worktrees":records}))
            .unwrap(),
    )
    .unwrap();
    worktrees::Store::open(directory).unwrap()
}

fn template_store(
    directory: &Path,
    run_id: &str,
    tasks: Value,
    approved: bool,
) -> workflow_templates::Store {
    let approvals = if approved {
        json!([{"repository":REPOSITORY,"digest":DIGEST,"approvedAt":1}])
    } else {
        json!([])
    };
    std::fs::write(
        directory.join("workflow-templates.json"),
        serde_json::to_vec(&json!({"version":1,"approvals":approvals,"runs":[{"runId":run_id,"repository":REPOSITORY,"template":"review","digest":DIGEST,"tasks":tasks,"boundAt":1}]})).unwrap(),
    )
    .unwrap();
    workflow_templates::Store::open(directory).unwrap()
}

async fn harness(keys: &[&str]) -> Harness {
    let scratch = scratch();
    let log = Service::open(scratch.0.join("events.sqlite3"))
        .await
        .unwrap();
    let created = log
        .workflow(
            owner(),
            request(
                json!({"action":"create","key":"create","spec":{"title":"Checks","goal":"Run host checks"}}),
            ),
        )
        .await
        .unwrap();
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();
    let tasks: Vec<Value> = keys
        .iter()
        .map(|key| json!({"key":key,"title":key,"instruction":"Do the work"}))
        .collect();
    let planned = log
        .workflow(
            owner(),
            request(
                json!({"action":"setPlan","key":"plan","runId":run_id,"expectedRevision":1,"tasks":tasks}),
            ),
        )
        .await
        .unwrap();
    let mut revision = log
        .workflow(
            owner(),
            request(
                json!({"action":"activate","key":"activate","runId":run_id,"expectedRevision":planned["run"]["revision"]}),
            ),
        )
        .await
        .unwrap()["run"]["revision"]
        .as_u64()
        .unwrap();
    let mut attempts = Vec::new();
    for (index, task) in planned["tasks"].as_array().unwrap().iter().enumerate() {
        let session = format!("{index}").repeat(32);
        let assigned = log
            .workflow(
                owner(),
                request(
                    json!({"action":"assign","key":format!("assign-{index}"),"runId":run_id,"taskId":task["id"],"sessionId":session,"expectedRevision":revision}),
                ),
            )
            .await
            .unwrap();
        let attempt = assigned["tasks"][index]["currentAttempt"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let reported = log
            .workflow(
                worker(&session),
                request(
                    json!({"action":"report","key":"report","attemptId":attempt,"result":{"outcome":"succeeded","summary":"Worker claims success","files":[],"artifacts":[],"checks":[{"name":"unit","outcome":"passed","details":"Claimed by the worker"}],"limitations":[]}}),
                ),
            )
            .await
            .unwrap();
        revision = reported["run"]["revision"].as_u64().unwrap();
        attempts.push((attempt, session));
    }
    Harness {
        scratch,
        log,
        run_id,
        revision,
        attempts,
    }
}

impl Harness {
    fn host(&self) -> PathBuf {
        let directory = self.scratch.0.join("host");
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }
    fn worktree(&self, index: usize) -> PathBuf {
        let directory = self.scratch.0.join(format!("worktree-{index}"));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }
    fn validation(&self, index: usize, key: &str, revision: u64) -> Request {
        request(json!({
            "action":"validate","key":key,"runId":self.run_id,"attemptId":self.attempts[index].0,
            "expectedRevision":revision,"hostChecks":true,
            "validation":{"passed":true,"summary":"Owner accepts on host evidence","checks":[]}
        }))
    }
    async fn attempt(&self, index: usize) -> Value {
        let view = self
            .log
            .workflow(
                owner(),
                Request::Get {
                    run_id: self.run_id.clone(),
                },
            )
            .await
            .unwrap();
        let task_id = view["tasks"][index]["id"].as_str().unwrap().to_owned();
        let history = self
            .log
            .workflow(
                owner(),
                Request::Task {
                    run_id: self.run_id.clone(),
                    task_id,
                    offset: None,
                },
            )
            .await
            .unwrap();
        history["attempts"][0].clone()
    }
}

#[tokio::test]
async fn host_check_validation_attests_passing_and_failing_checks_and_refuses_validated_on_failure()
{
    let harness = harness(&["implement", "lint", "docs"]).await;
    let host = harness.host();
    let records = (0..3)
        .map(|index| record(&harness.attempts[index].1, &harness.worktree(index), None))
        .collect();
    let worktrees = worktree_store(&host, records, &[]);
    let templates = template_store(
        &host,
        &harness.run_id,
        json!([
            {"key":"implement","commands":[fixture("echo 0 6f6b0a")]},
            {"key":"lint","commands":[fixture("echo 0 6f6b0a"),fixture("echo 3 6661696c0a"),fixture("echo 0")]}
        ]),
        true,
    );
    let passed = validate_with(
        &harness.log,
        owner(),
        harness.validation(0, "accept-implement", harness.revision),
        &worktrees,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(passed["tasks"][0]["state"], "succeeded");
    let checks = &passed["hostChecks"];
    assert_eq!(checks["source"], "hostAttestation");
    assert_eq!(checks["passed"], true);
    assert_eq!(checks["template"], "review");
    assert_eq!(checks["digest"], DIGEST);
    assert_eq!(checks["attemptId"], harness.attempts[0].0.as_str());
    assert_eq!(checks["checks"][0]["outcome"], "passed");
    assert_eq!(checks["checks"][0]["exitCode"], 0);
    assert_eq!(checks["checks"][0]["tail"], "ok\n");
    assert!(checks["checks"][0]["durationMs"].is_u64());
    let replay = validate_with(
        &harness.log,
        owner(),
        harness.validation(0, "accept-implement", harness.revision),
        &worktrees,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(replay, passed);
    let stored = harness.attempt(0).await;
    assert_eq!(stored["state"], "succeeded");
    assert_eq!(stored["validation"]["hostChecks"]["passed"], true);
    assert_eq!(stored["validation"]["source"], "ownerAttestation");
    assert_eq!(
        stored["result"]["checks"][0]["details"],
        "Claimed by the worker"
    );
    let revision = passed["run"]["revision"].as_u64().unwrap();
    let failed = validate_with(
        &harness.log,
        owner(),
        harness.validation(1, "accept-lint", revision),
        &worktrees,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(failed["tasks"][1]["state"], "failed");
    let checks = &failed["hostChecks"]["checks"];
    assert_eq!(failed["hostChecks"]["passed"], false);
    assert_eq!(checks[0]["outcome"], "passed");
    assert_eq!(checks[1]["outcome"], "failed");
    assert_eq!(checks[1]["exitCode"], 3);
    assert_eq!(checks[1]["tail"], "fail\n");
    assert_eq!(checks[2]["outcome"], "passed");
    let stored = harness.attempt(1).await;
    assert_eq!(stored["state"], "failed");
    assert_eq!(stored["validation"]["refusedBy"], "hostChecks");
    assert_eq!(stored["validation"]["passed"], true);
    let revision = failed["run"]["revision"].as_u64().unwrap();
    let missing = validate_with(
        &harness.log,
        owner(),
        harness.validation(2, "accept-docs", revision),
        &worktrees,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&missing), "host_checks_missing");
    assert_eq!(harness.attempt(2).await["state"], "reported");
    let log_text = std::fs::read_to_string(harness.worktree(1).join(".nesvo/checks.log")).unwrap();
    assert!(log_text.contains("fail\n"), "{log_text}");
}

#[tokio::test]
async fn host_check_validation_refuses_unapproved_or_changed_digests_and_missing_worktrees() {
    let harness = harness(&["implement", "lint"]).await;
    let host = harness.host();
    let config = json!({"setup":[],"run":["npm run dev"],"envFiles":[],"timeoutS":600});
    let current = worktrees::Config {
        setup: Vec::new(),
        run: vec!["npm run dev".into()],
        env_files: Vec::new(),
        timeout_s: 600,
    }
    .digest();
    let worktrees = worktree_store(
        &host,
        vec![
            record(
                &harness.attempts[0].1,
                &harness.worktree(0),
                Some((DIGEST, config)),
            ),
            record(&harness.attempts[1].1, &harness.worktree(1), None),
        ],
        &[DIGEST, &current],
    );
    let tasks = json!([
        {"key":"implement","commands":[fixture("echo 0 6f6b0a")]},
        {"key":"lint","commands":[fixture("echo 0 6f6b0a")]}
    ]);
    let templates = template_store(&host, &harness.run_id, tasks.clone(), true);
    let changed = validate_with(
        &harness.log,
        owner(),
        harness.validation(0, "changed", harness.revision),
        &worktrees,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&changed), "worktree_setup_unapproved");
    let unapproved_templates = template_store(&host, &harness.run_id, tasks, false);
    let unapproved = validate_with(
        &harness.log,
        owner(),
        harness.validation(1, "unapproved", harness.revision),
        &worktrees,
        &unapproved_templates,
        TAIL_BYTES,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&unapproved), "workflow_templates_unapproved");
    let empty = worktree_store(&host, Vec::new(), &[]);
    let unbound = validate_with(
        &harness.log,
        owner(),
        harness.validation(1, "unbound", harness.revision),
        &empty,
        &templates,
        TAIL_BYTES,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&unbound), "host_checks_unavailable");
    for index in 0..2 {
        assert_eq!(harness.attempt(index).await["state"], "reported");
        assert!(!harness.worktree(index).join(".nesvo/checks.log").exists());
    }
}

#[tokio::test]
async fn validation_requesting_host_checks_without_a_host_attestation_fails_closed() {
    let harness = harness(&["implement"]).await;
    let forwarded = harness
        .log
        .workflow(owner(), harness.validation(0, "direct", harness.revision))
        .await
        .unwrap_err();
    assert_eq!(code(&forwarded), "host_checks_unavailable");
    assert_eq!(harness.attempt(0).await["state"], "reported");
    let forged = serde_json::from_value::<Request>(json!({
        "action":"validate","key":"forged","runId":harness.run_id,"attemptId":harness.attempts[0].0,
        "expectedRevision":harness.revision,"hostChecks":true,"hostAttestation":{"passed":true},
        "validation":{"passed":true,"summary":"Forged","checks":[]}
    }));
    assert!(forged.is_err());
    let worker_refused = validate_with(
        &harness.log,
        worker(&harness.attempts[0].1),
        harness.validation(0, "worker", harness.revision),
        &worktree_store(&harness.host(), Vec::new(), &[]),
        &template_store(&harness.host(), &harness.run_id, json!([]), true),
        TAIL_BYTES,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&worker_refused), "forbidden");
}

async fn held(listener: &tokio::net::TcpListener) -> tokio::net::TcpStream {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut role = [0; 5];
    stream.read_exact(&mut role).await.unwrap();
    assert_eq!(&role, b"root\n");
    stream
}

#[tokio::test]
async fn host_check_validation_times_out_a_check_beyond_its_deadline_and_skips_the_rest() {
    let scratch = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (_cancel, receiver) = watch::channel(false);
    let commands = vec![fixture(&format!("tree {address} root")), fixture("echo 0")];
    let running = run_checks(
        &commands,
        &scratch.0,
        Bounds {
            limit: Duration::from_millis(1500),
            tail: TAIL_BYTES,
        },
        receiver,
    );
    let (result, mut stream) = tokio::join!(running, held(&listener));
    let (runs, log) = result.unwrap();
    assert_eq!(runs[0].outcome, "timedOut");
    assert_eq!(runs[0].exit_code, None);
    assert!(runs[0].duration_ms >= 1000);
    assert_eq!(runs[1].outcome, "skipped");
    assert!(log.ends_with("checks.log"));
    let mut byte = [0];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut byte))
        .await
        .expect("the terminated check releases its socket");
    assert!(matches!(read, Ok(0) | Err(_)));
}

#[tokio::test]
async fn host_check_validation_output_tails_never_exceed_their_bound() {
    let scratch = scratch();
    let (_cancel, receiver) = watch::channel(false);
    let payload: String = (0..96)
        .map(|i| format!("{:02x}", b'a' + (i % 26)))
        .collect();
    let commands = vec![
        fixture(&format!("emit {payload}0d0a1b5b33316d")),
        fixture("echo 0"),
    ];
    let (runs, _) = run_checks(
        &commands,
        &scratch.0,
        Bounds {
            limit: Duration::from_secs(60),
            tail: 16,
        },
        receiver,
    )
    .await
    .unwrap();
    assert_eq!(runs[0].outcome, "passed");
    assert!(runs[0].tail.len() <= 16, "{:?}", runs[0].tail);
    assert!(runs[0].tail_truncated);
    assert!(runs[0].tail.ends_with("\n?[31m"), "{:?}", runs[0].tail);
    assert!(!runs[0].tail.contains('\r'));
    assert_eq!(runs[1].tail, "");
    assert!(!runs[1].tail_truncated);
    let (text, cut) = printable("ąąąą".as_bytes(), 3);
    assert!(text.len() <= 3 && cut);
    assert_eq!(text, "ą");
}

#[test]
fn host_check_validation_template_checks_parse_within_bounds_and_change_the_digest() {
    let base = "[[workflow]]\nname = \"one\"\ngoal = \"Goal\"\n[[workflow.task]]\nkey = \"build\"\ninstruction = \"Build\"\nprogram = \"claude\"\nworkspace = \"worktree\"\n";
    let plain = workflow_templates::parse(base).unwrap();
    assert!(plain[0].tasks[0].checks.is_empty());
    let checked = workflow_templates::parse(&format!(
        "{base}checks = [\"cargo test --locked\", \"npm run lint\"]\n"
    ))
    .unwrap();
    assert_eq!(
        checked[0].tasks[0].checks,
        vec!["cargo test --locked", "npm run lint"]
    );
    assert_ne!(
        workflow_templates::digest(&plain),
        workflow_templates::digest(&checked)
    );
    assert!(
        serde_json::to_value(&plain).unwrap()[0]["tasks"][0]
            .get("checks")
            .is_none()
    );
    let many = (0..=workflow_templates::CHECK_LIMIT)
        .map(|i| format!("\"check {i}\""))
        .collect::<Vec<_>>()
        .join(", ");
    for invalid in [
        format!("{base}checks = [{many}]\n"),
        format!("{base}checks = [\"\"]\n"),
        format!(
            "{base}checks = [\"{}\"]\n",
            "a".repeat(workflow_templates::CHECK_BYTES + 1)
        ),
        format!("{base}checks = \"cargo test\"\n"),
    ] {
        assert!(workflow_templates::parse(&invalid).is_err(), "{invalid}");
    }
    let source = workflow_templates::Source {
        root: PathBuf::from(REPOSITORY),
        repository: REPOSITORY.into(),
        templates: checked,
    };
    let digest = source.digest().unwrap();
    let binding =
        workflow_templates::run_checks(&source, &source.templates[0], &digest, "run").unwrap();
    assert_eq!(binding.commands("build").len(), 2);
    assert!(binding.commands("other").is_empty());
    assert!(
        workflow_templates::run_checks(
            &workflow_templates::Source {
                root: PathBuf::from(REPOSITORY),
                repository: REPOSITORY.into(),
                templates: plain.clone(),
            },
            &plain[0],
            &digest,
            "run"
        )
        .is_none()
    );
}
