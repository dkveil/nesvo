//! Durable precheck authorization/outcome, before any model dispatch.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    job_definitions::{Reply, Spec},
    job_prechecks::{self, Outcome, OutcomeState},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

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
    let job: String = tx.query_row(
        "SELECT job_id FROM harness_job_occurrences WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    append_transaction(
        tx,
        vec![Observation {
            session_id: None,
            kind: "job.changed",
            at: now,
            payload: json!({"jobId":job,"occurrenceId":id,"phase":state}),
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
    let approval = tx
        .query_row(
            "SELECT spec,digest,enabled FROM harness_precheck_approvals WHERE id=?1",
            [&approval_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?;
    let command = approval
        .as_ref()
        .filter(|(_, _, enabled)| *enabled)
        .and_then(|(spec, digest, _)| {
            let parsed = serde_json::from_str::<job_prechecks::Command>(spec).ok()?;
            (job_prechecks::digest(&parsed).ok().as_ref() == Some(digest)).then_some(parsed)
        });
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
    tx.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,spec,state,reason,started_at,finished_at,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?7)",params![id,approval_id,approval.as_ref().map(|r|r.1.as_str()),approval.as_ref().map(|r|r.0.as_str()),state,reason,now as i64,command.is_none().then_some(now as i64)])?;
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
    mut result: Outcome,
    now: u64,
) -> Result<(bool, &'static str, Option<&'static str>)> {
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_prechecks p JOIN harness_job_occurrences o ON o.id=p.occurrence_id WHERE o.id=?1 AND o.state='prechecking' AND o.run_id IS NULL AND p.state='running')",[id],|r|r.get(0))?;
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
    let (passed, state, reason) = match result.state {
        OutcomeState::Passed => (true, "dispatching", None),
        OutcomeState::Skipped => (false, "skipped", Some("precheck_skip")),
        OutcomeState::Unknown => (false, "reconcile", Some("precheck_unconfirmed")),
        OutcomeState::TimedOut => (false, "failed", Some("precheck_timeout")),
        OutcomeState::OutputLimit => (false, "failed", Some("precheck_output_limit")),
        OutcomeState::Refused => (false, "failed", Some("precheck_refused")),
        OutcomeState::Failed => (false, "failed", Some("precheck_exit_failed")),
    };
    let recorded = serde_json::to_value(result.state)?;
    tx.execute("UPDATE harness_job_prechecks SET state=?2,reason=?3,observed_at=?4,finished_at=?6,result=?5 WHERE occurrence_id=?1",params![id,recorded.as_str(),result.reason,now as i64,serde_json::to_string(&result)?,result.cleanup_confirmed.then_some(now as i64)])?;
    Ok((passed, state, reason))
}
