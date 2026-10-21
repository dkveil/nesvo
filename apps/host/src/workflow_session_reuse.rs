use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub struct Live {
    pub blocker: Option<&'static str>,
    pub conversation: Option<String>,
}

const OPEN_ATTEMPTS: [&str; 4] = ["launching", "launchUnknown", "assigned", "reported"];

fn refuse(code: &'static str, message: &'static str) -> anyhow::Error {
    Error::new(code, message).into()
}

pub fn live_refusal(code: &'static str) -> anyhow::Error {
    match code {
        "resume_pending" => refuse(
            "resume_pending",
            "The session's exact conversation resume is not verified yet",
        ),
        "resume_failed" => refuse(
            "identity_mismatch",
            "The session's resume did not verify the task's recorded conversation",
        ),
        "unsupported" => refuse(
            "session_foreign",
            "Task instructions reuse agent workers, not shell command interpreters",
        ),
        "forbidden" | "scope_revoked" => {
            refuse(code, "This caller cannot automate the selected session")
        }
        _ => refuse(
            "session_busy",
            "Reuse needs a live, ready, idle agent with no human control, draft or pending input",
        ),
    }
}

pub fn valid_conversation(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

struct Bound {
    id: String,
    run: String,
    task: String,
    state: String,
}

fn bound(transaction: &Transaction<'_>, session: &str) -> Result<Option<Bound>> {
    Ok(transaction
        .query_row(
            "SELECT a.id,t.run_id,a.task_id,a.state FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.session_id=?1 ORDER BY a.ordinal DESC LIMIT 1",
            [session],
            |r| {
                Ok(Bound {
                    id: r.get(0)?,
                    run: r.get(1)?,
                    task: r.get(2)?,
                    state: r.get(3)?,
                })
            },
        )
        .optional()?)
}

fn recorded(transaction: &Transaction<'_>, attempt: &str) -> Result<Option<String>> {
    Ok(transaction
        .query_row(
            "SELECT i.conversation_id FROM workflow_deliveries d JOIN workflow_delivery_identities i ON i.delivery_id=d.id WHERE d.attempt_id=?1",
            [attempt],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn admit(
    transaction: &Transaction<'_>,
    run: &str,
    task: &str,
    session: &str,
    live: &Live,
    now: u64,
) -> Result<String> {
    let job: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_job_attempts WHERE run_id=?1)",
        [run],
        |r| r.get(0),
    )?;
    if job {
        return Err(refuse(
            "session_foreign",
            "Job-owned workers follow their job policy, not task delivery reuse",
        ));
    }
    let previous = bound(transaction, session)?
        .filter(|b| b.run == run && b.task == task)
        .ok_or_else(|| {
            refuse(
                "session_foreign",
                "The session is not this task's worker in this run",
            )
        })?;
    let (latest, ordinal, state): (String, i64, String) = transaction.query_row(
        "SELECT id,ordinal,state FROM workflow_attempts WHERE task_id=?1 ORDER BY ordinal DESC LIMIT 1",
        [task],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if OPEN_ATTEMPTS.contains(&state.as_str()) {
        return Err(refuse(
            "attempt_unsettled",
            "The task's current attempt is unsettled; reuse needs a settled previous attempt",
        ));
    }
    if latest != previous.id {
        return Err(refuse(
            "session_foreign",
            "Another worker owns the task's latest attempt",
        ));
    }
    if previous.state == "succeeded" {
        return Err(refuse(
            "attempt_state_conflict",
            "Task already has an accepted result",
        ));
    }
    let delivery_open: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_deliveries WHERE attempt_id=?1 AND phase IN ('queued','dispatching','unknown'))",
        [&previous.id],
        |r| r.get(0),
    )?;
    let native_open: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE session_id=?1 AND phase IN ('accepted','dispatching','received','started','waiting','unknown'))",
        [session],
        |r| r.get(0),
    )?;
    if delivery_open || native_open {
        return Err(refuse(
            "attempt_unsettled",
            "An earlier instruction or native operation on this session is unsettled; inspect its receipt",
        ));
    }
    if let Some(code) = live.blocker {
        return Err(live_refusal(code));
    }
    let recorded = recorded(transaction, &previous.id)?;
    let Some(conversation) = live
        .conversation
        .as_deref()
        .filter(|id| valid_conversation(id) && recorded.as_deref() == Some(*id))
    else {
        return Err(refuse(
            "identity_mismatch",
            "The session's current conversation is not the one recorded for this task",
        ));
    };
    let ordinal = ordinal + 1;
    crate::job_timeouts::guard_run(transaction, run, now, crate::event_log::monotonic_millis())?;
    crate::workflow_budget::admit_attempt(transaction, run, ordinal)?;
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_attempts", [], |r| r.get(0))?;
    if ordinal > 16 || count >= 4096 {
        return Err(refuse(
            "busy",
            "Attempt history capacity exhausted; no history was discarded",
        ));
    }
    let id = hex::encode(crate::wire::random::<16>());
    transaction.execute(
        "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,?3,?4,'assigned')",
        params![id, task, ordinal, session],
    )?;
    transaction.execute(
        "INSERT INTO workflow_session_reuses(attempt_id,previous_attempt_id,session_id,conversation_id,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![id, previous.id, session, conversation, now as i64],
    )?;
    let subject: Option<String> = transaction.query_row(
        "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
        [run],
        |r| r.get(0),
    )?;
    append_transaction(
        transaction,
        vec![Observation {
            session_id: subject,
            kind: "run.session_reused",
            at: now,
            payload: json!({"runId":run,"taskId":task,"attemptId":id,"previousAttemptId":previous.id,"sessionId":session}),
        }],
    )?;
    Ok(id)
}

pub fn guard_claim(
    transaction: &Transaction<'_>,
    attempt: &str,
    conversation: Option<&str>,
) -> Result<()> {
    let expected: Option<String> = transaction
        .query_row(
            "SELECT conversation_id FROM workflow_session_reuses WHERE attempt_id=?1",
            [attempt],
            |r| r.get(0),
        )
        .optional()?;
    match expected {
        Some(expected) if conversation != Some(expected.as_str()) => Err(refuse(
            "identity_mismatch",
            "The reused session changed conversation before its instruction was claimed",
        )),
        _ => Ok(()),
    }
}

pub fn record(
    transaction: &Transaction<'_>,
    delivery: &str,
    conversation: Option<&str>,
) -> Result<()> {
    if let Some(conversation) = conversation.filter(|id| valid_conversation(id)) {
        transaction.execute(
            "INSERT OR IGNORE INTO workflow_delivery_identities(delivery_id,conversation_id) VALUES(?1,?2)",
            params![delivery, conversation],
        )?;
    }
    Ok(())
}

pub fn summary(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(connection
        .query_row(
            "SELECT previous_attempt_id,session_id,created_at FROM workflow_session_reuses WHERE attempt_id=?1",
            [attempt],
            |r| {
                Ok(json!({"previousAttemptId":r.get::<_,String>(0)?,"sessionId":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?}))
            },
        )
        .optional()?
        .unwrap_or(Value::Null))
}
