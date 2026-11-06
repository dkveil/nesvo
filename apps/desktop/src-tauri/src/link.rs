use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use nesvo_wire as wire;
use serde_json::{Value, json};
use std::{fmt, time::Duration};
use tokio::{net::TcpStream, sync::mpsc, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SEND_TIMEOUT: Duration = Duration::from_secs(3);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const HOST_SILENCE_LIMIT: Duration = Duration::from_secs(65);
const CHALLENGE_HEX_LENGTH: usize = 64;
const PROTOCOL_VERSION: u64 = 2;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
pub struct OpenError {
    pub permanent: bool,
    pub message: String,
}

impl OpenError {
    fn transient(message: impl Into<String>) -> Self {
        Self {
            permanent: false,
            message: message.into(),
        }
    }

    fn permanent(message: impl Into<String>) -> Self {
        Self {
            permanent: true,
            message: message.into(),
        }
    }
}

impl fmt::Display for OpenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for OpenError {}

pub struct Link {
    socket: Socket,
    key: [u8; 32],
    challenge: String,
    pub client_id: u64,
}

async fn next_text(
    socket: &mut Socket,
    stage: &str,
    closed: fn(&str) -> OpenError,
) -> Result<String, OpenError> {
    match timeout(HANDSHAKE_TIMEOUT, socket.next()).await {
        Err(_) => Err(OpenError::transient(format!(
            "Timed out waiting for {stage}"
        ))),
        Ok(Some(Ok(Message::Text(text)))) => Ok(text.to_string()),
        Ok(Some(Ok(Message::Close(_))) | None) => Err(closed(stage)),
        Ok(Some(Ok(_))) => Err(OpenError::permanent(format!(
            "Unexpected frame during {stage}"
        ))),
        Ok(Some(Err(error))) => Err(OpenError::transient(error.to_string())),
    }
}

fn closed_before_challenge(stage: &str) -> OpenError {
    OpenError::transient(format!("Host closed the connection before {stage}"))
}

fn closed_during_auth(_stage: &str) -> OpenError {
    OpenError::permanent("Host rejected the pairing key")
}

pub async fn open(url: &str, key: [u8; 32]) -> Result<Link, OpenError> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(wire::MAX_FRAME))
        .max_frame_size(Some(wire::MAX_FRAME));
    let request = url
        .into_client_request()
        .map_err(|_| OpenError::permanent("Invalid host URL"))?;
    let (mut socket, _) = timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| OpenError::transient("Timed out connecting to the host"))?
    .map_err(|error| OpenError::transient(error.to_string()))?;

    let hello = next_text(&mut socket, "the challenge", closed_before_challenge).await?;
    let hello: Value = serde_json::from_str(&hello)
        .map_err(|_| OpenError::permanent("Host sent a malformed challenge"))?;
    let challenge = hello["challenge"].as_str().unwrap_or_default().to_owned();
    if !(hello["type"] == "challenge"
        && hello["version"] == 1
        && challenge.len() == CHALLENGE_HEX_LENGTH
        && challenge.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(OpenError::permanent("Host sent an invalid challenge"));
    }

    let client_nonce = hex::encode(wire::random::<32>());
    let auth = wire::encode_client(
        json!({"type": "auth", "clientNonce": client_nonce}),
        &key,
        &challenge,
        1,
    )
    .map_err(|error| OpenError::permanent(error.to_string()))?;
    timeout(SEND_TIMEOUT, socket.send(Message::Text(auth.into())))
        .await
        .map_err(|_| OpenError::transient("Timed out sending authentication"))?
        .map_err(|error| OpenError::transient(error.to_string()))?;

    let answer = next_text(&mut socket, "the host proof", closed_during_auth).await?;
    let connected = wire::decode_host(&answer, &key, &challenge, 1)
        .map_err(|_| OpenError::permanent("Host proof is invalid; check the pairing key"))?;
    if connected["type"] != "connected" || connected["clientNonce"] != client_nonce {
        return Err(OpenError::permanent(
            "Host answered with an unexpected message",
        ));
    }
    if connected["protocolVersion"] != PROTOCOL_VERSION {
        return Err(OpenError::permanent("Host does not speak protocol v2"));
    }
    let client_id = connected["clientId"]
        .as_u64()
        .ok_or_else(|| OpenError::permanent("Host did not assign a client id"))?;

    Ok(Link {
        socket,
        key,
        challenge,
        client_id,
    })
}

impl Link {
    pub async fn serve(
        self,
        mut commands: mpsc::Receiver<Value>,
        messages: mpsc::Sender<Value>,
    ) -> Result<()> {
        let Self {
            socket,
            key,
            challenge,
            ..
        } = self;
        let (mut sink, mut stream) = socket.split();
        let mut sent = 1u64;
        let mut received = 1u64;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { break };
                    sent += 1;
                    let frame = wire::encode_client(command, &key, &challenge, sent)?;
                    timeout(SEND_TIMEOUT, sink.send(Message::Text(frame.into()))).await??;
                }
                frame = timeout(HOST_SILENCE_LIMIT, stream.next()) => {
                    match frame.context("Host heartbeat timed out")? {
                        Some(Ok(Message::Text(text))) => {
                            let payload = wire::decode_host(&text, &key, &challenge, received + 1)
                                .context("Invalid or replayed host frame")?;
                            received += 1;
                            if messages.send(payload).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            timeout(SEND_TIMEOUT, sink.send(Message::Pong(data))).await??;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Close(_))) | None => {
                            return Err(anyhow!("Host disconnected; sessions remain on the host"));
                        }
                        Some(Err(_)) => return Err(anyhow!("Host connection interrupted")),
                        Some(Ok(_)) => return Err(anyhow!("Unexpected host message")),
                    }
                }
            }
        }
        let _ = timeout(CLOSE_TIMEOUT, sink.close()).await;
        Ok(())
    }
}
