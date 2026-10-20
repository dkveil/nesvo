//! Durable one-shot launches. A claimed job is never retried automatically.
use crate::{
    launchers::Program,
    sessions::{PtyEvent, State},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub name: String,
    pub cwd: Option<String>,
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "crate::caller::Role::is_worker")]
    pub role: crate::caller::Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub program: Program,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub auto_title: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub resume_picker: bool,
}

pub fn timestamp(input: &str) -> Result<i64> {
    let now = chrono::Local::now();
    let at = if input.len() == 5 {
        let time = chrono::NaiveTime::parse_from_str(input, "%H:%M")?;
        now.date_naive()
            .and_time(time)
            .and_local_timezone(chrono::Local)
            .single()
            .ok_or_else(|| anyhow::anyhow!("Ambiguous local time; use RFC3339 with an offset."))?
            .timestamp()
    } else {
        chrono::DateTime::parse_from_rfc3339(input)?.timestamp()
    };
    ensure!(
        at > now.timestamp(),
        "Start time must be in the future (host local time). Use RFC3339 for another date."
    );
    ensure!(
        at - now.timestamp() <= 366 * 86400,
        "Schedule up to one year ahead."
    );
    Ok(at)
}

pub async fn run(state: Arc<Mutex<State>>, events: mpsc::Sender<PtyEvent>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        interval.tick().await;
        let job = match state.lock() {
            Ok(mut state) => state.claim_job(),
            Err(_) => return,
        };
        let Some((id, mut spec)) = job else {
            continue;
        };
        let cwd = state
            .lock()
            .ok()
            .and_then(|state| state.validate_launch(&spec).ok());
        let result = match cwd {
            Some(cwd) => {
                if spec.worktree {
                    match crate::git::create_worktree(&cwd).await {
                        Ok(path) => {
                            spec.cwd = Some(crate::process::display_path(&path));
                            spec.worktree = false;
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    Ok(())
                }
            }
            None => Err(anyhow::anyhow!(
                "Launch no longer valid: check folder, group, installed program and session capacity."
            )),
        };
        if let Ok(mut state) = state.lock() {
            let result = result.and_then(|()| state.launch(&spec, &events));
            state.finish_job(&id, result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MetadataStore;
    #[test]
    fn additive_lineage_keeps_legacy_launch_fingerprints_identical() {
        let legacy = serde_json::json!({"name":"Existing receipt","cwd":null,"groupId":null,"program":"shell","prompt":"","worktree":false,"autoTitle":false,"muted":false,"resumePicker":false});
        let spec: LaunchSpec = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&spec).unwrap(),
            legacy,
            "new default metadata must not invalidate stored idempotency keys"
        );
        let child = LaunchSpec {
            parent_session_id: Some("parent".into()),
            ..spec
        };
        assert_eq!(
            serde_json::to_value(child).unwrap()["parentSessionId"],
            "parent"
        );
    }
    #[test]
    fn schedules_survive_reopen_and_claimed_jobs_never_run_twice() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-jobs-{}.sqlite",
            hex::encode(crate::wire::random::<8>())
        ));
        let spec = LaunchSpec {
            name: "Scheduled review".into(),
            prompt: "Review changes".into(),
            program: Program::Claude,
            ..Default::default()
        };
        let now = chrono::Utc::now().timestamp();
        let id;
        {
            let store = MetadataStore::open(&path).unwrap();
            id = store.add_schedule(&spec, now).unwrap();
            store.add_schedule(&spec, now - 120).unwrap();
        }
        {
            let mut store = MetadataStore::open(&path).unwrap();
            let (claimed, launch) = store.claim_schedule().unwrap().unwrap();
            assert_eq!(claimed, id);
            assert_eq!(launch.prompt, spec.prompt);
            assert!(store.claim_schedule().unwrap().is_none());
            assert!(
                store
                    .schedules()
                    .unwrap()
                    .iter()
                    .any(|job| job["state"] == "missed")
            );
        }
        {
            let mut store = MetadataStore::open(&path).unwrap();
            assert!(store.claim_schedule().unwrap().is_none());
            assert!(
                store
                    .schedules()
                    .unwrap()
                    .iter()
                    .any(|job| job["id"] == id && job["state"] == "interrupted")
            );
            let id = store.add_schedule(&spec, now + 60).unwrap();
            store.cancel_schedule(&id).unwrap();
            assert!(store.cancel_schedule(&id).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn scheduling_rejects_past_times_and_accepts_offset_dates() {
        assert!(timestamp("2000-01-01T00:00:00Z").is_err());
        assert!(timestamp("25:99").is_err());
        let future = chrono::Utc::now() + chrono::Duration::minutes(3);
        assert_eq!(timestamp(&future.to_rfc3339()).unwrap(), future.timestamp());
    }
}
