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
    approve_executable(f, owner, mode, timeout_ms, node(f)).await
}
async fn approve_executable(
    f: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    timeout_ms: u64,
    executable: PathBuf,
) -> Result<(Value, PathBuf)> {
    let script = f.directory.join("precheck łódź.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )
    .with_context(|| format!("Write owned precheck script: {}", script.display()))?;
    let directory = f.directory.join(format!("check-{mode}"));
    std::fs::create_dir_all(&directory).with_context(|| {
        format!(
            "Create owned precheck effect directory: {}",
            directory.display()
        )
    })?;
    let spec = json!({"title":format!("Check {mode}"),"executable":executable,"cwd":f.directory,"arguments":[script,mode,directory,"root",LITERAL],"timeoutMs":timeout_ms,"environment":{"CHECK_LITERAL":LITERAL}});
    let file = f.directory.join(format!("approve-{mode}.json"));
    std::fs::write(&file, serde_json::to_vec(&spec)?)
        .with_context(|| format!("Write owned precheck approval input: {}", file.display()))?;
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
    state_within(owner, job, wanted, Duration::from_secs(20)).await
}
async fn state_within(
    owner: &RunningService<RoleClient, ()>,
    job: &Value,
    wanted: &str,
    budget: Duration,
) -> Result<Value> {
    let mut last = Value::Null;
    let observed = timeout(budget, async {
        loop {
            let history =
                data(call(owner, "nesvo_get_job_history", json!({"jobId":job["id"]})).await?)?;
            last = history.clone();
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
    .await;
    observed
        .with_context(|| format!("Precheck occurrence outcome {wanted}; last history: {last}"))?
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
        let mut held = Vec::new();
        for n in 0..3 {
            let key = format!("held-{n}");
            let job = create(
                &owner,
                &key,
                Some(&approval),
                chrono::Utc::now() + chrono::Duration::hours(1),
            )
            .await?;
            let accepted = now(&owner, &job, &key).await?;
            held.push((
                job["id"]
                    .as_str()
                    .context("Held precheck job ID")?
                    .to_owned(),
                accepted["data"]["occurrence"]["id"]
                    .as_str()
                    .context("Held precheck occurrence ID")?
                    .to_owned(),
            ));
        }
        let due = chrono::Utc::now() + chrono::Duration::seconds(1);
        let fast = create(&owner, "independent-clock", None, due).await?;
        let report = state_within(&owner, &fast, "needsValidation", Duration::from_secs(8))
            .await
            .context("Slow prechecks must not block an unrelated scheduled job")?;
        assert!(report["data"]["occurrence"]["precheck"].is_null());
        let release = directory.join("release");
        std::fs::write(&release, "explicit fixture release").with_context(|| {
            format!(
                "Release owned held precheck commands: {}",
                release.display()
            )
        })?;
        // This follows the unchanged eight-second fairness assertion. A release
        // file is intent, not proof that all three native command scopes exited.
        // Await exact durable cleanup evidence before deleting their executable
        // and working directories, especially on Windows.
        let mut last = Vec::new();
        timeout(Duration::from_secs(6), async {
            loop {
                let mut settled = true;
                let mut observed = Vec::new();
                for (job, occurrence) in &held {
                    let current = data(
                        call(
                            &owner,
                            "nesvo_get_job_occurrence",
                            json!({"jobId":job,"occurrenceId":occurrence}),
                        )
                        .await?,
                    )?;
                    let precheck = &current["data"]["occurrence"]["precheck"];
                    settled &= precheck["finishedAt"].is_number()
                        && precheck["result"]["cleanupConfirmed"] == true;
                    observed
                        .push(json!({"jobId":job,"occurrenceId":occurrence,"precheck":precheck}));
                }
                if settled {
                    return Ok::<_, anyhow::Error>(());
                }
                last = observed;
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .with_context(|| {
            format!(
                "Await cleanup of three exact released precheck scopes; last: {}",
                serde_json::to_string(&last)
                    .unwrap_or_default()
                    .chars()
                    .take(8192)
                    .collect::<String>()
            )
        })??;
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

#[tokio::test]
#[ignore = "native owner CLI/MCP cancellation, owned command descendants and restart; no models"]
async fn owner_occurrence_cancellation_stops_precheck_tree_and_never_replays_after_restart()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let (approval, directory) = approve(&f, &owner, "tree-cancel", 10000).await?;
        let spec = json!({
            "title":"Cancelable command tree",
            "instruction":"report-task",
            "profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
            "precheckId":approval["id"],
            "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
            "overlap":"queue"
        });
        let created = data(
            call(
                &owner,
                "nesvo_create_job",
                json!({"key":"cancelable-tree","spec":spec}),
            )
            .await?,
        )?;
        let job = &created["data"]["job"];
        let job_id = job["id"].as_str().context("cancelable job ID")?;
        let active = now(&owner, job, "active-tree").await?;
        let active_id = active["data"]["occurrence"]["id"]
            .as_str()
            .context("active occurrence ID")?;
        tree_ready(&directory).await?;

        // The live first occurrence holds the overlap gate, so the second one
        // is durably queued without racing a claim from an otherwise idle host.
        let queued = now(&owner, job, "queued-tree").await?;
        assert_eq!(queued["data"]["occurrence"]["state"], "queued");
        let queued_id = queued["data"]["occurrence"]["id"]
            .as_str()
            .context("queued occurrence ID")?;
        let queued_cancel = budgets::owner_cli(
            &f,
            &[
                "job", "cancel", job_id, queued_id, "--key", "cancel-queued", "--json",
            ],
        )
        .await?;
        let queued_view = &queued_cancel["data"]["occurrence"];
        assert_eq!(queued_view["state"], "canceled");
        assert_eq!(queued_view["cancellation"]["state"], "completed");
        assert!(queued_view["runId"].is_null());
        assert!(queued_view["precheck"].is_null());

        let active_arguments =
            json!({"key":"cancel-active","jobId":job_id,"occurrenceId":active_id});
        let active_cancel = data(
            call(
                &owner,
                "nesvo_cancel_job_occurrence",
                active_arguments.clone(),
            )
            .await?,
        )?;
        assert_eq!(active_cancel["data"]["occurrence"]["state"], "canceling");
        assert_eq!(
            active_cancel["data"]["occurrence"]["cancellation"]["state"],
            "awaitingPrecheck"
        );
        let mut last = Value::Null;
        let completed = timeout(Duration::from_secs(6), async {
            loop {
                let current = data(
                    call(
                        &owner,
                        "nesvo_get_job_occurrence",
                        json!({"jobId":job_id,"occurrenceId":active_id}),
                    )
                    .await?,
                )?;
                if current["data"]["occurrence"]["state"] == "canceled" {
                    return Ok::<_, anyhow::Error>(current);
                }
                last = current;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .with_context(|| format!("Canceled command cleanup was not confirmed; last: {last}"))??;
        let current = &completed["data"]["occurrence"];
        assert_eq!(current["cancellation"]["state"], "completed");
        assert_eq!(current["reason"], "owner_canceled");
        assert_eq!(current["precheck"]["result"]["cleanupConfirmed"], true);
        assert_eq!(current["precheck"]["result"]["reason"], "owner_canceled");
        assert!(current["precheck"]["finishedAt"].is_number());
        assert!(current["finishedAt"].is_number());
        assert!(current["runId"].is_null());
        tree_gone(&f, &directory).await?;
        no_model(&owner).await?;

        let queued_replay = data(
            call(
                &owner,
                "nesvo_cancel_job_occurrence",
                json!({"key":"cancel-queued","jobId":job_id,"occurrenceId":queued_id}),
            )
            .await?,
        )?;
        assert_eq!(queued_replay["data"], queued_cancel["data"]);
        let active_replay = budgets::owner_cli(
            &f,
            &[
                "job", "cancel", job_id, active_id, "--key", "cancel-active", "--json",
            ],
        )
        .await?;
        assert_eq!(active_replay["data"], active_cancel["data"]);
        assert_eq!(active_replay["data"]["occurrence"]["state"], "canceling");
        let conflict = call(
            &owner,
            "nesvo_cancel_job_occurrence",
            json!({"key":"cancel-active","jobId":job_id,"occurrenceId":queued_id}),
        )
        .await?
        .structured_content
        .context("Cancellation changed-intent refusal")?;
        assert_eq!(conflict["error"]["code"], "idempotency_conflict");
        let accepted = budgets::owner_cli(
            &f,
            &["job", "mutation", "--key", "cancel-active", "--json"],
        )
        .await?;
        assert_eq!(accepted["data"], active_cancel["data"]);
        assert_eq!(
            std::fs::read_to_string(directory.join("effects.log"))?
                .lines()
                .count(),
            1
        );
        owner.cancel().await?;
        f.restart(false).await?;
        let owner = client(&f.pairing()).await?;
        let retained = data(
            call(
                &owner,
                "nesvo_get_job_history",
                json!({"jobId":job_id}),
            )
            .await?,
        )?;
        let rows = retained["data"]["occurrences"]
            .as_array()
            .context("retained canceled occurrences")?;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row["state"] == "canceled"
            && row["cancellation"]["state"] == "completed"
            && row["runId"].is_null()));
        let after_restart = data(
            call(&owner, "nesvo_cancel_job_occurrence", active_arguments).await?,
        )?;
        assert_eq!(after_restart["data"], active_cancel["data"]);
        tree_gone(&f, &directory).await?;
        no_model(&owner).await?;
        assert_eq!(
            std::fs::read_to_string(directory.join("effects.log"))?
                .lines()
                .count(),
            1
        );
        run_checkpoints::schema(vec![
            created,
            active,
            queued,
            queued_cancel,
            active_cancel,
            completed,
            queued_replay,
            active_replay,
            conflict,
            accepted,
            retained,
            after_restart,
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
#[ignore = "graceful host shutdown drains an owned command tree and persists cleanup before exit"]
async fn graceful_host_shutdown_reaps_precheck_descendants_and_retains_refusal_after_restart()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(40), async {
        let owner = client(&f.pairing()).await?;
        // A distinct executable makes Windows image-handle release observable
        // without removing the Node used for process probes or the restarted host.
        let executable = f.directory.join(if cfg!(windows) {
            "shutdown-command.exe"
        } else {
            "shutdown-command"
        });
        std::fs::copy(node(&f), &executable).with_context(|| {
            format!(
                "Copy owned shutdown command executable: {}",
                executable.display()
            )
        })?;
        let (approval, directory) =
            approve_executable(&f, &owner, "tree-shutdown", 10000, executable.clone()).await?;
        let job = create(
            &owner,
            "graceful-shutdown-tree",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "graceful-shutdown-tree").await?;
        let occurrence = admitted["data"]["occurrence"]["id"]
            .as_str()
            .context("Shutdown occurrence identity")?;
        tree_ready(&directory).await?;
        let running = data(
            call(
                &owner,
                "nesvo_get_job_occurrence",
                json!({"jobId":job["id"],"occurrenceId":occurrence}),
            )
            .await?,
        )?;
        assert_eq!(
            running["data"]["occurrence"]["precheck"]["state"],
            "running"
        );
        no_model(&owner).await?;
        owner.cancel().await?;

        // The same graceful stdin-close path used by the fixture is the action
        // under test. No release file, cancellation API or process kill is used.
        drop(f.host.stdin.take());
        let status = timeout(Duration::from_secs(10), f.host.wait())
            .await
            .context("Graceful owned host exit while precheck descendants are active")?
            .context("Reap gracefully stopped native host")?;
        ensure!(
            status.success(),
            "Native host did not confirm its runtime shutdown: {status}"
        );
        tree_gone(&f, &directory).await?;
        std::fs::remove_file(&executable).with_context(|| {
            format!(
                "Remove owned command image after graceful host cleanup: {}",
                executable.display()
            )
        })?;

        f.restart(false).await?;
        let owner = client(&f.pairing()).await?;
        let retained = data(
            call(
                &owner,
                "nesvo_get_job_occurrence",
                json!({"jobId":job["id"],"occurrenceId":occurrence}),
            )
            .await?,
        )?;
        let current = &retained["data"]["occurrence"];
        assert_eq!(current["state"], "failed");
        assert_eq!(current["reason"], "precheck_refused");
        assert!(current["runId"].is_null());
        assert!(current["finishedAt"].is_number());
        let precheck = &current["precheck"];
        assert_eq!(precheck["state"], "refused");
        assert_eq!(precheck["reason"], "host_shutdown");
        assert!(precheck["finishedAt"].is_number());
        assert_eq!(precheck["result"]["reason"], "host_shutdown");
        assert_eq!(precheck["result"]["cleanupConfirmed"], true);
        assert!(precheck["result"]["commandStarted"].is_null());
        assert!(precheck["result"]["exitCode"].is_null());
        let replay = now(&owner, &job, "graceful-shutdown-tree").await?;
        assert_eq!(replay["data"], admitted["data"]);
        no_model(&owner).await?;
        tree_gone(&f, &directory).await?;
        let effects = directory.join("effects.log");
        assert_eq!(
            std::fs::read_to_string(&effects)
                .with_context(|| format!(
                    "Read retained owned command effects: {}",
                    effects.display()
                ))?
                .lines()
                .count(),
            1
        );
        run_checkpoints::schema(vec![admitted, running, retained, replay]).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = f.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded graceful command shutdown acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
