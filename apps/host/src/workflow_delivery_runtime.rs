use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::Actor,
    sessions::State,
    workflow_delivery::{Pending, Reply, Request, Work},
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
    execute_guarded(state, log, actor, authority, request, None).await
}
pub async fn execute_guarded(
    state: Arc<Mutex<State>>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
    executor: Option<(crate::workflow_executor::Guard, u64)>,
) -> Result<Value> {
    let reuse = match (&request, &executor) {
        (Request::Queue { session_id, .. }, None) => session_id.clone(),
        _ => None,
    };
    let (before, controlled, live) = {
        let state = state.lock().unwrap();
        let epoch = state.human_control_epoch();
        let live = reuse.map(|session| live_session(&state, &session, &authority, epoch));
        (epoch, state.human_controlled_sessions(), live)
    };
    let before = executor
        .as_ref()
        .map_or(before, |(_, epoch)| before.min(*epoch));
    let Reply::Prepared { view, pending } = log
        .delivery(match (executor, live) {
            (Some((guard, _)), _) => Work::PrepareForExecutor {
                actor: actor.clone(),
                request,
                guard,
            },
            (None, Some(live)) => Work::Reuse {
                actor: actor.clone(),
                request,
                live,
            },
            (None, None) => Work::Prepare {
                actor: actor.clone(),
                request,
            },
        })
        .await?
    else {
        return Err(anyhow!("Unexpected task delivery reply"));
    };
    if let Some(pending) = pending {
        let was_controlled = controlled.contains(&pending.session_id);
        tokio::spawn(async move {
            let id = pending.id.clone();
            if deliver(
                state,
                log.clone(),
                actor.issuer,
                authority,
                pending,
                before,
                was_controlled,
            )
            .await
            .is_err()
            {
                let _ = log
                    .delivery(Work::Abandon {
                        id: id.clone(),
                        phase: "failed",
                        code: "delivery_unavailable".into(),
                    })
                    .await;
                let _ = log.delivery(Work::Finish { id }).await;
            }
        });
    }
    Ok(view)
}
async fn deliver(
    state: Arc<Mutex<State>>,
    log: Service,
    issuer: String,
    source: Authority,
    pending: Pending,
    before: u64,
    was_controlled: bool,
) -> Result<()> {
    if was_controlled {
        log.delivery(Work::Abandon {
            id: pending.id,
            phase: "paused",
            code: "control_busy".into(),
        })
        .await?;
        return Ok(());
    }
    let mut changed = log.subscribe();
    loop {
        let Reply::Current { queued: true } = log
            .delivery(Work::Inspect {
                id: pending.id.clone(),
            })
            .await?
        else {
            return Ok(());
        };
        if crate::status::now_millis() >= pending.deadline_at {
            log.delivery(Work::Abandon {
                id: pending.id,
                phase: "expired",
                code: "readiness_timeout".into(),
            })
            .await?;
            return Ok(());
        }
        let prepared = (|| -> Result<_> {
            let mut state = state.lock().unwrap();
            let authority =
                state.workflow_launch_authority(&source, pending.coordinator.as_deref())?;
            state.check_task_delivery(&pending.session_id, &authority, before)?;
            let permit = state.native_run_permit(&pending.run_id)?;
            Ok((
                authority,
                permit,
                state.conversation_id(&pending.session_id),
            ))
        })();
        let result: Result<()> = match prepared {
            Ok((authority, _permit, conversation)) => match log
                .delivery(Work::Claim {
                    id: pending.id.clone(),
                    conversation,
                })
                .await
            {
                Ok(Reply::Claimed(Some(dispatch))) => {
                    let _ = crate::operations::dispatch_send(
                        state.clone(),
                        log.clone(),
                        issuer,
                        dispatch.receipt,
                        dispatch.prompt,
                        authority,
                        Some(before),
                    )
                    .await;
                    log.delivery(Work::Finish { id: pending.id }).await?;
                    return Ok(());
                }
                Ok(Reply::Claimed(None)) => return Ok(()),
                Ok(_) => return Err(anyhow!("Unexpected task delivery claim")),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            let code = error
                .downcast_ref::<crate::api_error::Error>()
                .map(|e| e.code)
                .unwrap_or("delivery_unavailable");
            if matches!(
                code,
                "agent_not_ready"
                    | "submission_pending"
                    | "lifecycle_pending"
                    | "decision_pending"
                    | "busy"
            ) {
                log.delivery(Work::Note {
                    id: pending.id.clone(),
                    code: code.into(),
                })
                .await?;
            } else {
                let phase = if matches!(
                    code,
                    "control_busy" | "unsafe_draft" | "scope_revoked" | "host_stopping"
                ) {
                    "paused"
                } else {
                    "failed"
                };
                log.delivery(Work::Abandon {
                    id: pending.id,
                    phase,
                    code: code.into(),
                })
                .await?;
                return Ok(());
            }
        }
        changed.borrow_and_update();
        let remaining = pending
            .deadline_at
            .saturating_sub(crate::status::now_millis())
            .min(1000);
        tokio::select! {
            _=tokio::time::sleep(std::time::Duration::from_millis(remaining))=>{},
            result=changed.changed()=>{if result.is_err(){return Ok(());}},
        }
    }
}
fn live_session(
    state: &State,
    session: &str,
    authority: &Authority,
    epoch: u64,
) -> crate::workflow_session_reuse::Live {
    crate::workflow_session_reuse::Live {
        blocker: state
            .check_task_delivery(session, authority, epoch)
            .err()
            .map(|error| {
                error
                    .downcast_ref::<crate::api_error::Error>()
                    .map_or("session_busy", |error| error.code)
            }),
        conversation: state.conversation_id(session),
    }
}
