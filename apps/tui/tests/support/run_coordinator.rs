use super::*;
use run_checkpoints::{mutate, schema, setup, view};

async fn provider_probe_completed(fixture: &Fixture) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
            if doctor["providerVersions"]
                .as_array()
                .is_some_and(|versions| {
                    versions
                        .iter()
                        .any(|v| v["program"] == "claude" && v["status"] == "ready")
                })
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Replacement provider readiness after host restart")?
}
async fn replacement(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    directory: Option<&Path>,
) -> Result<(String, PathBuf, RunningService<RoleClient, ()>)> {
    provider_probe_completed(fixture).await?;
    let mut spec = json!({"name":"Replacement coordinator","program":"claude","role":"coordinator","harness":true});
    if let Some(directory) = directory {
        spec["cwd"] = directory.to_string_lossy().as_ref().into();
    }
    let created = data(
        call(
            owner,
            "nesvo_create_session",
            json!({"key":format!("replacement-{}",directory.is_some()),"spec":spec}),
        )
        .await?,
    )?;
    let id = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("replacement ID")?
        .to_owned();
    session_ready(owner, &id).await?;
    let context = PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?);
    let client = scoped_client(&context, &id).await?;
    Ok((id, context, client))
}
async fn stop(owner: &RunningService<RoleClient, ()>, id: &str) -> Result<()> {
    data(
        call(
            owner,
            "nesvo_stop_session",
            json!({"key":format!("stop-{id}"),"sessionId":id}),
        )
        .await?,
    )?;
    timeout(Duration::from_secs(6), async {
        loop {
            let current = data(call(owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
            if current["data"]["session"]["running"] == false {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await??;
    Ok(())
}
async fn refusal(client: &RunningService<RoleClient, ()>, args: Value, code: &str) -> Result<()> {
    let reply = call(client, "nesvo_rebind_run_coordinator", args).await?;
    assert_eq!(reply.is_error, Some(true));
    assert_eq!(
        reply.structured_content.context("binding refusal")?["error"]["code"],
        code
    );
    Ok(())
}
fn args(run: &str, old: &str, new: &str, revision: Value) -> Value {
    json!({"key":"recover-coordinator-once","runId":run,"expectedRevision":revision,"expectedCoordinatorSessionId":old,"coordinatorSessionId":new})
}
async fn pending_note(fixture: &Fixture, child: &str, run: &str) -> Result<Value> {
    let path = PathBuf::from(std::fs::read_to_string(
        fixture
            .directory
            .join("callers")
            .join(format!("{child}.txt")),
    )?);
    let worker = scoped_client(&path, child).await?;
    let sent = data(call(&worker,"nesvo_send_message",json!({"key":"retained-question","runId":run,"correlationId":"restart-safe","kind":"question","body":"Retain this literal question łódź $(never-execute)"})).await?)?;
    worker.cancel().await?;
    Ok(sent)
}

#[tokio::test]
#[ignore = "native binaries and Node; owner binding preserves context/control without worker adoption"]
async fn owner_rebind_recovers_metadata_but_preserves_target_draft_and_old_worker_authority()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let (old,child,run,_,old_client)=setup(&fixture,&owner).await?;
        let note=pending_note(&fixture,&child,&run).await?;
        let retained_result=report_from_controlled_worker(&old_client,&fixture.directory,&child).await?;
        let (new,path,new_client)=replacement(&fixture,&owner,None).await?;
        let revision=view(&owner,&run).await?["run"]["revision"].clone();
        let request=args(&run,&old,&new,revision);
        refusal(&old_client,request.clone(),"forbidden").await?;
        refusal(&owner,request.clone(),"coordinator_alive").await?;
        stop(&owner,&old).await?;
        let foreign_directory=fixture.directory.join("different workspace łódź");
        std::fs::create_dir(&foreign_directory)?;
        let (foreign,_,foreign_client)=replacement(&fixture,&owner,Some(&foreign_directory)).await?;
        refusal(&owner,args(&run,&old,&foreign,request["expectedRevision"].clone()),"coordinator_context_mismatch").await?;
        refusal(&owner,args(&run,&old,&child,request["expectedRevision"].clone()),"session_not_found").await?;
        let mut wrong_revision=request.clone();wrong_revision["expectedRevision"]=0.into();
        refusal(&owner,wrong_revision,"revision_conflict").await?;
        let mut human=human_control_variant(&fixture.pairing(),&new,true).await?;
        let before=data(call(&owner,"nesvo_get_session",json!({"sessionId":new})).await?)?;
        let screen=data(call(&owner,"nesvo_read_session",json!({"sessionId":new,"maxBytes":8192})).await?)?;
        assert!(before["data"]["session"]["controllerId"].is_number());
        let state=view(&owner,&run).await?;
        let revision=request["expectedRevision"].as_u64().context("binding revision")?.to_string();
        let bound=budgets::owner_cli(&fixture,&["run","bind-coordinator",&run,"--from",&old,"--session",&new,"--key","recover-coordinator-once","--revision",&revision,"--json"]).await?;
        assert_eq!(bound["data"]["run"]["coordinatorSessionId"],new);
        assert_eq!(bound["data"]["run"]["coordinatorBinding"]["source"],"retainedSession");
        assert_eq!(bound["data"]["nativeEffectsRestored"],false);
        assert_eq!(bound["data"]["workerAuthorityRestored"],false);
        assert_eq!(bound["data"]["tasks"],state["tasks"]);
        assert_eq!(bound["data"]["run"]["budget"],state["run"]["budget"]);
        let replay=data(call(&owner,"nesvo_rebind_run_coordinator",request.clone()).await?)?;
        assert_eq!(replay["data"],bound["data"]);
        let mut changed=request;changed["coordinatorSessionId"]=foreign.into();
        refusal(&owner,changed,"idempotency_conflict").await?;
        let recovered=inbox::scoped_cli(&path,&["run","recover","--json"]).await?;
        assert_eq!(recovered["data"]["page"]["run"]["id"],run);
        let inbox=data(call(&new_client,"nesvo_read_inbox",json!({"runId":run})).await?)?;
        let messages=inbox["data"]["messages"].as_array().context("retained inbox")?;
        assert!(messages.iter().any(|m|m["id"]==note["data"]["message"]["id"]));
        assert!(messages.iter().any(|m|m["kind"]=="result"&&m["payload"]["reportId"]==retained_result["data"]["report"]["id"]));
        assert_eq!(inbox["data"]["pendingCount"],2);
        let denied=call(&new_client,"nesvo_read_session",json!({"sessionId":child,"maxBytes":1024})).await?;
        assert_eq!(denied.is_error,Some(true),"Metadata recovery must not adopt the old worker PTY");
        let after=data(call(&owner,"nesvo_get_session",json!({"sessionId":new})).await?)?;
        let after_screen=data(call(&owner,"nesvo_read_session",json!({"sessionId":new,"maxBytes":8192})).await?)?;
        assert_eq!(after["data"]["session"]["controllerId"],before["data"]["session"]["controllerId"]);
        assert_eq!(after_screen["data"]["page"]["data"],screen["data"]["page"]["data"]);
        let forbidden_send=call(&owner,"nesvo_send_prompt",json!({"key":"preserved-human-draft","sessionId":new,"prompt":"MUST_NOT_REPLACE_DRAFT"})).await?;
        assert_eq!(forbidden_send.is_error,Some(true));
        schema(vec![bound,replay,recovered,inbox]).await?;
        drop(human.stdin.take());ensure!(timeout(Duration::from_secs(5),human.wait()).await??.success(),"Owned human controller did not exit");
        foreign_client.cancel().await?;new_client.cancel().await?;old_client.cancel().await?;owner.cancel().await?;
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

#[tokio::test]
#[ignore = "native binaries and Node; actual host restart retains results/rules without native replay"]
async fn host_restart_binding_uses_saved_workspace_and_retains_result_inbox_and_pending_owner_rules()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let (old,child,run,old_path,old_client)=setup(&fixture,&owner).await?;
        pending_note(&fixture,&child,&run).await?;
        report_from_controlled_worker(&old_client,&fixture.directory,&child).await?;
        mutate(&owner,&run,"nesvo_add_run_constraint",json!({"key":"owner-rule-before-restart","text":"Retain all pending work. No native effects until a deliberate owner decision."})).await?;
        let before=view(&owner,&run).await?;
        let pending=data(call(&old_client,"nesvo_read_inbox",json!({"runId":run})).await?)?;
        old_client.cancel().await?;owner.cancel().await?;
        fixture.restart(false).await?;
        assert!(!old_path.exists(),"Old scoped capability must not survive host shutdown");
        let owner=client(&fixture.pairing()).await?;
        let after_restart=view(&owner,&run).await?;
        assert_eq!(after_restart["tasks"],before["tasks"]);
        assert_eq!(after_restart["run"]["constraints"],before["run"]["constraints"]);
        let (new,path,new_client)=replacement(&fixture,&owner,None).await?;
        let request=args(&run,&old,&new,after_restart["run"]["revision"].clone());
        let bound=data(call(&owner,"nesvo_rebind_run_coordinator",request).await?)?;
        assert_eq!(bound["data"]["run"]["coordinatorBinding"]["source"],"recoveryRecord");
        assert_eq!(bound["data"]["tasks"],before["tasks"]);
        let inbox=data(call(&new_client,"nesvo_read_inbox",json!({"runId":run})).await?)?;
        assert_eq!(inbox["data"]["messages"],pending["data"]["messages"]);
        let context=inbox::scoped_cli(&path,&["run","recover","--json"]).await?;
        assert_eq!(context["data"]["page"]["currentConstraints"]["pending"],true);
        assert_eq!(context["data"]["page"]["context"]["nativeEffectsRestored"],false);
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        let sessions=sessions["data"]["sessions"].as_array().context("no restored worker process")?;
        assert_eq!(sessions.len(),1);assert_eq!(sessions[0]["id"],new);
        let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":new,"maxBytes":8192})).await?)?;
        assert!(!output["data"]["page"]["data"].as_str().context("new process screen")?.contains("FIXTURE_RESPONSE"));
        schema(vec![bound,inbox,context]).await?;
        new_client.cancel().await?;owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
#[ignore = "native binaries and Node; coordinator generation fences actual owner paste before Enter"]
async fn coordinator_replacement_fences_partial_owner_input_without_clearing_or_resubmitting_draft()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        std::fs::write(fixture.directory.join(".fixture-editor-redraw"),"")?;
        std::fs::write(fixture.directory.join(".fixture-slow-redraw"),"")?;
        let owner=client(&fixture.pairing()).await?;
        let (old,child,run,_,old_client)=setup(&fixture,&owner).await?;
        let (new,_,new_client)=replacement(&fixture,&owner,None).await?;
        let sender=call(&owner,"nesvo_send_prompt",json!({"key":"owner-paste-before-rebind","sessionId":child,"prompt":"MUST_REMAIN_UNSUBMITTED"}));
        let recover=async {
            observed_output(&owner,&child,"PASTE_PENDING_REDRAW").await?;
            stop(&owner,&old).await?;
            let request=args(&run,&old,&new,view(&owner,&run).await?["run"]["revision"].clone());
            data(call(&owner,"nesvo_rebind_run_coordinator",request).await?)?;
            Ok::<_,anyhow::Error>(())
        };
        let (sent,recovered)=tokio::join!(sender,recover);recovered?;
        let sent=sent?.structured_content.context("original fenced send receipt")?;
        let receipt=sent["data"]["receipt"]["id"].as_str().or_else(||sent["error"]["receipt"]["id"].as_str()).context("original input ID")?;
        let observed=timeout(Duration::from_secs(8),async {
            loop {
                let state=data(call(&owner,"nesvo_get_operation",json!({"id":receipt})).await?)?;
                if state["data"]["receipt"]["phase"]=="unknown" { return Ok::<_,anyhow::Error>(state); }
                ensure!(state["data"]["receipt"]["phase"]!="settled","Old input was unexpectedly submitted");
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await??;
        assert_eq!(observed["data"]["receipt"]["result"]["code"],"coordinator_changed");
        assert_eq!(observed["data"]["receipt"]["result"]["effectStarted"],true);
        let replay=call(&owner,"nesvo_send_prompt",json!({"key":"owner-paste-before-rebind","sessionId":child,"prompt":"MUST_REMAIN_UNSUBMITTED"})).await?.structured_content.context("retained unknown intent")?;
        assert_eq!(replay["error"]["receipt"]["id"],receipt);
        let fresh=call(&owner,"nesvo_send_prompt",json!({"key":"new-key-cannot-erase-draft","sessionId":child,"prompt":"MUST_NOT_SUBMIT_OLD_DRAFT"})).await?.structured_content.context("dirty draft fence")?;
        assert_eq!(fresh["error"]["receipt"]["result"]["code"],"unsafe_draft");
        let screen=data(call(&owner,"nesvo_read_session",json!({"sessionId":child,"maxBytes":8192})).await?)?;
        assert!(!screen["data"]["page"]["data"].as_str().context("old worker output")?.contains("FIXTURE_RESPONSE"));
        let context=data(call(&new_client,"nesvo_read_run_context",json!({"runId":run})).await?)?;
        assert!(context["data"]["parts"].as_array().context("uncertain operation context")?.iter().any(|p|p["kind"]=="nativeOperation"&&p["data"]["receiptId"]==receipt&&p["data"]["phase"]=="unknown"));
        schema(vec![observed,context]).await?;
        new_client.cancel().await?;old_client.cancel().await?;owner.cancel().await?;
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
