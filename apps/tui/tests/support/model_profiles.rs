use super::*;
fn argv(fixture: &Fixture, id: &str) -> Result<Vec<String>> {
    Ok(serde_json::from_slice(&std::fs::read(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.launch-argv.json")),
    )?)?)
}
fn has_pair(args: &[String], key: &str, value: &str) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == key && pair[1] == value)
}
async fn selection(owner: &RunningService<RoleClient, ()>, id: &str) -> Result<Value> {
    Ok(
        data(call(owner, "nesvo_get_session", json!({"sessionId":id})).await?)?["data"]["session"]
            ["launchProfile"]
            .clone(),
    )
}
#[tokio::test]
#[ignore = "requires native binaries and Node; captured per-process model arguments, no model calls"]
async fn model_profiles_are_literal_versioned_and_never_inherited_or_claimed_as_resolved()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        let owner=client(&fixture.pairing()).await?;
        timeout(Duration::from_secs(5),async {loop {
            let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
            if doctor["launchProfileSupport"].as_array().is_some_and(|rows|rows.iter().any(|r|r["program"]=="claude"&&r["supported"]==true)&&rows.iter().any(|r|r["program"]=="codex"&&r["supported"]==true)){return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(40)).await;
        }}).await??;
        let model="deployment łódź $(literal)";
        let created=budgets::owner_cli(&fixture,&["session","create","Explicit model coordinator","--key","native-model-profile","--program","claude","--role","coordinator","--harness","--model",model,"--effort","low","--json"]).await?;
        let id=created["data"]["receipt"]["sessionId"].as_str().context("model coordinator")?;
        session_ready(&owner,id).await?;
        let actual=argv(&fixture,id)?;assert!(has_pair(&actual,"--model",model));assert!(has_pair(&actual,"--effort","low"));
        let info=selection(&owner,id).await?;assert_eq!(info["requested"]["model"],model);assert_eq!(info["requested"]["effort"],"low");assert!(info["resolved"].is_null());assert_eq!(info["inheritedByChildren"],false);
        let replay=data(call(&owner,"nesvo_create_session",json!({"key":"native-model-profile","spec":{"name":"Explicit model coordinator","program":"claude","role":"coordinator","harness":true,"model":model,"effort":"low","worktree":false,"prompt":"","groupId":null}})).await?)?;
        assert_eq!(replay["data"]["receipt"]["id"],created["data"]["receipt"]["id"]);
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{id}.txt")))?);
        let coordinator=scoped_client(&context,id).await?;
        let child=data(call(&coordinator,"nesvo_create_session",json!({"key":"model-default-child","spec":{"name":"Provider defaults","program":"claude"}})).await?)?;
        let child=child["data"]["receipt"]["sessionId"].as_str().context("default child")?;session_ready(&owner,child).await?;
        assert!(!argv(&fixture,child)?.iter().any(|arg|arg=="--model"||arg=="--effort"));
        assert_eq!(selection(&owner,child).await?["source"],"providerDefaults");
        let codex=data(call(&owner,"nesvo_create_session",json!({"key":"codex-model-profile","spec":{"name":"Codex profile","program":"codex","model":"gpt-native-test","effort":"max"}})).await?)?;
        let codex=codex["data"]["receipt"]["sessionId"].as_str().context("Codex profile")?;session_ready(&owner,codex).await?;
        let actual=argv(&fixture,codex)?;assert!(has_pair(&actual,"--model","gpt-native-test"));assert!(has_pair(&actual,"-c","model_reasoning_effort=\"max\""));assert!(actual.iter().any(|arg|arg.starts_with("hooks=")));
        let run=data(call(&coordinator,"nesvo_create_run",json!({"key":"model-run","spec":{"title":"Model task","goal":"Explicit task profiles"}})).await?)?;
        let run=run["data"]["run"]["id"].as_str().context("model run")?;
        let plan=run_checkpoints::mutate(&coordinator,run,"nesvo_set_run_plan",json!({"key":"model-plan","tasks":[{"key":"test","title":"Model-selected worker","instruction":"Do not submit a native prompt"}]})).await?;
        run_checkpoints::mutate(&coordinator,run,"nesvo_activate_run",json!({"key":"model-activate"})).await?;
        let task=plan["tasks"][0]["id"].as_str().context("model task")?;
        let rev=run_checkpoints::view(&coordinator,run).await?["run"]["revision"].as_u64().context("launch revision")?.to_string();
        let launched=inbox::scoped_cli(&context,&["run","launch",run,"--task",task,"--key","model-task-once","--revision",&rev,"--program","claude","--shared","--harness","--model","sonnet","--effort","medium","--json"]).await?;
        let worker=launched["data"]["launch"]["sessionId"].as_str().context("model worker")?;session_ready(&owner,worker).await?;
        assert!(has_pair(&argv(&fixture,worker)?,"--model","sonnet"));assert!(has_pair(&argv(&fixture,worker)?,"--effort","medium"));
        for (index,spec) in [json!({"name":"Invalid model","program":"claude","model":"--permission-mode"}),json!({"name":"Invalid effort","program":"claude","model":"opus","effort":"ultracode"}),json!({"name":"Explicit model required","program":"codex","effort":"low"}),json!({"name":"No shell model","program":"shell","model":"test"})].into_iter().enumerate() {
            let refused=call(&owner,"nesvo_create_session",json!({"key":format!("invalid-model-{index}"),"spec":spec})).await?;assert_eq!(refused.is_error,Some(true));
        }
        let changed=call(&owner,"nesvo_create_session",json!({"key":"native-model-profile","spec":{"name":"Explicit model coordinator","program":"claude","role":"coordinator","harness":true,"model":model,"effort":"high","worktree":false,"prompt":"","groupId":null}})).await?;
        assert_eq!(changed.structured_content.context("changed model profile")?["error"]["code"],"idempotency_conflict");
        let snapshot=data(call(&owner,"nesvo_get_session",json!({"sessionId":id})).await?)?;
        let doctor=budgets::owner_cli(&fixture,&["doctor","--json"]).await?;
        let saved_id=id.to_owned();
        run_checkpoints::schema(vec![created,replay,launched,snapshot,doctor]).await?;
        coordinator.cancel().await?;owner.cancel().await?;
        fixture.restart(false).await?;
        let saved=recoveries(&fixture.pairing()).await?;
        let saved=saved.as_array().context("raw recovery profile records")?.iter().find(|record|record["id"]==saved_id).context("saved model selection")?;
        assert_eq!(saved["spec"]["model"],model);assert_eq!(saved["spec"]["effort"],"low");
        let owner=client(&fixture.pairing()).await?;
        let listed=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert!(listed["data"]["sessions"].as_array().context("empty restart sessions")?.is_empty());
        owner.cancel().await?;Ok::<_,anyhow::Error>(())
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
