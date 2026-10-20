//! Durable job generation history through native CLI/MCP and one controlled worker.
use super::*;

async fn reported_occurrence(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    occurrence: &str,
) -> Result<Value> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(8), async {
        loop {
            let view = data(
                call(
                    owner,
                    "nesvo_get_job_occurrence",
                    json!({"jobId":job,"occurrenceId":occurrence}),
                )
                .await?,
            )?;
            if view["data"]["occurrence"]["state"] == "needsValidation" {
                return Ok::<_, anyhow::Error>(view);
            }
            last = view;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .with_context(|| format!("Job generation did not retain its worker result; last: {last}"))?
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and controlled Node worker; durable job generation history, no models"]
async fn first_job_generation_retains_native_pointers_and_restarts_without_creating_another_attempt()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(18), async {
        let owner = client(&fixture.pairing()).await?;
        let created = data(call(&owner,"nesvo_create_job",json!({
            "key":"attempt-history-definition",
            "spec":{
                "title":"Durable first generation",
                "instruction":"report-task",
                "profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
                "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}
            }
        })).await?)?;
        let job = created["data"]["job"]["id"].as_str().context("Journal job ID")?;
        let admitted = budgets::owner_cli(&fixture,&[
            "job","run-now",job,"--key","attempt-history-run","--revision","1","--json"
        ]).await?;
        let occurrence = admitted["data"]["occurrence"]["id"].as_str().context("Journal occurrence ID")?;
        let reported = reported_occurrence(&owner,job,occurrence).await?;
        let current = &reported["data"]["occurrence"];
        let run = current["runId"].as_str().context("Journal workflow run")?;
        let native_attempt = current["attemptId"].as_str().context("Native workflow attempt")?;
        let worker = current["sessionId"].as_str().context("Native worker session")?;
        let launch_receipt = current["launchReceiptId"].as_str().context("Native launch receipt")?;

        let listed = data(call(&owner,"nesvo_get_job_attempts",json!({"jobId":job,"occurrenceId":occurrence})).await?)?;
        let rows = listed["data"]["jobAttempts"].as_array().context("Job generation journal")?;
        assert_eq!(rows.len(),1,"One native run creates exactly one job generation");
        assert!(listed["data"]["nextOffset"].is_null());
        let generation = rows[0]["id"].as_str().context("Job generation ID")?;
        assert_ne!(generation,native_attempt,"Job generations and native task attempts have separate identities");
        assert_eq!(current["jobAttemptId"],generation);
        assert_eq!(current["jobAttemptOrdinal"],1);
        assert_eq!(rows[0]["ordinal"],1);

        let detail = data(call(&owner,"nesvo_get_job_attempt",json!({"jobId":job,"occurrenceId":occurrence,"jobAttemptId":generation})).await?)?;
        let attempt = &detail["data"]["jobAttempt"];
        assert_eq!(attempt["id"],generation);
        assert_eq!(attempt["occurrenceId"],occurrence);
        assert_eq!(attempt["ordinal"],1);
        assert_eq!(attempt["runId"],run);
        assert_eq!(attempt["state"],"needsValidation");
        assert!(attempt["createdAt"].is_number());
        assert!(attempt["claimedAt"].is_number());
        assert!(attempt["finishedAt"].is_null(),"A worker report is not validated job success");
        assert_eq!(attempt["attemptId"],native_attempt);
        assert_eq!(attempt["sessionId"],worker);
        assert_eq!(attempt["launchReceiptId"],launch_receipt);
        assert!(attempt["precheck"].is_null());

        let list_cli = budgets::owner_cli(&fixture,&[
            "job","attempts",job,occurrence,"--offset","0","--json"
        ]).await?;
        assert_eq!(list_cli["data"],listed["data"]);
        let detail_cli = budgets::owner_cli(&fixture,&[
            "job","attempt",job,occurrence,generation,"--json"
        ]).await?;
        assert_eq!(detail_cli["data"],detail["data"]);
        let empty = data(call(&owner,"nesvo_get_job_attempts",json!({"jobId":job,"occurrenceId":occurrence,"offset":1})).await?)?;
        assert!(empty["data"]["jobAttempts"].as_array().context("Exhausted journal page")?.is_empty());
        assert!(empty["data"]["nextOffset"].is_null());
        let mut paging_errors = Vec::new();
        for offset in [-1,4097] {
            let invalid = call(&owner,"nesvo_get_job_attempts",json!({"jobId":job,"occurrenceId":occurrence,"offset":offset})).await?.structured_content.context("Invalid journal page refusal")?;
            assert_eq!(invalid["error"]["code"],"invalid_argument");
            paging_errors.push(invalid);
        }

        let run_view = data(call(&owner,"nesvo_get_run",json!({"runId":run})).await?)?;
        let task = run_view["data"]["tasks"][0]["id"].as_str().context("Journal native task")?;
        assert_eq!(run_view["data"]["tasks"][0]["state"],"reported");
        assert_eq!(run_view["data"]["tasks"][0]["currentAttempt"]["id"],native_attempt);
        assert_eq!(run_view["data"]["tasks"][0]["currentAttempt"]["reportedOutcome"],"succeeded");
        assert!(run_view["data"]["run"]["taskResult"].is_null());
        let native = data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;
        let native_rows = native["data"]["attempts"].as_array().context("One native attempt")?;
        assert_eq!(native_rows.len(),1);
        assert_eq!(native_rows[0]["id"],native_attempt);
        assert_eq!(native_rows[0]["result"]["outcome"],"succeeded");
        assert_eq!(native_rows[0]["launch"]["receiptId"],launch_receipt);
        let receipt = data(call(&owner,"nesvo_get_operation",json!({"id":launch_receipt})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["phase"],"created");
        assert_eq!(receipt["data"]["receipt"]["sessionId"],worker);

        let context = PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{worker}.txt")))?);
        let scoped = scoped_client(&context,worker).await?;
        let mut denied = Vec::new();
        for (job_id,occurrence_id,attempt_id) in [
            (job,occurrence,generation),
            ("missing-job","missing-occurrence","missing-generation"),
        ] {
            for (tool,arguments) in [
                ("nesvo_get_job_attempts",json!({"jobId":job_id,"occurrenceId":occurrence_id})),
                ("nesvo_get_job_attempt",json!({"jobId":job_id,"occurrenceId":occurrence_id,"jobAttemptId":attempt_id})),
            ] {
                let refusal = call(&scoped,tool,arguments).await?.structured_content.context("Scoped journal refusal")?;
                assert_eq!(refusal["error"]["code"],"forbidden","Ownership must be checked before lookup");
                denied.push(refusal);
            }
        }
        scoped.cancel().await?;
        let original = data(call(&owner,"nesvo_get_job_mutation",json!({"key":"attempt-history-run"})).await?)?;
        assert_eq!(original["data"],admitted["data"],"Claiming a generation cannot rewrite the earlier admission response");
        let replay = data(call(&owner,"nesvo_run_job_now",json!({"key":"attempt-history-run","jobId":job,"expectedRevision":1})).await?)?;
        assert_eq!(replay["data"],admitted["data"]);
        let before_runs = data(call(&owner,"nesvo_list_runs",json!({})).await?)?;
        assert_eq!(before_runs["data"]["runs"].as_array().context("One owned workflow run")?.len(),1);
        owner.cancel().await?;

        fixture.restart(false).await?;
        let owner = client(&fixture.pairing()).await?;
        let restarted = data(call(&owner,"nesvo_get_job_attempt",json!({"jobId":job,"occurrenceId":occurrence,"jobAttemptId":generation})).await?)?;
        let journal = &restarted["data"]["jobAttempt"];
        assert_eq!(journal["id"],generation);
        assert_eq!(journal["ordinal"],1);
        assert_eq!(journal["runId"],run);
        assert_eq!(journal["attemptId"],native_attempt);
        assert_eq!(journal["sessionId"],worker);
        assert_eq!(journal["launchReceiptId"],launch_receipt);
        assert_eq!(journal["state"],"reconcile");
        assert!(journal["finishedAt"].is_null());
        let retained = data(call(&owner,"nesvo_get_job_attempts",json!({"jobId":job,"occurrenceId":occurrence})).await?)?;
        let rows = retained["data"]["jobAttempts"].as_array().context("Retained generation")?;
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["id"],generation);
        let occurrence_after = data(call(&owner,"nesvo_get_job_occurrence",json!({"jobId":job,"occurrenceId":occurrence})).await?)?;
        assert_eq!(occurrence_after["data"]["occurrence"]["state"],"reconcile");
        assert_eq!(occurrence_after["data"]["occurrence"]["jobAttemptId"],generation);
        let after_runs = data(call(&owner,"nesvo_list_runs",json!({})).await?)?;
        assert_eq!(after_runs["data"]["runs"].as_array().context("No replacement run")?.len(),1);
        assert_eq!(after_runs["data"]["runs"][0]["id"],run);
        let after_native = data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;
        let native_rows = after_native["data"]["attempts"].as_array().context("No replacement native task attempt")?;
        assert_eq!(native_rows.len(),1);
        assert_eq!(native_rows[0]["id"],native_attempt);
        assert_eq!(native_rows[0]["result"]["outcome"],"succeeded");
        let sessions = data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(sessions["data"]["sessions"].as_array().context("Restart creates no workers")?.is_empty());
        let original_after = data(call(&owner,"nesvo_get_job_mutation",json!({"key":"attempt-history-run"})).await?)?;
        assert_eq!(original_after["data"],admitted["data"]);
        owner.cancel().await?;

        let mut envelopes = vec![created,admitted,reported,listed,detail,list_cli,detail_cli,empty,run_view,native,receipt,original,replay,before_runs,restarted,retained,occurrence_after,after_runs,after_native,sessions,original_after];
        envelopes.extend(denied);
        envelopes.extend(paging_errors);
        run_checkpoints::schema(envelopes).await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native job generation history scenario")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
