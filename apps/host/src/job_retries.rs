use crate::{api_error::Error, job_attempts, job_definitions};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const UNCERTAIN_FAILURES: &[&str] = &[
    "dispatch_unconfirmed",
    "dispatch_interrupted",
    "launch_unconfirmed",
    "host_restarted",
];

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

fn parsed(text: Option<String>) -> Value {
    text.and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

/// Only immutable decision facts belong in an old generation's public view.
/// Claiming or canceling a later retry cannot rewrite a previously read body.
pub fn view(connection: &Connection, source_attempt: &str) -> Result<Value> {
    let row = connection
        .query_row(
            "SELECT native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,class,probe,state
             FROM harness_job_retries WHERE source_attempt_id=?1",
            [source_attempt],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((native, receipt, decided, not_before, next, class, probe, state)) = row else {
        return Ok(Value::Null);
    };
    if state == "adopted" || (class != "noEffect" && probe.is_none()) {
        return Ok(Value::Null);
    }
    let mut value = json!({
        "jobAttemptId":source_attempt,
        "attemptId":native,
        "launchReceiptId":receipt,
        "decidedAt":decided,
        "notBefore":not_before,
        "nextOrdinal":next,
        "class":class
    });
    if class != "noEffect" {
        value["probe"] = parsed(probe);
    }
    Ok(value)
}

struct Ledger {
    class: String,
    failure: Option<String>,
    key: Option<String>,
    state: String,
    probe: Option<String>,
    claim_probe: Option<String>,
    decided: i64,
    not_before: i64,
    next: Option<i64>,
    counterpart: Option<String>,
}

fn ledger(connection: &Connection, column: &str, attempt: &str) -> Result<Option<Ledger>> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT class,failure,launch_key,state,probe,claim_probe,decided_at,not_before,
                        next_ordinal,target_attempt_id,source_attempt_id
                 FROM harness_job_retries WHERE {column}=?1"
            ),
            [attempt],
            |r| {
                Ok(Ledger {
                    class: r.get(0)?,
                    failure: r.get(1)?,
                    key: r.get(2)?,
                    state: r.get(3)?,
                    probe: r.get(4)?,
                    claim_probe: r.get(5)?,
                    decided: r.get(6)?,
                    not_before: r.get(7)?,
                    next: r.get(8)?,
                    counterpart: if column == "source_attempt_id" {
                        r.get(9)?
                    } else {
                        r.get(10)?
                    },
                })
            },
        )
        .optional()?)
}

impl Ledger {
    fn decision(&self) -> &'static str {
        if self.state == "adopted" {
            "adopted"
        } else if self.next.is_some() {
            "retryWaiting"
        } else if self.probe.is_some() {
            "blocked"
        } else if self.state == "canceled" {
            "canceled"
        } else {
            "probing"
        }
    }
    fn facts(&self) -> Value {
        let decided = self.decision() != "probing";
        json!({
            "class":self.class,
            "failure":self.failure,
            "launchKey":self.key,
            "decision":self.decision(),
            "decidedAt":decided.then_some(self.decided),
            "notBefore":decided.then_some(self.not_before),
            "nextOrdinal":self.next,
            "probe":parsed(self.probe.clone())
        })
    }
}

pub fn classification(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "source_attempt_id", attempt)?
        .map(|ledger| ledger.facts())
        .unwrap_or(Value::Null))
}

pub fn diagnostic(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "source_attempt_id", attempt)?
        .map(|ledger| {
            let mut value = ledger.facts();
            value["state"] = ledger.state.clone().into();
            value["retryJobAttemptId"] = ledger.counterpart.clone().into();
            value["claimProbe"] = parsed(ledger.claim_probe.clone());
            value
        })
        .unwrap_or(Value::Null))
}

pub fn admission(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "target_attempt_id", attempt)?
        .map(|ledger| {
            json!({
                "sourceJobAttemptId":ledger.counterpart,
                "class":ledger.class,
                "claimProbe":parsed(ledger.claim_probe)
            })
        })
        .unwrap_or(Value::Null))
}

struct Source {
    occurrence: String,
    job: String,
    id: String,
    ordinal: i64,
    run: Option<String>,
    spec: String,
    state: String,
    started: i64,
    producer: bool,
}

fn source(connection: &Connection, occurrence: &str) -> Result<Option<Source>> {
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

fn policy(source: &Source) -> Option<Policy> {
    let spec: Value = serde_json::from_str(&source.spec).ok()?;
    let policy: Policy = serde_json::from_value(spec.get("retry")?.clone()).ok()?;
    policy.validate().ok()?;
    Some(policy)
}

fn launch_key(source: &Source) -> String {
    format!(
        "{}:executor",
        job_attempts::key_prefix(&source.job, &source.occurrence, source.ordinal)
    )
}

fn precheck_settled(connection: &Connection, source: &Source) -> Result<bool> {
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

struct Evidence {
    native: String,
    receipt: String,
}

/// A label such as launchFailed is not proof. Read the exact bound receipt and
/// reject every other task admission, result, delivery, exit or native receipt.
fn evidence(connection: &Connection, source: &Source) -> Result<Option<Evidence>> {
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
    // SQLite's json_extract maps false and 0 to the same SQL integer. Parsing
    // the JSON value keeps those distinct and refuses absent/null/string data.
    if !no_effect_result(Some(&result)) {
        return Ok(None);
    }
    Ok(Some(Evidence { native, receipt }))
}

fn no_effect_result(result: Option<&str>) -> bool {
    result
        .and_then(|result| serde_json::from_str::<Value>(result).ok())
        .is_some_and(|result| {
            result.get("effectStarted") == Some(&Value::Bool(false))
                && result["taskResult"].is_null()
        })
}

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

fn authorized(connection: &Connection, source: &Source) -> Result<bool> {
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

fn authorized_uncertain(
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Found {
    Absent,
    NoEffectProven,
    Attempt,
    Session,
}

impl Found {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::NoEffectProven => "noEffectProven",
            Self::Attempt => "attemptFound",
            Self::Session => "sessionFound",
        }
    }
}

struct Probe {
    found: Found,
    key: String,
    run: Option<String>,
    executor_accepted: bool,
    attempt: Option<String>,
    session: Option<String>,
    receipt: Option<String>,
    attempt_state: Option<String>,
}

impl Probe {
    fn json(&self, now: u64) -> Value {
        json!({
            "observedAt":now,
            "result":self.found.label(),
            "launchKey":self.key,
            "runId":self.run,
            "executorAccepted":self.executor_accepted,
            "attemptId":self.attempt,
            "attemptState":self.attempt_state,
            "sessionId":self.session,
            "launchReceiptId":self.receipt
        })
    }
}

type NativeRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn probe(connection: &Connection, source: &Source) -> Result<Probe> {
    let key = launch_key(source);
    let prefix = job_attempts::key_prefix(&source.job, &source.occurrence, source.ordinal);
    let run = match &source.run {
        Some(run) => Some(run.clone()),
        None => connection
            .query_row(
                "SELECT json_extract(view,'$.run.id') FROM workflow_mutations
                 WHERE issuer='owner' AND key=?1 AND json_valid(view)",
                [format!("{prefix}:run")],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten(),
    };
    let executor_accepted: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_mutations WHERE issuer='owner' AND key=?1)",
        [&key],
        |r| r.get(0),
    )?;
    let mut probe = Probe {
        found: Found::Absent,
        key,
        run: run.clone(),
        executor_accepted,
        attempt: None,
        session: None,
        receipt: None,
        attempt_state: None,
    };
    let Some(run) = run else {
        return Ok(probe);
    };
    let rows: Vec<NativeRow> = {
        let mut query = connection.prepare(
            "SELECT n.id,n.session_id,n.state,l.operation_id,p.phase,p.result
             FROM workflow_tasks t JOIN workflow_attempts n ON n.task_id=t.id
             LEFT JOIN workflow_launches l ON l.attempt_id=n.id
             LEFT JOIN operation_receipts p ON p.id=l.operation_id
             WHERE t.run_id=?1 ORDER BY n.ordinal,n.rowid",
        )?;
        query
            .query_map([&run], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (attempt, session, state, receipt, phase, result) in rows {
        let session_seen: bool = connection.query_row(
            "SELECT ?2 IS 'created'
                OR EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)
                OR EXISTS(SELECT 1 FROM domain_events WHERE session_id=?1)
                OR EXISTS(SELECT 1 FROM operation_receipts WHERE session_id=?1 AND id IS NOT ?3)",
            params![session, phase, receipt],
            |r| r.get(0),
        )?;
        let proven = state == "launchFailed"
            && phase.as_deref() == Some("failed")
            && no_effect_result(result.as_deref())
            && !session_seen;
        let found = if session_seen {
            Found::Session
        } else if proven {
            Found::NoEffectProven
        } else {
            Found::Attempt
        };
        if probe.found == Found::Absent || found != Found::NoEffectProven {
            probe.found = found;
            probe.attempt = Some(attempt);
            probe.session = Some(session);
            probe.receipt = receipt;
            probe.attempt_state = Some(state);
        }
        if found != Found::NoEffectProven {
            break;
        }
    }
    Ok(probe)
}

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

fn settle_generation(tx: &Transaction<'_>, source: &Source, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE harness_job_attempts
         SET state='failed',reason='launch_no_effect',finished_at=COALESCE(finished_at,?2),
             dispatch_token=NULL WHERE id=?1",
        params![source.id, now],
    )?;
    Ok(())
}

fn wait_for_retry(
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

fn deadline(policy: &Policy, ordinal: u16, now: u64) -> Result<i64> {
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

fn eligible(source: &Source) -> Option<(Policy, u16)> {
    let policy = policy(source)?;
    if source.ordinal < 1 || source.ordinal >= i64::from(policy.max_attempts) {
        return None;
    }
    Some((policy, u16::try_from(source.ordinal).ok()?))
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

fn adopt(
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

fn settle(tx: &Transaction<'_>, source: &Source, failure: &str, now: u64) -> Result<()> {
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

/// An owner can cancel a known no-effect backoff without inventing native stop
/// receipts. The caller owns the occurrence transition and cancellation event.
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
