use crate::{
    protocol::Command,
    sessions::{Client, PtyEvent, State},
    storage::RevisionConflict,
    wire,
};
use anyhow::{Result, anyhow, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch},
    time::timeout,
};

struct EventSubscription(Option<tokio::task::JoinHandle<()>>);
impl Drop for EventSubscription {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}
struct EventRequest {
    after: u64,
    limit: usize,
    subject: Option<String>,
    subscribe: bool,
    request_id: Option<String>,
}
async fn serve_events(
    state: std::sync::Weak<Mutex<State>>,
    client_id: u64,
    log: crate::event_log::Service,
    mut request: EventRequest,
    mut cancelled: watch::Receiver<bool>,
) {
    let mut changed = log.subscribe();
    loop {
        if *cancelled.borrow() {
            return;
        }
        changed.borrow_and_update();
        let page = log
            .read(request.after, request.limit, request.subject.clone())
            .await;
        if *cancelled.borrow() {
            return;
        }
        let Some(state) = state.upgrade() else {
            return;
        };
        let mut event = match page {
            Ok(page) => {
                let done = !request.subscribe || page.gap;
                let more = page.more;
                request.after = page.next_cursor;
                let mut event=serde_json::to_value(page).unwrap_or_else(|_|json!({"type":"error","code":"event_log_unavailable","message":"Cannot encode event page"}));
                event["type"] = "events".into();
                event["subscribed"] = request.subscribe.into();
                event["health"] = log.health();
                if let Some(id) = &request.request_id {
                    event["requestId"] = id.clone().into();
                }
                {
                    let state = state.lock().unwrap();
                    if state
                        .event_subject(client_id, request.subject.clone())
                        .is_err()
                    {
                        let mut error = json!({"type":"error","code":"scope_revoked","message":"Event subscription authority has expired"});
                        if let Some(id) = &request.request_id {
                            error["requestId"] = id.clone().into();
                        }
                        state.send(client_id, error);
                        return;
                    }
                    state.send(client_id, event);
                }
                if done {
                    return;
                }
                if more {
                    continue;
                }
                tokio::select! {result=changed.changed()=>if result.is_err(){return;},_=cancelled.changed()=>return}
                continue;
            }
            Err(error) => {
                json!({"type":"error","code":error.downcast_ref::<crate::api_error::Error>().map(|e|e.code).unwrap_or("event_log_unavailable"),"message":if error.downcast_ref::<crate::api_error::Error>().is_some(){error.to_string()}else{"Event journal cannot be read".into()}})
            }
        };
        if let Some(id) = &request.request_id {
            event["requestId"] = id.clone().into();
        }
        state.lock().unwrap().send(client_id, event);
        return;
    }
}
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);
// Eight simultaneous subscriptions can enqueue 8 * (32 replay chunks + 2
// acknowledgments) before this connection's writer is scheduled again. Keep
// this bounded, but leave room for that legitimate burst (~2 MiB of output).
pub(crate) const CLIENT_EVENT_CAPACITY: usize = 512;

fn origin_allowed(origin: Option<&str>, extra: &[String]) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if origin == "null" || extra.iter().any(|allowed| allowed == origin) {
        return true;
    }
    url::Url::parse(origin).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    })
}

struct Cleanup {
    state: Arc<Mutex<State>>,
    id: u64,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.disconnect(self.id);
        }
    }
}

pub async fn handle(
    socket: TcpStream,
    key: [u8; 32],
    state: Arc<Mutex<State>>,
    pty_events: mpsc::Sender<PtyEvent>,
    origins: Vec<String>,
) -> Result<()> {
    socket.set_nodelay(true)?;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(wire::MAX_FRAME);
    config.max_frame_size = Some(wire::MAX_FRAME);
    config.max_write_buffer_size = 512 * 1024;
    config.write_buffer_size = 0;
    let binding = Arc::new(Mutex::new((key, crate::caller::Authority::Owner)));
    let chosen_binding = binding.clone();
    let scope_state = state.clone();
    // tungstenite's callback requires this exact unboxed response error type.
    #[allow(clippy::result_large_err)]
    let handshake = move |request: &Request,
                          response: Response|
          -> std::result::Result<Response, ErrorResponse> {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok());
        if request.uri().path() != "/"
            || request.uri().query().is_some()
            || !origin_allowed(origin, &origins)
        {
            return Err(Response::builder()
                .status(403)
                .body(Some("Origin or path not allowed".into()))
                .unwrap());
        }
        if request.headers().get_all("x-nesvo-scope").iter().count() > 1 {
            return Err(Response::builder()
                .status(403)
                .body(Some("Authentication failed".into()))
                .unwrap());
        }
        if let Some(scope) = request.headers().get("x-nesvo-scope") {
            let resolved = scope
                .to_str()
                .ok()
                .and_then(|id| scope_state.lock().ok()?.resolve_caller(id));
            let Some(resolved) = resolved else {
                return Err(Response::builder()
                    .status(403)
                    .body(Some("Authentication failed".into()))
                    .unwrap());
            };
            *chosen_binding.lock().unwrap() = resolved;
        }
        Ok(response)
    };
    let mut websocket = timeout(
        Duration::from_secs(5),
        accept_hdr_async_with_config(socket, handshake, Some(config)),
    )
    .await??;
    let (key, authority) = binding.lock().unwrap().clone();
    let challenge = hex::encode(wire::random::<32>());
    websocket
        .send(Message::Text(
            json!({"type":"challenge", "version":1, "challenge":challenge})
                .to_string()
                .into(),
        ))
        .await?;
    let auth = timeout(Duration::from_secs(5), websocket.next()).await;
    let client_nonce = match auth {
        Ok(Some(Ok(Message::Text(text)))) => wire::decode(&text, &key, &challenge, 1)
            .and_then(|value| Ok(serde_json::from_value::<Command>(value)?))
            .ok()
            .and_then(|command| match command {
                Command::Auth { client_nonce }
                    if client_nonce.len() == 64
                        && client_nonce
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
                {
                    Some(client_nonce)
                }
                _ => None,
            }),
        _ => None,
    };
    if client_nonce.is_none() {
        let _ = timeout(
            Duration::from_secs(1),
            websocket.close(Some(CloseFrame {
                code: CloseCode::Library(4003),
                reason: "Authentication failed".into(),
            })),
        )
        .await;
        return Err(anyhow!("Authentication failed"));
    }
    let id = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
    let (event_tx, mut event_rx) = mpsc::channel(CLIENT_EVENT_CAPACITY);
    let (cancel_tx, mut cancelled) = watch::channel(false);
    {
        let mut state = state.lock().unwrap();
        state.clients.insert(
            id,
            Client {
                events: event_tx,
                cancelled: cancel_tx,
                authority,
            },
        );
        state.send(
            id,
            json!({"type":"connected", "clientNonce":client_nonce.unwrap(), "clientId":id, "protocolVersion":2}),
        );
        state.send(id, state.list());
    }
    let _cleanup = Cleanup {
        state: state.clone(),
        id,
    };
    let (mut outgoing, mut incoming) = websocket.split();
    let git_gate = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
    let mut incoming_seq = 1;
    let mut outgoing_seq = 0;
    let mut rate_start = Instant::now();
    let mut rate_count = 0u32;
    let event_gate = Arc::new(tokio::sync::Semaphore::new(4));
    let mut domain_subscription = EventSubscription(None);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.tick().await;
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = cancelled.changed() => break,
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(60) { break; }
                timeout(Duration::from_secs(3), outgoing.send(Message::Ping(Vec::new().into()))).await??;
            }
            event = event_rx.recv() => {
                let Some(event) = event else { break; };
                outgoing_seq += 1;
                let frame = wire::encode(event, &key, &challenge, outgoing_seq)?;
                timeout(Duration::from_secs(3), outgoing.send(Message::Text(frame.into()))).await??;
            }
            frame = incoming.next() => {
                last_seen = Instant::now();
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        if rate_start.elapsed() >= Duration::from_secs(1) { rate_start = Instant::now(); rate_count = 0; }
                        rate_count += 1;
                        let decoded = (|| -> Result<(Command, Option<String>)> {
                            ensure!(rate_count <= 300, "Message rate exceeded");
                            let value = wire::decode(&text, &key, &challenge, incoming_seq + 1)?;
                            let request_id = value.get("requestId").map(|value| {
                                let id = value.as_str().ok_or_else(|| anyhow!("Invalid request ID"))?;
                                ensure!(!id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control), "Invalid request ID");
                                Ok(id.to_owned())
                            }).transpose()?;
                            Ok((serde_json::from_value(value)?, request_id))
                        })();
                        let (command, request_id) = match decoded {
                            Ok(command) => command,
                            Err(_) => {
                                let _ = timeout(Duration::from_secs(1), outgoing.send(Message::Close(Some(CloseFrame { code: CloseCode::Library(4003), reason: "Authentication or protocol validation failed".into() })))).await;
                                break;
                            }
                        };
                        incoming_seq += 1;
                        let authorization=state.lock().unwrap().authorize(id,&command);
                        if let Err(error)=authorization {
                            let mut event=json!({"type":"error","code":error.downcast_ref::<crate::api_error::Error>().map(|e|e.code).unwrap_or("forbidden"),"message":error.to_string()});
                            if let Some(request_id)=request_id {event["requestId"]=request_id.into();}
                            state.lock().unwrap().send(id,event);
                            continue;
                        }
                        if matches!(command,Command::UnsubscribeEvents) {
                            if let Some(task)=domain_subscription.0.take(){task.abort();}
                            let mut event=json!({"type":"eventsUnsubscribed"});
                            if let Some(id)=request_id {event["requestId"]=id.into();}
                            state.lock().unwrap().send(id,event);
                            continue;
                        }
                        if matches!(command,Command::ReadEvents{..}|Command::SubscribeEvents{..}) {
                            let (after,limit,subject,subscribe)=match command {
                                Command::ReadEvents{after,limit,session_id}=>(after,limit.unwrap_or(32),session_id,false),
                                Command::SubscribeEvents{after,limit,session_id}=>(after,limit.unwrap_or(32),session_id,true),
                                _=>unreachable!(),
                            };
                            if subscribe && let Some(task)=domain_subscription.0.take(){task.abort();}
                            let prepared=(||->Result<_>{let state=state.lock().unwrap();Ok((state.event_log()?,state.event_subject(id,subject)?))})();
                            let permit=event_gate.clone().try_acquire_owned();
                            match (prepared,permit) {
                                (Ok((log,subject)),Ok(permit))=>{
                                    let task=tokio::spawn({let state=Arc::downgrade(&state);let cancelled=cancelled.clone();async move {
                                        let _permit=permit;
                                        serve_events(state,id,log,EventRequest{after,limit,subject,subscribe,request_id},cancelled).await;
                                    }});
                                    if subscribe {domain_subscription.0=Some(task);}
                                },
                                _=>{let mut event=json!({"type":"error","code":"event_log_unavailable","message":"Event service is unavailable or busy"});if let Some(id)=request_id {event["requestId"]=id.into();}state.lock().unwrap().send(id,event);}
                            }
                            continue;
                        }
                        if let Command::Launch { mut spec } = command {
                            let directory = state.lock().unwrap().validate_launch(&spec);
                            let permit = git_gate.clone().try_acquire_owned();
                            let state = state.clone();
                            let events = pty_events.clone();
                            tokio::spawn(async move {
                                let result = match (directory, permit) {
                                    (Ok(directory), Ok(_permit)) => {
                                        if spec.worktree { crate::git::create_worktree(&directory).await }
                                        else { Ok(directory) }
                                    }
                                    (Err(error), _) => Err(error),
                                    (_, Err(_)) => Err(anyhow!("Another Git operation is running.")),
                                };
                                if let Ok(mut state) = state.lock() {
                                    let result = result.and_then(|path| {
                                        spec.cwd = Some(crate::process::display_path(&path));
                                        spec.worktree = false;
                                        state.launch(&spec, &events)
                                    });
                                    let mut event = match result {
                                        Ok(id) => json!({"type":"created", "sessionId":id}),
                                        Err(error) => json!({"type":"error", "message":error.to_string()}),
                                    };
                                    if let Some(request_id) = request_id { event["requestId"] = request_id.into(); }
                                    state.send(id, event);
                                    state.broadcast_list();
                                }
                            });
                            continue;
                        }
                        if let Command::GetDiff { session_id, scope, directory } = command {
                            let pinned = directory.as_ref().is_some_and(|path| !path.is_empty());
                            let report = state.lock().unwrap().context_report(&session_id);
                            let directory = state.lock().unwrap().session_directory(&session_id).and_then(|session_dir| {
                                match directory {
                                    Some(path) if !path.is_empty() => {
                                        anyhow::ensure!(path.len() <= 4096 && !path.chars().any(char::is_control), "Invalid review folder");
                                        let path = std::path::PathBuf::from(path);
                                        Ok(if path.is_absolute() { path } else { session_dir.join(path) })
                                    },
                                    _ => Ok(session_dir),
                                }
                            });
                            let permit = git_gate.clone().try_acquire_owned();
                            let state = state.clone();
                            tokio::spawn(async move {
                                let result = match (directory, permit) {
                                    (Ok(directory), Ok(_permit)) => {
                                        let context = if pinned {
                                            crate::agent_context::Context { directory, source: "Pinned".into() }
                                        } else { crate::agent_context::resolve(directory, report).await };
                                        crate::git::review(&context.directory, &scope).await.map_err(|error| anyhow!("{} · {}: {error}", context.source, context.directory.display())).map(|mut review| {
                                            review.source = Some(context.source);
                                            review
                                        })
                                    },
                                    (Err(error), _) => Err(error),
                                    (_, Err(_)) => Err(anyhow!("A Git inspection is already running.")),
                                };
                                let mut event = match result {
                                    Ok(review) => json!({"type":"diff", "sessionId":session_id, "review":review}),
                                    Err(error) => json!({"type":"diff", "sessionId":session_id, "error":error.to_string()}),
                                };
                                if let Some(request_id) = request_id { event["requestId"] = request_id.into(); }
                                if let Ok(state) = state.lock() { state.send(id, event); }
                            });
                            continue;
                        }
                        let mut state = state.lock().unwrap();
                        if let Err(error) = state.command(id, command, request_id.as_deref(), &pty_events) {
                            let mut event = json!({"type":"error", "message":error.to_string()});
                            if let Some(request_id) = request_id { event["requestId"] = request_id.into(); }
                            if let Some(conflict) = error.downcast_ref::<RevisionConflict>() {
                                event["code"] = "revision_conflict".into();
                                event["revision"] = conflict.0.into();
                            }
                            if let Some(error)=error.downcast_ref::<crate::api_error::Error>() {
                                event["code"]=error.code.into();
                            }
                            state.send(id, event);
                        }
                    }
                    Some(Ok(Message::Ping(data))) => { timeout(Duration::from_secs(3), outgoing.send(Message::Pong(data))).await??; }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => break,
                }
            }
        }
    }
    let _ = timeout(Duration::from_secs(1), outgoing.close()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_origins_are_constrained() {
        assert!(origin_allowed(None, &[]));
        assert!(origin_allowed(Some("null"), &[]));
        assert!(origin_allowed(Some("http://localhost:8081"), &[]));
        assert!(!origin_allowed(Some("https://attacker.example"), &[]));
        assert!(!origin_allowed(
            Some("https://localhost.attacker.example"),
            &[]
        ));
        assert!(origin_allowed(
            Some("https://example.test"),
            &["https://example.test".into()]
        ));
    }
}
