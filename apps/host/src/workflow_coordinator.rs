//! Explicit owner metadata rebinding. Native worker authority/effects are not adopted.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor, Scope},
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub key: String,
    pub run_id: String,
    pub expected_revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub expected_coordinator_session_id: Option<String>,
    pub coordinator_session_id: String,
}
#[derive(Clone)]
pub struct Location {
    pub directory: String,
    pub group_id: Option<String>,
}
pub struct Facts {
    pub target_id: String,
    pub target: Location,
    pub previous: Option<Location>,
}
pub enum Work {
    Lookup {
        actor: Actor,
        request: Request,
    },
    Apply {
        actor: Actor,
        request: Request,
        facts: Facts,
    },
}
fn digest(actor: &Actor, request: &Request) -> Result<String> {
    if !matches!(actor.scope, Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the owner may replace a run coordinator binding",
        )
        .into());
    }
    for id in [
        &request.key,
        &request.run_id,
        &request.coordinator_session_id,
    ]
    .into_iter()
    .chain(request.expected_coordinator_session_id.iter())
    {
        orchestration::validate_key(id)?;
    }
    Ok(hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"coordinator","request":request}))?,
        )
        .as_ref(),
    ))
}
pub fn summary(connection: &Connection, run: &str) -> Result<Value> {
    let result:Option<Value>=connection.query_row("SELECT coordinator_id,previous_id,directory,group_id,generation,source,updated_at FROM workflow_coordinator_bindings WHERE run_id=?1",[run],|r|Ok(json!({"sessionId":r.get::<_,String>(0)?,"previousSessionId":r.get::<_,Option<String>>(1)?,"directory":r.get::<_,String>(2)?,"groupId":r.get::<_,Option<String>>(3)?,"generation":r.get::<_,i64>(4)?,"source":r.get::<_,String>(5)?,"updatedAt":r.get::<_,i64>(6)?,"nativeEffectsRestored":false,"workerAuthorityRestored":false}))).optional()?;
    Ok(result.unwrap_or(Value::Null))
}
fn source(
    connection: &Connection,
    request: &Request,
    facts: &Facts,
) -> Result<(Option<Location>, &'static str)> {
    if request.expected_coordinator_session_id.is_none() {
        return Ok((None, "unbound"));
    }
    if let Some(location) = &facts.previous {
        return Ok((Some(location.clone()), "retainedSession"));
    }
    let old = request
        .expected_coordinator_session_id
        .as_deref()
        .ok_or_else(|| anyhow!("Missing previous coordinator"))?;
    let previous = summary(connection, &request.run_id)?;
    if previous["sessionId"] == old {
        return Ok((
            Some(Location {
                directory: previous["directory"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Missing binding directory"))?
                    .into(),
                group_id: previous["groupId"].as_str().map(str::to_owned),
            }),
            "previousBinding",
        ));
    }
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        let text: Option<String> = connection
            .query_row("SELECT spec FROM recovery WHERE id=?1", [old], |r| r.get(0))
            .optional()?;
        if let Some(text) = text {
            let spec: crate::jobs::LaunchSpec = serde_json::from_str(&text).map_err(|_| {
                Error::new(
                    "coordinator_context_missing",
                    "Previous coordinator recovery record is malformed",
                )
            })?;
            if spec.role == crate::caller::Role::Coordinator
                && let Some(directory) = spec.cwd
            {
                return Ok((
                    Some(Location {
                        directory,
                        group_id: spec.group_id,
                    }),
                    "recoveryRecord",
                ));
            }
        }
    }
    Err(Error::new("coordinator_context_missing","Previous coordinator workspace/group evidence is unavailable; do not infer it from names or UI focus").into())
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Option<Value>> {
    let (actor, request, facts) = match work {
        Work::Lookup { actor, request } => (actor, request, None),
        Work::Apply {
            actor,
            request,
            facts,
        } => (actor, request, Some(facts)),
    };
    let fingerprint = digest(&actor, &request)?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, &request.run_id)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, &request.key, &fingerprint)? {
        return Ok(Some(view));
    }
    let Some(facts) = facts else {
        return Ok(None);
    };
    if current["revision"] != request.expected_revision
        || current["coordinatorSessionId"] != json!(request.expected_coordinator_session_id)
    {
        return Err(Error::new(
            "revision_conflict",
            "Run coordinator/revision changed; inspect before rebinding",
        )
        .into());
    }
    if facts.target_id != request.coordinator_session_id
        || request.expected_coordinator_session_id.as_deref() == Some(&facts.target_id)
    {
        return Err(Error::new(
            "invalid_argument",
            "Select a different verified native coordinator",
        )
        .into());
    }
    let (previous, source) = source(&transaction, &request, &facts)?;
    if previous.is_some_and(|old| {
        old.directory != facts.target.directory || old.group_id != facts.target.group_id
    }) {
        return Err(Error::new(
            "coordinator_context_mismatch",
            "Replacement coordinator must use the retained canonical workspace and group",
        )
        .into());
    }
    orchestration::mutation_capacity(&transaction)?;
    let generation =
        crate::workflow_context::coordinator_generation(&transaction, &request.run_id)?
            .checked_add(1)
            .filter(|g| *g <= 9_007_199_254_740_991)
            .ok_or_else(|| anyhow!("Coordinator generation exhausted"))?;
    transaction.execute(
        "UPDATE workflow_runs SET coordinator_id=?2,revision=revision+1 WHERE id=?1",
        params![request.run_id, request.coordinator_session_id],
    )?;
    transaction.execute("INSERT INTO workflow_coordinator_bindings(run_id,coordinator_id,previous_id,directory,group_id,generation,source,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(run_id) DO UPDATE SET coordinator_id=excluded.coordinator_id,previous_id=excluded.previous_id,directory=excluded.directory,group_id=excluded.group_id,generation=excluded.generation,source=excluded.source,updated_at=excluded.updated_at",params![request.run_id,request.coordinator_session_id,request.expected_coordinator_session_id,facts.target.directory,facts.target.group_id,generation,source,now as i64])?;
    // Invalidate every old pump generation, even an already disabled policy.
    transaction.execute("UPDATE workflow_executors SET enabled=0,generation=generation+1,phase='paused',reason='coordinator_changed' WHERE run_id=?1",[&request.run_id])?;
    transaction.execute("UPDATE workflow_wake_policies SET enabled=0,generation=generation+1,phase='paused',reason='coordinator_changed',coordinator_id=?2 WHERE run_id=?1",params![request.run_id,request.coordinator_session_id])?;
    transaction.execute("UPDATE workflow_deliveries SET phase='paused',blocker='coordinator_changed' WHERE run_id=?1 AND phase='queued'",[&request.run_id])?;
    let cursor = append_transaction(
        &transaction,
        vec![Observation {
            session_id: Some(request.coordinator_session_id.clone()),
            kind: "run.coordinator_rebound",
            at: now,
            payload: json!({"runId":request.run_id,"previousSessionId":request.expected_coordinator_session_id,"sessionId":request.coordinator_session_id,"generation":generation}),
        }],
    )?;
    let mut view = orchestration::view(&transaction, &actor, &request.run_id)?;
    view["cursor"] = cursor.into();
    view["nativeEffectsRestored"] = false.into();
    view["workerAuthorityRestored"] = false.into();
    orchestration::remember(&transaction, &actor, &request.key, &fingerprint, &view)?;
    transaction.commit()?;
    Ok(Some(view))
}
