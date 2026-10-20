//! Durable job definitions and occurrence admission; no process or clock I/O.
pub use crate::job_calendar::Schedule;
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor, Scope},
    workflow_launches::Profile,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ACTIVE: &str =
    "'dispatching','prechecking','running','needsValidation','reconcile','canceling'";
fn grace() -> u64 {
    60_000
}
fn budget() -> u64 {
    300_000
}
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Misfire {
    Skip,
    #[default]
    CatchUp,
}
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Overlap {
    #[default]
    Skip,
    Queue,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub title: String,
    pub instruction: String,
    pub profile: Profile,
    pub schedule: Schedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck_id: Option<String>,
    #[serde(default)]
    pub misfire: Misfire,
    #[serde(default = "grace")]
    pub grace_ms: u64,
    #[serde(default)]
    pub overlap: Overlap,
    #[serde(default = "budget")]
    pub max_elapsed_ms: u64,
    // Internal adapter result, neither accepted from the wire nor persisted.
    #[serde(skip)]
    pub calendar: Option<crate::job_calendar::Answer>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    CancelOccurrence {
        key: String,
        job_id: String,
        occurrence_id: String,
    },
    Prechecks {
        request: crate::job_prechecks::Request,
    },
    AbandonPrecheck {
        key: String,
        job_id: String,
        occurrence_id: String,
        expected_digest: String,
        acknowledge_unknown_effects: bool,
    },
    Create {
        key: String,
        spec: Spec,
    },
    Get {
        job_id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Update {
        key: String,
        job_id: String,
        expected_revision: u64,
        spec: Spec,
    },
    SetEnabled {
        key: String,
        job_id: String,
        expected_revision: u64,
        enabled: bool,
    },
    RunNow {
        key: String,
        job_id: String,
        expected_revision: u64,
    },
    History {
        job_id: String,
        #[serde(default)]
        offset: u16,
    },
    Occurrence {
        job_id: String,
        occurrence_id: String,
    },
    Mutation {
        key: String,
    },
}
pub struct Claim {
    pub id: String,
    pub job_id: String,
    pub spec: Spec,
}
pub enum Work {
    CancelPoll {
        slots: u8,
    },
    CancelRequested {
        occurrence: String,
    },
    CancelFinished {
        claim: crate::job_cancellations::Claim,
        result: Option<Value>,
    },
    Poll {
        slots: u8,
    },
    BeginPrecheck {
        occurrence: String,
    },
    FinishPrecheck {
        occurrence: String,
        result: crate::job_prechecks::Outcome,
    },
    Interrupted {
        occurrence: String,
    },
    CalendarDue,
    AdvanceCalendar {
        id: String,
        revision: u64,
        due: u64,
        evaluated_at: u64,
        answer: crate::job_calendar::Answer,
    },
    BindRun {
        occurrence: String,
        run: String,
    },
    Started {
        occurrence: String,
    },
    Refused {
        occurrence: String,
        uncertain: bool,
    },
}
pub enum Reply {
    Cancellations(Vec<crate::job_cancellations::Claim>),
    CancelRequested(bool),
    Claims(Vec<Claim>),
    Calendars(Vec<CalendarDue>),
    Precheck(Option<Box<crate::job_prechecks::Command>>),
    PrecheckPassed(bool),
    Done,
}
pub struct CalendarDue {
    pub id: String,
    pub revision: u64,
    pub due: u64,
    pub schedule: Schedule,
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS harness_jobs(id TEXT PRIMARY KEY,spec TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,next_due INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_job_mutations(issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));
      CREATE INDEX IF NOT EXISTS harness_jobs_due ON harness_jobs(enabled,next_due);
      CREATE TABLE IF NOT EXISTS harness_job_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES harness_jobs(id),job_revision INTEGER NOT NULL,spec TEXT NOT NULL,trigger_key TEXT NOT NULL,trigger_kind TEXT NOT NULL,due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,run_id TEXT REFERENCES workflow_runs(id),started_at INTEGER,finished_at INTEGER,UNIQUE(job_id,trigger_key));
      CREATE INDEX IF NOT EXISTS harness_job_occurrences_active ON harness_job_occurrences(state,job_id);
      CREATE INDEX IF NOT EXISTS harness_job_occurrences_history ON harness_job_occurrences(job_id,created_at);")?;
    let has_error = {
        let mut query = connection.prepare("PRAGMA table_info(harness_jobs)")?;
        query
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "calendar_error")
    };
    if !has_error {
        connection.execute_batch("ALTER TABLE harness_jobs ADD COLUMN calendar_error TEXT;")?;
    }
    let has_coalesced = {
        let mut query = connection.prepare("PRAGMA table_info(harness_job_occurrences)")?;
        query
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "coalesced_from")
    };
    if !has_coalesced {
        connection.execute_batch(
            "ALTER TABLE harness_job_occurrences ADD COLUMN coalesced_from INTEGER;",
        )?;
    }
    crate::job_prechecks::initialize(connection)?;
    crate::job_cancellations::initialize(connection)?;
    Ok(())
}
pub fn recover(connection: &mut Connection, now: u64) -> Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let ids = {
        let mut q=transaction.prepare("SELECT id FROM harness_job_occurrences WHERE state IN ('dispatching','prechecking','running','needsValidation','canceling')")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in ids {
        transaction.execute("UPDATE harness_job_prechecks SET state='unknown',reason='host_restarted',observed_at=?2,finished_at=NULL WHERE occurrence_id=?1 AND state='running'",params![id,now as i64])?;
        transition(
            &transaction,
            &id,
            "reconcile",
            Some("host_restarted"),
            false,
            now,
        )?;
    }
    crate::job_cancellations::recover(&transaction, now)?;
    transaction.commit()?;
    Ok(())
}
fn due(spec: &Spec) -> Result<u64> {
    let Schedule::Once { at } = &spec.schedule else {
        return spec
            .calendar
            .as_ref()
            .ok_or_else(|| invalid("Calendar adapter result is required"))?
            .as_ref()
            .map_err(|failure| {
                let code = match failure.code.as_str() {
                    "calendar_timeout" => "calendar_timeout",
                    "calendar_limit" => "calendar_limit",
                    "calendar_busy" => "calendar_busy",
                    "calendar_unavailable" => "calendar_unavailable",
                    _ => "invalid_calendar",
                };
                anyhow::Error::from(Error::new(code, "Calendar could not be evaluated"))
                    .context(failure.message.clone())
            })?
            .next
            .ok_or_else(|| invalid("No future occurrence remains in this recurrence"));
    };
    if at.len() > 64 {
        return Err(invalid(
            "Once time must be RFC3339 with an explicit UTC offset",
        ));
    }
    let instant = chrono::DateTime::parse_from_rfc3339(at)
        .map_err(|_| invalid("Once time must be RFC3339 with an explicit UTC offset"))?
        .timestamp_millis();
    u64::try_from(instant).map_err(|_| invalid("Once time must be after the Unix epoch"))
}
fn validate(spec: &Spec, now: u64) -> Result<u64> {
    if spec
        .precheck_id
        .as_ref()
        .is_some_and(|id| id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(invalid("Select a host-issued precheck approval ID"));
    }
    crate::groups::valid_name(&spec.title)?;
    if spec.instruction.trim().is_empty()
        || spec.instruction.len() > 8192
        || spec.instruction.contains('\0')
        || serde_json::to_vec(spec)?.len() > 16 * 1024
        || !(1000..=604_800_000).contains(&spec.max_elapsed_ms)
        || spec.grace_ms > 86_400_000
        || spec.profile.program == crate::launchers::Program::Shell
    {
        return Err(invalid(
            "Jobs need an agent, a nonempty instruction within 8192 bytes, a 16 KiB profile, 1 second–7 day elapsed budget and at most 24 hour grace",
        ));
    }
    orchestration::validate_plan(&[orchestration::TaskSpec {
        key: "job".into(),
        title: spec.title.clone(),
        instruction: spec.instruction.clone(),
        dependencies: vec![],
    }])?;
    if let Some(tools) = &spec.profile.allowed_nesvo_tools {
        crate::tool_permissions::validate(tools)?;
    }
    let at = due(spec)?;
    if at <= now
        || (matches!(spec.schedule, Schedule::Once { .. })
            && at.saturating_sub(now) > 366 * 86_400_000)
    {
        return Err(invalid(
            "Choose an explicit future instant up to 366 days ahead",
        ));
    }
    Ok(at)
}
fn validate_approval(connection: &Connection, spec: &Spec) -> Result<()> {
    if let Some(id) = &spec.precheck_id {
        let approval = crate::job_prechecks::view(connection, id)?;
        if approval["enabled"] != true {
            return Err(Error::new(
                "precheck_revoked",
                "Select an enabled owner precheck approval",
            )
            .into());
        }
    }
    Ok(())
}
fn job(connection: &Connection, id: &str, detail: bool) -> Result<Value> {
    let row = connection
        .query_row(
            "SELECT spec,revision,enabled,next_due,created_at,calendar_error FROM harness_jobs WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((spec, revision, enabled, next_due, created, calendar_error)) = row else {
        return Err(Error::new("job_not_found", "Job does not exist").into());
    };
    let spec: Spec = serde_json::from_str(&spec)?;
    let mut view = json!({"id":id,"title":spec.title,"revision":revision,"enabled":enabled,"nextDueAt":next_due,"createdAt":created,"schedule":spec.schedule});
    view["calendarState"] = if calendar_error.is_some() {
        "blocked"
    } else if next_due.is_none() {
        "exhausted"
    } else {
        "ready"
    }
    .into();
    view["calendarError"] = calendar_error
        .map(|text| serde_json::from_str::<Value>(&text))
        .transpose()?
        .unwrap_or(Value::Null);
    if detail {
        view["spec"] = serde_json::to_value(spec)?;
    }
    Ok(view)
}
pub(crate) fn occurrence(
    connection: &Connection,
    job_id: &str,
    id: &str,
    detail: bool,
) -> Result<Value> {
    let row=connection.query_row("SELECT job_revision,trigger_kind,due_at,created_at,state,reason,run_id,started_at,finished_at,spec FROM harness_job_occurrences WHERE id=?1 AND job_id=?2",params![id,job_id],|r|Ok((json!({"id":id,"jobId":job_id,"jobRevision":r.get::<_,i64>(0)?,"trigger":r.get::<_,String>(1)?,"dueAt":r.get::<_,i64>(2)?,"createdAt":r.get::<_,i64>(3)?,"state":r.get::<_,String>(4)?,"reason":r.get::<_,Option<String>>(5)?,"runId":r.get::<_,Option<String>>(6)?,"startedAt":r.get::<_,Option<i64>>(7)?,"finishedAt":r.get::<_,Option<i64>>(8)?}),r.get::<_,String>(9)?))).optional()?;
    let Some((mut view, spec)) = row else {
        return Err(Error::new(
            "occurrence_not_found",
            "Occurrence does not belong to this job",
        )
        .into());
    };
    view["coalescedFromAt"] = connection
        .query_row(
            "SELECT coalesced_from FROM harness_job_occurrences WHERE id=?1",
            [id],
            |r| r.get::<_, Option<i64>>(0),
        )?
        .into();
    view["precheck"] = crate::job_precheck_records::view(connection, id, detail)?;
    view["cancellation"] = crate::job_cancellations::view(connection, id)?;
    let binding = if let Some(run) = view["runId"].as_str() {
        connection.query_row("SELECT a.id,a.session_id,l.operation_id FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id LEFT JOIN workflow_launches l ON l.attempt_id=a.id WHERE t.run_id=?1 ORDER BY a.ordinal DESC,a.rowid DESC LIMIT 1",[run],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional()?
    } else {
        None
    };
    view["attemptId"] = binding.as_ref().map(|b| b.0.as_str()).into();
    view["sessionId"] = binding.as_ref().map(|b| b.1.as_str()).into();
    view["launchReceiptId"] = binding.as_ref().and_then(|b| b.2.as_deref()).into();
    if detail {
        view["spec"] = serde_json::from_str(&spec)?;
    }
    Ok(view)
}
fn observe(
    transaction: &Transaction<'_>,
    job: &str,
    occurrence: Option<&str>,
    phase: &str,
    now: u64,
) -> Result<()> {
    append_transaction(
        transaction,
        vec![Observation {
            session_id: None,
            kind: "job.changed",
            at: now,
            payload: json!({"jobId":job,"occurrenceId":occurrence,"phase":phase}),
        }],
    )?;
    Ok(())
}
pub(crate) fn transition(
    transaction: &Transaction<'_>,
    id: &str,
    state: &str,
    reason: Option<&str>,
    finished: bool,
    now: u64,
) -> Result<()> {
    let job: String = transaction.query_row(
        "SELECT job_id FROM harness_job_occurrences WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let changed=transaction.execute("UPDATE harness_job_occurrences SET state=?2,reason=?3,finished_at=CASE WHEN ?4 THEN ?5 ELSE finished_at END WHERE id=?1 AND (state<>?2 OR reason IS NOT ?3)",params![id,state,reason,finished,now as i64])?;
    if changed > 0 {
        observe(transaction, &job, Some(id), state, now)?;
    }
    Ok(())
}
fn insert_occurrence(
    transaction: &Transaction<'_>,
    record: &Value,
    trigger: &str,
    kind: &str,
    at: u64,
    now: u64,
) -> Result<String> {
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM harness_job_occurrences", [], |r| {
            r.get(0)
        })?;
    if count >= 4096 {
        return Err(Error::new(
            "busy",
            "Job history retention is full; no history was discarded",
        )
        .into());
    }
    let spec: Spec = serde_json::from_value(record["spec"].clone())?;
    let job = record["id"]
        .as_str()
        .ok_or_else(|| invalid("Invalid stored job identity"))?;
    let active:bool=transaction.query_row(&format!("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE job_id=?1 AND state IN ({ACTIVE},'queued'))"),[job],|r|r.get(0))?;
    let queued: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE job_id=?1 AND state='queued')",
        [job],
        |r| r.get(0),
    )?;
    let late = kind == "schedule"
        && now.saturating_sub(at)
            > match spec.misfire {
                Misfire::Skip => 5000,
                Misfire::CatchUp => spec.grace_ms,
            };
    let reason = if late {
        Some("missed_window")
    } else if active && matches!(spec.overlap, Overlap::Skip) {
        Some("overlap")
    } else if queued {
        Some("queue_full")
    } else {
        None
    };
    let id = hex::encode(crate::wire::random::<16>());
    let state = if reason.is_some() {
        "skipped"
    } else {
        "queued"
    };
    transaction.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,reason,finished_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,job,record["revision"].as_i64(),serde_json::to_string(&spec)?,trigger,kind,at as i64,now as i64,state,reason,reason.map(|_|now as i64)])?;
    observe(transaction, job, Some(&id), state, now)?;
    Ok(id)
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
            "Only the owner may configure or inspect scheduled jobs",
        )
        .into());
    }
    if let Request::Prechecks { request } = request {
        return crate::job_prechecks::execute(connection, actor, request, now);
    }
    match &request {
        Request::Mutation { key } => {
            orchestration::validate_key(key)?;
            let saved: Option<String> = connection
                .query_row(
                    "SELECT view FROM harness_job_mutations WHERE issuer=?1 AND key=?2",
                    params![actor.issuer, key],
                    |r| r.get(0),
                )
                .optional()?;
            return saved
                .map(|view| serde_json::from_str(&view).map_err(Into::into))
                .unwrap_or_else(|| {
                    Err(
                        Error::new("mutation_not_found", "Job mutation key was not accepted")
                            .into(),
                    )
                });
        }
        Request::Get { job_id } => return Ok(json!({"job":job(connection,job_id,true)?})),
        Request::Occurrence {
            job_id,
            occurrence_id,
        } => return Ok(json!({"occurrence":occurrence(connection,job_id,occurrence_id,true)?})),
        Request::List { offset } => {
            if *offset > 4096 {
                return Err(invalid("Invalid job page offset"));
            }
            let mut q = connection
                .prepare("SELECT id FROM harness_jobs ORDER BY created_at,id LIMIT 17 OFFSET ?1")?;
            let ids = q
                .query_map([offset], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let rows = ids
                .iter()
                .take(16)
                .map(|id| job(connection, id, false))
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"jobs":rows,"nextOffset":if ids.len()>16{Some(*offset+16)}else{None}}),
            );
        }
        Request::History { job_id, offset } => {
            job(connection, job_id, false)?;
            if *offset > 4096 {
                return Err(invalid("Invalid occurrence page offset"));
            }
            let mut q=connection.prepare("SELECT id FROM harness_job_occurrences WHERE job_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 9 OFFSET ?2")?;
            let ids = q
                .query_map(params![job_id, offset], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let rows = ids
                .iter()
                .take(8)
                .map(|id| occurrence(connection, job_id, id, false))
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"occurrences":rows,"nextOffset":if ids.len()>8{Some(*offset+8)}else{None}}),
            );
        }
        _ => {}
    }
    let key = match &request {
        Request::Create { key, .. }
        | Request::Update { key, .. }
        | Request::SetEnabled { key, .. }
        | Request::RunNow { key, .. }
        | Request::CancelOccurrence { key, .. }
        | Request::AbandonPrecheck { key, .. } => key,
        _ => unreachable!(),
    };
    orchestration::validate_key(key)?;
    let digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"jobs","request":request}))?,
        )
        .as_ref(),
    );
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let saved: Option<(String, String)> = transaction
        .query_row(
            "SELECT digest,view FROM harness_job_mutations WHERE issuer=?1 AND key=?2",
            params![actor.issuer, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((old, view)) = saved {
        if old != digest {
            return Err(Error::new(
                "idempotency_conflict",
                "Job mutation key belongs to a different intent",
            )
            .into());
        }
        return Ok(serde_json::from_str(&view)?);
    }
    let retained: i64 =
        transaction.query_row("SELECT count(*) FROM harness_job_mutations", [], |r| {
            r.get(0)
        })?;
    if retained >= 4096 {
        return Err(Error::new(
            "busy",
            "Job mutation retention is full; no accepted keys were discarded",
        )
        .into());
    }
    let view = match &request {
        Request::CancelOccurrence {
            job_id,
            occurrence_id,
            ..
        } => crate::job_cancellations::accept(&transaction, &actor, job_id, occurrence_id, now)?,
        Request::AbandonPrecheck {
            job_id,
            occurrence_id,
            expected_digest,
            acknowledge_unknown_effects,
            ..
        } => {
            let current = occurrence(&transaction, job_id, occurrence_id, true)?;
            if !acknowledge_unknown_effects
                || !current["runId"].is_null()
                || current["state"] != "reconcile"
                || !matches!(
                    current["precheck"]["state"].as_str(),
                    Some("unknown" | "passed")
                )
                || current["precheck"]["approvalDigest"] != *expected_digest
            {
                return Err(Error::new("occurrence_conflict","Inspect the unknown precheck and explicitly acknowledge its effects before abandoning this exact command; no process is resumed or undone").into());
            }
            transaction.execute("UPDATE harness_job_prechecks SET state='abandoned',reason='owner_abandoned',observed_at=?2 WHERE occurrence_id=?1",params![occurrence_id,now as i64])?;
            transaction.execute("UPDATE harness_job_cancellations SET state='abandoned',reason='owner_acknowledged_unknown_effects',observed_at=?2 WHERE occurrence_id=?1",params![occurrence_id,now as i64])?;
            transition(
                &transaction,
                occurrence_id,
                "canceled",
                Some("precheck_owner_abandoned"),
                true,
                now,
            )?;
            json!({"occurrence":occurrence(&transaction,job_id,occurrence_id,true)?})
        }
        Request::Create { spec, .. } => {
            let at = validate(spec, now)?;
            validate_approval(&transaction, spec)?;
            let count: i64 =
                transaction.query_row("SELECT count(*) FROM harness_jobs", [], |r| r.get(0))?;
            if count >= 64 {
                return Err(Error::new("busy", "Job definition retention is full").into());
            }
            let id = hex::encode(crate::wire::random::<16>());
            transaction.execute("INSERT INTO harness_jobs(id,spec,revision,enabled,next_due,created_at) VALUES(?1,?2,1,1,?3,?4)",params![id,serde_json::to_string(spec)?,at as i64,now as i64])?;
            observe(&transaction, &id, None, "created", now)?;
            json!({"job":job(&transaction,&id,true)?})
        }
        Request::Update {
            job_id,
            expected_revision,
            ..
        }
        | Request::SetEnabled {
            job_id,
            expected_revision,
            ..
        }
        | Request::RunNow {
            job_id,
            expected_revision,
            ..
        } => {
            let current = job(&transaction, job_id, true)?;
            if current["revision"] != *expected_revision {
                return Err(Error::new(
                    "revision_conflict",
                    "Job configuration changed; inspect before mutating",
                )
                .into());
            }
            match &request {
                Request::Update { spec, .. } => {
                    let at = validate(spec, now)?;
                    validate_approval(&transaction, spec)?;
                    transaction.execute("UPDATE harness_jobs SET spec=?2,next_due=?3,calendar_error=NULL,revision=revision+1 WHERE id=?1",params![job_id,serde_json::to_string(spec)?,at as i64])?;
                    observe(&transaction, job_id, None, "updated", now)?;
                    json!({"job":job(&transaction,job_id,true)?})
                }
                Request::SetEnabled { enabled, .. } => {
                    transaction.execute(
                        "UPDATE harness_jobs SET enabled=?2,revision=revision+1 WHERE id=?1",
                        params![job_id, enabled],
                    )?;
                    observe(
                        &transaction,
                        job_id,
                        None,
                        if *enabled { "enabled" } else { "disabled" },
                        now,
                    )?;
                    json!({"job":job(&transaction,job_id,true)?})
                }
                Request::RunNow { .. } => {
                    let id = insert_occurrence(
                        &transaction,
                        &current,
                        &format!("manual:{key}"),
                        "manual",
                        now,
                        now,
                    )?;
                    json!({"job":current,"occurrence":occurrence(&transaction,job_id,&id,true)?})
                }
                _ => unreachable!(),
            }
        }
        _ => unreachable!(),
    };
    transaction.execute(
        "INSERT INTO harness_job_mutations(issuer,key,digest,view) VALUES(?1,?2,?3,?4)",
        params![actor.issuer, key, digest, serde_json::to_string(&view)?],
    )?;
    transaction.commit()?;
    Ok(view)
}
fn refresh(transaction: &Transaction<'_>, now: u64) -> Result<()> {
    crate::job_cancellations::refresh(transaction, now)?;
    let rows = {
        let mut q=transaction.prepare(&format!("SELECT o.id,r.state,(SELECT a.state FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE t.run_id=r.id ORDER BY a.ordinal DESC LIMIT 1),e.reason,o.state FROM harness_job_occurrences o JOIN workflow_runs r ON r.id=o.run_id LEFT JOIN workflow_executors e ON e.run_id=r.id WHERE o.state IN ({ACTIVE})"))?;
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, run, attempt, reason, current) in rows {
        if crate::job_cancellations::requested(transaction, &id)? {
            continue;
        }
        match (run.as_str(), attempt.as_deref()) {
            ("succeeded", _) => transition(transaction, &id, "succeeded", None, true, now)?,
            ("canceled" | "stopped", _) => {
                transition(transaction, &id, "canceled", None, true, now)?
            }
            (_, Some("failed" | "launchFailed")) => transition(
                transaction,
                &id,
                "failed",
                Some("attempt_failed"),
                true,
                now,
            )?,
            (_, Some("launchUnknown")) => transition(
                transaction,
                &id,
                "reconcile",
                Some("launch_unconfirmed"),
                false,
                now,
            )?,
            (_, Some("reported")) => transition(
                transaction,
                &id,
                "needsValidation",
                Some("validation_pending"),
                false,
                now,
            )?,
            _ => {
                if matches!(current.as_str(), "dispatching" | "running") {
                    transition(transaction, &id, &current, reason.as_deref(), false, now)?;
                }
            }
        }
    }
    Ok(())
}
pub fn work(connection: &mut Connection, work: Work, now: u64) -> Result<Reply> {
    let slots = match &work {
        Work::Poll { slots } => i64::from((*slots).min(4)),
        _ => 4,
    };
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let reply = match work {
        Work::CancelRequested { occurrence } => Reply::CancelRequested(
            crate::job_cancellations::requested(&transaction, &occurrence)?,
        ),
        Work::CancelPoll { slots } => {
            crate::job_cancellations::refresh(&transaction, now)?;
            Reply::Cancellations(crate::job_cancellations::claims(&transaction, slots, now)?)
        }
        Work::CancelFinished { claim, result } => {
            crate::job_cancellations::finish(&transaction, &claim, result, now)?;
            Reply::Done
        }
        Work::Interrupted { occurrence } => {
            let phase: Option<String> = transaction
                .query_row(
                    "SELECT state FROM harness_job_occurrences WHERE id=?1",
                    [&occurrence],
                    |r| r.get(0),
                )
                .optional()?;
            let running_precheck:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1 AND state='running')",[&occurrence],|r|r.get(0))?;
            if running_precheck {
                let result = crate::job_prechecks::Outcome::failed(
                    crate::job_prechecks::OutcomeState::Unknown,
                    "dispatch_interrupted",
                );
                crate::job_precheck_records::finish(&transaction, &occurrence, result, now)?;
                transition(
                    &transaction,
                    &occurrence,
                    "reconcile",
                    Some("precheck_unconfirmed"),
                    false,
                    now,
                )?;
            } else if matches!(phase.as_deref(), Some("dispatching" | "running")) {
                transition(
                    &transaction,
                    &occurrence,
                    "reconcile",
                    Some("dispatch_interrupted"),
                    false,
                    now,
                )?;
            }
            Reply::Done
        }
        Work::BeginPrecheck { occurrence } => {
            crate::job_precheck_records::begin(&transaction, &occurrence, now)?
        }
        Work::FinishPrecheck { occurrence, result } => {
            let (passed, state, reason) =
                crate::job_precheck_records::finish(&transaction, &occurrence, result, now)?;
            transition(
                &transaction,
                &occurrence,
                state,
                reason,
                !passed && state != "reconcile",
                now,
            )?;
            Reply::PrecheckPassed(passed)
        }
        Work::CalendarDue => {
            let retained: i64 =
                transaction.query_row("SELECT count(*) FROM harness_job_occurrences", [], |r| {
                    r.get(0)
                })?;
            let mut q = transaction.prepare("SELECT id,revision,next_due,spec FROM harness_jobs WHERE enabled=1 AND next_due<=?1 AND json_extract(spec,'$.schedule.kind') IN ('cron','rrule') ORDER BY next_due,id LIMIT ?2")?;
            let records = q
                .query_map(params![now as i64, (4096 - retained).clamp(0, 8)], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut due = Vec::new();
            for (id, revision, at, spec) in records {
                let spec: Spec = serde_json::from_str(&spec)?;
                if !matches!(spec.schedule, Schedule::Once { .. }) {
                    due.push(CalendarDue {
                        id,
                        revision: u64::try_from(revision)
                            .map_err(|_| invalid("Invalid stored job revision"))?,
                        due: u64::try_from(at)
                            .map_err(|_| invalid("Invalid stored job due time"))?,
                        schedule: spec.schedule,
                    });
                }
            }
            Reply::Calendars(due)
        }
        Work::AdvanceCalendar {
            id,
            revision,
            due,
            evaluated_at,
            answer,
        } => {
            refresh(&transaction, now)?;
            let record = job(&transaction, &id, true)?;
            let retained: i64 =
                transaction.query_row("SELECT count(*) FROM harness_job_occurrences", [], |r| {
                    r.get(0)
                })?;
            // The off-worker result is a proposal, never authority over a
            // concurrently edited/disabled calendar or another tick's cursor.
            if record["enabled"] == true
                && record["revision"] == revision
                && record["nextDueAt"] == due
                && due <= evaluated_at
                && evaluated_at <= now
                && retained < 4096
            {
                let (at, next, failure) = match answer {
                    Ok(window) if window.next.is_none_or(|at| at > evaluated_at) => {
                        let at = window
                            .previous
                            .filter(|at| *at >= due && *at <= evaluated_at)
                            .unwrap_or(due);
                        (at, window.next, None)
                    }
                    Ok(_) => return Err(invalid("Invalid calendar successor")),
                    Err(failure) => (due, None, Some(failure)),
                };
                let occurrence = insert_occurrence(
                    &transaction,
                    &record,
                    &format!("schedule:{revision}:{at}"),
                    "schedule",
                    at,
                    now,
                )?;
                transaction.execute(
                    "UPDATE harness_jobs SET next_due=?2,calendar_error=?3 WHERE id=?1",
                    params![
                        id,
                        next.map(|n| n as i64),
                        failure.as_ref().map(serde_json::to_string).transpose()?
                    ],
                )?;
                // One retained occurrence represents the latest missed slot,
                // with an explicit start of the coalesced interval for audit.
                transaction.execute(
                    "UPDATE harness_job_occurrences SET coalesced_from=?2 WHERE id=?1",
                    params![occurrence, (at > due).then_some(due as i64)],
                )?;
                observe(
                    &transaction,
                    &id,
                    None,
                    if failure.is_some() {
                        "calendarBlocked"
                    } else {
                        "calendarAdvanced"
                    },
                    now,
                )?;
            }
            Reply::Done
        }
        Work::Poll { .. } => {
            refresh(&transaction, now)?;
            let retained: i64 =
                transaction.query_row("SELECT count(*) FROM harness_job_occurrences", [], |r| {
                    r.get(0)
                })?;
            let due = {
                let mut q=transaction.prepare("SELECT id FROM harness_jobs WHERE enabled=1 AND next_due<=?1 AND json_extract(spec,'$.schedule.kind')='once' ORDER BY next_due,id LIMIT ?2")?;
                q.query_map(params![now as i64, (4096 - retained).clamp(0, 8)], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for id in due {
                let record = job(&transaction, &id, true)?;
                let spec: Spec = serde_json::from_value(record["spec"].clone())?;
                if !matches!(spec.schedule, Schedule::Once { .. }) {
                    continue;
                }
                let at = record["nextDueAt"]
                    .as_u64()
                    .ok_or_else(|| invalid("Invalid stored due instant"))?;
                insert_occurrence(
                    &transaction,
                    &record,
                    &format!("schedule:{}:{at}", record["revision"]),
                    "schedule",
                    at,
                    now,
                )?;
                transaction.execute("UPDATE harness_jobs SET next_due=NULL WHERE id=?1", [&id])?;
            }
            let candidates = {
                let mut q=transaction.prepare(&format!("SELECT o.id,o.job_id,o.spec FROM harness_job_occurrences o JOIN harness_jobs j ON j.id=o.job_id WHERE o.state='queued' AND (j.enabled=1 OR o.trigger_kind='manual') AND NOT EXISTS(SELECT 1 FROM harness_job_occurrences a WHERE a.job_id=o.job_id AND a.state IN ({ACTIVE})) ORDER BY o.created_at,o.rowid LIMIT ?1"))?;
                q.query_map([slots], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut claims = Vec::new();
            for (id, job_id, spec) in candidates {
                transition(&transaction, &id, "dispatching", None, false, now)?;
                transaction.execute(
                    "UPDATE harness_job_occurrences SET started_at=?2 WHERE id=?1",
                    params![id, now as i64],
                )?;
                claims.push(Claim {
                    id,
                    job_id,
                    spec: serde_json::from_str(&spec)?,
                });
            }
            Reply::Claims(claims)
        }
        Work::BindRun { occurrence, run } => {
            let spec: String = transaction.query_row(
                "SELECT spec FROM harness_job_occurrences WHERE id=?1",
                [&occurrence],
                |r| r.get(0),
            )?;
            let spec: Spec = serde_json::from_str(&spec)?;
            if spec.precheck_id.is_some() {
                let passed:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_prechecks WHERE occurrence_id=?1 AND state='passed')",[&occurrence],|r|r.get(0))?;
                if !passed {
                    return Err(Error::new(
                        "precheck_required",
                        "A job run requires a confirmed passed precheck",
                    )
                    .into());
                }
            }
            let changed=transaction.execute("UPDATE harness_job_occurrences SET run_id=?2 WHERE id=?1 AND state='dispatching' AND run_id IS NULL",params![occurrence,run])?;
            if changed != 1 {
                return Err(Error::new(
                    "occurrence_conflict",
                    "Job dispatch is no longer bindable",
                )
                .into());
            }
            Reply::Done
        }
        Work::Started { occurrence } => {
            let pending:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE id=?1 AND state='dispatching')",[&occurrence],|r|r.get(0))?;
            if pending {
                transition(&transaction, &occurrence, "running", None, false, now)?;
            }
            Reply::Done
        }
        Work::Refused {
            occurrence,
            uncertain,
        } => {
            let pending:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM harness_job_occurrences WHERE id=?1 AND state IN ('dispatching','running'))",[&occurrence],|r|r.get(0))?;
            if pending {
                transition(
                    &transaction,
                    &occurrence,
                    if uncertain { "reconcile" } else { "failed" },
                    Some(if uncertain {
                        "dispatch_unconfirmed"
                    } else {
                        "dispatch_refused"
                    }),
                    !uncertain,
                    now,
                )?;
            }
            Reply::Done
        }
    };
    transaction.commit()?;
    Ok(reply)
}
