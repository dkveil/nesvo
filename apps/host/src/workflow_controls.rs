use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor, Scope},
    receipts::Receipt,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Stop,
    Cancel,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Cancel => "cancel",
        }
    }
    fn pending(self) -> &'static str {
        match self {
            Self::Stop => "stopping",
            Self::Cancel => "canceling",
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Start {
        key: String,
        run_id: String,
        expected_revision: u64,
        kind: Kind,
    },
    Get {
        run_id: String,
        control_id: String,
        offset: Option<u16>,
    },
}
#[derive(Clone, Debug)]
pub struct Claim {
    pub id: String,
    pub token: String,
}
#[derive(Debug)]
pub struct Target {
    pub session_id: String,
    pub key: String,
}
pub enum Work {
    PrepareJobTimeout {
        claim: crate::job_timeouts::Claim,
    },
    Prepare {
        actor: Actor,
        request: Request,
    },
    Claim {
        claim: Claim,
    },
    Finish {
        claim: Claim,
        session_id: String,
        receipt: Option<Receipt>,
    },
    Read {
        actor: Actor,
        run_id: String,
        control_id: String,
        offset: u16,
    },
    Observe {
        actor: Actor,
        run_id: String,
        control_id: String,
        exited: Vec<String>,
        unavailable: Vec<String>,
    },
}
#[derive(Debug)]
pub enum Reply {
    Prepared { view: Value, claim: Option<Claim> },
    Targets(Vec<Target>),
    View(Value),
    Done,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_controls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(id),kind TEXT NOT NULL,issuer TEXT NOT NULL,state TEXT NOT NULL,token TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_controls_run ON workflow_controls(run_id);
      CREATE TABLE IF NOT EXISTS workflow_process_exits(session_id TEXT PRIMARY KEY REFERENCES workflow_attempts(session_id),observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_control_targets(control_id TEXT NOT NULL REFERENCES workflow_controls(id),session_id TEXT NOT NULL,attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),position INTEGER NOT NULL,key TEXT NOT NULL,phase TEXT NOT NULL,receipt_id TEXT,code TEXT,PRIMARY KEY(control_id,session_id));
      CREATE INDEX IF NOT EXISTS workflow_control_target_session ON workflow_control_targets(session_id);
      CREATE INDEX IF NOT EXISTS workflow_control_target_page ON workflow_control_targets(control_id,position);")?;
    Ok(())
}
pub fn recover(connection: &mut Connection) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let affected = {
        let mut statement = transaction
            .prepare("SELECT id,run_id FROM workflow_controls WHERE token IS NOT NULL AND state!='completed'")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    transaction.execute("UPDATE workflow_control_targets SET phase='unknown',code='host_restart' WHERE phase IN ('pending','dispatching')",[])?;
    transaction.execute(
        "UPDATE workflow_controls SET token=NULL,state=CASE WHEN state='completed' THEN state ELSE 'unconfirmed' END WHERE token IS NOT NULL",
        [],
    )?;
    for (id, run) in affected {
        event(
            &transaction,
            &run,
            &id,
            DomainEvent::RunControlUnconfirmed,
            crate::status::now_millis(),
        )?;
    }
    transaction.commit()?;
    Ok(())
}
fn event(
    transaction: &Transaction<'_>,
    run_id: &str,
    control_id: &str,
    kind: fn(model::RunControl) -> DomainEvent,
    now: u64,
) -> Result<u64> {
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            at: now,
            event: kind(model::RunControl {
                run_id: run_id.into(),
                control_id: control_id.into(),
            }),
        }],
    )
}
fn identity(connection: &Connection, control_id: &str) -> Result<(String, String)> {
    connection
        .query_row(
            "SELECT run_id,kind FROM workflow_controls WHERE id=?1",
            [control_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| Error::new("control_not_found", "Run control intent is unavailable").into())
}
fn view(
    connection: &Connection,
    actor: &Actor,
    run_id: &str,
    id: &str,
    offset: u16,
) -> Result<Value> {
    let run = orchestration::run(connection, actor, run_id)?;
    let (actual, kind) = identity(connection, id)?;
    if actual != run_id {
        return Err(Error::new("control_not_found", "Control does not belong to this run").into());
    }
    if offset > 4096 {
        return Err(Error::new(
            "invalid_argument",
            "Control offset exceeds retained attempt capacity",
        )
        .into());
    }
    let (state, created_at): (String, i64) = connection.query_row(
        "SELECT state,created_at FROM workflow_controls WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut statement=connection.prepare("SELECT c.session_id,c.attempt_id,c.key,c.phase,COALESCE(c.receipt_id,(SELECT o.id FROM operation_receipts o JOIN workflow_controls w ON w.id=c.control_id WHERE o.key=c.key AND o.issuer=w.issuer AND o.operation='stop')),c.code FROM workflow_control_targets c WHERE c.control_id=?1 ORDER BY c.position LIMIT 9 OFFSET ?2")?;
    let mut targets=statement.query_map(params![id,offset],|r|Ok(json!({"sessionId":r.get::<_,String>(0)?,"attemptId":r.get::<_,String>(1)?,"operationKey":r.get::<_,String>(2)?,"phase":r.get::<_,String>(3)?,"receiptId":r.get::<_,Option<String>>(4)?,"code":r.get::<_,Option<String>>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let more = targets.len() > 8;
    targets.truncate(8);
    let mut counts = serde_json::Map::new();
    let mut statement = connection.prepare(
        "SELECT phase,count(*) FROM workflow_control_targets WHERE control_id=?1 GROUP BY phase",
    )?;
    for row in statement.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (phase, count) = row?;
        counts.insert(phase, count.into());
    }
    Ok(
        json!({"run":run,"control":{"id":id,"kind":kind,"state":state,"createdAt":created_at,"counts":counts},"targets":targets,"nextOffset":more.then_some(offset+8)}),
    )
}
fn check_claim(connection: &Connection, claim: &Claim) -> Result<()> {
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_controls WHERE id=?1 AND token=?2)",
        params![claim.id, claim.token],
        |r| r.get(0),
    )?;
    if !valid {
        return Err(Error::new(
            "stale_control",
            "Run control dispatch claim is no longer active",
        )
        .into());
    }
    Ok(())
}
fn settle(transaction: &Transaction<'_>, id: &str, now: u64) -> Result<()> {
    let (run_id, kind) = identity(transaction, id)?;
    let timeout = crate::job_timeouts::owns_control(transaction, id)?;
    let mut phases = Vec::new();
    let mut statement =
        transaction.prepare("SELECT phase FROM workflow_control_targets WHERE control_id=?1")?;
    for phase in statement.query_map([id], |r| r.get::<_, String>(0))? {
        phases.push(phase?);
    }
    let phase = if phases.iter().all(|phase| phase == "exited") {
        "completed"
    } else if phases
        .iter()
        .any(|p| matches!(p.as_str(), "pending" | "dispatching"))
    {
        "dispatching"
    } else if phases
        .iter()
        .any(|p| matches!(p.as_str(), "unknown" | "unavailable"))
    {
        "unconfirmed"
    } else if phases.iter().any(|p| p == "stopRequested") {
        "awaitingExit"
    } else {
        "blocked"
    };
    transaction.execute(
        "UPDATE workflow_controls SET state=?2 WHERE id=?1",
        params![id, phase],
    )?;
    if phase == "completed" {
        let terminal = if kind == "cancel" {
            "canceled"
        } else {
            "stopped"
        };
        let changed=transaction.execute("UPDATE workflow_runs SET state=?2,revision=revision+1 WHERE id=?1 AND state IN ('stopping','canceling') AND ?3=(SELECT id FROM workflow_controls WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1)",params![run_id,terminal,id])?;
        if changed > 0 {
            let attempts = {
                let mut statement=transaction.prepare("SELECT a.id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=?1 AND a.state IN ('assigned','reported') AND (?2=0 OR EXISTS(SELECT 1 FROM workflow_control_targets c WHERE c.control_id=?3 AND c.attempt_id=a.id))")?;
                statement
                    .query_map(params![run_id, timeout, id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for attempt in attempts {
                crate::workflow_decisions::close_pending(
                    transaction,
                    &attempt,
                    now,
                    "Run native control completed; no answer or task success inferred",
                )?;
            }
            transaction.execute("UPDATE workflow_attempts SET state='stopped' WHERE task_id IN (SELECT id FROM workflow_tasks WHERE run_id=?1) AND (state IN ('assigned','launching','launchUnknown') OR (?2='cancel' AND state='reported')) AND (?3=0 OR id IN (SELECT attempt_id FROM workflow_control_targets WHERE control_id=?4))",params![run_id,kind,timeout,id])?;
            event(
                transaction,
                &run_id,
                id,
                DomainEvent::RunControlCompleted,
                now,
            )?;
            crate::workflow_digest::settle(transaction, &run_id, now)?;
        }
    }
    Ok(())
}

fn prepare_job_timeout(
    connection: &mut Connection,
    timeout: crate::job_timeouts::Claim,
    now: u64,
) -> Result<Reply> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    crate::job_timeouts::guard_claim(&transaction, &timeout)?;
    let actor = Actor {
        issuer: timeout.issuer.clone(),
        scope: Scope::Owner,
    };
    let run_id = &timeout.identity.run_id;
    let run = orchestration::run(&transaction, &actor, run_id)?;
    let previous: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id,issuer,kind FROM workflow_controls WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((id, issuer, kind)) = previous {
        let exact: bool = transaction.query_row(
            "SELECT count(*)=1 AND COALESCE(sum(attempt_id=?2 AND session_id=?3),0)=1 FROM workflow_control_targets WHERE control_id=?1",
            params![id, timeout.identity.attempt_id, timeout.identity.session_id],
            |row| row.get(0),
        )?;
        if exact && issuer == timeout.issuer && matches!(kind.as_str(), "stop" | "cancel") {
            crate::job_timeouts::control_prepared(&transaction, &timeout, &id, now)?;
            let view = view(&transaction, &actor, run_id, &id, 0)?;
            transaction.commit()?;
            return Ok(Reply::Prepared { view, claim: None });
        }
        crate::job_timeouts::block_claim(&transaction, &timeout, "existing_control_conflict", now)?;
        transaction.commit()?;
        return Ok(Reply::Done);
    }
    if !matches!(
        run["state"].as_str(),
        Some("active" | "draining" | "drained")
    ) {
        crate::job_timeouts::block_claim(&transaction, &timeout, "timeout_run_state_changed", now)?;
        transaction.commit()?;
        return Ok(Reply::Done);
    }
    orchestration::mutation_capacity(&transaction)?;
    orchestration::validate_key(&timeout.control_key)?;
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({
                "action":"jobExecutionTimeout",
                "jobId":timeout.identity.job_id,
                "occurrenceId":timeout.identity.occurrence_id,
                "jobAttemptId":timeout.identity.job_attempt_id,
                "runId":run_id,
                "attemptId":timeout.identity.attempt_id,
                "sessionId":timeout.identity.session_id,
                "launchReceiptId":timeout.identity.launch_receipt_id,
                "deadlineAt":timeout.deadline_at,
            }))?,
        )
        .as_ref(),
    );
    if orchestration::replay(&transaction, &actor, &timeout.control_key, &fingerprint)?.is_some() {
        return Err(Error::new("control_unconfirmed", "An existing timeout mutation has no matching retained control; no native effect was repeated").into());
    }
    let (controls, targets): (i64, i64) = transaction.query_row(
        "SELECT (SELECT count(*) FROM workflow_controls),(SELECT count(*) FROM workflow_control_targets)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if controls >= 1024 || targets >= 8192 {
        return Err(Error::new(
            "busy",
            "Run control retention is full; no history was discarded",
        )
        .into());
    }
    let id = hex::encode(crate::wire::random::<16>());
    let token = hex::encode(crate::wire::random::<32>());
    let exited: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)",
        [&timeout.identity.session_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO workflow_controls(id,run_id,kind,issuer,state,token,created_at) VALUES(?1,?2,'stop',?3,'dispatching',?4,?5)",
        params![id,run_id,timeout.issuer,if exited { None } else { Some(&token) },now as i64],
    )?;
    transaction.execute(
        "INSERT INTO workflow_control_targets(control_id,session_id,attempt_id,position,key,phase) VALUES(?1,?2,?3,0,?4,?5)",
        params![id,timeout.identity.session_id,timeout.identity.attempt_id,format!("run-control:{id}:{}",timeout.identity.attempt_id),if exited { "exited" } else { "pending" }],
    )?;
    crate::job_timeouts::control_prepared(&transaction, &timeout, &id, now)?;
    crate::workflow_budget::ensure_record(&transaction, run_id)?;
    transaction.execute(
        "UPDATE workflow_run_budget SET drain_owner=1 WHERE run_id=?1",
        [run_id],
    )?;
    transaction.execute(
        "UPDATE workflow_runs SET state='stopping',revision=revision+1 WHERE id=?1",
        [run_id],
    )?;
    event(
        &transaction,
        run_id,
        &id,
        DomainEvent::RunControlRequested,
        now,
    )?;
    settle(&transaction, &id, now)?;
    let mut view = view(&transaction, &actor, run_id, &id, 0)?;
    view["cursor"] = u64::try_from(transaction.query_row(
        "SELECT head FROM domain_event_cursor WHERE id=1",
        [],
        |row| row.get::<_, i64>(0),
    )?)?
    .into();
    orchestration::remember(
        &transaction,
        &actor,
        &timeout.control_key,
        &fingerprint,
        &view,
    )?;
    transaction.commit()?;
    Ok(Reply::Prepared {
        view,
        claim: (!exited).then_some(Claim { id, token }),
    })
}
pub fn observe_exit(transaction: &Transaction<'_>, session: &str, now: u64) -> Result<()> {
    transaction.execute("INSERT OR IGNORE INTO workflow_process_exits(session_id,observed_at) SELECT session_id,?2 FROM workflow_attempts WHERE session_id=?1",params![session,now as i64])?;
    let controls = {
        let mut statement=transaction.prepare("SELECT control_id FROM workflow_control_targets WHERE session_id=?1 AND phase!='exited'")?;
        statement
            .query_map([session], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in controls {
        transaction.execute("UPDATE workflow_control_targets SET phase='exited' WHERE control_id=?1 AND session_id=?2",params![id,session])?;
        settle(transaction, &id, now)?;
    }
    Ok(())
}
fn prepare(connection: &mut Connection, actor: Actor, request: Request, now: u64) -> Result<Reply> {
    let Request::Start {
        ref key,
        ref run_id,
        expected_revision,
        kind,
    } = request
    else {
        return Err(anyhow!("Control prepare requires a start request"));
    };
    orchestration::validate_key(key)?;
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"control","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let run = orchestration::run(&transaction, &actor, run_id)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, key, &fingerprint)? {
        return Ok(Reply::Prepared { view, claim: None });
    }
    crate::job_launch_resolutions::guard_run(&transaction, run_id)?;
    orchestration::mutation_capacity(&transaction)?;
    if run["revision"] != expected_revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect before requesting native control",
        )
        .into());
    }
    if run["budget"]["ownerDrain"] == true && !matches!(actor.scope, Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Owner-controlled drain/stop can be changed only by the owner",
        )
        .into());
    }
    let state = run["state"].as_str().unwrap_or_default();
    if !matches!(
        state,
        "active" | "draining" | "drained" | "stopping" | "canceling"
    ) && !(matches!(kind, Kind::Cancel) && matches!(state, "draft" | "stopped"))
    {
        return Err(Error::new(
            "run_state_conflict",
            "Run does not admit this native control intent",
        )
        .into());
    }
    let previous: Option<String> = transaction
        .query_row(
            "SELECT state FROM workflow_controls WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    if previous
        .as_deref()
        .is_some_and(|phase| !matches!(phase, "completed" | "blocked"))
    {
        return Err(Error::new(
            "control_unconfirmed",
            "Reconcile the previous control and native receipts before another intent",
        )
        .into());
    }
    let controls: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_controls", [], |r| r.get(0))?;
    let retained: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_control_targets", [], |r| {
            r.get(0)
        })?;
    let mut statement=transaction.prepare("SELECT a.id,a.session_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=?1 AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.session_id=a.session_id) AND NOT EXISTS(SELECT 1 FROM workflow_process_exits e WHERE e.session_id=a.session_id) AND NOT EXISTS(SELECT 1 FROM workflow_launches l JOIN operation_receipts o ON o.id=l.operation_id WHERE l.attempt_id=a.id AND o.phase='failed' AND json_extract(o.result,'$.effectStarted')=0) ORDER BY a.rowid")?;
    let targets = statement
        .query_map([run_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if controls >= 1024 || retained + targets.len() as i64 > 8192 {
        return Err(Error::new(
            "busy",
            "Run control retention is full; no history was discarded",
        )
        .into());
    }
    let id = hex::encode(crate::wire::random::<16>());
    let token = hex::encode(crate::wire::random::<32>());
    transaction.execute("INSERT INTO workflow_controls(id,run_id,kind,issuer,state,token,created_at) VALUES(?1,?2,?3,?4,'dispatching',?5,?6)",params![id,run_id,kind.name(),actor.issuer,token,now as i64])?;
    for (position, (attempt, session)) in targets.iter().enumerate() {
        transaction.execute("INSERT INTO workflow_control_targets(control_id,session_id,attempt_id,position,key,phase) VALUES(?1,?2,?3,?4,?5,'pending')",params![id,session,attempt,position as i64,format!("run-control:{id}:{attempt}")])?;
    }
    crate::workflow_budget::ensure_record(&transaction, run_id)?;
    transaction.execute(
        "UPDATE workflow_run_budget SET drain_owner=(drain_owner OR ?2) WHERE run_id=?1",
        params![run_id, matches!(actor.scope, Scope::Owner)],
    )?;
    transaction.execute(
        "UPDATE workflow_runs SET state=?2,revision=revision+1 WHERE id=?1",
        params![run_id, kind.pending()],
    )?;
    event(
        &transaction,
        run_id,
        &id,
        DomainEvent::RunControlRequested,
        now,
    )?;
    settle(&transaction, &id, now)?;
    let cursor: u64 = u64::try_from(transaction.query_row(
        "SELECT head FROM domain_event_cursor WHERE id=1",
        [],
        |row| row.get::<_, i64>(0),
    )?)?;
    let mut view = view(&transaction, &actor, run_id, &id, 0)?;
    view["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, key, &fingerprint, &view)?;
    drop(statement);
    transaction.commit()?;
    Ok(Reply::Prepared {
        view,
        claim: Some(Claim { id, token }),
    })
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::PrepareJobTimeout { claim } => prepare_job_timeout(connection, claim, now),
        Work::Prepare { actor, request } => prepare(connection, actor, request, now),
        Work::Read {
            actor,
            run_id,
            control_id,
            offset,
        } => Ok(Reply::View(view(
            connection,
            &actor,
            &run_id,
            &control_id,
            offset,
        )?)),
        Work::Claim { claim } => {
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            check_claim(&transaction, &claim)?;
            let mut statement=transaction.prepare("SELECT session_id,key FROM workflow_control_targets WHERE control_id=?1 AND phase='pending' ORDER BY position LIMIT 8")?;
            let targets = statement
                .query_map([&claim.id], |r| {
                    Ok(Target {
                        session_id: r.get(0)?,
                        key: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for target in &targets {
                transaction.execute("UPDATE workflow_control_targets SET phase='dispatching' WHERE control_id=?1 AND session_id=?2",params![claim.id,target.session_id])?;
            }
            if targets.is_empty() {
                transaction.execute(
                    "UPDATE workflow_controls SET token=NULL WHERE id=?1",
                    [&claim.id],
                )?;
            }
            settle(&transaction, &claim.id, now)?;
            drop(statement);
            transaction.commit()?;
            Ok(Reply::Targets(targets))
        }
        Work::Finish {
            claim,
            session_id,
            receipt,
        } => {
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            check_claim(&transaction, &claim)?;
            let (phase, receipt_id, code) = match receipt {
                Some(receipt) => {
                    if receipt.session_id != session_id || receipt.operation != "stop" {
                        return Err(anyhow!("Native receipt does not match control target"));
                    }
                    let phase = match receipt.phase.as_str() {
                        "stopped" if receipt.result["processExited"] == true => "exited",
                        "stopRequested" => "stopRequested",
                        "failed" if receipt.result["effectStarted"] == false => "blocked",
                        _ => "unknown",
                    };
                    (
                        phase,
                        Some(receipt.id),
                        receipt.result["code"].as_str().map(str::to_owned),
                    )
                }
                None => ("unknown", None, Some("receipt_unconfirmed".into())),
            };
            let changed=transaction.execute("UPDATE workflow_control_targets SET phase=CASE WHEN phase='exited' THEN 'exited' ELSE ?3 END,receipt_id=?4,code=?5 WHERE control_id=?1 AND session_id=?2 AND phase IN ('dispatching','exited')",params![claim.id,session_id,phase,receipt_id,code])?;
            if changed != 1 {
                return Err(Error::new(
                    "stale_control",
                    "Control target was not claimed for native dispatch",
                )
                .into());
            }
            if phase == "exited" {
                observe_exit(&transaction, &session_id, now)?;
            }
            let (run, _) = identity(&transaction, &claim.id)?;
            event(
                &transaction,
                &run,
                &claim.id,
                DomainEvent::RunControlProgress,
                now,
            )?;
            settle(&transaction, &claim.id, now)?;
            transaction.commit()?;
            Ok(Reply::Done)
        }
        Work::Observe {
            actor,
            run_id,
            control_id,
            exited,
            unavailable,
        } => {
            if exited.len() + unavailable.len() > 8 {
                return Err(anyhow!("Observation exceeds control page"));
            }
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            view(&transaction, &actor, &run_id, &control_id, 0)?;
            for session in exited {
                let member:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM workflow_control_targets WHERE control_id=?1 AND session_id=?2)",params![control_id,session],|row|row.get(0))?;
                if !member {
                    return Err(anyhow!(
                        "Exit observation is outside the control target set"
                    ));
                }
                observe_exit(&transaction, &session, now)?;
            }
            for session in unavailable {
                transaction.execute("UPDATE workflow_control_targets SET phase='unavailable',code='process_unavailable' WHERE control_id=?1 AND session_id=?2 AND phase NOT IN ('exited','pending','dispatching')",params![control_id,session])?;
            }
            settle(&transaction, &control_id, now)?;
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
