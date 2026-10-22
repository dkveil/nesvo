use super::*;
use rmcp::{
    model::{ClientRequest, Request, ServerResult},
    service::{PeerRequestOptions, RequestHandle},
};

const PENDING_WAITS: usize = 4;
const MAX_REPLACEMENT_WAITS: usize = 16;
const MAX_OBSERVED_ENVELOPES: usize = 64;

fn record_observation(envelopes: &mut Vec<Value>, value: Value) {
    if envelopes.len() < MAX_OBSERVED_ENVELOPES {
        envelopes.push(value);
    }
}

async fn passive_wait(
    owner: &RunningService<RoleClient, ()>,
    receipt: &Value,
) -> Result<RequestHandle<RoleClient>> {
    let arguments = json!({"id":receipt["id"],"sessionId":receipt["sessionId"],"until":"settled","timeoutMs":60000});
    Ok(owner
        .peer()
        .send_cancellable_request(
            ClientRequest::CallToolRequest(Request::new(
                CallToolRequestParams::new("nesvo_wait_prompt").with_arguments(
                    arguments
                        .as_object()
                        .context("Passive wait arguments")?
                        .clone(),
                ),
            )),
            PeerRequestOptions::no_options(),
        )
        .await?)
}

async fn slots_proven_occupied_by_fifth_host_call(
    owner: &RunningService<RoleClient, ()>,
    receipt: &Value,
    envelopes: &mut Vec<Value>,
) -> Result<Vec<RequestHandle<RoleClient>>> {
    let mut waits = Vec::new();
    let mut admissions = 0;
    loop {
        retire_rejected_waits(&mut waits, envelopes)?;
        while waits.len() < PENDING_WAITS {
            ensure!(
                admissions < PENDING_WAITS + MAX_REPLACEMENT_WAITS,
                "Read-only wait admission exceeded {MAX_REPLACEMENT_WAITS} busy replacements"
            );
            waits.push(passive_wait(owner, receipt).await?);
            admissions += 1;
        }
        retire_rejected_waits(&mut waits, envelopes)?;
        if waits.len() != PENDING_WAITS {
            tokio::task::yield_now().await;
            continue;
        }
        let probe = call(
            owner,
            "nesvo_get_session",
            json!({"sessionId":receipt["sessionId"]}),
        )
        .await?;
        retire_rejected_waits(&mut waits, envelopes)?;
        if probe.is_error == Some(true) {
            ensure!(
                probe
                    .structured_content
                    .as_ref()
                    .is_some_and(|value| value["error"]["code"] == "busy"),
                "Unexpected capacity observation: {}",
                tool_metadata(&probe)
            );
            record_observation(
                envelopes,
                probe
                    .structured_content
                    .context("Four occupied MCP slots")?,
            );
            if waits.len() == PENDING_WAITS {
                return Ok(waits);
            }
        } else {
            record_observation(envelopes, data(probe)?);
        }
        tokio::task::yield_now().await;
    }
}

fn tool_metadata(reply: &CallToolResult) -> Value {
    let content = reply.structured_content.as_ref();
    json!({
        "kind":"toolResult",
        "isError":reply.is_error,
        "code":content.map(|value| value["error"]["code"].clone()),
        "receiptPhase":content.map(|value| value["data"]["receipt"]["phase"].clone()),
        "errorReceiptPhase":content.map(|value| value["error"]["receipt"]["phase"].clone()),
        "waitReached":content.map(|value| value["data"]["wait"]["reached"].clone())
    })
}

fn retire_rejected_waits(
    waits: &mut Vec<RequestHandle<RoleClient>>,
    envelopes: &mut Vec<Value>,
) -> Result<()> {
    let mut index = 0;
    while index < waits.len() {
        let metadata = match waits[index].rx.try_recv() {
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                index += 1;
                continue;
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                json!({"kind":"closedResponseChannel"})
            }
            Ok(Ok(ServerResult::CallToolResult(reply)))
                if reply.is_error == Some(true)
                    && reply
                        .structured_content
                        .as_ref()
                        .is_some_and(|value| value["error"]["code"] == "busy") =>
            {
                record_observation(
                    envelopes,
                    reply
                        .structured_content
                        .context("Rejected passive-wait admission")?,
                );
                drop(waits.remove(index));
                continue;
            }
            Ok(Ok(ServerResult::CallToolResult(reply))) => tool_metadata(&reply),
            Ok(Ok(_)) => json!({"kind":"unexpectedProtocolResult"}),
            Ok(Err(rmcp::ServiceError::McpError(error))) => {
                json!({"kind":"protocolError","code":error.code.0})
            }
            Ok(Err(_)) => json!({"kind":"serviceError"}),
        };
        anyhow::bail!("Passive wait {index} completed before four-slot capacity: {metadata}");
    }
    Ok(())
}

async fn recovered_read(
    owner: &RunningService<RoleClient, ()>,
    tool: &'static str,
    arguments: Value,
    envelopes: &mut Vec<Value>,
) -> Result<Value> {
    loop {
        let reply = call(owner, tool, arguments.clone()).await?;
        if reply.is_error != Some(true) {
            let value = data(reply)?;
            record_observation(envelopes, value.clone());
            return Ok(value);
        }
        ensure!(
            reply
                .structured_content
                .as_ref()
                .is_some_and(|value| value["error"]["code"] == "busy"),
            "Unexpected cancellation recovery from {tool}: {}",
            tool_metadata(&reply)
        );
        record_observation(
            envelopes,
            reply
                .structured_content
                .context("Pending cancellation slot release")?,
        );
        tokio::task::yield_now().await;
    }
}

async fn cancel_waits(waits: Vec<RequestHandle<RoleClient>>) -> Result<()> {
    for wait in waits {
        wait.cancel(Some("Owned passive-wait regression".to_owned()))
            .await?;
    }
    Ok(())
}

async fn session_events(
    owner: &RunningService<RoleClient, ()>,
    session: &str,
    envelopes: &mut Vec<Value>,
) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut cursor = 0;
    loop {
        let page = data(
            call(
                owner,
                "nesvo_read_events",
                json!({"sessionId":session,"after":cursor}),
            )
            .await?,
        )?;
        ensure!(
            page["data"]["gap"] == false,
            "Cancellation observations must have complete history"
        );
        events.extend(
            page["data"]["events"]
                .as_array()
                .context("Cancellation metadata events")?
                .iter()
                .cloned(),
        );
        let more = page["data"]["more"]
            .as_bool()
            .context("Cancellation event continuation")?;
        let next = page["data"]["nextCursor"]
            .as_u64()
            .context("Cancellation event cursor")?;
        envelopes.push(page);
        if !more {
            return Ok(events);
        }
        ensure!(next > cursor, "Cancellation event cursor must advance");
        cursor = next;
    }
}

fn unchanged_work(events: &[Value], receipt: &Value, settled: bool) -> Result<()> {
    let operation = receipt["id"].as_str().context("Original send identity")?;
    let sends: std::collections::HashSet<_> = events
        .iter()
        .filter(|event| {
            event["kind"] == "operation.changed" && event["payload"]["operation"] == "send"
        })
        .filter_map(|event| event["payload"]["operationId"].as_str())
        .collect();
    assert_eq!(
        sends,
        std::collections::HashSet::from([operation]),
        "Cancellation must retain the only original send"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "agent.lifecycle"
                && event["payload"]["event"] == "UserPromptSubmit")
            .count(),
        1,
        "Passive cancellation must not submit another prompt"
    );
    assert!(
        events.iter().all(|event| {
            if event["kind"] == "operation.changed" {
                !matches!(
                    event["payload"]["operation"].as_str(),
                    Some("interrupt" | "stop")
                ) && !matches!(
                    event["payload"]["phase"].as_str(),
                    Some("failed" | "unknown" | "interrupted")
                )
            } else if event["kind"] == "agent.lifecycle" {
                !matches!(
                    event["payload"]["event"].as_str(),
                    Some("Interrupt" | "StopFailure")
                )
            } else {
                true
            }
        }),
        "Passive cancellation must not interrupt, fail or replace accepted native work"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "operation.changed"
                && event["payload"]["operationId"] == operation
                && event["payload"]["phase"] == "settled")
            .count(),
        usize::from(settled),
        "Original send must settle exactly once, after release"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "response.settled")
            .count(),
        usize::from(settled),
        "Original response must settle exactly once, after release"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires native CLI/host and controlled Node PTY; protocol cancellation, no models"]
async fn canceled_mcp_waits_release_all_slots_without_interrupting_the_original_response()
-> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let phase = std::cell::Cell::new("owner MCP subprocess startup");
    let mut owner = None;
    let mut release = None;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(10), async {
        owner = Some(client(&fixture.pairing()).await?);
        let owner = owner.as_ref().context("Owned cancellation MCP process")?;
        phase.set("owner CLI doctor: controlled provider readiness");
        waits::provider(&fixture, "claude").await?;
        phase.set("owner MCP nesvo_create_session: controlled PTY");
        let created = waits::operation(owner, "nesvo_create_session", json!({
            "key":"cancel-wait-session","spec":{"name":"Passive cancellation fixture","program":"claude","harness":true}
        })).await?;
        let session = created["data"]["receipt"]["sessionId"].as_str().context("Cancellation session")?;
        release = Some(fixture.directory.join("callers").join(format!("{session}.release")));
        phase.set("owner MCP nesvo_get_session: controlled provider readiness");
        session_ready(owner, session).await?;
        phase.set("owner MCP nesvo_send_prompt: sole native submission");
        let sent = waits::operation(owner, "nesvo_send_prompt", json!({
            "sessionId":session,"key":"cancel-wait-original","prompt":"held-natural-response"
        })).await?;
        phase.set("owner MCP nesvo_read_session: held natural response marker");
        observed_output(owner, session, "FIXTURE_HOLDING_NATURAL_RESPONSE").await?;
        phase.set("owner MCP nesvo_wait_prompt: original receipt started");
        let started = waits::receipt(owner, &sent["data"]["receipt"]["id"], session, "started").await?;
        let receipt = &started["data"]["receipt"];
        assert_eq!(receipt["id"], sent["data"]["receipt"]["id"]);
        assert_eq!(receipt["phase"], "started");
        assert_eq!(receipt["result"]["nativeWriteFlushed"], true);
        phase.set("owner MCP nesvo_get_session: original active turn");
        let before = data(call(owner, "nesvo_get_session", json!({"sessionId":session})).await?)?;
        let turn = &before["data"]["session"]["lifecycle"]["turn"];
        assert_eq!(turn["phase"], "started");
        assert_eq!(turn["id"], receipt["result"]["turnId"]);

        let mut envelopes = Vec::new();
        phase.set("owner MCP nesvo_wait_prompt/get_session: four occupied slots");
        let waits = slots_proven_occupied_by_fifth_host_call(owner, receipt, &mut envelopes).await?;
        phase.set("owner MCP notifications/cancelled: all four passive waits");
        cancel_waits(waits).await?;
        phase.set("owner MCP nesvo_get_session: same process reuses canceled slots");
        let recovered = recovered_read(owner, "nesvo_get_session", json!({"sessionId":session}), &mut envelopes).await?;
        let recovered_turn = &recovered["data"]["session"]["lifecycle"]["turn"];
        assert_eq!(recovered["data"]["session"]["running"], true);
        for field in ["id", "generation", "phase", "observedAt", "outcome"] {
            assert_eq!(recovered_turn[field], turn[field], "Cancellation changed the original turn field {field}");
        }
        phase.set("owner MCP nesvo_wait_prompt/get_session: all four slots reused");
        let reused_waits = slots_proven_occupied_by_fifth_host_call(owner, receipt, &mut envelopes).await?;
        phase.set("owner MCP notifications/cancelled: reused four passive waits");
        cancel_waits(reused_waits).await?;
        phase.set("owner MCP nesvo_get_operation: cancellation retains original receipt");
        let retained = recovered_read(owner, "nesvo_get_operation", json!({"id":receipt["id"]}), &mut envelopes).await?;
        assert_eq!(&retained["data"]["receipt"], receipt);
        envelopes.extend([created.clone(), sent, started.clone(), before.clone(), recovered, retained]);
        phase.set("owner MCP nesvo_read_events: cancellation has no native effects");
        unchanged_work(&session_events(owner, session, &mut envelopes).await?, receipt, false)?;

        phase.set("owned fixture release: original natural response");
        std::fs::write(release.as_ref().context("Owned natural response release")?, "")?;
        phase.set("owner MCP nesvo_get_operation: original natural settlement");
        let settled = waits::receipt(owner, &receipt["id"], session, "settled").await?;
        let finished = &settled["data"]["receipt"];
        assert_eq!(finished["id"], receipt["id"]);
        assert_eq!(finished["phase"], "settled");
        assert_eq!(finished["result"]["turnId"], turn["id"]);
        assert!(finished["result"]["taskResult"].is_null());
        phase.set("owner MCP nesvo_get_operation: original key still resolves once");
        let original = data(call(owner, "nesvo_get_operation", json!({"key":"cancel-wait-original"})).await?)?;
        assert_eq!(&original["data"]["receipt"], finished);
        phase.set("owner MCP nesvo_get_session: same settled turn");
        let ended = data(call(owner, "nesvo_get_session", json!({"sessionId":session})).await?)?;
        assert_eq!(ended["data"]["session"]["running"], true);
        assert_eq!(ended["data"]["session"]["lifecycle"]["turn"]["id"], turn["id"]);
        assert_eq!(ended["data"]["session"]["lifecycle"]["turn"]["phase"], "settled");
        phase.set("owner MCP nesvo_read_session: single original response");
        let output = data(call(owner, "nesvo_read_session", json!({"sessionId":session,"maxBytes":8192})).await?)?;
        let text = output["data"]["page"]["data"].as_str().context("Original natural response output")?;
        assert_eq!(text.matches("FIXTURE_HOLDING_NATURAL_RESPONSE").count(), 1);
        assert_eq!(text.matches("FIXTURE_NATURAL_RESPONSE_FINISHED").count(), 1);
        envelopes.extend([settled, original, ended, output]);
        phase.set("owner MCP nesvo_read_events: exactly one original settlement");
        unchanged_work(&session_events(owner, session, &mut envelopes).await?, receipt, true)?;
        phase.set("published harness JSON schemas");
        run_checkpoints::schema(envelopes).await?;
        Ok::<_, anyhow::Error>(())
    })).catch_unwind().await;

    let release_before_fixture_fallback_wait = release
        .as_ref()
        .map(|path| std::fs::write(path, ""))
        .transpose()
        .map(|_| ());
    let client_cleanup = match owner {
        Some(owner) => owner.cancel().await.map(|_| ()),
        None => Ok(()),
    };
    let host_cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result
                .with_context(|| {
                    format!(
                        "MCP cancellation exceeded its 10-second scenario budget during {}",
                        phase.get()
                    )
                })?
                .with_context(|| {
                    format!(
                        "MCP cancellation phase: {}; owned host stderr is inherited by this test",
                        phase.get()
                    )
                })?;
            release_before_fixture_fallback_wait?;
            client_cleanup.context("Cancellation MCP cleanup")?;
            host_cleanup
        }
        Err(panic) => {
            eprintln!(
                "MCP cancellation panic phase: {}; owned host stderr is inherited by this test",
                phase.get()
            );
            let _ = (
                release_before_fixture_fallback_wait,
                client_cleanup,
                host_cleanup,
            );
            std::panic::resume_unwind(panic)
        }
    }
}
