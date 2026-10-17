//! Persisted launch descriptions; restoring never replays an old prompt.
use crate::{jobs::LaunchSpec, storage::MetadataStore};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde_json::{Value, json};

impl MetadataStore {
    pub fn save_template(&self, name: &str, spec: &LaunchSpec) -> Result<()> {
        let name = crate::groups::valid_name(name)?;
        let count: i64 = self
            .connection
            .query_row("SELECT count(*) FROM templates", [], |r| r.get(0))?;
        ensure!(count < 32, "Maximum 32 templates. Delete one first.");
        ensure!(
            spec.prompt.len() <= 8192 && !spec.prompt.contains('\0'),
            "Invalid prompt"
        );
        self.connection.execute(
            "INSERT INTO templates(id,name,spec) VALUES(?1,?2,?3)",
            params![
                hex::encode(crate::wire::random::<16>()),
                name,
                serde_json::to_string(spec)?
            ],
        )?;
        Ok(())
    }
    pub fn templates(&self) -> Result<Vec<Value>> {
        let mut query = self
            .connection
            .prepare("SELECT id,name,spec FROM templates ORDER BY name,id LIMIT 32")?;
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .map(|row| {
                let (id, name, spec) = row?;
                let spec: LaunchSpec = serde_json::from_str(&spec)?;
                Ok(json!({"id":id,"name":name,"spec":spec}))
            })
            .collect()
    }
    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM templates WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn save_recovery(&self, id: &str, spec: &LaunchSpec) -> Result<()> {
        let mut spec = spec.clone();
        spec.prompt.clear();
        spec.worktree = false;
        self.connection.execute("INSERT INTO recovery(id,spec,state) VALUES(?1,?2,'saved') ON CONFLICT(id) DO UPDATE SET spec=excluded.spec", params![id, serde_json::to_string(&spec)?])?;
        Ok(())
    }
    pub fn recoveries(&self) -> Result<Vec<Value>> {
        let mut query = self
            .connection
            .prepare("SELECT id,spec,state FROM recovery ORDER BY rowid DESC LIMIT 128")?;
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .map(|row| {
                let (id, spec, state) = row?;
                let spec: LaunchSpec = serde_json::from_str(&spec)?;
                Ok(json!({"id":id,"spec":spec,"state":state}))
            })
            .collect()
    }
    pub fn claim_recovery(&self, id: &str) -> Result<LaunchSpec> {
        let spec: String = self.connection.query_row(
            "SELECT spec FROM recovery WHERE id=?1 AND state='saved'",
            [id],
            |row| row.get(0),
        )?;
        self.connection
            .execute("UPDATE recovery SET state='starting' WHERE id=?1", [id])?;
        Ok(serde_json::from_str(&spec)?)
    }
    pub fn finish_recovery(&self, id: &str, success: bool) -> Result<()> {
        self.connection.execute(
            if success {
                "DELETE FROM recovery WHERE id=?1"
            } else {
                "UPDATE recovery SET state='saved' WHERE id=?1"
            },
            [id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_never_replays_prompts_or_creates_another_worktree() {
        let store = MetadataStore::open(std::path::Path::new(":memory:")).unwrap();
        let spec = LaunchSpec {
            name: "Review".into(),
            prompt: "Do work".into(),
            worktree: true,
            ..Default::default()
        };
        store.save_template("Review", &spec).unwrap();
        assert_eq!(store.templates().unwrap()[0]["spec"]["prompt"], "Do work");
        store.save_recovery("old", &spec).unwrap();
        let restored = store.claim_recovery("old").unwrap();
        assert!(restored.prompt.is_empty() && !restored.worktree);
        assert!(store.claim_recovery("old").is_err());
        store.finish_recovery("old", true).unwrap();
        assert!(store.recoveries().unwrap().is_empty());
    }
}
