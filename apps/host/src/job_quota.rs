use crate::{api_error::Error, job_attempts, launchers::Program};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Wait,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub mode: Mode,
    pub context_id: String,
    pub account_fingerprint: String,
}
impl Policy {
    pub fn validate(&self, program: Program) -> Result<()> {
        validate_binding(&self.binding())?;
        if program != Program::Codex {
            return Err(Error::new(
                "unsupported",
                "Configured-account job quota waiting currently requires Codex",
            )
            .into());
        }
        Ok(())
    }
    fn binding(&self) -> Binding {
        Binding {
            context_id: self.context_id.clone(),
            account_fingerprint: self.account_fingerprint.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub context_id: String,
    pub account_fingerprint: String,
}

#[derive(Clone, Debug)]
pub struct Permit {
    pub run_id: String,
    pub occurrence_id: String,
    pub job_attempt_id: String,
    pub binding: Binding,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub source_id: String,
    pub revision: u64,
    pub binding: Option<Binding>,
    pub expires_elapsed_ms: u64,
    pub eligible: bool,
    pub reason: String,
}

pub const ELIGIBLE_SQL: &str = "(
    ((json_type(o.spec,'$.quotaPolicy') IS NULL OR json_type(o.spec,'$.quotaPolicy')='null')
     AND NOT EXISTS(SELECT 1 FROM harness_job_quota_sources quota_gate
        WHERE quota_gate.source_id='gate_'||json_extract(o.spec,'$.profile.program')
          AND quota_gate.eligible=0 AND quota_gate.expires_elapsed_ms>?3))
    OR (json_extract(o.spec,'$.quotaPolicy.mode')='wait' AND EXISTS(
        SELECT 1 FROM harness_job_quota_sources quota_source
        LEFT JOIN harness_job_quota_authorizations quota_auth ON quota_auth.occurrence_id=o.id
        WHERE COALESCE(quota_auth.paused,0)=0
          AND quota_source.context_id=COALESCE(quota_auth.context_id,json_extract(o.spec,'$.quotaPolicy.contextId'))
          AND quota_source.account_fingerprint=COALESCE(quota_auth.account_fingerprint,json_extract(o.spec,'$.quotaPolicy.accountFingerprint'))
          AND quota_source.eligible=1 AND quota_source.expires_elapsed_ms>?3
    ))
)";

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_job_quota_sources(
            source_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK(revision>=1),
            context_id TEXT,
            account_fingerprint TEXT,
            expires_elapsed_ms INTEGER NOT NULL CHECK(expires_elapsed_ms>=0),
            eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
            reason TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS harness_job_quota_sources_binding
            ON harness_job_quota_sources(context_id,account_fingerprint);
        CREATE TABLE IF NOT EXISTS harness_job_quota_authorizations(
            occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),
            context_id TEXT NOT NULL,
            account_fingerprint TEXT NOT NULL,
            paused INTEGER NOT NULL CHECK(paused IN (0,1)),
            authorized_at INTEGER NOT NULL CHECK(authorized_at>=0)
        );",
    )?;
    Ok(())
}

const GATE_PREFIX: &str = "gate_";
const GATE_STATES: [&str; 4] = ["queued", "retryWaiting", "dispatching", "prechecking"];

pub fn gate_source(program: Program) -> String {
    let name = match program {
        Program::Shell => "shell",
        Program::Claude => "claude",
        Program::Gemini => "gemini",
        Program::Codex => "codex",
    };
    format!("{GATE_PREFIX}{name}")
}

fn gate_hold(
    connection: &Connection,
    source: &str,
    elapsed: u64,
) -> Result<Option<(i64, String, i64)>> {
    Ok(connection
        .query_row(
            "SELECT revision,reason,expires_elapsed_ms FROM harness_job_quota_sources
             WHERE source_id=?1 AND eligible=0 AND expires_elapsed_ms>?2",
            params![source, i64::try_from(elapsed)?],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

pub fn guard_gate(connection: &Connection, program: Program, elapsed: u64) -> Result<()> {
    if program != Program::Shell && gate_hold(connection, &gate_source(program), elapsed)?.is_some()
    {
        return Err(Error::new(
            "quota_wait",
            "Provider quota is held at a known limit; the launch waits for a newer read or the reset",
        )
        .into());
    }
    Ok(())
}

fn gate_view(connection: &Connection, occurrence: &str, elapsed: u64) -> Result<Value> {
    let (state, program): (String, Option<String>) = connection.query_row(
        "SELECT state,json_extract(spec,'$.profile.program') FROM harness_job_occurrences WHERE id=?1",
        [occurrence],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let hold = match program {
        Some(program) if GATE_STATES.contains(&state.as_str()) => {
            gate_hold(connection, &format!("{GATE_PREFIX}{program}"), elapsed)?
        }
        _ => None,
    };
    let Some((revision, reason, expires)) = hold else {
        return Ok(
            json!({"state":"notRequired","reason":null,"contextId":null,"accountFingerprint":null,"sourceRevision":null}),
        );
    };
    let resets_at = u64::try_from(expires)
        .ok()
        .filter(|expires| *expires != crate::quota_gate::UNTIMED_EXPIRY)
        .map(|expires| crate::status::now_millis().saturating_add(expires.saturating_sub(elapsed)));
    Ok(
        json!({"state":"held","reason":reason,"resetsAt":resets_at,"contextId":null,"accountFingerprint":null,"sourceRevision":revision}),
    )
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_binding(binding: &Binding) -> Result<()> {
    if !hex64(&binding.context_id) || !hex64(&binding.account_fingerprint) {
        return Err(Error::new(
            "invalid_argument",
            "Quota bindings require lowercase 64-character opaque context and account fingerprints",
        )
        .into());
    }
    Ok(())
}

pub fn publish(tx: &Transaction<'_>, observation: &Observation) -> Result<bool> {
    if observation.source_id.is_empty()
        || observation.source_id.len() > 128
        || !observation
            .source_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || observation.revision == 0
    {
        return Err(Error::new("invalid_argument", "Invalid private quota source identity").into());
    }
    let revision = i64::try_from(observation.revision)?;
    let previous: Option<i64> = tx
        .query_row(
            "SELECT revision FROM harness_job_quota_sources WHERE source_id=?1",
            [&observation.source_id],
            |row| row.get(0),
        )
        .optional()?;
    if previous.is_some_and(|previous| previous >= revision) {
        return Ok(false);
    }
    if previous.is_none() {
        let count: i64 =
            tx.query_row("SELECT count(*) FROM harness_job_quota_sources", [], |r| {
                r.get(0)
            })?;
        if count >= 64 {
            return Err(Error::new(
                "busy",
                "Quota source retention is full; no authority was evicted",
            )
            .into());
        }
    }
    let binding = observation
        .binding
        .as_ref()
        .filter(|binding| validate_binding(binding).is_ok());
    let expires = i64::try_from(observation.expires_elapsed_ms).ok();
    let safe_reason = !observation.reason.is_empty()
        && observation.reason.len() <= 64
        && observation
            .reason
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    let valid =
        safe_reason && expires.is_some() && binding.is_some() == observation.binding.is_some();
    let gate = observation.source_id.starts_with(GATE_PREFIX);
    let valid = valid && (!gate || observation.binding.is_none());
    let eligible =
        valid && observation.eligible && (gate || (binding.is_some() && expires != Some(0)));
    let reason = if !valid {
        "invalid_observation"
    } else if observation.eligible && binding.is_none() && !gate {
        "binding_unavailable"
    } else {
        observation.reason.as_str()
    };
    tx.execute(
        "INSERT INTO harness_job_quota_sources(source_id,revision,context_id,account_fingerprint,expires_elapsed_ms,eligible,reason)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,context_id=excluded.context_id,
             account_fingerprint=excluded.account_fingerprint,expires_elapsed_ms=excluded.expires_elapsed_ms,
             eligible=excluded.eligible,reason=excluded.reason",
        params![observation.source_id, revision, binding.map(|b| &b.context_id),
            binding.map(|b| &b.account_fingerprint), expires.unwrap_or(0), eligible, reason],
    )?;
    Ok(true)
}

fn effective_binding(connection: &Connection, occurrence: &str) -> Result<Option<(Binding, bool)>> {
    let spec: String = connection.query_row(
        "SELECT spec FROM harness_job_occurrences WHERE id=?1",
        [occurrence],
        |row| row.get(0),
    )?;
    let spec: Value = serde_json::from_str(&spec)?;
    let Some(policy) = spec.get("quotaPolicy").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let policy: Policy = serde_json::from_value(policy.clone())?;
    let original = policy.binding();
    validate_binding(&original)?;
    let authorization: Option<(String, String, bool)> = connection
        .query_row(
            "SELECT context_id,account_fingerprint,paused FROM harness_job_quota_authorizations WHERE occurrence_id=?1",
            [occurrence],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(Some(match authorization {
        Some((context_id, account_fingerprint, paused)) => (
            Binding {
                context_id,
                account_fingerprint,
            },
            paused,
        ),
        None => (original, false),
    }))
}

pub fn view(connection: &Connection, occurrence: &str, elapsed: u64) -> Result<Value> {
    let Some((binding, paused)) = effective_binding(connection, occurrence)? else {
        return gate_view(connection, occurrence, elapsed);
    };
    let elapsed = i64::try_from(elapsed)?;
    let source: Option<(i64, bool, i64, String)> = connection
        .query_row(
            "SELECT revision,eligible,expires_elapsed_ms,reason FROM harness_job_quota_sources
         WHERE context_id=?1 AND account_fingerprint=?2
         ORDER BY (eligible=1 AND expires_elapsed_ms>?3) DESC,revision DESC,source_id LIMIT 1",
            params![binding.context_id, binding.account_fingerprint, elapsed],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let eligible = !paused
        && source
            .as_ref()
            .is_some_and(|(_, eligible, expires, _)| *eligible && *expires > elapsed);
    let reason = if paused {
        "owner_authorization_required"
    } else if eligible {
        "observed"
    } else {
        match &source {
            Some((_, true, _, _)) => "observation_expired",
            Some((_, false, _, reason)) => reason,
            None => "source_unavailable",
        }
    };
    Ok(
        json!({"state":if eligible {"eligible"} else {"waiting"},"reason":reason,
        "contextId":binding.context_id,"accountFingerprint":binding.account_fingerprint,
        "sourceRevision":source.as_ref().map(|source|source.0)}),
    )
}

pub fn guard_occurrence(connection: &Connection, occurrence: &str, elapsed: u64) -> Result<()> {
    if matches!(
        view(connection, occurrence, elapsed)?["state"].as_str(),
        Some("waiting" | "held")
    ) {
        return Err(Error::new(
            "quota_wait",
            "Configured provider quota permission is unavailable; inspect quota and occurrence authorization",
        ).into());
    }
    Ok(())
}

pub fn guard_dispatch(
    connection: &Connection,
    dispatch: &job_attempts::Dispatch,
    elapsed: u64,
) -> Result<()> {
    job_attempts::guard(connection, dispatch, &["dispatching"])?;
    guard_occurrence(connection, &dispatch.occurrence, elapsed)
}

pub fn permit_for_run(connection: &Connection, run: &str) -> Result<Option<Permit>> {
    let retained: Option<String> = connection
        .query_row(
            "SELECT occurrence_id FROM harness_job_attempts WHERE run_id=?1",
            [run],
            |row| row.get(0),
        )
        .optional()?;
    let Some(retained) = retained else {
        return Ok(None);
    };
    let Some((binding, _)) = effective_binding(connection, &retained)? else {
        return Ok(None);
    };
    crate::job_cancellations::guard_run(connection, run)?;
    let current: Option<(String,String)> = connection.query_row(
        "SELECT o.id,a.id FROM harness_job_occurrences o JOIN harness_job_attempts a
         ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id
         WHERE o.run_id=?1 AND a.run_id=?1 AND o.state IN ('dispatching','running','needsValidation')
           AND a.state=o.state",
        [run], |row|Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    let Some((occurrence_id, job_attempt_id)) = current else {
        return Err(Error::new(
            "job_attempt_conflict",
            "The job run is no longer the current admissible generation",
        )
        .into());
    };
    Ok(Some(Permit {
        run_id: run.into(),
        occurrence_id,
        job_attempt_id,
        binding,
    }))
}

pub fn guard_permit(connection: &Connection, permit: &Permit, elapsed: u64) -> Result<()> {
    let current = permit_for_run(connection, &permit.run_id)?;
    if !current.is_some_and(|current| {
        current.occurrence_id == permit.occurrence_id
            && current.job_attempt_id == permit.job_attempt_id
            && current.binding == permit.binding
    }) {
        return Err(Error::new(
            "quota_binding_conflict",
            "The exact job generation or quota authorization changed",
        )
        .into());
    }
    guard_occurrence(connection, &permit.occurrence_id, elapsed)
}

#[allow(clippy::too_many_arguments)]
pub fn authorize(
    tx: &Transaction<'_>,
    job: &str,
    occurrence: &str,
    expected_context: &str,
    expected_account: &str,
    binding: &Binding,
    now: u64,
) -> Result<()> {
    validate_binding(&Binding {
        context_id: expected_context.into(),
        account_fingerprint: expected_account.into(),
    })?;
    validate_binding(binding)?;
    let Some((current, _)) = effective_binding(tx, occurrence)? else {
        return Err(Error::new(
            "occurrence_conflict",
            "This occurrence has no frozen quota policy",
        )
        .into());
    };
    if current.context_id != expected_context || current.account_fingerprint != expected_account {
        return Err(Error::new(
            "quota_binding_conflict",
            "Quota authorization changed; inspect the current occurrence binding",
        )
        .into());
    }
    let allowed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_occurrences o
          WHERE o.id=?1 AND o.job_id=?2
            AND NOT EXISTS(SELECT 1 FROM harness_job_cancellations WHERE occurrence_id=o.id)
            AND ((o.state='queued' AND o.run_id IS NULL AND o.current_job_attempt_id IS NULL
                 AND o.started_at IS NULL AND NOT EXISTS(SELECT 1 FROM harness_job_attempts WHERE occurrence_id=o.id))
              OR (o.state='retryWaiting' AND EXISTS(
                 SELECT 1 FROM harness_job_attempts a JOIN harness_job_retries retry ON retry.source_attempt_id=a.id
                 WHERE a.id=o.current_job_attempt_id AND a.occurrence_id=o.id AND a.state='failed'
                   AND a.reason='launch_no_effect' AND a.finished_at IS NOT NULL AND a.dispatch_token IS NULL
                   AND retry.occurrence_id=o.id AND retry.state='waiting' AND retry.target_attempt_id IS NULL
                   AND NOT EXISTS(SELECT 1 FROM harness_job_attempts later WHERE later.occurrence_id=o.id AND later.ordinal>a.ordinal)))))",
        params![occurrence,job], |row|row.get(0),
    )?;
    if !allowed || crate::job_timeouts::owns_occurrence(tx, occurrence)? {
        return Err(Error::new(
            "occurrence_conflict",
            "Quota authorization is limited to unclaimed queued work or a waiting no-effect retry",
        )
        .into());
    }
    tx.execute(
        "INSERT INTO harness_job_quota_authorizations(occurrence_id,context_id,account_fingerprint,paused,authorized_at)
         VALUES(?1,?2,?3,0,?4) ON CONFLICT(occurrence_id) DO UPDATE SET context_id=excluded.context_id,
             account_fingerprint=excluded.account_fingerprint,paused=0,authorized_at=excluded.authorized_at",
        params![occurrence,binding.context_id,binding.account_fingerprint,i64::try_from(now)?],
    )?;
    Ok(())
}

pub fn recover(tx: &Transaction<'_>, now: u64) -> Result<()> {
    tx.execute("DELETE FROM harness_job_quota_sources", [])?;
    tx.execute(
        "INSERT INTO harness_job_quota_authorizations(occurrence_id,context_id,account_fingerprint,paused,authorized_at)
         SELECT o.id,COALESCE(a.context_id,json_extract(o.spec,'$.quotaPolicy.contextId')),
             COALESCE(a.account_fingerprint,json_extract(o.spec,'$.quotaPolicy.accountFingerprint')),1,?1
         FROM harness_job_occurrences o LEFT JOIN harness_job_quota_authorizations a ON a.occurrence_id=o.id
         WHERE json_type(o.spec,'$.quotaPolicy')='object'
           AND o.state IN ('queued','retryWaiting','dispatching','prechecking','running','needsValidation','canceling','reconcile')
         ON CONFLICT(occurrence_id) DO UPDATE SET paused=1",
        [i64::try_from(now)?],
    )?;
    Ok(())
}
