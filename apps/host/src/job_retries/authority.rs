use super::source::Source;
use crate::job_definitions;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

fn expected_limits(source: &Source) -> Result<crate::workflow_budget::Limits> {
    let spec: job_definitions::Spec = serde_json::from_str(&source.spec)?;
    Ok(crate::workflow_budget::Limits {
        max_parallel: 1,
        max_attempts_per_task: 1,
        max_elapsed_ms: Some(spec.max_elapsed_ms),
    })
}

fn stored_limits(
    connection: &Connection,
    run: &str,
) -> Result<Option<Option<crate::workflow_budget::Limits>>> {
    let limits: Option<String> = connection
        .query_row(
            "SELECT limits FROM workflow_run_budget WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()?;
    Ok(limits.map(|text| serde_json::from_str(&text).ok()))
}

fn approval_open(connection: &Connection, source: &Source) -> Result<bool> {
    let spec: job_definitions::Spec = serde_json::from_str(&source.spec)?;
    match &spec.precheck_id {
        Some(id) => crate::job_precheck_records::approval_ready(connection, id),
        None => Ok(true),
    }
}

const RUN_FENCE_OPEN: &str = "NOT EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=?2)
           AND NOT EXISTS(SELECT 1 FROM workflow_controls WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_constraints WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_coordinator_bindings WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_run_budget WHERE run_id=?1 AND drain_owner<>0)
           AND NOT EXISTS(SELECT 1 FROM workflow_executors
                          WHERE run_id=?1 AND (phase='disabled' OR
                              (phase='paused' AND (reason IS NULL OR reason NOT IN ('host_restart','job_retry_waiting')))))";

pub(super) fn authorized(connection: &Connection, source: &Source) -> Result<bool> {
    let Some(run) = &source.run else {
        return Ok(false);
    };
    if !approval_open(connection, source)? {
        return Ok(false);
    }
    if stored_limits(connection, run)?.flatten().as_ref() != Some(&expected_limits(source)?) {
        return Ok(false);
    }
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE id=?1 AND state='active' AND coordinator_id IS NULL) AND {RUN_FENCE_OPEN}"
        ),
        params![run, source.occurrence],
        |r| r.get(0),
    )?)
}

pub(super) fn authorized_uncertain(
    connection: &Connection,
    source: &Source,
    run: Option<&str>,
) -> Result<bool> {
    if !approval_open(connection, source)? {
        return Ok(false);
    }
    let canceled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=?1)",
        [&source.occurrence],
        |r| r.get(0),
    )?;
    let Some(run) = run else {
        return Ok(!canceled);
    };
    if let Some(limits) = stored_limits(connection, run)?
        && limits.as_ref() != Some(&expected_limits(source)?)
    {
        return Ok(false);
    }
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE id=?1 AND state IN ('draft','active') AND coordinator_id IS NULL) AND {RUN_FENCE_OPEN}"
        ),
        params![run, source.occurrence],
        |r| r.get(0),
    )?)
}
