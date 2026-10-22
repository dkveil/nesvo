use super::*;

#[tokio::test]
#[ignore = "requires native binaries, Node and Git; atomic task launch with real PTYs and worktree"]
async fn launch_reserves_before_spawn_replays_once_and_obeys_validation_and_run_control()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let repository=fixture.directory.join("repo");std::fs::create_dir(&repository)?;
        let git=|args:Vec<&str>| {let mut command=Command::new("git");command.current_dir(&repository).args(args);#[cfg(windows)]command.creation_flags(0x08000000);command};
        ensure!(git(vec!["init","--quiet"]).output().await?.status.success(),"Initialize owned Git fixture");
        ensure!(git(vec!["config","core.autocrlf","false"]).output().await?.status.success(),"Keep fixture bytes independent of user Git defaults");
        std::fs::write(repository.join("source.txt"),"committed\n")?;
        ensure!(git(vec!["add","--","source.txt"]).output().await?.status.success(),"Stage owned fixture file");
        ensure!(git(vec!["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=","commit","--quiet","-m","fixture"]).output().await?.status.success(),"Commit owned fixture source");
        std::fs::write(repository.join("source.txt"),"keep source edits\n")?;
        waits::provider(&fixture,"claude").await?;
        let owner=client(&fixture.pairing()).await?;
        let root=waits::operation(&owner,"nesvo_create_session",json!({"key":"launch-root","spec":{"name":"Launch coordinator","program":"claude","cwd":repository,"role":"coordinator","harness":true}})).await?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("launch root")?;
        session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"launch-run","spec":{"title":"Bounded task launches","goal":"Dependency ready visible work"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"launch-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"implement","title":"Implement","instruction":"Controlled implementation"},{"key":"independent","title":"Independent","instruction":"Independent work"},{"key":"review","title":"Review","instruction":"Review accepted evidence","dependencies":["implement"]}]})).await?)?;
        let policy=data(call(&coordinator,"nesvo_set_run_budget",json!({"key":"launch-policy","runId":run,"expectedRevision":2,"limits":{"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":null}})).await?)?;
        let active=data(call(&coordinator,"nesvo_activate_run",json!({"key":"activate-launch","runId":run,"expectedRevision":policy["data"]["run"]["revision"]})).await?)?;
        let revision=active["data"]["run"]["revision"].as_u64().context("launch revision")?.to_string();
        let implement=plan["data"]["tasks"][0]["id"].as_str().context("implement task")?;
        let args=json!({"key":"same-launch","runId":run,"taskId":implement,"expectedRevision":active["data"]["run"]["revision"],"profile":{"program":"claude","workspace":"shared","harness":true}});
        let (first,second)=tokio::join!(call(&coordinator,"nesvo_launch_task",args.clone()),call(&coordinator,"nesvo_launch_task",args));
        let mut accepted=None;
        for reply in [first?,second?] {
            if reply.is_error==Some(true) {assert_eq!(reply.structured_content.context("concurrent refusal")?["error"]["code"],"busy");}
            else {let next=data(reply)?;if let Some(prior)=&accepted {assert_eq!(prior,&next);}accepted=Some(next);}
        }
        let accepted=accepted.context("at least one launch accepted")?;
        let child=accepted["data"]["launch"]["sessionId"].as_str().context("reserved child")?;
        assert_eq!(accepted["data"]["launch"]["phase"],"accepted");
        let replay=inbox::scoped_cli(&context,&["run","launch",run,"--task",implement,"--key","same-launch","--revision",&revision,"--program","claude","--shared","--harness","--json"]).await?;
        assert_eq!(replay["data"],accepted["data"]);
        session_ready(&owner,child).await?;
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        assert_eq!(current["data"]["tasks"][0]["state"],"assigned");
        assert_eq!(current["data"]["run"]["budget"]["activeAttempts"],1);
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(sessions["data"]["sessions"].as_array().context("session list")?.len(),2);
        for session in sessions["data"]["sessions"].as_array().unwrap() {assert!(session["controllerId"].is_null());}
        let denied=call(&coordinator,"nesvo_launch_task",json!({"key":"parallel-denied","runId":run,"taskId":plan["data"]["tasks"][1]["id"],"expectedRevision":current["data"]["run"]["revision"],"profile":{"program":"shell","workspace":"shared","harness":false}})).await?;
        assert_eq!(denied.structured_content.context("parallel refusal")?["error"]["code"],"parallel_budget_exhausted");
        let early_review=call(&coordinator,"nesvo_launch_task",json!({"key":"review-too-early","runId":run,"taskId":plan["data"]["tasks"][2]["id"],"expectedRevision":current["data"]["run"]["revision"],"profile":{"program":"shell","workspace":"worktree","harness":false}})).await?;
        assert_eq!(early_review.structured_content.context("dependency refusal")?["error"]["code"],"dependencies_unmet");
        waits::operation(&coordinator,"nesvo_send_prompt",json!({"key":"launch-work","sessionId":child,"prompt":"report-task"})).await?;
        let reported=waits::until(async || {
            let view=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
            let task=&view["data"]["tasks"][0];
            if task["state"]=="reported" {return Ok(Some(view));}
            ensure!(!waits::is_settled_attempt(&task["currentAttempt"]["state"]) && !waits::is_settled_run(&view["data"]["run"]["state"]),"Launched task settled before its report: {view}");
            Ok(None)
        }).await?;
        let validated=data(call(&coordinator,"nesvo_validate_task_result",json!({"key":"accept-launch-result","runId":run,"attemptId":reported["data"]["tasks"][0]["currentAttempt"]["id"],"expectedRevision":reported["data"]["run"]["revision"],"validation":{"passed":true,"summary":"Controlled fixture report inspected","checks":[{"name":"fixture","outcome":"passed","details":"Observed native result reporting"}]}})).await?)?;
        let failed=data(call(&coordinator,"nesvo_launch_task",json!({"key":"known-failed-launch","runId":run,"taskId":plan["data"]["tasks"][1]["id"],"expectedRevision":validated["data"]["run"]["revision"],"profile":{"name":"","program":"shell","workspace":"shared","harness":false}})).await?)?;
        let failed_receipt=data(call(&coordinator,"nesvo_get_operation",json!({"id":failed["data"]["launch"]["receiptId"]})).await?)?;
        assert_eq!(failed_receipt["data"]["receipt"]["phase"],"failed");
        assert_eq!(failed_receipt["data"]["receipt"]["result"]["effectStarted"],false);
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        assert_eq!(current["data"]["tasks"][1]["state"],"launchFailed");
        let review=data(call(&owner,"nesvo_launch_task",json!({"key":"isolated-review","runId":run,"taskId":plan["data"]["tasks"][2]["id"],"expectedRevision":current["data"]["run"]["revision"],"profile":{"program":"shell","workspace":"worktree","harness":false}})).await?)?;
        let foreign_receipt=call(&coordinator,"nesvo_get_operation",json!({"id":review["data"]["launch"]["receiptId"]})).await?;
        assert_eq!(foreign_receipt.structured_content.context("receipt issuer scope")?["error"]["code"],"operation_not_found");
        let owner_receipt=data(call(&owner,"nesvo_get_operation",json!({"id":review["data"]["launch"]["receiptId"]})).await?)?;
        assert_eq!(owner_receipt["data"]["receipt"]["phase"],"created");
        let review_id=review["data"]["launch"]["sessionId"].as_str().context("review child")?;
        let review_session=data(call(&coordinator,"nesvo_get_session",json!({"sessionId":review_id})).await?)?;
        let directory=PathBuf::from(review_session["data"]["session"]["cwd"].as_str().context("worktree path")?);
        assert!(directory.canonicalize()?.starts_with(fixture.directory.canonicalize()?));
        assert_ne!(directory.canonicalize()?,repository.canonicalize()?);
        assert_eq!(std::fs::read_to_string(directory.join("source.txt"))?,"committed\n");
        assert_eq!(std::fs::read_to_string(repository.join("source.txt"))?,"keep source edits\n");
        let current=data(call(&coordinator,"nesvo_get_run",json!({"runId":run})).await?)?;
        let canceled=data(call(&coordinator,"nesvo_cancel_run",json!({"key":"cancel-launched","runId":run,"expectedRevision":current["data"]["run"]["revision"]})).await?)?;
        let control=canceled["data"]["control"]["id"].as_str().context("cancel control")?;
        waits::until(async || {
            let view=data(call(&coordinator,"nesvo_get_run_control",json!({"runId":run,"controlId":control})).await?)?;
            let state=&view["data"]["control"]["state"];
            if state=="completed" {assert_eq!(view["data"]["targets"].as_array().unwrap().len(),2,"No target is fabricated for known no-effect startup failure");return Ok(Some(()));}
            ensure!(state!="blocked","Run control blocked: {view}");
            Ok(None)
        }).await?;
        let root=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;assert_eq!(root["data"]["session"]["running"],true);
        let orphan_run=data(call(&owner,"nesvo_create_run",json!({"key":"lost-coordinator-run","spec":{"title":"Stopped coordinator","goal":"Do not revive its authority","coordinatorSessionId":root_id}})).await?)?;
        let orphan_id=orphan_run["data"]["run"]["id"].as_str().context("orphan run")?;
        let orphan_plan=data(call(&owner,"nesvo_set_run_plan",json!({"key":"lost-coordinator-plan","runId":orphan_id,"expectedRevision":1,"tasks":[{"key":"work","title":"Work","instruction":"No implicit coordinator adoption"}]})).await?)?;
        let orphan_active=data(call(&owner,"nesvo_activate_run",json!({"key":"lost-coordinator-active","runId":orphan_id,"expectedRevision":orphan_plan["data"]["run"]["revision"]})).await?)?;
        waits::operation(&owner,"nesvo_stop_session",json!({"key":"deliberate-coordinator-stop","sessionId":root_id})).await?;
        waits::session(&owner,root_id,waits::Session::Stopped).await?;
        let refused=data(call(&owner,"nesvo_launch_task",json!({"key":"owner-cannot-revive-coordinator","runId":orphan_id,"taskId":orphan_plan["data"]["tasks"][0]["id"],"expectedRevision":orphan_active["data"]["run"]["revision"],"profile":{"program":"shell","workspace":"shared","harness":false}})).await?)?;
        let receipt=data(call(&owner,"nesvo_get_operation",json!({"id":refused["data"]["launch"]["receiptId"]})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["result"]["code"],"scope_revoked");
        assert_eq!(receipt["data"]["receipt"]["result"]["effectStarted"],false);
        let orphan=data(call(&owner,"nesvo_get_run",json!({"runId":orphan_id})).await?)?;
        assert_eq!(orphan["data"]["tasks"][0]["state"],"launchFailed");assert_eq!(orphan["data"]["run"]["budget"]["activeAttempts"],0);
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
