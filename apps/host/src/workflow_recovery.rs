//! Resolve authenticated recovery bindings without adopting or replaying effects.
use crate::{
    api_error::Error,
    orchestration::{Actor, Scope},
};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub fn read(
    connection: &Connection,
    actor: &Actor,
    run: Option<&str>,
    offset: usize,
    expected_digest: Option<&str>,
) -> Result<Value> {
    let scope = match actor.scope {
        Scope::Owner => "owner",
        Scope::Coordinator(_) => "coordinator",
        Scope::Worker(_) => "worker",
    };
    let mut result = json!({"scope":scope,"bound":false,"selectionRequired":false,"nativeEffectsRestored":false});
    if let Scope::Worker(session) = &actor.scope {
        if run.is_some() || offset != 0 || expected_digest.is_some() {
            return Err(Error::new("forbidden","Worker recovery only reads its own current task, without a run selector or parent manifest cursor").into());
        }
        let bound: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_attempts WHERE session_id=?1)",
            [session],
            |r| r.get(0),
        )?;
        if bound {
            result["taskContext"] = crate::workflow_attempts::context(connection, actor, None)?;
            result["bound"] = true.into();
        }
        return Ok(result);
    }
    let run = match run {
        Some(run) => run.to_owned(),
        None => {
            let Scope::Coordinator(session) = &actor.scope else {
                return Err(Error::new(
                    "invalid_argument",
                    "Owner recovery requires an explicit run ID; UI focus is never a binding",
                )
                .into());
            };
            // Do not pick the newest run or use names/UI focus as authority.
            let mut query=connection.prepare("SELECT id,title,state FROM workflow_runs WHERE coordinator_id=?1 ORDER BY created_at,id LIMIT 9")?;
            let runs=query.query_map(params![session],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            if runs.len() != 1 {
                if offset != 0 || expected_digest.is_some() {
                    return Err(Error::new(
                        "invalid_cursor",
                        "Select an exact run before continuing recovery pages",
                    )
                    .into());
                }
                result["selectionRequired"] = (!runs.is_empty()).into();
                result["hasMoreRuns"] = (runs.len() > 8).into();
                result["runs"] = runs.into_iter().take(8).collect::<Vec<_>>().into();
                return Ok(result);
            }
            runs[0]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing recovery run identity"))?
                .to_owned()
        }
    };
    result["page"] =
        crate::workflow_checkpoints::current(connection, actor, &run, offset, expected_digest)?;
    result["bound"] = true.into();
    Ok(result)
}
