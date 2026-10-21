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

#[tokio::test]
#[ignore = "native binaries and Node; owner child policy stays scoped to authenticated direct Claude children"]
async fn owner_child_tool_policy_is_explicit_process_scoped_and_never_delegates_host_roles()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        timeout(Duration::from_secs(5),async{loop {
            let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
            if doctor["providerVersions"].as_array().is_some_and(|rows|rows.iter().any(|v|v["program"]=="claude"&&v["status"]=="ready")){return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(40)).await;
        }}).await.context("Child policy provider readiness")??;
        let created=budgets::owner_cli(&fixture,&["session","create","Owner child policy","--key","owner-child-policy","--program","claude","--role","coordinator","--harness","--allow-nesvo-tool","nesvo_create_session","--allow-child-nesvo-tool","nesvo_get_current_task","--allow-child-nesvo-tool","nesvo_report_task_result","--allow-child-nesvo-tool","nesvo_create_session","--json"]).await?;
        let id=created["data"]["receipt"]["sessionId"].as_str().context("policy coordinator")?;session_ready(&owner,id).await?;
        let policy=json!(["nesvo_get_current_task","nesvo_report_task_result","nesvo_create_session"]);
        let root=data(call(&owner,"nesvo_get_session",json!({"sessionId":id})).await?)?;
        assert_eq!(root["data"]["session"]["harness"]["childToolPolicy"]["allow"],policy);
        assert_eq!(actual(&fixture,id)?,json!(["mcp__nesvo__nesvo_create_session"]),"The child policy must not expand the coordinator's own allow list");
        let coordinator=scoped_client(&caller(&fixture,id)?,id).await?;
        let child=data(call(&coordinator,"nesvo_create_session",json!({"key":"derived-policy-child","spec":{"name":"Derived policy child","program":"claude"}})).await?)?;
        let child_id=child["data"]["receipt"]["sessionId"].as_str().context("derived policy child")?;session_ready(&owner,child_id).await?;
        let configured=effective(&owner,child_id).await?;
        assert_eq!(configured["allow"],policy);assert_eq!(configured["source"],"ownerChildPolicy");assert_eq!(configured["originSessionId"],id);
        assert_eq!(actual(&fixture,child_id)?,json!(["mcp__nesvo__nesvo_get_current_task","mcp__nesvo__nesvo_report_task_result","mcp__nesvo__nesvo_create_session"]));
        let child_view=data(call(&owner,"nesvo_get_session",json!({"sessionId":child_id})).await?)?;
        assert_eq!(child_view["data"]["session"]["harness"]["childToolPolicy"]["allow"],json!([]));
        let worker=scoped_client(&caller(&fixture,child_id)?,child_id).await?;
        refused_before_or_after_durable_identity(&worker,json!({"key":"child-policy-is-not-a-role","spec":{"name":"Forbidden grandchild","program":"claude"}}),"forbidden").await?;
        for field in ["allowedNesvoTools","childAllowedNesvoTools"] {
            let mut spec=json!({"name":"Cannot replace policy","program":"claude"});spec[field]=json!([]);
            refused_before_or_after_durable_identity(&coordinator,json!({"key":format!("cannot-replace-{field}"),"spec":spec}),"forbidden").await?;
        }
        let metadata=data(call(&owner,"nesvo_create_session",json!({"key":"metadata-is-not-delegation","spec":{"name":"Owner metadata child","program":"claude","harness":true,"parentSessionId":id}})).await?)?;
        let metadata=metadata["data"]["receipt"]["sessionId"].as_str().context("metadata child")?;session_ready(&owner,metadata).await?;
        assert_eq!(actual(&fixture,metadata)?,json!([]));assert_eq!(effective(&owner,metadata).await?["source"],"none");
        let opted=data(call(&coordinator,"nesvo_create_session",json!({"key":"explicit-tools-optout","spec":{"name":"No harness tools","program":"claude","harness":false}})).await?)?;
        let opted=opted["data"]["receipt"]["sessionId"].as_str().context("opted out child")?;session_ready(&owner,opted).await?;
        assert_eq!(actual(&fixture,opted)?,json!([]));
        let run=data(call(&coordinator,"nesvo_create_run",json!({"key":"child-policy-task-run","spec":{"title":"Delegated task tools","goal":"Owner policy stays separate from worker authority"}})).await?)?;
        let run=run["data"]["run"]["id"].as_str().context("policy run")?;
        let plan=run_checkpoints::mutate(&coordinator,run,"nesvo_set_run_plan",json!({"key":"child-policy-task-plan","tasks":[{"key":"work","title":"Bound policy worker","instruction":"No native prompt is submitted by this fixture"}]})).await?;
        run_checkpoints::mutate(&coordinator,run,"nesvo_activate_run",json!({"key":"child-policy-task-activate"})).await?;
        let launch=run_checkpoints::mutate(&owner,run,"nesvo_launch_task",json!({"key":"owner-executor-delegation","taskId":plan["tasks"][0]["id"],"profile":{"program":"claude","workspace":"shared","harness":true}})).await?;
        let task_worker=launch["launch"]["sessionId"].as_str().context("policy task worker")?;session_ready(&owner,task_worker).await?;
        assert_eq!(effective(&owner,task_worker).await?["source"],"ownerChildPolicy");
        assert_eq!(effective(&owner,task_worker).await?["originSessionId"],id);
        assert_eq!(actual(&fixture,task_worker)?,actual(&fixture,child_id)?);
        let other=data(call(&owner,"nesvo_create_session",json!({"key":"another-coordinator-policy","spec":{"name":"Another owner policy","program":"claude","role":"coordinator","harness":false,"childAllowedNesvoTools":["nesvo_get_session"]}})).await?)?;
        let other_id=other["data"]["receipt"]["sessionId"].as_str().context("other coordinator")?;session_ready(&owner,other_id).await?;
        let other_client=scoped_client(&caller(&fixture,other_id)?,other_id).await?;
        let other_child=data(call(&other_client,"nesvo_create_session",json!({"key":"other-derived-child","spec":{"name":"Other policy child","program":"claude","harness":true}})).await?)?;
        let other_child=other_child["data"]["receipt"]["sessionId"].as_str().context("other child")?;session_ready(&owner,other_child).await?;
        assert_eq!(actual(&fixture,other_child)?,json!(["mcp__nesvo__nesvo_get_session"]));assert_eq!(effective(&owner,other_child).await?["originSessionId"],other_id);
        refused_before_or_after_durable_identity(&other_client,json!({"key":"cannot-select-another-parent-policy","spec":{"name":"Forged policy origin","program":"claude","harness":true,"parentSessionId":id}}),"forbidden").await?;
        let shell=data(call(&coordinator,"nesvo_create_session",json!({"key":"policy-does-not-affect-shell","spec":{"name":"Passive shell child","program":"shell","harness":false}})).await?)?;
        let shell=shell["data"]["receipt"]["sessionId"].as_str().context("passive policy shell")?;
        assert_eq!(effective(&owner,shell).await?["allow"],json!([]));
        refused_before_or_after_durable_identity(&owner,json!({"key":"worker-cannot-declare-child-policy","spec":{"name":"Wrong role","program":"claude","harness":true,"childAllowedNesvoTools":[]}}),"invalid_argument").await?;
        refused_before_or_after_durable_identity(&owner,json!({"key":"no-wildcard-child-policy","spec":{"name":"Wrong policy","program":"claude","role":"coordinator","childAllowedNesvoTools":["*"]}}),"invalid_argument").await?;
        let saved_id=id.to_owned();
        run_checkpoints::schema(vec![created,root,child,child_view]).await?;
        other_client.cancel().await?;worker.cancel().await?;coordinator.cancel().await?;owner.cancel().await?;
        fixture.restart(false).await?;
        let saved=recoveries(&fixture.pairing()).await?;
        let saved=saved.as_array().context("raw recovery policy records")?.iter().find(|record|record["id"]==saved_id).context("saved coordinator")?;
        assert!(saved["spec"].get("allowedNesvoTools").is_none());assert!(saved["spec"].get("childAllowedNesvoTools").is_none(),"Process recovery must not silently restore native delegation");
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
async fn refused_before_or_after_durable_identity(
    client: &RunningService<RoleClient, ()>,
    args: Value,
    code: &str,
) -> Result<()> {
    let result = call(client, "nesvo_create_session", args).await?;
    assert_eq!(result.is_error, Some(true));
    let value = result
        .structured_content
        .context("native permission refusal")?;
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
            refused_before_or_after_durable_identity(&coordinator,json!({"key":format!("cannot-grant-{index}"),"spec":{"name":"Forbidden permission grant","program":"claude","harness":true,"allowedNesvoTools":tools}}),"forbidden").await?;
        }
        let cli=budgets::owner_cli(&fixture,&["session","create","Owner approved worker","--key","cli-native-policy","--program","claude","--harness","--allow-nesvo-tool","nesvo_get_session","--allow-nesvo-tool","nesvo_create_session","--json"]).await?;
        let passive=cli["data"]["receipt"]["sessionId"].as_str().context("passive worker")?;
        session_ready(&owner,passive).await?;
        assert_eq!(actual(&fixture,passive)?,json!(["mcp__nesvo__nesvo_get_session","mcp__nesvo__nesvo_create_session"]));
        let worker=scoped_client(&caller(&fixture,passive)?,passive).await?;
        refused_before_or_after_durable_identity(&worker,json!({"key":"native-allow-is-not-host-authority","spec":{"name":"Not permitted to spawn","program":"claude"}}),"forbidden").await?;
        for (index,tools) in [json!(["*"]),json!(["mcp__nesvo__*"]),json!(["Bash"]),json!(["nesvo_unknown"]),json!(["nesvo_get_session","nesvo_get_session"])].into_iter().enumerate() {
            refused_before_or_after_durable_identity(&owner,json!({"key":format!("bad-policy-{index}"),"spec":{"name":"Invalid policy","program":"claude","harness":true,"allowedNesvoTools":tools}}),"invalid_argument").await?;
        }
        refused_before_or_after_durable_identity(&owner,json!({"key":"must-explicitly-enable-harness","spec":{"name":"No harness","program":"claude","allowedNesvoTools":["nesvo_get_session"]}}),"invalid_argument").await?;
        refused_before_or_after_durable_identity(&owner,json!({"key":"unsupported-program-policy","spec":{"name":"No shell policy","program":"shell","harness":true,"allowedNesvoTools":["nesvo_get_session"]}}),"unsupported").await?;
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
