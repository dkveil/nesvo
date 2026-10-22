use super::{
    authority::{authorized, authorized_uncertain},
    evidence::evidence,
    probe::{Found, probe},
    settle::settle,
    source::{Source, policy, precheck_settled, source},
};
use crate::{api_error::Error, job_attempts, job_definitions};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

fn block(
    tx: &Transaction<'_>,
    source: &Source,
    reason: &str,
    claim_probe: Option<Value>,
    now: u64,
) -> Result<()> {
    let changed = tx.execute(
        "UPDATE harness_job_retries SET state='blocked',claim_probe=COALESCE(?2,claim_probe)
         WHERE source_attempt_id=?1 AND state='waiting'",
        params![source.id, claim_probe.map(|probe| probe.to_string())],
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

struct Decision {
    native: Option<String>,
    receipt: Option<String>,
    ordinal: Option<i64>,
    not_before: i64,
    class: String,
    probed: bool,
    failure: Option<String>,
}

#[cfg(test)]
pub fn claim(
    tx: &Transaction<'_>,
    occurrence: &str,
    now: u64,
) -> Result<Option<(job_attempts::Dispatch, u16)>> {
    claim_at(tx, occurrence, now, now)
}
pub fn probe_pending(tx: &Transaction<'_>, now: u64, elapsed: u64) -> Result<()> {
    let pending = {
        let mut query = tx.prepare(
            "SELECT o.id FROM harness_job_occurrences o
             JOIN harness_job_retries retry
               ON retry.source_attempt_id=o.current_job_attempt_id AND retry.occurrence_id=o.id
             WHERE o.state='retryWaiting' AND retry.state='waiting'
               AND retry.class='uncertainEffect' AND retry.probe IS NULL AND retry.not_before<=?1
             ORDER BY retry.not_before,o.rowid LIMIT 64",
        )?;
        query
            .query_map([i64::try_from(now)?], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for occurrence in pending {
        claim_at(tx, &occurrence, now, elapsed)?;
    }
    Ok(())
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
    let decision = tx
        .query_row(
            "SELECT native_attempt_id,receipt_id,next_ordinal,not_before,class,probe IS NOT NULL,failure
             FROM harness_job_retries
             WHERE source_attempt_id=?1 AND occurrence_id=?2 AND state='waiting'",
            params![source.id, occurrence],
            |r| {
                Ok(Decision {
                    native: r.get(0)?,
                    receipt: r.get(1)?,
                    ordinal: r.get(2)?,
                    not_before: r.get(3)?,
                    class: r.get(4)?,
                    probed: r.get(5)?,
                    failure: r.get(6)?,
                })
            },
        )
        .optional()?;
    let Some(decision) = decision else {
        return Ok(None);
    };
    if i64::try_from(now)? < decision.not_before {
        return Ok(None);
    }
    if decision.class == "uncertainEffect" && !decision.probed {
        settle(
            tx,
            &source,
            decision.failure.as_deref().unwrap_or_default(),
            now,
        )?;
        return Ok(None);
    }
    let Some(policy) = policy(&source) else {
        block(tx, &source, "retry_policy_changed", None, now)?;
        return Ok(None);
    };
    let Some(ordinal) = decision.ordinal else {
        block(tx, &source, "retry_policy_changed", None, now)?;
        return Ok(None);
    };
    if ordinal != source.ordinal + 1
        || ordinal > i64::from(policy.max_attempts)
        || source.state != "retryWaiting"
    {
        block(tx, &source, "retry_policy_changed", None, now)?;
        return Ok(None);
    }
    let retained: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_attempts
                       WHERE id=?1 AND state='failed' AND reason='launch_no_effect'
                         AND finished_at IS NOT NULL AND dispatch_token IS NULL)",
        [&source.id],
        |r| r.get(0),
    )?;
    let mut claim_probe = None;
    if decision.class == "noEffect" {
        let proof = evidence(tx, &source)?;
        if !retained
            || !proof.is_some_and(|proof| {
                Some(&proof.native) == decision.native.as_ref()
                    && Some(&proof.receipt) == decision.receipt.as_ref()
            })
        {
            block(tx, &source, "retry_evidence_changed", None, now)?;
            return Ok(None);
        }
        if !authorized(tx, &source)? {
            block(tx, &source, "retry_authority_changed", None, now)?;
            return Ok(None);
        }
    } else {
        let probe = probe(tx, &source)?;
        let observed = probe.json(now);
        if !retained || probe.found != Found::Absent || !precheck_settled(tx, &source)? {
            block(tx, &source, "retry_evidence_changed", Some(observed), now)?;
            return Ok(None);
        }
        if !authorized_uncertain(tx, &source, probe.run.as_deref())? {
            block(tx, &source, "retry_authority_changed", Some(observed), now)?;
            return Ok(None);
        }
        claim_probe = Some(observed.to_string());
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
        "UPDATE harness_job_retries SET state='claimed',claimed_at=?2,target_attempt_id=?3,
             claim_probe=COALESCE(?4,claim_probe)
         WHERE source_attempt_id=?1 AND state='waiting'",
        params![source.id, now_i64, attempt, claim_probe],
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
