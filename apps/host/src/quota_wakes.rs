//! One-shot quota continuations. Durable intent never proves live input authority.
use crate::{
    api_error::Error,
    receipts::{self, Receipt},
    sessions::session_quota::WakeProof,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ACTIVE_LIMIT: i64 = 64;
const RETENTION_LIMIT: i64 = 4096;
pub const ISSUER: &str = "quota-wake";
pub const PROMPT: &str = "Continue the previous task.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Arm {
    pub id: String,
    pub session_id: String,
    pub launch_id: String,
    pub generation: u64,
    pub human_epoch: u64,
    pub predecessor_id: Option<String>,
    pub proof: WakeProof,
}

/// Private arm data remains available to the live-state guard. Only `public`
/// exposes retained metadata; its clock values are wall-clock reset evidence.
pub struct View {
    pub arm: Arm,
    pub phase: String,
    pub reason: Option<String>,
    pub receipt: Option<Receipt>,
}

impl View {
    pub fn public(&self) -> Value {
        json!({
            "id": self.arm.id,
            "sessionId": self.arm.session_id,
            "launchId": self.arm.launch_id,
            "generation": self.arm.generation,
            "phase": self.phase,
            "reason": self.reason,
            "predecessorId": self.arm.predecessor_id,
            "source": {
                "readerId": self.arm.proof.reader_id,
                "contextId": self.arm.proof.context_id,
                "accountFingerprint": self.arm.proof.account_fingerprint,
                "revision": self.arm.proof.revision,
                "resetAt": self.arm.proof.reset_at,
            },
            "operationId": self.receipt.as_ref().map(|receipt| &receipt.id),
            "operationPhase": self.receipt.as_ref().map(|receipt| &receipt.phase),
        })
    }
}

pub struct Dispatch {
    pub arm: Arm,
    pub receipt: Receipt,
}

pub enum Work {
    Arm(Arm),
    Disable(String),
    Pause {
        id: String,
        reason: &'static str,
    },
    List,
    Claim {
        id: String,
        expected: Arm,
    },
    Guard {
        session_id: String,
        operation_id: String,
    },
    Current(String),
}

pub enum Reply {
    Armed(View),
    Disabled,
    List(Vec<View>),
    Claimed(Option<Dispatch>),
    Guarded(Option<Arm>),
    Current(Option<View>),
}

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS quota_wake_arms(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
            session_id TEXT NOT NULL,
            arm TEXT NOT NULL CHECK(json_valid(arm)),
            phase TEXT NOT NULL CHECK(phase IN ('armed','dispatching','paused')),
            operation_id TEXT UNIQUE REFERENCES operation_receipts(id),
            reason TEXT,
            CHECK(phase!='armed' OR operation_id IS NULL),
            CHECK(phase!='dispatching' OR operation_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS quota_wake_active_session
            ON quota_wake_arms(session_id) WHERE phase IN ('armed','dispatching');
        CREATE INDEX IF NOT EXISTS quota_wake_active ON quota_wake_arms(phase,sequence);
        CREATE INDEX IF NOT EXISTS quota_wake_session ON quota_wake_arms(session_id,sequence);",
    )?;
    Ok(())
}

/// Persisted elapsed clocks and live session ownership never survive a restart.
/// Existing native receipts remain untouched, including uncertain outcomes.
pub fn recover(connection: &mut Connection) -> Result<()> {
    initialize(connection)?;
    connection.execute(
        "UPDATE quota_wake_arms SET phase='paused',reason='host_restarted'
         WHERE phase IN ('armed','dispatching')",
        [],
    )?;
    Ok(())
}

fn invalid() -> anyhow::Error {
    Error::new("invalid_argument", "Invalid quota wake binding").into()
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-:.".contains(&byte))
}

fn id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn encode(arm: &Arm) -> Result<String> {
    let encoded = serde_json::to_string(arm)?;
    if !id(&arm.id)
        || !identifier(&arm.session_id)
        || !identifier(&arm.launch_id)
        || arm.generation == 0
        || arm
            .predecessor_id
            .as_deref()
            .is_some_and(|value| !id(value))
        || !identifier(&arm.proof.reader_id)
        || !identifier(&arm.proof.context_id)
        || !identifier(&arm.proof.account_fingerprint)
        || arm.proof.revision == 0
        || arm.proof.reset_at <= 0
        || arm.proof.reset_elapsed_ms < arm.proof.read_started_elapsed_ms
        || encoded.len() > 4096
    {
        return Err(invalid());
    }
    Ok(encoded)
}

fn read(connection: &Connection, arm_id: &str) -> Result<Option<View>> {
    let row: Option<(String, String, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT arm,phase,reason,operation_id FROM quota_wake_arms WHERE id=?1",
            [arm_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    row.map(|(arm, phase, reason, operation_id)| {
        let receipt = operation_id
            .map(|operation_id| {
                let row: Option<(String, String, String, String)> = connection
                    .query_row(
                        "SELECT operation,phase,session_id,result FROM operation_receipts
                         WHERE id=?1 AND issuer=?2",
                        params![operation_id, ISSUER],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let (operation, phase, session_id, result) =
                    row.ok_or_else(|| anyhow!("Retained quota wake receipt is unavailable"))?;
                Ok::<_, anyhow::Error>(Receipt {
                    id: operation_id,
                    operation,
                    phase,
                    session_id,
                    result: serde_json::from_str(&result)?,
                })
            })
            .transpose()?;
        Ok(View {
            arm: serde_json::from_str(&arm)?,
            phase,
            reason,
            receipt,
        })
    })
    .transpose()
}

pub fn current(connection: &Connection, session_id: &str) -> Result<Option<View>> {
    let arm_id: Option<String> = connection
        .query_row(
            "SELECT id FROM quota_wake_arms WHERE session_id=?1 ORDER BY sequence DESC LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    arm_id
        .map(|arm_id| read(connection, &arm_id))
        .transpose()
        .map(Option::flatten)
}

fn arm(connection: &mut Connection, arm: Arm) -> Result<View> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = read(&transaction, &arm.id)? {
        if serde_json::to_value(&existing.arm)? != serde_json::to_value(&arm)? {
            return Err(Error::new(
                "idempotency_conflict",
                "This quota wake identity already has another binding",
            )
            .into());
        }
        return Ok(existing);
    }
    let encoded = encode(&arm)?;
    if let Some(predecessor) = &arm.predecessor_id {
        let matches: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_receipts
             WHERE id=?1 AND operation='send' AND session_id=?2)",
            params![predecessor, arm.session_id],
            |row| row.get(0),
        )?;
        if !matches {
            return Err(invalid());
        }
    }
    let active: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM quota_wake_arms
         WHERE session_id=?1 AND phase IN ('armed','dispatching'))",
        [&arm.session_id],
        |row| row.get(0),
    )?;
    if active {
        return Err(Error::new(
            "quota_wake_conflict",
            "A quota wake is already active for this session",
        )
        .into());
    }
    let (retained, active): (i64, i64) = transaction.query_row(
        "SELECT count(*),COALESCE(sum(phase IN ('armed','dispatching')),0) FROM quota_wake_arms",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if retained >= RETENTION_LIMIT || active >= ACTIVE_LIMIT {
        return Err(Error::new("busy", "Quota wake retention capacity is exhausted").into());
    }
    transaction.execute(
        "INSERT INTO quota_wake_arms(id,session_id,arm,phase) VALUES(?1,?2,?3,'armed')",
        params![arm.id, arm.session_id, encoded],
    )?;
    let view = read(&transaction, &arm.id)?
        .ok_or_else(|| anyhow!("Accepted quota wake is unavailable"))?;
    transaction.commit()?;
    Ok(view)
}

fn list(connection: &Connection) -> Result<Vec<View>> {
    let mut query = connection.prepare(
        "SELECT id FROM quota_wake_arms WHERE phase IN ('armed','dispatching')
         ORDER BY sequence LIMIT ?1",
    )?;
    let ids = query
        .query_map([ACTIVE_LIMIT], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.into_iter()
        .map(|arm_id| {
            read(connection, &arm_id)?.ok_or_else(|| anyhow!("Active quota wake is unavailable"))
        })
        .collect()
}

fn claim(connection: &mut Connection, arm_id: &str, expected: &Arm) -> Result<Option<Dispatch>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(stored) = read(&transaction, arm_id)? else {
        return Ok(None);
    };
    if stored.phase != "armed"
        || expected.id != arm_id
        || serde_json::to_value(&stored.arm)? != serde_json::to_value(expected)?
    {
        return Ok(None);
    }
    let mut request = json!({
        "sessionId":stored.arm.session_id,
        "prompt":PROMPT,
        "quotaWakeId":stored.arm.id,
    });
    let mut linkage = json!({"quotaWakeId":stored.arm.id});
    if let Some(predecessor) = &stored.arm.predecessor_id {
        request["predecessorId"] = json!(predecessor);
        linkage["predecessorId"] = json!(predecessor);
    }
    let mut accepted = receipts::accept_transaction(
        &transaction,
        ISSUER,
        &format!("quota-wake:{arm_id}"),
        "send",
        request,
    )?;
    // Reusing a retained receipt must never manufacture another dispatch, even
    // if an inconsistent imported arm still says armed.
    let (phase, reason) = if accepted.is_new {
        accepted.receipt.result = linkage;
        transaction.execute(
            "UPDATE operation_receipts SET result=?2 WHERE id=?1",
            params![accepted.receipt.id, accepted.receipt.result.to_string()],
        )?;
        ("dispatching", None)
    } else {
        ("paused", Some("receipt_retained"))
    };
    transaction.execute(
        "UPDATE quota_wake_arms SET phase=?2,reason=?3,operation_id=?4
         WHERE id=?1 AND phase='armed'",
        params![arm_id, phase, reason, accepted.receipt.id],
    )?;
    transaction.commit()?;
    Ok(accepted.is_new.then_some(Dispatch {
        arm: stored.arm,
        receipt: accepted.receipt,
    }))
}

/// Ordinary sends return `None`. A retained quota operation must remain bound
/// to a dispatching arm; disable and recovery revoke it without deleting proof.
pub fn guard_dispatch(
    connection: &Connection,
    session_id: &str,
    operation_id: &str,
) -> Result<Option<Arm>> {
    let arm_id: Option<String> = connection
        .query_row(
            "SELECT id FROM quota_wake_arms WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(arm_id) = arm_id else {
        return Ok(None);
    };
    let view =
        read(connection, &arm_id)?.ok_or_else(|| anyhow!("Bound quota wake is unavailable"))?;
    if view.arm.session_id != session_id {
        return Err(Error::new("forbidden", "Quota wake belongs to another session").into());
    }
    if view.phase != "dispatching" {
        return Err(Error::new("quota_wake_paused", "Quota wake is no longer dispatchable").into());
    }
    Ok(Some(view.arm))
}

pub fn handle(connection: &mut Connection, work: Work) -> Result<Reply> {
    match work {
        Work::Arm(value) => arm(connection, value).map(Reply::Armed),
        Work::Disable(session_id) => {
            connection.execute(
                "UPDATE quota_wake_arms SET phase='paused',reason='disabled'
                 WHERE session_id=?1 AND phase IN ('armed','dispatching')",
                [session_id],
            )?;
            Ok(Reply::Disabled)
        }
        Work::List => list(connection).map(Reply::List),
        Work::Pause { id, reason } => {
            connection.execute("UPDATE quota_wake_arms SET phase='paused',reason=?2 WHERE id=?1 AND phase IN ('armed','dispatching')", params![id, reason])?;
            Ok(Reply::Disabled)
        }
        Work::Claim { id, expected } => claim(connection, &id, &expected).map(Reply::Claimed),
        Work::Guard {
            session_id,
            operation_id,
        } => guard_dispatch(connection, &session_id, &operation_id).map(Reply::Guarded),
        Work::Current(session_id) => current(connection, &session_id).map(Reply::Current),
    }
}
