//! Opt-in durable DAG scheduling policy. Native effects use existing receipts.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor},
    workflow_launches::Profile,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskProfile {
    pub task_id: String,
    pub profile: Profile,
}
fn retry_delay() -> u64 {
    1000
}
fn readiness_timeout() -> u64 {
    60000
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub tasks: Vec<TaskProfile>,
    #[serde(default)]
    pub retry_failed: bool,
    #[serde(default = "retry_delay")]
    pub retry_delay_ms: u64,
    #[serde(default = "readiness_timeout")]
    pub readiness_timeout_ms: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Start {
        key: String,
        run_id: String,
        expected_revision: u64,
        spec: Spec,
    },
    Get {
        run_id: String,
    },
    Disable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Enable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
}
#[derive(Clone)]
pub struct Guard {
    pub id: String,
    pub generation: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Executor {
    pub id: String,
    pub run_id: String,
    pub spec: Spec,
    pub issuer: String,
    pub enabled: bool,
    pub generation: u64,
    pub phase: String,
    pub reason: Option<String>,
    pub task_id: Option<String>,
    pub created_at: u64,
}
pub struct Snapshot {
    pub executor: Executor,
    pub owned: HashSet<String>,
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
    Retry {
        guard: Guard,
        issuer: String,
        attempt: String,
    },
    Note {
        guard: Guard,
        issuer: String,
        phase: &'static str,
        reason: Option<String>,
        task_id: Option<String>,
        disable: bool,
    },
}
pub enum Reply {
    Managed { view: Value, pump: Option<Guard> },
    Snapshot(Option<Box<Snapshot>>),
    RetryReady(bool),
    Done,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_executors(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),spec TEXT NOT NULL,issuer TEXT NOT NULL,enabled INTEGER NOT NULL,generation INTEGER NOT NULL,phase TEXT NOT NULL,reason TEXT,task_id TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_executor_launches(attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),executor_id TEXT NOT NULL REFERENCES workflow_executors(id),issuer TEXT NOT NULL,workflow_key TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_executor_retries(executor_id TEXT NOT NULL REFERENCES workflow_executors(id),attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),not_before INTEGER NOT NULL,PRIMARY KEY(executor_id,attempt_id));")?;
    Ok(())
}
fn read(connection: &Connection, run: &str) -> Result<Option<Executor>> {
    let mut q=connection.prepare("SELECT id,run_id,spec,issuer,enabled,generation,phase,reason,task_id,created_at FROM workflow_executors WHERE run_id=?1")?;
    let mut rows = q.query([run])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let source: String = row.get(2)?;
    Ok(Some(Executor {
        id: row.get(0)?,
        run_id: row.get(1)?,
        spec: serde_json::from_str(&source)?,
        issuer: row.get(3)?,
        enabled: row.get(4)?,
        generation: u64::try_from(row.get::<_, i64>(5)?)?,
        phase: row.get(6)?,
        reason: row.get(7)?,
        task_id: row.get(8)?,
        created_at: u64::try_from(row.get::<_, i64>(9)?)?,
    }))
}
fn event(transaction: &Transaction<'_>, id: &str, run: &str, now: u64) -> Result<u64> {
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [run],
    )?;
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run],
        |r| r.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            kind: "run.executor_changed",
            at: now,
            payload: json!({"runId":run,"executorId":id}),
        }],
    )
}
/// A job retry retires this generation's pump, not its retained Run evidence.
/// Share the decision transaction so no stale pump can admit between them.
pub(crate) fn pause_for_job_retry(
    transaction: &Transaction<'_>,
    run: &str,
    now: u64,
) -> Result<()> {
    if let Some(executor) = read(transaction, run)?
        && executor.enabled
    {
        transaction.execute("UPDATE workflow_executors SET enabled=0,generation=generation+1,phase='paused',reason='job_retry_waiting',task_id=NULL WHERE id=?1 AND enabled=1", [&executor.id])?;
        event(transaction, &executor.id, run, now)?;
    }
    Ok(())
}
fn capacity(connection: &Connection) -> Result<()> {
    let enabled: i64 = connection.query_row(
        "SELECT count(*) FROM workflow_executors WHERE enabled=1",
        [],
        |r| r.get(0),
    )?;
    if enabled >= 16 {
        return Err(Error::new("busy", "At most 16 run executors may be enabled").into());
    }
    Ok(())
}
fn validate_spec(connection: &Connection, run: &str, spec: &Spec) -> Result<()> {
    if !(1..=64).contains(&spec.tasks.len())
        || serde_json::to_vec(spec)?.len() > 24 * 1024
        || !(1000..=60000).contains(&spec.retry_delay_ms)
        || !(1..=300000).contains(&spec.readiness_timeout_ms)
    {
        return Err(Error::new("invalid_argument","Executor needs 1–64 task profiles within 24 KiB, 1–60 second retry delay and 1–300000 ms readiness timeout").into());
    }
    let mut q = connection.prepare("SELECT id FROM workflow_tasks WHERE run_id=?1")?;
    let mut tasks = q
        .query_map([run], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    for task in &spec.tasks {
        let profile = &task.profile;
        if !tasks.remove(&task.task_id)
            || profile.program == crate::launchers::Program::Shell
            || profile
                .name
                .as_ref()
                .is_some_and(|s| crate::groups::valid_name(s).is_err())
            || profile
                .cwd
                .as_ref()
                .is_some_and(|s| s.len() > 4096 || s.chars().any(char::is_control))
        {
            return Err(Error::new("invalid_argument","Executor profiles must name each host task exactly once, use agents and explicit workspace modes, and contain bounded names/paths").into());
        }
    }
    if !tasks.is_empty() {
        return Err(Error::new(
            "invalid_argument",
            "Executor requires an explicit profile for every task",
        )
        .into());
    }
    Ok(())
}
pub fn guard(connection: &Connection, guard: &Guard, issuer: &str) -> Result<()> {
    let valid:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM workflow_executors WHERE id=?1 AND generation=?2 AND issuer=?3 AND enabled=1)",params![guard.id,guard.generation as i64,issuer],|r|r.get(0))?;
    if !valid {
        return Err(Error::new(
            "executor_paused",
            "Executor admission is disabled or superseded; no new effect was admitted",
        )
        .into());
    }
    Ok(())
}
/// Called only inside the same transaction as native worker reservation.
pub fn record_launch(
    connection: &Connection,
    guard: &Guard,
    issuer: &str,
    key: &str,
    attempt: &str,
) -> Result<()> {
    let run:String=connection.query_row("SELECT t.run_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id=?1",[attempt],|r|r.get(0))?;
    guard_run(connection, guard, issuer, &run)?;
    connection.execute("INSERT INTO workflow_executor_launches(attempt_id,executor_id,issuer,workflow_key,generation) VALUES(?1,?2,?3,?4,?5)",params![attempt,guard.id,issuer,key,guard.generation as i64])?;
    Ok(())
}
pub fn guard_run(connection: &Connection, guard: &Guard, issuer: &str, run: &str) -> Result<()> {
    self::guard(connection, guard, issuer)?;
    let matches: bool = connection.query_row(
        "SELECT run_id=?2 FROM workflow_executors WHERE id=?1",
        params![guard.id, run],
        |r| r.get(0),
    )?;
    if !matches {
        return Err(Error::new(
            "executor_scope_conflict",
            "Executor cannot admit effects into another run",
        )
        .into());
    }
    Ok(())
}
pub fn recover(connection: &mut Connection) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows = {
        let mut q =
            transaction.prepare("SELECT id,run_id FROM workflow_executors WHERE enabled=1")?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, run) in rows {
        transaction.execute("UPDATE workflow_executors SET enabled=0,generation=generation+1,phase='paused',reason='host_restart' WHERE id=?1",[&id])?;
        event(&transaction, &id, &run, crate::status::now_millis())?;
    }
    transaction.commit()?;
    Ok(())
}
fn manage(connection: &mut Connection, actor: Actor, request: Request, now: u64) -> Result<Reply> {
    if let Request::Get { run_id } = &request {
        let run = orchestration::run(connection, &actor, run_id)?;
        return Ok(Reply::Managed {
            view: json!({"run":run,"executor":read(connection,run_id)?}),
            pump: None,
        });
    }
    let (key, run, revision) = match &request {
        Request::Start {
            key,
            run_id,
            expected_revision,
            ..
        }
        | Request::Enable {
            key,
            run_id,
            expected_revision,
        }
        | Request::Disable {
            key,
            run_id,
            expected_revision,
        } => (key, run_id, *expected_revision),
        _ => return Err(anyhow!("Unexpected executor command")),
    };
    orchestration::validate_key(key)?;
    orchestration::run(connection, &actor, run)?;
    crate::workflow_budget::refresh(connection, run, now)?;
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"executor","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, run)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, key, &fingerprint)? {
        return Ok(Reply::Managed { view, pump: None });
    }
    orchestration::mutation_capacity(&transaction)?;
    if current["revision"] != revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect before changing its executor",
        )
        .into());
    }
    let previous = read(&transaction, run)?;
    if !matches!(request, Request::Disable { .. }) {
        crate::job_cancellations::guard_run(&transaction, run)?;
        crate::workflow_context::guard(&transaction, run)?;
    }
    let (id, enabled) = match &request {
        Request::Start { spec, .. } => {
            if previous.is_some() {
                return Err(Error::new(
                    "executor_exists",
                    "This run already has an executor; inspect or explicitly enable it",
                )
                .into());
            }
            if current["state"] != "active" {
                return Err(Error::new(
                    "run_state_conflict",
                    "Activate the immutable run plan before enabling execution",
                )
                .into());
            }
            validate_spec(&transaction, run, spec)?;
            capacity(&transaction)?;
            let retained: i64 =
                transaction
                    .query_row("SELECT count(*) FROM workflow_executors", [], |r| r.get(0))?;
            if retained >= 1024 {
                return Err(Error::new(
                    "busy",
                    "Executor retention is full; no history was discarded",
                )
                .into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            transaction.execute("INSERT INTO workflow_executors(id,run_id,spec,issuer,enabled,generation,phase,created_at) VALUES(?1,?2,?3,?4,1,1,'enabled',?5)",params![id,run,serde_json::to_string(spec)?,actor.issuer,now as i64])?;
            (id, true)
        }
        Request::Enable { .. } | Request::Disable { .. } => {
            let previous =
                previous.ok_or_else(|| Error::new("executor_not_found", "Run has no executor"))?;
            let enabled = matches!(request, Request::Enable { .. });
            if enabled {
                if previous.enabled {
                    return Err(Error::new(
                        "executor_state_conflict",
                        "Executor is already enabled; inspect the existing generation",
                    )
                    .into());
                }
                if current["state"] != "active" {
                    return Err(Error::new(
                        "run_state_conflict",
                        "Run must be active; executor enable cannot bypass run stop/drain",
                    )
                    .into());
                }
                capacity(&transaction)?;
            }
            transaction.execute("UPDATE workflow_executors SET issuer=?2,enabled=?3,generation=generation+1,phase=?4,reason=NULL,task_id=NULL WHERE id=?1",params![previous.id,actor.issuer,enabled,if enabled {"enabled"}else{"disabled"}])?;
            (previous.id, enabled)
        }
        _ => return Err(anyhow!("Unexpected executor mutation")),
    };
    let cursor = event(&transaction, &id, run, now)?;
    let executor = read(&transaction, run)?.ok_or_else(|| anyhow!("Executor disappeared"))?;
    let pump = enabled.then(|| Guard {
        id: executor.id.clone(),
        generation: executor.generation,
    });
    let view = json!({"run":orchestration::run(&transaction,&actor,run)?,"executor":executor,"cursor":cursor});
    orchestration::remember(&transaction, &actor, key, &fingerprint, &view)?;
    transaction.commit()?;
    Ok(Reply::Managed { view, pump })
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::Manage { actor, request } => manage(connection, actor, request, now),
        Work::Retry {
            guard,
            issuer,
            attempt,
        } => {
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            self::guard(&transaction, &guard, &issuer)?;
            let run: String = transaction.query_row(
                "SELECT run_id FROM workflow_executors WHERE id=?1",
                [&guard.id],
                |row| row.get(0),
            )?;
            let eligible: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id=?1 AND t.run_id=?2 AND a.state IN ('failed','stopped','launchFailed') AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=a.task_id))", params![attempt,run], |row| row.get(0))?;
            if !eligible {
                return Err(Error::new(
                    "revision_conflict",
                    "Retry history changed; inspect current task",
                )
                .into());
            }
            let executor =
                read(&transaction, &run)?.ok_or_else(|| anyhow!("Missing retry executor"))?;
            if !executor.spec.retry_failed {
                return Err(
                    Error::new("retry_requires_intent", "Automatic retry is disabled").into(),
                );
            }
            // First observed terminal failure starts the durable cooldown. The
            // old process's launch timestamp can precede failure by hours.
            transaction.execute("INSERT OR IGNORE INTO workflow_executor_retries(executor_id,attempt_id,not_before) VALUES(?1,?2,?3)", params![guard.id,attempt,now.saturating_add(executor.spec.retry_delay_ms) as i64])?;
            let after: i64 = transaction.query_row("SELECT not_before FROM workflow_executor_retries WHERE executor_id=?1 AND attempt_id=?2", params![guard.id,attempt], |row| row.get(0))?;
            transaction.commit()?;
            Ok(Reply::RetryReady(now >= u64::try_from(after)?))
        }
        Work::Poll { guard, issuer } => {
            if let Err(error) = self::guard(connection, &guard, &issuer) {
                if error
                    .downcast_ref::<Error>()
                    .is_some_and(|e| e.code == "executor_paused")
                {
                    return Ok(Reply::Snapshot(None));
                }
                return Err(error);
            }
            let run: String = connection.query_row(
                "SELECT run_id FROM workflow_executors WHERE id=?1",
                [&guard.id],
                |r| r.get(0),
            )?;
            let executor =
                read(connection, &run)?.ok_or_else(|| anyhow!("Executor disappeared"))?;
            let mut q=connection.prepare("SELECT e.attempt_id FROM workflow_executor_launches e JOIN workflow_attempts a ON a.id=e.attempt_id WHERE e.executor_id=?1 AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=a.task_id)")?;
            let owned = q
                .query_map([&guard.id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            Ok(Reply::Snapshot(Some(Box::new(Snapshot {
                executor,
                owned,
            }))))
        }
        Work::Note {
            guard,
            issuer,
            phase,
            reason,
            task_id,
            disable,
        } => {
            if !matches!(
                phase,
                "waiting" | "blocked" | "paused" | "completed" | "scheduling"
            ) {
                return Err(anyhow!("Invalid executor phase"));
            }
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let changed=transaction.execute("UPDATE workflow_executors SET phase=?4,reason=?5,task_id=?6,enabled=(NOT ?7),generation=generation+?7 WHERE id=?1 AND generation=?2 AND issuer=?3 AND enabled=1 AND (phase!=?4 OR reason IS NOT ?5 OR task_id IS NOT ?6 OR ?7)",params![guard.id,guard.generation as i64,issuer,phase,reason,task_id,disable])?;
            if changed > 0 {
                let run: String = transaction.query_row(
                    "SELECT run_id FROM workflow_executors WHERE id=?1",
                    [&guard.id],
                    |r| r.get(0),
                )?;
                event(&transaction, &guard.id, &run, now)?;
            }
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
