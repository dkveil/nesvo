use super::{probe::Probe, source::Source};
use crate::job_definitions;
use anyhow::Result;
use rusqlite::{Transaction, params};

pub(super) fn adopt(
    tx: &Transaction<'_>,
    source: &Source,
    failure: &str,
    probe: &Probe,
    now: u64,
) -> Result<()> {
    let now_i64 = i64::try_from(now)?;
    tx.execute(
        "UPDATE harness_job_retries
         SET class='definiteEffect',state='adopted',native_attempt_id=?2,receipt_id=?3,
             probe=?4,decided_at=?5,not_before=?5
         WHERE source_attempt_id=?1 AND state='waiting' AND probe IS NULL",
        params![
            source.id,
            probe.attempt,
            probe.receipt,
            probe.json(now).to_string(),
            now_i64
        ],
    )?;
    let (state, reason) = if probe.attempt_state.as_deref() == Some("launchUnknown") {
        ("reconcile", Some("launch_unconfirmed"))
    } else if failure == "host_restarted" {
        ("reconcile", Some("host_restarted"))
    } else {
        ("running", None)
    };
    job_definitions::transition(tx, &source.occurrence, state, reason, false, now)
}
