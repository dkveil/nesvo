//! Explicit native job execution windows; controlled workers, never model calls.
use super::*;
use job_cancellation::{occurrence, process_alive};

type Owner = RunningService<RoleClient, ()>;
type ScenarioOutcome =
    std::thread::Result<std::result::Result<Result<()>, tokio::time::error::Elapsed>>;
const WINDOW_MS: u64 = 10_000;
const DISCOVERY_MS: u64 = 5_000;
const WORKING_MS: u64 = 7_000;
const HOST_CONTROL_BOUND_MS: u64 = 10_000;
const RESOLUTION_MARGIN_MS: u64 = 5_000;
const SETTLE_MS: u64 = 15_000;
const TIMED_WORKER_MS: u64 =
    WORKING_MS + WINDOW_MS + HOST_CONTROL_BOUND_MS + RESOLUTION_MARGIN_MS + SETTLE_MS;

const fn scenario_bound(timed_workers: u64) -> Duration {
    Duration::from_millis(DISCOVERY_MS + timed_workers * TIMED_WORKER_MS)
}

fn spec(instruction: &str) -> Value {
    json!({
        "title":"Controlled execution timeout","instruction":instruction,
        "profile":{"program":"claude","workspace":"shared","harness":true,
            "allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
        "executionTimeoutMs":WINDOW_MS,"maxElapsedMs":300000
    })
}

async fn reply(owner: &Owner, name: &'static str, args: Value) -> Result<Value> {
    data(call(owner, name, args).await?)
}

async fn read_occurrence(owner: &Owner, job: &str, id: &str) -> Result<Value> {
    reply(
        owner,
        "nesvo_get_job_occurrence",
        json!({"jobId":job,"occurrenceId":id}),
    )
    .await
}

struct DiscoveryEvidence {
    started: tokio::time::Instant,
    elapsed_ms: Option<u64>,
    attempted: u64,
    completed: u64,
    stage: &'static str,
    query_outcome: &'static str,
    precondition_outcome: &'static str,
    last_claude_status: &'static str,
}

impl DiscoveryEvidence {
    fn new() -> Self {
        Self {
            started: tokio::time::Instant::now(),
            elapsed_ms: None,
            attempted: 0,
            completed: 0,
            stage: "notStarted",
            query_outcome: "notAttempted",
            precondition_outcome: "notCompleted",
            last_claude_status: "notReported",
        }
    }

    fn summary(&self) -> Value {
        json!({
            "deadlineMs":DISCOVERY_MS,
            "elapsedMs":self.elapsed_ms.unwrap_or_else(|| {
                u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
            }),
            "attemptedDoctorQueries":self.attempted,
            "completedDoctorQueries":self.completed,
            "doctorQueryInFlight":self.stage == "doctorQuery",
            "stage":self.stage,
            "queryOutcome":self.query_outcome,
            "preconditionOutcome":self.precondition_outcome,
            "lastClaudeProbeStatus":self.last_claude_status,
        })
    }
}

async fn discovery_ready(fixture: &Fixture, evidence: &mut DiscoveryEvidence) -> Result<()> {
    evidence.started = tokio::time::Instant::now();
    let result = timeout(Duration::from_millis(DISCOVERY_MS), async {
        loop {
            evidence.attempted = evidence.attempted.saturating_add(1);
            evidence.stage = "doctorQuery";
            evidence.query_outcome = "pending";
            let query = budgets::owner_cli(fixture, &["doctor", "--json"]).await;
            evidence.completed = evidence.completed.saturating_add(1);
            evidence.stage = "doctorCompleted";
            let doctor = match query {
                Ok(doctor) => {
                    evidence.query_outcome = "completed";
                    doctor
                }
                Err(_) => {
                    evidence.query_outcome = "failed";
                    anyhow::bail!("Controlled provider doctor query failed");
                }
            };
            evidence.last_claude_status = match doctor["providerVersions"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["program"] == "claude"))
                .and_then(|row| row["status"].as_str())
            {
                Some("checking") => "checking",
                Some("ready") => "ready",
                Some("unavailable") => "unavailable",
                Some(_) => "invalidStatus",
                None => "notReported",
            };
            if doctor["providerVersions"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["program"] == "claude" && row["status"] == "ready")
            }) {
                evidence.stage = "ready";
                return Ok::<_, anyhow::Error>(());
            }
            evidence.stage = "betweenDoctorQueries";
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await;
    evidence.elapsed_ms =
        Some(u64::try_from(evidence.started.elapsed().as_millis()).unwrap_or(u64::MAX));
    evidence.precondition_outcome = match &result {
        Ok(Ok(())) => "ready",
        Ok(Err(_)) => "queryFailed",
        Err(_) => "deadlineElapsed",
    };
    if result.is_err() && evidence.stage == "doctorQuery" {
        evidence.query_outcome = "pendingAtDeadline";
    }
    result.context("Controlled provider discovery before execution timeout admission")?
}

fn working_session(result: CallToolResult, worker: &str) -> Result<Option<Value>> {
    // Storage reserves this exact session ID and arms its deadline before the
    // native process is created. Only this typed absence is a pending read;
    // authority, malformed replies and transport failures are not readiness.
    if result.is_error == Some(true)
        && result.structured_content.as_ref().is_some_and(|reply| {
            reply["schemaVersion"] == 1
                && reply["ok"] == false
                && reply["error"]["code"] == "session_not_found"
                && reply["error"]["retryable"] == false
                && reply["error"]["message"].is_string()
                && reply.get("data").is_none()
        })
    {
        return Ok(None);
    }
    let session = data(result)?;
    ensure!(
        session["schemaVersion"] == 1
            && session["ok"] == true
            && session["data"]["session"]["id"] == worker,
        "Timed worker session reply must match its exact reserved identity"
    );
    Ok(Some(session))
}

async fn working(owner: &Owner, job: &str, id: &str) -> Result<(Value, Value)> {
    let mut last = Value::Null;
    timeout(Duration::from_millis(WORKING_MS), async {
        loop {
            let current = read_occurrence(owner, job, id).await?;
            let row = &current["data"]["occurrence"];
            if row["executionTimeout"]["state"] == "armed"
                && let Some(worker) = row["sessionId"].as_str()
            {
                let observed =
                    call(owner, "nesvo_get_session", json!({"sessionId":worker})).await?;
                if let Some(session) = working_session(observed, worker)?
                    && session["data"]["session"]["status"]["state"] == "working"
                {
                    return Ok::<_, anyhow::Error>((current, session));
                }
            }
            last = current;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .with_context(|| format!("Timed worker never reached controlled hold; last: {last}"))?
}

#[test]
fn timed_worker_waits_for_reserved_id_but_rejects_foreign_or_untyped_missing_session() {
    let worker = "1".repeat(32);
    let missing = json!({"schemaVersion":1,"ok":false,"error":{
        "code":"session_not_found","message":"Session no longer exists","retryable":false}});
    assert!(
        working_session(CallToolResult::structured_error(missing.clone()), &worker)
            .unwrap()
            .is_none()
    );
    let created = json!({"schemaVersion":1,"ok":true,"data":{"type":"session",
        "session":{"id":worker,"status":{"state":"working"}}}});
    assert_eq!(
        working_session(CallToolResult::structured(created.clone()), &worker).unwrap(),
        Some(created.clone())
    );
    let mut foreign = created;
    foreign["data"]["session"]["id"] = json!("2".repeat(32));
    assert!(working_session(CallToolResult::structured(foreign), &worker).is_err());

    for (field, value) in [
        ("code", json!("forbidden")),
        ("code", json!("scope_revoked")),
        ("retryable", json!(true)),
        ("retryable", json!("false")),
        ("message", Value::Null),
    ] {
        let mut refused = missing.clone();
        refused["error"][field] = value;
        assert!(working_session(CallToolResult::structured_error(refused), &worker).is_err());
    }
    for malformed in [
        json!({"error":{"code":"session_not_found"}}),
        json!({"schemaVersion":1,"ok":true,"error":missing["error"]}),
        json!({"schemaVersion":2,"ok":false,"error":missing["error"]}),
        json!({"schemaVersion":1,"ok":false,"error":missing["error"],"data":{}}),
    ] {
        assert!(working_session(CallToolResult::structured_error(malformed), &worker).is_err());
    }
    // The MCP error flag is part of the typed refusal. A body merely containing
    // the same code cannot turn an otherwise malformed success into a wait.
    assert!(working_session(CallToolResult::structured(missing), &worker).is_err());
    assert!(working_session(CallToolResult::structured(json!({})), &worker).is_err());
}

fn until_dispatch_resolved(timer: &Value) -> Result<Duration> {
    let deadline = timer["deadlineAt"]
        .as_u64()
        .context("Public native deadline")?;
    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    let remaining = deadline
        .saturating_add(HOST_CONTROL_BOUND_MS + RESOLUTION_MARGIN_MS)
        .saturating_sub(now);
    ensure!(
        remaining <= WINDOW_MS + HOST_CONTROL_BOUND_MS + RESOLUTION_MARGIN_MS,
        "Unexpected deadline exceeds this scenario's explicit window"
    );
    Ok(Duration::from_millis(remaining))
}

async fn resolved_timeout(
    owner: &Owner,
    job: &str,
    id: &str,
    timer: &Value,
    wanted: &str,
) -> Result<Value> {
    let bound = until_dispatch_resolved(timer)?;
    let mut last = Value::Null;
    let resolved = timeout(bound, async {
        loop {
            let current = read_occurrence(owner, job, id).await?;
            if !matches!(
                current["data"]["occurrence"]["executionTimeout"]["state"].as_str(),
                Some("armed" | "dispatching")
            ) {
                return Ok::<_, anyhow::Error>(current);
            }
            last = current;
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    })
    .await
    .with_context(|| {
        format!("Timeout dispatch did not resolve within the host control bound; last: {last}")
    })??;
    ensure!(
        resolved["data"]["occurrence"]["executionTimeout"]["state"] == wanted,
        "Timeout dispatch resolved without reaching {wanted}: {resolved}"
    );
    Ok(resolved)
}

fn frozen_deadline(first: &Value, later: &Value) {
    for field in [
        "jobId",
        "occurrenceId",
        "jobAttemptId",
        "runId",
        "attemptId",
        "sessionId",
        "launchReceiptId",
        "executionTimeoutMs",
        "armedAt",
        "deadlineAt",
        "controlKey",
    ] {
        assert_eq!(
            first[field], later[field],
            "Frozen timeout field changed: {field}"
        );
    }
    assert_eq!(first["executionTimeoutMs"], WINDOW_MS);
    assert_eq!(
        first["deadlineAt"].as_u64().unwrap() - first["armedAt"].as_u64().unwrap(),
        WINDOW_MS
    );
}

async fn past_deadline(timer: &Value) -> Result<()> {
    let deadline = timer["deadlineAt"]
        .as_u64()
        .context("Public native deadline")?;
    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    let remaining = deadline.saturating_add(250).saturating_sub(now);
    ensure!(
        remaining <= WINDOW_MS + 250,
        "Unexpected deadline exceeds this scenario's explicit window"
    );
    tokio::time::sleep(Duration::from_millis(remaining)).await;
    Ok(())
}

async fn release_human(mut human: Child) -> Result<()> {
    // The existing helper waits for the host's lease-release acknowledgement.
    drop(human.stdin.take());
    ensure!(
        timeout(Duration::from_secs(5), human.wait())
            .await??
            .success(),
        "Owned human control helper did not release its lease"
    );
    Ok(())
}

async fn one_generation(owner: &Owner, current: &Value) -> Result<Vec<Value>> {
    let row = &current["data"]["occurrence"];
    let job = row["jobId"].as_str().context("Generation job")?;
    let id = row["id"].as_str().context("Generation occurrence")?;
    let run = row["runId"].as_str().context("Generation run")?;
    let history = reply(owner, "nesvo_get_job_history", json!({"jobId":job})).await?;
    let occurrences = history["data"]["occurrences"]
        .as_array()
        .context("One occurrence history")?;
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0]["id"], row["id"]);
    assert_eq!(occurrences[0]["executionTimeout"], row["executionTimeout"]);
    for field in [
        "jobId",
        "jobAttemptId",
        "runId",
        "attemptId",
        "sessionId",
        "launchReceiptId",
    ] {
        assert_eq!(
            row["executionTimeout"][field], row[field],
            "Timeout identity differs from its occurrence: {field}"
        );
    }
    assert_eq!(row["executionTimeout"]["occurrenceId"], row["id"]);
    let listed = reply(
        owner,
        "nesvo_get_job_attempts",
        json!({"jobId":job,"occurrenceId":id}),
    )
    .await?;
    let rows = listed["data"]["jobAttempts"]
        .as_array()
        .context("One retained generation")?;
    assert_eq!(
        rows.len(),
        1,
        "Execution timeout must never create another dispatch generation"
    );
    assert_eq!(rows[0]["id"], row["jobAttemptId"]);
    assert!(rows[0]["retry"].is_null());
    assert_eq!(rows[0]["executionTimeout"], row["executionTimeout"]);
    let detail = reply(
        owner,
        "nesvo_get_job_attempt",
        json!({"jobId":job,"occurrenceId":id,"jobAttemptId":row["jobAttemptId"]}),
    )
    .await?;
    assert_eq!(
        detail["data"]["jobAttempt"]["executionTimeout"],
        row["executionTimeout"]
    );
    let view = reply(owner, "nesvo_get_run", json!({"runId":run})).await?;
    assert_eq!(view["data"]["tasks"][0]["attempts"], 1);
    assert_eq!(
        view["data"]["tasks"][0]["currentAttempt"]["id"],
        row["attemptId"]
    );
    assert_eq!(
        view["data"]["run"]["budget"]["limits"]["maxElapsedMs"],
        300000
    );
    let native = reply(
        owner,
        "nesvo_get_task_attempts",
        json!({"runId":run,"taskId":view["data"]["tasks"][0]["id"]}),
    )
    .await?;
    let attempts = native["data"]["attempts"]
        .as_array()
        .context("One native task attempt")?;
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0]["id"], row["attemptId"]);
    assert_eq!(attempts[0]["launch"]["receiptId"], row["launchReceiptId"]);
    Ok(vec![history, listed, detail, view, native])
}

async fn finish(
    fixture: &mut Fixture,
    scenario: &str,
    phase: &str,
    job: Option<&str>,
    discovery: &DiscoveryEvidence,
    outcome: ScenarioOutcome,
) -> Result<()> {
    if !matches!(&outcome, Ok(Ok(Ok(())))) {
        let diagnostics = match job {
            Some(job) => job_diagnostics::report_timeout_diagnostics(fixture, job).await,
            None => {
                let host = match fixture.host.try_wait() {
                    Ok(Some(status)) => json!({"state":"exited","exitCode":status.code()}),
                    Ok(None) => json!({"state":"running"}),
                    Err(_) => json!({"state":"unavailable"}),
                };
                json!({"jobNotCreated":true,"discovery":discovery.summary(),"hostAfterFailure":host})
            }
        };
        eprintln!(
            "JOB_EXECUTION_TIMEOUT_DIAGNOSTIC {}",
            json!({"scenario":scenario,"phase":phase,"actual":diagnostics})
                .to_string()
                .chars()
                .take(16384)
                .collect::<String>()
        );
    }
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.with_context(|| format!("{scenario}; last phase: {phase}"))??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

async fn approved_precheck(fixture: &Fixture, owner: &Owner) -> Result<(String, Vec<Value>)> {
    let script = fixture.directory.join("timeout-precheck.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )?;
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let literal = "literal $(x); & łódź \"quoted\"";
    let command = json!({"title":"Before execution admission","executable":node,"cwd":fixture.directory,
        "arguments":[script,"pass",fixture.directory.join("timeout-precheck-effects"),"root",literal],
        "timeoutMs":10000,"environment":{"CHECK_LITERAL":literal}});
    let described = reply(owner, "nesvo_describe_precheck", json!({"spec":command})).await?;
    let approved = reply(
        owner,
        "nesvo_approve_precheck",
        json!({"key":"timeout-precheck","spec":command,
        "expectedDigest":described["data"]["precheckDescription"]["digest"]}),
    )
    .await?;
    let id = approved["data"]["precheckApproval"]["id"]
        .as_str()
        .context("Approved precheck")?
        .to_owned();
    Ok((id, vec![described, approved]))
}

#[tokio::test]
#[ignore = "native host/CLI/MCP and controlled Node; disconnected execution timeout, no models"]
async fn timeout_without_clients_stops_only_its_worker_and_never_retries_execution() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let mut phase = "provider discovery";
    let mut diagnostic_job = None;
    let mut discovery = DiscoveryEvidence::new();
    let outcome = std::panic::AssertUnwindSafe(timeout(scenario_bound(1),async {
        discovery_ready(&fixture, &mut discovery).await?;
        let owner = client(&fixture.pairing()).await?;
        let independent = reply(&owner,"nesvo_create_session",json!({"key":"timeout-independent","spec":{"name":"Untimed independent shell","program":"shell"}})).await?;
        let independent_id = independent["data"]["receipt"]["sessionId"].as_str().context("Independent session")?;
        let (precheck,mut envelopes) = approved_precheck(&fixture,&owner).await?;
        phase = "CLI/MCP definition parity";
        let mut selected = spec("hold-response");
        selected["precheckId"] = precheck.into();
        selected["retry"] = json!({"on":"launchNoEffect","maxAttempts":2,"initialDelayMs":1000,"maxDelayMs":1000});
        let file = fixture.directory.join("execution-timeout-job.json");
        std::fs::write(&file,serde_json::to_vec(&selected)?)?;
        let created = budgets::owner_cli(&fixture,&["job","create","--key","timeout-definition","--file",file.to_str().context("Timeout job file")?,"--json"]).await?;
        let job = created["data"]["job"]["id"].as_str().context("Timeout job")?;
        diagnostic_job = Some(job.to_owned());
        let create_replay = reply(&owner,"nesvo_create_job",json!({"key":"timeout-definition","spec":selected})).await?;
        assert_eq!(create_replay["data"],created["data"]);
        selected["title"] = "Edited execution timeout".into();
        std::fs::write(&file,serde_json::to_vec(&selected)?)?;
        let edited = budgets::owner_cli(&fixture,&["job","edit",job,"--key","timeout-edit","--revision","1","--file",file.to_str().context("Timeout edited file")?,"--json"]).await?;
        let edit_replay = reply(&owner,"nesvo_update_job",json!({"key":"timeout-edit","jobId":job,"expectedRevision":1,"spec":selected})).await?;
        assert_eq!(edit_replay["data"],edited["data"]);
        assert_eq!(edited["data"]["job"]["spec"]["executionTimeoutMs"],WINDOW_MS);
        phase = "precheck and native hold admission";
        let arguments = json!({"key":"timeout-run","jobId":job,"expectedRevision":2});
        let admitted = reply(&owner,"nesvo_run_job_now",arguments.clone()).await?;
        assert!(admitted["data"]["occurrence"]["executionTimeout"].is_null());
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Timeout occurrence")?;
        let (held,session) = working(&owner,job,id).await?;
        let row = &held["data"]["occurrence"];
        let timer = row["executionTimeout"].clone();
        assert_eq!(row["precheck"]["state"],"passed");
        assert!(timer["armedAt"].as_u64().context("Native arm")? >= row["precheck"]["finishedAt"].as_u64().context("Precheck completion")?);
        frozen_deadline(&timer,&timer);
        let pid = session["data"]["session"]["lifecycle"]["process"]["pid"].as_u64().context("Owned timed PID")?;
        selected["executionTimeoutMs"] = json!(20_000);
        let future = reply(&owner,"nesvo_update_job",json!({"key":"timeout-future","jobId":job,"expectedRevision":2,"spec":selected})).await?;
        assert_eq!(future["data"]["job"]["spec"]["executionTimeoutMs"],20_000);
        phase = "owner disconnected through native deadline";
        owner.cancel().await?;
        ensure!(u64::try_from(chrono::Utc::now().timestamp_millis())? < timer["deadlineAt"].as_u64().context("Disconnected native deadline")?,"Owner must disconnect before its worker's execution deadline");
        ensure!(process_alive(&fixture,pid).await?,"Owned worker must still exist after owner disconnects");
        past_deadline(&timer).await?;
        timeout(until_dispatch_resolved(&timer)?,async {
            while process_alive(&fixture,pid).await? { tokio::time::sleep(Duration::from_millis(150)).await; }
            Ok::<_,anyhow::Error>(())
        }).await.context("Owned PID exit while all owner MCP clients remain closed")??;
        phase = "reconnect and retained timeout evidence";
        let owner = client(&fixture.pairing()).await?;
        let failed = occurrence(&owner,job,id,"failed").await?;
        let current = &failed["data"]["occurrence"];
        assert_eq!(current["reason"],"execution_timeout");
        assert_eq!(current["executionTimeout"]["state"],"completed");
        assert!(current["finishedAt"].is_number());
        assert!(current["retry"].is_null());
        frozen_deadline(&timer,&current["executionTimeout"]);
        let control = reply(&owner,"nesvo_get_run_control",json!({"runId":current["runId"],"controlId":current["executionTimeout"]["controlId"]})).await?;
        assert_eq!(control["data"]["control"]["kind"],"stop");
        assert_eq!(control["data"]["control"]["state"],"completed");
        let targets = control["data"]["targets"].as_array().context("One frozen timeout target")?;
        assert_eq!(targets.len(),1);
        assert_eq!(targets[0]["attemptId"],current["attemptId"]);
        assert_eq!(targets[0]["sessionId"],current["sessionId"]);
        assert_eq!(targets[0]["phase"],"exited");
        let stop = reply(&owner,"nesvo_get_operation",json!({"id":targets[0]["receiptId"]})).await?;
        assert_eq!(stop["data"]["receipt"]["operation"],"stop");
        assert_eq!(stop["data"]["receipt"]["sessionId"],current["sessionId"]);
        assert_eq!(stop["data"]["receipt"]["phase"],"stopRequested");
        assert_eq!(stop["data"]["receipt"]["result"]["nativeStopRequested"],true);
        let preserved = reply(&owner,"nesvo_get_session",json!({"sessionId":independent_id})).await?;
        assert_eq!(preserved["data"]["session"]["running"],true);
        let independent_pid = preserved["data"]["session"]["lifecycle"]["process"]["pid"].as_u64().context("Independent owned PID")?;
        ensure!(process_alive(&fixture,independent_pid).await?,"Independent untimed process must survive another job's timeout");
        let original = reply(&owner,"nesvo_get_job_mutation",json!({"key":"timeout-run"})).await?;
        let replay = reply(&owner,"nesvo_run_job_now",arguments).await?;
        assert_eq!(original["data"],admitted["data"]);
        assert_eq!(replay["data"],admitted["data"]);
        holds_throughout(Duration::from_millis(1500), async || {
            let view = read_occurrence(&owner,job,id).await?;
            ensure!(view["data"]["occurrence"]["state"]=="failed","Timed-out occurrence left failed: {view}");
            Ok(())
        }).await?;
        let stable = read_occurrence(&owner,job,id).await?;
        assert_eq!(stable["data"]["occurrence"]["state"],"failed");
        envelopes.extend(one_generation(&owner,&stable).await?);
        envelopes.extend([independent,created.clone(),create_replay,edited,edit_replay,admitted.clone(),held,session,future,failed,control,stop,preserved,original,replay,stable]);
        phase = "published schema validation";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(
        &mut fixture,
        "Disconnected native execution timeout",
        phase,
        diagnostic_job.as_deref(),
        &discovery,
        outcome,
    )
    .await
}

#[tokio::test]
#[ignore = "native host/CLI/MCP and controlled Node; accepted report disarms execution timeout, no models"]
async fn accepted_report_disarms_execution_timeout_while_explicit_validation_stays_pending()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let mut phase = "provider discovery";
    let mut diagnostic_job = None;
    let mut discovery = DiscoveryEvidence::new();
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(30),async {
        discovery_ready(&fixture, &mut discovery).await?;
        let owner = client(&fixture.pairing()).await?;
        let created = reply(&owner,"nesvo_create_job",json!({"key":"report-disarms-definition","spec":spec("report-task")})).await?;
        let job = created["data"]["job"]["id"].as_str().context("Reported job")?;
        diagnostic_job = Some(job.to_owned());
        let admitted = reply(&owner,"nesvo_run_job_now",json!({"key":"report-disarms-run","jobId":job,"expectedRevision":1})).await?;
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Reported occurrence")?;
        phase = "accepted explicit report before native deadline";
        let reported = occurrence(&owner,job,id,"needsValidation").await?;
        let current = &reported["data"]["occurrence"];
        let timer = current["executionTimeout"].clone();
        frozen_deadline(&timer,&timer);
        assert_eq!(timer["state"],"disarmed");
        assert_eq!(timer["reason"],"report_accepted");
        assert!(timer["observedAt"].as_u64().context("Accepted report time")? < timer["deadlineAt"].as_u64().context("Original deadline")?);
        assert!(timer["requestedAt"].is_null() && timer["controlId"].is_null());
        let worker = current["sessionId"].as_str().context("Reported worker")?;
        let session = reply(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?;
        let pid = session["data"]["session"]["lifecycle"]["process"]["pid"].as_u64().context("Reported owned PID")?;
        phase = "original deadline passes while validation remains pending";
        past_deadline(&timer).await?;
        let pending = read_occurrence(&owner,job,id).await?;
        assert_eq!(pending["data"]["occurrence"]["state"],"needsValidation");
        assert!(pending["data"]["occurrence"]["finishedAt"].is_null());
        assert_eq!(pending["data"]["occurrence"]["executionTimeout"],timer);
        ensure!(process_alive(&fixture,pid).await?,"A reported worker must survive its disarmed deadline");
        phase = "explicit validation after deadline";
        let run = current["runId"].as_str().context("Reported run")?;
        run_checkpoints::mutate(&owner,run,"nesvo_validate_task_result",json!({"key":"validate-after-execution-deadline","attemptId":current["attemptId"],
            "validation":{"passed":true,"summary":"Inspected controlled result before explicit validation","checks":[{"name":"fixture","outcome":"passed","details":"Real scoped report accepted before its native deadline; no model calls"}]}})).await?;
        let succeeded = occurrence(&owner,job,id,"succeeded").await?;
        assert_eq!(succeeded["data"]["occurrence"]["executionTimeout"],timer);
        ensure!(process_alive(&fixture,pid).await?,"Validation must not invent automatic process cleanup");
        let mut envelopes = one_generation(&owner,&succeeded).await?;
        envelopes.extend([created.clone(),admitted.clone(),reported,session,pending,succeeded]);
        phase = "published schema validation";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(
        &mut fixture,
        "Report disarms native execution timeout",
        phase,
        diagnostic_job.as_deref(),
        &discovery,
        outcome,
    )
    .await
}

#[tokio::test]
#[ignore = "native host/CLI/MCP and controlled Node; human lease/epoch fences automatic timeout stop, no models"]
async fn human_lease_and_quick_takeover_release_permanently_block_automatic_timeout_stop()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let mut phase = "provider discovery";
    let mut diagnostic_job = None;
    let mut discovery = DiscoveryEvidence::new();
    let outcome = std::panic::AssertUnwindSafe(timeout(scenario_bound(2),async {
        discovery_ready(&fixture, &mut discovery).await?;
        let owner = client(&fixture.pairing()).await?;
        let mut envelopes = Vec::new();
        for quick_release in [false,true] {
            phase = "admit controlled held worker before human takeover";
            let prefix = if quick_release {"released-takeover"} else {"active-human-lease"};
            let created = reply(&owner,"nesvo_create_job",json!({"key":format!("{prefix}:definition"),"spec":spec("hold-response")})).await?;
            let job = created["data"]["job"]["id"].as_str().context("Human-controlled job")?;
            diagnostic_job = Some(job.to_owned());
            let admitted = reply(&owner,"nesvo_run_job_now",json!({"key":format!("{prefix}:run"),"jobId":job,"expectedRevision":1})).await?;
            let id = admitted["data"]["occurrence"]["id"].as_str().context("Human-controlled occurrence")?;
            let (held,session) = working(&owner,job,id).await?;
            let current = &held["data"]["occurrence"];
            let timer = current["executionTimeout"].clone();
            let worker = current["sessionId"].as_str().context("Human-controlled worker")?;
            let pid = session["data"]["session"]["lifecycle"]["process"]["pid"].as_u64().context("Human-controlled owned PID")?;
            phase = "real human control acquisition before timeout";
            let mut human = Some(human_control_variant(&fixture.pairing(),worker,!quick_release).await?);
            let leased = reply(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?;
            assert!(!leased["data"]["session"]["controllerId"].is_null());
            if quick_release { release_human(human.take().unwrap()).await?; }
            let prior_deadline = reply(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?;
            assert_eq!(prior_deadline["data"]["session"]["controllerId"].is_null(),quick_release);
            ensure!(u64::try_from(chrono::Utc::now().timestamp_millis())? < timer["deadlineAt"].as_u64().context("Human guard deadline")?,"Human takeover/release must complete before the configured deadline");
            phase = "automatic stop blocked at deadline";
            let blocked = resolved_timeout(&owner,job,id,&timer,"blocked").await?;
            let blocked_row = &blocked["data"]["occurrence"];
            assert_eq!(blocked_row["state"],"canceling");
            assert_eq!(blocked_row["reason"],"execution_timeout_blocked");
            assert!(blocked_row["finishedAt"].is_null());
            frozen_deadline(&timer,&blocked_row["executionTimeout"]);
            let control = reply(&owner,"nesvo_get_run_control",json!({"runId":current["runId"],"controlId":blocked_row["executionTimeout"]["controlId"]})).await?;
            assert_eq!(control["data"]["control"]["state"],"blocked");
            let targets = control["data"]["targets"].as_array().context("One protected timeout target")?;
            assert_eq!(targets.len(),1);
            assert_eq!(targets[0]["phase"],"blocked");
            assert_eq!(targets[0]["code"],"control_busy");
            assert_eq!(targets[0]["sessionId"],worker);
            assert_eq!(targets[0]["attemptId"],current["attemptId"]);
            let refused = reply(&owner,"nesvo_get_operation",json!({"id":targets[0]["receiptId"]})).await?;
            assert_eq!(refused["data"]["receipt"]["phase"],"failed");
            assert_eq!(refused["data"]["receipt"]["result"]["code"],"control_busy");
            assert_eq!(refused["data"]["receipt"]["result"]["effectStarted"],false);
            ensure!(process_alive(&fixture,pid).await?,"Automatic timeout must preserve human-controlled worker");
            if let Some(human) = human.take() { release_human(human).await?; }
            let released = reply(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?;
            assert!(released["data"]["session"]["controllerId"].is_null());
            phase = "human release never authorizes deferred automatic stop";
            holds_throughout(Duration::from_millis(1100), async || {
                let view = read_occurrence(&owner,job,id).await?;
                ensure!(view["data"]["occurrence"]["executionTimeout"]["state"]=="blocked","Human release unblocked the automatic stop: {view}");
                Ok(())
            }).await?;
            let retained = read_occurrence(&owner,job,id).await?;
            let retained_timer = &retained["data"]["occurrence"]["executionTimeout"];
            frozen_deadline(&timer,retained_timer);
            assert_eq!(retained_timer["state"],"blocked");
            assert_eq!(retained_timer["controlId"],blocked_row["executionTimeout"]["controlId"]);
            assert_eq!(retained_timer["requestedAt"],blocked_row["executionTimeout"]["requestedAt"]);
            let unchanged_control = reply(&owner,"nesvo_get_run_control",json!({"runId":current["runId"],"controlId":blocked_row["executionTimeout"]["controlId"]})).await?;
            assert_eq!(unchanged_control["data"]["control"]["state"],"blocked");
            assert_eq!(unchanged_control["data"]["targets"][0]["receiptId"],targets[0]["receiptId"]);
            ensure!(process_alive(&fixture,pid).await?,"No deferred signal may follow human release");
            phase = "deliberate owner stop reconciles original blocked timeout";
            let stopped = reply(&owner,"nesvo_stop_session",json!({"key":format!("{prefix}:owner-stop"),"sessionId":worker})).await?;
            let completed = occurrence(&owner,job,id,"failed").await?;
            assert_eq!(completed["data"]["occurrence"]["reason"],"execution_timeout");
            assert_eq!(completed["data"]["occurrence"]["executionTimeout"]["state"],"completed");
            assert_eq!(completed["data"]["occurrence"]["executionTimeout"]["controlId"],blocked_row["executionTimeout"]["controlId"]);
            frozen_deadline(&timer,&completed["data"]["occurrence"]["executionTimeout"]);
            ensure!(!process_alive(&fixture,pid).await?,"Explicit owner stop must observe actual worker exit");
            let final_control = reply(&owner,"nesvo_get_run_control",json!({"runId":current["runId"],"controlId":blocked_row["executionTimeout"]["controlId"]})).await?;
            assert_eq!(final_control["data"]["control"]["state"],"completed");
            assert_eq!(final_control["data"]["targets"][0]["phase"],"exited");
            assert_eq!(final_control["data"]["targets"][0]["receiptId"],targets[0]["receiptId"]);
            envelopes.extend(one_generation(&owner,&completed).await?);
            envelopes.extend([created.clone(),admitted.clone(),held,session,leased,prior_deadline,blocked,control,refused,released,retained,unchanged_control,stopped,completed,final_control]);
        }
        phase = "published schema validation";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(
        &mut fixture,
        "Human priority over automatic job timeout",
        phase,
        diagnostic_job.as_deref(),
        &discovery,
        outcome,
    )
    .await
}
