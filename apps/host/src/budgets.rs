use crate::{
    api_error::Error,
    caller::Role,
    event_log::{DomainEvent, Observation, append_transaction, model},
    launchers::Program,
    orchestration::{self, Actor, Scope},
};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};

pub const SESSION_CEILING: u16 = 16;
pub const SNAPSHOT_BUDGET_BYTES: usize = 48 * 1024;
const STARTUP_METADATA_ALLOWANCE_BYTES: usize = 8 * 1024;
pub fn admit_snapshot_bytes(current: usize, extra_text: usize) -> Result<()> {
    if current
        .checked_add(extra_text)
        .and_then(|n| n.checked_add(STARTUP_METADATA_ALLOWANCE_BYTES))
        .is_none_or(|n| n > SNAPSHOT_BUDGET_BYTES)
    {
        return Err(Error::new(
            "budget_snapshot_capacity",
            "Session metadata capacity reached; close retained sessions before creating more",
        )
        .into());
    }
    Ok(())
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Providers {
    pub shell: u16,
    pub claude: u16,
    pub codex: u16,
    pub gemini: u16,
}
impl Providers {
    pub fn get(&self, program: Program) -> u16 {
        match program {
            Program::Shell => self.shell,
            Program::Claude => self.claude,
            Program::Codex => self.codex,
            Program::Gemini => self.gemini,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_sessions: u16,
    pub max_workers: u16,
    pub providers: Providers,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_sessions: 8,
            max_workers: 8,
            providers: Providers {
                shell: 8,
                claude: 8,
                codex: 8,
                gemini: 8,
            },
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<()> {
        if !(1..=SESSION_CEILING).contains(&self.max_sessions)
            || self.max_workers > SESSION_CEILING
            || [
                self.providers.shell,
                self.providers.claude,
                self.providers.codex,
                self.providers.gemini,
            ]
            .iter()
            .any(|n| *n > SESSION_CEILING)
        {
            return Err(Error::new(
                "invalid_argument",
                "Host session budget is 1–16; worker/provider budgets are 0–16",
            )
            .into());
        }
        Ok(())
    }
    pub fn admit(&self, usage: Usage, program: Program, role: Role) -> Result<()> {
        let reason = if usage.retained >= usize::from(self.max_sessions) {
            Some("Session retention budget reached; close an existing session or raise maxSessions")
        } else if role == Role::Worker && usage.workers >= usize::from(self.max_workers) {
            Some("Live worker budget reached; existing processes retain their work")
        } else if usage.provider >= usize::from(self.providers.get(program)) {
            Some("Live provider process budget reached; existing processes retain their work")
        } else {
            None
        };
        match reason {
            Some(reason) => Err(Error::new("budget_exhausted", reason).into()),
            None => Ok(()),
        }
    }
}
#[derive(Clone, Copy, Default)]
pub struct Usage {
    pub retained: usize,
    pub workers: usize,
    pub provider: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub limits: Limits,
}
pub type Shared = Arc<RwLock<Option<Snapshot>>>;
pub fn defaults() -> Shared {
    Arc::new(RwLock::new(Some(Snapshot {
        revision: 1,
        limits: Limits::default(),
    })))
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS host_budget(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,data TEXT NOT NULL);")?;
    connection.execute(
        "INSERT OR IGNORE INTO host_budget(id,revision,data) VALUES(1,1,?1)",
        [serde_json::to_string(&Limits::default())?],
    )?;
    Ok(())
}
pub fn load(connection: &Connection) -> Result<Snapshot> {
    let (revision, source): (i64, String) = connection.query_row(
        "SELECT revision,data FROM host_budget WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let limits: Limits = serde_json::from_str(&source)?;
    limits.validate()?;
    if revision < 1 {
        return Err(Error::new("budget_unavailable", "Stored budget revision is invalid").into());
    }
    Ok(Snapshot {
        revision: revision as u64,
        limits,
    })
}
pub fn publish(connection: &Connection, shared: &Shared) -> Result<()> {
    let mut projection = shared
        .write()
        .map_err(|_| Error::new("budget_unavailable", "Admission policy is unavailable"))?;
    match load(connection) {
        Ok(current) => {
            *projection = Some(current);
            Ok(())
        }
        Err(error) => {
            *projection = None;
            Err(error)
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
    Get {},
    Set {
        key: String,
        expected_revision: u64,
        limits: Limits,
    },
}
pub fn owner(actor: &Actor) -> Result<()> {
    if !matches!(actor.scope, Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the explicit owner can inspect or change global host budgets",
        )
        .into());
    }
    Ok(())
}
pub fn execute(connection: &mut Connection, actor: Actor, request: Request) -> Result<Value> {
    owner(&actor)?;
    let Request::Set {
        ref key,
        expected_revision,
        ref limits,
    } = request
    else {
        return Ok(json!({"budget":load(connection)?}));
    };
    orchestration::validate_key(key)?;
    limits.validate()?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"hostBudget","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(previous) = orchestration::replay(&transaction, &actor, key, &digest)? {
        return Ok(previous);
    }
    orchestration::mutation_capacity(&transaction)?;
    let current = load(&transaction)?;
    if current.revision != expected_revision {
        return Err(Error::new(
            "revision_conflict",
            "Host budget revision changed; read the current policy",
        )
        .into());
    }
    let revision = current
        .revision
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| Error::new("busy", "Budget revision capacity exhausted"))?;
    transaction.execute(
        "UPDATE host_budget SET revision=?1,data=?2 WHERE id=1",
        params![revision as i64, serde_json::to_string(limits)?],
    )?;
    let cursor = append_transaction(
        &transaction,
        vec![Observation {
            session_id: None,
            at: crate::status::now_millis(),
            event: DomainEvent::HostBudgetChanged(model::RevisionChanged { revision }),
        }],
    )?;
    let result = json!({"budget":load(&transaction)?,"cursor":cursor});
    orchestration::remember(&transaction, &actor, key, &digest, &result)?;
    transaction.commit()?;
    Ok(result)
}
