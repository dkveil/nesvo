use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::{Actor, Request as Workflow},
    sessions::State,
    workflow_wakes::{Guard, Policy, Reply, Request, Work},
};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub async fn execute(
    state: Arc<Mutex<State>>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
) -> Result<Value> {
    let (before, controlled) = {
        let state = state.lock().unwrap();
        (
            state.human_control_epoch(),
            state.human_controlled_sessions(),
        )
    };
    let Reply::Managed { view, pump } = log
        .wakes(Work::Manage {
            actor: actor.clone(),
            request,
        })
        .await?
    else {
        return Err(anyhow!("Unexpected wake management reply"));
    };
    if let Some(guard) = pump {
        let coordinator = view["wakePolicy"]["coordinator"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing wake coordinator"))?
            .to_owned();
        let was_controlled = controlled.contains(&coordinator);
        tokio::spawn(async move {
            let runner = Runner {
                state,
                log,
                actor,
                source: authority,
                guard,
                before,
            };
            let result = async {
                if was_controlled {
                    runner.note("paused", "control_busy", true).await?;
                    return Ok(());
                }
                runner.seed().await?;
                runner.run().await
            }
            .await;
            if let Err(error) = result {
                let code = error
                    .downcast_ref::<crate::api_error::Error>()
                    .map(|e| e.code)
                    .unwrap_or("wake_unavailable");
                let _ = runner.note("paused", code, true).await;
            }
        });
    }
    Ok(view)
}
struct Runner {
    state: Arc<Mutex<State>>,
    log: Service,
    actor: Actor,
    source: Authority,
    guard: Guard,
    before: u64,
}
impl Runner {
    async fn note(&self, phase: &'static str, reason: &str, disable: bool) -> Result<()> {
        self.log
            .wakes(Work::Note {
                guard: self.guard.clone(),
                issuer: self.actor.issuer.clone(),
                phase,
                reason: Some(reason.into()),
                disable,
            })
            .await?;
        Ok(())
    }
    async fn seed(&self) -> Result<()> {
        let Reply::Snapshot(Some(snapshot)) = self
            .log
            .wakes(Work::Poll {
                guard: self.guard.clone(),
                issuer: self.actor.issuer.clone(),
            })
            .await?
        else {
            return Ok(());
        };
        let run = self
            .log
            .workflow(
                self.actor.clone(),
                Workflow::Get {
                    run_id: snapshot.policy.run_id,
                },
            )
            .await?;
        let ids = run["tasks"]
            .as_array()
            .ok_or_else(|| anyhow!("Missing wake run tasks"))?
            .iter()
            .filter_map(|task| {
                task["currentAttempt"]["sessionId"]
                    .as_str()
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        let events = {
            let state = self.state.lock().unwrap();
            state.wake_authority(&self.source, &snapshot.policy.coordinator)?;
            state.wake_attention_events(&ids)
        };
        if !events.is_empty() {
            self.log.append(events).await?;
        }
        Ok(())
    }
    async fn run(&self) -> Result<()> {
        let mut changed = self.log.subscribe();
        loop {
            let Reply::Snapshot(Some(snapshot)) = self
                .log
                .wakes(Work::Poll {
                    guard: self.guard.clone(),
                    issuer: self.actor.issuer.clone(),
                })
                .await?
            else {
                return Ok(());
            };
            self.state.lock().unwrap().check_wake_priority(
                &self.source,
                &snapshot.policy.coordinator,
                self.before,
            )?;
            if matches!(snapshot.run_state.as_str(), "succeeded" | "canceled") {
                self.note("completed", "run_terminal", true).await?;
                return Ok(());
            }
            if !matches!(snapshot.run_state.as_str(), "active" | "draining") {
                self.note("paused", "run_not_active", true).await?;
                return Ok(());
            }
            if snapshot.time_exhausted {
                self.note("paused", "time_budget_exhausted", true).await?;
                return Ok(());
            }
            let result = if snapshot.active_batch {
                self.note("waiting", "wake_settlement_pending", false)
                    .await
                    .map(|_| false)
            } else if snapshot.pending == 0 {
                self.note("waiting", "no_new_notices", false)
                    .await
                    .map(|_| false)
            } else if snapshot
                .first_at
                .is_some_and(|at| crate::status::now_millis() < at.saturating_add(250))
            {
                self.note("waiting", "coalescing", false)
                    .await
                    .map(|_| false)
            } else {
                self.dispatch(&snapshot.policy).await
            };
            match result {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    let code = error
                        .downcast_ref::<crate::api_error::Error>()
                        .map(|e| e.code)
                        .unwrap_or("wake_unavailable");
                    if matches!(
                        code,
                        "agent_not_ready"
                            | "submission_pending"
                            | "lifecycle_pending"
                            | "busy"
                            | "revision_conflict"
                    ) {
                        self.note("waiting", code, false).await?;
                    } else if code == "wake_paused" {
                        return Ok(());
                    } else {
                        self.note("paused", code, true).await?;
                        return Ok(());
                    }
                }
            }
            changed.borrow_and_update();
            tokio::select! {
                _=tokio::time::sleep(std::time::Duration::from_millis(if snapshot.pending>0&&!snapshot.active_batch{250}else{1000}))=>{},
                result=changed.changed()=>{if result.is_err(){return Ok(());}tokio::time::sleep(std::time::Duration::from_millis(50)).await;},
            }
        }
    }
    async fn dispatch(&self, policy: &Policy) -> Result<bool> {
        let (authority, _permit) = {
            let mut state = self.state.lock().unwrap();
            let authority = state.wake_authority(&self.source, &policy.coordinator)?;
            state.check_task_delivery(&policy.coordinator, &authority, self.before)?;
            (authority, state.native_run_permit(&policy.run_id)?)
        };
        let Reply::Claimed(dispatch) = self
            .log
            .wakes(Work::Claim {
                guard: self.guard.clone(),
                issuer: self.actor.issuer.clone(),
            })
            .await?
        else {
            return Err(anyhow!("Unexpected native wake claim reply"));
        };
        let Some(dispatch) = dispatch else {
            return Ok(false);
        };
        let result = crate::operations::dispatch_send(
            self.state.clone(),
            self.log.clone(),
            self.actor.issuer.clone(),
            dispatch.receipt,
            dispatch.prompt,
            authority,
            Some(self.before),
        )
        .await;
        self.log
            .wakes(Work::Finish {
                batch_id: dispatch.batch_id,
            })
            .await?;
        result?;
        Ok(true)
    }
}
