//! Owner constraints are append-only; handling acknowledgement is a separate act.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor, Scope},
    workflow_context as context,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Add {
        key: String,
        run_id: String,
        expected_revision: u64,
        text: String,
    },
    List {
        run_id: String,
        after: Option<u64>,
    },
    Acknowledge {
        key: String,
        run_id: String,
        expected_revision: u64,
        constraint_revision: u64,
    },
}
fn view(connection: &Connection, actor: &Actor, run: &str, after: u64) -> Result<Value> {
    let run_view = orchestration::run(connection, actor, run)?;
    let summary = context::summary(connection, run)?;
    if after
        > summary["revision"]
            .as_u64()
            .ok_or_else(|| anyhow!("Missing constraint revision"))?
    {
        return Err(Error::new("invalid_cursor", "Constraint cursor is ahead of this run").into());
    }
    let rows = context::records(connection, run)?;
    let rows = rows
        .into_iter()
        .filter(|r| r["revision"].as_u64().is_some_and(|n| n > after))
        .collect::<Vec<_>>();
    let more = rows.len() > 8;
    let records = rows.into_iter().take(8).collect::<Vec<_>>();
    let next = records
        .last()
        .and_then(|r| r["revision"].as_u64())
        .unwrap_or(after);
    Ok(
        json!({"run":run_view,"constraints":summary,"records":records,"nextCursor":next,"hasMore":more}),
    )
}
pub fn execute(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
) -> Result<Value> {
    let (key, run, revision) = match &request {
        Request::List { run_id, after } => {
            return view(connection, &actor, run_id, after.unwrap_or(0));
        }
        Request::Add {
            key,
            run_id,
            expected_revision,
            ..
        }
        | Request::Acknowledge {
            key,
            run_id,
            expected_revision,
            ..
        } => (key, run_id, *expected_revision),
    };
    orchestration::run(connection, &actor, run)?;
    if matches!(request, Request::Add { .. }) && !matches!(actor.scope, Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the human owner may append manual constraints",
        )
        .into());
    }
    orchestration::validate_key(key)?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"constraints","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, run)?;
    if let Some(result) = orchestration::replay(&transaction, &actor, key, &digest)? {
        return Ok(result);
    }
    orchestration::mutation_capacity(&transaction)?;
    if current["revision"] != revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect current constraints and revision",
        )
        .into());
    }
    let policy = context::summary(&transaction, run)?;
    let kind = match &request {
        Request::Add { text, .. } => {
            if text.trim().is_empty()
                || text.len() > 1024
                || text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                || serde_json::to_vec(text)?.len() > 2048
            {
                return Err(Error::new("invalid_argument","Manual constraint needs literal UTF-8 text within 1024 bytes / 2048 encoded bytes").into());
            }
            let count: i64 =
                transaction.query_row("SELECT count(*) FROM workflow_constraints", [], |r| {
                    r.get(0)
                })?;
            if policy["revision"].as_u64().is_none_or(|n| n >= 16) || count >= 4096 {
                return Err(Error::new(
                    "busy",
                    "Constraint retention is full; no owner text was discarded",
                )
                .into());
            }
            let next = policy["revision"]
                .as_i64()
                .ok_or_else(|| anyhow!("Missing constraint revision"))?
                + 1;
            transaction.execute("INSERT INTO workflow_constraints(id,run_id,revision,text,issuer,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![hex::encode(crate::wire::random::<16>()),run,next,text,actor.issuer,now as i64])?;
            // Never silently keep scheduling an immutable plan after its owner
            // changes the context. Existing model responses may still finish.
            transaction.execute("UPDATE workflow_executors SET enabled=0,generation=generation+1,phase='paused',reason='constraints_changed' WHERE run_id=?1 AND enabled=1",[run])?;
            transaction.execute("UPDATE workflow_wake_policies SET enabled=0,generation=generation+1,phase='paused',reason='constraints_changed' WHERE run_id=?1 AND enabled=1",[run])?;
            transaction.execute("UPDATE workflow_deliveries SET phase='paused',blocker='constraints_changed' WHERE run_id=?1 AND phase='queued'",[run])?;
            "run.constraints_added"
        }
        Request::Acknowledge {
            constraint_revision,
            ..
        } => {
            if policy["revision"] != *constraint_revision {
                return Err(Error::new(
                    "revision_conflict",
                    "Acknowledge the exact current constraint revision after reading it",
                )
                .into());
            }
            if policy["pending"] != true {
                return Err(Error::new(
                    "context_state_conflict",
                    "This constraint revision is already acknowledged",
                )
                .into());
            }
            transaction.execute("INSERT INTO workflow_context_ack(run_id,revision,issuer,at) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,issuer=excluded.issuer,at=excluded.at",params![run,*constraint_revision as i64,actor.issuer,now as i64])?;
            "run.constraints_acknowledged"
        }
        _ => return Err(anyhow!("Unexpected constraint mutation")),
    };
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [run],
    )?;
    let cursor = append_transaction(
        &transaction,
        vec![Observation {
            session_id: current["coordinatorSessionId"].as_str().map(str::to_owned),
            kind,
            at: now,
            payload: json!({"runId":run,"constraintRevision":context::summary(&transaction,run)?["revision"]}),
        }],
    )?;
    let mut result = view(&transaction, &actor, run, 0)?;
    result["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, key, &digest, &result)?;
    transaction.commit()?;
    Ok(result)
}
