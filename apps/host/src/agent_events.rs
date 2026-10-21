//! Launch-scoped lifecycle journal. Sequence order does not depend on wall time.
use crate::status::StatusState;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::{path::Path, time::Duration};

const RETENTION: u64 = 1024;
const BATCH: u64 = 256;

/// Aggregate observer work only. No launch identity or stored content is retained.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadCounts {
    pub scope_polls: u64,
    pub database_open_attempts: u64,
    pub database_opens: u64,
    pub read_transaction_attempts: u64,
    pub read_transactions: u64,
    pub lifecycle_schema_probes: u64,
    pub quota_table_probes: u64,
    pub quota_rows: u64,
    pub quota_decodes: u64,
    pub lifecycle_event_rows: u64,
    pub lifecycle_read_failures: u64,
    pub quota_read_failures: u64,
    pub blocking_task_failures: u64,
}

impl ReadCounts {
    pub fn accumulate(&mut self, other: Self) {
        self.scope_polls = self.scope_polls.saturating_add(other.scope_polls);
        self.database_open_attempts = self
            .database_open_attempts
            .saturating_add(other.database_open_attempts);
        self.database_opens = self.database_opens.saturating_add(other.database_opens);
        self.read_transaction_attempts = self
            .read_transaction_attempts
            .saturating_add(other.read_transaction_attempts);
        self.read_transactions = self
            .read_transactions
            .saturating_add(other.read_transactions);
        self.lifecycle_schema_probes = self
            .lifecycle_schema_probes
            .saturating_add(other.lifecycle_schema_probes);
        self.quota_table_probes = self
            .quota_table_probes
            .saturating_add(other.quota_table_probes);
        self.quota_rows = self.quota_rows.saturating_add(other.quota_rows);
        self.quota_decodes = self.quota_decodes.saturating_add(other.quota_decodes);
        self.lifecycle_event_rows = self
            .lifecycle_event_rows
            .saturating_add(other.lifecycle_event_rows);
        self.lifecycle_read_failures = self
            .lifecycle_read_failures
            .saturating_add(other.lifecycle_read_failures);
        self.quota_read_failures = self
            .quota_read_failures
            .saturating_add(other.quota_read_failures);
        self.blocking_task_failures = self
            .blocking_task_failures
            .saturating_add(other.blocking_task_failures);
    }
}

fn database(report: &Path) -> std::path::PathBuf {
    report.with_file_name("events.sqlite3")
}
pub fn exists(report: &Path) -> bool {
    database(report).is_file()
}
pub fn initialize(report: &Path, session_id: &str) -> Result<()> {
    let connection = Connection::open(database(report))?;
    connection.execute_batch("CREATE TABLE scope (id INTEGER PRIMARY KEY CHECK(id=1), host_session TEXT NOT NULL, launch_id TEXT NOT NULL, provider_session TEXT, provider_turn TEXT, generation INTEGER NOT NULL DEFAULT 1, rejected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, provider_session TEXT, event TEXT NOT NULL, state TEXT NOT NULL, prompt_digest TEXT, paste_digest TEXT);
      CREATE TABLE native_turns (generation INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(generation,id));")?;
    connection.execute(
        "INSERT INTO scope(id,host_session,launch_id) VALUES(1,?1,?2)",
        params![session_id, hex::encode(crate::wire::random::<16>())],
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(database(report), std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
fn open(report: &Path, writable: bool) -> Result<Connection> {
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(database(report), flags)?;
    connection.busy_timeout(Duration::from_millis(50))?;
    Ok(connection)
}
#[cfg(test)]
pub fn append(
    report: &Path,
    provider_session: Option<&str>,
    event: &str,
    state: StatusState,
    allow_rebind: bool,
    prompt_digest: Option<&str>,
) -> Result<Option<u64>> {
    append_scoped(
        report,
        SourceEvent {
            provider_session,
            provider_turn: None,
            event,
            state,
            allow_rebind,
            prompt_digest,
            paste_digest: None,
        },
    )
}
pub struct SourceEvent<'a> {
    pub provider_session: Option<&'a str>,
    pub provider_turn: Option<&'a str>,
    pub event: &'a str,
    pub state: StatusState,
    pub allow_rebind: bool,
    pub prompt_digest: Option<&'a str>,
    pub paste_digest: Option<&'a str>,
}
pub fn append_scoped(report: &Path, source: SourceEvent<'_>) -> Result<Option<u64>> {
    let SourceEvent {
        provider_session,
        provider_turn,
        event,
        state,
        allow_rebind,
        prompt_digest,
        paste_digest,
    } = source;
    ensure!(
        prompt_digest
            .into_iter()
            .chain(paste_digest)
            .all(|hash| event == "UserPromptSubmit"
                && hash.len() == 64
                && hash.bytes().all(|b| b.is_ascii_hexdigit())),
        "Invalid prompt fingerprint"
    );
    ensure!(
        provider_session.is_none_or(|id| !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))),
        "Invalid provider identity"
    );
    ensure!(
        provider_turn.is_none_or(|id| !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))),
        "Invalid provider turn identity"
    );
    let mut connection = open(report, true)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (active, mut generation): (Option<String>, i64) = transaction.query_row(
        "SELECT provider_session,generation FROM scope WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let changed = active.as_deref() != provider_session;
    if changed
        && active.is_some()
        && (event != "SessionStart" || !allow_rebind || provider_session.is_none())
    {
        transaction.execute("UPDATE scope SET rejected=rejected+1 WHERE id=1", [])?;
        transaction.commit()?;
        return Ok(None);
    }
    if changed {
        if active.is_some() {
            ensure!(generation < i64::MAX, "Generation counter exhausted");
            generation += 1;
        }
        transaction.execute(
            "UPDATE scope SET provider_session=?1,generation=?2 WHERE id=1",
            params![provider_session, generation],
        )?;
    }
    let turn_column = has_column(&transaction, "scope", "provider_turn")?;
    if let Some(turn) = provider_turn {
        ensure!(
            turn_column,
            "Native turn correlation requires a current launch journal"
        );
        let current: Option<String> =
            transaction.query_row("SELECT provider_turn FROM scope WHERE id=1", [], |row| {
                row.get(0)
            })?;
        if event == "UserPromptSubmit" {
            let seen: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM native_turns WHERE generation=?1 AND id=?2)",
                params![generation, turn],
                |row| row.get(0),
            )?;
            if seen {
                // Repeated pickup cannot supersede or duplicate the same native turn.
                transaction.commit()?;
                return Ok(None);
            }
            let count: i64 =
                transaction.query_row("SELECT count(*) FROM native_turns", [], |row| row.get(0))?;
            ensure!(
                count < 4096,
                "Native turn fence capacity exhausted; reconcile this launch before further native correlation"
            );
            transaction.execute(
                "INSERT INTO native_turns(generation,id) VALUES(?1,?2)",
                params![generation, turn],
            )?;
            transaction.execute("UPDATE scope SET provider_turn=?1 WHERE id=1", [turn])?;
        } else if current.as_deref() != Some(turn) {
            transaction.execute("UPDATE scope SET rejected=rejected+1 WHERE id=1", [])?;
            transaction.commit()?;
            return Ok(None);
        }
    } else if event == "SessionStart" && turn_column && changed {
        transaction.execute("UPDATE scope SET provider_turn=NULL WHERE id=1", [])?;
    }
    // Old launch journals remain readable/writable if a helper is upgraded while
    // their host is still running. They simply provide no prompt correlation.
    let digest_column = has_digest_column(&transaction)?;
    let state = serde_json::to_string(&state)?;
    if digest_column && has_column(&transaction, "events", "paste_digest")? {
        transaction.execute("INSERT INTO events(generation,provider_session,event,state,prompt_digest,paste_digest) VALUES(?1,?2,?3,?4,?5,?6)",params![generation,provider_session,event,state,prompt_digest,paste_digest])?;
    } else if digest_column {
        transaction.execute("INSERT INTO events(generation,provider_session,event,state,prompt_digest) VALUES(?1,?2,?3,?4,?5)",params![generation,provider_session,event,state,prompt_digest])?;
    } else {
        transaction.execute(
            "INSERT INTO events(generation,provider_session,event,state) VALUES(?1,?2,?3,?4)",
            params![generation, provider_session, event, state],
        )?;
    }
    let sequence = u64::try_from(transaction.last_insert_rowid())?;
    transaction.execute(
        "DELETE FROM events WHERE sequence<=?1",
        [sequence.saturating_sub(RETENTION) as i64],
    )?;
    if provider_turn.is_some() && matches!(event, "Stop" | "Interrupt") {
        transaction.execute("UPDATE scope SET provider_turn=NULL WHERE id=1", [])?;
    }
    transaction.commit()?;
    Ok(Some(sequence))
}
fn has_digest_column(connection: &Connection) -> Result<bool> {
    has_column(connection, "events", "prompt_digest")
}
fn has_column(connection: &Connection, table: &'static str, wanted: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == wanted {
            return Ok(true);
        }
    }
    Ok(false)
}
pub fn accepts_context(report: &Path, provider_session: Option<&str>) -> Result<bool> {
    let active: Option<String> = open(report, false)?.query_row(
        "SELECT provider_session FROM scope WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    Ok(active.is_none() || active.as_deref() == provider_session)
}

/// A private callback ticket never binds or changes lifecycle identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RootQuotaTicket {
    pub(crate) host_session_id: String,
    pub(crate) launch_id: String,
    pub(crate) provider_session_id: String,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
}

fn quota_scope(connection: &Connection) -> Result<(String, String, Option<String>, u64)> {
    Ok(connection.query_row(
        "SELECT host_session,launch_id,provider_session,generation FROM scope WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, unsigned(row, 3)?)),
    )?)
}

/// Reserve ordering before reading stdin, so an older callback cannot replace a
/// newer callback that completed first. Only one small snapshot is retained.
pub(crate) fn begin_root_quota(report: &Path) -> Result<Option<RootQuotaTicket>> {
    let mut connection = open(report, true)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (host_session_id, launch_id, provider_session_id, generation) = quota_scope(&transaction)?;
    let Some(provider_session_id) = provider_session_id else {
        return Ok(None);
    };
    ensure!(
        !provider_session_id.is_empty() && generation > 0,
        "Invalid bound quota scope"
    );
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS root_quota (
          id INTEGER PRIMARY KEY CHECK(id=1),
          next_sequence INTEGER NOT NULL CHECK(next_sequence>=0),
          sequence INTEGER,
          launch_id TEXT,
          provider_session TEXT,
          generation INTEGER,
          snapshot TEXT CHECK(snapshot IS NULL OR length(snapshot)<=2048)
        );
        INSERT OR IGNORE INTO root_quota(id,next_sequence) VALUES(1,0);",
    )?;
    let previous: u64 = transaction.query_row(
        "SELECT next_sequence FROM root_quota WHERE id=1",
        [],
        |row| unsigned(row, 0),
    )?;
    let sequence = previous
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("Quota callback counter exhausted"))?;
    transaction.execute(
        "UPDATE root_quota SET next_sequence=?1 WHERE id=1",
        [sequence as i64],
    )?;
    transaction.commit()?;
    Ok(Some(RootQuotaTicket {
        host_session_id,
        launch_id,
        provider_session_id,
        generation,
        sequence,
    }))
}

/// The value is the receiver's typed projection, never the native JSON input.
pub(crate) fn append_root_quota(
    report: &Path,
    ticket: &RootQuotaTicket,
    snapshot: &crate::claude_quota::StoredSnapshot,
) -> Result<bool> {
    snapshot.validate()?;
    let encoded = serde_json::to_string(snapshot)?;
    ensure!(
        encoded.len() <= 2048,
        "Quota snapshot exceeds private bound"
    );
    let mut connection = open(report, true)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (host_session, launch, provider_session, generation) = quota_scope(&transaction)?;
    if host_session != ticket.host_session_id
        || launch != ticket.launch_id
        || provider_session.as_deref() != Some(ticket.provider_session_id.as_str())
        || generation != ticket.generation
    {
        return Ok(false);
    }
    let changed = transaction.execute(
        "UPDATE root_quota SET sequence=?1,launch_id=?2,provider_session=?3,generation=?4,snapshot=?5
         WHERE id=1 AND next_sequence=?1",
        params![i64::try_from(ticket.sequence)?, ticket.launch_id, ticket.provider_session_id,
            i64::try_from(ticket.generation)?, encoded],
    )?;
    transaction.commit()?;
    Ok(changed == 1)
}

#[cfg(test)]
pub(crate) fn read_root_quota(
    report: &Path,
    expected_session: &str,
) -> Result<Option<(RootQuotaTicket, crate::claude_quota::StoredSnapshot)>> {
    read_root_quota_counted(report, expected_session, &mut ReadCounts::default())
}

pub(crate) fn read_root_quota_counted(
    report: &Path,
    expected_session: &str,
    counts: &mut ReadCounts,
) -> Result<Option<(RootQuotaTicket, crate::claude_quota::StoredSnapshot)>> {
    let result = read_root_quota_inner(report, expected_session, counts);
    if result.is_err() {
        counts.quota_read_failures = counts.quota_read_failures.saturating_add(1);
    }
    result
}

fn read_root_quota_inner(
    report: &Path,
    expected_session: &str,
    counts: &mut ReadCounts,
) -> Result<Option<(RootQuotaTicket, crate::claude_quota::StoredSnapshot)>> {
    counts.database_open_attempts = counts.database_open_attempts.saturating_add(1);
    let mut connection = open(report, false)?;
    counts.database_opens = counts.database_opens.saturating_add(1);
    counts.read_transaction_attempts = counts.read_transaction_attempts.saturating_add(1);
    let transaction = connection.transaction()?;
    counts.read_transactions = counts.read_transactions.saturating_add(1);
    let (host_session_id, launch_id, provider_session_id, generation) = quota_scope(&transaction)?;
    ensure!(
        host_session_id == expected_session,
        "Quota launch belongs to another session"
    );
    let Some(provider_session_id) = provider_session_id else {
        return Ok(None);
    };
    counts.quota_table_probes = counts.quota_table_probes.saturating_add(1);
    let table_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='root_quota')",
        [],
        |row| row.get(0),
    )?;
    if !table_exists {
        return Ok(None);
    }
    let saved = transaction
        .query_row(
            "SELECT sequence,snapshot FROM root_quota WHERE id=1 AND launch_id=?1
         AND provider_session=?2 AND generation=?3 AND snapshot IS NOT NULL",
            params![launch_id, provider_session_id, i64::try_from(generation)?],
            |row| Ok((unsigned(row, 0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((sequence, encoded)) = saved else {
        return Ok(None);
    };
    counts.quota_rows = counts.quota_rows.saturating_add(1);
    ensure!(encoded.len() <= 2048, "Invalid stored quota snapshot");
    counts.quota_decodes = counts.quota_decodes.saturating_add(1);
    let snapshot: crate::claude_quota::StoredSnapshot = serde_json::from_str(&encoded)
        .map_err(|_| anyhow::anyhow!("Invalid stored quota snapshot"))?;
    snapshot.validate()?;
    transaction.commit()?;
    Ok(Some((
        RootQuotaTicket {
            host_session_id,
            launch_id,
            provider_session_id,
            generation,
            sequence,
        },
        snapshot,
    )))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub host_session_id: String,
    pub launch_id: String,
    pub provider_session_id: Option<String>,
    pub generation: u64,
    pub rejected: u64,
    pub prompt_correlation: bool,
}
pub struct Event {
    pub name: String,
    pub sequence: u64,
    pub generation: u64,
    pub state: StatusState,
    pub prompt_digest: Option<String>,
    pub paste_digest: Option<String>,
}
pub struct Batch {
    pub identity: Identity,
    pub events: Vec<Event>,
    pub gap: bool,
    pub observed: bool,
    pub head_sequence: u64,
}
fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
pub fn read(report: &Path, expected_session: &str, after: u64) -> Result<Batch> {
    read_counted(report, expected_session, after, &mut ReadCounts::default())
}

pub(crate) fn read_counted(
    report: &Path,
    expected_session: &str,
    after: u64,
    counts: &mut ReadCounts,
) -> Result<Batch> {
    let result = read_inner(report, expected_session, after, counts);
    if result.is_err() {
        counts.lifecycle_read_failures = counts.lifecycle_read_failures.saturating_add(1);
    }
    result
}

fn read_inner(
    report: &Path,
    expected_session: &str,
    after: u64,
    counts: &mut ReadCounts,
) -> Result<Batch> {
    ensure!(after <= i64::MAX as u64, "Invalid lifecycle cursor");
    counts.database_open_attempts = counts.database_open_attempts.saturating_add(1);
    let mut connection = open(report, false)?;
    counts.database_opens = counts.database_opens.saturating_add(1);
    counts.read_transaction_attempts = counts.read_transaction_attempts.saturating_add(1);
    let transaction = connection.transaction()?;
    counts.read_transactions = counts.read_transactions.saturating_add(1);
    counts.lifecycle_schema_probes = counts.lifecycle_schema_probes.saturating_add(1);
    let prompt_correlation = has_digest_column(&transaction)?;
    let paste_correlation = if prompt_correlation {
        counts.lifecycle_schema_probes = counts.lifecycle_schema_probes.saturating_add(1);
        has_column(&transaction, "events", "paste_digest")?
    } else {
        false
    };
    let identity = transaction.query_row(
        "SELECT host_session,launch_id,provider_session,generation,rejected FROM scope WHERE id=1",
        [],
        |row| {
            Ok(Identity {
                host_session_id: row.get(0)?,
                launch_id: row.get(1)?,
                provider_session_id: row.get(2)?,
                generation: unsigned(row, 3)?,
                rejected: unsigned(row, 4)?,
                prompt_correlation,
            })
        },
    )?;
    ensure!(
        identity.host_session_id == expected_session,
        "Lifecycle launch belongs to another session"
    );
    let first: Option<i64> =
        transaction.query_row("SELECT min(sequence) FROM events", [], |row| row.get(0))?;
    let head: Option<i64> =
        transaction.query_row("SELECT max(sequence) FROM events", [], |row| row.get(0))?;
    let head_sequence = head.map(u64::try_from).transpose()?.unwrap_or(0);
    ensure!(
        first.is_none_or(|first| first >= 0),
        "Invalid journal sequence"
    );
    let gap = first.is_some_and(|first| first as u64 > after.saturating_add(1));
    let mut events = Vec::new();
    {
        let columns = match (prompt_correlation, paste_correlation) {
            (true, true) => "prompt_digest,paste_digest",
            (true, false) => "prompt_digest,NULL",
            _ => "NULL,NULL",
        };
        let mut statement=transaction.prepare(&format!("SELECT sequence,generation,state,event,{columns} FROM events WHERE sequence>?1 ORDER BY sequence LIMIT ?2"))?;
        let rows = statement.query_map(params![after as i64, BATCH as i64], |row| {
            Ok((
                unsigned(row, 0)?,
                unsigned(row, 1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            counts.lifecycle_event_rows = counts.lifecycle_event_rows.saturating_add(1);
            let (sequence, generation, state, name, prompt_digest, paste_digest) = row?;
            ensure!(state.len() <= 32, "Invalid lifecycle state");
            ensure!(
                prompt_digest
                    .iter()
                    .chain(paste_digest.iter())
                    .all(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())),
                "Invalid stored prompt fingerprint"
            );
            events.push(Event {
                name,
                sequence,
                generation,
                state: serde_json::from_str(&state)?,
                prompt_digest,
                paste_digest,
            });
        }
    }
    transaction.commit()?;
    Ok(Batch {
        identity,
        events,
        gap,
        observed: first.is_some(),
        head_sequence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nesvo-events-{}",
            hex::encode(crate::wire::random::<16>())
        ));
        std::fs::create_dir(&dir).unwrap();
        dir.join("context.json")
    }

    #[test]
    fn observer_counts_measure_separate_reads_and_keep_failed_decode_work() {
        let report = fixture();
        initialize(&report, "host-session").unwrap();
        append(
            &report,
            Some("conversation"),
            "SessionStart",
            StatusState::Idle,
            false,
            None,
        )
        .unwrap();
        let ticket = begin_root_quota(&report).unwrap().unwrap();
        let snapshot = crate::claude_quota::StoredSnapshot {
            started_wall_ms: 1000,
            received_wall_ms: 1001,
            started_monotonic_ms: 1,
            received_monotonic_ms: 2,
            five_hour: None,
            seven_day: None,
            reason: crate::claude_quota::Reason::WindowsUnavailable,
        };
        assert!(append_root_quota(&report, &ticket, &snapshot).unwrap());
        let mut counts = ReadCounts::default();
        let observed = read_root_quota_counted(&report, "host-session", &mut counts)
            .unwrap()
            .unwrap();
        assert_eq!(observed, (ticket, snapshot));
        let lifecycle = read_counted(&report, "host-session", 0, &mut counts).unwrap();
        assert_eq!(lifecycle.events.len(), 1);
        assert_eq!(counts.database_open_attempts, 2);
        assert_eq!(counts.database_opens, 2);
        assert_eq!(counts.read_transaction_attempts, 2);
        assert_eq!(counts.read_transactions, 2);
        assert_eq!(counts.lifecycle_schema_probes, 2);
        assert_eq!(counts.quota_table_probes, 1);
        assert_eq!(counts.quota_rows, 1);
        assert_eq!(counts.quota_decodes, 1);
        assert_eq!(counts.lifecycle_event_rows, 1);
        assert_eq!(counts.lifecycle_read_failures, 0);
        assert_eq!(counts.quota_read_failures, 0);
        assert!(
            read_counted(
                &report,
                "host-session",
                lifecycle.head_sequence,
                &mut counts
            )
            .unwrap()
            .events
            .is_empty()
        );
        assert_eq!(counts.lifecycle_event_rows, 1);
        let connection = Connection::open(database(&report)).unwrap();
        connection
            .execute("UPDATE root_quota SET snapshot='invalid' WHERE id=1", [])
            .unwrap();
        assert!(read_root_quota_counted(&report, "host-session", &mut counts).is_err());
        assert_eq!(counts.database_opens, 4);
        assert_eq!(counts.read_transactions, 4);
        assert_eq!(counts.quota_rows, 2);
        assert_eq!(counts.quota_decodes, 2);
        assert_eq!(counts.quota_read_failures, 1);
        let encoded = serde_json::to_value(&counts).unwrap();
        assert!(
            encoded
                .as_object()
                .unwrap()
                .values()
                .all(serde_json::Value::is_u64)
        );
        drop(connection);
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }

    #[test]
    fn native_turn_fence_rejects_late_stops_and_duplicate_pickup_without_losing_new_work() {
        let report = fixture();
        initialize(&report, "native-session").unwrap();
        let emit = |event, state, turn| {
            append_scoped(
                &report,
                SourceEvent {
                    provider_session: Some("native-conversation"),
                    provider_turn: turn,
                    event,
                    state,
                    allow_rebind: false,
                    prompt_digest: None,
                    paste_digest: None,
                },
            )
            .unwrap()
        };
        assert!(emit("SessionStart", StatusState::Idle, None).is_some());
        assert!(emit("UserPromptSubmit", StatusState::Working, Some("turn-1")).is_some());
        assert_eq!(
            emit("UserPromptSubmit", StatusState::Working, Some("turn-1")),
            None
        );
        assert!(emit("UserPromptSubmit", StatusState::Working, Some("turn-2")).is_some());
        assert_eq!(
            emit("UserPromptSubmit", StatusState::Working, Some("turn-1")),
            None
        );
        assert_eq!(emit("Stop", StatusState::Idle, Some("turn-1")), None);
        assert_eq!(
            emit("PreToolUse", StatusState::Working, Some("turn-1")),
            None
        );
        assert!(
            emit("SessionStart", StatusState::Working, None).is_some(),
            "same-conversation compaction must preserve the native turn fence"
        );
        let batch = read(&report, "native-session", 0).unwrap();
        assert_eq!(batch.events.last().unwrap().state, StatusState::Working);
        assert_eq!(batch.identity.rejected, 2);
        assert!(emit("Stop", StatusState::Idle, Some("turn-2")).is_some());
        assert_eq!(
            emit("PreToolUse", StatusState::Working, Some("turn-2")),
            None,
            "completed native turns cannot revive through late tool events"
        );
        assert_eq!(
            read(&report, "native-session", 0)
                .unwrap()
                .events
                .last()
                .unwrap()
                .state,
            StatusState::Idle
        );
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }
    #[test]
    fn prompt_evidence_is_private_and_legacy_journals_keep_status_compatibility() {
        let report = fixture();
        initialize(&report, "host-session").unwrap();
        let hash = crate::submission::digest("private prompt never stored").unwrap();
        append(
            &report,
            Some("conversation"),
            "UserPromptSubmit",
            StatusState::Working,
            false,
            Some(&hash),
        )
        .unwrap();
        let batch = read(&report, "host-session", 0).unwrap();
        assert!(batch.identity.prompt_correlation);
        assert_eq!(
            batch.events[0].prompt_digest.as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(batch.head_sequence, 1);
        assert!(
            !String::from_utf8_lossy(&std::fs::read(database(&report)).unwrap())
                .contains("private prompt never stored")
        );
        Connection::open(database(&report))
            .unwrap()
            .execute_batch("ALTER TABLE events DROP COLUMN prompt_digest")
            .unwrap();
        append(
            &report,
            Some("conversation"),
            "UserPromptSubmit",
            StatusState::Working,
            false,
            Some(&hash),
        )
        .unwrap();
        let legacy = read(&report, "host-session", 0).unwrap();
        assert!(!legacy.identity.prompt_correlation);
        assert!(legacy.events.iter().all(|e| e.prompt_digest.is_none()));
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }
    #[test]
    fn optional_paste_fingerprint_preserves_raw_legacy_journals_and_rejects_bad_metadata() {
        let report = fixture();
        initialize(&report, "host-session").unwrap();
        let hash = crate::submission::digest("literal owned test").unwrap();
        let source = |event, paste| SourceEvent {
            provider_session: Some("conversation"),
            provider_turn: None,
            event,
            state: StatusState::Working,
            allow_rebind: false,
            prompt_digest: Some(hash.as_str()),
            paste_digest: paste,
        };
        assert!(append_scoped(&report, source("Stop", Some(hash.as_str()))).is_err());
        assert!(append_scoped(&report, source("UserPromptSubmit", Some("invalid"))).is_err());
        append_scoped(&report, source("UserPromptSubmit", Some(hash.as_str()))).unwrap();
        let current = read(&report, "host-session", 0).unwrap();
        assert_eq!(
            current.events[0].paste_digest.as_deref(),
            Some(hash.as_str())
        );
        Connection::open(database(&report))
            .unwrap()
            .execute_batch("ALTER TABLE events DROP COLUMN paste_digest")
            .unwrap();
        append_scoped(&report, source("UserPromptSubmit", Some(hash.as_str()))).unwrap();
        let legacy = read(&report, "host-session", 0).unwrap();
        assert!(legacy.identity.prompt_correlation);
        assert!(
            legacy
                .events
                .iter()
                .all(|e| e.prompt_digest.as_deref() == Some(hash.as_str())
                    && e.paste_digest.is_none())
        );
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }
    #[test]
    fn fast_turns_remain_ordered_and_foreign_conversations_cannot_stop_new_ones() {
        let report = fixture();
        initialize(&report, "host-session").unwrap();
        for (name, state) in [
            ("SessionStart", StatusState::Idle),
            ("UserPromptSubmit", StatusState::Working),
            ("Stop", StatusState::Idle),
        ] {
            append(&report, Some("conversation-a"), name, state, false, None).unwrap();
        }
        let batch = read(&report, "host-session", 0).unwrap();
        assert_eq!(
            batch.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(batch.events[1].state, StatusState::Working);
        append(
            &report,
            Some("conversation-b"),
            "SessionStart",
            StatusState::Idle,
            true,
            None,
        )
        .unwrap();
        assert!(
            append(
                &report,
                Some("conversation-a"),
                "Stop",
                StatusState::Idle,
                false,
                None
            )
            .unwrap()
            .is_none()
        );
        let batch = read(&report, "host-session", 3).unwrap();
        assert_eq!(batch.identity.generation, 2);
        assert_eq!(batch.identity.rejected, 1);
        assert_eq!(batch.events.len(), 1);
        assert!(read(&report, "different-host-session", 0).is_err());
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }
    #[test]
    fn retention_is_bounded_and_reports_cursor_gaps() {
        let report = fixture();
        initialize(&report, "session").unwrap();
        for _ in 0..1026 {
            append(&report, None, "Stop", StatusState::Idle, false, None).unwrap();
        }
        let batch = read(&report, "session", 0).unwrap();
        assert!(batch.gap);
        assert_eq!(batch.events.len(), 256);
        assert_eq!(batch.events[0].sequence, 3);
        assert_eq!(
            read(&report, "session", 1025).unwrap().events[0].sequence,
            1026
        );
        std::fs::remove_dir_all(report.parent().unwrap()).unwrap();
    }
}
