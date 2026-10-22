//! Opted-in retry uses genuine native launch receipts and controlled Node PTYs.
use super::*;

#[path = "job_retry_prechecks.rs"]
mod precheck_generations;

fn retry(max_attempts: u64, delay_ms: u64) -> Value {
    json!({"on":"launchNoEffect","maxAttempts":max_attempts,"initialDelayMs":delay_ms,"maxDelayMs":delay_ms})
}

fn spec(cwd: &Path, workspace: &str, retry: Option<Value>) -> Value {
    let mut spec = json!({
        "title":"Controlled native job retry","instruction":"report-task",
        "profile":{"program":"claude","workspace":workspace,"cwd":cwd,"harness":true,
            "allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}
    });
    if let Some(retry) = retry {
        spec["retry"] = retry;
    }
    spec
}

async fn owned_git(repository: &Path, args: &[&str]) -> Result<()> {
    let mut command = Command::new("git");
    command
        .current_dir(repository)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .await
        .context("Owned Git fixture command")?;
    ensure!(
        output.status.success(),
        "Owned Git fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1024)
            .collect::<String>()
    );
    Ok(())
}

pub(super) async fn repository_whose_worktree_checkout_fails(fixture: &Fixture) -> Result<PathBuf> {
    let source = fixture.directory.join("uncertain-checkout");
    std::fs::create_dir(&source)?;
    std::fs::write(
        source.join(".gitattributes"),
        "blob.txt filter=nesvoFailedCheckout\n",
    )?;
    std::fs::write(source.join("blob.txt"), "owned checkout input\n")?;
    for args in [
        &["init", "--quiet"][..],
        &["config", "--local", "core.autocrlf", "false"],
        &["add", "--", ".gitattributes", "blob.txt"],
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "--quiet",
            "-m",
            "owned fixture source",
        ],
        &[
            "config",
            "--local",
            "filter.nesvoFailedCheckout.smudge",
            "false",
        ],
        &[
            "config",
            "--local",
            "filter.nesvoFailedCheckout.required",
            "true",
        ],
    ] {
        owned_git(&source, args).await?;
    }
    Ok(source)
}

async fn ready(fixture: &Fixture) -> Result<()> {
    waits::provider(fixture, "claude")
        .await
        .context("Controlled provider discovery before retry acceptance")?;
    Ok(())
}

async fn admit(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    key: &str,
    spec: Value,
) -> Result<(Value, Value)> {
    let created = data(
        call(
            owner,
            "nesvo_create_job",
            json!({"key":format!("{key}:definition"),"spec":spec}),
        )
        .await?,
    )?;
    let job = created["data"]["job"]["id"]
        .as_str()
        .context("Retry job ID")?;
    let admitted = budgets::owner_cli(
        fixture,
        &[
            "job",
            "run-now",
            job,
            "--key",
            key,
            "--revision",
            "1",
            "--json",
        ],
    )
    .await?;
    Ok((created, admitted))
}

async fn occurrence(owner: &RunningService<RoleClient, ()>, job: &str, id: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_occurrence",
            json!({"jobId":job,"occurrenceId":id}),
        )
        .await?,
    )
}

async fn state(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    description: &str,
    wanted: impl Fn(&Value) -> bool,
    observation: &mut job_diagnostics::RetryWaitObservation,
    started: tokio::time::Instant,
) -> Result<Value> {
    let reached = waits::until(async || {
        observation.started(started.elapsed());
        let response = occurrence(owner, job, id).await;
        match &response {
            Ok(view) => observation.completed(view, started.elapsed()),
            Err(_) => observation.failed(),
        }
        let view = response?;
        if wanted(&view["data"]["occurrence"]) {
            return Ok(Some(view));
        }
        ensure!(
            !waits::is_settled_occurrence(&view["data"]["occurrence"]["state"]),
            "Native retry occurrence settled first"
        );
        Ok(None)
    })
    .await;
    reached.with_context(|| {
        format!(
            "Native retry occurrence did not reach {description}; progress: {}",
            observation.summary(started.elapsed())
        )
    })
}

async fn generations(owner: &RunningService<RoleClient, ()>, job: &str, id: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_attempts",
            json!({"jobId":job,"occurrenceId":id}),
        )
        .await?,
    )
}

async fn state_with_diagnostics(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    wanted: &str,
    ordinal: u64,
) -> Result<Value> {
    observed_with_diagnostics(
        fixture,
        owner,
        job,
        id,
        &format!("{wanted}/{ordinal}"),
        |current| current["state"] == wanted && current["jobAttemptOrdinal"] == ordinal,
    )
    .await
}

async fn observed_with_diagnostics(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    description: &str,
    wanted: impl Fn(&Value) -> bool,
) -> Result<Value> {
    let mut observation = job_diagnostics::RetryWaitObservation::new(job, id);
    let started = tokio::time::Instant::now();
    match state(
        owner,
        job,
        id,
        description,
        wanted,
        &mut observation,
        started,
    )
    .await
    {
        Ok(view) => Ok(view),
        Err(error) => {
            let diagnostics = job_diagnostics::retry_timeout_diagnostics(
                fixture,
                owner,
                &observation,
                started.elapsed(),
            )
            .await;
            Err(error.context(format!(
                "Bounded actual retry diagnostics: {}",
                diagnostics
                    .to_string()
                    .chars()
                    .take(16384)
                    .collect::<String>()
            )))
        }
    }
}

async fn detail(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    generation: &Value,
) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_attempt",
            json!({"jobId":job,"occurrenceId":id,"jobAttemptId":generation}),
        )
        .await?,
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn deadline(current: &Value, delay_ms: i64) -> Result<i64> {
    let retry = &current["retry"];
    let decided = retry["decidedAt"]
        .as_i64()
        .context("Immutable retry decision time")?;
    let due = retry["notBefore"]
        .as_i64()
        .context("Immutable retry deadline")?;
    assert_eq!(due - decided, delay_ms);
    assert_eq!(retry["jobAttemptId"], current["jobAttemptId"]);
    assert_eq!(retry["attemptId"], current["attemptId"]);
    assert_eq!(retry["launchReceiptId"], current["launchReceiptId"]);
    assert_eq!(retry["nextOrdinal"], 2);
    Ok(due)
}

fn launched_workers(fixture: &Fixture) -> Result<usize> {
    Ok(std::fs::read_dir(fixture.directory.join("callers"))?
        .collect::<std::io::Result<Vec<_>>>()?
        .iter()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".launch-argv.json")
        })
        .count())
}

async fn no_workers(fixture: &Fixture, owner: &RunningService<RoleClient, ()>) -> Result<Value> {
    let sessions = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    assert!(
        sessions["data"]["sessions"]
            .as_array()
            .context("No native workers")?
            .is_empty()
    );
    assert_eq!(
        launched_workers(fixture)?,
        0,
        "No controlled process was started"
    );
    Ok(sessions)
}

async fn launch_evidence(
    owner: &RunningService<RoleClient, ()>,
    current: &Value,
    phase: &str,
) -> Result<Vec<Value>> {
    let run = current["runId"].as_str().context("Native retry run")?;
    let view = data(call(owner, "nesvo_get_run", json!({"runId":run})).await?)?;
    let task = &view["data"]["tasks"][0];
    assert_eq!(task["currentAttempt"]["id"], current["attemptId"]);
    assert_eq!(
        task["attempts"], 1,
        "Each job generation owns one native attempt"
    );
    let native = data(
        call(
            owner,
            "nesvo_get_task_attempts",
            json!({"runId":run,"taskId":task["id"]}),
        )
        .await?,
    )?;
    let rows = native["data"]["attempts"]
        .as_array()
        .context("One linked native attempt")?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], current["attemptId"]);
    assert_eq!(rows[0]["sessionId"], current["sessionId"]);
    assert_eq!(rows[0]["launch"]["receiptId"], current["launchReceiptId"]);
    assert_eq!(rows[0]["launch"]["phase"], phase);
    let receipt = data(
        call(
            owner,
            "nesvo_get_operation",
            json!({"id":current["launchReceiptId"]}),
        )
        .await?,
    )?;
    assert_eq!(receipt["data"]["receipt"]["operation"], "create");
    assert_eq!(receipt["data"]["receipt"]["phase"], phase);
    assert_eq!(
        receipt["data"]["receipt"]["sessionId"],
        current["sessionId"]
    );
    if phase == "failed" {
        assert_eq!(rows[0]["state"], "launchFailed");
        assert_eq!(rows[0]["launch"]["effectStarted"].as_bool(), Some(false));
        assert_eq!(
            receipt["data"]["receipt"]["result"]["effectStarted"].as_bool(),
            Some(false)
        );
    } else if phase == "unknown" {
        assert_eq!(rows[0]["state"], "launchUnknown");
        assert_ne!(
            receipt["data"]["receipt"]["result"]["effectStarted"].as_bool(),
            Some(false)
        );
    }
    Ok(vec![view, native, receipt])
}

async fn fenced(
    owner: &RunningService<RoleClient, ()>,
    run: &str,
    key: &str,
    code: &str,
) -> Result<Value> {
    async {
        loop {
            let view = run_checkpoints::view(owner, run).await?;
            let reply = call(
                owner,
                "nesvo_enable_run_executor",
                json!({"key":key,"runId":run,"expectedRevision":view["run"]["revision"]}),
            )
            .await?;
            ensure!(
                reply.is_error == Some(true),
                "Retired job run accepted automated admission"
            );
            let refusal = reply
                .structured_content
                .context("Retired job run refusal")?;
            if refusal["error"]["code"] != "revision_conflict" {
                assert_eq!(refusal["error"]["code"], code);
                return Ok::<_, anyhow::Error>(refusal);
            }
        }
    }
    .await
    .context("Retired run fence must hold during backoff")
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and controlled Node PTY; genuine failed launch retry, no models"]
async fn opted_job_retry_waits_for_its_deadline_and_retains_the_failed_native_generation()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(25), async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let cwd = fixture.directory.join("retry-created-before-deadline");
        ensure!(
            !cwd.exists(),
            "The first native launch must encounter a missing owned cwd"
        );
        let (created, admitted) = admit(
            &fixture,
            &owner,
            "native-job-retry",
            spec(&cwd, "shared", Some(retry(3, 4000))),
        )
        .await?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Opted retry job")?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Opted retry occurrence")?;
        let waiting =
            state_with_diagnostics(&mut fixture, &owner, job, id, "retryWaiting", 1).await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 4000)?;
        let first_detail = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        assert_eq!(first_detail["data"]["jobAttempt"]["state"], "failed");
        assert_eq!(first_detail["data"]["jobAttempt"]["retry"], first["retry"]);
        assert!(first_detail["data"]["jobAttempt"]["finishedAt"].is_number());
        let mut envelopes = vec![no_workers(&fixture, &owner).await?];
        let old_run = first["runId"].as_str().context("Failed native run")?;
        envelopes.push(
            fenced(
                &owner,
                old_run,
                "no-rearm-during-job-backoff",
                "job_generation_retired",
            )
            .await?,
        );

        let stable = occurrence(&owner, job, id).await?;
        assert_eq!(
            stable["data"]["occurrence"]["retry"], first["retry"],
            "Reads never retime backoff"
        );
        assert_eq!(stable["data"]["occurrence"]["jobAttemptOrdinal"], 1);
        ensure!(
            now_ms() < due,
            "Native fixture must repair its cwd before the original deadline"
        );
        std::fs::create_dir(&cwd)?;

        let original_key = format!("job:{job}:{id}:run");
        let original_run = budgets::owner_cli(
            &fixture,
            &["run", "mutation", "--key", &original_key, "--json"],
        )
        .await?;
        assert_eq!(original_run["data"]["run"]["id"], old_run);
        while now_ms() < due - 60 {
            let early = occurrence(&owner, job, id).await?;
            if now_ms() >= due {
                break;
            }
            assert_eq!(
                early["data"]["occurrence"]["jobAttemptOrdinal"], 1,
                "No generation before notBefore"
            );
            assert_eq!(early["data"]["occurrence"]["retry"], first["retry"]);
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        let reported =
            state_with_diagnostics(&mut fixture, &owner, job, id, "needsValidation", 2).await?;
        let second = &reported["data"]["occurrence"];
        assert!(
            second["retry"].is_null(),
            "Current retry facts belong only to the failed generation"
        );
        for field in [
            "jobAttemptId",
            "runId",
            "attemptId",
            "launchReceiptId",
            "sessionId",
        ] {
            assert!(
                first[field].is_string() && second[field].is_string(),
                "Retain both reserved identities: {field}"
            );
            assert_ne!(
                first[field], second[field],
                "Retry requires a fresh {field}"
            );
        }
        let second_detail = detail(&owner, job, id, &second["jobAttemptId"]).await?;
        assert!(
            second_detail["data"]["jobAttempt"]["claimedAt"]
                .as_i64()
                .context("Retry claimed time")?
                >= due
        );
        assert_eq!(
            second_detail["data"]["jobAttempt"]["result"]["outcome"],
            "succeeded"
        );
        assert!(second_detail["data"]["jobAttempt"]["validation"].is_null());
        assert!(
            second_detail["data"]["jobAttempt"]["finishedAt"].is_null(),
            "A controlled report still needs validation"
        );
        envelopes.extend(launch_evidence(&owner, first, "failed").await?);
        envelopes.extend(launch_evidence(&owner, second, "created").await?);
        let unchanged = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        assert_eq!(
            unchanged["data"], first_detail["data"],
            "All failed generation details remain immutable"
        );
        let listed = generations(&owner, job, id).await?;
        let rows = listed["data"]["jobAttempts"]
            .as_array()
            .context("Both native generations")?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], second["jobAttemptId"]);
        assert!(rows[0]["retry"].is_null());
        assert_eq!(rows[1]["id"], first["jobAttemptId"]);
        assert_eq!(rows[1]["retry"], first["retry"]);
        let list_cli =
            budgets::owner_cli(&fixture, &["job", "attempts", job, id, "--json"]).await?;
        assert_eq!(list_cli["data"], listed["data"]);
        let first_id = first["jobAttemptId"]
            .as_str()
            .context("First generation identity")?;
        let detail_cli =
            budgets::owner_cli(&fixture, &["job", "attempt", job, id, first_id, "--json"]).await?;
        assert_eq!(detail_cli["data"], first_detail["data"]);
        let history = data(call(&owner, "nesvo_get_job_history", json!({"jobId":job})).await?)?;
        let history_cli = budgets::owner_cli(&fixture, &["job", "history", job, "--json"]).await?;
        assert_eq!(history_cli["data"], history["data"]);
        let original = data(
            call(
                &owner,
                "nesvo_get_job_mutation",
                json!({"key":"native-job-retry"}),
            )
            .await?,
        )?;
        let replay = data(
            call(
                &owner,
                "nesvo_run_job_now",
                json!({"key":"native-job-retry","jobId":job,"expectedRevision":1}),
            )
            .await?,
        )?;
        assert_eq!(original["data"], admitted["data"]);
        assert_eq!(replay["data"], admitted["data"]);
        let run_replay = budgets::owner_cli(
            &fixture,
            &["run", "mutation", "--key", &original_key, "--json"],
        )
        .await?;
        assert_eq!(
            run_replay["data"], original_run["data"],
            "Generation one mutation keys retain their original view"
        );
        let retry_key = format!("job:{job}:{id}:attempt:2:run");
        let retry_run = budgets::owner_cli(
            &fixture,
            &["run", "mutation", "--key", &retry_key, "--json"],
        )
        .await?;
        assert_eq!(retry_run["data"]["run"]["id"], second["runId"]);
        let worker = second["sessionId"]
            .as_str()
            .context("Controlled retry worker")?;
        observed_output(&owner, worker, "FIXTURE_RESPONSE report-task").await?;
        let output = data(
            call(
                &owner,
                "nesvo_read_session",
                json!({"sessionId":worker,"maxBytes":8192}),
            )
            .await?,
        )?;
        assert_eq!(
            output["data"]["page"]["data"]
                .as_str()
                .context("Controlled worker transcript")?
                .matches("FIXTURE_RESPONSE report-task")
                .count(),
            1
        );
        let report: Value = serde_json::from_slice(&std::fs::read(
            fixture
                .directory
                .join("callers")
                .join(format!("{worker}.result.json")),
        )?)?;
        assert_eq!(report["data"]["attempt"]["id"], second["attemptId"]);
        let mut progress = job_diagnostics::RetryWaitObservation::new(job, id);
        progress.started(Duration::ZERO);
        progress.completed(&reported, Duration::ZERO);
        let evidence = job_diagnostics::retry_timeout_diagnostics(
            &mut fixture,
            &owner,
            &progress,
            Duration::ZERO,
        )
        .await;
        assert_eq!(evidence["queries"]["run"], "observed");
        assert_eq!(evidence["queries"]["launchOperation"], "observed");
        assert_eq!(evidence["queries"]["explain"], "observed");
        assert_eq!(evidence["queries"]["nativeAttempt"], "observed");
        assert_eq!(
            evidence["wait"]["occurrence"]["sessionId"],
            second["sessionId"]
        );
        assert_eq!(evidence["launchOperation"]["id"], second["launchReceiptId"]);
        assert_eq!(evidence["launchOperation"]["phase"], "created");
        assert_eq!(evidence["session"]["sessionId"], second["sessionId"]);
        assert_eq!(evidence["attempt"]["id"], second["attemptId"]);
        assert_eq!(
            evidence["attempt"]["delivery"]["attemptId"],
            second["attemptId"]
        );
        assert!(evidence["attempt"]["delivery"]["receiptId"].is_string());
        assert!(evidence["attempt"]["delivery"]["phase"].is_string());
        assert_ne!(evidence["attempt"]["delivery"]["phase"], "other");
        assert_eq!(evidence["fixtureStages"]["reportInputPresent"], true);
        assert_eq!(evidence["stageFilesAreCompletionProof"], false);
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(
            sessions["data"]["sessions"]
                .as_array()
                .context("Exactly one physical worker")?
                .len(),
            1
        );
        assert_eq!(launched_workers(&fixture)?, 1);
        let runs = data(call(&owner, "nesvo_list_runs", json!({})).await?)?;
        assert_eq!(
            runs["data"]["runs"]
                .as_array()
                .context("Fresh native run per generation")?
                .len(),
            2
        );
        assert_eq!(owner.list_all_tools().await?.len(), published_tool_count());
        envelopes.extend(vec![
            created.clone(),
            admitted.clone(),
            waiting.clone(),
            first_detail.clone(),
            reported.clone(),
            second_detail,
            unchanged,
            listed,
            list_cli,
            detail_cli,
            history,
            history_cli,
            original,
            replay,
            original_run,
            run_replay,
            retry_run,
            output,
            report,
            sessions,
            runs,
        ]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native successful job retry scenario")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native CLI/MCP/host, Node and Git; default-off, attempt bound and genuine unknown worktree"]
async fn job_retry_stays_default_off_respects_its_attempt_bound_and_refuses_unknown_effects()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(30), async {
        ready(&fixture).await?;
        let mut git = Command::new("git");
        git.arg("-C")
            .arg(&fixture.directory)
            .args(["rev-parse", "--show-toplevel"])
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .kill_on_drop(true);
        #[cfg(windows)]
        git.creation_flags(0x08000000);
        ensure!(
            !git.output().await?.status.success(),
            "Refusing worktree fixture inside an inherited Git repository"
        );
        let owner = client(&fixture.pairing()).await?;
        let missing = fixture.directory.join("retry-always-absent");
        let uncertain = repository_whose_worktree_checkout_fails(&fixture).await?;
        let mut envelopes = Vec::new();
        let (bounded_job, bounded_admission) = admit(
            &fixture,
            &owner,
            "retry-bound-two",
            spec(&missing, "shared", Some(retry(2, 1000))),
        )
        .await?;
        let bounded = bounded_job["data"]["job"]["id"]
            .as_str()
            .context("Bounded job")?;
        let bounded_id = bounded_admission["data"]["occurrence"]["id"]
            .as_str()
            .context("Bounded occurrence")?;
        let first =
            state_with_diagnostics(&mut fixture, &owner, bounded, bounded_id, "retryWaiting", 1)
                .await?;
        let due = deadline(&first["data"]["occurrence"], 1000)?;
        let first_detail = detail(
            &owner,
            bounded,
            bounded_id,
            &first["data"]["occurrence"]["jobAttemptId"],
        )
        .await?;
        envelopes.extend(launch_evidence(&owner, &first["data"]["occurrence"], "failed").await?);

        let mut cases = Vec::new();
        for (key, workspace, policy, expected) in [
            ("retry-default-off", "shared", None, "failed"),
            ("retry-bound-one", "shared", Some(retry(1, 1000)), "failed"),
            (
                "retry-unknown-worktree",
                "worktree",
                Some(retry(3, 1000)),
                "reconcile",
            ),
        ] {
            let cwd = if workspace == "worktree" {
                &uncertain
            } else {
                &missing
            };
            let (created, admitted) =
                admit(&fixture, &owner, key, spec(cwd, workspace, policy)).await?;
            let job = created["data"]["job"]["id"]
                .as_str()
                .context("Negative retry job")?
                .to_owned();
            let id = admitted["data"]["occurrence"]["id"]
                .as_str()
                .context("Negative retry occurrence")?
                .to_owned();
            let current =
                state_with_diagnostics(&mut fixture, &owner, &job, &id, expected, 1).await?;
            assert!(current["data"]["occurrence"]["retry"].is_null());
            envelopes.extend(
                launch_evidence(
                    &owner,
                    &current["data"]["occurrence"],
                    if workspace == "worktree" {
                        "unknown"
                    } else {
                        "failed"
                    },
                )
                .await?,
            );
            cases.push((job, id, expected));
            envelopes.extend(vec![created, admitted, current]);
        }
        let terminal =
            state_with_diagnostics(&mut fixture, &owner, bounded, bounded_id, "failed", 2).await?;
        assert!(
            terminal["data"]["occurrence"]["retry"].is_null(),
            "The configured last generation cannot schedule another retry"
        );
        envelopes.extend(launch_evidence(&owner, &terminal["data"]["occurrence"], "failed").await?);
        let observed_until = now_ms().max(due) + 1300;
        while now_ms() < observed_until {
            for (job, id, expected) in &cases {
                let current = occurrence(&owner, job, id).await?;
                assert_eq!(current["data"]["occurrence"]["state"], *expected);
                assert_eq!(current["data"]["occurrence"]["jobAttemptOrdinal"], 1);
                assert!(current["data"]["occurrence"]["retry"].is_null());
            }
            let current = occurrence(&owner, bounded, bounded_id).await?;
            assert_eq!(current["data"]["occurrence"]["jobAttemptOrdinal"], 2);
            assert_eq!(current["data"]["occurrence"]["state"], "failed");
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        for (job, id, _) in &cases {
            let journal = generations(&owner, job, id).await?;
            assert_eq!(
                journal["data"]["jobAttempts"]
                    .as_array()
                    .context("No accidental retry generation")?
                    .len(),
                1
            );
            envelopes.push(journal);
        }
        let unchanged = detail(
            &owner,
            bounded,
            bounded_id,
            &first["data"]["occurrence"]["jobAttemptId"],
        )
        .await?;
        assert_eq!(unchanged["data"], first_detail["data"]);
        let journal = generations(&owner, bounded, bounded_id).await?;
        assert_eq!(
            journal["data"]["jobAttempts"]
                .as_array()
                .context("Exactly the configured attempt maximum")?
                .len(),
            2
        );
        envelopes.push(no_workers(&fixture, &owner).await?);
        envelopes.extend(vec![
            bounded_job.clone(),
            bounded_admission,
            first,
            first_detail,
            terminal,
            unchanged,
            journal,
        ]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded default-off, retry bound and unknown-effect scenarios")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and controlled Node worker; backoff cancellation and original-deadline restart"]
async fn waiting_job_retry_cancels_without_native_stop_and_restart_keeps_the_original_deadline()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(35), async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let canceled_cwd = fixture.directory.join("canceled-retry-must-never-launch");
        let resumed_cwd = fixture.directory.join("restart-retry-original-deadline");
        let (cancel_job, cancel_admitted) = admit(&fixture, &owner, "cancel-waiting-retry", spec(&canceled_cwd, "shared", Some(retry(3, 6000)))).await?;
        let cancel_job_id = cancel_job["data"]["job"]["id"].as_str().context("Canceled retry job")?;
        let cancel_id = cancel_admitted["data"]["occurrence"]["id"].as_str().context("Canceled retry occurrence")?;
        let cancel_waiting = state_with_diagnostics(&mut fixture, &owner, cancel_job_id, cancel_id, "retryWaiting", 1).await?;
        let cancel_due = deadline(&cancel_waiting["data"]["occurrence"], 6000)?;
        let canceled = data(call(&owner, "nesvo_cancel_job_occurrence", json!({"key":"cancel-owned-backoff","jobId":cancel_job_id,"occurrenceId":cancel_id})).await?)?;
        assert_eq!(canceled["data"]["occurrence"]["state"], "canceled");
        assert_eq!(canceled["data"]["occurrence"]["cancellation"]["state"], "completed");
        assert!(canceled["data"]["occurrence"]["cancellation"]["controlId"].is_null(), "No native stop is needed for proven no-effect backoff");
        let cancel_replay = budgets::owner_cli(&fixture, &["job", "cancel", cancel_job_id, cancel_id, "--key", "cancel-owned-backoff", "--json"]).await?;
        assert_eq!(cancel_replay["data"], canceled["data"]);
        std::fs::create_dir(&canceled_cwd)?;
        let mut envelopes = launch_evidence(&owner, &cancel_waiting["data"]["occurrence"], "failed").await?;
        let cancel_run = cancel_waiting["data"]["occurrence"]["runId"].as_str().context("Canceled backoff run")?;
        envelopes.push(fenced(&owner, cancel_run, "cancel-backoff-cannot-rearm", "job_canceled").await?);

        let (restart_job, restart_admitted) = admit(&fixture, &owner, "restart-waiting-retry", spec(&resumed_cwd, "shared", Some(retry(3, 8000)))).await?;
        let restart_job_id = restart_job["data"]["job"]["id"].as_str().context("Restart retry job")?;
        let restart_id = restart_admitted["data"]["occurrence"]["id"].as_str().context("Restart retry occurrence")?;
        let waiting = state_with_diagnostics(&mut fixture, &owner, restart_job_id, restart_id, "retryWaiting", 1).await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 8000)?;
        let first_detail = detail(&owner, restart_job_id, restart_id, &first["jobAttemptId"]).await?;
        envelopes.extend(launch_evidence(&owner, first, "failed").await?);
        envelopes.push(no_workers(&fixture, &owner).await?);
        owner.cancel().await?;
        ensure!(now_ms() < due, "Restart must begin during the original backoff");
        fixture.restart(false).await?;
        let owner = client(&fixture.pairing()).await?;
        ensure!(now_ms() < due, "Owned fixture restart must finish before the immutable deadline");
        let recovered = occurrence(&owner, restart_job_id, restart_id).await?;
        assert_eq!(recovered["data"]["occurrence"]["state"], "retryWaiting");
        assert_eq!(recovered["data"]["occurrence"]["retry"], first["retry"], "Restart cannot reset or shorten backoff");
        assert_eq!(recovered["data"]["occurrence"]["jobAttemptId"], first["jobAttemptId"]);
        let retained = detail(&owner, restart_job_id, restart_id, &first["jobAttemptId"]).await?;
        assert_eq!(retained["data"], first_detail["data"]);
        std::fs::create_dir(&resumed_cwd)?;
        let reported = state_with_diagnostics(&mut fixture, &owner, restart_job_id, restart_id, "needsValidation", 2).await?;
        let second = &reported["data"]["occurrence"];
        assert!(second["retry"].is_null());
        let second_detail = detail(&owner, restart_job_id, restart_id, &second["jobAttemptId"]).await?;
        assert!(second_detail["data"]["jobAttempt"]["claimedAt"].as_i64().context("Restart retry admission time")? >= due);
        for field in ["jobAttemptId", "runId", "attemptId", "launchReceiptId", "sessionId"] {
            assert_ne!(first[field], second[field], "Restart retry must create a fresh {field}");
        }
        assert!(now_ms() > cancel_due, "Cancellation must be observed beyond its former retry deadline");
        let canceled_after = occurrence(&owner, cancel_job_id, cancel_id).await?;
        assert_eq!(canceled_after["data"]["occurrence"]["state"], "canceled");
        assert_eq!(canceled_after["data"]["occurrence"]["cancellation"]["state"], "completed");
        assert!(canceled_after["data"]["occurrence"]["cancellation"]["controlId"].is_null());
        let canceled_journal = generations(&owner, cancel_job_id, cancel_id).await?;
        assert_eq!(canceled_journal["data"]["jobAttempts"].as_array().context("Canceled backoff never retries")?.len(), 1);
        let journal = generations(&owner, restart_job_id, restart_id).await?;
        assert_eq!(journal["data"]["jobAttempts"].as_array().context("Restart dispatches exactly one retry")?.len(), 2);
        let original = data(call(&owner, "nesvo_get_job_mutation", json!({"key":"restart-waiting-retry"})).await?)?;
        assert_eq!(original["data"], restart_admitted["data"]);
        let cancellation = data(call(&owner, "nesvo_get_job_mutation", json!({"key":"cancel-owned-backoff"})).await?)?;
        assert_eq!(cancellation["data"], canceled["data"]);
        let unchanged = detail(&owner, restart_job_id, restart_id, &first["jobAttemptId"]).await?;
        assert_eq!(unchanged["data"], first_detail["data"]);
        let worker = second["sessionId"].as_str().context("Restart controlled worker")?;
        observed_output(&owner, worker, "FIXTURE_RESPONSE report-task").await?;
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(sessions["data"]["sessions"].as_array().context("Only uncanceled retry starts a worker")?.len(), 1);
        assert_eq!(launched_workers(&fixture)?, 1);
        envelopes.extend(vec![cancel_job.clone(), cancel_admitted, cancel_waiting, canceled, cancel_replay, restart_job.clone(), restart_admitted.clone(), waiting.clone(), first_detail.clone(), recovered, retained, reported.clone(), second_detail, canceled_after, canceled_journal, journal, original, cancellation, unchanged, sessions]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded backoff cancellation and restart scenarios")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

const EXECUTOR_CAPACITY: usize = 16;

async fn occupied_executor(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    index: usize,
) -> Result<String> {
    let key = format!("executor-capacity-{index}");
    let created = data(
        call(
            owner,
            "nesvo_create_run",
            json!({"key":format!("{key}:run"),"spec":{"title":"Executor capacity","goal":"Hold one enabled executor without a worker"}}),
        )
        .await?,
    )?;
    let run = created["data"]["run"]["id"]
        .as_str()
        .context("Capacity run")?
        .to_owned();
    let plan = data(
        call(
            owner,
            "nesvo_set_run_plan",
            json!({"key":format!("{key}:plan"),"runId":run,"expectedRevision":created["data"]["run"]["revision"],
                "tasks":[{"key":"held","title":"Held","instruction":"UNSENT_CAPACITY"}]}),
        )
        .await?,
    )?;
    let active = data(
        call(
            owner,
            "nesvo_activate_run",
            json!({"key":format!("{key}:activate"),"runId":run,"expectedRevision":plan["data"]["run"]["revision"]}),
        )
        .await?,
    )?;
    data(
        call(
            owner,
            "nesvo_start_run_executor",
            json!({"key":format!("{key}:executor"),"runId":run,"expectedRevision":active["data"]["run"]["revision"],
                "spec":{"tasks":[{"taskId":plan["data"]["tasks"][0]["id"],
                    "profile":{"program":"claude","workspace":"shared","cwd":fixture.directory.join("capacity-cwd-absent"),"harness":true}}]}}),
        )
        .await?,
    )?;
    Ok(run)
}

async fn executor(owner: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    data(call(owner, "nesvo_get_run_executor", json!({"runId":run})).await?)
}

async fn occupied_capacity(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
) -> Result<Vec<String>> {
    let mut runs = Vec::new();
    for index in 0..EXECUTOR_CAPACITY {
        runs.push(occupied_executor(fixture, owner, index).await?);
    }
    waits::until(async || {
        let mut settled = 0;
        for run in &runs {
            let view = executor(owner, run).await?;
            ensure!(
                view["data"]["executor"]["enabled"] == true,
                "A capacity executor stopped holding its slot: {view}"
            );
            let tasks = run_checkpoints::view(owner, run).await?;
            ensure!(
                !waits::is_settled_run(&tasks["run"]["state"]),
                "A capacity run settled while holding its slot: {tasks}"
            );
            if tasks["tasks"][0]["state"] == "launchFailed"
                && view["data"]["executor"]["reason"] == "retry_requires_intent"
            {
                settled += 1;
            }
        }
        Ok((settled == runs.len()).then_some(()))
    })
    .await
    .context("Capacity executors settle enabled without a worker")?;
    Ok(runs)
}

async fn release_capacity(owner: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    async {
        loop {
            let view = run_checkpoints::view(owner, run).await?;
            let reply = call(
                owner,
                "nesvo_disable_run_executor",
                json!({"key":"release-one-executor-slot","runId":run,"expectedRevision":view["run"]["revision"]}),
            )
            .await?;
            if reply.is_error != Some(true) {
                return data(reply);
            }
            let refusal = reply
                .structured_content
                .context("Capacity release refusal")?;
            ensure!(
                refusal["error"]["code"] == "revision_conflict",
                "Unexpected capacity release refusal: {refusal}"
            );
        }
    }
    .await
    .context("Release one executor slot")
}

async fn overlapping(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    key: &str,
) -> Result<Value> {
    let sibling = data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({"key":key,"jobId":job,"expectedRevision":1}),
        )
        .await?,
    )?;
    assert_eq!(sibling["data"]["occurrence"]["state"], "skipped");
    assert_eq!(sibling["data"]["occurrence"]["reason"], "overlap");
    assert!(sibling["data"]["occurrence"]["jobAttemptId"].is_null());
    Ok(sibling)
}

fn probed(probe: &Value, key: &str, run: &Value, result: &str, accepted: bool) {
    assert_eq!(probe["result"], result);
    assert_eq!(probe["launchKey"], key);
    assert_eq!(probe["runId"], *run);
    assert_eq!(probe["executorAccepted"].as_bool(), Some(accepted));
    assert!(probe["observedAt"].is_i64());
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and controlled Node PTY; refused executor dispatch, absent probes and one fresh generation"]
async fn uncertain_dispatch_absent_probes_admit_one_fresh_generation() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(40), async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let capacity = occupied_capacity(&fixture, &owner).await?;
        let cwd = fixture.directory.join("uncertain-dispatch");
        std::fs::create_dir(&cwd)?;
        let (created, admitted) = admit(
            &fixture,
            &owner,
            "uncertain-dispatch",
            spec(&cwd, "shared", Some(retry(3, 4000))),
        )
        .await?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Uncertain dispatch job")?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Uncertain dispatch occurrence")?;
        let key = format!("job:{job}:{id}:executor");
        let parked = observed_with_diagnostics(
            &mut fixture,
            &owner,
            job,
            id,
            "retryWaiting/1 after an unconfirmed executor dispatch",
            |current| current["state"] == "retryWaiting" && current["jobAttemptOrdinal"] == 1,
        )
        .await?;
        let mut envelopes = Vec::new();
        if parked["data"]["occurrence"]["reason"] == "retry_probe_pending" {
            assert!(
                parked["data"]["occurrence"]["retry"].is_null(),
                "No decision exists before the first probe"
            );
            let pending = detail(
                &owner,
                job,
                id,
                &parked["data"]["occurrence"]["jobAttemptId"],
            )
            .await?;
            let facts = &pending["data"]["jobAttempt"]["retryClassification"];
            assert_eq!(facts["decision"], "probing");
            assert_eq!(facts["class"], "uncertainEffect");
            assert_eq!(facts["failure"], "dispatch_unconfirmed");
            assert_eq!(facts["launchKey"], key);
            assert!(facts["probe"].is_null() && facts["notBefore"].is_null());
            envelopes.push(pending);
        }
        let waiting = observed_with_diagnostics(
            &mut fixture,
            &owner,
            job,
            id,
            "retryWaiting/retry_backoff/1 after an absent first probe",
            |current| {
                current["state"] == "retryWaiting"
                    && current["reason"] == "retry_backoff"
                    && current["jobAttemptOrdinal"] == 1
            },
        )
        .await?;
        let first = &waiting["data"]["occurrence"];
        let due = deadline(first, 4000)?;
        let old_run = first["runId"]
            .as_str()
            .context("Unconfirmed dispatch run")?;
        assert!(first["attemptId"].is_null() && first["launchReceiptId"].is_null());
        assert!(first["sessionId"].is_null());
        assert_eq!(first["retry"]["class"], "uncertainEffect");
        probed(
            &first["retry"]["probe"],
            &key,
            &first["runId"],
            "absent",
            false,
        );
        assert!(first["retry"]["probe"]["attemptId"].is_null());
        assert_eq!(
            first["retry"]["probe"]["observedAt"],
            first["retry"]["decidedAt"]
        );
        let first_detail = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        let generation = &first_detail["data"]["jobAttempt"];
        assert_eq!(generation["state"], "failed");
        assert_eq!(generation["reason"], "launch_no_effect");
        assert_eq!(generation["retry"], first["retry"]);
        assert!(generation["retryAdmission"].is_null());
        let facts = &generation["retryClassification"];
        assert_eq!(facts["class"], "uncertainEffect");
        assert_eq!(facts["failure"], "dispatch_unconfirmed");
        assert_eq!(facts["launchKey"], key);
        assert_eq!(facts["decision"], "retryWaiting");
        assert_eq!(facts["decidedAt"], first["retry"]["decidedAt"]);
        assert_eq!(facts["notBefore"], due);
        assert_eq!(facts["nextOrdinal"], 2);
        assert_eq!(facts["probe"], first["retry"]["probe"]);
        let refused = executor(&owner, old_run).await?;
        assert!(
            refused["data"]["executor"].is_null(),
            "The refused dispatch never created an executor to pause"
        );
        let old_view = run_checkpoints::view(&owner, old_run).await?;
        assert_eq!(old_view["tasks"][0]["attempts"], 0);
        envelopes.push(
            fenced(
                &owner,
                old_run,
                "no-rearm-during-uncertain-backoff",
                "job_generation_retired",
            )
            .await?,
        );
        let sibling = overlapping(&owner, job, "uncertain-dispatch-overlap").await?;
        ensure!(
            now_ms() < due,
            "Native fixture must release one executor slot before the original deadline"
        );
        let released = release_capacity(&owner, &capacity[0]).await?;
        assert_eq!(released["data"]["executor"]["enabled"], false);
        let window = Duration::from_millis(u64::try_from((due - 60 - now_ms()).max(0))?);
        holds_throughout(window, async || {
            let early = occurrence(&owner, job, id).await?;
            if now_ms() < due {
                ensure!(
                    early["data"]["occurrence"]["jobAttemptOrdinal"] == 1
                        && early["data"]["occurrence"]["retry"] == first["retry"],
                    "No generation before notBefore: {early}"
                );
            }
            Ok(())
        })
        .await?;
        let reported =
            state_with_diagnostics(&mut fixture, &owner, job, id, "needsValidation", 2).await?;
        let second = &reported["data"]["occurrence"];
        assert!(second["retry"].is_null());
        for field in ["jobAttemptId", "runId"] {
            assert_ne!(
                first[field], second[field],
                "Retry requires a fresh {field}"
            );
        }
        for field in ["attemptId", "launchReceiptId", "sessionId"] {
            assert!(second[field].is_string(), "Fresh native {field}");
        }
        let second_detail = detail(&owner, job, id, &second["jobAttemptId"]).await?;
        let retried = &second_detail["data"]["jobAttempt"];
        assert!(
            retried["claimedAt"]
                .as_i64()
                .context("Uncertain retry claim time")?
                >= due
        );
        assert!(retried["retryClassification"].is_null());
        let admission = &retried["retryAdmission"];
        assert_eq!(admission["sourceJobAttemptId"], first["jobAttemptId"]);
        assert_eq!(admission["class"], "uncertainEffect");
        probed(
            &admission["claimProbe"],
            &key,
            &first["runId"],
            "absent",
            false,
        );
        assert!(
            admission["claimProbe"]["observedAt"]
                .as_i64()
                .context("Claim probe time")?
                >= due
        );
        assert_eq!(retried["result"]["outcome"], "succeeded");
        let retained = detail(&owner, job, id, &first["jobAttemptId"]).await?;
        assert_eq!(
            retained["data"]["jobAttempt"]["retry"],
            first_detail["data"]["jobAttempt"]["retry"]
        );
        assert_eq!(
            retained["data"]["jobAttempt"]["retryClassification"],
            first_detail["data"]["jobAttempt"]["retryClassification"]
        );
        let listed = generations(&owner, job, id).await?;
        let rows = listed["data"]["jobAttempts"]
            .as_array()
            .context("Exactly two job generations")?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], second["jobAttemptId"]);
        assert_eq!(rows[1]["id"], first["jobAttemptId"]);
        let first_run = budgets::owner_cli(
            &fixture,
            &[
                "run",
                "mutation",
                "--key",
                &format!("job:{job}:{id}:run"),
                "--json",
            ],
        )
        .await?;
        assert_eq!(first_run["data"]["run"]["id"], first["runId"]);
        let retry_run = budgets::owner_cli(
            &fixture,
            &[
                "run",
                "mutation",
                "--key",
                &format!("job:{job}:{id}:attempt:2:run"),
                "--json",
            ],
        )
        .await?;
        assert_eq!(retry_run["data"]["run"]["id"], second["runId"]);
        let retry_launch = budgets::owner_cli(
            &fixture,
            &[
                "run",
                "mutation",
                "--key",
                &format!("job:{job}:{id}:attempt:2:executor"),
                "--json",
            ],
        )
        .await?;
        assert_eq!(retry_launch["data"]["run"]["id"], second["runId"]);
        let worker = second["sessionId"]
            .as_str()
            .context("Fresh controlled worker")?;
        observed_output(&owner, worker, "FIXTURE_RESPONSE report-task").await?;
        let report: Value = serde_json::from_slice(&std::fs::read(
            fixture
                .directory
                .join("callers")
                .join(format!("{worker}.result.json")),
        )?)?;
        assert_eq!(report["data"]["attempt"]["id"], second["attemptId"]);
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(
            sessions["data"]["sessions"]
                .as_array()
                .context("Exactly one physical worker")?
                .len(),
            1
        );
        assert_eq!(launched_workers(&fixture)?, 1);
        let runs = data(call(&owner, "nesvo_list_runs", json!({})).await?)?;
        let rest = data(call(&owner, "nesvo_list_runs", json!({"offset":16})).await?)?;
        let listed_runs = runs["data"]["runs"]
            .as_array()
            .into_iter()
            .chain(rest["data"]["runs"].as_array())
            .flatten()
            .collect::<Vec<_>>();
        assert!(rest["data"]["nextOffset"].is_null());
        assert_eq!(listed_runs.len(), EXECUTOR_CAPACITY + 2);
        assert_eq!(
            listed_runs
                .iter()
                .filter(|run| run["title"] == "Controlled native job retry")
                .count(),
            2,
            "One fresh run per job generation"
        );
        let skipped = occurrence(
            &owner,
            job,
            sibling["data"]["occurrence"]["id"]
                .as_str()
                .context("Overlap occurrence")?,
        )
        .await?;
        assert_eq!(skipped["data"]["occurrence"]["state"], "skipped");
        envelopes.extend(vec![
            created.clone(),
            admitted.clone(),
            parked.clone(),
            waiting.clone(),
            first_detail.clone(),
            refused,
            sibling.clone(),
            released,
            reported.clone(),
            second_detail.clone(),
            retained,
            listed,
            first_run,
            retry_run,
            retry_launch,
            report,
            sessions,
            runs,
            rest,
            skipped,
        ]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native uncertain dispatch retry scenario")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native CLI/MCP/host, Node and Git; genuine unknown worktree launch found by the probe and adopted"]
async fn uncertain_launch_found_by_probe_is_adopted_without_retry() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(30), async {
        ready(&fixture).await?;
        let mut git = Command::new("git");
        git.arg("-C")
            .arg(&fixture.directory)
            .args(["rev-parse", "--show-toplevel"])
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .kill_on_drop(true);
        #[cfg(windows)]
        git.creation_flags(0x08000000);
        ensure!(
            !git.output().await?.status.success(),
            "Refusing worktree fixture inside an inherited Git repository"
        );
        let owner = client(&fixture.pairing()).await?;
        let uncertain = repository_whose_worktree_checkout_fails(&fixture).await?;
        let (created, admitted) = admit(
            &fixture,
            &owner,
            "uncertain-launch-adopted",
            spec(&uncertain, "worktree", Some(retry(3, 1000))),
        )
        .await?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Adopted uncertain job")?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Adopted uncertain occurrence")?;
        let key = format!("job:{job}:{id}:executor");
        let adopted = observed_with_diagnostics(
            &mut fixture,
            &owner,
            job,
            id,
            "reconcile/launch_unconfirmed/1 after the adopting probe",
            |current| {
                current["state"] == "reconcile"
                    && current["reason"] == "launch_unconfirmed"
                    && current["jobAttemptOrdinal"] == 1
            },
        )
        .await?;
        let current = &adopted["data"]["occurrence"];
        assert!(
            current["retry"].is_null(),
            "Adoption never records a retry decision"
        );
        let mut envelopes = launch_evidence(&owner, current, "unknown").await?;
        let adopted_detail = detail(&owner, job, id, &current["jobAttemptId"]).await?;
        let generation = &adopted_detail["data"]["jobAttempt"];
        assert_eq!(generation["state"], "reconcile");
        assert_eq!(generation["reason"], "launch_unconfirmed");
        assert!(generation["retry"].is_null() && generation["retryAdmission"].is_null());
        let facts = &generation["retryClassification"];
        assert_eq!(facts["class"], "definiteEffect");
        assert_eq!(facts["failure"], "launch_unconfirmed");
        assert_eq!(facts["launchKey"], key);
        assert_eq!(facts["decision"], "adopted");
        assert!(facts["nextOrdinal"].is_null());
        let probe = &facts["probe"];
        probed(probe, &key, &current["runId"], "sessionFound", true);
        assert_eq!(probe["attemptId"], current["attemptId"]);
        assert_eq!(probe["attemptState"], "launchUnknown");
        assert_eq!(probe["sessionId"], current["sessionId"]);
        assert_eq!(probe["launchReceiptId"], current["launchReceiptId"]);
        assert_eq!(facts["decidedAt"], probe["observedAt"]);
        let reconciliation = &generation["launchReconciliation"];
        if reconciliation.is_object() {
            assert_eq!(reconciliation["retryClassification"]["state"], "adopted");
            assert!(reconciliation["retryClassification"]["retryJobAttemptId"].is_null());
        }
        let run = current["runId"].as_str().context("Adopted native run")?;
        let engine = executor(&owner, run).await?;
        assert_ne!(
            engine["data"]["executor"]["reason"], "job_retry_waiting",
            "Adopted work is never paused for a retry"
        );
        let sibling = overlapping(&owner, job, "uncertain-launch-overlap").await?;
        let observed_until = facts["decidedAt"].as_i64().context("Adoption time")? + 2500;
        let window = Duration::from_millis(u64::try_from((observed_until - now_ms()).max(0))?);
        holds_throughout(window, async || {
            let held = occurrence(&owner, job, id).await?;
            ensure!(
                held["data"]["occurrence"]["state"] == "reconcile"
                    && held["data"]["occurrence"]["jobAttemptOrdinal"] == 1
                    && held["data"]["occurrence"]["retry"].is_null(),
                "Adopted work must not be retried: {held}"
            );
            Ok(())
        })
        .await?;
        let settled = detail(&owner, job, id, &current["jobAttemptId"]).await?;
        assert_eq!(
            settled["data"]["jobAttempt"]["retryClassification"], *facts,
            "Later polls never reclassify adopted work"
        );
        let listed = generations(&owner, job, id).await?;
        assert_eq!(
            listed["data"]["jobAttempts"]
                .as_array()
                .context("No retry generation after adoption")?
                .len(),
            1
        );
        let view = run_checkpoints::view(&owner, run).await?;
        assert_eq!(view["tasks"][0]["attempts"], 1);
        let runs = data(call(&owner, "nesvo_list_runs", json!({})).await?)?;
        assert_eq!(
            runs["data"]["runs"]
                .as_array()
                .context("No fresh run after adoption")?
                .len(),
            1
        );
        let skipped = occurrence(
            &owner,
            job,
            sibling["data"]["occurrence"]["id"]
                .as_str()
                .context("Overlap occurrence")?,
        )
        .await?;
        assert_eq!(skipped["data"]["occurrence"]["state"], "skipped");
        envelopes.push(no_workers(&fixture, &owner).await?);
        envelopes.extend(vec![
            created.clone(),
            admitted.clone(),
            adopted.clone(),
            adopted_detail.clone(),
            engine,
            sibling.clone(),
            settled,
            listed,
            runs,
            skipped,
        ]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native uncertain launch adoption scenario")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
