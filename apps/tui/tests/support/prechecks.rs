use super::*;
use tokio::io::AsyncReadExt;
const LITERAL: &str = "literal $(x); & łódź \"quoted\"";
fn node(f: &Fixture) -> PathBuf {
    f.directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}
pub(crate) const TREE_READY_DEADLINE: Duration = Duration::from_secs(15);
pub(crate) const TREE_EXIT_DEADLINE: Duration = Duration::from_secs(5);
const TREE_ROLES: [&str; 3] = ["child", "grandchild", "root"];

pub(crate) struct OwnedTree {
    listener: tokio::net::TcpListener,
    members: Vec<(String, BufReader<tokio::net::TcpStream>)>,
}

impl OwnedTree {
    pub(crate) async fn bind() -> Result<Self> {
        Ok(Self {
            listener: tokio::net::TcpListener::bind("127.0.0.1:0").await?,
            members: Vec::new(),
        })
    }

    pub(crate) fn environment(&self) -> Result<Value> {
        Ok(json!({
            "CHECK_LITERAL":LITERAL,
            "TREE_PORT":self.listener.local_addr()?.port().to_string(),
            "TREE_PROGRAM":process_fixture::executable(),
        }))
    }

    pub(crate) async fn announced(&mut self) -> Result<()> {
        while self.members.len() < TREE_ROLES.len() {
            let (stream, _) = self.listener.accept().await?;
            let mut member = BufReader::new(stream);
            let mut role = String::new();
            member.read_line(&mut role).await?;
            self.members.push((role.trim_end().to_owned(), member));
        }
        let mut roles: Vec<&str> = self.members.iter().map(|(role, _)| role.as_str()).collect();
        roles.sort();
        ensure!(
            roles == TREE_ROLES,
            "Unexpected owned tree members: {roles:?}"
        );
        Ok(())
    }

    pub(crate) async fn release_root(&mut self) -> Result<()> {
        let (_, root) = self
            .members
            .iter_mut()
            .find(|(role, _)| role == "root")
            .context("Announced owned tree root")?;
        root.get_mut().write_all(b"\n").await?;
        Ok(())
    }

    pub(crate) async fn exited(&mut self) -> Result<()> {
        for (role, member) in &mut self.members {
            let mut rest = Vec::new();
            if member.read_to_end(&mut rest).await.is_ok() {
                ensure!(rest.is_empty(), "Owned tree {role} wrote after announcing");
            }
        }
        Ok(())
    }
}

fn literal_environment() -> Value {
    json!({"CHECK_LITERAL":LITERAL})
}

async fn approve(
    f: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    timeout_ms: u64,
) -> Result<(Value, PathBuf)> {
    approve_executable(f, owner, mode, timeout_ms, node(f), literal_environment()).await
}
async fn approve_tree(
    f: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    timeout_ms: u64,
    tree: &OwnedTree,
) -> Result<(Value, PathBuf)> {
    approve_executable(f, owner, mode, timeout_ms, node(f), tree.environment()?).await
}
async fn approve_executable(
    f: &Fixture,
    owner: &RunningService<RoleClient, ()>,
    mode: &str,
    timeout_ms: u64,
    executable: PathBuf,
    environment: Value,
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
    let spec = json!({"title":format!("Check {mode}"),"executable":executable,"cwd":f.directory,"arguments":[script,mode,directory,"root",LITERAL],"timeoutMs":timeout_ms,"environment":environment});
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
    let id = waits::until(async || {
        let history =
            data(call(owner, "nesvo_get_job_history", json!({"jobId":job["id"]})).await?)?;
        let rows = history["data"]["occurrences"]
            .as_array()
            .context("Precheck job history")?;
        if let Some(id) = rows
            .iter()
            .find(|r| r["state"] == wanted)
            .and_then(|r| r["id"].as_str())
        {
            return Ok(Some(id.to_owned()));
        }
        ensure!(
            rows.is_empty()
                || !rows
                    .iter()
                    .all(|r| waits::is_settled_occurrence(&r["state"])),
            "Precheck occurrence settled before reaching {wanted}; history: {history}"
        );
        Ok(None)
    })
    .await?;
    data(
        call(
            owner,
            "nesvo_get_job_occurrence",
            json!({"jobId":job["id"],"occurrenceId":id}),
        )
        .await?,
    )
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
async fn tree_ready(tree: &mut OwnedTree) -> Result<()> {
    timeout(TREE_READY_DEADLINE, tree.announced())
        .await
        .context("Owned three-level command tree readiness")?
}
async fn tree_gone(tree: &mut OwnedTree) -> Result<()> {
    timeout(TREE_EXIT_DEADLINE, tree.exited())
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
        let ready =
            waits::until(async || Ok(directory.join("effects.log").exists().then_some(()))).await;
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
            anyhow::bail!("Precheck did not execute; retained detail: {detail}");
        }
        ready?;
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
        let mut tree = OwnedTree::bind().await?;
        let (approval, directory) = approve_tree(&f, &owner, "tree-timeout", 5000, &tree).await?;
        let job = create(
            &owner,
            "tree-timeout",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "tree-timeout").await?;
        tree_ready(&mut tree).await?;
        let failed = state(&owner, &job, "failed").await?;
        assert_eq!(failed["data"]["occurrence"]["reason"], "precheck_timeout");
        tree_gone(&mut tree).await?;
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
        let mut crash_tree = OwnedTree::bind().await?;
        let (approval, directory) = approve_tree(&f, &owner, "tree-crash", 10000, &crash_tree).await?;
        let job = create(
            &owner,
            "tree-crash",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        let admitted = now(&owner, &job, "tree-crash").await?;
        tree_ready(&mut crash_tree).await?;
        owner.cancel().await?;
        f.restart(true).await?;
        tree_gone(&mut crash_tree).await?;
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
        let mut pass_tree = OwnedTree::bind().await?;
        let (approval, _) = approve_tree(&f, &owner, "tree-pass", 5000, &pass_tree).await?;
        let job = create(
            &owner,
            "tree-pass",
            Some(&approval),
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;
        now(&owner, &job, "tree-pass").await?;
        tree_ready(&mut pass_tree).await?;
        pass_tree.release_root().await?;
        let passed = state(&owner, &job, "needsValidation").await?;
        tree_gone(&mut pass_tree).await?;
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
        let report = waits::until(async || {
            let history = data(call(&owner, "nesvo_get_job_history", json!({"jobId":fast["id"]})).await?)?;
            let reported = history["data"]["occurrences"].as_array().and_then(|rows| rows.iter().find(|r| r["state"] == "needsValidation")).and_then(|r| r["id"].as_str()).map(str::to_owned);
            for (job, occurrence) in &held {
                let current = data(call(&owner, "nesvo_get_job_occurrence", json!({"jobId":job,"occurrenceId":occurrence})).await?)?;
                ensure!(current["data"]["occurrence"]["precheck"]["finishedAt"].is_null(), "A held precheck finished within its published command budget before the unrelated job reported, so fairness is unproven: {current}; unrelated history: {history}");
            }
            if let Some(id) = &history["data"]["occurrences"].as_array().and_then(|rows| rows.iter().find(|r| waits::is_settled_occurrence(&r["state"]))) {
                anyhow::bail!("Unrelated scheduled job settled before reporting: {id}");
            }
            Ok(reported)
        })
        .await
        .context("Slow prechecks must not block an unrelated scheduled job")?;
        let report = data(call(&owner, "nesvo_get_job_occurrence", json!({"jobId":fast["id"],"occurrenceId":report})).await?)?;
        assert!(report["data"]["occurrence"]["precheck"].is_null());
        let release = directory.join("release");
        std::fs::write(&release, "explicit fixture release").with_context(|| {
            format!(
                "Release owned held precheck commands: {}",
                release.display()
            )
        })?;
        waits::until(async || {
            let mut settled = true;
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
                let finished = precheck["finishedAt"].is_number();
                ensure!(
                    !finished || precheck["result"]["cleanupConfirmed"] == true,
                    "Released precheck scope finished without confirmed cleanup: {}",
                    json!({"jobId":job,"occurrenceId":occurrence,"precheck":precheck})
                );
                settled &= finished;
            }
            Ok(settled.then_some(()))
        })
        .await
        .context("Await cleanup of three exact released precheck scopes")?;
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
        let mut tree = OwnedTree::bind().await?;
        let (approval, directory) = approve_tree(&f, &owner, "tree-cancel", 10000, &tree).await?;
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
        tree_ready(&mut tree).await?;

        let queued_behind_live_first_occurrence = now(&owner, job, "queued-tree").await?;
        assert_eq!(queued_behind_live_first_occurrence["data"]["occurrence"]["state"], "queued");
        let queued_id = queued_behind_live_first_occurrence["data"]["occurrence"]["id"]
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
        let completed = waits::occurrence(&owner, job_id, active_id, "canceled")
            .await
            .context("Canceled command cleanup was not confirmed")?;
        let current = &completed["data"]["occurrence"];
        assert_eq!(current["cancellation"]["state"], "completed");
        assert_eq!(current["reason"], "owner_canceled");
        assert_eq!(current["precheck"]["result"]["cleanupConfirmed"], true);
        assert_eq!(current["precheck"]["result"]["reason"], "owner_canceled");
        assert!(current["precheck"]["finishedAt"].is_number());
        assert!(current["finishedAt"].is_number());
        assert!(current["runId"].is_null());
        tree_gone(&mut tree).await?;
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
        tree_gone(&mut tree).await?;
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
            queued_behind_live_first_occurrence,
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

async fn shut_down_host_by_closing_stdin_only(f: &mut Fixture) -> Result<()> {
    drop(f.host.stdin.take());
    let status = f
        .host
        .wait()
        .await
        .context("Graceful owned host exit while precheck descendants are active")?;
    ensure!(
        status.success(),
        "Native host did not confirm its runtime shutdown: {status}"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "graceful host shutdown drains an owned command tree and persists cleanup before exit"]
async fn graceful_host_shutdown_reaps_precheck_descendants_and_retains_refusal_after_restart()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&f.pairing()).await?;
        let image_released_by_cleanup = f.directory.join(if cfg!(windows) {
            "shutdown-command.exe"
        } else {
            "shutdown-command"
        });
        std::fs::copy(node(&f), &image_released_by_cleanup).with_context(|| {
            format!(
                "Copy owned shutdown command executable: {}",
                image_released_by_cleanup.display()
            )
        })?;
        let mut tree = OwnedTree::bind().await?;
        let (approval, directory) = approve_executable(
            &f,
            &owner,
            "tree-shutdown",
            10000,
            image_released_by_cleanup.clone(),
            tree.environment()?,
        )
        .await?;
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
        tree_ready(&mut tree).await?;
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

        shut_down_host_by_closing_stdin_only(&mut f).await?;
        tree_gone(&mut tree).await?;
        std::fs::remove_file(&image_released_by_cleanup).with_context(|| {
            format!(
                "Remove owned command image after graceful host cleanup: {}",
                image_released_by_cleanup.display()
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
        tree_gone(&mut tree).await?;
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
