use super::*;

async fn diagnostic_cli(fixture: &Fixture, args: &[&str]) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .arg("--pairing")
        .arg(fixture.pairing())
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    match timeout(Duration::from_secs(1), command.output()).await {
        Ok(Ok(output)) => json!({
            "exitCode":output.status.code(),
            "reply":serde_json::from_slice::<Value>(&output.stdout).unwrap_or_else(|_| {
                json!({"unparsedStdout":String::from_utf8_lossy(&output.stdout).chars().take(1024).collect::<String>()})
            }),
            "stderr":String::from_utf8_lossy(&output.stderr).chars().take(1024).collect::<String>()
        }),
        Ok(Err(error)) => json!({"error":error.to_string()}),
        Err(_) => json!({"error":"Diagnostic CLI query exceeded one second"}),
    }
}

pub(super) async fn report_timeout_diagnostics(fixture: &mut Fixture, job: &str) -> Value {
    let host = match fixture.host.try_wait() {
        Ok(Some(status)) => json!({"exited":true,"exitCode":status.code()}),
        Ok(None) => json!({"exited":false}),
        Err(error) => json!({"error":error.to_string()}),
    };
    let mut diagnostics = json!({"host":host});
    let observed = timeout(Duration::from_millis(3800), async {
        let history_args = ["job", "history", job, "--json"];
        let definition_args = ["job", "show", job, "--json"];
        let (history, doctor, definition) = tokio::join!(
            diagnostic_cli(fixture, &history_args),
            diagnostic_cli(fixture, &["doctor", "--json"]),
            diagnostic_cli(fixture, &definition_args),
        );
        diagnostics["history"] = history;
        diagnostics["providerProbe"] = json!({
            "exitCode":doctor["exitCode"],"stderr":doctor["stderr"],"error":doctor["error"],
            "providerVersions":doctor["reply"]["providerVersions"],
            "eventJournal":doctor["reply"]["eventJournal"],
            "replyError":doctor["reply"]["error"]
        });
        diagnostics["job"] = definition;
        let occurrence = &diagnostics["history"]["reply"]["data"]["occurrences"][0];
        let run_id = occurrence["runId"].as_str().map(str::to_owned);
        let receipt = occurrence["launchReceiptId"].as_str().map(str::to_owned);
        let session = occurrence["sessionId"].as_str().map(str::to_owned);
        let (run, receipt, transcript, session_state) = tokio::join!(
            async {
                match run_id.as_deref() {
                    Some(run) => diagnostic_cli(fixture, &["run", "get", run, "--json"]).await,
                    None => Value::Null,
                }
            },
            async {
                match receipt {
                    Some(receipt) => {
                        diagnostic_cli(fixture, &["operation", &receipt, "--json"]).await
                    }
                    None => Value::Null,
                }
            },
            async {
                match session.as_deref() {
                    Some(session) => {
                        diagnostic_cli(
                            fixture,
                            &["session", "read", session, "--max-bytes", "2048", "--json"],
                        )
                        .await
                    }
                    None => Value::Null,
                }
            },
            async {
                match session.as_deref() {
                    Some(session) => {
                        diagnostic_cli(fixture, &["session", "get", session, "--json"]).await
                    }
                    None => Value::Null,
                }
            },
        );
        diagnostics["run"] = run;
        diagnostics["launchReceipt"] = receipt;
        diagnostics["controlledWorkerOutput"] = transcript;
        diagnostics["session"] = session_state;
        let task_id = diagnostics["run"]["reply"]["data"]["tasks"][0]["id"]
            .as_str()
            .map(str::to_owned);
        if let (Some(run), Some(task)) = (run_id, task_id) {
            diagnostics["taskAttempts"] =
                diagnostic_cli(fixture, &["run", "task", &run, &task, "--json"]).await;
        }
    })
    .await;
    if observed.is_err() {
        diagnostics["diagnosticDeadlineElapsed"] = true.into();
    }
    diagnostics
}

fn retry_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(str::to_owned)
}

#[derive(Clone)]
pub(super) struct RetryOccurrence {
    pub job_id: String,
    pub occurrence_id: String,
    pub run_id: Option<String>,
    pub attempt_id: Option<String>,
    pub session_id: Option<String>,
    pub launch_receipt_id: Option<String>,
    pub job_attempt_id: Option<String>,
    view: Value,
}

pub(super) struct RetryWaitObservation {
    job: String,
    occurrence: String,
    current: Option<RetryOccurrence>,
    queries: u64,
    successes: u64,
    last_success_ms: Option<u64>,
    pending_since_ms: Option<u64>,
    last_query: &'static str,
}
impl RetryWaitObservation {
    pub fn new(job: &str, occurrence: &str) -> Self {
        Self {
            job: job.into(),
            occurrence: occurrence.into(),
            current: None,
            queries: 0,
            successes: 0,
            last_success_ms: None,
            pending_since_ms: None,
            last_query: "notStarted",
        }
    }
    pub fn started(&mut self, elapsed: Duration) {
        self.queries += 1;
        self.pending_since_ms = Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
        self.last_query = "pending";
    }
    pub fn completed(&mut self, value: &Value, elapsed: Duration) {
        self.pending_since_ms = None;
        let row = &value["data"]["occurrence"];
        if retry_id(&row["jobId"]).as_deref() != Some(self.job.as_str())
            || retry_id(&row["id"]).as_deref() != Some(self.occurrence.as_str())
        {
            self.last_query = "scopeMismatch";
            return;
        }
        self.successes += 1;
        self.last_success_ms = Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
        self.last_query = "observed";
        self.current = Some(RetryOccurrence {
            job_id: self.job.clone(),
            occurrence_id: self.occurrence.clone(),
            run_id: retry_id(&row["runId"]),
            attempt_id: retry_id(&row["attemptId"]),
            session_id: retry_id(&row["sessionId"]),
            launch_receipt_id: retry_id(&row["launchReceiptId"]),
            job_attempt_id: retry_id(&row["jobAttemptId"]),
            view: retry_fields(
                row,
                &[
                    "id",
                    "jobId",
                    "state",
                    "reason",
                    "jobAttemptOrdinal",
                    "runId",
                    "attemptId",
                    "sessionId",
                    "launchReceiptId",
                    "jobAttemptId",
                ],
            ),
        });
    }
    pub fn failed(&mut self) {
        self.pending_since_ms = None;
        self.last_query = "queryError";
    }
    pub fn summary(&self, elapsed: Duration) -> Value {
        let elapsed = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
        json!({"elapsedMs":elapsed,"queriesStarted":self.queries,"successfulPolls":self.successes,
            "lastQueryOutcome":self.last_query,"lastSuccessElapsedMs":self.last_success_ms,
            "lastSuccessAgeMs":self.last_success_ms.map(|at|elapsed.saturating_sub(at)),
            "inFlightAtDeadline":self.pending_since_ms.is_some(),
            "pendingQueryElapsedMs":self.pending_since_ms.map(|at|elapsed.saturating_sub(at)),
            "occurrence":self.current.as_ref().map(|current|&current.view)})
    }
}

fn retry_fields(value: &Value, fields: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for field in fields {
        let Some(value) = value.get(*field) else {
            continue;
        };
        let accepted = if value.is_null() {
            Some(Value::Null)
        } else if matches!(
            *field,
            "id" | "jobId"
                | "runId"
                | "attemptId"
                | "sessionId"
                | "launchId"
                | "receiptId"
                | "launchReceiptId"
                | "jobAttemptId"
                | "taskId"
        ) {
            retry_id(value).map(Value::String)
        } else if value.is_boolean() || value.is_u64() || value.is_i64() {
            Some(value.clone())
        } else {
            value.as_str().map(|text| {
                json!(if matches!(
                    text,
                    "queued"
                        | "dispatching"
                        | "running"
                        | "retryWaiting"
                        | "needsValidation"
                        | "assigned"
                        | "launching"
                        | "launchFailed"
                        | "launchUnknown"
                        | "created"
                        | "accepted"
                        | "received"
                        | "delivered"
                        | "sent"
                        | "started"
                        | "settled"
                        | "interrupted"
                        | "unknown"
                        | "failed"
                        | "canceled"
                        | "canceling"
                        | "active"
                        | "paused"
                        | "draining"
                        | "stopped"
                        | "reported"
                        | "succeeded"
                        | "notApplicable"
                        | "starting"
                        | "waiting"
                        | "ready"
                        | "timedOut"
                        | "expired"
                        | "exited"
                        | "idle"
                        | "working"
                        | "blocked"
                        | "question"
                        | "done"
                        | "hook"
                        | "program"
                        | "screen"
                        | "process"
                        | "activity"
                        | "create"
                        | "send"
                        | "interrupt"
                        | "stop"
                        | "prepare"
                        | "pasteFence"
                        | "pasteFlush"
                        | "pasteDelay"
                        | "submitFence"
                        | "submitFlush"
                        | "notObserved"
                        | "missing"
                        | "unreadable"
                        | "oversized"
                        | "malformed"
                        | "gap"
                        | "queueUnreadable"
                        | "submission_unconfirmed"
                        | "lifecycle_pending"
                        | "editor_pending"
                        | "native_write_timeout"
                        | "native_write_closed"
                        | "native_write_failed"
                        | "instruction_not_sent"
                        | "worker_result_pending"
                        | "input_unknown"
                        | "launch_unconfirmed"
                        | "decision_pending"
                        | "decision_unresolved"
                        | "validation_pending"
                        | "human_or_authority_pause"
                        | "host_stopping"
                        | "busy"
                        | "scope_revoked"
                        | "forbidden"
                        | "session_not_found"
                        | "operation_not_found"
                        | "attempt_not_found"
                        | "job_generation_retired"
                        | "occurrence_conflict"
                        | "unsupported"
                        | "timeout"
                        | "host_unavailable"
                        | "conversation_changed"
                        | "submission_preempted"
                        | "executor_unavailable"
                        | "claude"
                        | "codex"
                        | "gemini"
                        | "shell"
                        | "checking"
                        | "unavailable"
                ) {
                    text
                } else {
                    "other"
                })
            })
        };
        if let Some(value) = accepted {
            result.insert((*field).into(), value);
        }
    }
    Value::Object(result)
}
fn retry_submission_fence(value: &Value) -> Value {
    let Some(value) = value.as_object() else {
        return Value::Null;
    };
    let substage = value
        .get("substage")
        .and_then(Value::as_str)
        .filter(|label| matches!(*label, "runGuard" | "lifecycleRead" | "queueAdmission"))
        .unwrap_or("other");
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .filter(|label| {
            matches!(
                *label,
                "sqlBusy"
                    | "sqlLocked"
                    | "io"
                    | "invalidData"
                    | "joinFailed"
                    | "queueFull"
                    | "queueClosed"
                    | "unknown"
            )
        })
        .unwrap_or("other");
    json!({"substage":substage,"reason":reason})
}
fn retry_native(value: &Value) -> Value {
    let mut result = retry_fields(value, &["id", "operation", "sessionId", "phase"]);
    result["result"] = retry_fields(
        &value["result"],
        &[
            "code",
            "effectStarted",
            "submissionStage",
            "nativeWriteFlushed",
            "providerPromptObserved",
            "nativeStopRequested",
            "processExited",
        ],
    );
    if let Some(fence) = value["result"].get("submissionFence") {
        result["result"]["submissionFence"] = retry_submission_fence(fence);
    }
    result
}

fn retry_integration_delivery(value: &Value) -> Value {
    let Some(outcome) = value.get("outcome").and_then(Value::as_str) else {
        return Value::Null;
    };
    let Some(helper_error) = value.get("helperError").and_then(Value::as_bool) else {
        return Value::Null;
    };
    if !matches!(
        outcome,
        "notObserved"
            | "missing"
            | "unreadable"
            | "oversized"
            | "malformed"
            | "received"
            | "gap"
            | "queueUnreadable"
    ) {
        return Value::Null;
    }
    json!({"outcome":outcome,"helperError":helper_error})
}

struct RetryRead {
    outcome: &'static str,
    value: Option<Value>,
}
impl RetryRead {
    fn value(&self) -> &Value {
        self.value.as_ref().unwrap_or(&Value::Null)
    }
}
async fn retry_read(
    owner: &RunningService<RoleClient, ()>,
    tool: &'static str,
    args: Value,
) -> RetryRead {
    let (outcome, value) = match timeout(Duration::from_millis(600), call(owner, tool, args)).await
    {
        Ok(Ok(reply)) => match reply.structured_content {
            Some(value) if reply.is_error != Some(true) && value["ok"] == true => {
                ("observed", Some(value))
            }
            Some(_) => ("refused", None),
            None => ("malformed", None),
        },
        Ok(Err(_)) => ("transportUnavailable", None),
        Err(_) => ("deadlineElapsed", None),
    };
    RetryRead { outcome, value }
}
fn retry_attempt(value: &Value) -> Value {
    let mut result = retry_fields(value, &["id", "taskId", "state", "sessionId", "ordinal"]);
    result["launch"] = retry_fields(
        &value["launch"],
        &[
            "attemptId",
            "receiptId",
            "phase",
            "sessionId",
            "code",
            "effectStarted",
        ],
    );
    result["delivery"] = retry_fields(
        &value["delivery"],
        &[
            "id",
            "attemptId",
            "phase",
            "blocker",
            "receiptId",
            "createdAt",
            "deadlineAt",
        ],
    );
    result["delivery"]["native"] = retry_native(&value["delivery"]["native"]);
    result
}
fn retry_explain(value: &Value, session: &str) -> Value {
    let Some(row) = value["data"]["report"]["sessions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["sessionId"] == session))
    else {
        return Value::Null;
    };
    let mut result = retry_fields(row, &["sessionId", "running"]);
    result["process"] = retry_fields(&row["processIdentity"], &["pid", "launchId"]);
    result["inputOperation"] = retry_fields(
        &row["inputOperation"],
        &["id", "queued", "canceled", "correlated"],
    );
    result["readiness"] = retry_fields(&row["readiness"], &["phase", "initialized"]);
    result["status"] = retry_fields(
        &row["status"]["selected"],
        &["state", "source", "updatedAt"],
    );
    result["hook"] = retry_fields(
        &row["status"]["hook"],
        &["state", "sequence", "receivedAt", "ageMs"],
    );
    result["turn"] = retry_fields(&row["turn"], &["generation", "phase", "elapsedSeconds"]);
    if let Some(id) = retry_turn_id(&row["turn"]["id"]) {
        result["turn"]["id"] = json!(id);
    }
    result["integration"] = retry_fields(
        &row["integration"],
        &["configured", "cursor", "shadowSequence", "gap"],
    );
    result["integration"]["delivery"] = retry_integration_delivery(&row["integration"]["delivery"]);
    result
}

fn retry_turn_id(value: &Value) -> Option<&str> {
    let id = value.as_str()?;
    let (launch, sequence) = id.split_once(':')?;
    (launch.len() == 32
        && launch
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && !sequence.is_empty()
        && sequence.len() <= 20
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.parse::<u64>().is_ok())
    .then_some(id)
}

pub(super) async fn retry_timeout_diagnostics(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    observation: &RetryWaitObservation,
    elapsed: Duration,
) -> Value {
    let host = match fixture.host.try_wait() {
        Ok(Some(status)) => json!({"state":"exited","exitCode":status.code()}),
        Ok(None) => json!({"state":"running"}),
        Err(_) => json!({"state":"unavailable"}),
    };
    let mut result = json!({"wait":observation.summary(elapsed),"host":host,"queries":{},
        "stageFilesAreCompletionProof":false});
    let Some(current) = &observation.current else {
        return result;
    };
    let collected = timeout(Duration::from_millis(3800),async {
        let (run,operation,explain) = tokio::join!(
            async {match &current.run_id {Some(id)=>retry_read(owner,"nesvo_get_run",json!({"runId":id})).await,None=>RetryRead{outcome:"notObserved",value:None}}},
            async {match &current.launch_receipt_id {Some(id)=>retry_read(owner,"nesvo_get_operation",json!({"id":id})).await,None=>RetryRead{outcome:"notObserved",value:None}}},
            async {match &current.session_id {Some(id)=>retry_read(owner,"nesvo_explain_session",json!({"sessionId":id})).await,None=>RetryRead{outcome:"notObserved",value:None}}},
        );
        result["queries"] = json!({"run":run.outcome,"launchOperation":operation.outcome,"explain":explain.outcome});
        result["run"] = retry_fields(&run.value()["data"]["run"],&["id","state","revision"]);
        result["launchOperation"] = retry_native(&operation.value()["data"]["receipt"]);
        result["session"] = current.session_id.as_deref().map_or(Value::Null,|id|retry_explain(explain.value(),id));
        result["providerStates"] = explain.value()["data"]["report"]["providerVersions"].as_array()
            .map(|rows|Value::Array(rows.iter().take(3).map(|row|retry_fields(row,&["program","status"])).collect()))
            .unwrap_or(Value::Null);
        result["eventJournal"] = retry_fields(&explain.value()["data"]["report"]["eventJournal"],
            &["observationDrops","writeFailures"]);
        let task = run.value()["data"]["tasks"].as_array().and_then(|tasks|tasks.iter()
            .find(|task|retry_id(&task["currentAttempt"]["id"]) == current.attempt_id))
            .and_then(|task|retry_id(&task["id"]));
        if let (Some(run),Some(task),Some(attempt)) = (&current.run_id,task,&current.attempt_id) {
            let native = retry_read(owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await;
            result["queries"]["nativeAttempt"] = json!(native.outcome);
            result["attempt"] = native.value()["data"]["attempts"].as_array()
                .and_then(|rows|rows.iter().find(|row|retry_id(&row["id"]).as_ref() == Some(attempt)))
                .map_or(Value::Null,retry_attempt);
        } else if let Some(generation) = &current.job_attempt_id {
            let generation = retry_read(owner,"nesvo_get_job_attempt",json!({"jobId":current.job_id,
                "occurrenceId":current.occurrence_id,"jobAttemptId":generation})).await;
            result["queries"]["jobAttempt"] = json!(generation.outcome);
            result["jobAttempt"] = retry_fields(&generation.value()["data"]["jobAttempt"],
                &["id","state","runId","attemptId","sessionId","launchReceiptId","claimedAt","finishedAt"]);
        }
        if let Some(session) = &current.session_id {
            let callers = fixture.directory.join("callers");
            let session = session.clone();
            if let Ok(stages) = tokio::task::spawn_blocking(move || {
                let mut stages = serde_json::Map::new();
                for (key,suffix) in [("callerContextPresent","txt"),("launchArgumentsPresent","launch-argv.json"),
                    ("reportInputPresent","report-input.json"),("reportReplyPresent","result.json")] {
                    let present = std::fs::metadata(callers.join(format!("{session}.{suffix}")))
                        .is_ok_and(|metadata|metadata.is_file());
                    stages.insert(key.into(),json!(present));
                }
                stages
            }).await {
                result["fixtureStages"] = Value::Object(stages);
            }
        }
    }).await;
    if collected.is_err() {
        result["diagnosticDeadlineElapsed"] = json!(true);
    }
    result
}

#[cfg(test)]
mod retry_evidence_tests {
    use super::*;
    fn snapshot() -> Value {
        json!({"data":{"occurrence":{"jobId":"1".repeat(32),"id":"2".repeat(32),
            "runId":"3".repeat(32),"attemptId":"4".repeat(32),"sessionId":"5".repeat(32),
            "launchReceiptId":"6".repeat(32),"jobAttemptId":"7".repeat(32),"state":"running",
            "jobAttemptOrdinal":2,"reason":null,"spec":{"instruction":"PRIVATE_PROMPT"}}}})
    }
    #[test]
    fn retry_wait_retains_exact_pointers_after_query_error_without_error_display() {
        let mut observation = RetryWaitObservation::new(&"1".repeat(32), &"2".repeat(32));
        observation.started(Duration::ZERO);
        observation.completed(&snapshot(), Duration::from_millis(10));
        observation.started(Duration::from_millis(20));
        observation.failed();
        let summary = observation.summary(Duration::from_millis(50));
        assert_eq!(summary["occurrence"]["runId"], "3".repeat(32));
        assert_eq!(summary["occurrence"]["launchReceiptId"], "6".repeat(32));
        assert_eq!(summary["lastQueryOutcome"], "queryError");
        assert_eq!(summary["successfulPolls"], 1);
        assert!(!summary.to_string().contains("PRIVATE_PROMPT"));
    }
    #[test]
    fn retry_wait_distinguishes_pending_query_from_repeated_successful_running_polls() {
        let mut observation = RetryWaitObservation::new(&"1".repeat(32), &"2".repeat(32));
        observation.started(Duration::ZERO);
        observation.completed(&snapshot(), Duration::from_millis(10));
        observation.started(Duration::from_millis(20));
        let pending = observation.summary(Duration::from_millis(50));
        assert_eq!(pending["inFlightAtDeadline"], true);
        assert_eq!(pending["pendingQueryElapsedMs"], 30);
        assert_eq!(pending["lastSuccessAgeMs"], 40);
        observation.completed(&snapshot(), Duration::from_millis(55));
        let progressing = observation.summary(Duration::from_millis(60));
        assert_eq!(progressing["inFlightAtDeadline"], false);
        assert_eq!(progressing["successfulPolls"], 2);
        assert_eq!(progressing["lastSuccessAgeMs"], 5);
    }
    #[test]
    fn retry_wait_foreign_or_malformed_reply_never_replaces_retained_scope() {
        let mut observation = RetryWaitObservation::new(&"1".repeat(32), &"2".repeat(32));
        observation.completed(&snapshot(), Duration::ZERO);
        let mut foreign = snapshot();
        foreign["data"]["occurrence"]["id"] = json!("8".repeat(32));
        observation.completed(&foreign, Duration::from_millis(1));
        observation.completed(&json!({"data":{}}), Duration::from_millis(2));
        let summary = observation.summary(Duration::from_millis(3));
        assert_eq!(summary["lastQueryOutcome"], "scopeMismatch");
        assert_eq!(summary["occurrence"]["id"], "2".repeat(32));
    }
    #[test]
    fn retry_evidence_projects_delivery_boundary_and_drops_payload_paths_and_raw_errors() {
        let attempt = retry_attempt(&json!({"id":"4".repeat(32),"state":"assigned",
            "instruction":"PRIVATE_PROMPT","cwd":"C:/PRIVATE_PATH","stderr":"PRIVATE_STDERR",
            "launch":{"receiptId":"6".repeat(32),"phase":"created","directory":"PRIVATE_PATH"},
            "delivery":{"phase":"failed","blocker":"submission_unconfirmed","native":{
                "phase":"failed","result":{"code":"submission_unconfirmed","submissionStage":"pasteFence",
                    "effectStarted":false,"message":"PRIVATE_STDERR","prompt":"PRIVATE_PROMPT",
                    "submissionFence":{"substage":"lifecycleRead","reason":"sqlBusy",
                        "message":"PRIVATE_STDERR","path":"PRIVATE_PATH"}}}}}));
        assert_eq!(
            attempt["delivery"]["native"]["result"]["submissionStage"],
            "pasteFence"
        );
        assert_eq!(
            attempt["delivery"]["native"]["result"]["effectStarted"],
            false
        );
        assert_eq!(
            attempt["delivery"]["native"]["result"]["submissionFence"],
            json!({"substage":"lifecycleRead","reason":"sqlBusy"})
        );
        let encoded = attempt.to_string();
        for private in ["PRIVATE_PROMPT", "PRIVATE_PATH", "PRIVATE_STDERR"] {
            assert!(!encoded.contains(private));
        }
    }
    #[test]
    fn retry_native_keeps_only_fixed_submission_fence_labels_and_presence() {
        for substage in ["runGuard", "lifecycleRead", "queueAdmission"] {
            for reason in [
                "sqlBusy",
                "sqlLocked",
                "io",
                "invalidData",
                "joinFailed",
                "queueFull",
                "queueClosed",
                "unknown",
            ] {
                let projected = retry_native(&json!({"result":{"submissionFence":{
                    "substage":substage,"reason":reason,"path":"PRIVATE_PATH",
                    "prompt":"PRIVATE_PROMPT","rawError":"PRIVATE_STDERR"}}}));
                assert_eq!(
                    projected["result"]["submissionFence"],
                    json!({"substage":substage,"reason":reason})
                );
                for secret in ["PRIVATE_PATH", "PRIVATE_PROMPT", "PRIVATE_STDERR"] {
                    assert!(!projected.to_string().contains(secret));
                }
            }
        }
        let unknown = retry_native(&json!({"result":{"submissionFence":{
            "substage":"PRIVATE_PATH","reason":"PRIVATE_STDERR","payload":"PRIVATE_PROMPT"}}}));
        assert_eq!(
            unknown["result"]["submissionFence"],
            json!({"substage":"other","reason":"other"})
        );
        assert!(!unknown.to_string().contains("PRIVATE_"));
        assert!(
            retry_native(&json!({"result":{}}))["result"]
                .get("submissionFence")
                .is_none()
        );
        for invalid in [
            Value::Null,
            json!("PRIVATE_STDERR"),
            json!(["PRIVATE_PROMPT"]),
        ] {
            assert_eq!(
                retry_native(&json!({"result":{"submissionFence":invalid}}))["result"]["submissionFence"],
                Value::Null
            );
        }
    }
    #[test]
    fn retry_integration_delivery_uses_actual_camel_case_object_only() {
        for outcome in [
            "notObserved",
            "missing",
            "unreadable",
            "oversized",
            "malformed",
            "received",
            "gap",
            "queueUnreadable",
        ] {
            for helper_error in [false, true] {
                assert_eq!(
                    retry_integration_delivery(&json!({"outcome":outcome,
                    "helperError":helper_error,"helper_error":"PRIVATE_STDERR","path":"PRIVATE_PATH"})),
                    json!({"outcome":outcome,"helperError":helper_error})
                );
            }
        }
        for invalid in [
            json!("received"),
            Value::Null,
            json!({"outcome":"received","helper_error":false}),
            json!({"outcome":"PRIVATE_STDERR","helperError":false}),
            json!({"outcome":"received","helperError":"PRIVATE_PATH"}),
        ] {
            assert_eq!(retry_integration_delivery(&invalid), Value::Null);
        }
    }
    #[test]
    fn retry_explain_keeps_ordering_and_input_facts_without_native_payload_or_identity() {
        let session = "5".repeat(32);
        let projected = retry_explain(
            &json!({"data":{"report":{"sessions":[{
                "sessionId":session,"running":true,"conversationIdentity":{"providerSessionId":"PRIVATE_IDENTITY"},
                "cwd":"PRIVATE_PATH","nativeQuotaCallback":{"raw":"PRIVATE_PAYLOAD"},
                "processIdentity":{"pid":123,"launchId":session,"launchedAt":10,"cwd":"PRIVATE_PATH"},
                "inputOperation":{"id":"6".repeat(32),"queued":false,"canceled":false,"correlated":true,"prompt":"PRIVATE_PROMPT"},
                "status":{"selected":{"state":"idle","source":"hook","updatedAt":10},
                    "screenHint":"PRIVATE_PAYLOAD","matchedRule":"PRIVATE_PAYLOAD", "hook":{"sequence":3}},
                "readiness":{"phase":"ready","initialized":true,"reason":"PRIVATE_PATH"},
                "turn":{"id":format!("{session}:3"),"generation":2,"phase":"settled","elapsedSeconds":4},
                "integration":{"configured":true,"cursor":3,"shadowSequence":3,"gap":false,
                    "delivery":{"outcome":"received","helperError":false},"raw":"PRIVATE_PAYLOAD"}
            }]}}}),
            &session,
        );
        assert_eq!(projected["inputOperation"]["queued"], false);
        assert_eq!(
            projected["inputOperation"],
            json!({"id":"6".repeat(32),"queued":false,"canceled":false,"correlated":true})
        );
        assert_eq!(projected["process"], json!({"pid":123,"launchId":session}));
        assert_eq!(
            projected["readiness"],
            json!({"phase":"ready","initialized":true})
        );
        assert_eq!(projected["integration"]["cursor"], 3);
        assert_eq!(
            projected["integration"]["delivery"],
            json!({"outcome":"received","helperError":false})
        );
        assert_eq!(projected["status"]["state"], "idle");
        assert_eq!(projected["turn"]["id"], format!("{session}:3"));
        for private in [
            "PRIVATE_IDENTITY",
            "PRIVATE_PATH",
            "PRIVATE_PAYLOAD",
            "PRIVATE_PROMPT",
        ] {
            assert!(!projected.to_string().contains(private));
        }
    }
    #[test]
    fn retry_turn_identity_and_delivery_phases_match_the_host_without_arbitrary_text() {
        let launch = "5".repeat(32);
        for sequence in [0, 3, u64::MAX] {
            let id = json!(format!("{launch}:{sequence}"));
            assert_eq!(retry_turn_id(&id), id.as_str());
        }
        for invalid in [
            Value::Null,
            json!(format!("{launch}:18446744073709551616")),
            json!(format!("{launch}:")),
            json!(format!("{launch}:+3")),
            json!(format!("{launch}:3:4")),
            json!(format!("{launch}:PRIVATE_PROMPT")),
            json!("PRIVATE_PATH:3"),
        ] {
            assert!(retry_turn_id(&invalid).is_none());
        }
        for phase in [
            "queued",
            "dispatching",
            "sent",
            "failed",
            "unknown",
            "paused",
            "expired",
            "canceled",
        ] {
            assert_eq!(
                retry_attempt(&json!({"delivery":{"phase":phase}}))["delivery"]["phase"],
                phase
            );
        }
        assert_eq!(
            retry_attempt(&json!({"delivery":{"phase":"PRIVATE_PROMPT"}}))["delivery"]["phase"],
            "other"
        );
    }
}
