//! Claimed job generations retain metadata evidence and fence native admission.
use crate::api_error::Error;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

const CAPACITY: i64 = 32768;
#[derive(Clone)]
pub struct Dispatch {
    pub occurrence: String,
    pub attempt: String,
    pub token: String,
}

const STATES: &[&str] = &[
    "dispatching",
    "prechecking",
    "running",
    "needsValidation",
    "reconcile",
    "canceling",
    "succeeded",
    "failed",
    "skipped",
    "canceled",
];

fn conflict() -> anyhow::Error {
    Error::new(
        "job_attempt_conflict",
        "Inspect the original job generation; its identity, phase or dispatch claim changed",
    )
    .into()
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_job_attempts(id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 4096),run_id TEXT UNIQUE REFERENCES workflow_runs(id),created_at INTEGER NOT NULL CHECK(created_at>=0),claimed_at INTEGER CHECK(claimed_at>=0),finished_at INTEGER CHECK(finished_at>=0),state TEXT NOT NULL,reason TEXT,dispatch_token TEXT,UNIQUE(occurrence_id,ordinal));
        CREATE INDEX IF NOT EXISTS harness_job_attempts_history ON harness_job_attempts(occurrence_id,ordinal);")?;
    let attempt_columns = {
        let mut query = connection.prepare("PRAGMA table_info(harness_job_attempts)")?;
        query
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !attempt_columns.iter().any(|name| name == "dispatch_token") {
        connection
            .execute_batch("ALTER TABLE harness_job_attempts ADD COLUMN dispatch_token TEXT;")?;
    }
    let occurrence_columns = {
        let mut query = connection.prepare("PRAGMA table_info(harness_job_occurrences)")?;
        query
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !occurrence_columns
        .iter()
        .any(|name| name == "current_job_attempt_id")
    {
        connection.execute_batch("ALTER TABLE harness_job_occurrences ADD COLUMN current_job_attempt_id TEXT REFERENCES harness_job_attempts(id);")?;
    }
    crate::job_launch_resolutions::initialize(connection)?;
    Ok(())
}
pub(crate) fn capacity(connection: &Connection, additional: usize) -> Result<()> {
    let count: i64 =
        connection.query_row("SELECT count(*) FROM harness_job_attempts", [], |r| {
            r.get(0)
        })?;
    if additional > CAPACITY as usize || count > CAPACITY - additional as i64 {
        return Err(Error::new(
            "busy",
            "Job generation retention is full; no historical evidence was discarded",
        )
        .into());
    }
    Ok(())
}
/// Copy historical claim evidence before restart changes its occurrence phase.
/// No row is manufactured for a queued/skipped/canceled intent never claimed.
pub fn backfill(tx: &Transaction<'_>) -> Result<()> {
    let mut query = tx.prepare("SELECT o.id FROM harness_job_occurrences o WHERE o.started_at IS NOT NULL AND o.state!='queued' AND NOT EXISTS(SELECT 1 FROM harness_job_attempts a WHERE a.occurrence_id=o.id AND a.ordinal=1) ORDER BY o.rowid")?;
    let occurrences = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    capacity(tx, occurrences.len())?;
    for occurrence in occurrences {
        let id = hex::encode(crate::wire::random::<16>());
        tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,finished_at,state,reason) SELECT ?2,id,1,run_id,created_at,started_at,finished_at,state,reason FROM harness_job_occurrences WHERE id=?1",params![occurrence,id])?;
    }
    // Already published generation rows acquire a pointer, never a new dispatch
    // capability. Never rewind a later explicit generation pointer.
    tx.execute("UPDATE harness_job_occurrences SET current_job_attempt_id=(SELECT a.id FROM harness_job_attempts a WHERE a.occurrence_id=harness_job_occurrences.id AND a.ordinal=1) WHERE current_job_attempt_id IS NULL AND EXISTS(SELECT 1 FROM harness_job_attempts a WHERE a.occurrence_id=harness_job_occurrences.id AND a.ordinal=1)",[])?;
    Ok(())
}
fn point_first(tx: &Transaction<'_>, occurrence: &str, attempt: &str) -> Result<()> {
    let pointer: Option<Option<String>> = tx
        .query_row(
            "SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",
            [occurrence],
            |r| r.get(0),
        )
        .optional()?;
    match pointer {
        Some(Some(current)) if current == attempt => Ok(()),
        Some(None) => {
            if tx.execute("UPDATE harness_job_occurrences SET current_job_attempt_id=?2 WHERE id=?1 AND current_job_attempt_id IS NULL",params![occurrence,attempt])? != 1 { return Err(conflict()); }
            Ok(())
        }
        _ => Err(conflict()),
    }
}
/// Admission already persisted started_at. It is not proof of process creation.
pub fn begin(tx: &Transaction<'_>, occurrence: &str, _now: u64) -> Result<String> {
    if let Some(id) = tx
        .query_row(
            "SELECT id FROM harness_job_attempts WHERE occurrence_id=?1 AND ordinal=1",
            [occurrence],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        point_first(tx, occurrence, &id)?;
        return Ok(id);
    }
    let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE id=?1 AND started_at IS NOT NULL AND state!='queued' AND current_job_attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM harness_job_attempts WHERE occurrence_id=?1))",[occurrence],|r|r.get(0))?;
    if !claimed {
        return Err(conflict());
    }
    capacity(tx, 1)?;
    let id = hex::encode(crate::wire::random::<16>());
    tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,finished_at,state,reason) SELECT ?2,id,1,run_id,created_at,started_at,finished_at,state,reason FROM harness_job_occurrences WHERE id=?1",params![occurrence,id])?;
    point_first(tx, occurrence, &id)?;
    Ok(id)
}
/// Used only by fresh scheduler admission. Even a retired generation cannot
/// obtain another token: original work is inspected, never implicitly rearmed.
#[cfg(test)]
pub fn claim(tx: &Transaction<'_>, occurrence: &str, now: u64) -> Result<Dispatch> {
    claim_at(tx, occurrence, now, now)
}
pub fn claim_at(
    tx: &Transaction<'_>,
    occurrence: &str,
    now: u64,
    elapsed: u64,
) -> Result<Dispatch> {
    let fresh: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE id=?1 AND state='dispatching' AND started_at IS NOT NULL AND run_id IS NULL AND current_job_attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM harness_job_attempts WHERE occurrence_id=?1))",[occurrence],|r|r.get(0))?;
    if !fresh {
        return Err(conflict());
    }
    crate::job_quota::guard_occurrence(tx, occurrence, elapsed)?;
    let attempt = begin(tx, occurrence, now)?;
    let token = hex::encode(crate::wire::random::<32>());
    if tx.execute(
        "UPDATE harness_job_attempts SET dispatch_token=?2 WHERE id=?1 AND dispatch_token IS NULL",
        params![attempt, token],
    )? != 1
    {
        return Err(conflict());
    }
    Ok(Dispatch {
        occurrence: occurrence.into(),
        attempt,
        token,
    })
}
/// A pure read fence. Native dispatch checks it in the same writer transaction
/// as its admission; it neither refreshes state nor creates a replacement claim.
pub fn guard(connection: &Connection, dispatch: &Dispatch, allowed: &[&str]) -> Result<()> {
    let phases: Option<(String,String)> = connection.query_row("SELECT o.state,a.state FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id WHERE o.id=?1 AND a.id=?2 AND a.dispatch_token=?3",params![dispatch.occurrence,dispatch.attempt,dispatch.token],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if !phases.is_some_and(|(occurrence, attempt)| {
        occurrence == attempt && allowed.contains(&occurrence.as_str())
    }) {
        return Err(conflict());
    }
    Ok(())
}
/// Preparation after binding must target this generation's exact run. Callers
/// keep this read and their metadata mutation in the same writer transaction.
pub fn guard_bound_run(connection: &Connection, dispatch: &Dispatch, run: &str) -> Result<()> {
    guard(connection, dispatch, &["dispatching"])?;
    let bound: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id WHERE o.id=?1 AND a.id=?2 AND a.dispatch_token=?3 AND o.run_id=?4 AND a.run_id=?4)",params![dispatch.occurrence,dispatch.attempt,dispatch.token,run],|r|r.get(0))?;
    if !bound {
        return Err(conflict());
    }
    Ok(())
}
pub fn retire(tx: &Transaction<'_>, dispatch: &Dispatch) -> Result<()> {
    if tx.execute("UPDATE harness_job_attempts SET dispatch_token=NULL WHERE id=?1 AND occurrence_id=?2 AND dispatch_token=?3",params![dispatch.attempt,dispatch.occurrence,dispatch.token])? != 1 { return Err(conflict()); }
    Ok(())
}
/// Ongoing native work needs current run assignment, not the already retired
/// preparation token. Historical runs remain readable but cannot admit effects.
pub fn guard_run(connection: &Connection, run: &str) -> Result<()> {
    crate::job_launch_resolutions::guard_run(connection, run)?;
    let retired: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_attempts a JOIN harness_job_occurrences o ON o.id=a.occurrence_id WHERE a.run_id=?1 AND (o.current_job_attempt_id IS NULL OR o.current_job_attempt_id<>a.id OR EXISTS(SELECT 1 FROM harness_job_retries retry WHERE retry.source_attempt_id=a.id)))",[run],|r|r.get(0))?;
    if retired {
        return Err(Error::new("job_generation_retired","This run belongs to a historical job generation; inspect its evidence instead of admitting new effects").into());
    }
    Ok(())
}
pub fn bind(tx: &Transaction<'_>, occurrence: &str, run: &str) -> Result<()> {
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT a.id,a.run_id FROM harness_job_attempts a JOIN harness_job_occurrences o ON o.current_job_attempt_id=a.id AND o.id=a.occurrence_id WHERE o.id=?1",
            [occurrence],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, bound)) = row else {
        return Err(conflict());
    };
    if bound.as_deref() == Some(run) {
        return Ok(());
    }
    if bound.is_some()
        || tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM harness_job_attempts WHERE run_id=?1)",
            [run],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(conflict());
    }
    if tx.execute(
        "UPDATE harness_job_attempts SET run_id=?2 WHERE id=?1 AND run_id IS NULL",
        params![id, run],
    )? != 1
    {
        return Err(conflict());
    }
    Ok(())
}
pub fn sync(
    tx: &Transaction<'_>,
    occurrence: &str,
    state: &str,
    reason: Option<&str>,
    finished_at: Option<u64>,
) -> Result<()> {
    if crate::job_launch_resolutions::resolved_occurrence(tx, occurrence)? {
        return Ok(());
    }
    // Backoff/cancellation belongs to the logical occurrence. Keep the failed
    // source generation and its first completion evidence immutable.
    let retry_source: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_attempts a JOIN harness_job_occurrences o ON o.current_job_attempt_id=a.id AND o.id=a.occurrence_id JOIN harness_job_retries retry ON retry.source_attempt_id=a.id WHERE o.id=?1 AND a.state='failed')", [occurrence], |r|r.get(0))?;
    if retry_source {
        return Ok(());
    }
    if !STATES.contains(&state) {
        return Err(Error::new("invalid_argument", "Unknown claimed job generation phase").into());
    }
    let finished = finished_at.map(i64::try_from).transpose()?;
    tx.execute("UPDATE harness_job_attempts SET state=?2,reason=?3,finished_at=COALESCE(finished_at,?4) WHERE occurrence_id=?1 AND id=(SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id=?1) AND (state<>?2 OR reason IS NOT ?3 OR (finished_at IS NULL AND ?4 IS NOT NULL))",params![occurrence,state,reason,finished])?;
    Ok(())
}
fn record(
    connection: &Connection,
    job: &str,
    occurrence: &str,
    id: &str,
    detail: bool,
) -> Result<Value> {
    let mut value = connection.query_row("SELECT ordinal,run_id,created_at,claimed_at,finished_at,state,reason FROM harness_job_attempts WHERE id=?1 AND occurrence_id=?2",params![id,occurrence],|r|Ok(json!({"id":id,"jobId":job,"occurrenceId":occurrence,"ordinal":r.get::<_,i64>(0)?,"runId":r.get::<_,Option<String>>(1)?,"createdAt":r.get::<_,i64>(2)?,"claimedAt":r.get::<_,Option<i64>>(3)?,"finishedAt":r.get::<_,Option<i64>>(4)?,"state":r.get::<_,String>(5)?,"reason":r.get::<_,Option<String>>(6)?}))).optional()?.ok_or_else(||Error::new("job_attempt_not_found","Job generation does not belong to this occurrence"))?;
    value["precheck"] =
        crate::job_precheck_records::view_attempt(connection, occurrence, id, detail)?;
    value["retry"] = crate::job_retries::view(connection, id)?;
    value["executionTimeout"] = crate::job_timeouts::view_attempt(connection, id)?;
    let (reconciliation, resolution) = crate::job_launch_resolutions::view_attempt(connection, id)?;
    value["launchReconciliation"] = reconciliation;
    value["launchResolution"] = resolution;
    for field in ["runState", "attemptId", "sessionId", "launchReceiptId"] {
        value[field] = Value::Null;
    }
    if detail {
        value["result"] = Value::Null;
        value["validation"] = Value::Null;
    }
    if let Some(run) = value["runId"].as_str().map(str::to_owned) {
        value["runState"] = connection
            .query_row("SELECT state FROM workflow_runs WHERE id=?1", [&run], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .into();
        let native = connection.query_row("SELECT a.id,a.session_id,l.operation_id,CASE WHEN ?2 THEN a.result END,CASE WHEN ?2 THEN a.validation END FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id LEFT JOIN workflow_launches l ON l.attempt_id=a.id WHERE t.run_id=?1 ORDER BY a.ordinal DESC,a.rowid DESC LIMIT 1",params![run,detail],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).optional()?;
        if let Some((attempt, session, launch, result, validation)) = native {
            value["attemptId"] = attempt.into();
            value["sessionId"] = session.into();
            value["launchReceiptId"] = launch.into();
            if detail {
                value["result"] = result
                    .map(|text| serde_json::from_str::<Value>(&text))
                    .transpose()?
                    .unwrap_or(Value::Null);
                value["validation"] = validation
                    .map(|text| serde_json::from_str::<Value>(&text))
                    .transpose()?
                    .unwrap_or(Value::Null);
            }
        }
    }
    Ok(value)
}
/// Authorization is performed by the parent job request; tuple membership is
/// still checked here, so an ID from another occurrence cannot leak evidence.
pub fn view(
    connection: &Connection,
    job: &str,
    occurrence: &str,
    attempt: Option<&str>,
    offset: u16,
) -> Result<Value> {
    if offset > 4096 || (attempt.is_some() && offset != 0) {
        return Err(Error::new("invalid_argument", "Invalid job generation page offset").into());
    }
    let member: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE id=?1 AND job_id=?2)",
        params![occurrence, job],
        |r| r.get(0),
    )?;
    if !member {
        return Err(Error::new(
            "occurrence_not_found",
            "Occurrence does not belong to this job",
        )
        .into());
    }
    if let Some(attempt) = attempt {
        return Ok(json!({"jobAttempt":record(connection,job,occurrence,attempt,true)?}));
    }
    let mut query = connection.prepare("SELECT id FROM harness_job_attempts WHERE occurrence_id=?1 ORDER BY ordinal DESC LIMIT 9 OFFSET ?2")?;
    let ids = query
        .query_map(params![occurrence, offset], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let rows = ids
        .iter()
        .take(8)
        .map(|id| record(connection, job, occurrence, id, false))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"jobAttempts":rows,"nextOffset":(ids.len()>8).then_some(offset+8)}))
}
