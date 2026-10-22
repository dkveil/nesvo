use super::*;

pub(super) async fn occurrence(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    id: &str,
    wanted: &str,
) -> Result<Value> {
    loop {
        let view = data(
            call(
                owner,
                "nesvo_get_job_occurrence",
                json!({"jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        let state = &view["data"]["occurrence"]["state"];
        if state == wanted {
            return Ok(view);
        }
        ensure!(
            !state
                .as_str()
                .is_some_and(|state| SETTLED_OCCURRENCE.contains(&state)),
            "Bound occurrence settled before reaching {wanted}: {view}"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

const SETTLED_OCCURRENCE: [&str; 4] = ["succeeded", "failed", "skipped", "canceled"];

fn diagnostic_fields(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|field| {
                value
                    .get(*field)
                    .map(|value| ((*field).into(), value.clone()))
            })
            .collect(),
    )
}

fn diagnostic_native(value: &Value) -> Value {
    let mut summary = diagnostic_fields(value, &["id", "operation", "sessionId", "phase"]);
    summary["result"] = diagnostic_fields(
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
    summary
}

async fn failed_initial_report_diagnostics(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    occurrence: &str,
) -> Value {
    let actual = job_diagnostics::report_timeout_diagnostics(fixture, job).await;
    let unavailable = Value::Null;
    let current = actual["history"]["reply"]["data"]["occurrences"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == occurrence))
        .unwrap_or(&unavailable);
    let attempt_id = current["attemptId"].as_str();
    let attempt = actual["taskAttempts"]["reply"]["data"]["attempts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"].as_str() == attempt_id))
        .unwrap_or(&unavailable);
    let mut diagnostics = json!({
        "jobId":job,"occurrenceId":occurrence,
        "host":diagnostic_fields(&actual["host"],&["exited","exitCode"]),
        "providerProbe":diagnostic_fields(&actual["providerProbe"],&["providerVersions","eventJournal"]),
        "diagnosticDeadlineElapsed":actual["diagnosticDeadlineElapsed"],
        "occurrence":diagnostic_fields(current,&[
            "id","state","reason","runId","attemptId","sessionId","jobAttemptId","launchReceiptId"
        ]),
        "run":diagnostic_fields(&actual["run"]["reply"]["data"]["run"],&[
            "id","state","revision","reason"
        ]),
        "attempt":diagnostic_fields(attempt,&["id","taskId","state","sessionId","ordinal"]),
        "launch":diagnostic_fields(&attempt["launch"],&["attemptId","receiptId","phase","sessionId"]),
        "launchOperation":diagnostic_native(&actual["launchReceipt"]["reply"]["data"]["receipt"]),
        "delivery":diagnostic_fields(&attempt["delivery"],&[
            "id","attemptId","phase","blocker","receiptId","createdAt","deadlineAt"
        ]),
        "deliveryNative":diagnostic_native(&attempt["delivery"]["native"]),
        "session":diagnostic_fields(&actual["session"]["reply"]["data"]["session"],&[
            "id","program","running","status","readiness","turn","lifecycle","inputOperation"
        ])
    });
    if let Some(session) = current["sessionId"].as_str() {
        let explain = timeout(
            Duration::from_millis(600),
            call(owner, "nesvo_explain_session", json!({"sessionId":session})),
        )
        .await;
        diagnostics["explain"] = match explain {
            Ok(Ok(reply)) => match reply.structured_content {
                Some(reply) if reply["ok"] == true => match reply["data"]["report"]["sessions"]
                    .as_array()
                    .and_then(|sessions| {
                        sessions.iter().find(|entry| entry["sessionId"] == session)
                    }) {
                    Some(entry) => diagnostic_fields(
                        entry,
                        &[
                            "sessionId",
                            "running",
                            "processIdentity",
                            "inputOperation",
                            "integration",
                            "status",
                            "readiness",
                            "turn",
                            "publicationLatency",
                        ],
                    ),
                    None => json!({"errorCode":"diagnostic_session_unavailable"}),
                },
                Some(reply) => json!({"errorCode":reply["error"]["code"]}),
                None => json!({"errorCode":"diagnostic_response_unavailable"}),
            },
            Ok(Err(_)) => json!({"errorCode":"diagnostic_transport_unavailable"}),
            Err(_) => json!({"errorCode":"diagnostic_deadline_elapsed"}),
        };
    }
    diagnostics
}

pub(super) async fn process_alive(fixture: &Fixture, pid: u64) -> Result<bool> {
    let mut command = Command::new(fixture.directory.join("bin").join(if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }));
    command.args([
        "-e",
        "try { process.kill(Number(process.argv[1]), 0); process.stdout.write('alive'); } catch (error) { if (error.code !== 'ESRCH') throw error; process.stdout.write('gone'); }",
        &pid.to_string(),
    ]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(2), command.output()).await??;
    ensure!(
        output.status.success(),
        "Read-only owned PID probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    match output.stdout.as_slice() {
        b"alive" => Ok(true),
        b"gone" => Ok(false),
        _ => anyhow::bail!("Unexpected owned PID observation"),
    }
}

#[tokio::test]
#[ignore = "native CLI/host and controlled Node worker; actual job stop/exit, no models"]
async fn bound_job_cancel_stops_the_exact_worker_and_retains_original_pending_acceptance()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(20), async {
        let owner = client(&fixture.pairing()).await?;
        let created = data(call(&owner, "nesvo_create_job", json!({
            "key":"bound-cancel-definition",
            "spec":{
                "title":"Bound cancellation",
                "instruction":"report-task",
                "profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
                "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}
            }
        })).await?)?;
        let job = created["data"]["job"]["id"].as_str().context("Bound job ID")?;
        let admitted = data(call(&owner, "nesvo_run_job_now", json!({
            "key":"bound-cancel-run-now","jobId":job,"expectedRevision":1
        })).await?)?;
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Bound occurrence ID")?;
        let reported = match occurrence(&owner, job, id, "needsValidation").await {
            Ok(reported) => reported,
            Err(error) => {
                let diagnostics = failed_initial_report_diagnostics(&mut fixture, &owner, job, id).await;
                return Err(error.context(format!("Bound initial report diagnostics: {diagnostics}")));
            }
        };
        let current = &reported["data"]["occurrence"];
        let run = current["runId"].as_str().context("Bound native run")?;
        let worker = current["sessionId"].as_str().context("Bound worker session")?;
        let attempt = current["attemptId"].as_str().context("Bound native attempt")?;
        let before = data(call(&owner,"nesvo_get_run",json!({"runId":run})).await?)?;
        let task = before["data"]["tasks"][0]["id"].as_str().context("Bound task")?;
        assert_eq!(before["data"]["tasks"][0]["currentAttempt"]["id"],attempt);
        assert_eq!(before["data"]["tasks"][0]["state"],"reported");
        assert_eq!(before["data"]["tasks"][0]["attempts"],1);
        assert!(current["finishedAt"].is_null(),"A report is not validated job success");
        let alive = data(call(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?)?;
        assert_eq!(alive["data"]["session"]["running"],true);
        let pid = alive["data"]["session"]["lifecycle"]["process"]["pid"]
            .as_u64().context("Owned worker PID")?;
        ensure!(process_alive(&fixture,pid).await?,"Worker must still exist before cancellation");

        let accepted = budgets::owner_cli(&fixture,&[
            "job","cancel",job,id,"--key","cancel-bound-worker","--json"
        ]).await?;
        assert_eq!(accepted["data"]["occurrence"]["state"],"canceling");
        assert_eq!(accepted["data"]["occurrence"]["cancellation"]["state"],"requested");
        assert!(accepted["data"]["occurrence"]["finishedAt"].is_null());
        let arguments = json!({"key":"cancel-bound-worker","jobId":job,"occurrenceId":id});
        let replay = data(call(&owner,"nesvo_cancel_job_occurrence",arguments.clone()).await?)?;
        assert_eq!(replay["data"],accepted["data"]);
        let completed = occurrence(&owner,job,id,"canceled").await?;
        let cancellation = &completed["data"]["occurrence"]["cancellation"];
        assert_eq!(cancellation["state"],"completed");
        assert_eq!(completed["data"]["occurrence"]["reason"],"owner_canceled");
        assert!(completed["data"]["occurrence"]["finishedAt"].is_number());
        let control_id = cancellation["controlId"].as_str().context("Native cancellation control")?;
        let control = data(call(&owner,"nesvo_get_run_control",json!({"runId":run,"controlId":control_id})).await?)?;
        assert_eq!(control["data"]["control"]["kind"],"cancel");
        assert_eq!(control["data"]["control"]["state"],"completed");
        assert_eq!(control["data"]["run"]["state"],"canceled");
        assert!(control["data"]["run"]["taskResult"].is_null());
        let targets = control["data"]["targets"].as_array().context("Exact native target")?;
        assert_eq!(targets.len(),1);
        assert_eq!(targets[0]["sessionId"],worker);
        assert_eq!(targets[0]["attemptId"],attempt);
        assert_eq!(targets[0]["phase"],"exited");
        let receipt_id = targets[0]["receiptId"].as_str().context("Native stop receipt")?;
        let stop = data(call(&owner,"nesvo_get_operation",json!({"id":receipt_id})).await?)?;
        assert_eq!(stop["data"]["receipt"]["operation"],"stop");
        assert_eq!(stop["data"]["receipt"]["sessionId"],worker);
        assert_eq!(stop["data"]["receipt"]["phase"],"stopRequested");
        assert_eq!(stop["data"]["receipt"]["result"]["nativeStopRequested"],true);
        let stopped = data(call(&owner,"nesvo_get_session",json!({"sessionId":worker})).await?)?;
        assert_eq!(stopped["data"]["session"]["running"],false);
        ensure!(!process_alive(&fixture,pid).await?,"Owned native worker PID survived completed cancellation");

        let retained = data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;
        let attempts = retained["data"]["attempts"].as_array().context("Retained attempts")?;
        assert_eq!(attempts.len(),1);
        assert_eq!(attempts[0]["id"],attempt);
        assert_eq!(attempts[0]["state"],"stopped");
        assert_eq!(attempts[0]["launch"]["receiptId"],current["launchReceiptId"]);
        let launch = data(call(&owner,"nesvo_get_operation",json!({"id":current["launchReceiptId"]})).await?)?;
        assert_eq!(launch["data"]["receipt"]["phase"],"created");
        let reenable = call(&owner,"nesvo_enable_run_executor",json!({
            "key":"do-not-rearm-canceled-job","runId":run,
            "expectedRevision":control["data"]["run"]["revision"]
        })).await?.structured_content.context("Canceled job executor refusal")?;
        let admission_refused_by_either_guard=matches!(reenable["error"]["code"].as_str(),Some("job_canceled"|"revision_conflict"));
        assert!(admission_refused_by_either_guard,"Unexpected re-enable outcome: {reenable}");
        let original = budgets::owner_cli(&fixture,&[
            "job","mutation","--key","cancel-bound-worker","--json"
        ]).await?;
        assert_eq!(original["data"],accepted["data"]);
        let final_replay = data(call(&owner,"nesvo_cancel_job_occurrence",arguments).await?)?;
        assert_eq!(final_replay["data"],accepted["data"]);
        assert_eq!(final_replay["data"]["occurrence"]["state"],"canceling");
        holds_throughout(Duration::from_millis(1100), async || {
            let view = data(call(&owner,"nesvo_get_run",json!({"runId":run})).await?)?;
            ensure!(view["data"]["run"]["state"]=="canceled" && view["data"]["tasks"][0]["attempts"]==1,"Canceled job run changed: {view}");
            let sessions = data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
            ensure!(sessions["data"]["sessions"].as_array().is_some_and(|rows|rows.len()==1),"Canceled job started another session: {sessions}");
            Ok(())
        }).await?;
        let stable = data(call(&owner,"nesvo_get_run",json!({"runId":run})).await?)?;
        assert_eq!(stable["data"]["run"]["state"],"canceled");
        assert_eq!(stable["data"]["tasks"][0]["attempts"],1);
        assert_eq!(stable["data"]["tasks"][0]["currentAttempt"]["id"],attempt);
        let sessions = data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        let rows = sessions["data"]["sessions"].as_array().context("Retained stopped worker")?;
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["id"],worker);
        assert_eq!(rows[0]["running"],false);
        run_checkpoints::schema(vec![created.clone(),admitted.clone(),reported.clone(),before,alive,accepted,replay,completed,control,stop,stopped,retained,launch,reenable,original,final_replay,stable,sessions]).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bound job cancellation exceeded its 20-second scenario budget")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
