use super::*;

fn last_recovery(fixture: &Fixture, id: &str) -> Result<Value> {
    let text = std::fs::read_to_string(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.recovery.jsonl")),
    )?;
    Ok(serde_json::from_str(
        text.lines().last().context("recovery evidence")?,
    )?)
}
fn context(output: &Value) -> Result<Value> {
    assert_eq!(
        output["hookSpecificOutput"]["hookEventName"],
        "SessionStart"
    );
    assert!(output.get("decision").is_none());
    assert!(
        output["hookSpecificOutput"]
            .get("initialUserMessage")
            .is_none()
    );
    let text = output["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("native additional context")?;
    Ok(
        serde_json::Deserializer::from_str(text.split_once('\n').context("framed context")?.1)
            .into_iter::<Value>()
            .next()
            .context("framed JSON")??,
    )
}
async fn invoke(
    binary: &Path,
    pairing: &Path,
    input: &[u8],
    hold_eof: bool,
) -> Result<std::process::Output> {
    let provider_changed_temp_root = binary.parent().context("fixture executable folder")?;
    let mut command = Command::new(binary);
    command
        .arg("--pairing")
        .arg(pairing)
        .args(["run", "recover-hook"])
        .env_remove("NESVO_AGENT_CONTEXT")
        .env_remove("NESVO_SESSION_ID")
        .env("TMP", provider_changed_temp_root)
        .env("TMPDIR", provider_changed_temp_root)
        .env("TEMP", provider_changed_temp_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().context("recovery hook stdin")?;
    stdin.write_all(input).await?;
    let held = if hold_eof {
        Some(stdin)
    } else {
        drop(stdin);
        None
    };
    let result = child.wait_with_output().await?;
    drop(held);
    ensure!(
        result.status.success(),
        "Recovery must not block the original provider operation"
    );
    Ok(result)
}
fn unavailable(output: &std::process::Output) -> Result<()> {
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let text = value["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("unavailable warning")?;
    ensure!(
        text.starts_with("Nesvo current recovery context is unavailable"),
        "Missing bounded refusal: {value}"
    );
    assert!(value.get("decision").is_none());
    assert!(!text.contains("LAST_OWNER_RULE"));
    assert!(!output.stderr.is_empty());
    Ok(())
}
async fn oversize_provider_context_with_run_constraints(
    owner: &RunningService<RoleClient, ()>,
    run: &str,
) -> Result<()> {
    for index in 10..16 {
        run_checkpoints::mutate(
            owner,
            run,
            "nesvo_add_run_constraint",
            json!({"key":format!("hook-rule-{index}"),"text":"\"".repeat(1023)}),
        )
        .await?;
    }
    Ok(())
}
async fn report(owner: &RunningService<RoleClient, ()>, id: &str, outcome: &str) -> Result<Value> {
    waits::until(async || {
        let current = data(call(owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
        let harness = &current["data"]["session"]["harness"];
        if harness["recovery"]["status"]["outcome"] == outcome {
            assert_eq!(
                harness["loaded"],
                Value::Null,
                "Prepared context is not model consumption evidence"
            );
            return Ok(Some(harness.clone()));
        }
        ensure!(
            current["data"]["session"]["running"] != false,
            "Session {id} exited before recovery outcome {outcome}: {harness}"
        );
        Ok(None)
    })
    .await
}

#[tokio::test]
#[ignore = "requires native binaries and Node; bounded scoped recovery hooks with no model calls"]
async fn native_recovery_collects_all_current_context_without_replay_and_fails_open_within_deadline()
-> Result<()> {
    let mut fixture = Fixture::start_variant_with_client(true, true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        let (id,child,run,path,coordinator)=run_checkpoints::setup(&fixture,&owner).await?;
        let config:Value=serde_json::from_slice(&std::fs::read(path.with_file_name("mcp.json"))?)?;
        let binary=PathBuf::from(config["mcpServers"]["nesvo"]["command"].as_str().context("copied native client")?);
        assert!(binary.to_string_lossy().contains("native client łódź"));
        assert_eq!(context(&last_recovery(&fixture,&id)?["output"])?["bound"],false);
        assert_eq!(context(&last_recovery(&fixture,&child)?["output"])?["bound"],false);
        for index in 0..10 {
            let text=if index==9 {"LAST_OWNER_RULE literal $(not executable) łódź".to_owned()} else {format!("Owner rule {index}: preserve the current user's instruction.")};
            run_checkpoints::mutate(&owner,&run,"nesvo_add_run_constraint",json!({"key":format!("hook-rule-{index}"),"text":text})).await?;
        }
        data(call(&owner,"nesvo_send_prompt",json!({"key":"controlled-compact","sessionId":id,"prompt":"fixture-compact"})).await?)?;
        observed_output(&owner,&id,"FIXTURE_CONTEXT_COMPACTED").await?;
        let evidence=last_recovery(&fixture,&id)?;
        assert_eq!(evidence["source"],"compact");
        let recovered=context(&evidence["output"])?;
        assert_eq!(recovered["scope"],"coordinator");
        assert_eq!(recovered["bound"],true);
        assert_eq!(recovered["nativeEffectsRestored"],false);
        let page=&recovered["page"];
        let parts=page["parts"].as_array().context("all manifest parts")?;
        assert_eq!(parts.len() as u64,page["context"]["partCount"].as_u64().context("part count")?);
        assert!(parts.len()>8,"This must exercise real digest-checked continuation");
        assert_eq!(parts.iter().filter(|p|p["kind"]=="constraint").count(),10);
        assert!(parts.iter().any(|p|p["data"]["text"]=="LAST_OWNER_RULE literal $(not executable) łódź"));
        assert_eq!(page["currentConstraints"]["pending"],true);
        assert_eq!(page["run"]["goal"],"Preserve the literal goal; never repeat uncertain input");
        let prepared=report(&owner,&id,"prepared").await?;
        assert_eq!(prepared["recovery"]["status"]["source"],"compact");
        assert_eq!(prepared["recovery"]["status"]["constraintRevision"],10);
        let worker_path=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{child}.txt")))?);
        let event=serde_json::to_vec(&json!({"hook_event_name":"SessionStart","source":"compact","agent_id":""}))?;
        let before=run_checkpoints::view(&coordinator,&run).await?;
        let terminal_before=data(call(&owner,"nesvo_read_session",json!({"sessionId":child,"maxBytes":8192})).await?)?;
        let worker=invoke(&binary,&worker_path,&event,false).await?;
        let worker=context(&serde_json::from_slice::<Value>(&worker.stdout)?)?;
        assert_eq!(worker["scope"],"worker");
        assert_eq!(worker["taskContext"]["attempt"]["state"],"assigned");
        assert_eq!(worker["taskContext"]["constraints"]["records"].as_array().context("all worker rules")?.len(),10);
        assert!(worker.get("page").is_none());
        let worker_report=report(&owner,&child,"prepared").await?;
        assert_eq!(worker_report["recovery"]["status"]["constraintRevision"],10);
        assert_eq!(run_checkpoints::view(&coordinator,&run).await?,before,"Recovery reads cannot ACK, enable policies, validate, or change revisions");
        let terminal_after=data(call(&owner,"nesvo_read_session",json!({"sessionId":child,"maxBytes":8192})).await?)?;
        assert_eq!(terminal_after["data"]["page"]["data"],terminal_before["data"]["page"]["data"],"No native input from recovery");
        oversize_provider_context_with_run_constraints(&owner,&run).await?;
        unavailable(&invoke(&binary,&path,&event,false).await?)?;
        let failed=report(&owner,&id,"unavailable").await?;
        assert!(failed["recovery"]["status"]["runId"].is_null());
        let absent=fixture.directory.join("missing-secret-pairing.json");
        for ignored in [json!({"hook_event_name":"Stop","source":"compact"}),json!({"hook_event_name":"SessionStart","source":"compact","agent_id":"child"}),json!({"hook_event_name":"SessionStart","source":"fork"})] {
            let output=invoke(&binary,&absent,&serde_json::to_vec(&ignored)?,false).await?;
            assert!(output.stdout.is_empty()&&output.stderr.is_empty(),"Ignored events must not authenticate or contact a host");
        }
        unavailable(&invoke(&binary,&fixture.pairing(),&event,false).await?)?;
        unavailable(&invoke(&binary,&absent,&event,false).await?)?;
        unavailable(&invoke(&binary,&path,&event,true).await?)?;
        data(call(&coordinator,"nesvo_create_run",json!({"key":"second-recovery-run","spec":{"title":"Second","goal":"Do not implicitly select me"}})).await?)?;
        let output=invoke(&binary,&path,&event,false).await?;
        let text=serde_json::from_slice::<Value>(&output.stdout)?;
        assert!(text["hookSpecificOutput"]["additionalContext"].as_str().context("selection guidance")?.contains("explicit selection"));
        report(&owner,&id,"selectionRequired").await?;
        coordinator.cancel().await?;
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
