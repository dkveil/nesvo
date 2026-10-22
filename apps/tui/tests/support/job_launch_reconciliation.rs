use super::*;

type Owner = RunningService<RoleClient, ()>;
type ScenarioOutcome = std::thread::Result<Result<()>>;

async fn reply(owner: &Owner, name: &'static str, args: Value) -> Result<Value> {
    data(call(owner, name, args).await?)
}

async fn read(owner: &Owner, job: &str, occurrence: &str) -> Result<Value> {
    reply(
        owner,
        "nesvo_get_job_occurrence",
        json!({"jobId":job,"occurrenceId":occurrence}),
    )
    .await
}

async fn ready(fixture: &Fixture) -> Result<()> {
    waits::provider(fixture, "claude")
        .await
        .context("Controlled provider discovery before launch reconciliation")?;
    Ok(())
}

fn ensure_unsettled(view: &Value, wanted: &str) -> Result<()> {
    ensure!(
        !waits::is_settled_occurrence(&view["data"]["occurrence"]["state"]),
        "Occurrence settled before {wanted}: {view}"
    );
    Ok(())
}

async fn git(repository: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(repository)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .await
        .context("Owned Git fixture command")?;
    ensure!(
        output.status.success(),
        "Owned Git fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1024)
            .collect::<String>()
    );
    Ok(String::from_utf8(output.stdout)?)
}

fn single_quoted_forward_slash_shell_word(path: &Path) -> Result<String> {
    let path = path.to_str().context("Owned Git filter path is UTF-8")?;
    Ok(format!(
        "'{}'",
        path.replace('\\', "/").replace('\'', "'\\''")
    ))
}

async fn source_repository_with_checkout_failure_installed_after_initial_commit(
    fixture: &Fixture,
) -> Result<PathBuf> {
    let source = fixture.directory.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    git(&source, &["config", "--local", "core.autocrlf", "false"]).await?;
    git(&source, &["config", "--local", "core.hooksPath", ""]).await?;
    std::fs::write(
        source.join(".gitattributes"),
        "blob.txt filter=nesvoLaunchGate\n",
    )?;
    std::fs::write(source.join("blob.txt"), "owned checkout input\n")?;
    git(&source, &["add", "--", ".gitattributes", "blob.txt"]).await?;
    git(
        &source,
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
            "owned fixture source",
        ],
    )
    .await?;
    let script = fixture.directory.join("job-launch-filter.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-launch-filter.cjs"),
    )?;
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let command = format!(
        "{} {}",
        single_quoted_forward_slash_shell_word(&node)?,
        single_quoted_forward_slash_shell_word(&script)?
    );
    git(
        &source,
        &[
            "config",
            "--local",
            "filter.nesvoLaunchGate.smudge",
            &command,
        ],
    )
    .await?;
    git(
        &source,
        &[
            "config",
            "--local",
            "filter.nesvoLaunchGate.required",
            "true",
        ],
    )
    .await?;
    Ok(source)
}

async fn approve_precheck(fixture: &Fixture, owner: &Owner) -> Result<(String, Vec<Value>)> {
    let script = fixture.directory.join("launch-precheck.cjs");
    std::fs::write(
        &script,
        include_str!("../../../../tests/fixtures/job-precheck.cjs"),
    )?;
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let literal = "literal $(x); & łódź \"quoted\"";
    let command = json!({"title":"Explicit command before late native failure","executable":node,"cwd":fixture.directory,
        "arguments":[script,"pass",fixture.directory.join("launch-precheck-effects"),"root",literal],
        "timeoutMs":10000,"environment":{"CHECK_LITERAL":literal}});
    let described = reply(owner, "nesvo_describe_precheck", json!({"spec":command})).await?;
    let approved = reply(
        owner,
        "nesvo_approve_precheck",
        json!({"key":"launch-precheck-approval","spec":command,
        "expectedDigest":described["data"]["precheckDescription"]["digest"]}),
    )
    .await?;
    let id = approved["data"]["precheckApproval"]["id"]
        .as_str()
        .context("Explicit native reconciliation precheck approval")?
        .to_owned();
    Ok((id, vec![described, approved]))
}

fn spec(source: &Path) -> Value {
    json!({
        "title":"Late failed native checkout","instruction":"report-task",
        "profile":{"program":"claude","workspace":"worktree","cwd":source,"harness":true,
            "allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
        "overlap":"queue","executionTimeoutMs":1000,
        "retry":{"on":"launchNoEffect","maxAttempts":2,"initialDelayMs":1000,"maxDelayMs":1000}
    })
}

async fn claimed_before_filter_release(
    owner: &Owner,
    fixture: &Fixture,
    job: &str,
    id: &str,
) -> Result<Value> {
    let marker = fixture.directory.join("job-launch-filter-started.json");
    let finished = fixture.directory.join("job-launch-filter-finished.json");
    waits::until(async || {
            let view = read(owner, job, id).await?;
            if marker.is_file() && view["data"]["occurrence"]["executionTimeout"]["state"] == "dispatching" {
                ensure!(!finished.exists(), "Filter ended before observing its claimed timeout; late-failure ordering is unproven");
                let row = &view["data"]["occurrence"];
                assert!(row["executionTimeout"]["requestedAt"].is_number());
                assert!(row["executionTimeout"]["controlId"].is_null(), "Native launch still owns the run permit");
                let receipt = reply(owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
                assert_eq!(receipt["data"]["receipt"]["phase"], "dispatching", "Git has not returned a completed create receipt yet");
                return Ok(Some(view));
            }
            ensure_unsettled(&view, "the claimed execution timer")?;
            ensure!(!finished.exists(), "Filter ended before its execution timer was claimed: {view}");
            ensure!(matches!(view["data"]["occurrence"]["executionTimeout"]["state"].as_str(), None | Some("armed" | "dispatching")),
                "Execution timer resolved before the held Git checkout was observed: {view}");
            Ok(None)
    })
    .await
    .context("No claimed execution timer while real Git checkout is held")
}

async fn available(owner: &Owner, job: &str, id: &str) -> Result<Value> {
    waits::until(async || {
        let view = read(owner, job, id).await?;
        if view["data"]["occurrence"]["launchReconciliation"]["available"] == true {
            return Ok(Some(view));
        }
        ensure_unsettled(&view, "owner reconciliation")?;
        Ok(None)
    })
    .await
    .context("Real late no-effect launch did not become owner-reconcilable")
}

async fn refusal(owner: &Owner, name: &'static str, args: Value, wanted: &str) -> Result<Value> {
    let result = call(owner, name, args).await?;
    ensure!(
        result.is_error == Some(true),
        "Fresh refused mutation unexpectedly succeeded"
    );
    let envelope = result
        .structured_content
        .context("Structured owner refusal")?;
    assert_eq!(envelope["error"]["code"], wanted);
    Ok(envelope)
}

fn identity(row: &Value, descriptor: &Value) {
    assert_eq!(descriptor.as_object().unwrap().len(), 11);
    assert_eq!(descriptor["kind"], "launchNoEffect");
    assert_eq!(descriptor["occurrenceId"], row["id"]);
    for key in [
        "jobId",
        "jobAttemptId",
        "runId",
        "attemptId",
        "sessionId",
        "launchReceiptId",
    ] {
        assert_eq!(
            descriptor[key], row[key],
            "Exact generation identity differs: {key}"
        );
    }
}

fn assert_same_control_and_targets_ignoring_live_run_projection(
    retained: &Value,
    original: &Value,
) {
    assert_eq!(retained["data"]["control"], original["data"]["control"]);
    assert_eq!(retained["data"]["targets"], original["data"]["targets"]);
    assert_eq!(
        retained["data"]["nextOffset"],
        original["data"]["nextOffset"]
    );
}

fn launched_workers(fixture: &Fixture) -> Result<usize> {
    Ok(std::fs::read_dir(fixture.directory.join("callers"))?
        .collect::<std::io::Result<Vec<_>>>()?
        .iter()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".launch-argv.json")
        })
        .count())
}

async fn retained_artifact_inventory(fixture: &Fixture, source: &Path) -> Result<Value> {
    let mut entries = std::fs::read_dir(&fixture.directory)?
        .collect::<std::io::Result<Vec<_>>>()?
        .iter()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("source-nesvo-"))
        .collect::<Vec<_>>();
    entries.sort();
    let branches = git(
        source,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/nesvo/",
        ],
    )
    .await?;
    Ok(
        json!({"worktreePaths":entries,"branches":branches,"sourceBytes":std::fs::read_to_string(source.join("blob.txt"))?}),
    )
}

async fn retained_generation(owner: &Owner, row: &Value, phase: &str) -> Result<Vec<Value>> {
    let job = row["jobId"].as_str().context("Retained job")?;
    let id = row["id"].as_str().context("Retained occurrence")?;
    let listed = reply(
        owner,
        "nesvo_get_job_attempts",
        json!({"jobId":job,"occurrenceId":id}),
    )
    .await?;
    let attempts = listed["data"]["jobAttempts"]
        .as_array()
        .context("Retained generation")?;
    assert_eq!(
        attempts.len(),
        1,
        "Owner acknowledgment never retries an old occurrence"
    );
    assert_eq!(attempts[0]["id"], row["jobAttemptId"]);
    assert!(attempts[0]["retry"].is_null());
    let detail = reply(
        owner,
        "nesvo_get_job_attempt",
        json!({"jobId":job,"occurrenceId":id,"jobAttemptId":row["jobAttemptId"]}),
    )
    .await?;
    for field in [
        "executionTimeout",
        "launchReconciliation",
        "launchResolution",
    ] {
        assert_eq!(detail["data"]["jobAttempt"][field], row[field]);
        assert_eq!(attempts[0][field], row[field]);
    }
    let run = reply(owner, "nesvo_get_run", json!({"runId":row["runId"]})).await?;
    assert_eq!(run["data"]["tasks"][0]["attempts"], 1);
    let native = reply(
        owner,
        "nesvo_get_task_attempts",
        json!({"runId":row["runId"],"taskId":run["data"]["tasks"][0]["id"]}),
    )
    .await?;
    let records = native["data"]["attempts"]
        .as_array()
        .context("Retained native attempt")?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["id"], row["attemptId"]);
    assert_eq!(records[0]["sessionId"], row["sessionId"]);
    assert_eq!(records[0]["launch"]["receiptId"], row["launchReceiptId"]);
    assert_eq!(records[0]["launch"]["phase"], phase);
    if phase == "failed" {
        assert_eq!(records[0]["launch"]["effectStarted"], false);
    } else {
        assert_ne!(records[0]["launch"]["effectStarted"], false);
        assert_eq!(records[0]["state"], "launchUnknown");
    }
    assert!(records[0]["result"].is_null() && records[0]["validation"].is_null());
    assert_ne!(
        records[0]["state"], "stopped",
        "Logical abandonment must not fabricate an actual native exit"
    );
    Ok(vec![listed, detail, run, native])
}

fn release_live_filter_for_cleanup_regardless_of_outcome(fixture: &Fixture) -> Result<()> {
    std::fs::write(
        fixture.directory.join("job-launch-filter-release"),
        "cleanup",
    )?;
    Ok(())
}

async fn finish(
    fixture: &mut Fixture,
    phase: &str,
    job: Option<&str>,
    outcome: ScenarioOutcome,
) -> Result<()> {
    release_live_filter_for_cleanup_regardless_of_outcome(fixture)?;
    if !matches!(&outcome, Ok(Ok(()))) {
        let diagnostic = match job {
            Some(job) => job_diagnostics::report_timeout_diagnostics(fixture, job).await,
            None => json!({"jobNotCreated":true}),
        };
        let filter = ["started", "finished"].map(|phase| {
            let file = fixture
                .directory
                .join(format!("job-launch-filter-{phase}.json"));
            std::fs::read(file)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        });
        eprintln!(
            "JOB_LAUNCH_RECONCILIATION_DIAGNOSTIC {}",
            json!({"phase":phase,"filter":filter,"actual":diagnostic})
                .to_string()
                .chars()
                .take(16384)
                .collect::<String>()
        );
    }
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.with_context(|| format!("Native launch reconciliation; last phase: {phase}"))?;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native CLI/MCP/host and late Git checkout failure; unknown effects stay unresolved, no models"]
async fn late_unknown_checkout_refuses_owner_abandonment_and_keeps_overlap_held() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let mut phase = "controlled provider discovery and private Git source";
    let mut diagnostic_job = None;
    let outcome = std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let source = source_repository_with_checkout_failure_installed_after_initial_commit(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let (precheck,mut envelopes) = approve_precheck(&fixture,&owner).await?;
        let mut selected = spec(&source);
        selected["precheckId"] = precheck.into();
        let created = reply(&owner,"nesvo_create_job",json!({"key":"late-launch-definition","spec":selected})).await?;
        let job = created["data"]["job"]["id"].as_str().context("Late unknown launch job")?;
        diagnostic_job = Some(job.to_owned());
        let admitted = reply(&owner,"nesvo_run_job_now",json!({"key":"late-launch-first","jobId":job,"expectedRevision":1})).await?;
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Late unknown launch occurrence")?;
        phase = "real Git filter held until the execution timeout is claimed";
        let claimed = claimed_before_filter_release(&owner,&fixture,job,id).await?;
        assert_eq!(launched_workers(&fixture)?,0);
        std::fs::write(fixture.directory.join("job-launch-filter-release"),"release after claimed timeout")?;
        phase = "actual Git unknown receipt and finished cleanup observation";
        let unresolved = waits::until(async || {
            let view = read(&owner,job,id).await?;
            let row = &view["data"]["occurrence"];
            if matches!(row["executionTimeout"]["state"].as_str(),Some("blocked"|"unconfirmed")) {
                let receipt = reply(&owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
                if receipt["data"]["receipt"]["phase"] == "unknown" {return Ok(Some(view));}
                ensure!(matches!(receipt["data"]["receipt"]["phase"].as_str(),Some("accepted"|"dispatching")),"Late Git launch settled without unknown effects: {receipt}");
            }
            ensure_unsettled(&view,"the unknown Git cleanup")?;
            ensure!(!matches!(row["executionTimeout"]["state"].as_str(),Some("completed"|"disarmed")),"Execution timer resolved past the unknown Git cleanup: {view}");
            Ok(None)
        }).await.context("Late Git unknown cleanup did not settle")?;
        let row = &unresolved["data"]["occurrence"];
        let descriptor = &row["launchReconciliation"];
        identity(row,descriptor);
        assert_eq!(descriptor["available"],false);
        assert!(descriptor["reason"].is_string() && descriptor["digest"].is_null());
        assert!(row["launchResolution"].is_null() && row["finishedAt"].is_null());
        assert!(matches!(row["state"].as_str(),Some("reconcile"|"canceling")));
        assert!(row["retry"].is_null(),"Unknown checkout effects cannot qualify for automatic retry");
        assert_eq!(row["precheck"]["state"],"passed");
        let precheck_effects = fixture.directory.join("launch-precheck-effects").join("effects.log");
        assert_eq!(std::fs::read_to_string(&precheck_effects)?,"pass\n");
        let filter:Value = serde_json::from_slice(&std::fs::read(fixture.directory.join("job-launch-filter-finished.json"))?)?;
        assert_eq!(filter["released"],true,"The checkout must fail after the observed timeout claim");
        let filter_start:Value = serde_json::from_slice(&std::fs::read(fixture.directory.join("job-launch-filter-started.json"))?)?;
        assert_eq!(filter_start["bytes"],b"owned checkout input\n".len());
        assert!(filter["finishedAt"].as_u64().context("Actual filter exit")? >= claimed["data"]["occurrence"]["executionTimeout"]["requestedAt"].as_u64().context("Earlier timeout claim")?);
        let receipt = reply(&owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
        assert_eq!(receipt["data"]["receipt"]["phase"],"unknown");
        assert_eq!(receipt["data"]["receipt"]["result"]["code"],"worktree_unconfirmed");
        assert_ne!(receipt["data"]["receipt"]["result"]["effectStarted"],false);
        let control = reply(&owner,"nesvo_get_run_control",json!({"runId":row["runId"],"controlId":row["executionTimeout"]["controlId"]})).await?;
        assert!(matches!(control["data"]["control"]["state"].as_str(),Some("blocked"|"unconfirmed")));
        let targets = control["data"]["targets"].as_array().context("One reserved unknown target")?;
        assert_eq!(targets.len(),1);
        assert_eq!(targets[0]["attemptId"],row["attemptId"]);
        assert_eq!(targets[0]["sessionId"],row["sessionId"]);
        assert_ne!(targets[0]["phase"],"exited");
        assert_ne!(targets[0]["phase"],"stopRequested");
        let artifacts = retained_artifact_inventory(&fixture,&source).await?;
        envelopes.extend(retained_generation(&owner,row,"unknown").await?);
        phase = "unknown-effects acknowledgment refusal via both owner adapters";
        let ack = json!({"key":"refuse-unknown-native-effects","jobId":job,"occurrenceId":id,"jobAttemptId":row["jobAttemptId"],"expectedDigest":"0".repeat(64),"acknowledgeUnknownEffects":true});
        let refused = refusal(&owner,"nesvo_abandon_job_launch",ack,"occurrence_conflict").await?;
        let mut cli = Command::new(env!("CARGO_BIN_EXE_nesvo"));
        cli.arg("--pairing").arg(fixture.pairing()).args(["job","abandon-launch",job,id,"--job-attempt-id",row["jobAttemptId"].as_str().context("Unknown exact generation")?,"--key","refuse-unknown-native-effects-cli","--digest",&"0".repeat(64),"--acknowledge-unknown-effects","--json"]).stdin(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)] cli.creation_flags(0x08000000);
        let rejected = cli.output().await?;
        ensure!(!rejected.status.success(),"CLI acknowledged genuinely unknown native effects");
        let rejected:Value = serde_json::from_slice(&rejected.stdout)?;
        assert_eq!(rejected["error"]["code"],"occurrence_conflict");
        phase = "future shared occurrence remains queued behind unknown checkout";
        let mut future = selected.clone();
        future["profile"]["workspace"] = "shared".into();
        future.as_object_mut().unwrap().remove("executionTimeoutMs");
        let edited = reply(&owner,"nesvo_update_job",json!({"key":"unknown-future-profile","jobId":job,"expectedRevision":1,"spec":future})).await?;
        let queued = reply(&owner,"nesvo_run_job_now",json!({"key":"unknown-separate-occurrence","jobId":job,"expectedRevision":2})).await?;
        let second = queued["data"]["occurrence"]["id"].as_str().context("Unknown-effects queue")?;
        holds_throughout(Duration::from_millis(1200), async || {
            let view = read(&owner,job,second).await?;
            ensure!(view["data"]["occurrence"]["state"]=="queued" && view["data"]["occurrence"]["sessionId"].is_null(),"Unknown overlap admitted the queued occurrence: {view}");
            Ok(())
        }).await?;
        let pending = read(&owner,job,second).await?;
        assert_eq!(pending["data"]["occurrence"]["state"],"queued");
        for field in ["runId","jobAttemptId","attemptId","sessionId","launchReceiptId"] {
            assert!(pending["data"]["occurrence"][field].is_null(),"Unknown overlap admitted future native identity: {field}");
        }
        assert_eq!(std::fs::read_to_string(&precheck_effects)?,"pass\n");
        assert_eq!(launched_workers(&fixture)?,0);
        let sessions = reply(&owner,"nesvo_list_sessions",json!({})).await?;
        assert!(sessions["data"]["sessions"].as_array().context("No actual provider processes")?.is_empty());
        let final_first = read(&owner,job,id).await?;
        assert!(final_first["data"]["occurrence"]["launchResolution"].is_null());
        assert_eq!(final_first["data"]["occurrence"]["launchReconciliation"]["available"],false);
        assert_eq!(final_first["data"]["occurrence"]["executionTimeout"],row["executionTimeout"]);
        let retained_receipt = reply(&owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
        let retained_control = reply(&owner,"nesvo_get_run_control",json!({"runId":row["runId"],"controlId":row["executionTimeout"]["controlId"]})).await?;
        assert_eq!(retained_receipt["data"]["receipt"],receipt["data"]["receipt"]);
        assert_same_control_and_targets_ignoring_live_run_projection(&retained_control,&control);
        assert_eq!(retained_artifact_inventory(&fixture,&source).await?,artifacts,"Refused acknowledgment must not erase partial Git artifacts");
        envelopes.extend(retained_generation(&owner,&final_first["data"]["occurrence"],"unknown").await?);
        envelopes.extend([created,admitted,claimed,unresolved.clone(),receipt,control,refused,rejected,edited,queued,pending,sessions,final_first,retained_receipt,retained_control]);
        phase = "published schema validation of actual negative-path envelopes";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    finish(&mut fixture, phase, diagnostic_job.as_deref(), outcome).await
}

#[tokio::test]
#[ignore = "native CLI/MCP/host, proven missing-cwd refusal and a separate controlled Node worker; no models"]
async fn owner_abandons_proven_preflight_failure_and_deliberately_starts_a_new_occurrence()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let mut phase = "controlled provider discovery and explicitly approved command";
    let mut diagnostic_job = None;
    let outcome = std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let (precheck,mut envelopes) = approve_precheck(&fixture,&owner).await?;
        let missing = fixture.directory.join("missing-before-native-preflight");
        ensure!(!missing.exists(),"Missing native cwd must be a genuine initial preflight refusal");
        let mut selected = spec(&missing);
        selected["profile"]["workspace"] = "shared".into();
        selected["precheckId"] = precheck.into();
        selected.as_object_mut().unwrap().remove("executionTimeoutMs");
        selected.as_object_mut().unwrap().remove("retry");
        let created = reply(&owner,"nesvo_create_job",json!({"key":"known-preflight-definition","spec":selected})).await?;
        let job = created["data"]["job"]["id"].as_str().context("Known preflight job")?;
        diagnostic_job = Some(job.to_owned());
        let arguments = json!({"key":"known-preflight-first","jobId":job,"expectedRevision":1});
        let admitted = reply(&owner,"nesvo_run_job_now",arguments.clone()).await?;
        let id = admitted["data"]["occurrence"]["id"].as_str().context("Known preflight occurrence")?;
        phase = "actual typed-false preflight refusal without timeout or retry policy";
        let reconcilable = available(&owner,job,id).await?;
        let row = &reconcilable["data"]["occurrence"];
        assert_eq!(row["state"],"failed");
        assert!(row["executionTimeout"].is_null() && row["retry"].is_null());
        assert!(row["launchResolution"].is_null());
        assert_eq!(row["precheck"]["state"],"passed");
        let precheck_effects = fixture.directory.join("launch-precheck-effects").join("effects.log");
        assert_eq!(std::fs::read_to_string(&precheck_effects)?,"pass\n");
        let descriptor = &row["launchReconciliation"];
        identity(row,descriptor);
        assert_eq!(descriptor["available"],true);
        assert!(descriptor["reason"].is_null());
        let digest = descriptor["digest"].as_str().context("Exact preflight evidence digest")?;
        ensure!(digest.len()==64 && digest.bytes().all(|c|c.is_ascii_hexdigit()&&!c.is_ascii_uppercase()),"Expected an exact lowercase SHA256 digest");
        let receipt = reply(&owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
        assert_eq!(receipt["data"]["receipt"]["phase"],"failed");
        assert_eq!(receipt["data"]["receipt"]["result"]["effectStarted"],false);
        let sessions = reply(&owner,"nesvo_list_sessions",json!({})).await?;
        assert!(sessions["data"]["sessions"].as_array().context("No preflight process")?.is_empty());
        assert_eq!(launched_workers(&fixture)?,0);
        envelopes.extend(retained_generation(&owner,row,"failed").await?);
        phase = "strict exact-generation and explicit acknowledgment refusals";
        let ack = json!({"key":"abandon-real-preflight","jobId":job,"occurrenceId":id,"jobAttemptId":row["jobAttemptId"],"expectedDigest":digest,"acknowledgeUnknownEffects":true});
        let mut wrong_digest = ack.clone();wrong_digest["key"]="wrong-preflight-digest".into();wrong_digest["expectedDigest"]="0".repeat(64).into();
        envelopes.push(refusal(&owner,"nesvo_abandon_job_launch",wrong_digest,"occurrence_conflict").await?);
        let mut wrong_generation = ack.clone();wrong_generation["key"]="wrong-preflight-generation".into();wrong_generation["jobAttemptId"]="f".repeat(32).into();
        envelopes.push(refusal(&owner,"nesvo_abandon_job_launch",wrong_generation,"occurrence_conflict").await?);
        let mut missing_ack = ack.clone();missing_ack["key"]="missing-preflight-ack".into();missing_ack["acknowledgeUnknownEffects"]=false.into();
        envelopes.push(refusal(&owner,"nesvo_abandon_job_launch",missing_ack,"invalid_argument").await?);
        phase = "owner CLI acknowledgment and immutable MCP replay";
        let accepted = budgets::owner_cli(&fixture,&["job","abandon-launch",job,id,"--job-attempt-id",row["jobAttemptId"].as_str().context("Exact preflight generation")?,"--key","abandon-real-preflight","--digest",digest,"--acknowledge-unknown-effects","--json"]).await?;
        let resolved = &accepted["data"]["occurrence"];
        assert_eq!(resolved["state"],"canceled");
        assert_eq!(resolved["reason"],"launch_owner_abandoned");
        assert!(resolved["finishedAt"].is_number());
        identity(resolved,&resolved["launchResolution"]);
        assert_eq!(resolved["launchResolution"]["digest"],digest);
        assert_eq!(resolved["launchResolution"]["mutationKey"],"abandon-real-preflight");
        assert!(resolved["launchResolution"]["acknowledgedAt"].is_number());
        assert_eq!(resolved["launchReconciliation"]["available"],false);
        assert_eq!(resolved["launchReconciliation"]["reason"],"generation_resolved");
        assert!(resolved["launchReconciliation"]["digest"].is_null());
        assert_eq!(resolved["precheck"],row["precheck"]);
        let replay = reply(&owner,"nesvo_abandon_job_launch",ack.clone()).await?;
        let original = reply(&owner,"nesvo_get_job_mutation",json!({"key":"abandon-real-preflight"})).await?;
        assert_eq!(replay["data"],accepted["data"]);
        assert_eq!(original["data"],accepted["data"]);
        let unchanged_receipt = reply(&owner,"nesvo_get_operation",json!({"id":row["launchReceiptId"]})).await?;
        assert_eq!(unchanged_receipt["data"]["receipt"],receipt["data"]["receipt"],"Owner acknowledgment does not rewrite native facts");
        assert_eq!(std::fs::read_to_string(&precheck_effects)?,"pass\n","Acknowledgment never repeats the approved command");
        assert_eq!(launched_workers(&fixture)?,0,"Acknowledgment alone never launches a worker");
        phase = "explicitly admit a separate occurrence after updating only future intent";
        let mut future = selected.clone();
        future["profile"]["cwd"] = fixture.directory.to_str().context("Owned existing future cwd")?.into();
        let edited = reply(&owner,"nesvo_update_job",json!({"key":"deliberate-future-profile","jobId":job,"expectedRevision":1,"spec":future})).await?;
        let separate = reply(&owner,"nesvo_run_job_now",json!({"key":"deliberate-new-occurrence","jobId":job,"expectedRevision":2})).await?;
        let second = separate["data"]["occurrence"]["id"].as_str().context("Separate deliberate occurrence")?;
        assert_ne!(second,id);
        let reported = waits::occurrence(&owner,job,second,"needsValidation").await?;
        let next = &reported["data"]["occurrence"];
        assert_eq!(next["jobAttemptOrdinal"],1);
        assert!(next["executionTimeout"].is_null() && next["retry"].is_null() && next["launchResolution"].is_null());
        for field in ["jobAttemptId","runId","attemptId","sessionId","launchReceiptId"] {
            assert!(next[field].is_string());
            assert_ne!(next[field],row[field],"New occurrence reused retired identity: {field}");
        }
        assert_eq!(resolved["spec"]["profile"]["cwd"],serde_json::to_value(&missing)?);
        let worker = next["sessionId"].as_str().context("Only actual worker")?;
        observed_output(&owner,worker,"FIXTURE_RESPONSE report-task").await?;
        assert_eq!(launched_workers(&fixture)?,1);
        assert_eq!(std::fs::read_to_string(&precheck_effects)?,"pass\npass\n");
        let output = reply(&owner,"nesvo_read_session",json!({"sessionId":worker,"maxBytes":8192})).await?;
        assert_eq!(output["data"]["page"]["data"].as_str().context("Worker transcript")?.matches("FIXTURE_RESPONSE report-task").count(),1);
        let context = PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{worker}.txt")))?);
        let scoped = scoped_client(&context,worker).await?;
        let denied = call(&scoped,"nesvo_abandon_job_launch",ack.clone()).await?.structured_content.context("Worker owner-only refusal")?;
        assert!(matches!(denied["error"]["code"].as_str(),Some("forbidden"|"unsupported")),"Unexpected worker owner-only result: {denied}");
        scoped.cancel().await?;
        phase = "permanent old-generation controls and launch fences";
        let old_run = row["runId"].as_str().context("Retired run")?;
        let run = reply(&owner,"nesvo_get_run",json!({"runId":old_run})).await?;
        let stop_refused = refusal(&owner,"nesvo_stop_run",json!({"key":"do-not-stop-abandoned-preflight","runId":old_run,"expectedRevision":run["data"]["run"]["revision"]}),"job_generation_retired").await?;
        let launch_reply = call(&owner,"nesvo_launch_task",json!({"key":"do-not-relaunch-abandoned-preflight","runId":old_run,"taskId":run["data"]["tasks"][0]["id"],"expectedRevision":run["data"]["run"]["revision"],"profile":{"program":"claude","workspace":"shared","harness":true}})).await?;
        ensure!(launch_reply.is_error==Some(true),"Retired preflight run launched another native attempt");
        let launch_refused = launch_reply.structured_content.context("Retired launch refusal")?;
        assert!(matches!(launch_refused["error"]["code"].as_str(),Some("job_generation_retired"|"run_state_conflict")),"Unexpected earlier launch fence: {launch_refused}");
        let final_first = read(&owner,job,id).await?;
        assert_eq!(final_first["data"]["occurrence"],*resolved);
        envelopes.extend(retained_generation(&owner,&final_first["data"]["occurrence"],"failed").await?);
        let history = reply(&owner,"nesvo_get_job_history",json!({"jobId":job})).await?;
        assert_eq!(history["data"]["occurrences"].as_array().context("Two deliberate occurrences")?.len(),2);
        let final_sessions = reply(&owner,"nesvo_list_sessions",json!({})).await?;
        let rows = final_sessions["data"]["sessions"].as_array().context("One actual provider process")?;
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["id"],worker);
        assert_eq!(rows[0]["running"],true);
        ensure!(!missing.exists(),"Native refusal must not fabricate or repair the missing old cwd");
        let admission_replay = reply(&owner,"nesvo_run_job_now",arguments).await?;
        assert_eq!(admission_replay["data"],admitted["data"]);
        envelopes.extend([created,admitted.clone(),reconcilable.clone(),receipt,sessions,accepted.clone(),replay,original,unchanged_receipt,edited,separate,reported,output,denied,run,stop_refused,launch_refused,final_first,history,final_sessions,admission_replay]);
        phase = "published schema validation of actual positive-path envelopes";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    finish(&mut fixture, phase, diagnostic_job.as_deref(), outcome).await
}
