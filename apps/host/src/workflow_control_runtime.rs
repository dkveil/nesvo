//! Native adapter for durable run control. Reads/replays never dispatch effects.
use crate::{
    caller::Authority,
    event_log::Service,
    orchestration::Actor,
    sessions::State,
    workflow_controls::{Claim, Reply, Request, Work},
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
                        break;
                    }
                    for target in targets {
                        let receipt = crate::operations::control(
                            state.clone(),
                            log.clone(),
                            actor.issuer.clone(),
                            target.key,
                            target.session_id.clone(),
                            crate::operations::ControlAction::StopRunWorker,
                            authority.clone(),
                        )
                        .await
                        .ok();
                        log.run_control(Work::Finish {
                            claim: Claim {
                                id: claim.id.clone(),
                                token: claim.token.clone(),
                            },
                            session_id: target.session_id,
                            receipt,
                        })
                        .await?;
                    }
                }
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
