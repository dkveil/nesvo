use super::*;

async fn delivery(
    owner: &RunningService<RoleClient, ()>,
    run: &str,
    task: &Value,
    expected: &str,
) -> Result<Value> {
    waits::delivery(owner, run, task, 0, expected)
        .await
        .context("Expected task delivery outcome")
}
#[tokio::test]
#[ignore = "requires native binaries and Node; guarded durable task instruction delivery through real PTYs"]
async fn queued_task_instruction_delivers_once_and_never_resumes_over_human_control() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        waits::provider(&fixture,"claude").await?;
        let owner=client(&fixture.pairing()).await?;
        let root=waits::operation(&owner,"nesvo_create_session",json!({"key":"delivery-root","spec":{"name":"Delivery coordinator","program":"claude","role":"coordinator","harness":true}})).await?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("coordinator")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"delivery-run","spec":{"title":"Instruction intents","goal":"Guard actual PTY delivery"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("run")?;
        let specs:Vec<Value>=(0..4).map(|i|json!({"key":format!("task-{i}"),"title":format!("Task {i}"),"instruction":if i==0 {"report-task"}else{"UNSENT_TASK_INSTRUCTION"}})).collect();
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"delivery-plan","runId":run,"expectedRevision":1,"tasks":specs})).await?)?;
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"delivery-active","runId":run,"expectedRevision":2})).await?)?;
        let tasks=plan["data"]["tasks"].as_array().context("tasks")?;
        let mut workers=Vec::new();
        for (index,task) in tasks.iter().enumerate(){
            let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
            let launched=data(call(&coordinator,"nesvo_launch_task",json!({"key":format!("delivery-launch-{index}"),"runId":run,"taskId":task["id"],"expectedRevision":current["data"]["run"]["revision"],"profile":{"program":"claude","workspace":"shared","harness":true}})).await?)?;
            let child=launched["data"]["launch"]["sessionId"].as_str().context("worker")?.to_owned();session_ready(&owner,&child).await?;workers.push(child);
        }
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let revision=current["data"]["run"]["revision"].as_u64().unwrap().to_string();
        let accepted=inbox::scoped_cli(&context,&["run","deliver",run,"--task",tasks[0]["id"].as_str().unwrap(),"--key","deliver-once","--revision",&revision,"--json"]).await?;
        assert_eq!(accepted["data"]["delivery"]["phase"],"queued");assert!(accepted["data"]["delivery"]["receiptId"].is_null());
        let replay=data(call(&coordinator,"nesvo_deliver_task",json!({"key":"deliver-once","runId":run,"taskId":tasks[0]["id"],"expectedRevision":current["data"]["run"]["revision"]})).await?)?;
        assert_eq!(replay["data"],accepted["data"]);
        let sent=delivery(&owner,run,&tasks[0]["id"],"sent").await?;
        assert!(sent["data"]["attempts"][0]["delivery"]["receiptId"].is_string());
        observed_output(&owner,&workers[0],"FIXTURE_RESPONSE report-task").await?;
        let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":workers[0],"maxBytes":8192})).await?)?;
        assert_eq!(output["data"]["page"]["data"].as_str().unwrap().matches("FIXTURE_RESPONSE report-task").count(),1);
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        assert_eq!(current["data"]["tasks"][0]["state"],"reported");assert!(current["data"]["tasks"][0]["taskResult"].is_null());
        waits::operation(&coordinator,"nesvo_send_prompt",json!({"key":"hold-before-takeover","sessionId":workers[1],"prompt":"hold-response"})).await?;
        observed_output(&owner,&workers[1],"FIXTURE_HOLDING_RESPONSE").await?;
        let queued=data(call(&owner,"nesvo_deliver_task",json!({"key":"human-wins","runId":run,"taskId":tasks[1]["id"],"expectedRevision":current["data"]["run"]["revision"]})).await?)?;
        let mut human=human_control(&fixture.pairing(),&workers[1]).await?;
        drop(human.stdin.take());ensure!(human.wait().await?.success(),"Human release fixture");
        let paused=delivery(&owner,run,&tasks[1]["id"],"paused").await?;
        assert!(paused["data"]["attempts"][0]["delivery"]["receiptId"].is_null());
        assert!(queued["data"]["delivery"]["receiptId"].is_null());
        for index in 2..4 {
            waits::operation(&coordinator,"nesvo_send_prompt",json!({"key":format!("hold-{index}"),"sessionId":workers[index],"prompt":"hold-response"})).await?;
            observed_output(&owner,&workers[index],"FIXTURE_HOLDING_RESPONSE").await?;
            let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
            let queued=data(call(&coordinator,"nesvo_deliver_task",json!({"key":format!("waiting-{index}"),"runId":run,"taskId":tasks[index]["id"],"expectedRevision":current["data"]["run"]["revision"],"timeoutMs":if index==2 {300000}else{150}})).await?)?;
            if index==2 {
                loop {
                    let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
                    let canceled=call(&coordinator,"nesvo_cancel_task_delivery",json!({"key":"cancel-waiting","runId":run,"deliveryId":queued["data"]["delivery"]["id"],"expectedRevision":current["data"]["run"]["revision"]})).await?;
                    if canceled.is_error!=Some(true){break;}
                    assert_eq!(canceled.structured_content.context("cancel race")?["error"]["code"],"revision_conflict");
                }
                delivery(&owner,run,&tasks[index]["id"],"canceled").await?;
            } else {delivery(&owner,run,&tasks[index]["id"],"expired").await?;}
        }
        for child in &workers[1..] {
            let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":child,"maxBytes":8192})).await?)?;
            assert!(!output["data"]["page"]["data"].as_str().unwrap().contains("UNSENT_TASK_INSTRUCTION"));
        }
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;for session in sessions["data"]["sessions"].as_array().unwrap(){assert!(session["controllerId"].is_null());}
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
async fn attempt_state(
    owner: &RunningService<RoleClient, ()>,
    run: &str,
    task: &Value,
    index: usize,
    field: &str,
    expected: &str,
) -> Result<Value> {
    if field == "delivery" {
        return waits::delivery(owner, run, task, index, expected)
            .await
            .context("Expected task attempt delivery");
    }
    waits::until(async || {
        let view = data(
            call(
                owner,
                "nesvo_get_task_attempts",
                json!({"runId":run,"taskId":task}),
            )
            .await?,
        )?;
        let current = &view["data"]["attempts"][index][field];
        if current == expected {
            return Ok(Some(view));
        }
        ensure!(
            !waits::is_settled_attempt(current),
            "Task attempt {index} settled before {field} reached {expected}: {view}"
        );
        Ok(None)
    })
    .await
    .context("Expected task attempt state")
}
async fn settled(
    owner: &RunningService<RoleClient, ()>,
    receipt: &Value,
    session: &str,
) -> Result<()> {
    waits::receipt(owner, receipt, session, "settled")
        .await
        .context("Instruction receipt did not settle")?;
    Ok(())
}
async fn response_after(
    owner: &RunningService<RoleClient, ()>,
    session: &str,
    marker: &str,
    after: u64,
) -> Result<()> {
    let responded = async || {
        let output = data(
            call(
                owner,
                "nesvo_read_session",
                json!({"sessionId":session,"after":after,"maxBytes":8192}),
            )
            .await?,
        )?;
        ensure!(
            output["data"]["page"]["gap"] == false,
            "Response transcript expired"
        );
        Ok::<_, anyhow::Error>(
            output["data"]["page"]["data"]
                .as_str()
                .is_some_and(|text| text.contains(marker)),
        )
    };
    waits::until(async || {
        if responded().await? {
            return Ok(Some(()));
        }
        if waits::exited(owner, session).await? {
            ensure!(
                responded().await?,
                "Worker {session} exited without response {marker}"
            );
            return Ok(Some(()));
        }
        Ok(None)
    })
    .await
    .context("Expected worker response")
}
async fn provider_turns(
    owner: &RunningService<RoleClient, ()>,
    session: &str,
) -> Result<[usize; 2]> {
    let mut turns = [0, 0];
    let mut cursor = 0;
    loop {
        let page = data(
            call(
                owner,
                "nesvo_read_events",
                json!({"sessionId":session,"after":cursor}),
            )
            .await?,
        )?;
        ensure!(
            page["data"]["gap"] == false,
            "Worker history must be complete"
        );
        for event in page["data"]["events"].as_array().context("Worker events")? {
            if event["kind"] == "agent.lifecycle" && event["payload"]["event"] == "UserPromptSubmit"
            {
                turns[0] += 1;
            }
            if event["kind"] == "response.settled" {
                turns[1] += 1;
            }
        }
        let next = page["data"]["nextCursor"]
            .as_u64()
            .context("Worker event cursor")?;
        if page["data"]["more"] != true {
            return Ok(turns);
        }
        ensure!(next > cursor, "Worker event cursor must advance");
        cursor = next;
    }
}
async fn settled_turns(
    owner: &RunningService<RoleClient, ()>,
    session: &str,
    expected: usize,
) -> Result<[usize; 2]> {
    waits::until(async || {
        let turns = provider_turns(owner, session).await?;
        if turns.iter().all(|count| *count >= expected) {
            return Ok(Some(turns));
        }
        ensure!(
            !waits::exited(owner, session).await?,
            "Worker {session} exited with provider turns {turns:?}"
        );
        Ok(None)
    })
    .await
    .context("Expected settled provider turns")
}
fn refusal(result: CallToolResult) -> Result<String> {
    ensure!(
        result.is_error == Some(true),
        "Reuse was unexpectedly accepted"
    );
    Ok(
        result.structured_content.context("refusal")?["error"]["code"]
            .as_str()
            .context("refusal code")?
            .to_owned(),
    )
}
#[tokio::test]
#[ignore = "requires native binaries and Node; reuses one controlled worker for a new task attempt through real PTYs"]
async fn settled_worker_session_is_reused_for_a_new_attempt_once_and_refused_when_unsafe()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        waits::provider(&fixture,"claude").await?;
        let owner=client(&fixture.pairing()).await?;
        let root=waits::operation(&owner,"nesvo_create_session",json!({"key":"reuse-root","spec":{"name":"Reuse coordinator","program":"claude","role":"coordinator","harness":true}})).await?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("coordinator")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"reuse-run","spec":{"title":"Session reuse","goal":"Reuse one settled worker"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"reuse-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"task-0","title":"Task 0","instruction":"report-task"}]})).await?)?;
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"reuse-active","runId":run,"expectedRevision":2})).await?)?;
        let task=&plan["data"]["tasks"][0]["id"];
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let launched=data(call(&coordinator,"nesvo_launch_task",json!({"key":"reuse-launch","runId":run,"taskId":task,"expectedRevision":current["data"]["run"]["revision"],"profile":{"program":"claude","workspace":"shared","harness":true}})).await?)?;
        let worker=launched["data"]["launch"]["sessionId"].as_str().context("worker")?.to_owned();session_ready(&owner,&worker).await?;
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let revision=current["data"]["run"]["revision"].as_u64().unwrap().to_string();
        inbox::scoped_cli(&context,&["run","deliver",run,"--task",task.as_str().unwrap(),"--key","first-instruction","--revision",&revision,"--json"]).await?;
        attempt_state(&owner,run,task,0,"delivery","sent").await?;
        let reported=attempt_state(&owner,run,task,0,"state","reported").await?;
        let first=reported["data"]["attempts"][0]["id"].clone();
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let early=call(&coordinator,"nesvo_deliver_task",json!({"key":"reuse-early","runId":run,"taskId":task,"expectedRevision":current["data"]["run"]["revision"],"sessionId":worker})).await?;
        assert_eq!(refusal(early)?,"attempt_unsettled");
        data(call(&coordinator,"nesvo_validate_task_result",json!({"key":"reject-first","runId":run,"attemptId":first,"expectedRevision":current["data"]["run"]["revision"],"validation":{"passed":false,"summary":"Retry on the same worker","checks":[{"name":"review","outcome":"failed","details":"Controlled rejection"}]}})).await?)?;
        session_ready(&owner,&worker).await?;
        attempt_state(&owner,run,task,0,"state","failed").await?;
        settled(&owner,&reported["data"]["attempts"][0]["delivery"]["receiptId"],&worker).await?;
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let foreign=call(&coordinator,"nesvo_deliver_task",json!({"key":"reuse-foreign","runId":run,"taskId":task,"expectedRevision":current["data"]["run"]["revision"],"sessionId":root_id})).await?;
        assert_eq!(refusal(foreign)?,"session_foreign");
        let mut human=human_control(&fixture.pairing(),&worker).await?;
        let busy=call(&coordinator,"nesvo_deliver_task",json!({"key":"reuse-busy","runId":run,"taskId":task,"expectedRevision":current["data"]["run"]["revision"],"sessionId":worker})).await?;
        assert_eq!(refusal(busy)?,"session_busy");
        drop(human.stdin.take());ensure!(human.wait().await?.success(),"Human release fixture");
        session_ready(&owner,&worker).await?;
        let before_reuse=data(call(&owner,"nesvo_read_session",json!({"sessionId":worker,"maxBytes":1})).await?)?["data"]["page"]["headCursor"].as_u64().context("worker transcript head")?;
        let unchanged=data(call(&owner,"nesvo_get_task_attempts",json!({"runId":run,"taskId":task})).await?)?;
        assert_eq!(unchanged["data"]["attempts"].as_array().map(Vec::len),Some(1));
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let revision=current["data"]["run"]["revision"].as_u64().unwrap().to_string();
        let accepted=inbox::scoped_cli(&context,&["run","deliver",run,"--task",task.as_str().unwrap(),"--key","reuse-instruction","--revision",&revision,"--session",&worker,"--json"]).await?;
        assert_eq!(accepted["data"]["delivery"]["phase"],"queued");assert!(accepted["data"]["delivery"]["receiptId"].is_null());
        assert_eq!(accepted["data"]["delivery"]["reuse"]["previousAttemptId"],first);
        let replay=data(call(&coordinator,"nesvo_deliver_task",json!({"key":"reuse-instruction","runId":run,"taskId":task,"expectedRevision":current["data"]["run"]["revision"],"sessionId":worker})).await?)?;
        assert_eq!(replay["data"],accepted["data"]);
        let sent=attempt_state(&owner,run,task,1,"delivery","sent").await?;
        let second=&sent["data"]["attempts"][1];
        assert_eq!(second["ordinal"],2);assert_eq!(second["sessionId"],worker.as_str());assert_ne!(second["delivery"]["receiptId"],sent["data"]["attempts"][0]["delivery"]["receiptId"]);
        attempt_state(&owner,run,task,1,"state","reported").await?;
        settled(&owner,&second["delivery"]["receiptId"],&worker).await?;
        response_after(&owner,&worker,"FIXTURE_RESPONSE report-task",before_reuse).await?;
        assert_eq!(settled_turns(&owner,&worker,2).await?,[2,2]);
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;for session in sessions["data"]["sessions"].as_array().unwrap(){assert!(session["controllerId"].is_null());}
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
