//! Durable, caller-bound operation intents. A launch is not an agent/task result.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    status::now_millis,
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub operation: String,
    pub phase: String,
    pub session_id: String,
    pub result: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub receipt: Receipt,
    pub cursor: u64,
}
pub struct Accepted {
    pub receipt: Receipt,
    pub is_new: bool,
}
pub struct Claim {
    pub receipt: Receipt,
    pub token: String,
}
fn event(receipt: &Receipt) -> Observation {
    Observation {
        session_id: Some(receipt.session_id.clone()),
        kind: "operation.changed",
        at: now_millis(),
        payload: json!({"operationId":receipt.id,"phase":receipt.phase,"operation":receipt.operation}),
    }
}
fn valid_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
        return Err(Error::new(
            "invalid_argument",
            "Idempotency key must be 1–128 bytes without control characters",
        )
        .into());
    }
    Ok(())
}
pub fn initialize(connection: &mut Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS operation_receipts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,operation TEXT NOT NULL,phase TEXT NOT NULL,session_id TEXT NOT NULL,result TEXT NOT NULL,claim_token TEXT,UNIQUE(issuer,key));
      CREATE INDEX IF NOT EXISTS operation_receipts_phase ON operation_receipts(phase);")?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let pending: Vec<String> = {
        let mut statement = transaction.prepare(
            "SELECT id FROM operation_receipts WHERE phase IN ('accepted','dispatching','received','started','waiting') OR (operation='send' AND phase='delivered' AND COALESCE(json_extract(result,'$.correlation'),'launchHook')!='unavailable') LIMIT 256",
        )?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    for id in pending {
        transaction.execute("UPDATE operation_receipts SET phase='unknown',claim_token=NULL,result=?2 WHERE id=?1",params![id,json!({"code":"host_restart","message":"Host restarted before the operation outcome was confirmed; inspect before retrying"}).to_string()])?;
        let receipt = read_record(&transaction, &id, None)?
            .ok_or_else(|| Error::new("operation_not_found", "Operation no longer exists"))?;
        append_transaction(&transaction, vec![event(&receipt)])?;
    }
    transaction.commit()?;
    Ok(())
}
fn read_record(connection: &Connection, id: &str, issuer: Option<&str>) -> Result<Option<Receipt>> {
    let row:Option<(String,String,String,String,String)>=connection.query_row("SELECT id,operation,phase,session_id,result FROM operation_receipts WHERE id=?1 AND (?2 IS NULL OR issuer=?2)",params![id,issuer],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    row.map(|(id, operation, phase, session_id, result)| {
        Ok(Receipt {
            id,
            operation,
            phase,
            session_id,
            result: serde_json::from_str(&result)?,
        })
    })
    .transpose()
}
pub fn accept(
    connection: &mut Connection,
    issuer: &str,
    key: &str,
    operation: &str,
    request: Value,
) -> Result<Accepted> {
    valid_key(key)?;
    ensure!(
        matches!(operation, "create" | "send" | "interrupt" | "stop"),
        "Unsupported operation"
    );
    let target = if operation != "create" {
        let id = request["sessionId"]
            .as_str()
            .ok_or_else(|| Error::new("invalid_argument", "Operation needs a target session"))?;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return Err(Error::new("invalid_argument", "Invalid operation target").into());
        }
        Some(id.to_owned())
    } else {
        None
    };
    let request = serde_json::to_vec(&request)?;
    if request.len() > 24 * 1024 {
        return Err(Error::new("invalid_argument", "Operation request exceeds 24 KiB").into());
    }
    let digest = hex::encode(ring::digest::digest(&ring::digest::SHA256, &request).as_ref());
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id,digest,operation FROM operation_receipts WHERE issuer=?1 AND key=?2",
            params![issuer, key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((id, stored, stored_operation)) = existing {
        if stored != digest || stored_operation != operation {
            return Err(Error::new(
                "idempotency_conflict",
                "This idempotency key already describes a different request",
            )
            .into());
        }
        let receipt = read_record(&transaction, &id, Some(issuer))?
            .ok_or_else(|| Error::new("operation_not_found", "Operation no longer exists"))?;
        return Ok(Accepted {
            receipt,
            is_new: false,
        });
    }
    let pending: i64 = transaction.query_row(
        "SELECT count(*) FROM operation_receipts WHERE phase IN ('accepted','dispatching','received','started','waiting') OR (operation='send' AND phase='delivered' AND COALESCE(json_extract(result,'$.correlation'),'launchHook')!='unavailable')",
        [],
        |r| r.get(0),
    )?;
    if pending >= 256 {
        return Err(Error::new("busy", "Operation acceptance capacity is exhausted").into());
    }
    let receipt = Receipt {
        id: hex::encode(crate::wire::random::<16>()),
        operation: operation.into(),
        phase: "accepted".into(),
        session_id: target.unwrap_or_else(|| hex::encode(crate::wire::random::<16>())),
        result: json!({}),
    };
    transaction.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES(?1,?2,?3,?4,?5,?6,?7,'{}')",params![receipt.id,issuer,key,digest,operation,receipt.phase,receipt.session_id])?;
    append_transaction(&transaction, vec![event(&receipt)])?;
    transaction.commit()?;
    Ok(Accepted {
        receipt,
        is_new: true,
    })
}
pub fn claim(connection: &mut Connection, id: &str, issuer: &str) -> Result<Option<Claim>> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let token = hex::encode(crate::wire::random::<16>());
    if transaction.execute("UPDATE operation_receipts SET phase='dispatching',claim_token=?3 WHERE id=?1 AND issuer=?2 AND phase='accepted'",params![id,issuer,token])?!=1 {return Ok(None);}
    let receipt = read_record(&transaction, id, Some(issuer))?
        .ok_or_else(|| Error::new("operation_not_found", "Operation no longer exists"))?;
    append_transaction(&transaction, vec![event(&receipt)])?;
    transaction.commit()?;
    Ok(Some(Claim { receipt, token }))
}
pub fn finish(
    connection: &mut Connection,
    id: &str,
    issuer: &str,
    token: &str,
    phase: &str,
    result: Value,
) -> Result<Receipt> {
    ensure!(
        matches!(
            phase,
            "created"
                | "failed"
                | "unknown"
                | "delivered"
                | "received"
                | "started"
                | "waiting"
                | "settled"
                | "interrupted"
                | "stopRequested"
                | "stopped"
        ),
        "Invalid operation outcome"
    );
    ensure!(
        result.is_object(),
        "Operation result must be metadata object"
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut receipt = read_record(&transaction, id, Some(issuer))?
        .ok_or_else(|| Error::new("operation_not_found", "Operation no longer exists"))?;
    let stored_token: Option<String> = transaction.query_row(
        "SELECT claim_token FROM operation_receipts WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    if stored_token.as_deref() != Some(token) {
        return Err(Error::new(
            "stale_operation",
            "This operation claim is no longer current",
        )
        .into());
    }
    let send = receipt.operation == "send";
    let terminal = !matches!(
        receipt.phase.as_str(),
        "dispatching" | "delivered" | "received" | "started" | "waiting"
    );
    if terminal {
        if send && phase == "unknown" {
            return Ok(receipt);
        }
        if !(send && phase == "delivered") {
            return Err(Error::new("stale_operation", "This operation is already terminal").into());
        }
    }
    let valid = match receipt.operation.as_str() {
        "create" => matches!(phase, "created" | "failed" | "unknown"),
        "send" => !matches!(phase, "created" | "stopRequested" | "stopped"),
        "interrupt" => matches!(phase, "delivered" | "failed" | "unknown"),
        "stop" => matches!(phase, "stopRequested" | "stopped" | "failed" | "unknown"),
        _ => false,
    };
    if !valid || (!send && receipt.phase != "dispatching") {
        return Err(Error::new("invalid_argument", "Invalid operation transition").into());
    }
    if send
        && matches!(
            phase,
            "received" | "started" | "waiting" | "settled" | "interrupted"
        )
    {
        let sequence = result["sourceSequence"]
            .as_u64()
            .filter(|s| *s > 0)
            .ok_or_else(|| {
                Error::new(
                    "invalid_argument",
                    "Lifecycle transition needs source order",
                )
            })?;
        if receipt.result["sourceSequence"]
            .as_u64()
            .is_some_and(|old| old >= sequence)
        {
            return Ok(receipt);
        }
    }
    let next_phase = if phase == "delivered"
        && (terminal || matches!(receipt.phase.as_str(), "received" | "started" | "waiting"))
    {
        receipt.phase.clone()
    } else {
        phase.into()
    };
    if let Some(object) = receipt.result.as_object_mut() {
        object.extend(
            result
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.clone())),
        );
    }
    let result = serde_json::to_string(&receipt.result)?;
    ensure!(result.len() <= 4096, "Operation result is too large");
    transaction.execute("UPDATE operation_receipts SET phase=?4,result=?5,claim_token=?6 WHERE id=?1 AND issuer=?2 AND claim_token=?3",params![id,issuer,token,next_phase,result,send.then_some(token)])?;
    receipt.phase = next_phase;
    append_transaction(&transaction, vec![event(&receipt)])?;
    transaction.commit()?;
    Ok(receipt)
}
pub fn get(
    connection: &Connection,
    issuer: &str,
    admin: bool,
    id: Option<&str>,
    key: Option<&str>,
) -> Result<View> {
    if id.is_some() == key.is_some() {
        return Err(Error::new(
            "invalid_argument",
            "Supply one operation ID or idempotency key",
        )
        .into());
    }
    let transaction = connection.unchecked_transaction()?;
    let id = if let Some(key) = key {
        valid_key(key)?;
        transaction
            .query_row(
                "SELECT id FROM operation_receipts WHERE issuer=?1 AND key=?2",
                params![issuer, key],
                |r| r.get(0),
            )
            .optional()?
    } else {
        id.map(str::to_owned)
    };
    let receipt = id
        .as_deref()
        .map(|id| read_record(&transaction, id, (!admin).then_some(issuer)))
        .transpose()?
        .flatten()
        .ok_or_else(|| {
            Error::new(
                "operation_not_found",
                "Operation no longer exists or is not visible to this caller",
            )
        })?;
    let cursor: i64 =
        transaction.query_row("SELECT head FROM domain_event_cursor WHERE id=1", [], |r| {
            r.get(0)
        })?;
    transaction.commit()?;
    Ok(View {
        receipt,
        cursor: u64::try_from(cursor)?,
    })
}
