use super::*;
use prechecks::{OwnedTree, TREE_EXIT_DEADLINE};
use provider_quota::{
    configure_source, context_query, context_refresh, context_revision, row, snapshot,
};

type Owner = RunningService<RoleClient, ()>;

const LITERAL: &str = "literal $(x); & łódź \"quoted\"";

struct Owned {
    directory: PathBuf,
    executable: PathBuf,
}

fn owned(f: &Fixture, name: &str) -> Result<Owned> {
    let directory = f.directory.join(name);
    std::fs::create_dir(&directory)
        .with_context(|| format!("Create owned shutdown directory: {}", directory.display()))?;
    let executable = directory.join(if cfg!(windows) {
        "shutdown-node.exe"
    } else {
        "shutdown-node"
    });
    let node = f
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    std::fs::copy(&node, &executable)
        .with_context(|| format!("Copy owned command image: {}", executable.display()))?;
    Ok(Owned {
        directory,
        executable,
    })
}

async fn approve(
    owner: &Owner,
    owned: &Owned,
    mode: &str,
    environment: Value,
) -> Result<(Value, PathBuf, Vec<Value>)> {
    let script = owned.directory.join("precheck łódź.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )
    .with_context(|| format!("Write owned precheck script: {}", script.display()))?;
    let effects = owned.directory.join(format!("check-{mode}"));
    let spec = json!({"title":format!("Shutdown {mode}"),"executable":owned.executable,"cwd":owned.directory,
        "arguments":[script,mode,effects,"root",LITERAL],"timeoutMs":10000,"environment":environment});
    let described = data(call(owner, "nesvo_describe_precheck", json!({"spec":spec})).await?)?;
    let digest = described["data"]["precheckDescription"]["digest"]
        .as_str()
        .context("Owned shutdown precheck digest")?
        .to_owned();
    let approved = data(
        call(
            owner,
            "nesvo_approve_precheck",
            json!({"key":format!("approve-shutdown-{mode}"),"spec":spec,"expectedDigest":digest}),
        )
        .await?,
    )?;
    Ok((
        approved["data"]["precheckApproval"].clone(),
        effects,
        vec![described, approved],
    ))
}

async fn create(owner: &Owner, key: &str, spec: Value) -> Result<(String, Value)> {
    let created = data(
        call(
            owner,
            "nesvo_create_job",
            json!({"key":format!("definition:{key}"),"spec":spec}),
        )
        .await?,
    )?;
    let job = created["data"]["job"]["id"]
        .as_str()
        .context("Shutdown job identity")?
        .to_owned();
    Ok((job, created))
}

async fn run_now(owner: &Owner, job: &str, key: &str) -> Result<(String, Value)> {
    let admitted = data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({"key":key,"jobId":job,"expectedRevision":1}),
        )
        .await?,
    )?;
    let occurrence = admitted["data"]["occurrence"]["id"]
        .as_str()
        .context("Shutdown occurrence identity")?
        .to_owned();
    Ok((occurrence, admitted))
}

async fn occurrence(owner: &Owner, job: &str, id: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_occurrence",
            json!({"jobId":job,"occurrenceId":id}),
        )
        .await?,
    )
}

async fn occurrence_until(
    owner: &Owner,
    job: &str,
    id: &str,
    wanted: &str,
    reached: impl Fn(&Value) -> bool,
) -> Result<Value> {
    waits::until(async || {
        let view = occurrence(owner, job, id).await?;
        let current = &view["data"]["occurrence"];
        if reached(current) {
            return Ok(Some(view));
        }
        ensure!(
            !waits::is_settled_occurrence(&current["state"]),
            "Shutdown occurrence settled before {wanted}: {view}"
        );
        Ok(None)
    })
    .await
    .with_context(|| format!("Shutdown occurrence did not reach {wanted}"))
}

fn remove_immediately(directory: &Path) -> Result<()> {
    std::fs::remove_dir_all(directory).with_context(|| {
        format!(
            "Remove a directory used by native work right after graceful host exit: {}",
            directory.display()
        )
    })
}

#[tokio::test]
#[ignore = "graceful stop with an owned precheck tree, a parked dispatch and a shell; restart retry classification; no models"]
async fn graceful_stop_records_host_stopping_settles_native_jobs_and_retries_after_restart()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let quota_directory = f.directory.join("shutdown quota context");
        std::fs::create_dir(&quota_directory)?;
        let quota_key = quota_directory
            .to_str()
            .context("Owned quota directory")?
            .to_owned();
        let mut contexts = serde_json::Map::new();
        contexts.insert(
            quota_key.clone(),
            json!({"mode":"snapshot","result":snapshot()}),
        );
        configure_source(&f, json!({"mode":"snapshot","result":snapshot(),"contexts":contexts}))?;
        context_query(&owner, &quota_directory, false).await?;
        let base = context_revision(&owner, &quota_directory, 1).await?;
        let binding = row(&base)?.clone();
        assert_eq!(binding["ordinaryUsageEligible"], true);

        let shell = f.directory.join("shutdown shell łódź");
        std::fs::create_dir(&shell)?;
        let created = waits::operation(&owner,"nesvo_create_session",json!({"key":"shutdown-shell",
            "spec":{"name":"Shutdown shell","program":"shell","cwd":shell}})).await?;
        let shell_id = created["data"]["receipt"]["sessionId"]
            .as_str()
            .context("Shutdown shell session")?
            .to_owned();
        ensure!(
            !waits::exited(&owner, &shell_id).await?,
            "The owned shell must still run when the host stops"
        );

        let hold = owned(&f, "shutdown hold")?;
        let (hold_approval, hold_effects, mut envelopes) =
            approve(&owner, &hold, "hold", json!({"CHECK_LITERAL":LITERAL})).await?;
        let (parked_job, parked_definition) = create(&owner, "shutdown-parked", json!({
            "title":"Dispatch parked by quota at shutdown","instruction":"report-task",
            "profile":{"program":"codex","workspace":"shared","cwd":quota_directory},
            "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
            "quotaPolicy":{"mode":"wait","contextId":binding["contextId"],"accountFingerprint":binding["accountFingerprint"]},
            "precheckId":hold_approval["id"],
            "retry":{"on":"launchNoEffect","maxAttempts":2,"initialDelayMs":1000,"maxDelayMs":1000}
        })).await?;

        let tree_directory = owned(&f, "shutdown tree łódź")?;
        let mut tree = OwnedTree::bind().await?;
        let (tree_approval, _, approvals) =
            approve(&owner, &tree_directory, "tree-shutdown", tree.environment()?).await?;
        envelopes.extend(approvals);
        let (tree_job, tree_definition) = create(&owner, "shutdown-tree", json!({
            "title":"Precheck tree at shutdown","instruction":"report-task",
            "profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
            "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
            "precheckId":tree_approval["id"]
        })).await?;

        let (parked, parked_admitted) = run_now(&owner, &parked_job, "shutdown-parked").await?;
        occurrence_until(&owner, &parked_job, &parked, "a running hold precheck", |current| {
            current["precheck"]["state"] == "running"
        })
        .await?;
        let mut denied = snapshot();
        denied["ordinaryUsageAllowed"] = json!(false);
        let mut contexts = serde_json::Map::new();
        contexts.insert(quota_key, json!({"mode":"snapshot","result":denied}));
        configure_source(&f, json!({"mode":"snapshot","result":snapshot(),"contexts":contexts}))?;
        let refreshed = context_refresh(&owner, &quota_directory).await?;
        let target = refreshed["data"]["refresh"]["revision"]
            .as_u64()
            .context("Denied quota refresh revision")?;
        let denial = context_revision(&owner, &quota_directory, target).await?;
        assert_eq!(row(&denial)?["ordinaryUsageEligible"], false);
        occurrence_until(&owner, &parked_job, &parked, "a quota wait", |current| {
            current["quota"]["state"] == "waiting"
        })
        .await?;
        std::fs::write(hold_effects.join("release"), "explicit fixture release")?;
        let in_flight = occurrence_until(
            &owner,
            &parked_job,
            &parked,
            "a dispatch parked after its passed precheck",
            |current| {
                current["state"] == "dispatching"
                    && current["precheck"]["state"] == "passed"
                    && current["quota"]["state"] == "waiting"
            },
        )
        .await?;
        assert!(in_flight["data"]["occurrence"]["sessionId"].is_null());

        let (tree_occurrence, tree_admitted) = run_now(&owner, &tree_job, "shutdown-tree").await?;
        tokio::select! {
            announced = tree.announced() => announced.context("Owned three-level precheck tree readiness")?,
            settled = occurrence_until(&owner, &tree_job, &tree_occurrence, "an announced precheck tree", |_| false) => {
                settled?;
            }
        }
        let tree_running = occurrence(&owner, &tree_job, &tree_occurrence).await?;
        assert_eq!(
            tree_running["data"]["occurrence"]["precheck"]["state"],
            "running"
        );
        owner.cancel().await?;

        drop(f.host.stdin.take());
        let status = f
            .host
            .wait()
            .await
            .context("Graceful owned host exit with native work in flight")?;
        ensure!(
            status.success(),
            "Graceful host stop must exit successfully: {status}"
        );
        for directory in [&shell, &hold.directory, &tree_directory.directory] {
            remove_immediately(directory)?;
        }
        timeout(TREE_EXIT_DEADLINE, tree.exited())
            .await
            .context("Every owned precheck tree member ended")??;

        f.restart(false).await?;
        let owner = client(&f.pairing()).await?;
        let stopped = occurrence(&owner, &parked_job, &parked).await?;
        let current = &stopped["data"]["occurrence"];
        assert_eq!(current["state"], "retryWaiting", "{stopped}");
        assert!(current["finishedAt"].is_null());
        assert_eq!(current["precheck"]["state"], "passed");
        let generations = data(
            call(
                &owner,
                "nesvo_get_job_attempts",
                json!({"jobId":parked_job,"occurrenceId":parked}),
            )
            .await?,
        )?;
        let attempts = generations["data"]["jobAttempts"]
            .as_array()
            .context("Parked dispatch generations")?;
        assert_eq!(attempts.len(), 1, "{generations}");
        let source = &attempts[0];
        assert_eq!(source["state"], "reconcile");
        assert_eq!(source["reason"], "host_stopping");
        assert_eq!(source["retryClassification"]["class"], "uncertainEffect");
        assert_eq!(source["retryClassification"]["failure"], "host_restarted");
        for field in ["sessionId", "attemptId", "launchReceiptId"] {
            assert!(
                source[field].is_null(),
                "The parked dispatch never launched: {field} in {generations}"
            );
        }

        let refused = occurrence(&owner, &tree_job, &tree_occurrence).await?;
        let current = &refused["data"]["occurrence"];
        assert_eq!(current["state"], "failed");
        assert_eq!(current["reason"], "precheck_refused");
        assert_eq!(current["precheck"]["reason"], "host_shutdown");
        assert_eq!(current["precheck"]["result"]["cleanupConfirmed"], true);

        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        ensure!(
            sessions["data"]["sessions"]
                .as_array()
                .is_some_and(|sessions| sessions.iter().all(|s| s["running"] == false)),
            "No native session survives or is relaunched by restart recovery: {sessions}"
        );
        envelopes.extend([
            base,
            created,
            parked_definition,
            tree_definition,
            parked_admitted,
            refreshed,
            denial,
            in_flight,
            tree_admitted,
            tree_running,
            stopped,
            generations,
            refused,
            sessions,
        ]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = f.close().await;
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
