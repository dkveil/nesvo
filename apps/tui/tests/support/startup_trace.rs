use super::*;
use serde::{Deserialize, Deserializer, Serialize};
use std::sync::{Arc, Mutex};

const PREFIX: &str = "NESVO_STARTUP_PHASE ";
const MAX_RECORDS: usize = 128;
const MAX_LINE_BYTES: usize = 256;
const MAX_TOTAL_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    RuntimeCreate,
    WorkspaceResolve,
    ListenerBind,
    AdvertiseResolve,
    PairingDirectory,
    HostLock,
    PairingPermissions,
    PairingPrepare,
    MetadataOpen,
    JournalOpen,
    StartupEventAppend,
    LauncherDiscover,
    StateInitialize,
    WebhookBind,
    RuntimesInstall,
    ReadinessAnnounce,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Event {
    Begin,
    End,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Ok,
    Failed,
}

fn required_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u8,
    sequence: u64,
    phase: Phase,
    event: Event,
    elapsed_ms: u64,
    #[serde(deserialize_with = "required_option")]
    duration_ms: Option<u64>,
    #[serde(deserialize_with = "required_option")]
    outcome: Option<Outcome>,
}

#[derive(Default)]
pub(super) struct Collector {
    records: Vec<Record>,
    active: Vec<Record>,
    rejected: u64,
    seen: usize,
    bytes: usize,
    truncated: bool,
}

impl Collector {
    fn consume(&mut self, line: &str) -> bool {
        let Some(body) = line.strip_prefix(PREFIX) else {
            return false;
        };
        self.seen = self.seen.saturating_add(1);
        self.bytes = self.bytes.saturating_add(line.len().saturating_add(1));
        if self.seen > MAX_RECORDS || self.bytes > MAX_TOTAL_BYTES {
            self.truncated = true;
            self.rejected = self.rejected.saturating_add(1);
            return true;
        }
        let record = if line.len().saturating_add(1) <= MAX_LINE_BYTES {
            serde_json::from_str::<Record>(body).ok()
        } else {
            None
        };
        if let Some(record) = record
            && self.accept(record)
        {
            return true;
        }
        self.rejected = self.rejected.saturating_add(1);
        true
    }

    fn accept(&mut self, record: Record) -> bool {
        if record.schema_version != 1
            || record.sequence != self.records.len() as u64 + 1
            || self
                .records
                .last()
                .is_some_and(|last| record.elapsed_ms < last.elapsed_ms)
        {
            return false;
        }
        match record.event {
            Event::Begin => {
                if record.duration_ms.is_some()
                    || record.outcome.is_some()
                    || self
                        .records
                        .iter()
                        .any(|previous| previous.phase == record.phase)
                {
                    return false;
                }
                self.active.push(record.clone());
            }
            Event::End => {
                let Some(begin) = self.active.last() else {
                    return false;
                };
                if begin.phase != record.phase
                    || record.outcome.is_none()
                    || record.duration_ms != Some(record.elapsed_ms - begin.elapsed_ms)
                {
                    return false;
                }
                self.active.pop();
            }
        }
        self.records.push(record);
        true
    }

    fn view(&self) -> Value {
        let last_completed = self
            .records
            .iter()
            .rev()
            .find(|record| record.event == Event::End);
        let complete = !self.truncated
            && self.rejected == 0
            && self.active.is_empty()
            && self
                .records
                .first()
                .is_some_and(|record| record.phase == Phase::RuntimeCreate)
            && !self
                .records
                .iter()
                .any(|record| record.outcome == Some(Outcome::Failed))
            && last_completed.is_some_and(|record| {
                record.phase == Phase::ReadinessAnnounce && record.outcome == Some(Outcome::Ok)
            });
        json!({
            "enabled":true,"validRecords":self.records.len(),"rejectedRecords":self.rejected,
            "truncated":self.truncated,"complete":complete,
            "position":if self.records.is_empty() { "unknown" } else { "observed" },
            "lastElapsedMs":self.records.last().map(|record| record.elapsed_ms),
            "activePhases":self.active,"lastCompleted":last_completed,"records":self.records
        })
    }
}

pub(super) type Shared = Arc<Mutex<Collector>>;

pub(super) fn shared() -> Shared {
    Arc::new(Mutex::new(Collector::default()))
}

pub(super) fn consume(trace: &Shared, line: &str) -> bool {
    if !line.starts_with(PREFIX) {
        return false;
    }
    if let Ok(mut collector) = trace.lock() {
        collector.consume(line)
    } else {
        line.starts_with(PREFIX)
    }
}

pub(super) fn view(trace: &Shared) -> Value {
    trace
        .lock()
        .map(|collector| collector.view())
        .unwrap_or_else(|_| json!({"enabled":true,"unavailable":true,"complete":false}))
}

fn line(
    sequence: u64,
    phase: &str,
    event: &str,
    elapsed: u64,
    duration: Value,
    outcome: Value,
) -> String {
    format!(
        "{PREFIX}{}",
        json!({
            "schemaVersion":1,"sequence":sequence,"phase":phase,"event":event,
            "elapsedMs":elapsed,"durationMs":duration,"outcome":outcome
        })
    )
}

#[test]
fn active_boundary_and_completed_duration_are_current_child_evidence() {
    let mut trace = Collector::default();
    assert!(trace.consume(&line(
        1,
        "metadataOpen",
        "begin",
        12,
        Value::Null,
        Value::Null
    )));
    assert_eq!(trace.view()["activePhases"][0]["phase"], "metadataOpen");
    assert_eq!(trace.view()["lastCompleted"], Value::Null);
    assert!(!trace.view()["complete"].as_bool().unwrap());
    trace.consume(&line(2, "metadataOpen", "end", 18, json!(6), json!("ok")));
    assert_eq!(trace.view()["lastCompleted"]["durationMs"], 6);
    assert!(trace.view()["activePhases"].as_array().unwrap().is_empty());
    assert_eq!(Collector::default().view()["position"], "unknown");
}

#[test]
fn failure_and_unfinished_new_phase_never_claim_readiness() {
    let mut trace = Collector::default();
    trace.consume(&line(
        1,
        "metadataOpen",
        "begin",
        0,
        Value::Null,
        Value::Null,
    ));
    trace.consume(&line(
        2,
        "metadataOpen",
        "end",
        1,
        json!(1),
        json!("failed"),
    ));
    trace.consume(&line(
        3,
        "journalOpen",
        "begin",
        2,
        Value::Null,
        Value::Null,
    ));
    let view = trace.view();
    assert_eq!(view["lastCompleted"]["outcome"], "failed");
    assert_eq!(view["activePhases"][0]["phase"], "journalOpen");
    assert_eq!(view["complete"], false);
}

#[test]
fn strict_schema_and_allowlists_discard_private_or_readiness_shaped_payloads() {
    let secret = "private/path prompt-key \u{1b}[31m Rust host listening";
    let mut trace = Collector::default();
    for input in [
        format!("{PREFIX}not-json {secret}"),
        line(1, secret, "begin", 0, Value::Null, Value::Null),
        line(1, "runtimeCreate", secret, 0, Value::Null, Value::Null),
        line(1, "runtimeCreate", "end", 0, json!(0), json!(secret)),
        format!(
            "{PREFIX}{{\"schemaVersion\":1,\"sequence\":1,\"phase\":\"runtimeCreate\",\"event\":\"begin\",\"elapsedMs\":0}}"
        ),
        format!(
            "{PREFIX}{}",
            json!({"schemaVersion":1,"sequence":1,"phase":"runtimeCreate","event":"begin","elapsedMs":0,"durationMs":null,"outcome":null,"raw":secret})
        ),
        format!("{PREFIX}{}", "x".repeat(MAX_LINE_BYTES)),
    ] {
        assert!(
            trace.consume(&input),
            "Even invalid prefixed input is consumed before readiness matching"
        );
    }
    let safe = trace.view().to_string();
    assert!(!safe.contains("private/path"));
    assert!(!safe.contains("prompt-key"));
    assert!(!safe.contains("Rust host listening"));
    assert_eq!(trace.view()["validRecords"], 0);
    assert_eq!(trace.view()["rejectedRecords"], 7);
    assert!(!trace.consume("nesvo Rust host listening on ordinary address"));
}

#[test]
fn sequence_elapsed_duration_duplicates_and_missing_begin_are_rejected() {
    for invalid in [
        line(3, "metadataOpen", "end", 20, json!(8), json!("ok")),
        line(2, "metadataOpen", "end", 11, json!(0), json!("ok")),
        line(2, "metadataOpen", "end", 20, json!(7), json!("ok")),
        line(2, "journalOpen", "end", 20, json!(8), json!("ok")),
        line(2, "metadataOpen", "begin", 20, Value::Null, Value::Null),
    ] {
        let mut trace = Collector::default();
        trace.consume(&line(
            1,
            "metadataOpen",
            "begin",
            12,
            Value::Null,
            Value::Null,
        ));
        trace.consume(&invalid);
        assert_eq!(trace.view()["validRecords"], 1);
        assert_eq!(trace.view()["rejectedRecords"], 1);
        assert_eq!(trace.view()["activePhases"][0]["sequence"], 1);
    }
}

#[test]
fn complete_trace_requires_matching_successful_readiness_and_no_earlier_failure() {
    for outcome in ["ok", "failed"] {
        let mut trace = Collector::default();
        trace.consume(&line(
            1,
            "runtimeCreate",
            "begin",
            0,
            Value::Null,
            Value::Null,
        ));
        trace.consume(&line(
            2,
            "runtimeCreate",
            "end",
            3,
            json!(3),
            json!(outcome),
        ));
        trace.consume(&line(
            3,
            "readinessAnnounce",
            "begin",
            7,
            Value::Null,
            Value::Null,
        ));
        assert_eq!(trace.view()["complete"], false);
        trace.consume(&line(
            4,
            "readinessAnnounce",
            "end",
            9,
            json!(2),
            json!("ok"),
        ));
        assert_eq!(trace.view()["complete"], outcome == "ok");
    }
}

#[test]
fn flood_and_record_bytes_are_bounded_and_never_hide_truncation() {
    let mut trace = Collector::default();
    let raw = format!("{PREFIX}{}", "private-sentinel".repeat(40));
    for _ in 0..MAX_RECORDS + 50 {
        trace.consume(&raw);
    }
    let view = trace.view();
    assert_eq!(view["truncated"], true);
    assert_eq!(view["complete"], false);
    assert!(view["records"].as_array().unwrap().is_empty());
    assert!(!view.to_string().contains("private-sentinel"));
}

async fn completed_trace(fixture: &Fixture) -> Result<Value> {
    waits::until(async || {
        let snapshot = view(&fixture.startup_trace);
        if snapshot["complete"] == true {
            return Ok(Some(snapshot));
        }
        ensure!(
            snapshot["truncated"] == false && snapshot["rejectedRecords"] == 0,
            "Startup trace can no longer complete: {snapshot}"
        );
        Ok(None)
    })
    .await
    .context("Startup trace did not finish after the original listener handshake")
}

fn assert_startup(snapshot: &Value) {
    assert_eq!(snapshot["rejectedRecords"], 0);
    assert_eq!(snapshot["truncated"], false);
    assert_eq!(snapshot["complete"], true);
    let records = snapshot["records"].as_array().unwrap();
    assert_eq!(records[0]["sequence"], 1);
    let begins = records
        .iter()
        .filter(|record| record["event"] == "begin")
        .map(|record| record["phase"].as_str().unwrap())
        .filter(|phase| *phase != "pairingPermissions")
        .collect::<Vec<_>>();
    assert_eq!(
        begins,
        vec![
            "runtimeCreate",
            "workspaceResolve",
            "listenerBind",
            "advertiseResolve",
            "pairingDirectory",
            "hostLock",
            "pairingPrepare",
            "metadataOpen",
            "journalOpen",
            "startupEventAppend",
            "launcherDiscover",
            "stateInitialize",
            "runtimesInstall",
            "readinessAnnounce"
        ]
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["event"] == "begin" && record["phase"] == "pairingPermissions")
            .count(),
        usize::from(cfg!(unix))
    );
}

#[tokio::test]
#[ignore = "native host/client and Node; controlled startup/restart diagnostics, zero model prompts"]
async fn startup_phase_records_identify_fresh_and_restarted_owned_host() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let first_trace = fixture.startup_trace.clone();
        let first = completed_trace(&fixture).await?;
        assert_startup(&first);
        let owner = client(&fixture.pairing()).await?;
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert!(
            sessions["data"]["sessions"]
                .as_array()
                .context("Controlled empty host")?
                .is_empty()
        );
        owner.cancel().await?;
        let pairing: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
        fixture.restart(false).await?;
        let second = completed_trace(&fixture).await?;
        assert_startup(&second);
        assert!(!Arc::ptr_eq(&first_trace, &fixture.startup_trace));
        assert_eq!(
            view(&first_trace),
            first,
            "Old child evidence is immutable after exit"
        );
        let after: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
        ensure!(
            after["key"] == pairing["key"],
            "Restart keeps existing pairing key"
        );
        let owner = client(&fixture.pairing()).await?;
        let sessions = data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        assert!(
            sessions["data"]["sessions"]
                .as_array()
                .context("Restarted empty host")?
                .is_empty()
        );
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
