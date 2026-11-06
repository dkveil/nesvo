use futures_util::{SinkExt, StreamExt};
use nesvo_desktop_lib::{
    link::open,
    supervisor::{CommandSlot, Outbound, Sink, Status, supervise},
};
use nesvo_wire as wire;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    accept_async,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};

const KEY: [u8; 32] = [7; 32];
const CHALLENGE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn snapshot() -> Value {
    json!({
        "type": "sessions",
        "sessions": [{
            "id": "s1", "name": "main", "cwd": "/work", "createdAt": "2026-11-06T10:00:00Z",
            "cols": 80, "rows": 24, "running": true, "controllerId": null,
            "groupId": null, "program": "claude"
        }],
        "groups": [],
        "revision": 1
    })
}

async fn start_host(host_key: [u8; 32]) -> (u16, JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let hello = json!({"type": "challenge", "version": 1, "challenge": CHALLENGE});
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .unwrap();
        let Some(Ok(Message::Text(auth))) = socket.next().await else {
            return vec![];
        };
        let Ok(auth) = wire::decode(&auth, &host_key, CHALLENGE, 1) else {
            let rejection = CloseFrame {
                code: CloseCode::Library(4003),
                reason: "Authentication failed".into(),
            };
            let _ = socket.send(Message::Close(Some(rejection))).await;
            return vec![];
        };
        let connected = json!({
            "type": "connected", "clientNonce": auth["clientNonce"],
            "clientId": 7, "protocolVersion": 2
        });
        let frames = [
            wire::encode(connected, &host_key, CHALLENGE, 1).unwrap(),
            wire::encode(snapshot(), &host_key, CHALLENGE, 2).unwrap(),
        ];
        for frame in frames {
            socket.send(Message::Text(frame.into())).await.unwrap();
        }
        let mut received = vec![];
        if let Ok(Some(Ok(Message::Text(text)))) =
            timeout(Duration::from_secs(5), socket.next()).await
        {
            received.push(wire::decode(&text, &host_key, CHALLENGE, 2).unwrap());
        }
        received
    });
    (port, task)
}

#[tokio::test]
async fn opens_a_link_receives_the_snapshot_and_sends_commands() {
    let (port, host) = start_host(KEY).await;
    let link = open(&format!("ws://127.0.0.1:{port}"), KEY).await.unwrap();
    assert_eq!(link.client_id, 7);
    let (commands, command_rx) = tokio::sync::mpsc::channel(4);
    let (message_tx, mut messages) = tokio::sync::mpsc::channel(4);
    let serving = tokio::spawn(link.serve(command_rx, message_tx));
    assert_eq!(messages.recv().await.unwrap(), snapshot());
    commands.send(json!({"type": "list"})).await.unwrap();
    assert_eq!(host.await.unwrap(), vec![json!({"type": "list"})]);
    drop(commands);
    let _ = serving.await;
}

#[tokio::test]
async fn a_wrong_pairing_key_is_a_permanent_failure() {
    let (port, _host) = start_host(KEY).await;
    let error = open(&format!("ws://127.0.0.1:{port}"), [9; 32])
        .await
        .err()
        .unwrap();
    assert!(error.permanent, "{error}");
}

#[tokio::test]
async fn an_unreachable_host_is_a_transient_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let error = open(&format!("ws://127.0.0.1:{port}"), KEY)
        .await
        .err()
        .unwrap();
    assert!(!error.permanent, "{error}");
}

#[tokio::test]
async fn the_supervisor_reports_state_changes_and_forwards_snapshots() {
    let (port, _host) = start_host(KEY).await;
    let events: Arc<Mutex<Vec<Outbound>>> = Arc::default();
    let recorded = Arc::clone(&events);
    let sink: Sink = Arc::new(move |outbound| recorded.lock().unwrap().push(outbound));
    let slot: CommandSlot = Arc::default();
    let task = tokio::spawn(supervise(format!("ws://127.0.0.1:{port}"), KEY, sink, slot));
    timeout(Duration::from_secs(5), async {
        loop {
            let seen = events.lock().unwrap().iter().any(
                |event| matches!(event, Outbound::Sessions(snapshot) if snapshot["revision"] == 1),
            );
            if seen {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let statuses: Vec<Status> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            Outbound::State(state) => Some(state.status),
            Outbound::Sessions(_) => None,
        })
        .collect();
    assert_eq!(statuses, [Status::Connecting, Status::Connected]);
}
