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
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

const MAX_CLAIMS_PER_TICK: usize = 4;
const MAX_RETAINED_DISPATCH_TASKS: usize = 64;

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

async fn quota_step<T, F, G>(
    slots: &Arc<Semaphore>,
    permit: &mut Option<OwnedSemaphorePermit>,
    mut changed: watch::Receiver<u64>,
    mut shutdown: watch::Receiver<bool>,
    mut action: F,
) -> Result<T>
where
    F: FnMut() -> G,
    G: std::future::Future<Output = Result<T>>,
{
    loop {
        if shutdown_requested(&shutdown) {
            return Err(crate::api_error::Error::new(
                "host_stopping",
                "Job runtime is shutting down",
            )
            .into());
        }
        if permit.is_none() {
            *permit = Some(tokio::select! {
                _ = stopping(&mut shutdown) => return Err(crate::api_error::Error::new("host_stopping", "Job runtime is shutting down").into()),
                permit=slots.clone().acquire_owned()=>permit.map_err(|_|anyhow!("Job dispatch capacity is closed"))?,
            });
        }
        changed.borrow_and_update();
        match action().await {
            Err(error)
                if error
                    .downcast_ref::<crate::api_error::Error>()
                    .is_some_and(|error| error.code == "quota_wait") =>
            {
                drop(permit.take());
                tokio::select! {
                    _ = stopping(&mut shutdown) => return Err(crate::api_error::Error::new("host_stopping", "Job runtime is shutting down").into()),
                    changed=changed.changed()=>changed.map_err(|_|anyhow!("Job quota journal is closed"))?,
                }
            }
            result => return result,
        }
    }
}

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
    slots: Arc<Semaphore>,
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
        permit: &mut Option<OwnedSemaphorePermit>,
        dispatch: &crate::job_attempts::Dispatch,
        request: Value,
    ) -> Result<Value> {
        self.admission_open()?;
        let request: Box<crate::orchestration::Request> = serde_json::from_value(request)?;
        match quota_step(
            &self.slots,
            permit,
            self.log.subscribe(),
            self.shutdown.clone(),
            || {
                self.log.jobs(Work::Prepare {
                    dispatch: dispatch.clone(),
                    request: request.clone(),
                })
            },
        )
        .await?
        {
            Reply::Prepared(view) => Ok(view),
            _ => Err(anyhow!("Job metadata preparation was not confirmed")),
        }
    }
    async fn dispatch(
        &self,
        claim: Claim,
        permit: OwnedSemaphorePermit,
    ) -> std::result::Result<(), Failure> {
        let mut permit = Some(permit);
        let admitted = self.admit(&claim, &mut permit).await;
        if !admitted.map_err(|error| Failure {
            error,
            stage: Stage::Admission,
        })? {
            return Ok(());
        }
        let mut native_requested = false;
        let launched = self
            .launch(&claim, &mut permit, &mut native_requested)
            .await;
        launched.map_err(|error| Failure {
            error,
            stage: Stage::Launch { native_requested },
        })
    }
    async fn admit(
        &self,
        claim: &Claim,
        permit: &mut Option<OwnedSemaphorePermit>,
    ) -> Result<bool> {
        self.admission_open()?;
        match quota_step(
            &self.slots,
            permit,
            self.log.subscribe(),
            self.shutdown.clone(),
            || {
                self.log.jobs(Work::BeginPrecheck {
                    dispatch: claim.dispatch.clone(),
                })
            },
        )
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
                    return Ok(false);
                }
            }
            Reply::Precheck(None) => {}
            Reply::PrecheckPassed(false) => return Ok(false),
            _ => return Err(anyhow!("Precheck admission was not confirmed")),
        }
        Ok(true)
    }
    async fn launch(
        &self,
        claim: &Claim,
        permit: &mut Option<OwnedSemaphorePermit>,
        native_requested: &mut bool,
    ) -> Result<()> {
        let prefix =
            crate::job_attempts::key_prefix(&claim.job_id, &claim.id, i64::from(claim.ordinal));
        self.admission_open()?;
        let run=self.workflow(permit,&claim.dispatch,json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":claim.spec.title,"goal":claim.spec.instruction}})).await?;
        let run_id = run["run"]["id"]
            .as_str()
            .ok_or_else(|| anyhow!("Job run identity was not confirmed"))?;
        self.admission_open()?;
        quota_step(
            &self.slots,
            permit,
            self.log.subscribe(),
            self.shutdown.clone(),
            || {
                self.log.jobs(Work::BindRun {
                    dispatch: claim.dispatch.clone(),
                    run: run_id.into(),
                })
            },
        )
        .await?;
        let plan=self.workflow(permit,&claim.dispatch,json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run_id,"expectedRevision":run["run"]["revision"],"tasks":[{"key":"job","title":claim.spec.title,"instruction":claim.spec.instruction}]})).await?;
        let limits=self.workflow(permit,&claim.dispatch,json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run_id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":claim.spec.max_elapsed_ms}}})).await?;
        let active=self.workflow(permit,&claim.dispatch,json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run_id,"expectedRevision":limits["run"]["revision"]})).await?;
        let request = serde_json::from_value(
            json!({"action":"start","key":format!("{prefix}:executor"),"runId":run_id,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}],"retryFailed":false}}),
        )?;
        self.admission_open()?;
        *native_requested = true;
        crate::workflow_executor_runtime::execute(
            self.state.clone(),
            self.events.clone(),
            self.log.clone(),
            owner(),
            Authority::Owner,
            request,
        )
        .await?;
        self.log
            .jobs(Work::Started {
                dispatch: claim.dispatch.clone(),
            })
            .await?;
        Ok(())
    }
}

enum Stage {
    Admission,
    Launch { native_requested: bool },
}

struct Failure {
    error: anyhow::Error,
    stage: Stage,
}

#[derive(Debug, PartialEq, Eq)]
enum Closing {
    Stopped,
    Refused { uncertain: bool },
    Interrupted,
}

type DispatchOutcome = std::thread::Result<std::result::Result<(), Failure>>;

fn host_stopping(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<crate::api_error::Error>()
        .is_some_and(|error| error.code == "host_stopping")
}

fn closing(outcome: &DispatchOutcome, stopping: bool) -> Option<Closing> {
    match outcome {
        Ok(Ok(())) => None,
        Ok(Err(failure)) if stopping || host_stopping(&failure.error) => Some(Closing::Stopped),
        Ok(Err(Failure {
            stage: Stage::Launch { native_requested },
            ..
        })) => Some(Closing::Refused {
            uncertain: *native_requested,
        }),
        Ok(Err(_)) | Err(_) => Some(Closing::Interrupted),
    }
}

async fn settle(
    log: &Service,
    stopping: bool,
    dispatch: crate::job_attempts::Dispatch,
    outcome: DispatchOutcome,
) -> Result<()> {
    let Some(closing) = closing(&outcome, stopping) else {
        return Ok(());
    };
    let shutdown = stopping || closing == Closing::Stopped;
    let recorded = match closing {
        Closing::Stopped => {
            log.jobs(Work::Stopped {
                dispatch: dispatch.clone(),
            })
            .await
        }
        Closing::Refused { uncertain } => match log
            .jobs(Work::Refused {
                dispatch: dispatch.clone(),
                uncertain,
            })
            .await
        {
            Err(_) => {
                log.jobs(Work::Interrupted {
                    dispatch: dispatch.clone(),
                })
                .await
            }
            recorded => recorded,
        },
        Closing::Interrupted => {
            log.jobs(Work::Interrupted {
                dispatch: dispatch.clone(),
            })
            .await
        }
    };
    if let Err(error) = recorded {
        if !shutdown {
            return Err(error);
        }
        eprintln!(
            "Job dispatch {} shutdown record is unconfirmed: {error}",
            dispatch.occurrence
        );
    }
    match outcome {
        Err(_) => Err(anyhow!("Job dispatch was interrupted")),
        Ok(_) => Ok(()),
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
        slots: Arc::new(Semaphore::new(4)),
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
            if !crate::provider_quota_runtime::publish(&runner.state, &runner.log).await {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
            let mut reserved = Vec::new();
            while reserved.len() < MAX_CLAIMS_PER_TICK
                && dispatches.len() + reserved.len() < MAX_RETAINED_DISPATCH_TASKS
            {
                match runner.slots.clone().try_acquire_owned() {
                    Ok(permit) => reserved.push(permit),
                    Err(_) => break,
                }
            }
            match runner
                .log
                .jobs(Work::Poll {
                    slots: reserved.len() as u8,
                })
                .await
            {
                Ok(Reply::Claims(claims)) => {
                    delay = 1;
                    for (claim, permit) in claims.into_iter().zip(reserved) {
                        let runner = runner.clone();
                        dispatches.spawn(async move {
                            let dispatch = claim.dispatch.clone();
                            let outcome =
                                std::panic::AssertUnwindSafe(runner.dispatch(claim, permit))
                                    .catch_unwind()
                                    .await;
                            let stopping = shutdown_requested(&runner.shutdown);
                            settle(&runner.log, stopping, dispatch, outcome).await
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
    async fn parked_quota_step_releases_capacity_and_rechecks_only_after_change() {
        let slots = Arc::new(Semaphore::new(1));
        let mut permit = Some(slots.clone().acquire_owned().await.unwrap());
        let (journal, changed) = watch::channel(0);
        let (_host, shutdown) = watch::channel(false);
        let calls = std::cell::Cell::new(0);
        let step = quota_step(&slots, &mut permit, changed, shutdown, || {
            let count = calls.get() + 1;
            calls.set(count);
            std::future::ready(if count == 1 {
                Err(crate::api_error::Error::new("quota_wait", "Fixture permission held").into())
            } else {
                Ok("same phase and claim")
            })
        });
        tokio::pin!(step);
        assert!(futures_util::poll!(&mut step).is_pending());
        assert_eq!(calls.get(), 1);
        assert_eq!(slots.available_permits(), 1);
        assert!(futures_util::poll!(&mut step).is_pending());
        assert_eq!(calls.get(), 1, "Polling alone cannot repeat admission");
        let other = slots.clone().try_acquire_owned().unwrap();
        journal.send(1).unwrap();
        assert!(futures_util::poll!(&mut step).is_pending());
        assert_eq!(
            calls.get(),
            1,
            "Release still needs active dispatch capacity"
        );
        drop(other);
        assert_eq!(step.await.unwrap(), "same phase and claim");
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn quota_release_during_rejected_read_is_not_lost_and_shutdown_stops_parking() {
        let slots = Arc::new(Semaphore::new(1));
        let mut permit = Some(slots.clone().acquire_owned().await.unwrap());
        let (journal, changed) = watch::channel(0);
        let (host, shutdown) = watch::channel(false);
        let calls = std::cell::Cell::new(0);
        let step = quota_step(&slots, &mut permit, changed, shutdown, || {
            let count = calls.get() + 1;
            calls.set(count);
            if count == 1 {
                journal.send(1).unwrap();
            }
            std::future::ready(Err::<(), _>(
                crate::api_error::Error::new("quota_wait", "Fixture permission held").into(),
            ))
        });
        tokio::pin!(step);
        assert!(futures_util::poll!(&mut step).is_pending());
        assert_eq!(
            calls.get(),
            2,
            "An event during the store read triggers a fresh read"
        );
        assert_eq!(slots.available_permits(), 1);
        host.send(true).unwrap();
        let error = step.await.unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "host_stopping"
        );
        assert_eq!(calls.get(), 2);
        assert_eq!(slots.available_permits(), 1);
    }

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

    fn dispatch() -> crate::job_attempts::Dispatch {
        crate::job_attempts::Dispatch {
            occurrence: "occurrence".into(),
            attempt: "attempt".into(),
            token: "token".into(),
        }
    }

    fn failed(stage: Stage, error: anyhow::Error) -> DispatchOutcome {
        Ok(Err(Failure { error, stage }))
    }

    fn stopping_refusal() -> anyhow::Error {
        crate::api_error::Error::new("host_stopping", "Job runtime is shutting down").into()
    }

    #[test]
    fn dispatch_ended_by_graceful_shutdown_is_recorded_as_host_stopping() {
        let refused_by_stopping_state = || {
            failed(
                Stage::Launch {
                    native_requested: true,
                },
                anyhow!("Host is shutting down."),
            )
        };
        assert_eq!(
            closing(&refused_by_stopping_state(), true),
            Some(Closing::Stopped)
        );
        assert_eq!(
            closing(&failed(Stage::Admission, stopping_refusal()), false),
            Some(Closing::Stopped)
        );
        assert_eq!(
            closing(&refused_by_stopping_state(), false),
            Some(Closing::Refused { uncertain: true })
        );
        assert_eq!(
            closing(
                &failed(
                    Stage::Launch {
                        native_requested: false
                    },
                    anyhow!("refused")
                ),
                false
            ),
            Some(Closing::Refused { uncertain: false })
        );
        assert_eq!(
            closing(&failed(Stage::Admission, anyhow!("journal")), false),
            Some(Closing::Interrupted)
        );
        let panicked: DispatchOutcome = Err(Box::new("fixture panic"));
        assert_eq!(closing(&panicked, true), Some(Closing::Interrupted));
        assert_eq!(closing(&Ok(Ok(())), true), None);
    }

    #[tokio::test]
    async fn shutdown_journal_failure_is_reported_without_failing_the_runtime() {
        let (log, writes) = Service::held();
        drop(writes);
        let during_shutdown = failed(
            Stage::Launch {
                native_requested: true,
            },
            anyhow!("Host is shutting down."),
        );
        settle(&log, true, dispatch(), during_shutdown)
            .await
            .unwrap();
        settle(
            &log,
            false,
            dispatch(),
            failed(Stage::Admission, stopping_refusal()),
        )
        .await
        .unwrap();
        settle(&log, false, dispatch(), Ok(Ok(()))).await.unwrap();
        let ordinary = failed(
            Stage::Launch {
                native_requested: false,
            },
            anyhow!("refused"),
        );
        assert!(
            settle(&log, false, dispatch(), ordinary).await.is_err(),
            "Outside shutdown an unrecorded refusal remains an unconfirmed dispatch"
        );
        let panicked: DispatchOutcome = Err(Box::new("fixture panic"));
        assert!(settle(&log, true, dispatch(), panicked).await.is_err());
    }

    #[test]
    fn stopped_dispatch_keeps_host_stopping_and_restart_hands_it_to_retry_classification() {
        const NOW: u64 = 1_792_416_000_000;
        let mut journal = crate::event_log::test_journal();
        let at = chrono::DateTime::from_timestamp_millis((NOW + 60_000) as i64)
            .unwrap()
            .to_rfc3339();
        let job = crate::job_definitions::execute(
            &mut journal,
            owner(),
            serde_json::from_value(json!({
                "action":"create","key":"definition:stopping","spec":{
                    "title":"Stopped dispatch","instruction":"No native effects in this fixture",
                    "profile":{"program":"claude","workspace":"shared"},
                    "schedule":{"kind":"once","at":at},
                    "retry":{"on":"launchNoEffect","maxAttempts":2,"initialDelayMs":1000,"maxDelayMs":1000}
                }
            }))
            .unwrap(),
            NOW,
        )
        .unwrap()["job"]
            .clone();
        crate::job_definitions::execute(
            &mut journal,
            owner(),
            serde_json::from_value(json!({"action":"runNow","key":"manual:stopping","jobId":job["id"],"expectedRevision":1}))
                .unwrap(),
            NOW,
        )
        .unwrap();
        let Reply::Claims(mut claims) =
            crate::job_definitions::work(&mut journal, Work::Poll { slots: 1 }, NOW).unwrap()
        else {
            panic!("Expected one job claim");
        };
        let claim = claims.pop().unwrap();
        crate::job_definitions::work(
            &mut journal,
            Work::Stopped {
                dispatch: claim.dispatch.clone(),
            },
            NOW + 1,
        )
        .unwrap();
        let row = |journal: &rusqlite::Connection| {
            journal
                .query_row(
                    "SELECT o.state,o.reason,a.state,a.reason,a.dispatch_token IS NULL,
                        (SELECT COUNT(*) FROM harness_job_retries r WHERE r.occurrence_id=o.id)
                     FROM harness_job_occurrences o
                     JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id
                     WHERE o.id=?1",
                    [&claim.id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, Option<String>>(3)?,
                            r.get::<_, bool>(4)?,
                            r.get::<_, i64>(5)?,
                        ))
                    },
                )
                .unwrap()
        };
        let stopping = Some("host_stopping".to_owned());
        assert_eq!(
            row(&journal),
            (
                "reconcile".into(),
                stopping.clone(),
                "reconcile".into(),
                stopping.clone(),
                true,
                0
            ),
            "A graceful stop is not a job failure and starts no retry before restart"
        );
        crate::job_definitions::recover(&mut journal, NOW + 2).unwrap();
        assert_eq!(
            row(&journal),
            (
                "retryWaiting".into(),
                Some("retry_probe_pending".into()),
                "reconcile".into(),
                stopping,
                true,
                1
            )
        );
        let classified: (String, String) = journal
            .query_row(
                "SELECT class,failure FROM harness_job_retries WHERE occurrence_id=?1",
                [&claim.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            classified,
            ("uncertainEffect".into(), "host_restarted".into())
        );
        crate::job_definitions::recover(&mut journal, NOW + 3).unwrap();
        assert_eq!(
            row(&journal).5,
            1,
            "A later restart does not classify twice"
        );
    }
}
