//! Native adapter for durable run control. Reads/replays never dispatch effects.
use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::{Actor, Scope},
    sessions::State,
    workflow_controls::{Claim, Kind, Reply, Request, Work},
};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::sync::{Arc, Mutex};

async fn pump(
    state: &Arc<Mutex<State>>,
    log: &Service,
    actor: &Actor,
    authority: &Authority,
    claim: Claim,
    action: crate::operations::ControlAction,
) -> Result<()> {
    loop {
        let Reply::Targets(targets) = log
            .run_control(Work::Claim {
                claim: claim.clone(),
            })
            .await?
        else {
            return Err(anyhow!("Unexpected control dispatch page"));
        };
        if targets.is_empty() {
            return Ok(());
        }
        for target in targets {
            let receipt = crate::operations::control(
                state.clone(),
                log.clone(),
                actor.issuer.clone(),
                target.key,
                target.session_id.clone(),
                action,
                authority.clone(),
            )
            .await
            .ok();
            log.run_control(Work::Finish {
                claim: claim.clone(),
                session_id: target.session_id,
                receipt,
            })
            .await?;
        }
    }
}

async fn run_permit(
    state: &Arc<Mutex<State>>,
    run_id: &str,
) -> Result<tokio::sync::OwnedMutexGuard<()>> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let attempt = state.lock().unwrap().native_run_permit(run_id);
        match attempt {
            Ok(permit) => return Ok(permit),
            Err(error)
                if error
                    .downcast_ref::<crate::api_error::Error>()
                    .is_some_and(|error| error.code == "busy")
                    && tokio::time::Instant::now() < deadline =>
            {
                let next = tokio::time::Instant::now() + std::time::Duration::from_millis(25);
                tokio::time::sleep_until(next.min(deadline)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Stop only the worker frozen by one due job generation. Existing controls are
/// observed, never reclaimed, and a blocked/unknown claim is not redispatched.
pub async fn timeout_job(
    state: Arc<Mutex<State>>,
    log: Service,
    timeout: crate::job_timeouts::Claim,
) -> Result<Value> {
    // The durable timeout claim has already fenced reports/input/launches. An
    // earlier admitted native launch may leave its critical section first.
    let _permit = run_permit(&state, &timeout.identity.run_id).await?;
    let actor = Actor {
        issuer: timeout.issuer.clone(),
        scope: Scope::Owner,
    };
    let Reply::Prepared { view, claim } = log
        .run_control(Work::PrepareJobTimeout {
            claim: timeout.clone(),
        })
        .await?
    else {
        return Err(crate::api_error::Error::new(
            "job_execution_timeout",
            "Automatic timeout cleanup is blocked; inspect the retained timeout reason and existing owner control",
        )
        .into());
    };
    if let Some(claim) = claim {
        pump(
            &state,
            &log,
            &actor,
            &Authority::Owner,
            claim,
            crate::operations::ControlAction::StopJobTimeoutWorker,
        )
        .await?;
    }
    let control_id = view["control"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Missing exact timeout control identity"))?
        .to_owned();
    execute(
        state,
        log,
        actor,
        Authority::Owner,
        Request::Get {
            run_id: timeout.identity.run_id,
            control_id,
            offset: Some(0),
        },
    )
    .await
}

/// Cancel the exact job-bound run through its ordinary native control guards.
/// The persisted owner issuer and stable control key are supplied by job intent,
/// never inferred from a focused session. An accepted key is inspected only:
/// neither replay nor host recovery obtains another physical dispatch claim.
pub async fn cancel_job(
    state: Arc<Mutex<State>>,
    log: Service,
    issuer: String,
    run_id: String,
    control_key: String,
) -> Result<Value> {
    let actor = Actor {
        issuer,
        scope: Scope::Owner,
    };
    // Target enumeration must follow any admitted physical launch or delivery.
    // Keep the permit through preparation and dispatch, as ordinary control does.
    let _permit = run_permit(&state, &run_id).await?;
    let accepted = match log
        .workflow(
            actor.clone(),
            crate::orchestration::Request::Mutation {
                key: control_key.clone(),
            },
        )
        .await
    {
        Ok(view) => view,
        Err(error)
            if error
                .downcast_ref::<crate::api_error::Error>()
                .is_some_and(|error| error.code == "mutation_not_found") =>
        {
            let current = log
                .workflow(
                    actor.clone(),
                    crate::orchestration::Request::Get {
                        run_id: run_id.clone(),
                    },
                )
                .await?;
            let expected_revision = current["run"]["revision"]
                .as_u64()
                .ok_or_else(|| anyhow!("Missing current run revision"))?;
            let Reply::Prepared { view, claim } = log
                .run_control(Work::Prepare {
                    actor: actor.clone(),
                    request: Request::Start {
                        key: control_key,
                        run_id: run_id.clone(),
                        expected_revision,
                        kind: Kind::Cancel,
                    },
                })
                .await?
            else {
                return Err(anyhow!("Unexpected job control preparation reply"));
            };
            if let Some(claim) = claim {
                pump(
                    &state,
                    &log,
                    &actor,
                    &Authority::Owner,
                    claim,
                    crate::operations::ControlAction::StopRunWorker,
                )
                .await?;
            }
            view
        }
        Err(error) => return Err(error),
    };
    if accepted["run"]["id"] != run_id || accepted["control"]["kind"] != "cancel" {
        return Err(crate::api_error::Error::new(
            "idempotency_conflict",
            "Job control key belongs to another accepted workflow intent",
        )
        .into());
    }
    let control_id = accepted["control"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Missing accepted job control identity"))?
        .to_owned();
    execute(
        state,
        log,
        actor,
        Authority::Owner,
        Request::Get {
            run_id,
            control_id,
            offset: Some(0),
        },
    )
    .await
}

pub async fn execute(
    state: Arc<Mutex<State>>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
) -> Result<Value> {
    match request {
        Request::Start { ref run_id, .. } => {
            log.workflow(
                actor.clone(),
                crate::orchestration::Request::Get {
                    run_id: run_id.clone(),
                },
            )
            .await?;
            let _permit = state.lock().unwrap().native_run_permit(run_id)?;
            let Reply::Prepared { view, claim } = log
                .run_control(Work::Prepare {
                    actor: actor.clone(),
                    request,
                })
                .await?
            else {
                return Err(anyhow!("Unexpected run control preparation reply"));
            };
            if let Some(claim) = claim {
                pump(
                    &state,
                    &log,
                    &actor,
                    &authority,
                    claim,
                    crate::operations::ControlAction::StopRunWorker,
                )
                .await?;
            }
            // This is the immutable acceptance view, also recovered by its key.
            // Current per-target receipts/exit proof are read explicitly below.
            Ok(view)
        }
        Request::Get {
            run_id,
            control_id,
            offset,
        } => {
            let offset = offset.unwrap_or(0);
            let read = || Work::Read {
                actor: actor.clone(),
                run_id: run_id.clone(),
                control_id: control_id.clone(),
                offset,
            };
            let Reply::View(view) = log.run_control(read()).await? else {
                return Err(anyhow!("Unexpected control inspection reply"));
            };
            let (mut exited, mut unavailable) = (Vec::new(), Vec::new());
            {
                let state = state.lock().unwrap();
                for target in view["targets"]
                    .as_array()
                    .ok_or_else(|| anyhow!("Missing control target page"))?
                {
                    if target["phase"] == "exited" {
                        continue;
                    }
                    let id = target["sessionId"]
                        .as_str()
                        .ok_or_else(|| anyhow!("Missing control target identity"))?;
                    match state.run_control_process_running(id) {
                        Some(false) => exited.push(id.to_owned()),
                        None => unavailable.push(id.to_owned()),
                        _ => {}
                    }
                }
            }
            if !exited.is_empty() || !unavailable.is_empty() {
                log.run_control(Work::Observe {
                    actor: actor.clone(),
                    run_id: run_id.clone(),
                    control_id: control_id.clone(),
                    exited,
                    unavailable,
                })
                .await?;
                let Reply::View(view) = log.run_control(read()).await? else {
                    return Err(anyhow!("Unexpected control inspection reply"));
                };
                return Ok(view);
            }
            Ok(view)
        }
    }
}
