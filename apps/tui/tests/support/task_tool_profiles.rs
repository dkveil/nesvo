use super::*;

fn permissions(fixture: &Fixture, id: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.native-permissions.json")),
    )?)?)
}
fn context(fixture: &Fixture, id: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?))
}
async fn task_run(
    client: &RunningService<RoleClient, ()>,
    key: &str,
    count: usize,
) -> Result<(String, Vec<String>)> {
    let created = data(call(client,"nesvo_create_run",json!({"key":key,"spec":{"title":"Task native tools","goal":"No model calls or global configuration"}})).await?)?;
    let run = created["data"]["run"]["id"]
        .as_str()
        .context("tool run")?
        .to_owned();
    let tasks: Vec<Value> = (0..count).map(|i| json!({"key":format!("task-{i}"),"title":format!("Task {i}"),"instruction":"Controlled native profile fixture"})).collect();
    let plan = run_checkpoints::mutate(
        client,
        &run,
        "nesvo_set_run_plan",
        json!({"key":format!("{key}-plan"),"tasks":tasks}),
    )
    .await?;
    let tasks = plan["tasks"]
        .as_array()
        .context("profile tasks")?
        .iter()
        .map(|t| t["id"].as_str().context("task identity").map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    run_checkpoints::mutate(client,&run,"nesvo_set_run_budget",json!({"key":format!("{key}-budget"),"limits":{"maxParallel":8,"maxAttemptsPerTask":1,"maxElapsedMs":null}})).await?;
    run_checkpoints::mutate(
        client,
        &run,
        "nesvo_activate_run",
        json!({"key":format!("{key}-active")}),
    )
    .await?;
    Ok((run, tasks))
}
async fn history(client: &RunningService<RoleClient, ()>, run: &str, task: &str) -> Result<Value> {
    Ok(data(
        call(
            client,
            "nesvo_get_task_attempts",
            json!({"runId":run,"taskId":task}),
        )
        .await?,
    )?["data"]
        .clone())
}
async fn effective(client: &RunningService<RoleClient, ()>, id: &str) -> Result<Value> {
    Ok(
        data(call(client, "nesvo_get_session", json!({"sessionId":id})).await?)?["data"]["session"]
            ["harness"]["nativePermissions"]
            .clone(),
    )
}

#[tokio::test]
#[ignore = "native host/client, Node and Git; task permission selections never call a model"]
async fn task_tool_selection_is_a_policy_subset_or_explicit_owner_intent_and_survives_replay()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        waits::provider(&fixture,"claude").await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"task-tools-root","spec":{"name":"Task tools coordinator","program":"claude","role":"coordinator","harness":true,"childAllowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]}})).await?)?;
        let root=root["data"]["receipt"]["sessionId"].as_str().context("root")?;
        session_ready(&owner,root).await?;
        let root_context=context(&fixture,root)?;
        let coordinator=scoped_client(&root_context,root).await?;
        let (run,tasks)=task_run(&coordinator,"subset-run",7).await?;
        let revision=run_checkpoints::view(&coordinator,&run).await?["run"]["revision"].as_u64().context("run revision")?.to_string();
        let cli=inbox::scoped_cli(&root_context,&["run","launch",&run,"--task",&tasks[0],"--key","subset-cli","--revision",&revision,"--program","claude","--shared","--allow-nesvo-tool","nesvo_get_current_task","--json"]).await?;
        let worker=cli["data"]["launch"]["sessionId"].as_str().context("subset worker")?;
        session_ready(&owner,worker).await?;
        assert_eq!(permissions(&fixture,worker)?,json!(["mcp__nesvo__nesvo_get_current_task"]));
        let configured=effective(&owner,worker).await?;
        assert_eq!(configured["source"],"ownerChildPolicy");assert_eq!(configured["originSessionId"],root);
        let request=json!({"key":"subset-cli","runId":run,"taskId":tasks[0],"expectedRevision":revision.parse::<u64>()?,"profile":{"program":"claude","workspace":"shared","allowedNesvoTools":["nesvo_get_current_task"]}});
        let replay=data(call(&coordinator,"nesvo_launch_task",request.clone()).await?)?;
        assert_eq!(replay,cli,"CLI and MCP recover the same immutable acceptance");
        let mut changed=request;changed["profile"]["allowedNesvoTools"]=json!([]);
        let conflict=call(&coordinator,"nesvo_launch_task",changed).await?.structured_content.context("profile conflict")?;
        assert_eq!(conflict["error"]["code"],"idempotency_conflict");
        let saved=history(&coordinator,&run,&tasks[0]).await?;
        assert_eq!(saved["attempts"][0]["launch"]["profile"]["allowedNesvoTools"],json!(["nesvo_get_current_task"]));
        let revision=run_checkpoints::view(&coordinator,&run).await?["run"]["revision"].as_u64().context("empty revision")?.to_string();
        let empty=inbox::scoped_cli(&root_context,&["run","launch",&run,"--task",&tasks[1],"--key","empty-cli","--revision",&revision,"--program","claude","--shared","--clear-nesvo-tools","--json"]).await?;
        let empty_id=empty["data"]["launch"]["sessionId"].as_str().context("empty worker")?;session_ready(&owner,empty_id).await?;
        assert_eq!(permissions(&fixture,empty_id)?,json!([]));assert_eq!(effective(&owner,empty_id).await?["source"],"none");
        assert_eq!(history(&coordinator,&run,&tasks[1]).await?["attempts"][0]["launch"]["profile"]["allowedNesvoTools"],json!([]));
        let defaults=run_checkpoints::mutate(&coordinator,&run,"nesvo_launch_task",json!({"key":"default-inheritance","taskId":tasks[2],"profile":{"program":"claude","workspace":"shared"}})).await?;
        let default_id=defaults["launch"]["sessionId"].as_str().context("default worker")?;session_ready(&owner,default_id).await?;
        assert_eq!(permissions(&fixture,default_id)?,json!(["mcp__nesvo__nesvo_get_current_task","mcp__nesvo__nesvo_report_task_result"]));
        let owner_launches_refused_by_coordinator_policy_before_any_effect=[
            (3,json!({"program":"claude","workspace":"worktree","allowedNesvoTools":["nesvo_create_session"]}),"forbidden"),
            (4,json!({"program":"claude","workspace":"shared","harness":false,"allowedNesvoTools":[]}),"unsupported"),
            (5,json!({"program":"shell","workspace":"shared","harness":false,"allowedNesvoTools":[]}),"unsupported"),
            (6,json!({"program":"claude","workspace":"shared","allowedNesvoTools":["*"]}),"invalid_argument"),
        ];
        for (index,profile,code) in owner_launches_refused_by_coordinator_policy_before_any_effect {
            let rejected=run_checkpoints::mutate(&owner,&run,"nesvo_launch_task",json!({"key":format!("refuse-{index}"),"taskId":tasks[index],"profile":profile})).await?;
            let receipt=data(call(&owner,"nesvo_get_operation",json!({"id":rejected["launch"]["receiptId"]})).await?)?;
            assert_eq!(receipt["data"]["receipt"]["phase"],"failed");
            assert_eq!(receipt["data"]["receipt"]["result"]["code"],code);
            assert_eq!(receipt["data"]["receipt"]["result"]["effectStarted"],false);
        }
        let worker_client=scoped_client(&context(&fixture,worker)?,worker).await?;
        let denied=call(&worker_client,"nesvo_launch_task",json!({"key":"worker-no-escalation","runId":run,"taskId":tasks[3],"expectedRevision":1,"profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_create_session"]}})).await?.structured_content.context("worker refusal")?;
        assert_eq!(denied["error"]["code"],"forbidden");
        let (unbound,owner_tasks)=task_run(&owner,"owner-no-coordinator",1).await?;
        let explicit=run_checkpoints::mutate(&owner,&unbound,"nesvo_launch_task",json!({"key":"owner-task-tools","taskId":owner_tasks[0],"profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_create_session","nesvo_get_current_task"]}})).await?;
        let explicit_id=explicit["launch"]["sessionId"].as_str().context("owner-selected worker")?;session_ready(&owner,explicit_id).await?;
        assert_eq!(permissions(&fixture,explicit_id)?,json!(["mcp__nesvo__nesvo_create_session","mcp__nesvo__nesvo_get_current_task"]));
        assert_eq!(effective(&owner,explicit_id).await?["source"],"ownerLaunch");
        let owner_worker=scoped_client(&context(&fixture,explicit_id)?,explicit_id).await?;
        let denied=call(&owner_worker,"nesvo_create_session",json!({"key":"native-allow-does-not-grant-role","spec":{"name":"No recursive grant","program":"shell"}})).await?.structured_content.context("native allow host refusal")?;
        assert_eq!(denied["error"]["code"],"forbidden");
        let (automatic,automatic_tasks)=task_run(&coordinator,"automatic-subset",1).await?;
        let executor_spec=json!({"tasks":[{"taskId":automatic_tasks[0],"profile":{"program":"claude","workspace":"shared","allowedNesvoTools":["nesvo_report_task_result"]}}]});
        let executor_file=fixture.directory.join("task profile łódź.json");std::fs::write(&executor_file,serde_json::to_vec(&executor_spec)?)?;
        let revision=run_checkpoints::view(&coordinator,&automatic).await?["run"]["revision"].as_u64().context("executor revision")?.to_string();
        let executor=inbox::scoped_cli(&root_context,&["run","executor","start",&automatic,"--key","executor-subset","--revision",&revision,"--file",executor_file.to_str().context("executor profile file")?,"--json"]).await?;
        let stored=data(call(&coordinator,"nesvo_get_run_executor",json!({"runId":automatic})).await?)?;
        assert_eq!(stored["data"]["executor"]["spec"]["tasks"][0]["profile"]["allowedNesvoTools"],json!(["nesvo_report_task_result"]));
        let automatic_history=waits::until(async || {
            let current=history(&coordinator,&automatic,&automatic_tasks[0]).await?;
            let phase=&current["attempts"][0]["launch"]["phase"];
            if phase=="created" {return Ok(Some(current));}
            ensure!(!matches!(phase.as_str(),Some("failed"|"unknown")),"Automatic subset launch settled as {phase}: {current}");
            Ok(None)
        }).await.context("automatic subset launch")?;
        let automatic_id=automatic_history["attempts"][0]["sessionId"].as_str().context("executor worker")?;
        session_ready(&owner,automatic_id).await?;
        assert_eq!(permissions(&fixture,automatic_id)?,json!(["mcp__nesvo__nesvo_report_task_result"]));
        assert_eq!(automatic_history["attempts"][0]["launch"]["profile"]["allowedNesvoTools"],json!(["nesvo_report_task_result"]));
        let listed=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(listed["data"]["sessions"].as_array().context("session count")?.len(),6,"Rejected profiles and replays never start processes");
        let history_envelope=data(call(&coordinator,"nesvo_get_task_attempts",json!({"runId":run,"taskId":tasks[0]})).await?)?;
        run_checkpoints::schema(vec![cli,replay,empty,executor,stored,history_envelope,listed]).await?;
        owner_worker.cancel().await?;worker_client.cancel().await?;coordinator.cancel().await?;owner.cancel().await?;
        fixture.restart(false).await?;
        let owner=client(&fixture.pairing()).await?;
        assert_eq!(history(&owner,&run,&tasks[0]).await?["attempts"][0]["launch"]["profile"]["allowedNesvoTools"],json!(["nesvo_get_current_task"]));
        let restored=recoveries(&fixture.pairing()).await?;
        for record in restored.as_array().context("recovery profiles")? {
            assert!(record["spec"].get("allowedNesvoTools").is_none(),"Historical task profiles must not restore process authority");
        }
        let listed=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(listed["data"]["sessions"].as_array().context("no restart effects")?.is_empty());
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
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
