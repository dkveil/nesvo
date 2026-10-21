//! Opt-in metadata-only push delivery. Network I/O never holds the host lock.
use crate::{attention::Event, sessions::State, storage::MetadataStore};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub fn valid_token(token: &str) -> bool {
    let body = token
        .strip_prefix("ExponentPushToken[")
        .or_else(|| token.strip_prefix("ExpoPushToken["))
        .and_then(|s| s.strip_suffix(']'));
    body.is_some_and(|s| {
        (10..=200).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
impl MetadataStore {
    pub fn push_tokens(&self) -> Result<Vec<String>> {
        Ok(self
            .connection
            .prepare("SELECT token FROM push_devices LIMIT 8")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn register_push(&self, token: &str, enabled: bool) -> Result<()> {
        ensure!(valid_token(token), "Invalid notification token");
        if enabled {
            let tokens = self.push_tokens()?;
            ensure!(
                tokens.contains(&token.to_owned()) || tokens.len() < 8,
                "Maximum 8 registered phones"
            );
            self.connection.execute(
                "INSERT OR IGNORE INTO push_devices(token) VALUES(?1)",
                [token],
            )?;
        } else {
            self.push_kind_table()?;
            self.connection
                .execute("DELETE FROM push_device_kinds WHERE token=?1", [token])?;
            self.connection
                .execute("DELETE FROM push_devices WHERE token=?1", [token])?;
        }
        Ok(())
    }
    fn push_kind_table(&self) -> Result<()> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS push_device_kinds (token TEXT PRIMARY KEY, kinds TEXT NOT NULL);",
        )?;
        Ok(())
    }
    pub fn set_push_kinds(&self, token: &str, kinds: &[String]) -> Result<Vec<String>> {
        let mut chosen: Vec<String> = Vec::new();
        for kind in kinds {
            ensure!(
                crate::attention_inbox::PUSH_KINDS.contains(&kind.as_str()),
                "Unknown notification kind"
            );
            if !chosen.contains(kind) {
                chosen.push(kind.clone());
            }
        }
        ensure!(
            self.push_tokens()?.iter().any(|known| known == token),
            "Register the phone before choosing notification kinds"
        );
        self.push_kind_table()?;
        self.connection.execute(
            "INSERT INTO push_device_kinds(token,kinds) VALUES(?1,?2) ON CONFLICT(token) DO UPDATE SET kinds=excluded.kinds",
            rusqlite::params![token, serde_json::to_string(&chosen)?],
        )?;
        Ok(chosen)
    }
    pub fn push_tokens_for(&self, kind: &str) -> Result<Vec<String>> {
        self.push_kind_table()?;
        let rows = self
            .connection
            .prepare("SELECT d.token,k.kinds FROM push_devices d JOIN push_device_kinds k ON k.token=d.token LIMIT 8")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .filter(|(_, kinds)| {
                serde_json::from_str::<Vec<String>>(kinds)
                    .is_ok_and(|kinds| kinds.iter().any(|known| known == kind))
            })
            .map(|(token, _)| token)
            .collect())
    }
}

pub struct Job {
    pub token: String,
    pub session_id: String,
    pub sequence: u64,
    pub item: Option<String>,
    payload: Value,
}
impl Job {
    pub fn inbox(token: String, host_id: String, kind: &'static str, item: String) -> Self {
        let body = if kind == crate::attention_inbox::PUSH_DECISION {
            "An agent asked a question. Open the inbox to decide."
        } else {
            "A job result is ready to review."
        };
        let payload = json!({"to":token,"title":"nesvo","body":body,"sound":"default","channelId":"attention","ttl":3600,
            "data":{"hostId":host_id,"kind":kind,"itemId":item}});
        Self {
            token,
            session_id: String::new(),
            sequence: 0,
            item: Some(item),
            payload,
        }
    }
    pub fn new(token: String, host_id: String, session_id: String, event: Event) -> Self {
        let body = match event.kind {
            "done" if event.subject == Some("response") => {
                "A response ended. Open the session to review the result."
            }
            "done" if event.source == crate::status::StatusSource::Process => {
                "Agent process exited. Open the session to review."
            }
            "done" => "Agent appears to have finished. Open the session to review.",
            "failed" => "Agent process failed. Open the session for details.",
            "limit" => "Agent reached a usage limit.",
            "permission" => "Agent may need permission. Check the session.",
            _ => "Agent may need your answer. Check the session.",
        };
        let payload = json!({"to":token,"title":"nesvo","body":body,"sound":"default","channelId":"attention","ttl":3600,
            "data":{"hostId":host_id,"sessionId":session_id,"sequence":event.sequence}});
        Self {
            token,
            session_id,
            sequence: event.sequence,
            item: None,
            payload,
        }
    }
}
async fn post(client: &reqwest::Client, path: &str, payload: &Value) -> Result<Value> {
    let mut response = client
        .post(format!("https://exp.host/--/api/v2/push/{path}"))
        .json(payload)
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 64 * 1024,
            "Push response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
fn invalid_device(value: &Value) -> bool {
    value["details"]["error"] == "DeviceNotRegistered"
}
fn unregister(state: &Arc<Mutex<State>>, token: &str) {
    if let Ok(state) = state.lock() {
        let _ = state.metadata.register_push(token, false);
    }
}
pub async fn run(state: Arc<Mutex<State>>) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let mut receipts: VecDeque<(Instant, String, String)> = VecDeque::new();
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let job = state.lock().ok().and_then(|mut s| s.next_push());
        if let Some(job) = job {
            match post(&client, "send", &job.payload).await {
                Ok(response) if invalid_device(&response["data"]) => unregister(&state, &job.token),
                Ok(response) if response["data"]["status"] == "ok" => {
                    if let Some(id) = response["data"]["id"].as_str().filter(|id| id.len() <= 200)
                        && receipts.len() < 256
                    {
                        receipts.push_back((Instant::now(), id.into(), job.token));
                    }
                }
                _ => eprintln!("Notification was not accepted; terminal sessions are unaffected"),
            }
        }
        if receipts
            .front()
            .is_some_and(|(at, _, _)| at.elapsed() >= Duration::from_secs(900))
            && let Some((_, id, token)) = receipts.pop_front()
        {
            match post(&client, "getReceipts", &json!({"ids":[id]})).await {
                Ok(value) if invalid_device(&value["data"][&id]) => unregister(&state, &token),
                Ok(value) if value["data"][&id]["status"] == "ok" => {}
                _ => eprintln!("Notification delivery receipt unavailable or rejected"),
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_is_bounded_and_idempotent_and_payload_contains_no_terminal_data() {
        let store = MetadataStore::open(std::path::Path::new(":memory:")).unwrap();
        assert!(!valid_token("https://example.com"));
        for i in 0..8 {
            store
                .register_push(&format!("ExpoPushToken[abcdefghijk{i}]"), true)
                .unwrap();
        }
        store
            .register_push("ExpoPushToken[abcdefghijk0]", true)
            .unwrap();
        assert!(
            store
                .register_push("ExpoPushToken[abcdefghijk9]", true)
                .is_err()
        );
        store
            .register_push("ExpoPushToken[abcdefghijk0]", false)
            .unwrap();
        assert_eq!(store.push_tokens().unwrap().len(), 7);
        let job = Job::new(
            "token".into(),
            "host".into(),
            "session".into(),
            Event {
                sequence: 1,
                kind: "question",
                at: 1,
                unread: true,
                source: crate::status::StatusSource::Screen,
                subject: None,
                turn_id: None,
            },
        );
        assert_eq!(
            job.payload["data"],
            json!({"hostId":"host","sessionId":"session","sequence":1})
        );
        assert!(invalid_device(
            &json!({"details":{"error":"DeviceNotRegistered"}})
        ));
    }
}
