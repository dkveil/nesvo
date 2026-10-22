//! Durable precheck authorization/outcome, before any model dispatch.
use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    job_attempts::{self, Dispatch},
    job_definitions::{Reply, Spec},
    job_prechecks::{self, Outcome, OutcomeState},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

/// Later generations retain their own command admission and outcome. The
/// composite journal key also prevents a row from naming a different occurrence
/// or using the legacy generation-1 storage slot.
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS harness_job_attempts_precheck_membership ON harness_job_attempts(id,occurrence_id,ordinal);
        CREATE TABLE IF NOT EXISTS harness_job_generation_prechecks(
            job_attempt_id TEXT PRIMARY KEY,
            occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
            ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 2 AND 4096),
            approval_id TEXT NOT NULL,
            approval_digest TEXT,
            approval_revision INTEGER CHECK(approval_revision>0),
            spec TEXT,
            state TEXT NOT NULL,
            reason TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            result TEXT,
            observed_at INTEGER,
            FOREIGN KEY(job_attempt_id,occurrence_id,ordinal) REFERENCES harness_job_attempts(id,occurrence_id,ordinal)
        );
        CREATE INDEX IF NOT EXISTS harness_job_generation_prechecks_occurrence
            ON harness_job_generation_prechecks(occurrence_id);",
    )?;
    Ok(())
}

fn attempt_ordinal(connection: &Connection, occurrence: &str, attempt: &str) -> Result<i64> {
    connection
        .query_row(
            "SELECT ordinal FROM harness_job_attempts WHERE id=?1 AND occurrence_id=?2",
            params![attempt, occurrence],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            Error::new(
                "job_attempt_not_found",
                "Job generation does not belong to this occurrence",
            )
            .into()
        })
}

fn current_attempt(connection: &Connection, occurrence: &str) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",
            [occurrence],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(conflict)
}

/// This read resolves only the requested journal row; it never repairs or
/// advances a claim, authorization, observation or finish timestamp.
pub fn view_attempt(
    connection: &Connection,
    occurrence: &str,
    attempt: &str,
    detail: bool,
) -> Result<Value> {
    if attempt_ordinal(connection, occurrence, attempt)? == 1 {
        return view(connection, occurrence, detail);
    }
    let record = connection
        .query_row(
            "SELECT approval_id,approval_digest,approval_revision,state,reason,started_at,finished_at,result,observed_at FROM harness_job_generation_prechecks WHERE job_attempt_id=?1 AND occurrence_id=?2",
            params![attempt, occurrence],
            |row| {
                Ok((
                    json!({"approvalId":row.get::<_,String>(0)?,"approvalDigest":row.get::<_,Option<String>>(1)?,"approvalRevision":row.get::<_,Option<i64>>(2)?,"state":row.get::<_,String>(3)?,"reason":row.get::<_,String>(4)?,"authorizedAt":row.get::<_,i64>(5)?,"finishedAt":row.get::<_,Option<i64>>(6)?,"observedAt":row.get::<_,Option<i64>>(8)?}),
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((mut value, result)) = record else {
        return Ok(Value::Null);
    };
    value["result"] = result
        .map(|text| serde_json::from_str::<Value>(&text))
        .transpose()?
        .unwrap_or(Value::Null);
    if !detail && let Some(result) = value["result"].as_object_mut() {
        result.remove("stdout");
        result.remove("stderr");
    }
    Ok(value)
}

pub fn view_current(connection: &Connection, occurrence: &str, detail: bool) -> Result<Value> {
    match current_attempt(connection, occurrence)? {
        Some(attempt) => view_attempt(connection, occurrence, &attempt, detail),
        // Queued occurrences have no claim. Retain legacy pre-journal reads.
        None => view(connection, occurrence, detail),
    }
}

struct Approval {
    spec: String,
    digest: String,
    revision: i64,
    enabled: bool,
}

fn approval(connection: &Connection, id: &str) -> Result<Option<Approval>> {
    Ok(connection
        .query_row(
            "SELECT spec,digest,revision,enabled FROM harness_precheck_approvals WHERE id=?1",
            [id],
            |row| {
                Ok(Approval {
                    spec: row.get(0)?,
                    digest: row.get(1)?,
                    revision: row.get(2)?,
                    enabled: row.get(3)?,
                })
            },
        )
        .optional()?)
}

fn approved_command(approval: &Approval) -> Option<job_prechecks::Command> {
    if !approval.enabled || approval.revision < 1 {
        return None;
    }
    let command = serde_json::from_str::<job_prechecks::Command>(&approval.spec).ok()?;
    (job_prechecks::digest(&command).ok().as_deref() == Some(approval.digest.as_str()))
        .then_some(command)
}

/// Fresh availability check for retry admission. A prior passed outcome does
/// not grant permission to execute a command whose approval was revoked.
pub fn approval_ready(connection: &Connection, id: &str) -> Result<bool> {
    Ok(approval(connection, id)?
        .as_ref()
        .and_then(approved_command)
        .is_some())
}

fn guard_unbound(connection: &Connection, dispatch: &Dispatch, allowed: &[&str]) -> Result<i64> {
    job_attempts::guard(connection, dispatch, allowed)?;
    let ordinal = connection
        .query_row(
            "SELECT a.ordinal FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id WHERE o.id=?1 AND a.id=?2 AND a.dispatch_token=?3 AND o.run_id IS NULL AND a.run_id IS NULL",
            params![dispatch.occurrence, dispatch.attempt, dispatch.token],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(conflict)?;
    Ok(ordinal)
}

/// Admission writes a new command snapshot before returning the command. The
/// same generation cannot begin twice, including after an interrupted claim.
pub fn begin_attempt(tx: &Transaction<'_>, dispatch: &Dispatch, now: u64) -> Result<Reply> {
    let ordinal = guard_unbound(tx, dispatch, &["dispatching"])?;
    if crate::job_cancellations::requested(tx, &dispatch.occurrence)? {
        return Err(conflict());
    }
    if ordinal == 1 {
        return begin(tx, &dispatch.occurrence, now);
    }
    let spec: String = tx.query_row(
        "SELECT spec FROM harness_job_occurrences WHERE id=?1",
        [&dispatch.occurrence],
        |row| row.get(0),
    )?;
    let spec: Spec = serde_json::from_str(&spec)?;
    let Some(approval_id) = spec.precheck_id else {
        return Ok(Reply::Precheck(None));
    };
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_generation_prechecks WHERE job_attempt_id=?1)",
        [&dispatch.attempt],
        |row| row.get(0),
    )?;
    if exists {
        return Err(conflict());
    }
    let approval = approval(tx, &approval_id)?;
    let command = approval.as_ref().and_then(approved_command);
    let (state, reason) = if command.is_some() {
        ("running", "authorized")
    } else {
        ("refused", "approval_unavailable")
    };
    tx.execute(
        "INSERT INTO harness_job_generation_prechecks(job_attempt_id,occurrence_id,ordinal,approval_id,approval_digest,approval_revision,spec,state,reason,started_at,finished_at,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?10)",
        params![dispatch.attempt,dispatch.occurrence,ordinal,approval_id,approval.as_ref().map(|row|row.digest.as_str()),approval.as_ref().filter(|row|row.revision>0).map(|row|row.revision),approval.as_ref().map(|row|row.spec.as_str()),state,reason,now as i64,command.is_none().then_some(now as i64)],
    )?;
    if let Some(command) = command {
        phase(tx, &dispatch.occurrence, "prechecking", now)?;
        Ok(Reply::Precheck(Some(Box::new(command))))
    } else {
        tx.execute(
            "UPDATE harness_job_occurrences SET reason='precheck_not_trusted',finished_at=?2 WHERE id=?1",
            params![dispatch.occurrence, now as i64],
        )?;
        phase(tx, &dispatch.occurrence, "failed", now)?;
        Ok(Reply::PrecheckPassed(false))
    }
}

pub fn view(connection: &Connection, id: &str, detail: bool) -> Result<Value> {
    let record=connection.query_row("SELECT approval_id,approval_digest,state,reason,started_at,finished_at,result,observed_at FROM harness_job_prechecks WHERE occurrence_id=?1",[id],|r|Ok((json!({"approvalId":r.get::<_,String>(0)?,"approvalDigest":r.get::<_,Option<String>>(1)?,"state":r.get::<_,String>(2)?,"reason":r.get::<_,String>(3)?,"authorizedAt":r.get::<_,i64>(4)?,"finishedAt":r.get::<_,Option<i64>>(5)?,"observedAt":r.get::<_,Option<i64>>(7)?}),r.get::<_,Option<String>>(6)?))).optional()?;
    let Some((mut view, result)) = record else {
        return Ok(Value::Null);
    };
    if let Some(result) = result {
        let mut result: Value = serde_json::from_str(&result)?;
        if !detail && let Some(object) = result.as_object_mut() {
            object.remove("stdout");
            object.remove("stderr");
        }
        view["result"] = result;
    } else {
        view["result"] = Value::Null;
    }
    Ok(view)
}
fn conflict() -> anyhow::Error {
    Error::new(
        "occurrence_conflict",
        "Precheck phase changed; inspect the original occurrence, never repeat the command",
    )
    .into()
}
fn phase(tx: &Transaction<'_>, id: &str, state: &str, now: u64) -> Result<()> {
    tx.execute(
        "UPDATE harness_job_occurrences SET state=?2 WHERE id=?1",
        params![id, state],
    )?;
    let (reason, finished_at): (Option<String>, Option<i64>) = tx.query_row(
        "SELECT reason,finished_at FROM harness_job_occurrences WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    crate::job_attempts::sync(
        tx,
        id,
        state,
        reason.as_deref(),
        finished_at.map(u64::try_from).transpose()?,
    )?;
    let job: String = tx.query_row(
        "SELECT job_id FROM harness_job_occurrences WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    append_transaction(
        tx,
        vec![Observation {
            session_id: None,
            at: now,
            event: DomainEvent::JobChanged(model::JobChanged {
                job_id: job,
                occurrence_id: Some(id.into()),
                phase: state.into(),
            }),
        }],
    )?;
    Ok(())
}
pub fn begin(tx: &Transaction<'_>, id: &str, now: u64) -> Result<Reply> {
    let row = tx
        .query_row(
            "SELECT spec,state,run_id FROM harness_job_occurrences WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(conflict)?;
    if row.1 != "dispatching" || row.2.is_some() {
        return Err(conflict());
    }
    let spec: Spec = serde_json::from_str(&row.0)?;
    let Some(approval_id) = spec.precheck_id else {
        return Ok(Reply::Precheck(None));
    };
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1)",
        [id],
        |r| r.get(0),
    )?;
    if exists {
        return Err(conflict());
    }
    let approval = approval(tx, &approval_id)?;
    let command = approval.as_ref().and_then(approved_command);
    let state = if command.is_some() {
        "running"
    } else {
        "refused"
    };
    let reason = if command.is_some() {
        "authorized"
    } else {
        "approval_unavailable"
    };
    tx.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,spec,state,reason,started_at,finished_at,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?7)",params![id,approval_id,approval.as_ref().map(|r|r.digest.as_str()),approval.as_ref().map(|r|r.spec.as_str()),state,reason,now as i64,command.is_none().then_some(now as i64)])?;
    if let Some(command) = command {
        phase(tx, id, "prechecking", now)?;
        Ok(Reply::Precheck(Some(Box::new(command))))
    } else {
        tx.execute("UPDATE harness_job_occurrences SET reason='precheck_not_trusted',finished_at=?2 WHERE id=?1",params![id,now as i64])?;
        phase(tx, id, "failed", now)?;
        Ok(Reply::PrecheckPassed(false))
    }
}
pub fn finish(
    tx: &Transaction<'_>,
    id: &str,
    result: Outcome,
    now: u64,
) -> Result<(bool, &'static str, Option<&'static str>)> {
    finish_record(tx, id, None, true, result, now)
}

/// Completion must still possess the current producer token and exact journal
/// membership. An old callback cannot settle the next generation or its cancel.
pub fn finish_attempt(
    tx: &Transaction<'_>,
    dispatch: &Dispatch,
    result: Outcome,
    now: u64,
) -> Result<(bool, &'static str, Option<&'static str>)> {
    let ordinal = guard_unbound(tx, dispatch, &["prechecking", "canceling"])?;
    if ordinal == 1 {
        return finish(tx, &dispatch.occurrence, result, now);
    }
    finish_record(
        tx,
        &dispatch.occurrence,
        Some(&dispatch.attempt),
        false,
        result,
        now,
    )
}

fn finish_record(
    tx: &Transaction<'_>,
    id: &str,
    attempt: Option<&str>,
    legacy: bool,
    mut result: Outcome,
    now: u64,
) -> Result<(bool, &'static str, Option<&'static str>)> {
    let valid: bool = if legacy {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_prechecks p JOIN harness_job_occurrences o ON o.id=p.occurrence_id WHERE o.id=?1 AND o.state IN ('prechecking','canceling') AND o.run_id IS NULL AND p.state='running')",[id],|r|r.get(0))?
    } else {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_generation_prechecks WHERE occurrence_id=?1 AND job_attempt_id=?2 AND state='running')",params![id,attempt],|r|r.get(0))?
    };
    if !valid {
        return Err(conflict());
    }
    if result.stdout.len() > 512 || result.stderr.len() > 512 || result.reason.len() > 128 {
        return Err(Error::new(
            "invalid_argument",
            "Precheck result exceeds retention bounds",
        )
        .into());
    }
    if !result.cleanup_confirmed {
        result.state = OutcomeState::Unknown;
        result.reason = "cleanup_unconfirmed".into();
    }
    if matches!(result.state, OutcomeState::Passed | OutcomeState::Skipped)
        && result.command_started != Some(true)
    {
        result.state = OutcomeState::Unknown;
        result.reason = "execution_unconfirmed".into();
    }
    let (mut passed, mut state, mut reason) = match result.state {
        OutcomeState::Passed => (true, "dispatching", None),
        OutcomeState::Skipped => (false, "skipped", Some("precheck_skip")),
        OutcomeState::Unknown => (false, "reconcile", Some("precheck_unconfirmed")),
        OutcomeState::TimedOut => (false, "failed", Some("precheck_timeout")),
        OutcomeState::OutputLimit => (false, "failed", Some("precheck_output_limit")),
        OutcomeState::Refused => (false, "failed", Some("precheck_refused")),
        OutcomeState::Failed => (false, "failed", Some("precheck_exit_failed")),
    };
    if crate::job_cancellations::requested(tx, id)? {
        let confirmed = result.cleanup_confirmed && result.state != OutcomeState::Unknown;
        if let Some(attempt) = attempt {
            crate::job_cancellations::precheck_finished_attempt(tx, id, attempt, confirmed, now)?;
        } else {
            crate::job_cancellations::precheck_finished(tx, id, confirmed, now)?;
        }
        passed = false;
        state = if confirmed { "canceled" } else { "reconcile" };
        reason = Some(if confirmed {
            "owner_canceled"
        } else {
            "precheck_unconfirmed"
        });
    }
    let recorded = serde_json::to_value(result.state)?;
    if legacy {
        tx.execute("UPDATE harness_job_prechecks SET state=?2,reason=?3,observed_at=?4,finished_at=?6,result=?5 WHERE occurrence_id=?1",params![id,recorded.as_str(),result.reason,now as i64,serde_json::to_string(&result)?,result.cleanup_confirmed.then_some(now as i64)])?;
    } else {
        tx.execute("UPDATE harness_job_generation_prechecks SET state=?3,reason=?4,observed_at=?5,finished_at=?7,result=?6 WHERE occurrence_id=?1 AND job_attempt_id=?2",params![id,attempt,recorded.as_str(),result.reason,now as i64,serde_json::to_string(&result)?,result.cleanup_confirmed.then_some(now as i64)])?;
    }
    Ok((passed, state, reason))
}

/// Restart only marks the current running command unknown. Historical command
/// evidence, including its finish and retained output, remains immutable.
pub fn recover_current(tx: &Transaction<'_>, occurrence: &str, now: u64) -> Result<()> {
    let Some(attempt) = current_attempt(tx, occurrence)? else {
        tx.execute("UPDATE harness_job_prechecks SET state='unknown',reason='host_restarted',observed_at=?2,finished_at=NULL WHERE occurrence_id=?1 AND state='running'",params![occurrence,now as i64])?;
        return Ok(());
    };
    if attempt_ordinal(tx, occurrence, &attempt)? == 1 {
        tx.execute("UPDATE harness_job_prechecks SET state='unknown',reason='host_restarted',observed_at=?2,finished_at=NULL WHERE occurrence_id=?1 AND state='running'",params![occurrence,now as i64])?;
    } else {
        tx.execute("UPDATE harness_job_generation_prechecks SET state='unknown',reason='host_restarted',observed_at=?3,finished_at=NULL WHERE occurrence_id=?1 AND job_attempt_id=?2 AND state='running'",params![occurrence,attempt,now as i64])?;
    }
    Ok(())
}

/// The caller checks owner acknowledgement and occurrence reconciliation. A
/// repeated digest never substitutes for the exact later generation identity.
pub fn abandon(
    tx: &Transaction<'_>,
    occurrence: &str,
    attempt: Option<&str>,
    expected_digest: &str,
    now: u64,
) -> Result<()> {
    let current = current_attempt(tx, occurrence)?;
    let legacy = match current.as_deref() {
        Some(current) => {
            if attempt.is_some_and(|attempt| attempt != current) {
                return Err(conflict());
            }
            let legacy = attempt_ordinal(tx, occurrence, current)? == 1;
            if !legacy && attempt != Some(current) {
                return Err(conflict());
            }
            legacy
        }
        None if attempt.is_none() => true,
        None => return Err(conflict()),
    };
    let changed = if legacy {
        tx.execute("UPDATE harness_job_prechecks SET state='abandoned',reason='owner_abandoned',observed_at=?3 WHERE occurrence_id=?1 AND approval_digest=?2 AND state IN ('unknown','passed')",params![occurrence,expected_digest,now as i64])?
    } else {
        tx.execute("UPDATE harness_job_generation_prechecks SET state='abandoned',reason='owner_abandoned',observed_at=?4 WHERE occurrence_id=?1 AND job_attempt_id=?2 AND approval_digest=?3 AND state IN ('unknown','passed')",params![occurrence,current,expected_digest,now as i64])?
    };
    if changed != 1 {
        return Err(conflict());
    }
    Ok(())
}

/// A committed result is checked against its own admission snapshot, not a
/// previous generation's pass or a later change to approval availability.
pub fn passed_current(connection: &Connection, occurrence: &str) -> Result<bool> {
    let Some(attempt) = current_attempt(connection, occurrence)? else {
        return Ok(false);
    };
    let ordinal = attempt_ordinal(connection, occurrence, &attempt)?;
    let record = if ordinal == 1 {
        connection.query_row("SELECT approval_id,approval_digest,spec,result FROM harness_job_prechecks WHERE occurrence_id=?1 AND state='passed' AND finished_at IS NOT NULL",[occurrence],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).optional()?
    } else {
        connection.query_row("SELECT approval_id,approval_digest,spec,result FROM harness_job_generation_prechecks WHERE occurrence_id=?1 AND job_attempt_id=?2 AND state='passed' AND finished_at IS NOT NULL AND approval_revision>0",params![occurrence,attempt],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).optional()?
    };
    let Some((approval_id, Some(digest), Some(spec), Some(result))) = record else {
        return Ok(false);
    };
    let occurrence_spec: String = connection.query_row(
        "SELECT spec FROM harness_job_occurrences WHERE id=?1",
        [occurrence],
        |row| row.get(0),
    )?;
    let occurrence_spec: Spec = serde_json::from_str(&occurrence_spec)?;
    if occurrence_spec.precheck_id.as_deref() != Some(approval_id.as_str()) {
        return Ok(false);
    }
    let Ok(command) = serde_json::from_str::<job_prechecks::Command>(&spec) else {
        return Ok(false);
    };
    if job_prechecks::digest(&command).ok().as_deref() != Some(digest.as_str()) {
        return Ok(false);
    }
    let Ok(result) = serde_json::from_str::<Value>(&result) else {
        return Ok(false);
    };
    Ok(result["state"] == "passed"
        && result["commandStarted"] == true
        && result["cleanupConfirmed"] == true)
}
