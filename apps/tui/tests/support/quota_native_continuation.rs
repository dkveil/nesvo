use super::*;
use provider_quota::{
    configure_source, context_query, context_refresh, context_revision, row, snapshot,
};

type Owner = RunningService<RoleClient, ()>;

struct Held {
    occurrence: Value,
    run: Value,
    attempts: Value,
    directory: PathBuf,
    run_id: String,
    task_id: String,
    attempt_id: String,
    receipt_id: String,
    session_id: String,
}

fn string(value: &Value, field: &str) -> Result<String> {
    value[field]
        .as_str()
        .with_context(|| format!("Actual retained native {field}"))
        .map(str::to_owned)
}

async fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .context("Owned quota Git command deadline")??;
    ensure!(
        output.status.success(),
        "Owned quota Git fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1024)
            .collect::<String>()
    );
    Ok(String::from_utf8(output.stdout)?)
}

async fn repository(fixture: &Fixture) -> Result<PathBuf> {
    let directory = fixture.directory.join("source");
    std::fs::create_dir(&directory)?;
    git(&directory, &["init", "--quiet"]).await?;
    git(&directory, &["config", "--local", "core.autocrlf", "false"]).await?;
    git(&directory, &["config", "--local", "core.hooksPath", ""]).await?;
    std::fs::write(directory.join("source.txt"), "Committed source\n")?;
    git(&directory, &["add", "--", "source.txt"]).await?;
    git(
        &directory,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "owned quota source",
        ],
    )
    .await?;
    std::fs::write(
        directory.join("source.txt"),
        "Preserve base working edits\n",
    )?;
    directory
        .canonicalize()
        .context("Canonical private quota Git repository")
}

fn configuration(
    fixture: &Fixture,
    source: &Path,
    allowed_derived: Option<&Path>,
    held_response: bool,
) -> Result<()> {
    let mut denied = snapshot();
    denied["ordinaryUsageAllowed"] = json!(false);
    let mut contexts = serde_json::Map::new();
    contexts.insert(
        source.to_str().context("Private base directory")?.into(),
        json!({"mode":"snapshot","result":snapshot()}),
    );
    if let Some(directory) = allowed_derived {
        contexts.insert(
            directory
                .to_str()
                .context("Private derived directory")?
                .into(),
            json!({"mode":if held_response {"heldSnapshot"} else {"snapshot"},"result":snapshot()}),
        );
    }
    configure_source(
        fixture,
        json!({"mode":"snapshot","result":denied,"contexts":contexts}),
    )
}

async fn inventory(source: &Path) -> Result<Value> {
    let worktrees = git(source, &["worktree", "list", "--porcelain"]).await?;
    let branches = git(
        source,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/nesvo/",
        ],
    )
    .await?;
    ensure!(
        worktrees
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count()
            == 2,
        "Exactly the original and one actual derived worktree must exist: {worktrees}"
    );
    ensure!(
        branches.lines().count() == 1,
        "Exactly one actual Nesvo worktree branch must exist: {branches}"
    );
    Ok(json!({"worktrees":worktrees,"branches":branches,
        "sourceBytes":std::fs::read_to_string(source.join("source.txt"))?}))
}

fn native_files(fixture: &Fixture, suffix: &str) -> Result<Vec<PathBuf>> {
    Ok(std::fs::read_dir(fixture.directory.join("callers"))?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(suffix))
        .map(|entry| entry.path())
        .collect())
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

async fn attempts(owner: &Owner, run: &str, task: &str) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_task_attempts",
            json!({"runId":run,"taskId":task}),
        )
        .await?,
    )
}

async fn admit(owner: &Owner, source: &Path, binding: &Value) -> Result<(Value, Value)> {
    let created = data(call(owner,"nesvo_create_job",json!({"key":"late-quota-definition","spec":{
        "title":"Actual late worktree quota continuation","instruction":"report-task",
        "profile":{"program":"codex","workspace":"worktree","cwd":source},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
        "quotaPolicy":{"mode":"wait","contextId":binding["contextId"],"accountFingerprint":binding["accountFingerprint"]},
        "maxElapsedMs":60000,"overlap":"queue"
    }})).await?)?;
    let admitted = data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({
                "key":"late-quota-once","jobId":created["data"]["job"]["id"],"expectedRevision":1
            }),
        )
        .await?,
    )?;
    Ok((created, admitted))
}

async fn held(fixture: &Fixture, owner: &Owner, job: &str, id: &str) -> Result<Held> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(20), async {
        loop {
            let occurrence = occurrence(owner,job,id).await?;
            let current = &occurrence["data"]["occurrence"];
            if let Some(run_id) = current["runId"].as_str() {
                let run = data(call(owner,"nesvo_get_run",json!({"runId":run_id})).await?)?;
                let task_id = string(&run["data"]["tasks"][0],"id")?;
                let history = attempts(owner,run_id,&task_id).await?;
                last = json!({"occurrence":current,"tasks":run["data"]["tasks"],"attempts":history["data"]["attempts"]});
                if let Some(native) = history["data"]["attempts"].as_array().and_then(|rows|rows.first()) {
                    let launch = &native["launch"];
                    if launch["phase"]=="dispatching" && launch["quotaHoldReason"]=="quota_wait"
                        && let Some(directory)=launch["preparedWorkspace"]["directory"].as_str()
                        && current["launchReceiptId"]==launch["receiptId"]
                        && current["attemptId"]==native["id"] {
                        let directory=PathBuf::from(directory).canonicalize()?;
                        let root=fixture.directory.canonicalize()?;
                        ensure!(directory.parent()==Some(root.as_path()) && directory.file_name().is_some_and(|name|name.to_string_lossy().starts_with("source-nesvo-")),
                            "Actual prepared worktree must stay inside the owned fixture");
                        assert_eq!(launch["preparedWorkspace"]["derivedWorktree"],true);
                        assert_eq!(history["data"]["attempts"].as_array().context("One original native attempt")?.len(),1);
                        assert_eq!(native["state"],"launching");
                        assert!(native["result"].is_null());
                        let result=Held {
                            run_id:run_id.into(),task_id,attempt_id:string(native,"id")?,
                            receipt_id:string(launch,"receiptId")?,session_id:string(launch,"sessionId")?,
                            occurrence,run,attempts:history,directory,
                        };
                        return Ok::<_,anyhow::Error>(result);
                    }
                    ensure!(!matches!(launch["phase"].as_str(),Some("failed"|"unknown")),
                        "Late native preparation refused before the held evidence: {last}");
                }
            } else {last=occurrence;}
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }).await.with_context(||format!("No actual post-Git quota hold; last: {}",last.to_string().chars().take(12000).collect::<String>()))?
}

async fn no_native_worker(fixture: &Fixture, owner: &Owner) -> Result<Value> {
    let listed = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    ensure!(
        listed["data"]["sessions"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "A denied derived workspace must not have a physical native worker"
    );
    ensure!(
        native_files(fixture, ".launch-argv.json")?.is_empty(),
        "Denied worktree launched a native CLI"
    );
    ensure!(
        native_files(fixture, ".result.json")?.is_empty(),
        "Denied worktree produced a native report"
    );
    Ok(listed)
}

async fn prepared(
    fixture: &Fixture,
    owner: &Owner,
) -> Result<(PathBuf, Value, Value, Value, Held)> {
    let source = repository(fixture).await?;
    configuration(fixture, &source, None, false)?;
    context_query(owner, &source, false).await?;
    let base = context_revision(owner, &source, 1).await?;
    let binding = row(&base)?;
    assert_eq!(binding["ordinaryUsageEligible"], true);
    let (created, admitted) = admit(owner, &source, binding).await?;
    let job = string(&created["data"]["job"], "id")?;
    let id = string(&admitted["data"]["occurrence"], "id")?;
    let held = held(fixture, owner, &job, &id).await?;
    ensure!(
        held.occurrence["data"]["occurrence"]["precheck"].is_null(),
        "No command precheck was approved or executed"
    );
    assert!(held.occurrence["data"]["occurrence"]["retry"].is_null());
    assert_eq!(
        std::fs::read_to_string(held.directory.join("source.txt"))?,
        "Committed source\n"
    );
    assert_eq!(
        std::fs::read_to_string(source.join("source.txt"))?,
        "Preserve base working edits\n"
    );
    Ok((source, base, created, admitted, held))
}

async fn release(
    owner: &Owner,
    fixture: &Fixture,
    source: &Path,
    held: &Held,
    held_response: bool,
) -> Result<(Vec<Value>, u64)> {
    let denied = context_query(owner, &held.directory, false).await?;
    let current = context_revision(owner, &held.directory, 1).await?;
    assert_eq!(row(&current)?["ordinaryUsageEligible"], false);
    assert_eq!(row(&current)?["ordinaryUsageAllowed"], false);
    configuration(fixture, source, Some(&held.directory), held_response)?;
    let refreshed = context_refresh(owner, &held.directory).await?;
    let target = refreshed["data"]["refresh"]["revision"]
        .as_u64()
        .context("Derived quota refresh target")?;
    let mut envelopes = vec![denied, current, refreshed];
    if !held_response {
        let recovered = context_revision(owner, &held.directory, target).await?;
        recovered_identity(&envelopes[1], &recovered)?;
        envelopes.push(recovered);
    }
    Ok((envelopes, target))
}

fn recovered_identity(current: &Value, recovered: &Value) -> Result<()> {
    assert_eq!(row(recovered)?["ordinaryUsageEligible"], true);
    assert_eq!(
        row(recovered)?["accountFingerprint"],
        row(current)?["accountFingerprint"]
    );
    assert_eq!(
        row(recovered)?["readerId"],
        row(current)?["readerId"],
        "Owner refresh coalesces the actual derived reader"
    );
    Ok(())
}

fn same_identity(held: &Held, current: &Value) {
    let current = &current["data"]["occurrence"];
    for field in [
        "id",
        "jobId",
        "jobAttemptId",
        "runId",
        "attemptId",
        "sessionId",
        "launchReceiptId",
    ] {
        assert_eq!(
            current[field], held.occurrence["data"]["occurrence"][field],
            "Retained identity changed: {field}"
        );
    }
}

fn diagnostic_fields(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|field| {
                let value = match &value[*field] {
                    Value::String(text)
                        if text.len() <= 128
                            && text.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                            }) =>
                    {
                        json!(text)
                    }
                    Value::Bool(value) => json!(value),
                    Value::Null => Value::Null,
                    _ => json!("unavailable"),
                };
                ((*field).into(), value)
            })
            .collect(),
    )
}

async fn report_timeout_diagnostic(fixture: &Fixture, held: &Held) -> Value {
    let mut diagnostic = json!({"clientAvailable":false,"receipt":null,"job":null,"nativeAttempt":null,"launch":null});
    let observed = timeout(Duration::from_secs(3), async {
        let owner = client(&fixture.pairing()).await?;
        diagnostic["clientAvailable"] = json!(true);
        if let Ok(Ok(reply)) = timeout(
            Duration::from_millis(600),
            call(&owner, "nesvo_get_operation", json!({"id":held.receipt_id})),
        )
        .await
            && let Ok(envelope) = data(reply)
        {
            let receipt = &envelope["data"]["receipt"];
            diagnostic["receipt"] = diagnostic_fields(receipt, &["phase"]);
            diagnostic["receipt"]["result"] =
                diagnostic_fields(&receipt["result"], &["code", "effectStarted"]);
        }
        let original = &held.occurrence["data"]["occurrence"];
        if let Ok(Ok(reply)) = timeout(
            Duration::from_millis(600),
            call(
                &owner,
                "nesvo_get_job_occurrence",
                json!({"jobId":original["jobId"],"occurrenceId":original["id"]}),
            ),
        )
        .await
            && let Ok(envelope) = data(reply)
        {
            diagnostic["job"] =
                diagnostic_fields(&envelope["data"]["occurrence"], &["state", "reason"]);
        }
        if let Ok(Ok(reply)) = timeout(
            Duration::from_millis(600),
            call(
                &owner,
                "nesvo_get_task_attempts",
                json!({"runId":held.run_id,"taskId":held.task_id}),
            ),
        )
        .await
            && let Ok(envelope) = data(reply)
            && let Some(native) = envelope["data"]["attempts"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["id"] == held.attempt_id))
        {
            diagnostic["nativeAttempt"] = diagnostic_fields(native, &["state"]);
            diagnostic["launch"] = diagnostic_fields(
                &native["launch"],
                &["phase", "code", "effectStarted", "quotaHoldReason"],
            );
        }
        let _ = timeout(Duration::from_millis(500), owner.cancel()).await;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    diagnostic["diagnosticDeadlineElapsed"] = json!(observed.is_err());
    diagnostic
}

#[tokio::test]
#[ignore = "real Git worktree, denied derived quota reader and exact retained native PTY release without owner clients"]
async fn late_worktree_quota_hold_releases_the_original_receipt_and_worker_once() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(60), async {
        let owner = client(&fixture.pairing()).await?;
        let (source, base, created, admitted, held) = prepared(&fixture, &owner).await?;
        let before = inventory(&source).await?;
        let empty = no_native_worker(&fixture, &owner).await?;
        let receipt =
            data(call(&owner, "nesvo_get_operation", json!({"id":held.receipt_id})).await?)?;
        assert_eq!(receipt["data"]["receipt"]["phase"], "dispatching");
        assert_eq!(receipt["data"]["receipt"]["sessionId"], held.session_id);
        assert!(receipt["data"]["receipt"]["result"]["effectStarted"].is_null());
        let (mut quota, target) = release(&owner, &fixture, &source, &held, true).await?;
        assert_eq!(
            row(&base)?["accountFingerprint"],
            row(&quota[1])?["accountFingerprint"],
            "Hold is an actual derived-folder denial for the same account"
        );
        owner.cancel().await?;
        std::fs::write(
            fixture.directory.join("callers/.fixture-quota-release"),
            "Owner client closed before reader completion",
        )?;
        let report = fixture
            .directory
            .join("callers")
            .join(format!("{}.result.json", held.session_id));
        let reported = timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(bytes) = std::fs::read(&report)
                    && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                {
                    return Ok::<_, anyhow::Error>(value);
                }
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        })
        .await;
        let reported=match reported {
            Ok(result)=>result?,
            Err(error)=> {
                let diagnostic=report_timeout_diagnostic(&fixture,&held).await;
                return Err(anyhow::Error::new(error).context(format!(
                    "Original reserved worker must report with the owner disconnected; sanitized retained diagnostics: {diagnostic}"
                )));
            }
        };
        assert_eq!(reported["ok"], true);
        let owner = client(&fixture.pairing()).await?;
        let recovered = context_revision(&owner, &held.directory, target).await?;
        recovered_identity(&quota[1], &recovered)?;
        quota.push(recovered);
        let job = string(&created["data"]["job"], "id")?;
        let id = string(&admitted["data"]["occurrence"], "id")?;
        let pending = job_cancellation::occurrence(&owner, &job, &id, "needsValidation").await?;
        same_identity(&held, &pending);
        let history = attempts(&owner, &held.run_id, &held.task_id).await?;
        let native = &history["data"]["attempts"][0];
        assert_eq!(
            history["data"]["attempts"]
                .as_array()
                .context("One native history row")?
                .len(),
            1
        );
        assert_eq!(native["id"], held.attempt_id);
        assert_eq!(native["result"]["outcome"], "succeeded");
        assert_eq!(native["launch"]["receiptId"], held.receipt_id);
        assert_eq!(native["launch"]["sessionId"], held.session_id);
        assert_eq!(native["launch"]["phase"], "created");
        assert!(native["launch"]["quotaHoldReason"].is_null());
        assert_eq!(
            native["launch"]["preparedWorkspace"],
            held.attempts["data"]["attempts"][0]["launch"]["preparedWorkspace"]
        );
        let generations = data(
            call(
                &owner,
                "nesvo_get_job_attempts",
                json!({"jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        assert_eq!(
            generations["data"]["jobAttempts"]
                .as_array()
                .context("One original job generation")?
                .len(),
            1
        );
        let session = data(
            call(
                &owner,
                "nesvo_get_session",
                json!({"sessionId":held.session_id}),
            )
            .await?,
        )?;
        let cwd = PathBuf::from(string(&session["data"]["session"], "cwd")?).canonicalize()?;
        assert_eq!(cwd, held.directory);
        assert_eq!(native_files(&fixture, ".launch-argv.json")?.len(), 1);
        assert_eq!(native_files(&fixture, ".result.json")?, vec![report]);
        assert_eq!(
            inventory(&source).await?,
            before,
            "A retained release must never invoke Git setup again"
        );
        let replay = data(
            call(
                &owner,
                "nesvo_run_job_now",
                json!({"key":"late-quota-once","jobId":job,"expectedRevision":1}),
            )
            .await?,
        )?;
        assert_eq!(replay["data"], admitted["data"]);
        let mut envelopes = vec![
            base,
            created,
            admitted,
            held.occurrence,
            held.run,
            held.attempts,
            empty,
            receipt,
            pending,
            history,
            generations,
            session,
            replay,
            reported,
        ];
        envelopes.extend(quota);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded actual late-worktree quota release acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "owner cancellation of a real prepared quota-held worktree cannot be undone by a later fresh reader"]
async fn canceled_late_worktree_quota_hold_keeps_git_facts_and_never_starts_a_worker() -> Result<()>
{
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(60), async {
        let owner = client(&fixture.pairing()).await?;
        let (source, base, created, admitted, held) = prepared(&fixture, &owner).await?;
        let before = inventory(&source).await?;
        let empty = no_native_worker(&fixture, &owner).await?;
        let job = string(&created["data"]["job"], "id")?;
        let id = string(&admitted["data"]["occurrence"], "id")?;
        let canceled = data(
            call(
                &owner,
                "nesvo_cancel_job_occurrence",
                json!({"key":"cancel-held-worktree","jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        let mut last = Value::Null;
        let stopped = timeout(Duration::from_secs(8), async {
            loop {
                let view = data(
                    call(&owner, "nesvo_get_operation", json!({"id":held.receipt_id})).await?,
                )?;
                if view["data"]["receipt"]["phase"] == "unknown" {
                    return Ok::<_, anyhow::Error>(view);
                }
                last = view;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .with_context(|| format!("Retained launch did not observe owner cancellation: {last}"))??;
        assert_eq!(stopped["data"]["receipt"]["result"]["code"], "job_canceled");
        assert_ne!(
            stopped["data"]["receipt"]["result"]["effectStarted"], false,
            "The real prepared Git worktree cannot be relabeled as no effects"
        );
        let (quota, _) = release(&owner, &fixture, &source, &held, false).await?;
        let current = occurrence(&owner, &job, &id).await?;
        same_identity(&held, &current);
        assert!(current["data"]["occurrence"]["cancellation"].is_object());
        let history = attempts(&owner, &held.run_id, &held.task_id).await?;
        assert_eq!(
            history["data"]["attempts"]
                .as_array()
                .context("One canceled native reservation")?
                .len(),
            1
        );
        assert_eq!(history["data"]["attempts"][0]["id"], held.attempt_id);
        assert_eq!(
            history["data"]["attempts"][0]["launch"]["receiptId"],
            held.receipt_id
        );
        assert_eq!(history["data"]["attempts"][0]["launch"]["phase"], "unknown");
        assert_eq!(
            history["data"]["attempts"][0]["launch"]["preparedWorkspace"],
            held.attempts["data"]["attempts"][0]["launch"]["preparedWorkspace"]
        );
        let after = no_native_worker(&fixture, &owner).await?;
        assert_eq!(
            inventory(&source).await?,
            before,
            "Cancellation retains real Git facts"
        );
        let replay = data(
            call(
                &owner,
                "nesvo_cancel_job_occurrence",
                json!({"key":"cancel-held-worktree","jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        assert_eq!(replay["data"], canceled["data"]);
        let mut envelopes = vec![
            base,
            created,
            admitted,
            held.occurrence,
            held.run,
            held.attempts,
            empty,
            canceled,
            stopped,
            current,
            history,
            after,
            replay,
        ];
        envelopes.extend(quota);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded actual late-worktree quota cancellation acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
