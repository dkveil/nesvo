//! Job dispatch reuses durable workflow admission and native receipt guards.
use crate::{
    caller::Authority,
    event_log::Service,
    job_definitions::{Claim, Reply, Work},
    orchestration::{Actor, Request, Scope},
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Clone)]
struct Runner {
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
}
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
impl Runner {
    async fn workflow(&self, request: Value) -> Result<Value> {
        self.log
            .workflow(owner(), serde_json::from_value::<Request>(request)?)
            .await
    }
    async fn dispatch(&self, claim: Claim) -> Result<()> {
        match self
            .log
            .jobs(Work::BeginPrecheck {
                occurrence: claim.id.clone(),
            })
            .await?
        {
            Reply::Precheck(Some(command)) => {
                let result = crate::job_precheck_adapter::run(*command).await;
                if !matches!(
                    self.log
                        .jobs(Work::FinishPrecheck {
                            occurrence: claim.id.clone(),
                            result
                        })
                        .await?,
                    Reply::PrecheckPassed(true)
                ) {
                    return Ok(());
                }
            }
            Reply::Precheck(None) => {}
            Reply::PrecheckPassed(false) => return Ok(()),
            _ => return Err(anyhow!("Precheck admission was not confirmed")),
        }
        let mut native_requested = false;
        let prefix = format!("job:{}:{}", claim.job_id, claim.id);
        let result=async {
            let run=self.workflow(json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":claim.spec.title,"goal":claim.spec.instruction}})).await?;
            let run_id=run["run"]["id"].as_str().ok_or_else(||anyhow!("Job run identity was not confirmed"))?;
            self.log.jobs(Work::BindRun{occurrence:claim.id.clone(),run:run_id.into()}).await?;
            let plan=self.workflow(json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run_id,"expectedRevision":run["run"]["revision"],"tasks":[{"key":"job","title":claim.spec.title,"instruction":claim.spec.instruction}]})).await?;
            let limits=self.workflow(json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run_id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":claim.spec.max_elapsed_ms}}})).await?;
            let active=self.workflow(json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run_id,"expectedRevision":limits["run"]["revision"]})).await?;
            let request=serde_json::from_value(json!({"action":"start","key":format!("{prefix}:executor"),"runId":run_id,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}],"retryFailed":false}}))?;
            native_requested=true;
            crate::workflow_executor_runtime::execute(self.state.clone(),self.events.clone(),self.log.clone(),owner(),Authority::Owner,request).await?;
            self.log.jobs(Work::Started{occurrence:claim.id.clone()}).await?;
            Ok::<_,anyhow::Error>(())
        }.await;
        if result.is_err() {
            // Never retry an unknown native effect or guess a replacement run.
            // The occurrence prefix recovers each immutable metadata acceptance.
            self.log
                .jobs(Work::Refused {
                    occurrence: claim.id,
                    uncertain: native_requested,
                })
                .await?;
        }
        result
    }
}
pub async fn run(state: Arc<Mutex<State>>, events: mpsc::Sender<PtyEvent>, log: Service) {
    let runner = Runner { state, events, log };
    let mut delay = 1;
    let mut dispatches = tokio::task::JoinSet::new();
    let mut calendars = tokio::task::JoinSet::new();
    let mut pending_calendars = std::collections::BTreeSet::new();
    loop {
        while dispatches.try_join_next().is_some() {}
        while let Some(result) = calendars.try_join_next() {
            if let Ok(key) = result {
                pending_calendars.remove(&key);
            }
        }
        let checking = match runner.state.lock() {
            Ok(state) => state.provider_probes_pending(),
            Err(_) => return,
        };
        if checking {
            // Bounded host version probes precede admission. A persisted due
            // job must not interpret transient discovery as unsupported CLI.
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        if let Ok(Reply::Calendars(due)) = runner.log.jobs(Work::CalendarDue).await {
            for item in due {
                if calendars.len() >= 2 {
                    break;
                }
                let key = (item.id.clone(), item.revision, item.due);
                if !pending_calendars.insert(key.clone()) {
                    continue;
                }
                let log = runner.log.clone();
                calendars.spawn(async move {
                    let evaluated_at = crate::status::now_millis();
                    let answer = std::panic::AssertUnwindSafe(crate::job_calendar_adapter::next(
                        item.schedule,
                        evaluated_at,
                    ))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(crate::job_calendar::Failure::new(
                            "calendar_unavailable",
                            "Calendar adapter was interrupted",
                        ))
                    });
                    // A busy slot leaves original due intent for a later tick.
                    if !answer
                        .as_ref()
                        .err()
                        .is_some_and(|e| e.code == "calendar_busy")
                    {
                        let _ = log
                            .jobs(Work::AdvanceCalendar {
                                id: item.id,
                                revision: item.revision,
                                due: item.due,
                                evaluated_at,
                                answer,
                            })
                            .await;
                    }
                    key
                });
            }
        }
        match runner
            .log
            .jobs(Work::Poll {
                slots: 4u8.saturating_sub(dispatches.len() as u8),
            })
            .await
        {
            Ok(Reply::Claims(claims)) => {
                delay = 1;
                for claim in claims {
                    // At most four durable claims per tick. The executor owns
                    // bounded provider readiness/input; no model heartbeat.
                    let runner = runner.clone();
                    dispatches.spawn(async move {
                        let occurrence = claim.id.clone();
                        let result = std::panic::AssertUnwindSafe(runner.dispatch(claim))
                            .catch_unwind()
                            .await;
                        if !matches!(result, Ok(Ok(()))) {
                            let _ = runner.log.jobs(Work::Interrupted { occurrence }).await;
                        }
                    });
                }
            }
            _ => {
                delay = (delay * 2).min(30);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
    }
}
