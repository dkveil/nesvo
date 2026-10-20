//! Real owner CLI/MCP, native timer, bounded command scopes and fake provider.
use super::*;
const LITERAL: &str = "literal $(x); & łódź \"quoted\"";
fn node(f: &Fixture) -> PathBuf {
    f.directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}
async fn approve(
    f: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    timeout_ms: u64,
) -> Result<(Value, PathBuf)> {
    let script = f.directory.join("precheck łódź.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )?;
    let directory = f.directory.join(format!("check-{mode}"));
    std::fs::create_dir_all(&directory)?;
    let spec = json!({"title":format!("Check {mode}"),"executable":node(f),"cwd":f.directory,"arguments":[script,mode,directory,"root",LITERAL],"timeoutMs":timeout_ms,"environment":{"CHECK_LITERAL":LITERAL}});
    let file = f.directory.join(format!("approve-{mode}.json"));
    std::fs::write(&file, serde_json::to_vec(&spec)?)?;
    let described = budgets::owner_cli(
        f,
        &[
            "job",
            "precheck",
            "describe",
            "--file",
            file.to_str().context("command file")?,
            "--json",
        ],
    )
    .await?;
    assert_eq!(
        described["data"]["precheckDescription"]["trust"],
        "notApproved"
    );
    let described_mcp = data(call(owner, "nesvo_describe_precheck", json!({"spec":spec})).await?)?;
    assert_eq!(
        described_mcp["data"]["precheckDescription"],
        described["data"]["precheckDescription"]
    );
    let digest = described["data"]["precheckDescription"]["digest"]
        .as_str()
        .context("command digest")?;
    let key = format!("approve-{mode}");
    let approved = budgets::owner_cli(
        f,
        &[
            "job",
            "precheck",
            "approve",
            "--file",
            file.to_str().context("command file")?,
            "--key",
            &key,
            "--digest",
            digest,
            "--json",
        ],
    )
    .await?;
    let replay = data(
        call(
            owner,
            "nesvo_approve_precheck",
            json!({"key":key,"spec":spec,"expectedDigest":digest}),
        )
        .await?,
    )?;
    assert_eq!(replay["data"], approved["data"]);
    run_checkpoints::schema(vec![described, described_mcp, approved.clone(), replay]).await?;
    Ok((approved["data"]["precheckApproval"].clone(), directory))
}
async fn create(
    owner: &RunningService<RoleClient, ()>,
    key: &str,
    approval: Option<&Value>,
    due: chrono::DateTime<chrono::Utc>,
) -> Result<Value> {
    let mut spec = json!({"title":key,"instruction":"report-task","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":due.to_rfc3339()},"misfire":"skip"});
    if let Some(approval) = approval {
        spec["precheckId"] = approval["id"].clone();
    }
    Ok(data(
        call(
            owner,
            "nesvo_create_job",
            json!({"key":format!("definition:{key}"),"spec":spec}),
        )
        .await?,
    )?["data"]["job"]
        .clone())
}
async fn now(owner: &RunningService<RoleClient, ()>, job: &Value, key: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({"key":key,"jobId":job["id"],"expectedRevision":job["revision"]}),
        )
        .await?,
    )
}
async fn state(owner: &RunningService<RoleClient, ()>, job: &Value, wanted: &str) -> Result<Value> {
    timeout(Duration::from_secs(20), async {
        loop {
            let history =
                data(call(owner, "nesvo_get_job_history", json!({"jobId":job["id"]})).await?)?;
            if let Some(id) = history["data"]["occurrences"]
                .as_array()
                .and_then(|rows| rows.iter().find(|r| r["state"] == wanted))
                .and_then(|r| r["id"].as_str())
            {
                return data(
                    call(
                        owner,
                        "nesvo_get_job_occurrence",
                        json!({"jobId":job["id"],"occurrenceId":id}),
                    )
                    .await?,
                );
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    })
    .await
    .context("Precheck occurrence outcome")?
}
async fn no_model(owner: &RunningService<RoleClient, ()>) -> Result<()> {
    let sessions = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    ensure!(
        sessions["data"]["sessions"]
            .as_array()
            .is_some_and(|s| s.is_empty()),
        "Precheck must not create a provider session: {sessions}"
    );
    Ok(())
}
async fn tree_ready(directory: &Path) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            if ["root", "child", "grandchild"]
                .iter()
                .all(|name| directory.join(format!("{name}.json")).exists())
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context("Owned three-level command tree readiness")?
}
async fn tree_gone(f: &Fixture, directory: &Path) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            let mut command = Command::new(node(f));
            command
                .arg(f.directory.join("precheck łódź.cjs"))
                .arg("probe")
                .arg(directory);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let output = command.output().await?;
            ensure!(
                output.status.success(),
                "Process observation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let view: Value = serde_json::from_slice(&output.stdout)?;
            if view["running"]
                .as_array()
                .is_some_and(|states| states.len() == 3 && states.iter().all(|v| v == false))
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("All ordinary owned command descendants exited")?
}

#[tokio::test]
#[ignore = "native host/client/Node; explicit command trust, skip/refusal/pass and no model on failure"]
async fn owner_prechecks_skip_fail_revoke_and_pass_before_native_dispatch() -> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let (skip, directory) = approve(&f, &owner, "skip", 2000).await?;
        let due = chrono::Utc::now() + chrono::Duration::seconds(5);
        let job = create(&owner, "disconnected-skip", Some(&skip), due).await?;
        owner.cancel().await?;
        let ready = timeout(Duration::from_secs(12), async {
            loop {
                if directory.join("effects.log").exists() {
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        let owner = client(&f.pairing()).await?;
        if ready.is_err() {
            let history =
                data(call(&owner, "nesvo_get_job_history", json!({"jobId":job["id"]})).await?)?;
            let id = &history["data"]["occurrences"][0]["id"];
            let detail = data(
                call(
                    &owner,
                    "nesvo_get_job_occurrence",
                    json!({"jobId":job["id"],"occurrenceId":id}),
                )
                .await?,
            )?;
            anyhow::bail!("Precheck did not execute before timeout; retained detail: {detail}");
        }
        ready??;
        let skipped = state(&owner, &job, "skipped").await?;
        let o = &skipped["data"]["occurrence"];
        assert_eq!(o["reason"], "precheck_skip");
        assert!(o["runId"].is_null());
        assert_eq!(o["precheck"]["result"]["exitCode"], 10);
        assert_eq!(o["precheck"]["result"]["cleanupConfirmed"], true);
        assert!(
            !o["precheck"]["result"]["stdout"]
                .as_str()
                .context("retained stdout")?
                .contains('\u{1b}')
        );
        no_model(&owner).await?;
        for mode in ["fail", "flood"] {
            let (approval, _) = approve(&f, &owner, mode, 3000).await?;
            let job = create(
                &owner,
                mode,
                Some(&approval),
                chrono::Utc::now() + chrono::Duration::hours(1),
            )
            .await?;
            now(&owner, &job, mode).await?;
            let failed = state(&owner, &job, "failed").await?;
            assert!(failed["data"]["occurrence"]["runId"].is_null());
            assert_eq!(
                failed["data"]["occurrence"]["precheck"]["state"],
                if mode == "fail" {
                    "failed"
                } else {
                    "outputLimit"
                }
            );
            run_checkpoints::schema(vec![failed]).await?;
            no_model(&owner).await?;
        }
        let (revoked, revoked_dir) = approve(&f, &owner, "revoked", 2000).await?;
        let job = create(
            &owner,
            "revoked-job",
            Some(&revoked),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let revoked_id = revoked["id"].as_str().context("approval ID")?;
        let off = budgets::owner_cli(
            &f,
            &[
                "job",
                "precheck",
                "revoke",
                revoked_id,
                "--key",
                "revoke",
                "--revision",
                "1",
                "--json",
            ],
        )
        .await?;
        let off_mcp = data(
            call(
                &owner,
                "nesvo_revoke_precheck",
                json!({"key":"revoke","id":revoked_id,"expectedRevision":1}),
            )
            .await?,
        )?;
        assert_eq!(off_mcp["data"], off["data"]);
        now(&owner, &job, "after-revoke").await?;
        let refused = state(&owner, &job, "failed").await?;
        assert_eq!(
            refused["data"]["occurrence"]["reason"],
            "precheck_not_trusted"
        );
        assert!(!revoked_dir.join("effects.log").exists());
        no_model(&owner).await?;
        let (passed, _) = approve(&f, &owner, "pass", 2000).await?;
        let job = create(
            &owner,
            "passed-job",
            Some(&passed),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "pass-now").await?;
        let report = state(&owner, &job, "needsValidation").await?;
        assert_eq!(report["data"]["occurrence"]["precheck"]["state"], "passed");
        assert_eq!(
            report["data"]["occurrence"]["precheck"]["result"]["commandStarted"],
            true
        );
        let worker = report["data"]["occurrence"]["sessionId"]
            .as_str()
            .context("checked worker")?;
        let path = PathBuf::from(std::fs::read_to_string(
            f.directory.join("callers").join(format!("{worker}.txt")),
        )?);
        let scoped = scoped_client(&path, worker).await?;
        let denied = call(&scoped, "nesvo_list_prechecks", json!({}))
            .await?
            .structured_content
            .context("scoped trust refusal")?;
        assert_eq!(denied["error"]["code"], "forbidden");
        scoped.cancel().await?;
        let replay = now(&owner, &job, "pass-now").await?;
        assert_eq!(replay["data"], admitted["data"]);
        let list = budgets::owner_cli(&f, &["job", "precheck", "list", "--json"]).await?;
        let shown =
            budgets::owner_cli(&f, &["job", "precheck", "show", revoked_id, "--json"]).await?;
        let accepted = budgets::owner_cli(
            &f,
            &["job", "precheck", "mutation", "--key", "revoke", "--json"],
        )
        .await?;
        assert_eq!(off["data"], accepted["data"]);
        let list_mcp = data(call(&owner, "nesvo_list_prechecks", json!({})).await?)?;
        assert_eq!(
            list_mcp["data"]["precheckApprovals"],
            list["data"]["precheckApprovals"]
        );
        assert_eq!(list_mcp["data"]["nextOffset"], list["data"]["nextOffset"]);
        let shown_mcp = data(call(&owner, "nesvo_get_precheck", json!({"id":revoked_id})).await?)?;
        assert_eq!(
            shown_mcp["data"]["precheckApproval"],
            shown["data"]["precheckApproval"]
        );
        let accepted_mcp = data(
            call(
                &owner,
                "nesvo_get_precheck_mutation",
                json!({"key":"revoke"}),
            )
            .await?,
        )?;
        assert_eq!(accepted_mcp["data"], accepted["data"]);
        run_checkpoints::schema(vec![
            skipped,
            off,
            off_mcp,
            refused,
            report,
            list,
            list_mcp,
            shown,
            shown_mcp,
            accepted,
            accepted_mcp,
        ])
        .await?;
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

#[tokio::test]
#[ignore = "native scoped command descendants and abrupt host death; no original models"]
async fn precheck_scope_ends_descendants_on_timeout_root_exit_and_parent_death_without_replay()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let (approval, directory) = approve(&f, &owner, "tree-timeout", 5000).await?;
        let job = create(
            &owner,
            "tree-timeout",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "tree-timeout").await?;
        tree_ready(&directory).await?;
        let failed = state(&owner, &job, "failed").await?;
        assert_eq!(failed["data"]["occurrence"]["reason"], "precheck_timeout");
        tree_gone(&f, &directory).await?;
        no_model(&owner).await?;
        assert_eq!(
            now(&owner, &job, "tree-timeout").await?["data"],
            admitted["data"]
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("effects.log"))?
                .lines()
                .count(),
            1
        );
        let (approval, directory) = approve(&f, &owner, "tree-crash", 10000).await?;
        let job = create(
            &owner,
            "tree-crash",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "tree-crash").await?;
        tree_ready(&directory).await?;
        owner.cancel().await?;
        f.restart(true).await?;
        tree_gone(&f, &directory).await?;
        let owner = client(&f.pairing()).await?;
        let unknown = state(&owner, &job, "reconcile").await?;
        assert_eq!(
            unknown["data"]["occurrence"]["precheck"]["state"],
            "unknown"
        );
        assert!(unknown["data"]["occurrence"]["runId"].is_null());
        no_model(&owner).await?;
        assert_eq!(
            std::fs::read_to_string(directory.join("effects.log"))?
                .lines()
                .count(),
            1
        );
        assert_eq!(
            now(&owner, &job, "tree-crash").await?["data"],
            admitted["data"]
        );
        let abandoned = budgets::owner_cli(
            &f,
            &[
                "job",
                "abandon-precheck",
                job["id"].as_str().context("crashed job")?,
                unknown["data"]["occurrence"]["id"]
                    .as_str()
                    .context("crashed occurrence")?,
                "--key",
                "ack-unknown",
                "--digest",
                approval["digest"].as_str().context("approval digest")?,
                "--acknowledge-unknown-effects",
                "--json",
            ],
        )
        .await?;
        assert_eq!(abandoned["data"]["occurrence"]["state"], "canceled");
        let abandoned_mcp = data(
            call(
                &owner,
                "nesvo_abandon_job_precheck",
                json!({"key":"ack-unknown","jobId":job["id"],"occurrenceId":unknown["data"]["occurrence"]["id"],"expectedDigest":approval["digest"],"acknowledgeUnknownEffects":true}),
            )
            .await?,
        )?;
        assert_eq!(abandoned_mcp["data"], abandoned["data"]);
        let (approval, directory) = approve(&f, &owner, "tree-pass", 5000).await?;
        let job = create(
            &owner,
            "tree-pass",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        now(&owner, &job, "tree-pass").await?;
        let passed = state(&owner, &job, "needsValidation").await?;
        tree_gone(&f, &directory).await?;
        assert_eq!(
            passed["data"]["occurrence"]["precheck"]["result"]["cleanupConfirmed"],
            true
        );
        run_checkpoints::schema(vec![failed, unknown, abandoned, abandoned_mcp, passed]).await?;
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

#[tokio::test]
#[ignore = "native timer fairness while bounded command checks occupy their own slots"]
async fn slow_prechecks_do_not_starve_unrelated_due_jobs_or_free_all_dispatch_capacity()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let (approval, directory) = approve(&f, &owner, "hold", 10000).await?;
        for n in 0..3 {
            let key = format!("held-{n}");
            let job = create(
                &owner,
                &key,
                Some(&approval),
                chrono::Utc::now() + chrono::Duration::hours(1),
            )
            .await?;
            now(&owner, &job, &key).await?;
        }
        let due = chrono::Utc::now() + chrono::Duration::seconds(1);
        let fast = create(&owner, "independent-clock", None, due).await?;
        let report = timeout(
            Duration::from_secs(8),
            state(&owner, &fast, "needsValidation"),
        )
        .await
        .context("Slow prechecks must not block an unrelated scheduled job")??;
        assert!(report["data"]["occurrence"]["precheck"].is_null());
        std::fs::write(directory.join("release"), "explicit fixture release")?;
        run_checkpoints::schema(vec![report]).await?;
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
