//! Attempt-bound questions. A recorded answer is data, never a native permission grant.
use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor, Scope},
    workflow_attempts,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

type RunDecisionEvent = fn(model::RunDecision) -> DomainEvent;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Audience {
    Owner,
    Coordinator,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Ask {
        key: String,
        attempt_id: String,
        audience: Audience,
        question: String,
        timeout_ms: u64,
    },
    List {
        run_id: String,
        attempt_id: Option<String>,
        offset: Option<usize>,
    },
    Get {
        run_id: String,
        decision_id: String,
    },
    Answer {
        key: String,
        run_id: String,
        decision_id: String,
        expected_revision: u64,
        answer: String,
    },
    Cancel {
        key: String,
        run_id: String,
        decision_id: String,
        expected_revision: u64,
        reason: String,
    },
    Pending {
        page: Option<u16>,
    },
    Decide {
        decision_id: String,
        choice: String,
        note: Option<String>,
    },
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_decisions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(id),attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),revision INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_decisions_attempt ON workflow_decisions(attempt_id,sequence);")?;
    Ok(())
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
fn text(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 2048
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
        && serde_json::to_string(value).is_ok_and(|s| s.len() <= 3072)
}
fn event(transaction: &Transaction<'_>, run: &Value, event: DomainEvent, now: u64) -> Result<u64> {
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run["id"].as_str()],
        |r| r.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            at: now,
            event,
        }],
    )
}
fn authorize(
    connection: &Connection,
    actor: &Actor,
    run_id: &str,
    attempt_id: Option<&str>,
) -> Result<Value> {
    if matches!(actor.scope, Scope::Worker(_)) {
        let own = workflow_attempts::context(connection, actor, attempt_id)?;
        if own["run"]["id"] != run_id {
            return Err(
                Error::new("run_not_found", "Decision is unavailable to this caller").into(),
            );
        }
        Ok(own["run"].clone())
    } else {
        orchestration::run(connection, actor, run_id)
    }
}
fn load(connection: &Connection, run_id: &str, id: &str) -> Result<Value> {
    let row: Option<(String, i64, String)> = connection
        .query_row(
            "SELECT data,revision,state FROM workflow_decisions WHERE run_id=?1 AND id=?2",
            params![run_id, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (source, revision, state) =
        row.ok_or_else(|| Error::new("decision_not_found", "Decision is unavailable in this run"))?;
    let mut value: Value = serde_json::from_str(&source)?;
    value["revision"] = revision.into();
    value["state"] = state.into();
    Ok(value)
}
fn base(run: Value, decision: Value) -> Value {
    json!({"run":{"id":run["id"],"title":run["title"],"revision":run["revision"],"state":run["state"]},"task":{"id":decision["taskId"]},"attempt":{"id":decision["attemptId"]},"decision":decision})
}
fn identity(actor: &Actor) -> Value {
    match &actor.scope {
        Scope::Owner => json!({"role":"owner"}),
        Scope::Coordinator(id) => json!({"role":"coordinator","sessionId":id}),
        Scope::Worker(id) => json!({"role":"worker","sessionId":id}),
    }
}
fn save(transaction: &Transaction<'_>, decision: &Value) -> Result<()> {
    transaction.execute(
        "UPDATE workflow_decisions SET revision=?2,state=?3,data=?4 WHERE id=?1",
        params![
            decision["id"].as_str(),
            decision["revision"].as_i64(),
            decision["state"].as_str(),
            serde_json::to_string(decision)?
        ],
    )?;
    Ok(())
}
/// Housekeeping commits before the requested action, so a rejected late answer
/// cannot roll a deadline back into a pending question. No model/native effect.
fn expire(
    connection: &mut Connection,
    run: &Value,
    attempt_id: Option<&str>,
    now: u64,
) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut statement = transaction.prepare("SELECT id FROM workflow_decisions WHERE run_id=?1 AND state='pending' AND (?2 IS NULL OR attempt_id=?2)")?;
    let ids = statement
        .query_map(params![run["id"].as_str(), attempt_id], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut count = 0;
    for id in ids {
        let mut d = load(
            &transaction,
            run["id"]
                .as_str()
                .ok_or_else(|| invalid("Missing run identity"))?,
            &id,
        )?;
        if d["expiresAt"].as_u64().is_some_and(|at| at <= now) {
            d["state"] = "expired".into();
            d["revision"] = (d["revision"].as_u64().unwrap_or(1) + 1).into();
            d["resolvedAt"] = now.into();
            save(&transaction, &d)?;
            count += 1;
        }
    }
    if count > 0 {
        event(
            &transaction,
            run,
            DomainEvent::RunDecisionsExpired(model::RunCount {
                run_id: crate::event_log::field(&run["id"])?,
                count,
            }),
            now,
        )?;
    }
    transaction.commit()?;
    Ok(())
}
pub(crate) fn expire_due(connection: &mut Connection, now: u64) -> Result<()> {
    let mut statement = connection.prepare("SELECT DISTINCT run_id FROM workflow_decisions WHERE state='pending' AND json_extract(data,'$.expiresAt')<=?1")?;
    let runs = statement
        .query_map([now as i64], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for run in runs {
        expire(connection, &json!({ "id": run }), None, now)?;
    }
    Ok(())
}
pub(crate) fn inbox_id(run_id: &str, decision_id: &str) -> String {
    format!("decision:{run_id}:{decision_id}")
}
fn owner_only(actor: &Actor) -> Result<()> {
    if matches!(actor.scope, Scope::Owner) {
        Ok(())
    } else {
        Err(Error::new("forbidden", "Only the owner can read or decide across runs").into())
    }
}
const PENDING_PAGE: usize = 8;
fn pending(connection: &mut Connection, actor: &Actor, page: u16, now: u64) -> Result<Value> {
    owner_only(actor)?;
    if page > 512 {
        return Err(invalid("Decision page exceeds retention"));
    }
    expire_due(connection, now)?;
    let total: i64 = connection.query_row(
        "SELECT count(*) FROM workflow_decisions WHERE state='pending'",
        [],
        |r| r.get(0),
    )?;
    let mut statement = connection.prepare("SELECT d.id,d.run_id,r.title,r.state FROM workflow_decisions d JOIN workflow_runs r ON r.id=d.run_id WHERE d.state='pending' ORDER BY d.sequence LIMIT ?1 OFFSET ?2")?;
    let rows = statement
        .query_map(
            params![
                (PENDING_PAGE + 1) as i64,
                (usize::from(page) * PENDING_PAGE) as i64
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let more = rows.len() > PENDING_PAGE;
    let decisions = rows
        .into_iter()
        .take(PENDING_PAGE)
        .map(|(id, run_id, title, state)| {
            let mut decision = load(connection, &run_id, &id)?;
            decision["inboxId"] = inbox_id(&run_id, &id).into();
            decision["run"] = json!({"id":run_id,"title":title,"state":state});
            Ok(decision)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"decisions":decisions,"page":page,"nextPage":more.then_some(page+1),"total":total}))
}
fn decide(
    connection: &mut Connection,
    actor: Actor,
    decision_id: String,
    choice: String,
    note: Option<String>,
    now: u64,
) -> Result<Value> {
    owner_only(&actor)?;
    let run_id: String = connection
        .query_row(
            "SELECT run_id FROM workflow_decisions WHERE id=?1",
            [&decision_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::new("decision_not_found", "Decision is unavailable"))?;
    expire(connection, &json!({ "id": run_id }), None, now)?;
    let current = load(connection, &run_id, &decision_id)?;
    match current["state"].as_str() {
        Some("pending") => {}
        Some("expired") => {
            return Err(Error::new(
                "decision_expired",
                "Decision expired before an answer was recorded",
            )
            .into());
        }
        _ => {
            return Err(Error::new(
                "decision_resolved",
                "Decision was already answered or canceled",
            )
            .into());
        }
    }
    let answer = match note.as_deref().map(str::trim) {
        Some(note) if !note.is_empty() => format!(
            "{choice}

{note}"
        ),
        _ => choice,
    };
    let revision = current["revision"]
        .as_u64()
        .ok_or_else(|| invalid("Missing decision revision"))?;
    let mut result = execute(
        connection,
        actor,
        Request::Answer {
            key: format!("decide:{decision_id}:{revision}"),
            run_id: run_id.clone(),
            decision_id: decision_id.clone(),
            expected_revision: revision,
            answer,
        },
        now,
    )?;
    result["inboxId"] = inbox_id(&run_id, &decision_id).into();
    Ok(result)
}
pub fn summary(connection: &Connection, attempt: &str) -> Result<Value> {
    let (total,pending,unresolved):(i64,i64,i64) = connection.query_row("SELECT count(*),COALESCE(SUM(state='pending'),0),COALESCE(SUM(state!='answered'),0) FROM workflow_decisions WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    Ok(
        json!({"total":total,"pending":pending,"unresolved":unresolved,"blocksSuccess":unresolved>0}),
    )
}
pub fn guard_result(
    transaction: &Transaction<'_>,
    attempt: &str,
    success: bool,
    now: u64,
) -> Result<()> {
    let unresolved: i64 = transaction.query_row(
        "SELECT count(*) FROM workflow_decisions WHERE attempt_id=?1 AND state!='answered'",
        [attempt],
        |r| r.get(0),
    )?;
    if success && unresolved > 0 {
        return Err(Error::new("decision_pending","Successful reporting requires all decisions answered; canceled/expired gates require a non-success result and deliberate retry").into());
    }
    if !success {
        close_pending(
            transaction,
            attempt,
            now,
            "Attempt reported a non-success outcome",
        )?;
    }
    Ok(())
}
pub(crate) fn close_pending(
    transaction: &Transaction<'_>,
    attempt: &str,
    now: u64,
    reason: &str,
) -> Result<()> {
    let mut statement = transaction.prepare(
        "SELECT id,run_id FROM workflow_decisions WHERE attempt_id=?1 AND state='pending'",
    )?;
    let rows = statement
        .query_map([attempt], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (id, run) in rows {
        let mut d = load(transaction, &run, &id)?;
        d["state"] = if d["expiresAt"].as_u64().is_some_and(|at| at <= now) {
            "expired"
        } else {
            "canceled"
        }
        .into();
        d["revision"] = (d["revision"].as_u64().unwrap_or(1) + 1).into();
        d["resolvedAt"] = now.into();
        d["reason"] = reason.into();
        save(transaction, &d)?;
    }
    Ok(())
}
pub fn execute(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
) -> Result<Value> {
    let request = match request {
        Request::Pending { page } => return pending(connection, &actor, page.unwrap_or(0), now),
        Request::Decide {
            decision_id,
            choice,
            note,
        } => return decide(connection, actor, decision_id, choice, note, now),
        request => request,
    };
    // Derive the run/attempt before any expiration or message side effect.
    let (run_id, filter) = match &request {
        Request::Ask { attempt_id, .. } => {
            let own = workflow_attempts::context(connection, &actor, Some(attempt_id))?;
            (
                own["run"]["id"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing run identity"))?
                    .to_owned(),
                Some(attempt_id.clone()),
            )
        }
        Request::Pending { .. } | Request::Decide { .. } => unreachable!(),
        Request::List {
            run_id, attempt_id, ..
        } => (run_id.clone(), attempt_id.clone()),
        Request::Get {
            run_id,
            decision_id,
        }
        | Request::Answer {
            run_id,
            decision_id,
            ..
        }
        | Request::Cancel {
            run_id,
            decision_id,
            ..
        } => {
            authorize(connection, &actor, run_id, None)?;
            let d = load(connection, run_id, decision_id)?;
            (
                run_id.clone(),
                Some(
                    d["attemptId"]
                        .as_str()
                        .ok_or_else(|| invalid("Missing attempt identity"))?
                        .to_owned(),
                ),
            )
        }
    };
    let run = authorize(connection, &actor, &run_id, filter.as_deref())?;
    let filter = if matches!(actor.scope, Scope::Worker(_)) {
        Some(
            workflow_attempts::context(connection, &actor, filter.as_deref())?["attempt"]["id"]
                .as_str()
                .ok_or_else(|| invalid("Missing worker attempt"))?
                .to_owned(),
        )
    } else {
        filter
    };
    expire(connection, &run, filter.as_deref(), now)?;
    if let Request::List { offset, .. } = request {
        let offset = offset.unwrap_or(0);
        if offset > 4096 {
            return Err(invalid("Decision offset exceeds retention"));
        }
        let mut statement = connection.prepare("SELECT id FROM workflow_decisions WHERE run_id=?1 AND (?2 IS NULL OR attempt_id=?2) ORDER BY sequence LIMIT 9 OFFSET ?3")?;
        let ids = statement
            .query_map(params![run_id, filter, offset as i64], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = ids.len() > 8;
        let decisions = ids
            .iter()
            .take(8)
            .map(|id| load(connection, &run_id, id))
            .collect::<Result<Vec<_>>>()?;
        let mut result = json!({"run":{"id":run["id"],"title":run["title"],"revision":run["revision"],"state":run["state"]},"decisions":decisions,"nextOffset":more.then_some(offset+8)});
        if let Some(id) = filter {
            result["attempt"] = json!({"id":id});
        }
        return Ok(result);
    }
    if let Request::Get { decision_id, .. } = request {
        return Ok(base(run, load(connection, &run_id, &decision_id)?));
    }
    let key = match &request {
        Request::Ask { key, .. } | Request::Answer { key, .. } | Request::Cancel { key, .. } => key,
        _ => unreachable!(),
    };
    orchestration::validate_key(key)?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"decision","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(previous) = orchestration::replay(&transaction, &actor, key, &digest)? {
        return Ok(previous);
    }
    orchestration::mutation_capacity(&transaction)?;
    let (d, kind, to_worker, notice): (_, RunDecisionEvent, _, _) = match &request {
        Request::Ask {
            attempt_id,
            audience,
            question,
            timeout_ms,
            ..
        } => {
            let own = workflow_attempts::context(&transaction, &actor, Some(attempt_id))?;
            if !matches!(own["run"]["state"].as_str(), Some("active" | "draining"))
                || own["attempt"]["state"] != "assigned"
            {
                return Err(Error::new(
                    "attempt_state_conflict",
                    "Only a current assigned worker can ask a decision",
                )
                .into());
            }
            if !text(question) || !(1000..=604_800_000).contains(timeout_ms) {
                return Err(invalid(
                    "Question must fit 2048 UTF-8/3072 encoded bytes; timeout is 1 second–7 days",
                ));
            }
            let count: i64 = transaction.query_row(
                "SELECT count(*) FROM workflow_decisions WHERE attempt_id=?1",
                [attempt_id],
                |r| r.get(0),
            )?;
            let pending: i64 = transaction.query_row(
                "SELECT count(*) FROM workflow_decisions WHERE attempt_id=?1 AND state='pending'",
                [attempt_id],
                |r| r.get(0),
            )?;
            let total: i64 =
                transaction
                    .query_row("SELECT count(*) FROM workflow_decisions", [], |r| r.get(0))?;
            if pending > 0 {
                return Err(Error::new(
                    "decision_pending",
                    "Resolve the existing question before asking another",
                )
                .into());
            }
            let closed: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM workflow_decisions WHERE attempt_id=?1 AND state IN ('expired','canceled'))",[attempt_id],|r|r.get(0))?;
            if closed {
                return Err(Error::new("attempt_state_conflict","Canceled or expired decisions require a non-success result and a deliberate new attempt").into());
            }
            if count >= 16 || total >= 4096 {
                return Err(Error::new(
                    "busy",
                    "Decision retention exhausted; existing questions remain readable",
                )
                .into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            let expires = now
                .checked_add(*timeout_ms)
                .filter(|t| *t <= 9_007_199_254_740_991)
                .ok_or_else(|| invalid("Decision deadline exceeds clock bounds"))?;
            let d = json!({"id":id,"runId":run_id,"taskId":own["task"]["id"],"attemptId":attempt_id,"audience":audience,"question":question,"askedBy":identity(&actor),"createdAt":now,"expiresAt":expires,"revision":1,"state":"pending","answer":null,"reason":null,"resolvedAt":null,"resolvedBy":null});
            transaction.execute("INSERT INTO workflow_decisions(id,run_id,attempt_id,revision,state,data) VALUES(?1,?2,?3,1,'pending',?4)",params![id,run_id,attempt_id,serde_json::to_string(&d)?])?;
            (d, DomainEvent::RunDecisionAsked, false, question.clone())
        }
        Request::Answer {
            decision_id,
            expected_revision,
            answer,
            ..
        }
        | Request::Cancel {
            decision_id,
            expected_revision,
            reason: answer,
            ..
        } => {
            let mut d = load(&transaction, &run_id, decision_id)?;
            let attempt = d["attemptId"]
                .as_str()
                .ok_or_else(|| invalid("Missing decision attempt"))?;
            let own = if matches!(actor.scope, Scope::Worker(_)) {
                workflow_attempts::context(&transaction, &actor, Some(attempt))?["attempt"].clone()
            } else {
                workflow_attempts::active_attempt(&transaction, &run_id, attempt)?
            };
            let cancel = matches!(request, Request::Cancel { .. });
            if matches!(actor.scope, Scope::Worker(_)) && !cancel
                || d["audience"] == "owner" && matches!(actor.scope, Scope::Coordinator(_))
            {
                return Err(Error::new("forbidden","Only the addressed coordinator or explicit owner can answer; workers may withdraw their own question").into());
            }
            if !matches!(run["state"].as_str(), Some("active" | "draining"))
                || own["state"] != "assigned"
            {
                return Err(Error::new(
                    "attempt_state_conflict",
                    "Decision requires the current assigned attempt",
                )
                .into());
            }
            if d["revision"] != *expected_revision {
                return Err(Error::new(
                    "revision_conflict",
                    "Decision revision changed; read it before answering",
                )
                .into());
            }
            if d["state"] != "pending" {
                return Err(Error::new(
                    "decision_state_conflict",
                    "Decision has already resolved or expired",
                )
                .into());
            }
            if !text(answer) {
                return Err(invalid(
                    "Decision answer/reason must fit 2048 UTF-8/3072 encoded bytes",
                ));
            }
            d["revision"] = (expected_revision + 1).into();
            d["state"] = if cancel { "canceled" } else { "answered" }.into();
            d[if cancel { "reason" } else { "answer" }] = answer.clone().into();
            d["resolvedAt"] = now.into();
            d["resolvedBy"] = identity(&actor);
            save(&transaction, &d)?;
            (
                d,
                if cancel {
                    DomainEvent::RunDecisionCanceled
                } else {
                    DomainEvent::RunDecisionAnswered
                },
                true,
                answer.clone(),
            )
        }
        _ => unreachable!(),
    };
    let result_base = base(run.clone(), d);
    crate::workflow_inbox::decision_notice(&transaction, &actor, &result_base, to_worker, &notice)?;
    let cursor = event(
        &transaction,
        &run,
        kind(model::RunDecision {
            run_id: run_id.clone(),
            decision_id: crate::event_log::field(&result_base["decision"]["id"])?,
            state: crate::event_log::field(&result_base["decision"]["state"])?,
        }),
        now,
    )?;
    let mut result = result_base;
    result["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, key, &digest, &result)?;
    transaction.commit()?;
    Ok(result)
}
