use super::*;
use budgets::owner_cli;

type Owner = RunningService<RoleClient, ()>;

const RESUMABLE_IDENTITY: &str = include_str!("../../../../tests/fixtures/resumable-identity.cjs");
const SCOPED_AGENT: &str = include_str!("../../../../tests/fixtures/scoped-agent.cjs");

fn claude_entry(fixture: &Fixture) -> PathBuf {
    if cfg!(windows) {
        fixture
            .directory
            .join("bin")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("main.js")
    } else {
        fixture.directory.join("bin").join("claude")
    }
}

pub(super) async fn install_resumable_identity(fixture: &Fixture) -> Result<()> {
    waits::provider(fixture, "claude")
        .await
        .context("Controlled Claude version probe before the identity wrapper")?;
    let entry = claude_entry(fixture);
    let directory = entry.parent().context("Controlled Claude entry folder")?;
    std::fs::write(directory.join("scoped-agent.cjs"), SCOPED_AGENT)?;
    let staged = directory.join("resumable-identity.tmp");
    std::fs::write(&staged, RESUMABLE_IDENTITY)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&staged, &entry)?;
    Ok(())
}

pub(super) fn conversation_of(session: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &session[0..8],
        &session[8..12],
        &session[12..16],
        &session[16..20],
        &session[20..32]
    )
}

async fn conversation_observed(owner: &Owner, id: &str, conversation: &str) -> Result<Value> {
    waits::until(async || {
        let response = data(call(owner, "nesvo_explain_session", json!({"sessionId": id})).await?)?;
        let view = response["data"]["report"]["sessions"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["sessionId"] == id))
            .context("Owned session diagnostics")?
            .clone();
        if view["conversationIdentity"]["providerSessionId"] == conversation {
            return Ok(Some(view));
        }
        ensure!(
            !waits::exited(owner, id).await?,
            "Session {id} exited before reporting conversation {conversation}: {view}"
        );
        Ok(None)
    })
    .await
    .context("Controlled provider conversation identity")
}

async fn turn(owner: &Owner, id: &str, key: &str, prompt: &str) -> Result<()> {
    session_ready(owner, id).await?;
    let sent = waits::operation(
        owner,
        "nesvo_send_prompt",
        json!({"sessionId":id,"key":key,"prompt":prompt}),
    )
    .await?;
    waits::receipt(owner, &sent["data"]["receipt"]["id"], id, "settled").await?;
    observed_output(owner, id, &format!("FIXTURE_RESPONSE {prompt}")).await?;
    session_ready(owner, id).await
}

async fn session_events(owner: &Owner, id: &str) -> Result<Vec<Value>> {
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
            "Hibernation journal must be complete: {page}"
        );
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Hibernation journal events")?
                .iter()
                .cloned(),
        );
        if page["data"]["more"] != true {
            return Ok(events);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Hibernation journal cursor")?;
    }
}

fn refusal_code(result: CallToolResult) -> Result<Value> {
    ensure!(
        result.is_error == Some(true),
        "Expected a refusal: {result:?}"
    );
    Ok(result.structured_content.context("Structured refusal")?["error"]["code"].clone())
}

#[tokio::test]
#[ignore = "requires native binaries and Node; owner hibernation survives a host restart and resumes the exact conversation under the same session"]
async fn hibernated_session_survives_restart_and_resumes_its_exact_conversation() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome =
        std::panic::AssertUnwindSafe(async {
            install_resumable_identity(&fixture).await?;
            let owner = client(&fixture.pairing()).await?;
            let shell = waits::operation(&owner, "nesvo_create_session", json!({
            "key":"hibernation-shell","spec":{"name":"Hibernation refusal shell","program":"shell"}
        })).await?;
            let shell_id = shell["data"]["receipt"]["sessionId"]
                .as_str()
                .context("refusal shell")?
                .to_owned();
            let refused = call(
                &owner,
                "nesvo_hibernate_session",
                json!({"sessionId":shell_id,"key":"hibernate-shell"}),
            )
            .await?;
            assert_eq!(refusal_code(refused)?, "hibernate_unsupported");
            let still =
                data(call(&owner, "nesvo_get_session", json!({"sessionId":shell_id})).await?)?;
            assert_eq!(
                still["data"]["session"]["running"], true,
                "A refused hibernation keeps the process"
            );
            assert!(still["data"]["session"]["hibernation"].is_null());
            waits::operation(
                &owner,
                "nesvo_stop_session",
                json!({"key":"stop-hibernation-shell","sessionId":shell_id}),
            )
            .await?;
            waits::session(&owner, &shell_id, waits::Session::Stopped).await?;

            let created = waits::operation(&owner, "nesvo_create_session", json!({
            "key":"hibernation-worker","spec":{"name":"Hibernation worker","program":"claude"}
        })).await?;
            let id = created["data"]["receipt"]["sessionId"]
                .as_str()
                .context("hibernation worker")?
                .to_owned();
            let conversation = conversation_of(&id);
            turn(&owner, &id, "before-hibernation", "before-hibernation").await?;
            conversation_observed(&owner, &id, &conversation).await?;

            let hibernated = owner_cli(
                &fixture,
                &[
                    "session",
                    "hibernate",
                    &id,
                    "--key",
                    "hibernate-worker",
                    "--json",
                ],
            )
            .await?;
            assert_eq!(hibernated["data"]["type"], "sessionHibernation");
            assert_eq!(hibernated["data"]["sessionId"], id.as_str());
            assert_eq!(hibernated["data"]["state"], "hibernated");
            assert_eq!(
                hibernated["data"]["hibernation"]["conversationId"],
                conversation.as_str()
            );
            assert_eq!(hibernated["data"]["hibernation"]["trigger"], "owner");
            let replayed = data(
                call(
                    &owner,
                    "nesvo_hibernate_session",
                    json!({"sessionId":id,"key":"hibernate-worker"}),
                )
                .await?,
            )?;
            assert_eq!(replayed["data"]["state"], "hibernated");
            assert_eq!(
                replayed["data"]["hibernation"], hibernated["data"]["hibernation"],
                "Same key replays the original hibernation"
            );
            let stopped = waits::session(&owner, &id, waits::Session::Stopped).await?;
            assert_eq!(
                stopped["data"]["session"]["hibernation"]["state"],
                "hibernated"
            );
            owner.cancel().await?;

            fixture.restart(false).await?;
            let owner = client(&fixture.pairing()).await?;
            let listed = data(call(&owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
            assert_eq!(listed["data"]["session"]["running"], false);
            assert_eq!(
                listed["data"]["session"]["hibernation"]["state"],
                "hibernated"
            );
            assert_eq!(
                listed["data"]["session"]["hibernation"]["conversationId"],
                conversation.as_str()
            );
            let again = call(
                &owner,
                "nesvo_hibernate_session",
                json!({"sessionId":id,"key":"hibernate-again"}),
            )
            .await?;
            assert_eq!(refusal_code(again)?, "session_hibernated");

            let resumed = owner_cli(
                &fixture,
                &["session", "resume", &id, "--key", "resume-worker", "--json"],
            )
            .await?;
            assert_eq!(resumed["data"]["type"], "sessionHibernation");
            assert_eq!(resumed["data"]["sessionId"], id.as_str());
            assert_eq!(resumed["data"]["state"], "resumed");
            assert_eq!(resumed["data"]["resume"]["state"], "verified");
            assert_eq!(
                resumed["data"]["resume"]["conversationId"],
                conversation.as_str()
            );
            let replay = data(
                call(
                    &owner,
                    "nesvo_resume_session",
                    json!({"sessionId":id,"key":"resume-worker"}),
                )
                .await?,
            )?;
            assert_eq!(replay["data"]["state"], "resumed");
            assert_eq!(
                replay["data"]["resume"], resumed["data"]["resume"],
                "Same key replays the verified resume"
            );
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
            assert_eq!(argv.get(flag + 1), Some(&conversation));
            turn(&owner, &id, "after-resume", "after-resume").await?;
            let live = data(call(&owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
            assert_eq!(live["data"]["session"]["running"], true);
            assert!(live["data"]["session"]["hibernation"].is_null());

            let kinds: Vec<String> = session_events(&owner, &id)
                .await?
                .iter()
                .filter_map(|event| event["kind"].as_str())
                .filter(|kind| matches!(*kind, "session.hibernated" | "session.resumed"))
                .map(str::to_owned)
                .collect();
            assert_eq!(kinds, ["session.hibernated", "session.resumed"]);
            run_checkpoints::schema(vec![hibernated, resumed]).await?;
            waits::operation(
                &owner,
                "nesvo_stop_session",
                json!({"key":"stop-hibernation-worker","sessionId":id}),
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
