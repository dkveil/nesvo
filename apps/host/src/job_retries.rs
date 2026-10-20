//! Durable retries only for an exact, terminal native create refusal with no effect.
use crate::{api_error::Error, job_attempts, job_definitions};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum On {
    LaunchNoEffect,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub on: On,
    pub max_attempts: u8,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        if !(1..=8).contains(&self.max_attempts)
            || !(1_000..=3_600_000).contains(&self.initial_delay_ms)
            || self.max_delay_ms < self.initial_delay_ms
            || self.max_delay_ms > 86_400_000
        {
            return Err(Error::new(
                "invalid_argument",
                "Job retries require 1–8 total attempts, a 1 second–1 hour initial delay and a maximum delay between the initial delay and 24 hours",
            )
            .into());
        }
        Ok(())
    }

    /// The failed first generation waits one initial delay. Every following
    /// generation doubles that delay, with checked arithmetic and a fixed cap.
    pub fn delay_ms(&self, source_ordinal: u16) -> Result<u64> {
        self.validate()?;
        if !(1..=8).contains(&source_ordinal) {
            return Err(Error::new("invalid_argument", "Invalid retry source generation").into());
        }
        Ok((1..source_ordinal).fold(self.initial_delay_ms, |delay, _| {
            delay
                .checked_mul(2)
                .unwrap_or(self.max_delay_ms)
                .min(self.max_delay_ms)
        }))
    }
}

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_job_retries(
            source_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
            occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
            native_attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
            receipt_id TEXT NOT NULL REFERENCES operation_receipts(id),
            decided_at INTEGER NOT NULL CHECK(decided_at>=0),
            not_before INTEGER NOT NULL CHECK(not_before>=decided_at),
            next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 2 AND 8),
            state TEXT NOT NULL CHECK(state IN ('waiting','claimed','canceled','blocked')),
            claimed_at INTEGER CHECK(claimed_at>=0),
            target_attempt_id TEXT UNIQUE REFERENCES harness_job_attempts(id)
        );
        CREATE INDEX IF NOT EXISTS harness_job_retries_due
            ON harness_job_retries(state,not_before);",
    )?;
    Ok(())
}

/// Only immutable decision facts belong in an old generation's public view.
/// Claiming or canceling a later retry cannot rewrite a previously read body.
pub fn view(connection: &Connection, source_attempt: &str) -> Result<Value> {
    Ok(connection
        .query_row(
            "SELECT native_attempt_id,receipt_id,decided_at,not_before,next_ordinal
             FROM harness_job_retries WHERE source_attempt_id=?1",
            [source_attempt],
            |r| {
                Ok(json!({
                    "jobAttemptId":source_attempt,
                    "attemptId":r.get::<_,String>(0)?,
                    "launchReceiptId":r.get::<_,String>(1)?,
                    "decidedAt":r.get::<_,i64>(2)?,
                    "notBefore":r.get::<_,i64>(3)?,
                    "nextOrdinal":r.get::<_,i64>(4)?
                }))
            },
        )
        .optional()?
        .unwrap_or(Value::Null))
}

struct Source {
    occurrence: String,
    job: String,
    id: String,
    ordinal: i64,
    run: String,
    spec: String,
    state: String,
}

fn source(connection: &Connection, occurrence: &str) -> Result<Option<Source>> {
    Ok(connection
        .query_row(
            "SELECT o.job_id,a.id,a.ordinal,a.run_id,o.spec,o.state
             FROM harness_job_occurrences o
             JOIN harness_job_attempts a
               ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id
             WHERE o.id=?1 AND a.run_id IS NOT NULL",
            [occurrence],
            |r| {
                Ok(Source {
                    occurrence: occurrence.into(),
                    job: r.get(0)?,
                    id: r.get(1)?,
                    ordinal: r.get(2)?,
                    run: r.get(3)?,
                    spec: r.get(4)?,
                    state: r.get(5)?,
                })
            },
        )
        .optional()?)
}

fn policy(source: &Source) -> Option<Policy> {
    let spec: Value = serde_json::from_str(&source.spec).ok()?;
    let policy: Policy = serde_json::from_value(spec.get("retry")?.clone()).ok()?;
    policy.validate().ok()?;
    Some(policy)
}

struct Evidence {
    native: String,
    receipt: String,
}

/// A label such as launchFailed is not proof. Read the exact bound receipt and
/// reject every other task admission, result, delivery, exit or native receipt.
fn evidence(connection: &Connection, source: &Source) -> Result<Option<Evidence>> {
    let spec: job_definitions::Spec = serde_json::from_str(&source.spec)?;
    if spec.precheck_id.is_some()
        && !crate::job_precheck_records::passed_current(connection, &source.occurrence)?
    {
        return Ok(None);
    }
    if spec.precheck_id.is_none() {
        let unexpected: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1)
                OR EXISTS(SELECT 1 FROM harness_job_generation_prechecks WHERE occurrence_id=?1)",
            [&source.occurrence],
            |row| row.get(0),
        )?;
        if unexpected {
            return Ok(None);
        }
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
            params![source.occurrence, source.id, source.run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((native, receipt, result)) = row else {
        return Ok(None);
    };
    // SQLite's json_extract maps false and 0 to the same SQL integer. Parsing
    // the JSON value keeps those distinct and refuses absent/null/string data.
    let result = serde_json::from_str::<Value>(&result).ok();
    if !result.as_ref().is_some_and(|result| {
        result.get("effectStarted") == Some(&Value::Bool(false)) && result["taskResult"].is_null()
    }) {
        return Ok(None);
    }
    Ok(Some(Evidence { native, receipt }))
}

fn authorized(connection: &Connection, source: &Source) -> Result<bool> {
    // A new Run must not silently undo an owner's edits to the old admission
    // policy. The frozen job profile permits one native attempt per generation.
    let spec: job_definitions::Spec = serde_json::from_str(&source.spec)?;
    if let Some(id) = &spec.precheck_id
        && !crate::job_precheck_records::approval_ready(connection, id)?
    {
        return Ok(false);
    }
    let expected = crate::workflow_budget::Limits {
        max_parallel: 1,
        max_attempts_per_task: 1,
        max_elapsed_ms: Some(spec.max_elapsed_ms),
    };
    let limits: Option<String> = connection
        .query_row(
            "SELECT limits FROM workflow_run_budget WHERE run_id=?1",
            [&source.run],
            |r| r.get(0),
        )
        .optional()?;
    if limits
        .and_then(|text| serde_json::from_str::<crate::workflow_budget::Limits>(&text).ok())
        .as_ref()
        != Some(&expected)
    {
        return Ok(false);
    }
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE id=?1 AND state='active' AND coordinator_id IS NULL)
           AND NOT EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=?2)
           AND NOT EXISTS(SELECT 1 FROM workflow_controls WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_constraints WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_coordinator_bindings WHERE run_id=?1)
           AND NOT EXISTS(SELECT 1 FROM workflow_run_budget WHERE run_id=?1 AND drain_owner<>0)
           AND NOT EXISTS(SELECT 1 FROM workflow_executors
                          WHERE run_id=?1 AND (phase='disabled' OR
                              (phase='paused' AND (reason IS NULL OR reason NOT IN ('host_restart','job_retry_waiting')))))",
        params![source.run, source.occurrence],
        |r| r.get(0),
    )?)
}

/// Called before generic failure projection, in the same writer transaction.
/// The first accepted decision owns its deadline; subsequent reads are quiet.
pub fn consider(tx: &Transaction<'_>, occurrence: &str, now: u64) -> Result<bool> {
    if crate::job_launch_resolutions::resolved_occurrence(tx, occurrence)?
        || crate::job_timeouts::owns_occurrence(tx, occurrence)?
    {
        return Ok(false);
    }
    let Some(source) = source(tx, occurrence)? else {
        return Ok(false);
    };
    let existing: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_retries WHERE source_attempt_id=?1)",
        [&source.id],
        |r| r.get(0),
    )?;
    if existing {
        return Ok(true);
    }
    if !matches!(
        source.state.as_str(),
        "dispatching" | "running" | "reconcile"
    ) {
        return Ok(false);
    }
    let Some(policy) = policy(&source) else {
        return Ok(false);
    };
    if source.ordinal < 1 || source.ordinal >= i64::from(policy.max_attempts) {
        return Ok(false);
    }
    let Some(evidence) = evidence(tx, &source)? else {
        return Ok(false);
    };
    if !authorized(tx, &source)? {
        return Ok(false);
    }
    let ordinal = u16::try_from(source.ordinal)?;
    let decided_at = i64::try_from(now)?;
    let not_before = now
        .checked_add(policy.delay_ms(ordinal)?)
        .and_then(|deadline| i64::try_from(deadline).ok())
        .ok_or_else(|| {
            Error::new(
                "invalid_argument",
                "Retry deadline exceeds the storage clock",
            )
        })?;
    tx.execute(
        "INSERT INTO harness_job_retries(
            source_attempt_id,occurrence_id,native_attempt_id,receipt_id,
            decided_at,not_before,next_ordinal,state
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,'waiting')",
        params![
            source.id,
            occurrence,
            evidence.native,
            evidence.receipt,
            decided_at,
            not_before,
            ordinal + 1
        ],
    )?;
    tx.execute(
        "UPDATE harness_job_attempts
         SET state='failed',reason='launch_no_effect',finished_at=COALESCE(finished_at,?2),
             dispatch_token=NULL WHERE id=?1",
        params![source.id, decided_at],
    )?;
    tx.execute(
        "UPDATE harness_job_occurrences
         SET state='retryWaiting',reason='retry_backoff',finished_at=NULL WHERE id=?1",
        [occurrence],
    )?;
    crate::workflow_executor::pause_for_job_retry(tx, &source.run, now)?;
    job_definitions::observe(tx, &source.job, Some(occurrence), "retryWaiting", now)?;
    Ok(true)
}

fn block(tx: &Transaction<'_>, source: &Source, reason: &str, now: u64) -> Result<()> {
    let changed = tx.execute(
        "UPDATE harness_job_retries SET state='blocked'
         WHERE source_attempt_id=?1 AND state='waiting'",
        [&source.id],
    )?;
    if changed > 0 {
        tx.execute(
            "UPDATE harness_job_occurrences
             SET state='reconcile',reason=?2,finished_at=NULL
             WHERE id=?1 AND current_job_attempt_id=?3",
            params![source.occurrence, reason, source.id],
        )?;
        job_definitions::observe(tx, &source.job, Some(&source.occurrence), "reconcile", now)?;
    }
    Ok(())
}

/// The scheduler supplies its common fair candidate order and available slots.
/// This revalidation and fresh token allocation share its writer transaction.
#[cfg(test)]
pub fn claim(
    tx: &Transaction<'_>,
    occurrence: &str,
    now: u64,
) -> Result<Option<(job_attempts::Dispatch, u16)>> {
    claim_at(tx, occurrence, now, now)
}
pub fn claim_at(
    tx: &Transaction<'_>,
    occurrence: &str,
    now: u64,
    elapsed: u64,
) -> Result<Option<(job_attempts::Dispatch, u16)>> {
    if crate::job_launch_resolutions::resolved_occurrence(tx, occurrence)?
        || crate::job_timeouts::owns_occurrence(tx, occurrence)?
    {
        return Ok(None);
    }
    let Some(source) = source(tx, occurrence)? else {
        return Ok(None);
    };
    let decision: Option<(String, String, i64, i64)> = tx
        .query_row(
            "SELECT native_attempt_id,receipt_id,next_ordinal,not_before
             FROM harness_job_retries
             WHERE source_attempt_id=?1 AND occurrence_id=?2 AND state='waiting'",
            params![source.id, occurrence],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((native, receipt, ordinal, not_before)) = decision else {
        return Ok(None);
    };
    if i64::try_from(now)? < not_before {
        return Ok(None);
    }
    let Some(policy) = policy(&source) else {
        block(tx, &source, "retry_policy_changed", now)?;
        return Ok(None);
    };
    if ordinal != source.ordinal + 1
        || ordinal > i64::from(policy.max_attempts)
        || source.state != "retryWaiting"
    {
        block(tx, &source, "retry_policy_changed", now)?;
        return Ok(None);
    }
    let retained: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_attempts
                       WHERE id=?1 AND state='failed' AND reason='launch_no_effect'
                         AND finished_at IS NOT NULL AND dispatch_token IS NULL)",
        [&source.id],
        |r| r.get(0),
    )?;
    let proof = evidence(tx, &source)?;
    if !retained || !proof.is_some_and(|proof| proof.native == native && proof.receipt == receipt) {
        block(tx, &source, "retry_evidence_changed", now)?;
        return Ok(None);
    }
    if !authorized(tx, &source)? {
        block(tx, &source, "retry_authority_changed", now)?;
        return Ok(None);
    }
    if let Err(error) = crate::job_quota::guard_occurrence(tx, occurrence, elapsed) {
        if error
            .downcast_ref::<Error>()
            .is_some_and(|error| error.code == "quota_wait")
        {
            return Ok(None);
        }
        return Err(error);
    }
    job_attempts::capacity(tx, 1)?;
    let attempt = hex::encode(crate::wire::random::<16>());
    let token = hex::encode(crate::wire::random::<32>());
    let now_i64 = i64::try_from(now)?;
    tx.execute(
        "INSERT INTO harness_job_attempts(
            id,occurrence_id,ordinal,created_at,claimed_at,state,dispatch_token
         ) VALUES(?1,?2,?3,?4,?4,'dispatching',?5)",
        params![attempt, occurrence, ordinal, now_i64, token],
    )?;
    tx.execute(
        "UPDATE harness_job_occurrences
         SET current_job_attempt_id=?2,state='dispatching',run_id=NULL,reason=NULL,
             finished_at=NULL WHERE id=?1 AND current_job_attempt_id=?3",
        params![occurrence, attempt, source.id],
    )?;
    tx.execute(
        "UPDATE harness_job_retries SET state='claimed',claimed_at=?2,target_attempt_id=?3
         WHERE source_attempt_id=?1 AND state='waiting'",
        params![source.id, now_i64, attempt],
    )?;
    job_definitions::observe(tx, &source.job, Some(occurrence), "dispatching", now)?;
    Ok(Some((
        job_attempts::Dispatch {
            occurrence: occurrence.into(),
            attempt,
            token,
        },
        u16::try_from(ordinal)?,
    )))
}

/// An owner can cancel a known no-effect backoff without inventing native stop
/// receipts. The caller owns the occurrence transition and cancellation event.
pub fn cancel_waiting(tx: &Transaction<'_>, occurrence: &str, _now: u64) -> Result<bool> {
    let Some(source) = source(tx, occurrence)? else {
        return Ok(false);
    };
    let decision: Option<(String, String)> = tx
        .query_row(
            "SELECT native_attempt_id,receipt_id FROM harness_job_retries
             WHERE source_attempt_id=?1 AND occurrence_id=?2 AND state IN ('waiting','blocked')",
            params![source.id, occurrence],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((native, receipt)) = decision else {
        return Ok(false);
    };
    if !evidence(tx, &source)?
        .is_some_and(|proof| proof.native == native && proof.receipt == receipt)
    {
        return Ok(false);
    }
    Ok(tx.execute(
        "UPDATE harness_job_retries SET state='canceled'
         WHERE source_attempt_id=?1 AND state IN ('waiting','blocked')",
        [&source.id],
    )? == 1)
}
