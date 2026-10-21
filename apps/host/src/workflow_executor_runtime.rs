//! Deterministic scheduling of explicit task profiles; never an LLM heartbeat.
use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::{Actor, Request as Workflow},
    sessions::{PtyEvent, State},
    workflow_executor::{Guard, Reply, Request, Snapshot, Work},
};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

struct Runner {
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    actor: Actor,
    authority: Authority,
    guard: Guard,
    before: u64,
}
fn priority(reason: &str) -> u8 {
    match reason {
        "human_or_authority_pause" => 10,
        "input_unknown" | "launch_unconfirmed" | "decision_unresolved" => 9,
        "decision_pending" | "instruction_not_sent" => 8,
        "retry_requires_intent" | "retry_budget_exhausted" => 7,
        "validation_pending" => 5,
        "manual_attempt" => 4,
        "worker_result_pending" => 3,
        "parallel_budget_exhausted" => 2,
        "retry_cooldown" => 1,
        _ => 0,
    }
}
fn select_blocker<'a>(
    current: &mut (&'static str, Option<&'a str>),
    reason: &'static str,
    task: &'a str,
) {
    if priority(reason) > priority(current.0) {
        *current = (reason, Some(task));
    }
}
pub async fn execute(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
) -> Result<Value> {
    let before = state.lock().unwrap().human_control_epoch();
    let Reply::Managed { view, pump } = log
        .executor(Work::Manage {
            actor: actor.clone(),
            request,
        })
        .await?
    else {
        return Err(anyhow!("Unexpected executor management reply"));
    };
    if let Some(guard) = pump {
        tokio::spawn(async move {
            let runner = Runner {
                state,
                events,
                log,
                actor,
                authority,
                guard,
                before,
            };
            if runner.run().await.is_err() {
                let _ = runner
                    .note("paused", Some("executor_unavailable"), None, true)
                    .await;
            }
        });
    }
    Ok(view)
}
impl Runner {
    async fn note(
        &self,
        phase: &'static str,
        reason: Option<&str>,
        task: Option<&str>,
        disable: bool,
    ) -> Result<()> {
        self.log
            .executor(Work::Note {
                guard: self.guard.clone(),
                issuer: self.actor.issuer.clone(),
                phase,
                reason: reason.map(str::to_owned),
                task_id: task.map(str::to_owned),
                disable,
            })
            .await?;
        Ok(())
    }
    async fn run(&self) -> Result<()> {
        let mut changed = self.log.subscribe();
        loop {
            let Reply::Snapshot(Some(snapshot)) = self
                .log
                .executor(Work::Poll {
                    guard: self.guard.clone(),
                    issuer: self.actor.issuer.clone(),
                })
                .await?
            else {
                return Ok(());
            };
            match self.step(&snapshot).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    let code = error
                        .downcast_ref::<crate::api_error::Error>()
                        .map(|e| e.code)
                        .unwrap_or("executor_unavailable");
                    if matches!(code, "revision_conflict" | "busy" | "quota_wait") {
                        self.note("waiting", Some(code), None, false).await?;
                    } else if code == "executor_paused" {
                        return Ok(());
                    } else {
                        self.note("paused", Some(code), None, true).await?;
                        return Ok(());
                    }
                }
            }
            // Consume our own coalesced note, then debounce external changes.
            // The timer checks deterministic policy only, never model input.
            changed.borrow_and_update();
            tokio::select! {
                _=tokio::time::sleep(std::time::Duration::from_secs(1))=>{},
                result=changed.changed()=>{if result.is_err(){return Ok(());}tokio::time::sleep(std::time::Duration::from_millis(50)).await;},
            }
        }
    }
    async fn step(&self, snapshot: &Snapshot) -> Result<bool> {
        let engine = &snapshot.executor;
        let current = self
            .log
            .workflow(
                self.actor.clone(),
                Workflow::Get {
                    run_id: engine.run_id.clone(),
                },
            )
            .await?;
        let run = &current["run"];
        let state = run["state"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing executor run state"))?;
        if matches!(state, "succeeded" | "canceled") {
            self.note("completed", Some(state), None, true).await?;
            return Ok(false);
        }
        if state != "active" {
            self.note("blocked", Some("run_not_active"), None, false)
                .await?;
            return Ok(false);
        }
        if run["budget"]["timeState"] == "exhausted" {
            self.note("blocked", Some("time_budget_exhausted"), None, false)
                .await?;
            return Ok(false);
        }
        self.state
            .lock()
            .unwrap()
            .workflow_launch_authority(&self.authority, run["coordinatorSessionId"].as_str())?;
        let tasks = current["tasks"]
            .as_array()
            .ok_or_else(|| anyhow!("Missing executor tasks"))?;
        let mut blocker = ("dependencies_waiting", None);
        for task in tasks {
            let id = task["id"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing executor task identity"))?;
            let phase = task["state"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing task state"))?;
            if phase == "succeeded" {
                continue;
            }
            if phase == "reported" {
                select_blocker(&mut blocker, "validation_pending", id);
                continue;
            }
            if task["dependencyState"] != "ready" {
                continue;
            }
            let ordinal = task["attempts"]
                .as_u64()
                .ok_or_else(|| anyhow!("Missing attempt count"))?;
            let profile = engine
                .spec
                .tasks
                .iter()
                .find(|p| p.task_id == id)
                .ok_or_else(|| anyhow!("Executor task profile missing"))?;
            if phase == "assigned" {
                let attempt = task["currentAttempt"]["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Missing current attempt"))?;
                if !snapshot.owned.contains(attempt) {
                    select_blocker(&mut blocker, "manual_attempt", id);
                    continue;
                }
                let history = self
                    .log
                    .workflow(
                        self.actor.clone(),
                        Workflow::Task {
                            run_id: engine.run_id.clone(),
                            task_id: id.into(),
                            offset: Some((ordinal.saturating_sub(1) / 4 * 4) as usize),
                        },
                    )
                    .await?;
                let full = history["attempts"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|a| a["id"] == attempt))
                    .ok_or_else(|| anyhow!("Current attempt history unavailable"))?;
                if full["decisionGate"]["unresolved"]
                    .as_u64()
                    .is_some_and(|count| count > 0)
                {
                    select_blocker(
                        &mut blocker,
                        if full["decisionGate"]["pending"]
                            .as_u64()
                            .is_some_and(|count| count > 0)
                        {
                            "decision_pending"
                        } else {
                            "decision_unresolved"
                        },
                        id,
                    );
                    continue;
                }
                if full["delivery"].is_null() {
                    let request = crate::workflow_delivery::Request::Queue {
                        key: format!("engine:{}:input:{attempt}", engine.id),
                        run_id: engine.run_id.clone(),
                        task_id: id.into(),
                        expected_revision: history["run"]["revision"]
                            .as_u64()
                            .ok_or_else(|| anyhow!("Missing current revision"))?,
                        timeout_ms: Some(engine.spec.readiness_timeout_ms),
                        session_id: None,
                    };
                    crate::workflow_delivery_runtime::execute_guarded(
                        self.state.clone(),
                        self.log.clone(),
                        self.actor.clone(),
                        self.authority.clone(),
                        request,
                        Some((self.guard.clone(), self.before)),
                    )
                    .await?;
                    return Ok(true);
                }
                select_blocker(
                    &mut blocker,
                    match full["delivery"]["phase"].as_str() {
                        Some("paused") => "human_or_authority_pause",
                        Some("unknown") => "input_unknown",
                        Some("failed" | "expired" | "canceled") => "instruction_not_sent",
                        _ => "worker_result_pending",
                    },
                    id,
                );
                continue;
            }
            if matches!(phase, "launching" | "launchUnknown") {
                select_blocker(&mut blocker, "launch_unconfirmed", id);
                continue;
            }
            let retry = matches!(phase, "failed" | "stopped" | "launchFailed");
            if phase != "planned" && (!retry || !engine.spec.retry_failed) {
                select_blocker(&mut blocker, "retry_requires_intent", id);
                continue;
            }
            let parallel = run["budget"]["activeAttempts"]
                .as_u64()
                .ok_or_else(|| anyhow!("Missing parallel accounting"))?;
            let limit = run["budget"]["limits"]["maxParallel"]
                .as_u64()
                .ok_or_else(|| anyhow!("Missing parallel limit"))?;
            if parallel >= limit {
                select_blocker(&mut blocker, "parallel_budget_exhausted", id);
                continue;
            }
            let attempts = run["budget"]["limits"]["maxAttemptsPerTask"]
                .as_u64()
                .ok_or_else(|| anyhow!("Missing retry limit"))?;
            if ordinal >= attempts {
                select_blocker(&mut blocker, "retry_budget_exhausted", id);
                continue;
            }
            if retry {
                let Reply::RetryReady(ready) = self
                    .log
                    .executor(Work::Retry {
                        guard: self.guard.clone(),
                        issuer: self.actor.issuer.clone(),
                        attempt: task["currentAttempt"]["id"]
                            .as_str()
                            .ok_or_else(|| anyhow!("Missing retry attempt"))?
                            .into(),
                    })
                    .await?
                else {
                    return Err(anyhow!("Unexpected retry admission reply"));
                };
                if !ready {
                    select_blocker(&mut blocker, "retry_cooldown", id);
                    continue;
                }
            }
            let request = crate::workflow_launches::Request {
                key: format!("engine:{}:launch:{id}:{}", engine.id, ordinal + 1),
                run_id: engine.run_id.clone(),
                task_id: id.into(),
                expected_revision: run["revision"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Missing executor run revision"))?,
                profile: profile.profile.clone(),
            };
            crate::workflow_launch_runtime::execute_guarded(
                self.state.clone(),
                self.events.clone(),
                self.log.clone(),
                self.actor.clone(),
                self.authority.clone(),
                request,
                Some(self.guard.clone()),
            )
            .await?;
            return Ok(true);
        }
        self.note(
            if priority(blocker.0) >= 7 {
                "blocked"
            } else {
                "waiting"
            },
            Some(blocker.0),
            blocker.1,
            false,
        )
        .await?;
        Ok(false)
    }
}
