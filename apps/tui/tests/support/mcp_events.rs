use super::*;
use rmcp::{
    ClientHandler,
    model::{
        ClientRequest, ErrorCode, NotificationMetaObject, ReadResourceRequestParams, Request,
        ResourceContents, ResourceUpdatedNotificationParam, ServerNotification,
        SubscribeRequestParams, SubscriptionFilter, UnsubscribeRequestParams,
    },
    service::{ClientLifecycleMode, ClientServiceExt, NotificationContext, Subscription},
};
use tokio::sync::mpsc;

const OPERATIONS: &str = "nesvo://events/operations";
const META_KEY: &str = "nesvo/events";

fn adapter() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    hide_console_window(&mut command);
    command
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

fn paired(pairing: &Path) -> Command {
    let mut command = adapter();
    command.arg("--pairing").arg(pairing).arg("mcp");
    command
}

fn scoped(context: &Path, id: &str) -> Command {
    let mut command = adapter();
    command
        .arg("mcp")
        .env("NESVO_AGENT_CONTEXT", context)
        .env("NESVO_SESSION_ID", id);
    command
}

async fn discover(command: Command) -> Result<RunningService<RoleClient, ()>> {
    Ok(()
        .serve_with_lifecycle(
            TokioChildProcess::new(command)?,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await?)
}

async fn modern(pairing: &Path) -> Result<RunningService<RoleClient, ()>> {
    discover(paired(pairing)).await
}

async fn legacy_client(
    command: Command,
) -> Result<(
    RunningService<RoleClient, LegacyUpdates>,
    mpsc::Receiver<(String, Value)>,
)> {
    let (updates, received) = mpsc::channel(8);
    let client = LegacyUpdates {
        config: ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("nesvo-legacy-events", "1"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25),
        updates,
    }
    .serve(TokioChildProcess::new(command)?)
    .await?;
    Ok((client, received))
}

fn subscribe_request(uri: &str) -> ClientRequest {
    ClientRequest::SubscribeRequest(Request::new(SubscribeRequestParams::new(uri)))
}

fn refusal_code(error: &rmcp::ServiceError) -> Option<Value> {
    match error {
        rmcp::ServiceError::McpError(error) => error.data.as_ref().map(|data| data["code"].clone()),
        _ => None,
    }
}

fn caller_context(fixture: &Fixture, id: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(std::fs::read_to_string(
        fixture.directory.join("callers").join(format!("{id}.txt")),
    )?))
}

fn cursor_meta(meta: Option<&NotificationMetaObject>) -> Option<Value> {
    meta.and_then(|meta| meta.get(META_KEY)).cloned()
}

struct LegacyUpdates {
    config: ClientConfig,
    updates: mpsc::Sender<(String, Value)>,
}

impl ClientHandler for LegacyUpdates {
    fn get_info(&self) -> ClientConfig {
        self.config.clone()
    }
    async fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        context: NotificationContext<RoleClient>,
    ) {
        let meta = cursor_meta(Some(&context.meta))
            .or_else(|| cursor_meta(context.extensions.get::<NotificationMetaObject>()))
            .or_else(|| cursor_meta(params.meta.as_ref()))
            .unwrap_or(Value::Null);
        let _ = self.updates.try_send((params.uri, meta));
    }
}

async fn modern_update(subscription: &mut Subscription, uri: &str) -> Result<Value> {
    let notification = subscription
        .next()
        .await?
        .context("Subscription ended before an update")?;
    let ServerNotification::ResourceUpdatedNotification(update) = notification else {
        anyhow::bail!("Unexpected subscription notification: {notification:?}");
    };
    ensure!(
        update.params.uri == uri,
        "Notification names the subscribed URI"
    );
    cursor_meta(update.extensions.get::<NotificationMetaObject>())
        .or_else(|| cursor_meta(update.params.meta.as_ref()))
        .context("Notification cursor metadata")
}

async fn legacy_update(updates: &mut mpsc::Receiver<(String, Value)>) -> Result<Value> {
    legacy_update_for(updates, OPERATIONS).await
}

async fn legacy_update_for(
    updates: &mut mpsc::Receiver<(String, Value)>,
    expected: &str,
) -> Result<Value> {
    let (uri, meta) = updates.recv().await.context("Legacy client closed")?;
    ensure!(
        uri == expected,
        "Legacy notification names the subscribed URI"
    );
    Ok(meta)
}

async fn read_page<S: rmcp::Service<RoleClient>>(
    client: &RunningService<RoleClient, S>,
    uri: &str,
) -> Result<Value> {
    let result = client
        .read_resource(ReadResourceRequestParams::new(uri))
        .await?;
    let Some(ResourceContents::TextResourceContents {
        text, mime_type, ..
    }) = result.contents.first()
    else {
        anyhow::bail!("Event resource returns one JSON text content");
    };
    ensure!(mime_type.as_deref() == Some("application/json"));
    let value: Value = serde_json::from_str(text)?;
    ensure!(value["schemaVersion"] == 1 && value["ok"] == true);
    Ok(value["data"].clone())
}

async fn delta_for(
    client: &RunningService<RoleClient, ()>,
    mut next: impl AsyncFnMut() -> Result<Value>,
    operation: &str,
) -> Result<(Value, Value)> {
    loop {
        let meta = next().await?;
        ensure!(meta["ready"] == false && meta["gap"] == false && meta.get("closed").is_none());
        let sequences = meta["sequences"].as_array().context("sequences")?;
        ensure!(!sequences.is_empty(), "Only matching deltas notify");
        let after = meta["after"].as_u64().context("after")?;
        ensure!(sequences.iter().all(|s| s.as_u64() > Some(after)));
        ensure!(meta["nextCursor"].as_u64() >= sequences.last().and_then(Value::as_u64));
        let page = read_page(client, meta["readUri"].as_str().context("readUri")?).await?;
        let events = page["events"].as_array().context("delta events")?;
        ensure!(
            events
                .iter()
                .all(|e| e["kind"] == "operation.changed" && e["sequence"].as_u64() > Some(after))
        );
        if events
            .iter()
            .any(|e| e["payload"]["operationId"] == operation && e["payload"]["phase"] == "created")
        {
            return Ok((meta, page));
        }
    }
}

#[tokio::test]
#[ignore = "requires native CLI/host; MCP resource subscriptions over a controlled shell, no models"]
async fn sdk_clients_receive_event_resource_updates_with_cursors() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let listed = owner.list_all_resources().await?;
        ensure!(listed.iter().any(|r| r.uri == OPERATIONS));
        let templates = owner.list_all_resource_templates().await?;
        ensure!(templates.iter().any(|t| t.uri_template.starts_with("nesvo://events/session/")));
        let unknown = owner
            .read_resource(ReadResourceRequestParams::new("nesvo://events/unknown"))
            .await
            .expect_err("Unknown event resource");
        ensure!(
            matches!(&unknown, rmcp::ServiceError::McpError(error) if error.code == ErrorCode::RESOURCE_NOT_FOUND),
            "Unknown resources are not found: {unknown:?}"
        );
        let initial = read_page(&owner, OPERATIONS).await?;
        ensure!(initial["resource"] == OPERATIONS && initial["more"] == false);

        let modern_client = modern(&fixture.pairing()).await?;
        let modern_page = read_page(&modern_client, OPERATIONS).await?;
        ensure!(modern_page["resource"] == OPERATIONS);
        let mut subscription = modern_client
            .peer()
            .listen(
                SubscriptionFilter::builder()
                    .resource_subscription(OPERATIONS)
                    .resource_subscription("nesvo://events/bogus")
                    .build(),
            )
            .await?;
        ensure!(
            subscription.acknowledged().resource_subscriptions.as_deref()
                == Some(&[OPERATIONS.to_owned()][..]),
            "Only valid event URIs are acknowledged"
        );
        let ready = modern_update(&mut subscription, OPERATIONS).await?;
        ensure!(ready["ready"] == true && ready["sequences"] == json!([]), "{ready}");
        let start = ready["after"].as_u64().context("start cursor")?;
        ensure!(ready["readUri"] == format!("{OPERATIONS}?after={start}"));

        let (legacy, mut legacy_rx) = legacy_client(paired(&fixture.pairing())).await?;
        let subscribe = || subscribe_request(OPERATIONS);
        legacy.peer().send_request(subscribe()).await?;
        ensure!(legacy_update(&mut legacy_rx).await?["ready"] == true);

        let created = waits::operation(
                &owner,
                "nesvo_create_session",
                json!({"key":"events-bridge","spec":{"name":"Events bridge","program":"shell","cwd":fixture.directory}}),
            ).await?;
        let receipt = &created["data"]["receipt"];
        let operation = receipt["id"].as_str().context("operation")?;
        let (modern, page) = delta_for(&modern_client, async || modern_update(&mut subscription, OPERATIONS).await, operation).await?;
        ensure!(modern["after"].as_u64() >= Some(start));
        let (legacy_meta, _) = delta_for(&owner, async || legacy_update(&mut legacy_rx).await, operation).await?;
        ensure!(legacy_meta["after"].as_u64() >= Some(start));
        let resumed = read_page(
            &owner,
            &format!("{OPERATIONS}?after={}", page["nextCursor"].as_u64().context("next")?),
        )
        .await?;
        ensure!(
            resumed["events"].as_array().context("resumed")?.iter().all(|e| e["sequence"].as_u64() > page["nextCursor"].as_u64()),
            "Reading from nextCursor returns only the remaining delta"
        );

        legacy
            .peer()
            .send_request(ClientRequest::UnsubscribeRequest(Request::new(
                UnsubscribeRequestParams::new(OPERATIONS),
            )))
            .await?;
        legacy.peer().send_request(subscribe()).await?;
        let mut buffered = 0;
        while legacy_update(&mut legacy_rx).await?["ready"] != true {
            buffered += 1;
            ensure!(buffered < 8, "Unsubscribe releases its stream for a new subscription");
        }

        let id = receipt["sessionId"].as_str().context("session")?;
        waits::operation(&owner, "nesvo_stop_session", json!({"key":"events-bridge-stop","sessionId":id})).await?;
        drop(subscription);
        modern_client.cancel().await?;
        legacy.cancel().await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires native binaries and Node; worker-scoped MCP event subscriptions over the controlled provider, no models"]
async fn worker_event_subscriptions_keep_their_subject_and_refuse_foreign_sessions() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        repository_context::provider_ready(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let root = waits::operation(&owner, "nesvo_create_session", json!({"key":"events-coordinator","spec":{"name":"Events coordinator","role":"coordinator","program":"claude","harness":true}})).await?;
        let root_id = root["data"]["receipt"]["sessionId"].as_str().context("coordinator")?;
        session_ready(&owner, root_id).await?;
        let coordinator = scoped_client(&caller_context(&fixture, root_id)?, root_id).await?;
        let child = waits::operation(&coordinator, "nesvo_create_session", json!({"key":"events-worker","spec":{"name":"Events worker","program":"claude"}})).await?;
        let child_id = child["data"]["receipt"]["sessionId"].as_str().context("worker")?;
        session_ready(&owner, child_id).await?;
        let foreign = waits::operation(&owner, "nesvo_create_session", json!({"key":"events-foreign","spec":{"name":"Foreign events","program":"shell","cwd":fixture.directory}})).await?;
        let foreign_id = foreign["data"]["receipt"]["sessionId"].as_str().context("foreign")?;
        let foreign_uri = format!("nesvo://events/session/{foreign_id}");
        let own = "nesvo://events";
        let context = caller_context(&fixture, child_id)?;

        let worker = discover(scoped(&context, child_id)).await?;
        let mut refused = worker
            .peer()
            .listen(
                SubscriptionFilter::builder()
                    .resource_subscription(own)
                    .resource_subscription(foreign_uri.as_str())
                    .build(),
            )
            .await?;
        let error = refused
            .next()
            .await
            .expect_err("A foreign session subscription is refused");
        ensure!(refusal_code(&error) == Some(json!("forbidden")), "{error:?}");

        let mut subscription = worker
            .peer()
            .listen(SubscriptionFilter::builder().resource_subscription(own).build())
            .await?;
        let ready = modern_update(&mut subscription, own).await?;
        ensure!(ready["ready"] == true, "A refused listen releases its streams: {ready}");
        let sent = waits::operation(&coordinator, "nesvo_send_prompt", json!({"sessionId":child_id,"key":"events-worker-turn","prompt":"literal worker prompt"})).await?;
        data(call(&coordinator, "nesvo_wait_prompt", json!({"id":sent["data"]["receipt"]["id"],"sessionId":child_id,"timeoutMs":5000})).await?)?;
        let mut delta = ready;
        for _ in 0..8 {
            if delta["sequences"].as_array().is_some_and(|s| !s.is_empty()) {
                break;
            }
            delta = modern_update(&mut subscription, own).await?;
        }
        let page = read_page(&worker, delta["readUri"].as_str().context("readUri")?).await?;
        let events = page["events"].as_array().context("worker events")?;
        ensure!(!events.is_empty(), "The worker turn is delivered: {delta}");
        ensure!(
            events.iter().all(|e| e["sessionId"] == child_id),
            "A worker stream defaults to its own subject: {page}"
        );

        let (legacy, mut updates) = legacy_client(scoped(&context, child_id)).await?;
        let error = legacy
            .peer()
            .send_request(subscribe_request(&foreign_uri))
            .await
            .expect_err("A legacy foreign session subscription is refused");
        ensure!(refusal_code(&error) == Some(json!("forbidden")), "{error:?}");
        legacy.peer().send_request(subscribe_request(own)).await?;
        ensure!(legacy_update_for(&mut updates, own).await?["ready"] == true);

        drop(subscription);
        drop(refused);
        legacy.cancel().await?;
        worker.cancel().await?;
        coordinator.cancel().await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}
