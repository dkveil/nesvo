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
use tokio::sync::{mpsc, watch};

fn shutdown_requested(stop: &watch::Receiver<bool>) -> bool {
    *stop.borrow() || stop.has_changed().is_err()
}

async fn stopping(stop: &mut watch::Receiver<bool>) {
    while !shutdown_requested(stop) {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Retain scheduling and command cleanup until the host's journal is drained.
/// Dropping the sender is also a fail-closed stop, never permission to continue.
pub struct Runtime {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<()>>,
}
impl Runtime {
    pub fn start(state: Arc<Mutex<State>>, events: mpsc::Sender<PtyEvent>, log: Service) -> Self {
        let (stop, receive) = watch::channel(false);
        Self {
            stop,
            task: tokio::spawn(run(state, events, log, receive)),
        }
    }
    pub fn request_shutdown(&self) {
        let _ = self.stop.send(true);
    }
    pub async fn shutdown(mut self) -> Result<()> {
        self.request_shutdown();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let drain = deadline - std::time::Duration::from_millis(100);
        match tokio::time::timeout_at(drain, &mut self.task).await {
            Ok(result) => result.map_err(|_| anyhow!("Job runtime shutdown was interrupted"))?,
            Err(_) => {
                // Preserve any in-flight durable claim as unconfirmed. Do not
                // invent command cleanup or repeat native termination signals.
                self.task.abort();
                if tokio::time::timeout_at(deadline, &mut self.task)
                    .await
                    .is_err()
                {
                    return Err(anyhow!(
                        "Job runtime shutdown and task termination were not confirmed within five seconds"
                    ));
                }
                Err(anyhow!(
                    "Job runtime shutdown cleanup was not confirmed within five seconds"
                ))
            }
        }
    }
}

/// The owned process future must remain polled while the store guard is slow.
/// Guard reads have no native effects and can be dropped on timeout/completion.
async fn supervise_precheck<C, G>(
    check: C,
    stop: tokio::sync::watch::Sender<Option<crate::job_precheck_adapter::Stop>>,
    mut shutdown: watch::Receiver<bool>,
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
        if shutdown_requested(&shutdown) && stop.borrow().is_none() {
            let _ = stop.send(Some(Stop::HostShutdown));
        }
        tokio::select! {
            result = &mut check => return result,
            _ = stopping(&mut shutdown), if stop.borrow().is_none() => {
                let _ = stop.send(Some(Stop::HostShutdown));
            }
            _ = monitor.tick(), if stop.borrow().is_none() => {
                let answer = tokio::select! {
                    result = &mut check => return result,
                    _ = stopping(&mut shutdown) => {
                        let _ = stop.send(Some(Stop::HostShutdown));
                        continue;
                    }
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
    shutdown: watch::Receiver<bool>,
}
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
impl Runner {
    fn admission_open(&self) -> Result<()> {
        if shutdown_requested(&self.shutdown) {
            return Err(crate::api_error::Error::new(
                "host_stopping",
                "Job runtime is shutting down",
            )
            .into());
        }
        Ok(())
    }
    async fn workflow(
        &self,
        dispatch: &crate::job_attempts::Dispatch,
        request: Value,
    ) -> Result<Value> {
        self.admission_open()?;
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
        self.admission_open()?;
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
                let result = supervise_precheck(check, stop_tx, self.shutdown.clone(), || {
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
        let prefix = if claim.ordinal == 1 {
            format!("job:{}:{}", claim.job_id, claim.id)
        } else {
            format!(
                "job:{}:{}:attempt:{}",
                claim.job_id, claim.id, claim.ordinal
            )
        };
        let result=async {
            self.admission_open()?;
            let run=self.workflow(&claim.dispatch,json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":claim.spec.title,"goal":claim.spec.instruction}})).await?;
            let run_id=run["run"]["id"].as_str().ok_or_else(||anyhow!("Job run identity was not confirmed"))?;
            self.admission_open()?;
            self.log.jobs(Work::BindRun{dispatch:claim.dispatch.clone(),run:run_id.into()}).await?;
            let plan=self.workflow(&claim.dispatch,json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run_id,"expectedRevision":run["run"]["revision"],"tasks":[{"key":"job","title":claim.spec.title,"instruction":claim.spec.instruction}]})).await?;
            let limits=self.workflow(&claim.dispatch,json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run_id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":claim.spec.max_elapsed_ms}}})).await?;
            let active=self.workflow(&claim.dispatch,json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run_id,"expectedRevision":limits["run"]["revision"]})).await?;
            let request=serde_json::from_value(json!({"action":"start","key":format!("{prefix}:executor"),"runId":run_id,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}],"retryFailed":false}}))?;
            self.admission_open()?;
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

async fn run(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let runner = Runner {
        state,
        events,
        log,
        shutdown: shutdown.clone(),
    };
    let mut delay = 1;
    let mut dispatches = tokio::task::JoinSet::new();
    let mut calendars = tokio::task::JoinSet::new();
    let mut cancellations = tokio::task::JoinSet::new();
    let mut pending_calendars = std::collections::BTreeSet::new();
    let scheduling = async {
        loop {
            if shutdown_requested(&shutdown) {
                break;
            }
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
                        let result = std::panic::AssertUnwindSafe(
                            crate::workflow_control_runtime::cancel_job(
                                runner.state,
                                runner.log.clone(),
                                claim.issuer.clone(),
                                claim.run.clone(),
                                claim.key.clone(),
                            ),
                        )
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
            if shutdown_requested(&shutdown) {
                break;
            }
            let checking = match runner.state.lock() {
                Ok(state) => state.provider_probes_pending(),
                Err(_) => return Err(anyhow!("Job runtime state is unavailable")),
            };
            if checking {
                // Bounded host version probes precede admission. A persisted due
                // job must not interpret transient discovery as unsupported CLI.
                tokio::select! {
                    _ = stopping(&mut shutdown) => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                }
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
                        let answer = std::panic::AssertUnwindSafe(
                            crate::job_calendar_adapter::next(item.schedule, evaluated_at),
                        )
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
            if shutdown_requested(&shutdown) {
                break;
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
                                runner.log.jobs(Work::Interrupted { dispatch }).await?;
                            }
                            match result {
                                Ok(Err(error))
                                    if error
                                        .downcast_ref::<crate::api_error::Error>()
                                        .is_some_and(|e| e.code == "host_stopping") =>
                                {
                                    Ok(())
                                }
                                Ok(result) => result,
                                Err(_) => Err(anyhow!("Job dispatch was interrupted")),
                            }
                        });
                    }
                }
                _ => {
                    delay = (delay * 2).min(30);
                }
            }
            tokio::select! {
                _ = stopping(&mut shutdown) => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {},
            }
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    // Stop admission first, but keep every owned command future and the journal
    // alive through its exact terminate/reap/empty observation and finish write.
    // Detached executor/native operations retain their own receipt uncertainty;
    // draining this runtime is not proof those separate operations completed.
    let mut failed = false;
    loop {
        while let Some(result) = dispatches.try_join_next() {
            failed |= !matches!(result, Ok(Ok(())));
        }
        while let Some(result) = calendars.try_join_next() {
            failed |= result.is_err();
        }
        while let Some(result) = cancellations.try_join_next() {
            failed |= result.is_err();
        }
        if dispatches.is_empty()
            && calendars.is_empty()
            && cancellations.is_empty()
            && crate::job_precheck_adapter::scopes_settled()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    anyhow::ensure!(
        !failed,
        "Job runtime shutdown retained an unconfirmed dispatch"
    );
    scheduling
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job_prechecks::{Outcome, OutcomeState};

    #[tokio::test]
    async fn slow_store_guard_cannot_suspend_the_owned_check_deadline() {
        let (stop, _receive) = tokio::sync::watch::channel(None);
        let (_host, shutdown) = watch::channel(false);
        let check = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Outcome::failed(OutcomeState::Refused, "check_deadline_observed")
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            supervise_precheck(check, stop, shutdown, std::future::pending::<Result<Reply>>),
        )
        .await
        .unwrap();
        assert_eq!(result.reason, "check_deadline_observed");
    }

    #[tokio::test]
    async fn stalled_store_guard_requests_cooperative_cleanup_within_its_budget() {
        let (stop, mut receive) = tokio::sync::watch::channel(None);
        let (_host, shutdown) = watch::channel(false);
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
            supervise_precheck(check, stop, shutdown, std::future::pending::<Result<Reply>>),
        )
        .await
        .unwrap();
        assert_eq!(result.reason, "cleanup_observed_after_guard_loss");
        assert!(!result.cleanup_confirmed);
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_stalled_guard_and_keeps_polling_owned_cleanup() {
        let (host, shutdown) = watch::channel(false);
        let (stop, mut receive) = watch::channel(None);
        let check = async move {
            receive.changed().await.unwrap();
            assert_eq!(
                *receive.borrow(),
                Some(crate::job_precheck_adapter::Stop::HostShutdown)
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let mut result = Outcome::failed(OutcomeState::Refused, "host_shutdown");
            result.command_started = None;
            result.cleanup_confirmed = true;
            result
        };
        let supervisor =
            supervise_precheck(check, stop, shutdown, std::future::pending::<Result<Reply>>);
        let (result, ()) = tokio::join!(supervisor, async {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            host.send(true).unwrap();
        });
        assert_eq!(result.reason, "host_shutdown");
        assert!(result.command_started.is_none());
        assert!(result.cleanup_confirmed);
    }

    #[tokio::test]
    async fn losing_the_runtime_stop_sender_fails_closed() {
        let (host, shutdown) = watch::channel(false);
        drop(host);
        let (stop, mut receive) = watch::channel(None);
        let check = async move {
            receive.changed().await.unwrap();
            assert_eq!(
                *receive.borrow(),
                Some(crate::job_precheck_adapter::Stop::HostShutdown)
            );
            Outcome::failed(OutcomeState::Refused, "host_shutdown")
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            supervise_precheck(check, stop, shutdown, std::future::pending::<Result<Reply>>),
        )
        .await
        .unwrap();
        assert_eq!(result.reason, "host_shutdown");
    }
}
