//! Scoped external admission commits delivery dedupe and an ordinary job intent together.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    job_trigger_auth as auth,
    orchestration::{self, Actor, Scope},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Webhook,
    Github,
}

pub struct Inbound {
    pub provider: Provider,
    pub trigger_id: String,
    pub delivery_id: String,
    pub event: String,
    pub signature: String,
    pub body: Vec<u8>,
}
pub struct Acceptance {
    pub view: Value,
    pub replayed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Adapter {
    Webhook {
        event: String,
    },
    Github {
        repository_id: u64,
        repository: String,
        event: String,
        actions: Vec<String>,
        #[serde(deserialize_with = "Option::deserialize")]
        branch: Option<String>,
    },
}
impl Adapter {
    fn provider(&self) -> Provider {
        match self {
            Self::Webhook { .. } => Provider::Webhook,
            Self::Github { .. } => Provider::Github,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub title: String,
    pub job_id: String,
    pub job_revision: u64,
    pub adapter: Adapter,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Create {
        key: String,
        spec: Spec,
        secret: String,
    },
    Update {
        key: String,
        id: String,
        expected_revision: u64,
        spec: Spec,
    },
    SetEnabled {
        key: String,
        id: String,
        expected_revision: u64,
        enabled: bool,
    },
    Rotate {
        key: String,
        id: String,
        expected_revision: u64,
        secret: String,
    },
    Revoke {
        key: String,
        id: String,
        expected_revision: u64,
    },
    Get {
        id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Deliveries {
        id: String,
        #[serde(default)]
        offset: u16,
    },
    Delivery {
        id: String,
        delivery_id: String,
    },
    Mutation {
        key: String,
    },
}

fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
fn not_found() -> anyhow::Error {
    Error::new("job_trigger_not_found", "Job trigger does not exist").into()
}
fn id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn clock(now: u64) -> Result<i64> {
    Ok(i64::try_from(now)?)
}
fn random_id() -> String {
    hex::encode(crate::wire::random::<16>())
}

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_job_triggers(
        id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES harness_jobs(id),spec TEXT NOT NULL,
        authorized_spec_digest TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
        credential_generation INTEGER NOT NULL CHECK(credential_generation>0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS harness_job_trigger_credentials(
        trigger_id TEXT NOT NULL REFERENCES harness_job_triggers(id),generation INTEGER NOT NULL CHECK(generation>0),
        secret TEXT,secret_digest TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
        created_at INTEGER NOT NULL,retired_at INTEGER,PRIMARY KEY(trigger_id,generation));
        CREATE UNIQUE INDEX IF NOT EXISTS harness_job_trigger_active_credential ON harness_job_trigger_credentials(trigger_id) WHERE state='active';
        CREATE TABLE IF NOT EXISTS harness_job_trigger_mutations(
        issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));
        CREATE TABLE IF NOT EXISTS harness_job_trigger_deliveries(
        id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES harness_job_triggers(id),delivery_id TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL,credential_generation INTEGER NOT NULL,trigger_revision INTEGER NOT NULL,
        job_id TEXT NOT NULL REFERENCES harness_jobs(id),job_revision INTEGER NOT NULL,accepted_at INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('queued','skipped','ignored')),reason TEXT,
        occurrence_id TEXT UNIQUE REFERENCES harness_job_occurrences(id),view TEXT NOT NULL,
        UNIQUE(trigger_id,delivery_id),UNIQUE(trigger_id,raw_sha256),
        FOREIGN KEY(trigger_id,credential_generation) REFERENCES harness_job_trigger_credentials(trigger_id,generation));
        CREATE INDEX IF NOT EXISTS harness_job_trigger_delivery_burst ON harness_job_trigger_deliveries(trigger_id,accepted_at);")?;
    Ok(())
}

struct Record {
    spec: Spec,
    authorized_digest: String,
    revision: i64,
    enabled: bool,
    revoked: bool,
    generation: i64,
    created: i64,
    updated: i64,
}
fn load(connection: &Connection, trigger: &str) -> Result<Record> {
    let row=connection.query_row("SELECT spec,authorized_spec_digest,revision,enabled,revoked,credential_generation,created_at,updated_at FROM harness_job_triggers WHERE id=?1",[trigger],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,bool>(3)?,r.get::<_,bool>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?))).optional()?.ok_or_else(not_found)?;
    Ok(Record {
        spec: serde_json::from_str(&row.0)?,
        authorized_digest: row.1,
        revision: row.2,
        enabled: row.3,
        revoked: row.4,
        generation: row.5,
        created: row.6,
        updated: row.7,
    })
}
fn view(connection: &Connection, trigger: &str) -> Result<Value> {
    let r = load(connection, trigger)?;
    Ok(
        json!({"id":trigger,"revision":r.revision,"enabled":r.enabled,"revoked":r.revoked,"credentialGeneration":r.generation,"createdAt":r.created,"updatedAt":r.updated,"spec":r.spec}),
    )
}
fn spec_digest(source: &str) -> Result<String> {
    let spec: crate::job_definitions::Spec = serde_json::from_str(source)?;
    Ok(auth::digest(&serde_json::to_vec(&spec)?))
}
fn validate_spec(connection: &Connection, spec: &Spec) -> Result<String> {
    crate::groups::valid_name(&spec.title)?;
    if !id(&spec.job_id) || spec.job_revision == 0 || spec.job_revision > 9_007_199_254_740_991 {
        return Err(invalid("Select an exact current job identity and revision"));
    }
    match &spec.adapter {
        Adapter::Webhook { event } if auth::event_name(event) => {}
        Adapter::Github {
            repository_id,
            repository,
            event,
            actions,
            branch,
        } => {
            let parts = repository.split('/').collect::<Vec<_>>();
            let repository_ok = parts.len() == 2
                && parts.iter().all(|part| {
                    !part.is_empty()
                        && part.len() <= 100
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
                });
            let unique = actions.iter().collect::<std::collections::BTreeSet<_>>();
            if *repository_id == 0
                || !repository_ok
                || actions.len() > 16
                || unique.len() != actions.len()
                || actions.iter().any(|a| !auth::event_name(a))
                || branch.as_ref().is_some_and(|b| {
                    b.is_empty()
                        || b.len() > 255
                        || b.chars().any(|c| c.is_control() || c.is_whitespace())
                })
                || match event.as_str() {
                    "push" => !actions.is_empty(),
                    "pull_request" => {
                        actions.is_empty()
                            || actions
                                .iter()
                                .any(|action| !auth::pull_request_action(action))
                    }
                    "workflow_run" => actions.as_slice() != ["completed"],
                    _ => true,
                }
            {
                return Err(invalid(
                    "Use a bounded GitHub repository identity, supported event, action allowlist and optional branch",
                ));
            }
        }
        _ => return Err(invalid("Webhook event must be 1–64 ASCII name characters")),
    }
    let (revision, source): (i64, String) = connection
        .query_row(
            "SELECT revision,spec FROM harness_jobs WHERE id=?1",
            [&spec.job_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| Error::new("job_not_found", "Job does not exist"))?;
    if u64::try_from(revision).ok() != Some(spec.job_revision) {
        return Err(Error::new(
            "revision_conflict",
            "Job changed; authorize its exact current revision",
        )
        .into());
    }
    spec_digest(&source)
}
fn credential(
    tx: &Transaction<'_>,
    trigger: &str,
    generation: i64,
    secret: &str,
    now: u64,
) -> Result<()> {
    if !auth::secret(secret) {
        return Err(invalid(
            "Trigger secret must be exactly 64 lowercase hexadecimal ASCII characters",
        ));
    }
    let digest = auth::digest(secret.as_bytes());
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_trigger_credentials WHERE secret_digest=?1)",
        [&digest],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid(
            "Trigger secrets cannot be reused across routes, rotations or revoked credentials",
        ));
    }
    tx.execute("INSERT INTO harness_job_trigger_credentials(trigger_id,generation,secret,secret_digest,state,created_at) VALUES(?1,?2,?3,?4,'active',?5)",params![trigger,generation,secret,digest,clock(now)?])?;
    Ok(())
}
fn observe(tx: &Transaction<'_>, trigger: &str, phase: &'static str, now: u64) -> Result<()> {
    append_transaction(
        tx,
        vec![Observation {
            session_id: None,
            kind: "job.trigger_changed",
            at: now,
            payload: json!({"triggerId":trigger,"phase":phase}),
        }],
    )?;
    Ok(())
}
fn saved_delivery(connection: &Connection, trigger: &str, delivery: &str) -> Result<Value> {
    let text:String=connection.query_row("SELECT view FROM harness_job_trigger_deliveries WHERE trigger_id=?1 AND delivery_id=?2",params![trigger,delivery],|r|r.get(0)).optional()?.ok_or_else(||Error::new("job_trigger_delivery_not_found","Delivery does not belong to this trigger"))?;
    Ok(serde_json::from_str(&text)?)
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
            "Only the owner can manage external job triggers and credentials",
        )
        .into());
    }
    match &request {
        Request::Get { id } => return Ok(json!({"trigger":view(connection,id)?})),
        Request::Mutation { key } => {
            orchestration::validate_key(key)?;
            let text: String = connection
                .query_row(
                    "SELECT view FROM harness_job_trigger_mutations WHERE issuer=?1 AND key=?2",
                    params![actor.issuer, key],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    Error::new("mutation_not_found", "Trigger mutation does not exist")
                })?;
            return Ok(serde_json::from_str(&text)?);
        }
        Request::List { offset } => {
            if *offset > 4096 {
                return Err(invalid("Invalid trigger page offset"));
            }
            let mut query = connection.prepare(
                "SELECT id FROM harness_job_triggers ORDER BY rowid DESC LIMIT 9 OFFSET ?1",
            )?;
            let ids = query
                .query_map([offset], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let records = ids
                .iter()
                .take(8)
                .map(|id| view(connection, id))
                .collect::<Result<Vec<_>>>()?;
            return Ok(json!({"triggers":records,"nextOffset":(ids.len()>8).then_some(offset+8)}));
        }
        Request::Deliveries { id, offset } => {
            load(connection, id)?;
            if *offset > 4096 {
                return Err(invalid("Invalid delivery page offset"));
            }
            let mut query=connection.prepare("SELECT view FROM harness_job_trigger_deliveries WHERE trigger_id=?1 ORDER BY rowid DESC LIMIT 9 OFFSET ?2")?;
            let rows = query
                .query_map(params![id, offset], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let records = rows
                .iter()
                .take(8)
                .map(|text| Ok(serde_json::from_str::<Value>(text)?["delivery"].clone()))
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"deliveries":records,"nextOffset":(rows.len()>8).then_some(offset+8)}),
            );
        }
        Request::Delivery { id, delivery_id } => {
            load(connection, id)?;
            if !auth::delivery_id(delivery_id) {
                return Err(invalid("Invalid sender delivery identity"));
            }
            return saved_delivery(connection, id, delivery_id);
        }
        _ => {}
    }
    let key = match &request {
        Request::Create { key, .. }
        | Request::Update { key, .. }
        | Request::SetEnabled { key, .. }
        | Request::Rotate { key, .. }
        | Request::Revoke { key, .. } => key,
        _ => unreachable!(),
    };
    orchestration::validate_key(key)?;
    // The fingerprint binds the full request, while retained response bodies
    // contain only metadata. Secrets never enter events or public views.
    let digest = auth::digest(&serde_json::to_vec(
        &json!({"action":"jobTriggers","request":request}),
    )?);
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old: Option<(String, String)> = tx
        .query_row(
            "SELECT digest,view FROM harness_job_trigger_mutations WHERE issuer=?1 AND key=?2",
            params![actor.issuer, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((previous, view)) = old {
        if previous != digest {
            return Err(Error::new(
                "idempotency_conflict",
                "Trigger mutation key belongs to a different intent",
            )
            .into());
        }
        return Ok(serde_json::from_str(&view)?);
    }
    let retained: i64 = tx.query_row(
        "SELECT count(*) FROM harness_job_trigger_mutations",
        [],
        |r| r.get(0),
    )?;
    // Permanent revocation needs one reserved acceptance per retained trigger
    // even when ordinary management retention is full. A revoked trigger can
    // never consume another new key, bounding this reserve to 128 rows.
    if retained >= 4096 && !matches!(request, Request::Revoke { .. }) {
        return Err(Error::new(
            "busy",
            "Trigger mutation retention is full; accepted keys were preserved",
        )
        .into());
    }
    let (trigger, phase) = match &request {
        Request::Create { spec, secret, .. } => {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM harness_job_triggers", [], |r| {
                    r.get(0)
                })?;
            if count >= 128 {
                return Err(Error::new(
                    "busy",
                    "Trigger retention is full; retained credentials were preserved",
                )
                .into());
            }
            let authorized = validate_spec(&tx, spec)?;
            let trigger = random_id();
            tx.execute("INSERT INTO harness_job_triggers(id,job_id,spec,authorized_spec_digest,revision,enabled,revoked,credential_generation,created_at,updated_at) VALUES(?1,?2,?3,?4,1,0,0,1,?5,?5)",params![trigger,spec.job_id,serde_json::to_string(spec)?,authorized,clock(now)?])?;
            credential(&tx, &trigger, 1, secret, now)?;
            (trigger, "created")
        }
        Request::Update {
            id,
            expected_revision,
            ..
        }
        | Request::SetEnabled {
            id,
            expected_revision,
            ..
        }
        | Request::Rotate {
            id,
            expected_revision,
            ..
        }
        | Request::Revoke {
            id,
            expected_revision,
            ..
        } => {
            let current = load(&tx, id)?;
            if u64::try_from(current.revision).ok() != Some(*expected_revision) {
                return Err(Error::new(
                    "revision_conflict",
                    "Trigger changed; inspect its current revision",
                )
                .into());
            }
            if current.revoked {
                return Err(Error::new(
                    "trigger_revoked",
                    "Revocation is permanent; create a new scoped trigger instead",
                )
                .into());
            }
            if current.revision >= 9_007_199_254_740_991 {
                return Err(Error::new("busy", "Trigger revision capacity is exhausted").into());
            }
            let phase = match &request {
                Request::Update { spec, .. } => {
                    if spec.job_id != current.spec.job_id
                        || spec.adapter.provider() != current.spec.adapter.provider()
                    {
                        return Err(invalid(
                            "A trigger cannot change its job or provider kind; create a new scoped trigger",
                        ));
                    }
                    let authorized = validate_spec(&tx, spec)?;
                    tx.execute("UPDATE harness_job_triggers SET spec=?2,authorized_spec_digest=?3 WHERE id=?1",params![id,serde_json::to_string(spec)?,authorized])?;
                    "updated"
                }
                Request::SetEnabled { enabled, .. } => {
                    tx.execute(
                        "UPDATE harness_job_triggers SET enabled=?2 WHERE id=?1",
                        params![id, enabled],
                    )?;
                    if *enabled { "enabled" } else { "disabled" }
                }
                Request::Rotate { secret, .. } => {
                    let generation = current
                        .generation
                        .checked_add(1)
                        .ok_or_else(|| invalid("Credential generation capacity is exhausted"))?;
                    tx.execute("UPDATE harness_job_trigger_credentials SET state='retired',secret=NULL,retired_at=?2 WHERE trigger_id=?1 AND state='active'",params![id,clock(now)?])?;
                    credential(&tx, id, generation, secret, now)?;
                    tx.execute(
                        "UPDATE harness_job_triggers SET credential_generation=?2 WHERE id=?1",
                        params![id, generation],
                    )?;
                    "rotated"
                }
                Request::Revoke { .. } => {
                    tx.execute("UPDATE harness_job_trigger_credentials SET state='revoked',secret=NULL,retired_at=COALESCE(retired_at,?2) WHERE trigger_id=?1",params![id,clock(now)?])?;
                    tx.execute(
                        "UPDATE harness_job_triggers SET enabled=0,revoked=1 WHERE id=?1",
                        [id],
                    )?;
                    "revoked"
                }
                _ => unreachable!(),
            };
            tx.execute(
                "UPDATE harness_job_triggers SET revision=revision+1,updated_at=?2 WHERE id=?1",
                params![id, clock(now)?],
            )?;
            (id.clone(), phase)
        }
        _ => unreachable!(),
    };
    observe(&tx, &trigger, phase, now)?;
    let value = json!({"trigger":view(&tx,&trigger)?});
    tx.execute(
        "INSERT INTO harness_job_trigger_mutations(issuer,key,digest,view) VALUES(?1,?2,?3,?4)",
        params![actor.issuer, key, digest, serde_json::to_string(&value)?],
    )?;
    tx.commit()?;
    Ok(value)
}

pub fn ingest(connection: &mut Connection, inbound: Inbound, now: u64) -> Result<Acceptance> {
    let now_i64 = clock(now)?;
    if inbound.body.len() > auth::MAX_BODY {
        return Err(Error::new(
            "trigger_payload_too_large",
            "External delivery exceeds the payload byte limit",
        )
        .into());
    }
    if !id(&inbound.trigger_id)
        || !auth::delivery_id(&inbound.delivery_id)
        || !auth::event_name(&inbound.event)
    {
        return Err(invalid(
            "External trigger headers contain an invalid bounded identity",
        ));
    }
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_triggers WHERE id=?1)",
        [&inbound.trigger_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(auth::unauthorized());
    }
    let trigger = load(&tx, &inbound.trigger_id)?;
    if trigger.revoked || trigger.spec.adapter.provider() != inbound.provider {
        return Err(auth::unauthorized());
    }
    let secret:Option<String>=tx.query_row("SELECT secret FROM harness_job_trigger_credentials WHERE trigger_id=?1 AND generation=?2 AND state='active'",params![inbound.trigger_id,trigger.generation],|r|r.get(0)).optional()?.flatten();
    let secret = secret.ok_or_else(auth::unauthorized)?;
    auth::verify(&secret, &inbound)?;
    let parsed = auth::parse(&trigger.spec.adapter, &inbound)?;
    let body_digest = auth::digest(&inbound.body);
    let old:Option<(String,String)>=tx.query_row("SELECT raw_sha256,view FROM harness_job_trigger_deliveries WHERE trigger_id=?1 AND delivery_id=?2",params![inbound.trigger_id,inbound.delivery_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((previous, view)) = old {
        if previous != body_digest {
            return Err(invalid(
                "Delivery identity belongs to a different signed payload",
            ));
        }
        return Ok(Acceptance {
            view: serde_json::from_str(&view)?,
            replayed: true,
        });
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT view FROM harness_job_trigger_deliveries WHERE trigger_id=?1 AND raw_sha256=?2",
            params![inbound.trigger_id, body_digest],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(view) = previous {
        return Ok(Acceptance {
            view: serde_json::from_str(&view)?,
            replayed: true,
        });
    }
    if parsed.sent_at.is_some_and(|at| at.abs_diff(now) > 300_000) {
        return Err(invalid(
            "Fresh generic deliveries require a signed timestamp within five minutes",
        ));
    }
    let (latest,recent):(Option<i64>,i64)=tx.query_row("SELECT MAX(accepted_at),COALESCE(SUM(accepted_at>?2),0) FROM harness_job_trigger_deliveries WHERE trigger_id=?1",params![inbound.trigger_id,clock(now.saturating_sub(60_000))?],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if latest.is_some_and(|at| at > now_i64) || recent >= 10 {
        return Err(Error::new(
            "trigger_rate_limited",
            "Fresh trigger delivery allowance is exhausted; retry the same event later",
        )
        .into());
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM harness_job_trigger_deliveries",
        [],
        |r| r.get(0),
    )?;
    if count >= 4096 {
        return Err(Error::new(
            "busy",
            "External delivery retention is full; dedupe history was preserved",
        )
        .into());
    }
    let (job_revision, job_enabled, job_spec): (i64, bool, String) = tx.query_row(
        "SELECT revision,enabled,spec FROM harness_jobs WHERE id=?1",
        [&trigger.spec.job_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let reason = if !trigger.enabled {
        Some("trigger_disabled")
    } else if !job_enabled {
        Some("job_disabled")
    } else if spec_digest(&job_spec).ok().as_deref() != Some(trigger.authorized_digest.as_str()) {
        Some("job_config_changed")
    } else if !parsed.matches {
        Some("filter_mismatch")
    } else {
        None
    };
    let delivery = random_id();
    let (disposition, reason, occurrence) = if let Some(reason) = reason {
        ("ignored", Some(reason.to_owned()), None)
    } else {
        let occurrence = crate::job_definitions::insert_external_occurrence(
            &tx,
            &trigger.spec.job_id,
            &format!("external:{}:{delivery}", inbound.trigger_id),
            now,
        )?;
        let disposition = if occurrence["state"] == "skipped" {
            "skipped"
        } else {
            "queued"
        };
        (
            disposition,
            occurrence["reason"].as_str().map(str::to_owned),
            occurrence["id"].as_str().map(str::to_owned),
        )
    };
    let value = json!({"delivery":{"id":delivery,"triggerId":inbound.trigger_id,"deliveryId":inbound.delivery_id,"bodyDigest":body_digest,"credentialGeneration":trigger.generation,"triggerRevision":trigger.revision,"jobId":trigger.spec.job_id,"jobRevision":job_revision,"acceptedAt":now,"disposition":disposition,"reason":reason,"occurrenceId":occurrence}});
    tx.execute("INSERT INTO harness_job_trigger_deliveries(id,trigger_id,delivery_id,raw_sha256,credential_generation,trigger_revision,job_id,job_revision,accepted_at,disposition,reason,occurrence_id,view) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![delivery,inbound.trigger_id,inbound.delivery_id,body_digest,trigger.generation,trigger.revision,trigger.spec.job_id,job_revision,clock(now)?,disposition,reason,occurrence,serde_json::to_string(&value)?])?;
    append_transaction(
        &tx,
        vec![Observation {
            session_id: None,
            kind: "job.trigger_delivery",
            at: now,
            payload: json!({"triggerId":inbound.trigger_id,"deliveryId":delivery,"disposition":disposition}),
        }],
    )?;
    tx.commit()?;
    Ok(Acceptance {
        view: value,
        replayed: false,
    })
}
