use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor},
    receipts::Receipt,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
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
    Queue {
        key: String,
        run_id: String,
        task_id: String,
        expected_revision: u64,
        timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    Cancel {
        key: String,
        run_id: String,
        delivery_id: String,
        expected_revision: u64,
    },
}
pub struct Pending {
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub coordinator: Option<String>,
    pub deadline_at: u64,
}
pub struct Dispatch {
    pub receipt: Receipt,
    pub prompt: String,
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
    Reuse {
        actor: Actor,
        request: Request,
        live: crate::workflow_session_reuse::Live,
    },
    Inspect {
        id: String,
    },
    Claim {
        id: String,
        conversation: Option<String>,
    },
    Note {
        id: String,
        code: String,
    },
    Abandon {
        id: String,
        phase: &'static str,
        code: String,
    },
    Finish {
        id: String,
    },
}
pub enum Reply {
    Prepared {
        view: Value,
        pending: Option<Pending>,
    },
    Current {
        queued: bool,
    },
    Claimed(Option<Dispatch>),
    Done,
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_deliveries(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),issuer TEXT NOT NULL,phase TEXT NOT NULL,blocker TEXT,operation_id TEXT UNIQUE REFERENCES operation_receipts(id),created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL);")?;
    Ok(())
}
pub fn summary(connection: &Connection, attempt: &str) -> Result<Value> {
    type Row = (String, String, Option<String>, Option<String>, i64, i64);
    let row: Option<Row> = connection.query_row("SELECT id,phase,blocker,operation_id,created_at,deadline_at FROM workflow_deliveries WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let Some((id, phase, blocker, receipt, created, deadline)) = row else {
        return Ok(Value::Null);
    };
    let native: Option<(String, String)> = if let Some(receipt) = &receipt {
        connection
            .query_row(
                "SELECT phase,result FROM operation_receipts WHERE id=?1",
                [receipt],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
    } else {
        None
    };
    let native = native
        .map(|(phase, result)| -> Result<Value> {
            Ok(json!({"phase":phase,"result":serde_json::from_str::<Value>(&result)?}))
        })
        .transpose()?;
    Ok(
        json!({"id":id,"attemptId":attempt,"phase":phase,"blocker":blocker,"receiptId":receipt,"operationKey":receipt.as_ref().map(|_|format!("run-delivery:{id}")),"createdAt":created,"deadlineAt":deadline,"native":native,"reuse":crate::workflow_session_reuse::summary(connection,attempt)?}),
    )
}
fn changed(transaction: &Transaction<'_>, id: &str, now: u64) -> Result<u64> {
    let (run,subject):(String,Option<String>)=transaction.query_row("SELECT d.run_id,r.coordinator_id FROM workflow_deliveries d JOIN workflow_runs r ON r.id=d.run_id WHERE d.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    transaction.execute(
        "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
        [&run],
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            at: now,
            event: DomainEvent::RunDeliveryChanged(model::RunDelivery {
                run_id: run,
                delivery_id: id.into(),
            }),
        }],
    )
}
fn update(
    connection: &mut Connection,
    id: &str,
    phase: Option<&str>,
    code: Option<&str>,
    now: u64,
) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let count=transaction.execute("UPDATE workflow_deliveries SET phase=COALESCE(?2,phase),blocker=?3 WHERE id=?1 AND phase='queued' AND (phase!=COALESCE(?2,phase) OR blocker IS NOT ?3)",params![id,phase,code])?;
    if count > 0 {
        changed(&transaction, id, now)?;
    }
    transaction.commit()?;
    Ok(())
}
pub fn recover(connection: &mut Connection) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows = {
        let mut q = transaction.prepare(
            "SELECT id,phase FROM workflow_deliveries WHERE phase IN ('queued','dispatching')",
        )?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, phase) in rows {
        transaction.execute(
            "UPDATE workflow_deliveries SET phase=?2,blocker='host_restart' WHERE id=?1",
            params![
                id,
                if phase == "queued" {
                    "paused"
                } else {
                    "unknown"
                }
            ],
        )?;
        changed(&transaction, &id, crate::status::now_millis())?;
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
    live: Option<crate::workflow_session_reuse::Live>,
) -> Result<Reply> {
    let (key, run, revision) = match &request {
        Request::Queue {
            key,
            run_id,
            expected_revision,
            ..
        }
        | Request::Cancel {
            key,
            run_id,
            expected_revision,
            ..
        } => (key, run_id, *expected_revision),
    };
    orchestration::validate_key(key)?;
    orchestration::run(connection, &actor, run)?;
    crate::workflow_budget::refresh(connection, run, now)?;
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"delivery","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = orchestration::run(&transaction, &actor, run)?;
    if let Some(view) = orchestration::replay(&transaction, &actor, key, &fingerprint)? {
        return Ok(Reply::Prepared {
            view,
            pending: None,
        });
    }
    if let Some(guard) = &executor {
        crate::workflow_executor::guard_run(&transaction, guard, &actor.issuer, run)?;
    }
    orchestration::mutation_capacity(&transaction)?;
    if current["revision"] != revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; inspect before changing task delivery",
        )
        .into());
    }
    let (id, attempt, pending) = match &request {
        Request::Queue {
            task_id,
            timeout_ms,
            session_id,
            ..
        } => {
            if current["state"] != "active" {
                return Err(Error::new(
                    "run_state_conflict",
                    "Only an active run accepts a task instruction intent",
                )
                .into());
            }
            let timeout = timeout_ms.unwrap_or(60_000);
            if !(1..=300_000).contains(&timeout) {
                return Err(Error::new(
                    "invalid_argument",
                    "Delivery readiness timeout must be 1–300000 ms",
                )
                .into());
            }
            let task = crate::workflow_attempts::task(&transaction, run, task_id)?;
            if crate::submission::digest(&task.instruction).is_none() {
                return Err(Error::new(
                    "invalid_argument",
                    "Task instruction cannot be submitted safely",
                )
                .into());
            }
            let (attempt, session) = match (session_id, &live) {
                (Some(session), Some(live)) => (
                    crate::workflow_session_reuse::admit(
                        &transaction,
                        run,
                        task_id,
                        session,
                        live,
                        now,
                    )?,
                    session.clone(),
                ),
                (Some(_), None) => {
                    return Err(Error::new(
                        "invalid_argument",
                        "Session reuse needs host-observed live session evidence",
                    )
                    .into());
                }
                (None, _) => {
                    let attempt:Option<(String,String)>=transaction.query_row("SELECT id,session_id FROM workflow_attempts WHERE task_id=?1 AND state='assigned' AND ordinal=(SELECT MAX(ordinal) FROM workflow_attempts WHERE task_id=?1)",[task_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                    attempt.ok_or_else(|| {
                        Error::new(
                            "attempt_state_conflict",
                            "Task needs its current assigned worker before queuing an instruction",
                        )
                    })?
                }
            };
            crate::workflow_budget::guard_dispatch_transaction(&transaction, &session, now)?;
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_deliveries WHERE attempt_id=?1)",
                [&attempt],
                |r| r.get(0),
            )?;
            if exists {
                return Err(Error::new("delivery_exists","This attempt already has an instruction intent; inspect its history and native receipt").into());
            }
            let (pending,retained):(i64,i64)=transaction.query_row("SELECT SUM(CASE WHEN phase IN ('queued','dispatching') THEN 1 ELSE 0 END),count(*) FROM workflow_deliveries",[],|r|Ok((r.get::<_,Option<i64>>(0)?.unwrap_or(0),r.get(1)?)))?;
            if pending >= 64 || retained >= 4096 {
                return Err(Error::new(
                    "busy",
                    "Task delivery capacity is exhausted; no history was evicted",
                )
                .into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            let deadline = now.saturating_add(timeout);
            transaction.execute("INSERT INTO workflow_deliveries(id,run_id,attempt_id,issuer,phase,created_at,deadline_at) VALUES(?1,?2,?3,?4,'queued',?5,?6)",params![id,run,attempt,actor.issuer,now as i64,deadline as i64])?;
            let pending = Pending {
                id: id.clone(),
                run_id: run.clone(),
                session_id: session,
                coordinator: current["coordinatorSessionId"].as_str().map(str::to_owned),
                deadline_at: deadline,
            };
            (id, attempt, Some(pending))
        }
        Request::Cancel { delivery_id, .. } => {
            let row: Option<(String, String)> = transaction
                .query_row(
                    "SELECT attempt_id,phase FROM workflow_deliveries WHERE id=?1 AND run_id=?2",
                    params![delivery_id, run],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (attempt, phase) =
                row.ok_or_else(|| Error::new("delivery_not_found", "Delivery is not in this run"))?;
            if phase != "queued" {
                return Err(Error::new("delivery_state_conflict","Only an unclaimed instruction intent can be canceled; native input needs receipt inspection").into());
            }
            transaction.execute("UPDATE workflow_deliveries SET phase='canceled',blocker='user_canceled' WHERE id=?1",[delivery_id])?;
            (delivery_id.clone(), attempt, None)
        }
    };
    let cursor = changed(&transaction, &id, now)?;
    let mut view = orchestration::view(&transaction, &actor, run)?;
    view["delivery"] = summary(&transaction, &attempt)?;
    view["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, key, &fingerprint, &view)?;
    transaction.commit()?;
    Ok(Reply::Prepared { view, pending })
}
pub fn execute(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    match work {
        Work::Prepare { actor, request } => prepare(connection, actor, request, now, None, None),
        Work::Reuse {
            actor,
            request,
            live,
        } => prepare(connection, actor, request, now, None, Some(live)),
        Work::PrepareForExecutor {
            actor,
            request,
            guard,
        } => prepare(connection, actor, request, now, Some(guard), None),
        Work::Inspect { id } => Ok(Reply::Current {
            queued: connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_deliveries WHERE id=?1 AND phase='queued')",
                [id],
                |r| r.get(0),
            )?,
        }),
        Work::Note { id, code } => {
            update(connection, &id, None, Some(&code), now)?;
            Ok(Reply::Done)
        }
        Work::Abandon { id, phase, code } => {
            if !matches!(phase, "failed" | "paused" | "expired") {
                return Err(anyhow!("Invalid queued delivery outcome"));
            }
            update(connection, &id, Some(phase), Some(&code), now)?;
            Ok(Reply::Done)
        }
        Work::Claim { id, conversation } => {
            let row:Option<(String,String,String,i64)>=connection.query_row("SELECT d.attempt_id,a.session_id,d.issuer,d.deadline_at FROM workflow_deliveries d JOIN workflow_attempts a ON a.id=d.attempt_id WHERE d.id=?1 AND d.phase='queued'",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((attempt, session, issuer, deadline)) = row else {
                return Ok(Reply::Claimed(None));
            };
            if now >= deadline as u64 {
                update(
                    connection,
                    &id,
                    Some("expired"),
                    Some("readiness_timeout"),
                    now,
                )?;
                return Ok(Reply::Claimed(None));
            }
            crate::workflow_budget::guard_dispatch(connection, &session, now)?;
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let queued: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_deliveries WHERE id=?1 AND phase='queued')",
                [&id],
                |r| r.get(0),
            )?;
            if !queued {
                return Ok(Reply::Claimed(None));
            }
            crate::workflow_budget::guard_dispatch_transaction(&transaction, &session, now)?;
            crate::workflow_session_reuse::guard_claim(
                &transaction,
                &attempt,
                conversation.as_deref(),
            )?;
            let (run,task):(String,String)=transaction.query_row("SELECT t.run_id,t.id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let prompt = crate::workflow_context::task_prompt(
                &transaction,
                &run,
                crate::workflow_attempts::task(&transaction, &run, &task)?.instruction,
            )?;
            let accepted = crate::receipts::accept_transaction(
                &transaction,
                &issuer,
                &format!("run-delivery:{id}"),
                "send",
                json!({"sessionId":session,"prompt":prompt}),
            )?;
            if !accepted.is_new {
                return Err(anyhow!("New delivery unexpectedly reused native receipt"));
            }
            crate::workflow_context::freeze(&transaction, &run, &accepted.receipt.id)?;
            transaction.execute("UPDATE workflow_deliveries SET phase='dispatching',blocker=NULL,operation_id=?2 WHERE id=?1",params![id,accepted.receipt.id])?;
            crate::workflow_session_reuse::record(&transaction, &id, conversation.as_deref())?;
            changed(&transaction, &id, now)?;
            transaction.commit()?;
            Ok(Reply::Claimed(Some(Dispatch {
                receipt: accepted.receipt,
                prompt,
            })))
        }
        Work::Finish { id } => {
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let row:Option<(String,String)>=transaction.query_row("SELECT o.phase,o.result FROM workflow_deliveries d JOIN operation_receipts o ON o.id=d.operation_id WHERE d.id=?1 AND d.phase='dispatching'",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((phase, result)) = row {
                let result: Value = serde_json::from_str(&result)?;
                let phase = if result["nativeWriteFlushed"] == true
                    || result["providerPromptObserved"] == true
                {
                    "sent"
                } else if phase == "failed" && result["effectStarted"] == false {
                    "failed"
                } else {
                    "unknown"
                };
                transaction.execute(
                    "UPDATE workflow_deliveries SET phase=?2,blocker=?3 WHERE id=?1",
                    params![id, phase, result["code"].as_str()],
                )?;
                changed(&transaction, &id, now)?;
            }
            transaction.commit()?;
            Ok(Reply::Done)
        }
    }
}
