//! Owner cancellation intent fences admissions before asynchronous native cleanup.
use crate::{api_error::Error, job_definitions, orchestration::Actor};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub struct Claim {
    pub occurrence: String,
    pub token: String,
    pub issuer: String,
    pub run: String,
    pub key: String,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_job_cancellations(occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),issuer TEXT NOT NULL,state TEXT NOT NULL,requested_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,reason TEXT,control_key TEXT NOT NULL,control_id TEXT,token TEXT);
        CREATE INDEX IF NOT EXISTS harness_job_cancellations_pending ON harness_job_cancellations(state);
        CREATE INDEX IF NOT EXISTS harness_job_occurrences_run ON harness_job_occurrences(run_id) WHERE run_id IS NOT NULL;")?;
    Ok(())
}
pub fn view(connection: &Connection, occurrence: &str) -> Result<Value> {
    Ok(connection.query_row("SELECT state,requested_at,observed_at,reason,control_key,control_id FROM harness_job_cancellations WHERE occurrence_id=?1",[occurrence],|r|Ok(json!({"state":r.get::<_,String>(0)?,"requestedAt":r.get::<_,i64>(1)?,"observedAt":r.get::<_,i64>(2)?,"reason":r.get::<_,Option<String>>(3)?,"controlKey":r.get::<_,String>(4)?,"controlId":r.get::<_,Option<String>>(5)?}))).optional()?.unwrap_or(Value::Null))
}
/// Applies even after completion: a canceled occurrence's run is never reused.
/// Human direct PTY input does not pass through this automated admission fence.
pub fn guard_run(connection: &Connection, run: &str) -> Result<()> {
    let canceled:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_cancellations c JOIN harness_job_occurrences o ON o.id=c.occurrence_id WHERE o.run_id=?1) OR EXISTS(SELECT 1 FROM harness_job_cancellations c JOIN harness_job_attempts a ON a.occurrence_id=c.occurrence_id WHERE a.run_id=?1)",[run],|r|r.get(0))?;
    if canceled {
        return Err(Error::new(
            "job_canceled",
            "Owner canceled this job occurrence; no further automated admission is allowed",
        )
        .into());
    }
    crate::job_attempts::guard_run(connection, run)
}
pub fn accept(
    tx: &Transaction<'_>,
    actor: &Actor,
    job: &str,
    occurrence: &str,
    now: u64,
) -> Result<Value> {
    let current = job_definitions::occurrence(tx, job, occurrence, true)?;
    if !current["cancellation"].is_null() {
        return Err(Error::new("cancellation_exists", "Inspect the accepted cancellation and its original mutation; cleanup is never repeated by a new key").into());
    }
    if !matches!(
        current["state"].as_str(),
        Some(
            "queued"
                | "dispatching"
                | "prechecking"
                | "running"
                | "needsValidation"
                | "reconcile"
                | "retryWaiting"
        )
    ) {
        return Err(Error::new(
            "occurrence_conflict",
            "A terminal occurrence cannot accept a new cancellation",
        )
        .into());
    }
    let waiting = crate::job_retries::cancel_waiting(tx, occurrence, now)?;
    let run = current["runId"].as_str();
    if let Some(run) = run.filter(|_| !waiting) {
        let state: String =
            tx.query_row("SELECT state FROM workflow_runs WHERE id=?1", [run], |r| {
                r.get(0)
            })?;
        if matches!(state.as_str(), "succeeded" | "canceled" | "stopped") {
            return Err(Error::new(
                "occurrence_conflict",
                "The bound run is terminal; cancellation cannot rewrite its result",
            )
            .into());
        }
    }
    let (state, phase, finished, reason) = if waiting {
        ("completed", "canceled", true, "owner_canceled")
    } else if run.is_some() {
        ("requested", "canceling", false, "owner_canceled")
    } else if current["state"] == "prechecking" {
        ("awaitingPrecheck", "canceling", false, "owner_canceled")
    } else if current["state"] == "reconcile" {
        ("unconfirmed", "reconcile", false, "effects_unconfirmed")
    } else {
        ("completed", "canceled", true, "owner_canceled")
    };
    tx.execute("INSERT INTO harness_job_cancellations(occurrence_id,issuer,state,requested_at,observed_at,reason,control_key) VALUES(?1,?2,?3,?4,?4,?5,?6)", params![occurrence,actor.issuer,state,now as i64,reason,format!("job-cancel:{occurrence}")])?;
    job_definitions::transition(tx, occurrence, phase, Some(reason), finished, now)?;
    Ok(json!({"occurrence":job_definitions::occurrence(tx,job,occurrence,true)?}))
}
pub fn requested(connection: &Connection, occurrence: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=?1)",
        [occurrence],
        |r| r.get(0),
    )?)
}
pub fn claims(tx: &Transaction<'_>, slots: u8, now: u64) -> Result<Vec<Claim>> {
    let mut statement=tx.prepare("SELECT c.occurrence_id,c.issuer,o.run_id,c.control_key FROM harness_job_cancellations c JOIN harness_job_occurrences o ON o.id=c.occurrence_id WHERE c.state='requested' ORDER BY c.requested_at,c.rowid LIMIT ?1")?;
    let rows = statement
        .query_map([slots.min(2)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut claims = Vec::new();
    for (occurrence, issuer, run, key) in rows {
        let token = hex::encode(crate::wire::random::<32>());
        tx.execute("UPDATE harness_job_cancellations SET state='dispatching',token=?2,observed_at=?3 WHERE occurrence_id=?1",params![occurrence,token,now as i64])?;
        claims.push(Claim {
            occurrence,
            token,
            issuer,
            run,
            key,
        });
    }
    Ok(claims)
}
pub fn finish(tx: &Transaction<'_>, claim: &Claim, result: Option<Value>, now: u64) -> Result<()> {
    let matches:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_cancellations c JOIN harness_job_occurrences o ON o.id=c.occurrence_id WHERE c.occurrence_id=?1 AND c.token=?2 AND c.state='dispatching' AND o.run_id=?3)",params![claim.occurrence,claim.token,claim.run],|r|r.get(0))?;
    if !matches {
        return Err(Error::new(
            "stale_cancellation",
            "Cancellation dispatch was already observed or invalidated",
        )
        .into());
    }
    let control = result
        .as_ref()
        .filter(|r| r["run"]["id"] == claim.run && r["control"]["kind"] == "cancel")
        .and_then(|r| r["control"]["id"].as_str());
    tx.execute("UPDATE harness_job_cancellations SET token=NULL,control_id=?2,state='unconfirmed',reason='cancel_dispatch_unconfirmed',observed_at=?3 WHERE occurrence_id=?1",params![claim.occurrence,control,now as i64])?;
    refresh(tx, now)?;
    Ok(())
}
/// Reads existing native evidence only; never claims or repeats a stop operation.
pub fn refresh(tx: &Transaction<'_>, now: u64) -> Result<()> {
    let mut statement=tx.prepare("SELECT c.occurrence_id,w.id,w.state FROM harness_job_cancellations c JOIN harness_job_occurrences o ON o.id=c.occurrence_id JOIN workflow_mutations m ON m.issuer=c.issuer AND m.key=c.control_key JOIN workflow_controls w ON w.id=json_extract(m.view,'$.control.id') AND w.run_id=o.run_id AND w.kind='cancel' WHERE c.token IS NULL AND c.state NOT IN ('completed','awaitingPrecheck')")?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (occurrence, control, state) in rows {
        let (phase, reason, finished) = match state.as_str() {
            "completed" => ("canceled", "owner_canceled", true),
            "blocked" => ("canceling", "cancel_blocked", false),
            "unconfirmed" => ("reconcile", "cancel_unconfirmed", false),
            _ => ("canceling", "cancel_pending", false),
        };
        tx.execute("UPDATE harness_job_cancellations SET state=?2,control_id=?3,reason=?4,observed_at=CASE WHEN state<>?2 OR control_id IS NOT ?3 OR reason IS NOT ?4 THEN ?5 ELSE observed_at END WHERE occurrence_id=?1",params![occurrence,state,control,reason,now as i64])?;
        job_definitions::transition(tx, &occurrence, phase, Some(reason), finished, now)?;
    }
    // Another explicit owner control may have stopped this exact run while our
    // admission was waiting or uncertain. Its latest completed control and
    // terminal run state are exit evidence; neither alone is sufficient.
    let observed = {
        let mut q=tx.prepare("SELECT c.occurrence_id,w.id FROM harness_job_cancellations c JOIN harness_job_occurrences o ON o.id=c.occurrence_id JOIN workflow_runs r ON r.id=o.run_id JOIN workflow_controls w ON w.id=(SELECT id FROM workflow_controls WHERE run_id=o.run_id ORDER BY rowid DESC LIMIT 1) WHERE c.token IS NULL AND c.state NOT IN ('completed','abandoned','awaitingPrecheck') AND r.state IN ('canceled','stopped') AND w.state='completed'")?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (occurrence, control) in observed {
        tx.execute("UPDATE harness_job_cancellations SET state='completed',control_id=?2,reason='run_termination_observed',observed_at=?3 WHERE occurrence_id=?1",params![occurrence,control,now as i64])?;
        job_definitions::transition(
            tx,
            &occurrence,
            "canceled",
            Some("run_termination_observed"),
            true,
            now,
        )?;
    }
    // A dispatch error before any control acceptance is still not exit proof.
    let unmatched = {
        let mut q = tx.prepare("SELECT o.id FROM harness_job_occurrences o JOIN harness_job_cancellations c ON c.occurrence_id=o.id WHERE c.state='unconfirmed' AND c.control_id IS NULL AND o.state='canceling'")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for occurrence in unmatched {
        job_definitions::transition(
            tx,
            &occurrence,
            "reconcile",
            Some("cancel_dispatch_unconfirmed"),
            false,
            now,
        )?;
    }
    Ok(())
}
pub fn precheck_finished(
    tx: &Transaction<'_>,
    occurrence: &str,
    confirmed: bool,
    now: u64,
) -> Result<()> {
    tx.execute("UPDATE harness_job_cancellations SET state=?2,reason=?3,observed_at=?4 WHERE occurrence_id=?1 AND state='awaitingPrecheck'",params![occurrence,if confirmed {"completed"}else{"unconfirmed"},if confirmed {"owner_canceled"}else{"cleanup_unconfirmed"},now as i64])?;
    Ok(())
}
pub fn recover(tx: &Transaction<'_>, now: u64) -> Result<()> {
    // Even an unclaimed accepted native cancellation remains fenced. A restart
    // cannot safely distinguish setup/stop effects from the old host generation.
    tx.execute("UPDATE harness_job_cancellations SET token=NULL,state='unconfirmed',reason='host_restarted',observed_at=?1 WHERE state NOT IN ('completed','blocked','abandoned')",[now as i64])?;
    Ok(())
}
