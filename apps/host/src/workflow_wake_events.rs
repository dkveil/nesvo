//! Transactional wake references. Untrusted bodies never become native input.
use crate::api_error::Error;
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

fn insert(
    transaction: &Transaction<'_>,
    run: &str,
    source: &str,
    kind: &str,
    data: Value,
    now: u64,
) -> Result<()> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_wake_notices WHERE source_key=?1)",
        [source],
        |r| r.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_wake_notices", [], |r| {
            r.get(0)
        })?;
    if count >= 8192 {
        return Err(Error::new(
            "busy",
            "Wake notice retention is full; original transaction was not accepted",
        )
        .into());
    }
    let encoded = serde_json::to_string(&data)?;
    anyhow::ensure!(
        encoded.len() <= 1024,
        "Wake reference metadata exceeds its bound"
    );
    transaction.execute("INSERT INTO workflow_wake_notices(id,run_id,source_key,kind,data,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![hex::encode(crate::wire::random::<16>()),run,source,kind,encoded,now as i64])?;
    Ok(())
}
pub fn message(
    transaction: &Transaction<'_>,
    run: &str,
    recipient: &str,
    message: &Value,
    now: u64,
) -> Result<()> {
    if recipient != "coordinator"
        || !matches!(
            message["kind"].as_str(),
            Some("result" | "decision" | "question" | "error")
        )
    {
        return Ok(());
    }
    let enabled: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_wake_policies WHERE run_id=?1 AND enabled=1 AND held=0)",
        [run],
        |r| r.get(0),
    )?;
    if !enabled {
        return Ok(());
    }
    let id = message["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Wake source has no durable message identity"))?;
    let kind = message["kind"]
        .as_str()
        .ok_or_else(|| anyhow!("Wake source has no kind"))?;
    // Only host-authored result/decision fields or stable message identity are
    // exposed. Caller body/correlation/payload text is never a wake instruction.
    let data = if matches!(kind, "result" | "decision") {
        json!({"messageId":id,"taskId":message["payload"]["taskId"],"attemptId":message["payload"]["attemptId"],"decisionId":message["payload"]["decisionId"],"decisionState":message["payload"]["state"]})
    } else {
        json!({"messageId":id})
    };
    let sequence: i64 = transaction.query_row(
        "SELECT sequence FROM workflow_messages WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    let mut data = data;
    data["messageSequence"] = sequence.into();
    insert(transaction, run, &format!("message:{id}"), kind, data, now)
}
pub fn canonical(
    transaction: &Transaction<'_>,
    session: &str,
    data: &Value,
    now: u64,
) -> Result<()> {
    let binding:Option<(String,String,String)>=transaction.query_row("SELECT a.id,t.run_id,a.state FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id JOIN workflow_runs r ON r.id=t.run_id WHERE a.session_id=?1 AND a.state IN ('assigned','reported','launching','launchUnknown') AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=a.task_id) AND r.state IN ('active','draining')",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((attempt, run, phase)) = binding else {
        return Ok(());
    };
    let mut priority = data["priority"]
        .as_u64()
        .filter(|n| *n <= 3)
        .ok_or_else(|| anyhow!("Invalid canonical attention priority"))?;
    let children = data["blockedChildren"]
        .as_u64()
        .filter(|n| *n <= 256)
        .ok_or_else(|| anyhow!("Invalid canonical attention aggregate"))?;
    let mut reason = data["reason"].as_str();
    anyhow::ensure!(
        reason.is_none_or(|reason| reason.len() <= 64 && !reason.chars().any(char::is_control)),
        "Invalid canonical attention reason"
    );
    let exited = data["processExited"].as_bool().unwrap_or(false);
    let exit = data["exitCode"].as_u64();
    if exited && (phase == "assigned" || exit != Some(0)) {
        priority = 1;
        reason = Some(if exit == Some(0) {
            "missing_result"
        } else {
            "process_exit"
        });
    }
    let fingerprint = json!({"priority":priority,"reason":reason,"blockedChildren":children,"processExited":exited,"exitCode":exit});
    let encoded = serde_json::to_string(&fingerprint)?;
    let previous: Option<(String, i64)> = transaction
        .query_row(
            "SELECT data,revision FROM workflow_wake_signals WHERE attempt_id=?1",
            [&attempt],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if previous.as_ref().is_some_and(|(data, _)| data == &encoded) {
        return Ok(());
    }
    let was_blocked = previous
        .as_ref()
        .map(|(text, _)| serde_json::from_str::<Value>(text))
        .transpose()?
        .is_some_and(|v| v["priority"].as_u64().is_some_and(|n| n > 0));
    let revision = previous.map_or(1, |(_, revision)| revision + 1);
    transaction.execute("INSERT INTO workflow_wake_signals(attempt_id,data,revision) VALUES(?1,?2,?3) ON CONFLICT(attempt_id) DO UPDATE SET data=excluded.data,revision=excluded.revision",params![attempt,encoded,revision])?;
    let enabled: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_wake_policies WHERE run_id=?1 AND enabled=1 AND held=0)",
        [&run],
        |r| r.get(0),
    )?;
    if enabled && (priority > 0 || was_blocked) {
        insert(
            transaction,
            &run,
            &format!("signal:{attempt}:{revision}"),
            "blocker",
            json!({"attemptId":attempt,"sessionId":session,"attention":fingerprint,"signalRevision":revision}),
            now,
        )?;
    }
    Ok(())
}
pub fn seed(transaction: &Transaction<'_>, run: &str, now: u64) -> Result<()> {
    let messages = {
        let mut query=transaction.prepare("SELECT data FROM workflow_messages WHERE run_id=?1 AND recipient='coordinator' AND acked_at IS NULL ORDER BY sequence")?;
        query
            .query_map([run], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for source in messages {
        message(
            transaction,
            run,
            "coordinator",
            &serde_json::from_str(&source)?,
            now,
        )?;
    }
    let signals = {
        let mut query=transaction.prepare("SELECT a.id,a.session_id,s.data,s.revision FROM workflow_wake_signals s JOIN workflow_attempts a ON a.id=s.attempt_id JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=?1 AND a.state IN ('assigned','reported','launching','launchUnknown') AND a.ordinal=(SELECT MAX(b.ordinal) FROM workflow_attempts b WHERE b.task_id=a.task_id)")?;
        query
            .query_map([run], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (attempt, session, source, revision) in signals {
        let data: Value = serde_json::from_str(&source)?;
        if data["priority"].as_u64().is_some_and(|n| n > 0) {
            insert(
                transaction,
                run,
                &format!("signal:{attempt}:{revision}"),
                "blocker",
                json!({"attemptId":attempt,"sessionId":session,"attention":data,"signalRevision":revision}),
                now,
            )?;
        }
    }
    Ok(())
}
pub fn page(connection: &Connection, run: &str, after: u64) -> Result<(Vec<Value>, u64, bool)> {
    let head: i64 = connection.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM workflow_wake_notices WHERE run_id=?1",
        [run],
        |r| r.get(0),
    )?;
    if after > u64::try_from(head)? {
        return Err(Error::new(
            "invalid_cursor",
            "Wake cursor is ahead of this run's notices",
        )
        .into());
    }
    let mut query=connection.prepare("SELECT id,sequence,kind,data,batch_id,created_at FROM workflow_wake_notices WHERE run_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 9")?;
    let mut rows = query.query(params![run, after as i64])?;
    let mut notices = Vec::new();
    while let Some(row) = rows.next()? {
        notices.push(json!({"id":row.get::<_,String>(0)?,"sequence":row.get::<_,i64>(1)?,"kind":row.get::<_,String>(2)?,"reference":serde_json::from_str::<Value>(&row.get::<_,String>(3)?)?,"batchId":row.get::<_,Option<String>>(4)?,"createdAt":row.get::<_,i64>(5)?}));
    }
    let more = notices.len() > 8;
    notices.truncate(8);
    let next = notices
        .last()
        .and_then(|n| n["sequence"].as_u64())
        .unwrap_or(after);
    Ok((notices, next, more))
}
