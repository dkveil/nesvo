use super::*;
use budgets::owner_cli;
use hibernation::{conversation_of, install_resumable_identity};

type Owner = RunningService<RoleClient, ()>;

async fn worker(owner: &Owner, key: &str, name: &str) -> Result<String> {
    let created = waits::operation(
        owner,
        "nesvo_create_session",
        json!({"key":key,"spec":{"name":name,"program":"claude"}}),
    )
    .await?;
    Ok(created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("restore fixture worker")?
        .to_owned())
}

async fn turn(owner: &Owner, id: &str, prompt: &str) -> Result<()> {
    session_ready(owner, id).await?;
    let sent = waits::operation(
        owner,
        "nesvo_send_prompt",
        json!({"sessionId":id,"key":format!("{prompt}-{id}"),"prompt":prompt}),
    )
    .await?;
    waits::receipt(owner, &sent["data"]["receipt"]["id"], id, "settled").await?;
    observed_output(owner, id, &format!("FIXTURE_RESPONSE {prompt}")).await?;
    session_ready(owner, id).await
}

async fn conversation(owner: &Owner, id: &str) -> Result<Value> {
    waits::until(async || {
        let response = data(call(owner, "nesvo_explain_session", json!({"sessionId": id})).await?)?;
        let identity =
            response["data"]["report"]["sessions"][0]["conversationIdentity"]["providerSessionId"]
                .clone();
        if identity.is_string() {
            return Ok(Some(identity));
        }
        ensure!(
            !waits::exited(owner, id).await?,
            "Session {id} exited before reporting a conversation"
        );
        Ok(None)
    })
    .await
}

async fn restored(fixture: &Fixture, owner: &Owner, id: &str) -> Result<Value> {
    waits::until(async || {
        let view = data(call(owner, "nesvo_get_session", json!({"sessionId": id})).await?)?;
        let session = &view["data"]["session"];
        ensure!(
            session["hibernation"]["lastResumeFailure"].is_null()
                && session["resume"]["state"] != "resumeFailed",
            "Restore of {id} failed: {session}"
        );
        if session["running"] != true {
            let doctor = owner_cli(fixture, &["doctor", "--json"]).await?;
            let rows = &doctor["sessionRestore"]["sessions"];
            if let Ok(entry) = row(rows, id) {
                ensure!(
                    matches!(entry["outcome"].as_str(), Some("pending" | "restored")),
                    "Restore of {id} was refused: {entry}"
                );
            }
            return Ok(None);
        }
        let verified = session["resume"]["state"] == "verified";
        let ready =
            session["readiness"]["phase"] == "ready" && session["status"]["state"] == "idle";
        Ok((verified && ready).then_some(view))
    })
    .await
    .context("Restored session readiness")
}

async fn report(fixture: &Fixture) -> Result<(Value, Value)> {
    waits::until(async || {
        let doctor = owner_cli(fixture, &["doctor", "--json"]).await?;
        let rows = doctor["sessionRestore"]["sessions"].clone();
        let settled = rows
            .as_array()
            .context("Restore report rows")?
            .iter()
            .all(|row| row["outcome"] != "pending");
        Ok(settled.then_some((doctor, rows)))
    })
    .await
}

fn row<'a>(rows: &'a Value, id: &str) -> Result<&'a Value> {
    rows.as_array()
        .context("Restore report rows")?
        .iter()
        .find(|row| row["sessionId"] == id)
        .with_context(|| format!("No restore report row for {id}: {rows}"))
}

async fn journal(owner: &Owner, id: &str) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut cursor = 0;
    loop {
        let page = data(
            call(
                owner,
                "nesvo_read_events",
                json!({"sessionId":id,"after":cursor}),
            )
            .await?,
        )?;
        ensure!(
            page["data"]["gap"] == false,
            "Restore journal must be complete: {page}"
        );
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Restore journal events")?
                .iter()
                .filter(|event| {
                    matches!(
                        event["kind"].as_str(),
                        Some("session.hibernated" | "session.resumed")
                    )
                })
                .cloned(),
        );
        if page["data"]["more"] != true {
            return Ok(events);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Restore journal cursor")?;
    }
}

#[tokio::test]
#[ignore = "requires native binaries and Node; a graceful host restart hibernates and restores the resumable worker under its id and reports the reaped one"]
async fn graceful_restart_restores_resumable_sessions_and_reports_reaped_ones() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        waits::provider(&fixture, "claude").await?;
        let plain = worker(&owner, "restore-plain", "Restore plain worker").await?;
        turn(&owner, &plain, "plain-before").await?;
        install_resumable_identity(&fixture).await?;
        let id = worker(&owner, "restore-worker", "Restore worker").await?;
        let expected = conversation_of(&id);
        turn(&owner, &id, "before-restart").await?;
        assert_eq!(conversation(&owner, &id).await?, expected.as_str());
        session_ready(&owner, &plain).await?;
        owner.cancel().await?;

        fixture.restart(false).await?;
        let owner = client(&fixture.pairing()).await?;
        let live = restored(&fixture, &owner, &id).await?;
        assert_eq!(live["data"]["session"]["id"], id.as_str());
        assert!(live["data"]["session"]["hibernation"].is_null());
        assert_eq!(
            live["data"]["session"]["resume"]["conversationId"],
            expected.as_str()
        );
        let (doctor, rows) = report(&fixture).await?;
        assert_eq!(
            doctor["sessionRestore"]["policy"],
            json!({"enabled":true,"concurrency":2})
        );
        let entry = row(&rows, &id)?;
        assert_eq!(entry["outcome"], "restored");
        assert!(entry["code"].is_null());
        let reaped = row(&rows, &plain)?;
        assert_eq!(reaped["outcome"], "reaped");
        assert_eq!(reaped["code"], "resume_unavailable");
        let gone = call(&owner, "nesvo_get_session", json!({"sessionId":plain})).await?;
        assert_eq!(gone.is_error, Some(true));
        assert_eq!(
            gone.structured_content.context("Reaped session refusal")?["error"]["code"],
            "session_not_found"
        );
        let key = format!(
            "restore:{id}:{}",
            entry["shutdownAt"]
                .as_u64()
                .context("Restore shutdown time")?
        );
        let replayed = owner_cli(
            &fixture,
            &["session", "resume", &id, "--key", &key, "--json"],
        )
        .await?;
        assert_eq!(replayed["data"]["state"], "resumed");
        assert_eq!(replayed["data"]["reason"], "restored");
        assert_eq!(replayed["data"]["replayed"], true);
        let argv: Vec<String> = serde_json::from_slice(&std::fs::read(
            fixture
                .directory
                .join("callers")
                .join(format!("{id}.launch-argv.json")),
        )?)?;
        let flag = argv
            .iter()
            .position(|arg| arg == "--resume")
            .context("Exact resume argument")?;
        assert_eq!(argv.get(flag + 1), Some(&expected));
        turn(&owner, &id, "after-restart").await?;

        let pairs: Vec<(Value, Value)> = journal(&owner, &id)
            .await?
            .into_iter()
            .map(|event| (event["kind"].clone(), event["payload"].clone()))
            .collect();
        assert_eq!(
            pairs,
            [
                (
                    json!("session.hibernated"),
                    json!({"conversationId":expected,"program":"claude","trigger":"shutdown"})
                ),
                (
                    json!("session.resumed"),
                    json!({"conversationId":expected,"program":"claude","reason":"restored"})
                ),
            ]
        );
        assert!(journal(&owner, &plain).await?.is_empty());
        run_checkpoints::schema(vec![doctor, replayed]).await?;
        waits::operation(
            &owner,
            "nesvo_stop_session",
            json!({"key":"stop-restore-worker","sessionId":id}),
        )
        .await?;
        waits::session(&owner, &id, waits::Session::Stopped).await?;
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
