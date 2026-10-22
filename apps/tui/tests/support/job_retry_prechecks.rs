//! Fresh command authorization for every opted-in native job generation.
use super::prechecks::{OwnedTree, TREE_EXIT_DEADLINE};
use super::*;

const LITERAL: &str = "literal $(x); & łódź \"quoted\"";

fn node(fixture: &Fixture) -> PathBuf {
    fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

const COMMAND_TIMEOUT_MS: u64 = 10_000;
const PRECHECK_BOUND_MS: u64 = COMMAND_TIMEOUT_MS + 3_000;
const HOST_READINESS_MS: u64 = 60_000;
const MARGIN_MS: u64 = 10_000;
const FIRST_GENERATION_BOUND: Duration = Duration::from_millis(PRECHECK_BOUND_MS + MARGIN_MS);
const CANCEL_CLEANUP_BOUND: Duration = Duration::from_millis(2_000 + MARGIN_MS);
const RESTART_RECONCILE_BOUND: Duration = Duration::from_millis(MARGIN_MS);
const SETTLED_STATES: [&str; 6] = [
    "canceled",
    "failed",
    "needsValidation",
    "reconcile",
    "skipped",
    "succeeded",
];
const BLOCKED_REASONS: [&str; 2] = ["input_unknown", "instruction_not_sent"];

fn next_generation_bound(delay_ms: u64) -> Duration {
    Duration::from_millis(delay_ms + MARGIN_MS)
}

fn next_precheck_bound(delay_ms: u64) -> Duration {
    Duration::from_millis(delay_ms + PRECHECK_BOUND_MS + MARGIN_MS)
}

fn reported_bound(delay_ms: u64) -> Duration {
    Duration::from_millis(delay_ms + PRECHECK_BOUND_MS + 2 * HOST_READINESS_MS + MARGIN_MS)
}

fn diverged(occurrence: &Value, wanted: &str, ordinal: u64) -> Option<String> {
    let state = occurrence["state"].as_str().unwrap_or_default();
    let current = occurrence["jobAttemptOrdinal"].as_u64().unwrap_or_default();
    let reason = occurrence["reason"].as_str().unwrap_or_default();
    if state == wanted && current == ordinal {
        return None;
    }
    (current > ordinal || SETTLED_STATES.contains(&state) || BLOCKED_REASONS.contains(&reason))
        .then(|| {
            format!(
                "Occurrence settled at {state}/{current} ({reason}) instead of {wanted}/{ordinal}"
            )
        })
}

async fn approve(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    tree: Option<&OwnedTree>,
) -> Result<(Value, PathBuf, Vec<Value>)> {
    let script = fixture.directory.join("generation precheck łódź.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )?;
    let directory = fixture.directory.join(format!("check-{mode}"));
    std::fs::create_dir(&directory)?;
    // This existing command cwd is deliberately independent of the missing
    // worker cwd which produces the genuine native failed/no-effect receipt.
    let environment = match tree {
        Some(tree) => tree.environment()?,
        None => json!({"CHECK_LITERAL":LITERAL}),
    };
    let command = json!({
        "title":format!("Repeated owned {mode}"),"executable":node(fixture),
        "cwd":directory,"arguments":[script,mode,directory,"root",LITERAL],
        "timeoutMs":COMMAND_TIMEOUT_MS,"environment":environment
    });
    let description = data(call(owner, "nesvo_describe_precheck", json!({"spec":command})).await?)?;
    let digest = description["data"]["precheckDescription"]["digest"]
        .as_str()
        .context("Repeated command digest")?;
    let file = fixture.directory.join(format!("{mode}-approval.json"));
    std::fs::write(&file, serde_json::to_vec(&command)?)?;
    let key = format!("approve:{mode}");
    let approved = budgets::owner_cli(
        fixture,
        &[
            "job",
            "precheck",
            "approve",
            "--file",
            file.to_str().context("Repeated command file")?,
            "--key",
            &key,
            "--digest",
            digest,
            "--json",
        ],
    )
    .await?;
    let replay = data(
        call(
            owner,
            "nesvo_approve_precheck",
            json!({"key":key,"spec":command,"expectedDigest":digest}),
        )
        .await?,
    )?;
    assert_eq!(replay["data"], approved["data"]);
    Ok((
        approved["data"]["precheckApproval"].clone(),
        directory,
        vec![description, approved, replay],
    ))
}

fn checked_spec(cwd: &Path, approval: &Value, delay_ms: u64) -> Value {
    let mut value = spec(cwd, "shared", Some(retry(3, delay_ms)));
    value["precheckId"] = approval["id"].clone();
    value
}

fn count(directory: &Path) -> Result<u64> {
    serde_json::from_slice::<Value>(&std::fs::read(directory.join("counter.json"))?)?["count"]
        .as_u64()
        .context("Actual command execution counter")
}

fn checked_record(record: &Value, approval: &Value, ordinal: u64, state: &str) -> Result<()> {
    assert_eq!(record["approvalId"], approval["id"]);
    assert_eq!(record["approvalDigest"], approval["digest"]);
    assert_eq!(record["state"], state);
    if ordinal == 1 {
        assert!(
            record.get("approvalRevision").is_none(),
            "Legacy record shape"
        );
    } else {
        assert_eq!(record["approvalRevision"], approval["revision"]);
    }
    let authorized = record["authorizedAt"]
        .as_i64()
        .context("Fresh authorization")?;
    let observed = record["observedAt"]
        .as_i64()
        .context("Command observation")?;
    assert!(observed >= authorized);
    if state == "passed" || state == "skipped" {
        let finished = record["finishedAt"].as_i64().context("Command outcome")?;
        assert!(finished >= authorized);
        assert_eq!(record["result"]["commandStarted"], true);
        assert_eq!(record["result"]["cleanupConfirmed"], true);
    }
    Ok(())
}

async fn wait_for(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    wanted: &str,
    ordinal: u64,
    bound: Duration,
) -> Result<Value> {
    let mut last = Value::Null;
    let mut report_file_cause = String::new();
    let observed = timeout(bound, async {
        loop {
            last = occurrence(owner, job, id).await?;
            if let Some(divergence) = diverged(&last["data"]["occurrence"], wanted, ordinal) {
                anyhow::bail!(divergence);
            }
            let phase_matches = last["data"]["occurrence"]["state"] == wanted
                && last["data"]["occurrence"]["jobAttemptOrdinal"] == ordinal;
            let report_ready = if wanted != "needsValidation" {
                true
            } else if phase_matches {
                let session = last["data"]["occurrence"]["sessionId"]
                    .as_str()
                    .context("Reported generation must retain its native session ID")?;
                let path = fixture
                    .directory
                    .join("callers")
                    .join(format!("{session}.result.json"));
                match std::fs::read(&path) {
                    Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                        Ok(report)
                            if report["data"]["attempt"]["id"]
                                == last["data"]["occurrence"]["attemptId"] =>
                        {
                            true
                        }
                        Ok(report) => {
                            report_file_cause = format!(
                                "{}: report attempt {} differs from current attempt {}",
                                path.display(),
                                report["data"]["attempt"]["id"],
                                last["data"]["occurrence"]["attemptId"]
                            );
                            false
                        }
                        Err(error) => {
                            report_file_cause = format!("{}: {error}", path.display());
                            false
                        }
                    },
                    Err(error) => {
                        report_file_cause = format!("{}: {error}", path.display());
                        false
                    }
                }
            } else {
                false
            };
            if phase_matches && report_ready {
                return Ok::<_, anyhow::Error>(last.clone());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await;
    match observed {
        Ok(Ok(view)) => Ok(view),
        result => {
            let diagnostics = job_diagnostics::report_timeout_diagnostics(fixture, job).await;
            anyhow::bail!(
                "Fresh precheck did not reach {wanted}/{ordinal} in {}s; result: {result:?}; last: {last}; report file cause: {report_file_cause}; actual diagnostics: {}",
                bound.as_secs(),
                diagnostics
                    .to_string()
                    .chars()
                    .take(16384)
                    .collect::<String>()
            )
        }
    }
}

async fn parity(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    first: &Value,
    current: &Value,
) -> Result<Vec<Value>> {
    let first_id = first["data"]["jobAttempt"]["id"]
        .as_str()
        .context("Old generation")?;
    let current_id = current["data"]["occurrence"]["jobAttemptId"]
        .as_str()
        .context("Current generation")?;
    let old = detail(owner, job, id, &json!(first_id)).await?;
    assert_eq!(
        serde_json::to_vec(&old["data"])?,
        serde_json::to_vec(&first["data"])?
    );
    let latest = detail(owner, job, id, &json!(current_id)).await?;
    assert_eq!(
        latest["data"]["jobAttempt"]["precheck"],
        current["data"]["occurrence"]["precheck"]
    );
    let old_cli =
        budgets::owner_cli(fixture, &["job", "attempt", job, id, first_id, "--json"]).await?;
    assert_eq!(old_cli["data"], first["data"]);
    let latest_cli =
        budgets::owner_cli(fixture, &["job", "attempt", job, id, current_id, "--json"]).await?;
    assert_eq!(latest_cli["data"], latest["data"]);
    let current_cli =
        budgets::owner_cli(fixture, &["job", "occurrence", job, id, "--json"]).await?;
    assert_eq!(current_cli["data"], current["data"]);
    let journal = generations(owner, job, id).await?;
    let journal_cli = budgets::owner_cli(fixture, &["job", "attempts", job, id, "--json"]).await?;
    assert_eq!(journal_cli["data"], journal["data"]);
    let rows = journal["data"]["jobAttempts"]
        .as_array()
        .context("Generation command journal")?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], current_id);
    assert_eq!(rows[1]["id"], first_id);
    assert_eq!(
        rows[0]["precheck"]["authorizedAt"],
        latest["data"]["jobAttempt"]["precheck"]["authorizedAt"]
    );
    assert_eq!(
        rows[1]["precheck"]["authorizedAt"],
        first["data"]["jobAttempt"]["precheck"]["authorizedAt"]
    );
    let history = data(call(owner, "nesvo_get_job_history", json!({"jobId":job})).await?)?;
    let history_cli = budgets::owner_cli(fixture, &["job", "history", job, "--json"]).await?;
    assert_eq!(history_cli["data"], history["data"]);
    assert_eq!(
        history["data"]["occurrences"][0]["jobAttemptId"],
        current_id
    );
    assert_eq!(
        history["data"]["occurrences"][0]["precheck"]["authorizedAt"],
        current["data"]["occurrence"]["precheck"]["authorizedAt"]
    );
    let quiet = occurrence(owner, job, id).await?;
    assert_eq!(
        quiet["data"], current["data"],
        "Reads retain all command timestamps"
    );
    Ok(vec![
        old,
        latest,
        old_cli,
        latest_cli,
        current_cli,
        journal,
        journal_cli,
        history,
        history_cli,
        quiet,
    ])
}

async fn replay_admission(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    key: &str,
    admitted: &Value,
) -> Result<Vec<Value>> {
    let mutation =
        budgets::owner_cli(fixture, &["job", "mutation", "--key", key, "--json"]).await?;
    let replay = data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({"key":key,"jobId":job,"expectedRevision":1}),
        )
        .await?,
    )?;
    assert_eq!(
        serde_json::to_vec(&mutation["data"])?,
        serde_json::to_vec(&admitted["data"])?
    );
    assert_eq!(replay["data"], admitted["data"]);
    Ok(vec![mutation, replay])
}

#[tokio::test]
#[ignore = "native SDK/CLI/host and controlled Node commands/workers; fresh precheck on explicit retry, no models"]
async fn retry_generation_runs_a_fresh_approved_command_before_one_controlled_worker() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let (approval, directory, mut envelopes) =
            approve(&fixture, &owner, "generation-pass", None).await?;
        let cwd = fixture.directory.join("worker-after-second-check");
        assert!(!cwd.exists());
        let key = "native-command-generations";
        let (created, admitted) =
            admit(&fixture, &owner, key, checked_spec(&cwd, &approval, 4000)).await?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Checked retry job")?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Checked retry occurrence")?;
        let waiting = wait_for(
            &mut fixture,
            &owner,
            job,
            id,
            "retryWaiting",
            1,
            FIRST_GENERATION_BOUND,
        )
        .await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 4000)?;
        checked_record(&first["precheck"], &approval, 1, "passed")?;
        assert_eq!(count(&directory)?, 1);
        let old = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        assert_eq!(old["data"]["jobAttempt"]["precheck"], first["precheck"]);
        envelopes.push(no_workers(&fixture, &owner).await?);
        envelopes.extend(launch_evidence(&owner, first, "failed").await?);
        let old_key = format!("job:{job}:{id}:run");
        let old_mutation =
            budgets::owner_cli(&fixture, &["run", "mutation", "--key", &old_key, "--json"]).await?;
        assert_eq!(old_mutation["data"]["run"]["id"], first["runId"]);
        ensure!(
            now_ms() < due,
            "Repair owned worker cwd before its original retry deadline"
        );
        std::fs::create_dir(&cwd)?;
        let reported = wait_for(
            &mut fixture,
            &owner,
            job,
            id,
            "needsValidation",
            2,
            reported_bound(4000),
        )
        .await?;
        let second = &reported["data"]["occurrence"];
        checked_record(&second["precheck"], &approval, 2, "passed")?;
        assert_eq!(count(&directory)?, 2);
        assert!(
            second["precheck"]["authorizedAt"]
                .as_i64()
                .context("Second authorization")?
                >= due
        );
        for field in ["authorizedAt", "observedAt", "finishedAt"] {
            assert!(
                second["precheck"][field].as_i64() > first["precheck"][field].as_i64(),
                "Fresh generation timestamp: {field}"
            );
        }
        for field in [
            "jobAttemptId",
            "runId",
            "attemptId",
            "launchReceiptId",
            "sessionId",
        ] {
            assert!(first[field].is_string() && second[field].is_string());
            assert_ne!(
                first[field], second[field],
                "Fresh native generation identity: {field}"
            );
        }
        assert!(second["retry"].is_null());
        envelopes.extend(launch_evidence(&owner, second, "created").await?);
        envelopes.extend(parity(&fixture, &owner, job, id, &old, &reported).await?);
        envelopes.extend(replay_admission(&fixture, &owner, job, key, &admitted).await?);
        let retained_mutation =
            budgets::owner_cli(&fixture, &["run", "mutation", "--key", &old_key, "--json"]).await?;
        assert_eq!(retained_mutation["data"], old_mutation["data"]);
        let new_key = format!("job:{job}:{id}:attempt:2:run");
        let new_mutation =
            budgets::owner_cli(&fixture, &["run", "mutation", "--key", &new_key, "--json"]).await?;
        assert_eq!(new_mutation["data"]["run"]["id"], second["runId"]);
        let worker = second["sessionId"]
            .as_str()
            .context("One checked native worker")?;
        let report: Value = serde_json::from_slice(&std::fs::read(
            fixture
                .directory
                .join("callers")
                .join(format!("{worker}.result.json")),
        )?)?;
        assert_eq!(report["data"]["attempt"]["id"], second["attemptId"]);
        assert_eq!(launched_workers(&fixture)?, 1);
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(
            sessions["data"]["sessions"]
                .as_array()
                .context("One native worker")?
                .len(),
            1
        );
        let runs = data(call(&owner, "nesvo_list_runs", json!({})).await?)?;
        assert_eq!(
            runs["data"]["runs"]
                .as_array()
                .context("One Run per generation")?
                .len(),
            2
        );
        envelopes.extend(vec![
            created.clone(),
            admitted.clone(),
            waiting.clone(),
            old,
            reported.clone(),
            old_mutation,
            retained_mutation,
            new_mutation,
            report,
            sessions,
            runs,
        ]);
        run_checkpoints::schema(envelopes).await?;
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

#[tokio::test]
#[ignore = "native SDK/CLI/host and owned Node prechecks; second-command skip and revoked waiting retry never start a worker"]
async fn retry_generation_does_not_reuse_the_old_pass_after_skip_or_revocation() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let (approval, directory, mut envelopes) =
            approve(&fixture, &owner, "generation-skip", None).await?;
        let cwd = fixture.directory.join("worker-for-skipped-generation");
        let key = "native-second-command-skip";
        let (created, admitted) =
            admit(&fixture, &owner, key, checked_spec(&cwd, &approval, 3000)).await?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Second skip job")?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Second skip occurrence")?;
        let waiting = wait_for(
            &mut fixture,
            &owner,
            job,
            id,
            "retryWaiting",
            1,
            FIRST_GENERATION_BOUND,
        )
        .await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 3000)?;
        checked_record(&first["precheck"], &approval, 1, "passed")?;
        let old = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        assert_eq!(count(&directory)?, 1);
        ensure!(
            now_ms() < due,
            "Repair skipped worker cwd before the fixed retry deadline"
        );
        std::fs::create_dir(&cwd)?;
        let skipped = wait_for(
            &mut fixture,
            &owner,
            job,
            id,
            "skipped",
            2,
            next_precheck_bound(3000),
        )
        .await?;
        let second = &skipped["data"]["occurrence"];
        checked_record(&second["precheck"], &approval, 2, "skipped")?;
        assert_eq!(second["reason"], "precheck_skip");
        assert_eq!(second["precheck"]["result"]["exitCode"], 10);
        assert_ne!(second["jobAttemptId"], first["jobAttemptId"]);
        assert!(
            second["precheck"]["authorizedAt"].as_i64() > first["precheck"]["finishedAt"].as_i64()
        );
        for field in [
            "runId",
            "attemptId",
            "launchReceiptId",
            "sessionId",
            "retry",
        ] {
            assert!(
                second[field].is_null(),
                "A previous pass must not release a skipped generation: {field}"
            );
        }
        assert_eq!(count(&directory)?, 2);
        envelopes.extend(parity(&fixture, &owner, job, id, &old, &skipped).await?);
        envelopes.extend(replay_admission(&fixture, &owner, job, key, &admitted).await?);
        envelopes.extend(launch_evidence(&owner, first, "failed").await?);

        let (revocable, revoked_directory, approvals) =
            approve(&fixture, &owner, "generation-pass", None).await?;
        envelopes.extend(approvals);
        let revoked_cwd = fixture.directory.join("worker-for-revoked-generation");
        let revoked_key = "native-revoked-waiting-precheck";
        let (revoked_job, revoked_admission) = admit(
            &fixture,
            &owner,
            revoked_key,
            checked_spec(&revoked_cwd, &revocable, 4000),
        )
        .await?;
        let revoked_job_id = revoked_job["data"]["job"]["id"]
            .as_str()
            .context("Revoked job")?;
        let revoked_id = revoked_admission["data"]["occurrence"]["id"]
            .as_str()
            .context("Revoked occurrence")?;
        let before = wait_for(
            &mut fixture,
            &owner,
            revoked_job_id,
            revoked_id,
            "retryWaiting",
            1,
            FIRST_GENERATION_BOUND,
        )
        .await?;
        let source = &before["data"]["occurrence"];
        let revoked_due = deadline(source, 4000)?;
        checked_record(&source["precheck"], &revocable, 1, "passed")?;
        let source_detail =
            detail(&owner, revoked_job_id, revoked_id, &source["jobAttemptId"]).await?;
        let approval_id = revocable["id"].as_str().context("Revoked approval")?;
        let revoked = budgets::owner_cli(
            &fixture,
            &[
                "job",
                "precheck",
                "revoke",
                approval_id,
                "--key",
                "revoke-before-next-command",
                "--revision",
                "1",
                "--json",
            ],
        )
        .await?;
        let revoked_replay = data(
            call(
                &owner,
                "nesvo_revoke_precheck",
                json!({"key":"revoke-before-next-command","id":approval_id,"expectedRevision":1}),
            )
            .await?,
        )?;
        assert_eq!(revoked_replay["data"], revoked["data"]);
        ensure!(
            now_ms() < revoked_due,
            "Revoke before the fixed fresh-command admission deadline"
        );
        std::fs::create_dir(&revoked_cwd)?;
        let blocked = wait_for(
            &mut fixture,
            &owner,
            revoked_job_id,
            revoked_id,
            "reconcile",
            1,
            next_generation_bound(4000),
        )
        .await?;
        assert_eq!(
            blocked["data"]["occurrence"]["jobAttemptId"],
            source["jobAttemptId"]
        );
        assert_eq!(blocked["data"]["occurrence"]["retry"], source["retry"]);
        assert_eq!(
            blocked["data"]["occurrence"]["precheck"],
            source["precheck"]
        );
        assert_eq!(
            count(&revoked_directory)?,
            1,
            "Revocation must not execute the command again"
        );
        let retained = detail(&owner, revoked_job_id, revoked_id, &source["jobAttemptId"]).await?;
        assert_eq!(retained["data"], source_detail["data"]);
        let journal = generations(&owner, revoked_job_id, revoked_id).await?;
        assert_eq!(
            journal["data"]["jobAttempts"]
                .as_array()
                .context("No refused retry generation")?
                .len(),
            1
        );
        envelopes.extend(
            replay_admission(
                &fixture,
                &owner,
                revoked_job_id,
                revoked_key,
                &revoked_admission,
            )
            .await?,
        );
        // The terminal skip remains terminal beyond another full configured
        // delay while the independent revoked retry is checked.
        let still_skipped = occurrence(&owner, job, id).await?;
        assert_eq!(still_skipped["data"], skipped["data"]);
        assert_eq!(count(&directory)?, 2);
        envelopes.push(no_workers(&fixture, &owner).await?);
        envelopes.extend(vec![
            created.clone(),
            admitted.clone(),
            waiting.clone(),
            old,
            skipped,
            revoked_job.clone(),
            revoked_admission.clone(),
            before.clone(),
            source_detail,
            revoked,
            revoked_replay,
            blocked,
            retained,
            journal,
            still_skipped,
        ]);
        run_checkpoints::schema(envelopes).await?;
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

async fn tree_ready(fixture: &mut Fixture, job: &str, tree: &mut OwnedTree) -> Result<()> {
    let result = timeout(Duration::from_millis(PRECHECK_BOUND_MS), tree.announced()).await;
    if !matches!(result, Ok(Ok(()))) {
        let diagnostics = job_diagnostics::report_timeout_diagnostics(fixture, job).await;
        anyhow::bail!(
            "Second-generation owned tree did not start: {result:?}; diagnostics: {diagnostics}"
        );
    }
    Ok(())
}

async fn tree_gone(fixture: &mut Fixture, job: &str, tree: &mut OwnedTree) -> Result<()> {
    let result = timeout(TREE_EXIT_DEADLINE, tree.exited()).await;
    if !matches!(result, Ok(Ok(()))) {
        let diagnostics = job_diagnostics::report_timeout_diagnostics(fixture, job).await;
        anyhow::bail!(
            "Second-generation tree cleanup was not observed: {result:?}; diagnostics: {diagnostics}"
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "native SDK/CLI/host and owned second-generation command descendants; cancellation, restart and exact unknown abandon, no models"]
async fn second_precheck_cleanup_and_abandon_are_bound_to_the_exact_generation() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let mut tree = OwnedTree::bind().await?;
        let (approval, directory, mut envelopes) = approve(&fixture, &owner, "generation-tree-cancel", Some(&tree)).await?;
        let cwd = fixture.directory.join("worker-never-starts-after-cancel");
        let key = "native-cancel-second-command";
        let (created, admitted) = admit(&fixture, &owner, key, checked_spec(&cwd, &approval, 3000)).await?;
        let job = created["data"]["job"]["id"].as_str().context("Canceled second-command job")?;
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Canceled second-command occurrence")?;
        let waiting = wait_for(&mut fixture, &owner, job, id, "retryWaiting", 1, FIRST_GENERATION_BOUND).await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 3000)?;
        let old = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        checked_record(&first["precheck"], &approval, 1, "passed")?;
        ensure!(now_ms() < due, "Repair cancel worker cwd before its fixed deadline");
        std::fs::create_dir(&cwd)?;
        let active = wait_for(&mut fixture, &owner, job, id, "prechecking", 2, next_generation_bound(3000)).await?;
        let second = &active["data"]["occurrence"];
        checked_record(&second["precheck"], &approval, 2, "running")?;
        assert_ne!(second["jobAttemptId"], first["jobAttemptId"]);
        assert!(second["runId"].is_null());
        tree_ready(&mut fixture, job, &mut tree).await?;
        assert_eq!(count(&directory)?, 2);
        envelopes.push(no_workers(&fixture, &owner).await?);
        let cancellation_args = json!({"key":"cancel-fresh-command","jobId":job,"occurrenceId":id});
        let canceling = data(call(&owner, "nesvo_cancel_job_occurrence", cancellation_args.clone()).await?)?;
        assert_eq!(canceling["data"]["occurrence"]["state"], "canceling");
        assert_eq!(canceling["data"]["occurrence"]["cancellation"]["state"], "awaitingPrecheck");
        assert_eq!(canceling["data"]["occurrence"]["jobAttemptId"], second["jobAttemptId"]);
        let canceled = wait_for(&mut fixture, &owner, job, id, "canceled", 2, CANCEL_CLEANUP_BOUND).await?;
        assert_eq!(canceled["data"]["occurrence"]["cancellation"]["state"], "completed");
        assert_eq!(canceled["data"]["occurrence"]["precheck"]["result"]["cleanupConfirmed"], true);
        assert!(canceled["data"]["occurrence"]["precheck"]["result"]["commandStarted"].is_null());
        assert_eq!(canceled["data"]["occurrence"]["precheck"]["result"]["reason"], "owner_canceled");
        assert!(canceled["data"]["occurrence"]["runId"].is_null());
        tree_gone(&mut fixture, job, &mut tree).await?;
        let cancel_replay = budgets::owner_cli(&fixture, &["job", "cancel", job, id, "--key", "cancel-fresh-command", "--json"]).await?;
        assert_eq!(cancel_replay["data"], canceling["data"]);
        envelopes.extend(parity(&fixture, &owner, job, id, &old, &canceled).await?);
        envelopes.extend(replay_admission(&fixture, &owner, job, key, &admitted).await?);

        let mut crash_tree = OwnedTree::bind().await?;
        let (crash_approval, crash_directory, approvals) = approve(&fixture, &owner, "generation-tree-crash", Some(&crash_tree)).await?;
        envelopes.extend(approvals);
        let crash_cwd = fixture.directory.join("worker-never-starts-after-crash");
        let crash_key = "native-restart-second-command";
        let (crash_job, crash_admission) = admit(&fixture, &owner, crash_key, checked_spec(&crash_cwd, &crash_approval, 3000)).await?;
        let crash_job_id = crash_job["data"]["job"]["id"].as_str().context("Crashed second-command job")?;
        let crash_id = crash_admission["data"]["occurrence"]["id"].as_str().context("Crashed second-command occurrence")?;
        let before = wait_for(&mut fixture, &owner, crash_job_id, crash_id, "retryWaiting", 1, FIRST_GENERATION_BOUND).await?;
        let source = &before["data"]["occurrence"];
        let crash_due = deadline(source, 3000)?;
        let source_detail = detail(&owner, crash_job_id, crash_id, &source["jobAttemptId"]).await?;
        ensure!(now_ms() < crash_due, "Repair crash worker cwd before its fixed deadline");
        std::fs::create_dir(&crash_cwd)?;
        let running = wait_for(&mut fixture, &owner, crash_job_id, crash_id, "prechecking", 2, next_generation_bound(3000)).await?;
        let target = running["data"]["occurrence"]["jobAttemptId"].as_str().context("Exact unknown second generation")?;
        tree_ready(&mut fixture, crash_job_id, &mut crash_tree).await?;
        assert_eq!(count(&crash_directory)?, 2);
        owner.cancel().await?;
        fixture.restart(true).await?;
        let owner = client(&fixture.pairing()).await?;
        let unknown = wait_for(&mut fixture, &owner, crash_job_id, crash_id, "reconcile", 2, RESTART_RECONCILE_BOUND).await?;
        assert_eq!(unknown["data"]["occurrence"]["jobAttemptId"], target);
        checked_record(&unknown["data"]["occurrence"]["precheck"], &crash_approval, 2, "unknown")?;
        assert!(unknown["data"]["occurrence"]["precheck"]["finishedAt"].is_null());
        assert!(unknown["data"]["occurrence"]["runId"].is_null());
        tree_gone(&mut fixture, crash_job_id, &mut crash_tree).await?;
        let intent = json!({"key":"abandon-exact-second-command","jobId":crash_job_id,"occurrenceId":crash_id,"expectedDigest":crash_approval["digest"],"acknowledgeUnknownEffects":true});
        for job_attempt_id in [None, Some(source["jobAttemptId"].clone())] {
            let mut wrong = intent.clone();
            if let Some(job_attempt_id) = job_attempt_id { wrong["jobAttemptId"] = job_attempt_id; }
            let reply = call(&owner, "nesvo_abandon_job_precheck", wrong).await?;
            assert_eq!(reply.is_error, Some(true), "Omitted/old generation cannot acknowledge a new command");
            envelopes.push(reply.structured_content.context("Exact generation abandon refusal")?);
            assert_eq!(occurrence(&owner, crash_job_id, crash_id).await?["data"], unknown["data"]);
        }
        let digest = crash_approval["digest"].as_str().context("Unknown command digest")?;
        let abandoned = budgets::owner_cli(&fixture, &["job", "abandon-precheck", crash_job_id, crash_id, "--key", "abandon-exact-second-command", "--digest", digest, "--job-attempt-id", target, "--acknowledge-unknown-effects", "--json"]).await?;
        assert_eq!(abandoned["data"]["occurrence"]["state"], "canceled");
        assert_eq!(abandoned["data"]["occurrence"]["precheck"]["state"], "abandoned");
        let mut exact = intent.clone();
        exact["jobAttemptId"] = json!(target);
        let abandon_replay = data(call(&owner, "nesvo_abandon_job_precheck", exact.clone()).await?)?;
        assert_eq!(abandon_replay["data"], abandoned["data"]);
        let altered = call(&owner, "nesvo_abandon_job_precheck", intent).await?.structured_content.context("Immutable abandon request fingerprint")?;
        assert_eq!(altered["error"]["code"], "idempotency_conflict");
        let retained = detail(&owner, crash_job_id, crash_id, &source["jobAttemptId"]).await?;
        assert_eq!(serde_json::to_vec(&retained["data"])?, serde_json::to_vec(&source_detail["data"])?);
        envelopes.extend(replay_admission(&fixture, &owner, crash_job_id, crash_key, &crash_admission).await?);
        let final_canceled = occurrence(&owner, job, id).await?;
        assert_eq!(final_canceled["data"], canceled["data"]);
        let cancel_after_restart = data(call(&owner, "nesvo_cancel_job_occurrence", cancellation_args).await?)?;
        assert_eq!(cancel_after_restart["data"], canceling["data"]);
        assert_eq!(count(&directory)?, 2);
        assert_eq!(count(&crash_directory)?, 2);
        envelopes.push(no_workers(&fixture, &owner).await?);
        envelopes.extend(parity(&fixture, &owner, crash_job_id, crash_id, &source_detail, &abandoned).await?);
        envelopes.extend(vec![created.clone(), admitted.clone(), waiting.clone(), old, active.clone(), canceling, canceled, cancel_replay, crash_job.clone(), crash_admission.clone(), before.clone(), source_detail, running.clone(), unknown, abandoned, abandon_replay, altered, retained, final_canceled, cancel_after_restart]);
        run_checkpoints::schema(envelopes).await?;
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
