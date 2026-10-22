use super::*;

const REPLY_DROP: &str = "NESVO_EXECUTOR_REPLY_DROP_TEST_JOB";
const RETRY_DELAY_MS: i64 = 4000;

type Owner = RunningService<RoleClient, ()>;

fn spec(cwd: &Path) -> Value {
    json!({
        "title":"Lost executor reply","instruction":"report-task",
        "profile":{"program":"claude","workspace":"shared","cwd":cwd,"harness":true,
            "allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
        "retry":{"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":RETRY_DELAY_MS,"maxDelayMs":RETRY_DELAY_MS}
    })
}

async fn restart_with_reply_drop(fixture: &mut Fixture, job: &str) -> Result<()> {
    drop(fixture.host.stdin.take());
    let status = fixture.host.wait().await?;
    ensure!(
        status.success(),
        "Owned host did not finish graceful shutdown"
    );
    let mut command = Command::new(Fixture::host_binary());
    agent_fixture_environment(&fixture.directory, &mut command)?;
    command.env(REPLY_DROP, job);
    let (host, startup_trace) = Fixture::spawn_host(&fixture.directory, command).await?;
    fixture.host = host;
    fixture.startup_trace = startup_trace;
    Ok(())
}

async fn occurrence(owner: &Owner, job: &str, id: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_occurrence",
            json!({"jobId":job,"occurrenceId":id}),
        )
        .await?,
    )
}

async fn reached(
    fixture: &mut Fixture,
    owner: &Owner,
    job: &str,
    id: &str,
    description: &str,
    wanted: impl Fn(&Value) -> bool,
) -> Result<Value> {
    let mut observation = job_diagnostics::RetryWaitObservation::new(job, id);
    let started = tokio::time::Instant::now();
    let result = waits::until(async || {
        observation.started(started.elapsed());
        let response = occurrence(owner, job, id).await;
        match &response {
            Ok(view) => observation.completed(view, started.elapsed()),
            Err(_) => observation.failed(),
        }
        let view = response?;
        let current = &view["data"]["occurrence"];
        if wanted(current) {
            return Ok(Some(view));
        }
        ensure!(
            !waits::is_settled_occurrence(&current["state"]),
            "Lost-reply occurrence settled before {description}: {view}"
        );
        Ok(None)
    })
    .await;
    match result {
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
                "Lost-reply occurrence did not reach {description}; bounded diagnostics: {}",
                diagnostics
                    .to_string()
                    .chars()
                    .take(16384)
                    .collect::<String>()
            )))
        }
    }
}

async fn generation(owner: &Owner, job: &str, id: &str, generation: &Value) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_attempt",
            json!({"jobId":job,"occurrenceId":id,"jobAttemptId":generation}),
        )
        .await?,
    )
}

async fn executor(owner: &Owner, run: &str) -> Result<Value> {
    data(call(owner, "nesvo_get_run_executor", json!({"runId":run})).await?)
}

fn paused(view: &Value) {
    let executor = &view["data"]["executor"];
    assert_eq!(executor["phase"], "paused");
    assert_eq!(executor["reason"], "job_retry_waiting");
    assert_eq!(executor["enabled"], false);
    assert!(executor["taskId"].is_null());
}

async fn refused_enable(owner: &Owner, run: &str) -> Result<Value> {
    loop {
        let view = run_checkpoints::view(owner, run).await?;
        let reply = call(
            owner,
            "nesvo_enable_run_executor",
            json!({"key":"rearm-lost-reply-executor","runId":run,"expectedRevision":view["run"]["revision"]}),
        )
        .await?;
        ensure!(
            reply.is_error == Some(true),
            "The paused executor of a retired generation was re-enabled"
        );
        let refusal = reply
            .structured_content
            .context("Retired executor refusal")?;
        if refusal["error"]["code"] != "revision_conflict" {
            assert_eq!(refusal["error"]["code"], "job_generation_retired");
            return Ok(refusal);
        }
    }
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

async fn no_session(fixture: &Fixture, owner: &Owner) -> Result<Value> {
    let sessions = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    ensure!(
        sessions["data"]["sessions"]
            .as_array()
            .context("Session list")?
            .is_empty(),
        "The lost-reply generation launched a session: {sessions}"
    );
    ensure!(
        launched_workers(fixture)? == 0,
        "The lost-reply generation started a controlled process"
    );
    Ok(sessions)
}

async fn executor_changes(owner: &Owner, run: &str) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut cursor = 0;
    loop {
        let page = data(call(owner, "nesvo_read_events", json!({"after":cursor})).await?)?;
        ensure!(
            page["data"]["gap"] == false,
            "Lost-reply journal must be complete: {page}"
        );
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Lost-reply journal events")?
                .iter()
                .filter(|event| {
                    event["kind"] == "run.executor_changed" && event["payload"]["runId"] == run
                })
                .cloned(),
        );
        if page["data"]["more"] != true {
            return Ok(events);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Lost-reply journal cursor")?;
    }
}

fn probed(probe: &Value, key: &str, run: &Value) {
    assert_eq!(probe["result"], "absent");
    assert_eq!(probe["launchKey"], key);
    assert_eq!(probe["runId"], *run);
    assert_eq!(probe["executorAccepted"].as_bool(), Some(true));
    assert!(probe["attemptId"].is_null());
    assert!(probe["observedAt"].is_i64());
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and controlled Node PTY; lost executor reply pauses the old run with job_retry_waiting and one fresh generation runs"]
async fn lost_executor_reply_pauses_the_old_run_and_admits_one_fresh_generation() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        waits::provider(&fixture, "claude").await?;
        let owner = client(&fixture.pairing()).await?;
        let cwd = fixture.directory.join("lost-executor-reply");
        std::fs::create_dir(&cwd)?;
        let created = data(
            call(
                &owner,
                "nesvo_create_job",
                json!({"key":"lost-executor-reply:definition","spec":spec(&cwd)}),
            )
            .await?,
        )?;
        let job = created["data"]["job"]["id"]
            .as_str()
            .context("Lost-reply job")?
            .to_owned();
        owner.cancel().await?;
        restart_with_reply_drop(&mut fixture, &job).await?;
        waits::provider(&fixture, "claude").await?;
        let owner = client(&fixture.pairing()).await?;
        let admitted = budgets::owner_cli(
            &fixture,
            &[
                "job",
                "run-now",
                &job,
                "--key",
                "lost-executor-reply",
                "--revision",
                "1",
                "--json",
            ],
        )
        .await?;
        let id = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Lost-reply occurrence")?
            .to_owned();
        let key = format!("job:{job}:{id}:executor");
        let mut envelopes = vec![created.clone(), admitted.clone()];
        let parked = reached(
            &mut fixture,
            &owner,
            &job,
            &id,
            "retryWaiting/1 after the lost executor reply",
            |current| current["state"] == "retryWaiting" && current["jobAttemptOrdinal"] == 1,
        )
        .await?;
        if parked["data"]["occurrence"]["reason"] == "retry_probe_pending" {
            assert!(parked["data"]["occurrence"]["retry"].is_null());
            let pending = generation(
                &owner,
                &job,
                &id,
                &parked["data"]["occurrence"]["jobAttemptId"],
            )
            .await?;
            let facts = &pending["data"]["jobAttempt"]["retryClassification"];
            assert_eq!(facts["decision"], "probing");
            assert_eq!(facts["class"], "uncertainEffect");
            assert_eq!(facts["failure"], "dispatch_unconfirmed");
            assert_eq!(facts["launchKey"], key);
            envelopes.push(pending);
        }
        let waiting = reached(
            &mut fixture,
            &owner,
            &job,
            &id,
            "retryWaiting/retry_backoff/1 after an absent probe",
            |current| {
                current["state"] == "retryWaiting"
                    && current["reason"] == "retry_backoff"
                    && current["jobAttemptOrdinal"] == 1
            },
        )
        .await?;
        let first = &waiting["data"]["occurrence"];
        let old_run = first["runId"]
            .as_str()
            .context("Lost-reply run")?
            .to_owned();
        let decided = first["retry"]["decidedAt"]
            .as_i64()
            .context("Retry decision time")?;
        let due = first["retry"]["notBefore"]
            .as_i64()
            .context("Retry deadline")?;
        assert_eq!(due - decided, RETRY_DELAY_MS);
        assert_eq!(first["retry"]["class"], "uncertainEffect");
        assert_eq!(first["retry"]["nextOrdinal"], 2);
        probed(&first["retry"]["probe"], &key, &first["runId"]);
        for field in ["attemptId", "launchReceiptId", "sessionId"] {
            assert!(first[field].is_null(), "The lost reply allocated {field}");
        }
        let first_detail = generation(&owner, &job, &id, &first["jobAttemptId"]).await?;
        let retired = &first_detail["data"]["jobAttempt"];
        assert_eq!(retired["state"], "failed");
        assert_eq!(retired["reason"], "launch_no_effect");
        let facts = &retired["retryClassification"];
        assert_eq!(facts["class"], "uncertainEffect");
        assert_eq!(facts["failure"], "dispatch_unconfirmed");
        assert_eq!(facts["decision"], "retryWaiting");
        assert_eq!(facts["launchKey"], key);
        assert_eq!(facts["notBefore"], due);
        let committed =
            budgets::owner_cli(&fixture, &["run", "mutation", "--key", &key, "--json"]).await?;
        assert_eq!(committed["data"]["run"]["id"], old_run.as_str());
        let pause = executor(&owner, &old_run).await?;
        paused(&pause);
        let old_view = run_checkpoints::view(&owner, &old_run).await?;
        assert_eq!(old_view["tasks"][0]["attempts"], 0);
        let quiet = no_session(&fixture, &owner).await?;
        let refusal = refused_enable(&owner, &old_run).await?;
        let still = executor(&owner, &old_run).await?;
        assert_eq!(still["data"]["executor"], pause["data"]["executor"]);
        let now_ms = || chrono::Utc::now().timestamp_millis();
        let window = Duration::from_millis(u64::try_from((due - 60 - now_ms()).max(0))?);
        holds_throughout(window, async || {
            let early = occurrence(&owner, &job, &id).await?;
            if now_ms() < due {
                ensure!(
                    early["data"]["occurrence"]["jobAttemptOrdinal"] == 1
                        && early["data"]["occurrence"]["retry"] == first["retry"],
                    "No generation before notBefore: {early}"
                );
                no_session(&fixture, &owner).await?;
            }
            Ok(())
        })
        .await?;
        let reported = reached(
            &mut fixture,
            &owner,
            &job,
            &id,
            "needsValidation/2",
            |current| current["state"] == "needsValidation" && current["jobAttemptOrdinal"] == 2,
        )
        .await?;
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
        let second_detail = generation(&owner, &job, &id, &second["jobAttemptId"]).await?;
        let fresh = &second_detail["data"]["jobAttempt"];
        assert!(
            fresh["claimedAt"]
                .as_i64()
                .context("Fresh generation claim time")?
                >= due
        );
        let admission = &fresh["retryAdmission"];
        assert_eq!(admission["sourceJobAttemptId"], first["jobAttemptId"]);
        assert_eq!(admission["class"], "uncertainEffect");
        probed(&admission["claimProbe"], &key, &first["runId"]);
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
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(
            sessions["data"]["sessions"]
                .as_array()
                .context("Exactly one physical worker")?
                .len(),
            1
        );
        assert_eq!(launched_workers(&fixture)?, 1);
        let retained = executor(&owner, &old_run).await?;
        assert_eq!(retained["data"]["executor"], pause["data"]["executor"]);
        let changes = executor_changes(&owner, &old_run).await?;
        assert_eq!(
            changes.len(),
            2,
            "The old run journals its accepted start and exactly one pause: {changes:?}"
        );
        for change in &changes {
            assert_eq!(
                change["payload"]["executorId"],
                pause["data"]["executor"]["id"]
            );
        }
        let listed = data(
            call(
                &owner,
                "nesvo_get_job_attempts",
                json!({"jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        let rows = listed["data"]["jobAttempts"]
            .as_array()
            .context("Exactly two job generations")?;
        assert_eq!(rows.len(), 2);
        envelopes.extend(vec![
            parked,
            waiting.clone(),
            first_detail,
            committed,
            pause,
            quiet,
            refusal,
            still,
            reported.clone(),
            second_detail.clone(),
            retry_launch,
            sessions,
            retained,
            listed,
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
