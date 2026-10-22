use super::{
    evidence::no_effect_result,
    source::{Source, launch_key},
};
use crate::job_attempts;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Found {
    Absent,
    NoEffectProven,
    Attempt,
    Session,
}

impl Found {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::NoEffectProven => "noEffectProven",
            Self::Attempt => "attemptFound",
            Self::Session => "sessionFound",
        }
    }
}

pub(super) struct Probe {
    pub(super) found: Found,
    key: String,
    pub(super) run: Option<String>,
    executor_accepted: bool,
    pub(super) attempt: Option<String>,
    session: Option<String>,
    pub(super) receipt: Option<String>,
    pub(super) attempt_state: Option<String>,
}

impl Probe {
    pub(super) fn json(&self, now: u64) -> Value {
        json!({
            "observedAt":now,
            "result":self.found.label(),
            "launchKey":self.key,
            "runId":self.run,
            "executorAccepted":self.executor_accepted,
            "attemptId":self.attempt,
            "attemptState":self.attempt_state,
            "sessionId":self.session,
            "launchReceiptId":self.receipt
        })
    }
}

type NativeRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(super) fn probe(connection: &Connection, source: &Source) -> Result<Probe> {
    let key = launch_key(source);
    let prefix = job_attempts::key_prefix(&source.job, &source.occurrence, source.ordinal);
    let run = match &source.run {
        Some(run) => Some(run.clone()),
        None => connection
            .query_row(
                "SELECT json_extract(view,'$.run.id') FROM workflow_mutations
                 WHERE issuer='owner' AND key=?1 AND json_valid(view)",
                [format!("{prefix}:run")],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten(),
    };
    let executor_accepted: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_mutations WHERE issuer='owner' AND key=?1)",
        [&key],
        |r| r.get(0),
    )?;
    let mut probe = Probe {
        found: Found::Absent,
        key,
        run: run.clone(),
        executor_accepted,
        attempt: None,
        session: None,
        receipt: None,
        attempt_state: None,
    };
    let Some(run) = run else {
        return Ok(probe);
    };
    let rows: Vec<NativeRow> = {
        let mut query = connection.prepare(
            "SELECT n.id,n.session_id,n.state,l.operation_id,p.phase,p.result
             FROM workflow_tasks t JOIN workflow_attempts n ON n.task_id=t.id
             LEFT JOIN workflow_launches l ON l.attempt_id=n.id
             LEFT JOIN operation_receipts p ON p.id=l.operation_id
             WHERE t.run_id=?1 ORDER BY n.ordinal,n.rowid",
        )?;
        query
            .query_map([&run], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (attempt, session, state, receipt, phase, result) in rows {
        let session_seen: bool = connection.query_row(
            "SELECT ?2 IS 'created'
                OR EXISTS(SELECT 1 FROM workflow_process_exits WHERE session_id=?1)
                OR EXISTS(SELECT 1 FROM domain_events WHERE session_id=?1)
                OR EXISTS(SELECT 1 FROM operation_receipts WHERE session_id=?1 AND id IS NOT ?3)",
            params![session, phase, receipt],
            |r| r.get(0),
        )?;
        let proven = state == "launchFailed"
            && phase.as_deref() == Some("failed")
            && no_effect_result(result.as_deref())
            && !session_seen;
        let found = if session_seen {
            Found::Session
        } else if proven {
            Found::NoEffectProven
        } else {
            Found::Attempt
        };
        if probe.found == Found::Absent || found != Found::NoEffectProven {
            probe.found = found;
            probe.attempt = Some(attempt);
            probe.session = Some(session);
            probe.receipt = receipt;
            probe.attempt_state = Some(state);
        }
        if found != Found::NoEffectProven {
            break;
        }
    }
    Ok(probe)
}
