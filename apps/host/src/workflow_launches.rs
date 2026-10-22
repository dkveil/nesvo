use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::claude_statusline::deserialize_options"
    )]
    pub claude_quota_capture: Option<crate::claude_statusline::Options>,
}
impl Profile {
    pub fn validate_capture(&self, owner: bool) -> Result<()> {
        if let Some(options) = &self.claude_quota_capture {
            if !owner {
                return Err(Error::new(
                    "forbidden",
                    "Only the owner may select a declared Claude quota display profile",
                )
                .into());
            }
            options.validate(self.program)?;
        }
        Ok(())
    }
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
    PreparedWorkspace {
        operation_id: String,
        token: String,
        spec: Box<LaunchSpec>,
        derived_worktree: bool,
    },
    QuotaHold {
        operation_id: String,
        token: String,
        reason: Option<String>,
    },
    Finish {
        attempt_id: String,
        receipt_id: String,
    },
}
pub struct Dispatch {
    pub spec: LaunchSpec,
    pub selected_tools: Option<Vec<String>>,
    pub receipt: Receipt,
    pub coordinator: Option<String>,
    pub attempt_id: String,
    pub quota: Option<crate::job_quota::Permit>,
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
    let mut query = connection.prepare("PRAGMA table_info(workflow_launches)")?;
    let columns = query
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    if !columns.iter().any(|name| name == "profile") {
        connection.execute_batch("ALTER TABLE workflow_launches ADD COLUMN profile TEXT;")?;
    }
    for (name, declaration) in [
        ("prepared_spec", "TEXT"),
        ("prepared_at", "INTEGER"),
        ("derived_worktree", "INTEGER"),
        ("quota_hold_reason", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute_batch(&format!(
                "ALTER TABLE workflow_launches ADD COLUMN {name} {declaration};"
            ))?;
        }
    }
    Ok(())
}
fn event(
    transaction: &Transaction<'_>,
    run: &str,
    attempt: &str,
    kind: fn(model::RunAttempt) -> DomainEvent,
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
            at: now,
            event: kind(model::RunAttempt {
                run_id: run.into(),
                attempt_id: attempt.into(),
            }),
        }],
    )
}
pub fn summary(connection: &Connection, attempt: &str) -> Result<Value> {
    let row = connection.query_row(
        "SELECT l.operation_id,l.operation_key,o.phase,o.session_id,l.workspace,l.created_at,o.result,l.profile,l.prepared_spec,l.prepared_at,l.derived_worktree,l.quota_hold_reason FROM workflow_launches l JOIN operation_receipts o ON o.id=l.operation_id WHERE l.attempt_id=?1",
        [attempt],
        |row| Ok((
            json!({"attemptId":attempt,"receiptId":row.get::<_,String>(0)?,"operationKey":row.get::<_,String>(1)?,"phase":row.get::<_,String>(2)?,"sessionId":row.get::<_,String>(3)?,"workspace":row.get::<_,String>(4)?,"createdAt":row.get::<_,i64>(5)?}),
            row.get::<_,String>(6)?, row.get::<_,Option<String>>(7)?,
            row.get::<_,Option<String>>(8)?, row.get::<_,Option<i64>>(9)?,
            row.get::<_,Option<bool>>(10)?, row.get::<_,Option<String>>(11)?,
        )),
    ).optional()?;
    let Some((mut view, result, profile, prepared, prepared_at, derived_worktree, quota_hold)) =
        row
    else {
        return Ok(Value::Null);
    };
    let result: Value = serde_json::from_str(&result)?;
    view["profile"] = profile
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?
        .unwrap_or(Value::Null);
    for key in ["code", "effectStarted", "directory"] {
        view[key] = result[key].clone();
    }
    view["preparedWorkspace"] = match prepared {
        Some(spec) => {
            let spec: LaunchSpec = serde_json::from_str(&spec)?;
            json!({"directory":spec.cwd,"derivedWorktree":derived_worktree,"preparedAt":prepared_at})
        }
        None => Value::Null,
    };
    view["quotaHoldReason"] = quota_hold.into();
    Ok(view)
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
            "UPDATE workflow_launches SET quota_hold_reason=NULL WHERE attempt_id=?1",
            [&attempt],
        )?;
        transaction.execute(
            "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
            [&run],
        )?;
        event(
            &transaction,
            &run,
            &attempt,
            DomainEvent::RunLaunchRecovered,
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
    request
        .profile
        .validate_capture(matches!(actor.scope, orchestration::Scope::Owner))?;
    if let Some(guard) = &executor {
        crate::workflow_executor::guard_run(&transaction, guard, &actor.issuer, &request.run_id)?;
    }
    let quota = crate::job_quota::permit_for_run(&transaction, &request.run_id)?;
    match &quota {
        Some(permit) => crate::job_quota::guard_permit(
            &transaction,
            permit,
            crate::event_log::monotonic_millis(),
        )?,
        None => crate::job_quota::guard_gate(
            &transaction,
            request.profile.program,
            crate::event_log::monotonic_millis(),
        )?,
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
    crate::job_timeouts::guard_run(
        &transaction,
        &request.run_id,
        now,
        crate::event_log::monotonic_millis(),
    )?;
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
        claude_quota_capture: request.profile.claude_quota_capture.clone(),
        claude_quota_owner_selected: request.profile.claude_quota_capture.is_some(),
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
    transaction.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at,profile) VALUES(?1,?2,?3,?4,?5,?6)",params![attempt,accepted.receipt.id,native_key,if spec.worktree {"worktree"} else {"shared"},now as i64,serde_json::to_string(&request.profile)?])?;
    if quota.is_some() {
        crate::workflow_context::freeze(&transaction, &request.run_id, &accepted.receipt.id)?;
    }
    crate::job_timeouts::arm(
        &transaction,
        &request.run_id,
        &attempt,
        now,
        crate::event_log::monotonic_millis(),
    )?;
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
        DomainEvent::RunLaunchReserved,
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
            selected_tools: request.profile.allowed_nesvo_tools,
            receipt: accepted.receipt,
            coordinator,
            attempt_id: attempt,
            quota,
        })),
    })
}
fn live_claim(
    transaction: &Transaction<'_>,
    operation: &str,
    token: &str,
) -> Result<(String, String)> {
    let (attempt, run): (String, String) = transaction
        .query_row(
            "SELECT l.attempt_id,t.run_id FROM workflow_launches l
             JOIN workflow_attempts a ON a.id=l.attempt_id
             JOIN workflow_tasks t ON t.id=a.task_id
             JOIN operation_receipts o ON o.id=l.operation_id
             WHERE l.operation_id=?1 AND o.claim_token=?2 AND o.phase='dispatching'
               AND o.operation='create' AND a.state='launching' AND a.session_id=o.session_id
               AND a.ordinal=(SELECT MAX(latest.ordinal) FROM workflow_attempts latest WHERE latest.task_id=a.task_id)",
            params![operation, token],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            anyhow::Error::from(Error::new(
                "launch_claim_conflict",
                "The original native launch claim is no longer live; no continuation was replayed",
            ))
        })?;
    Ok((attempt, run))
}

fn prepared_workspace(
    connection: &mut Connection,
    operation: &str,
    token: &str,
    spec: &LaunchSpec,
    derived_worktree: bool,
    now: u64,
) -> Result<Reply> {
    let directory = spec.cwd.as_deref().ok_or_else(|| {
        Error::new(
            "invalid_argument",
            "Prepared launch requires its resolved directory",
        )
    })?;
    if spec.worktree
        || directory.is_empty()
        || directory.len() > 4096
        || directory.chars().any(char::is_control)
        || !std::path::Path::new(directory).is_absolute()
    {
        return Err(Error::new(
            "invalid_argument",
            "Prepared launch must retain one absolute resolved workspace without another Git setup",
        )
        .into());
    }
    let encoded = serde_json::to_string(spec)?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (attempt, run) = live_claim(&transaction, operation, token)?;
    let prior: (Option<String>, Option<bool>) = transaction.query_row(
        "SELECT prepared_spec,derived_worktree FROM workflow_launches WHERE operation_id=?1",
        [operation],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if let Some(prior_spec) = prior.0 {
        if prior_spec != encoded || prior.1 != Some(derived_worktree) {
            return Err(Error::new(
                "launch_workspace_conflict",
                "The original prepared workspace is immutable; another setup was refused",
            )
            .into());
        }
    } else {
        transaction.execute(
            "UPDATE workflow_launches SET prepared_spec=?2,prepared_at=?3,derived_worktree=?4 WHERE operation_id=?1",
            params![operation, encoded, i64::try_from(now)?, derived_worktree],
        )?;
        event(
            &transaction,
            &run,
            &attempt,
            DomainEvent::RunWorkspacePrepared,
            now,
        )?;
    }
    transaction.commit()?;
    Ok(Reply::Done)
}

fn quota_hold(
    connection: &mut Connection,
    operation: &str,
    token: &str,
    reason: Option<&str>,
    now: u64,
) -> Result<Reply> {
    if reason.is_some_and(|reason| !matches!(reason, "quota_wait" | "native_run_busy")) {
        return Err(Error::new("invalid_argument", "Invalid native quota hold reason").into());
    }
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (attempt, run) = live_claim(&transaction, operation, token)?;
    let session: String = transaction.query_row(
        "SELECT session_id FROM operation_receipts WHERE id=?1",
        [operation],
        |row| row.get(0),
    )?;
    crate::workflow_context::guard_native(&transaction, &session, operation)?;
    let changed = transaction.execute(
        "UPDATE workflow_launches SET quota_hold_reason=?2 WHERE operation_id=?1 AND quota_hold_reason IS NOT ?2",
        params![operation, reason],
    )?;
    if changed != 0 {
        event(
            &transaction,
            &run,
            &attempt,
            DomainEvent::RunQuotaHoldChanged,
            now,
        )?;
    }
    transaction.commit()?;
    Ok(Reply::Done)
}

pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::Prepare { actor, request } => prepare(connection, actor, request, now, None),
        Work::PrepareForExecutor {
            actor,
            request,
            guard,
        } => prepare(connection, actor, request, now, Some(guard)),
        Work::PreparedWorkspace {
            operation_id,
            token,
            spec,
            derived_worktree,
        } => prepared_workspace(
            connection,
            &operation_id,
            &token,
            &spec,
            derived_worktree,
            now,
        ),
        Work::QuotaHold {
            operation_id,
            token,
            reason,
        } => quota_hold(connection, &operation_id, &token, reason.as_deref(), now),
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
            transaction.execute(
                "UPDATE workflow_launches SET quota_hold_reason=NULL WHERE attempt_id=?1",
                [&attempt_id],
            )?;
            if changed > 0 {
                transaction.execute(
                    "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
                    [&run],
                )?;
                crate::workflow_budget::settle_drain(&transaction, &run)?;
                event(
                    &transaction,
                    &run,
                    &attempt_id,
                    DomainEvent::RunLaunchObserved,
                    now,
                )?;
                crate::workflow_digest::settle(&transaction, &run, now)?;
            }
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
