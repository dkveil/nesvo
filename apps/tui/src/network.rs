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
        Message,
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

pub struct Connection {
    pub client_id: u64,
    pub events: mpsc::Receiver<NetworkEvent>,
    commands: mpsc::Sender<Value>,
    worker: JoinHandle<()>,
}

impl Connection {
    pub async fn open(pairing: Pairing) -> Result<Self> {
        pairing.validate()?;
        let decoded = hex::decode(&pairing.key).context("Invalid pairing key")?;
        let key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| anyhow!("Invalid pairing key"))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(wire::MAX_FRAME))
            .max_frame_size(Some(wire::MAX_FRAME));
        let mut request = pairing.url.as_str().into_client_request()?;
        if let Some(scope) = &pairing.scope_id {
            request
                .headers_mut()
                .insert("x-nesvo-scope", scope.parse()?);
        }
        let (mut socket, _) = timeout(
            Duration::from_secs(8),
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .context("Host connection timed out")?
        .context("Cannot connect to host; check that it is running and reachable")?;
        let hello = timeout(Duration::from_secs(5), socket.next())
            .await
            .context("Host handshake timed out")?
            .ok_or_else(|| anyhow!("Host closed during handshake"))??;
        let Message::Text(text) = hello else {
            return Err(anyhow!("Invalid host handshake"));
        };
        let hello: Value = serde_json::from_str(&text).context("Invalid host handshake")?;
        let challenge = hello["challenge"].as_str().unwrap_or_default().to_owned();
        ensure!(
            hello["type"] == "challenge"
                && hello["version"] == 1
                && challenge.len() == 64
                && challenge.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid host challenge"
        );
        let client_nonce = hex::encode(wire::random::<32>());
        let auth = wire::encode_client(
            json!({"type":"auth", "clientNonce":client_nonce}),
            &key,
            &challenge,
            1,
        )?;
        timeout(
            Duration::from_secs(3),
            socket.send(Message::Text(auth.into())),
        )
        .await??;
        let answer = timeout(Duration::from_secs(5), socket.next())
            .await
            .context("Host authentication timed out")?
            .ok_or_else(|| anyhow!("Host closed during authentication"))??;
        let Message::Text(answer) = answer else {
            return Err(anyhow!("Host rejected authentication"));
        };
        let connected = wire::decode_host(&answer, &key, &challenge, 1)
            .context("Could not authenticate host")?;
        ensure!(
            connected["type"] == "connected" && connected["clientNonce"] == client_nonce,
            "Host did not prove this connection's fresh nonce"
        );
        ensure!(
            connected["protocolVersion"] == 2,
            "This TUI requires host protocol v2; update the host"
        );
        let client_id = connected["clientId"]
            .as_u64()
            .ok_or_else(|| anyhow!("Missing client identity"))?;
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
