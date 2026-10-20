use super::*;

#[tokio::test]
#[ignore = "requires native binaries and Node; run budget/control fixture without model calls"]
async fn run_policy_drain_and_deadline_fence_native_workers_without_killing_them() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        timeout(Duration::from_secs(5),async {loop {
            let report=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
            if report["providerVersions"].as_array().is_some_and(|versions|versions.iter().any(|version|version["program"]=="claude"&&version["status"]=="ready")) {return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }}).await??;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"run-budget-root","spec":{"name":"Run coordinator","role":"coordinator","program":"claude","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("run coordinator")?;
        session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let mut children=Vec::new();
        for index in 0..2 {
            let child=data(call(&coordinator,"nesvo_create_session",json!({"key":format!("run-worker-{index}"),"spec":{"name":format!("Run worker {index}"),"program":"claude"}})).await?)?;
            let id=child["data"]["receipt"]["sessionId"].as_str().context("run worker")?.to_owned();
            session_ready(&owner,&id).await?;
            children.push(id);
        }
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"budget-run","spec":{"title":"Run limits","goal":"Controlled native admission, never a model call"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("run ID")?;
        let planned=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"budget-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"first","title":"First","instruction":"Report through the original native CLI"},{"key":"next","title":"Next","instruction":"Check admission independently"}]})).await?)?;
        let first=planned["data"]["tasks"][0]["id"].clone();
        let next=planned["data"]["tasks"][1]["id"].clone();
        let limits=json!({"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":null});
        let path=fixture.directory.join("run policy łódź.json");
        std::fs::write(&path,serde_json::to_vec(&limits)?)?;
        let configured=budgets::owner_cli(&fixture,&["run","budget","set",run,"--key","run-policy","--revision","2","--file",path.to_str().context("policy path")?,"--json"]).await?;
        let replay=data(call(&owner,"nesvo_set_run_budget",json!({"key":"run-policy","runId":run,"expectedRevision":2,"limits":limits})).await?)?;
        assert_eq!(configured["data"],replay["data"],"CLI/MCP share policy mutation keys");
        let observed=data(call(&coordinator,"nesvo_get_run_budget",json!({"runId":run})).await?)?;
        assert_eq!(observed["data"]["policy"]["timeState"],"notStarted");
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"budget-start","runId":run,"expectedRevision":3})).await?)?;
        let assigned=data(call(&coordinator,"nesvo_assign_task",json!({"key":"budget-first","runId":run,"taskId":first,"sessionId":children[0],"expectedRevision":4})).await?)?;
        let attempt=assigned["data"]["tasks"][0]["currentAttempt"]["id"].clone();
        let refused=call(&coordinator,"nesvo_assign_task",json!({"key":"parallel-refusal","runId":run,"taskId":next,"sessionId":children[1],"expectedRevision":5})).await?;
        assert_eq!(refused.structured_content.context("parallel refusal")?["error"]["code"],"parallel_budget_exhausted");
        let drained=budgets::owner_cli(&fixture,&["run","drain",run,"--key","human-drain","--revision","5","--json"]).await?;
        assert_eq!(drained["data"]["run"]["state"],"draining");
        let refused=call(&coordinator,"nesvo_resume_run",json!({"key":"bypass-owner","runId":run,"expectedRevision":6})).await?;
        assert_eq!(refused.structured_content.context("owner drain authority")?["error"]["code"],"forbidden");
        let refused=call(&coordinator,"nesvo_assign_task",json!({"key":"drained-refusal","runId":run,"taskId":next,"sessionId":children[1],"expectedRevision":6})).await?;
        assert_eq!(refused.structured_content.context("drain admission")?["error"]["code"],"run_state_conflict");
        report_from_controlled_worker(&coordinator,&fixture.directory,&children[0]).await?;
        let validated=data(call(&owner,"nesvo_validate_task_result",json!({"key":"drain-validate","runId":run,"attemptId":attempt,"expectedRevision":7,"validation":{"passed":true,"summary":"Controlled native result transport","checks":[{"name":"result","outcome":"passed","details":"Fixture report was inspected; no model calls"}]}})).await?)?;
        assert_eq!(validated["data"]["run"]["state"],"drained");
        let original_start=validated["data"]["run"]["budget"]["startedAt"].clone();
        let resumed=budgets::owner_cli(&fixture,&["run","resume",run,"--key","human-resume","--revision","8","--json"]).await?;
        assert_eq!(resumed["data"]["run"]["budget"]["startedAt"],original_start);
        data(call(&coordinator,"nesvo_assign_task",json!({"key":"budget-next","runId":run,"taskId":next,"sessionId":children[1],"expectedRevision":9})).await?)?;
        let timed=json!({"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":1000});
        data(call(&owner,"nesvo_set_run_budget",json!({"key":"run-deadline","runId":run,"expectedRevision":10,"limits":timed})).await?)?;
        timeout(Duration::from_secs(4),async {loop {
            let policy=data(call(&owner,"nesvo_get_run_budget",json!({"runId":run})).await?)?;
            if policy["data"]["policy"]["timeState"]=="exhausted" {return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }}).await??;
        let before=data(call(&owner,"nesvo_read_session",json!({"sessionId":children[1],"maxBytes":8192})).await?)?;
        let refused=call(&coordinator,"nesvo_send_prompt",json!({"key":"late-native-send","sessionId":children[1],"prompt":"Never submit after the elapsed budget"})).await?;
        let refused=refused.structured_content.context("elapsed native send fence")?;
        assert_eq!(refused["error"]["receipt"]["result"]["code"],"time_budget_exhausted");
        assert_eq!(refused["error"]["receipt"]["result"]["effectStarted"],false);
        let after=data(call(&owner,"nesvo_read_session",json!({"sessionId":children[1],"maxBytes":8192})).await?)?;
        assert_eq!(before["data"]["page"],after["data"]["page"]);
        for id in &children {
            let view=data(call(&owner,"nesvo_get_session",json!({"sessionId":id})).await?)?;
            assert_eq!(view["data"]["session"]["running"],true);
            assert_eq!(view["data"]["session"]["controllerId"],Value::Null);
        }
        coordinator.cancel().await?;owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}
