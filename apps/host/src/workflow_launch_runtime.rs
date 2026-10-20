//! Native task launch after atomic run/attempt/receipt admission.
use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::Actor,
    sessions::{PtyEvent, State},
    workflow_launches::{Reply, Request, Work},
};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub async fn execute(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
) -> Result<Value> {
    execute_guarded(state, events, log, actor, authority, request, None).await
}
pub async fn execute_guarded(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
    guard: Option<crate::workflow_executor::Guard>,
) -> Result<Value> {
    log.workflow(
        actor.clone(),
        crate::orchestration::Request::Get {
            run_id: request.run_id.clone(),
        },
    )
    .await?;
    let mut run_permit = Some(state.lock().unwrap().native_run_permit(&request.run_id)?);
    let Reply::Prepared { view, dispatch } = log
        .launch(match guard {
            Some(guard) => Work::PrepareForExecutor {
                actor: actor.clone(),
                request,
                guard,
            },
            None => Work::Prepare {
                actor: actor.clone(),
                request,
            },
        })
        .await?
    else {
        return Err(anyhow!("Unexpected launch preparation reply"));
    };
    if let Some(dispatch) = dispatch {
        // A retained quota continuation reacquires this same physical fence
        // before effects, but must release it while waiting for fresh evidence
        // so an owner can stop or otherwise control the original run.
        if dispatch.quota.is_some() {
            drop(run_permit.take());
        }
        let authority = state
            .lock()
            .unwrap()
            .workflow_launch_authority(&authority, dispatch.coordinator.as_deref());
        match authority {
            Ok(authority) => {
                // The ordinary native receipt retains any rejection/unknown
                // effect. The workflow reply remains its immutable acceptance.
                let _ = crate::operations::dispatch_create(
                    state,
                    events,
                    log.clone(),
                    actor.issuer,
                    dispatch.receipt.clone(),
                    dispatch.spec,
                    crate::operations::CreateContext::task(
                        authority,
                        dispatch.selected_tools,
                        dispatch.quota,
                    ),
                )
                .await;
            }
            Err(error) => {
                // No native setup began; make that refusal recoverable under
                // the preallocated native identity before releasing run capacity.
                if let Some(claim) = log
                    .claim(actor.issuer.clone(), dispatch.receipt.id.clone())
                    .await?
                {
                    log.finish(actor.issuer,claim.receipt.id,claim.token,"failed".into(),serde_json::json!({"code":error.downcast_ref::<crate::api_error::Error>().map(|e|e.code).unwrap_or("launch_refused"),"effectStarted":false})).await?;
                }
            }
        }
        log.launch(Work::Finish {
            attempt_id: dispatch.attempt_id,
            receipt_id: dispatch.receipt.id,
        })
        .await?;
    }
    Ok(view)
}
