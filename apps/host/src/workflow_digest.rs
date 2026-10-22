use crate::{
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor, Scope},
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const MAX_BYTES: usize = 8192;
const SETTLED: [&str; 4] = ["succeeded", "canceled", "stopped", "drained"];
const SUMMARY_BYTES: usize = 240;
const COMPACT_SUMMARY_BYTES: usize = 80;
const ITEM_BYTES: usize = 160;
const DIRECTORY_BYTES: usize = 512;
const NEXT_STEPS: usize = 3;
const FILES: usize = 4;
const OPEN_DECISIONS: usize = 4;
const CHECKPOINTS: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Final,
    WorkingState,
    Inherited,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Final => "final",
            Self::WorkingState => "workingState",
            Self::Inherited => "inherited",
        }
    }
}

pub fn settled(state: &str) -> bool {
    SETTLED.contains(&state)
}

fn host() -> Actor {
    Actor {
        issuer: "host".into(),
        scope: Scope::Owner,
    }
}

pub(crate) fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= max {
        return flat;
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !flat.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &flat[..end])
}

fn texts(value: &Value, limit: usize) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(limit)
        .map(|item| clip(item, ITEM_BYTES).into())
        .collect()
}

fn length(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

fn size(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn decode(source: Option<String>) -> Result<Value> {
    Ok(source
        .map(|text| serde_json::from_str(&text))
        .transpose()?
        .unwrap_or(Value::Null))
}

fn count(connection: &Connection, sql: &str, value: &str) -> Result<i64> {
    Ok(connection.query_row(sql, [value], |row| row.get(0))?)
}

fn workspace(connection: &Connection, attempt: &str, session: &str) -> Result<Value> {
    let launch = crate::workflow_launches::summary(connection, attempt)?;
    let registry = crate::worktrees::session_branch(session);
    if launch.is_null() && registry.is_none() {
        return Ok(Value::Null);
    }
    let directory = launch["preparedWorkspace"]["directory"]
        .as_str()
        .or(launch["directory"].as_str())
        .map(str::to_owned)
        .or_else(|| registry.as_ref().map(|(worktree, _)| worktree.clone()));
    Ok(json!({
        "kind": launch["workspace"].as_str().unwrap_or("worktree"),
        "directory": directory.map(|directory| clip(&directory, DIRECTORY_BYTES)),
        "branch": registry.and_then(|(_, branch)| branch),
    }))
}

fn task_digest(connection: &Connection, task: &Value) -> Result<Value> {
    let mut digest = json!({
        "id": task["id"], "key": task["key"], "title": task["title"], "state": task["state"],
        "dependencyState": task["dependencyState"], "attempts": task["attempts"],
        "attempt": null, "outcome": null, "validation": null, "summary": null,
        "files": [], "filesTotal": 0, "checks": {"passed": 0, "failed": 0, "skipped": 0},
        "limitations": 0, "nextSteps": [], "decisionsAnswered": 0, "nativeOperations": 0,
        "workspace": null,
    });
    let current = &task["currentAttempt"];
    let Some(id) = current["id"].as_str() else {
        return Ok(digest);
    };
    let session = current["sessionId"].as_str().unwrap_or_default();
    let (result, validation): (Option<String>, Option<String>) = connection.query_row(
        "SELECT result,validation FROM workflow_attempts WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (result, validation) = (decode(result)?, decode(validation)?);
    digest["attempt"] = json!({"id": id, "ordinal": current["ordinal"], "sessionId": session, "state": current["state"]});
    digest["outcome"] = result["outcome"].clone();
    if !validation.is_null() {
        digest["validation"] =
            json!({"passed": validation["passed"], "source": validation["source"]});
    }
    if let Some(summary) = result["summary"].as_str() {
        digest["summary"] = clip(summary, SUMMARY_BYTES).into();
    }
    digest["files"] = texts(&result["files"], FILES).into();
    digest["filesTotal"] = length(&result["files"]).into();
    for check in result["checks"].as_array().into_iter().flatten() {
        if let Some(slot) = check["outcome"]
            .as_str()
            .and_then(|outcome| digest["checks"].get_mut(outcome))
        {
            *slot = (slot.as_u64().unwrap_or(0) + 1).into();
        }
    }
    digest["limitations"] = length(&result["limitations"]).into();
    digest["nextSteps"] = texts(&result["nextSteps"], NEXT_STEPS).into();
    digest["decisionsAnswered"] = count(
        connection,
        "SELECT count(*) FROM workflow_decisions WHERE attempt_id=?1 AND state='answered'",
        id,
    )?
    .into();
    digest["nativeOperations"] = native_operations(connection, id, session)?.into();
    digest["workspace"] = workspace(connection, id, session)?;
    Ok(digest)
}

pub(crate) fn native_operations(
    connection: &Connection,
    attempt: &str,
    session: &str,
) -> Result<i64> {
    Ok(connection.query_row(
        "WITH linked(attempt_id,operation_id) AS (
             SELECT attempt_id,operation_id FROM workflow_launches
             UNION ALL SELECT attempt_id,operation_id FROM workflow_deliveries WHERE operation_id IS NOT NULL),
         anchors(attempt_id,start) AS (
             SELECT l.attempt_id,MIN(r.rowid) FROM linked l
             JOIN workflow_attempts a ON a.id=l.attempt_id AND a.session_id=?2
             JOIN operation_receipts r ON r.id=l.operation_id AND r.session_id=?2
             GROUP BY l.attempt_id),
         own(start) AS (SELECT start FROM anchors WHERE attempt_id=?1)
         SELECT count(*) FROM operation_receipts r,own WHERE r.session_id=?2 AND r.rowid>=own.start
           AND r.rowid<COALESCE((SELECT MIN(a.start) FROM anchors a WHERE a.start>own.start),9223372036854775807)",
        params![attempt, session],
        |row| row.get(0),
    )?)
}

fn decisions(connection: &Connection, run_id: &str) -> Result<(Value, Vec<Value>)> {
    let mut totals = BTreeMap::from([("answered", 0), ("closed", 0), ("pending", 0), ("total", 0)]);
    let mut statement = connection
        .prepare("SELECT state,count(*) FROM workflow_decisions WHERE run_id=?1 GROUP BY state")?;
    for row in statement.query_map([run_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })? {
        let (state, amount) = row?;
        let slot = match state.as_str() {
            "pending" => "pending",
            "answered" => "answered",
            _ => "closed",
        };
        *totals.entry(slot).or_default() += amount;
        *totals.entry("total").or_default() += amount;
    }
    let mut statement = connection.prepare("SELECT d.id,t.task_key,json_extract(d.data,'$.audience'),json_extract(d.data,'$.question') FROM workflow_decisions d JOIN workflow_attempts a ON a.id=d.attempt_id JOIN workflow_tasks t ON t.id=a.task_id WHERE d.run_id=?1 AND d.state='pending' ORDER BY d.sequence LIMIT ?2")?;
    let open = statement
        .query_map(params![run_id, OPEN_DECISIONS as i64], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "taskKey": row.get::<_, String>(1)?,
                "audience": row.get::<_, Option<String>>(2)?,
                "question": clip(&row.get::<_, Option<String>>(3)?.unwrap_or_default(), ITEM_BYTES),
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((json!(totals), open))
}

fn inbox(connection: &Connection, run_id: &str) -> Result<Value> {
    let (pending, head): (i64, i64) = connection.query_row("SELECT COALESCE(SUM(CASE WHEN recipient='coordinator' AND acked_at IS NULL THEN 1 ELSE 0 END),0),COALESCE(MAX(sequence),0) FROM workflow_messages WHERE run_id=?1", [run_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(json!({"pendingCoordinatorMessages": pending, "messageHead": head}))
}

fn evidence(connection: &Connection, run_id: &str) -> Result<Value> {
    let cursor: i64 = connection.query_row(
        "SELECT head FROM domain_event_cursor WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let total = count(
        connection,
        "SELECT count(*) FROM workflow_checkpoints WHERE run_id=?1",
        run_id,
    )?;
    let mut statement = connection.prepare("SELECT id,ordinal,source_revision,digest FROM workflow_checkpoints WHERE run_id=?1 ORDER BY ordinal DESC LIMIT ?2")?;
    let checkpoints = statement
        .query_map(params![run_id, CHECKPOINTS as i64], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "ordinal": row.get::<_, i64>(1)?,
                "sourceRunRevision": row.get::<_, i64>(2)?,
                "digest": row.get::<_, String>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"journalCursor": cursor, "checkpointCount": total, "checkpoints": checkpoints}))
}

fn compact(task: &mut Value) {
    if let Some(summary) = task["summary"].as_str() {
        task["summary"] = clip(summary, COMPACT_SUMMARY_BYTES).into();
    }
    task["files"] = json!([]);
    if let Some(steps) = task["nextSteps"].as_array_mut() {
        steps.truncate(1);
    }
    if let Some(workspace) = task.get_mut("workspace").filter(|value| value.is_object()) {
        workspace["directory"] = Value::Null;
    }
}

pub(crate) fn bound(mut body: Value) -> Value {
    if size(&body) <= MAX_BYTES {
        return body;
    }
    body["truncated"] = true.into();
    for task in body["taskDigests"].as_array_mut().into_iter().flatten() {
        compact(task);
    }
    let mut omitted = 0;
    while size(&body) > MAX_BYTES
        && body["taskDigests"]
            .as_array_mut()
            .and_then(Vec::pop)
            .is_some()
    {
        omitted += 1;
    }
    body["omittedTasks"] = omitted.into();
    if size(&body) > MAX_BYTES {
        if let Some(open) = body.get_mut("openDecisions") {
            *open = json!([]);
        }
        if let Some(checkpoints) = body
            .get_mut("evidence")
            .and_then(|evidence| evidence.get_mut("checkpoints"))
        {
            *checkpoints = json!([]);
        }
    }
    if size(&body) > MAX_BYTES {
        return skeleton(body, omitted);
    }
    body
}

fn skeleton(mut body: Value, omitted: usize) -> Value {
    body["omittedTasks"] = (omitted + length(&body["taskDigests"])).into();
    body["taskDigests"] = json!([]);
    if let Some(title) = body["title"].as_str() {
        body["title"] = clip(title, ITEM_BYTES).into();
    }
    for (field, empty) in [
        ("budget", json!({})),
        (
            "tasks",
            json!({"total": body["tasks"]["total"], "byState": {}}),
        ),
    ] {
        if size(&body) > MAX_BYTES && body.get(field).is_some() {
            body[field] = empty;
        }
    }
    body
}

fn compose(
    connection: &Connection,
    run_id: &str,
    kind: Kind,
    only: Option<&[String]>,
    now: u64,
) -> Result<Value> {
    let view = orchestration::view(connection, &host(), run_id)?;
    let run = &view["run"];
    let tasks: Vec<&Value> = view["tasks"]
        .as_array()
        .ok_or_else(|| anyhow!("Missing digest plan"))?
        .iter()
        .filter(|task| only.is_none_or(|keys| keys.iter().any(|key| task["key"] == key.as_str())))
        .collect();
    let mut states = BTreeMap::<String, u64>::new();
    for task in &tasks {
        *states
            .entry(task["state"].as_str().unwrap_or("unknown").to_owned())
            .or_default() += 1;
    }
    let digests = tasks
        .iter()
        .map(|task| task_digest(connection, task))
        .collect::<Result<Vec<_>>>()?;
    let mut body = json!({
        "schemaVersion": 1, "kind": kind.name(), "runId": run_id, "title": run["title"],
        "state": run["state"], "sourceRevision": run["revision"],
        "tasks": {"total": tasks.len(), "byState": states},
        "taskDigests": digests, "omittedTasks": 0, "truncated": false,
    });
    if kind != Kind::Inherited {
        let (totals, open) = decisions(connection, run_id)?;
        body["producedAt"] = now.into();
        body["decisions"] = totals;
        body["openDecisions"] = open.into();
        body["budget"] = run["budget"].clone();
        body["inbox"] = inbox(connection, run_id)?;
        body["evidence"] = evidence(connection, run_id)?;
    }
    Ok(bound(body))
}

pub fn fingerprint(body: &Value) -> Result<String> {
    let mut stable = body.clone();
    if let Some(object) = stable.as_object_mut() {
        object.remove("producedAt");
    }
    if let Some(evidence) = stable.get_mut("evidence").and_then(Value::as_object_mut) {
        evidence.remove("journalCursor");
    }
    Ok(hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&stable)?).as_ref(),
    ))
}

pub fn settle(transaction: &Transaction<'_>, run_id: &str, now: u64) -> Result<()> {
    let (state, revision, subject): (String, i64, Option<String>) = transaction.query_row(
        "SELECT state,revision,coordinator_id FROM workflow_runs WHERE id=?1",
        [run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if !settled(&state) {
        return Ok(());
    }
    let recorded: Option<i64> = transaction
        .query_row(
            "SELECT source_revision FROM workflow_digests WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    if recorded.is_some_and(|recorded| recorded >= revision) {
        return Ok(());
    }
    let body = compose(transaction, run_id, Kind::Final, None, now)?;
    let fingerprint = fingerprint(&body)?;
    let encoded = serde_json::to_string(&body)?;
    transaction.execute("INSERT INTO workflow_digests(run_id,source_revision,state,produced_at,journal_cursor,fingerprint,body) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(run_id) DO UPDATE SET source_revision=excluded.source_revision,state=excluded.state,produced_at=excluded.produced_at,journal_cursor=excluded.journal_cursor,fingerprint=excluded.fingerprint,body=excluded.body", params![run_id, revision, state, now as i64, body["evidence"]["journalCursor"].as_i64().unwrap_or(0), fingerprint, encoded])?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            at: now,
            event: DomainEvent::RunDigestRecorded(model::RunDigestRecorded {
                run_id: run_id.into(),
                revision: u64::try_from(revision)?,
                state,
                fingerprint,
                bytes: u64::try_from(encoded.len())?,
            }),
        }],
    )?;
    Ok(())
}

pub fn read(connection: &mut Connection, actor: &Actor, run_id: &str, now: u64) -> Result<Value> {
    let behavior = if settled(
        orchestration::run(connection, actor, run_id)?["state"]
            .as_str()
            .unwrap_or_default(),
    ) {
        TransactionBehavior::Immediate
    } else {
        TransactionBehavior::Deferred
    };
    let transaction = connection.transaction_with_behavior(behavior)?;
    let run = orchestration::run(&transaction, actor, run_id)?;
    let summary = json!({"id": run["id"], "title": run["title"], "revision": run["revision"], "state": run["state"]});
    let result = if settled(run["state"].as_str().unwrap_or_default()) {
        settle(&transaction, run_id, now)?;
        let (body, fingerprint): (String, String) = transaction.query_row(
            "SELECT body,fingerprint FROM workflow_digests WHERE run_id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        json!({"run": summary, "digest": serde_json::from_str::<Value>(&body)?, "fingerprint": fingerprint, "stored": true})
    } else {
        let body = compose(&transaction, run_id, Kind::WorkingState, None, now)?;
        json!({"run": summary, "fingerprint": fingerprint(&body)?, "digest": body, "stored": false})
    };
    transaction.commit()?;
    Ok(result)
}

pub fn inherited(connection: &Connection, run_id: &str, task_id: &str) -> Result<Value> {
    let spec = crate::workflow_attempts::task(connection, run_id, task_id)?;
    if spec.dependencies.is_empty() {
        return Ok(Value::Null);
    }
    compose(
        connection,
        run_id,
        Kind::Inherited,
        Some(&spec.dependencies),
        0,
    )
}
