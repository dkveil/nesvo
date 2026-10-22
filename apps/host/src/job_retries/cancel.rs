use super::{
    evidence::evidence,
    probe::{Found, probe},
    source::source,
};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};

pub fn cancel_waiting(tx: &Transaction<'_>, occurrence: &str, now: u64) -> Result<bool> {
    let Some(source) = source(tx, occurrence)? else {
        return Ok(false);
    };
    let decision: Option<(Option<String>, Option<String>, String, bool)> = tx
        .query_row(
            "SELECT native_attempt_id,receipt_id,class,probe IS NOT NULL FROM harness_job_retries
             WHERE source_attempt_id=?1 AND occurrence_id=?2 AND state IN ('waiting','blocked')",
            params![source.id, occurrence],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((native, receipt, class, probed)) = decision else {
        return Ok(false);
    };
    if class == "uncertainEffect" {
        if !probed {
            tx.execute(
                "UPDATE harness_job_retries SET state='canceled'
                 WHERE source_attempt_id=?1 AND state='waiting' AND probe IS NULL",
                [&source.id],
            )?;
            return Ok(false);
        }
        let probe = probe(tx, &source)?;
        if probe.found != Found::Absent {
            return Ok(false);
        }
        return Ok(tx.execute(
            "UPDATE harness_job_retries SET state='canceled',claim_probe=COALESCE(claim_probe,?2)
             WHERE source_attempt_id=?1 AND state IN ('waiting','blocked')",
            params![source.id, probe.json(now).to_string()],
        )? == 1);
    }
    if !evidence(tx, &source)?.is_some_and(|proof| {
        Some(&proof.native) == native.as_ref() && Some(&proof.receipt) == receipt.as_ref()
    }) {
        return Ok(false);
    }
    Ok(tx.execute(
        "UPDATE harness_job_retries SET state='canceled'
         WHERE source_attempt_id=?1 AND state IN ('waiting','blocked')",
        [&source.id],
    )? == 1)
}
