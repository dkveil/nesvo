//! Durable domain observations. Terminal replay has a separate cursor space.
use crate::api_error::Error;
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch};

const RETENTION: u64 = 4096;
const MAX_PAGE: usize = 32;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;

/// A process-local elapsed clock for explicitly armed execution limits. Stored
/// deadlines lose dispatch authority at recovery and never cross this origin.
pub(crate) fn monotonic_millis() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
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
#[path = "budget_tests.rs"]
mod budget_tests;
#[cfg(test)]
#[path = "job_attempts_tests.rs"]
mod job_attempts_tests;
#[cfg(test)]
#[path = "job_cancellations_tests.rs"]
mod job_cancellations_tests;
#[cfg(test)]
#[path = "job_definitions_tests.rs"]
mod job_definitions_tests;
#[cfg(test)]
#[path = "job_dispatch_tests.rs"]
mod job_dispatch_tests;
#[cfg(test)]
#[path = "job_generation_prechecks_tests.rs"]
mod job_generation_prechecks_tests;
#[cfg(test)]
#[path = "job_launch_resolutions_tests.rs"]
mod job_launch_resolutions_tests;
#[cfg(test)]
#[path = "job_prechecks_tests.rs"]
mod job_prechecks_tests;
#[cfg(test)]
#[path = "job_quota_tests.rs"]
mod job_quota_tests;
#[cfg(test)]
#[path = "job_retries_tests.rs"]
mod job_retries_tests;
#[cfg(test)]
#[path = "job_timeout_controls_tests.rs"]
mod job_timeout_controls_tests;
#[cfg(test)]
#[path = "job_timeouts_tests.rs"]
mod job_timeouts_tests;
#[cfg(test)]
#[path = "job_triggers_tests.rs"]
mod job_triggers_tests;
#[cfg(test)]
#[path = "journal_concurrency_tests.rs"]
mod journal_concurrency_tests;
#[cfg(test)]
#[path = "orchestration_tests.rs"]
mod orchestration_tests;
#[cfg(test)]
#[path = "quota_wakes_tests.rs"]
mod quota_wakes_tests;
#[cfg(test)]
#[path = "workflow_budget_tests.rs"]
mod workflow_budget_tests;
#[cfg(test)]
#[path = "workflow_checkpoints_tests.rs"]
mod workflow_checkpoints_tests;
#[cfg(test)]
#[path = "workflow_controls_tests.rs"]
mod workflow_controls_tests;
#[cfg(test)]
#[path = "workflow_coordinator_tests.rs"]
mod workflow_coordinator_tests;
#[cfg(test)]
#[path = "workflow_decisions_tests.rs"]
mod workflow_decisions_tests;
#[cfg(test)]
#[path = "workflow_delivery_tests.rs"]
mod workflow_delivery_tests;
#[cfg(test)]
#[path = "workflow_executor_tests.rs"]
mod workflow_executor_tests;
#[cfg(test)]
#[path = "workflow_inbox_tests.rs"]
mod workflow_inbox_tests;
#[cfg(test)]
#[path = "workflow_launch_quota_tests.rs"]
mod workflow_launch_quota_tests;
#[cfg(test)]
#[path = "workflow_launches_tests.rs"]
mod workflow_launches_tests;
#[cfg(test)]
#[path = "workflow_recovery_tests.rs"]
mod workflow_recovery_tests;
#[cfg(test)]
#[path = "workflow_wakes_tests.rs"]
mod workflow_wakes_tests;
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
        crate::quota_wakes::initialize(&connection)?;
        crate::quota_wakes::recover(&mut connection)?;
        {
            let schema =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            crate::orchestration::initialize(&schema)?;
            schema.commit()?;
        }
        crate::workflow_launches::recover(&mut connection)?;
        crate::workflow_delivery::recover(&mut connection)?;
        crate::workflow_executor::recover(&mut connection)?;
        crate::workflow_wakes::recover(&mut connection)?;
        crate::workflow_controls::recover(&mut connection)?;
        crate::job_definitions::recover(&mut connection, crate::status::now_millis())?;
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
        let mut attention: Vec<_> = observations
            .iter()
            .filter(|observation| observation.kind == "agent.attention")
            .filter_map(|event| {
                event
                    .session_id
                    .as_ref()
                    .map(|id| (id.clone(), event.payload.clone(), event.at))
            })
            .collect();
        attention.extend(observations.iter().filter(|event|event.kind=="session.closed").filter_map(|event|event.session_id.as_ref().map(|id|(id.clone(),serde_json::json!({"priority":1,"reason":"session_closed","blockedChildren":0}),event.at))));
        let exits: Vec<_> = observations
            .iter()
            .filter(|observation| observation.kind == "process.exited")
            .filter_map(|observation| {
                observation
                    .session_id
                    .as_ref()
                    .map(|id| (id.clone(), observation.at))
            })
            .collect();
        let transaction = self.0.transaction()?;
        let mut head = append_transaction(&transaction, observations)?;
        for (id, payload, at) in attention {
            crate::workflow_wake_events::canonical(&transaction, &id, &payload, at)?;
        }
        for (session, now) in &exits {
            crate::workflow_controls::observe_exit(&transaction, session, *now)?;
        }
        if !exits.is_empty() {
            head = u64::try_from(transaction.query_row(
                "SELECT head FROM domain_event_cursor WHERE id=1",
                [],
                |row| row.get::<_, i64>(0),
            )?)?;
        }
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
    QuotaWakes {
        work: crate::quota_wakes::Work,
        reply: oneshot::Sender<Result<crate::quota_wakes::Reply>>,
    },
    ExternalTrigger {
        inbound: crate::job_triggers::Inbound,
        reply: oneshot::Sender<Result<crate::job_triggers::Acceptance>>,
    },
    Jobs {
        work: crate::job_definitions::Work,
        reply: oneshot::Sender<Result<crate::job_definitions::Reply>>,
    },
    Wakes {
        work: crate::workflow_wakes::Work,
        reply: oneshot::Sender<Result<crate::workflow_wakes::Reply>>,
    },
    Executor {
        work: crate::workflow_executor::Work,
        reply: oneshot::Sender<Result<crate::workflow_executor::Reply>>,
    },
    Delivery {
        work: crate::workflow_delivery::Work,
        reply: oneshot::Sender<Result<crate::workflow_delivery::Reply>>,
    },
    Launch {
        work: crate::workflow_launches::Work,
        reply: oneshot::Sender<Result<crate::workflow_launches::Reply>>,
    },
    RunControl {
        work: crate::workflow_controls::Work,
        reply: oneshot::Sender<Result<crate::workflow_controls::Reply>>,
    },
    GuardRunDispatch {
        session_id: String,
        operation_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    Workflow {
        actor: crate::orchestration::Actor,
        request: crate::orchestration::Request,
        reply: oneshot::Sender<Result<Value>>,
    },
    Coordinator {
        work: crate::workflow_coordinator::Work,
        reply: oneshot::Sender<Result<Option<Value>>>,
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
fn reject_admitted(receiver: &mut mpsc::Receiver<Work>) -> Vec<oneshot::Sender<()>> {
    let mut stops = Vec::new();
    while let Some(work) = receiver.blocking_recv() {
        if let Work::Stop(reply) = work {
            stops.push(reply);
        }
    }
    stops
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
    budget: crate::budgets::Shared,
    sender: mpsc::Sender<Work>,
    changed: watch::Receiver<u64>,
    health_changed: watch::Sender<u64>,
    drops: Arc<AtomicU64>,
    failures: Arc<AtomicU64>,
    wait_slots: Arc<tokio::sync::Semaphore>,
}
impl Service {
    pub async fn external_trigger(
        &self,
        inbound: crate::job_triggers::Inbound,
    ) -> Result<crate::job_triggers::Acceptance> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .try_send(Work::ExternalTrigger { inbound, reply })
            .map_err(|_| Error::new("busy", "External trigger journal capacity is unavailable"))?;
        answer.await.map_err(|_| {
            anyhow!("External delivery outcome is unconfirmed; retry the same signed event")
        })?
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }

    pub async fn executor(
        &self,
        work: crate::workflow_executor::Work,
    ) -> Result<crate::workflow_executor::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Executor { work, reply })
            .await
            .map_err(|_| anyhow!("Run executor journal is closed"))?;
        answer.await.map_err(|_| {
            anyhow!(
                "Executor outcome unconfirmed; inspect the original workflow key and current run"
            )
        })?
    }
    pub async fn delivery(
        &self,
        work: crate::workflow_delivery::Work,
    ) -> Result<crate::workflow_delivery::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Delivery { work, reply })
            .await
            .map_err(|_| anyhow!("Task delivery journal is closed"))?;
        answer.await.map_err(|_| {
            anyhow!("Task delivery outcome unconfirmed; inspect the original workflow key")
        })?
    }
    pub async fn launch(
        &self,
        work: crate::workflow_launches::Work,
    ) -> Result<crate::workflow_launches::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Launch { work, reply })
            .await
            .map_err(|_| anyhow!("Workflow launch journal is closed"))?;
        answer.await.map_err(|_| {
            anyhow!(
                "Launch outcome unconfirmed; inspect the original workflow key and native receipt"
            )
        })?
    }
    pub async fn run_control(
        &self,
        work: crate::workflow_controls::Work,
    ) -> Result<crate::workflow_controls::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::RunControl { work, reply })
            .await
            .map_err(|_| anyhow!("Run control journal is closed"))?;
        answer.await.map_err(|_| {
            anyhow!("Run control outcome was not confirmed; recover the original key")
        })?
    }
    pub async fn wakes(
        &self,
        work: crate::workflow_wakes::Work,
    ) -> Result<crate::workflow_wakes::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Wakes { work, reply })
            .await
            .map_err(|_| anyhow!("Wake store is closed"))?;
        answer.await.map_err(|_| {
            anyhow!("Wake outcome was not confirmed; recover the original workflow key")
        })?
    }
    pub async fn quota_wakes(
        &self,
        work: crate::quota_wakes::Work,
    ) -> Result<crate::quota_wakes::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::QuotaWakes { work, reply })
            .await
            .map_err(|_| anyhow!("Quota wake journal is closed"))?;
        answer.await.map_err(|_| {
            anyhow!("Quota wake outcome is unconfirmed; inspect its original receipt")
        })?
    }
    pub async fn guard_run_dispatch(&self, session_id: &str, operation_id: &str) -> Result<()> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::GuardRunDispatch {
                session_id: session_id.into(),
                operation_id: operation_id.into(),
                reply,
            })
            .await
            .map_err(|_| anyhow!("Workflow store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Run dispatch guard was not confirmed"))?
    }
    pub fn budget(&self) -> crate::budgets::Shared {
        self.budget.clone()
    }
    pub async fn coordinator(
        &self,
        work: crate::workflow_coordinator::Work,
    ) -> Result<Option<Value>> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Coordinator { work, reply })
            .await
            .map_err(|_| anyhow!("Workflow store is closed"))?;
        answer.await.map_err(|_| {
            anyhow!(
                "Coordinator recovery outcome was not confirmed; recover the original workflow key"
            )
        })?
    }
    pub async fn workflow(
        &self,
        actor: crate::orchestration::Actor,
        mut request: crate::orchestration::Request,
    ) -> Result<Value> {
        if matches!(actor.scope, crate::orchestration::Scope::Owner)
            && let crate::orchestration::Request::Jobs { request } = &mut request
            && let crate::job_definitions::Request::Create { spec, .. }
            | crate::job_definitions::Request::Update { spec, .. } = request.as_mut()
            && !matches!(
                spec.schedule,
                crate::job_calendar::Schedule::Once { .. }
                    | crate::job_calendar::Schedule::External
            )
        {
            // Keep computation off the SQLite worker. Even a failed evaluation
            // is carried through to the domain: immutable key replay must be
            // checked before fresh live-clock validation or helper errors.
            spec.calendar = Some(
                crate::job_calendar_adapter::next(
                    spec.schedule.clone(),
                    crate::status::now_millis(),
                )
                .await,
            );
        }
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
    pub async fn jobs(
        &self,
        work: crate::job_definitions::Work,
    ) -> Result<crate::job_definitions::Reply> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Work::Jobs { work, reply })
            .await
            .map_err(|_| anyhow!("Job store is closed"))?;
        answer
            .await
            .map_err(|_| anyhow!("Job outcome is unconfirmed; inspect the original occurrence"))?
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
    #[cfg(test)]
    pub async fn open(path: PathBuf) -> Result<Self> {
        Self::open_inner(path, None).await
    }
    pub async fn open_with_owner(
        path: PathBuf,
        owner: Arc<crate::host_lock::HostLock>,
    ) -> Result<Self> {
        Self::open_inner(path, Some(owner)).await
    }
    async fn open_inner(
        path: PathBuf,
        owner: Option<Arc<crate::host_lock::HostLock>>,
    ) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<Work>(128);
        let (changed_tx, changed) = watch::channel(0);
        let health_changed = changed_tx.clone();
        let (ready_tx, ready_rx) = oneshot::channel();
        let drops = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let worker_failures = failures.clone();
        let budget = crate::budgets::defaults();
        let worker_budget = budget.clone();
        std::thread::Builder::new()
            .name("nesvo-events".into())
            .spawn(move || {
                // Keep directory ownership while the writer drains, including
                // error/cancellation paths after the async host future ends.
                let _owner_guard = owner;
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
                if let Err(error) = crate::budgets::publish(&store.0, &worker_budget) {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
                changed_tx.send_replace(head);
                let _ = ready_tx.send(Ok(()));
                while let Some(work) = receiver.blocking_recv() {
                    match work {
                        Work::QuotaWakes { work, reply } => {
                            let result = crate::quota_wakes::handle(&mut store.0, work);
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Wakes { work, reply } => {
                            let result = crate::workflow_wakes::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Executor { work, reply } => {
                            let result = crate::workflow_executor::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Delivery { work, reply } => {
                            let result = crate::workflow_delivery::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Launch { work, reply } => {
                            let result = crate::workflow_launches::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::RunControl { work, reply } => {
                            let result = crate::workflow_controls::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::GuardRunDispatch {
                            session_id,
                            operation_id,
                            reply,
                        } => {
                            let result = crate::workflow_budget::guard_dispatch(
                                &mut store.0,
                                &session_id,
                                crate::status::now_millis(),
                            )
                            .and_then(|_| {
                                crate::workflow_context::guard_native(
                                    &store.0,
                                    &session_id,
                                    &operation_id,
                                )
                            })
                            .and_then(|_| {
                                crate::workflow_wake_batches::guard_dispatch(
                                    &store.0,
                                    &session_id,
                                    &operation_id,
                                    crate::status::now_millis(),
                                )
                            })
                            .and_then(|_| {
                                crate::quota_wakes::guard_dispatch(
                                    &store.0,
                                    &session_id,
                                    &operation_id,
                                )
                                .map(|_| ())
                            });
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Coordinator { work, reply } => {
                            let result = crate::workflow_coordinator::execute(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Jobs { work, reply } => {
                            let result = crate::job_definitions::work_at(
                                &mut store.0,
                                work,
                                crate::status::now_millis(),
                                monotonic_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::ExternalTrigger { inbound, reply } => {
                            let result = crate::job_triggers::ingest(
                                &mut store.0,
                                inbound,
                                crate::status::now_millis(),
                            );
                            record_storage_failure(&result, &worker_failures, &changed_tx);
                            notify_head(&store, &changed_tx);
                            let _ = reply.send(result);
                        }
                        Work::Workflow {
                            actor,
                            request,
                            reply,
                        } => {
                            let budget_request =
                                matches!(actor.scope, crate::orchestration::Scope::Owner)
                                    && matches!(
                                        request,
                                        crate::orchestration::Request::HostBudget { .. }
                                    );
                            let result =
                                crate::orchestration::execute(&mut store.0, actor, request);
                            // Also invalidate the projection when an authorized
                            // read detects unavailable/corrupt policy storage.
                            let result = if budget_request {
                                crate::budgets::publish(&store.0, &worker_budget).and(result)
                            } else {
                                result
                            };
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
                            let result = crate::workflow_context::accept_native(
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
                            receiver.close();
                            drop(store);
                            let mut stops = reject_admitted(&mut receiver);
                            stops.push(reply);
                            for stop in stops {
                                let _ = stop.send(());
                            }
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
            budget,
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
    pub fn observe_confirmed(&self, event: Observation) -> Option<oneshot::Receiver<Result<u64>>> {
        let (reply, answer) = oneshot::channel();
        if self
            .sender
            .try_send(Work::Append(vec![event], Some(reply)))
            .is_err()
        {
            self.drops.fetch_add(1, Ordering::Relaxed);
            self.health_changed.send_modify(|_| {});
            None
        } else {
            Some(answer)
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

    struct StartupDatabase {
        directory: PathBuf,
        path: PathBuf,
    }
    impl StartupDatabase {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "nesvo-startup-schema-{}",
                hex::encode(crate::wire::random::<16>())
            ));
            std::fs::create_dir(&directory).unwrap();
            let directory = directory.canonicalize().unwrap();
            Self {
                path: directory.join("metadata.sqlite3"),
                directory,
            }
        }
    }
    impl Drop for StartupDatabase {
        fn drop(&mut self) {
            if std::env::temp_dir().canonicalize().is_ok_and(|temporary| {
                self.directory.parent() == Some(temporary.as_path())
                    && self
                        .directory
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("nesvo-startup-schema-"))
            }) {
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
    }
    fn startup_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut query = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        query
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }
    fn startup_has_table(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                [name],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn startup_schema_batch_fresh_and_warm_preserve_metadata_and_recover_receipt_once() {
        let fixture = StartupDatabase::new();
        let retained_spec = "{  \"name\": \"retained specification\"  }";
        let (host_id, group_id, receipt_id, receipt_identity, original_head) = {
            let mut metadata = crate::storage::MetadataStore::open(&fixture.path).unwrap();
            let group = metadata.create("Retained group", None, 0, 0).unwrap();
            let mut store = Store::open(&fixture.path).unwrap();
            assert_eq!(store.cursors().unwrap(), (0, 0));
            assert!(startup_has_table(&store.0, "harness_job_quota_sources"));
            assert!(startup_has_table(
                &store.0,
                "harness_job_launch_resolutions"
            ));
            assert_eq!(
                store
                    .0
                    .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "wal"
            );
            assert_eq!(
                store
                    .0
                    .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                store
                    .0
                    .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            metadata
                .connection
                .execute(
                    "INSERT INTO templates VALUES('retained-template','Retained',?1)",
                    [retained_spec],
                )
                .unwrap();
            metadata
                .connection
                .execute(
                    "INSERT INTO recovery VALUES('legacy-recovery',?1,'starting')",
                    [retained_spec],
                )
                .unwrap();
            metadata
                .connection
                .execute(
                    "INSERT INTO schedules VALUES('legacy-schedule',1,?1,'starting',NULL)",
                    [retained_spec],
                )
                .unwrap();
            let accepted = crate::receipts::accept(
                &mut store.0,
                "owner",
                "retained-startup-key",
                "send",
                json!({"sessionId":"retained-session","prompt":"controlled fixture"}),
            )
            .unwrap();
            crate::receipts::claim(&mut store.0, &accepted.receipt.id, "owner")
                .unwrap()
                .unwrap();
            let identity: String = store.0.query_row(
                "SELECT json_array(issuer,key,digest,operation,session_id) FROM operation_receipts WHERE id=?1",
                [&accepted.receipt.id], |row| row.get(0),
            ).unwrap();
            (
                metadata.host_id.clone(),
                group,
                accepted.receipt.id,
                identity,
                store.cursors().unwrap().0,
            )
        };
        for _ in 0..2 {
            let metadata = crate::storage::MetadataStore::open(&fixture.path).unwrap();
            assert_eq!(metadata.host_id, host_id);
            assert_eq!(metadata.revision(), 1);
            assert_eq!(metadata.groups().len(), 1);
            assert_eq!(metadata.groups()[0].id, group_id);
            assert_eq!(
                metadata
                    .connection
                    .query_row(
                        "SELECT spec FROM templates WHERE id='retained-template'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                retained_spec
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row(
                        "SELECT state FROM recovery WHERE id='legacy-recovery'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "interrupted"
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row(
                        "SELECT state FROM schedules WHERE id='legacy-schedule'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "interrupted"
            );
            let mut store = Store::open(&fixture.path).unwrap();
            let actual: (String, Option<String>, String, String) = store.0.query_row(
                "SELECT phase,claim_token,result,json_array(issuer,key,digest,operation,session_id) FROM operation_receipts WHERE id=?1",
                [&receipt_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).unwrap();
            assert_eq!(actual.0, "unknown");
            assert!(actual.1.is_none());
            assert_eq!(
                serde_json::from_str::<Value>(&actual.2).unwrap()["code"],
                "host_restart"
            );
            assert_eq!(actual.3, receipt_identity);
            assert_eq!(store.cursors().unwrap(), (original_head + 1, 0));
            assert!(
                crate::receipts::claim(&mut store.0, &receipt_id, "owner")
                    .unwrap()
                    .is_none()
            );
            assert!(store.0.is_autocommit());
        }
    }

    #[test]
    fn startup_schema_batch_migrates_published_shapes_without_minting_dispatch_authority() {
        let fixture = StartupDatabase::new();
        let spec = "{  \"published\": true  }";
        let accepted = "{  \"accepted\": true  }";
        let host_id = {
            let metadata = crate::storage::MetadataStore::open(&fixture.path).unwrap();
            metadata.connection.execute_batch("CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,coordinator_id TEXT,revision INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
                CREATE TABLE workflow_launches(attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),operation_key TEXT NOT NULL,workspace TEXT NOT NULL,created_at INTEGER NOT NULL);
                CREATE TABLE workflow_native_context(operation_id TEXT PRIMARY KEY REFERENCES operation_receipts(id),run_id TEXT NOT NULL REFERENCES workflow_runs(id),revision INTEGER NOT NULL,admitted INTEGER NOT NULL);
                CREATE TABLE harness_jobs(id TEXT PRIMARY KEY,spec TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,next_due INTEGER,created_at INTEGER NOT NULL);
                CREATE TABLE harness_job_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES harness_jobs(id),job_revision INTEGER NOT NULL,spec TEXT NOT NULL,trigger_key TEXT NOT NULL,trigger_kind TEXT NOT NULL,due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,run_id TEXT REFERENCES workflow_runs(id),started_at INTEGER,finished_at INTEGER,UNIQUE(job_id,trigger_key));
                CREATE TABLE harness_job_attempts(id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),ordinal INTEGER NOT NULL,run_id TEXT UNIQUE REFERENCES workflow_runs(id),created_at INTEGER NOT NULL,claimed_at INTEGER,finished_at INTEGER,state TEXT NOT NULL,reason TEXT,UNIQUE(occurrence_id,ordinal));
                CREATE TABLE harness_job_mutations(issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));
                INSERT INTO workflow_runs VALUES('published-run','Retained','Retained',NULL,7,'completed',10);").unwrap();
            metadata
                .connection
                .execute(
                    "INSERT INTO harness_jobs VALUES('published-job',?1,7,0,NULL,10)",
                    [spec],
                )
                .unwrap();
            metadata.connection.execute("INSERT INTO harness_job_occurrences VALUES('published-occurrence','published-job',7,?1,'published-trigger','once',10,10,'succeeded','retained occurrence','published-run',11,12)", [spec]).unwrap();
            metadata.connection.execute("INSERT INTO harness_job_attempts VALUES('published-generation','published-occurrence',1,'published-run',10,11,12,'succeeded','retained generation')", []).unwrap();
            metadata.connection.execute("INSERT INTO harness_job_mutations VALUES('owner','published-key','published-digest',?1)", [accepted]).unwrap();
            metadata.host_id
        };
        for _ in 0..2 {
            let store = Store::open(&fixture.path).unwrap();
            assert_eq!(store.cursors().unwrap(), (0, 0));
            assert_eq!(
                store
                    .0
                    .query_row(
                        "SELECT public_id FROM host_identity WHERE id=1",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                host_id
            );
            let actual: (String, Option<String>, i64, i64, i64, String, String) = store.0.query_row(
                "SELECT o.current_job_attempt_id,a.dispatch_token,a.created_at,a.claimed_at,a.finished_at,a.state,a.reason FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id WHERE o.id='published-occurrence'",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
            ).unwrap();
            assert_eq!(
                actual,
                (
                    "published-generation".into(),
                    None,
                    10,
                    11,
                    12,
                    "succeeded".into(),
                    "retained generation".into()
                )
            );
            assert_eq!(
                store
                    .0
                    .query_row(
                        "SELECT spec FROM harness_jobs WHERE id='published-job'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                spec
            );
            assert_eq!(
                store
                    .0
                    .query_row(
                        "SELECT spec FROM harness_job_occurrences WHERE id='published-occurrence'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                spec
            );
            assert_eq!(
                store
                    .0
                    .query_row(
                        "SELECT view FROM harness_job_mutations WHERE key='published-key'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                accepted
            );
            assert_eq!(
                store
                    .0
                    .query_row("SELECT count(*) FROM harness_job_attempts", [], |row| row
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                1
            );
            assert_eq!(
                store
                    .0
                    .query_row("SELECT count(*) FROM operation_receipts", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                store
                    .0
                    .query_row(
                        "SELECT count(*) FROM harness_job_launch_resolutions",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            for (table, column) in [
                ("workflow_launches", "profile"),
                ("workflow_launches", "prepared_spec"),
                ("workflow_launches", "quota_hold_reason"),
                ("workflow_native_context", "coordinator_generation"),
                ("harness_jobs", "calendar_error"),
                ("harness_job_occurrences", "coalesced_from"),
                ("harness_job_cancellations", "precheck_attempt_id"),
            ] {
                assert!(
                    startup_columns(&store.0, table)
                        .iter()
                        .any(|name| name == column)
                );
            }
            assert!(store.0.is_autocommit());
        }
    }

    #[test]
    fn startup_schema_batch_late_failure_rolls_back_schema_but_not_prior_receipt_recovery() {
        let fixture = StartupDatabase::new();
        let mut metadata = crate::storage::MetadataStore::open(&fixture.path).unwrap();
        let group = metadata
            .create("Retained after failure", None, 0, 0)
            .unwrap();
        metadata.connection.execute_batch("CREATE TABLE domain_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE domain_event_cursor(id INTEGER PRIMARY KEY CHECK(id=1),head INTEGER NOT NULL,floor INTEGER NOT NULL);
            INSERT INTO domain_event_cursor VALUES(1,0,0);
            CREATE TABLE workflow_launches(attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),operation_key TEXT NOT NULL,workspace TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE harness_job_quota_sources(source_id TEXT PRIMARY KEY);
            INSERT INTO harness_job_quota_sources VALUES('retained incompatible row');").unwrap();
        crate::receipts::initialize(&mut metadata.connection).unwrap();
        let accepted = crate::receipts::accept(
            &mut metadata.connection,
            "owner",
            "pre-schema-recovery",
            "send",
            json!({"sessionId":"retained-session","prompt":"controlled fixture"}),
        )
        .unwrap();
        let before: i64 = metadata
            .connection
            .query_row(
                "SELECT head FROM domain_event_cursor WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let original_columns = startup_columns(&metadata.connection, "workflow_launches");
        for _ in 0..2 {
            // Missing context/account columns fail a real late schema index;
            // no test-only SQL hook or altered production sequence is used.
            assert!(Store::open(&fixture.path).is_err());
            assert_eq!(
                startup_columns(&metadata.connection, "workflow_launches"),
                original_columns
            );
            for table in [
                "workflow_runs",
                "workflow_tasks",
                "harness_jobs",
                "harness_job_attempts",
                "host_budget",
            ] {
                assert!(!startup_has_table(&metadata.connection, table));
            }
            assert_eq!(
                metadata
                    .connection
                    .query_row(
                        "SELECT source_id FROM harness_job_quota_sources",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "retained incompatible row"
            );
            let receipt: (String, Option<String>, String) = metadata
                .connection
                .query_row(
                    "SELECT phase,claim_token,result FROM operation_receipts WHERE id=?1",
                    [&accepted.receipt.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(receipt.0, "unknown");
            assert!(receipt.1.is_none());
            assert_eq!(
                serde_json::from_str::<Value>(&receipt.2).unwrap()["code"],
                "host_restart"
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row(
                        "SELECT head FROM domain_event_cursor WHERE id=1",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                before + 1
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row("SELECT revision FROM metadata WHERE id=1", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row("SELECT name FROM groups WHERE id=?1", [&group], |row| {
                        row.get::<_, String>(0)
                    })
                    .unwrap(),
                "Retained after failure"
            );
            assert_eq!(
                metadata
                    .connection
                    .query_row("SELECT count(*) FROM quota_wake_arms", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(metadata.connection.is_autocommit());
        }
    }

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
            budget: crate::budgets::defaults(),
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
    async fn poll_until(deadline: Duration, ready: impl Fn() -> bool) {
        let expires = tokio::time::Instant::now() + deadline;
        while !ready() {
            assert!(
                tokio::time::Instant::now() < expires,
                "condition not reached within {deadline:?}"
            );
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
    #[tokio::test]
    async fn request_admitted_before_stop_is_rejected_instead_of_stranded() {
        let database = StartupDatabase::new();
        let service = Service::open(database.path.clone()).await.unwrap();
        let admitted = service.sender.clone().reserve_owned().await.unwrap();
        let stopping = tokio::spawn({
            let service = service.clone();
            async move { service.shutdown().await }
        });
        poll_until(Duration::from_secs(5), || service.sender.is_closed()).await;
        let (reply, answer) = oneshot::channel();
        admitted.send(Work::Read {
            after: 0,
            limit: 1,
            session_id: None,
            reply,
        });
        let answered = tokio::time::timeout(Duration::from_secs(5), answer)
            .await
            .expect("a request admitted before Stop must not be stranded in the closed journal");
        assert!(answered.is_err());
        tokio::time::timeout(Duration::from_secs(5), stopping)
            .await
            .expect("Stop must finish once admitted requests are rejected")
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), service.read(0, 1, None))
            .await
            .expect("requests after Stop must fail without waiting");
        assert!(closed.is_err());
    }
}
