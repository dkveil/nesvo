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
        let candidate = json!({"id":"00000000000000000000000000000000","name":name,"spec":spec});
        let mut existing = self.templates()?;
        existing.push(candidate);
        ensure!(
            serde_json::to_vec(&existing)?.len() <= 48 * 1024,
            "Template storage is full (48 KiB). Shorten a prompt or delete a template."
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
        spec.resume_picker = false;
        self.connection.execute("INSERT INTO recovery(id,spec,state) VALUES(?1,?2,'saved') ON CONFLICT(id) DO UPDATE SET spec=excluded.spec", params![id, serde_json::to_string(&spec)?])?;
        Ok(())
    }
    pub fn recoveries(&self) -> Result<Vec<Value>> {
        let mut query = self
            .connection
            .prepare("SELECT id,spec,state FROM recovery ORDER BY rowid DESC")?;
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
            parent_session_id: Some("parent-process".into()),
            model: Some("opus".into()),
            effort: Some("low".into()),
            worktree: true,
            ..Default::default()
        };
        store.save_template("Review", &spec).unwrap();
        assert_eq!(store.templates().unwrap()[0]["spec"]["prompt"], "Do work");
        store.save_recovery("old", &spec).unwrap();
        let restored = store.claim_recovery("old").unwrap();
        assert_eq!(restored.model.as_deref(), Some("opus"));
        assert_eq!(restored.effort.as_deref(), Some("low"));
        assert!(restored.prompt.is_empty() && !restored.worktree);
        assert_eq!(
            restored.parent_session_id.as_deref(),
            Some("parent-process")
        );
        assert!(store.claim_recovery("old").is_err());
        store.finish_recovery("old", true).unwrap();
        assert!(store.recoveries().unwrap().is_empty());
    }
    #[test]
    fn recovery_keeps_the_conversation_identity_across_a_store_reopen() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-recovery-{}.sqlite",
            hex::encode(crate::wire::random::<8>())
        ));
        let target = crate::resume::Target {
            provider: crate::launchers::Program::Claude,
            conversation_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
        };
        {
            let store = MetadataStore::open(&path).unwrap();
            store
                .save_recovery(
                    "old",
                    &LaunchSpec {
                        name: "Resumable".into(),
                        program: crate::launchers::Program::Claude,
                        ..Default::default()
                    },
                )
                .unwrap();
            store
                .save_recovery(
                    "old",
                    &LaunchSpec {
                        name: "Resumable".into(),
                        program: crate::launchers::Program::Claude,
                        prompt: "never stored".into(),
                        resume: Some(target.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let store = MetadataStore::open(&path).unwrap();
        let listed = store.recoveries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0]["spec"]["resume"],
            json!({"provider":"claude","conversationId":"0f8fad5b-d9cb-469f-a165-70867728950e"})
        );
        let restored = store.claim_recovery("old").unwrap();
        assert_eq!(restored.resume, Some(target));
        assert!(restored.prompt.is_empty());
        store.finish_recovery("old", false).unwrap();
        assert_eq!(store.recoveries().unwrap()[0]["state"], "saved");
        drop(store);
        let _ = std::fs::remove_file(&path);
    }
    #[test]
    fn templates_cannot_overflow_a_wire_frame() {
        let store = MetadataStore::open(std::path::Path::new(":memory:")).unwrap();
        let spec = LaunchSpec {
            prompt: "x".repeat(8192),
            ..Default::default()
        };
        for _ in 0..5 {
            store.save_template("recipe", &spec).unwrap();
        }
        assert!(store.save_template("overflow", &spec).is_err());
        assert!(
            serde_json::to_vec(&store.templates().unwrap())
                .unwrap()
                .len()
                < 48 * 1024
        );
    }
}
