//! Run admission and native create identities commit before process setup.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    jobs::LaunchSpec,
    launchers::Program,
    orchestration::{self, Actor},
    receipts::Receipt,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Workspace {
    Shared,
    Worktree,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub program: Program,
    pub workspace: Workspace,
    pub harness: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub key: String,
    pub run_id: String,
    pub task_id: String,
    pub expected_revision: u64,
    pub profile: Profile,
}
pub enum Work {
    PrepareForExecutor {
        actor: Actor,
        request: Request,
        guard: crate::workflow_executor::Guard,
    },
    Prepare {
        actor: Actor,
        request: Request,
    },
    Finish {
        attempt_id: String,
        receipt_id: String,
    },
}
pub struct Dispatch {
    pub spec: LaunchSpec,
    pub receipt: Receipt,
    pub coordinator: Option<String>,
    pub attempt_id: String,
}
pub enum Reply {
    Prepared {
        view: Value,
        dispatch: Option<Box<Dispatch>>,
    },
    Done,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_launches(attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),operation_key TEXT NOT NULL,workspace TEXT NOT NULL,created_at INTEGER NOT NULL);")?;
    Ok(())
}
fn event(
    transaction: &Transaction<'_>,
    run: &str,
    attempt: &str,
    kind: &'static str,
    now: u64,
) -> Result<u64> {
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run],
        |row| row.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            kind,
            at: now,
            payload: json!({"runId":run,"attemptId":attempt}),
        }],
    )
}
pub fn summary(connection: &Connection, attempt: &str) -> Result<Value> {
    let row: Option<(String,String,String,String,String,i64,String)> = connection.query_row("SELECT l.operation_id,l.operation_key,o.phase,o.session_id,l.workspace,l.created_at,o.result FROM workflow_launches l JOIN operation_receipts o ON o.id=l.operation_id WHERE l.attempt_id=?1",[attempt],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional()?;
    let Some((receipt, key, phase, session, workspace, created, result)) = row else {
        return Ok(Value::Null);
    };
    let result: Value = serde_json::from_str(&result)?;
    Ok(
        json!({"attemptId":attempt,"receiptId":receipt,"operationKey":key,"phase":phase,"sessionId":session,"workspace":workspace,"createdAt":created,"code":result["code"],"effectStarted":result["effectStarted"],"directory":result["directory"]}),
    )
}
pub fn recover(connection: &mut Connection) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let pending = {
        let mut statement=transaction.prepare("SELECT a.id,t.run_id FROM workflow_attempts a JOIN workflow_launches l ON l.attempt_id=a.id JOIN workflow_tasks t ON t.id=a.task_id WHERE a.state='launching'")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (attempt, run) in pending {
        let launch = summary(&transaction, &attempt)?;
        let state = if launch["phase"] == "failed" && launch["effectStarted"] == false {
            "launchFailed"
        } else {
            "launchUnknown"
        };
        transaction.execute(
            "UPDATE workflow_attempts SET state=?2 WHERE id=?1",
            params![attempt, state],
        )?;
        transaction.execute(
            "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
            [&run],
        )?;
        event(
            &transaction,
            &run,
            &attempt,
            "run.launch_recovered",
            crate::status::now_millis(),
        )?;
    }
    transaction.commit()?;
    Ok(())
}
fn prepare(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
    executor: Option<crate::workflow_executor::Guard>,
) -> Result<Reply> {
    orchestration::validate_key(&request.key)?;
    // Refresh independently so a rejected reservation still latches exhaustion.
    orchestration::run(connection, &actor, &request.run_id)?;
    crate::workflow_budget::refresh(connection, &request.run_id, now)?;
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"launch","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, &request.run_id)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, &request.key, &fingerprint)? {
        return Ok(Reply::Prepared {
            view,
            dispatch: None,
        });
    }
    if let Some(guard) = &executor {
        crate::workflow_executor::guard_run(&transaction, guard, &actor.issuer, &request.run_id)?;
    }
    orchestration::mutation_capacity(&transaction)?;
    if current["revision"] != request.expected_revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect before launching a task",
        )
        .into());
    }
    if current["state"] != "active" {
        return Err(Error::new(
            "run_state_conflict",
            "Only an active run admits a new worker launch",
        )
        .into());
    }
    let task = crate::workflow_attempts::task(&transaction, &request.run_id, &request.task_id)?;
    let summaries = crate::workflow_attempts::summaries(&transaction, &request.run_id)?;
    for key in &task.dependencies {
        let id: String = transaction.query_row(
            "SELECT id FROM workflow_tasks WHERE run_id=?1 AND task_key=?2",
            params![request.run_id, key],
            |row| row.get(0),
        )?;
        if !summaries
            .get(&id)
            .is_some_and(|attempt| attempt["state"] == "succeeded")
        {
            return Err(Error::new(
                "dependencies_unmet",
                "A dependency has no accepted validated result",
            )
            .into());
        }
    }
    let prior = summaries.get(&request.task_id);
    if prior.is_some_and(|attempt| {
        !matches!(
            attempt["state"].as_str(),
            Some("failed" | "stopped" | "launchFailed")
        )
    }) {
        return Err(Error::new(
            "attempt_state_conflict",
            "Task already has a current attempt, uncertain launch or accepted result",
        )
        .into());
    }
    let ordinal = prior.map_or(1, |attempt| attempt["ordinal"].as_i64().unwrap_or(0) + 1);
    crate::workflow_budget::admit_attempt(&transaction, &request.run_id, ordinal)?;
    let retained: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_attempts", [], |row| {
            row.get(0)
        })?;
    if ordinal > 16 || retained >= 4096 {
        return Err(Error::new(
            "busy",
            "Attempt retention is full; no history was discarded",
        )
        .into());
    }
    let coordinator = current["coordinatorSessionId"].as_str().map(str::to_owned);
    let spec = LaunchSpec {
        name: request.profile.name.clone().unwrap_or(task.title),
        cwd: request.profile.cwd.clone(),
        program: request.profile.program,
        worktree: matches!(request.profile.workspace, Workspace::Worktree),
        harness: request.profile.harness,
        model: request.profile.model.clone(),
        effort: request.profile.effort.clone(),
        parent_session_id: coordinator.clone(),
        ..Default::default()
    };
    let attempt = hex::encode(crate::wire::random::<16>());
    let native_key = format!("run-launch:{attempt}");
    let accepted = crate::receipts::accept_transaction(
        &transaction,
        &actor.issuer,
        &native_key,
        "create",
        serde_json::to_value(&spec)?,
    )?;
    if !accepted.is_new {
        return Err(anyhow!(
            "New task launch unexpectedly reused a native identity"
        ));
    }
    transaction.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,?3,?4,'launching')",params![attempt,request.task_id,ordinal,accepted.receipt.session_id])?;
    transaction.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES(?1,?2,?3,?4,?5)",params![attempt,accepted.receipt.id,native_key,if spec.worktree {"worktree"} else {"shared"},now as i64])?;
    if let Some(guard) = &executor {
        crate::workflow_executor::record_launch(
            &transaction,
            guard,
            &actor.issuer,
            &request.key,
            &attempt,
        )?;
    }
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [&request.run_id],
    )?;
    let cursor = event(
        &transaction,
        &request.run_id,
        &attempt,
        "run.launch_reserved",
        now,
    )?;
    let mut view = orchestration::view(&transaction, &actor, &request.run_id)?;
    view["launch"] = summary(&transaction, &attempt)?;
    view["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, &request.key, &fingerprint, &view)?;
    transaction.commit()?;
    Ok(Reply::Prepared {
        view,
        dispatch: Some(Box::new(Dispatch {
            spec,
            receipt: accepted.receipt,
            coordinator,
            attempt_id: attempt,
        })),
    })
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::Prepare { actor, request } => prepare(connection, actor, request, now, None),
        Work::PrepareForExecutor {
            actor,
            request,
            guard,
        } => prepare(connection, actor, request, now, Some(guard)),
        Work::Finish {
            attempt_id,
            receipt_id,
        } => {
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let launch = summary(&transaction, &attempt_id)?;
            if launch["receiptId"] != receipt_id {
                return Err(anyhow!(
                    "Launch receipt does not match the reserved attempt"
                ));
            }
            let run:String=transaction.query_row("SELECT t.run_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id=?1",[&attempt_id],|row|row.get(0))?;
            let state = if launch["phase"] == "created" {
                let exited: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)",
                    [launch["sessionId"]
                        .as_str()
                        .ok_or_else(|| anyhow!("Missing reserved session identity"))?],
                    |row| row.get(0),
                )?;
                if exited { "stopped" } else { "assigned" }
            } else if launch["phase"] == "failed" && launch["effectStarted"] == false {
                "launchFailed"
            } else {
                "launchUnknown"
            };
            let changed = transaction.execute(
                "UPDATE workflow_attempts SET state=?2 WHERE id=?1 AND state='launching'",
                params![attempt_id, state],
            )?;
            if changed > 0 {
                transaction.execute(
                    "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
                    [&run],
                )?;
                crate::workflow_budget::settle_drain(&transaction, &run)?;
                event(&transaction, &run, &attempt_id, "run.launch_observed", now)?;
            }
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
