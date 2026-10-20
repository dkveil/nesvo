//! Once job through real native CLI/MCP, with all owner clients disconnected at due.
use super::*;

async fn job_history(owner: &RunningService<RoleClient, ()>, job: &str) -> Result<Value> {
    data(call(owner, "nesvo_get_job_history", json!({"jobId":job})).await?)
}
async fn report_wait<T>(
    fixture: &mut Fixture,
    job: &str,
    stage: &str,
    waited: std::result::Result<Result<T>, tokio::time::error::Elapsed>,
) -> Result<T> {
    match waited {
        Ok(result) => result,
        Err(error) => {
            let diagnostics = job_diagnostics::report_timeout_diagnostics(fixture, job).await;
            Err(anyhow::Error::new(error).context(format!(
                "{stage}; bounded actual diagnostics: {}",
                diagnostics
                    .to_string()
                    .chars()
                    .take(16384)
                    .collect::<String>()
            )))
        }
    }
}
async fn occurrence_state(
    fixture: &mut Fixture,
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    state: &str,
) -> Result<Value> {
    let waited = timeout(Duration::from_secs(15), async {
        loop {
            let history = job_history(owner, job).await?;
            if history["data"]["occurrences"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|o| o["state"] == state))
            {
                return Ok::<_, anyhow::Error>(history);
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    })
    .await;
    report_wait(
        fixture,
        job,
        &format!("Job occurrence state ({state})"),
        waited,
    )
    .await
}

#[tokio::test]
#[ignore = "native host/client and Node; persisted catch-up waits for actual provider version readiness"]
async fn startup_catchup_never_mistakes_pending_version_probe_for_an_unsupported_provider()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let due=chrono::Utc::now()+chrono::Duration::seconds(5);
        let created=data(call(&owner,"nesvo_create_job",json!({"key":"startup-catchup","spec":{"title":"Startup catch-up","instruction":"report-task","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":due.to_rfc3339()},"misfire":"catchUp","graceMs":60000}})).await?)?;
        let id=created["data"]["job"]["id"].as_str().context("startup job")?;
        owner.cancel().await?;
        drop(fixture.host.stdin.take());
        ensure!(timeout(Duration::from_secs(10),fixture.host.wait()).await??.success(),"Close only owned fixture host before due");
        let wait=(due-chrono::Utc::now()).to_std().unwrap_or_default()+Duration::from_millis(100);
        tokio::time::sleep(wait).await;
        std::fs::write(fixture.directory.join("callers/.fixture-slow-version"),"owned probe delay")?;
        fixture.restart(false).await?;
        let owner=client(&fixture.pairing()).await?;
        let pending=timeout(Duration::from_secs(15),async {loop {
            let history=job_history(&owner,id).await?;
            if let Some(rows)=history["data"]["occurrences"].as_array() {
                if let Some(failed)=rows.iter().find(|o|o["state"]=="failed"||o["state"]=="reconcile") {
                    let run=failed["runId"].as_str().context("failed startup run")?;
                    let current=run_checkpoints::view(&owner,run).await?;
                    let attempts=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":current["tasks"][0]["id"]})).await?)?;
                    anyhow::bail!("Startup catch-up refused during discovery: history={history}; attempts={attempts}");
                }
                if rows.iter().any(|o|o["state"]=="needsValidation") {return Ok::<_,anyhow::Error>(history);}
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }}).await;
        let pending=report_wait(&mut fixture,id,"Startup catch-up report",pending).await?;
        assert_eq!(pending["data"]["occurrences"].as_array().context("one startup occurrence")?.len(),1);
        let run=pending["data"]["occurrences"][0]["runId"].as_str().context("startup run")?;
        let tasks=run_checkpoints::view(&owner,run).await?;
        let history=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":tasks["tasks"][0]["id"]})).await?)?;
        assert_eq!(history["data"]["attempts"].as_array().context("one native attempt")?.len(),1);
        assert_eq!(history["data"]["attempts"][0]["launch"]["phase"],"created");
        assert_eq!(history["data"]["attempts"][0]["result"]["outcome"],"succeeded");
        owner.cancel().await?;Ok::<_,anyhow::Error>(())
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

#[tokio::test]
#[ignore = "native host/client and Node; once job runs with owner clients closed, no model calls"]
async fn once_jobs_dispatch_without_clients_retain_results_and_never_turn_restart_into_retry()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        timeout(Duration::from_secs(5),async {loop {
            let report=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
            if report["providerVersions"].as_array().is_some_and(|r|r.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")) {return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }}).await??;
        let owner=client(&fixture.pairing()).await?;
        let due=chrono::Utc::now()+chrono::Duration::seconds(8);
        let spec=json!({"title":"Disconnected once job","instruction":"report-task","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":due.to_rfc3339()},"overlap":"skip","misfire":"catchUp","graceMs":60000});
        let file=fixture.directory.join("scheduled job łódź.json");std::fs::write(&file,serde_json::to_vec(&spec)?)?;
        let created=budgets::owner_cli(&fixture,&["job","create","--key","once-job","--file",file.to_str().context("job file")?,"--json"]).await?;
        let id=created["data"]["job"]["id"].as_str().context("job ID")?.to_owned();
        let replay=data(call(&owner,"nesvo_create_job",json!({"key":"once-job","spec":spec})).await?)?;
        assert_eq!(replay["data"],created["data"]);
        let accepted=data(call(&owner,"nesvo_get_job_mutation",json!({"key":"once-job"})).await?)?;
        assert_eq!(accepted["data"],created["data"]);
        let mut wrong=spec.clone();wrong["instruction"]="Different job intent".into();
        let conflict=call(&owner,"nesvo_create_job",json!({"key":"once-job","spec":wrong})).await?.structured_content.context("job conflict")?;
        assert_eq!(conflict["error"]["code"],"idempotency_conflict");
        ensure!(chrono::Utc::now()<due,"Owner must disconnect before due instant");
        owner.cancel().await?;
        let reported=timeout(Duration::from_secs(18),async {loop {
            let reported=std::fs::read_dir(fixture.directory.join("callers"))?.filter_map(|e|e.ok()).any(|e|e.file_name().to_string_lossy().ends_with(".result.json"));
            if reported {return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(80)).await;
        }}).await;
        report_wait(&mut fixture,&id,"Scheduled worker reported without owner clients",reported).await?;
        let owner=client(&fixture.pairing()).await?;
        let pending=occurrence_state(&mut fixture,&owner,&id,"needsValidation").await?;
        let first=&pending["data"]["occurrences"][0];
        assert!(first["finishedAt"].is_null());assert_eq!(first["trigger"],"schedule");
        let run=first["runId"].as_str().context("job run")?.to_owned();
        let current=run_checkpoints::view(&owner,&run).await?;
        assert_eq!(current["tasks"][0]["state"],"reported");
        let worker=current["tasks"][0]["currentAttempt"]["sessionId"].as_str().context("job worker")?;
        assert_eq!(first["attemptId"],current["tasks"][0]["currentAttempt"]["id"]);
        assert_eq!(first["sessionId"],worker);
        assert!(first["launchReceiptId"].is_string());
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(sessions["data"]["sessions"].as_array().context("one worker")?.len(),1);
        assert!(sessions["data"]["sessions"][0]["parentSessionId"].is_null());assert!(sessions["data"]["sessions"][0]["controllerId"].is_null());
        let native:Value=serde_json::from_slice(&std::fs::read(fixture.directory.join("callers").join(format!("{worker}.native-permissions.json")))?)?;
        assert_eq!(native,json!(["mcp__nesvo__nesvo_get_current_task","mcp__nesvo__nesvo_report_task_result"]));
        let scoped=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{worker}.txt")))?);
        let worker_client=scoped_client(&scoped,worker).await?;
        let denied=call(&worker_client,"nesvo_list_jobs",json!({})).await?.structured_content.context("worker job refusal")?;
        assert_eq!(denied["error"]["code"],"forbidden");worker_client.cancel().await?;
        let skipped=budgets::owner_cli(&fixture,&["job","run-now",&id,"--key","explicit-overlap","--revision","1","--json"]).await?;
        assert_eq!(skipped["data"]["occurrence"]["state"],"skipped");assert_eq!(skipped["data"]["occurrence"]["reason"],"overlap");
        let skipped_replay=data(call(&owner,"nesvo_run_job_now",json!({"key":"explicit-overlap","jobId":id,"expectedRevision":1})).await?)?;
        assert_eq!(skipped_replay["data"],skipped["data"]);
        let mut edited=spec.clone();edited["title"]="Changed future profile".into();edited["overlap"]="queue".into();edited["schedule"]["at"]=(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339().into();edited["profile"]["allowedNesvoTools"]=json!(["nesvo_report_task_result"]);
        std::fs::write(&file,serde_json::to_vec(&edited)?)?;
        let updated=budgets::owner_cli(&fixture,&["job","edit",&id,"--key","future-profile","--revision","1","--file",file.to_str().context("edited job file")?,"--json"]).await?;
        let edited_replay=data(call(&owner,"nesvo_update_job",json!({"key":"future-profile","jobId":id,"expectedRevision":1,"spec":edited})).await?)?;
        assert_eq!(edited_replay["data"],updated["data"]);
        let queued=data(call(&owner,"nesvo_run_job_now",json!({"key":"deliberate-next-occurrence","jobId":id,"expectedRevision":2})).await?)?;
        assert_eq!(queued["data"]["occurrence"]["state"],"queued");
        let second_id=queued["data"]["occurrence"]["id"].as_str().context("queued occurrence")?.to_owned();
        let paused=budgets::owner_cli(&fixture,&["job","disable",&id,"--key","pause-future","--revision","2","--json"]).await?;
        assert_eq!(paused["data"]["job"]["enabled"],false);
        let selected=data(call(&owner,"nesvo_get_job_occurrence",json!({"jobId":id,"occurrenceId":first["id"]})).await?)?;
        assert_eq!(selected["data"]["occurrence"]["spec"]["profile"]["allowedNesvoTools"],spec["profile"]["allowedNesvoTools"]);
        run_checkpoints::mutate(&owner,&run,"nesvo_validate_task_result",json!({"key":"validate-disconnected-job","attemptId":current["tasks"][0]["currentAttempt"]["id"],"validation":{"passed":true,"summary":"Inspected exact controlled metadata result","checks":[{"name":"fixture","outcome":"passed","details":"Real scoped process reported its own attempt"}]}})).await?;
        occurrence_state(&mut fixture,&owner,&id,"succeeded").await?;
        let second=timeout(Duration::from_secs(15),async {loop {
            let view=data(call(&owner,"nesvo_get_job_occurrence",json!({"jobId":id,"occurrenceId":second_id})).await?)?;
            if view["data"]["occurrence"]["state"]=="needsValidation" {return Ok::<_,anyhow::Error>(view);}
            tokio::time::sleep(Duration::from_millis(80)).await;
        }}).await;
        let second=report_wait(&mut fixture,&id,"Explicit manual queue may run after definition disabled",second).await?;
        let next_run=second["data"]["occurrence"]["runId"].as_str().context("second run")?;
        let second_run=run_checkpoints::view(&owner,next_run).await?;
        let next_worker=second_run["tasks"][0]["currentAttempt"]["sessionId"].as_str().context("second worker")?;
        let native:Value=serde_json::from_slice(&std::fs::read(fixture.directory.join("callers").join(format!("{next_worker}.native-permissions.json")))?)?;
        assert_eq!(native,json!(["mcp__nesvo__nesvo_report_task_result"]));
        let list=budgets::owner_cli(&fixture,&["job","list","--json"]).await?;
        let show=budgets::owner_cli(&fixture,&["job","show",&id,"--json"]).await?;
        let history=budgets::owner_cli(&fixture,&["job","history",&id,"--json"]).await?;
        let occurrence=budgets::owner_cli(&fixture,&["job","occurrence",&id,first["id"].as_str().context("first occurrence")?,"--json"]).await?;
        let enabled=budgets::owner_cli(&fixture,&["job","enable",&id,"--key","enable-future","--revision","3","--json"]).await?;
        assert_eq!(enabled["data"]["job"]["enabled"],true);
        let disabled=data(call(&owner,"nesvo_set_job_enabled",json!({"key":"disable-future-again","jobId":id,"expectedRevision":4,"enabled":false})).await?)?;
        assert_eq!(disabled["data"]["job"]["enabled"],false);
        let mutation=budgets::owner_cli(&fixture,&["job","mutation","--key","once-job","--json"]).await?;
        assert_eq!(mutation["data"],created["data"]);
        run_checkpoints::schema(vec![created,replay,accepted,pending,skipped,skipped_replay,updated,edited_replay,queued,paused,selected,second,list,show,history,occurrence,enabled,disabled,mutation]).await?;
        owner.cancel().await?;
        fixture.restart(false).await?;
        let owner=client(&fixture.pairing()).await?;
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(sessions["data"]["sessions"].as_array().context("No restart process retry")?.is_empty());
        let retained=job_history(&owner,&id).await?;
        assert_eq!(retained["data"]["occurrences"].as_array().context("Retained job history")?.len(),3);
        let original=data(call(&owner,"nesvo_get_job_mutation",json!({"key":"deliberate-next-occurrence"})).await?)?;
        assert_eq!(original["data"]["occurrence"]["id"],second_id);
        owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
