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
    connection.execute_batch("CREATE TABLE scope (id INTEGER PRIMARY KEY CHECK(id=1), host_session TEXT NOT NULL, launch_id TEXT NOT NULL, provider_session TEXT, generation INTEGER NOT NULL DEFAULT 1, rejected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, provider_session TEXT, event TEXT NOT NULL, state TEXT NOT NULL);")?;
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
pub fn append(
    report: &Path,
    provider_session: Option<&str>,
    event: &str,
    state: StatusState,
    allow_rebind: bool,
) -> Result<Option<u64>> {
    ensure!(
        provider_session.is_none_or(|id| !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))),
        "Invalid provider identity"
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
    transaction.execute(
        "INSERT INTO events(generation,provider_session,event,state) VALUES(?1,?2,?3,?4)",
        params![
            generation,
            provider_session,
            event,
            serde_json::to_string(&state)?
        ],
    )?;
    let sequence = u64::try_from(transaction.last_insert_rowid())?;
    transaction.execute(
        "DELETE FROM events WHERE sequence<=?1",
        [sequence.saturating_sub(RETENTION) as i64],
    )?;
    transaction.commit()?;
    Ok(Some(sequence))
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
}
pub struct Event {
    pub name: String,
    pub sequence: u64,
    pub generation: u64,
    pub state: StatusState,
}
pub struct Batch {
    pub identity: Identity,
    pub events: Vec<Event>,
    pub gap: bool,
    pub observed: bool,
}
fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
pub fn read(report: &Path, expected_session: &str, after: u64) -> Result<Batch> {
    ensure!(after <= i64::MAX as u64, "Invalid lifecycle cursor");
    let mut connection = open(report, false)?;
    let transaction = connection.transaction()?;
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
            })
        },
    )?;
    ensure!(
        identity.host_session_id == expected_session,
        "Lifecycle launch belongs to another session"
    );
    let first: Option<i64> =
        transaction.query_row("SELECT min(sequence) FROM events", [], |row| row.get(0))?;
    ensure!(
        first.is_none_or(|first| first >= 0),
        "Invalid journal sequence"
    );
    let gap = first.is_some_and(|first| first as u64 > after.saturating_add(1));
    let mut events = Vec::new();
    {
        let mut statement=transaction.prepare("SELECT sequence,generation,state,event FROM events WHERE sequence>?1 ORDER BY sequence LIMIT ?2")?;
        let rows = statement.query_map(params![after as i64, BATCH as i64], |row| {
            Ok((
                unsigned(row, 0)?,
                unsigned(row, 1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (sequence, generation, state, name) = row?;
            ensure!(state.len() <= 32, "Invalid lifecycle state");
            events.push(Event {
                name,
                sequence,
                generation,
                state: serde_json::from_str(&state)?,
            });
        }
    }
    transaction.commit()?;
    Ok(Batch {
        identity,
        events,
        gap,
        observed: first.is_some(),
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
    fn fast_turns_remain_ordered_and_foreign_conversations_cannot_stop_new_ones() {
        let report = fixture();
        initialize(&report, "host-session").unwrap();
        for (name, state) in [
            ("SessionStart", StatusState::Idle),
            ("UserPromptSubmit", StatusState::Working),
            ("Stop", StatusState::Idle),
        ] {
            append(&report, Some("conversation-a"), name, state, false).unwrap();
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
        )
        .unwrap();
        assert!(
            append(
                &report,
                Some("conversation-a"),
                "Stop",
                StatusState::Idle,
                false
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
            append(&report, None, "Stop", StatusState::Idle, false).unwrap();
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
