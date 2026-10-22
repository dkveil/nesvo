use crate::{
    api_error::Error,
    orchestration::{self, Actor},
    workflow_context,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_PARTS: usize = 16_384;
pub fn digest(parts: &[Value]) -> Result<String> {
    Ok(hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(parts)?).as_ref(),
    ))
}
fn sql_parts(
    connection: &Connection,
    run: &str,
    sql: &str,
    kind: &str,
    parts: &mut Vec<Value>,
) -> Result<()> {
    let mut query = connection.prepare(sql)?;
    let rows = query.query_map([run], |r| r.get::<_, String>(0))?;
    for row in rows {
        let mut data: Value = serde_json::from_str(&row?)?;
        if let Some(value) = data.get_mut("validationPassed")
            && !value.is_null()
        {
            *value = json!(value == 1);
        }
        parts.push(json!({"kind":kind,"data":data}));
    }
    Ok(())
}
pub fn build(connection: &Connection, actor: &Actor, run: &str) -> Result<Vec<Value>> {
    let view = orchestration::view(connection, actor, run)?;
    let mut parts = vec![
        json!({"kind":"run","data":view["run"]}),
        json!({"kind":"constraintPolicy","data":workflow_context::summary(connection,run)?}),
    ];
    for record in workflow_context::records(connection, run)? {
        parts.push(json!({"kind":"constraint","data":record}));
    }
    for task in view["tasks"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing context plan"))?
    {
        parts.push(json!({"kind":"task","data":task}));
    }
    sql_parts(
        connection,
        run,
        "SELECT json_object('id',a.id,'taskId',a.task_id,'ordinal',a.ordinal,'sessionId',a.session_id,'state',a.state,'reportedOutcome',json_extract(a.result,'$.outcome'),'validationPassed',json_extract(a.validation,'$.passed'),'launchReceiptId',l.operation_id,'launchPhase',lo.phase,'deliveryId',d.id,'deliveryPhase',d.phase,'deliveryReceiptId',d.operation_id,'deliveryNativePhase',do.phase) FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id LEFT JOIN workflow_launches l ON l.attempt_id=a.id LEFT JOIN operation_receipts lo ON lo.id=l.operation_id LEFT JOIN workflow_deliveries d ON d.attempt_id=a.id LEFT JOIN operation_receipts do ON do.id=d.operation_id WHERE t.run_id=?1 ORDER BY t.rowid,a.ordinal",
        "attempt",
        &mut parts,
    )?;
    sql_parts(
        connection,
        run,
        "SELECT json_object('id',id,'attemptId',attempt_id,'revision',revision,'state',state,'audience',json_extract(data,'$.audience'),'expiresAt',json_extract(data,'$.expiresAt')) FROM workflow_decisions WHERE run_id=?1 ORDER BY sequence",
        "decision",
        &mut parts,
    )?;
    sql_parts(
        connection,
        run,
        "SELECT json_object('id',c.id,'kind',c.kind,'state',c.state,'sessionId',t.session_id,'attemptId',t.attempt_id,'phase',t.phase,'receiptId',t.receipt_id,'operationKey',t.key,'code',t.code) FROM workflow_controls c LEFT JOIN workflow_control_targets t ON t.control_id=c.id WHERE c.run_id=?1 AND c.state!='completed' ORDER BY c.created_at,c.id,t.position",
        "control",
        &mut parts,
    )?;
    sql_parts(
        connection,
        run,
        "SELECT json_object('id',b.id,'policyId',b.policy_id,'phase',b.phase,'reason',b.reason,'receiptId',b.operation_id,'nativePhase',o.phase) FROM workflow_wake_batches b JOIN workflow_wake_policies p ON p.id=b.policy_id JOIN operation_receipts o ON o.id=b.operation_id WHERE p.run_id=?1 AND b.phase!='settled' ORDER BY b.created_at,b.id",
        "wakeBatch",
        &mut parts,
    )?;
    sql_parts(
        connection,
        run,
        "SELECT json_object('receiptId',o.id,'sessionId',o.session_id,'operation',o.operation,'phase',o.phase) FROM operation_receipts o WHERE EXISTS(SELECT 1 FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=o.session_id AND t.run_id=?1) AND o.phase IN ('accepted','dispatching','delivered','received','started','waiting','unknown') ORDER BY o.id",
        "nativeOperation",
        &mut parts,
    )?;
    for (table, kind) in [
        ("workflow_executors", "executor"),
        ("workflow_wake_policies", "wakes"),
    ] {
        let row: Option<(String, bool, i64, String, Option<String>)> = connection
            .query_row(
                &format!("SELECT id,enabled,generation,phase,reason FROM {table} WHERE run_id=?1"),
                [run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        if let Some((id, enabled, generation, phase, reason)) = row {
            parts.push(json!({"kind":"automation","data":{"id":id,"type":kind,"enabled":enabled,"generation":generation,"phase":phase,"reason":reason}}));
        }
    }
    let (pending,head):(i64,i64)=connection.query_row("SELECT COALESCE(SUM(CASE WHEN recipient='coordinator' AND acked_at IS NULL THEN 1 ELSE 0 END),0),COALESCE(MAX(sequence),0) FROM workflow_messages WHERE run_id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?)))?;
    parts.push(
        json!({"kind":"inbox","data":{"pendingCoordinatorMessages":pending,"messageHead":head}}),
    );
    if parts.len() > MAX_PARTS || serde_json::to_vec(&parts)?.len() > MAX_BYTES {
        return Err(Error::new(
            "context_too_large",
            "Context exceeds 16384 records or 1 MiB; no history or constraints were omitted",
        )
        .into());
    }
    Ok(parts)
}
pub fn page(parts: &[Value], offset: usize) -> Result<(Vec<Value>, Option<usize>)> {
    if offset > parts.len() {
        return Err(
            Error::new("invalid_cursor", "Context offset is ahead of this manifest").into(),
        );
    }
    let mut result = Vec::new();
    let mut bytes = 0;
    for part in parts.iter().skip(offset).take(8) {
        let size = serde_json::to_vec(part)?.len();
        if size > 24 * 1024 {
            return Err(Error::new(
                "context_too_large",
                "One context record exceeds its 24 KiB page bound",
            )
            .into());
        }
        if bytes + size > 24 * 1024 {
            break;
        }
        bytes += size;
        result.push(part.clone());
    }
    let end = offset + result.len();
    Ok((result, (end < parts.len()).then_some(end)))
}
