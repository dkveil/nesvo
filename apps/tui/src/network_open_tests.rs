use super::*;
use std::{future::Future, net::SocketAddr};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, accept_async, accept_hdr_async,
    tungstenite::{
        handshake::server::{Request, Response},
        http::Response as HttpResponse,
        protocol::CloseFrame,
    },
};

const CHALLENGE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const KEY: [u8; 32] = [42; 32];
const STALL: Duration = Duration::from_millis(25);
const HOST_PACED: OpenTimeouts = OpenTimeouts {
    connect: Duration::MAX,
    challenge_read: Duration::MAX,
    auth_send: Duration::MAX,
    auth_read: Duration::MAX,
};
type MockSocket = WebSocketStream<TcpStream>;

fn pairing(address: SocketAddr) -> Pairing {
    Pairing {
        version: 1,
        url: format!("ws://{address}/"),
        key: hex::encode(KEY),
        scope_id: None,
    }
}

async fn mock_open_error<F, Fut>(host: F, timeouts: OpenTimeouts) -> anyhow::Error
where
    F: FnOnce(MockSocket) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pairing = pairing(listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        host(accept_async(stream).await.unwrap()).await;
    });
    let error = Connection::open_with_timeouts(pairing, timeouts)
        .await
        .err()
        .expect("host response must be rejected");
    task.await.unwrap();
    error
}

async fn auth(socket: &mut MockSocket) -> Value {
    socket
        .send(Message::Text(
            json!({"type":"challenge", "version":1, "challenge":CHALLENGE})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let Message::Text(frame) = socket.next().await.unwrap().unwrap() else {
        panic!("client must send an auth frame");
    };
    let auth = wire::decode(&frame, &KEY, CHALLENGE, 1).unwrap();
    assert_eq!(auth["type"], "auth");
    let nonce = auth["clientNonce"].as_str().unwrap();
    assert_eq!(nonce.len(), 64);
    assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
    auth
}

fn assert_diagnostic(error: anyhow::Error, suffix: &str) {
    let expected = format!("Cannot authenticate with the paired host ({suffix})");
    assert_eq!(open_failure_message(&error, "fallback"), expected);
    assert_eq!(error.to_string(), expected);
    assert!(expected.len() < 160);
    for private in ["private-host-response", CHALLENGE, &hex::encode(KEY)] {
        assert!(!expected.contains(private));
    }
}

#[test]
fn unknown_open_errors_keep_the_callers_generic_message() {
    let error = anyhow!("private-host-response: ws://private-host/ private-key");
    for fallback in [
        "Cannot authenticate with the paired host; check that it is running and reachable",
        "Cannot authenticate with the paired host",
    ] {
        assert_eq!(open_failure_message(&error, fallback), fallback);
    }
    let timeouts = OpenTimeouts::default();
    assert_eq!(timeouts.connect, Duration::from_secs(8));
    assert_eq!(timeouts.challenge_read, Duration::from_secs(5));
    assert_eq!(timeouts.auth_send, Duration::from_secs(3));
    assert_eq!(timeouts.auth_read, HOST_SILENCE_LIMIT);
    assert_eq!(HOST_SILENCE_LIMIT, Duration::from_secs(65));
}

#[tokio::test]
#[allow(
    clippy::result_large_err,
    reason = "tungstenite's handshake callback requires this exact unboxed response error type"
)]
async fn http_rejection_reports_only_the_connect_stage_and_status() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut pairing = pairing(listener.local_addr().unwrap());
    pairing.scope_id = Some("b".repeat(32));
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let result = accept_hdr_async(stream, |request: &Request, _: Response| {
            assert_eq!(request.headers()["x-nesvo-scope"], "b".repeat(32));
            Err(HttpResponse::builder()
                .status(403)
                .body(Some(format!("private-host-response {CHALLENGE}")))
                .unwrap())
        })
        .await;
        assert!(result.is_err());
    });
    let error = Connection::open_with_timeouts(pairing, HOST_PACED)
        .await
        .err()
        .expect("HTTP rejection must fail authentication");
    task.await.unwrap();
    assert_diagnostic(error, "stage=connect, cause=httpRejected, status=403");
}

#[tokio::test]
async fn challenge_and_auth_closes_report_numeric_codes_without_reasons() {
    for during_auth in [false, true] {
        let error = mock_open_error(
            move |mut socket| async move {
                if during_auth {
                    auth(&mut socket).await;
                }
                socket
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Library(4003),
                        reason: format!("private-host-response {CHALLENGE}").into(),
                    })))
                    .await
                    .unwrap();
            },
            HOST_PACED,
        )
        .await;
        assert_diagnostic(
            error,
            if during_auth {
                "stage=authRead, cause=peerClosed, status=4003"
            } else {
                "stage=challengeRead, cause=peerClosed, status=4003"
            },
        );
    }
}

#[tokio::test]
async fn challenge_frames_are_validated_before_authentication() {
    for (frame, expected) in [
        (
            Message::Binary(vec![1, 2, 3].into()),
            "stage=challengeRead, cause=unexpectedFrame",
        ),
        (
            Message::Text("private-host-response {".into()),
            "stage=challengeValidate, cause=malformedMessage",
        ),
        (
            Message::Text(
                json!({"type":"challenge", "version":1, "challenge":"private-host-response"})
                    .to_string()
                    .into(),
            ),
            "stage=challengeValidate, cause=invalidChallenge",
        ),
    ] {
        let error = mock_open_error(
            move |mut socket| async move {
                socket.send(frame).await.unwrap();
                assert!(!matches!(socket.next().await, Some(Ok(Message::Text(_)))));
            },
            HOST_PACED,
        )
        .await;
        assert_diagnostic(error, expected);
    }
}

#[tokio::test]
async fn host_proof_rejects_bad_keys_context_sequence_reflection_and_malformed_frames() {
    for scenario in 0..5 {
        let error = mock_open_error(
            move |mut socket| async move {
                let auth = auth(&mut socket).await;
                let connected = json!({
                    "type":"connected", "clientNonce":auth["clientNonce"],
                    "protocolVersion":2, "clientId":7,
                });
                let frame = match scenario {
                    0 => wire::encode(connected, &[43; 32], CHALLENGE, 1).unwrap(),
                    1 => wire::encode(connected, &KEY, "other-private-challenge", 1).unwrap(),
                    2 => wire::encode(connected, &KEY, CHALLENGE, 2).unwrap(),
                    3 => wire::encode_client(connected, &KEY, CHALLENGE, 1).unwrap(),
                    _ => "private-host-response malformed-proof".into(),
                };
                socket.send(Message::Text(frame.into())).await.unwrap();
            },
            HOST_PACED,
        )
        .await;
        assert_diagnostic(error, "stage=hostProof, cause=invalidProof");
    }
}

#[tokio::test]
async fn authenticated_connected_payload_requires_type_nonce_protocol_and_identity() {
    for (field, value, expected) in [
        (
            "type",
            json!("private-host-response"),
            "stage=connectedValidate, cause=unexpectedFrame",
        ),
        (
            "clientNonce",
            json!("private-host-response"),
            "stage=connectedValidate, cause=nonceMismatch",
        ),
        (
            "protocolVersion",
            json!(1),
            "stage=connectedValidate, cause=protocolUnsupported",
        ),
        (
            "clientId",
            Value::Null,
            "stage=connectedValidate, cause=missingIdentity",
        ),
    ] {
        let error = mock_open_error(
            move |mut socket| async move {
                let auth = auth(&mut socket).await;
                let mut connected = json!({
                    "type":"connected", "clientNonce":auth["clientNonce"],
                    "protocolVersion":2, "clientId":7,
                });
                connected[field] = value;
                let frame = wire::encode(connected, &KEY, CHALLENGE, 1).unwrap();
                socket.send(Message::Text(frame.into())).await.unwrap();
            },
            HOST_PACED,
        )
        .await;
        assert_diagnostic(error, expected);
    }
}

#[tokio::test]
async fn stalled_challenge_and_authentication_reads_keep_distinct_timeout_stages() {
    for during_auth in [false, true] {
        let timeouts = if during_auth {
            OpenTimeouts {
                auth_read: STALL,
                ..HOST_PACED
            }
        } else {
            OpenTimeouts {
                challenge_read: STALL,
                ..HOST_PACED
            }
        };
        let error = mock_open_error(
            move |mut socket| async move {
                if during_auth {
                    auth(&mut socket).await;
                }
                assert!(!matches!(socket.next().await, Some(Ok(Message::Text(_)))));
            },
            timeouts,
        )
        .await;
        assert_diagnostic(
            error,
            if during_auth {
                "stage=authRead, cause=timeout"
            } else {
                "stage=challengeRead, cause=timeout"
            },
        );
    }
}

#[tokio::test]
async fn stalled_websocket_upgrade_reports_the_connect_timeout() {
    let unanswered = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let error = Connection::open_with_timeouts(
        pairing(unanswered.local_addr().unwrap()),
        OpenTimeouts {
            connect: STALL,
            ..HOST_PACED
        },
    )
    .await
    .err()
    .expect("stalled upgrade must time out");
    drop(unanswered);
    assert_diagnostic(error, "stage=connect, cause=timeout");
}
