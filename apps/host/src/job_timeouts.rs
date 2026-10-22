use crate::{api_error::Error, job_definitions};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub job_id: String,
    pub occurrence_id: String,
    pub job_attempt_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub launch_receipt_id: String,
}

#[derive(Clone, Debug)]
pub struct Claim {
    pub identity: Identity,
    pub token: String,
    pub issuer: String,
    pub control_key: String,
    pub deadline_at: u64,
    pub deadline_monotonic_ms: u64,
}

pub struct Schedule {
    pub claims: Vec<Claim>,
    pub next_deadline_monotonic_ms: Option<u64>,
    pub observing: bool,
}

struct Record {
    identity: Identity,
    issuer: String,
    timeout_ms: u64,
    armed_at: u64,
    deadline_at: u64,
    deadline_monotonic_ms: u64,
    state: String,
    requested_at: Option<u64>,
    observed_at: u64,
    reason: Option<String>,
    control_key: String,
    control_id: Option<String>,
    token: Option<String>,
}

const COLUMNS: &str = "job_id,occurrence_id,job_attempt_id,run_id,attempt_id,session_id,launch_receipt_id,issuer,timeout_ms,armed_at,deadline_at,deadline_monotonic_ms,state,requested_at,observed_at,reason,control_key,control_id,token";

fn unsigned(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn millis(row: &Row<'_>, column: usize) -> rusqlite::Result<u64> {
    unsigned(row.get(column)?, column)
}

fn optional_millis(row: &Row<'_>, column: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(column)?
        .map(|value| unsigned(value, column))
        .transpose()
}

fn record(row: &Row<'_>) -> rusqlite::Result<Record> {
    Ok(Record {
        identity: Identity {
            job_id: row.get(0)?,
            occurrence_id: row.get(1)?,
            job_attempt_id: row.get(2)?,
            run_id: row.get(3)?,
            attempt_id: row.get(4)?,
            session_id: row.get(5)?,
            launch_receipt_id: row.get(6)?,
        },
        issuer: row.get(7)?,
        timeout_ms: millis(row, 8)?,
        armed_at: millis(row, 9)?,
        deadline_at: millis(row, 10)?,
        deadline_monotonic_ms: millis(row, 11)?,
        state: row.get(12)?,
        requested_at: optional_millis(row, 13)?,
        observed_at: millis(row, 14)?,
        reason: row.get(15)?,
        control_key: row.get(16)?,
        control_id: row.get(17)?,
        token: row.get(18)?,
    })
}

fn load(connection: &Connection, column: &str, value: &str) -> Result<Option<Record>> {
    Ok(connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM harness_job_timeouts WHERE {column}=?1"),
            [value],
            record,
        )
        .optional()?)
}

fn stale() -> anyhow::Error {
    Error::new(
        "stale_job_timeout",
        "Timeout identity or one-use claim changed; inspect its original control and receipts",
    )
    .into()
}

fn expired() -> anyhow::Error {
    Error::new(
        "job_execution_timeout",
        "This job execution deadline is exhausted or cleanup is pending; inspect the original generation and control",
    )
    .into()
}

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_job_timeouts(
        job_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
        job_id TEXT NOT NULL REFERENCES harness_jobs(id),
        occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
        run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
        attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),
        session_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(session_id),
        launch_receipt_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),
        issuer TEXT NOT NULL,timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 604800000),
        armed_at INTEGER NOT NULL CHECK(armed_at>=0),deadline_at INTEGER NOT NULL CHECK(deadline_at>armed_at),
        armed_monotonic_ms INTEGER NOT NULL CHECK(armed_monotonic_ms>=0),
        deadline_monotonic_ms INTEGER NOT NULL CHECK(deadline_monotonic_ms>armed_monotonic_ms),
        state TEXT NOT NULL CHECK(state IN ('armed','disarmed','dispatching','awaitingExit','blocked','unconfirmed','completed')),
        requested_at INTEGER,observed_at INTEGER NOT NULL,reason TEXT,
        control_key TEXT NOT NULL UNIQUE,control_id TEXT REFERENCES workflow_controls(id),token TEXT);
        CREATE INDEX IF NOT EXISTS harness_job_timeouts_due ON harness_job_timeouts(state,deadline_monotonic_ms);
        CREATE INDEX IF NOT EXISTS harness_job_timeouts_control ON harness_job_timeouts(control_id) WHERE control_id IS NOT NULL;")?;
    Ok(())
}

fn current(connection: &Connection, identity: &Identity) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_occurrences o
        JOIN harness_job_attempts j ON j.id=o.current_job_attempt_id AND j.occurrence_id=o.id
        JOIN workflow_tasks t ON t.run_id=j.run_id
        JOIN workflow_attempts a ON a.task_id=t.id
        JOIN workflow_launches l ON l.attempt_id=a.id
        WHERE o.job_id=?1 AND o.id=?2 AND j.id=?3 AND o.run_id=?4 AND j.run_id=?4
        AND a.id=?5 AND a.session_id=?6 AND l.operation_id=?7
        AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=t.id))",
        params![
            identity.job_id,
            identity.occurrence_id,
            identity.job_attempt_id,
            identity.run_id,
            identity.attempt_id,
            identity.session_id,
            identity.launch_receipt_id
        ],
        |row| row.get(0),
    )?)
}

pub fn arm(
    tx: &Transaction<'_>,
    run: &str,
    attempt: &str,
    now: u64,
    elapsed_ms: u64,
) -> Result<()> {
    crate::job_launch_resolutions::guard_run(tx, run)?;
    let binding = tx.query_row("SELECT o.job_id,o.id,j.id,o.spec,a.session_id,l.operation_id,p.issuer
        FROM harness_job_attempts j JOIN harness_job_occurrences o ON o.id=j.occurrence_id
        JOIN workflow_tasks t ON t.run_id=j.run_id JOIN workflow_attempts a ON a.task_id=t.id
        JOIN workflow_launches l ON l.attempt_id=a.id JOIN operation_receipts p ON p.id=l.operation_id
        WHERE j.run_id=?1 AND a.id=?2",params![run,attempt],|row|Ok((Identity {
            job_id:row.get(0)?,occurrence_id:row.get(1)?,job_attempt_id:row.get(2)?,run_id:run.into(),
            attempt_id:attempt.into(),session_id:row.get(4)?,launch_receipt_id:row.get(5)?,
        },row.get::<_,String>(3)?,row.get::<_,String>(6)?))).optional()?;
    let Some((identity, spec, issuer)) = binding else {
        return Ok(());
    };
    let spec: job_definitions::Spec = serde_json::from_str(&spec)?;
    let Some(timeout_ms) = spec.execution_timeout_ms else {
        return Ok(());
    };
    if !current(tx, &identity)? || !(1000..=604_800_000).contains(&timeout_ms) {
        return Err(stale());
    }
    if load(tx, "job_attempt_id", &identity.job_attempt_id)?.is_some() {
        return Err(Error::new("job_timeout_exists", "This generation already has a frozen native execution deadline; inspect its original attempt").into());
    }
    let deadline = now.checked_add(timeout_ms).ok_or_else(stale)?;
    let monotonic_deadline = elapsed_ms.checked_add(timeout_ms).ok_or_else(stale)?;
    tx.execute("INSERT INTO harness_job_timeouts(job_attempt_id,job_id,occurrence_id,run_id,attempt_id,session_id,launch_receipt_id,issuer,timeout_ms,armed_at,deadline_at,armed_monotonic_ms,deadline_monotonic_ms,state,observed_at,control_key)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'armed',?10,?14)",
        params![identity.job_attempt_id,identity.job_id,identity.occurrence_id,run,attempt,identity.session_id,identity.launch_receipt_id,issuer,i64::try_from(timeout_ms)?,i64::try_from(now)?,i64::try_from(deadline)?,i64::try_from(elapsed_ms)?,i64::try_from(monotonic_deadline)?,format!("job-timeout:{}",identity.job_attempt_id)])?;
    Ok(())
}

fn guard(record: Option<Record>, elapsed_ms: u64) -> Result<()> {
    if record.is_some_and(|record| {
        record.state != "disarmed"
            && (record.state != "armed" || elapsed_ms >= record.deadline_monotonic_ms)
    }) {
        return Err(expired());
    }
    Ok(())
}

pub fn guard_run(connection: &Connection, run: &str, _now: u64, elapsed_ms: u64) -> Result<()> {
    guard(load(connection, "run_id", run)?, elapsed_ms)
}

pub fn guard_report(
    connection: &Connection,
    attempt: &str,
    _now: u64,
    elapsed_ms: u64,
) -> Result<()> {
    guard(load(connection, "attempt_id", attempt)?, elapsed_ms)
}

pub fn report_accepted(tx: &Transaction<'_>, attempt: &str, now: u64) -> Result<()> {
    let resolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_launch_resolutions x JOIN workflow_tasks t ON t.run_id=x.run_id JOIN workflow_attempts a ON a.task_id=t.id WHERE a.id=?1)",[attempt],|row|row.get(0))?;
    if resolved {
        return Err(stale());
    }
    tx.execute(
        "UPDATE harness_job_timeouts SET state='disarmed',reason='report_accepted',observed_at=?2
        WHERE attempt_id=?1 AND state='armed'",
        params![attempt, i64::try_from(now)?],
    )?;
    Ok(())
}

pub fn owns_occurrence(connection: &Connection, occurrence: &str) -> Result<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_timeouts x
        JOIN harness_job_occurrences o ON o.id=x.occurrence_id AND o.current_job_attempt_id=x.job_attempt_id
        WHERE o.id=?1 AND x.state NOT IN ('armed','disarmed') AND NOT EXISTS(SELECT 1 FROM harness_job_launch_resolutions r WHERE r.job_attempt_id=x.job_attempt_id))",[occurrence],|row|row.get(0))?)
}

pub fn owns_control(connection: &Connection, control: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_timeouts WHERE control_id=?1)",
        [control],
        |row| row.get(0),
    )?)
}

pub fn guard_claim(connection: &Connection, claim: &Claim) -> Result<()> {
    if crate::job_launch_resolutions::resolved_attempt(connection, &claim.identity.job_attempt_id)?
    {
        return Err(stale());
    }
    let Some(record) = load(connection, "job_attempt_id", &claim.identity.job_attempt_id)? else {
        return Err(stale());
    };
    if record.identity != claim.identity
        || record.token.as_deref() != Some(claim.token.as_str())
        || record.state != "dispatching"
        || record.issuer != claim.issuer
        || record.control_key != claim.control_key
        || record.deadline_at != claim.deadline_at
        || record.deadline_monotonic_ms != claim.deadline_monotonic_ms
        || !current(connection, &claim.identity)?
        || crate::job_cancellations::requested(connection, &claim.identity.occurrence_id)?
    {
        return Err(stale());
    }
    Ok(())
}

pub fn control_prepared(
    tx: &Transaction<'_>,
    claim: &Claim,
    control: &str,
    now: u64,
) -> Result<()> {
    guard_claim(tx, claim)?;
    let matches:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workflow_controls c
        JOIN workflow_control_targets t ON t.control_id=c.id WHERE c.id=?1 AND c.run_id=?2 AND c.issuer=?3
        AND c.kind IN ('stop','cancel') AND t.attempt_id=?4 AND t.session_id=?5
        AND (SELECT count(*) FROM workflow_control_targets WHERE control_id=c.id)=1)",
        params![control,claim.identity.run_id,claim.issuer,claim.identity.attempt_id,claim.identity.session_id],|row|row.get(0))?;
    if !matches {
        return Err(stale());
    }
    let changed=tx.execute("UPDATE harness_job_timeouts SET control_id=?2,observed_at=?3 WHERE job_attempt_id=?1 AND (control_id IS NULL OR control_id=?2)",params![claim.identity.job_attempt_id,control,i64::try_from(now)?])?;
    if changed != 1 {
        return Err(stale());
    }
    Ok(())
}

pub fn block_claim(
    tx: &Transaction<'_>,
    claim: &Claim,
    reason: &'static str,
    now: u64,
) -> Result<()> {
    guard_claim(tx, claim)?;
    tx.execute("UPDATE harness_job_timeouts SET state='blocked',reason=?2,observed_at=?3 WHERE job_attempt_id=?1",params![claim.identity.job_attempt_id,reason,i64::try_from(now)?])?;
    job_definitions::transition(
        tx,
        &claim.identity.occurrence_id,
        "canceling",
        Some("execution_timeout_blocked"),
        false,
        now,
    )?;
    Ok(())
}

pub fn claims(tx: &Transaction<'_>, slots: u8, now: u64, elapsed_ms: u64) -> Result<Vec<Claim>> {
    let mut query=tx.prepare(&format!("SELECT {COLUMNS} FROM harness_job_timeouts x WHERE state='armed'
        AND deadline_monotonic_ms<=?1 AND NOT EXISTS(SELECT 1 FROM harness_job_cancellations c WHERE c.occurrence_id=x.occurrence_id)
        AND NOT EXISTS(SELECT 1 FROM harness_job_launch_resolutions r WHERE r.job_attempt_id=x.job_attempt_id)
        ORDER BY deadline_monotonic_ms,job_attempt_id LIMIT ?2"))?;
    let rows = query
        .query_map(params![i64::try_from(elapsed_ms)?, slots.min(2)], record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut claims = Vec::new();
    for record in rows {
        if !current(tx, &record.identity)? {
            tx.execute("UPDATE harness_job_timeouts SET state='unconfirmed',reason='timeout_target_changed',observed_at=?2 WHERE job_attempt_id=?1",params![record.identity.job_attempt_id,i64::try_from(now)?])?;
            continue;
        }
        let token = hex::encode(crate::wire::random::<32>());
        tx.execute("UPDATE harness_job_timeouts SET state='dispatching',requested_at=?2,observed_at=?2,reason='execution_timeout',token=?3 WHERE job_attempt_id=?1 AND state='armed'",params![record.identity.job_attempt_id,i64::try_from(now)?,token])?;
        job_definitions::transition(
            tx,
            &record.identity.occurrence_id,
            "canceling",
            Some("execution_timeout"),
            false,
            now,
        )?;
        claims.push(Claim {
            identity: record.identity,
            token,
            issuer: record.issuer,
            control_key: record.control_key,
            deadline_at: record.deadline_at,
            deadline_monotonic_ms: record.deadline_monotonic_ms,
        });
    }
    Ok(claims)
}

pub fn finish(tx: &Transaction<'_>, claim: &Claim, result: Option<Value>, now: u64) -> Result<()> {
    if crate::job_launch_resolutions::resolved_attempt(tx, &claim.identity.job_attempt_id)? {
        return Err(stale());
    }
    let Some(record) = load(tx, "job_attempt_id", &claim.identity.job_attempt_id)? else {
        return Err(stale());
    };
    if record.identity != claim.identity
        || record.token.as_deref() != Some(claim.token.as_str())
        || !matches!(record.state.as_str(), "dispatching" | "blocked")
    {
        return Err(stale());
    }
    let mismatched = result.is_some_and(|result| {
        result["run"]["id"] != claim.identity.run_id
            || record.control_id.is_none()
            || result["control"]["id"].as_str() != record.control_id.as_deref()
    });
    if record.state == "blocked" {
        tx.execute(
            "UPDATE harness_job_timeouts SET token=NULL WHERE job_attempt_id=?1",
            [&claim.identity.job_attempt_id],
        )?;
    } else {
        tx.execute("UPDATE harness_job_timeouts SET token=NULL,state='unconfirmed',reason=?3,observed_at=?2 WHERE job_attempt_id=?1",params![claim.identity.job_attempt_id,i64::try_from(now)?,if mismatched {"timeout_result_mismatch"}else{"timeout_dispatch_unconfirmed"}])?;
    }
    refresh(tx, now)
}

fn disarm(tx: &Transaction<'_>, record: &Record, reason: &str, now: u64) -> Result<()> {
    tx.execute("UPDATE harness_job_timeouts SET state='disarmed',reason=?2,observed_at=?3 WHERE job_attempt_id=?1 AND state='armed'",params![record.identity.job_attempt_id,reason,i64::try_from(now)?])?;
    Ok(())
}

pub fn refresh(tx: &Transaction<'_>, now: u64) -> Result<()> {
    let mut query=tx.prepare(&format!("SELECT {COLUMNS} FROM harness_job_timeouts WHERE state IN ('armed','dispatching','awaitingExit','blocked','unconfirmed') AND token IS NULL ORDER BY job_attempt_id LIMIT 4096"))?;
    let rows = query
        .query_map([], record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for record in rows {
        if crate::job_launch_resolutions::resolved_attempt(tx, &record.identity.job_attempt_id)? {
            continue;
        }
        if record.state == "armed" {
            let native=tx.query_row("SELECT a.result,p.phase,p.result FROM workflow_attempts a JOIN operation_receipts p ON p.id=?2 WHERE a.id=?1",params![record.identity.attempt_id,record.identity.launch_receipt_id],|row|Ok((row.get::<_,Option<String>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))?;
            if native.0.is_some() {
                disarm(tx, &record, "report_accepted", now)?;
                continue;
            }
            let no_effect = native.1 == "failed"
                && serde_json::from_str::<Value>(&native.2)?.get("effectStarted")
                    == Some(&Value::Bool(false));
            if no_effect {
                disarm(tx, &record, "launch_no_effect", now)?;
                continue;
            }
            let owner_control:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workflow_controls WHERE run_id=?1) OR EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=?2)",params![record.identity.run_id,record.identity.occurrence_id],|row|row.get(0))?;
            if owner_control {
                disarm(tx, &record, "owner_control", now)?;
                continue;
            }
            let exited: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)",
                [&record.identity.session_id],
                |row| row.get(0),
            )?;
            if exited && current(tx, &record.identity)? {
                disarm(tx, &record, "process_exited", now)?;
                let changed=tx.execute("UPDATE workflow_attempts SET state='stopped' WHERE id=?1 AND result IS NULL AND state IN ('assigned','launching','launchUnknown')",[&record.identity.attempt_id])?;
                if changed > 0 {
                    tx.execute(
                        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
                        [&record.identity.run_id],
                    )?;
                    crate::workflow_decisions::close_pending(
                        tx,
                        &record.identity.attempt_id,
                        now,
                        "Worker process exited without a reported task result",
                    )?;
                    crate::workflow_budget::settle_drain(tx, &record.identity.run_id)?;
                }
                job_definitions::transition(
                    tx,
                    &record.identity.occurrence_id,
                    "failed",
                    Some("worker_exited_without_result"),
                    true,
                    now,
                )?;
            }
            continue;
        }
        if record.requested_at.is_none() {
            continue;
        }
        let exited: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)",
            [&record.identity.session_id],
            |row| row.get(0),
        )?;
        let (state, reason) = if exited {
            ("completed", "execution_timeout")
        } else if let Some(control) = &record.control_id {
            let state:Option<String>=tx.query_row("SELECT c.state FROM workflow_controls c JOIN workflow_control_targets t ON t.control_id=c.id WHERE c.id=?1 AND c.run_id=?2 AND t.attempt_id=?3 AND t.session_id=?4",params![control,record.identity.run_id,record.identity.attempt_id,record.identity.session_id],|row|row.get(0)).optional()?;
            match state.as_deref() {
                Some("blocked") => ("blocked", "timeout_blocked"),
                Some("awaitingExit") => ("awaitingExit", "timeout_pending"),
                _ => ("unconfirmed", "timeout_unconfirmed"),
            }
        } else if record.state == "blocked" {
            (
                "blocked",
                record.reason.as_deref().unwrap_or("timeout_blocked"),
            )
        } else {
            (
                "unconfirmed",
                record
                    .reason
                    .as_deref()
                    .unwrap_or("timeout_dispatch_unconfirmed"),
            )
        };
        if record.state != state || record.reason.as_deref() != Some(reason) {
            tx.execute("UPDATE harness_job_timeouts SET state=?2,reason=?3,observed_at=?4 WHERE job_attempt_id=?1",params![record.identity.job_attempt_id,state,reason,i64::try_from(now)?])?;
        }
        if current(tx, &record.identity)? {
            let (phase, reason, finished) = match state {
                "completed" => ("failed", "execution_timeout", true),
                "blocked" => ("canceling", "execution_timeout_blocked", false),
                "awaitingExit" => ("canceling", "execution_timeout_pending", false),
                _ => ("reconcile", "execution_timeout_unconfirmed", false),
            };
            job_definitions::transition(
                tx,
                &record.identity.occurrence_id,
                phase,
                Some(reason),
                finished,
                now,
            )?;
        }
    }
    Ok(())
}

pub fn schedule(tx: &Transaction<'_>, slots: u8, now: u64, elapsed_ms: u64) -> Result<Schedule> {
    refresh(tx, now)?;
    let claims = claims(tx, slots, now, elapsed_ms)?;
    let next_deadline_monotonic_ms=tx.query_row("SELECT MIN(deadline_monotonic_ms) FROM harness_job_timeouts x WHERE state='armed' AND (?1>0 OR deadline_monotonic_ms>?2) AND NOT EXISTS(SELECT 1 FROM harness_job_launch_resolutions r WHERE r.job_attempt_id=x.job_attempt_id)",params![slots,i64::try_from(elapsed_ms)?],|row|optional_millis(row,0))?;
    let observing=tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_timeouts x WHERE state IN ('dispatching','awaitingExit') AND NOT EXISTS(SELECT 1 FROM harness_job_launch_resolutions r WHERE r.job_attempt_id=x.job_attempt_id))",[],|row|row.get(0))?;
    Ok(Schedule {
        claims,
        next_deadline_monotonic_ms,
        observing,
    })
}

pub fn recover(tx: &Transaction<'_>, now: u64) -> Result<()> {
    refresh(tx, now)?;
    tx.execute("UPDATE harness_job_timeouts SET state='unconfirmed',token=NULL,reason='host_restarted',observed_at=?1 WHERE state NOT IN ('disarmed','completed') AND NOT EXISTS(SELECT 1 FROM harness_job_launch_resolutions r WHERE r.job_attempt_id=harness_job_timeouts.job_attempt_id)",[i64::try_from(now)?])?;
    Ok(())
}

fn view(record: Record) -> Value {
    json!({"jobId":record.identity.job_id,"occurrenceId":record.identity.occurrence_id,"jobAttemptId":record.identity.job_attempt_id,"runId":record.identity.run_id,"attemptId":record.identity.attempt_id,"sessionId":record.identity.session_id,"launchReceiptId":record.identity.launch_receipt_id,"executionTimeoutMs":record.timeout_ms,"armedAt":record.armed_at,"deadlineAt":record.deadline_at,"state":record.state,"requestedAt":record.requested_at,"observedAt":record.observed_at,"reason":record.reason,"controlKey":record.control_key,"controlId":record.control_id})
}

pub fn view_attempt(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(load(connection, "job_attempt_id", attempt)?
        .map(view)
        .unwrap_or(Value::Null))
}

pub fn view_current(connection: &Connection, occurrence: &str) -> Result<Value> {
    let attempt: Option<String> = connection.query_row(
        "SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",
        [occurrence],
        |row| row.get(0),
    )?;
    attempt
        .map(|attempt| view_attempt(connection, &attempt))
        .transpose()
        .map(|value| value.unwrap_or(Value::Null))
}
