//! Owner acknowledgment retires one proven no-effect launch, without inventing cleanup.
use crate::{api_error::Error, job_definitions, orchestration::Actor};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_job_launch_resolutions(
        job_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
        occurrence_id TEXT NOT NULL UNIQUE REFERENCES harness_job_occurrences(id),
        run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
        identity TEXT NOT NULL,digest TEXT NOT NULL,issuer TEXT NOT NULL,
        mutation_key TEXT NOT NULL,acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at>=0));",
    )?;
    Ok(())
}

pub fn resolved_attempt(connection: &Connection, attempt: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_launch_resolutions WHERE job_attempt_id=?1)",
        [attempt],
        |row| row.get(0),
    )?)
}

pub fn resolved_occurrence(connection: &Connection, occurrence: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_launch_resolutions WHERE occurrence_id=?1)",
        [occurrence],
        |row| row.get(0),
    )?)
}

/// This permanent fence applies to automation and fresh controls, not reads or
/// immutable-key replays. It does not claim that a process exited.
pub fn guard_run(connection: &Connection, run: &str) -> Result<()> {
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_launch_resolutions WHERE run_id=?1)",
        [run],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(Error::new("job_generation_retired", "Owner abandoned this exact launch; inspect its retained evidence instead of admitting new effects").into());
    }
    Ok(())
}

fn resolution(connection: &Connection, attempt: &str) -> Result<Value> {
    let row = connection.query_row("SELECT identity,digest,mutation_key,acknowledged_at FROM harness_job_launch_resolutions WHERE job_attempt_id=?1", [attempt], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?))).optional()?;
    let Some((identity, digest, key, at)) = row else {
        return Ok(Value::Null);
    };
    let mut value: Value = serde_json::from_str(&identity)?;
    value["digest"] = digest.into();
    value["mutationKey"] = key.into();
    value["acknowledgedAt"] = at.into();
    Ok(value)
}

struct Evidence {
    identity: Value,
    reason: Option<&'static str>,
    facts: Value,
}

impl Evidence {
    fn refuse(&mut self, reason: &'static str) {
        if self.reason.is_none() {
            self.reason = Some(reason);
        }
    }
    fn digest(&self) -> Result<Option<String>> {
        Ok(if self.reason.is_none() {
            Some(hex::encode(
                ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&self.facts)?)
                    .as_ref(),
            ))
        } else {
            None
        })
    }
    fn descriptor(&self) -> Result<Value> {
        let mut value = self.identity.clone();
        value["available"] = self.reason.is_none().into();
        value["reason"] = self
            .reason
            .map(|_| "launch_reconciliation_unavailable")
            .into();
        value["digest"] = self.digest()?.into();
        Ok(value)
    }
}

/// Hash source material is private. Only the fixed descriptor and digest leave
/// this module; native receipt bodies, precheck output and tokens never do.
fn evidence(connection: &Connection, attempt: &str) -> Result<Option<Evidence>> {
    let row = connection.query_row("SELECT o.job_id,o.id,j.run_id,n.id,n.session_id,l.operation_id,o.spec,j.ordinal,o.state,j.dispatch_token,o.current_job_attempt_id,o.run_id
        FROM harness_job_attempts j JOIN harness_job_occurrences o ON o.id=j.occurrence_id
        JOIN workflow_tasks t ON t.run_id=j.run_id JOIN workflow_attempts n ON n.task_id=t.id
        JOIN workflow_launches l ON l.attempt_id=n.id WHERE j.id=?1 ORDER BY n.ordinal,n.rowid LIMIT 1", [attempt], |row| Ok((
            json!({"kind":"launchNoEffect","jobId":row.get::<_,String>(0)?,"occurrenceId":row.get::<_,String>(1)?,"jobAttemptId":attempt,"runId":row.get::<_,String>(2)?,"attemptId":row.get::<_,String>(3)?,"sessionId":row.get::<_,String>(4)?,"launchReceiptId":row.get::<_,String>(5)?}),
            row.get::<_,String>(6)?,row.get::<_,i64>(7)?,row.get::<_,String>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,Option<String>>(10)?,row.get::<_,Option<String>>(11)?))).optional()?;
    let Some((identity, spec, ordinal, state, dispatch_token, current, occurrence_run)) = row
    else {
        return Ok(None);
    };
    let mut evidence = Evidence {
        identity,
        reason: None,
        facts: json!({"version":1}),
    };
    let parsed_spec = match serde_json::from_str::<job_definitions::Spec>(&spec) {
        Ok(spec) => spec,
        Err(_) => {
            // A diagnostic is additive to legacy history. Unusable policy
            // cannot authorize abandonment or make retained facts unreadable.
            evidence.refuse("launch_spec_unavailable");
            return Ok(Some(evidence));
        }
    };
    evidence.facts["identity"] = evidence.identity.clone();
    evidence.facts["spec"] = serde_json::from_str(&spec)?;
    let occurrence = evidence.identity["occurrenceId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let run = evidence.identity["runId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let native = evidence.identity["attemptId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let session = evidence.identity["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let receipt = evidence.identity["launchReceiptId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if current.as_deref() != Some(attempt) || occurrence_run.as_deref() != Some(run.as_str()) {
        evidence.refuse("generation_not_current");
    }
    if !matches!(state.as_str(), "reconcile" | "canceling" | "failed") {
        evidence.refuse("occurrence_state_conflict");
    }
    if dispatch_token.is_some() {
        evidence.refuse("generation_producer_active");
    }
    if evidence.reason.is_some() {
        return Ok(Some(evidence));
    }
    let exact: bool = connection.query_row("SELECT
        NOT EXISTS(SELECT 1 FROM harness_job_attempts later WHERE later.occurrence_id=?1 AND later.ordinal>?6)
        AND (SELECT count(*) FROM workflow_tasks WHERE run_id=?2)=1
        AND (SELECT count(*) FROM workflow_attempts n JOIN workflow_tasks t ON t.id=n.task_id WHERE t.run_id=?2)=1
        AND EXISTS(SELECT 1 FROM workflow_tasks t JOIN workflow_attempts n ON n.task_id=t.id JOIN workflow_launches l ON l.attempt_id=n.id WHERE t.run_id=?2 AND t.task_key='job' AND n.id=?3 AND n.ordinal=1 AND n.session_id=?4 AND l.operation_id=?5 AND l.operation_key=('run-launch:'||n.id))", params![occurrence,run,native,session,receipt,ordinal], |row| row.get(0))?;
    if !exact {
        evidence.refuse("native_identity_conflict");
        return Ok(Some(evidence));
    }
    let outcome: bool = connection.query_row("SELECT
        EXISTS(SELECT 1 FROM workflow_attempts WHERE id=?1 AND (result IS NOT NULL OR validation IS NOT NULL))
        OR EXISTS(SELECT 1 FROM workflow_deliveries WHERE run_id=?2)
        OR EXISTS(SELECT 1 FROM workflow_decisions WHERE run_id=?2)
        OR EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?3)",params![native,run,session],|row|row.get(0))?;
    if outcome {
        evidence.refuse("generation_outcome_present");
        return Ok(Some(evidence));
    }
    let retry: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_retries WHERE source_attempt_id=?1)",
        [attempt],
        |row| row.get(0),
    )?;
    if retry {
        evidence.refuse("retry_decision_present");
        return Ok(Some(evidence));
    }
    let launch = connection.query_row("SELECT p.issuer,p.key,p.digest,p.operation,p.phase,p.session_id,p.result,p.claim_token,l.operation_key,l.workspace FROM operation_receipts p JOIN workflow_launches l ON l.operation_id=p.id WHERE p.id=?1",[&receipt],|row|Ok((json!({"issuer":row.get::<_,String>(0)?,"key":row.get::<_,String>(1)?,"digest":row.get::<_,String>(2)?,"operation":row.get::<_,String>(3)?,"phase":row.get::<_,String>(4)?,"sessionId":row.get::<_,String>(5)?,"operationKey":row.get::<_,String>(8)?,"workspace":row.get::<_,String>(9)?}),row.get::<_,String>(6)?,row.get::<_,Option<String>>(7)?))).optional()?;
    if let Some((mut launch, result, token)) = launch {
        let result = serde_json::from_str::<Value>(&result).ok();
        let expected_key = format!("run-launch:{native}");
        if launch["operation"] != "create"
            || launch["phase"] != "failed"
            || launch["sessionId"] != session
            || launch["key"] != expected_key
            || launch["operationKey"] != expected_key
            || !result.as_ref().is_some_and(|r| {
                r.get("effectStarted") == Some(&Value::Bool(false)) && r["taskResult"].is_null()
            })
        {
            evidence.refuse("launch_proof_unavailable");
        }
        if token.is_some() {
            evidence.refuse("generation_producer_active");
        }
        launch["result"] = result.unwrap_or(Value::Null);
        evidence.facts["launch"] = launch;
    } else {
        evidence.refuse("launch_proof_unavailable");
    }
    if evidence.reason.is_some() {
        return Ok(Some(evidence));
    }
    let spec = parsed_spec;
    let precheck = if spec.precheck_id.is_some() {
        if !crate::job_precheck_records::passed_current(connection, &occurrence)? {
            evidence.refuse("precheck_unconfirmed");
        }
        let sql = if ordinal == 1 {
            "SELECT approval_id,approval_digest,spec,state,result FROM harness_job_prechecks WHERE occurrence_id=?1"
        } else {
            "SELECT approval_id,approval_digest,spec,state,result FROM harness_job_generation_prechecks WHERE job_attempt_id=?1"
        };
        connection.query_row(sql,[if ordinal == 1 { occurrence.as_str() } else { attempt }],|row|Ok(json!({"approvalId":row.get::<_,String>(0)?,"approvalDigest":row.get::<_,Option<String>>(1)?,"spec":row.get::<_,Option<String>>(2)?,"state":row.get::<_,String>(3)?,"result":row.get::<_,Option<String>>(4)?}))).optional()?.unwrap_or(Value::Null)
    } else {
        let unexpected: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1) OR EXISTS(SELECT 1 FROM harness_job_generation_prechecks WHERE occurrence_id=?1)",[&occurrence],|row|row.get(0))?;
        if unexpected {
            evidence.refuse("precheck_unconfirmed");
        }
        Value::Null
    };
    evidence.facts["precheck"] = precheck;
    if evidence.reason.is_some() {
        return Ok(Some(evidence));
    }
    // This first slice resolves only the frozen worker's launch. Retained
    // coordinator identity or other run-native input expands that scope even
    // if a current pointer was later cleared; no such effects are adopted.
    let expanded_scope:bool=connection.query_row("SELECT
        EXISTS(SELECT 1 FROM workflow_runs WHERE id=?1 AND coordinator_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM workflow_coordinator_bindings WHERE run_id=?1)
        OR EXISTS(SELECT 1 FROM workflow_wake_policies WHERE run_id=?1)
        OR EXISTS(SELECT 1 FROM workflow_mutations WHERE CASE WHEN json_valid(view) THEN json_extract(view,'$.run.id')=?1 AND json_extract(view,'$.run.coordinatorSessionId') IS NOT NULL ELSE 0 END)
        OR EXISTS(SELECT 1 FROM workflow_native_context context JOIN operation_receipts p ON p.id=context.operation_id
            WHERE context.run_id=?1 AND (context.coordinator_generation<>0 OR (p.id<>?2 AND NOT EXISTS(
                SELECT 1 FROM workflow_control_targets target JOIN workflow_controls control ON control.id=target.control_id
                WHERE control.run_id=?1 AND target.attempt_id=?3 AND target.session_id=?4
                AND p.session_id=?4 AND p.operation='stop' AND p.key=target.key AND p.issuer=control.issuer
                AND (target.receipt_id IS NULL OR target.receipt_id=p.id)))))",params![run,receipt,native,session],|row|row.get(0))?;
    if expanded_scope {
        evidence.refuse("native_identity_conflict");
        return Ok(Some(evidence));
    }
    let timeout = connection.query_row("SELECT state,reason,control_key,control_id,token,armed_at,deadline_at FROM harness_job_timeouts WHERE job_attempt_id=?1",[attempt],|row|Ok((json!({"state":row.get::<_,String>(0)?,"reason":row.get::<_,Option<String>>(1)?,"controlKey":row.get::<_,String>(2)?,"controlId":row.get::<_,Option<String>>(3)?,"armedAt":row.get::<_,i64>(5)?,"deadlineAt":row.get::<_,i64>(6)?}),row.get::<_,Option<String>>(4)?))).optional()?;
    if let Some((timeout, token)) = timeout {
        let exact: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_timeouts WHERE job_attempt_id=?1 AND occurrence_id=?2 AND run_id=?3 AND attempt_id=?4 AND session_id=?5 AND launch_receipt_id=?6)",params![attempt,occurrence,run,native,session,receipt],|row|row.get(0))?;
        if !exact {
            evidence.refuse("cleanup_identity_conflict");
        }
        if token.is_some()
            || matches!(
                timeout["state"].as_str(),
                Some("armed" | "dispatching" | "awaitingExit" | "completed")
            )
        {
            evidence.refuse("cleanup_producer_active");
        }
        evidence.facts["timeout"] = timeout;
    }
    let cancellation = connection.query_row("SELECT state,reason,control_key,control_id,token FROM harness_job_cancellations WHERE occurrence_id=?1",[&occurrence],|row|Ok((json!({"state":row.get::<_,String>(0)?,"reason":row.get::<_,Option<String>>(1)?,"controlKey":row.get::<_,String>(2)?,"controlId":row.get::<_,Option<String>>(3)?}),row.get::<_,Option<String>>(4)?))).optional()?;
    if let Some((cancellation, token)) = cancellation {
        if token.is_some()
            || matches!(
                cancellation["state"].as_str(),
                Some("requested" | "dispatching" | "awaitingPrecheck" | "awaitingExit")
            )
        {
            evidence.refuse("cleanup_producer_active");
        }
        evidence.facts["cancellation"] = cancellation;
    }
    let mut query = connection.prepare(
        "SELECT id,kind,issuer,state,token FROM workflow_controls WHERE run_id=?1 ORDER BY rowid",
    )?;
    let controls = query.query_map([&run],|row|Ok((json!({"id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,"issuer":row.get::<_,String>(2)?,"state":row.get::<_,String>(3)?}),row.get::<_,Option<String>>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut control_facts = Vec::new();
    for (mut control, token) in controls {
        if token.is_some()
            || !matches!(
                control["state"].as_str(),
                Some("blocked" | "unconfirmed" | "completed")
            )
        {
            evidence.refuse("cleanup_producer_active");
        }
        if !matches!(control["kind"].as_str(), Some("stop" | "cancel")) {
            evidence.refuse("cleanup_identity_conflict");
        }
        let id = control["id"].as_str().unwrap_or_default();
        let mut targets = connection.prepare("SELECT attempt_id,session_id,key,phase,receipt_id,code FROM workflow_control_targets WHERE control_id=?1 ORDER BY position,session_id")?;
        let targets = targets.query_map([id],|row|Ok(json!({"attemptId":row.get::<_,String>(0)?,"sessionId":row.get::<_,String>(1)?,"key":row.get::<_,String>(2)?,"phase":row.get::<_,String>(3)?,"receiptId":row.get::<_,Option<String>>(4)?,"code":row.get::<_,Option<String>>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for target in &targets {
            if target["attemptId"] != native || target["sessionId"] != session {
                evidence.refuse("cleanup_identity_conflict");
            }
            if !matches!(
                target["phase"].as_str(),
                Some("unknown" | "unavailable" | "blocked" | "stopRequested" | "exited")
            ) {
                evidence.refuse("cleanup_producer_active");
            }
            if matches!(target["phase"].as_str(), Some("stopRequested" | "exited")) {
                evidence.refuse("native_effects_observed");
            }
            if let Some(receipt) = target["receiptId"].as_str() {
                let exact:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE id=?1 AND issuer=?2 AND key=?3 AND operation='stop' AND session_id=?4)",params![receipt,control["issuer"].as_str(),target["key"].as_str(),session],|row|row.get(0))?;
                if !exact {
                    evidence.refuse("cleanup_identity_conflict");
                }
            }
        }
        control["targets"] = targets.into();
        control_facts.push(control);
    }
    evidence.facts["controls"] = control_facts.into();
    let mut query = connection.prepare("SELECT p.id,p.issuer,p.key,p.digest,p.operation,p.phase,p.result,p.claim_token,
        EXISTS(SELECT 1 FROM workflow_control_targets t JOIN workflow_controls c ON c.id=t.control_id WHERE c.run_id=?3 AND t.attempt_id=?4 AND t.session_id=p.session_id AND t.key=p.key AND c.issuer=p.issuer AND (t.receipt_id IS NULL OR t.receipt_id=p.id))
        FROM operation_receipts p WHERE p.session_id=?1 AND p.id<>?2 ORDER BY p.rowid")?;
    let receipts = query.query_map(params![session,receipt,run,native],|row|Ok((json!({"id":row.get::<_,String>(0)?,"issuer":row.get::<_,String>(1)?,"key":row.get::<_,String>(2)?,"digest":row.get::<_,String>(3)?,"operation":row.get::<_,String>(4)?,"phase":row.get::<_,String>(5)?}),row.get::<_,String>(6)?,row.get::<_,Option<String>>(7)?,row.get::<_,bool>(8)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut receipt_facts = Vec::new();
    for (mut receipt, result, token, linked) in receipts {
        if !linked || receipt["operation"] != "stop" {
            evidence.refuse("cleanup_identity_conflict");
        }
        if token.is_some() || !matches!(receipt["phase"].as_str(), Some("failed" | "unknown")) {
            evidence.refuse("cleanup_producer_active");
        }
        let result = serde_json::from_str::<Value>(&result).ok();
        if !result.as_ref().is_some_and(|r| {
            r.is_object()
                && r["nativeStopRequested"] != true
                && r["nativeWriteFlushed"] != true
                && r["processExited"] != true
                && r["taskResult"].is_null()
                && (receipt["phase"] == "unknown"
                    || r.get("effectStarted") == Some(&Value::Bool(false)))
        }) {
            evidence.refuse("native_effects_observed");
        }
        receipt["result"] = result.unwrap_or(Value::Null);
        receipt_facts.push(receipt);
    }
    evidence.facts["cleanupReceipts"] = receipt_facts.into();
    Ok(Some(evidence))
}

pub fn view_attempt(connection: &Connection, attempt: &str) -> Result<(Value, Value)> {
    let resolution = resolution(connection, attempt)?;
    if !resolution.is_null() {
        let mut descriptor = resolution.clone();
        if let Some(value) = descriptor.as_object_mut() {
            for key in ["digest", "mutationKey", "acknowledgedAt"] {
                value.remove(key);
            }
        }
        descriptor["available"] = false.into();
        descriptor["reason"] = "generation_resolved".into();
        descriptor["digest"] = Value::Null;
        return Ok((descriptor, resolution));
    }
    Ok((
        evidence(connection, attempt)?
            .map(|e| e.descriptor())
            .transpose()?
            .unwrap_or(Value::Null),
        resolution,
    ))
}

pub fn view_current(connection: &Connection, occurrence: &str) -> Result<(Value, Value)> {
    let attempt: Option<String> = connection.query_row(
        "SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",
        [occurrence],
        |row| row.get(0),
    )?;
    attempt
        .map(|id| view_attempt(connection, &id))
        .transpose()
        .map(|v| v.unwrap_or((Value::Null, Value::Null)))
}

#[allow(clippy::too_many_arguments)]
pub fn accept(
    tx: &Transaction<'_>,
    actor: &Actor,
    job: &str,
    occurrence: &str,
    attempt: &str,
    expected_digest: &str,
    acknowledge: bool,
    mutation_key: &str,
    now: u64,
) -> Result<Value> {
    if !matches!(actor.scope, crate::orchestration::Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the owner can acknowledge this job launch and its unknown effects",
        )
        .into());
    }
    if !acknowledge
        || expected_digest.len() != 64
        || !expected_digest
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(Error::new("invalid_argument", "Inspect the exact launch reconciliation digest and explicitly acknowledge unknown effects before abandonment").into());
    }
    let member: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.occurrence_id=o.id WHERE o.id=?1 AND o.job_id=?2 AND a.id=?3)",params![occurrence,job,attempt],|row|row.get(0))?;
    if !member || resolved_attempt(tx, attempt)? {
        return Err(conflict());
    }
    let evidence = evidence(tx, attempt)?.ok_or_else(conflict)?;
    if evidence.reason.is_some() || evidence.digest()?.as_deref() != Some(expected_digest) {
        return Err(conflict());
    }
    // Persist terminal intent and the permanent admission fence atomically. No
    // timeout, cancellation, native receipt, control, or process fact changes.
    job_definitions::transition(
        tx,
        occurrence,
        "canceled",
        Some("launch_owner_abandoned"),
        true,
        now,
    )?;
    tx.execute("INSERT INTO harness_job_launch_resolutions(job_attempt_id,occurrence_id,run_id,identity,digest,issuer,mutation_key,acknowledged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![attempt,occurrence,evidence.identity["runId"].as_str(),serde_json::to_string(&evidence.identity)?,expected_digest,actor.issuer,mutation_key,i64::try_from(now)?])?;
    Ok(json!({"occurrence":job_definitions::occurrence(tx,job,occurrence,true)?}))
}

fn conflict() -> anyhow::Error {
    Error::new("occurrence_conflict", "Launch reconciliation changed or is unavailable; inspect this exact generation and its native evidence before acknowledging unknown effects").into()
}
