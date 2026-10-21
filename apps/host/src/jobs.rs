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
    pub child_allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::claude_statusline::deserialize_options"
    )]
    pub claude_quota_capture: Option<crate::claude_statusline::Options>,
    #[serde(skip)]
    pub(crate) claude_quota_prepared: Option<crate::claude_statusline::Prepared>,
    // Set only by owner-validated task preparation; scoped input cannot supply it.
    #[serde(skip)]
    pub(crate) claude_quota_owner_selected: bool,
    #[serde(default)]
    pub program: Program,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub(crate) worktree_setup: Option<crate::worktrees::SetupFact>,
    #[serde(default)]
    pub auto_title: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub resume_picker: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<crate::resume::Target>,
    // Internal admission context is never accepted from serialized launch input.
    #[serde(skip)]
    pub(crate) quota_launch: Option<crate::quota_contexts::LaunchContext>,
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
        let cwd = match cwd {
            Some(cwd) => crate::claude_statusline::prepare(&mut spec)
                .await
                .map(|()| cwd),
            None => Err(anyhow::anyhow!(
                "Launch no longer valid: check folder, group, installed program and session capacity."
            )),
        };
        let session_id = hex::encode(crate::wire::random::<16>());
        let result = match cwd {
            Ok(cwd) => {
                if spec.worktree {
                    let log = state.lock().ok().and_then(|state| state.event_log().ok());
                    crate::worktrees::derive(&cwd, &session_id, log, &mut spec).await
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(error),
        };
        if let Ok(mut state) = state.lock() {
            let result =
                result.and_then(|()| state.launch_reserved(&spec, &events, &session_id, None));
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
            serde_json::to_value(&child).unwrap()["parentSessionId"],
            "parent"
        );
        let resumed = LaunchSpec {
            resume: Some(crate::resume::Target {
                provider: Program::Claude,
                conversation_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            }),
            ..child
        };
        assert_eq!(
            serde_json::to_value(&resumed).unwrap()["resume"],
            serde_json::json!({"provider":"claude","conversationId":"0f8fad5b-d9cb-469f-a165-70867728950e"})
        );
    }
    #[test]
    fn worktree_setup_evidence_is_host_written_and_never_changes_legacy_fingerprints() {
        let mut supplied = serde_json::json!({"name":"Worktree","cwd":null,"groupId":null,"program":"shell","prompt":"","worktree":true,"autoTitle":false,"muted":false,"resumePicker":false});
        let legacy = supplied.clone();
        supplied["worktreeSetup"] =
            serde_json::json!({"digest":"forged","result":"passed","log":"forged"});
        let spec: LaunchSpec = serde_json::from_value(supplied).unwrap();
        assert!(spec.worktree_setup.is_none());
        assert_eq!(serde_json::to_value(&spec).unwrap(), legacy);
        let prepared = LaunchSpec {
            worktree_setup: Some(crate::worktrees::SetupFact {
                digest: "d".repeat(64),
                result: "passed",
                log: "setup.log".into(),
            }),
            ..spec
        };
        assert_eq!(
            serde_json::to_value(prepared).unwrap()["worktreeSetup"],
            serde_json::json!({"digest":"d".repeat(64),"result":"passed","log":"setup.log"})
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
