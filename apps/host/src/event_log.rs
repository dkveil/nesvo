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
pub(crate) fn append_transaction(
    transaction: &rusqlite::Transaction<'_>,
    observations: Vec<Observation>,
) -> Result<u64> {
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
    Ok(head)
}

struct Store(Connection);
#[cfg(test)]
#[path = "journal_concurrency_tests.rs"]
mod journal_concurrency_tests;
#[cfg(test)]
#[path = "orchestration_tests.rs"]
mod orchestration_tests;
#[cfg(test)]
#[path = "workflow_inbox_tests.rs"]
mod workflow_inbox_tests;
impl Store {
    fn open(path: &std::path::Path) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_millis(50))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS domain_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS domain_events_session ON domain_events(session_id,sequence);
          CREATE TABLE IF NOT EXISTS domain_event_cursor(id INTEGER PRIMARY KEY CHECK(id=1),head INTEGER NOT NULL,floor INTEGER NOT NULL);
          INSERT OR IGNORE INTO domain_event_cursor VALUES(1,0,0);")?;
        crate::receipts::initialize(&mut connection)?;
        crate::orchestration::initialize(&connection)?;
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
        let transaction = self.0.transaction()?;
        let head = append_transaction(&transaction, observations)?;
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
    Workflow {
        actor: crate::orchestration::Actor,
        request: crate::orchestration::Request,
        reply: oneshot::Sender<Result<Value>>,
    },
    Accept {
        operation: &'static str,
        issuer: String,
        key: String,
        request: Value,
        reply: oneshot::Sender<Result<crate::receipts::Accepted>>,
    },
    Claim {
        issuer: String,
        id: String,
        reply: oneshot::Sender<Result<Option<crate::receipts::Claim>>>,
    },
    Finish {
        issuer: String,
        id: String,
        token: String,
        phase: String,
        result: Value,
        reply: oneshot::Sender<Result<crate::receipts::Receipt>>,
    },
    GetOperation {
        issuer: String,
        admin: bool,
        id: Option<String>,
        key: Option<String>,
        reply: oneshot::Sender<Result<crate::receipts::View>>,
    },
    Append(Vec<Observation>, Option<oneshot::Sender<Result<u64>>>),
    Read {
        after: u64,
        limit: usize,
        session_id: Option<String>,
        reply: oneshot::Sender<Result<Page>>,
    },
    Stop(oneshot::Sender<()>),
}
fn notify_head(store: &Store, changed: &watch::Sender<u64>) {
    if let Ok((head, _)) = store.cursors() {
        let current = *changed.borrow();
        if head != current {
            changed.send_replace(head);
        }
    }
}
fn record_storage_failure<T>(
    result: &Result<T>,
    failures: &AtomicU64,
    changed: &watch::Sender<u64>,
) {
    if let Err(error) = result
        && error.downcast_ref::<Error>().is_none()
    {
        failures.fetch_add(1, Ordering::Relaxed);
        changed.send_modify(|_| {});
    }
}
#[derive(Clone)]
pub struct Service {
    sender: mpsc::Sender<Work>,
    changed: watch::Receiver<u64>,
    health_changed: watch::Sender<u64>,
    drops: Arc<AtomicU64>,
    failures: Arc<AtomicU64>,
    wait_slots: Arc<tokio::sync::Semaphore>,
}
impl Service {
    pub async fn workflow(
        &self,
        actor: crate::orchestration::Actor,
        request: crate::orchestration::Request,
    ) -> Result<Value> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Workflow {
                actor,
                request,
                reply,
            })
            .await
            .map_err(|_| anyhow!("Workflow store is closed"))?;
        answer.await.map_err(|_| {
            anyhow!("Workflow outcome was not confirmed; recover the same mutation key")
        })?
    }
    pub fn wait_slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.wait_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("busy", "Host wait capacity is exhausted").into())
    }
    pub async fn accept(
        &self,
        issuer: String,
        key: String,
        request: Value,
    ) -> Result<crate::receipts::Accepted> {
        self.accept_operation(issuer, key, "create", request).await
    }
    pub async fn accept_send(
        &self,
        issuer: String,
        key: String,
        request: Value,
    ) -> Result<crate::receipts::Accepted> {
        self.accept_operation(issuer, key, "send", request).await
    }
    pub(crate) async fn accept_operation(
        &self,
        issuer: String,
        key: String,
        operation: &'static str,
        request: Value,
    ) -> Result<crate::receipts::Accepted> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Accept {
                operation,
                issuer,
                key,
                request,
                reply,
            })
            .await
            .map_err(|_| anyhow!("Operation store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Operation acceptance was not confirmed"))?
    }
    pub async fn claim(
        &self,
        issuer: String,
        id: String,
    ) -> Result<Option<crate::receipts::Claim>> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Claim { issuer, id, reply })
            .await
            .map_err(|_| anyhow!("Operation store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Operation claim was not confirmed"))?
    }
    pub async fn finish(
        &self,
        issuer: String,
        id: String,
        token: String,
        phase: String,
        result: Value,
    ) -> Result<crate::receipts::Receipt> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Finish {
                issuer,
                id,
                token,
                phase,
                result,
                reply,
            })
            .await
            .map_err(|_| anyhow!("Operation store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Operation outcome was not confirmed"))?
    }
    pub async fn operation(
        &self,
        issuer: String,
        admin: bool,
        id: Option<String>,
        key: Option<String>,
    ) -> Result<crate::receipts::View> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::GetOperation {
                issuer,
                admin,
                id,
                key,
                reply,
            })
            .await
            .map_err(|_| anyhow!("Operation store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Operation could not be read"))?
    }
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
                        Work::Workflow {
                            actor,
                            request,
                            reply,
                        } => {
                            let result =
                                crate::orchestration::execute(&mut store.0, actor, request);
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Accept {
                            operation,
                            issuer,
                            key,
                            request,
                            reply,
                        } => {
                            let result = crate::receipts::accept(
                                &mut store.0,
                                &issuer,
                                &key,
                                operation,
                                request,
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Claim { issuer, id, reply } => {
                            let result = crate::receipts::claim(&mut store.0, &id, &issuer);
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Finish {
                            issuer,
                            id,
                            token,
                            phase,
                            result,
                            reply,
                        } => {
                            let result = crate::receipts::finish(
                                &mut store.0,
                                &id,
                                &issuer,
                                &token,
                                &phase,
                                result,
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::GetOperation {
                            issuer,
                            admin,
                            id,
                            key,
                            reply,
                        } => {
                            let _ = reply.send(crate::receipts::get(
                                &store.0,
                                &issuer,
                                admin,
                                id.as_deref(),
                                key.as_deref(),
                            ));
                        }
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
            wait_slots: Arc::new(tokio::sync::Semaphore::new(32)),
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
    use serde_json::json;

    #[test]
    fn receipt_and_event_commit_atomically_and_claims_cannot_be_reused() {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.0.execute_batch("CREATE TRIGGER reject_event BEFORE INSERT ON domain_events BEGIN SELECT RAISE(ABORT,'fixture disk error'); END;").unwrap();
        assert!(
            crate::receipts::accept(
                &mut store.0,
                "owner",
                "key",
                "create",
                json!({"prompt":"private fixture"})
            )
            .is_err()
        );
        assert_eq!(
            store
                .0
                .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(store.cursors().unwrap(), (0, 0));
        store.0.execute_batch("DROP TRIGGER reject_event").unwrap();
        let accepted = crate::receipts::accept(
            &mut store.0,
            "owner",
            "key",
            "create",
            json!({"prompt":"private fixture"}),
        )
        .unwrap();
        assert!(accepted.is_new);
        let id = &accepted.receipt.id;
        let view = crate::receipts::get(&store.0, "owner", true, Some(id), None).unwrap();
        assert_eq!(view.cursor, 1);
        assert_eq!(view.receipt.phase, "accepted");
        assert!(
            !crate::receipts::accept(
                &mut store.0,
                "owner",
                "key",
                "create",
                json!({"prompt":"private fixture"})
            )
            .unwrap()
            .is_new
        );
        assert!(
            crate::receipts::accept(
                &mut store.0,
                "owner",
                "key",
                "create",
                json!({"prompt":"different"})
            )
            .is_err()
        );
        assert_eq!(
            store.cursors().unwrap().0,
            1,
            "replays/conflicts create no events"
        );
        assert!(crate::receipts::get(&store.0, "session:other", false, Some(id), None).is_err());
        assert!(
            crate::receipts::claim(&mut store.0, id, "session:other")
                .unwrap()
                .is_none()
        );
        let claim = crate::receipts::claim(&mut store.0, id, "owner")
            .unwrap()
            .unwrap();
        assert!(
            crate::receipts::claim(&mut store.0, id, "owner")
                .unwrap()
                .is_none()
        );
        assert!(
            crate::receipts::finish(&mut store.0, id, "owner", "forged", "created", json!({}))
                .is_err()
        );
        let receipt = crate::receipts::finish(
            &mut store.0,
            id,
            "owner",
            &claim.token,
            "created",
            json!({"taskResult":null}),
        )
        .unwrap();
        assert_eq!(receipt.phase, "created");
        assert!(
            crate::receipts::finish(
                &mut store.0,
                id,
                "owner",
                &claim.token,
                "created",
                json!({})
            )
            .is_err()
        );
        let view = crate::receipts::get(&store.0, "owner", true, None, Some("key")).unwrap();
        assert_eq!(view.cursor, 3);
        let page = store.read(0, 32, None).unwrap();
        assert_eq!(page.events.len(), 3);
        assert!(
            !serde_json::to_string(&page)
                .unwrap()
                .contains("private fixture")
        );
        let other =
            crate::receipts::accept(&mut store.0, "session:other", "key", "create", json!({}))
                .unwrap();
        assert_ne!(other.receipt.id, *id, "keys are namespaced by caller");
    }

    #[tokio::test]
    async fn concurrent_acceptance_has_one_dispatch_and_restart_preserves_uncertainty() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-receipts-{}.sqlite",
            hex::encode(crate::wire::random::<8>())
        ));
        let service = Service::open(path.clone()).await.unwrap();
        let (a, b) = tokio::join!(
            service.accept("owner".into(), "shared".into(), json!({"name":"same"})),
            service.accept("owner".into(), "shared".into(), json!({"name":"same"}))
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.receipt.id, b.receipt.id);
        assert_ne!(a.is_new, b.is_new);
        let claim = service
            .claim("owner".into(), a.receipt.id.clone())
            .await
            .unwrap()
            .unwrap();
        let pending = service
            .accept("owner".into(), "not-dispatched".into(), json!({}))
            .await
            .unwrap();
        service.shutdown().await;
        let reopened = Service::open(path.clone()).await.unwrap();
        for id in [&a.receipt.id, &pending.receipt.id] {
            let view = reopened
                .operation("owner".into(), true, Some(id.clone()), None)
                .await
                .unwrap();
            assert_eq!(view.receipt.phase, "unknown");
            assert_eq!(view.receipt.result["code"], "host_restart");
            assert!(
                reopened
                    .claim("owner".into(), id.clone())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            reopened
                .finish(
                    "owner".into(),
                    a.receipt.id.clone(),
                    claim.token,
                    "created".into(),
                    json!({})
                )
                .await
                .is_err()
        );
        let replay = reopened
            .accept("owner".into(), "shared".into(), json!({"name":"same"}))
            .await
            .unwrap();
        assert!(!replay.is_new);
        assert_eq!(replay.receipt.phase, "unknown");
        assert_eq!(
            reopened.health()["writeFailures"],
            0,
            "semantic conflicts are not storage faults"
        );
        reopened.shutdown().await;
        std::fs::remove_file(path).unwrap();
    }

    fn event(id: &str, at: u64) -> Observation {
        Observation {
            session_id: Some(id.into()),
            kind: "response.settled",
            at,
            payload: serde_json::json!({"turnId":"launch:2"}),
        }
    }
    #[test]
    fn early_response_beats_late_write_ack_and_send_restart_never_replays() {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let accepted = crate::receipts::accept(
            &mut store.0,
            "owner",
            "send-key",
            "send",
            json!({"sessionId":"s","prompt":"wanted"}),
        )
        .unwrap();
        let claim = crate::receipts::claim(&mut store.0, &accepted.receipt.id, "owner")
            .unwrap()
            .unwrap();
        let id = &claim.receipt.id;
        let started = crate::receipts::finish(
            &mut store.0,
            id,
            "owner",
            &claim.token,
            "received",
            json!({"turnId":"launch:2","sourceSequence":2}),
        )
        .unwrap();
        assert_eq!(started.phase, "received");
        let delivered = crate::receipts::finish(
            &mut store.0,
            id,
            "owner",
            &claim.token,
            "delivered",
            json!({"nativeWriteFlushed":true}),
        )
        .unwrap();
        assert_eq!(delivered.phase, "received");
        assert_eq!(delivered.result["turnId"], "launch:2");
        let settled = crate::receipts::finish(
            &mut store.0,
            id,
            "owner",
            &claim.token,
            "settled",
            json!({"sourceSequence":3,"taskResult":null}),
        )
        .unwrap();
        assert_eq!(settled.phase, "settled");
        let late = crate::receipts::finish(
            &mut store.0,
            id,
            "owner",
            &claim.token,
            "delivered",
            json!({"nativeWriteFlushed":true,"ackArrivedLate":true}),
        )
        .unwrap();
        assert_eq!(late.phase, "settled");
        assert_eq!(late.result["ackArrivedLate"], true);
        let other = crate::receipts::accept(
            &mut store.0,
            "owner",
            "other",
            "send",
            json!({"sessionId":"s","prompt":"next"}),
        )
        .unwrap();
        let other_claim = crate::receipts::claim(&mut store.0, &other.receipt.id, "owner")
            .unwrap()
            .unwrap();
        crate::receipts::finish(
            &mut store.0,
            &other.receipt.id,
            "owner",
            &other_claim.token,
            "delivered",
            json!({"nativeWriteFlushed":true}),
        )
        .unwrap();
        let untracked = crate::receipts::accept(
            &mut store.0,
            "owner",
            "untracked",
            "send",
            json!({"sessionId":"shell","prompt":"literal"}),
        )
        .unwrap();
        let untracked_claim = crate::receipts::claim(&mut store.0, &untracked.receipt.id, "owner")
            .unwrap()
            .unwrap();
        crate::receipts::finish(
            &mut store.0,
            &untracked.receipt.id,
            "owner",
            &untracked_claim.token,
            "delivered",
            json!({"nativeWriteFlushed":true,"correlation":"unavailable"}),
        )
        .unwrap();
        crate::receipts::initialize(&mut store.0).unwrap();
        let delivery =
            crate::receipts::get(&store.0, "owner", true, Some(&untracked.receipt.id), None)
                .unwrap();
        assert_eq!(
            delivery.receipt.phase, "delivered",
            "confirmed delivery without response tracking remains historical after restart"
        );
        let unknown =
            crate::receipts::get(&store.0, "owner", true, Some(&other.receipt.id), None).unwrap();
        assert_eq!(unknown.receipt.phase, "unknown");
        assert!(
            !crate::receipts::accept(
                &mut store.0,
                "owner",
                "other",
                "send",
                json!({"sessionId":"s","prompt":"next"})
            )
            .unwrap()
            .is_new
        );
        assert!(
            crate::receipts::claim(&mut store.0, &other.receipt.id, "owner")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn confirmed_control_receipts_survive_restart_without_replay_or_kind_confusion() {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        for (operation, phase) in [("interrupt", "delivered"), ("stop", "stopRequested")] {
            let accepted = crate::receipts::accept(
                &mut store.0,
                "owner",
                operation,
                operation,
                json!({"sessionId":"target"}),
            )
            .unwrap();
            let claim = crate::receipts::claim(&mut store.0, &accepted.receipt.id, "owner")
                .unwrap()
                .unwrap();
            assert!(
                crate::receipts::finish(
                    &mut store.0,
                    &accepted.receipt.id,
                    "owner",
                    &claim.token,
                    "created",
                    json!({})
                )
                .is_err()
            );
            crate::receipts::finish(
                &mut store.0,
                &accepted.receipt.id,
                "owner",
                &claim.token,
                phase,
                json!({"taskResult":null}),
            )
            .unwrap();
            crate::receipts::initialize(&mut store.0).unwrap();
            let historical =
                crate::receipts::get(&store.0, "owner", true, Some(&accepted.receipt.id), None)
                    .unwrap();
            assert_eq!(historical.receipt.phase, phase);
            let replay = crate::receipts::accept(
                &mut store.0,
                "owner",
                operation,
                operation,
                json!({"sessionId":"target"}),
            )
            .unwrap();
            assert!(!replay.is_new);
            assert!(
                crate::receipts::claim(&mut store.0, &accepted.receipt.id, "owner")
                    .unwrap()
                    .is_none()
            );
            assert!(
                crate::receipts::accept(
                    &mut store.0,
                    "owner",
                    operation,
                    "send",
                    json!({"sessionId":"target","prompt":"different effect"})
                )
                .is_err()
            );
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
            wait_slots: Arc::new(tokio::sync::Semaphore::new(32)),
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
