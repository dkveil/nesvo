use super::source::{Source, precheck_settled};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

pub(super) struct Evidence {
    pub(super) native: String,
    pub(super) receipt: String,
}

pub(super) fn evidence(connection: &Connection, source: &Source) -> Result<Option<Evidence>> {
    let Some(run) = &source.run else {
        return Ok(None);
    };
    if !precheck_settled(connection, source)? {
        return Ok(None);
    }
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT n.id,p.id,p.result
             FROM harness_job_occurrences o
             JOIN harness_job_attempts a
               ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id
             JOIN workflow_tasks t ON t.run_id=a.run_id
             JOIN workflow_attempts n ON n.task_id=t.id
             JOIN workflow_launches l ON l.attempt_id=n.id
             JOIN operation_receipts p ON p.id=l.operation_id
             WHERE o.id=?1 AND a.id=?2 AND a.run_id=?3 AND o.run_id=a.run_id
               AND NOT EXISTS(SELECT 1 FROM harness_job_attempts later
                              WHERE later.occurrence_id=o.id AND later.ordinal>a.ordinal)
               AND (SELECT count(*) FROM workflow_tasks WHERE run_id=a.run_id)=1
               AND (SELECT count(*) FROM workflow_attempts WHERE task_id=t.id)=1
               AND t.task_key='job' AND n.ordinal=1 AND n.state='launchFailed'
               AND n.result IS NULL AND n.validation IS NULL
               AND p.operation='create' AND p.phase='failed' AND p.claim_token IS NULL
               AND p.session_id=n.session_id AND p.key=l.operation_key
               AND l.operation_key=('run-launch:' || n.id)
               AND NOT EXISTS(SELECT 1 FROM workflow_deliveries WHERE run_id=a.run_id)
               AND NOT EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=n.session_id)
               AND NOT EXISTS(SELECT 1 FROM operation_receipts other
                              WHERE other.session_id=n.session_id AND other.id<>p.id)",
            params![source.occurrence, source.id, run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((native, receipt, result)) = row else {
        return Ok(None);
    };
    // json_extract maps false and 0 to one SQL integer; parse the JSON to keep them distinct.
    if !no_effect_result(Some(&result)) {
        return Ok(None);
    }
    Ok(Some(Evidence { native, receipt }))
}

pub(super) fn no_effect_result(result: Option<&str>) -> bool {
    result
        .and_then(|result| serde_json::from_str::<Value>(result).ok())
        .is_some_and(|result| {
            result.get("effectStarted") == Some(&Value::Bool(false))
                && result["taskResult"].is_null()
        })
}
