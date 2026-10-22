use super::*;

type Owner = RunningService<RoleClient, ()>;
const FIRST_BRANCH: &str = "f31-initial";
const NEXT_BRANCH: &str = "f31-updated";
const PRODUCTION_CACHE_TTL: Duration = Duration::from_secs(30);
const NATIVE_BOUNDARY_AFTER_OBSERVED_RECEIPT: Duration = Duration::from_secs(31);

pub(super) async fn provider_ready(fixture: &Fixture) -> Result<()> {
    waits::provider(fixture, "claude")
        .await
        .context("Controlled fixture version before repository metadata acceptance")?;
    Ok(())
}

fn write_unborn_repository_without_running_git(repository: &Path) -> Result<()> {
    std::fs::create_dir_all(repository.join(".git/objects"))?;
    std::fs::create_dir_all(repository.join(".git/refs/heads"))?;
    std::fs::write(
        repository.join(".git/config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
    )?;
    std::fs::write(
        repository.join(".git/HEAD"),
        "ref: refs/heads/f31-initial\n",
    )?;
    Ok(())
}

async fn list(owner: &Owner) -> Result<Value> {
    let value = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    ensure!(
        value["schemaVersion"] == 1 && value["ok"] == true && value["data"]["type"] == "sessions",
        "Authenticated native sessions envelope"
    );
    Ok(value)
}

fn session<'a>(envelope: &'a Value, id: &str) -> Result<&'a Value> {
    let rows = envelope["data"]["sessions"]
        .as_array()
        .context("Actual session list")?;
    ensure!(
        rows.len() == 1,
        "One original controlled process; metadata must not duplicate sessions"
    );
    rows.iter()
        .find(|row| row["id"] == id)
        .context("Exact original session in native list")
}

fn baseline(row: &Value) -> Value {
    json!({"id":row["id"],"name":row["name"],"program":row["program"],"cwd":row["cwd"],
        "createdAt":row["createdAt"],"groupId":row["groupId"],"parentSessionId":row["parentSessionId"],
        "cols":row["cols"],"rows":row["rows"]})
}

fn assert_ready(context: &Value, repository: &str, branch: &str) {
    let fields = context
        .as_object()
        .expect("Actual repository metadata object");
    assert_eq!(fields.len(), 7, "Frozen additive repositoryContext DTO");
    for field in [
        "source",
        "state",
        "name",
        "branch",
        "observedAt",
        "revision",
        "root",
    ] {
        assert!(
            fields.contains_key(field),
            "Missing repository metadata field {field}"
        );
    }
    assert_eq!(context["source"], "launchDirectory");
    assert_eq!(context["state"], "ready");
    assert_eq!(context["name"], repository);
    assert_eq!(context["branch"], branch);
    let root = context["root"].as_str().expect("Repository root path");
    assert!(std::path::Path::new(root).is_absolute());
    assert_eq!(
        std::path::Path::new(root)
            .file_name()
            .and_then(|name| name.to_str()),
        Some(repository)
    );
    for field in ["observedAt", "revision"] {
        let value = context[field]
            .as_u64()
            .expect("Safe numeric repository metadata");
        assert!(value > 0 && value <= 9_007_199_254_740_991);
    }
}

fn assert_newer_revision_since_wall_clock_may_roll_back(refreshed: &Value, first: &Value) {
    assert!(refreshed["revision"].as_u64().unwrap() > first["revision"].as_u64().unwrap());
}

async fn ready_context(owner: &Owner, id: &str, repository: &str, branch: &str) -> Result<Value> {
    waits::until(async || {
        let listed = list(owner).await?;
        let row = session(&listed, id)?;
        let context = &row["repositoryContext"];
        if context["state"] == "ready" && context["branch"] == branch {
            assert_ready(context, repository, branch);
            return Ok(Some(listed));
        }
        ensure!(
            row["running"] != false,
            "Session {id} exited before repository metadata {branch}: {context}"
        );
        Ok(None)
    })
    .await
    .context("Native repository metadata refresh after explicit List")
}

#[tokio::test]
#[ignore = "real Git/private host/official SDK/controlled Node PTY; one production TTL, no models"]
async fn launch_repository_context_is_native_shared_and_refreshes_after_its_cooldown() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let mut owner = None;
    let mut owner_cleanup_uncertain = false;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(70),async {
        let original_host = fixture.host.id().context("Original isolated host PID")?;
        let repository = fixture.directory.join("repo-łódź");
        write_unborn_repository_without_running_git(&repository)?;
        let directory = repository.join("pakiety").join("żółć nested");
        std::fs::create_dir_all(&directory)?;
        let repository = repository.canonicalize()?;
        let directory = directory.canonicalize()?;
        let name = repository.file_name().and_then(|name|name.to_str()).context("Actual owned repository basename")?.to_owned();
        assert_eq!(std::fs::read_to_string(repository.join(".git/HEAD"))?.trim(),"ref: refs/heads/f31-initial");
        assert!(!repository.join(".git/refs/heads/f31-initial").exists());

        owner_cleanup_uncertain = true;
        provider_ready(&fixture).await?;
        owner = Some(client(&fixture.pairing()).await?);
        owner_cleanup_uncertain = false;
        let caller = owner.as_ref().context("Owned SDK client")?;
        let empty = list(caller).await?;
        assert!(empty["data"]["sessions"].as_array().context("Fresh isolated host session list")?.is_empty());
        let before_any_possible_inspection = tokio::time::Instant::now();
        let created = data(call(caller,"nesvo_create_session",json!({
            "key":"repository-context-native","spec":{"name":"Repository context fixture",
                "program":"claude","cwd":directory,"harness":false}
        })).await?)?;
        let id = created["data"]["receipt"]["sessionId"].as_str().context("Original controlled session identity")?.to_owned();
        assert_eq!(created["data"]["receipt"]["phase"],"created");
        let physical = data(call(caller,"nesvo_get_session",json!({"sessionId":id})).await?)?;
        let initial = &physical["data"]["session"];
        let original = baseline(initial);
        let pid = initial["lifecycle"]["process"]["pid"].as_u64().context("Original actual controlled PID")?;
        assert!(pid > 0);
        assert_eq!(initial["running"],true);
        assert_eq!(initial["name"],"Repository context fixture");
        assert_eq!(initial["program"],"claude");
        assert_eq!(Path::new(initial["cwd"].as_str().context("Actual native cwd")?).canonicalize()?,directory);

        let first = ready_context(caller,&id,&name,FIRST_BRANCH).await?;
        let received = tokio::time::Instant::now();
        let first_context = session(&first,&id)?["repositoryContext"].clone();
        assert_ready(&first_context,&name,FIRST_BRANCH);
        assert_eq!(baseline(session(&first,&id)?),original,"Optional metadata preserves legacy session fields");

        std::fs::write(repository.join(".git/HEAD"),"ref: refs/heads/f31-updated\n")?;
        let cached = list(caller).await?;
        owner_cleanup_uncertain = true;
        let cached_cli = budgets::owner_cli(&fixture,&["session","list","--json"]).await?;
        owner_cleanup_uncertain = false;
        ensure!(before_any_possible_inspection.elapsed() < PRODUCTION_CACHE_TTL,"Both cached observations must finish before the earliest possible production TTL boundary");
        assert_eq!(session(&cached,&id)?["repositoryContext"],first_context);
        assert_eq!(session(&cached_cli,&id)?["repositoryContext"],first_context,"CLI and MCP share the host cache");
        assert_eq!(baseline(session(&cached_cli,&id)?),original);
        owner_cleanup_uncertain = true;
        owner.take().context("Disconnect first owner SDK client")?.cancel().await?;
        owner_cleanup_uncertain = false;

        tokio::time::sleep_until(received+NATIVE_BOUNDARY_AFTER_OBSERVED_RECEIPT).await;
        owner_cleanup_uncertain = true;
        owner = Some(client(&fixture.pairing()).await?);
        owner_cleanup_uncertain = false;
        let caller = owner.as_ref().context("Reconnected owner SDK client")?;
        let refreshed = ready_context(caller,&id,&name,NEXT_BRANCH).await?;
        let refreshed_context = &session(&refreshed,&id)?["repositoryContext"];
        assert_ready(refreshed_context,&name,NEXT_BRANCH);
        assert_newer_revision_since_wall_clock_may_roll_back(refreshed_context,&first_context);
        owner_cleanup_uncertain = true;
        let refreshed_cli = budgets::owner_cli(&fixture,&["session","list","--json"]).await?;
        owner_cleanup_uncertain = false;
        assert_eq!(session(&refreshed_cli,&id)?["repositoryContext"],*refreshed_context);
        assert_eq!(baseline(session(&refreshed,&id)?),original);
        assert_eq!(baseline(session(&refreshed_cli,&id)?),original);
        let survived = data(call(caller,"nesvo_get_session",json!({"sessionId":id})).await?)?;
        assert_eq!(survived["data"]["session"]["running"],true);
        assert_eq!(survived["data"]["session"]["lifecycle"]["process"]["pid"],pid);
        assert_eq!(baseline(&survived["data"]["session"]),original);
        let receipt = data(call(caller,"nesvo_get_operation",json!({"id":created["data"]["receipt"]["id"]})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["phase"],"created");
        assert_eq!(receipt["data"]["receipt"]["sessionId"],id);
        assert_eq!(fixture.host.id(),Some(original_host));
        assert!(fixture.host.try_wait()?.is_none(),"Original host survives owner reconnect");
        owner_cleanup_uncertain = true;
        run_checkpoints::schema(vec![empty,created,physical,first,cached,cached_cli,refreshed,refreshed_cli,survived,receipt]).await?;
        owner_cleanup_uncertain = false;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;

    let owner_cleanup = match owner.take() {
        Some(owner) => owner
            .cancel()
            .await
            .map(|_| ())
            .context("Owned metadata SDK cleanup"),
        None => Ok(()),
    };
    owner_cleanup_uncertain |= owner_cleanup.is_err();
    let fixture_cleanup = if owner_cleanup_uncertain {
        eprintln!("REPOSITORY_CONTEXT_FIXTURE_PRESERVED");
        fixture.stop().await
    } else {
        fixture.close().await
    };
    match outcome {
        Ok(result) => {
            owner_cleanup?;
            fixture_cleanup?;
            result??;
            Ok(())
        }
        Err(panic) => {
            if owner_cleanup.is_err() || fixture_cleanup.is_err() {
                eprintln!("REPOSITORY_CONTEXT_FIXTURE_CLEANUP_UNCONFIRMED");
            }
            std::panic::resume_unwind(panic)
        }
    }
}
