use super::*;
use run_checkpoints::{mutate, view};

type Client = RunningService<RoleClient, ()>;

fn profile() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../../../../tests/fixtures/native-recovery-profile.json"
    ))?)
}
async fn api(client: &Client, tool: &'static str, arguments: Value) -> Result<Value> {
    Ok(data(call(client, tool, arguments).await?)?["data"].clone())
}
async fn scoped(fixture: &Fixture, id: &str) -> Result<Client> {
    let path = PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?);
    scoped_client(&path, id).await
}
async fn coordinator(fixture: &Fixture, owner: &Client, key: &str) -> Result<(String, Client)> {
    let p = profile()?;
    let created = api(
        owner,
        "nesvo_create_session",
        json!({"key":key,"spec":{
            "name":key,"program":"claude","role":"coordinator","harness":true,
            "model":p["workerProfile"]["model"],"effort":p["workerProfile"]["effort"],
            "allowedNesvoTools":p["coordinatorTools"],"childAllowedNesvoTools":p["childTools"]
        }}),
    )
    .await?;
    let id = created["receipt"]["sessionId"]
        .as_str()
        .context("coordinator ID")?
        .to_owned();
    session_ready(owner, &id).await?;
    Ok((id.clone(), scoped(fixture, &id).await?))
}
async fn stopped(owner: &Client, id: &str) -> Result<()> {
    api(
        owner,
        "nesvo_stop_session",
        json!({"key":format!("stop-{id}"),"sessionId":id}),
    )
    .await?;
    waits::session(owner, id, waits::Session::Stopped).await?;
    Ok(())
}
async fn delivered(client: &Client, run: &str, task: &Value, key: &str) -> Result<Value> {
    mutate(
        client,
        run,
        "nesvo_deliver_task",
        json!({"key":key,"taskId":task}),
    )
    .await?;
    waits::until(async || {
        let history = api(
            client,
            "nesvo_get_task_attempts",
            json!({"runId":run,"taskId":task}),
        )
        .await?;
        let delivery = &history["attempts"][0]["delivery"];
        if delivery["phase"] == "sent" && delivery["native"]["phase"] == "settled" {
            return Ok(Some(history));
        }
        ensure!(
            !matches!(
                delivery["phase"].as_str(),
                Some("failed" | "unknown" | "paused" | "expired" | "canceled")
            ) && !matches!(
                delivery["native"]["phase"].as_str(),
                Some("failed" | "unknown" | "interrupted")
            ),
            "Unsettled profile delivery: {delivery}"
        );
        Ok(None)
    })
    .await
    .context("Profile task native settlement")
}
fn result(marker: &str) -> Value {
    json!({"outcome":"succeeded","summary":marker,"files":[],"artifacts":[],"checks":[],
        "limitations":["Metadata-only fixture; no code or tests were executed"]})
}
async fn validate(client: &Client, run: &str, attempt: &Value, marker: &str) -> Result<Value> {
    mutate(client,run,"nesvo_validate_task_result",json!({"key":format!("validate-{marker}"),"attemptId":attempt,
        "validation":{"passed":true,"summary":"Metadata marker reviewed","checks":[{
            "name":"metadata-marker","outcome":"passed","details":format!("Observed {marker}; no code/tests verified")
        }]}})).await
}

#[tokio::test]
#[ignore = "native binaries and Node; complete recovery policy/DAG preflight, no original models"]
async fn recovery_profile_retains_questions_and_results_then_launches_one_review_under_new_authority()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let p = profile()?;
        waits::provider(&fixture,"claude").await?;
        let owner=client(&fixture.pairing()).await?;
        let budget=api(&owner,"nesvo_get_host_budget",json!({})).await?;
        api(&owner,"nesvo_set_host_budget",json!({"key":"profile-host-budget","expectedRevision":budget["budget"]["revision"],"limits":p["hostLimits"]})).await?;
        let (first,old)=coordinator(&fixture,&owner,"profile-first").await?;
        let created=api(&owner,"nesvo_create_run",json!({"key":"profile-run","spec":{"title":"Native recovery profile","goal":"HOST_ONLY_RECOVERY_MARKER","coordinatorSessionId":first}})).await?;
        let run=created["run"]["id"].as_str().context("profile run ID")?;
        let planned=mutate(&owner,run,"nesvo_set_run_plan",json!({"key":"profile-plan","tasks":[
            {"key":"implement","title":"Implement","instruction":"METADATA_IMPLEMENTER"},
            {"key":"review","title":"Review","instruction":"METADATA_REVIEWER","dependencies":["implement"]}
        ]})).await?;
        let a=planned["tasks"][0]["id"].clone(); let b=planned["tasks"][1]["id"].clone();
        mutate(&owner,run,"nesvo_set_run_budget",json!({"key":"profile-run-budget","limits":p["runLimits"]})).await?;
        mutate(&owner,run,"nesvo_activate_run",json!({"key":"profile-active"})).await?;
        let launch=mutate(&old,run,"nesvo_launch_task",json!({"key":"profile-launch-a","taskId":a,"profile":p["workerProfile"]})).await?;
        let worker=launch["launch"]["sessionId"].as_str().context("implementer ID")?;
        session_ready(&owner,worker).await?;
        let delivered_a=delivered(&old,run,&a,"profile-deliver-a").await?;
        let attempt_a=delivered_a["attempts"][0]["id"].clone();
        let implementation=scoped(&fixture,worker).await?;
        let asked=api(&implementation,"nesvo_ask_decision",json!({"key":"profile-question","attemptId":attempt_a,"audience":"owner","question":p["ownerQuestion"],"timeoutMs":120000})).await?;
        stopped(&owner,&first).await?;
        let (second,new)=coordinator(&fixture,&owner,"profile-second").await?;
        let bound=mutate(&owner,run,"nesvo_rebind_run_coordinator",json!({"key":"profile-rebind","expectedCoordinatorSessionId":first,"coordinatorSessionId":second})).await?;
        assert_eq!(bound["nativeEffectsRestored"],false);assert_eq!(bound["workerAuthorityRestored"],false);
        let recovered=api(&new,"nesvo_recover_run_context",json!({"runId":run})).await?;
        assert!(serde_json::to_string(&recovered)?.contains("HOST_ONLY_RECOVERY_MARKER"));
        let decision=api(&owner,"nesvo_get_decision",json!({"runId":run,"decisionId":asked["decision"]["id"]})).await?;
        assert_eq!(decision["decision"]["state"],"pending");
        api(&owner,"nesvo_answer_decision",json!({"key":"profile-owner-answer","runId":run,"decisionId":asked["decision"]["id"],"expectedRevision":decision["decision"]["revision"],"answer":p["ownerAnswer"]})).await?;
        let refused=call(&new,"nesvo_read_session",json!({"sessionId":worker,"maxBytes":1024})).await?;
        assert_eq!(refused.is_error,Some(true),"Retained metadata must not adopt old native worker authority");
        api(&implementation,"nesvo_report_task_result",json!({"key":"profile-result-a","attemptId":attempt_a,"result":result("IMPLEMENTATION_PROBE_OK")})).await?;
        let inbox=api(&new,"nesvo_read_inbox",json!({"runId":run})).await?;
        assert!(inbox["messages"].as_array().context("retained result messages")?.iter().any(|m|m["kind"]=="result"&&m["payload"]["attemptId"]==attempt_a));
        validate(&new,run,&attempt_a,"IMPLEMENTATION_PROBE_OK").await?;
        stopped(&owner,worker).await?;

        let budget=api(&owner,"nesvo_get_host_budget",json!({})).await?;
        let retained_root_worker_and_replacement_slots=3;
        let mut lower=p["hostLimits"].clone();lower["maxSessions"]=retained_root_worker_and_replacement_slots.into();
        api(&owner,"nesvo_set_host_budget",json!({"key":"profile-retention-only","expectedRevision":budget["budget"]["revision"],"limits":lower})).await?;
        let rejected=call(&owner,"nesvo_create_session",json!({"key":"profile-preflight-refusal","spec":{"name":"Must not start","program":"claude"}})).await?;
        let failure=rejected.structured_content.context("retention refusal")?;
        assert_eq!(failure["error"]["receipt"]["result"]["code"],"budget_exhausted");
        assert_eq!(failure["error"]["receipt"]["result"]["effectStarted"],false);
        assert_eq!(view(&owner,run).await?["tasks"][1]["state"],"planned","A session preflight refusal must not consume the review task's sole attempt");
        let budget=api(&owner,"nesvo_get_host_budget",json!({})).await?;
        api(&owner,"nesvo_set_host_budget",json!({"key":"profile-four-retained","expectedRevision":budget["budget"]["revision"],"limits":p["hostLimits"]})).await?;
        let review=mutate(&new,run,"nesvo_launch_task",json!({"key":"profile-launch-b","taskId":b,"profile":p["workerProfile"]})).await?;
        let reviewer=review["launch"]["sessionId"].as_str().context("reviewer ID")?;
        session_ready(&owner,reviewer).await?;
        let attempt_b=view(&new,run).await?["tasks"][1]["currentAttempt"]["id"].clone();
        let message=api(&new,"nesvo_send_message",json!({"key":"profile-dependency-context","runId":run,"attemptId":attempt_b,"correlationId":"probe-dependency-review","body":format!("Accepted attempt {attempt_a}: IMPLEMENTATION_PROBE_OK")})).await?;
        delivered(&new,run,&b,"profile-deliver-b").await?;
        let review_client=scoped(&fixture,reviewer).await?;
        let inbox_b=api(&review_client,"nesvo_read_inbox",json!({"runId":run})).await?;
        assert_eq!(inbox_b["messages"][0]["id"],message["message"]["id"]);
        api(&review_client,"nesvo_ack_messages",json!({"runId":run,"ids":[message["message"]["id"]]})).await?;
        api(&review_client,"nesvo_report_task_result",json!({"key":"profile-result-b","attemptId":attempt_b,"result":result("REVIEW_PROBE_OK")})).await?;
        let final_view=validate(&new,run,&attempt_b,"REVIEW_PROBE_OK").await?;
        assert_eq!(final_view["run"]["state"],"succeeded");
        stopped(&new,reviewer).await?;
        let sessions=api(&owner,"nesvo_list_sessions",json!({})).await?;
        let rows=sessions["sessions"].as_array().context("profile sessions")?;
        assert_eq!(rows.len(),4);assert_eq!(rows.iter().filter(|s|s["running"]==true).count(),1);
        assert_eq!(rows.iter().find(|s|s["id"]==worker).context("retained implementer")?["parentSessionId"],first);
        assert_eq!(rows.iter().find(|s|s["id"]==reviewer).context("retained reviewer")?["parentSessionId"],second);
        for (sid,parent) in [(worker,&first),(reviewer,&second)] {
            let observed=api(&owner,"nesvo_get_session",json!({"sessionId":sid})).await?;
            assert_eq!(observed["session"]["harness"]["nativePermissions"]["allow"],p["childTools"]);
            assert_eq!(observed["session"]["harness"]["nativePermissions"]["originSessionId"],parent.as_str());
            let native:Value=serde_json::from_slice(&std::fs::read(fixture.directory.join("callers").join(format!("{sid}.native-permissions.json")))?)?;
            assert_eq!(native,json!(p["childTools"].as_array().context("child tools")?.iter().map(|t|format!("mcp__nesvo__{}",t.as_str().unwrap())).collect::<Vec<_>>()));
        }
        review_client.cancel().await?;implementation.cancel().await?;new.cancel().await?;old.cancel().await?;owner.cancel().await?;
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
