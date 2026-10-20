//! Durable intent precedes native effects; observation never dispatches input.
use crate::{
    event_log::Service,
    jobs::LaunchSpec,
    receipts::Receipt,
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Until {
    Delivered,
    Received,
    Started,
    #[default]
    Settled,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    pub id: Option<String>,
    pub key: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub until: Until,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy)]
pub enum ControlAction {
    Interrupt,
    Stop,
    /// Run orchestration also protects a retained human draft without a lease.
    StopRunWorker,
    /// A job timeout additionally refuses any prior human takeover of its worker.
    StopJobTimeoutWorker,
}
pub enum ControlDispatch {
    Write(tokio::sync::oneshot::Receiver<bool>),
    StopRequested,
    AlreadyExited,
}
impl ControlAction {
    fn operation(self) -> &'static str {
        match self {
            Self::Interrupt => "interrupt",
            Self::Stop | Self::StopRunWorker | Self::StopJobTimeoutWorker => "stop",
        }
    }

    pub(crate) fn check_human_priority(
        self,
        running: bool,
        leased: bool,
        dirty: bool,
        human_epoch: u64,
    ) -> Result<()> {
        if leased
            || (running
                && dirty
                && matches!(self, Self::StopRunWorker | Self::StopJobTimeoutWorker))
        {
            return Err(crate::api_error::Error::new(
                "control_busy",
                "Human terminal control must be released before automated interruption or stop",
            )
            .into());
        }
        if running && human_epoch != 0 && matches!(self, Self::StopJobTimeoutWorker) {
            return Err(crate::api_error::Error::new(
                "control_busy",
                "Human takeover was observed; this worker requires explicit owner control instead of automatic timeout termination",
            )
            .into());
        }
        Ok(())
    }
}
pub async fn control(
    state: Arc<Mutex<State>>,
    log: Service,
    issuer: String,
    key: String,
    session_id: String,
    action: ControlAction,
    authority: crate::caller::Authority,
) -> Result<Receipt> {
    let accepted = log
        .accept_operation(
            issuer.clone(),
            key,
            action.operation(),
            json!({"sessionId":session_id}),
        )
        .await?;
    if !accepted.is_new {
        return Ok(accepted.receipt);
    }
    let claim = log
        .claim(issuer.clone(), accepted.receipt.id)
        .await?
        .ok_or_else(|| anyhow!("Control operation claim is unavailable"))?;
    let dispatched = state
        .lock()
        .unwrap()
        .dispatch_control(&session_id, action, &authority);
    let result = async {
        let outcome=match dispatched? {
            ControlDispatch::Write(answer) => {
                flushed(answer).await?;
                (
                "delivered",
                json!({"nativeWriteFlushed":true,"taskResult":null,"agentStopped":null}),
            )},
            ControlDispatch::StopRequested => (
                "stopRequested",
                json!({"nativeStopRequested":true,"taskResult":null,"processExited":null}),
            ),
            ControlDispatch::AlreadyExited => ("stopped",json!({"nativeStopRequested":false,"processExited":true,"effectStarted":false,"taskResult":null})),
        };
        Ok::<_, anyhow::Error>(outcome)
    }
    .await;
    let (phase, result) = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            let typed = error.downcast_ref::<crate::api_error::Error>();
            (
                if typed.is_some() { "failed" } else { "unknown" },
                json!({"code":typed.map(|e|e.code).unwrap_or("control_unconfirmed"),"message":if typed.is_some(){error.to_string()}else{"Inspect the original receipt and process state before another control attempt".into()},"effectStarted":typed.is_none(),"taskResult":null}),
            )
        }
    };
    log.finish(issuer, claim.receipt.id, claim.token, phase.into(), result)
        .await
}
pub async fn wait(
    log: Service,
    issuer: String,
    admin: bool,
    request: WaitRequest,
    mut canceled: tokio::sync::watch::Receiver<bool>,
) -> Result<serde_json::Value> {
    use crate::api_error::Error;
    let timeout = request.timeout_ms.unwrap_or(30_000);
    if !(1..=60_000).contains(&timeout) {
        return Err(Error::new("invalid_argument", "Wait timeout must be 1–60000 ms").into());
    }
    let _slot = log.wait_slot()?;
    let mut changed = log.subscribe();
    changed.borrow_and_update();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout);
    loop {
        if *canceled.borrow() {
            return Err(Error::new(
                "disconnected",
                "Wait caller disconnected; no effect was retried",
            )
            .into());
        }
        let view = log
            .operation(
                issuer.clone(),
                admin,
                request.id.clone(),
                request.key.clone(),
            )
            .await?;
        let receipt = &view.receipt;
        if receipt.operation != "send" {
            return Err(Error::new(
                "unsupported",
                "This wait targets a send receipt; process creation is not a response turn",
            )
            .into());
        }
        if request
            .session_id
            .as_ref()
            .is_some_and(|id| id != &receipt.session_id)
        {
            return Err(Error::new(
                "invalid_argument",
                "Receipt belongs to a different target session",
            )
            .into());
        }
        let reached = match request.until {
            Until::Delivered => {
                receipt.result["nativeWriteFlushed"] == true
                    || receipt.result["providerPromptObserved"] == true
            }
            Until::Received => receipt.result["providerPromptObserved"] == true,
            Until::Started => receipt.result["processingObserved"] == true,
            Until::Settled => receipt.phase == "settled",
        };
        let terminal = matches!(
            receipt.phase.as_str(),
            "failed" | "unknown" | "interrupted" | "settled"
        );
        let expired = tokio::time::Instant::now() >= deadline;
        if reached || terminal || expired {
            let outcome = if reached {
                "reached"
            } else if terminal {
                receipt.phase.as_str()
            } else {
                "timeout"
            };
            return Ok(
                json!({"type":"operation","receipt":receipt,"cursor":view.cursor,"wait":{"until":request.until,"outcome":outcome,"reached":reached}}),
            );
        }
        if !matches!(request.until, Until::Delivered)
            && receipt.result["correlation"] == "unavailable"
        {
            return Err(Error::new(
                "unsupported",
                "Provider prompt correlation is unavailable; do not infer completion from idle",
            )
            .into());
        }
        tokio::select! {
            _=tokio::time::sleep_until(deadline)=>{},
            _=canceled.changed()=>return Err(Error::new("disconnected","Wait caller disconnected; no effect was retried").into()),
            result=changed.changed()=>{if result.is_err(){return Err(Error::new("disconnected","Host journal closed during wait").into());}},
        }
    }
}

async fn fence(
    path: Option<std::path::PathBuf>,
    session_id: &str,
) -> Result<Option<crate::agent_events::Batch>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let session_id = session_id.to_owned();
    Ok(Some(
        tokio::task::spawn_blocking(move || crate::agent_events::read(&path, &session_id, 0))
            .await??,
    ))
}
async fn flushed(answer: tokio::sync::oneshot::Receiver<bool>) -> Result<()> {
    // Controls retain their existing conservative untyped failure projection.
    write_confirmation(answer, std::time::Duration::from_secs(5))
        .await
        .map_err(|_| anyhow!("Native terminal write was not confirmed"))
}

#[derive(Debug, PartialEq, Eq)]
enum WriteConfirmationFailure {
    Timeout,
    Closed,
    Failed,
}
impl WriteConfirmationFailure {
    fn into_error(self) -> anyhow::Error {
        let (code, message) = match self {
            Self::Timeout => (
                "native_write_timeout",
                "Native terminal write confirmation timed out; inspect the original receipt and terminal",
            ),
            Self::Closed => (
                "native_write_closed",
                "Native terminal write confirmation channel closed; inspect the original receipt and terminal",
            ),
            Self::Failed => (
                "native_write_failed",
                "Native terminal write or flush failed; inspect the original receipt and terminal",
            ),
        };
        crate::api_error::Error::new(code, message).into()
    }
}

/// Confirmation distinguishes native write failure from missing evidence. A
/// timeout does not cancel queued bytes or prove that no write took place.
async fn write_confirmation(
    answer: tokio::sync::oneshot::Receiver<bool>,
    timeout: std::time::Duration,
) -> std::result::Result<(), WriteConfirmationFailure> {
    match tokio::time::timeout(timeout, answer).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(WriteConfirmationFailure::Failed),
        Ok(Err(_)) => Err(WriteConfirmationFailure::Closed),
        Err(_) => Err(WriteConfirmationFailure::Timeout),
    }
}

#[derive(Clone, Copy)]
enum SubmissionStage {
    Prepare,
    PasteFence,
    PasteFlush,
    PasteDelay,
    SubmitFence,
    SubmitFlush,
}
impl SubmissionStage {
    fn label(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::PasteFence => "pasteFence",
            Self::PasteFlush => "pasteFlush",
            Self::PasteDelay => "pasteDelay",
            Self::SubmitFence => "submitFence",
            Self::SubmitFlush => "submitFlush",
        }
    }
}

fn submission_failure(
    error: anyhow::Error,
    queued: bool,
    stage: SubmissionStage,
) -> (&'static str, serde_json::Value) {
    let typed = error.downcast_ref::<crate::api_error::Error>();
    let code = typed.map(|e| e.code).unwrap_or("submission_unconfirmed");
    let message = if typed.is_some() {
        error.to_string()
    } else {
        "Inspect the original receipt and terminal before another submission".into()
    };
    (
        if queued { "unknown" } else { "failed" },
        json!({"code":code,"message":message,"effectStarted":queued,"taskResult":null,"submissionStage":stage.label()}),
    )
}

/// Retry only rejected admission checks: this queue write accepted no bytes.
/// Journal notification is registered before reading to avoid a lost wakeup.
async fn enqueue_fenced(
    state: &Arc<Mutex<State>>,
    log: &Service,
    path: Option<std::path::PathBuf>,
    session_id: &str,
    operation: &str,
    text: Option<&str>,
    cancellation: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(tokio::sync::oneshot::Receiver<bool>, bool)> {
    use crate::api_error::Error;
    let mut changed = log.subscribe();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if *cancellation.borrow() {
            return Err(Error::new(
                "submission_preempted",
                "Submission was preempted before queue admission",
            )
            .into());
        }
        changed.borrow_and_update();
        log.guard_run_dispatch(session_id, operation).await?;
        let latest = fence(path.clone(), session_id).await?;
        let result =
            state
                .lock()
                .unwrap()
                .enqueue_submission(session_id, operation, text, latest.as_ref());
        match result {
            Ok(answer) => {
                return Ok((
                    answer,
                    latest
                        .as_ref()
                        .is_some_and(|batch| batch.identity.prompt_correlation),
                ));
            }
            Err(error)
                if error
                    .downcast_ref::<Error>()
                    .is_some_and(|e| matches!(e.code, "lifecycle_pending" | "editor_pending")) =>
            {
                if tokio::time::Instant::now() >= deadline {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
        tokio::select! {
            _=tokio::time::sleep_until(deadline)=>return Err(Error::new("lifecycle_pending","Lifecycle fence/editor did not settle within two seconds; no further input was queued").into()),
            // PTY evidence is coalesced by the status timer, and unchanged
            // projections need not emit a journal event. Recheck every guard.
            _=tokio::time::sleep(std::time::Duration::from_millis(50))=>{},
            _=cancellation.changed()=>return Err(Error::new("submission_preempted","Submission was preempted while waiting for lifecycle evidence").into()),
            result=changed.changed()=>{if result.is_err(){return Err(anyhow!("Host journal closed while waiting for lifecycle evidence"));}},
        }
    }
}

pub async fn send(
    state: Arc<Mutex<State>>,
    log: Service,
    issuer: String,
    key: String,
    session_id: String,
    prompt: String,
    authority: crate::caller::Authority,
) -> Result<Receipt> {
    let accepted = log
        .accept_send(
            issuer.clone(),
            key,
            json!({"sessionId":session_id,"prompt":prompt}),
        )
        .await?;
    if !accepted.is_new {
        return Ok(accepted.receipt);
    }
    dispatch_send(
        state,
        log,
        issuer,
        accepted.receipt,
        prompt,
        authority,
        None,
    )
    .await
}
/// Task delivery reserves this receipt atomically with its claim before input.
pub(crate) async fn dispatch_send(
    state: Arc<Mutex<State>>,
    log: Service,
    issuer: String,
    receipt: Receipt,
    prompt: String,
    authority: crate::caller::Authority,
    task_epoch: Option<u64>,
) -> Result<Receipt> {
    let session_id = receipt.session_id.clone();
    let claim = log
        .claim(issuer.clone(), receipt.id)
        .await?
        .ok_or_else(|| anyhow!("Submission claim is unavailable"))?;
    let reference = crate::submission::Claim {
        id: claim.receipt.id.clone(),
        issuer: issuer.clone(),
        token: claim.token.clone(),
    };
    let mut queued = false;
    let mut stage = SubmissionStage::Prepare;
    let result = async {
        let (path, mut cancellation) = {
            let mut state = state.lock().unwrap();
            if let Some(before) = task_epoch {
                state.check_task_delivery(&session_id, &authority, before)?;
            }
            state.begin_submission(&session_id, reference, &prompt, &authority)?
        };
        stage = SubmissionStage::PasteFence;
        let (answer, _) = enqueue_fenced(
            &state,
            &log,
            path.clone(),
            &session_id,
            &claim.receipt.id,
            Some(&prompt),
            &mut cancellation,
        )
        .await?;
        queued = true;
        stage = SubmissionStage::PasteFlush;
        write_confirmation(answer, std::time::Duration::from_secs(5))
            .await
            .map_err(WriteConfirmationFailure::into_error)?;
        // Keep paste and submit separate. Frameworks may debounce a paste event;
        // a human taking control in this interval cancels the Enter entirely.
        stage = SubmissionStage::PasteDelay;
        tokio::select! {
            _=tokio::time::sleep(std::time::Duration::from_millis(150))=>{},
            _=cancellation.changed()=>return Err(crate::api_error::Error::new("submission_preempted","Submission was preempted before submit queue admission").into()),
        }
        stage = SubmissionStage::SubmitFence;
        let (answer, correlated) = enqueue_fenced(
            &state,
            &log,
            path,
            &session_id,
            &claim.receipt.id,
            None,
            &mut cancellation,
        )
        .await?;
        stage = SubmissionStage::SubmitFlush;
        write_confirmation(answer, std::time::Duration::from_secs(5))
            .await
            .map_err(WriteConfirmationFailure::into_error)?;
        Ok::<_, anyhow::Error>(correlated)
    }
    .await;
    let (phase, result) = match result {
        Ok(correlated) => (
            "delivered",
            json!({"nativeWriteFlushed":true,"correlation":if correlated {"launchHook"} else {"unavailable"},"taskResult":null}),
        ),
        Err(error) => submission_failure(error, queued, stage),
    };
    let receipt = log
        .finish(issuer, claim.receipt.id, claim.token, phase.into(), result)
        .await?;
    state
        .lock()
        .unwrap()
        .end_submission(&session_id, &receipt.id, &receipt.phase);
    Ok(receipt)
}

pub async fn create(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    issuer: String,
    key: String,
    mut spec: LaunchSpec,
    authority: crate::caller::Authority,
) -> Result<Receipt> {
    state
        .lock()
        .unwrap()
        .normalize_launch_intent(&authority, &mut spec)?;
    let accepted = log
        .accept(issuer.clone(), key, serde_json::to_value(&spec)?)
        .await?;
    if !accepted.is_new {
        return Ok(accepted.receipt);
    }
    dispatch_create(
        state,
        events,
        log,
        issuer,
        accepted.receipt,
        spec,
        CreateContext::ordinary(authority),
    )
    .await
}
/// Internal adapter context, never accepted as a caller-supplied launch field.
pub(crate) struct CreateContext {
    authority: crate::caller::Authority,
    task_tools: Option<Vec<String>>,
    quota: Option<crate::job_quota::Permit>,
}
impl CreateContext {
    fn ordinary(authority: crate::caller::Authority) -> Self {
        Self {
            authority,
            task_tools: None,
            quota: None,
        }
    }
    pub(crate) fn task(
        authority: crate::caller::Authority,
        task_tools: Option<Vec<String>>,
        quota: Option<crate::job_quota::Permit>,
    ) -> Self {
        Self {
            authority,
            task_tools,
            quota,
        }
    }
}

fn is_quota_wait(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<crate::api_error::Error>()
        .is_some_and(|error| error.code == "quota_wait")
}

/// One live continuation owns the existing claim, prepared directory and
/// reserved native identity. Nothing in this wait accepts another create or
/// replays Git. Only the physical run mutex is released while evidence is held.
struct QuotaContinuation<'a> {
    state: &'a Arc<Mutex<State>>,
    log: &'a Service,
    claim: &'a crate::receipts::Claim,
    permit: &'a crate::job_quota::Permit,
    authority: &'a crate::caller::Authority,
    before: u64,
    needs_derived_reader: bool,
}
impl Drop for QuotaContinuation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.quota_launch_done(&self.claim.receipt.id);
        }
    }
}
impl QuotaContinuation<'_> {
    fn native_ready(&self, directory: &std::path::Path, derived_worktree: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        state.quota_launch_ready(
            self.permit,
            &self.claim.receipt.id,
            directory,
            derived_worktree,
        )?;
        if self.needs_derived_reader && !derived_worktree {
            state.quota_reserve_derived_reader(&self.claim.receipt.id)?;
        }
        Ok(())
    }
    async fn hold(&self, reason: Option<&str>) -> Result<()> {
        self.log
            .launch(crate::workflow_launches::Work::QuotaHold {
                operation_id: self.claim.receipt.id.clone(),
                token: self.claim.token.clone(),
                reason: reason.map(str::to_owned),
            })
            .await?;
        Ok(())
    }

    async fn durable_guard(&self) -> Result<()> {
        match self
            .log
            .jobs(crate::job_definitions::Work::QuotaNativeGuard {
                permit: self.permit.clone(),
            })
            .await?
        {
            crate::job_definitions::Reply::Done => Ok(()),
            _ => Err(anyhow!("Unexpected native quota guard reply")),
        }
    }

    async fn ready(
        &self,
        directory: &std::path::Path,
        derived_worktree: bool,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        let mut changed = self.log.subscribe();
        'wait: loop {
            // Register before both reads; updates during either boundary must
            // not be lost. A bounded poll also observes shutdown/clock expiry.
            changed.borrow_and_update();
            self.state
                .lock()
                .unwrap()
                .quota_native_authority_ready(self.authority, self.before)?;
            let durable = self.durable_guard().await;
            let durable_ready = match durable {
                Ok(()) => true,
                Err(error) if is_quota_wait(&error) => false,
                Err(error) => return Err(error),
            };
            let native = self.native_ready(directory, derived_worktree);
            let native_ready = match native {
                Ok(()) => true,
                Err(error) if is_quota_wait(&error) => false,
                Err(error) => return Err(error),
            };
            let mut reason = "quota_wait";
            if durable_ready && native_ready {
                let acquired = self
                    .state
                    .lock()
                    .unwrap()
                    .native_run_permit(&self.permit.run_id);
                match acquired {
                    Ok(guard) => {
                        // Another native control can have changed durable
                        // authority before this mutex became available.
                        let durable = match self.durable_guard().await {
                            Ok(()) => true,
                            Err(error) if is_quota_wait(&error) => false,
                            Err(error) => return Err(error),
                        };
                        let native = self.native_ready(directory, derived_worktree);
                        let native = match native {
                            Ok(()) => true,
                            Err(error) if is_quota_wait(&error) => false,
                            Err(error) => return Err(error),
                        };
                        let waiting = !durable || !native;
                        if waiting {
                            drop(guard);
                            self.hold(Some("quota_wait")).await?;
                            continue 'wait;
                        }
                        self.hold(None).await?;
                        self.state
                            .lock()
                            .unwrap()
                            .quota_native_authority_ready(self.authority, self.before)?;
                        return Ok(guard);
                    }
                    Err(error)
                        if error
                            .downcast_ref::<crate::api_error::Error>()
                            .is_some_and(|error| error.code == "busy") =>
                    {
                        reason = "native_run_busy";
                    }
                    Err(error) => return Err(error),
                }
            }
            self.hold(Some(reason)).await?;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                changed = changed.changed() => {
                    if changed.is_err() {
                        return Err(anyhow!("Host journal closed during retained quota admission"));
                    }
                },
            }
        }
    }
}

async fn dispatch_quota_create(
    state: &Arc<Mutex<State>>,
    events: &mpsc::Sender<PtyEvent>,
    log: &Service,
    claim: &crate::receipts::Claim,
    spec: &mut LaunchSpec,
    context: &CreateContext,
    authority_epoch: Result<u64>,
) -> (&'static str, serde_json::Value) {
    let Some(permit) = context.quota.as_ref() else {
        return ("unknown", json!({"code":"quota_context_missing"}));
    };
    let validation = authority_epoch.and_then(|before| {
        state
            .lock()
            .unwrap()
            .resolve_task_launch(&context.authority, spec, context.task_tools.as_deref())
            .map(|directory| (directory, before))
    });
    let (mut directory, before) = match validation {
        Ok(ready) => ready,
        Err(error) => {
            return (
                "failed",
                json!({"code":error.downcast_ref::<crate::api_error::Error>().map(|error|error.code).unwrap_or("invalid_launch"),"message":error.to_string().chars().take(240).collect::<String>(),"effectStarted":false}),
            );
        }
    };
    let derived_worktree = spec.worktree;
    let continuation = QuotaContinuation {
        state,
        log,
        claim,
        permit,
        authority: &context.authority,
        before,
        needs_derived_reader: derived_worktree,
    };
    let mut setup_started = false;
    let mut spawn_attempted = false;
    let result: Result<String> = async {
        let gate = continuation.ready(&directory, false).await?;
        if derived_worktree {
            // From this boundary Git may have left real repository artifacts.
            // Every later refusal remains uncertain about effects, even when
            // no native process was spawned.
            setup_started = true;
            directory = crate::git::create_worktree(&directory).await.map_err(|_| {
                crate::api_error::Error::new(
                    "worktree_unconfirmed",
                    "Inspect the repository before creating another worktree",
                )
            })?;
        }
        spec.cwd = Some(crate::process::display_path(&directory));
        spec.worktree = false;
        log.launch(crate::workflow_launches::Work::PreparedWorkspace {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            spec: Box::new(spec.clone()),
            derived_worktree,
        })
        .await?;
        drop(gate);
        spec.quota_launch = Some(crate::quota_contexts::LaunchContext {
            permit: permit.clone(),
            derived_worktree,
            receipt_id: claim.receipt.id.clone(),
        });
        loop {
            let gate = continuation.ready(&directory, derived_worktree).await?;
            let launched = {
                let mut current = state.lock().unwrap();
                current.quota_native_authority_ready(&context.authority, before)?;
                current.launch_authorized(
                    &context.authority,
                    spec,
                    events,
                    &claim.receipt.session_id,
                    context.task_tools.as_deref(),
                )
            };
            drop(gate);
            match launched {
                Err(error) if is_quota_wait(&error) => {
                    continuation.hold(Some("quota_wait")).await?;
                }
                other => {
                    // A native adapter error can occur after process creation;
                    // its typed spelling alone is never no-effect evidence.
                    spawn_attempted = true;
                    return other;
                }
            }
        }
    }
    .await;
    drop(continuation);
    match result {
        Ok(id) => ("created", json!({"sessionId":id,"taskResult":null})),
        Err(error) => {
            let typed = error.downcast_ref::<crate::api_error::Error>();
            let no_effect = !setup_started && !spawn_attempted && typed.is_some();
            (
                if no_effect { "failed" } else { "unknown" },
                json!({"code":typed.map(|error|error.code).unwrap_or("launch_unconfirmed"),
                    "message":if typed.is_some() {error.to_string().chars().take(240).collect::<String>()} else {"Inspect the original launch receipt, workspace and session before another operation".into()},
                    "effectStarted":if no_effect {Some(false)} else {None},
                    "reservedSessionId":claim.receipt.session_id,"directory":spec.cwd}),
            )
        }
    }
}
/// Dispatch an already journaled create once. Workflow admission can reserve
/// its attempt and this receipt atomically before reaching native setup.
pub(crate) async fn dispatch_create(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    issuer: String,
    receipt: Receipt,
    mut spec: LaunchSpec,
    context: CreateContext,
) -> Result<Receipt> {
    let quota_epoch = context.quota.as_ref().map(|_| {
        state
            .lock()
            .unwrap()
            .quota_native_authority_epoch(&context.authority)
    });
    let claim = log
        .claim(issuer.clone(), receipt.id)
        .await?
        .ok_or_else(|| anyhow!("Operation is no longer available for dispatch"))?;
    if let Some(authority_epoch) = quota_epoch {
        let (phase, result) = dispatch_quota_create(
            &state,
            &events,
            &log,
            &claim,
            &mut spec,
            &context,
            authority_epoch,
        )
        .await;
        return log
            .finish(issuer, claim.receipt.id, claim.token, phase.into(), result)
            .await;
    }
    let validation = state.lock().unwrap().resolve_task_launch(
        &context.authority,
        &mut spec,
        context.task_tools.as_deref(),
    );
    let (phase, result) = match validation {
        Err(error) => (
            "failed",
            json!({"code":error.downcast_ref::<crate::api_error::Error>().map(|e|e.code).unwrap_or("invalid_launch"),"message":error.to_string().chars().take(240).collect::<String>(),"effectStarted":false}),
        ),
        Ok(directory) => {
            let setup = if spec.worktree {
                crate::git::create_worktree(&directory).await.map(|path| {
                    spec.cwd = Some(crate::process::display_path(&path));
                    spec.worktree = false;
                })
            } else {
                Ok(())
            };
            match setup {
                Err(_) => (
                    "unknown",
                    json!({"code":"worktree_unconfirmed","message":"Inspect the repository before creating another worktree"}),
                ),
                Ok(()) => {
                    let launched = state.lock().unwrap().launch_authorized(
                        &context.authority,
                        &spec,
                        &events,
                        &claim.receipt.session_id,
                        context.task_tools.as_deref(),
                    );
                    match launched {
                        Ok(id) => ("created", json!({"sessionId":id,"taskResult":null})),
                        Err(_) => (
                            "unknown",
                            json!({"code":"launch_unconfirmed","message":"Inspect sessions and recovery before creating a new operation","reservedSessionId":claim.receipt.session_id,"directory":spec.cwd}),
                        ),
                    }
                }
            }
        }
    };
    log.finish(issuer, claim.receipt.id, claim.token, phase.into(), result)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn native_write_confirmation_distinguishes_true_false_closed_and_timeout() {
        let short = Duration::from_millis(1);
        let (sender, answer) = oneshot::channel();
        sender.send(true).unwrap();
        assert_eq!(write_confirmation(answer, short).await, Ok(()));

        let (sender, answer) = oneshot::channel();
        sender.send(false).unwrap();
        let failed = write_confirmation(answer, short).await.unwrap_err();
        assert_eq!(failed, WriteConfirmationFailure::Failed);

        let (sender, answer) = oneshot::channel();
        drop(sender);
        let closed = write_confirmation(answer, short).await.unwrap_err();
        assert_eq!(closed, WriteConfirmationFailure::Closed);

        let (sender, answer) = oneshot::channel();
        let timed_out = write_confirmation(answer, short).await.unwrap_err();
        drop(sender);
        assert_eq!(timed_out, WriteConfirmationFailure::Timeout);

        for (failure, code) in [
            (failed, "native_write_failed"),
            (closed, "native_write_closed"),
            (timed_out, "native_write_timeout"),
        ] {
            let error = failure.into_error();
            assert_eq!(
                error
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                code
            );
        }
    }

    #[test]
    fn write_diagnostics_preserve_unknown_effects_and_identify_paste_or_submit() {
        for (stage, label) in [
            (SubmissionStage::PasteFlush, "pasteFlush"),
            (SubmissionStage::SubmitFlush, "submitFlush"),
        ] {
            for failure in [
                WriteConfirmationFailure::Failed,
                WriteConfirmationFailure::Closed,
                WriteConfirmationFailure::Timeout,
            ] {
                let (phase, result) = submission_failure(failure.into_error(), true, stage);
                assert_eq!(phase, "unknown");
                assert_eq!(result["effectStarted"], true);
                assert_eq!(result["submissionStage"], label);
                assert!(result["taskResult"].is_null());
            }
        }
        let (phase, result) = submission_failure(
            crate::api_error::Error::new(
                "submission_preempted",
                "Submission was preempted before submit queue admission",
            )
            .into(),
            true,
            SubmissionStage::PasteDelay,
        );
        assert_eq!(phase, "unknown");
        assert_eq!(result["code"], "submission_preempted");
        assert_eq!(result["effectStarted"], true);
        assert_eq!(result["submissionStage"], "pasteDelay");
    }

    #[test]
    fn untyped_failure_retains_only_bounded_stage_and_safe_existing_message() {
        for (stage, label, queued) in [
            (SubmissionStage::Prepare, "prepare", false),
            (SubmissionStage::PasteFence, "pasteFence", false),
            (SubmissionStage::SubmitFence, "submitFence", true),
        ] {
            let (phase, result) = submission_failure(
                anyhow!("Private prompt or raw OS diagnostic must not be retained"),
                queued,
                stage,
            );
            assert_eq!(phase, if queued { "unknown" } else { "failed" });
            assert_eq!(
                result,
                json!({"code":"submission_unconfirmed","message":"Inspect the original receipt and terminal before another submission","effectStarted":queued,"taskResult":null,"submissionStage":label})
            );
        }
    }

    #[tokio::test]
    async fn control_write_failure_keeps_its_existing_untyped_unknown_projection() {
        let (sender, answer) = oneshot::channel();
        sender.send(false).unwrap();
        let error = flushed(answer).await.unwrap_err();
        assert!(error.downcast_ref::<crate::api_error::Error>().is_none());
        assert_eq!(error.to_string(), "Native terminal write was not confirmed");
    }
}
