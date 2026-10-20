//! Run admission, retry/time budgets and drain. Native control receipts are separate.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor, Scope},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_parallel: u16,
    pub max_attempts_per_task: u16,
    #[serde(deserialize_with = "Option::deserialize")]
    pub max_elapsed_ms: Option<u64>,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_parallel: 8,
            max_attempts_per_task: 16,
            max_elapsed_ms: None,
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<()> {
        if !(1..=16).contains(&self.max_parallel)
            || !(1..=16).contains(&self.max_attempts_per_task)
            || self
                .max_elapsed_ms
                .is_some_and(|n| !(1000..=604_800_000).contains(&n))
        {
            return Err(Error::new(
                "invalid_argument",
                "Run parallel/attempt limits are 1–16; elapsed limit is null or 1 second–7 days",
            )
            .into());
        }
        Ok(())
    }
    fn tightens(&self, old: &Self) -> bool {
        self.max_parallel <= old.max_parallel
            && self.max_attempts_per_task <= old.max_attempts_per_task
            && match (self.max_elapsed_ms, old.max_elapsed_ms) {
                (Some(a), Some(b)) => a <= b,
                (None, Some(_)) => false,
                _ => true,
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
    Get {
        run_id: String,
    },
    Set {
        key: String,
        run_id: String,
        expected_revision: u64,
        limits: Limits,
    },
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_run_budget(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),limits TEXT NOT NULL,started_at INTEGER,exhausted_at INTEGER,drain_owner INTEGER NOT NULL DEFAULT 0);")?;
    Ok(())
}
struct Record {
    limits: Limits,
    started: Option<u64>,
    exhausted: Option<u64>,
    drain_owner: bool,
}
fn load(connection: &Connection, run_id: &str) -> Result<Record> {
    let row:Option<(String,Option<i64>,Option<i64>,bool)>=connection.query_row("SELECT limits,started_at,exhausted_at,drain_owner FROM workflow_run_budget WHERE run_id=?1",[run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    match row {
        Some((source, started, exhausted, drain_owner)) => {
            let limits: Limits = serde_json::from_str(&source)?;
            limits.validate()?;
            Ok(Record {
                limits,
                started: started.map(u64::try_from).transpose()?,
                exhausted: exhausted.map(u64::try_from).transpose()?,
                drain_owner,
            })
        }
        None => Ok(Record {
            limits: Limits::default(),
            started: None,
            exhausted: None,
            drain_owner: false,
        }),
    }
}
pub fn ensure_record(connection: &Connection, run_id: &str) -> Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO workflow_run_budget(run_id,limits) VALUES(?1,?2)",
        params![run_id, serde_json::to_string(&Limits::default())?],
    )?;
    Ok(())
}
fn deadline(record: &Record) -> Option<u64> {
    record
        .started
        .zip(record.limits.max_elapsed_ms)
        .and_then(|(start, duration)| start.checked_add(duration))
}
fn active(connection: &Connection, run_id: &str) -> Result<i64> {
    Ok(connection.query_row("SELECT count(*) FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=?1 AND a.state IN ('launching','launchUnknown','assigned','reported')",[run_id],|r|r.get(0))?)
}
pub fn snapshot(connection: &Connection, run_id: &str, state: &str) -> Result<Value> {
    let record = load(connection, run_id)?;
    let clock = if record.started.is_none() {
        if state == "draft" {
            "notStarted"
        } else {
            "untracked"
        }
    } else if record.exhausted.is_some() {
        "exhausted"
    } else if record.limits.max_elapsed_ms.is_none() {
        "unlimited"
    } else {
        "open"
    };
    Ok(
        json!({"limits":record.limits,"startedAt":record.started,"deadlineAt":deadline(&record),"exhaustedAt":record.exhausted,"timeState":clock,"activeAttempts":active(connection,run_id)?,"ownerDrain":record.drain_owner}),
    )
}
fn event(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: &'static str,
    payload: Value,
    now: u64,
) -> Result<u64> {
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            kind,
            at: now,
            payload,
        }],
    )
}
/// Persist first observed exhaustion independently of a rejected admission.
pub fn refresh(connection: &mut Connection, run_id: &str, now: u64) -> Result<()> {
    let record = load(connection, run_id)?;
    if record.exhausted.is_some() || !deadline(&record).is_some_and(|at| now >= at) {
        return Ok(());
    }
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let record = load(&transaction, run_id)?;
    if record.exhausted.is_none() && deadline(&record).is_some_and(|at| now >= at) {
        transaction.execute(
            "UPDATE workflow_run_budget SET exhausted_at=?2 WHERE run_id=?1",
            params![run_id, now as i64],
        )?;
        event(
            &transaction,
            run_id,
            "run.time_budget_exhausted",
            json!({"runId":run_id}),
            now,
        )?;
    }
    transaction.commit()?;
    Ok(())
}
pub fn activate(transaction: &Transaction<'_>, run_id: &str, now: u64) -> Result<()> {
    ensure_record(transaction, run_id)?;
    transaction.execute(
        "UPDATE workflow_run_budget SET started_at=?2 WHERE run_id=?1 AND started_at IS NULL",
        params![run_id, now as i64],
    )?;
    Ok(())
}
pub fn admit_attempt(connection: &Connection, run_id: &str, ordinal: i64) -> Result<()> {
    crate::job_cancellations::guard_run(connection, run_id)?;
    crate::workflow_context::guard(connection, run_id)?;
    let record = load(connection, run_id)?;
    if record.exhausted.is_some() {
        return Err(Error::new(
            "time_budget_exhausted",
            "Run elapsed budget is exhausted; only an explicit owner extension can reopen it",
        )
        .into());
    }
    if active(connection, run_id)? >= i64::from(record.limits.max_parallel) {
        return Err(Error::new(
            "parallel_budget_exhausted",
            "Run parallel attempt budget is occupied, including results awaiting validation",
        )
        .into());
    }
    if ordinal > i64::from(record.limits.max_attempts_per_task) {
        return Err(Error::new(
            "retry_budget_exhausted",
            "Task attempt budget is exhausted; history is retained",
        )
        .into());
    }
    Ok(())
}
pub fn settle_drain(connection: &Connection, run_id: &str) -> Result<()> {
    if active(connection, run_id)? == 0 {
        connection.execute(
            "UPDATE workflow_runs SET state='drained' WHERE id=?1 AND state='draining'",
            [run_id],
        )?;
    }
    Ok(())
}
pub fn mutate_drain(
    transaction: &Transaction<'_>,
    actor: &Actor,
    run_id: &str,
    resume: bool,
) -> Result<()> {
    ensure_record(transaction, run_id)?;
    let record = load(transaction, run_id)?;
    if resume {
        if record.drain_owner && !matches!(actor.scope, Scope::Owner) {
            return Err(Error::new(
                "forbidden",
                "A human owner drain can be resumed only by the owner",
            )
            .into());
        }
        transaction.execute(
            "UPDATE workflow_run_budget SET drain_owner=0 WHERE run_id=?1",
            [run_id],
        )?;
        transaction.execute(
            "UPDATE workflow_runs SET state='active' WHERE id=?1",
            [run_id],
        )?;
    } else {
        transaction.execute(
            "UPDATE workflow_run_budget SET drain_owner=(drain_owner OR ?2) WHERE run_id=?1",
            params![run_id, matches!(actor.scope, Scope::Owner)],
        )?;
        transaction.execute(
            "UPDATE workflow_runs SET state='draining' WHERE id=?1",
            [run_id],
        )?;
        settle_drain(transaction, run_id)?;
    }
    Ok(())
}
fn policy_view(connection: &Connection, actor: &Actor, run_id: &str) -> Result<Value> {
    let mut run = orchestration::run(connection, actor, run_id)?;
    let policy = run
        .as_object_mut()
        .and_then(|run| run.remove("budget"))
        .ok_or_else(|| anyhow::anyhow!("Stored run has no budget projection"))?;
    Ok(json!({"run":run,"policy":policy}))
}
pub fn execute(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
) -> Result<Value> {
    execute_inner(connection, actor, request, now, None)
}
/// Job setup uses the same budget mutation with its proof inside the writer.
pub fn execute_for_job(
    connection: &mut Connection,
    actor: &Actor,
    request: Request,
    now: u64,
    dispatch: &crate::job_attempts::Dispatch,
) -> Result<Value> {
    if !matches!(actor.scope, Scope::Owner) || !matches!(request, Request::Set { .. }) {
        return Err(Error::new(
            "invalid_argument",
            "Internal job preparation requires an owner budget set",
        )
        .into());
    }
    execute_inner(connection, actor.clone(), request, now, Some(dispatch))
}
fn execute_inner(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
    job_dispatch: Option<&crate::job_attempts::Dispatch>,
) -> Result<Value> {
    let run_id = match &request {
        Request::Get { run_id } | Request::Set { run_id, .. } => run_id,
    };
    if job_dispatch.is_none() {
        orchestration::run(connection, &actor, run_id)?;
        refresh(connection, run_id, now)?;
    }
    if matches!(request, Request::Get { .. }) {
        return policy_view(connection, &actor, run_id);
    }
    let Request::Set {
        ref key,
        expected_revision,
        ref limits,
        ..
    } = request
    else {
        unreachable!()
    };
    limits.validate()?;
    orchestration::validate_key(key)?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"runBudget","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(dispatch) = job_dispatch {
        crate::job_attempts::guard_bound_run(&transaction, dispatch, run_id)?;
    }
    if let Some(previous) = orchestration::replay(&transaction, &actor, key, &digest)? {
        return Ok(previous);
    }
    orchestration::mutation_capacity(&transaction)?;
    let run = orchestration::run(&transaction, &actor, run_id)?;
    if run["revision"] != expected_revision {
        return Err(Error::new(
            "revision_conflict",
            "Run revision changed; read it before editing its budget",
        )
        .into());
    }
    if !matches!(
        run["state"].as_str(),
        Some("draft" | "active" | "draining" | "drained")
    ) {
        return Err(Error::new(
            "run_state_conflict",
            "A completed run's admission policy cannot change",
        )
        .into());
    }
    let old = load(&transaction, run_id)?;
    if !matches!(actor.scope, Scope::Owner) && !limits.tightens(&old.limits) {
        return Err(Error::new(
            "forbidden",
            "Coordinator may tighten its run budget; only the owner may relax it",
        )
        .into());
    }
    if old.started.is_none() && run["state"] != "draft" && limits.max_elapsed_ms.is_some() {
        return Err(Error::new(
            "clock_unavailable",
            "This legacy run has no attested activation time; no elapsed budget was invented",
        )
        .into());
    }
    let extends = matches!(actor.scope, Scope::Owner)
        && match (limits.max_elapsed_ms, old.limits.max_elapsed_ms) {
            (None, Some(_)) => true,
            (Some(a), Some(b)) => a > b,
            _ => false,
        };
    let mut record = Record {
        limits: limits.clone(),
        started: old.started,
        exhausted: if extends { None } else { old.exhausted },
        drain_owner: old.drain_owner,
    };
    let reference = now.max(old.exhausted.unwrap_or(0));
    if deadline(&record).is_some_and(|at| reference >= at) {
        record.exhausted = Some(old.exhausted.unwrap_or(now));
    }
    ensure_record(&transaction, run_id)?;
    transaction.execute(
        "UPDATE workflow_run_budget SET limits=?2,exhausted_at=?3 WHERE run_id=?1",
        params![
            run_id,
            serde_json::to_string(&record.limits)?,
            record.exhausted.map(|n| n as i64)
        ],
    )?;
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [run_id],
    )?;
    let cursor = event(
        &transaction,
        run_id,
        "run.budget_changed",
        json!({"runId":run_id}),
        now,
    )?;
    let mut result = policy_view(&transaction, &actor, run_id)?;
    result["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, key, &digest, &result)?;
    transaction.commit()?;
    Ok(result)
}
/// Automated paste AND submit must pass. This never grants native authority or
/// affects a human's direct PTY input; native readiness/control guards still apply.
pub fn guard_dispatch(connection: &mut Connection, session: &str, now: u64) -> Result<()> {
    let run: Option<String> = connection.query_row("SELECT t.run_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=?1",[session],|r|r.get(0)).optional()?;
    if let Some(run) = run {
        refresh(connection, &run, now)?;
    }
    guard_dispatch_transaction(connection, session, now)
}
/// Recheck inside the writer transaction without nesting an exhaustion commit.
pub(crate) fn guard_dispatch_transaction(
    connection: &Connection,
    session: &str,
    now: u64,
) -> Result<()> {
    let binding:Option<(String,String,String,bool)>=connection.query_row("SELECT t.run_id,a.id,a.state,a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=t.id) FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((run_id, attempt, state, current)) = binding else {
        return Ok(());
    };
    crate::job_cancellations::guard_run(connection, &run_id)?;
    crate::workflow_context::guard(connection, &run_id)?;
    let run_state: String = connection.query_row(
        "SELECT state FROM workflow_runs WHERE id=?1",
        [&run_id],
        |r| r.get(0),
    )?;
    if !current {
        return Err(Error::new(
            "stale_attempt",
            "Automation cannot send to a superseded worker attempt",
        )
        .into());
    }
    if !matches!(run_state.as_str(), "active" | "draining") || state != "assigned" {
        return Err(Error::new(
            "attempt_state_conflict",
            "Run/attempt does not admit further automated input",
        )
        .into());
    }
    let budget = load(connection, &run_id)?;
    if budget.exhausted.is_some() || deadline(&budget).is_some_and(|at| now >= at) {
        return Err(Error::new(
            "time_budget_exhausted",
            "Run elapsed budget blocks further automated input",
        )
        .into());
    }
    let gates: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_decisions WHERE attempt_id=?1 AND state!='answered')",
        [attempt],
        |r| r.get(0),
    )?;
    if gates {
        return Err(Error::new(
            "decision_pending",
            "Resolve the current attempt's decision gates before automated input",
        )
        .into());
    }
    Ok(())
}
