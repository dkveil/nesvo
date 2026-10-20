//! Official SDK -> native durable quota journal -> one controlled existing PTY.
//! No original provider, model request, artificial hook or database seeding.
use super::*;
use provider_quota::{
    configure_source, context_query, context_refresh, context_revision, row, snapshot,
};

type Owner = RunningService<RoleClient, ()>;

async fn quota_wake(owner: &Owner, session: &str) -> Result<Value> {
    let envelope = data(call(owner, "nesvo_get_quota_wake", json!({"sessionId":session})).await?)?;
    assert_eq!(envelope["data"]["type"], "quotaWake");
    Ok(envelope["data"]["quotaWake"].clone())
}

async fn operation(owner: &Owner, id: &str) -> Result<Value> {
    Ok(
        data(call(owner, "nesvo_get_operation", json!({"id":id})).await?)?["data"]["receipt"]
            .clone(),
    )
}

async fn create(fixture: &Fixture, owner: &Owner) -> Result<(Value, String)> {
    let tools = owner.list_all_tools().await?;
    assert_eq!(tools.len(), published_tool_count());
    for name in ["nesvo_set_quota_wake", "nesvo_get_quota_wake"] {
        assert!(tools.iter().any(|tool| tool.name == name));
    }
    timeout(Duration::from_secs(5), async {
        loop {
            let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
            if doctor["providerVersions"]
                .as_array()
                .is_some_and(|versions| {
                    versions
                        .iter()
                        .any(|row| row["program"] == "codex" && row["status"] == "ready")
                })
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Controlled Codex version readiness")??;
    let created = data(
        call(
            owner,
            "nesvo_create_session",
            json!({"key":"quota-wake-native-once","spec":{
                "name":"Quota continuation existing process","program":"codex",
                "cwd":fixture.directory
            }}),
        )
        .await?,
    )?;
    let id = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("Controlled quota session identity")?
        .to_owned();
    session_ready(owner, &id).await?;
    assert!(quota_wake(owner, &id).await?.is_null());
    Ok((created, id))
}

/// Start the short reset only when refresh is admitted. An earlier startup
/// observation can be cooling down; none of these refreshes invokes a model.
async fn near_reset(fixture: &Fixture, owner: &Owner) -> Result<Value> {
    timeout(Duration::from_secs(9), async {
        loop {
            let mut limited = snapshot();
            limited["rateLimits"]["primary"]["usedPercent"] = json!(95);
            limited["rateLimits"]["primary"]["resetsAt"] =
                json!(chrono::Utc::now().timestamp() + 8);
            configure_source(fixture, json!({"mode":"snapshot","result":limited}))?;
            let accepted = context_query(owner, &fixture.directory, true).await?;
            match accepted["data"]["refresh"]["state"].as_str() {
                Some("queued" | "pending") => {
                    let revision = accepted["data"]["refresh"]["revision"]
                        .as_u64()
                        .context("Limited-reader target revision")?;
                    let observed = context_revision(owner, &fixture.directory, revision).await?;
                    let view = row(&observed)?;
                    assert_eq!(view["ordinaryUsageAllowed"], true);
                    assert_eq!(view["complete"], true);
                    assert_eq!(view["freshness"], "fresh");
                    assert!(view["contextId"].is_string());
                    assert!(view["accountFingerprint"].is_string());
                    let windows = view["windows"].as_array().context("Complete windows")?;
                    assert!(windows.iter().any(|window| {
                        window["durationMins"] == 300 && window["usedPercent"] == 95
                    }));
                    return Ok::<_, anyhow::Error>(view.clone());
                }
                Some("cooldown") => {
                    let delay = accepted["data"]["refresh"]["retryAfterMs"]
                        .as_u64()
                        .context("Limited-reader cooldown")?;
                    tokio::time::sleep(Duration::from_millis(delay.clamp(1, 5000))).await;
                }
                _ => anyhow::bail!("Unexpected controlled context refresh: {accepted}"),
            }
        }
    })
    .await
    .context("Bounded near-reset reader observation")?
}

async fn blocked_prompt(owner: &Owner, session: &str) -> Result<(Value, String)> {
    let sent = data(
        call(
            owner,
            "nesvo_send_prompt",
            json!({"sessionId":session,"key":"quota-blocked-original","prompt":"quota-wait"}),
        )
        .await?,
    )?;
    let id = sent["data"]["receipt"]["id"]
        .as_str()
        .context("Original correlated send")?
        .to_owned();
    timeout(Duration::from_secs(5), async {
        loop {
            let session_view =
                data(call(owner, "nesvo_get_session", json!({"sessionId":session})).await?)?;
            let receipt = operation(owner, &id).await?;
            if session_view["data"]["session"]["rateLimited"] == true
                && session_view["data"]["session"]["status"]["state"] == "blocked"
                && matches!(receipt["phase"].as_str(), Some("received" | "started"))
            {
                assert_eq!(receipt["result"]["providerPromptObserved"], true);
                assert_eq!(receipt["result"]["taskResult"], Value::Null);
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Supported prompt correlation plus current quota screen")??;
    Ok((sent, id))
}

async fn arm(owner: &Owner, session: &str, predecessor: &str) -> Result<Value> {
    let enabled = data(
        call(
            owner,
            "nesvo_set_quota_wake",
            json!({"sessionId":session,"enabled":true}),
        )
        .await?,
    )?;
    assert_eq!(enabled["data"]["type"], "wakeConfigured");
    let retained = enabled["data"]["quotaWake"].clone();
    assert_eq!(retained["phase"], "armed");
    assert_eq!(retained["sessionId"], session);
    assert_eq!(retained["predecessorId"], predecessor);
    assert!(retained["operationId"].is_null());
    assert!(
        retained["source"]["resetAt"]
            .as_i64()
            .is_some_and(|reset| reset > chrono::Utc::now().timestamp())
    );
    assert_eq!(quota_wake(owner, session).await?, retained);
    Ok(retained)
}

async fn after_reset(owner: &Owner, fixture: &Fixture, retained: &Value) -> Result<Value> {
    let reset = retained["source"]["resetAt"]
        .as_i64()
        .context("Frozen future reset")?
        .checked_mul(1000)
        .and_then(|value| value.checked_add(200))
        .context("Bounded reset timestamp")?;
    let remaining = reset.saturating_sub(chrono::Utc::now().timestamp_millis());
    if remaining > 0 {
        tokio::time::sleep(Duration::from_millis(u64::try_from(remaining)?)).await;
    }
    configure_source(fixture, json!({"mode":"snapshot","result":snapshot()}))?;
    let accepted = context_refresh(owner, &fixture.directory).await?;
    let revision = accepted["data"]["refresh"]["revision"]
        .as_u64()
        .context("Post-reset target revision")?;
    let refreshed = context_revision(owner, &fixture.directory, revision).await?;
    let current = row(&refreshed)?;
    assert_eq!(current["readerId"], retained["source"]["readerId"]);
    assert_eq!(current["contextId"], retained["source"]["contextId"]);
    assert_eq!(
        current["accountFingerprint"],
        retained["source"]["accountFingerprint"]
    );
    assert!(current["revision"].as_u64() > retained["source"]["revision"].as_u64());
    assert_eq!(current["ordinaryUsageEligible"], true);
    Ok(current.clone())
}

fn inputs(fixture: &Fixture, session: &str) -> Result<Vec<Value>> {
    let path = fixture
        .directory
        .join("callers")
        .join(format!("{session}.quota-wake-inputs.jsonl"));
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(text
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?)
}

async fn paused(owner: &Owner, session: &str) -> Result<Value> {
    timeout(Duration::from_secs(5), async {
        loop {
            let view = quota_wake(owner, session).await?;
            if view["phase"] == "paused" {
                return Ok::<_, anyhow::Error>(view);
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Retained one-shot arm must pause")?
}

async fn stop(owner: &Owner, session: &str) -> Result<()> {
    data(
        call(
            owner,
            "nesvo_stop_session",
            json!({"sessionId":session,"key":"quota-fixture-stop"}),
        )
        .await?,
    )?;
    timeout(Duration::from_secs(5), async {
        loop {
            let view = data(call(owner, "nesvo_get_session", json!({"sessionId":session})).await?)?;
            if view["data"]["session"]["running"] == false {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Owned controlled quota process must exit")?
}

#[tokio::test]
#[ignore = "native SDK/controlled PTY; durable one-shot continuation survives owner disconnect"]
async fn durable_quota_wake_resumes_exact_existing_process_once_after_fresh_matching_reset()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(30), async {
        let owner = client(&fixture.pairing()).await?;
        let (created, session) = create(&fixture, &owner).await?;
        let source = near_reset(&fixture, &owner).await?;
        let (_, original) = blocked_prompt(&owner, &session).await?;
        let retained = arm(&owner, &session, &original).await?;
        assert_eq!(retained["source"]["contextId"], source["contextId"]);
        assert_eq!(retained["source"]["accountFingerprint"], source["accountFingerprint"]);
        assert!(inputs(&fixture, &session)?.is_empty());
        owner.cancel().await?;

        // No owner transport owns the arm or the native producer's lifetime.
        let reset = retained["source"]["resetAt"].as_i64().context("Reset")?;
        let remaining = (reset * 1000 + 200).saturating_sub(chrono::Utc::now().timestamp_millis());
        if remaining > 0 {
            tokio::time::sleep(Duration::from_millis(u64::try_from(remaining)?)).await;
        }
        assert!(inputs(&fixture, &session)?.is_empty(), "Wall-clock reset alone cannot resume input");
        let owner = client(&fixture.pairing()).await?;
        after_reset(&owner, &fixture, &retained).await?;
        let (finished_wake, finished_send) = timeout(Duration::from_secs(7), async {
            loop {
                let wake = quota_wake(&owner, &session).await?;
                if let Some(operation_id) = wake["operationId"].as_str() {
                    let receipt = operation(&owner, operation_id).await?;
                    if receipt["phase"] == "settled" && wake["phase"] == "paused" {
                        return Ok::<_, anyhow::Error>((wake, receipt));
                    }
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await.context("One controlled quota continuation must settle")??;
        assert_eq!(finished_wake["id"], retained["id"]);
        assert_eq!(finished_wake["source"], retained["source"]);
        assert_eq!(finished_wake["predecessorId"], original);
        assert_eq!(finished_send["sessionId"], session);
        assert_eq!(finished_send["operation"], "send");
        assert_eq!(finished_send["result"]["taskResult"], Value::Null);
        let old = operation(&owner, &original).await?;
        assert_eq!(old["phase"], "interrupted");
        assert_eq!(old["result"]["code"], "quota_resumed");
        assert_eq!(old["result"]["quotaWakeId"], retained["id"]);
        assert_eq!(old["result"]["supersededBy"], finished_send["id"]);
        assert_eq!(old["result"]["taskResult"], Value::Null);

        let recorded = inputs(&fixture, &session)?;
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0]["prompt"], "Continue the previous task.");
        assert_eq!(recorded[0]["sessionId"], session);
        let before: Value = serde_json::from_slice(&std::fs::read(fixture.directory.join("callers").join(format!("{session}.quota-wake-original.json")))?)?;
        assert_eq!(recorded[0]["pid"], before["pid"], "Continue the same native process");
        for _ in 0..3 {
            assert_eq!(quota_wake(&owner, &session).await?, finished_wake);
            assert_eq!(operation(&owner, finished_send["id"].as_str().context("Continuation receipt")?).await?, finished_send);
        }
        let replay = call(&owner,"nesvo_send_prompt",json!({"sessionId":session,"key":"quota-blocked-original","prompt":"quota-wait"})).await?;
        assert_eq!(replay.is_error, Some(true));
        let replay = replay.structured_content.context("Original send replay evidence")?;
        assert_eq!(replay["error"]["receipt"], old);
        let create_replay=data(call(&owner,"nesvo_create_session",json!({"key":"quota-wake-native-once","spec":{
            "name":"Quota continuation existing process","program":"codex","cwd":fixture.directory
        }})).await?)?;
        assert_eq!(create_replay["data"]["receipt"], created["data"]["receipt"]);
        let listed=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        let sessions=listed["data"]["sessions"].as_array().context("One native session")?;
        assert_eq!(sessions.len(),1);
        assert_eq!(sessions[0]["id"], session);
        assert_eq!(inputs(&fixture,&session)?.len(),1,"Queries and original-key replay cannot redeliver continuation");
        stop(&owner,&session).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Native one-shot quota case deadline")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native SDK/controlled PTY; human takeover and owner disable retain a paused arm"]
async fn durable_quota_wake_stays_paused_after_takeover_disable_and_fresh_quota() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(30), async {
        let owner = client(&fixture.pairing()).await?;
        let (_, session) = create(&fixture, &owner).await?;
        near_reset(&fixture, &owner).await?;
        let (_, original) = blocked_prompt(&owner, &session).await?;
        let retained = arm(&owner, &session, &original).await?;
        let mut human = human_control(&fixture.pairing(), &session).await?;
        drop(human.stdin.take());
        ensure!(
            timeout(Duration::from_secs(5), human.wait())
                .await??
                .success(),
            "Controlled owner lease must close cleanly"
        );
        let taken_over = paused(&owner, &session).await?;
        assert_eq!(taken_over["id"], retained["id"]);
        assert_eq!(taken_over["source"], retained["source"]);
        assert!(
            taken_over["operationId"].is_null(),
            "Human epoch revokes the arm before any native receipt"
        );
        let disabled = data(
            call(
                &owner,
                "nesvo_set_quota_wake",
                json!({"sessionId":session,"enabled":false}),
            )
            .await?,
        )?;
        assert_eq!(disabled["data"]["wakeAt"], Value::Null);
        assert_eq!(disabled["data"]["quotaWake"], taken_over);
        let current = after_reset(&owner, &fixture, &retained).await?;
        assert_eq!(current["ordinaryUsageEligible"], true);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        for _ in 0..3 {
            let view = quota_wake(&owner, &session).await?;
            assert_eq!(view, taken_over);
            assert_eq!(view["predecessorId"], original);
            assert!(view["operationId"].is_null());
        }
        assert!(
            inputs(&fixture, &session)?.is_empty(),
            "Neither reset, released human control nor fresh quota rearms a one-shot intent"
        );
        let old = operation(&owner, &original).await?;
        assert!(matches!(
            old["phase"].as_str(),
            Some("received" | "started" | "unknown" | "interrupted")
        ));
        assert_ne!(old["result"]["code"], "quota_resumed");
        assert_ne!(old["phase"], "settled");
        stop(&owner, &session).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Native disabled quota case deadline")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
