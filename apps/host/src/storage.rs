use crate::groups::{Group, MAX_GROUPS, validate_edit};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use std::{fmt, path::Path, time::Duration};

#[derive(Debug)]
pub struct RevisionConflict(pub u64);
impl fmt::Display for RevisionConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Metadata changed. Refresh before applying this change (revision {}).",
            self.0
        )
    }
}
impl std::error::Error for RevisionConflict {}

pub struct MetadataStore {
    pub(crate) connection: Connection,
    groups: Vec<Group>,
    pub host_id: String,
    revision: u64,
}

impl MetadataStore {
    pub fn add_schedule(&self, spec: &crate::jobs::LaunchSpec, due: i64) -> Result<String> {
        let count: i64 = self.connection.query_row(
            "SELECT count(*) FROM schedules WHERE state='pending'",
            [],
            |row| row.get(0),
        )?;
        ensure!(count < 64, "Maximum 64 pending schedules.");
        let id = hex::encode(crate::wire::random::<16>());
        self.connection.execute(
            "INSERT INTO schedules(id,due,spec,state) VALUES(?1,?2,?3,'pending')",
            params![id, due, serde_json::to_string(spec)?],
        )?;
        Ok(id)
    }
    pub fn schedules(&self) -> Result<Vec<serde_json::Value>> {
        let mut statement = self.connection.prepare(
            "SELECT id,due,spec,state,result FROM schedules ORDER BY due DESC LIMIT 128",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (id,due,spec,state,result) = row?;
            let spec: crate::jobs::LaunchSpec = serde_json::from_str(&spec)?;
            Ok(serde_json::json!({"id":id,"due":due,"startsAt":chrono::DateTime::from_timestamp(due,0).map(|date| date.to_rfc3339()),"name":spec.name,"program":spec.program,"state":state,"result":result}))
        }).collect()
    }
    pub fn cancel_schedule(&self, id: &str) -> Result<()> {
        ensure!(
            self.connection.execute(
                "UPDATE schedules SET state='cancelled' WHERE id=?1 AND state='pending'",
                [id]
            )? == 1,
            "Only pending schedules can be cancelled."
        );
        Ok(())
    }
    pub fn claim_schedule(&mut self) -> Result<Option<(String, crate::jobs::LaunchSpec)>> {
        use rusqlite::OptionalExtension;
        let now = chrono::Utc::now().timestamp();
        // Quiet legacy ticks share this database with the event journal. A WAL
        // reader needs no writer reservation or wait under the session-state lock.
        let due: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schedules WHERE state='pending' AND due<=?1)",
            [now],
            |row| row.get(0),
        )?;
        if !due {
            return Ok(None);
        }
        // The preflight is only a hint. Re-read after reserving the writer so a
        // competing claim or cancellation cannot launch stale pending work.
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute("UPDATE schedules SET state='missed',result='Host was unavailable at the scheduled time.' WHERE state='pending' AND due < ?1", [now - 60])?;
        let job: Option<(String,String)> = transaction.query_row("SELECT id,spec FROM schedules WHERE state='pending' AND due<=?1 ORDER BY due LIMIT 1", [now], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let job = job
            .map(|(id, spec)| -> Result<_> { Ok((id, serde_json::from_str(&spec)?)) })
            .transpose()?;
        if let Some((id, _)) = &job {
            ensure!(
                transaction.execute(
                    "UPDATE schedules SET state='starting' WHERE id=?1 AND state='pending' AND due<=?2",
                    params![id, now],
                )? == 1,
                "Schedule is no longer claimable."
            );
        }
        transaction.commit()?;
        Ok(job)
    }
    pub fn finish_schedule(&self, id: &str, state: &str, result: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE schedules SET state=?2,result=?3 WHERE id=?1",
            params![id, state, result],
        )?;
        Ok(())
    }

    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).context("Could not open metadata database")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA foreign_keys=ON;")?;
        let schema =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        schema.execute_batch("CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL);
            UPDATE recovery SET state='interrupted' WHERE state='starting';
            CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS host_identity (id INTEGER PRIMARY KEY CHECK(id=1), public_id TEXT NOT NULL);
            INSERT OR IGNORE INTO host_identity VALUES(1,lower(hex(randomblob(16))));
            CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, due INTEGER NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
            CREATE INDEX IF NOT EXISTS schedules_pending_due ON schedules(due) WHERE state='pending';
            UPDATE schedules SET state='interrupted', result='Host stopped during launch; inspect sessions before scheduling again.' WHERE state='starting';
            CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO metadata(id,revision) VALUES(1,0);
            CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES groups(id), name TEXT NOT NULL, sort_order INTEGER NOT NULL);")?;
        schema.commit()?;
        let revision: i64 =
            connection.query_row("SELECT revision FROM metadata WHERE id=1", [], |row| {
                row.get(0)
            })?;
        ensure!(
            (0..=9_007_199_254_740_991).contains(&revision),
            "Invalid metadata revision."
        );
        let revision = revision as u64;
        let groups = {
            let mut statement = connection.prepare(
                "SELECT id,parent_id,name,sort_order FROM groups ORDER BY sort_order,id",
            )?;
            statement
                .query_map([], |row| {
                    Ok(Group {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        name: row.get(2)?,
                        order: row.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        ensure!(
            groups.len() <= MAX_GROUPS,
            "Metadata database has too many groups."
        );
        for group in &groups {
            validate_edit(
                &groups,
                &group.id,
                group.parent_id.as_deref(),
                &group.name,
                group.order,
            )?;
        }
        let host_id = connection.query_row(
            "SELECT public_id FROM host_identity WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(Self {
            host_id,
            connection,
            groups,
            revision,
        })
    }

    pub fn groups(&self) -> &[Group] {
        &self.groups
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn contains(&self, id: &str) -> bool {
        self.groups.iter().any(|group| group.id == id)
    }
    pub fn check_revision(&self, expected: u64) -> Result<()> {
        if expected != self.revision {
            return Err(RevisionConflict(self.revision).into());
        }
        ensure!(
            self.revision < 9_007_199_254_740_991,
            "Metadata revision limit reached."
        );
        Ok(())
    }

    fn mutate(&mut self, sql: &str, values: impl rusqlite::Params) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(sql, values)?;
        transaction.execute("UPDATE metadata SET revision=revision+1 WHERE id=1", [])?;
        transaction.commit()?;
        self.revision += 1;
        Ok(())
    }

    pub fn create(
        &mut self,
        name: &str,
        parent_id: Option<String>,
        order: u32,
        expected: u64,
    ) -> Result<String> {
        self.check_revision(expected)?;
        ensure!(self.groups.len() < MAX_GROUPS, "Maximum 64 groups.");
        let id = hex::encode(crate::wire::random::<16>());
        let name = validate_edit(&self.groups, &id, parent_id.as_deref(), name, order)?;
        self.mutate(
            "INSERT INTO groups(id,parent_id,name,sort_order) VALUES(?1,?2,?3,?4)",
            params![id, parent_id, name, order],
        )?;
        self.groups.push(Group {
            id: id.clone(),
            parent_id,
            name,
            order,
        });
        self.sort();
        Ok(id)
    }

    pub fn update(
        &mut self,
        id: &str,
        name: &str,
        parent_id: Option<String>,
        order: u32,
        expected: u64,
    ) -> Result<()> {
        self.check_revision(expected)?;
        ensure!(self.contains(id), "Group does not exist.");
        let name = validate_edit(&self.groups, id, parent_id.as_deref(), name, order)?;
        self.mutate(
            "UPDATE groups SET parent_id=?2,name=?3,sort_order=?4 WHERE id=?1",
            params![id, parent_id, name, order],
        )?;
        let group = self.groups.iter_mut().find(|group| group.id == id).unwrap();
        group.parent_id = parent_id;
        group.name = name;
        group.order = order;
        self.sort();
        Ok(())
    }

    pub fn delete(&mut self, id: &str, expected: u64) -> Result<()> {
        self.check_revision(expected)?;
        ensure!(self.contains(id), "Group does not exist.");
        ensure!(
            !self
                .groups
                .iter()
                .any(|group| group.parent_id.as_deref() == Some(id)),
            "Group contains subgroups. Move or remove them first."
        );
        self.mutate("DELETE FROM groups WHERE id=?1", params![id])?;
        self.groups.retain(|group| group.id != id);
        Ok(())
    }

    pub fn bump(&mut self, expected: u64) -> Result<()> {
        self.check_revision(expected)?;
        self.mutate("UPDATE metadata SET revision=revision WHERE id=1", [])
    }

    fn sort(&mut self) {
        self.groups
            .sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };

    static QUIET_BUSY_CALLS: AtomicUsize = AtomicUsize::new(0);
    fn refuse_writer_wait(_: i32) -> bool {
        QUIET_BUSY_CALLS.fetch_add(1, Ordering::SeqCst);
        false
    }

    struct ClaimBarrier {
        observed: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
    }
    static CLAIM_BARRIER: Mutex<Option<ClaimBarrier>> = Mutex::new(None);
    fn wait_for_competing_cancellation(_: i32) -> bool {
        let barrier = CLAIM_BARRIER.lock().unwrap().take().unwrap();
        barrier.observed.send(()).unwrap();
        barrier.release.recv_timeout(Duration::from_secs(2)).is_ok()
    }

    #[test]
    fn a_quiet_schedule_tick_reads_through_a_wal_writer_without_waiting_or_writing() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-quiet-scheduler-{}.sqlite3",
            hex::encode(crate::wire::random::<12>())
        ));
        let mut store = MetadataStore::open(&path).unwrap();
        store
            .connection
            .execute_batch("PRAGMA journal_mode=WAL;")
            .unwrap();
        let future = store
            .add_schedule(
                &crate::jobs::LaunchSpec::default(),
                chrono::Utc::now().timestamp() + 3600,
            )
            .unwrap();
        store
            .connection
            .busy_handler(Some(refuse_writer_wait))
            .unwrap();
        let before = store.connection.total_changes();
        let mut competing = Connection::open(&path).unwrap();
        let writer = competing
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        QUIET_BUSY_CALLS.store(0, Ordering::SeqCst);
        assert!(store.claim_schedule().unwrap().is_none());
        assert_eq!(QUIET_BUSY_CALLS.load(Ordering::SeqCst), 0);
        assert_eq!(store.connection.total_changes(), before);
        assert!(
            store
                .schedules()
                .unwrap()
                .iter()
                .any(|row| row["id"] == future && row["state"] == "pending")
        );
        // Positive control: the other writer is still live and this handler
        // would detect any attempted writer reservation on the idle path.
        assert!(
            store
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .is_err()
        );
        assert_eq!(QUIET_BUSY_CALLS.load(Ordering::SeqCst), 1);
        writer.rollback().unwrap();
        drop(competing);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_due_preflight_cannot_claim_a_schedule_canceled_before_writer_reservation() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-scheduler-cancel-{}.sqlite3",
            hex::encode(crate::wire::random::<12>())
        ));
        let mut store = MetadataStore::open(&path).unwrap();
        store
            .connection
            .execute_batch("PRAGMA journal_mode=WAL;")
            .unwrap();
        let id = store
            .add_schedule(
                &crate::jobs::LaunchSpec::default(),
                chrono::Utc::now().timestamp(),
            )
            .unwrap();
        store
            .connection
            .busy_handler(Some(wait_for_competing_cancellation))
            .unwrap();
        let mut competing = Connection::open(&path).unwrap();
        let writer = competing
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        writer
            .execute("UPDATE schedules SET state='cancelled' WHERE id=?1", [&id])
            .unwrap();
        let (observed, blocked) = mpsc::sync_channel(1);
        let (release, resumed) = mpsc::channel();
        *CLAIM_BARRIER.lock().unwrap() = Some(ClaimBarrier {
            observed,
            release: resumed,
        });
        let pending = std::thread::spawn(move || {
            store
                .claim_schedule()
                .map(|claimed| claimed.map(|(id, _)| id))
        });
        // WAL preflight sees the earlier pending state. Only writer reservation
        // waits, allowing the competing cancellation to commit before recheck.
        let reservation = blocked.recv_timeout(Duration::from_secs(2));
        writer.commit().unwrap();
        let _ = release.send(());
        let claimed = pending.join().unwrap();
        *CLAIM_BARRIER.lock().unwrap() = None;
        assert!(
            reservation.is_ok(),
            "Expected a controlled writer reservation wait: {claimed:?}"
        );
        assert!(claimed.unwrap().is_none());
        assert_eq!(
            competing
                .query_row("SELECT state FROM schedules WHERE id=?1", [&id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "cancelled"
        );
        drop(competing);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn groups_persist_with_revisions_and_rejected_edits_do_not_mutate() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-metadata-{}.sqlite3",
            hex::encode(crate::wire::random::<16>())
        ));
        let root;
        {
            let mut store = MetadataStore::open(&path).unwrap();
            root = store.create("Work", None, 0, 0).unwrap();
            let child = store.create("Child", Some(root.clone()), 1, 1).unwrap();
            assert!(
                store
                    .update(&root, "Cycle", Some(child.clone()), 0, 2)
                    .is_err()
            );
            assert!(store.delete(&root, 2).is_err());
            assert!(
                store
                    .create("Stale", None, 0, 0)
                    .unwrap_err()
                    .is::<RevisionConflict>()
            );
            assert_eq!(store.revision(), 2);
            store.delete(&child, 2).unwrap();
            store.update(&root, "Renamed", None, 2, 3).unwrap();
        }
        {
            let store = MetadataStore::open(&path).unwrap();
            assert_eq!(store.revision(), 4);
            assert_eq!(
                store.groups(),
                &[Group {
                    id: root,
                    parent_id: None,
                    name: "Renamed".into(),
                    order: 2
                }]
            );
        }
        std::fs::remove_file(path).unwrap();
    }
}
