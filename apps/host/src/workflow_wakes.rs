use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor},
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
type PolicyRow = (
    String,
    String,
    String,
    bool,
    i64,
    String,
    Option<String>,
    i64,
    String,
    bool,
);
type BatchSummaryRow = (
    String,
    String,
    Option<String>,
    i64,
    Option<String>,
    i64,
    String,
);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Delta,
    Full,
}
impl Delivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delta => "delta",
            Self::Full => "full",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Enable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Disable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Pause {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Resume {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    SetDelivery {
        key: String,
        run_id: String,
        expected_revision: u64,
        delivery: Delivery,
    },
    Get {
        run_id: String,
        after: Option<u64>,
    },
    Batch {
        run_id: String,
        batch_id: String,
    },
}
#[derive(Clone)]
pub struct Guard {
    pub id: String,
    pub generation: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub id: String,
    pub run_id: String,
    pub coordinator: String,
    pub issuer: String,
    pub enabled: bool,
    pub generation: u64,
    pub phase: String,
    pub reason: Option<String>,
    pub created_at: u64,
    pub delivery: String,
    pub held: bool,
}
pub struct Snapshot {
    pub policy: Policy,
    pub pending: usize,
    pub first_at: Option<u64>,
    pub active_batch: bool,
    pub run_state: String,
    pub time_exhausted: bool,
}
pub struct Dispatch {
    pub receipt: crate::receipts::Receipt,
    pub prompt: String,
    pub batch_id: String,
}
pub enum Work {
    Manage {
        actor: Actor,
        request: Request,
    },
    Poll {
        guard: Guard,
        issuer: String,
    },
    Claim {
        guard: Guard,
        issuer: String,
    },
    Note {
        guard: Guard,
        issuer: String,
        phase: &'static str,
        reason: Option<String>,
        disable: bool,
    },
    Finish {
        batch_id: String,
    },
}
pub enum Reply {
    Managed { view: Value, pump: Option<Guard> },
    Snapshot(Option<Box<Snapshot>>),
    Claimed(Option<Dispatch>),
    Done,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_wake_policies(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),coordinator_id TEXT NOT NULL,issuer TEXT NOT NULL,enabled INTEGER NOT NULL,generation INTEGER NOT NULL,phase TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_wake_signals(attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),data TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_wake_batches(id TEXT PRIMARY KEY,policy_id TEXT NOT NULL REFERENCES workflow_wake_policies(id),generation INTEGER NOT NULL,issuer TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),phase TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_wake_notices(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(id),source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,data TEXT NOT NULL,batch_id TEXT REFERENCES workflow_wake_batches(id),created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_wake_pending ON workflow_wake_notices(run_id,batch_id,sequence);")?;
    Ok(())
}
pub fn read(connection: &Connection, run: &str) -> Result<Option<Policy>> {
    let row:Option<PolicyRow>=connection.query_row("SELECT id,coordinator_id,issuer,enabled,generation,phase,reason,created_at,delivery,held FROM workflow_wake_policies WHERE run_id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?;
    row.map(
        |(id, coordinator, issuer, enabled, generation, phase, reason, at, delivery, held)| {
            Ok(Policy {
                id,
                run_id: run.into(),
                coordinator,
                issuer,
                enabled,
                generation: u64::try_from(generation)?,
                phase,
                reason,
                created_at: u64::try_from(at)?,
                delivery,
                held,
            })
        },
    )
    .transpose()
}
fn batches(connection: &Connection, run: &str) -> Result<Vec<Value>> {
    let mut query = connection.prepare("SELECT b.id,b.phase,b.reason,b.created_at,b.delivery,(SELECT count(*) FROM workflow_wake_notices n WHERE n.batch_id=b.id),o.phase FROM workflow_wake_batches b JOIN workflow_wake_policies p ON p.id=b.policy_id JOIN operation_receipts o ON o.id=b.operation_id WHERE p.run_id=?1 ORDER BY b.rowid DESC LIMIT 8")?;
    let rows = query
        .query_map([run], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<BatchSummaryRow>>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, phase, reason, at, delivery, notices, native)| {
            json!({"id":id,"phase":phase,"reason":reason,"createdAt":at,"delivery":delivery.unwrap_or_else(|| "delta".into()),"noticeCount":notices,"native":{"phase":native}})
        })
        .collect())
}
pub fn delivered_through(connection: &Connection, run: &str) -> Result<u64> {
    let sequence: i64 = connection.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM workflow_wake_notices WHERE run_id=?1 AND batch_id IS NOT NULL",
        [run],
        |row| row.get(0),
    )?;
    Ok(u64::try_from(sequence)?)
}
pub fn guard(connection: &Connection, expected: &Guard, issuer: &str) -> Result<Policy> {
    let run:Option<String>=connection.query_row("SELECT run_id FROM workflow_wake_policies WHERE id=?1 AND generation=?2 AND issuer=?3 AND enabled=1 AND held=0",params![expected.id,expected.generation as i64,issuer],|row|row.get(0)).optional()?;
    let run = run.ok_or_else(|| {
        Error::new(
            "wake_paused",
            "Wake policy is disabled or superseded; no new input is admitted",
        )
    })?;
    read(connection, &run)?.ok_or_else(|| anyhow!("Wake policy disappeared"))
}
pub fn changed(transaction: &Transaction<'_>, policy: &str, now: u64) -> Result<u64> {
    let (run, coordinator): (String, String) = transaction.query_row(
        "SELECT run_id,coordinator_id FROM workflow_wake_policies WHERE id=?1",
        [policy],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [&run],
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: Some(coordinator),
            at: now,
            event: DomainEvent::RunWakeChanged(model::RunWake {
                run_id: run,
                policy_id: policy.into(),
            }),
        }],
    )
}
pub fn run_guard(connection: &Connection, run: &str, now: u64) -> Result<()> {
    crate::job_attempts::guard_run(connection, run)?;
    crate::workflow_context::guard(connection, run)?;
    let state: String = connection.query_row(
        "SELECT state FROM workflow_runs WHERE id=?1",
        [run],
        |row| row.get(0),
    )?;
    if !matches!(state.as_str(), "active" | "draining") {
        return Err(Error::new(
            "run_state_conflict",
            "Run must be active or draining before coordinator input",
        )
        .into());
    }
    let budget = crate::workflow_budget::snapshot(connection, run, &state)?;
    if budget["timeState"] == "exhausted"
        || budget["deadlineAt"]
            .as_u64()
            .is_some_and(|deadline| now >= deadline)
    {
        return Err(Error::new(
            "time_budget_exhausted",
            "Run elapsed budget blocks coordinator input",
        )
        .into());
    }
    Ok(())
}
fn view(connection: &Connection, actor: &Actor, run: &str, after: u64) -> Result<Value> {
    let run_view = orchestration::run(connection, actor, run)?;
    let (notices, next, more) = crate::workflow_wake_events::page(connection, run, after)?;
    let pending: i64 = connection.query_row(
        "SELECT count(*) FROM workflow_wake_notices WHERE run_id=?1 AND batch_id IS NULL",
        [run],
        |row| row.get(0),
    )?;
    Ok(
        json!({"run":run_view,"wakePolicy":read(connection,run)?,"notices":notices,"pendingCount":pending,"nextCursor":next,"more":more,"deliveredThrough":delivered_through(connection,run)?,"batches":batches(connection,run)?}),
    )
}

fn manage(connection: &mut Connection, actor: Actor, request: Request, now: u64) -> Result<Reply> {
    if let Some(reply) = inspect(connection, &actor, &request)? {
        return Ok(reply);
    }
    let (key, run, revision) = target(&request)?;
    owner_controls(&actor, &request)?;
    orchestration::validate_key(key)?;
    orchestration::run(connection, &actor, run)?;
    crate::workflow_budget::refresh(connection, run, now)?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"wakes","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, run)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, key, &digest)? {
        return Ok(Reply::Managed { view, pump: None });
    }
    orchestration::mutation_capacity(&transaction)?;
    if current["revision"] != revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect before changing coordinator wakes",
        )
        .into());
    }
    let previous = read(&transaction, run)?;
    let id = apply(&transaction, &actor, &request, run, &current, previous, now)?;
    let delivering = delivers(&request);
    if delivering {
        crate::workflow_wake_events::seed(&transaction, run, now)?;
    }

    let cursor = changed(&transaction, &id, now)?;
    let mut result = view(&transaction, &actor, run, 0)?;
    result["cursor"] = cursor.into();
    let pump = pump_guard(&transaction, run, delivering)?;
    orchestration::remember(&transaction, &actor, key, &digest, &result)?;
    transaction.commit()?;
    Ok(Reply::Managed { view: result, pump })
}
fn inspect(connection: &Connection, actor: &Actor, request: &Request) -> Result<Option<Reply>> {
    match request {
        Request::Get { run_id, after } => Ok(Some(Reply::Managed {
            view: view(connection, actor, run_id, after.unwrap_or(0))?,
            pump: None,
        })),
        Request::Batch { run_id, batch_id } => {
            let run = orchestration::run(connection, actor, run_id)?;
            Ok(Some(Reply::Managed {
                view: json!({"run":run,"wakeBatch":crate::workflow_wake_batches::read(connection,run_id,batch_id)?}),
                pump: None,
            }))
        }
        _ => Ok(None),
    }
}
fn target(request: &Request) -> Result<(&String, &String, u64)> {
    match request {
        Request::Enable {
            key,
            run_id,
            expected_revision,
        }
        | Request::Disable {
            key,
            run_id,
            expected_revision,
        }
        | Request::Pause {
            key,
            run_id,
            expected_revision,
        }
        | Request::Resume {
            key,
            run_id,
            expected_revision,
        }
        | Request::SetDelivery {
            key,
            run_id,
            expected_revision,
            ..
        } => Ok((key, run_id, *expected_revision)),
        _ => Err(anyhow!("Unexpected wake command")),
    }
}
fn owner_controls(actor: &Actor, request: &Request) -> Result<()> {
    if matches!(
        request,
        Request::Pause { .. } | Request::Resume { .. } | Request::SetDelivery { .. }
    ) && !matches!(actor.scope, orchestration::Scope::Owner)
    {
        return Err(Error::new(
            "forbidden",
            "Only the owner may hold, resume or change wake delivery",
        )
        .into());
    }
    Ok(())
}
fn delivers(request: &Request) -> bool {
    matches!(request, Request::Enable { .. } | Request::Resume { .. })
}
fn apply(
    transaction: &Transaction<'_>,
    actor: &Actor,
    request: &Request,
    run: &str,
    current: &Value,
    previous: Option<Policy>,
    now: u64,
) -> Result<String> {
    match request {
        Request::Enable { .. } => enable(transaction, actor, run, current, previous, now),
        Request::Disable { .. } => disable(transaction, actor, previous),
        Request::Pause { .. } => hold(transaction, &existing(previous)?),
        Request::Resume { .. } => resume(transaction, actor, current, &existing(previous)?, now),
        Request::SetDelivery { delivery, .. } => {
            set_delivery(transaction, &existing(previous)?, *delivery)
        }
        _ => Err(anyhow!("Unexpected wake command")),
    }
}
fn existing(previous: Option<Policy>) -> Result<Policy> {
    Ok(previous.ok_or_else(|| Error::new("wake_not_found", "Run has no wake policy"))?)
}
fn enable(
    transaction: &Transaction<'_>,
    actor: &Actor,
    run: &str,
    current: &Value,
    previous: Option<Policy>,
    now: u64,
) -> Result<String> {
    run_guard(transaction, run, now)?;
    let coordinator = current["coordinatorSessionId"].as_str().ok_or_else(|| {
        Error::new(
            "coordinator_required",
            "Bind a live native coordinator before enabling model wakes",
        )
    })?;
    enabled_capacity(transaction)?;
    let Some(previous) = previous else {
        return create(transaction, actor, run, coordinator, now);
    };
    if previous.held && !matches!(actor.scope, orchestration::Scope::Owner) {
        return Err(Error::new(
            "wake_policy_held",
            "The owner held this wake policy; only the owner can release it",
        )
        .into());
    }
    if previous.enabled {
        return Err(Error::new(
            "wake_state_conflict",
            "Wake policy is already enabled; inspect it",
        )
        .into());
    }
    if previous.coordinator != coordinator {
        return Err(Error::new(
            "scope_revoked",
            "Coordinator adoption needs explicit recovery",
        )
        .into());
    }
    transaction.execute("UPDATE workflow_wake_policies SET issuer=?2,enabled=1,held=0,generation=generation+1,phase='enabled',reason=NULL WHERE id=?1",params![previous.id,actor.issuer])?;
    Ok(previous.id)
}
fn create(
    transaction: &Transaction<'_>,
    actor: &Actor,
    run: &str,
    coordinator: &str,
    now: u64,
) -> Result<String> {
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_wake_policies", [], |row| {
            row.get(0)
        })?;
    if count >= 1024 {
        return Err(Error::new(
            "busy",
            "Wake policy retention is full; no history was discarded",
        )
        .into());
    }
    let id = hex::encode(crate::wire::random::<16>());
    transaction.execute("INSERT INTO workflow_wake_policies(id,run_id,coordinator_id,issuer,enabled,generation,phase,created_at) VALUES(?1,?2,?3,?4,1,1,'enabled',?5)",params![id,run,coordinator,actor.issuer,now as i64])?;
    Ok(id)
}
fn disable(
    transaction: &Transaction<'_>,
    actor: &Actor,
    previous: Option<Policy>,
) -> Result<String> {
    let previous = existing(previous)?;
    if previous.held && !matches!(actor.scope, orchestration::Scope::Owner) {
        return Err(Error::new(
            "wake_policy_held",
            "The owner held this wake policy; only the owner can disable or release it",
        )
        .into());
    }
    transaction.execute("UPDATE workflow_wake_policies SET enabled=0,held=0,generation=generation+1,phase='disabled',reason='user_disabled' WHERE id=?1",[&previous.id])?;
    Ok(previous.id)
}
fn enabled_capacity(connection: &Connection) -> Result<()> {
    let active: i64 = connection.query_row(
        "SELECT count(*) FROM workflow_wake_policies WHERE enabled=1",
        [],
        |row| row.get(0),
    )?;
    if active >= 16 {
        return Err(Error::new("busy", "At most 16 wake policies may be enabled").into());
    }
    Ok(())
}
fn hold(transaction: &Transaction<'_>, previous: &Policy) -> Result<String> {
    if !previous.enabled || previous.held {
        return Err(Error::new(
            "wake_state_conflict",
            "Only enabled, delivering wakes can be held; inspect the policy",
        )
        .into());
    }
    transaction.execute("UPDATE workflow_wake_policies SET held=1,generation=generation+1,phase='held',reason='owner_held' WHERE id=?1",[&previous.id])?;
    Ok(previous.id.clone())
}
fn resume(
    transaction: &Transaction<'_>,
    actor: &Actor,
    current: &Value,
    previous: &Policy,
    now: u64,
) -> Result<String> {
    if !previous.held {
        return Err(Error::new(
            "wake_state_conflict",
            "Only held wakes can resume; enable a paused or disabled policy instead",
        )
        .into());
    }
    run_guard(transaction, &previous.run_id, now)?;
    if current["coordinatorSessionId"].as_str() != Some(previous.coordinator.as_str()) {
        return Err(Error::new(
            "scope_revoked",
            "Coordinator adoption needs explicit recovery",
        )
        .into());
    }
    if !previous.enabled {
        enabled_capacity(transaction)?;
    }
    transaction.execute("UPDATE workflow_wake_policies SET issuer=?2,enabled=1,held=0,generation=generation+1,phase='enabled',reason=NULL WHERE id=?1",params![previous.id,actor.issuer])?;
    Ok(previous.id.clone())
}
fn set_delivery(
    transaction: &Transaction<'_>,
    previous: &Policy,
    delivery: Delivery,
) -> Result<String> {
    if previous.delivery == delivery.as_str() {
        return Err(Error::new(
            "wake_state_conflict",
            "Wake delivery already uses this mode",
        )
        .into());
    }
    transaction.execute(
        "UPDATE workflow_wake_policies SET delivery=?2 WHERE id=?1",
        params![previous.id, delivery.as_str()],
    )?;
    Ok(previous.id.clone())
}
fn pump_guard(transaction: &Transaction<'_>, run: &str, delivering: bool) -> Result<Option<Guard>> {
    let policy = read(transaction, run)?.ok_or_else(|| anyhow!("Missing wake policy"))?;
    Ok(delivering.then_some(Guard {
        id: policy.id,
        generation: policy.generation,
    }))
}
pub fn recover(connection: &mut Connection) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows = {
        let mut query =
            transaction.prepare("SELECT id FROM workflow_wake_policies WHERE enabled=1")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in rows {
        transaction.execute("UPDATE workflow_wake_policies SET enabled=0,generation=generation+1,phase=CASE WHEN held=1 THEN 'held' ELSE 'paused' END,reason=CASE WHEN held=1 THEN 'owner_held' ELSE 'host_restart' END WHERE id=?1",[&id])?;
        changed(&transaction, &id, crate::status::now_millis())?;
    }
    transaction.execute("UPDATE workflow_wake_batches SET phase=CASE WHEN (SELECT phase FROM operation_receipts WHERE id=operation_id) IN ('settled','failed','interrupted') THEN (SELECT phase FROM operation_receipts WHERE id=operation_id) ELSE 'unknown' END,reason='host_restart' WHERE phase='dispatching'",[])?;
    transaction.commit()?;
    Ok(())
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::Manage { actor, request } => manage(connection, actor, request, now),
        Work::Claim { guard, issuer } => {
            crate::workflow_wake_batches::claim(connection, guard, issuer, now)
        }
        Work::Finish { batch_id } => {
            crate::workflow_wake_batches::finish(connection, &batch_id, now)?;
            Ok(Reply::Done)
        }
        Work::Poll {
            guard: expected,
            issuer,
        } => {
            let policy = match guard(connection, &expected, &issuer) {
                Ok(policy) => policy,
                Err(error)
                    if error
                        .downcast_ref::<Error>()
                        .is_some_and(|e| e.code == "wake_paused") =>
                {
                    return Ok(Reply::Snapshot(None));
                }
                Err(error) => return Err(error),
            };
            crate::workflow_budget::refresh(connection, &policy.run_id, now)?;
            let active_batch = crate::workflow_wake_batches::reconcile(connection, &policy, now)?;
            match guard(connection, &expected, &issuer) {
                Ok(_) => {}
                Err(error)
                    if error
                        .downcast_ref::<Error>()
                        .is_some_and(|e| e.code == "wake_paused") =>
                {
                    return Ok(Reply::Snapshot(None));
                }
                Err(error) => return Err(error),
            }
            let (count,first):(i64,Option<i64>)=connection.query_row("SELECT count(*),MIN(created_at) FROM workflow_wake_notices WHERE run_id=?1 AND batch_id IS NULL",[&policy.run_id],|row|Ok((row.get(0)?,row.get(1)?)))?;
            let run_state: String = connection.query_row(
                "SELECT state FROM workflow_runs WHERE id=?1",
                [&policy.run_id],
                |row| row.get(0),
            )?;
            let budget = crate::workflow_budget::snapshot(connection, &policy.run_id, &run_state)?;
            let time_exhausted = budget["timeState"] == "exhausted"
                || budget["deadlineAt"].as_u64().is_some_and(|at| now >= at);
            Ok(Reply::Snapshot(Some(Box::new(Snapshot {
                policy,
                pending: usize::try_from(count)?,
                first_at: first.map(u64::try_from).transpose()?,
                active_batch,
                run_state,
                time_exhausted,
            }))))
        }
        Work::Note {
            guard: expected,
            issuer,
            phase,
            reason,
            disable,
        } => {
            if !matches!(phase, "waiting" | "paused" | "completed") {
                return Err(anyhow!("Invalid wake phase"));
            }
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let count=transaction.execute("UPDATE workflow_wake_policies SET phase=?4,reason=?5,enabled=NOT ?6,generation=generation+?6 WHERE id=?1 AND generation=?2 AND issuer=?3 AND enabled=1 AND (phase!=?4 OR reason IS NOT ?5 OR ?6)",params![expected.id,expected.generation as i64,issuer,phase,reason,disable])?;
            if count > 0 {
                changed(&transaction, &expected.id, now)?;
            }
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
