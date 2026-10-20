//! Constraint revisions fence native input; ACK never grants process authority.
use crate::{api_error::Error, receipts};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_constraints(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(id),revision INTEGER NOT NULL,text TEXT NOT NULL,issuer TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,revision));
      CREATE TABLE IF NOT EXISTS workflow_context_ack(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),revision INTEGER NOT NULL,issuer TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_native_context(operation_id TEXT PRIMARY KEY REFERENCES operation_receipts(id),run_id TEXT NOT NULL REFERENCES workflow_runs(id),revision INTEGER NOT NULL,admitted INTEGER NOT NULL,coordinator_generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workflow_coordinator_bindings(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),coordinator_id TEXT NOT NULL,previous_id TEXT,directory TEXT NOT NULL,group_id TEXT,generation INTEGER NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL);")?;
    let mut query = connection.prepare("PRAGMA table_info(workflow_native_context)")?;
    let columns = query
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    if !columns.iter().any(|name| name == "coordinator_generation") {
        connection.execute_batch("ALTER TABLE workflow_native_context ADD COLUMN coordinator_generation INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}
pub fn summary(connection: &Connection, run: &str) -> Result<Value> {
    let revision: i64 = connection.query_row(
        "SELECT COALESCE(MAX(revision),0) FROM workflow_constraints WHERE run_id=?1",
        [run],
        |r| r.get(0),
    )?;
    let acknowledged: Option<i64> = connection
        .query_row(
            "SELECT revision FROM workflow_context_ack WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()?;
    let acknowledged = acknowledged.unwrap_or(0);
    Ok(
        json!({"revision":revision,"acknowledgedRevision":acknowledged,"pending":revision!=acknowledged}),
    )
}
pub fn records(connection: &Connection, run: &str) -> Result<Vec<Value>> {
    let mut query = connection.prepare("SELECT id,revision,text,issuer,created_at FROM workflow_constraints WHERE run_id=?1 ORDER BY revision")?;
    Ok(query.query_map([run], |r| Ok(json!({"id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"text":r.get::<_,String>(2)?,"issuer":r.get::<_,String>(3)?,"createdAt":r.get::<_,i64>(4)?})))?.collect::<rusqlite::Result<_>>()?)
}
pub fn guard(connection: &Connection, run: &str) -> Result<()> {
    if summary(connection, run)?["pending"] == true {
        return Err(Error::new("constraints_changed", "Read current owner constraints and deliberately acknowledge their exact revision before new automated work").into());
    }
    Ok(())
}
pub fn freeze(transaction: &Transaction<'_>, run: &str, operation: &str) -> Result<()> {
    let context = summary(transaction, run)?;
    let generation = coordinator_generation(transaction, run)?;
    transaction.execute("INSERT INTO workflow_native_context(operation_id,run_id,revision,admitted,coordinator_generation) VALUES(?1,?2,?3,?4,?5)", params![operation,run,context["revision"].as_i64(),context["pending"]!=true,generation])?;
    Ok(())
}
pub fn coordinator_generation(connection: &Connection, run: &str) -> Result<i64> {
    Ok(connection
        .query_row(
            "SELECT generation FROM workflow_coordinator_bindings WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}
/// Ordinary session sends share the same acceptance transaction and immutable
/// context fence as host-generated task/wake input. Replay never renews it.
pub fn accept_native(
    connection: &mut Connection,
    issuer: &str,
    key: &str,
    operation: &str,
    request: Value,
) -> Result<receipts::Accepted> {
    if operation != "send" {
        return receipts::accept(connection, issuer, key, operation, request);
    }
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let accepted = receipts::accept_transaction(&transaction, issuer, key, operation, request)?;
    if accepted.is_new {
        let run: Option<String> = transaction.query_row("SELECT t.run_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=?1", [&accepted.receipt.session_id], |r|r.get(0)).optional()?;
        if let Some(run) = run {
            freeze(&transaction, &run, &accepted.receipt.id)?;
        }
    }
    transaction.commit()?;
    Ok(accepted)
}
pub fn guard_native(connection: &Connection, session: &str, operation: &str) -> Result<()> {
    let bound: Option<(String, i64, bool, i64)> = connection
        .query_row(
            "SELECT run_id,revision,admitted,coordinator_generation FROM workflow_native_context WHERE operation_id=?1",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?,r.get(3)?)),
        )
        .optional()?;
    if let Some((run, revision, admitted, generation)) = bound {
        if coordinator_generation(connection, &run)? != generation {
            return Err(Error::new("coordinator_changed","This native input predates the current coordinator binding; inspect its original receipt, never rearm retained input").into());
        }
        let current = summary(connection, &run)?;
        if !admitted || current["pending"] == true || current["revision"] != revision {
            return Err(Error::new("constraints_changed", "This native input belongs to an earlier or unacknowledged constraint revision; inspect its original receipt, never rearm it").into());
        }
    } else {
        let run: Option<String> = connection.query_row("SELECT t.run_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=?1", [session], |r|r.get(0)).optional()?;
        if let Some(run) = run
            && (summary(connection, &run)?["revision"] != 0
                || coordinator_generation(connection, &run)? != 0)
        {
            return Err(Error::new(
                "context_unconfirmed",
                "Legacy native input has no constraint provenance and cannot be silently adopted",
            )
            .into());
        }
    }
    Ok(())
}
pub fn task_prompt(connection: &Connection, run: &str, instruction: String) -> Result<String> {
    let constraints = records(connection, run)?;
    if constraints.is_empty() {
        return Ok(instruction);
    }
    let context = summary(connection, run)?;
    guard(connection, run)?;
    let text = constraints
        .iter()
        .map(|c| {
            format!(
                "[{}] {}",
                c["revision"],
                c["text"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Nesvo owner constraints for run {run}, revision {}. Preserve these task constraints; they grant no native permissions or new role.\n{text}\n\nTask instruction:\n{instruction}",
        context["revision"]
    );
    if prompt.len() > 8192 {
        return Err(Error::new("context_too_large", "Task plus owner constraints exceeds the native 8192-byte prompt bound; reconcile the task explicitly, no constraint was omitted").into());
    }
    Ok(prompt)
}
