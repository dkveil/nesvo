use super::*;
use crate::orchestration::{Actor, Scope};
use std::time::Duration;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let path = std::env::temp_dir().join(format!(
        "nesvo-workflow-templates-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    Scratch(path)
}

const TEMPLATES: &str = r#"
[worktree]
setup = ["cargo fetch --locked"]

[[workflow]]
name = "review"
title = "Branch review"
goal = "Review the current branch and report blocking issues"
start = "active"
max_parallel = 2
max_elapsed_ms = 1_800_000

[[workflow.task]]
key = "implement"
instruction = "Implement the change\nand report evidence"
program = "claude"
workspace = "worktree"
harness = true
allowed_nesvo_tools = ["nesvo_get_current_task", "nesvo_report_task_result"]

[[workflow.task]]
key = "review"
title = "Review"
instruction = "Validate the implementation"
depends_on = ["implement"]
program = "codex"
workspace = "shared"

[[workflow]]
name = "triage"
goal = "Triage the open issues"

[[workflow.task]]
key = "triage"
instruction = "List the issues worth fixing"
program = "gemini"
workspace = "shared"
"#;

fn task(key: &str, dependencies: &[&str]) -> String {
    let depends = dependencies
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "[[workflow.task]]\nkey = \"{key}\"\ninstruction = \"Do {key}\"\nprogram = \"claude\"\nworkspace = \"shared\"\ndepends_on = [{depends}]\n"
    )
}

fn single(tasks: &str) -> String {
    format!("[[workflow]]\nname = \"one\"\ngoal = \"Goal\"\n{tasks}")
}

#[test]
fn workflow_templates_parse_the_declared_subset_and_reject_everything_else() {
    let templates = parse(TEMPLATES).unwrap();
    assert_eq!(templates.len(), 2);
    let review = &templates[0];
    assert_eq!(review.name, "review");
    assert_eq!(review.title, "Branch review");
    assert_eq!(review.start, Start::Active);
    assert_eq!(
        review.budget,
        Some(Budget {
            max_parallel: 2,
            max_attempts_per_task: 16,
            max_elapsed_ms: Some(1_800_000)
        })
    );
    assert_eq!(
        review.tasks[0],
        Task {
            key: "implement".into(),
            title: "implement".into(),
            instruction: "Implement the change\nand report evidence".into(),
            dependencies: Vec::new(),
            program: "claude".into(),
            workspace: "worktree".into(),
            harness: Some(true),
            allowed_nesvo_tools: Some(vec![
                "nesvo_get_current_task".into(),
                "nesvo_report_task_result".into()
            ]),
        }
    );
    assert_eq!(review.tasks[1].dependencies, ["implement"]);
    assert_eq!(templates[1].title, "triage");
    assert_eq!(templates[1].start, Start::Draft);
    assert_eq!(templates[1].budget, None);
    assert!(parse("").unwrap().is_empty());
    assert!(parse("[worktree]\nsetup = [\"x\"]\n").unwrap().is_empty());
    let valid = single(&task("a", &[]));
    assert_eq!(parse(&valid).unwrap()[0].tasks.len(), 1);
    for invalid in [
        "[[workflow]]\nname = \"x\"\ngoal = \"g\"\n".to_owned(),
        "[[workflow.task]]\nkey = \"a\"\n".to_owned(),
        "[[workflow]]\ngoal = \"g\"\n".to_owned() + &task("a", &[]),
        "[[workflow]]\nname = \"x\"\n".to_owned() + &task("a", &[]),
        "[[workflow]]\nname = \"bad name\"\ngoal = \"g\"\n".to_owned() + &task("a", &[]),
        valid.replace("goal = \"Goal\"", "goal = \"Goal\"\nstart = \"later\""),
        valid.replace("goal = \"Goal\"", "goal = \"Goal\"\nmax_parallel = 17"),
        valid.replace("goal = \"Goal\"", "goal = \"Goal\"\nmax_elapsed_ms = 999"),
        valid.replace("goal = \"Goal\"", "goal = \"Goal\"\ngoal = \"Again\""),
        valid.replace("goal = \"Goal\"", "goal = \"Goal\"\nshell = \"sh\""),
        valid.replace("goal = \"Goal\"", "goal = 1"),
        valid.replace("program = \"claude\"", "program = \"shell\""),
        valid.replace("workspace = \"shared\"", "workspace = \"temp\""),
        valid.replace("workspace = \"shared\"\n", ""),
        valid.replace("instruction = \"Do a\"\n", ""),
        valid.replace(
            "program = \"claude\"",
            "program = \"claude\"\nharness = \"yes\"",
        ),
        valid.replace(
            "program = \"claude\"",
            "program = \"claude\"\nallowed_nesvo_tools = [\"*\"]",
        ),
        single(&(task("a", &[]) + &task("a", &[]))),
        single(&task("a", &["a"])),
        single(&task("a", &["missing"])),
        single(&(task("a", &["b"]) + &task("b", &["a"]))),
        format!("{valid}{valid}"),
        format!("{valid}[other]\n"),
        format!("{valid}[[worktree]]\n"),
    ] {
        assert!(parse(&invalid).is_err(), "{invalid:?}");
    }
    let many = (0..=TASK_LIMIT)
        .map(|n| task(&format!("t{n}"), &[]))
        .collect::<String>();
    assert!(parse(&single(&many)).is_err());
    let error = parse(&valid.replace("program = \"claude\"", "program = \"bash\""))
        .unwrap_err()
        .to_string();
    assert!(error.contains("line 7"), "{error}");
}

#[test]
fn workflow_templates_digest_binds_content_not_formatting() {
    let compact = parse(&single(&task("a", &[]))).unwrap();
    let spaced = parse(
        "# templates\n[[workflow]]   # one\nname='one'\ngoal = \"Goal\"\n\n[[ workflow.task ]]\nkey = 'a'\nworkspace = \"shared\"\nprogram = \"claude\"\ninstruction = \"Do a\"\ndepends_on = [\n]\n",
    )
    .unwrap();
    assert_eq!(digest(&compact), digest(&spaced));
    assert_eq!(digest(&compact).len(), 64);
    let changed = parse(&single(&task("a", &[])).replace("Do a", "Do b")).unwrap();
    assert_ne!(digest(&compact), digest(&changed));
}

#[test]
fn worktree_setup_ignores_workflow_entries_and_keeps_its_digest() {
    let combined = crate::worktrees::parse(TEMPLATES).unwrap();
    let plain =
        crate::worktrees::parse("[worktree]\nsetup = [\"cargo fetch --locked\"]\n").unwrap();
    assert_eq!(combined, plain);
    assert_eq!(combined.digest(), plain.digest());
    assert!(crate::worktrees::parse(&format!("{TEMPLATES}[worktree]\n")).is_err());
    assert!(crate::worktrees::parse("[[workflow]]\nname = \"x\"\n[[other]]\n").is_err());
    assert!(
        crate::worktrees::parse("[worktree]\nsetup = \"npm ci\"\n").is_err(),
        "string values remain invalid for setup"
    );
}

async fn git_ok(directory: &Path, arguments: &[&str]) {
    let output = git::run(directory, arguments, 64 * 1024, Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(output.code, Some(0), "git {arguments:?}");
}

async fn repository(scratch: &Scratch, config: &str) -> PathBuf {
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
    commit(&repository, config).await;
    repository
}

async fn commit(repository: &Path, config: &str) {
    std::fs::write(repository.join(CONFIG_FILE), config).unwrap();
    git_ok(repository, &["add", "."]).await;
    git_ok(
        repository,
        &["-c", "core.hooksPath=", "commit", "-q", "-m", "templates"],
    )
    .await;
}

fn store(scratch: &Scratch) -> Store {
    let directory = scratch.0.join("host");
    std::fs::create_dir_all(&directory).unwrap();
    Store::open(&directory).unwrap()
}

fn code(error: &anyhow::Error) -> &'static str {
    worktrees::error_code(error).unwrap_or("untyped")
}

#[tokio::test]
async fn workflow_templates_approval_gate_follows_the_committed_digest_and_revocation() {
    let scratch = scratch();
    let store = store(&scratch);
    let repository = repository(&scratch, TEMPLATES).await;
    let directory = display_path(&repository);
    let source = inspect(&directory).await.unwrap();
    let described = describe(&store, &source);
    assert_eq!(described["type"], "workflowTemplates");
    assert_eq!(described["configured"], true);
    assert_eq!(described["approved"], false);
    assert_eq!(
        described["templates"][0]["tasks"][1]["dependencies"],
        json!(["implement"])
    );
    let digest = described["digest"].as_str().unwrap().to_owned();
    assert_eq!(
        code(&approve(&store, None, &source, &"0".repeat(64)).unwrap_err()),
        "digest_mismatch"
    );
    assert_eq!(
        code(&approve(&store, None, &source, "short").unwrap_err()),
        "invalid_argument"
    );
    let approved = approve(&store, None, &source, &digest).unwrap();
    assert_eq!(approved["type"], "workflowTemplatesApproved");
    assert_eq!(describe(&store, &source)["approved"], true);
    let reopened = Store::open(&scratch.0.join("host")).unwrap();
    assert!(reopened.approved(&source.repository, &digest));
    std::fs::write(repository.join(CONFIG_FILE), "[worktree]\n").unwrap();
    assert_eq!(
        describe(&store, &inspect(&directory).await.unwrap())["approved"],
        true,
        "uncommitted edits never change the HEAD templates"
    );
    let revoked = revoke(&store, None, &source.repository, &digest).unwrap();
    assert_eq!(revoked["revoked"], true);
    assert_eq!(describe(&store, &source)["approved"], false);
    assert_eq!(
        code(&inspect("relative/folder").await.err().unwrap()),
        "invalid_argument"
    );
    let empty = Scratch(scratch.0.join("empty"));
    let plain = self::repository(&empty, "[worktree]\n").await;
    let plain_source = inspect(&display_path(&plain)).await.unwrap();
    assert_eq!(describe(&store, &plain_source)["configured"], false);
    assert_eq!(
        code(&approve(&store, None, &plain_source, &digest).unwrap_err()),
        "workflow_templates_missing"
    );
    let broken = Scratch(scratch.0.join("broken"));
    let invalid = self::repository(&broken, "[[workflow]]\nname = \"x\"\n").await;
    assert_eq!(
        code(&inspect(&display_path(&invalid)).await.err().unwrap()),
        "workflow_templates_invalid"
    );
}

#[tokio::test]
async fn workflow_templates_start_refuses_unapproved_or_changed_digests() {
    let scratch = scratch();
    let store = store(&scratch);
    let repository = repository(&scratch, TEMPLATES).await;
    let directory = display_path(&repository);
    let source = inspect(&directory).await.unwrap();
    assert_eq!(
        code(&selected(&store, &source, "review").err().unwrap()),
        "workflow_templates_unapproved"
    );
    let digest = source.digest().unwrap();
    approve(&store, None, &source, &digest).unwrap();
    assert_eq!(selected(&store, &source, "review").unwrap().1, digest);
    assert_eq!(
        code(&selected(&store, &source, "deploy").err().unwrap()),
        "workflow_template_not_found"
    );
    commit(
        &repository,
        &TEMPLATES.replace("blocking issues", "every issue"),
    )
    .await;
    let changed = inspect(&directory).await.unwrap();
    assert_ne!(changed.digest().unwrap(), digest);
    assert_eq!(
        code(&selected(&store, &changed, "review").err().unwrap()),
        "workflow_templates_unapproved"
    );
}

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

fn executor(log: event_log::Service) -> impl Fn(Request) -> Step {
    move |request| {
        let log = log.clone();
        Box::pin(async move {
            match request {
                Request::Executor { request } => match log
                    .executor(workflow_executor::Work::Manage {
                        actor: owner(),
                        request,
                    })
                    .await?
                {
                    workflow_executor::Reply::Managed { view, .. } => Ok(view),
                    _ => Err(anyhow!("Unexpected executor reply")),
                },
                request => log.workflow(owner(), request).await,
            }
        })
    }
}

fn source(root: &Path, text: &str) -> Source {
    Source {
        root: root.to_owned(),
        repository: display_path(root),
        templates: parse(text).unwrap(),
    }
}

#[tokio::test]
async fn workflow_templates_start_creates_the_run_and_tasks_once_per_key() {
    let scratch = scratch();
    let log = event_log::Service::open(scratch.0.join("events.sqlite3"))
        .await
        .unwrap();
    let source = source(&scratch.0, TEMPLATES);
    let digest = source.digest().unwrap();
    let review = &source.templates[0];
    let started = start_with(executor(log.clone()), &source, review, &digest, "review-1")
        .await
        .unwrap();
    assert_eq!(started["type"], "workflowTemplateStarted");
    assert_eq!(started["template"], "review");
    assert_eq!(started["digest"], digest.as_str());
    assert_eq!(started["run"]["title"], "Branch review");
    assert_eq!(
        started["run"]["goal"],
        "Review the current branch and report blocking issues"
    );
    assert_eq!(started["run"]["state"], "active");
    assert_eq!(started["run"]["coordinatorSessionId"], Value::Null);
    let tasks = started["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0]["key"], "implement");
    assert_eq!(
        tasks[0]["instruction"],
        "Implement the change\nand report evidence"
    );
    assert_eq!(tasks[1]["dependencies"], json!([tasks[0]["id"]]));
    assert_eq!(started["profiles"][0]["taskId"], tasks[0]["id"]);
    assert_eq!(started["profiles"][0]["profile"]["workspace"], "worktree");
    assert_eq!(started["profiles"][0]["profile"]["harness"], true);
    assert_eq!(
        started["profiles"][1]["profile"]["cwd"],
        display_path(&scratch.0).as_str()
    );
    assert_eq!(started["executor"], Value::Null);
    let run_id = started["run"]["id"].as_str().unwrap().to_owned();
    let budget = log
        .workflow(
            owner(),
            Request::RunBudget {
                request: workflow_budget::Request::Get {
                    run_id: run_id.clone(),
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(budget["policy"]["limits"]["maxParallel"], 2);
    assert_eq!(budget["policy"]["limits"]["maxAttemptsPerTask"], 16);
    assert_eq!(budget["policy"]["limits"]["maxElapsedMs"], 1_800_000);
    let replay = start_with(executor(log.clone()), &source, review, &digest, "review-1")
        .await
        .unwrap();
    assert_eq!(replay["run"]["id"], run_id.as_str());
    assert_eq!(replay["run"]["revision"], started["run"]["revision"]);
    let listed = log
        .workflow(owner(), Request::List { offset: None })
        .await
        .unwrap();
    assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
    let changed = self::source(&scratch.0, &TEMPLATES.replace("Branch review", "Other"));
    let conflict = start_with(
        executor(log.clone()),
        &changed,
        &changed.templates[0],
        &digest,
        "review-1",
    )
    .await
    .unwrap_err();
    assert_eq!(code(&conflict), "idempotency_conflict");
    let draft = start_with(
        executor(log.clone()),
        &source,
        &source.templates[1],
        &digest,
        "triage-1",
    )
    .await
    .unwrap();
    assert_eq!(draft["run"]["state"], "draft");
    assert_eq!(draft["run"]["revision"], 2);
    assert_eq!(
        code(
            &start_with(executor(log.clone()), &source, review, &digest, "")
                .await
                .unwrap_err()
        ),
        "invalid_argument"
    );
}

#[tokio::test]
async fn workflow_templates_executor_start_configures_the_existing_executor() {
    let scratch = scratch();
    let log = event_log::Service::open(scratch.0.join("events.sqlite3"))
        .await
        .unwrap();
    let text = TEMPLATES.replace("start = \"active\"", "start = \"executor\"");
    let source = source(&scratch.0, &text);
    let digest = source.digest().unwrap();
    let started = start_with(
        executor(log.clone()),
        &source,
        &source.templates[0],
        &digest,
        "review-exec",
    )
    .await
    .unwrap();
    assert_eq!(started["run"]["state"], "active");
    assert_eq!(started["executor"]["enabled"], true);
    assert_eq!(
        started["executor"]["spec"]["tasks"][1]["taskId"],
        started["tasks"][1]["id"]
    );
}
