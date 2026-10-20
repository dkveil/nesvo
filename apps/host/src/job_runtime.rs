//! Job dispatch reuses durable workflow admission and native receipt guards.
use crate::{
    caller::Authority,
    event_log::Service,
    job_definitions::{Claim, Reply, Work},
    orchestration::{Actor, Scope},
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// The owned process future must remain polled while the store guard is slow.
/// Guard reads have no native effects and can be dropped on timeout/completion.
async fn supervise_precheck<C, G>(
    check: C,
    stop: tokio::sync::watch::Sender<Option<crate::job_precheck_adapter::Stop>>,
    mut guard: impl FnMut() -> G,
) -> crate::job_prechecks::Outcome
where
    C: std::future::Future<Output = crate::job_prechecks::Outcome>,
    G: std::future::Future<Output = Result<Reply>>,
{
    use crate::job_precheck_adapter::Stop;
    tokio::pin!(check);
    let mut monitor = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        tokio::select! {
            result = &mut check => return result,
            _ = monitor.tick(), if stop.borrow().is_none() => {
                let answer = tokio::select! {
                    result = &mut check => return result,
                    answer = tokio::time::timeout(std::time::Duration::from_secs(1), guard()) => answer,
                };
                let reason = match answer {
                    Ok(Ok(Reply::CancelRequested(false))) => None,
                    Ok(Ok(Reply::CancelRequested(true))) => Some(Stop::OwnerCancel),
                    _ => Some(Stop::GuardUnavailable),
                };
                if let Some(reason) = reason { let _ = stop.send(Some(reason)); }
            }
        }
    }
}

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
    async fn workflow(
        &self,
        dispatch: &crate::job_attempts::Dispatch,
        request: Value,
    ) -> Result<Value> {
        match self
            .log
            .jobs(Work::Prepare {
                dispatch: dispatch.clone(),
                request: serde_json::from_value(request)?,
            })
            .await?
        {
            Reply::Prepared(view) => Ok(view),
            _ => Err(anyhow!("Job metadata preparation was not confirmed")),
        }
    }
    async fn dispatch(&self, claim: Claim) -> Result<()> {
        match self
            .log
            .jobs(Work::BeginPrecheck {
                dispatch: claim.dispatch.clone(),
            })
            .await?
        {
            Reply::Precheck(Some(command)) => {
                let (stop_tx, stop_rx) = tokio::sync::watch::channel(None);
                let check = crate::job_precheck_adapter::run(*command, stop_rx);
                let result = supervise_precheck(check, stop_tx, || {
                    self.log.jobs(Work::CancelRequested {
                        dispatch: claim.dispatch.clone(),
                    })
                })
                .await;
                if !matches!(
                    self.log
                        .jobs(Work::FinishPrecheck {
                            dispatch: claim.dispatch.clone(),
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
            let run=self.workflow(&claim.dispatch,json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":claim.spec.title,"goal":claim.spec.instruction}})).await?;
            let run_id=run["run"]["id"].as_str().ok_or_else(||anyhow!("Job run identity was not confirmed"))?;
            self.log.jobs(Work::BindRun{dispatch:claim.dispatch.clone(),run:run_id.into()}).await?;
            let plan=self.workflow(&claim.dispatch,json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run_id,"expectedRevision":run["run"]["revision"],"tasks":[{"key":"job","title":claim.spec.title,"instruction":claim.spec.instruction}]})).await?;
            let limits=self.workflow(&claim.dispatch,json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run_id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":claim.spec.max_elapsed_ms}}})).await?;
            let active=self.workflow(&claim.dispatch,json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run_id,"expectedRevision":limits["run"]["revision"]})).await?;
            let request=serde_json::from_value(json!({"action":"start","key":format!("{prefix}:executor"),"runId":run_id,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}],"retryFailed":false}}))?;
            native_requested=true;
            crate::workflow_executor_runtime::execute(self.state.clone(),self.events.clone(),self.log.clone(),owner(),Authority::Owner,request).await?;
            self.log.jobs(Work::Started{dispatch:claim.dispatch.clone()}).await?;
            Ok::<_,anyhow::Error>(())
        }.await;
        if result.is_err() {
            // Never retry an unknown native effect or guess a replacement run.
            // The occurrence prefix recovers each immutable metadata acceptance.
            self.log
                .jobs(Work::Refused {
                    dispatch: claim.dispatch.clone(),
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
    let mut cancellations = tokio::task::JoinSet::new();
    let mut pending_calendars = std::collections::BTreeSet::new();
    loop {
        while dispatches.try_join_next().is_some() {}
        while cancellations.try_join_next().is_some() {}
        if let Ok(Reply::Cancellations(claims)) = runner
            .log
            .jobs(Work::CancelPoll {
                slots: 2u8.saturating_sub(cancellations.len() as u8),
            })
            .await
        {
            for claim in claims {
                let runner = runner.clone();
                cancellations.spawn(async move {
                    let result =
                        std::panic::AssertUnwindSafe(crate::workflow_control_runtime::cancel_job(
                            runner.state,
                            runner.log.clone(),
                            claim.issuer.clone(),
                            claim.run.clone(),
                            claim.key.clone(),
                        ))
                        .catch_unwind()
                        .await;
                    let result = match result {
                        Ok(Ok(view)) => Some(view),
                        _ => None,
                    };
                    let _ = runner
                        .log
                        .jobs(Work::CancelFinished { claim, result })
                        .await;
                });
            }
        }
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
                        let dispatch = claim.dispatch.clone();
                        let result = std::panic::AssertUnwindSafe(runner.dispatch(claim))
                            .catch_unwind()
                            .await;
                        if !matches!(result, Ok(Ok(()))) {
                            let _ = runner.log.jobs(Work::Interrupted { dispatch }).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job_prechecks::{Outcome, OutcomeState};

    #[tokio::test]
    async fn slow_store_guard_cannot_suspend_the_owned_check_deadline() {
        let (stop, _receive) = tokio::sync::watch::channel(None);
        let check = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Outcome::failed(OutcomeState::Refused, "check_deadline_observed")
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            supervise_precheck(check, stop, std::future::pending::<Result<Reply>>),
        )
        .await
        .unwrap();
        assert_eq!(result.reason, "check_deadline_observed");
    }

    #[tokio::test]
    async fn stalled_store_guard_requests_cooperative_cleanup_within_its_budget() {
        let (stop, mut receive) = tokio::sync::watch::channel(None);
        let check = async move {
            receive.changed().await.unwrap();
            assert_eq!(
                *receive.borrow(),
                Some(crate::job_precheck_adapter::Stop::GuardUnavailable)
            );
            Outcome::failed(OutcomeState::Unknown, "cleanup_observed_after_guard_loss")
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            supervise_precheck(check, stop, std::future::pending::<Result<Reply>>),
        )
        .await
        .unwrap();
        assert_eq!(result.reason, "cleanup_observed_after_guard_loss");
        assert!(!result.cleanup_confirmed);
    }
}
