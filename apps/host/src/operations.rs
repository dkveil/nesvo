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
            Self::Stop | Self::StopRunWorker => "stop",
        }
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
    match tokio::time::timeout(std::time::Duration::from_secs(5), answer).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(anyhow!("Native terminal write was not confirmed")),
    }
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
    let result = async {
        let (path, mut cancellation) = {
            let mut state = state.lock().unwrap();
            if let Some(before) = task_epoch {
                state.check_task_delivery(&session_id, &authority, before)?;
            }
            state.begin_submission(&session_id, reference, &prompt, &authority)?
        };
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
        flushed(answer).await?;
        // Keep paste and submit separate. Frameworks may debounce a paste event;
        // a human taking control in this interval cancels the Enter entirely.
        tokio::select! {
            _=tokio::time::sleep(std::time::Duration::from_millis(150))=>{},
            _=cancellation.changed()=>return Err(anyhow!("Submission was preempted")),
        }
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
        flushed(answer).await?;
        Ok::<_, anyhow::Error>(correlated)
    }
    .await;
    let (phase, result) = match result {
        Ok(correlated) => (
            "delivered",
            json!({"nativeWriteFlushed":true,"correlation":if correlated {"launchHook"} else {"unavailable"},"taskResult":null}),
        ),
        Err(error) => {
            let code = error
                .downcast_ref::<crate::api_error::Error>()
                .map(|e| e.code)
                .unwrap_or("submission_unconfirmed");
            let message = error
                .downcast_ref::<crate::api_error::Error>()
                .map(|_| error.to_string())
                .unwrap_or_else(|| {
                    "Inspect the original receipt and terminal before another submission".into()
                });
            (
                if queued { "unknown" } else { "failed" },
                json!({"code":code,"message":message,"effectStarted":queued,"taskResult":null}),
            )
        }
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
}
impl CreateContext {
    fn ordinary(authority: crate::caller::Authority) -> Self {
        Self {
            authority,
            task_tools: None,
        }
    }
    pub(crate) fn task(
        authority: crate::caller::Authority,
        task_tools: Option<Vec<String>>,
    ) -> Self {
        Self {
            authority,
            task_tools,
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
    let claim = log
        .claim(issuer.clone(), receipt.id)
        .await?
        .ok_or_else(|| anyhow!("Operation is no longer available for dispatch"))?;
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
