//! Idempotent launch flow. Durable intent precedes native/Git effects.
use crate::{
    event_log::Service,
    jobs::LaunchSpec,
    receipts::Receipt,
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub async fn create(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
    issuer: String,
    key: String,
    mut spec: LaunchSpec,
) -> Result<Receipt> {
    let accepted = log
        .accept(issuer.clone(), key, serde_json::to_value(&spec)?)
        .await?;
    if !accepted.is_new {
        return Ok(accepted.receipt);
    }
    let claim = log
        .claim(issuer.clone(), accepted.receipt.id.clone())
        .await?
        .ok_or_else(|| anyhow!("Operation is no longer available for dispatch"))?;
    let validation = state.lock().unwrap().validate_launch(&spec);
    let (phase, result) = match validation {
        Err(error) => (
            "failed",
            json!({"code":"invalid_launch","message":error.to_string().chars().take(240).collect::<String>(),"effectStarted":false}),
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
                    let launched = state.lock().unwrap().launch_reserved(
                        &spec,
                        &events,
                        &claim.receipt.session_id,
                    );
                    match launched {
                        Ok(id) => {
                            state.lock().unwrap().broadcast_list();
                            ("created", json!({"sessionId":id,"taskResult":null}))
                        }
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
