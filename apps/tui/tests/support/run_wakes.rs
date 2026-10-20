//! Official SDK -> stdio MCP -> real host/PTY, with controlled non-model programs.
use super::*;

async fn view(client: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    Ok(data(call(client, "nesvo_get_run", json!({"runId":run})).await?)?["data"].clone())
}
async fn mutation(
    client: &RunningService<RoleClient, ()>,
    run: &str,
    tool: &'static str,
    mut args: Value,
) -> Result<Value> {
    timeout(Duration::from_secs(8), async {
        loop {
            args["runId"] = run.into();
            args["expectedRevision"] = view(client, run).await?["run"]["revision"].clone();
            let reply = call(client, tool, args.clone()).await?;
            if reply.is_error != Some(true) {
                return Ok::<_, anyhow::Error>(data(reply)?["data"].clone());
            }
            let refusal = reply.structured_content.context("wake mutation result")?;
            ensure!(
                refusal["error"]["code"] == "revision_conflict",
                "Wake mutation failed: {refusal}"
            );
        }
    })
    .await
    .with_context(|| format!("Native wake mutation deadline: {tool}"))?
}
async fn provider(fixture: &Fixture) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
            if doctor["providerVersions"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["program"] == "claude" && row["status"] == "ready")
            }) {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("Native wake provider version probe deadline")?
}
async fn wake_view(client: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    Ok(data(call(client, "nesvo_get_run_wakes", json!({"runId":run})).await?)?["data"].clone())
}
async fn waves(fixture: &Fixture, id: &str, count: usize) -> Result<Vec<Value>> {
    timeout(Duration::from_secs(12), async {
        loop {
            let path = fixture
                .directory
                .join("callers")
                .join(format!("{id}.wake-inputs.jsonl"));
            if let Ok(text) = std::fs::read_to_string(path) {
                let parsed = text
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(serde_json::from_str::<Value>)
                    .collect::<std::result::Result<Vec<_>, _>>();
                if let Ok(values) = parsed
                    && values.len() >= count
                {
                    return Ok::<_, anyhow::Error>(values);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("Controlled native wake input")?
}
async fn message(
    client: &RunningService<RoleClient, ()>,
    run: &str,
    key: &str,
    kind: &str,
) -> Result<()> {
    data(call(client,"nesvo_send_message",json!({"key":key,"runId":run,"correlationId":"untrusted $(not code)","kind":kind,"body":"PRIVATE_BODY_MUST_NOT_BECOME_NATIVE_WAKE_INPUT"})).await?)?;
    Ok(())
}
async fn schema(envelopes: Vec<Value>) -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .arg(root.join("tests/fixtures/validate-harness-json.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut process = command.spawn()?;
    process
        .stdin
        .take()
        .context("schema input")?
        .write_all(&serde_json::to_vec(&envelopes)?)
        .await?;
    let output = timeout(Duration::from_secs(8), process.wait_with_output()).await??;
    ensure!(
        output.status.success(),
        "Real wake contract validation: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
async fn simple_run(
    fixture: &Fixture,
    owner: &RunningService<RoleClient, ()>,
) -> Result<(String, String)> {
    provider(fixture).await?;
    let created = data(call(owner, "nesvo_create_session", json!({
        "key":"simple-wake-coordinator",
        "spec":{"name":"Wake fence coordinator","program":"claude","role":"coordinator","harness":true}
    })).await?)?;
    let id = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("wake coordinator")?
        .to_owned();
    session_ready(owner, &id).await?;
    let created = data(call(owner, "nesvo_create_run", json!({
        "key":"simple-wake-run",
        "spec":{"title":"Wake fences","goal":"Preserve human and budget authority","coordinatorSessionId":id}
    })).await?)?;
    let run = created["data"]["run"]["id"]
        .as_str()
        .context("wake run")?
        .to_owned();
    mutation(owner, &run, "nesvo_set_run_plan", json!({
        "key":"simple-wake-plan","tasks":[{"key":"work","title":"Work","instruction":"Never imply success"}]
    })).await?;
    mutation(
        owner,
        &run,
        "nesvo_activate_run",
        json!({"key":"simple-wake-active"}),
    )
    .await?;
    Ok((id, run))
}
async fn paused(client: &RunningService<RoleClient, ()>, run: &str) -> Result<Value> {
    timeout(Duration::from_secs(8), async {
        loop {
            let current = wake_view(client, run).await?;
            if current["wakePolicy"]["phase"] == "paused" {
                return Ok::<_, anyhow::Error>(current);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .context("Wake policy did not pause")?
}

#[tokio::test]
#[ignore = "requires native binaries and Node; released human control still fences automatic wakes"]
async fn quick_human_takeover_pauses_wakes_and_only_explicit_enable_can_deliver_unclaimed_backlog()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let (id, run) = simple_run(&fixture, &owner).await?;
        mutation(
            &owner,
            &run,
            "nesvo_enable_run_wakes",
            json!({"key":"human-wake-enable"}),
        )
        .await?;
        let mut human = human_control(&fixture.pairing(), &id)
            .await
            .context("Native wake human takeover readiness")?;
        drop(human.stdin.take());
        ensure!(
            timeout(Duration::from_secs(8), human.wait())
                .await
                .context("Native wake human release helper deadline")??
                .success(),
            "Human release helper"
        );
        let stopped = paused(&owner, &run).await?;
        assert_eq!(stopped["wakePolicy"]["reason"], "control_busy");
        message(&owner, &run, "human-backlog", "question").await?;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let path = fixture
            .directory
            .join("callers")
            .join(format!("{id}.wake-inputs.jsonl"));
        assert!(
            !path.exists(),
            "Releasing a human lease does not rearm automatic input"
        );
        let restarted = mutation(
            &owner,
            &run,
            "nesvo_enable_run_wakes",
            json!({"key":"explicit-fresh-wake-generation"}),
        )
        .await?;
        assert!(
            restarted["wakePolicy"]["generation"].as_u64()
                > stopped["wakePolicy"]["generation"].as_u64()
        );
        let received = waves(&fixture, &id, 1).await?;
        assert_eq!(received.len(), 1);
        assert_eq!(
            received[0]["batch"]["data"]["wakeBatch"]["notices"]
                .as_array()
                .context("wake references")?
                .len(),
            1
        );
        let context = PathBuf::from(std::fs::read_to_string(
            fixture.directory.join("callers").join(format!("{id}.txt")),
        )?);
        let coordinator = scoped_client(&context, &id).await?;
        let batch = &received[0]["batch"]["data"]["wakeBatch"];
        data(
            call(
                &coordinator,
                "nesvo_get_run_wake_batch",
                json!({"runId":run,"batchId":batch["id"]}),
            )
            .await?,
        )?;
        let denied = call(
            &coordinator,
            "nesvo_get_operation",
            json!({"id":batch["receiptId"]}),
        )
        .await?
        .structured_content
        .context("owner receipt is private")?;
        assert_eq!(denied["error"]["code"], "operation_not_found");
        let inbox = data(call(&owner, "nesvo_read_inbox", json!({"runId":run})).await?)?;
        assert_eq!(inbox["data"]["pendingCount"], 1);
        mutation(
            &owner,
            &run,
            "nesvo_disable_run_wakes",
            json!({"key":"human-wake-disable"}),
        )
        .await?;
        coordinator.cancel().await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
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
#[ignore = "requires native binaries and Node; elapsed budget is checked again between paste and Enter"]
async fn elapsed_budget_stops_enter_after_wake_paste_and_relaxation_never_replays_retained_draft()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        std::fs::write(fixture.directory.join(".fixture-editor-redraw"), "")?;
        let owner = client(&fixture.pairing()).await?;
        let (id, run) = simple_run(&fixture, &owner).await?;
        mutation(&owner, &run, "nesvo_enable_run_wakes", json!({"key":"budget-wake-enable"})).await?;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        message(&owner, &run, "budget-delta", "question").await?;
        observed_output(&owner, &id, "PASTE_PENDING_REDRAW").await?;
        mutation(&owner, &run, "nesvo_set_run_budget", json!({
            "key":"expire-after-paste","limits":{"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":1000}
        })).await?;
        let stopped = paused(&owner, &run).await?;
        assert_eq!(stopped["wakePolicy"]["reason"], "time_budget_exhausted");
        let notices = stopped["notices"].as_array().context("wake notices")?;
        let batch_id = notices[0]["batchId"].as_str().context("claimed wake batch")?;
        let batch = data(call(&owner, "nesvo_get_run_wake_batch", json!({"runId":run,"batchId":batch_id})).await?)?;
        let receipt_id = batch["data"]["wakeBatch"]["receiptId"].as_str().context("wake native receipt")?;
        let receipt = data(call(&owner, "nesvo_get_operation", json!({"id":receipt_id})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["phase"], "unknown");
        assert_eq!(receipt["data"]["receipt"]["result"]["effectStarted"], true);
        assert_eq!(receipt["data"]["receipt"]["result"]["code"], "time_budget_exhausted");
        let path = fixture.directory.join("callers").join(format!("{id}.wake-inputs.jsonl"));
        assert!(!path.exists(), "Pasted metadata was not submitted with Enter");
        mutation(&owner, &run, "nesvo_set_run_budget", json!({
            "key":"relax-elapsed-only","limits":{"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":null}
        })).await?;
        message(&owner, &run, "new-after-expiry", "question").await?;
        mutation(&owner, &run, "nesvo_enable_run_wakes", json!({"key":"fresh-enable-keeps-dirty-draft"})).await?;
        let after = paused(&owner, &run).await?;
        assert_eq!(after["wakePolicy"]["reason"], "unsafe_draft");
        assert!(!path.exists(), "Budget relaxation and a fresh key cannot rearm partial input");
        let old = data(call(&owner, "nesvo_get_run_wake_batch", json!({"runId":run,"batchId":batch_id})).await?)?;
        assert_eq!(old["data"]["wakeBatch"]["receiptId"], receipt_id);
        assert_eq!(old["data"]["wakeBatch"]["phase"], "unknown");
        assert_eq!(after["pendingCount"], 1, "Only the new, unclaimed delta remains available");
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
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
#[ignore = "requires native binaries and Node; delta-only wakes with scoped metadata, real PTY and no model calls"]
async fn coordinator_wakes_only_for_new_deltas_after_idle_and_never_acks_or_validates() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async{
        provider(&fixture).await?;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"wake-root","spec":{"name":"Wake coordinator","program":"claude","role":"coordinator","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("wake root")?;session_ready(&owner,root_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&context,root_id).await?;
        let child=data(call(&coordinator,"nesvo_create_session",json!({"key":"wake-worker","spec":{"name":"Reporter","program":"claude","harness":true}})).await?)?;
        let child_id=child["data"]["receipt"]["sessionId"].as_str().context("wake worker")?;session_ready(&owner,child_id).await?;
        let created=data(call(&coordinator,"nesvo_create_run",json!({"key":"wake-run","spec":{"title":"Delta wake fixture","goal":"No silent ACK or fabricated validation"}})).await?)?;
        let run=created["data"]["run"]["id"].as_str().context("wake run")?;
        let plan=mutation(&coordinator,run,"nesvo_set_run_plan",json!({"key":"wake-plan","tasks":[{"key":"implement","title":"Implement","instruction":"report-task"},{"key":"review","title":"Review","instruction":"Must wait","dependencies":["implement"]}]})).await?;
        mutation(&coordinator,run,"nesvo_activate_run",json!({"key":"wake-active"})).await?;
        mutation(&coordinator,run,"nesvo_assign_task",json!({"key":"wake-assign","taskId":plan["tasks"][0]["id"],"sessionId":child_id})).await?;
        data(call(&owner,"nesvo_send_prompt",json!({"sessionId":root_id,"key":"wake-hold","prompt":"held-natural-response"})).await?)?;
        observed_output(&owner,root_id,"FIXTURE_HOLDING_NATURAL_RESPONSE").await?;
        let enabled=mutation(&coordinator,run,"nesvo_enable_run_wakes",json!({"key":"wake-enable"})).await?;
        message(&coordinator,run,"delta-question","question").await?;message(&coordinator,run,"delta-error","error").await?;
        data(call(&coordinator,"nesvo_send_prompt",json!({"sessionId":child_id,"key":"wake-worker-report","prompt":"report-task"})).await?)?;
        timeout(Duration::from_secs(8),async{loop{if view(&coordinator,run).await?["tasks"][0]["state"]=="reported" {return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        let pending=wake_view(&coordinator,run).await?;assert_eq!(pending["pendingCount"],3);
        assert!(!fixture.directory.join("callers").join(format!("{root_id}.wake-inputs.jsonl")).exists(),"Working coordinator gets no input");
        // Recover immutable acceptance by its workflow key, not a guessed revision.
        let recovered=inbox::scoped_cli(&context,&["run","mutation","--key","wake-enable","--json"]).await?;assert_eq!(recovered["data"],enabled);
        let original_revision = (enabled["run"]["revision"].as_u64().context("enable revision")? - 1).to_string();
        let cli_replay = inbox::scoped_cli(&context, &["run","wake","enable",run,"--key","wake-enable","--revision",&original_revision,"--json"]).await?;
        assert_eq!(cli_replay["data"], enabled, "CLI/MCP replay shares one accepted policy mutation");
        std::fs::write(fixture.directory.join("callers").join(format!("{root_id}.release")),"")?;
        let received=match waves(&fixture,root_id,1).await {Ok(values)=>values,Err(error)=>{
            let policy=wake_view(&coordinator,run).await?;
            let state=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;
            let output=data(call(&owner,"nesvo_read_session",json!({"sessionId":root_id,"maxBytes":8192})).await?)?;
            anyhow::bail!("{error:?}; policy={policy}; root={}; output={}",state["data"]["session"]["status"],output["data"]["page"]["data"]);
        }};assert_eq!(received.len(),1);
        assert_eq!(received[0]["batch"]["data"]["wakeBatch"]["notices"].as_array().unwrap().len(),3);
        assert_eq!(received[0]["inbox"]["data"]["pendingCount"],3);
        assert!(!received[0]["prompt"].as_str().unwrap().contains("PRIVATE_BODY"));
        let native_id=received[0]["batch"]["data"]["wakeBatch"]["receiptId"].as_str().context("wake receipt")?;
        timeout(Duration::from_secs(8),async{loop{let receipt=data(call(&coordinator,"nesvo_get_operation",json!({"id":native_id})).await?)?;if receipt["data"]["receipt"]["phase"]=="settled" {return Ok::<_,anyhow::Error>(());}tokio::time::sleep(Duration::from_millis(50)).await;}}).await??;
        for _ in 0..4 {wake_view(&coordinator,run).await?;}
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(waves(&fixture,root_id,1).await?.len(),1,"No unchanged-state model heartbeat");
        message(&coordinator,run,"second-delta","question").await?;
        let received=waves(&fixture,root_id,2).await?;assert_eq!(received.len(),2);
        assert_ne!(received[0]["batch"]["data"]["wakeBatch"]["id"],received[1]["batch"]["data"]["wakeBatch"]["id"]);
        let run_view=view(&coordinator,run).await?;assert_eq!(run_view["tasks"][0]["state"],"reported");assert!(run_view["tasks"][0]["taskResult"].is_null());assert_eq!(run_view["tasks"][1]["state"],"planned");
        let mail=data(call(&coordinator,"nesvo_read_inbox",json!({"runId":run})).await?)?;assert_eq!(mail["data"]["pendingCount"],4);
        let current = data(call(&coordinator,"nesvo_get_run_wakes",json!({"runId":run})).await?)?;
        let cli_current = inbox::scoped_cli(&context, &["run","wake","get",run,"--json"]).await?;
        schema(vec![current, cli_current, recovered, cli_replay, received[0]["batch"].clone(), received[1]["batch"].clone(), mail]).await?;
        let root=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;assert!(root["data"]["session"]["controllerId"].is_null());
        let disabled = mutation(&coordinator,run,"nesvo_disable_run_wakes",json!({"key":"wake-disable"})).await?;
        let original_revision = (disabled["run"]["revision"].as_u64().context("disable revision")? - 1).to_string();
        let cli_replay = inbox::scoped_cli(&context, &["run","wake","disable",run,"--key","wake-disable","--revision",&original_revision,"--json"]).await?;
        assert_eq!(cli_replay["data"], disabled);
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
#[ignore = "requires native binaries and Node; canonical hook blocker and resolution feed durable wake references"]
async fn native_worker_question_and_resolution_share_the_canonical_wake_projection() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let (id, run) = simple_run(&fixture, &owner).await?;
        let child = data(call(&owner, "nesvo_create_session", json!({
            "key":"question-wake-worker","spec":{"name":"Question worker","program":"claude","harness":true}
        })).await?)?;
        let child_id = child["data"]["receipt"]["sessionId"].as_str().context("question worker")?;
        session_ready(&owner, child_id).await?;
        let task = view(&owner, &run).await?["tasks"][0]["id"].clone();
        let assigned = mutation(&owner, &run, "nesvo_assign_task", json!({
            "key":"question-wake-assignment","taskId":task,"sessionId":child_id
        })).await?;
        let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
        data(call(&owner, "nesvo_send_prompt", json!({"sessionId":id,"key":"question-wake-hold","prompt":"held-natural-response"})).await?)?;
        observed_output(&owner, &id, "FIXTURE_HOLDING_NATURAL_RESPONSE").await?;
        mutation(&owner, &run, "nesvo_enable_run_wakes", json!({"key":"question-wake-enable"})).await?;
        data(call(&owner, "nesvo_send_prompt", json!({"sessionId":child_id,"key":"question-wake-input","prompt":"question-task"})).await?)?;
        observed_output(&owner, child_id, "FIXTURE_AWAITING_DECISION").await?;
        let blocked = timeout(Duration::from_secs(8), async {
            loop {
                let current = wake_view(&owner, &run).await?;
                if current["notices"].as_array().context("wake notices")?.iter().any(|notice| {
                    notice["kind"] == "blocker" && notice["reference"]["attention"]["reason"] == "question"
                }) {
                    return Ok::<_, anyhow::Error>(current);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.context("Native hook did not publish canonical blocker notice")??;
        let notices = blocked["notices"].as_array().context("blocker notices")?;
        let blocker = notices.iter().find(|notice| notice["kind"] == "blocker").context("question blocker")?;
        assert_eq!(blocker["reference"]["attemptId"], attempt);
        assert_eq!(blocker["reference"]["sessionId"], child_id);
        assert!(notices.iter().any(|notice| notice["kind"] == "decision"));
        let session = data(call(&owner, "nesvo_get_session", json!({"sessionId":child_id})).await?)?;
        assert_eq!(session["data"]["session"]["currentAttention"]["reason"], "question");
        let decisions = data(call(&owner, "nesvo_list_decisions", json!({"runId":run})).await?)?;
        let decision = &decisions["data"]["decisions"][0];
        data(call(&owner, "nesvo_answer_decision", json!({
            "key":"question-wake-owner-answer","runId":run,"decisionId":decision["id"],
            "expectedRevision":decision["revision"],"answer":"Finish the controlled transport test; no native permission is implied"
        })).await?)?;
        timeout(Duration::from_secs(8), async {
            loop {
                let current = wake_view(&owner, &run).await?;
                let notices = current["notices"].as_array().context("resolved notices")?;
                if notices.iter().any(|notice| notice["kind"] == "result") && notices.iter().any(|notice| {
                    notice["kind"] == "blocker" && notice["reference"]["attention"]["priority"] == 0
                }) { return Ok::<_, anyhow::Error>(()); }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.context("Native blocker resolution and result did not publish")??;
        assert!(!fixture.directory.join("callers").join(format!("{id}.wake-inputs.jsonl")).exists());
        let before = data(call(&owner, "nesvo_get_run_wakes", json!({"runId":run})).await?)?;
        std::fs::write(fixture.directory.join("callers").join(format!("{id}.release")), "")?;
        let received = waves(&fixture, &id, 1).await?;
        assert_eq!(received.len(), 1);
        let notices = received[0]["batch"]["data"]["wakeBatch"]["notices"].as_array().context("native batch")?;
        for kind in ["decision", "blocker", "result"] {
            assert!(notices.iter().any(|notice| notice["kind"] == kind));
        }
        schema(vec![before, received[0]["batch"].clone(), received[0]["inbox"].clone()]).await?;
        let current = view(&owner, &run).await?;
        assert_eq!(current["tasks"][0]["state"], "reported");
        assert!(current["tasks"][0]["taskResult"].is_null());
        let mail = data(call(&owner, "nesvo_read_inbox", json!({"runId":run})).await?)?;
        assert_eq!(mail["data"]["pendingCount"], 2, "Wake and decision answer never ACK coordinator mail");
        mutation(&owner, &run, "nesvo_disable_run_wakes", json!({"key":"question-wake-disable"})).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
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
