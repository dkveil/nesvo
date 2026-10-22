use super::*;

async fn control_state(
    owner: &RunningService<RoleClient, ()>,
    run: &str,
    control: &str,
    state: &str,
) -> Result<Value> {
    waits::until(async || {
        let view = data(
            call(
                owner,
                "nesvo_get_run_control",
                json!({"runId":run,"controlId":control}),
            )
            .await?,
        )?;
        let current = &view["data"]["control"]["state"];
        if current == state {
            return Ok(Some(view));
        }
        ensure!(
            current != "completed" && (state != "blocked" || current != "unconfirmed"),
            "Native control settled before reaching {state}: {view}"
        );
        Ok(None)
    })
    .await
    .context("Native control did not reach its expected observed state")
}
#[tokio::test]
#[ignore = "requires native binaries and Node; run stop/cancel with real native effects, no models"]
async fn controls_only_bound_workers_preserves_human_drafts_and_never_replays_signals() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        waits::provider(&fixture,"claude").await?;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"control-root","spec":{"name":"Control coordinator","program":"claude","role":"coordinator","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("control root")?;
        session_ready(&owner,root_id).await?;
        let root_context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&root_context,root_id).await?;
        let mut children=Vec::new();
        for (index,program) in ["claude","shell","shell"].into_iter().enumerate() {
            let child=data(call(&coordinator,"nesvo_create_session",json!({"key":format!("control-child-{index}"),"spec":{"name":format!("Control child {index}"),"program":program,"harness":program=="claude"}})).await?)?;
            let id=child["data"]["receipt"]["sessionId"].as_str().context("control child")?.to_owned();
            if program=="claude" {session_ready(&owner,&id).await?;}
            children.push(id);
        }
        let foreign=data(call(&owner,"nesvo_create_session",json!({"key":"control-foreign","spec":{"name":"Foreign shell","program":"shell","parentSessionId":root_id}})).await?)?;
        let foreign_id=foreign["data"]["receipt"]["sessionId"].as_str().context("foreign")?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"native-control-run","spec":{"title":"Native stop and cancel","goal":"Bounded physical control only"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("control run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"native-control-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"first","title":"First","instruction":"Controlled task"},{"key":"second","title":"Second","instruction":"Independent controlled task"}]})).await?)?;
        let mut current=data(call(&coordinator,"nesvo_activate_run",json!({"key":"native-control-start","runId":run,"expectedRevision":2})).await?)?;
        let started=current["data"]["run"]["budget"]["startedAt"].clone();
        for index in 0..2 {
            current=data(call(&coordinator,"nesvo_assign_task",json!({"key":format!("control-assign-{index}"),"runId":run,"expectedRevision":current["data"]["run"]["revision"],"taskId":plan["data"]["tasks"][index]["id"],"sessionId":children[index]})).await?)?;
        }
        let original_revision=current["data"]["run"]["revision"].as_u64().context("control revision")?.to_string();
        let mut human=human_control_variant(&fixture.pairing(),&children[0],true).await?;
        let accepted=budgets::owner_cli(&fixture,&["run","stop",run,"--key","native-run-stop","--revision",&original_revision,"--json"]).await?;
        let control=accepted["data"]["control"]["id"].as_str().context("stop control")?;
        let blocked=control_state(&owner,run,control,"blocked").await?;
        assert_eq!(blocked["data"]["control"]["counts"]["exited"],1);
        let human_target=blocked["data"]["targets"].as_array().context("control targets")?.iter().find(|target|target["sessionId"]==children[0]).context("human target")?;
        assert_eq!(human_target["code"],"control_busy");
        let receipt=data(call(&owner,"nesvo_get_operation",json!({"key":human_target["operationKey"]})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["result"]["effectStarted"],false);
        let replay=data(call(&owner,"nesvo_stop_run",json!({"key":"native-run-stop","runId":run,"expectedRevision":original_revision.parse::<u64>()?})).await?)?;
        assert_eq!(replay["data"],accepted["data"]);
        drop(human.stdin.take());human.wait().await?;
        waits::session(&owner,&children[0],waits::Session::Released).await?;
        let replay=data(call(&owner,"nesvo_stop_run",json!({"key":"native-run-stop","runId":run,"expectedRevision":original_revision.parse::<u64>()?})).await?)?;
        assert_eq!(replay["data"],accepted["data"],"Replay after human release must not signal again");
        let current=data(call(&owner,"nesvo_get_run",json!({"runId":run})).await?)?;
        let second=data(call(&owner,"nesvo_stop_run",json!({"key":"deliberate-run-stop","runId":run,"expectedRevision":current["data"]["run"]["revision"]})).await?)?;
        let second_id=second["data"]["control"]["id"].as_str().context("second control")?;
        let draft_blocked=control_state(&owner,run,second_id,"blocked").await?;
        assert_eq!(draft_blocked["data"]["targets"][0]["code"],"control_busy","Run stop protects a draft even after its lease is released");
        data(call(&owner,"nesvo_stop_session",json!({"key":"explicit-human-draft-stop","sessionId":children[0]})).await?)?;
        let stopped=control_state(&owner,run,second_id,"completed").await?;
        assert_eq!(stopped["data"]["run"]["state"],"stopped");
        let forbidden=call(&coordinator,"nesvo_resume_run",json!({"key":"coordinator-bypass","runId":run,"expectedRevision":stopped["data"]["run"]["revision"]})).await?;
        assert_eq!(forbidden.structured_content.context("owner stop latch")?["error"]["code"],"forbidden");
        let resumed=data(call(&owner,"nesvo_resume_run",json!({"key":"owner-reopens-stopped","runId":run,"expectedRevision":stopped["data"]["run"]["revision"]})).await?)?;
        assert_eq!(resumed["data"]["run"]["budget"]["startedAt"],started);
        let fresh=data(call(&coordinator,"nesvo_create_session",json!({"key":"fresh-control-worker","spec":{"name":"Fresh retry worker","program":"shell","harness":false}})).await?)?;
        let fresh_id=fresh["data"]["receipt"]["sessionId"].as_str().context("fresh worker")?;
        let assigned=data(call(&coordinator,"nesvo_assign_task",json!({"key":"fresh-control-attempt","runId":run,"expectedRevision":resumed["data"]["run"]["revision"],"taskId":plan["data"]["tasks"][0]["id"],"sessionId":fresh_id})).await?)?;
        assert_eq!(assigned["data"]["tasks"][0]["currentAttempt"]["ordinal"],2);
        let canceled=data(call(&coordinator,"nesvo_cancel_run",json!({"key":"native-run-cancel","runId":run,"expectedRevision":assigned["data"]["run"]["revision"]})).await?)?;
        let cancellation=canceled["data"]["control"]["id"].as_str().context("cancel control")?;
        let canceled=control_state(&owner,run,cancellation,"completed").await?;
        assert_eq!(canceled["data"]["run"]["state"],"canceled");
        assert_eq!(canceled["data"]["targets"].as_array().context("cancel scope")?.len(),1);
        let terminal=call(&owner,"nesvo_resume_run",json!({"key":"revive-canceled","runId":run,"expectedRevision":canceled["data"]["run"]["revision"]})).await?;
        assert_eq!(terminal.structured_content.context("terminal cancel")?["error"]["code"],"run_state_conflict");
        for id in [root_id,children[2].as_str(),foreign_id] {
            let session=data(call(&owner,"nesvo_get_session",json!({"sessionId":id})).await?)?;
            assert_eq!(session["data"]["session"]["running"],true,"Control never targets the coordinator, unassigned children or foreign sessions");
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
