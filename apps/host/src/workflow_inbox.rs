//! Durable addressed messages. Reading/ACK never executes or validates task work.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor, Scope},
    status::now_millis,
    workflow_attempts,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_CURSOR: u64 = 9_007_199_254_740_991;
const COORDINATOR: &str = "coordinator";
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Note,
    Question,
    Error,
}
impl Kind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Question => "question",
            Self::Error => "error",
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
    Read {
        run_id: String,
        attempt_id: Option<String>,
        after: Option<u64>,
        include_acked: Option<bool>,
    },
    Send {
        key: String,
        run_id: String,
        attempt_id: Option<String>,
        correlation_id: String,
        #[serde(default)]
        kind: Kind,
        body: String,
    },
    Ack {
        run_id: String,
        attempt_id: Option<String>,
        ids: Vec<String>,
    },
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(id),recipient TEXT NOT NULL,data TEXT NOT NULL,acked_at INTEGER,acked_by TEXT);
      CREATE INDEX IF NOT EXISTS workflow_messages_pending ON workflow_messages(run_id,recipient,acked_at,sequence);")?;
    Ok(())
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
enum Access {
    Read,
    Send,
    Ack,
}
struct Mailbox {
    base: Value,
    recipient: String,
}
fn resolve(
    connection: &Connection,
    actor: &Actor,
    run_id: &str,
    attempt: Option<&str>,
    access: Access,
) -> Result<Mailbox> {
    let (run, own) = if matches!(actor.scope, Scope::Worker(_)) {
        let own = workflow_attempts::context(connection, actor, None)?;
        if own["run"]["id"] != run_id {
            return Err(
                Error::new("run_not_found", "Mailbox is unavailable to this caller").into(),
            );
        }
        (own["run"].clone(), Some(own["attempt"]["id"].clone()))
    } else {
        (orchestration::run(connection, actor, run_id)?, None)
    };
    let target = if let Some(own) = &own {
        let id = own
            .as_str()
            .ok_or_else(|| invalid("Worker context has no attempt identity"))?;
        if matches!(access, Access::Send) {
            if attempt.is_some() {
                return Err(Error::new(
                    "forbidden",
                    "Workers may message only their run coordinator",
                )
                .into());
            }
            None
        } else {
            if attempt.is_some_and(|a| a != id) {
                return Err(Error::new(
                    "forbidden",
                    "Worker cannot consume another attempt mailbox",
                )
                .into());
            }
            Some(id.to_owned())
        }
    } else {
        if matches!(actor.scope, Scope::Coordinator(_))
            && attempt.is_some()
            && matches!(access, Access::Ack)
        {
            return Err(Error::new(
                "forbidden",
                "Only the receiving worker or explicit owner can acknowledge its mailbox",
            )
            .into());
        }
        if let Some(id) = attempt {
            let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id=?1 AND t.run_id=?2)",params![id,run_id],|r|r.get(0))?;
            if !exists {
                return Err(Error::new(
                    "attempt_not_found",
                    "Mailbox attempt is unavailable in this run",
                )
                .into());
            }
            if matches!(access, Access::Send) {
                workflow_attempts::active_attempt(connection, run_id, id)?;
            }
        }
        attempt.map(str::to_owned)
    };
    let mut base = json!({"run":{"id":run["id"],"title":run["title"],"revision":run["revision"],"state":run["state"]},"mailbox":{"runId":run_id,"recipientAttemptId":target}});
    if let Some(id) = own {
        base["attempt"] = json!({"id":id});
    }
    Ok(Mailbox {
        base,
        recipient: target.map_or_else(|| COORDINATOR.into(), |id| format!("attempt:{id}")),
    })
}
fn identity(actor: &Actor, base: &Value) -> Value {
    match &actor.scope {
        Scope::Owner => json!({"role":"owner"}),
        Scope::Coordinator(id) => json!({"role":"coordinator","sessionId":id}),
        Scope::Worker(id) => {
            json!({"role":"worker","sessionId":id,"attemptId":base["attempt"]["id"]})
        }
    }
}
type Stored = (i64, String, Option<i64>, Option<String>);
fn decode((sequence, source, acked_at, acked_by): Stored) -> Result<Value> {
    let mut message: Value = serde_json::from_str(&source)?;
    message["sequence"] = sequence.into();
    message["ackedAt"] = json!(acked_at);
    message["ackedBy"] = acked_by
        .map(|source| serde_json::from_str(&source))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(message)
}
fn insert(
    transaction: &Transaction<'_>,
    run_id: &str,
    recipient: &str,
    mut data: Value,
) -> Result<Value> {
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_messages", [], |r| r.get(0))?;
    if count >= 8192 {
        return Err(Error::new(
            "busy",
            "Inbox retention capacity exhausted; retained messages remain recoverable",
        )
        .into());
    }
    let id = hex::encode(crate::wire::random::<16>());
    data["id"] = id.clone().into();
    data["runId"] = run_id.into();
    data["createdAt"] = now_millis().into();
    let source = serde_json::to_string(&data)?;
    if source.len() > 6144 {
        return Err(invalid("Encoded inbox message exceeds 6 KiB"));
    }
    transaction.execute(
        "INSERT INTO workflow_messages(id,run_id,recipient,data) VALUES(?1,?2,?3,?4)",
        params![id, run_id, recipient, source],
    )?;
    let sequence = transaction.last_insert_rowid();
    if !(1..=MAX_CURSOR as i64).contains(&sequence) {
        return Err(Error::new("busy", "Inbox sequence capacity exhausted").into());
    }
    decode((sequence, source, None, None))
}
fn event(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: &'static str,
    payload: Value,
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
            kind,
            at: now_millis(),
            payload,
        }],
    )
}
pub fn notify_result(
    transaction: &Transaction<'_>,
    actor: &Actor,
    own: &Value,
    result: &workflow_attempts::ResultSpec,
) -> Result<()> {
    let run_id = own["run"]["id"]
        .as_str()
        .ok_or_else(|| invalid("Result has no run identity"))?;
    insert(
        transaction,
        run_id,
        COORDINATOR,
        json!({"recipientAttemptId":null,"sender":identity(actor,own),"correlationId":own["attempt"]["id"],"kind":"result","body":result.summary,"payload":{"taskId":own["task"]["id"],"attemptId":own["attempt"]["id"],"reportedOutcome":result.outcome}}),
    )?;
    Ok(())
}
fn read(
    connection: &Connection,
    mut mailbox: Mailbox,
    run_id: &str,
    after: u64,
    include_acked: bool,
) -> Result<Value> {
    let head: i64 = connection.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM workflow_messages WHERE run_id=?1 AND recipient=?2",
        params![run_id, mailbox.recipient],
        |r| r.get(0),
    )?;
    if after > MAX_CURSOR || head < 0 || after > head as u64 {
        return Err(Error::new("invalid_cursor", "Inbox cursor is ahead of this mailbox").into());
    }
    let pending:i64=connection.query_row("SELECT count(*) FROM workflow_messages WHERE run_id=?1 AND recipient=?2 AND acked_at IS NULL",params![run_id,mailbox.recipient],|r|r.get(0))?;
    let mut statement=connection.prepare("SELECT sequence,data,acked_at,acked_by FROM workflow_messages WHERE run_id=?1 AND recipient=?2 AND sequence>?3 AND (?4 OR acked_at IS NULL) ORDER BY sequence LIMIT 9")?;
    let rows = statement
        .query_map(
            params![run_id, mailbox.recipient, after as i64, include_acked],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?
        .collect::<rusqlite::Result<Vec<Stored>>>()?;
    let more = rows.len() > 8;
    let messages = rows
        .into_iter()
        .take(8)
        .map(decode)
        .collect::<Result<Vec<_>>>()?;
    let next = if more {
        messages
            .last()
            .and_then(|m| m["sequence"].as_u64())
            .unwrap_or(after)
    } else {
        head as u64
    };
    mailbox.base["messages"] = messages.into();
    mailbox.base["nextCursor"] = next.into();
    mailbox.base["headCursor"] = head.into();
    mailbox.base["more"] = more.into();
    mailbox.base["pendingCount"] = pending.into();
    Ok(mailbox.base)
}
pub fn execute(connection: &mut Connection, actor: Actor, request: Request) -> Result<Value> {
    match request {
        Request::Read {
            run_id,
            attempt_id,
            after,
            include_acked,
        } => {
            let transaction = connection.transaction()?;
            let mailbox = resolve(
                &transaction,
                &actor,
                &run_id,
                attempt_id.as_deref(),
                Access::Read,
            )?;
            let page = read(
                &transaction,
                mailbox,
                &run_id,
                after.unwrap_or(0),
                include_acked.unwrap_or(false),
            )?;
            transaction.commit()?;
            Ok(page)
        }
        Request::Send {
            ref key,
            ref run_id,
            ref attempt_id,
            ref correlation_id,
            ref kind,
            ref body,
        } => {
            orchestration::validate_key(key)?;
            orchestration::validate_key(correlation_id)?;
            if body.trim().is_empty()
                || body.len() > 4096
                || body
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
            {
                return Err(invalid(
                    "Message body must be nonempty UTF-8 within 4096 bytes without terminal controls",
                ));
            }
            let digest = hex::encode(
                ring::digest::digest(
                    &ring::digest::SHA256,
                    &serde_json::to_vec(&json!({"action":"inbox","request":request}))?,
                )
                .as_ref(),
            );
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if let Some(previous) = orchestration::replay(&transaction, &actor, key, &digest)? {
                return Ok(previous);
            }
            let mut mailbox = resolve(
                &transaction,
                &actor,
                run_id,
                attempt_id.as_deref(),
                Access::Send,
            )?;
            orchestration::mutation_capacity(&transaction)?;
            let message = insert(
                &transaction,
                run_id,
                &mailbox.recipient,
                json!({"recipientAttemptId":mailbox.base["mailbox"]["recipientAttemptId"],"sender":identity(&actor,&mailbox.base),"correlationId":correlation_id,"kind":kind.as_str(),"body":body,"payload":null}),
            )?;
            let cursor = event(
                &transaction,
                run_id,
                "run.message_sent",
                json!({"runId":run_id,"messageId":message["id"]}),
            )?;
            mailbox.base["message"] = message;
            mailbox.base["cursor"] = cursor.into();
            orchestration::remember(&transaction, &actor, key, &digest, &mailbox.base)?;
            transaction.commit()?;
            Ok(mailbox.base)
        }
        Request::Ack {
            run_id,
            attempt_id,
            ids,
        } => {
            if ids.is_empty()
                || ids.len() > 32
                || ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control))
                || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
            {
                return Err(invalid("ACK needs 1–32 distinct bounded message IDs"));
            }
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut mailbox = resolve(
                &transaction,
                &actor,
                &run_id,
                attempt_id.as_deref(),
                Access::Ack,
            )?;
            // Validate the whole batch before changing any acknowledgement.
            let mut rows = Vec::new();
            for id in &ids {
                let row:Option<Stored>=transaction.query_row("SELECT sequence,data,acked_at,acked_by FROM workflow_messages WHERE id=?1 AND run_id=?2 AND recipient=?3",params![id,run_id,mailbox.recipient],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                rows.push((
                    id,
                    row.ok_or_else(|| {
                        Error::new(
                            "message_not_found",
                            "Message is unavailable in this receiving mailbox",
                        )
                    })?,
                ));
            }
            let now = now_millis() as i64;
            let by = serde_json::to_string(&identity(&actor, &mailbox.base))?;
            let mut changed = false;
            let mut acknowledged = Vec::new();
            for (id, (sequence, source, at, by_previous)) in rows {
                let (at, by) = if let Some(at) = at {
                    (at, by_previous)
                } else {
                    transaction.execute("UPDATE workflow_messages SET acked_at=?2,acked_by=?3 WHERE id=?1 AND acked_at IS NULL",params![id,now,by])?;
                    changed = true;
                    (now, Some(by.clone()))
                };
                let value = decode((sequence, source, Some(at), by))?;
                acknowledged
                    .push(json!({"id":id,"ackedAt":value["ackedAt"],"ackedBy":value["ackedBy"]}));
            }
            let cursor = if changed {
                event(
                    &transaction,
                    &run_id,
                    "run.messages_acknowledged",
                    json!({"runId":run_id,"count":acknowledged.len()}),
                )?
            } else {
                transaction.query_row(
                    "SELECT head FROM domain_event_cursor WHERE id=1",
                    [],
                    |r| r.get::<_, i64>(0),
                )? as u64
            };
            mailbox.base["acknowledged"] = acknowledged.into();
            mailbox.base["cursor"] = cursor.into();
            transaction.commit()?;
            Ok(mailbox.base)
        }
    }
}
