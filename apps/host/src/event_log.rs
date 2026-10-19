//! Durable domain observations. Terminal replay has a separate cursor space.
use crate::api_error::Error;
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};

const RETENTION: u64 = 4096;
const MAX_PAGE: usize = 32;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;
#[derive(Clone)]
pub struct Observation {
    pub session_id: Option<String>,
    pub kind: &'static str,
    pub at: u64,
    pub payload: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub sequence: u64,
    pub session_id: Option<String>,
    pub kind: String,
    pub at: u64,
    pub payload: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<Event>,
    pub next_cursor: u64,
    pub head_cursor: u64,
    pub floor_cursor: u64,
    pub gap: bool,
    pub more: bool,
}
struct Store(Connection);
impl Store {
    fn open(path: &std::path::Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_millis(50))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS domain_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS domain_events_session ON domain_events(session_id,sequence);
          CREATE TABLE IF NOT EXISTS domain_event_cursor(id INTEGER PRIMARY KEY CHECK(id=1),head INTEGER NOT NULL,floor INTEGER NOT NULL);
          INSERT OR IGNORE INTO domain_event_cursor VALUES(1,0,0);")?;
        Ok(Self(connection))
    }
    fn cursors(&self) -> Result<(u64, u64)> {
        let (head, floor): (i64, i64) = self.0.query_row(
            "SELECT head,floor FROM domain_event_cursor WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (head, floor) = (u64::try_from(head)?, u64::try_from(floor)?);
        ensure!(
            floor <= head && head <= MAX_CURSOR,
            "Invalid persisted event cursor"
        );
        Ok((head, floor))
    }
    fn append(&mut self, observations: Vec<Observation>) -> Result<u64> {
        ensure!(
            !observations.is_empty() && observations.len() <= 64,
            "Invalid observation batch"
        );
        let encoded: Vec<_> = observations
            .into_iter()
            .map(|e| -> Result<_> {
                ensure!(
                    e.session_id.as_ref().is_none_or(|id| !id.is_empty()
                        && id.len() <= 128
                        && !id.chars().any(char::is_control)),
                    "Invalid event subject"
                );
                ensure!(
                    !e.kind.is_empty()
                        && e.kind.len() <= 64
                        && e.kind
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b"._".contains(&b)),
                    "Invalid event kind"
                );
                ensure!(e.at <= MAX_CURSOR, "Invalid event timestamp");
                ensure!(
                    e.payload.is_object(),
                    "Event payload must be metadata object"
                );
                let payload = serde_json::to_string(&e.payload)?;
                ensure!(payload.len() <= 1024, "Event metadata exceeds 1024 bytes");
                Ok((e, payload))
            })
            .collect::<Result<_>>()?;
        let transaction = self.0.transaction()?;
        let mut head = 0;
        for (event, payload) in encoded {
            transaction.execute(
                "INSERT INTO domain_events(session_id,kind,at,payload) VALUES(?1,?2,?3,?4)",
                params![event.session_id, event.kind, event.at as i64, payload],
            )?;
            head = u64::try_from(transaction.last_insert_rowid())?;
            ensure!(head <= MAX_CURSOR, "Event sequence exhausted");
        }
        let floor = head.saturating_sub(RETENTION);
        transaction.execute(
            "DELETE FROM domain_events WHERE sequence<=?1",
            [floor as i64],
        )?;
        transaction.execute(
            "UPDATE domain_event_cursor SET head=?1,floor=?2 WHERE id=1",
            params![head as i64, floor as i64],
        )?;
        transaction.commit()?;
        Ok(head)
    }
    fn read(&self, after: u64, limit: usize, session_id: Option<&str>) -> Result<Page> {
        if !(1..=MAX_PAGE).contains(&limit) {
            return Err(Error::new("invalid_argument", "Event page limit must be 1–32").into());
        }
        let transaction = self.0.unchecked_transaction()?;
        let (head, floor) = self.cursors()?;
        if after > head {
            return Err(Error::new(
                "invalid_cursor",
                "Event cursor is ahead of this host journal",
            )
            .into());
        }
        let mut statement=transaction.prepare("SELECT sequence,session_id,kind,at,payload FROM domain_events WHERE sequence>?1 AND sequence<=?4 AND (?2 IS NULL OR session_id=?2) ORDER BY sequence LIMIT ?3")?;
        let rows = statement.query_map(
            params![
                after.max(floor) as i64,
                session_id,
                (limit + 1) as i64,
                head as i64
            ],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, session_id, kind, at, payload) = row?;
            let (sequence, at) = (u64::try_from(sequence)?, u64::try_from(at)?);
            ensure!(payload.len() <= 1024, "Stored event exceeds metadata limit");
            events.push(Event {
                sequence,
                session_id,
                kind,
                at,
                payload: serde_json::from_str(&payload)?,
            });
        }
        let more = events.len() > limit;
        events.truncate(limit);
        let next_cursor = if more {
            events.last().map_or(after.max(floor), |e| e.sequence)
        } else {
            head
        };
        let page = Page {
            events,
            next_cursor,
            head_cursor: head,
            floor_cursor: floor,
            gap: after < floor,
            more,
        };
        drop(statement);
        transaction.commit()?;
        Ok(page)
    }
}

enum Work {
    Append(Vec<Observation>, Option<oneshot::Sender<Result<u64>>>),
    Read {
        after: u64,
        limit: usize,
        session_id: Option<String>,
        reply: oneshot::Sender<Result<Page>>,
    },
    Stop(oneshot::Sender<()>),
}
#[derive(Clone)]
pub struct Service {
    sender: mpsc::Sender<Work>,
    changed: watch::Receiver<u64>,
    health_changed: watch::Sender<u64>,
    drops: Arc<AtomicU64>,
    failures: Arc<AtomicU64>,
}
impl Service {
    pub async fn open(path: PathBuf) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<Work>(128);
        let (changed_tx, changed) = watch::channel(0);
        let health_changed = changed_tx.clone();
        let (ready_tx, ready_rx) = oneshot::channel();
        let drops = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let worker_failures = failures.clone();
        std::thread::Builder::new()
            .name("nesvo-events".into())
            .spawn(move || {
                let mut store = match Store::open(&path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let head = match store.cursors() {
                    Ok((head, _)) => head,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                changed_tx.send_replace(head);
                let _ = ready_tx.send(Ok(()));
                while let Some(work) = receiver.blocking_recv() {
                    match work {
                        Work::Append(events, reply) => {
                            let result = store.append(events);
                            match &result {
                                Ok(head) => {
                                    changed_tx.send_replace(*head);
                                }
                                Err(_) => {
                                    worker_failures.fetch_add(1, Ordering::Relaxed);
                                    changed_tx.send_modify(|_| {});
                                }
                            }
                            if let Some(reply) = reply {
                                let _ = reply.send(result);
                            }
                        }
                        Work::Read {
                            after,
                            limit,
                            session_id,
                            reply,
                        } => {
                            let _ = reply.send(store.read(after, limit, session_id.as_deref()));
                        }
                        Work::Stop(reply) => {
                            drop(store);
                            let _ = reply.send(());
                            return;
                        }
                    }
                }
            })?;
        ready_rx
            .await
            .map_err(|_| anyhow!("Event journal initialization stopped"))??;
        Ok(Self {
            sender,
            changed,
            health_changed,
            drops,
            failures,
        })
    }
    /// Informational observations fail open; the health counter exposes any loss.
    /// Critical workflow results use `append` and await durable acknowledgement.
    pub fn observe(&self, event: Observation) {
        if self
            .sender
            .try_send(Work::Append(vec![event], None))
            .is_err()
        {
            self.drops.fetch_add(1, Ordering::Relaxed);
            self.health_changed.send_modify(|_| {});
        }
    }
    pub async fn append(&self, events: Vec<Observation>) -> Result<u64> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Append(events, Some(reply)))
            .await
            .map_err(|_| anyhow!("Event journal is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Event journal stopped before confirmation"))?
    }
    pub async fn read(&self, after: u64, limit: usize, session_id: Option<String>) -> Result<Page> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Read {
                after,
                limit,
                session_id,
                reply,
            })
            .await
            .map_err(|_| anyhow!("Event journal is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Event journal stopped before reading"))?
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.clone()
    }
    pub fn health(&self) -> Value {
        serde_json::json!({"observationDrops":self.drops.load(Ordering::Relaxed),"writeFailures":self.failures.load(Ordering::Relaxed)})
    }
    pub async fn shutdown(&self) {
        let (reply, answer) = oneshot::channel();
        if self.sender.send(Work::Stop(reply)).await.is_ok() {
            let _ = answer.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(id: &str, at: u64) -> Observation {
        Observation {
            session_id: Some(id.into()),
            kind: "response.settled",
            at,
            payload: serde_json::json!({"turnId":"launch:2"}),
        }
    }
    #[test]
    fn informational_backpressure_is_bounded_and_visible() {
        let (sender, _held_receiver) = mpsc::channel(1);
        let (health_changed, changed) = watch::channel(0);
        let service = Service {
            sender,
            changed,
            health_changed,
            drops: Arc::new(AtomicU64::new(0)),
            failures: Arc::new(AtomicU64::new(0)),
        };
        service.observe(event("s", 1));
        service.observe(event("s", 2));
        assert_eq!(service.health()["observationDrops"], 1);
    }
    #[test]
    fn persistence_order_retention_and_scoped_cursors_do_not_rely_on_wall_clock() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-events-{}.sqlite",
            hex::encode(crate::wire::random::<8>())
        ));
        {
            let mut store = Store::open(&path).unwrap();
            for _ in 0..65 {
                store
                    .append(
                        (0..64)
                            .map(|i| event(if i % 2 == 0 { "a" } else { "b" }, 1000 - i))
                            .collect(),
                    )
                    .unwrap();
            }
            let page = store.read(0, 32, Some("a")).unwrap();
            assert!(page.gap && page.more);
            assert_eq!(page.floor_cursor, 64);
            assert_eq!(page.events[0].sequence, 65);
            assert!(
                page.events
                    .iter()
                    .all(|e| e.session_id.as_deref() == Some("a"))
            );
            assert!(serde_json::to_vec(&page).unwrap().len() < 48 * 1024);
            assert!(store.read(page.head_cursor + 1, 32, None).is_err());
            assert!(store.read(0, 33, None).is_err());
            let none = store.read(page.floor_cursor, 32, Some("absent")).unwrap();
            assert_eq!(none.next_cursor, page.head_cursor);
        }
        let store = Store::open(&path).unwrap();
        let page = store.read(4159, 32, Some("b")).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.next_cursor, 4160);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn subscribe_before_read_cannot_lose_a_fast_result_and_shutdown_drains() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-events-{}.sqlite",
            hex::encode(crate::wire::random::<8>())
        ));
        let service = Service::open(path.clone()).await.unwrap();
        let mut changed = service.subscribe();
        changed.borrow_and_update();
        let mut oversized = event("s", 0);
        oversized.payload = serde_json::json!({"value":"x".repeat(1024)});
        assert!(service.append(vec![oversized]).await.is_err());
        changed.changed().await.unwrap();
        assert_eq!(
            service.health()["writeFailures"],
            1,
            "observation failures are visible, not swallowed"
        );
        assert!(service.read(0, 32, None).await.unwrap().events.is_empty());
        assert_eq!(service.append(vec![event("s", 1)]).await.unwrap(), 1);
        changed.changed().await.unwrap();
        let page = service.read(0, 32, Some("s".into())).await.unwrap();
        assert_eq!(page.events.len(), 1);
        service.observe(event("s", 0));
        service.shutdown().await;
        let store = Store::open(&path).unwrap();
        assert_eq!(store.read(0, 32, None).unwrap().events.len(), 2);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
}
