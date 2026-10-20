use super::*;

#[tokio::test]
#[ignore = "requires native binaries and Node; delayed screen-only editor redraw after native paste"]
async fn submission_waits_for_fresh_editor_idle_without_repeating_paste() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        timeout(Duration::from_secs(5), async {
            loop {
                let doctor = budgets::owner_cli(&fixture, &["doctor", "--json"]).await?;
                if doctor["providerVersions"].as_array().is_some_and(|rows| rows.iter().any(|row| row["program"] == "claude" && row["status"] == "ready")) { return Ok::<_, anyhow::Error>(()); }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        std::fs::write(fixture.directory.join(".fixture-editor-redraw"), "")?;
        let owner = client(&fixture.pairing()).await?;
        let created = data(call(&owner, "nesvo_create_session", json!({
            "key":"redraw-worker", "spec":{"name":"Screen-only editor", "program":"claude", "harness":true}
        })).await?)?;
        let id = created["data"]["receipt"]["sessionId"].as_str().context("redraw session")?;
        session_ready(&owner, id).await?;
        let before = tokio::time::Instant::now();
        let prompt = format!("EDITOR_REDRAW_ONCE {}", "literal draft ".repeat(30));
        let args = json!({"sessionId":id,"key":"redraw-input","prompt":prompt});
        let sent = data(call(&owner, "nesvo_send_prompt", args.clone()).await?)?;
        assert_eq!(sent["data"]["receipt"]["phase"], "delivered");
        assert_eq!(sent["data"]["receipt"]["result"]["nativeWriteFlushed"], true);
        assert!(before.elapsed() >= Duration::from_millis(500), "No Enter before fresh editor evidence");
        assert_eq!(data(call(&owner, "nesvo_send_prompt", args).await?)?["data"], sent["data"]);
        observed_output(&owner, id, "FIXTURE_RESPONSE EDITOR_REDRAW_ONCE").await?;
        let read = data(call(&owner,"nesvo_read_session",json!({"sessionId":id,"maxBytes":8192})).await?)?;
        let text = read["data"]["page"]["data"].as_str().context("redraw output")?;
        assert_eq!(text.matches("EDITOR_REDRAW_ONCE").count(), 1, "No duplicate paste or Enter on replay");
        std::fs::write(fixture.directory.join(".fixture-editor-redraw"), "working")?;
        let created = data(call(&owner,"nesvo_create_session",json!({"key":"semantic-blocker-worker","spec":{"name":"Working must fail","program":"claude","harness":true}})).await?)?;
        let blocked_id = created["data"]["receipt"]["sessionId"].as_str().context("blocked session")?;
        session_ready(&owner, blocked_id).await?;
        let rejected = call(&owner,"nesvo_send_prompt",json!({"sessionId":blocked_id,"key":"semantic-blocker-input","prompt":"MUST_NOT_SUBMIT_AFTER_WORKING"})).await?.structured_content.context("rejected receipt")?;
        assert_eq!(rejected["error"]["receipt"]["phase"], "unknown");
        assert_eq!(rejected["error"]["receipt"]["result"]["code"], "agent_not_ready");
        assert_eq!(rejected["error"]["receipt"]["result"]["effectStarted"], true);
        tokio::time::sleep(Duration::from_millis(800)).await;
        let read=data(call(&owner,"nesvo_read_session",json!({"sessionId":blocked_id,"maxBytes":8192})).await?)?;
        assert!(!read["data"]["page"]["data"].as_str().context("blocked output")?.contains("FIXTURE_RESPONSE"), "New working evidence stops Enter, even when the editor later returns idle");
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(value) => {
            value?;
            cleanup
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
