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
        let transaction = self.connection.transaction()?;
        let now = chrono::Utc::now().timestamp();
        transaction.execute("UPDATE schedules SET state='missed',result='Host was unavailable at the scheduled time.' WHERE state='pending' AND due < ?1", [now - 60])?;
        let job: Option<(String,String)> = transaction.query_row("SELECT id,spec FROM schedules WHERE state='pending' AND due<=?1 ORDER BY due LIMIT 1", [now], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let job = job
            .map(|(id, spec)| -> Result<_> { Ok((id, serde_json::from_str(&spec)?)) })
            .transpose()?;
        if let Some((id, _)) = &job {
            transaction.execute("UPDATE schedules SET state='starting' WHERE id=?1", [id])?;
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
        let connection = Connection::open(path).context("Could not open metadata database")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL);
            UPDATE recovery SET state='interrupted' WHERE state='starting';
            CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, due INTEGER NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
            UPDATE schedules SET state='interrupted', result='Host stopped during launch; inspect sessions before scheduling again.' WHERE state='starting';
            CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO metadata(id,revision) VALUES(1,0);
            CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES groups(id), name TEXT NOT NULL, sort_order INTEGER NOT NULL);")?;
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
        Ok(Self {
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
