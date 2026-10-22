//! Owner-approved exact commands. Approval is explicit, immutable intent, not a sandbox.
use crate::{
    api_error::Error,
    event_log::{DomainEvent, Observation, append_transaction, model},
    orchestration::{self, Actor, Scope},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn timeout() -> u64 {
    2000
}
fn pass() -> Vec<i32> {
    vec![0]
}
fn skip() -> Vec<i32> {
    vec![10]
}
fn version() -> u8 {
    1
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    #[serde(default = "version")]
    pub version: u8,
    pub title: String,
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub cwd: String,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    #[serde(default = "pass")]
    pub pass_exit_codes: Vec<i32>,
    #[serde(default = "skip")]
    pub skip_exit_codes: Vec<i32>,
    /// Explicit environment only; no ambient credentials or pairing context.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}
pub fn digest(spec: &Command) -> Result<String> {
    crate::groups::valid_name(&spec.title)?;
    let keys = spec
        .environment
        .keys()
        .map(|key| key.to_ascii_uppercase())
        .collect::<BTreeSet<_>>();
    if keys.len() != spec.environment.len() {
        return Err(invalid(
            "Use environment names that are unique without regard to ASCII case",
        ));
    }
    if spec.version != 1
        || !std::path::Path::new(&spec.executable).is_absolute()
        || !std::path::Path::new(&spec.cwd).is_absolute()
        || spec.executable.len() > 4096
        || spec.cwd.len() > 4096
        || spec.executable.contains('\0')
        || spec.cwd.contains('\0')
        || spec.arguments.len() > 32
        || spec
            .arguments
            .iter()
            .any(|s| s.len() > 2048 || s.contains('\0'))
        || !(100..=10_000).contains(&spec.timeout_ms)
        || spec.environment.len() > 16
        || spec.environment.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 128
                || !k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || k.contains(['=', '\0'])
                || v.len() > 2048
                || v.contains('\0')
                || k.eq_ignore_ascii_case("SystemRoot")
                || k.to_ascii_uppercase().starts_with("NESVO_")
                || k.to_ascii_uppercase().starts_with("POCKET_")
        })
        || serde_json::to_vec(spec)?.len() > 16 * 1024
    {
        return Err(invalid(
            "Use absolute executable/cwd, bounded literal arguments/environment and a 100–10000 ms timeout",
        ));
    }
    #[cfg(windows)]
    if !std::path::Path::new(&spec.executable)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
    {
        return Err(invalid(
            "Select an executable, not an implicit .cmd/.bat shell; approve an explicit interpreter and its exact arguments instead",
        ));
    }
    let mut codes = BTreeSet::new();
    if spec.pass_exit_codes.is_empty()
        || spec.pass_exit_codes.len() > 8
        || spec.skip_exit_codes.is_empty()
        || spec.skip_exit_codes.len() > 8
        || spec
            .pass_exit_codes
            .iter()
            .chain(&spec.skip_exit_codes)
            .any(|code| !(0..=255).contains(code) || !codes.insert(code))
    {
        return Err(invalid(
            "Use nonempty unique disjoint pass/skip exit-code lists within 0–255",
        ));
    }
    Ok(hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(spec)?).as_ref(),
    ))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Describe {
        spec: Command,
    },
    Approve {
        key: String,
        spec: Command,
        expected_digest: String,
    },
    Get {
        id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Revoke {
        key: String,
        id: String,
        expected_revision: u64,
    },
    Mutation {
        key: String,
    },
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_precheck_approvals(id TEXT PRIMARY KEY,spec TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS harness_precheck_mutations(issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));
        CREATE TABLE IF NOT EXISTS harness_job_prechecks(occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),approval_id TEXT NOT NULL,approval_digest TEXT,spec TEXT,state TEXT NOT NULL,reason TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,result TEXT,observed_at INTEGER);")?;
    let observed = {
        let mut q = connection.prepare("PRAGMA table_info(harness_job_prechecks)")?;
        q.query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|s| s == "observed_at")
    };
    if !observed {
        connection
            .execute_batch("ALTER TABLE harness_job_prechecks ADD COLUMN observed_at INTEGER;")?;
    }
    Ok(())
}
pub fn view(connection: &Connection, id: &str) -> Result<Value> {
    connection.query_row("SELECT spec,digest,revision,enabled,created_at FROM harness_precheck_approvals WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,bool>(3)?,r.get::<_,i64>(4)?))).optional()?.map(|(spec,digest,revision,enabled,created)|Ok(json!({"id":id,"spec":serde_json::from_str::<Value>(&spec)?,"digest":digest,"revision":revision,"enabled":enabled,"createdAt":created,"trust":"ownerExactCommand","sandboxed":false,"environmentPolicy":"isolated-platform-v1","platformEnvironmentKeys":platform_keys()}))).unwrap_or_else(||Err(Error::new("precheck_not_found","Precheck approval does not exist").into()))
}
fn platform_keys() -> &'static [&'static str] {
    if cfg!(windows) { &["SystemRoot"] } else { &[] }
}
pub fn execute(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
) -> Result<Value> {
    if !matches!(actor.scope, Scope::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the owner may inspect or approve precheck commands",
        )
        .into());
    }
    match &request {
        Request::Describe { spec } => {
            return Ok(
                json!({"precheckDescription":{"spec":spec,"digest":digest(spec)?,"trust":"notApproved","sandboxed":false,"environmentPolicy":"isolated-platform-v1","platformEnvironmentKeys":platform_keys()}}),
            );
        }
        Request::Get { id } => return Ok(json!({"precheckApproval":view(connection,id)?})),
        Request::List { offset } => {
            if *offset > 4096 {
                return Err(invalid("Invalid precheck page offset"));
            }
            let mut q=connection.prepare("SELECT id FROM harness_precheck_approvals ORDER BY created_at,id LIMIT 17 OFFSET ?1")?;
            let ids = q
                .query_map([offset], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let rows = ids
                .iter()
                .take(16)
                .map(|id| {
                    let mut item = view(connection, id)?;
                    item.as_object_mut()
                        .ok_or_else(|| invalid("Invalid approval view"))?
                        .remove("spec");
                    Ok(item)
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"precheckApprovals":rows,"nextOffset":if ids.len()>16{Some(*offset+16)}else{None}}),
            );
        }
        Request::Mutation { key } => {
            orchestration::validate_key(key)?;
            let saved: Option<String> = connection
                .query_row(
                    "SELECT view FROM harness_precheck_mutations WHERE issuer=?1 AND key=?2",
                    params![actor.issuer, key],
                    |r| r.get(0),
                )
                .optional()?;
            return saved
                .map(|v| serde_json::from_str(&v).map_err(Into::into))
                .unwrap_or_else(|| {
                    Err(
                        Error::new("mutation_not_found", "Precheck mutation was not accepted")
                            .into(),
                    )
                });
        }
        _ => {}
    }
    let key = match &request {
        Request::Approve { key, .. } | Request::Revoke { key, .. } => key,
        _ => unreachable!(),
    };
    orchestration::validate_key(key)?;
    let hash = hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&request)?).as_ref(),
    );
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some((old, saved)) = tx
        .query_row(
            "SELECT digest,view FROM harness_precheck_mutations WHERE issuer=?1 AND key=?2",
            params![actor.issuer, key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if old != hash {
            return Err(Error::new(
                "idempotency_conflict",
                "Precheck key belongs to different intent",
            )
            .into());
        }
        return Ok(serde_json::from_str(&saved)?);
    }
    let retained: i64 =
        tx.query_row("SELECT count(*) FROM harness_precheck_mutations", [], |r| {
            r.get(0)
        })?;
    if retained >= 4096 {
        return Err(Error::new("busy", "Precheck mutation retention is full").into());
    }
    let (id, phase) = match &request {
        Request::Approve {
            spec,
            expected_digest,
            ..
        } => {
            let digest = digest(spec)?;
            if expected_digest != &digest {
                return Err(Error::new(
                    "precheck_digest_conflict",
                    "Inspect the exact normalized command digest before explicit owner approval",
                )
                .into());
            }
            let count: i64 =
                tx.query_row("SELECT count(*) FROM harness_precheck_approvals", [], |r| {
                    r.get(0)
                })?;
            if count >= 128 {
                return Err(Error::new("busy", "Precheck approval retention is full").into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            tx.execute("INSERT INTO harness_precheck_approvals(id,spec,digest,revision,enabled,created_at) VALUES(?1,?2,?3,1,1,?4)",params![id,serde_json::to_string(spec)?,digest,now as i64])?;
            (id, "approved")
        }
        Request::Revoke {
            id,
            expected_revision,
            ..
        } => {
            let current = view(&tx, id)?;
            if current["revision"] != *expected_revision {
                return Err(Error::new(
                    "revision_conflict",
                    "Precheck approval changed; inspect before revocation",
                )
                .into());
            }
            tx.execute(
                "UPDATE harness_precheck_approvals SET enabled=0,revision=revision+1 WHERE id=?1",
                [id],
            )?;
            (id.clone(), "revoked")
        }
        _ => unreachable!(),
    };
    let value = json!({"precheckApproval":view(&tx,&id)?});
    tx.execute(
        "INSERT INTO harness_precheck_mutations(issuer,key,digest,view) VALUES(?1,?2,?3,?4)",
        params![actor.issuer, key, hash, serde_json::to_string(&value)?],
    )?;
    append_transaction(
        &tx,
        vec![Observation {
            session_id: None,
            at: now,
            event: DomainEvent::PrecheckApprovalChanged(model::PrecheckApprovalChanged {
                approval_id: id.clone(),
                phase: phase.into(),
            }),
        }],
    )?;
    tx.commit()?;
    Ok(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutcomeState {
    Passed,
    Skipped,
    Failed,
    TimedOut,
    OutputLimit,
    Refused,
    Unknown,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    pub state: OutcomeState,
    pub reason: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
    pub cleanup_confirmed: bool,
    pub command_started: Option<bool>,
}
impl Outcome {
    pub fn failed(state: OutcomeState, reason: &str) -> Self {
        Self {
            state,
            reason: reason.into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 0,
            cleanup_confirmed: state == OutcomeState::Refused,
            command_started: if state == OutcomeState::Refused {
                Some(false)
            } else {
                None
            },
        }
    }
}
