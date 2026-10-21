//! Attempt ownership and explicit results; no native effects or inferred success.
use crate::{
    api_error::Error,
    orchestration::{Actor, Request, Scope, TaskSpec},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Succeeded,
    Failed,
    Blocked,
    Canceled,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckOutcome {
    Passed,
    Failed,
    Skipped,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Check {
    pub name: String,
    pub outcome: CheckOutcome,
    pub details: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultSpec {
    pub outcome: Outcome,
    pub summary: String,
    pub files: Vec<String>,
    pub artifacts: Vec<String>,
    pub checks: Vec<Check>,
    pub limitations: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationSpec {
    pub passed: bool,
    pub summary: String,
    pub checks: Vec<Check>,
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
fn plain(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
fn checks_valid(checks: &[Check]) -> bool {
    checks.len() <= 16
        && checks
            .iter()
            .all(|c| plain(&c.name, 128) && plain(&c.details, 1024))
}
pub(crate) fn task(connection: &Connection, run_id: &str, task_id: &str) -> Result<TaskSpec> {
    let source: Option<String> = connection
        .query_row(
            "SELECT spec FROM workflow_tasks WHERE id=?1 AND run_id=?2",
            params![task_id, run_id],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(
        &source.ok_or_else(|| Error::new("task_not_found", "Task is unavailable in this run"))?,
    )
    .map_err(Into::into)
}
fn latest(connection: &Connection, task_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT id FROM workflow_attempts WHERE task_id=?1 ORDER BY ordinal DESC LIMIT 1",
            [task_id],
            |r| r.get(0),
        )
        .optional()?)
}
fn attempt(connection: &Connection, id: &str) -> Result<Value> {
    type Row = (
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let record:Option<Row>=connection.query_row("SELECT id,task_id,ordinal,session_id,state,result,validation FROM workflow_attempts WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    let Some((id, task, ordinal, session, state, result, validation)) = record else {
        return Err(Error::new("attempt_not_found", "Attempt is unavailable").into());
    };
    let decode = |source: Option<String>| -> Result<Value> {
        Ok(source
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null))
    };
    Ok(
        json!({"id":id,"taskId":task,"ordinal":ordinal,"sessionId":session,"state":state,"result":decode(result)?,"validation":decode(validation)?,"decisionGate":crate::workflow_decisions::summary(connection,&id)?,"launch":crate::workflow_launches::summary(connection,&id)?,"delivery":crate::workflow_delivery::summary(connection,&id)?}),
    )
}
pub fn summaries(connection: &Connection, run_id: &str) -> Result<HashMap<String, Value>> {
    let mut statement=connection.prepare("SELECT a.id,a.task_id,a.ordinal,a.session_id,a.state,json_extract(a.result,'$.outcome') FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=?1 AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=a.task_id)")?;
    Ok(statement.query_map([run_id],|r|Ok((r.get::<_,String>(1)?,json!({"id":r.get::<_,String>(0)?,"ordinal":r.get::<_,i64>(2)?,"sessionId":r.get::<_,String>(3)?,"state":r.get::<_,String>(4)?,"reportedOutcome":r.get::<_,Option<String>>(5)?}))))?.collect::<rusqlite::Result<_>>()?)
}
pub fn context(
    connection: &Connection,
    actor: &Actor,
    expected_attempt: Option<&str>,
) -> Result<Value> {
    let session = actor.worker()?;
    let id: Option<String> = connection
        .query_row(
            "SELECT id FROM workflow_attempts WHERE session_id=?1 ORDER BY ordinal DESC LIMIT 1",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    let id =
        id.ok_or_else(|| Error::new("attempt_not_found", "This worker has no assigned attempt"))?;
    if expected_attempt.is_some_and(|expected| expected != id) {
        return Err(Error::new(
            "stale_attempt",
            "Result must identify this worker's exact current attempt",
        )
        .into());
    }
    let a = attempt(connection, &id)?;
    let task_id = a["taskId"]
        .as_str()
        .ok_or_else(|| invalid("Stored attempt has no task identity"))?;
    if latest(connection, task_id)?.as_deref() != Some(&id) {
        return Err(Error::new("stale_attempt", "A newer attempt superseded this worker").into());
    }
    let run_id: String = connection.query_row(
        "SELECT run_id FROM workflow_tasks WHERE id=?1",
        [task_id],
        |r| r.get(0),
    )?;
    let spec = task(connection, &run_id, task_id)?;
    let mut run=connection.query_row("SELECT id,title,revision,state FROM workflow_runs WHERE id=?1",[&run_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"state":r.get::<_,String>(3)?})))?;
    run["budget"] = crate::workflow_budget::snapshot(
        connection,
        &run_id,
        run["state"].as_str().unwrap_or("unknown"),
    )?;
    Ok(
        json!({"run":run,"task":{"id":task_id,"key":spec.key,"title":spec.title,"instruction":spec.instruction},"attempt":a,"constraints":{"policy":crate::workflow_context::summary(connection,&run_id)?,"records":crate::workflow_context::records(connection,&run_id)?}}),
    )
}
pub fn history(
    connection: &Connection,
    actor: &Actor,
    run_id: &str,
    task_id: &str,
    offset: usize,
) -> Result<Value> {
    let run = crate::orchestration::run(connection, actor, run_id)?;
    let spec = task(connection, run_id, task_id)?;
    if offset > 16 {
        return Err(invalid("Attempt history offset exceeds 16"));
    }
    let mut statement = connection.prepare(
        "SELECT id FROM workflow_attempts WHERE task_id=?1 ORDER BY ordinal LIMIT 5 OFFSET ?2",
    )?;
    let mut ids = statement
        .query_map(params![task_id, offset as i64], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = ids.len() > 4;
    ids.truncate(4);
    let records = ids
        .iter()
        .map(|id| attempt(connection, id))
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"run":run,"task":{"id":task_id,"spec":spec},"attempts":records,"nextOffset":more.then_some(offset+4)}),
    )
}
fn revision(
    connection: &Connection,
    actor: &Actor,
    run_id: &str,
    expected: u64,
    states: &[&str],
) -> Result<Value> {
    let run = crate::orchestration::run(connection, actor, run_id)?;
    if run["revision"].as_u64() != Some(expected) {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect its current revision",
        )
        .into());
    }
    if !run["state"]
        .as_str()
        .is_some_and(|state| states.contains(&state))
    {
        return Err(Error::new("run_state_conflict", "Run is not in the required state").into());
    }
    Ok(run)
}
pub(crate) fn active_attempt(connection: &Connection, run_id: &str, id: &str) -> Result<Value> {
    let a = attempt(connection, id)?;
    let task_id = a["taskId"]
        .as_str()
        .ok_or_else(|| invalid("Stored attempt has no task identity"))?;
    task(connection, run_id, task_id)?;
    if latest(connection, task_id)?.as_deref() != Some(id) {
        return Err(Error::new("stale_attempt", "A newer attempt owns this task").into());
    }
    Ok(a)
}
pub fn mutate(
    connection: &rusqlite::Transaction<'_>,
    actor: &Actor,
    request: &Request,
    now: u64,
) -> Result<(String, &'static str)> {
    let (run_id, kind) = match request {
        Request::Activate {
            run_id,
            expected_revision,
            ..
        } => {
            revision(connection, actor, run_id, *expected_revision, &["draft"])?;
            let count: i64 = connection.query_row(
                "SELECT count(*) FROM workflow_tasks WHERE run_id=?1",
                [run_id],
                |r| r.get(0),
            )?;
            if count == 0 {
                return Err(invalid("An empty draft cannot be activated"));
            }
            crate::workflow_budget::activate(connection, run_id, now)?;
            connection.execute(
                "UPDATE workflow_runs SET state='active' WHERE id=?1",
                [run_id],
            )?;
            (run_id.clone(), "run.activated")
        }
        Request::Assign {
            run_id,
            task_id,
            session_id,
            expected_revision,
            ..
        } => {
            revision(connection, actor, run_id, *expected_revision, &["active"])?;
            let spec = task(connection, run_id, task_id)?;
            let summaries = summaries(connection, run_id)?;
            for key in &spec.dependencies {
                let id: String = connection.query_row(
                    "SELECT id FROM workflow_tasks WHERE run_id=?1 AND task_key=?2",
                    params![run_id, key],
                    |r| r.get(0),
                )?;
                if !summaries
                    .get(&id)
                    .is_some_and(|a| a["state"] == "succeeded")
                {
                    return Err(Error::new(
                        "dependencies_unmet",
                        "A dependency has no accepted validated result",
                    )
                    .into());
                }
            }
            let current = summaries.get(task_id);
            if current.is_some_and(|a| {
                !matches!(
                    a["state"].as_str(),
                    Some("failed" | "stopped" | "launchFailed")
                )
            }) {
                return Err(Error::new(
                    "attempt_state_conflict",
                    "Task already has a current attempt or accepted result",
                )
                .into());
            }
            let ordinal = current.map_or(1, |a| a["ordinal"].as_i64().unwrap_or(0) + 1);
            crate::job_timeouts::guard_run(
                connection,
                run_id,
                now,
                crate::event_log::monotonic_millis(),
            )?;
            crate::workflow_budget::admit_attempt(connection, run_id, ordinal)?;
            let count: i64 =
                connection.query_row("SELECT count(*) FROM workflow_attempts", [], |r| r.get(0))?;
            if ordinal > 16 || count >= 4096 {
                return Err(Error::new(
                    "busy",
                    "Attempt history capacity exhausted; no history was discarded",
                )
                .into());
            }
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_attempts WHERE session_id=?1)",
                [session_id],
                |r| r.get(0),
            )?;
            if exists {
                return Err(Error::new(
                    "session_already_assigned",
                    "A native worker process can own only one attempt",
                )
                .into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            connection.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,?3,?4,'assigned')",params![id,task_id,ordinal,session_id])?;
            (run_id.clone(), "run.attempt_assigned")
        }
        Request::Report {
            attempt_id, result, ..
        } => {
            let own = context(connection, actor, Some(attempt_id))?;
            if !matches!(own["run"]["state"].as_str(), Some("active" | "draining"))
                || own["attempt"]["state"] != "assigned"
            {
                return Err(Error::new(
                    "attempt_state_conflict",
                    "Only the current assigned attempt can submit its first result",
                )
                .into());
            }
            if !plain(&result.summary, 2048)
                || result.files.len() > 32
                || result.artifacts.len() > 16
                || result.limitations.len() > 16
                || !checks_valid(&result.checks)
                || result
                    .files
                    .iter()
                    .chain(&result.artifacts)
                    .chain(&result.limitations)
                    .any(|v| !plain(v, 1024))
                || serde_json::to_vec(result)?.len() > 4096
            {
                return Err(invalid(
                    "Worker result exceeds its text, list or 4 KiB bounds",
                ));
            }
            connection.execute(
                "UPDATE workflow_attempts SET state='reported',result=?2 WHERE id=?1",
                params![attempt_id, serde_json::to_string(result)?],
            )?;
            crate::workflow_decisions::guard_result(
                connection,
                attempt_id,
                matches!(result.outcome, Outcome::Succeeded),
                now,
            )?;
            crate::workflow_inbox::notify_result(connection, actor, &own, result)?;
            // This is the report's deadline boundary after all validation and
            // dependent metadata work; a refusal rolls the whole report back.
            crate::job_timeouts::guard_report(
                connection,
                attempt_id,
                now,
                crate::event_log::monotonic_millis(),
            )?;
            crate::job_timeouts::report_accepted(connection, attempt_id, now)?;
            (
                own["run"]["id"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing assigned run identity"))?
                    .into(),
                "run.result_reported",
            )
        }
        Request::Validate {
            run_id,
            attempt_id,
            expected_revision,
            validation,
            ..
        } => {
            crate::job_cancellations::guard_run(connection, run_id)?;
            crate::job_timeouts::guard_run(
                connection,
                run_id,
                now,
                crate::event_log::monotonic_millis(),
            )?;
            revision(
                connection,
                actor,
                run_id,
                *expected_revision,
                &["active", "draining"],
            )?;
            let a = active_attempt(connection, run_id, attempt_id)?;
            if a["state"] != "reported" {
                return Err(Error::new(
                    "attempt_state_conflict",
                    "Validation requires the current worker's explicit result",
                )
                .into());
            }
            if !plain(&validation.summary, 1024)
                || !checks_valid(&validation.checks)
                || serde_json::to_vec(validation)?.len() > 2048
            {
                return Err(invalid(
                    "Validation exceeds its text, checks or 2 KiB bounds",
                ));
            }
            if validation.passed
                && (a["result"]["outcome"] != "succeeded"
                    || validation.checks.is_empty()
                    || validation
                        .checks
                        .iter()
                        .any(|c| !matches!(c.outcome, CheckOutcome::Passed)))
            {
                return Err(invalid(
                    "Accepting success requires a succeeded report and explicit passed validation checks",
                ));
            }
            let mut evidence = serde_json::to_value(validation)?;
            evidence["source"] = if matches!(actor.scope, Scope::Owner) {
                "ownerAttestation"
            } else {
                "coordinatorAttestation"
            }
            .into();
            evidence["validatorSessionId"] = match &actor.scope {
                Scope::Coordinator(id) => json!(id),
                _ => Value::Null,
            };
            connection.execute(
                "UPDATE workflow_attempts SET state=?2,validation=?3 WHERE id=?1",
                params![
                    attempt_id,
                    if validation.passed {
                        "succeeded"
                    } else {
                        "failed"
                    },
                    serde_json::to_string(&evidence)?
                ],
            )?;
            let unfinished:i64=connection.query_row("SELECT count(*) FROM workflow_tasks t WHERE t.run_id=?1 AND NOT EXISTS(SELECT 1 FROM workflow_attempts a WHERE a.task_id=t.id AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=t.id) AND a.state='succeeded')",[run_id],|r|r.get(0))?;
            if unfinished == 0 {
                connection.execute(
                    "UPDATE workflow_runs SET state='succeeded' WHERE id=?1",
                    [run_id],
                )?;
            }
            (run_id.clone(), "run.result_validated")
        }
        Request::Drain {
            run_id,
            expected_revision,
            ..
        }
        | Request::Resume {
            run_id,
            expected_revision,
            ..
        } => {
            let resume = matches!(request, Request::Resume { .. });
            revision(
                connection,
                actor,
                run_id,
                *expected_revision,
                if resume {
                    &["draining", "drained", "stopped"]
                } else {
                    &["active", "draining", "drained"]
                },
            )?;
            crate::workflow_budget::mutate_drain(connection, actor, run_id, resume)?;
            (
                run_id.clone(),
                if resume {
                    "run.resumed"
                } else {
                    "run.draining"
                },
            )
        }
        _ => return Err(invalid("Not a workflow mutation")),
    };
    crate::workflow_budget::settle_drain(connection, &run_id)?;
    connection.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [&run_id],
    )?;
    Ok((run_id, kind))
}
