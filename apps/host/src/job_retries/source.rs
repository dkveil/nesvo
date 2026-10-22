use super::Policy;
use crate::{api_error::Error, job_attempts, job_definitions};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

pub(super) struct Source {
    pub(super) occurrence: String,
    pub(super) job: String,
    pub(super) id: String,
    pub(super) ordinal: i64,
    pub(super) run: Option<String>,
    pub(super) spec: String,
    pub(super) state: String,
    pub(super) started: i64,
    pub(super) producer: bool,
}

pub(super) fn source(connection: &Connection, occurrence: &str) -> Result<Option<Source>> {
    Ok(connection
        .query_row(
            "SELECT o.job_id,a.id,a.ordinal,a.run_id,o.spec,o.state,
                    COALESCE(a.claimed_at,a.created_at),a.dispatch_token IS NOT NULL
             FROM harness_job_occurrences o
             JOIN harness_job_attempts a
               ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id
             WHERE o.id=?1",
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
                    started: r.get(6)?,
                    producer: r.get(7)?,
                })
            },
        )
        .optional()?)
}

pub(super) fn policy(source: &Source) -> Option<Policy> {
    let spec: Value = serde_json::from_str(&source.spec).ok()?;
    let policy: Policy = serde_json::from_value(spec.get("retry")?.clone()).ok()?;
    policy.validate().ok()?;
    Some(policy)
}

pub(super) fn launch_key(source: &Source) -> String {
    format!(
        "{}:executor",
        job_attempts::key_prefix(&source.job, &source.occurrence, source.ordinal)
    )
}

pub(super) fn precheck_settled(connection: &Connection, source: &Source) -> Result<bool> {
    let spec: job_definitions::Spec = serde_json::from_str(&source.spec)?;
    if spec.precheck_id.is_some() {
        return crate::job_precheck_records::passed_current(connection, &source.occurrence);
    }
    let unexpected: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1)
            OR EXISTS(SELECT 1 FROM harness_job_generation_prechecks WHERE occurrence_id=?1)",
        [&source.occurrence],
        |row| row.get(0),
    )?;
    Ok(!unexpected)
}

pub(super) fn deadline(policy: &Policy, ordinal: u16, now: u64) -> Result<i64> {
    now.checked_add(policy.delay_ms(ordinal)?)
        .and_then(|deadline| i64::try_from(deadline).ok())
        .ok_or_else(|| {
            Error::new(
                "invalid_argument",
                "Retry deadline exceeds the storage clock",
            )
            .into()
        })
}

pub(super) fn eligible(source: &Source) -> Option<(Policy, u16)> {
    let policy = policy(source)?;
    if source.ordinal < 1 || source.ordinal >= i64::from(policy.max_attempts) {
        return None;
    }
    Some((policy, u16::try_from(source.ordinal).ok()?))
}
