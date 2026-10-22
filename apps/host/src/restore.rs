use crate::{
    event_log::{Service, model},
    hibernation::{self, Reply, Work},
    sessions::{PtyEvent, State},
    status::now_millis,
};
use anyhow::{Result, anyhow};
use rusqlite::{Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinSet};

pub(crate) const CONCURRENCY: usize = 2;
pub(crate) const SHUTDOWN_BUDGET: Duration = Duration::from_secs(10);
pub(crate) const REPORT_LIMIT: usize = 256;
const MESSAGE_CHARS: usize = 256;
const UPSERT: &str = "INSERT INTO session_restore_outcomes(session_id,outcome,code,message,shutdown_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Outcome {
    Pending,
    Restored,
    Hibernated,
    Reaped,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Restored => "restored",
            Self::Hibernated => "hibernated",
            Self::Reaped => "reaped",
        }
    }

    fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "pending" => Self::Pending,
            "restored" => Self::Restored,
            "hibernated" => Self::Hibernated,
            "reaped" => Self::Reaped,
            _ => return Err(anyhow!("Unknown restore outcome {text}")),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub session_id: String,
    pub outcome: Outcome,
    pub code: Option<String>,
    pub message: Option<String>,
    pub shutdown_at: u64,
}

impl Entry {
    pub fn new(
        session_id: impl Into<String>,
        outcome: Outcome,
        code: Option<&str>,
        message: Option<&str>,
        shutdown_at: u64,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            outcome,
            code: code.map(str::to_owned),
            message: message.map(|text| text.chars().take(MESSAGE_CHARS).collect()),
            shutdown_at,
        }
    }

    pub fn refused(
        session_id: impl Into<String>,
        outcome: Outcome,
        error: &anyhow::Error,
        shutdown_at: u64,
    ) -> Self {
        Self::new(
            session_id,
            outcome,
            Some(hibernation::code(error).unwrap_or("hibernation_unconfirmed")),
            Some(&error.to_string()),
            shutdown_at,
        )
    }

    fn settled(self, outcome: Outcome, code: Option<&str>, message: Option<&str>) -> Self {
        Self::new(self.session_id, outcome, code, message, self.shutdown_at)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    enabled: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Policy {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn view(&self) -> Value {
        json!({"enabled": self.enabled, "concurrency": CONCURRENCY})
    }
}

#[derive(Default)]
pub(crate) struct Report {
    entries: Vec<Entry>,
}

impl Report {
    pub fn replace(&mut self, entries: Vec<Entry>) {
        self.entries = entries;
    }

    pub fn settle(&mut self, entry: Entry) {
        if let Some(current) = self
            .entries
            .iter_mut()
            .find(|current| current.session_id == entry.session_id)
        {
            *current = entry;
        }
    }

    pub fn view(&self, policy: Policy) -> Value {
        json!({"policy": policy.view(), "sessions": self.entries})
    }
}

fn insert(transaction: &Transaction<'_>, entry: &Entry, now: u64) -> Result<()> {
    transaction.execute(
        &format!("{UPSERT} ON CONFLICT(session_id) DO NOTHING"),
        params![
            entry.session_id,
            entry.outcome.as_str(),
            entry.code,
            entry.message,
            entry.shutdown_at as i64,
            now as i64
        ],
    )?;
    Ok(())
}

pub(crate) fn mark_pending(transaction: &Transaction<'_>, session: &str, at: u64) -> Result<()> {
    transaction.execute(
        &format!("{UPSERT} ON CONFLICT(session_id) DO UPDATE SET outcome='pending',code=NULL,message=NULL,shutdown_at=excluded.shutdown_at,updated_at=excluded.updated_at"),
        params![session, "pending", None::<String>, None::<String>, at as i64, at as i64],
    )?;
    Ok(())
}

pub(crate) fn record_shutdown(
    transaction: &Transaction<'_>,
    entries: &[Entry],
    now: u64,
) -> Result<()> {
    transaction.execute(
        "DELETE FROM session_restore_outcomes WHERE outcome!='pending'",
        [],
    )?;
    let pending: i64 =
        transaction.query_row("SELECT count(*) FROM session_restore_outcomes", [], |row| {
            row.get(0)
        })?;
    let room = REPORT_LIMIT.saturating_sub(pending as usize);
    for entry in entries.iter().take(room) {
        hibernation::valid_session(&entry.session_id)?;
        insert(transaction, entry, now)?;
    }
    Ok(())
}

pub(crate) fn load(transaction: &Transaction<'_>) -> Result<Vec<Entry>> {
    let mut statement = transaction.prepare(
        "SELECT session_id,outcome,code,message,shutdown_at FROM session_restore_outcomes ORDER BY shutdown_at,session_id LIMIT ?1",
    )?;
    statement
        .query_map([REPORT_LIMIT as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .map(|row| {
            let (session_id, outcome, code, message, shutdown_at) = row?;
            Ok(Entry {
                session_id,
                outcome: Outcome::parse(&outcome)?,
                code,
                message,
                shutdown_at: shutdown_at.max(0) as u64,
            })
        })
        .collect()
}

pub(crate) fn settle(transaction: &Transaction<'_>, entry: &Entry, now: u64) -> Result<()> {
    transaction.execute(
        "UPDATE session_restore_outcomes SET outcome=?2,code=?3,message=?4,updated_at=?5 WHERE session_id=?1 AND outcome='pending'",
        params![
            entry.session_id,
            entry.outcome.as_str(),
            entry.code,
            entry.message,
            now as i64
        ],
    )?;
    Ok(())
}

pub(crate) fn shutdown_key(session: &str, at: u64) -> String {
    format!("shutdown:{session}:{at}")
}

pub(crate) fn restore_key(entry: &Entry) -> String {
    format!("restore:{}:{}", entry.session_id, entry.shutdown_at)
}

pub(crate) async fn shutdown(state: &Arc<Mutex<State>>, log: &Service) -> Vec<Entry> {
    let at = now_millis();
    let deadline = tokio::time::Instant::now() + SHUTDOWN_BUDGET;
    let (order, mut entries) = state.lock().unwrap().shutdown_plan(at);
    for session in order {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let attempt = tokio::time::timeout(
            remaining,
            hibernation::hibernate(
                state,
                log,
                session.clone(),
                shutdown_key(&session, at),
                model::HibernationTrigger::Shutdown,
            ),
        )
        .await
        .unwrap_or_else(|_| {
            Err(hibernation::refuse(
                "shutdown_budget",
                format!(
                    "Graceful shutdown spent its {}-second hibernation budget",
                    SHUTDOWN_BUDGET.as_secs()
                ),
            ))
        });
        if let Err(error) = attempt
            && !state.lock().unwrap().is_hibernated(&session)
        {
            entries.push(Entry::refused(session, Outcome::Reaped, &error, at));
        }
    }
    if let Err(error) = log
        .hibernation(Work::RecordShutdown {
            entries: entries.clone(),
        })
        .await
    {
        eprintln!("The shutdown restore report was not recorded: {error}");
    }
    entries
}

async fn restore_one(
    state: &Arc<Mutex<State>>,
    log: &Service,
    events: &mpsc::Sender<PtyEvent>,
    entry: Entry,
    policy: Policy,
) -> Entry {
    if !policy.enabled() {
        return entry.settled(
            Outcome::Hibernated,
            Some("restore_disabled"),
            Some("Restore on start is off; resume the session explicitly"),
        );
    }
    let resumed = hibernation::resume_because(
        state,
        log,
        events,
        entry.session_id.clone(),
        restore_key(&entry),
        model::ResumeReason::Restored,
    )
    .await;
    match resumed {
        Ok(_) => entry.settled(Outcome::Restored, None, None),
        Err(error) => {
            let outcome = state.lock().unwrap().restore_outcome(&entry.session_id);
            Entry::refused(entry.session_id, outcome, &error, entry.shutdown_at)
        }
    }
}

async fn settle_one(state: &Arc<Mutex<State>>, log: &Service, entry: Entry) {
    if let Err(error) = log.hibernation(Work::RestoreSettle(entry.clone())).await {
        eprintln!("The restore outcome was not recorded: {error}");
    }
    state.lock().unwrap().settle_restore(entry);
}

pub(crate) async fn run(
    state: Arc<Mutex<State>>,
    log: Service,
    events: mpsc::Sender<PtyEvent>,
) -> Result<()> {
    let Reply::Restore(entries) = log.hibernation(Work::RestorePlan).await? else {
        return Err(anyhow!("Unexpected restore plan reply"));
    };
    let pending: Vec<Entry> = entries
        .iter()
        .filter(|entry| entry.outcome == Outcome::Pending)
        .cloned()
        .collect();
    let policy = state.lock().unwrap().install_restore_report(entries);
    let mut tasks = JoinSet::new();
    for entry in pending {
        if tasks.len() >= CONCURRENCY
            && let Some(done) = tasks.join_next().await
        {
            settle_one(&state, &log, done?).await;
        }
        let (state, log, events) = (state.clone(), log.clone(), events.clone());
        tasks.spawn(async move { restore_one(&state, &log, &events, entry, policy).await });
    }
    while let Some(done) = tasks.join_next().await {
        settle_one(&state, &log, done?).await;
    }
    Ok(())
}

pub(crate) fn start(
    state: Arc<Mutex<State>>,
    log: Service,
    events: mpsc::Sender<PtyEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = run(state, log, events).await {
            eprintln!("Sessions from the last shutdown were not restored: {error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    const FIRST: &str = "0123456789abcdef0123456789abcdef";
    const SECOND: &str = "fedcba9876543210fedcba9876543210";

    fn connection() -> Connection {
        crate::event_log::test_journal()
    }

    fn write(connection: &mut Connection, action: impl FnOnce(&Transaction<'_>)) {
        let transaction = connection.transaction().unwrap();
        action(&transaction);
        transaction.commit().unwrap();
    }

    fn rows(connection: &mut Connection) -> Vec<Entry> {
        let transaction = connection.transaction().unwrap();
        load(&transaction).unwrap()
    }

    #[test]
    fn restore_ledger_keeps_owed_restores_and_replaces_the_previous_report() {
        let mut connection = connection();
        write(&mut connection, |transaction| {
            mark_pending(transaction, FIRST, 10).unwrap();
            record_shutdown(
                transaction,
                &[
                    Entry::new(
                        SECOND,
                        Outcome::Reaped,
                        Some("hibernate_unsupported"),
                        Some("shell"),
                        10,
                    ),
                    Entry::new(FIRST, Outcome::Reaped, Some("busy"), None, 10),
                ],
                11,
            )
            .unwrap();
        });
        assert_eq!(
            rows(&mut connection),
            [
                Entry::new(FIRST, Outcome::Pending, None, None, 10),
                Entry::new(
                    SECOND,
                    Outcome::Reaped,
                    Some("hibernate_unsupported"),
                    Some("shell"),
                    10
                ),
            ]
        );
        write(&mut connection, |transaction| {
            settle(
                transaction,
                &Entry::new(FIRST, Outcome::Restored, None, None, 10),
                12,
            )
            .unwrap();
            settle(
                transaction,
                &Entry::new(SECOND, Outcome::Restored, None, None, 10),
                12,
            )
            .unwrap();
        });
        assert_eq!(rows(&mut connection)[0].outcome, Outcome::Restored);
        assert_eq!(rows(&mut connection)[1].outcome, Outcome::Reaped);
        write(&mut connection, |transaction| {
            record_shutdown(transaction, &[], 20).unwrap();
        });
        assert!(rows(&mut connection).is_empty());
    }

    #[test]
    fn restore_ledger_is_bounded_and_refuses_malformed_rows() {
        let mut connection = connection();
        let entries: Vec<Entry> = (0..REPORT_LIMIT + 8)
            .map(|index| {
                Entry::new(
                    format!("{index:032x}"),
                    Outcome::Reaped,
                    Some("process_exited"),
                    None,
                    1,
                )
            })
            .collect();
        write(&mut connection, |transaction| {
            mark_pending(transaction, FIRST, 1).unwrap();
            record_shutdown(transaction, &entries, 2).unwrap();
        });
        let stored = rows(&mut connection);
        assert_eq!(stored.len(), REPORT_LIMIT);
        assert!(stored.iter().any(|entry| entry.session_id == FIRST));
        let transaction = connection.transaction().unwrap();
        assert!(
            record_shutdown(
                &transaction,
                &[Entry::new("short", Outcome::Reaped, Some("x"), None, 1)],
                3
            )
            .is_err()
        );
        assert!(
            transaction
                .execute(
                    "INSERT INTO session_restore_outcomes VALUES(?1,'reaped',NULL,NULL,1,1)",
                    [SECOND],
                )
                .is_err()
        );
    }

    #[test]
    fn restore_policy_defaults_on_and_publishes_its_bound() {
        assert!(Policy::default().enabled());
        assert_eq!(
            Policy::default().view(),
            json!({"enabled":true,"concurrency":CONCURRENCY})
        );
        let mut report = Report::default();
        report.replace(vec![Entry::new(FIRST, Outcome::Pending, None, None, 5)]);
        report.settle(Entry::new(
            FIRST,
            Outcome::Hibernated,
            Some("restore_disabled"),
            Some(&"x".repeat(MESSAGE_CHARS + 10)),
            5,
        ));
        report.settle(Entry::new(SECOND, Outcome::Restored, None, None, 5));
        let view = report.view(Policy::new(false));
        assert_eq!(view["policy"]["enabled"], false);
        assert_eq!(view["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(view["sessions"][0]["outcome"], "hibernated");
        assert_eq!(view["sessions"][0]["code"], "restore_disabled");
        assert_eq!(
            view["sessions"][0]["message"].as_str().unwrap().len(),
            MESSAGE_CHARS
        );
        assert_eq!(
            restore_key(&report.entries[0]),
            format!("restore:{FIRST}:5")
        );
        assert_eq!(shutdown_key(FIRST, 9), format!("shutdown:{FIRST}:9"));
    }
}
