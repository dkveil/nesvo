use super::*;
use budgets::owner_cli;

type Owner = RunningService<RoleClient, ()>;

const MARKER: &str = "host-check-marker.txt";
const TEMPLATES: &str = r#"[[workflow]]
name = "checked"
title = "Host checked work"
goal = "Run the approved checks inside each worker worktree"
start = "executor"
max_parallel = 1

[[workflow.task]]
key = "passing"
instruction = "report-task"
program = "claude"
workspace = "worktree"
harness = true
checks = ["node marker-check.cjs"]

[[workflow.task]]
key = "failing"
depends_on = ["passing"]
instruction = "report-task"
program = "claude"
workspace = "worktree"
harness = true
checks = ["node marker-check.cjs", "node failing-check.cjs", "node marker-check.cjs"]
"#;
const MARKER_CHECK: &str = "const fs = require('node:fs');\nfs.appendFileSync('host-check-marker.txt', `${process.cwd()}\\n`);\nconsole.log(`HOST_CHECK_MARKER ${fs.readFileSync('worktree-identity.txt', 'utf8').trim()}`);\n";
const FAILING_CHECK: &str = "console.log('HOST_CHECK_FAILURE');\nprocess.exit(3);\n";

async fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .await
        .context("Owned host check Git command")?;
    ensure!(
        output.status.success(),
        "Owned host check Git fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn repository(fixture: &Fixture) -> Result<PathBuf> {
    let directory = fixture.directory.join("checked-repository");
    std::fs::create_dir(&directory)?;
    git(&directory, &["init", "--quiet"]).await?;
    git(&directory, &["config", "--local", "core.autocrlf", "false"]).await?;
    git(&directory, &["config", "--local", "core.hooksPath", ""]).await?;
    std::fs::write(directory.join("nesvo.toml"), TEMPLATES)?;
    std::fs::write(directory.join("marker-check.cjs"), MARKER_CHECK)?;
    std::fs::write(directory.join("failing-check.cjs"), FAILING_CHECK)?;
    std::fs::write(
        directory.join("worktree-identity.txt"),
        "committed checkout\n",
    )?;
    git(&directory, &["add", "--", "."]).await?;
    git(
        &directory,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "owned host checks",
        ],
    )
    .await?;
    Ok(directory)
}

async fn run_view(owner: &Owner, run: &str) -> Result<Value> {
    Ok(data(call(owner, "nesvo_get_run", json!({"runId":run})).await?)?["data"].clone())
}

async fn worker_exited(owner: &Owner, worker: &str) -> Result<bool> {
    let reply = call(owner, "nesvo_get_session", json!({"sessionId":worker})).await?;
    if reply.is_error == Some(true) {
        let refusal = reply.structured_content.context("Worker session refusal")?;
        ensure!(
            refusal["error"]["code"] == "session_not_found",
            "Worker {worker} could not be inspected: {refusal}"
        );
        return Ok(false);
    }
    Ok(data(reply)?["data"]["session"]["running"] == false)
}

async fn reported(owner: &Owner, run: &str, key: &str) -> Result<Value> {
    waits::until(async || {
        let view = run_view(owner, run).await?;
        let task = view["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["key"] == key))
            .cloned()
            .with_context(|| format!("Template task {key}"))?;
        if task["state"] == "reported" {
            return Ok(Some(task));
        }
        ensure!(
            !waits::is_settled_run(&view["run"]["state"])
                && !waits::is_settled_attempt(&task["currentAttempt"]["state"]),
            "Checked run settled before {key} reported: {view}"
        );
        if let Some(worker) = task["currentAttempt"]["sessionId"].as_str() {
            ensure!(
                !worker_exited(owner, worker).await?,
                "Worker {worker} of {key} exited before reporting: {view}"
            );
        }
        Ok(None)
    })
    .await
    .with_context(|| format!("Template worker {key} reported from its worktree"))
}

fn validation(run: &str, task: &Value, key: &str, revision: &Value) -> Value {
    json!({
        "key":key,"runId":run,"attemptId":task["currentAttempt"]["id"],"expectedRevision":revision,
        "validation":{"passed":true,"summary":"Owner accepts only if the host checks pass","checks":[]},
        "hostChecks":true
    })
}

async fn validate(owner: &Owner, run: &str, task: &Value, key: &str) -> Result<(Value, Value)> {
    loop {
        let arguments = validation(
            run,
            task,
            key,
            &run_view(owner, run).await?["run"]["revision"],
        );
        let reply = call(owner, "nesvo_validate_task_result", arguments.clone()).await?;
        if reply.is_error != Some(true) {
            return Ok((arguments, data(reply)?));
        }
        let refusal = reply
            .structured_content
            .context("Host check validation refusal")?;
        ensure!(
            refusal["error"]["code"] == "revision_conflict",
            "Host check validation {key} failed: {refusal}"
        );
    }
}

async fn run_events(owner: &Owner, run: &str) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut cursor = 0;
    loop {
        let page = data(call(owner, "nesvo_read_events", json!({"after":cursor})).await?)?;
        ensure!(
            page["data"]["gap"] == false,
            "Host check journal must be complete: {page}"
        );
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Host check journal events")?
                .iter()
                .filter(|event| event["payload"]["runId"] == run)
                .cloned(),
        );
        if page["data"]["more"] != true {
            return Ok(events);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Host check journal cursor")?;
    }
}

fn markers(worktree: &Path) -> Result<usize> {
    let expected = worktree.canonicalize()?;
    let text = std::fs::read_to_string(worktree.join(MARKER))?;
    for line in text.lines() {
        ensure!(
            Path::new(line).canonicalize()? == expected,
            "A check wrote its marker from {line}, not {}",
            expected.display()
        );
    }
    Ok(text.lines().count())
}

async fn checked_worktree(attestation: &Value, source: &Path) -> Result<PathBuf> {
    let worktree = PathBuf::from(
        attestation["worktree"]
            .as_str()
            .context("Attested worktree")?,
    );
    ensure!(
        worktree.canonicalize()? != source.canonicalize()?,
        "Host checks ran in the source checkout instead of a worktree"
    );
    let listed = git(source, &["worktree", "list", "--porcelain"]).await?;
    let name = worktree
        .file_name()
        .context("Worktree folder name")?
        .to_string_lossy()
        .into_owned();
    ensure!(
        listed.contains(&name),
        "The attested folder is not a Git worktree of the source: {listed}"
    );
    Ok(worktree)
}

#[tokio::test]
#[ignore = "requires native binaries, Git and Node; approved nesvo.toml checks run inside each worker worktree and a failing check refuses success"]
async fn approved_host_checks_run_inside_the_worker_worktree_and_report_failures() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        waits::provider(&fixture, "claude")
            .await
            .context("Host check worker provider probe")?;
        let source = repository(&fixture).await?;
        let directory = source.to_str().context("Host check repository path")?;
        let owner = client(&fixture.pairing()).await?;
        let listed = owner_cli(
            &fixture,
            &["workflow", "templates", "--directory", directory, "--json"],
        )
        .await?;
        assert_eq!(listed["data"]["approved"], false);
        let digest = listed["data"]["digest"]
            .as_str()
            .context("Template digest")?
            .to_owned();
        let approved = owner_cli(
            &fixture,
            &[
                "workflow",
                "approve-templates",
                "--directory",
                directory,
                "--digest",
                &digest,
                "--json",
            ],
        )
        .await?;
        assert_eq!(approved["data"]["digest"], digest.as_str());
        let started = owner_cli(
            &fixture,
            &[
                "workflow",
                "start",
                "checked",
                "--directory",
                directory,
                "--key",
                "host-checks",
                "--json",
            ],
        )
        .await?;
        assert_eq!(started["data"]["start"], "executor");
        let run = started["data"]["run"]["id"]
            .as_str()
            .context("Checked run")?
            .to_owned();

        let passing = reported(&owner, &run, "passing").await?;
        let (_, passed) = validate(&owner, &run, &passing, "validate-passing").await?;
        let attestation = &passed["data"]["hostChecks"];
        assert_eq!(attestation["source"], "hostAttestation");
        assert_eq!(attestation["taskKey"], "passing");
        assert_eq!(attestation["template"], "checked");
        assert_eq!(attestation["digest"], digest.as_str());
        assert_eq!(
            attestation["sessionId"],
            passing["currentAttempt"]["sessionId"]
        );
        assert_eq!(attestation["passed"], true);
        assert_eq!(attestation["checks"][0]["outcome"], "passed");
        assert_eq!(attestation["checks"][0]["exitCode"], 0);
        assert!(
            attestation["checks"][0]["tail"]
                .as_str()
                .context("Passing tail")?
                .contains("HOST_CHECK_MARKER committed checkout")
        );
        let worktree = checked_worktree(attestation, &source).await?;
        ensure!(
            markers(&worktree)? >= 1,
            "The passing check ran in its worktree"
        );
        assert!(worktree.join(".nesvo").join("checks.log").is_file());

        let failing = reported(&owner, &run, "failing").await?;
        let (accepted, failed) = validate(&owner, &run, &failing, "validate-failing").await?;
        let attestation = &failed["data"]["hostChecks"];
        assert_eq!(attestation["taskKey"], "failing");
        assert_eq!(attestation["passed"], false);
        let outcomes: Vec<&Value> = attestation["checks"]
            .as_array()
            .context("Failing checks")?
            .iter()
            .map(|check| &check["outcome"])
            .collect();
        assert_eq!(
            outcomes,
            [&json!("passed"), &json!("failed"), &json!("passed")]
        );
        assert_eq!(attestation["checks"][1]["exitCode"], 3);
        assert!(
            attestation["checks"][1]["tail"]
                .as_str()
                .context("Failing tail")?
                .contains("HOST_CHECK_FAILURE")
        );
        let failing_worktree = checked_worktree(attestation, &source).await?;
        assert_ne!(
            failing_worktree.canonicalize()?,
            worktree.canonicalize()?,
            "Each worker has its own worktree"
        );
        let failing_markers = markers(&failing_worktree)?;
        ensure!(
            failing_markers >= 2 && failing_markers % 2 == 0,
            "Both marker checks of the failing task ran in its worktree"
        );
        assert!(
            !source.join(MARKER).exists(),
            "No check ran in the source checkout"
        );

        let settled = run_view(&owner, &run).await?;
        let state = |key: &str| {
            settled["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|task| task["key"] == key))
                .map(|task| task["currentAttempt"]["state"].clone())
        };
        assert_eq!(state("passing"), Some(json!("succeeded")));
        assert_eq!(state("failing"), Some(json!("failed")));
        let attempts = data(
            call(
                &owner,
                "nesvo_get_task_attempts",
                json!({"runId":run,"taskId":failing["id"]}),
            )
            .await?,
        )?;
        let recorded = &attempts["data"]["attempts"][0]["validation"];
        assert_eq!(
            recorded["hostChecks"], *attestation,
            "The run keeps the host attestation"
        );
        assert_eq!(recorded["refusedBy"], "hostChecks");
        let replay = data(call(&owner, "nesvo_validate_task_result", accepted).await?)?;
        assert_eq!(
            replay["data"]["hostChecks"], *attestation,
            "The same key replays without running the checks again"
        );
        assert_eq!(markers(&failing_worktree)?, failing_markers);

        let kinds: Vec<String> = run_events(&owner, &run)
            .await?
            .iter()
            .filter_map(|event| event["kind"].as_str())
            .filter(|kind| matches!(*kind, "run.result_reported" | "run.result_validated"))
            .map(str::to_owned)
            .collect();
        assert_eq!(
            kinds,
            [
                "run.result_reported",
                "run.result_validated",
                "run.result_reported",
                "run.result_validated"
            ],
            "Each report is followed by one host-checked validation"
        );
        run_checkpoints::schema(vec![listed, approved, started]).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
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
