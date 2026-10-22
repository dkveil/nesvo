use super::*;

fn limits(slots: u16, workers: u16, shell: u16) -> Value {
    json!({"maxSessions":slots,"maxWorkers":workers,"providers":{"shell":shell,"claude":16,"codex":16,"gemini":16}})
}
pub(super) async fn owner_cli(fixture: &Fixture, args: &[&str]) -> Result<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command.arg("--pairing").arg(fixture.pairing()).args(args);
    waits::cli(command)
        .await
        .with_context(|| format!("Owner CLI {}", args.join(" ")))
}
#[tokio::test]
#[ignore = "requires built native binaries and Node; process budget fixture without model calls"]
async fn owner_budgets_bound_native_and_scoped_creation_without_terminating_work() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let initial=owner_cli(&fixture,&["budget","get","--json"]).await?;
        assert_eq!(initial["data"]["budget"]["revision"],1);
        assert_eq!(initial["data"]["budget"]["limits"]["maxSessions"],8);
        let large=limits(16,16,16);
        let saved=data(call(&owner,"nesvo_set_host_budget",json!({"key":"large-budget","expectedRevision":1,"limits":large})).await?)?;
        let path=fixture.directory.join("owner budget łódź.json");std::fs::write(&path,serde_json::to_vec(&large)?)?;
        let replay=owner_cli(&fixture,&["budget","set","--key","large-budget","--revision","1","--file",path.to_str().context("budget path")?,"--json"]).await?;
        assert_eq!(replay["data"],saved["data"]);
        let root=waits::operation(&owner,"nesvo_create_session",json!({"key":"budget-root","spec":{"name":"Budget coordinator","program":"claude","role":"coordinator"}})).await?;
        let root_id=root["data"]["receipt"]["sessionId"].as_str().context("budget root")?;
        session_ready(&owner,root_id).await?;
        let root_context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{root_id}.txt")))?);
        let coordinator=scoped_client(&root_context,root_id).await?;
        let denied=call(&coordinator,"nesvo_get_host_budget",json!({})).await?;
        assert_eq!(denied.structured_content.context("coordinator budget scope")?["error"]["code"],"forbidden");
        let child=waits::operation(&owner,"nesvo_create_session",json!({"key":"budget-worker","spec":{"name":"Budget worker","program":"claude"}})).await?;
        let worker_id=child["data"]["receipt"]["sessionId"].as_str().context("budget worker")?;
        session_ready(&owner,worker_id).await?;
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{worker_id}.txt")))?);
        let worker=scoped_client(&context,worker_id).await?;
        let denied=call(&worker,"nesvo_set_host_budget",json!({"key":"forged-budget","expectedRevision":2,"limits":large})).await?;
        assert_eq!(denied.structured_content.context("worker budget scope")?["error"]["code"],"forbidden");
        let mut shells=Vec::new();
        for index in 0..8 {
            let shell=waits::operation(&owner,"nesvo_create_session",json!({"key":format!("budget-shell-{index}"),"spec":{"name":format!("Shell {index}"),"program":"shell"}})).await?;
            shells.push(shell["data"]["receipt"]["sessionId"].as_str().context("budget shell")?.to_owned());
        }
        let before=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(before["data"]["sessions"].as_array().context("ten retained slots")?.len(),10,"Owner budget permits native processes beyond the former constant eight");
        data(call(&owner,"nesvo_set_host_budget",json!({"key":"one-worker","expectedRevision":2,"limits":limits(16,1,16)})).await?)?;
        let rejected=call(&coordinator,"nesvo_create_session",json!({"key":"worker-limit","spec":{"name":"Must not start","program":"shell"}})).await?;
        let refusal=rejected.structured_content.context("worker admission refusal")?;
        assert_eq!(refusal["error"]["code"],"operation_failed");assert_eq!(refusal["error"]["receipt"]["result"]["code"],"budget_exhausted");assert_eq!(refusal["error"]["receipt"]["result"]["effectStarted"],false);
        data(call(&owner,"nesvo_set_host_budget",json!({"key":"shell-limit","expectedRevision":3,"limits":limits(16,16,8)})).await?)?;
        let rejected=call(&coordinator,"nesvo_create_session",json!({"key":"provider-limit","spec":{"name":"Must not start either","program":"shell"}})).await?;
        assert_eq!(rejected.structured_content.context("provider admission refusal")?["error"]["receipt"]["result"]["code"],"budget_exhausted");
        let current=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(current["data"]["sessions"].as_array().context("preserved native work")?.len(),10);
        assert!(current["data"]["sessions"].as_array().unwrap().iter().all(|s|s["running"]==true&&s["controllerId"].is_null()),"Policy changes do not kill work or acquire control");
        waits::operation(&owner,"nesvo_stop_session",json!({"key":"budget-stop","sessionId":shells[0]})).await?;
        waits::session(&owner,&shells[0],waits::Session::Stopped).await?;
        waits::operation(&coordinator,"nesvo_create_session",json!({"key":"released-provider-slot","spec":{"name":"Allowed fresh child","program":"shell"}})).await?;
        data(call(&owner,"nesvo_set_host_budget",json!({"key":"retention-limit","expectedRevision":4,"limits":limits(1,16,16)})).await?)?;
        let historical=owner_cli(&fixture,&["run","mutation","--key","large-budget","--json"]).await?;
        assert_eq!(historical["data"],saved["data"]);
        let replay=owner_cli(&fixture,&["budget","set","--key","large-budget","--revision","1","--file",path.to_str().context("budget path")?,"--json"]).await?;
        assert_eq!(replay["data"],saved["data"]);
        let current=owner_cli(&fixture,&["budget","get","--json"]).await?;
        assert_eq!(current["data"]["budget"]["revision"],5);assert_eq!(current["data"]["budget"]["limits"]["maxSessions"],1);
        let rejected=call(&owner,"nesvo_create_session",json!({"key":"retained-slots","spec":{"name":"Retention refusal","program":"shell"}})).await?;
        assert_eq!(rejected.structured_content.context("retained slots refusal")?["error"]["receipt"]["result"]["code"],"budget_exhausted");
        let after=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(after["data"]["sessions"].as_array().context("eleven retained slots")?.len(),11);
        assert!(serde_json::to_vec(&after["data"])?.len()<nesvo_wire::MAX_PLAINTEXT);
        worker.cancel().await?;coordinator.cancel().await?;owner.cancel().await?;
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
