use super::*;

async fn scoped_cli(context: &Path, args: &[&str]) -> Result<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .env("NESVO_AGENT_CONTEXT", context)
        .args(args)
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(15), command.output()).await??;
    ensure!(
        output.status.success(),
        "Scoped CLI failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[tokio::test]
#[ignore = "requires native binaries and Node; addressed inbox fixture without model calls"]
async fn retains_results_while_coordinator_works_and_reconnects() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        timeout(Duration::from_secs(5),async {
            loop {
                let report=Command::new(env!("CARGO_BIN_EXE_nesvo")).arg("--pairing").arg(fixture.pairing()).args(["doctor","--json"]).output().await?;
                let report:Value=serde_json::from_slice(&report.stdout)?;
                if report["providerVersions"].as_array().is_some_and(|versions|versions.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")) {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let owner=client(&fixture.pairing()).await?;
        let root=data(call(&owner,"nesvo_create_session",json!({"key":"inbox-root","spec":{"name":"Inbox coordinator","role":"coordinator","program":"claude","harness":true}})).await?)?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("inbox root")?;
        session_ready(&owner,root_id).await?;
        let root_context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&root_context,root_id).await?;
        let child=data(call(&coordinator,"nesvo_create_session",json!({"key":"inbox-worker","spec":{"name":"Inbox worker","program":"claude"}})).await?)?;
        let child_id=child["data"]["receipt"]["sessionId"].as_str().context("inbox child")?;
        session_ready(&owner,child_id).await?;
        let child_context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{child_id}.txt")))?);
        let worker=scoped_client(&child_context,child_id).await?;
        let run=data(call(&coordinator,"nesvo_create_run",json!({"key":"inbox-run","spec":{"title":"Inbox run","goal":"Controlled addressed delivery"}})).await?)?;
        let run_id=run["data"]["run"]["id"].as_str().context("inbox run")?;
        let plan=data(call(&coordinator,"nesvo_set_run_plan",json!({"key":"inbox-plan","runId":run_id,"expectedRevision":1,"tasks":[{"key":"worker","title":"Worker","instruction":"Controlled result transport only"}]})).await?)?;
        let task_id=plan["data"]["tasks"][0]["id"].clone();
        data(call(&coordinator,"nesvo_activate_run",json!({"key":"inbox-activate","runId":run_id,"expectedRevision":2})).await?)?;
        let assigned=data(call(&coordinator,"nesvo_assign_task",json!({"key":"inbox-assign","runId":run_id,"taskId":task_id,"sessionId":child_id,"expectedRevision":3})).await?)?;
        let attempt=assigned["data"]["tasks"][0]["currentAttempt"]["id"].as_str().context("inbox attempt")?;
        let terminal_before=data(call(&owner,"nesvo_read_session",json!({"sessionId":child_id,"maxBytes":8192})).await?)?;
        let body="Literal note łódź $(never-execute)\nline two";
        let sent=data(call(&coordinator,"nesvo_send_message",json!({"key":"context-message","runId":run_id,"attemptId":attempt,"correlationId":"context-1","body":body})).await?)?;
        let replay=scoped_cli(&root_context,&["run","inbox","send",run_id,"--attempt",attempt,"--key","context-message","--correlation","context-1","--message",body,"--json"]).await?;
        assert_eq!(replay["data"],sent["data"],"CLI/MCP share message deduplication");
        let pending=data(call(&worker,"nesvo_read_inbox",json!({"runId":run_id})).await?)?;
        assert_eq!(pending["data"]["messages"][0]["body"],body);
        let terminal_after=data(call(&owner,"nesvo_read_session",json!({"sessionId":child_id,"maxBytes":8192})).await?)?;
        assert_eq!(terminal_before["data"]["page"],terminal_after["data"]["page"],"Inbox delivery never types a prompt");
        let message_id=sent["data"]["message"]["id"].as_str().context("context message")?;
        let ack=scoped_cli(&child_context,&["run","inbox","ack",run_id,message_id,"--json"]).await?;
        let repeat=data(call(&worker,"nesvo_ack_messages",json!({"runId":run_id,"ids":[message_id]})).await?)?;
        assert_eq!(ack["data"]["acknowledged"],repeat["data"]["acknowledged"]);
        let question=data(call(&worker,"nesvo_send_message",json!({"key":"question-1","runId":run_id,"correlationId":attempt,"kind":"question","body":"Controlled question, not a permission grant"})).await?)?;
        let holding=data(call(&owner,"nesvo_send_prompt",json!({"key":"root-hold","sessionId":root_id,"prompt":"hold-response"})).await?)?;
        let started=data(call(&owner,"nesvo_wait_prompt",json!({"id":holding["data"]["receipt"]["id"],"sessionId":root_id,"until":"started","timeoutMs":5000})).await?)?;
        assert_eq!(started["data"]["wait"]["reached"],true);
        report_from_controlled_worker(&coordinator,&fixture.directory,child_id).await?;
        let working=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;
        assert_eq!(working["data"]["session"]["status"]["state"],"working");
        let before_disconnect=data(call(&coordinator,"nesvo_read_inbox",json!({"runId":run_id})).await?)?;
        assert_eq!(before_disconnect["data"]["pendingCount"],2);
        assert_eq!(before_disconnect["data"]["messages"][1]["kind"],"result");
        assert_eq!(before_disconnect["data"]["messages"][1]["payload"]["attemptId"],attempt);
        coordinator.cancel().await?;
        let reconnected=scoped_client(&root_context,root_id).await?;
        let after_disconnect=data(call(&reconnected,"nesvo_read_inbox",json!({"runId":run_id})).await?)?;
        assert_eq!(after_disconnect["data"]["messages"],before_disconnect["data"]["messages"],"Consumer restart re-delivers unacknowledged IDs");
        data(call(&reconnected,"nesvo_ack_messages",json!({"runId":run_id,"ids":[question["data"]["message"]["id"]]})).await?)?;
        let task=data(call(&reconnected,"nesvo_get_run",json!({"runId":run_id})).await?)?;
        assert_eq!(task["data"]["tasks"][0]["state"],"reported");assert_eq!(task["data"]["tasks"][0]["taskResult"],Value::Null);
        data(call(&owner,"nesvo_interrupt_session",json!({"key":"release-root-hold","sessionId":root_id})).await?)?;
        session_ready(&owner,root_id).await?;
        data(call(&owner,"nesvo_stop_session",json!({"key":"stop-inbox-root","sessionId":root_id})).await?)?;
        timeout(Duration::from_secs(5),async {
            loop {
                let observed=data(call(&owner,"nesvo_get_session",json!({"sessionId":root_id})).await?)?;
                if observed["data"]["session"]["running"]==false {return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let revoked=call(&reconnected,"nesvo_read_inbox",json!({"runId":run_id})).await?;assert_eq!(revoked.is_error,Some(true));
        let retained=data(call(&owner,"nesvo_read_inbox",json!({"runId":run_id})).await?)?;
        assert_eq!(retained["data"]["pendingCount"],1);assert_eq!(retained["data"]["messages"][0]["kind"],"result");
        let live=data(call(&owner,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
        assert_eq!(live["data"]["session"]["running"],true);
        worker.cancel().await?;reconnected.cancel().await?;owner.cancel().await?;
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
