use crate::{
    api_error::Error,
    caller::Authority,
    event_log::{DomainEvent, Observation, Service, append_transaction, model},
    jobs::LaunchSpec,
    launchers::Program,
    protocol::Command,
    sessions::{PtyEvent, State},
    status::now_millis,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, mpsc};

pub(crate) const KEY_RETENTION: i64 = 1024;
pub(crate) const RECORD_LIMIT: i64 = 64;
pub(crate) const RECORD_BYTES: usize = 16 * 1024;
pub(crate) const RESUME_WAIT: Duration = Duration::from_secs(65);
pub(crate) const IDLE_MINUTES: std::ops::RangeInclusive<u64> = 15..=1440;
const RESUME_POLL: Duration = Duration::from_millis(100);
const IDLE_TICK: Duration = Duration::from_secs(30);
const READINESS_REASON: &str = "Hibernated; resume restarts the recorded provider conversation";
const OPEN_DELIVERIES: &str = "'queued','dispatching','unknown'";
const OPEN_RECEIPTS: &str = "'accepted','dispatching','received','started','waiting','unknown'";
const ACTIVE_RUNS: &str = "'active','draining','canceling','stopping'";

#[derive(Debug)]
pub(crate) struct Refusal {
    pub code: &'static str,
    message: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Refusal {}

pub(crate) fn refuse(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Refusal {
        code,
        message: message.into(),
    }
    .into()
}

pub(crate) fn code(error: &anyhow::Error) -> Option<&'static str> {
    error
        .downcast_ref::<Refusal>()
        .map(|refusal| refusal.code)
        .or_else(|| error.downcast_ref::<Error>().map(|error| error.code))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub session_id: String,
    pub spec: LaunchSpec,
    pub snapshot: Value,
    pub hibernated_at: u64,
    pub trigger: model::HibernationTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_resume_failure: Option<String>,
    #[serde(default)]
    pub attention_revision: u64,
}

impl Record {
    pub fn program(&self) -> Program {
        self.spec.program
    }

    pub fn conversation_id(&self) -> &str {
        self.spec
            .resume
            .as_ref()
            .map_or("", |target| target.conversation_id.as_str())
    }

    pub fn summary(&self) -> Value {
        json!({
            "state": "hibernated",
            "hibernatedAt": self.hibernated_at,
            "conversationId": self.conversation_id(),
            "trigger": self.trigger,
            "lastResumeFailure": self.last_resume_failure,
        })
    }

    pub fn view(&self, now: u64) -> Value {
        let mut view = self.snapshot.clone();
        let status = &self.snapshot["status"];
        let observed = status["freshness"]["observedAt"]
            .as_u64()
            .or_else(|| status["updatedAt"].as_u64())
            .unwrap_or(self.hibernated_at);
        let state = status["freshness"]["lastKnown"]["state"]
            .as_str()
            .or_else(|| status["state"].as_str())
            .unwrap_or("unknown")
            .to_owned();
        if let Some(fields) = view.as_object_mut() {
            for field in ["resume", "lifecycle", "repositoryContext", "searchRoot"] {
                fields.remove(field);
            }
        }
        view["running"] = false.into();
        view["controllerId"] = Value::Null;
        view["wakeAt"] = Value::Null;
        view["quotaWakeId"] = Value::Null;
        view["readiness"] = json!({"phase":"exited","initialized":true,"reason":READINESS_REASON});
        if view["status"].is_object() {
            view["status"]["freshness"] = json!({
                "source": "journal",
                "observedAt": observed,
                "ageMs": now.saturating_sub(observed),
                "stale": true,
                "boundMs": crate::freshness::bound(crate::freshness::Source::Journal),
                "lastKnown": {"state": state, "observedAt": observed},
            });
        }
        view["hibernation"] = self.summary();
        view
    }

    pub fn hibernated_reply(&self) -> Value {
        json!({
            "type": "sessionHibernation",
            "sessionId": self.session_id,
            "state": "hibernated",
            "hibernation": self.summary(),
            "replayed": false,
        })
    }

    pub fn resumed_reply(&self, reason: model::ResumeReason) -> Value {
        json!({
            "type": "sessionHibernation",
            "sessionId": self.session_id,
            "state": "resumed",
            "resume": {"state": "verified", "conversationId": self.conversation_id()},
            "reason": reason,
            "replayed": false,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IdlePolicy {
    idle_after_ms: Option<u64>,
}

impl IdlePolicy {
    pub fn from_minutes(minutes: Option<u64>) -> Result<Self> {
        match minutes {
            None => Ok(Self::default()),
            Some(minutes) if IDLE_MINUTES.contains(&minutes) => Ok(Self {
                idle_after_ms: Some(minutes * 60_000),
            }),
            Some(_) => Err(refuse(
                "invalid_argument",
                format!(
                    "Idle hibernation needs a bound of {}-{} minutes",
                    IDLE_MINUTES.start(),
                    IDLE_MINUTES.end()
                ),
            )),
        }
    }

    pub fn enabled(&self) -> bool {
        self.idle_after_ms.is_some()
    }

    pub fn due(&self, idle_since: u64, now: u64) -> bool {
        self.idle_after_ms
            .is_some_and(|bound| now.saturating_sub(idle_since) >= bound)
    }

    pub fn view(&self) -> Value {
        json!({"enabled": self.enabled(), "idleAfterMs": self.idle_after_ms})
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    records: HashMap<String, Record>,
    resuming: HashMap<String, Record>,
    pub idle: IdlePolicy,
    pub restore: crate::restore::Report,
    pub restore_policy: crate::restore::Policy,
}

impl Registry {
    pub fn contains(&self, id: &str) -> bool {
        self.records.contains_key(id)
    }

    pub fn resuming(&self, id: &str) -> bool {
        self.resuming.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.records.get(id)
    }

    pub fn insert(&mut self, record: Record) {
        self.resuming.remove(&record.session_id);
        self.records.insert(record.session_id.clone(), record);
    }

    pub fn remove(&mut self, id: &str) -> Option<Record> {
        self.records.remove(id)
    }

    pub fn begin_resume(&mut self, id: &str) -> Option<Record> {
        let record = self.records.remove(id)?;
        self.resuming.insert(id.to_owned(), record.clone());
        Some(record)
    }

    pub fn cancel_resume(&mut self, id: &str) {
        if let Some(record) = self.resuming.remove(id) {
            self.records.insert(id.to_owned(), record);
        }
    }

    pub fn take_resuming(&mut self, id: &str) -> Option<Record> {
        self.resuming.remove(id)
    }

    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.records.values()
    }

    pub fn views(&self, now: u64) -> Vec<Value> {
        self.records
            .values()
            .map(|record| record.view(now))
            .collect()
    }
}

pub(crate) fn merge_views(sessions: &mut Vec<Value>, registry: &Registry, now: u64) {
    if registry.records.is_empty() {
        return;
    }
    sessions.extend(registry.views(now));
    sessions.sort_by(|left, right| {
        left["createdAt"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["createdAt"].as_str().unwrap_or_default())
    });
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KeyRecord {
    pub operation: String,
    pub session_id: String,
    pub result: Option<Value>,
}

pub(crate) enum Work {
    Lookup(String),
    Prepare {
        key: String,
        record: Box<Record>,
    },
    Abort {
        session_id: String,
        key: String,
    },
    Commit {
        key: String,
        record: Box<Record>,
    },
    BeginResume {
        session_id: String,
        key: String,
    },
    CancelResume {
        session_id: String,
        key: String,
    },
    Resumed {
        key: String,
        record: Box<Record>,
        reason: model::ResumeReason,
    },
    ResumeFailed {
        key: String,
        record: Box<Record>,
        result: Value,
    },
    Recover,
    Discard(Vec<String>),
    RecordShutdown {
        entries: Vec<crate::restore::Entry>,
    },
    RestorePlan,
    RestoreSettle(crate::restore::Entry),
}

pub(crate) enum Reply {
    Key(Option<KeyRecord>),
    Records(Vec<Record>),
    Restore(Vec<crate::restore::Entry>),
    Done,
}

pub(crate) fn valid_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
        return Err(refuse(
            "invalid_argument",
            "Idempotency key must be 1-128 bytes without control characters",
        ));
    }
    Ok(())
}

pub(crate) fn valid_session(id: &str) -> Result<()> {
    if id.len() == 32
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(refuse(
            "invalid_argument",
            "Session ID must be a 32-character host session ID",
        ))
    }
}

fn table(transaction: &Transaction<'_>, name: &str) -> Result<bool> {
    Ok(transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )?)
}

fn found(transaction: &Transaction<'_>, tables: &[&str], sql: &str, session: &str) -> Result<bool> {
    for name in tables {
        if !table(transaction, name)? {
            return Ok(false);
        }
    }
    Ok(transaction.query_row(sql, [session], |row| row.get(0))?)
}

fn durable_refusal(transaction: &Transaction<'_>, session: &str) -> Result<Option<anyhow::Error>> {
    let open_attempts = crate::workflow_session_reuse::OPEN_ATTEMPTS
        .iter()
        .map(|state| format!("'{state}'"))
        .collect::<Vec<_>>()
        .join(",");
    let checks: [(&'static str, &str, &[&str], String); 6] = [
        (
            "attempt_unsettled",
            "A workflow attempt bound to this session is unsettled",
            &["workflow_attempts"],
            format!("SELECT EXISTS(SELECT 1 FROM workflow_attempts WHERE session_id=?1 AND state IN ({open_attempts}))"),
        ),
        (
            "attempt_unsettled",
            "An instruction delivery to this session is unsettled; inspect its run",
            &["workflow_deliveries", "workflow_attempts"],
            format!("SELECT EXISTS(SELECT 1 FROM workflow_deliveries d JOIN workflow_attempts a ON a.id=d.attempt_id WHERE a.session_id=?1 AND d.phase IN ({OPEN_DELIVERIES}))"),
        ),
        (
            "attempt_unsettled",
            "A native operation on this session is unsettled; inspect its receipt",
            &["operation_receipts"],
            format!("SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE session_id=?1 AND phase IN ({OPEN_RECEIPTS}))"),
        ),
        (
            "decision_pending",
            "A decision asked by or for this session is still pending",
            &["workflow_decisions", "workflow_attempts", "workflow_runs"],
            "SELECT EXISTS(SELECT 1 FROM workflow_decisions d JOIN workflow_attempts a ON a.id=d.attempt_id WHERE a.session_id=?1 AND d.state='pending') OR EXISTS(SELECT 1 FROM workflow_decisions d JOIN workflow_runs r ON r.id=d.run_id WHERE r.coordinator_id=?1 AND d.state='pending')".into(),
        ),
        (
            "run_active",
            "This session coordinates an active run; drain or finish it first",
            &["workflow_runs"],
            format!("SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE coordinator_id=?1 AND state IN ({ACTIVE_RUNS}))"),
        ),
        (
            "wake_armed",
            "A quota wake is armed for this session; disable it first",
            &["quota_wake_arms"],
            "SELECT EXISTS(SELECT 1 FROM quota_wake_arms WHERE session_id=?1 AND phase IN ('armed','dispatching'))".into(),
        ),
    ];
    for (code, message, tables, sql) in checks {
        if found(transaction, tables, &sql, session)? {
            return Ok(Some(refuse(code, message)));
        }
    }
    Ok(None)
}

fn lookup(connection: &Connection, key: &str) -> Result<Option<KeyRecord>> {
    let row: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT operation,session_id,result FROM session_hibernation_keys WHERE key=?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    row.map(|(operation, session_id, result)| {
        Ok(KeyRecord {
            operation,
            session_id,
            result: result.map(|text| serde_json::from_str(&text)).transpose()?,
        })
    })
    .transpose()
}

fn reserve(
    transaction: &Transaction<'_>,
    key: &str,
    operation: &str,
    session: &str,
    now: u64,
) -> Result<()> {
    valid_key(key)?;
    if lookup(transaction, key)?.is_some() {
        return Err(refuse(
            "busy",
            "This idempotency key is already in use; look it up before retrying",
        ));
    }
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM session_hibernation_keys", [], |row| {
            row.get(0)
        })?;
    if count >= KEY_RETENTION {
        transaction.execute(
            "DELETE FROM session_hibernation_keys WHERE key IN (SELECT key FROM session_hibernation_keys WHERE phase='done' ORDER BY created_at,key LIMIT ?1)",
            [count - KEY_RETENTION + 1],
        )?;
    }
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM session_hibernation_keys", [], |row| {
            row.get(0)
        })?;
    if count >= KEY_RETENTION {
        return Err(refuse(
            "busy",
            "Hibernation key capacity is exhausted; no history was discarded",
        ));
    }
    transaction.execute(
        "INSERT INTO session_hibernation_keys(key,operation,session_id,phase,created_at) VALUES(?1,?2,?3,'pending',?4)",
        params![key, operation, session, now as i64],
    )?;
    Ok(())
}

fn settle(transaction: &Transaction<'_>, key: &str, result: &Value) -> Result<()> {
    let changed = transaction.execute(
        "UPDATE session_hibernation_keys SET phase='done',result=?2 WHERE key=?1 AND phase='pending'",
        params![key, result.to_string()],
    )?;
    if changed != 1 {
        return Err(anyhow!("Hibernation key is no longer pending"));
    }
    Ok(())
}

fn encode(record: &Record) -> Result<String> {
    let text = serde_json::to_string(record)?;
    if text.len() > RECORD_BYTES {
        return Err(refuse(
            "budget_snapshot_capacity",
            "The session snapshot is too large to hibernate",
        ));
    }
    Ok(text)
}

fn row_state(transaction: &Transaction<'_>, session: &str) -> Result<Option<String>> {
    Ok(transaction
        .query_row(
            "SELECT state FROM session_hibernations WHERE session_id=?1",
            [session],
            |row| row.get(0),
        )
        .optional()?)
}

fn journal(
    transaction: &Transaction<'_>,
    record: &Record,
    now: u64,
    resumed: Option<model::ResumeReason>,
) -> Result<()> {
    let program = crate::event_log::program(record.program());
    let conversation_id = record.conversation_id().to_owned();
    let event = if let Some(reason) = resumed {
        DomainEvent::SessionResumed(model::SessionResumed {
            program,
            conversation_id,
            reason: Some(reason),
        })
    } else {
        DomainEvent::SessionHibernated(model::SessionHibernated {
            program,
            conversation_id,
            trigger: record.trigger,
        })
    };
    append_transaction(
        transaction,
        vec![Observation {
            session_id: Some(record.session_id.clone()),
            at: now,
            event,
        }],
    )?;
    Ok(())
}

fn change(transaction: &Transaction<'_>, sql: &str, args: impl rusqlite::Params) -> Result<()> {
    if transaction.execute(sql, args)? != 1 {
        return Err(refuse(
            "busy",
            "The hibernation record changed concurrently; inspect the session",
        ));
    }
    Ok(())
}

pub(crate) fn handle(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    if let Work::Lookup(key) = &work {
        return Ok(Reply::Key(lookup(connection, key)?));
    }
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let reply = match work {
        Work::Lookup(_) => unreachable!(),
        Work::Prepare { key, record } => {
            valid_session(&record.session_id)?;
            match row_state(&transaction, &record.session_id)?.as_deref() {
                Some("hibernated") => {
                    return Err(refuse(
                        "session_hibernated",
                        "Session is already hibernated",
                    ));
                }
                Some(_) => {
                    return Err(refuse(
                        "busy",
                        "Another hibernation operation is running for this session",
                    ));
                }
                None => {}
            }
            if let Some(refusal) = durable_refusal(&transaction, &record.session_id)? {
                return Err(refusal);
            }
            let count: i64 =
                transaction.query_row("SELECT count(*) FROM session_hibernations", [], |row| {
                    row.get(0)
                })?;
            if count >= RECORD_LIMIT {
                return Err(refuse("busy", "Hibernated session capacity is exhausted"));
            }
            reserve(&transaction, &key, "hibernate", &record.session_id, now)?;
            transaction.execute(
                "INSERT INTO session_hibernations(session_id,state,record,operation_key,updated_at) VALUES(?1,'stopping',?2,?3,?4)",
                params![record.session_id, encode(&record)?, key, now as i64],
            )?;
            Reply::Done
        }
        Work::Abort { session_id, key } => {
            transaction.execute(
                "DELETE FROM session_hibernations WHERE session_id=?1 AND state='stopping' AND operation_key=?2",
                params![session_id, key],
            )?;
            transaction.execute(
                "DELETE FROM session_hibernation_keys WHERE key=?1 AND phase='pending'",
                [&key],
            )?;
            Reply::Done
        }
        Work::Commit { key, record } => {
            change(
                &transaction,
                "UPDATE session_hibernations SET state='hibernated',record=?2,updated_at=?4 WHERE session_id=?1 AND state='stopping' AND operation_key=?3",
                params![record.session_id, encode(&record)?, key, now as i64],
            )?;
            settle(&transaction, &key, &record.hibernated_reply())?;
            journal(&transaction, &record, now, None)?;
            if record.trigger == model::HibernationTrigger::Shutdown {
                crate::restore::mark_pending(&transaction, &record.session_id, now)?;
            }
            Reply::Done
        }
        Work::BeginResume { session_id, key } => {
            match row_state(&transaction, &session_id)?.as_deref() {
                Some("hibernated") => {}
                Some(_) => {
                    return Err(refuse(
                        "busy",
                        "Another hibernation operation is running for this session",
                    ));
                }
                None => {
                    return Err(refuse(
                        "session_not_hibernated",
                        "Session is not hibernated",
                    ));
                }
            }
            reserve(&transaction, &key, "resume", &session_id, now)?;
            change(
                &transaction,
                "UPDATE session_hibernations SET state='resuming',operation_key=?2,updated_at=?3 WHERE session_id=?1 AND state='hibernated'",
                params![session_id, key, now as i64],
            )?;
            Reply::Done
        }
        Work::CancelResume { session_id, key } => {
            transaction.execute(
                "UPDATE session_hibernations SET state='hibernated',updated_at=?3 WHERE session_id=?1 AND state='resuming' AND operation_key=?2",
                params![session_id, key, now as i64],
            )?;
            transaction.execute(
                "DELETE FROM session_hibernation_keys WHERE key=?1 AND phase='pending'",
                [&key],
            )?;
            Reply::Done
        }
        Work::Resumed {
            key,
            record,
            reason,
        } => {
            change(
                &transaction,
                "DELETE FROM session_hibernations WHERE session_id=?1 AND state='resuming' AND operation_key=?2",
                params![record.session_id, key],
            )?;
            settle(&transaction, &key, &record.resumed_reply(reason))?;
            journal(&transaction, &record, now, Some(reason))?;
            Reply::Done
        }
        Work::ResumeFailed {
            key,
            record,
            result,
        } => {
            change(
                &transaction,
                "UPDATE session_hibernations SET state='hibernated',record=?2,updated_at=?4 WHERE session_id=?1 AND state='resuming' AND operation_key=?3",
                params![record.session_id, encode(&record)?, key, now as i64],
            )?;
            settle(&transaction, &key, &result)?;
            Reply::Done
        }
        Work::Recover => {
            transaction.execute(
                "DELETE FROM session_hibernations WHERE state='stopping'",
                [],
            )?;
            if table(&transaction, "recovery")? {
                transaction.execute(
                    "DELETE FROM session_hibernations WHERE session_id NOT IN (SELECT id FROM recovery)",
                    [],
                )?;
            }
            transaction.execute(
                "UPDATE session_hibernations SET state='hibernated',updated_at=?1 WHERE state='resuming'",
                [now as i64],
            )?;
            transaction.execute(
                "UPDATE session_hibernation_keys SET phase='done',result=?1 WHERE phase='pending'",
                [json!({"type":"error","code":"host_restart","message":"Host restarted before the hibernation outcome was confirmed; inspect the session"}).to_string()],
            )?;
            let records = {
                let mut statement = transaction.prepare(
                    "SELECT record FROM session_hibernations WHERE state='hibernated' ORDER BY updated_at,session_id LIMIT ?1",
                )?;
                statement
                    .query_map([RECORD_LIMIT], |row| row.get::<_, String>(0))?
                    .map(|text| Ok(serde_json::from_str::<Record>(&text?)?))
                    .collect::<Result<Vec<_>>>()?
            };
            Reply::Records(records)
        }
        Work::Discard(ids) => {
            for id in ids.iter().take(RECORD_LIMIT as usize) {
                transaction.execute(
                    "DELETE FROM session_hibernations WHERE session_id=?1 AND state='hibernated'",
                    [id],
                )?;
            }
            Reply::Done
        }
        Work::RecordShutdown { entries } => {
            crate::restore::record_shutdown(&transaction, &entries, now)?;
            Reply::Done
        }
        Work::RestorePlan => Reply::Restore(crate::restore::load(&transaction)?),
        Work::RestoreSettle(entry) => {
            crate::restore::settle(&transaction, &entry, now)?;
            Reply::Done
        }
    };
    transaction.commit()?;
    Ok(reply)
}

fn stored_error(result: &Value) -> anyhow::Error {
    let code = match result["code"].as_str() {
        Some("resume_unverifiable") => "resume_unverifiable",
        Some("session_not_found") => "session_not_found",
        Some("host_restart") => "host_restart",
        _ => "hibernation_unconfirmed",
    };
    refuse(
        code,
        result["message"]
            .as_str()
            .unwrap_or("The original hibernation outcome was not confirmed"),
    )
}

async fn work(log: &Service, work: Work) -> Result<Reply> {
    log.hibernation(work).await
}

async fn replay(log: &Service, key: &str, operation: &str, session: &str) -> Result<Option<Value>> {
    match work(log, Work::Lookup(key.to_owned())).await? {
        Reply::Key(None) => Ok(None),
        Reply::Key(Some(record))
            if record.operation == operation && record.session_id == session =>
        {
            match record.result {
                None => Err(refuse(
                    "busy",
                    "An operation with this key is still in progress",
                )),
                Some(result) if result["type"] == "error" => Err(stored_error(&result)),
                Some(mut result) => {
                    result["replayed"] = true.into();
                    Ok(Some(result))
                }
            }
        }
        Reply::Key(Some(_)) => Err(refuse(
            "idempotency_conflict",
            "This key was already used for another session or operation",
        )),
        _ => Err(anyhow!("Unexpected hibernation lookup reply")),
    }
}

fn unconfirmed(_: anyhow::Error) -> anyhow::Error {
    refuse(
        "hibernation_unconfirmed",
        "The outcome was applied but not journaled; look up the same key before retrying",
    )
}

pub(crate) async fn hibernate(
    state: &Arc<Mutex<State>>,
    log: &Service,
    session: String,
    key: String,
    trigger: model::HibernationTrigger,
) -> Result<Value> {
    valid_key(&key)?;
    valid_session(&session)?;
    if let Some(reply) = replay(log, &key, "hibernate", &session).await? {
        return Ok(reply);
    }
    let record = state
        .lock()
        .unwrap()
        .prepare_hibernation(&session, &key, trigger)?;
    if let Err(error) = work(
        log,
        Work::Prepare {
            key: key.clone(),
            record: Box::new(record),
        },
    )
    .await
    {
        state.lock().unwrap().release_hibernation(&session, &key);
        return Err(error);
    }
    let completed = state
        .lock()
        .unwrap()
        .complete_hibernation(&session, &key, trigger);
    let record = match completed {
        Ok(record) => record,
        Err(error) => {
            let _ = work(
                log,
                Work::Abort {
                    session_id: session,
                    key,
                },
            )
            .await;
            return Err(error);
        }
    };
    let reply = record.hibernated_reply();
    work(
        log,
        Work::Commit {
            key,
            record: Box::new(record),
        },
    )
    .await
    .map_err(unconfirmed)?;
    Ok(reply)
}

pub(crate) enum Outcome {
    Pending,
    Verified,
    Failed(String),
    Closed,
}

async fn verification(state: &Arc<Mutex<State>>, session: &str) -> Outcome {
    let deadline = tokio::time::Instant::now() + RESUME_WAIT;
    loop {
        let outcome = state.lock().unwrap().resume_outcome(session);
        if !matches!(outcome, Outcome::Pending) {
            return outcome;
        }
        if tokio::time::Instant::now() >= deadline {
            return Outcome::Failed(format!(
                "No verified resume arrived within {} seconds",
                RESUME_WAIT.as_secs()
            ));
        }
        tokio::time::sleep(RESUME_POLL).await;
    }
}

pub(crate) async fn resume(
    state: &Arc<Mutex<State>>,
    log: &Service,
    events: &mpsc::Sender<PtyEvent>,
    session: String,
    key: String,
) -> Result<Value> {
    resume_because(state, log, events, session, key, model::ResumeReason::Owner).await
}

pub(crate) async fn resume_because(
    state: &Arc<Mutex<State>>,
    log: &Service,
    events: &mpsc::Sender<PtyEvent>,
    session: String,
    key: String,
    reason: model::ResumeReason,
) -> Result<Value> {
    valid_key(&key)?;
    valid_session(&session)?;
    if let Some(reply) = replay(log, &key, "resume", &session).await? {
        return Ok(reply);
    }
    state.lock().unwrap().check_resumable(&session)?;
    work(
        log,
        Work::BeginResume {
            session_id: session.clone(),
            key: key.clone(),
        },
    )
    .await?;
    let launched = state.lock().unwrap().relaunch_hibernated(&session, events);
    if let Err(error) = launched {
        let _ = work(
            log,
            Work::CancelResume {
                session_id: session,
                key,
            },
        )
        .await;
        return Err(error);
    }
    match verification(state, &session).await {
        Outcome::Verified => {
            let record = state.lock().unwrap().finish_resume(&session)?;
            let reply = record.resumed_reply(reason);
            work(
                log,
                Work::Resumed {
                    key,
                    record: Box::new(record),
                    reason,
                },
            )
            .await
            .map_err(unconfirmed)?;
            Ok(reply)
        }
        Outcome::Failed(reason) => {
            let record = state.lock().unwrap().rehibernate(&session, &reason)?;
            let message = format!(
                "The provider did not prove the recorded conversation; the session stays hibernated: {reason}"
            );
            let result = json!({"type":"error","code":"resume_unverifiable","message":message});
            work(
                log,
                Work::ResumeFailed {
                    key,
                    record: Box::new(record),
                    result,
                },
            )
            .await
            .map_err(unconfirmed)?;
            Err(refuse("resume_unverifiable", message))
        }
        Outcome::Closed | Outcome::Pending => {
            let record = state.lock().unwrap().rehibernate(&session, "closed")?;
            let message = "Session was closed while resuming";
            let result = json!({"type":"error","code":"session_not_found","message":message});
            work(
                log,
                Work::ResumeFailed {
                    key,
                    record: Box::new(record),
                    result,
                },
            )
            .await
            .map_err(unconfirmed)?;
            let _ = work(log, Work::Discard(vec![session])).await;
            Err(refuse("session_not_found", message))
        }
    }
}

pub(crate) fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::HibernateSession { .. } | Command::ResumeSession { .. }
    )
}

fn error_event(error: &anyhow::Error) -> Value {
    json!({"type":"error","code":code(error).unwrap_or("hibernation_unconfirmed"),"message":error.to_string()})
}

pub(crate) async fn serve(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    client: u64,
    authority: Authority,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let log = state.lock().unwrap().event_log();
    let result = match (&authority, permit, log) {
        (Authority::Session { .. } | Authority::RunWake { .. }, _, _) => Err(refuse(
            "forbidden",
            "Only the owner may hibernate or resume sessions",
        )),
        (_, None, _) => Err(refuse("busy", "Hibernation service is busy")),
        (_, _, Err(_)) => Err(refuse(
            "unsupported",
            "Hibernation needs the host event journal",
        )),
        (Authority::Owner, Some(_permit), Ok(log)) => match command {
            Command::HibernateSession { session_id, key } => {
                hibernate(
                    &state,
                    &log,
                    session_id,
                    key,
                    model::HibernationTrigger::Owner,
                )
                .await
            }
            Command::ResumeSession { session_id, key } => {
                resume(&state, &log, &events, session_id, key).await
            }
            _ => Err(refuse(
                "invalid_argument",
                "Unsupported hibernation command",
            )),
        },
    };
    let mut event = result.unwrap_or_else(|error| error_event(&error));
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

pub(crate) async fn restore(state: &Arc<Mutex<State>>, log: &Service) -> Result<()> {
    let Reply::Records(records) = work(log, Work::Recover).await? else {
        return Err(anyhow!("Unexpected hibernation recovery reply"));
    };
    let discarded = state.lock().unwrap().install_hibernated(records);
    if !discarded.is_empty() {
        work(log, Work::Discard(discarded)).await?;
    }
    Ok(())
}

pub(crate) fn idle_key(session: &str, idle_since: u64) -> String {
    format!("idle:{session}:{idle_since}")
}

pub(crate) fn start_idle(
    state: Arc<Mutex<State>>,
    log: Service,
) -> Option<tokio::task::JoinHandle<()>> {
    if !state.lock().unwrap().hibernation_idle_policy().enabled() {
        return None;
    }
    Some(tokio::spawn(async move {
        let mut timer = tokio::time::interval(IDLE_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let due = state
                .lock()
                .unwrap()
                .idle_hibernation_candidates(now_millis());
            for (session, idle_since) in due {
                let _ = hibernate(
                    &state,
                    &log,
                    session.clone(),
                    idle_key(&session, idle_since),
                    model::HibernationTrigger::IdlePolicy,
                )
                .await;
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0123456789abcdef0123456789abcdef";
    const CONVERSATION: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn connection() -> Connection {
        let connection = crate::event_log::test_journal();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection
    }

    fn record(session: &str) -> Record {
        Record {
            session_id: session.into(),
            spec: LaunchSpec {
                name: "Agent".into(),
                program: Program::Claude,
                resume: Some(crate::resume::Target {
                    provider: Program::Claude,
                    conversation_id: CONVERSATION.into(),
                }),
                ..Default::default()
            },
            snapshot: json!({"id":session,"name":"Agent","createdAt":"2026-10-22T00:00:00Z","running":true,
                "status":{"state":"idle","source":"screen","evidence":"hook","updatedAt":1000,
                "freshness":{"source":"hook","observedAt":900,"ageMs":100,"stale":false,"boundMs":4000,"lastKnown":null}},
                "lifecycle":{"process":{"running":true,"pid":7}},"controllerId":3,"resume":{"state":"verified"}}),
            hibernated_at: 2000,
            trigger: model::HibernationTrigger::Owner,
            last_resume_failure: None,
            attention_revision: 0,
        }
    }

    fn code_of(error: anyhow::Error) -> &'static str {
        code(&error).unwrap()
    }

    fn events(connection: &Connection) -> Vec<(String, Value)> {
        let mut statement = connection
            .prepare("SELECT kind,payload FROM domain_events ORDER BY sequence")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get::<_, String>(1)?)))
            .unwrap()
            .map(|row| {
                let (kind, payload) = row.unwrap();
                (kind, serde_json::from_str(&payload).unwrap())
            })
            .collect()
    }

    fn prepare(connection: &mut Connection, key: &str, session: &str) -> Result<Reply> {
        handle(
            connection,
            Work::Prepare {
                key: key.into(),
                record: Box::new(record(session)),
            },
            10,
        )
    }

    #[test]
    fn hibernation_commit_journals_once_and_replays_the_original_reply_by_key() {
        let mut connection = connection();
        prepare(&mut connection, "k1", SESSION).unwrap();
        assert!(events(&connection).is_empty());
        let Reply::Key(Some(pending)) =
            handle(&mut connection, Work::Lookup("k1".into()), 11).unwrap()
        else {
            panic!("pending key expected");
        };
        assert_eq!(pending.result, None);
        handle(
            &mut connection,
            Work::Commit {
                key: "k1".into(),
                record: Box::new(record(SESSION)),
            },
            12,
        )
        .unwrap();
        assert_eq!(
            events(&connection),
            [(
                "session.hibernated".to_owned(),
                json!({"conversationId":CONVERSATION,"program":"claude","trigger":"owner"})
            )]
        );
        let Reply::Key(Some(done)) =
            handle(&mut connection, Work::Lookup("k1".into()), 13).unwrap()
        else {
            panic!("settled key expected");
        };
        assert_eq!(done.operation, "hibernate");
        assert_eq!(done.result.unwrap()["state"], "hibernated");
        assert_eq!(
            code_of(prepare(&mut connection, "k2", SESSION).err().unwrap()),
            "session_hibernated"
        );
        assert_eq!(
            code_of(
                prepare(&mut connection, "k1", &"f".repeat(32))
                    .err()
                    .unwrap()
            ),
            "busy"
        );
    }

    #[test]
    fn hibernation_refuses_unsettled_durable_work_without_reserving_the_key() {
        let mut connection = connection();
        for sql in [
            "CREATE TABLE IF NOT EXISTS operation_receipts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,operation TEXT NOT NULL,phase TEXT NOT NULL,session_id TEXT NOT NULL,result TEXT NOT NULL,claim_token TEXT,UNIQUE(issuer,key))",
            "CREATE TABLE IF NOT EXISTS quota_wake_arms(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,arm TEXT NOT NULL,phase TEXT NOT NULL,operation_id TEXT,reason TEXT)",
        ] {
            connection.execute(sql, []).unwrap();
        }
        let cases: [(&[&str], &str); 5] = [
            (
                &[
                    "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('a1','t1',1,?1,'assigned')",
                ],
                "attempt_unsettled",
            ),
            (
                &[
                    "INSERT INTO operation_receipts VALUES('r','owner','k','d','send','accepted',?1,'{}',NULL)",
                ],
                "attempt_unsettled",
            ),
            (
                &[
                    "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('a2','t2',1,?1,'failed')",
                    "INSERT INTO workflow_decisions(id,run_id,attempt_id,revision,state,data) SELECT 'd','run','a2',1,'pending','{}' WHERE ?1 IS NOT NULL",
                ],
                "decision_pending",
            ),
            (
                &[
                    "INSERT INTO workflow_runs(id,title,goal,coordinator_id,revision,state,created_at) VALUES('run','t','g',?1,1,'active',1)",
                ],
                "run_active",
            ),
            (
                &[
                    "INSERT INTO quota_wake_arms(id,session_id,arm,phase) VALUES('0123456789abcdef0123456789abcdef',?1,'{}','armed')",
                ],
                "wake_armed",
            ),
        ];
        for (index, (setup, expected)) in cases.into_iter().enumerate() {
            for sql in setup {
                connection.execute(sql, [SESSION]).unwrap();
            }
            let key = format!("refused-{index}");
            assert_eq!(
                code_of(prepare(&mut connection, &key, SESSION).err().unwrap()),
                expected
            );
            let Reply::Key(found) = handle(&mut connection, Work::Lookup(key), 1).unwrap() else {
                panic!("lookup reply expected");
            };
            assert_eq!(found, None);
            for table in [
                "workflow_decisions",
                "workflow_attempts",
                "workflow_runs",
                "operation_receipts",
                "quota_wake_arms",
            ] {
                connection
                    .execute(&format!("DELETE FROM {table}"), [])
                    .unwrap();
            }
        }
        prepare(&mut connection, "accepted", SESSION).unwrap();
    }

    #[test]
    fn hibernation_resume_cycle_and_restart_keep_records_hibernated() {
        let mut connection = connection();
        prepare(&mut connection, "h", SESSION).unwrap();
        handle(
            &mut connection,
            Work::Commit {
                key: "h".into(),
                record: Box::new(record(SESSION)),
            },
            1,
        )
        .unwrap();
        let begin = |connection: &mut Connection, key: &str| {
            handle(
                connection,
                Work::BeginResume {
                    session_id: SESSION.into(),
                    key: key.into(),
                },
                2,
            )
        };
        assert_eq!(
            code_of(
                handle(
                    &mut connection,
                    Work::BeginResume {
                        session_id: "e".repeat(32),
                        key: "x".into()
                    },
                    2
                )
                .err()
                .unwrap()
            ),
            "session_not_hibernated"
        );
        begin(&mut connection, "r1").unwrap();
        assert_eq!(code_of(begin(&mut connection, "r2").err().unwrap()), "busy");
        let Reply::Records(recovered) = handle(&mut connection, Work::Recover, 3).unwrap() else {
            panic!("records expected");
        };
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].session_id, SESSION);
        let Reply::Key(Some(interrupted)) =
            handle(&mut connection, Work::Lookup("r1".into()), 4).unwrap()
        else {
            panic!("interrupted key expected");
        };
        assert_eq!(interrupted.result.unwrap()["code"], "host_restart");
        begin(&mut connection, "r3").unwrap();
        let mut failed = record(SESSION);
        failed.last_resume_failure = Some("mismatch".into());
        handle(
            &mut connection,
            Work::ResumeFailed {
                key: "r3".into(),
                record: Box::new(failed),
                result: json!({"type":"error","code":"resume_unverifiable","message":"mismatch"}),
            },
            5,
        )
        .unwrap();
        let Reply::Records(still) = handle(&mut connection, Work::Recover, 6).unwrap() else {
            panic!("records expected");
        };
        assert_eq!(still[0].last_resume_failure.as_deref(), Some("mismatch"));
        begin(&mut connection, "r4").unwrap();
        handle(
            &mut connection,
            Work::Resumed {
                key: "r4".into(),
                record: Box::new(record(SESSION)),
                reason: model::ResumeReason::Owner,
            },
            7,
        )
        .unwrap();
        let kinds: Vec<String> = events(&connection)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds, ["session.hibernated", "session.resumed"]);
        let Reply::Records(none) = handle(&mut connection, Work::Recover, 8).unwrap() else {
            panic!("records expected");
        };
        assert!(none.is_empty());
    }

    #[test]
    fn hibernation_recovery_removes_rows_whose_saved_session_no_longer_exists() {
        let mut connection = connection();
        connection
            .execute_batch(
                "CREATE TABLE recovery (id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL);",
            )
            .unwrap();
        let (forgotten, resuming) = ("f".repeat(32), "e".repeat(32));
        for (key, session) in [("a", SESSION), ("b", &forgotten), ("c", &resuming)] {
            prepare(&mut connection, key, session).unwrap();
            handle(
                &mut connection,
                Work::Commit {
                    key: key.into(),
                    record: Box::new(record(session)),
                },
                1,
            )
            .unwrap();
        }
        handle(
            &mut connection,
            Work::BeginResume {
                session_id: resuming.clone(),
                key: "r".into(),
            },
            2,
        )
        .unwrap();
        prepare(&mut connection, "d", &"d".repeat(32)).unwrap();
        connection
            .execute("INSERT INTO recovery VALUES(?1,'{}','saved')", [SESSION])
            .unwrap();
        let Reply::Records(recovered) = handle(&mut connection, Work::Recover, 3).unwrap() else {
            panic!("records expected");
        };
        assert_eq!(
            recovered
                .iter()
                .map(|record| record.session_id.as_str())
                .collect::<Vec<_>>(),
            [SESSION]
        );
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM session_hibernations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn hibernation_abort_and_restart_drop_unfinished_stops_and_free_the_key() {
        let mut connection = connection();
        prepare(&mut connection, "a", SESSION).unwrap();
        handle(
            &mut connection,
            Work::Abort {
                session_id: SESSION.into(),
                key: "a".into(),
            },
            1,
        )
        .unwrap();
        let Reply::Key(found) = handle(&mut connection, Work::Lookup("a".into()), 1).unwrap()
        else {
            panic!("lookup reply expected");
        };
        assert_eq!(found, None);
        prepare(&mut connection, "a", SESSION).unwrap();
        let Reply::Records(recovered) = handle(&mut connection, Work::Recover, 2).unwrap() else {
            panic!("records expected");
        };
        assert!(recovered.is_empty());
        prepare(&mut connection, "b", SESSION).unwrap();
    }

    #[test]
    fn hibernation_key_history_is_bounded_and_keys_are_validated() {
        let mut connection = connection();
        for index in 0..KEY_RETENTION + 3 {
            let transaction = connection.transaction().unwrap();
            reserve(
                &transaction,
                &format!("k{index}"),
                "hibernate",
                SESSION,
                index as u64,
            )
            .unwrap();
            settle(&transaction, &format!("k{index}"), &json!({"ok":true})).unwrap();
            transaction.commit().unwrap();
        }
        let count: i64 = connection
            .query_row("SELECT count(*) FROM session_hibernation_keys", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, KEY_RETENTION);
        assert!(lookup(&connection, "k0").unwrap().is_none());
        for key in ["", "bad\nkey", &"k".repeat(129)] {
            assert_eq!(code_of(valid_key(key).err().unwrap()), "invalid_argument");
        }
        assert!(valid_session("ABCDEF0123456789abcdef0123456789").is_err());
        assert!(valid_session(SESSION).is_ok());
    }

    #[test]
    fn hibernation_view_is_a_stopped_snapshot_with_last_known_freshness() {
        let view = record(SESSION).view(5000);
        assert_eq!(view["running"], false);
        assert_eq!(view["controllerId"], Value::Null);
        assert!(view.get("lifecycle").is_none() && view.get("resume").is_none());
        assert_eq!(view["readiness"]["phase"], "exited");
        assert_eq!(view["hibernation"]["state"], "hibernated");
        assert_eq!(view["hibernation"]["conversationId"], CONVERSATION);
        let freshness = &view["status"]["freshness"];
        assert_eq!(freshness["source"], "journal");
        assert_eq!(freshness["stale"], true);
        assert_eq!(freshness["ageMs"], 4100);
        assert_eq!(
            freshness["lastKnown"],
            json!({"state":"idle","observedAt":900})
        );
        let mut negotiated = json!({"type":"sessions","sessions":[view.clone()]});
        crate::freshness::publish(&mut negotiated, true);
        assert_eq!(negotiated["sessions"][0]["status"]["state"], "unknown");
        let mut legacy = json!({"type":"sessions","sessions":[view]});
        crate::freshness::publish(&mut legacy, false);
        assert_eq!(legacy["sessions"][0]["status"]["state"], "idle");
        assert!(legacy["sessions"][0]["status"].get("freshness").is_none());
    }

    #[test]
    fn hibernation_idle_policy_is_declared_default_off_and_bounded() {
        let policy = IdlePolicy::default();
        assert!(!policy.enabled());
        assert!(!policy.due(0, u64::MAX));
        assert_eq!(policy.view(), json!({"enabled":false,"idleAfterMs":null}));
        for minutes in [0, 14, 1441] {
            assert!(IdlePolicy::from_minutes(Some(minutes)).is_err());
        }
        let enabled = IdlePolicy::from_minutes(Some(15)).unwrap();
        assert!(enabled.enabled());
        assert!(!enabled.due(1_000, 1_000 + 899_999));
        assert!(enabled.due(1_000, 1_000 + 900_000));
        assert_eq!(idle_key(SESSION, 7), format!("idle:{SESSION}:7"));
    }
}
