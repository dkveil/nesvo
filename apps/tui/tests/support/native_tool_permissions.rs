//! Explicit owner native permission additions, real SDK/CLI/host/PTY; no models.
use super::*;

fn actual(fixture: &Fixture, id: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.native-permissions.json")),
    )?)?)
}
fn caller(fixture: &Fixture, id: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?))
}
async fn effective(owner: &RunningService<RoleClient, ()>, id: &str) -> Result<Value> {
    let view = data(call(owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
    Ok(view["data"]["session"]["harness"]["nativePermissions"].clone())
}
async fn refused(client: &RunningService<RoleClient, ()>, args: Value, code: &str) -> Result<()> {
    let result = call(client, "nesvo_create_session", args).await?;
    assert_eq!(result.is_error, Some(true));
    let value = result
        .structured_content
        .context("native permission refusal")?;
    // Native launch validation happens after the durable operation identity.
    if value["error"]["receipt"].is_object() {
        assert_eq!(value["error"]["receipt"]["phase"], "failed");
        assert_eq!(value["error"]["receipt"]["result"]["code"], code);
        assert_eq!(value["error"]["receipt"]["result"]["effectStarted"], false);
    } else {
        assert_eq!(value["error"]["code"], code);
    }
    Ok(())
}
#[tokio::test]
#[ignore = "requires native binaries and Node; explicit owner tool policy with no model calls"]
async fn owner_native_permissions_are_literal_process_additions_not_child_or_host_authority()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        timeout(Duration::from_secs(10),async {
            loop {
                let report=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
                if report["providerVersions"].as_array().is_some_and(|rows|rows.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")){return Ok::<_,anyhow::Error>(());}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await??;
        let args=json!({"key":"explicit-native-policy","spec":{"name":"Owner approved coordinator","program":"claude","harness":true,"role":"coordinator","allowedNesvoTools":["nesvo_create_session"]}});
        let created=data(call(&owner,"nesvo_create_session",args.clone()).await?)?;
        let id=created["data"]["receipt"]["sessionId"].as_str().context("approved coordinator")?;
        session_ready(&owner,id).await?;
        assert_eq!(actual(&fixture,id)?,json!(["mcp__nesvo__nesvo_create_session"]));
        let settings=effective(&owner,id).await?;
        assert_eq!(settings["allow"],json!(["nesvo_create_session"]));
        assert_eq!(settings["source"],"ownerLaunch");
        assert_eq!(settings["scope"],"process");
        assert_eq!(settings["inheritedByChildren"],false);
        assert_eq!(settings["restrictsOtherTools"],false);
        assert_eq!(settings["providerRulesStillApply"],true);
        let same=data(call(&owner,"nesvo_create_session",args).await?)?;
        assert_eq!(same["data"]["receipt"]["id"],created["data"]["receipt"]["id"]);
        let coordinator=scoped_client(&caller(&fixture,id)?,id).await?;
        let child=data(call(&coordinator,"nesvo_create_session",json!({"key":"normal-child","spec":{"name":"Inherit harness only","program":"claude"}})).await?)?;
        let child_id=child["data"]["receipt"]["sessionId"].as_str().context("ordinary child")?;
        session_ready(&owner,child_id).await?;
        assert_eq!(effective(&owner,child_id).await?["allow"],json!([]));
        assert_eq!(effective(&owner,child_id).await?["source"],"none");
        assert_eq!(actual(&fixture,child_id)?,json!([]));
        for (index,tools) in [json!(["nesvo_get_session"]),json!([])].into_iter().enumerate() {
            refused(&coordinator,json!({"key":format!("cannot-grant-{index}"),"spec":{"name":"Forbidden permission grant","program":"claude","harness":true,"allowedNesvoTools":tools}}),"forbidden").await?;
        }
        let cli=budgets::owner_cli(&fixture,&["session","create","Owner approved worker","--key","cli-native-policy","--program","claude","--harness","--allow-nesvo-tool","nesvo_get_session","--allow-nesvo-tool","nesvo_create_session","--json"]).await?;
        let passive=cli["data"]["receipt"]["sessionId"].as_str().context("passive worker")?;
        session_ready(&owner,passive).await?;
        assert_eq!(actual(&fixture,passive)?,json!(["mcp__nesvo__nesvo_get_session","mcp__nesvo__nesvo_create_session"]));
        let worker=scoped_client(&caller(&fixture,passive)?,passive).await?;
        refused(&worker,json!({"key":"native-allow-is-not-host-authority","spec":{"name":"Not permitted to spawn","program":"claude"}}),"forbidden").await?;
        for (index,tools) in [json!(["*"]),json!(["mcp__nesvo__*"]),json!(["Bash"]),json!(["nesvo_unknown"]),json!(["nesvo_get_session","nesvo_get_session"])].into_iter().enumerate() {
            refused(&owner,json!({"key":format!("bad-policy-{index}"),"spec":{"name":"Invalid policy","program":"claude","harness":true,"allowedNesvoTools":tools}}),"invalid_argument").await?;
        }
        refused(&owner,json!({"key":"must-explicitly-enable-harness","spec":{"name":"No harness","program":"claude","allowedNesvoTools":["nesvo_get_session"]}}),"invalid_argument").await?;
        refused(&owner,json!({"key":"unsupported-program-policy","spec":{"name":"No shell policy","program":"shell","harness":true,"allowedNesvoTools":["nesvo_get_session"]}}),"unsupported").await?;
        let mut changed=json!({"key":"explicit-native-policy","spec":{"name":"Owner approved coordinator","program":"claude","harness":true,"role":"coordinator","allowedNesvoTools":["nesvo_get_session"]}});
        let conflict=call(&owner,"nesvo_create_session",changed.take()).await?.structured_content.context("policy key conflict")?;
        assert_eq!(conflict["error"]["code"],"idempotency_conflict");
        worker.cancel().await?;coordinator.cancel().await?;owner.cancel().await?;
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
