//! Official SDK/CLI -> native host -> controlled read-only Codex JSON-lines RPC.
use super::*;

const ACCOUNT: &str = "PRIVATE_QUOTA_ACCOUNT_DO_NOT_EXPOSE";
const ACCOUNT_B: &str = "PRIVATE_QUOTA_ACCOUNT_B_DO_NOT_EXPOSE";
const PRIVATE_ERROR: &str = "PRIVATE_QUOTA_PROVIDER_ERROR_DO_NOT_EXPOSE";

pub(super) fn snapshot() -> Value {
    let now = chrono::Utc::now().timestamp();
    json!({
        "accountId": ACCOUNT,
        "ordinaryUsageAllowed": true,
        "rateLimits": {
            "primary":{"usedPercent":23,"windowDurationMins":300,"resetsAt":now+3600},
            "secondary":{"usedPercent":37,"windowDurationMins":10080,"resetsAt":now+86400}
        }
    })
}

fn configure(f: &Fixture, mode: &str, result: Value, delay_ms: u64) -> Result<()> {
    configure_source(f, json!({"mode":mode,"result":result,"delayMs":delay_ms}))
}

pub(super) fn configure_source(f: &Fixture, configuration: Value) -> Result<()> {
    let path = f.directory.join("callers/.fixture-quota.json");
    std::fs::write(&path, serde_json::to_vec(&configuration)?)
        .with_context(|| format!("Write owned quota RPC fixture: {}", path.display()))
}

pub(super) fn row(envelope: &Value) -> Result<&Value> {
    envelope["data"]["providers"]
        .as_array()
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider["program"] == "codex")
        })
        .context("Native Codex quota observation")
}

async fn query(owner: &RunningService<RoleClient, ()>, refresh: bool) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_provider_quota",
            json!({"program":"codex","refresh":refresh}),
        )
        .await?,
    )
}

pub(super) async fn context_query(
    owner: &RunningService<RoleClient, ()>,
    directory: &Path,
    refresh: bool,
) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_provider_quota",
            json!({"program":"codex","directory":directory,"refresh":refresh}),
        )
        .await?,
    )
}

pub(super) async fn context_revision(
    owner: &RunningService<RoleClient, ()>,
    directory: &Path,
    expected: u64,
) -> Result<Value> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(15), async {
        loop {
            let current = context_query(owner, directory, false).await?;
            if row(&current)?["revision"]
                .as_u64()
                .is_some_and(|revision| revision >= expected)
            {
                return Ok::<_, anyhow::Error>(current);
            }
            last = current;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .with_context(|| format!("Context quota revision {expected} not observed; last: {last}"))?
}

pub(super) async fn context_refresh(
    owner: &RunningService<RoleClient, ()>,
    directory: &Path,
) -> Result<Value> {
    timeout(Duration::from_secs(8), async {
        loop {
            let accepted = context_query(owner, directory, true).await?;
            match accepted["data"]["refresh"]["state"].as_str() {
                Some("queued" | "pending") => return Ok::<_, anyhow::Error>(accepted),
                Some("cooldown") => {
                    let delay = accepted["data"]["refresh"]["retryAfterMs"]
                        .as_u64()
                        .context("Context cooldown")?;
                    tokio::time::sleep(Duration::from_millis(delay.clamp(1, 5000))).await;
                }
                _ => anyhow::bail!("Unknown context refresh: {accepted}"),
            }
        }
    })
    .await
    .context("Bounded contextual owner refresh")?
}

async fn revision(owner: &RunningService<RoleClient, ()>, expected: u64) -> Result<Value> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(12), async {
        loop {
            let current = query(owner, false).await?;
            if row(&current)?["revision"]
                .as_u64()
                .is_some_and(|value| value >= expected)
            {
                return Ok::<_, anyhow::Error>(current);
            }
            last = current;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .with_context(|| format!("Quota revision {expected} not observed; last: {last}"))?
}

async fn refresh(owner: &RunningService<RoleClient, ()>) -> Result<Value> {
    timeout(Duration::from_secs(8), async {
        loop {
            let accepted = query(owner, true).await?;
            let request = &accepted["data"]["refresh"];
            match request["state"].as_str() {
                Some("queued" | "pending") => return Ok::<_, anyhow::Error>(accepted),
                Some("cooldown") => {
                    let delay = request["retryAfterMs"]
                        .as_u64()
                        .context("Quota cooldown delay")?;
                    tokio::time::sleep(Duration::from_millis(delay.clamp(1, 5000))).await;
                }
                _ => anyhow::bail!("Unknown native quota refresh result: {accepted}"),
            }
        }
    })
    .await
    .context("Bounded quota owner refresh admission")?
}

fn read_count(f: &Fixture) -> Result<usize> {
    let path = f.directory.join("callers/.fixture-quota-reads.jsonl");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("Read private quota RPC count: {}", path.display()))?;
    let records = text
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut per_process = std::collections::BTreeMap::<u64, usize>::new();
    let expected = [
        ("initialize", json!(1)),
        ("initialized", Value::Null),
        ("account/read", json!(2)),
        ("config/read", json!(3)),
        ("account/rateLimits/read", json!(4)),
    ];
    let mut quota_reads = 0;
    for record in records {
        let pid = record["pid"]
            .as_u64()
            .context("Owned quota reader process")?;
        let next = per_process.entry(pid).or_default();
        let (method, id) = expected
            .get(*next)
            .context("Only one bounded read per original process")?;
        ensure!(
            record["method"] == *method && record["id"] == *id,
            "Only the frozen read-only account/config/quota RPC sequence is allowed"
        );
        match *method {
            "account/read" => assert_eq!(record["params"], json!({"refreshToken":false})),
            "config/read" => {
                assert_eq!(record["params"]["includeLayers"], false);
                ensure!(
                    record["params"]["cwd"]
                        .as_str()
                        .is_some_and(|cwd| Path::new(cwd).is_absolute()),
                    "Config read must name the actual absolute directory"
                );
                assert_eq!(
                    record["params"].as_object().map(|params| params.len()),
                    Some(2)
                );
            }
            "account/rateLimits/read" => {
                assert_eq!(record["params"], json!({}));
                quota_reads += 1;
            }
            _ => {}
        }
        ensure!(
            record["home"]
                .as_str()
                .is_some_and(|home| Path::new(home).is_absolute()),
            "Reader must receive explicit owned CODEX_HOME"
        );
        *next += 1;
    }
    Ok(quota_reads)
}

fn private(envelopes: &[Value], f: &Fixture) -> Result<()> {
    fn contains(value: &Value, secret: &str) -> bool {
        match value {
            Value::String(value) => value.contains(secret),
            Value::Array(values) => values.iter().any(|value| contains(value, secret)),
            Value::Object(values) => values.values().any(|value| contains(value, secret)),
            _ => false,
        }
    }
    for secret in [
        ACCOUNT.to_owned(),
        ACCOUNT_B.to_owned(),
        PRIVATE_ERROR.to_owned(),
        "PRIVATE_QUOTA_EMAIL_DO_NOT_EXPOSE".into(),
        "PRIVATE_MALFORMED_QUOTA_VALUE".into(),
        f.directory.to_string_lossy().into_owned(),
        f.directory
            .join("codex-home")
            .to_string_lossy()
            .into_owned(),
    ] {
        ensure!(
            !envelopes.iter().any(|value| contains(value, &secret)),
            "Public quota metadata exposed private provider source data"
        );
    }
    Ok(())
}

fn fingerprint(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

async fn no_sessions(owner: &RunningService<RoleClient, ()>) -> Result<()> {
    let sessions = data(call(owner, "nesvo_list_sessions", json!({})).await?)?;
    ensure!(
        sessions["data"]["sessions"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "Quota observations must not launch native sessions"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "native read-only quota RPC, coalesced owner refreshes, privacy and failed-read freshness"]
async fn native_quota_refresh_coalesces_and_failed_read_cannot_refresh_success_or_permission()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(40), async {
        let owner = client(&f.pairing()).await?;
        let initial = revision(&owner, 1).await?;
        assert_eq!(row(&initial)?["status"], "unavailable");
        assert_eq!(row(&initial)?["reason"], "provider_error");
        assert_eq!(read_count(&f)?, 1);
        no_sessions(&owner).await?;
        let all = data(call(&owner, "nesvo_get_provider_quota", json!({})).await?)?;
        let doctor = budgets::owner_cli(&f, &["doctor", "--json"]).await?;
        let mut installed = doctor["programs"]
            .as_array()
            .context("Detected native programs")?
            .iter()
            .filter(|program| program["available"] == true && program["id"] != "shell")
            .map(|program| program["id"].as_str().context("Installed program ID"))
            .collect::<Result<Vec<_>>>()?;
        let mut reported = all["data"]["providers"]
            .as_array()
            .context("Reported installed provider quotas")?
            .iter()
            .map(|program| program["program"].as_str().context("Quota program ID"))
            .collect::<Result<Vec<_>>>()?;
        installed.sort_unstable();
        reported.sort_unstable();
        assert_eq!(
            reported, installed,
            "Quota metadata includes only detected installed providers"
        );

        let saved = snapshot();
        configure(&f, "heldSnapshot", saved.clone(), 0)?;
        let queued = refresh(&owner).await?;
        let target = queued["data"]["refresh"]["revision"]
            .as_u64()
            .context("Refresh target revision")?;
        let (first, second) = tokio::join!(query(&owner, true), query(&owner, true));
        let (first, second) = (first?, second?);
        for pending in [&first, &second] {
            assert!(matches!(
                pending["data"]["refresh"]["state"].as_str(),
                Some("queued" | "pending")
            ));
            assert_eq!(pending["data"]["refresh"]["revision"], target);
            assert_eq!(
                row(pending)?["observedAt"],
                Value::Null,
                "Queued refresh is not a completed observation"
            );
        }
        let release = f.directory.join("callers/.fixture-quota-release");
        std::fs::write(&release, "Both concurrent owner refreshes were observed").with_context(
            || {
                format!(
                    "Release owned held quota RPC response: {}",
                    release.display()
                )
            },
        )?;
        let good = revision(&owner, target).await?;
        let good_row = row(&good)?;
        assert_eq!(good_row["source"], "codexAppServer");
        assert_eq!(good_row["status"], "ready");
        assert_eq!(good_row["freshness"], "fresh");
        assert_eq!(good_row["complete"], true);
        assert_eq!(good_row["ordinaryUsageAllowed"], true);
        assert_eq!(good_row["ordinaryUsageEligible"], true);
        assert_eq!(good_row["eligibilityReason"], "observed");
        assert_eq!(good_row["scope"], "readerSnapshotOnly");
        assert!(
            fingerprint(&good_row["contextId"]) && fingerprint(&good_row["accountFingerprint"])
        );
        assert_eq!(
            good_row["windows"]
                .as_array()
                .context("Two complete quota windows")?
                .len(),
            2
        );
        assert!(good_row["observedAt"].is_number() && good_row["expiresAt"].is_number());
        assert!(good_row["sourceAt"].is_null());
        assert_eq!(
            read_count(&f)?,
            2,
            "Concurrent refreshes share one original CLI read"
        );
        let cooldown =
            budgets::owner_cli(&f, &["quota", "--program", "codex", "--refresh", "--json"]).await?;
        assert_eq!(cooldown["data"]["refresh"]["state"], "cooldown");
        assert_eq!(cooldown["data"]["refresh"]["revision"], target);
        assert!(
            cooldown["data"]["refresh"]["retryAfterMs"]
                .as_u64()
                .is_some_and(|value| value > 0)
        );

        // Equal source contents still form a new completed observation revision.
        configure(&f, "snapshot", saved.clone(), 0)?;
        let unchanged_request = refresh(&owner).await?;
        let unchanged_target = unchanged_request["data"]["refresh"]["revision"]
            .as_u64()
            .context("Unchanged read target")?;
        assert_eq!(unchanged_target, target + 1);
        let unchanged = revision(&owner, unchanged_target).await?;
        assert_eq!(row(&unchanged)?["windows"], good_row["windows"]);
        assert_eq!(row(&unchanged)?["contextId"], good_row["contextId"]);
        assert_eq!(
            row(&unchanged)?["accountFingerprint"],
            good_row["accountFingerprint"]
        );
        assert!(row(&unchanged)?["observedAt"].as_u64() > good_row["observedAt"].as_u64());
        assert_eq!(read_count(&f)?, 3);

        // A sparse quota notification is not a full account/permission read.
        configure(&f, "sparseThenError", saved, 0)?;
        let failed_request = refresh(&owner).await?;
        let failed_target = failed_request["data"]["refresh"]["revision"]
            .as_u64()
            .context("Failed read target")?;
        let failed = revision(&owner, failed_target).await?;
        let failed_row = row(&failed)?;
        assert_eq!(failed_row["status"], "unavailable");
        assert_eq!(failed_row["freshness"], "unavailable");
        assert_eq!(failed_row["reason"], "provider_error");
        assert_eq!(failed_row["complete"], false);
        assert_eq!(failed_row["ordinaryUsageAllowed"], Value::Null);
        assert_eq!(failed_row["ordinaryUsageEligible"], false);
        assert_eq!(failed_row["observedAt"], row(&unchanged)?["observedAt"]);
        assert_eq!(failed_row["expiresAt"], row(&unchanged)?["expiresAt"]);
        assert!(failed_row["attemptedAt"].as_u64() > row(&unchanged)?["attemptedAt"].as_u64());
        assert_eq!(read_count(&f)?, 4);
        let cli = budgets::owner_cli(&f, &["quota", "--program", "codex", "--json"]).await?;
        assert_eq!(row(&cli)?["revision"], failed_target);
        assert_eq!(row(&cli)?["observedAt"], failed_row["observedAt"]);
        assert_eq!(row(&cli)?["ordinaryUsageEligible"], false);
        no_sessions(&owner).await?;
        let envelopes = vec![
            initial,
            all,
            queued,
            first,
            second,
            good,
            cooldown,
            unchanged_request,
            unchanged,
            failed_request,
            failed,
            cli,
        ];
        private(&envelopes, &f)?;
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = f.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native quota refresh acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "native malformed/sparse quota sources, bounded read timeout and scoped owner-only boundary"]
async fn native_quota_rejects_malformed_secondary_and_sparse_notifications_without_authority()
-> Result<()> {
    let mut f = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(40), async {
        let owner = client(&f.pairing()).await?;
        let initial = revision(&owner, 1).await?;
        let mut malformed = snapshot();
        malformed["rateLimits"]["secondary"]["usedPercent"] = json!("PRIVATE_MALFORMED_QUOTA_VALUE");
        configure(&f, "snapshot", malformed, 0)?;
        let malformed_request = refresh(&owner).await?;
        let malformed_target = malformed_request["data"]["refresh"]["revision"].as_u64().context("Malformed source revision")?;
        let invalid = revision(&owner, malformed_target).await?;
        assert_eq!(row(&invalid)?["reason"], "invalid_response");
        assert_eq!(row(&invalid)?["status"], "unavailable");
        assert_eq!(row(&invalid)?["ordinaryUsageEligible"], false);
        assert_eq!(row(&invalid)?["ordinaryUsageAllowed"], Value::Null);
        assert!(row(&invalid)?["observedAt"].is_null());
        assert!(row(&invalid)?["windows"].as_array().is_some_and(Vec::is_empty));

        configure(&f, "sparseOnly", snapshot(), 0)?;
        let sparse_request = refresh(&owner).await?;
        let sparse_target = sparse_request["data"]["refresh"]["revision"].as_u64().context("Sparse source revision")?;
        let sparse = revision(&owner, sparse_target).await?;
        assert_eq!(row(&sparse)?["reason"], "timeout");
        assert_eq!(row(&sparse)?["ordinaryUsageEligible"], false);
        assert!(row(&sparse)?["observedAt"].is_null());
        assert!(row(&sparse)?["accountFingerprint"].is_null());
        assert_eq!(read_count(&f)?, 3);
        no_sessions(&owner).await?;

        // The controlled original process exercises the actual scoped caller,
        // rather than supplying an invented owner identity to an internal helper.
        let created = data(call(&owner,"nesvo_create_session",json!({"key":"quota-owner-only-worker","spec":{"name":"Quota owner-only fixture","program":"claude","harness":true}})).await?)?;
        let id = created["data"]["receipt"]["sessionId"].as_str().context("Quota scoped worker")?;
        session_ready(&owner, id).await?;
        let context = PathBuf::from(std::fs::read_to_string(f.directory.join("callers").join(format!("{id}.txt")))?);
        let worker = scoped_client(&context, id).await?;
        let denied = call(&worker,"nesvo_get_provider_quota",json!({"program":"codex","refresh":true})).await?;
        assert_eq!(denied.is_error, Some(true));
        let denied = denied.structured_content.context("Scoped quota refusal")?;
        assert_eq!(denied["error"]["code"], "forbidden");
        assert_eq!(read_count(&f)?, 3, "Scoped refusal must not start another quota reader");
        let envelopes = vec![initial,malformed_request,invalid,sparse_request,sparse,created,denied];
        private(&envelopes, &f)?;
        run_checkpoints::schema(envelopes).await?;
        worker.cancel().await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = f.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded native quota negative acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

fn configure_context_pair(
    fixture: &Fixture,
    directory_a: &Path,
    quota_a: Value,
    directory_b: &Path,
    quota_b: Value,
) -> Result<()> {
    let mut contexts = serde_json::Map::new();
    for (directory, result) in [(directory_a, quota_a), (directory_b, quota_b)] {
        contexts.insert(
            directory.to_str().context("Owned quota directory")?.into(),
            json!({"mode":"snapshot","result":result}),
        );
    }
    configure_source(fixture, json!({"mode":"error","contexts":contexts}))
}

async fn admit_quota_job(
    owner: &RunningService<RoleClient, ()>,
    key: &str,
    directory: &Path,
    binding: &Value,
) -> Result<(Value, Value)> {
    // Controlled Codex PTY reports through its session-bound CLI context.
    // This does not assert original Codex MCP injection support.
    let created=data(call(owner,"nesvo_create_job",json!({"key":format!("{key}:definition"),"spec":{
        "title":"Controlled configured-account quota job","instruction":"report-task",
        "profile":{"program":"codex","workspace":"shared","cwd":directory},
        "schedule":{"kind":"once","at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()},
        "quotaPolicy":{"mode":"wait","contextId":binding["contextId"],"accountFingerprint":binding["accountFingerprint"]}
    }})).await?)?;
    let job = created["data"]["job"]["id"]
        .as_str()
        .context("Quota job ID")?;
    let admitted = data(
        call(
            owner,
            "nesvo_run_job_now",
            json!({"key":key,"jobId":job,"expectedRevision":1}),
        )
        .await?,
    )?;
    Ok((created, admitted))
}

async fn quota_occurrence(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    occurrence: &str,
    state: &str,
) -> Result<Value> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(15), async {
        loop {
            let view = data(
                call(
                    owner,
                    "nesvo_get_job_occurrence",
                    json!({"jobId":job,"occurrenceId":occurrence}),
                )
                .await?,
            )?;
            if view["data"]["occurrence"]["state"] == state {
                return Ok::<_, anyhow::Error>(view);
            }
            last = view;
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    })
    .await
    .with_context(|| format!("Quota occurrence did not reach {state}; last: {last}"))?
}

fn unclaimed(occurrence: &Value) {
    assert_eq!(occurrence["state"], "queued");
    assert_eq!(occurrence["quota"]["state"], "waiting");
    for field in [
        "runId",
        "jobAttemptId",
        "attemptId",
        "sessionId",
        "launchReceiptId",
    ] {
        assert!(
            occurrence[field].is_null(),
            "Waiting quota must not allocate {field}"
        );
    }
}

async fn generations(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    occurrence: &str,
) -> Result<Value> {
    data(
        call(
            owner,
            "nesvo_get_job_attempts",
            json!({"jobId":job,"occurrenceId":occurrence}),
        )
        .await?,
    )
}

#[tokio::test]
#[ignore = "native SDK contextual quota readers, held queue fairness, cancellation, release and immutable replay"]
async fn native_quota_contexts_release_only_matching_jobs_and_cancellation_stays_terminal()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(timeout(Duration::from_secs(65),async {
        let owner=client(&fixture.pairing()).await?;
        revision(&owner,1).await?;
        let directory_a=fixture.directory.join("quota context a łódź");
        let directory_b=fixture.directory.join("quota context b");
        std::fs::create_dir(&directory_a)?;
        std::fs::create_dir(&directory_b)?;
        let mut denied=snapshot();
        denied["ordinaryUsageAllowed"]=json!(false);
        let mut allowed=snapshot();
        allowed["accountId"]=json!(ACCOUNT_B);
        configure_context_pair(&fixture,&directory_a,denied,&directory_b,allowed.clone())?;

        let first=context_query(&owner,&directory_a,false).await?;
        let source_a=context_revision(&owner,&directory_a,1).await?;
        let source_b=context_revision(&owner,&directory_b,1).await?;
        let a=row(&source_a)?;
        let b=row(&source_b)?;
        assert_eq!(a["ordinaryUsageAllowed"],false,"Initial owned A source metadata: {}",json!({"status":a["status"],"reason":a["reason"],"revision":a["revision"],"freshness":a["freshness"],"complete":a["complete"]}));
        assert_eq!(a["ordinaryUsageEligible"],false);
        assert_eq!(b["ordinaryUsageEligible"],true);
        assert!(fingerprint(&a["contextId"]) && fingerprint(&a["accountFingerprint"]));
        assert!(fingerprint(&b["contextId"]) && fingerprint(&b["accountFingerprint"]));
        assert_ne!(a["readerId"],b["readerId"]);
        assert_ne!(a["contextId"],b["contextId"]);
        assert_ne!(a["accountFingerprint"],b["accountFingerprint"]);
        let repeated=context_query(&owner,&directory_a,false).await?;
        assert_eq!(row(&repeated)?["readerId"],a["readerId"],"Same canonical directory must coalesce its pinned reader");
        let cli=budgets::owner_cli(&fixture,&["quota","--program","codex","--directory",directory_b.to_str().context("Context CLI directory")?,"--json"]).await?;
        assert_eq!(row(&cli)?["readerId"],b["readerId"]);
        assert_eq!(row(&cli)?["contextId"],b["contextId"]);
        assert_eq!(read_count(&fixture)?,3,"One ambient and one original reader for each actual directory");
        no_sessions(&owner).await?;

        let (definition_a,admitted_a)=admit_quota_job(&owner,"quota-held-a",&directory_a,a).await?;
        let (definition_cancel,admitted_cancel)=admit_quota_job(&owner,"quota-cancel-a",&directory_a,a).await?;
        let (definition_b,admitted_b)=admit_quota_job(&owner,"quota-eligible-b",&directory_b,b).await?;
        let job_a=definition_a["data"]["job"]["id"].as_str().context("Held job")?;
        let occurrence_a=admitted_a["data"]["occurrence"]["id"].as_str().context("Held occurrence")?;
        let job_cancel=definition_cancel["data"]["job"]["id"].as_str().context("Canceled job")?;
        let occurrence_cancel=admitted_cancel["data"]["occurrence"]["id"].as_str().context("Canceled occurrence")?;
        let job_b=definition_b["data"]["job"]["id"].as_str().context("Eligible job")?;
        let occurrence_b=admitted_b["data"]["occurrence"]["id"].as_str().context("Eligible occurrence")?;

        // A real eligible worker/result proves the scheduler ran while older
        // denied-context work stayed out of its four dispatch slots.
        let reported_b=quota_occurrence(&owner,job_b,occurrence_b,"needsValidation").await?;
        let held_a=quota_occurrence(&owner,job_a,occurrence_a,"queued").await?;
        let held_cancel=quota_occurrence(&owner,job_cancel,occurrence_cancel,"queued").await?;
        unclaimed(&held_a["data"]["occurrence"]);
        unclaimed(&held_cancel["data"]["occurrence"]);
        let before_a=generations(&owner,job_a,occurrence_a).await?;
        let before_cancel=generations(&owner,job_cancel,occurrence_cancel).await?;
        assert!(before_a["data"]["jobAttempts"].as_array().is_some_and(Vec::is_empty));
        assert!(before_cancel["data"]["jobAttempts"].as_array().is_some_and(Vec::is_empty));
        let canceled=data(call(&owner,"nesvo_cancel_job_occurrence",json!({"key":"quota-cancel-before-release","jobId":job_cancel,"occurrenceId":occurrence_cancel})).await?)?;
        let terminal=quota_occurrence(&owner,job_cancel,occurrence_cancel,"canceled").await?;

        configure_context_pair(&fixture,&directory_a,snapshot(),&directory_b,allowed)?;
        let refresh=context_refresh(&owner,&directory_a).await?;
        assert_eq!(refresh["data"]["refresh"]["readerId"],a["readerId"]);
        let target=refresh["data"]["refresh"]["revision"].as_u64().context("Matching-context refresh revision")?;
        let recovered=context_revision(&owner,&directory_a,target).await?;
        assert_eq!(row(&recovered)?["contextId"],a["contextId"]);
        assert_eq!(row(&recovered)?["accountFingerprint"],a["accountFingerprint"]);
        assert_eq!(row(&recovered)?["ordinaryUsageEligible"],true);
        let reported_a=quota_occurrence(&owner,job_a,occurrence_a,"needsValidation").await?;
        let replay=data(call(&owner,"nesvo_run_job_now",json!({"key":"quota-held-a","jobId":job_a,"expectedRevision":1})).await?)?;
        assert_eq!(replay["data"],admitted_a["data"],"Lost-response replay preserves original queued acceptance after real launch");
        let cancel_replay=data(call(&owner,"nesvo_cancel_job_occurrence",json!({"key":"quota-cancel-before-release","jobId":job_cancel,"occurrenceId":occurrence_cancel})).await?)?;
        assert_eq!(cancel_replay["data"],canceled["data"]);
        let after_cancel=quota_occurrence(&owner,job_cancel,occurrence_cancel,"canceled").await?;
        for field in ["runId","jobAttemptId","attemptId","sessionId","launchReceiptId"] {assert!(after_cancel["data"]["occurrence"][field].is_null());}
        let after_a=generations(&owner,job_a,occurrence_a).await?;
        let after_b=generations(&owner,job_b,occurrence_b).await?;
        let canceled_generations=generations(&owner,job_cancel,occurrence_cancel).await?;
        assert_eq!(after_a["data"]["jobAttempts"].as_array().context("One recovered generation")?.len(),1);
        assert_eq!(after_b["data"]["jobAttempts"].as_array().context("One independent generation")?.len(),1);
        assert!(canceled_generations["data"]["jobAttempts"].as_array().is_some_and(Vec::is_empty));
        let sessions=data(call(&owner,"nesvo_list_sessions",json!({})).await?)?;
        assert_eq!(sessions["data"]["sessions"].as_array().context("Exactly two native quota workers")?.len(),2);
        assert_eq!(read_count(&fixture)?,4,"Refresh reads only the selected actual context");

        let quota_envelopes=vec![first,source_a,source_b,repeated,cli,refresh,recovered];
        private(&quota_envelopes,&fixture)?;
        let mut envelopes=quota_envelopes;
        envelopes.extend([definition_a,admitted_a,definition_cancel,admitted_cancel,definition_b,admitted_b,reported_b,held_a,held_cancel,before_a,before_cancel,canceled,terminal,reported_a,replay,cancel_replay,after_cancel,after_a,after_b,canceled_generations,sessions]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded contextual quota/job acceptance")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

async fn quota_held_for_reason(
    owner: &RunningService<RoleClient, ()>,
    job: &str,
    occurrence: &str,
    reason: &str,
) -> Result<Value> {
    let mut last = Value::Null;
    timeout(Duration::from_secs(5), async {
        loop {
            let envelope = data(
                call(
                    owner,
                    "nesvo_get_job_occurrence",
                    json!({"jobId":job,"occurrenceId":occurrence}),
                )
                .await?,
            )?;
            let current = &envelope["data"]["occurrence"];
            last = json!({
                "state":current["state"],"quota":current["quota"],
                "runId":current["runId"],"jobAttemptId":current["jobAttemptId"],
                "attemptId":current["attemptId"],"sessionId":current["sessionId"],
                "launchReceiptId":current["launchReceiptId"]
            });
            ensure!(
                current["state"] == "queued",
                "Quota refusal allocated work: {last}"
            );
            if current["quota"]["reason"] == reason {
                unclaimed(current);
                return Ok::<_, anyhow::Error>(envelope);
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .with_context(|| format!("Queued quota refusal {reason} was not published; metadata: {last}"))?
}

#[tokio::test]
#[ignore = "native SDK weekly-only quota admission, current refusal authority and one original job launch"]
async fn native_weekly_only_quota_releases_one_job_after_newer_refusals_without_inventing_windows()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(60), async {
        let owner = client(&fixture.pairing()).await?;
        let ambient = revision(&owner, 1).await?;
        let directory = fixture.directory.join("weekly quota context łódź");
        std::fs::create_dir(&directory)?;
        let mut weekly = snapshot();
        weekly["rateLimits"].as_object_mut().context("Owned quota bucket")?.remove("primary");
        let expected_windows = json!([{
            "usedPercent":weekly["rateLimits"]["secondary"]["usedPercent"],
            "durationMins":weekly["rateLimits"]["secondary"]["windowDurationMins"],
            "resetsAt":weekly["rateLimits"]["secondary"]["resetsAt"]
        }]);
        let mut initial_unknown = weekly.clone();
        initial_unknown["rateLimits"]["primary"] = Value::Null;
        initial_unknown["ordinaryUsageAllowed"] = Value::Null;
        configure(&fixture, "snapshot", initial_unknown, 0)?;
        let first = context_query(&owner, &directory, false).await?;
        let initial = context_revision(&owner, &directory, 1).await?;
        let binding = row(&initial)?.clone();
        assert_eq!(binding["source"], "codexAppServer");
        assert_eq!(binding["scope"], "readerSnapshotOnly");
        assert_eq!(binding["freshness"], "fresh");
        assert_eq!(binding["complete"], true, "A null slot must not require an invented window; metadata: {}", json!({"status":binding["status"],"reason":binding["reason"],"revision":binding["revision"],"freshness":binding["freshness"],"eligibilityReason":binding["eligibilityReason"]}));
        assert_eq!(binding["windows"], expected_windows);
        assert_eq!(binding["ordinaryUsageAllowed"], Value::Null);
        assert_eq!(binding["ordinaryUsageEligible"], false);
        assert!(fingerprint(&binding["contextId"]) && fingerprint(&binding["accountFingerprint"]));
        no_sessions(&owner).await?;

        let (definition, admitted) = admit_quota_job(&owner, "quota-weekly-release", &directory, &binding).await?;
        let job = definition["data"]["job"]["id"].as_str().context("Weekly quota job")?;
        let occurrence = admitted["data"]["occurrence"]["id"].as_str().context("Weekly quota occurrence")?;
        let held = quota_held_for_reason(&owner, job, occurrence, "backend_permission_unavailable").await?;
        let mut source_revision = held["data"]["occurrence"]["quota"]["sourceRevision"].as_u64().context("Initial writer quota revision")?;
        let mut quota_envelopes = vec![ambient, first, initial];
        let mut envelopes = vec![definition.clone(), admitted.clone(), held];

        let mut denied = weekly.clone();
        denied["rateLimits"]["primary"] = Value::Null;
        denied["ordinaryUsageAllowed"] = json!(false);
        let mut unknown = weekly.clone();
        unknown.as_object_mut().context("Owned quota response")?.remove("ordinaryUsageAllowed");
        let mut incomplete = weekly.clone();
        incomplete["rateLimits"]["secondary"] = json!({"usedPercent":37});
        for (mode, result, reason, permission) in [
            ("snapshot", denied, "backend_denied", json!(false)),
            ("snapshot", unknown, "backend_permission_unavailable", Value::Null),
            ("snapshot", incomplete, "incomplete_snapshot", json!(true)),
            ("error", Value::Null, "provider_error", Value::Null),
        ] {
            configure(&fixture, mode, result, 0)?;
            let accepted = context_refresh(&owner, &directory).await?;
            assert_eq!(accepted["data"]["refresh"]["readerId"], binding["readerId"]);
            let target = accepted["data"]["refresh"]["revision"].as_u64().context("Newer refusal read revision")?;
            let observed = context_revision(&owner, &directory, target).await?;
            let source = row(&observed)?;
            assert_eq!(source["eligibilityReason"], reason, "New refusal metadata: {}", json!({"status":source["status"],"reason":source["reason"],"revision":source["revision"],"freshness":source["freshness"],"complete":source["complete"]}));
            assert_eq!(source["readerId"], binding["readerId"]);
            assert_eq!(source["contextId"], binding["contextId"]);
            assert_eq!(source["accountFingerprint"], binding["accountFingerprint"]);
            assert_eq!(source["ordinaryUsageAllowed"], permission);
            assert_eq!(source["ordinaryUsageEligible"], false);
            if matches!(reason, "backend_denied" | "backend_permission_unavailable") {
                assert_eq!(source["complete"], true);
                assert_eq!(source["windows"], expected_windows, "Absent/null slots must never manufacture 0% windows");
            }
            let held = quota_held_for_reason(&owner, job, occurrence, reason).await?;
            let current_revision = held["data"]["occurrence"]["quota"]["sourceRevision"].as_u64().context("Published refusal revision")?;
            assert!(current_revision > source_revision, "Each refusal must reach the durable job gate");
            source_revision = current_revision;
            let attempts = generations(&owner, job, occurrence).await?;
            assert!(attempts["data"]["jobAttempts"].as_array().is_some_and(Vec::is_empty), "A current quota refusal must precede every attempt/precheck/Run");
            no_sessions(&owner).await?;
            quota_envelopes.extend([accepted, observed]);
            envelopes.extend([held, attempts]);
        }

        configure(&fixture, "snapshot", weekly, 0)?;
        let accepted = context_refresh(&owner, &directory).await?;
        let target = accepted["data"]["refresh"]["revision"].as_u64().context("Weekly release read revision")?;
        let recovered = context_revision(&owner, &directory, target).await?;
        let source = row(&recovered)?;
        assert_eq!(source["readerId"], binding["readerId"]);
        assert_eq!(source["contextId"], binding["contextId"]);
        assert_eq!(source["accountFingerprint"], binding["accountFingerprint"]);
        assert_eq!(source["complete"], true, "Weekly release metadata: {}", json!({"status":source["status"],"reason":source["reason"],"revision":source["revision"],"freshness":source["freshness"],"eligibilityReason":source["eligibilityReason"]}));
        assert_eq!(source["freshness"], "fresh");
        assert_eq!(source["ordinaryUsageAllowed"], true);
        assert_eq!(source["ordinaryUsageEligible"], true);
        assert_eq!(source["windows"], expected_windows, "The omitted slot must remain absent after release");
        let reported = quota_occurrence(&owner, job, occurrence, "needsValidation").await?;
        assert_eq!(reported["data"]["occurrence"]["id"], admitted["data"]["occurrence"]["id"]);
        let attempts = generations(&owner, job, occurrence).await?;
        assert_eq!(attempts["data"]["jobAttempts"].as_array().context("One weekly-quota generation")?.len(), 1);
        let replay = data(call(&owner, "nesvo_run_job_now", json!({"key":"quota-weekly-release","jobId":job,"expectedRevision":1})).await?)?;
        assert_eq!(replay["data"], admitted["data"], "Release must retain the original immutable acceptance");
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert_eq!(sessions["data"]["sessions"].as_array().context("One native weekly-quota worker")?.len(), 1);
        assert_eq!(read_count(&fixture)?, 7, "One ambient and six exact-context read-only RPC exchanges");
        quota_envelopes.extend([accepted, recovered]);
        private(&quota_envelopes, &fixture)?;
        envelopes.extend(quota_envelopes);
        envelopes.extend([reported, attempts, replay, sessions]);
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.context("Bounded weekly-only quota/job admission")??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
