use super::{
    adopt::adopt,
    authority::{authorized, authorized_uncertain},
    evidence::evidence,
    probe::{Found, Probe, probe},
    source::{Source, deadline, eligible, precheck_settled},
};
use crate::job_definitions;
use anyhow::Result;
use rusqlite::{Transaction, params};

fn settle_generation(tx: &Transaction<'_>, source: &Source, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE harness_job_attempts
         SET state='failed',reason='launch_no_effect',finished_at=COALESCE(finished_at,?2),
             dispatch_token=NULL WHERE id=?1",
        params![source.id, now],
    )?;
    Ok(())
}

pub(super) fn wait_for_retry(
    tx: &Transaction<'_>,
    source: &Source,
    run: Option<&str>,
    now: u64,
) -> Result<()> {
    settle_generation(tx, source, i64::try_from(now)?)?;
    tx.execute(
        "UPDATE harness_job_occurrences
         SET state='retryWaiting',reason='retry_backoff',finished_at=NULL WHERE id=?1",
        [&source.occurrence],
    )?;
    if let Some(run) = run {
        crate::workflow_executor::pause_for_job_retry(tx, run, now)?;
    }
    job_definitions::observe(
        tx,
        &source.job,
        Some(&source.occurrence),
        "retryWaiting",
        now,
    )
}

fn conclude(
    tx: &Transaction<'_>,
    source: &Source,
    probe: &Probe,
    outcome: (&str, &str, bool),
    now: u64,
) -> Result<()> {
    let now_i64 = i64::try_from(now)?;
    tx.execute(
        "UPDATE harness_job_retries
         SET state='blocked',probe=?2,decided_at=?3,not_before=?3,native_attempt_id=?4,receipt_id=?5
         WHERE source_attempt_id=?1 AND state='waiting' AND probe IS NULL",
        params![
            source.id,
            probe.json(now).to_string(),
            now_i64,
            probe.attempt,
            probe.receipt
        ],
    )?;
    settle_generation(tx, source, now_i64)?;
    if let Some(run) = &probe.run {
        crate::workflow_executor::pause_for_job_retry(tx, run, now)?;
    }
    let (state, reason, finished) = outcome;
    tx.execute(
        "UPDATE harness_job_occurrences
         SET state=?2,reason=?3,finished_at=CASE WHEN ?4 THEN ?5 ELSE NULL END WHERE id=?1",
        params![source.occurrence, state, reason, finished, now_i64],
    )?;
    job_definitions::observe(tx, &source.job, Some(&source.occurrence), state, now)
}

pub(super) fn settle(tx: &Transaction<'_>, source: &Source, failure: &str, now: u64) -> Result<()> {
    if source.producer || source.state != "retryWaiting" {
        return Ok(());
    }
    let probe = probe(tx, source)?;
    match probe.found {
        Found::Attempt | Found::Session => adopt(tx, source, failure, &probe, now),
        Found::NoEffectProven => {
            let proof = evidence(tx, source)?;
            match (eligible(source), proof) {
                (Some((policy, ordinal)), Some(proof)) if authorized(tx, source)? => {
                    tx.execute(
                        "UPDATE harness_job_retries
                         SET class='noEffect',native_attempt_id=?2,receipt_id=?3,probe=?4,
                             decided_at=?5,not_before=?6,next_ordinal=?7
                         WHERE source_attempt_id=?1 AND state='waiting' AND probe IS NULL",
                        params![
                            source.id,
                            proof.native,
                            proof.receipt,
                            probe.json(now).to_string(),
                            i64::try_from(now)?,
                            deadline(&policy, ordinal, now)?,
                            ordinal + 1
                        ],
                    )?;
                    wait_for_retry(tx, source, probe.run.as_deref(), now)
                }
                (None, _) => conclude(tx, source, &probe, ("failed", "retry_exhausted", true), now),
                _ => conclude(tx, source, &probe, ("failed", "attempt_failed", true), now),
            }
        }
        Found::Absent => {
            let Some((policy, ordinal)) = eligible(source) else {
                return conclude(tx, source, &probe, ("failed", "retry_exhausted", true), now);
            };
            if !precheck_settled(tx, source)?
                || !authorized_uncertain(tx, source, probe.run.as_deref())?
            {
                return conclude(
                    tx,
                    source,
                    &probe,
                    ("reconcile", "retry_blocked", false),
                    now,
                );
            }
            tx.execute(
                "UPDATE harness_job_retries
                 SET probe=?2,decided_at=?3,not_before=?4,next_ordinal=?5
                 WHERE source_attempt_id=?1 AND state='waiting' AND probe IS NULL",
                params![
                    source.id,
                    probe.json(now).to_string(),
                    i64::try_from(now)?,
                    deadline(&policy, ordinal, now)?,
                    ordinal + 1
                ],
            )?;
            wait_for_retry(tx, source, probe.run.as_deref(), now)
        }
    }
}
