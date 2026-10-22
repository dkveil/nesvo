use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

fn parsed(text: Option<String>) -> Value {
    text.and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

pub fn view(connection: &Connection, source_attempt: &str) -> Result<Value> {
    let row = connection
        .query_row(
            "SELECT native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,class,probe,state
             FROM harness_job_retries WHERE source_attempt_id=?1",
            [source_attempt],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((native, receipt, decided, not_before, next, class, probe, state)) = row else {
        return Ok(Value::Null);
    };
    if state == "adopted" || (class != "noEffect" && probe.is_none()) {
        return Ok(Value::Null);
    }
    let mut value = json!({
        "jobAttemptId":source_attempt,
        "attemptId":native,
        "launchReceiptId":receipt,
        "decidedAt":decided,
        "notBefore":not_before,
        "nextOrdinal":next,
        "class":class
    });
    if class != "noEffect" {
        value["probe"] = parsed(probe);
    }
    Ok(value)
}

struct Ledger {
    class: String,
    failure: Option<String>,
    key: Option<String>,
    state: String,
    probe: Option<String>,
    claim_probe: Option<String>,
    decided: i64,
    not_before: i64,
    next: Option<i64>,
    counterpart: Option<String>,
}

fn ledger(connection: &Connection, column: &str, attempt: &str) -> Result<Option<Ledger>> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT class,failure,launch_key,state,probe,claim_probe,decided_at,not_before,
                        next_ordinal,target_attempt_id,source_attempt_id
                 FROM harness_job_retries WHERE {column}=?1"
            ),
            [attempt],
            |r| {
                Ok(Ledger {
                    class: r.get(0)?,
                    failure: r.get(1)?,
                    key: r.get(2)?,
                    state: r.get(3)?,
                    probe: r.get(4)?,
                    claim_probe: r.get(5)?,
                    decided: r.get(6)?,
                    not_before: r.get(7)?,
                    next: r.get(8)?,
                    counterpart: if column == "source_attempt_id" {
                        r.get(9)?
                    } else {
                        r.get(10)?
                    },
                })
            },
        )
        .optional()?)
}

impl Ledger {
    fn decision(&self) -> &'static str {
        if self.state == "adopted" {
            "adopted"
        } else if self.next.is_some() {
            "retryWaiting"
        } else if self.probe.is_some() {
            "blocked"
        } else if self.state == "canceled" {
            "canceled"
        } else {
            "probing"
        }
    }
    fn facts(&self) -> Value {
        let decided = self.decision() != "probing";
        json!({
            "class":self.class,
            "failure":self.failure,
            "launchKey":self.key,
            "decision":self.decision(),
            "decidedAt":decided.then_some(self.decided),
            "notBefore":decided.then_some(self.not_before),
            "nextOrdinal":self.next,
            "probe":parsed(self.probe.clone())
        })
    }
}

pub fn classification(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "source_attempt_id", attempt)?
        .map(|ledger| ledger.facts())
        .unwrap_or(Value::Null))
}

pub fn diagnostic(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "source_attempt_id", attempt)?
        .map(|ledger| {
            let mut value = ledger.facts();
            value["state"] = ledger.state.clone().into();
            value["retryJobAttemptId"] = ledger.counterpart.clone().into();
            value["claimProbe"] = parsed(ledger.claim_probe.clone());
            value
        })
        .unwrap_or(Value::Null))
}

pub fn admission(connection: &Connection, attempt: &str) -> Result<Value> {
    Ok(ledger(connection, "target_attempt_id", attempt)?
        .map(|ledger| {
            json!({
                "sourceJobAttemptId":ledger.counterpart,
                "class":ledger.class,
                "claimProbe":parsed(ledger.claim_probe)
            })
        })
        .unwrap_or(Value::Null))
}
