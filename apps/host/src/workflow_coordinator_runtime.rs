use crate::{
    api_error::Error,
    caller::Authority,
    event_log::Service,
    orchestration::{Actor, Scope},
    sessions::State,
    workflow_coordinator::{Request, Work},
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub async fn execute(
    state: Arc<Mutex<State>>,
    log: Service,
    actor: Actor,
    authority: Authority,
    request: Request,
) -> Result<Value> {
    if !matches!(actor.scope, Scope::Owner) || !matches!(authority, Authority::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the owner may replace a run coordinator binding",
        )
        .into());
    }
    if let Some(view) = log
        .coordinator(Work::Lookup {
            actor: actor.clone(),
            request: request.clone(),
        })
        .await?
    {
        return Ok(view);
    }
    let _permit = state.lock().unwrap().native_run_permit(&request.run_id)?;
    let current = log
        .workflow(
            actor.clone(),
            crate::orchestration::Request::Get {
                run_id: request.run_id.clone(),
            },
        )
        .await?;
    if current["run"]["revision"] != request.expected_revision
        || current["run"]["coordinatorSessionId"] != json!(request.expected_coordinator_session_id)
    {
        return Err(Error::new(
            "revision_conflict",
            "Inspect the current coordinator and run revision before recovery",
        )
        .into());
    }
    let facts = state.lock().unwrap().coordinator_rebind_facts(
        request.expected_coordinator_session_id.as_deref(),
        &request.coordinator_session_id,
    )?;
    log.coordinator(Work::Apply {
        actor,
        request,
        facts,
    })
    .await?
    .ok_or_else(|| {
        anyhow!("Coordinator binding outcome was not confirmed; recover the original workflow key")
    })
}
