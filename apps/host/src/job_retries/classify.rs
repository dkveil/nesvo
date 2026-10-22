use super::{
    authority::authorized,
    evidence::evidence,
    settle::wait_for_retry,
    source::{deadline, eligible, launch_key, policy, precheck_settled, source},
};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};

const UNCERTAIN_FAILURES: &[&str] = &[
    "dispatch_unconfirmed",
    "dispatch_interrupted",
    "launch_unconfirmed",
    "host_restarted",
];

pub fn classify(tx: &Transaction<'_>, occurrence: &str, failure: &str) -> Result<()> {
    if !UNCERTAIN_FAILURES.contains(&failure)
        || crate::job_launch_resolutions::resolved_occurrence(tx, occurrence)?
        || crate::job_timeouts::owns_occurrence(tx, occurrence)?
        || crate::job_cancellations::requested(tx, occurrence)?
    {
        return Ok(());
    }
    let Some(source) = source(tx, occurrence)? else {
        return Ok(());
    };
    if policy(&source).is_none() || !precheck_settled(tx, &source)? {
        return Ok(());
    }
    let existing: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_retries WHERE source_attempt_id=?1)",
        [&source.id],
        |r| r.get(0),
    )?;
    if existing {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO harness_job_retries(
            source_attempt_id,occurrence_id,decided_at,not_before,state,class,failure,launch_key
         ) VALUES(?1,?2,?3,?3,'waiting','uncertainEffect',?4,?5)",
        params![
            source.id,
            occurrence,
            source.started,
            failure,
            launch_key(&source)
        ],
    )?;
    tx.execute(
        "UPDATE harness_job_occurrences SET state='retryWaiting',reason='retry_probe_pending'
         WHERE id=?1 AND current_job_attempt_id=?2",
        params![occurrence, source.id],
    )?;
    Ok(())
}

pub fn consider(tx: &Transaction<'_>, occurrence: &str, now: u64) -> Result<bool> {
    if crate::job_launch_resolutions::resolved_occurrence(tx, occurrence)?
        || crate::job_timeouts::owns_occurrence(tx, occurrence)?
    {
        return Ok(false);
    }
    let Some(source) = source(tx, occurrence)? else {
        return Ok(false);
    };
    let existing: Option<String> = tx
        .query_row(
            "SELECT state FROM harness_job_retries WHERE source_attempt_id=?1",
            [&source.id],
            |r| r.get(0),
        )
        .optional()?;
    match existing.as_deref() {
        Some("adopted") => return Ok(false),
        Some(_) => return Ok(true),
        None => {}
    }
    if !matches!(
        source.state.as_str(),
        "dispatching" | "running" | "reconcile"
    ) {
        return Ok(false);
    }
    let Some((policy, ordinal)) = eligible(&source) else {
        return Ok(false);
    };
    let Some(evidence) = evidence(tx, &source)? else {
        return Ok(false);
    };
    if !authorized(tx, &source)? {
        return Ok(false);
    }
    let decided_at = i64::try_from(now)?;
    let not_before = deadline(&policy, ordinal, now)?;
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
    wait_for_retry(tx, &source, source.run.as_deref(), now)?;
    Ok(true)
}
