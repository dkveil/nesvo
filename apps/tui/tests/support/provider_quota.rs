//! Official SDK/CLI -> native host -> controlled read-only Codex JSON-lines RPC.
use super::*;

const ACCOUNT: &str = "PRIVATE_QUOTA_ACCOUNT_DO_NOT_EXPOSE";
const PRIVATE_ERROR: &str = "PRIVATE_QUOTA_PROVIDER_ERROR_DO_NOT_EXPOSE";

fn snapshot() -> Value {
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
    let path = f.directory.join("callers/.fixture-quota.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({"mode":mode,"result":result,"delayMs":delay_ms}))?,
    )
    .with_context(|| format!("Write owned quota RPC fixture: {}", path.display()))
}

fn row(envelope: &Value) -> Result<&Value> {
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
    ensure!(
        records
            .iter()
            .all(|record| record["method"] == "account/rateLimits/read"),
        "Only read-only quota RPCs may be recorded"
    );
    Ok(records.len())
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
        PRIVATE_ERROR.to_owned(),
        "PRIVATE_MALFORMED_QUOTA_VALUE".into(),
        f.directory.to_string_lossy().into_owned(),
        f.directory
            .join("callers/.codex")
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
