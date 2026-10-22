use crate::{agent_events, claude_quota};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::Path,
};

const RECORD_LIMIT: usize = 1024;
const SIDECAR: &str = "claude-quota-delivery.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Anchor {
    pub host_session_id: String,
    pub launch_id: String,
}

impl Anchor {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [&self.host_session_id, &self.launch_id]
                .into_iter()
                .all(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
                }),
            "Invalid capture anchor"
        );
        Ok(())
    }

    fn matches(&self, identity: &agent_events::Identity) -> bool {
        self.host_session_id == identity.host_session_id && self.launch_id == identity.launch_id
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Outcome {
    Recorded,
    RootUnbound,
    PayloadScopeRejected,
    ScopeChanged,
    Superseded,
    StorageUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum State {
    Unconfirmed,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub attempt_sequence: u64,
    pub entry_generation: u64,
    pub bound_at_entry: bool,
    state: State,
    pub started_at: u64,
    pub started_monotonic_ms: u64,
    pub completed_at: Option<u64>,
    pub completed_monotonic_ms: Option<u64>,
    pub outcome: Option<Outcome>,
    pub parse_reason: Option<claude_quota::Reason>,
}

impl Attempt {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.attempt_sequence > 0 && self.entry_generation > 0,
            "Invalid capture attempt"
        );
        ensure!(
            match self.state {
                State::Unconfirmed =>
                    self.completed_at.is_none()
                        && self.completed_monotonic_ms.is_none()
                        && self.outcome.is_none()
                        && self.parse_reason.is_none(),
                State::Completed =>
                    self.completed_at.is_some()
                        && self
                            .completed_monotonic_ms
                            .is_some_and(|at| at >= self.started_monotonic_ms)
                        && self.outcome.is_some(),
            },
            "Invalid capture completion"
        );
        ensure!(
            self.parse_reason.is_none() || self.outcome == Some(Outcome::Recorded),
            "Invalid capture parse reason"
        );
        ensure!(
            self.outcome != Some(Outcome::Recorded)
                || (self.bound_at_entry && self.parse_reason.is_some()),
            "Invalid capture acceptance"
        );
        ensure!(
            self.outcome != Some(Outcome::RootUnbound) || !self.bound_at_entry,
            "Invalid unbound capture"
        );
        Ok(())
    }
}

pub(crate) struct Reservation {
    pub attempt: Attempt,
    pub quota: Option<agent_events::RootQuotaTicket>,
}

pub(crate) enum Begin {
    Reserved(Reservation),
    ScopeChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    Begin,
    Append,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StorageFailure {
    outcome: Outcome,
    pub stage: Stage,
    pub attempt_sequence: Option<u64>,
    pub started_at: u64,
    pub started_monotonic_ms: u64,
    pub completed_at: u64,
    pub completed_monotonic_ms: u64,
}

impl StorageFailure {
    fn validate(&self) -> Result<()> {
        let sequence_valid = match self.stage {
            Stage::Begin => self.attempt_sequence.is_none(),
            Stage::Append => self.attempt_sequence.is_some_and(|sequence| sequence > 0),
        };
        ensure!(
            self.outcome == Outcome::StorageUnavailable
                && sequence_valid
                && self.completed_monotonic_ms >= self.started_monotonic_ms,
            "Invalid storage failure receipt"
        );
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailureFile {
    schema_version: u8,
    anchor: Anchor,
    failure: StorageFailure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReaderOutcome {
    NotPolled,
    Readable,
    Missing,
    Unreadable,
    InvalidStoredData,
    ScopeChanged,
}

#[derive(Clone, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delivery {
    pub latest_started: Option<Attempt>,
    pub latest_completed: Option<Attempt>,
    pub latest_rejected: Option<Attempt>,
    pub last_storage_failure: Option<StorageFailure>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reader {
    pub outcome: ReaderOutcome,
    pub checked_at: Option<u64>,
    pub storage_failure_outcome: ReaderOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    pub delivery: Delivery,
    pub reader: Reader,
}

impl View {
    pub fn not_polled() -> Self {
        Self {
            delivery: Delivery::default(),
            reader: Reader {
                outcome: ReaderOutcome::NotPolled,
                checked_at: None,
                storage_failure_outcome: ReaderOutcome::NotPolled,
            },
        }
    }

    pub fn unavailable(report: &Path, anchor: &Anchor, outcome: ReaderOutcome) -> Self {
        let (last_storage_failure, storage_failure_outcome) = read_failure(report, anchor);
        Self {
            delivery: Delivery {
                last_storage_failure,
                ..Default::default()
            },
            reader: Reader {
                outcome,
                checked_at: Some(crate::status::now_millis()),
                storage_failure_outcome,
            },
        }
    }

    pub fn failed_read() -> Self {
        Self {
            delivery: Delivery::default(),
            reader: Reader {
                outcome: ReaderOutcome::Unreadable,
                checked_at: Some(crate::status::now_millis()),
                storage_failure_outcome: ReaderOutcome::NotPolled,
            },
        }
    }
}

pub(crate) fn install(report: &Path) -> Result<Anchor> {
    let mut connection = agent_events::capture_connection(report)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (host_session_id, launch_id, _, _) = agent_events::quota_scope(&transaction)?;
    let anchor = Anchor {
        host_session_id,
        launch_id,
    };
    anchor.validate()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS capture_attempts (
      slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 3),
      sequence INTEGER NOT NULL CHECK(sequence>0),
      host_session TEXT NOT NULL, launch_id TEXT NOT NULL,
      record TEXT NOT NULL CHECK(length(record)<=1024));",
    )?;
    transaction.commit()?;
    Ok(anchor)
}

pub(crate) fn begin(
    report: &Path,
    anchor: &Anchor,
    started: claude_quota::ReceiptClock,
) -> Result<Begin> {
    anchor.validate()?;
    let mut connection = agent_events::capture_connection(report)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (host, launch, provider, generation) = agent_events::quota_scope(&transaction)?;
    if host != anchor.host_session_id || launch != anchor.launch_id {
        return Ok(Begin::ScopeChanged);
    }
    let foreign: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM capture_attempts WHERE host_session<>?1 OR launch_id<>?2)",
        params![anchor.host_session_id, anchor.launch_id],
        |row| row.get(0),
    )?;
    ensure!(!foreign, "Capture records belong to another launch");
    let previous: Option<i64> = transaction
        .query_row(
            "SELECT sequence FROM capture_attempts WHERE slot=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let sequence = previous
        .map(u64::try_from)
        .transpose()?
        .unwrap_or(0)
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("Capture counter exhausted"))?;
    let quota = if provider.is_some() {
        agent_events::reserve_root_quota(&transaction)?
    } else {
        None
    };
    let attempt = Attempt {
        attempt_sequence: sequence,
        entry_generation: generation,
        bound_at_entry: quota.is_some(),
        state: State::Unconfirmed,
        started_at: started.wall_ms,
        started_monotonic_ms: started.monotonic_ms,
        completed_at: None,
        completed_monotonic_ms: None,
        outcome: None,
        parse_reason: None,
    };
    ensure!(
        write_attempt(&transaction, anchor, 1, &attempt)?,
        "Capture reservation was not recorded"
    );
    transaction.commit()?;
    Ok(Begin::Reserved(Reservation { attempt, quota }))
}

fn write_attempt(
    connection: &Connection,
    anchor: &Anchor,
    slot: u8,
    attempt: &Attempt,
) -> Result<bool> {
    attempt.validate()?;
    let encoded = serde_json::to_string(attempt)?;
    ensure!(
        encoded.len() <= RECORD_LIMIT,
        "Capture record exceeds bound"
    );
    let written = connection.execute("INSERT INTO capture_attempts(slot,sequence,host_session,launch_id,record) VALUES(?1,?2,?3,?4,?5)
      ON CONFLICT(slot) DO UPDATE SET sequence=excluded.sequence,host_session=excluded.host_session,launch_id=excluded.launch_id,record=excluded.record
      WHERE capture_attempts.host_session=excluded.host_session AND capture_attempts.launch_id=excluded.launch_id AND (capture_attempts.sequence<excluded.sequence OR (excluded.slot=1 AND capture_attempts.sequence=excluded.sequence))", params![i64::from(slot), i64::try_from(attempt.attempt_sequence)?, anchor.host_session_id, anchor.launch_id, encoded])?;
    Ok(written == 1)
}

pub(crate) fn finish(
    report: &Path,
    anchor: &Anchor,
    reservation: &Reservation,
    requested: Outcome,
    snapshot: Option<&claude_quota::StoredSnapshot>,
    completed: claude_quota::ReceiptClock,
) -> Result<Outcome> {
    let mut connection = agent_events::capture_connection(report)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (host, launch, provider, generation) = agent_events::quota_scope(&transaction)?;
    if host != anchor.host_session_id || launch != anchor.launch_id {
        return Ok(Outcome::ScopeChanged);
    }
    let foreign: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM capture_attempts WHERE host_session<>?1 OR launch_id<>?2)",
        params![anchor.host_session_id, anchor.launch_id],
        |row| row.get(0),
    )?;
    ensure!(!foreign, "Capture records belong to another launch");
    let outcome = match &reservation.quota {
        None => Outcome::RootUnbound,
        Some(ticket)
            if provider.as_deref() != Some(ticket.provider_session_id.as_str())
                || generation != ticket.generation =>
        {
            Outcome::ScopeChanged
        }
        Some(ticket) if requested == Outcome::Recorded => match agent_events::append_root_quota_in(
            &transaction,
            ticket,
            snapshot.ok_or_else(|| anyhow::anyhow!("Missing capture snapshot"))?,
        )? {
            agent_events::QuotaAppend::Recorded => Outcome::Recorded,
            agent_events::QuotaAppend::ScopeChanged => Outcome::ScopeChanged,
            agent_events::QuotaAppend::Superseded => Outcome::Superseded,
        },
        Some(_) => requested,
    };
    let mut attempt = reservation.attempt.clone();
    attempt.state = State::Completed;
    attempt.completed_at = Some(completed.wall_ms);
    attempt.completed_monotonic_ms = Some(completed.monotonic_ms);
    attempt.outcome = Some(outcome);
    attempt.parse_reason = if outcome == Outcome::Recorded {
        snapshot.map(|value| value.reason)
    } else {
        None
    };
    write_attempt(&transaction, anchor, 1, &attempt)?;
    write_attempt(&transaction, anchor, 2, &attempt)?;
    if outcome != Outcome::Recorded {
        write_attempt(&transaction, anchor, 3, &attempt)?;
    }
    transaction.commit()?;
    Ok(outcome)
}

pub(crate) fn storage_failure(
    report: &Path,
    anchor: &Anchor,
    stage: Stage,
    attempt_sequence: Option<u64>,
    started: claude_quota::ReceiptClock,
    completed: claude_quota::ReceiptClock,
) {
    let failure = StorageFailure {
        outcome: Outcome::StorageUnavailable,
        stage,
        attempt_sequence,
        started_at: started.wall_ms,
        started_monotonic_ms: started.monotonic_ms,
        completed_at: completed.wall_ms,
        completed_monotonic_ms: completed.monotonic_ms,
    };
    let result = (|| -> Result<()> {
        anchor.validate()?;
        failure.validate()?;
        let bytes = serde_json::to_vec(&FailureFile {
            schema_version: 1,
            anchor: anchor.clone(),
            failure,
        })?;
        ensure!(bytes.len() <= RECORD_LIMIT, "Capture failure exceeds bound");
        let directory = report
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Missing capture directory"))?;
        let metadata = std::fs::symlink_metadata(directory)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "Capture directory is unavailable"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                metadata.file_attributes()
                    & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                    == 0,
                "Capture directory is unavailable"
            );
        }
        let destination = directory.join(SIDECAR);
        let temporary =
            destination.with_extension(format!("{}.tmp", hex::encode(crate::wire::random::<16>())));
        let mut owned_temporary = false;
        let written = (|| -> Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            owned_temporary = true;
            file.write_all(&bytes)?;
            drop(file);
            std::fs::rename(&temporary, destination)?;
            Ok(())
        })();
        if written.is_err() && owned_temporary {
            let _ = std::fs::remove_file(&temporary);
        }
        written
    })();
    if result.is_err() {
        eprintln!("nesvo quota capture diagnostics are unavailable");
    }
}

fn read_failure(report: &Path, anchor: &Anchor) -> (Option<StorageFailure>, ReaderOutcome) {
    let result = (|| -> std::result::Result<StorageFailure, ReaderOutcome> {
        let path = report.with_file_name(SIDECAR);
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ReaderOutcome::Missing
            } else {
                ReaderOutcome::Unreadable
            }
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ReaderOutcome::Unreadable);
        }
        if metadata.len() > RECORD_LIMIT as u64 {
            return Err(ReaderOutcome::InvalidStoredData);
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let file = options.open(path).map_err(|_| ReaderOutcome::Unreadable)?;
        let metadata = file.metadata().map_err(|_| ReaderOutcome::Unreadable)?;
        if !metadata.is_file() {
            return Err(ReaderOutcome::Unreadable);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0
            {
                return Err(ReaderOutcome::Unreadable);
            }
        }
        let mut bytes = Vec::new();
        file.take(RECORD_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ReaderOutcome::Unreadable)?;
        if bytes.len() > RECORD_LIMIT {
            return Err(ReaderOutcome::InvalidStoredData);
        }
        let saved: FailureFile =
            serde_json::from_slice(&bytes).map_err(|_| ReaderOutcome::InvalidStoredData)?;
        if saved.schema_version != 1 {
            return Err(ReaderOutcome::InvalidStoredData);
        }
        if &saved.anchor != anchor {
            return Err(ReaderOutcome::ScopeChanged);
        }
        saved
            .failure
            .validate()
            .map_err(|_| ReaderOutcome::InvalidStoredData)?;
        Ok(saved.failure)
    })();
    match result {
        Ok(failure) => (Some(failure), ReaderOutcome::Readable),
        Err(outcome) => (None, outcome),
    }
}

pub(crate) fn read(
    connection: &Connection,
    report: &Path,
    anchor: &Anchor,
    identity: &agent_events::Identity,
) -> View {
    let mut view = View::unavailable(report, anchor, ReaderOutcome::Readable);
    if !anchor.matches(identity) {
        view.reader.outcome = ReaderOutcome::ScopeChanged;
        return view;
    }
    let result = (|| -> std::result::Result<Delivery, ReaderOutcome> {
        let mut statement = connection.prepare("SELECT slot,sequence,host_session,launch_id,record FROM capture_attempts ORDER BY slot LIMIT 4").map_err(|_| ReaderOutcome::Unreadable)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|_| ReaderOutcome::Unreadable)?;
        let mut delivery = Delivery::default();
        for row in rows {
            let (slot, sequence, host, launch, encoded) =
                row.map_err(|_| ReaderOutcome::InvalidStoredData)?;
            if host != anchor.host_session_id || launch != anchor.launch_id {
                return Err(ReaderOutcome::ScopeChanged);
            }
            if encoded.len() > RECORD_LIMIT {
                return Err(ReaderOutcome::InvalidStoredData);
            }
            let attempt: Attempt =
                serde_json::from_str(&encoded).map_err(|_| ReaderOutcome::InvalidStoredData)?;
            attempt
                .validate()
                .map_err(|_| ReaderOutcome::InvalidStoredData)?;
            if i64::try_from(attempt.attempt_sequence).ok() != Some(sequence) {
                return Err(ReaderOutcome::InvalidStoredData);
            }
            match slot {
                1 => delivery.latest_started = Some(attempt),
                2 if attempt.state == State::Completed => delivery.latest_completed = Some(attempt),
                3 if attempt.state == State::Completed
                    && attempt.outcome != Some(Outcome::Recorded) =>
                {
                    delivery.latest_rejected = Some(attempt)
                }
                _ => return Err(ReaderOutcome::InvalidStoredData),
            }
        }
        let started = delivery
            .latest_started
            .as_ref()
            .map(|attempt| attempt.attempt_sequence);
        let completed = delivery
            .latest_completed
            .as_ref()
            .map(|attempt| attempt.attempt_sequence);
        let rejected = delivery
            .latest_rejected
            .as_ref()
            .map(|attempt| attempt.attempt_sequence);
        if completed.is_some_and(|sequence| started.is_none_or(|latest| latest < sequence))
            || rejected.is_some_and(|sequence| completed.is_none_or(|latest| latest < sequence))
        {
            return Err(ReaderOutcome::InvalidStoredData);
        }
        Ok(delivery)
    })();
    match result {
        Ok(mut delivery) => {
            delivery.last_storage_failure = view.delivery.last_storage_failure;
            view.delivery = delivery;
        }
        Err(ReaderOutcome::Unreadable) => {
            view.reader.outcome = match connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_attempts')", [], |row| row.get::<_, bool>(0)) {
                Ok(false) => ReaderOutcome::Missing,
                Ok(true) => ReaderOutcome::Unreadable,
                Err(_) => ReaderOutcome::Unreadable,
            };
        }
        Err(outcome) => view.reader.outcome = outcome,
    }
    view
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{cell::Cell, io::Cursor, path::PathBuf};

    struct Fixture {
        report: PathBuf,
        anchor: Anchor,
    }

    impl Fixture {
        fn new(bound: bool) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "nesvo-capture-diagnostic-{}",
                hex::encode(crate::wire::random::<16>())
            ));
            std::fs::create_dir(&directory).unwrap();
            let report = directory.join("context.json");
            agent_events::initialize(&report, "host-fixture").unwrap();
            let anchor = install(&report).unwrap();
            let fixture = Self { report, anchor };
            if bound {
                fixture.bind("conversation-a");
            }
            fixture
        }

        fn bind(&self, provider: &str) {
            agent_events::append(
                &self.report,
                Some(provider),
                "SessionStart",
                crate::status::StatusState::Idle,
                true,
                None,
            )
            .unwrap();
        }

        fn payload(&self) -> Value {
            let reset = crate::status::now_millis() / 1000 + 3600;
            json!({"session_id":"conversation-a","rate_limits":{"five_hour":{"used_percentage":31.25,"resets_at":reset},"seven_day":{"used_percentage":42.5,"resets_at":reset + 86400}},"cwd":"PRIVATE-CWD","prompt":"PRIVATE-PROMPT","arbitrary_error":"PRIVATE-ERROR"})
        }

        fn receive(&self, value: Value) -> Outcome {
            claude_quota::receive_capture(
                &self.report,
                &self.anchor,
                Cursor::new(serde_json::to_vec(&value).unwrap()),
            )
        }

        fn observer(&self) -> agent_events::Observer {
            agent_events::Observer::new(self.report.clone(), "host-fixture".into())
                .with_capture(Some(self.anchor.clone()))
        }

        fn view(&self) -> View {
            let mut observer = self.observer();
            let _ = observer.poll(0, true, &mut agent_events::ReadCounts::default());
            observer.capture_diagnostic().unwrap().clone()
        }

        fn accepted(&self) -> Option<claude_quota::Observation> {
            claude_quota::read(&self.report, "host-fixture").unwrap()
        }

        fn assert_private(&self) {
            let view = serde_json::to_string(&self.view()).unwrap();
            for private in [
                "PRIVATE-",
                "conversation-a",
                "host-fixture",
                self.anchor.launch_id.as_str(),
            ] {
                assert!(!view.contains(private));
            }
            let connection = agent_events::capture_connection(&self.report).unwrap();
            let count: i64 = connection
                .query_row("SELECT count(*) FROM capture_attempts", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert!(count <= 3);
            let database = std::fs::read(self.report.with_file_name("events.sqlite3")).unwrap();
            assert!(!String::from_utf8_lossy(&database).contains("PRIVATE-"));
            if let Ok(sidecar) = std::fs::read(self.report.with_file_name(SIDECAR)) {
                assert!(!String::from_utf8_lossy(&sidecar).contains("PRIVATE-"));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.report.parent().unwrap());
        }
    }

    struct OnRead<F> {
        input: Cursor<Vec<u8>>,
        action: Option<F>,
    }
    impl<F: FnOnce()> Read for OnRead<F> {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if let Some(action) = self.action.take() {
                action();
            }
            self.input.read(bytes)
        }
    }

    fn clock(value: u64) -> claude_quota::ReceiptClock {
        claude_quota::ReceiptClock {
            wall_ms: 1000 + value,
            monotonic_ms: 100 + value,
        }
    }

    fn reserve(fixture: &Fixture, value: u64) -> Reservation {
        match begin(&fixture.report, &fixture.anchor, clock(value)).unwrap() {
            Begin::Reserved(reservation) => reservation,
            Begin::ScopeChanged => panic!("Owned fixture changed scope"),
        }
    }

    fn snapshot(value: u64) -> claude_quota::StoredSnapshot {
        claude_quota::StoredSnapshot {
            started_wall_ms: 1000 + value,
            received_wall_ms: 1001 + value,
            started_monotonic_ms: 100 + value,
            received_monotonic_ms: 101 + value,
            five_hour: None,
            seven_day: None,
            reason: claude_quota::Reason::WindowsUnavailable,
        }
    }

    #[test]
    fn unbound_entry_never_reads_or_borrows_a_later_root_and_attempt_sequence_is_independent() {
        let fixture = Fixture::new(false);
        let read = Cell::new(false);
        let input = OnRead {
            input: Cursor::new(serde_json::to_vec(&fixture.payload()).unwrap()),
            action: Some(|| {
                read.set(true);
                fixture.bind("conversation-a");
            }),
        };
        assert_eq!(
            claude_quota::receive_capture(&fixture.report, &fixture.anchor, input),
            Outcome::RootUnbound
        );
        assert!(!read.get());
        fixture.bind("conversation-a");
        assert!(fixture.accepted().is_none());
        let unbound = fixture.view().delivery.latest_completed.unwrap();
        assert_eq!(unbound.outcome, Some(Outcome::RootUnbound));
        assert!(!unbound.bound_at_entry);
        assert_eq!(unbound.entry_generation, 1);
        assert_eq!(fixture.receive(fixture.payload()), Outcome::Recorded);
        let view = fixture.view();
        assert_eq!(view.delivery.latest_completed.unwrap().attempt_sequence, 2);
        assert_eq!(view.delivery.latest_rejected.unwrap().attempt_sequence, 1);
        assert_eq!(
            fixture.accepted().unwrap().scope.sequence,
            1,
            "Diagnostic attempt sequence is not quota reservation/commit sequence"
        );
        fixture.assert_private();
    }

    #[test]
    fn root_rebind_during_input_records_entry_generation_without_accepting_old_payload() {
        let fixture = Fixture::new(true);
        let input = OnRead {
            input: Cursor::new(serde_json::to_vec(&fixture.payload()).unwrap()),
            action: Some(|| fixture.bind("conversation-b")),
        };
        assert_eq!(
            claude_quota::receive_capture(&fixture.report, &fixture.anchor, input),
            Outcome::ScopeChanged
        );
        assert!(fixture.accepted().is_none());
        let view = fixture.view();
        assert_eq!(view.reader.outcome, ReaderOutcome::Readable);
        let completed = view.delivery.latest_completed.unwrap();
        assert_eq!(completed.entry_generation, 1);
        assert!(completed.bound_at_entry);
        assert_eq!(completed.outcome, Some(Outcome::ScopeChanged));
        fixture.assert_private();
    }

    #[test]
    fn out_of_order_completion_cannot_replace_newer_completion_rejection_or_accepted_snapshot() {
        let fixture = Fixture::new(true);
        let first = reserve(&fixture, 1);
        let second = reserve(&fixture, 2);
        assert_eq!(
            finish(
                &fixture.report,
                &fixture.anchor,
                &second,
                Outcome::Recorded,
                Some(&snapshot(2)),
                clock(3)
            )
            .unwrap(),
            Outcome::Recorded
        );
        let accepted = fixture.accepted().unwrap();
        assert_eq!(
            finish(
                &fixture.report,
                &fixture.anchor,
                &first,
                Outcome::Recorded,
                Some(&snapshot(1)),
                clock(4)
            )
            .unwrap(),
            Outcome::Superseded
        );
        assert_eq!(fixture.accepted(), Some(accepted.clone()));
        let view = fixture.view();
        assert_eq!(view.delivery.latest_started.unwrap().attempt_sequence, 2);
        assert_eq!(view.delivery.latest_completed.unwrap().attempt_sequence, 2);
        assert_eq!(
            view.delivery.latest_rejected.unwrap().outcome,
            Some(Outcome::Superseded)
        );
        let third = reserve(&fixture, 5);
        let fourth = reserve(&fixture, 6);
        assert_eq!(
            finish(
                &fixture.report,
                &fixture.anchor,
                &fourth,
                Outcome::PayloadScopeRejected,
                None,
                clock(7)
            )
            .unwrap(),
            Outcome::PayloadScopeRejected
        );
        assert_eq!(
            finish(
                &fixture.report,
                &fixture.anchor,
                &third,
                Outcome::Recorded,
                Some(&snapshot(5)),
                clock(8)
            )
            .unwrap(),
            Outcome::Superseded
        );
        let view = fixture.view();
        assert_eq!(view.delivery.latest_completed.unwrap().attempt_sequence, 4);
        assert_eq!(view.delivery.latest_rejected.unwrap().attempt_sequence, 4);
        assert_eq!(fixture.accepted(), Some(accepted));
        fixture.assert_private();
    }

    #[test]
    fn rejected_payload_is_separate_from_accepted_quota_and_invalid_quota_replaces_success() {
        let fixture = Fixture::new(true);
        assert_eq!(fixture.receive(fixture.payload()), Outcome::Recorded);
        let accepted = fixture.accepted().unwrap();
        for rejected in [
            json!({"session_id":"PRIVATE-FOREIGN-ROOT"}),
            json!({"session_id":"conversation-a","agent_id":"PRIVATE-CHILD"}),
            json!({"session_id":"conversation-a","task":{"name":"PRIVATE-TASK"}}),
        ] {
            assert_eq!(fixture.receive(rejected), Outcome::PayloadScopeRejected);
            assert_eq!(fixture.accepted(), Some(accepted.clone()));
        }
        let rejected = fixture.view().delivery.latest_rejected.unwrap();
        assert_eq!(rejected.outcome, Some(Outcome::PayloadScopeRejected));
        assert!(rejected.parse_reason.is_none());
        let mut invalid = fixture.payload();
        invalid["rate_limits"]["five_hour"]["used_percentage"] = json!("PRIVATE-INVALID-WINDOW");
        assert_eq!(fixture.receive(invalid), Outcome::Recorded);
        let current = fixture.accepted().unwrap();
        assert!(current.snapshot.five_hour.is_none() && current.snapshot.seven_day.is_none());
        assert_eq!(current.snapshot.reason, claude_quota::Reason::InvalidWindow);
        let view = fixture.view();
        assert_eq!(
            view.delivery.latest_completed.unwrap().parse_reason,
            Some(claude_quota::Reason::InvalidWindow)
        );
        assert_eq!(view.delivery.latest_rejected.unwrap(), rejected);
        fixture.assert_private();
    }

    #[test]
    fn missing_journal_exposes_anchored_historical_sidecar_then_recovers_original_snapshot() {
        let fixture = Fixture::new(true);
        fixture.receive(fixture.payload());
        let accepted = fixture.accepted().unwrap();
        let mut observer = fixture.observer();
        observer
            .poll(0, true, &mut agent_events::ReadCounts::default())
            .unwrap();
        let database = fixture.report.with_file_name("events.sqlite3");
        let retained = fixture.report.with_file_name("retained.sqlite3");
        std::fs::rename(&database, &retained).unwrap();
        assert_eq!(
            fixture.receive(fixture.payload()),
            Outcome::StorageUnavailable
        );
        assert!(
            observer
                .poll(0, true, &mut agent_events::ReadCounts::default())
                .is_err()
        );
        let failed = observer.capture_diagnostic().unwrap();
        assert_eq!(failed.reader.outcome, ReaderOutcome::Unreadable);
        assert_eq!(
            failed.reader.storage_failure_outcome,
            ReaderOutcome::Readable
        );
        assert!(failed.delivery.latest_started.is_none());
        let failure = failed.delivery.last_storage_failure.clone().unwrap();
        assert_eq!(failure.stage, Stage::Begin);
        assert!(failure.attempt_sequence.is_none());
        std::fs::rename(retained, database).unwrap();
        let recovered = observer
            .poll(0, true, &mut agent_events::ReadCounts::default())
            .unwrap();
        assert_eq!(recovered.quota, Some(accepted));
        let view = observer.capture_diagnostic().unwrap();
        assert_eq!(view.reader.outcome, ReaderOutcome::Readable);
        assert_eq!(view.delivery.last_storage_failure, Some(failure));
        let sidecar = fixture.report.with_file_name(SIDECAR);
        let mut foreign: FailureFile =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        foreign.anchor.launch_id = "another-launch".into();
        std::fs::write(&sidecar, serde_json::to_vec(&foreign).unwrap()).unwrap();
        let refused = fixture.view();
        assert_eq!(
            refused.reader.storage_failure_outcome,
            ReaderOutcome::ScopeChanged
        );
        assert!(refused.delivery.last_storage_failure.is_none());
        fixture.assert_private();
    }

    #[test]
    fn append_diagnostic_failure_rolls_back_quota_and_remains_an_unconfirmed_attempt() {
        let fixture = Fixture::new(true);
        agent_events::capture_connection(&fixture.report).unwrap().execute_batch("CREATE TRIGGER reject_capture_finish BEFORE INSERT ON capture_attempts WHEN NEW.slot=2 BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
        assert_eq!(
            fixture.receive(fixture.payload()),
            Outcome::StorageUnavailable
        );
        assert!(
            fixture.accepted().is_none(),
            "Quota and completion commit atomically"
        );
        let view = fixture.view();
        assert_eq!(view.reader.outcome, ReaderOutcome::Readable);
        let started = view.delivery.latest_started.unwrap();
        assert_eq!(started.state, State::Unconfirmed);
        assert!(started.outcome.is_none());
        assert!(view.delivery.latest_completed.is_none());
        let failure = view.delivery.last_storage_failure.unwrap();
        assert_eq!(failure.stage, Stage::Append);
        assert_eq!(failure.attempt_sequence, Some(started.attempt_sequence));
        fixture.assert_private();
    }

    #[test]
    fn invalid_missing_and_unreadable_diagnostics_are_typed_without_resurrecting_private_data() {
        let fixture = Fixture::new(true);
        fixture.receive(fixture.payload());
        let connection = agent_events::capture_connection(&fixture.report).unwrap();
        connection
            .execute(
                "UPDATE capture_attempts SET record=?1 WHERE slot=1",
                ["{\"PRIVATE-ERROR\":\"PRIVATE-PATH\"}"],
            )
            .unwrap();
        let invalid = fixture.view();
        assert_eq!(invalid.reader.outcome, ReaderOutcome::InvalidStoredData);
        assert!(invalid.delivery.latest_completed.is_none());
        assert!(
            !serde_json::to_string(&invalid)
                .unwrap()
                .contains("PRIVATE-")
        );
        connection
            .execute_batch("DROP TABLE capture_attempts")
            .unwrap();
        assert_eq!(fixture.view().reader.outcome, ReaderOutcome::Missing);
        let path = fixture.report.with_file_name(SIDECAR);
        std::fs::write(&path, b"PRIVATE-INVALID").unwrap();
        assert_eq!(
            fixture.view().reader.storage_failure_outcome,
            ReaderOutcome::InvalidStoredData
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(
            fixture.view().reader.storage_failure_outcome,
            ReaderOutcome::Unreadable
        );
    }

    #[test]
    fn unavailable_sidecar_leaves_no_owned_temporary_and_never_recreates_removed_launch() {
        let fixture = Fixture::new(true);
        let sidecar = fixture.report.with_file_name(SIDECAR);
        std::fs::create_dir(&sidecar).unwrap();
        let database = fixture.report.with_file_name("events.sqlite3");
        let retained = fixture.report.with_file_name("retained.sqlite3");
        std::fs::rename(&database, &retained).unwrap();
        assert_eq!(
            fixture.receive(fixture.payload()),
            Outcome::StorageUnavailable
        );
        assert_eq!(
            fixture.view().reader.storage_failure_outcome,
            ReaderOutcome::Unreadable
        );
        assert!(
            !std::fs::read_dir(fixture.report.parent().unwrap())
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp"))
        );
        std::fs::remove_dir_all(fixture.report.parent().unwrap()).unwrap();
        assert_eq!(
            fixture.receive(fixture.payload()),
            Outcome::StorageUnavailable
        );
        assert!(!fixture.report.parent().unwrap().exists());
    }

    #[test]
    fn unconfigured_manual_callback_keeps_diagnostic_storage_and_reader_disabled() {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-manual-quota-{}",
            hex::encode(crate::wire::random::<16>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let report = directory.join("context.json");
        agent_events::initialize(&report, "host-fixture").unwrap();
        agent_events::append(
            &report,
            Some("conversation-a"),
            "SessionStart",
            crate::status::StatusState::Idle,
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            claude_quota::receive(&report, Cursor::new(b"{\"session_id\":\"conversation-a\"}"))
                .unwrap(),
            claude_quota::ReceiveOutcome::Recorded
        );
        let connection = agent_events::capture_connection(&report).unwrap();
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_attempts')", [], |row| row.get(0)).unwrap();
        assert!(!exists);
        assert!(!report.with_file_name(SIDECAR).exists());
        let mut observer = agent_events::Observer::new(report.clone(), "host-fixture".into());
        let mut counts = agent_events::ReadCounts::default();
        assert!(observer.poll(0, true, &mut counts).unwrap().quota.is_some());
        assert!(observer.capture_diagnostic().is_none());
        assert_eq!(counts.scope_polls, 1);
        assert_eq!(counts.database_opens, 1);
        assert_eq!(counts.read_transactions, 1);
        assert_eq!(counts.lifecycle_schema_probes, 1);
        assert_eq!(counts.quota_decodes, 1);
        drop(connection);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
