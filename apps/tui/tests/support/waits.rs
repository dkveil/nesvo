use super::*;

type Client = RunningService<RoleClient, ()>;

const POLL_INTERVAL: Duration = Duration::from_millis(50);
pub(super) const SETTLED_OCCURRENCE: [&str; 4] = ["succeeded", "failed", "skipped", "canceled"];
const SETTLED_READINESS: [&str; 2] = ["timedOut", "exited"];
const SETTLED_RECEIPT: [&str; 4] = ["failed", "unknown", "interrupted", "settled"];
const SETTLED_DELIVERY: [&str; 6] = ["sent", "failed", "paused", "expired", "canceled", "unknown"];
const SETTLED_RUN: [&str; 5] = ["succeeded", "failed", "canceled", "stopped", "drained"];
const SETTLED_ATTEMPT: [&str; 5] = [
    "succeeded",
    "failed",
    "stopped",
    "launchFailed",
    "launchUnknown",
];

pub(super) async fn until<T>(mut probe: impl AsyncFnMut() -> Result<Option<T>>) -> Result<T> {
    loop {
        if let Some(value) = probe().await? {
            return Ok(value);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn occurrence(owner: &Client, job: &str, id: &str, wanted: &str) -> Result<Value> {
    until(async || {
        let view = data(
            call(
                owner,
                "nesvo_get_job_occurrence",
                json!({"jobId":job,"occurrenceId":id}),
            )
            .await?,
        )?;
        let state = &view["data"]["occurrence"]["state"];
        if state == wanted {
            return Ok(Some(view));
        }
        ensure!(
            !is_settled_occurrence(state),
            "Bound occurrence settled before reaching {wanted}: {view}"
        );
        Ok(None)
    })
    .await
}

pub(super) fn is_settled_occurrence(state: &Value) -> bool {
    state
        .as_str()
        .is_some_and(|state| SETTLED_OCCURRENCE.contains(&state))
}

pub(super) fn is_settled_run(state: &Value) -> bool {
    state
        .as_str()
        .is_some_and(|state| SETTLED_RUN.contains(&state))
}

pub(super) fn is_settled_attempt(state: &Value) -> bool {
    state
        .as_str()
        .is_some_and(|state| SETTLED_ATTEMPT.contains(&state))
}

pub(super) async fn history_occurrence(
    owner: &Client,
    job: &str,
    index: usize,
    wanted: &str,
) -> Result<Value> {
    until(async || {
        let history = data(call(owner, "nesvo_get_job_history", json!({"jobId":job})).await?)?;
        let state = &history["data"]["occurrences"][index]["state"];
        if state == wanted {
            return Ok(Some(history));
        }
        ensure!(
            !is_settled_occurrence(state),
            "Job occurrence {index} settled before reaching {wanted}: {history}"
        );
        Ok(None)
    })
    .await
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Session {
    Ready,
    Released,
    Stopped,
}

impl Session {
    fn reached(self, session: &Value) -> bool {
        match self {
            Self::Ready => {
                session["readiness"]["phase"] == "ready" && session["status"]["state"] == "idle"
            }

            Self::Released => session["controllerId"].is_null(),
            Self::Stopped => session["running"] == false,
        }
    }

    fn settled(self, session: &Value) -> bool {
        match self {
            Self::Ready => {
                session["running"] == false
                    || session["readiness"]["phase"]
                        .as_str()
                        .is_some_and(|phase| SETTLED_READINESS.contains(&phase))
            }
            Self::Released => session["running"] == false,
            Self::Stopped => false,
        }
    }
}

pub(super) async fn session(client: &Client, id: &str, wanted: Session) -> Result<Value> {
    until(async || {
        let view = data(call(client, "nesvo_get_session", json!({"sessionId":id})).await?)?;
        let session = &view["data"]["session"];
        if wanted.reached(session) {
            return Ok(Some(view));
        }
        ensure!(
            !wanted.settled(session),
            "Session {id} settled before reaching {wanted:?}: {session}"
        );
        Ok(None)
    })
    .await
}

pub(super) async fn exited(client: &Client, id: &str) -> Result<bool> {
    let view = data(call(client, "nesvo_get_session", json!({"sessionId":id})).await?)?;
    Ok(view["data"]["session"]["running"] == false)
}

async fn page_with(client: &Client, id: &str, marker: &str) -> Result<Option<Value>> {
    let page = data(
        call(
            client,
            "nesvo_read_session",
            json!({"sessionId":id,"maxBytes":8192}),
        )
        .await?,
    )?;
    Ok(page["data"]["page"]["data"]
        .as_str()
        .is_some_and(|text| text.contains(marker))
        .then_some(page))
}

pub(super) async fn output(client: &Client, id: &str, marker: &str) -> Result<Value> {
    until(async || {
        if let Some(page) = page_with(client, id, marker).await? {
            return Ok(Some(page));
        }
        if exited(client, id).await? {
            return page_with(client, id, marker)
                .await?
                .with_context(|| format!("Session {id} exited without output {marker}"))
                .map(Some);
        }
        Ok(None)
    })
    .await
}

fn json_file(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub(super) async fn caller_file(client: &Client, writer: &str, path: &Path) -> Result<Value> {
    until(async || {
        if let Some(value) = json_file(path) {
            return Ok(Some(value));
        }
        if exited(client, writer).await? {
            return json_file(path)
                .with_context(|| {
                    format!("Session {writer} exited before writing {}", path.display())
                })
                .map(Some);
        }
        Ok(None)
    })
    .await
}

pub(super) async fn receipt(
    client: &Client,
    id: &Value,
    session: &str,
    milestone: &str,
) -> Result<Value> {
    until(async || {
        let view = data(call(client, "nesvo_get_operation", json!({"id":id})).await?)?;
        let receipt = &view["data"]["receipt"];
        ensure!(
            receipt["sessionId"] == session,
            "Receipt {id} belongs to another session: {receipt}"
        );
        if receipt_reached(receipt, milestone) {
            return Ok(Some(view));
        }
        ensure!(
            !receipt["phase"]
                .as_str()
                .is_some_and(|phase| SETTLED_RECEIPT.contains(&phase)),
            "Receipt {id} settled before reaching {milestone}: {receipt}"
        );
        ensure!(
            milestone == "delivered" || receipt["result"]["correlation"] != "unavailable",
            "Receipt {id} has no provider correlation for {milestone}: {receipt}"
        );
        Ok(None)
    })
    .await
}

fn receipt_reached(receipt: &Value, milestone: &str) -> bool {
    let result = &receipt["result"];
    match milestone {
        "delivered" => {
            result["nativeWriteFlushed"] == true || result["providerPromptObserved"] == true
        }
        "received" => result["providerPromptObserved"] == true,
        "started" => result["processingObserved"] == true,
        _ => receipt["phase"] == "settled",
    }
}

pub(super) async fn delivery(
    owner: &Client,
    run: &str,
    task: &Value,
    index: usize,
    wanted: &str,
) -> Result<Value> {
    until(async || {
        let view = data(
            call(
                owner,
                "nesvo_get_task_attempts",
                json!({"runId":run,"taskId":task}),
            )
            .await?,
        )?;
        let phase = &view["data"]["attempts"][index]["delivery"]["phase"];
        if phase == wanted {
            return Ok(Some(view));
        }
        ensure!(
            !phase
                .as_str()
                .is_some_and(|phase| SETTLED_DELIVERY.contains(&phase)),
            "Task delivery settled before reaching {wanted}: {view}"
        );
        Ok(None)
    })
    .await
}

pub(super) async fn provider(fixture: &Fixture, program: &str) -> Result<Value> {
    until(async || {
        let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
        let status = doctor["providerVersions"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["program"] == program))
            .map(|row| row["status"].clone())
            .unwrap_or_default();
        ensure!(
            status != "unavailable",
            "Provider {program} version probe settled unavailable: {}",
            doctor["providerVersions"]
        );
        Ok((status == "ready").then_some(doctor))
    })
    .await
}

fn exceeded_adapter_bound(result: &CallToolResult) -> bool {
    result.is_error == Some(true)
        && result.structured_content.as_ref().is_some_and(|reply| {
            reply["error"]["code"] == "timeout" && reply["error"].get("receipt").is_none()
        })
}

pub(super) async fn operation(client: &Client, name: &'static str, args: Value) -> Result<Value> {
    let key = args["key"].clone();
    let result = call(client, name, args).await?;
    if !exceeded_adapter_bound(&result) {
        return data(result);
    }
    let bound = result.structured_content.unwrap_or_default();
    until(async || {
        let view = data(call(client, "nesvo_get_operation", json!({"key":key})).await?)?;
        let phase = &view["data"]["receipt"]["phase"];
        if matches!(phase.as_str(), Some("accepted" | "dispatching")) {
            return Ok(None);
        }
        ensure!(
            !matches!(phase.as_str(), Some("failed" | "unknown" | "interrupted")),
            "Original key settled as {phase}: {view}"
        );
        Ok(Some(view))
    })
    .await
    .with_context(|| {
        format!("{name} exceeded the adapter request bound ({bound}); inspected its original key")
    })
}

#[test]
fn only_a_receiptless_adapter_timeout_is_recovered_through_its_original_key() {
    let bound = json!({"schemaVersion":1,"ok":false,"error":{"code":"timeout",
        "message":"Host request timed out; no operation was retried","retryable":true}});
    assert!(exceeded_adapter_bound(&CallToolResult::structured_error(
        bound.clone()
    )));
    let mut milestone = bound.clone();
    milestone["error"]["receipt"] = json!({"id":"1".repeat(32),"phase":"received"});
    assert!(!exceeded_adapter_bound(&CallToolResult::structured_error(
        milestone
    )));
    let mut refused = bound.clone();
    refused["error"]["code"] = json!("operation_failed");
    assert!(!exceeded_adapter_bound(&CallToolResult::structured_error(
        refused
    )));
    assert!(!exceeded_adapter_bound(&CallToolResult::structured(bound)));
}

#[test]
fn receipt_milestones_follow_the_host_wait_rules() {
    let receipt = |phase: &str, result: Value| json!({"phase":phase,"result":result});
    let flushed = receipt("delivered", json!({"nativeWriteFlushed":true}));
    assert!(receipt_reached(&flushed, "delivered"));
    assert!(!receipt_reached(&flushed, "received"));
    let observed = receipt("received", json!({"providerPromptObserved":true}));
    assert!(receipt_reached(&observed, "delivered"));
    assert!(receipt_reached(&observed, "received"));
    assert!(!receipt_reached(&observed, "started"));
    let processing = receipt(
        "started",
        json!({"providerPromptObserved":true,"processingObserved":true}),
    );
    assert!(receipt_reached(&processing, "started"));
    assert!(!receipt_reached(&processing, "settled"));
    assert!(receipt_reached(&receipt("settled", json!({})), "settled"));
}

pub(super) async fn cli(mut command: Command, label: &str) -> Result<Value> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().await?;
    ensure!(
        output.status.success(),
        "{label} failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
