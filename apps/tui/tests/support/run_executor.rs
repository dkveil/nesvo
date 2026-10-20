use super::*;

async fn run_view(client: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    Ok(data(call(client, "nesvo_get_run", json!({"runId":run})).await?)?["data"].clone())
}

#[tokio::test]
#[ignore = "requires native binaries, Node and Git; bounded automatic retry and uncertain-effect admission"]
async fn executor_bounds_known_failure_retries_and_never_retries_unknown_worktree_effects()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        let mut git=Command::new("git");git.args(["-C"]).arg(&fixture.directory).args(["rev-parse","--show-toplevel"]);#[cfg(windows)]git.creation_flags(0x08000000);
        ensure!(!git.output().await?.status.success(),"Owned temporary fixture must be outside Git; refusing worktree effects against an inherited repository");
        timeout(Duration::from_secs(5),async{loop{let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;if doctor["providerVersions"].as_array().is_some_and(|rows|rows.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")){return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"retry-executor-root","spec":{"name":"Retry coordinator","program":"claude","role":"coordinator","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("retry root")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);let coordinator=scoped_client(&context,root_id).await?;
        for unknown in [false,true] {
            let created=data(call(&coordinator,"nesvo_create_run",json!({"key":format!("retry-run-{unknown}"),"spec":{"title":"Bound automatic retries","goal":"No retry or slot release on uncertain effects"}})).await?)?;
            let run=created["data"]["run"]["id"].as_str().context("retry run")?;
            let tasks=if unknown {json!([{"key":"uncertain","title":"Uncertain","instruction":"UNSENT_UNKNOWN"},{"key":"blocked","title":"Blocked","instruction":"UNSENT_PARALLEL"}])}else{json!([{"key":"known","title":"Known","instruction":"UNSENT_FAILURE"}])};
            let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":format!("retry-plan-{unknown}"),"runId":run,"expectedRevision":1,"tasks":tasks})).await?)?;
            data(call(&coordinator,"nesvo_set_run_budget",json!({"key":format!("retry-policy-{unknown}"),"runId":run,"expectedRevision":2,"limits":{"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":null}})).await?)?;
            data(call(&coordinator,"nesvo_activate_run",json!({"key":format!("retry-active-{unknown}"),"runId":run,"expectedRevision":3})).await?)?;
            let profiles:Vec<Value>=plan["data"]["tasks"].as_array().unwrap().iter().enumerate().map(|(i,t)|json!({"taskId":t["id"],"profile":{"program":"claude","workspace":if unknown && i==0 {"worktree"}else{"shared"},"cwd":if unknown {fixture.directory.clone()}else{fixture.directory.join("does-not-exist")},"harness":true}})).collect();
            data(call(&coordinator,"nesvo_start_run_executor",json!({"key":format!("retry-start-{unknown}"),"runId":run,"expectedRevision":4,"spec":{"tasks":profiles,"retryFailed":true,"retryDelayMs":1000}})).await?)?;
            let observed=timeout(Duration::from_secs(10),async{loop{let view=run_view(&owner,run).await?;let expected=if unknown {"launchUnknown"}else{"launchFailed"};let count=if unknown {1}else{2};if view["tasks"][0]["state"]==expected && view["tasks"][0]["attempts"]==count {return Ok::<_,anyhow::Error>(view);}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
            assert_eq!(observed["run"]["budget"]["activeAttempts"],if unknown {1}else{0});
            tokio::time::sleep(Duration::from_millis(1100)).await;
            let stable=run_view(&owner,run).await?;assert_eq!(stable["tasks"][0]["attempts"],observed["tasks"][0]["attempts"]);
            if unknown {assert_eq!(stable["tasks"][1]["state"],"planned");}
            let history=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":plan["data"]["tasks"][0]["id"]})).await?)?;
            if !unknown {
                let attempts=history["data"]["attempts"].as_array().unwrap();assert_eq!(attempts.len(),2);assert_ne!(attempts[0]["id"],attempts[1]["id"]);
                for attempt in attempts {assert_eq!(attempt["launch"]["effectStarted"],false);assert!(attempt["result"].is_null());}
            }
            let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;assert_eq!(sessions["data"]["sessions"].as_array().unwrap().len(),1,"No worker process is fabricated for refused/unknown startup");
        }
        coordinator.cancel().await?;owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
#[ignore = "requires native binaries and Node; executor human-priority fence across delayed agent readiness"]
async fn executor_cannot_send_after_quick_human_takeover_or_rearm_a_paused_instruction()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        timeout(Duration::from_secs(5),async{loop{let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;if doctor["providerVersions"].as_array().is_some_and(|rows|rows.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")){return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"human-executor-root","spec":{"name":"Human priority coordinator","program":"claude","role":"coordinator","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("coordinator")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let delayed=fixture.directory.join("delayed");std::fs::create_dir(&delayed)?;std::fs::write(delayed.join(".fixture-defer-ready"),"")?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"human-engine-run","spec":{"title":"Human priority","goal":"No implicit input after takeover"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"human-engine-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"work","title":"Work","instruction":"UNSENT_AFTER_HUMAN_TAKEOVER"}]})).await?)?;
        let task=plan["data"]["tasks"][0]["id"].clone();
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"human-engine-active","runId":run,"expectedRevision":2})).await?)?;
        data(call(&coordinator,"nesvo_start_run_executor",json!({"key":"human-engine-start","runId":run,"expectedRevision":3,"spec":{"tasks":[{"taskId":task,"profile":{"program":"claude","workspace":"shared","cwd":delayed,"harness":true}}]}})).await?)?;
        let child=timeout(Duration::from_secs(10),async{loop{let current=run_view(&owner,run).await?;if current["tasks"][0]["state"]=="assigned" {return Ok::<_,anyhow::Error>(current["tasks"][0]["currentAttempt"]["sessionId"].as_str().context("owned worker")?.to_owned());}tokio::time::sleep(Duration::from_millis(25)).await;}}).await??;
        let mut human=human_control(&fixture.pairing(),&child).await?;
        drop(human.stdin.take());ensure!(timeout(Duration::from_secs(8),human.wait()).await??.success(),"Human release helper");
        let paused=timeout(Duration::from_secs(8),async{loop{let view=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;if view["data"]["attempts"][0]["delivery"]["phase"]=="paused" {return Ok::<_,anyhow::Error>(view);}tokio::time::sleep(Duration::from_millis(25)).await;}}).await??;
        assert!(paused["data"]["attempts"][0]["delivery"]["receiptId"].is_null());
        session_ready(&owner,&child).await?;
        mutate(&owner,run,"nesvo_disable_run_executor",json!({"key":"disable-human-engine","runId":run})).await?;
        mutate(&owner,run,"nesvo_enable_run_executor",json!({"key":"resume-human-engine","runId":run})).await?;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let current=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;
        assert_eq!(current["data"]["attempts"][0]["delivery"]["id"],paused["data"]["attempts"][0]["delivery"]["id"]);assert_eq!(current["data"]["attempts"][0]["delivery"]["phase"],"paused");assert!(current["data"]["attempts"][0]["delivery"]["receiptId"].is_null());
        let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":child,"maxBytes":8192})).await?)?;assert!(!output["data"]["page"]["data"].as_str().unwrap().contains("UNSENT_AFTER_HUMAN_TAKEOVER"));
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;assert_eq!(sessions["data"]["sessions"].as_array().unwrap().len(),2);
        coordinator.cancel().await?;owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
async fn reported(
    client: &RunningService<RoleClient, ()>,
    run: &str,
    index: usize,
) -> Result<Value> {
    timeout(Duration::from_secs(12), async {
        loop {
            let view = run_view(client, run).await?;
            if view["tasks"][index]["state"] == "reported" {
                return Ok::<_, anyhow::Error>(view);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("Automatic worker report")?
}
async fn mutate(
    client: &RunningService<RoleClient, ()>,
    run: &str,
    name: &'static str,
    mut args: Value,
) -> Result<Value> {
    timeout(Duration::from_secs(8), async {
        loop {
            args["expectedRevision"] = run_view(client, run).await?["run"]["revision"].clone();
            let reply = call(client, name, args.clone()).await?;
            if reply.is_error != Some(true) {
                return Ok::<_, anyhow::Error>(data(reply)?["data"].clone());
            }
            let error = reply
                .structured_content
                .context("executor mutation refusal")?;
            ensure!(
                error["error"]["code"] == "revision_conflict",
                "Unexpected executor mutation failure: {error}"
            );
        }
    })
    .await
    .context("Executor revision reconciliation")?
}
#[tokio::test]
#[ignore = "requires native binaries and Node; automatic DAG scheduling through real PTYs without model calls"]
async fn executor_launches_only_ready_tasks_and_waits_for_validation_without_touching_manual_workers()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        timeout(Duration::from_secs(5),async{loop{let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;if doctor["providerVersions"].as_array().is_some_and(|rows|rows.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")){return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"executor-root","spec":{"name":"Executor coordinator","program":"claude","role":"coordinator","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("executor root")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let manual=data(call(&coordinator,"nesvo_create_session",json!({"key":"manual-worker","spec":{"name":"Manual worker","program":"claude"}})).await?)?;
        let manual_id=manual["data"]["receipt"]["sessionId"].as_str().context("manual worker")?;session_ready(&owner,manual_id).await?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"executor-run","spec":{"title":"Automatic implement and review","goal":"Observed worker results require independent validation"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("executor run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"executor-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"implement","title":"Implement","instruction":"question-task"},{"key":"review","title":"Review","instruction":"report-task","dependencies":["implement"]},{"key":"manual","title":"Manual","instruction":"DO_NOT_INJECT_MANUAL_TASK"}]})).await?)?;
        data(call(&coordinator,"nesvo_set_run_budget",json!({"key":"executor-budget","runId":run,"expectedRevision":2,"limits":{"maxParallel":2,"maxAttemptsPerTask":2,"maxElapsedMs":null}})).await?)?;
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"executor-active","runId":run,"expectedRevision":3})).await?)?;
        data(call(&coordinator,"nesvo_assign_task",json!({"key":"manual-binding","runId":run,"taskId":plan["data"]["tasks"][2]["id"],"sessionId":manual_id,"expectedRevision":4})).await?)?;
        let spec=json!({"tasks":plan["data"]["tasks"].as_array().unwrap().iter().map(|t|json!({"taskId":t["id"],"profile":{"program":"claude","workspace":"shared","harness":true}})).collect::<Vec<_>>()});
        let start_args=json!({"key":"executor-start","runId":run,"expectedRevision":5,"spec":spec});
        let accepted=data(call(&coordinator,"nesvo_start_run_executor",start_args.clone()).await?)?;
        assert_eq!(accepted["data"]["executor"]["enabled"],true);
        let spec_path=fixture.directory.join("executor profiles łódź.json");std::fs::write(&spec_path,serde_json::to_vec(&spec)?)?;
        let replay=inbox::scoped_cli(&context,&["run","executor","start",run,"--key","executor-start","--revision","5","--file",spec_path.to_str().context("executor spec path")?,"--json"]).await?;
        assert_eq!(replay["data"],accepted["data"]);
        let question=timeout(Duration::from_secs(12),async{loop {
            let path=fixture.directory.join("callers");
            let file=std::fs::read_dir(path)?.filter_map(|e|e.ok()).find(|e|e.file_name().to_string_lossy().ends_with(".question.json"));
            if let Some(file)=file {return Ok::<_,anyhow::Error>(serde_json::from_slice::<Value>(&std::fs::read(file.path())?)?);}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }}).await??;
        let waiting=run_view(&coordinator,run).await?;assert_eq!(waiting["tasks"][0]["state"],"assigned");assert_eq!(waiting["tasks"][1]["state"],"planned");
        let denied=call(&coordinator,"nesvo_answer_decision",json!({"key":"coordinator-cannot-answer-owner","runId":run,"decisionId":question["data"]["decision"]["id"],"expectedRevision":question["data"]["decision"]["revision"],"answer":"unauthorized"})).await?;
        assert_eq!(denied.structured_content.context("owner decision gate")?["error"]["code"],"forbidden");
        data(call(&owner,"nesvo_answer_decision",json!({"key":"owner-answers-fixture","runId":run,"decisionId":question["data"]["decision"]["id"],"expectedRevision":question["data"]["decision"]["revision"],"answer":"Continue the fixture task only; no native permission is approved"})).await?)?;
        let implemented=reported(&coordinator,run,0).await?;
        assert_eq!(implemented["tasks"][1]["state"],"planned");assert_eq!(implemented["run"]["budget"]["activeAttempts"],2);assert!(implemented["tasks"][0]["taskResult"].is_null());
        let implement_id=implemented["tasks"][0]["currentAttempt"]["sessionId"].as_str().context("automatic implementer")?;
        observed_output(&owner,implement_id,"FIXTURE_RESPONSE question-task").await?;
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;assert_eq!(sessions["data"]["sessions"].as_array().unwrap().len(),3,"No reviewer before accepted implementation result");
        let disabled=mutate(&coordinator,run,"nesvo_disable_run_executor",json!({"key":"executor-disable","runId":run})).await?;
        assert_eq!(disabled["executor"]["enabled"],false);
        mutate(&coordinator,run,"nesvo_validate_task_result",json!({"key":"executor-validate-implementation","runId":run,"attemptId":implemented["tasks"][0]["currentAttempt"]["id"],"validation":{"passed":true,"summary":"Controlled result independently inspected","checks":[{"name":"fixture","outcome":"passed","details":"Verified actual controlled result and no early reviewer"}]}})).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(run_view(&owner,run).await?["tasks"][1]["state"],"planned","Disabled generation cannot admit the now-ready reviewer");
        let enabled=mutate(&owner,run,"nesvo_enable_run_executor",json!({"key":"owner-enable-executor","runId":run})).await?;
        assert_eq!(enabled["executor"]["issuer"],"owner");assert!(enabled["executor"]["generation"].as_u64().unwrap()>accepted["data"]["executor"]["generation"].as_u64().unwrap());
        let reviewed=reported(&owner,run,1).await?;
        assert_eq!(reviewed["tasks"][0]["attempts"],1);assert_eq!(reviewed["tasks"][1]["attempts"],1);assert_eq!(reviewed["tasks"][2]["state"],"assigned");
        let review_id=reviewed["tasks"][1]["currentAttempt"]["sessionId"].as_str().context("automatic reviewer")?;
        observed_output(&owner,review_id,"FIXTURE_RESPONSE report-task").await?;
        let history=data(call(&coordinator,"nesvo_get_task_attempts",json!({"runId":run,"taskId":plan["data"]["tasks"][1]["id"]})).await?)?;
        let owner_receipt=history["data"]["attempts"][0]["launch"]["receiptId"].clone();
        let denied=call(&coordinator,"nesvo_get_operation",json!({"id":owner_receipt})).await?;
        assert_eq!(denied.structured_content.context("executor receipt authority")?["error"]["code"],"operation_not_found");
        let manual_output=data(call(&owner,"nesvo_read_session",json!({"sessionId":manual_id,"maxBytes":8192})).await?)?;
        assert!(!manual_output["data"]["page"]["data"].as_str().unwrap().contains("DO_NOT_INJECT_MANUAL_TASK"));
        for id in [implement_id,review_id] {
            let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":id,"maxBytes":8192})).await?)?;
            let marker=if id==implement_id {"FIXTURE_RESPONSE question-task"}else{"FIXTURE_RESPONSE report-task"};
            assert_eq!(output["data"]["page"]["data"].as_str().unwrap().matches(marker).count(),1);
        }
        let canceled=mutate(&owner,run,"nesvo_cancel_run",json!({"key":"cancel-executed-run","runId":run})).await?;
        let control=canceled["control"]["id"].as_str().context("executor cancellation")?;
        timeout(Duration::from_secs(8),async{loop{let view=data(call(&owner,"nesvo_get_run_control",json!({"runId":run,"controlId":control})).await?)?;if view["data"]["control"]["state"]=="completed"{return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        let executor=data(call(&owner,"nesvo_get_run_executor",json!({"runId":run})).await?)?;
        assert_eq!(executor["data"]["executor"]["spec"]["retryFailed"],false);
        let root=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;assert_eq!(root["data"]["session"]["running"],true);
        coordinator.cancel().await?;owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
