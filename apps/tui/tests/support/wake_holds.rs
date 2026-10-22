use super::*;
use budgets::owner_cli;

type Owner = RunningService<RoleClient, ()>;

async fn view(client: &Owner, run: &str) -> Result<Value> {
    Ok(data(call(client, "nesvo_get_run", json!({"runId":run})).await?)?["data"].clone())
}

async fn revision(client: &Owner, run: &str) -> Result<String> {
    Ok(view(client, run).await?["run"]["revision"]
        .as_u64()
        .context("Run revision")?
        .to_string())
}

async fn wake_view(client: &Owner, run: &str) -> Result<Value> {
    Ok(data(call(client, "nesvo_get_run_wakes", json!({"runId":run})).await?)?["data"].clone())
}

async fn coordinator(fixture: &Fixture, owner: &Owner, key: &str) -> Result<String> {
    waits::provider(fixture, "claude")
        .await
        .context("Wake hold coordinator provider probe")?;
    let created = waits::operation(owner, "nesvo_create_session", json!({
        "key":key,"spec":{"name":"Wake hold coordinator","program":"claude","role":"coordinator","harness":true}
    })).await?;
    let id = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("Wake hold coordinator")?
        .to_owned();
    session_ready(owner, &id).await?;
    Ok(id)
}

fn received(fixture: &Fixture, id: &str) -> Result<Vec<Value>> {
    let path = fixture
        .directory
        .join("callers")
        .join(format!("{id}.wake-inputs.jsonl"));
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| Ok(serde_json::from_str::<Value>(line)?))
        .collect()
}

async fn waves(owner: &Owner, fixture: &Fixture, id: &str, count: usize) -> Result<Vec<Value>> {
    waits::until(async || {
        let values = received(fixture, id)?;
        ensure!(
            values.len() <= count,
            "Coordinator {id} received more than {count} wake inputs: {values:?}"
        );
        if values.len() == count {
            return Ok(Some(values));
        }
        ensure!(
            !waits::exited(owner, id).await?,
            "Coordinator {id} exited before {count} wake inputs"
        );
        Ok(None)
    })
    .await
    .context("Released wake delivery")
}

async fn refusal(client: &Owner, tool: &'static str, args: Value) -> Result<Value> {
    let reply = call(client, tool, args).await?;
    ensure!(
        reply.is_error == Some(true),
        "{tool} was not refused: {reply:?}"
    );
    Ok(reply.structured_content.context("Wake refusal")?["error"]["code"].clone())
}

#[tokio::test]
#[ignore = "requires native binaries and Node; an owner-held wake survives a host restart and its release delivers exactly once"]
async fn owner_held_wake_survives_restart_and_release_delivers_exactly_once() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let original = coordinator(&fixture, &owner, "wake-hold-coordinator").await?;
        let created = data(call(&owner, "nesvo_create_run", json!({
            "key":"wake-hold-run",
            "spec":{"title":"Owner wake hold","goal":"Keep the owner hold across a restart","coordinatorSessionId":original}
        })).await?)?;
        let run = created["data"]["run"]["id"].as_str().context("Wake hold run")?.to_owned();
        data(call(&owner, "nesvo_set_run_plan", json!({
            "key":"wake-hold-plan","runId":run,"expectedRevision":1,
            "tasks":[{"key":"work","title":"Work","instruction":"Never imply success"}]
        })).await?)?;
        data(call(&owner, "nesvo_activate_run", json!({"key":"wake-hold-active","runId":run,"expectedRevision":2})).await?)?;
        data(call(&owner, "nesvo_enable_run_wakes", json!({"key":"wake-hold-enable","runId":run,"expectedRevision":3})).await?)?;
        let held = owner_cli(&fixture, &["run", "wake", "pause", &run, "--key", "wake-hold", "--revision", &revision(&owner, &run).await?, "--json"]).await?;
        assert_eq!(held["data"]["wakePolicy"]["held"], true);
        assert_eq!(held["data"]["wakePolicy"]["phase"], "held");
        assert_eq!(held["data"]["wakePolicy"]["reason"], "owner_held");
        data(call(&owner, "nesvo_send_message", json!({
            "key":"held-question","runId":run,"correlationId":"held-question","kind":"question",
            "body":"PRIVATE_BODY_MUST_NOT_BECOME_NATIVE_WAKE_INPUT"
        })).await?)?;
        holds_throughout(Duration::from_millis(1100), async || {
            ensure!(received(&fixture, &original)?.is_empty(), "A held policy delivered wake input");
            Ok(())
        }).await?;
        owner.cancel().await?;

        fixture.restart(false).await?;
        let owner = client(&fixture.pairing()).await?;
        let restarted = wake_view(&owner, &run).await?;
        assert_eq!(restarted["wakePolicy"]["held"], true, "The owner hold survives the restart");
        assert_eq!(restarted["wakePolicy"]["enabled"], false);
        assert_eq!(restarted["wakePolicy"]["phase"], "held");
        assert_eq!(restarted["wakePolicy"]["reason"], "owner_held");
        let cli_restarted = owner_cli(&fixture, &["run", "wake", "get", &run, "--json"]).await?;
        assert_eq!(cli_restarted["data"]["wakePolicy"], restarted["wakePolicy"]);

        let replacement = coordinator(&fixture, &owner, "wake-hold-replacement").await?;
        let rebound = data(call(&owner, "nesvo_rebind_run_coordinator", json!({
            "key":"wake-hold-rebind","runId":run,"expectedRevision":view(&owner, &run).await?["run"]["revision"],
            "expectedCoordinatorSessionId":original,"coordinatorSessionId":replacement
        })).await?)?;
        assert_eq!(rebound["data"]["run"]["coordinatorSessionId"], replacement.as_str());
        let after_rebind = wake_view(&owner, &run).await?;
        assert_eq!(after_rebind["wakePolicy"]["held"], true, "Coordinator recovery keeps the owner hold");
        assert_eq!(after_rebind["wakePolicy"]["enabled"], false);
        let context = PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{replacement}.txt")))?);
        let scoped = scoped_client(&context, &replacement).await?;
        let current = revision(&owner, &run).await?.parse::<u64>()?;
        assert_eq!(refusal(&scoped, "nesvo_enable_run_wakes", json!({"key":"coordinator-release","runId":run,"expectedRevision":current})).await?, "wake_policy_held");
        assert_eq!(refusal(&scoped, "nesvo_disable_run_wakes", json!({"key":"coordinator-disable","runId":run,"expectedRevision":current})).await?, "wake_policy_held");
        holds_throughout(Duration::from_millis(1100), async || {
            ensure!(received(&fixture, &replacement)?.is_empty(), "A held policy delivered wake input after the restart");
            Ok(())
        }).await?;

        let release_revision = revision(&owner, &run).await?;
        let released = owner_cli(&fixture, &["run", "wake", "resume", &run, "--key", "wake-release", "--revision", &release_revision, "--json"]).await?;
        assert_eq!(released["data"]["wakePolicy"]["held"], false);
        assert_eq!(released["data"]["wakePolicy"]["enabled"], true);
        let delivered = waves(&owner, &fixture, &replacement, 1).await?;
        let batch = &delivered[0]["batch"]["data"]["wakeBatch"];
        let notices = batch["notices"].as_array().context("Released wake notices")?;
        assert_eq!(notices.len(), 1, "The held question is delivered once: {batch}");
        assert_eq!(notices[0]["kind"], "question");
        assert!(!delivered[0]["prompt"].as_str().context("Wake prompt")?.contains("PRIVATE_BODY"));
        waits::receipt(&owner, &batch["receiptId"], &replacement, "settled").await?;
        let replay = owner_cli(&fixture, &["run", "wake", "resume", &run, "--key", "wake-release", "--revision", &release_revision, "--json"]).await?;
        assert_eq!(replay["data"], released["data"], "The same release key replays without a second resume");
        holds_throughout(Duration::from_millis(1100), async || {
            ensure!(received(&fixture, &replacement)?.len() == 1, "A released hold delivered twice");
            ensure!(received(&fixture, &original)?.is_empty(), "The retired coordinator received input");
            Ok(())
        }).await?;
        let settled = wake_view(&owner, &run).await?;
        let batches: Vec<&Value> = settled["batches"].as_array().context("Wake batches")?.iter().collect();
        assert_eq!(batches.len(), 1, "Exactly one batch was claimed: {settled}");
        assert_eq!(batches[0]["id"], batch["id"]);
        let mail = data(call(&owner, "nesvo_read_inbox", json!({"runId":run})).await?)?;
        assert_eq!(mail["data"]["pendingCount"], 1, "Delivery never acknowledges the question");
        let disabled = owner_cli(&fixture, &["run", "wake", "disable", &run, "--key", "wake-hold-disable", "--revision", &revision(&owner, &run).await?, "--json"]).await?;
        assert_eq!(disabled["data"]["wakePolicy"]["enabled"], false);
        run_checkpoints::schema(vec![held, cli_restarted, released, replay, disabled, delivered[0]["batch"].clone(), mail]).await?;
        scoped.cancel().await?;
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
