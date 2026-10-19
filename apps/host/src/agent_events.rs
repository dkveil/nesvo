//! Launch-scoped lifecycle journal. Sequence order does not depend on wall time.
use crate::status::StatusState;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use serde::Serialize;
use std::{path::Path, time::Duration};

const RETENTION: u64 = 1024;
const BATCH: u64 = 256;
fn database(report: &Path) -> std::path::PathBuf {
    report.with_file_name("events.sqlite3")
}
pub fn exists(report: &Path) -> bool {
    database(report).is_file()
}
pub fn initialize(report: &Path, session_id: &str) -> Result<()> {
    let connection = Connection::open(database(report))?;
    connection.execute_batch("CREATE TABLE scope (id INTEGER PRIMARY KEY CHECK(id=1), host_session TEXT NOT NULL, launch_id TEXT NOT NULL, provider_session TEXT, provider_turn TEXT, generation INTEGER NOT NULL DEFAULT 1, rejected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, provider_session TEXT, event TEXT NOT NULL, state TEXT NOT NULL, prompt_digest TEXT);
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
}
pub fn append_scoped(report: &Path, source: SourceEvent<'_>) -> Result<Option<u64>> {
    let SourceEvent {
        provider_session,
        provider_turn,
        event,
        state,
        allow_rebind,
        prompt_digest,
    } = source;
    ensure!(
        prompt_digest.is_none_or(|hash| event == "UserPromptSubmit"
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
    if digest_column {
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
    ensure!(after <= i64::MAX as u64, "Invalid lifecycle cursor");
    let mut connection = open(report, false)?;
    let transaction = connection.transaction()?;
    let prompt_correlation = has_digest_column(&transaction)?;
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
        let mut statement=transaction.prepare(if prompt_correlation {"SELECT sequence,generation,state,event,prompt_digest FROM events WHERE sequence>?1 ORDER BY sequence LIMIT ?2"} else {"SELECT sequence,generation,state,event,NULL FROM events WHERE sequence>?1 ORDER BY sequence LIMIT ?2"})?;
        let rows = statement.query_map(params![after as i64, BATCH as i64], |row| {
            Ok((
                unsigned(row, 0)?,
                unsigned(row, 1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        for row in rows {
            let (sequence, generation, state, name, prompt_digest) = row?;
            ensure!(state.len() <= 32, "Invalid lifecycle state");
            ensure!(
                prompt_digest
                    .as_ref()
                    .is_none_or(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())),
                "Invalid stored prompt fingerprint"
            );
            events.push(Event {
                name,
                sequence,
                generation,
                state: serde_json::from_str(&state)?,
                prompt_digest,
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
