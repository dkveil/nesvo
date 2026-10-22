//! Authenticated transport. This client never creates or owns local processes.
use anyhow::{Context, Result, anyhow, ensure};
use futures_util::{SinkExt, StreamExt};
use nesvo_wire as wire;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{sync::mpsc, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Error as WebSocketError, Message,
        client::IntoClientRequest,
        protocol::{WebSocketConfig, frame::coding::CloseCode},
    },
};

#[derive(Deserialize)]
pub struct Pairing {
    version: u8,
    url: String,
    key: String,
    #[serde(default, rename = "scopeId")]
    scope_id: Option<String>,
}

impl Pairing {
    pub fn is_scoped(&self) -> bool {
        self.scope_id.is_some()
    }
    pub fn load(path: &Path, override_url: Option<&str>) -> Result<Self> {
        let bytes = std::fs::read(path)
            .context("Cannot read pairing file; start the host or pass --pairing PATH")?;
        ensure!(bytes.len() <= 16 * 1024, "Pairing file is too large");
        let mut pairing: Self = serde_json::from_slice(&bytes).context("Invalid pairing file")?;
        if let Some(url) = override_url {
            pairing.url = url.into();
        }
        pairing.validate()?;
        Ok(pairing)
    }

    pub fn local_id(&self) -> String {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.key.hash(&mut hash);
        format!("{:016x}", hash.finish())
    }

    fn validate(&self) -> Result<()> {
        ensure!(self.version == 1, "Unsupported pairing format");
        ensure!(
            self.scope_id.as_ref().is_none_or(|id| id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            "Invalid caller scope"
        );
        let url = url::Url::parse(&self.url).context("Invalid host URL")?;
        ensure!(
            matches!(url.scheme(), "ws" | "wss")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Host URL must be ws:// or wss:// with no credentials, query or path"
        );
        ensure!(
            self.key.len() == 64 && self.key.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid pairing key"
        );
        Ok(())
    }
}

pub enum NetworkEvent {
    Message(Value),
    Disconnected(String),
}

#[derive(Clone, Copy, Debug)]
enum OpenStage {
    Connect,
    ChallengeRead,
    ChallengeValidate,
    AuthSend,
    AuthRead,
    HostProof,
    ConnectedValidate,
}

impl OpenStage {
    fn label(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::ChallengeRead => "challengeRead",
            Self::ChallengeValidate => "challengeValidate",
            Self::AuthSend => "authSend",
            Self::AuthRead => "authRead",
            Self::HostProof => "hostProof",
            Self::ConnectedValidate => "connectedValidate",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum OpenCause {
    Timeout,
    Io,
    PeerClosed,
    HttpRejected,
    UnexpectedFrame,
    MalformedMessage,
    InvalidChallenge,
    InvalidProof,
    NonceMismatch,
    ProtocolUnsupported,
    MissingIdentity,
    EncodingFailed,
    InvalidRequest,
    Transport,
}

impl OpenCause {
    fn label(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::PeerClosed => "peerClosed",
            Self::HttpRejected => "httpRejected",
            Self::UnexpectedFrame => "unexpectedFrame",
            Self::MalformedMessage => "malformedMessage",
            Self::InvalidChallenge => "invalidChallenge",
            Self::InvalidProof => "invalidProof",
            Self::NonceMismatch => "nonceMismatch",
            Self::ProtocolUnsupported => "protocolUnsupported",
            Self::MissingIdentity => "missingIdentity",
            Self::EncodingFailed => "encodingFailed",
            Self::InvalidRequest => "invalidRequest",
            Self::Transport => "transport",
        }
    }
}

#[derive(Debug)]
struct ConnectionOpenError {
    stage: OpenStage,
    cause: OpenCause,
    status: Option<u16>,
}

impl ConnectionOpenError {
    fn new(stage: OpenStage, cause: OpenCause) -> Self {
        Self {
            stage,
            cause,
            status: None,
        }
    }

    fn websocket(stage: OpenStage, error: WebSocketError) -> Self {
        let cause = match error {
            WebSocketError::Http(response) => {
                return Self {
                    stage,
                    cause: OpenCause::HttpRejected,
                    status: Some(response.status().as_u16()),
                };
            }
            WebSocketError::Io(_) => OpenCause::Io,
            WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed => {
                OpenCause::PeerClosed
            }
            _ => OpenCause::Transport,
        };
        Self::new(stage, cause)
    }
}

impl std::fmt::Display for ConnectionOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Cannot authenticate with the paired host (stage={}, cause={}",
            self.stage.label(),
            self.cause.label()
        )?;
        if let Some(status) = self.status {
            write!(f, ", status={status}")?;
        }
        f.write_str(")")
    }
}

impl std::error::Error for ConnectionOpenError {}

/// Only typed, fixed diagnostics may cross the CLI/MCP boundary. Unknown errors
/// retain the caller's generic message; their text and sources are never exposed.
pub(crate) fn open_failure_message(error: &anyhow::Error, fallback: &str) -> String {
    error
        .downcast_ref::<ConnectionOpenError>()
        .map_or_else(|| fallback.to_owned(), ToString::to_string)
}

struct OpenTimeouts {
    connect: Duration,
    challenge_read: Duration,
    auth_send: Duration,
    auth_read: Duration,
}

impl Default for OpenTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(8),
            challenge_read: Duration::from_secs(5),
            auth_send: Duration::from_secs(3),
            auth_read: Duration::from_secs(5),
        }
    }
}

fn handshake_text(
    stage: OpenStage,
    frame: Option<std::result::Result<Message, WebSocketError>>,
) -> Result<String> {
    match frame {
        Some(Ok(Message::Text(text))) => Ok(text.to_string()),
        Some(Ok(Message::Close(frame))) => Err(ConnectionOpenError {
            stage,
            cause: OpenCause::PeerClosed,
            status: frame.map(|frame| u16::from(frame.code)),
        }
        .into()),
        None => Err(ConnectionOpenError::new(stage, OpenCause::PeerClosed).into()),
        Some(Err(error)) => Err(ConnectionOpenError::websocket(stage, error).into()),
        Some(Ok(_)) => Err(ConnectionOpenError::new(stage, OpenCause::UnexpectedFrame).into()),
    }
}

pub struct Connection {
    pub client_id: u64,
    pub events: mpsc::Receiver<NetworkEvent>,
    commands: mpsc::Sender<Value>,
    worker: JoinHandle<()>,
}

impl Connection {
    pub async fn open(pairing: Pairing) -> Result<Self> {
        Self::open_with_timeouts(pairing, OpenTimeouts::default()).await
    }

    async fn open_with_timeouts(pairing: Pairing, timeouts: OpenTimeouts) -> Result<Self> {
        pairing.validate()?;
        let decoded = hex::decode(&pairing.key).context("Invalid pairing key")?;
        let key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| anyhow!("Invalid pairing key"))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(wire::MAX_FRAME))
            .max_frame_size(Some(wire::MAX_FRAME));
        let mut request =
            pairing.url.as_str().into_client_request().map_err(|_| {
                ConnectionOpenError::new(OpenStage::Connect, OpenCause::InvalidRequest)
            })?;
        if let Some(scope) = &pairing.scope_id {
            request.headers_mut().insert(
                "x-nesvo-scope",
                scope.parse().map_err(|_| {
                    ConnectionOpenError::new(OpenStage::Connect, OpenCause::InvalidRequest)
                })?,
            );
        }
        let (mut socket, _) = timeout(
            timeouts.connect,
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| ConnectionOpenError::new(OpenStage::Connect, OpenCause::Timeout))?
        .map_err(|error| ConnectionOpenError::websocket(OpenStage::Connect, error))?;
        let hello = timeout(timeouts.challenge_read, socket.next())
            .await
            .map_err(|_| ConnectionOpenError::new(OpenStage::ChallengeRead, OpenCause::Timeout))?;
        let text = handshake_text(OpenStage::ChallengeRead, hello)?;
        let hello: Value = serde_json::from_str(&text).map_err(|_| {
            ConnectionOpenError::new(OpenStage::ChallengeValidate, OpenCause::MalformedMessage)
        })?;
        let challenge = hello["challenge"].as_str().unwrap_or_default().to_owned();
        if !(hello["type"] == "challenge"
            && hello["version"] == 1
            && challenge.len() == 64
            && challenge.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(ConnectionOpenError::new(
                OpenStage::ChallengeValidate,
                OpenCause::InvalidChallenge,
            )
            .into());
        }
        let client_nonce = hex::encode(wire::random::<32>());
        let auth = wire::encode_client(
            json!({"type":"auth", "clientNonce":client_nonce}),
            &key,
            &challenge,
            1,
        )
        .map_err(|_| ConnectionOpenError::new(OpenStage::AuthSend, OpenCause::EncodingFailed))?;
        timeout(timeouts.auth_send, socket.send(Message::Text(auth.into())))
            .await
            .map_err(|_| ConnectionOpenError::new(OpenStage::AuthSend, OpenCause::Timeout))?
            .map_err(|error| ConnectionOpenError::websocket(OpenStage::AuthSend, error))?;
        let answer = timeout(timeouts.auth_read, socket.next())
            .await
            .map_err(|_| ConnectionOpenError::new(OpenStage::AuthRead, OpenCause::Timeout))?;
        let answer = handshake_text(OpenStage::AuthRead, answer)?;
        let connected = wire::decode_host(&answer, &key, &challenge, 1)
            .map_err(|_| ConnectionOpenError::new(OpenStage::HostProof, OpenCause::InvalidProof))?;
        if connected["type"] != "connected" {
            return Err(ConnectionOpenError::new(
                OpenStage::ConnectedValidate,
                OpenCause::UnexpectedFrame,
            )
            .into());
        }
        if connected["clientNonce"] != client_nonce {
            return Err(ConnectionOpenError::new(
                OpenStage::ConnectedValidate,
                OpenCause::NonceMismatch,
            )
            .into());
        }
        if connected["protocolVersion"] != 2 {
            return Err(ConnectionOpenError::new(
                OpenStage::ConnectedValidate,
                OpenCause::ProtocolUnsupported,
            )
            .into());
        }
        let client_id = connected["clientId"].as_u64().ok_or_else(|| {
            ConnectionOpenError::new(OpenStage::ConnectedValidate, OpenCause::MissingIdentity)
        })?;
        let (commands, mut command_rx) = mpsc::channel::<Value>(64);
        let (events_tx, events) = mpsc::channel(128);
        let worker = tokio::spawn(async move {
            let result: Result<()> = async {
                let (mut sink, mut stream) = socket.split();
                let mut sent = 1u64;
                let mut received = 1u64;
                loop {
                    tokio::select! {
                        command = command_rx.recv() => {
                            let Some(command) = command else { break; };
                            sent += 1;
                            let frame = wire::encode_client(command, &key, &challenge, sent)?;
                            timeout(Duration::from_secs(3), sink.send(Message::Text(frame.into()))).await??;
                        }
                        frame = timeout(Duration::from_secs(65), stream.next()) => {
                            match frame.context("Host heartbeat timed out")? {
                                Some(Ok(Message::Text(text))) => {
                                    let payload = wire::decode_host(&text, &key, &challenge, received + 1)
                                        .context("Invalid or replayed host frame")?;
                                    received += 1;
                                    if events_tx.send(NetworkEvent::Message(payload)).await.is_err() { break; }
                                }
                                Some(Ok(Message::Ping(data))) => { timeout(Duration::from_secs(3), sink.send(Message::Pong(data))).await??; }
                                Some(Ok(Message::Pong(_))) => {}
                                Some(Ok(Message::Close(Some(frame)))) if frame.code == CloseCode::Library(4003) => {
                                    return Err(anyhow!("Host rejected command; update nesvo-host and reconnect."));
                                }
                                Some(Ok(Message::Close(_))) | None => return Err(anyhow!("Host disconnected; sessions remain on the host")),
                                Some(Err(_)) => return Err(anyhow!("Host connection interrupted; reconnect to continue")),
                                _ => return Err(anyhow!("Unexpected host message")),
                            }
                        }
                    }
                }
                let _ = timeout(Duration::from_secs(1), sink.close()).await;
                Ok(())
            }.await;
            if let Err(error) = result {
                let _ = events_tx
                    .send(NetworkEvent::Disconnected(error.to_string()))
                    .await;
            }
        });
        Ok(Self {
            client_id,
            events,
            commands,
            worker,
        })
    }

    pub fn send(&self, command: Value) -> Result<()> {
        self.commands
            .try_send(command)
            .map_err(|_| anyhow!("Connection is unavailable or busy; input was not sent"))
    }

    pub fn is_closed(&self) -> bool {
        self.commands.is_closed()
    }

    #[cfg(test)]
    pub(crate) fn scripted() -> (Self, mpsc::Sender<NetworkEvent>) {
        let (events_tx, events) = mpsc::channel(8);
        let (commands, _) = mpsc::channel(1);
        let connection = Self {
            client_id: 0,
            events,
            commands,
            worker: tokio::spawn(async {}),
        };
        (connection, events_tx)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Dropping the socket releases leases. It never sends a process-close command.
        self.worker.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_rejects_credential_and_query_urls() {
        let mut pairing = Pairing {
            scope_id: None,
            version: 1,
            url: "ws://127.0.0.1:8787".into(),
            key: "a".repeat(64),
        };
        assert!(pairing.validate().is_ok());
        for url in [
            "https://example.test",
            "ws://user:secret@localhost",
            "ws://localhost/?key=secret",
            "ws://localhost/other",
        ] {
            pairing.url = url.into();
            assert!(pairing.validate().is_err());
        }
    }
}

#[cfg(test)]
#[path = "network_open_tests.rs"]
mod open_tests;
