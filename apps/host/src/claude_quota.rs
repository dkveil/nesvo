use crate::agent_events::{self, RootQuotaTicket};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::Path};

const MAX_INPUT_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reason {
    Observed,
    PartialSnapshot,
    WindowsUnavailable,
    InvalidWindow,
    InvalidInput,
    InputOversized,
    InputReadFailed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Window {
    pub(crate) used_percentage: f64,
    pub(crate) resets_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredSnapshot {
    pub(crate) started_wall_ms: u64,
    pub(crate) received_wall_ms: u64,
    pub(crate) started_monotonic_ms: u64,
    pub(crate) received_monotonic_ms: u64,
    pub(crate) five_hour: Option<Window>,
    pub(crate) seven_day: Option<Window>,
    pub(crate) reason: Reason,
}

impl StoredSnapshot {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.received_monotonic_ms >= self.started_monotonic_ms,
            "Invalid quota receipt clock"
        );
        let now = i64::try_from(self.received_wall_ms / 1000)?;
        for window in self.five_hour.iter().chain(self.seven_day.iter()) {
            ensure!(
                window.used_percentage.is_finite()
                    && (0.0..=100.0).contains(&window.used_percentage)
                    && window.resets_at > now,
                "Invalid quota window"
            );
        }
        let count = usize::from(self.five_hour.is_some()) + usize::from(self.seven_day.is_some());
        ensure!(
            match self.reason {
                Reason::Observed => count == 2,
                Reason::PartialSnapshot => count == 1,
                _ => count == 0,
            },
            "Invalid quota outcome"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Observation {
    pub(crate) scope: RootQuotaTicket,
    pub(crate) snapshot: StoredSnapshot,
}

pub(crate) fn decode_snapshot(encoded: &str) -> Result<StoredSnapshot> {
    ensure!(encoded.len() <= 2048, "Invalid stored quota snapshot");
    let snapshot: StoredSnapshot = serde_json::from_str(encoded)
        .map_err(|_| anyhow::anyhow!("Invalid stored quota snapshot"))?;
    snapshot.validate()?;
    Ok(snapshot)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReceiveOutcome {
    Recorded,
    RejectedScope,
}

#[derive(Clone, Copy)]
pub(crate) struct ReceiptClock {
    pub wall_ms: u64,
    pub monotonic_ms: u64,
}

impl ReceiptClock {
    pub fn now() -> Result<Self> {
        Ok(Self {
            wall_ms: crate::status::now_millis(),
            monotonic_ms: system_monotonic_millis()?,
        })
    }
}

#[cfg(windows)]
fn system_monotonic_millis() -> Result<u64> {
    Ok(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() })
}

#[cfg(unix)]
fn system_monotonic_millis() -> Result<u64> {
    let mut value = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    ensure!(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut value) } == 0,
        "Quota monotonic clock unavailable"
    );
    let seconds = u64::try_from(value.tv_sec)?;
    let nanos = u64::try_from(value.tv_nsec)?;
    ensure!(nanos < 1_000_000_000, "Invalid quota monotonic clock");
    seconds
        .checked_mul(1000)
        .and_then(|ms| ms.checked_add(nanos / 1_000_000))
        .ok_or_else(|| anyhow::anyhow!("Quota monotonic clock exhausted"))
}

pub(crate) fn receive(report: &Path, input: impl Read) -> Result<ReceiveOutcome> {
    let started = ReceiptClock::now()?;
    let Some(ticket) = agent_events::begin_root_quota(report)? else {
        return Ok(ReceiveOutcome::RejectedScope);
    };
    let mut bytes = Vec::with_capacity(MAX_INPUT_BYTES as usize + 1);
    let failure = match input.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes) {
        Err(_) => Some(Reason::InputReadFailed),
        Ok(_) if bytes.len() > MAX_INPUT_BYTES as usize => Some(Reason::InputOversized),
        Ok(_) => None,
    };
    let received = ReceiptClock::now()?;
    let (five_hour, seven_day, reason) = if let Some(reason) = failure {
        (None, None, reason)
    } else {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => {
                if !root_matches(&value, &ticket) {
                    return Ok(ReceiveOutcome::RejectedScope);
                }
                parse_windows(&value, received.wall_ms)
            }
            Err(_) => (None, None, Reason::InvalidInput),
        }
    };
    let snapshot = StoredSnapshot {
        started_wall_ms: started.wall_ms,
        received_wall_ms: received.wall_ms,
        started_monotonic_ms: started.monotonic_ms,
        received_monotonic_ms: received.monotonic_ms,
        five_hour,
        seven_day,
        reason,
    };
    Ok(
        if agent_events::append_root_quota(report, &ticket, &snapshot)? {
            ReceiveOutcome::Recorded
        } else {
            ReceiveOutcome::RejectedScope
        },
    )
}

pub(crate) fn receive_capture(
    report: &Path,
    anchor: &crate::claude_quota_diagnostics::Anchor,
    input: impl Read,
) -> crate::claude_quota_diagnostics::Outcome {
    use crate::claude_quota_diagnostics::{self as diagnostics, Begin, Outcome, Stage};
    let Ok(started) = ReceiptClock::now() else {
        eprintln!("nesvo quota capture diagnostics are unavailable");
        return Outcome::StorageUnavailable;
    };
    let reservation = match diagnostics::begin(report, anchor, started) {
        Ok(Begin::Reserved(reservation)) => reservation,
        Ok(Begin::ScopeChanged) => return Outcome::ScopeChanged,
        Err(_) => {
            return capture_storage_unavailable(report, anchor, Stage::Begin, None, started);
        }
    };
    let (requested, snapshot) = match &reservation.quota {
        None => (Outcome::RootUnbound, None),
        Some(ticket) => {
            let mut bytes = Vec::with_capacity(MAX_INPUT_BYTES as usize + 1);
            let failure = match input.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes) {
                Err(_) => Some(Reason::InputReadFailed),
                Ok(_) if bytes.len() > MAX_INPUT_BYTES as usize => Some(Reason::InputOversized),
                Ok(_) => None,
            };
            let Ok(received) = ReceiptClock::now() else {
                return capture_storage_unavailable(
                    report,
                    anchor,
                    Stage::Append,
                    Some(reservation.attempt.attempt_sequence),
                    started,
                );
            };
            let parsed = if let Some(reason) = failure {
                Some((None, None, reason))
            } else {
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) if root_matches(&value, ticket) => {
                        Some(parse_windows(&value, received.wall_ms))
                    }
                    Ok(_) => None,
                    Err(_) => Some((None, None, Reason::InvalidInput)),
                }
            };
            match parsed {
                Some((five_hour, seven_day, reason)) => (
                    Outcome::Recorded,
                    Some(StoredSnapshot {
                        started_wall_ms: started.wall_ms,
                        received_wall_ms: received.wall_ms,
                        started_monotonic_ms: started.monotonic_ms,
                        received_monotonic_ms: received.monotonic_ms,
                        five_hour,
                        seven_day,
                        reason,
                    }),
                ),
                None => (Outcome::PayloadScopeRejected, None),
            }
        }
    };
    let Ok(completed) = ReceiptClock::now() else {
        return capture_storage_unavailable(
            report,
            anchor,
            Stage::Append,
            Some(reservation.attempt.attempt_sequence),
            started,
        );
    };
    match diagnostics::finish(
        report,
        anchor,
        &reservation,
        requested,
        snapshot.as_ref(),
        completed,
    ) {
        Ok(outcome) => outcome,
        Err(_) => {
            diagnostics::storage_failure(
                report,
                anchor,
                Stage::Append,
                Some(reservation.attempt.attempt_sequence),
                started,
                completed,
            );
            Outcome::StorageUnavailable
        }
    }
}

fn capture_storage_unavailable(
    report: &Path,
    anchor: &crate::claude_quota_diagnostics::Anchor,
    stage: crate::claude_quota_diagnostics::Stage,
    attempt_sequence: Option<u64>,
    started: ReceiptClock,
) -> crate::claude_quota_diagnostics::Outcome {
    if let Ok(completed) = ReceiptClock::now() {
        crate::claude_quota_diagnostics::storage_failure(
            report,
            anchor,
            stage,
            attempt_sequence,
            started,
            completed,
        );
    } else {
        eprintln!("nesvo quota capture diagnostics are unavailable");
    }
    crate::claude_quota_diagnostics::Outcome::StorageUnavailable
}

fn root_matches(value: &Value, ticket: &RootQuotaTicket) -> bool {
    value.is_object()
        && value.get("session_id").and_then(Value::as_str)
            == Some(ticket.provider_session_id.as_str())
        && !crate::agent_context::is_child(value)
        && value.get("task").is_none_or(Value::is_null)
        && value.get("tasks").is_none_or(Value::is_null)
}

fn parse_windows(value: &Value, received_wall_ms: u64) -> (Option<Window>, Option<Window>, Reason) {
    let Some(limits) = value.get("rate_limits") else {
        return (None, None, Reason::WindowsUnavailable);
    };
    let Some(limits) = limits.as_object() else {
        return (None, None, Reason::InvalidWindow);
    };
    let now = i64::try_from(received_wall_ms / 1000).unwrap_or(i64::MAX);
    let parse = |key| -> Option<Option<Window>> {
        let Some(window) = limits.get(key) else {
            return Some(None);
        };
        let window = window.as_object()?;
        let used_percentage = window.get("used_percentage")?.as_f64()?;
        let resets_at = window.get("resets_at")?.as_i64()?;
        (used_percentage.is_finite() && (0.0..=100.0).contains(&used_percentage) && resets_at > now)
            .then_some(Some(Window {
                used_percentage,
                resets_at,
            }))
    };
    let (Some(five_hour), Some(seven_day)) = (parse("five_hour"), parse("seven_day")) else {
        return (None, None, Reason::InvalidWindow);
    };
    let reason = match (five_hour.is_some(), seven_day.is_some()) {
        (true, true) => Reason::Observed,
        (false, false) => Reason::WindowsUnavailable,
        _ => Reason::PartialSnapshot,
    };
    (five_hour, seven_day, reason)
}

#[cfg(test)]
pub(crate) fn read(report: &Path, host_session: &str) -> Result<Option<Observation>> {
    Ok(agent_events::read_root_quota(report, host_session)?
        .map(|(scope, snapshot)| Observation { scope, snapshot }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::StatusState;
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(bound: bool) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "nesvo-claude-quota-{}",
                hex::encode(crate::wire::random::<16>())
            ));
            std::fs::create_dir(&directory).unwrap();
            let fixture = Self(directory.join("context.json"));
            agent_events::initialize(&fixture.0, "host-session").unwrap();
            if bound {
                fixture.bind("conversation-a");
            }
            fixture
        }
        fn bind(&self, provider: &str) {
            agent_events::append(
                &self.0,
                Some(provider),
                "SessionStart",
                StatusState::Idle,
                true,
                None,
            )
            .unwrap();
        }
        fn receive(&self, value: Value) -> ReceiveOutcome {
            receive(&self.0, serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
        }
        fn read(&self) -> Option<Observation> {
            read(&self.0, "host-session").unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }
    fn payload() -> Value {
        let reset = (crate::status::now_millis() / 1000 + 3600) as i64;
        json!({"session_id":"conversation-a", "rate_limits":{
            "five_hour":{"used_percentage":90.25,"resets_at":reset},
            "seven_day":{"used_percentage":0,"resets_at":reset + 86400}
        }})
    }

    #[test]
    fn exact_bound_root_receives_only_allowlisted_quota_metadata() {
        let fixture = Fixture::new(false);
        assert_eq!(fixture.receive(payload()), ReceiveOutcome::RejectedScope);
        assert!(fixture.read().is_none());
        fixture.bind("conversation-a");
        let mut input = payload();
        input["cwd"] = json!("PRIVATE-PATH-NOT-STORED");
        input["prompt_id"] = json!("PRIVATE-PROMPT-NOT-STORED");
        input["arbitrary_error"] = json!("PRIVATE-ERROR-NOT-STORED");
        input["rate_limits"]["spend_limit"] = json!({"private":"PRIVATE-SPEND-NOT-STORED"});
        assert_eq!(fixture.receive(input.clone()), ReceiveOutcome::Recorded);
        let observed = fixture.read().unwrap();
        assert_eq!(observed.scope.generation, 1);
        assert_eq!(observed.scope.sequence, 1);
        assert_eq!(observed.snapshot.reason, Reason::Observed);
        assert_eq!(observed.snapshot.five_hour.unwrap().used_percentage, 90.25);
        assert!(observed.snapshot.received_monotonic_ms >= observed.snapshot.started_monotonic_ms);
        let stored = std::fs::read(fixture.0.with_file_name("events.sqlite3")).unwrap();
        assert!(!String::from_utf8_lossy(&stored).contains("PRIVATE-"));
        input["agent_id"] = json!("child-agent");
        assert_eq!(
            fixture.receive(input.clone()),
            ReceiveOutcome::RejectedScope
        );
        input.as_object_mut().unwrap().remove("agent_id");
        input["task"] = json!({"id":"child-task"});
        assert_eq!(
            fixture.receive(input.clone()),
            ReceiveOutcome::RejectedScope
        );
        input.as_object_mut().unwrap().remove("task");
        input["tasks"] = json!([]);
        assert_eq!(fixture.receive(input), ReceiveOutcome::RejectedScope);
        assert_eq!(fixture.read().unwrap().scope.sequence, 1);
        assert!(read(&fixture.0, "foreign-host-session").is_err());
    }

    #[test]
    fn named_main_agent_is_not_a_subagent_identity() {
        let fixture = Fixture::new(true);
        let mut input = payload();
        input["agent"] = json!({"name":"PRIVATE-AGENT-NOT-STORED"});
        assert_eq!(fixture.receive(input.clone()), ReceiveOutcome::Recorded);
        assert_eq!(fixture.read().unwrap().snapshot.reason, Reason::Observed);
        input["agent_id"] = json!("child-agent");
        assert_eq!(
            fixture.receive(input.clone()),
            ReceiveOutcome::RejectedScope
        );
        input.as_object_mut().unwrap().remove("agent_id");
        input["session_id"] = json!("another-root");
        assert_eq!(fixture.receive(input), ReceiveOutcome::RejectedScope);
        let stored = std::fs::read(fixture.0.with_file_name("events.sqlite3")).unwrap();
        assert!(!String::from_utf8_lossy(&stored).contains("PRIVATE-AGENT-"));
    }

    #[test]
    fn missing_and_malformed_windows_replace_old_data_without_renewing_it() {
        let fixture = Fixture::new(true);
        fixture.receive(payload());
        fixture.receive(json!({"session_id":"conversation-a"}));
        let empty = fixture.read().unwrap();
        assert_eq!(empty.scope.sequence, 2);
        assert_eq!(empty.snapshot.reason, Reason::WindowsUnavailable);
        assert!(empty.snapshot.five_hour.is_none() && empty.snapshot.seven_day.is_none());
        let mut input = payload();
        input["rate_limits"]
            .as_object_mut()
            .unwrap()
            .remove("seven_day");
        fixture.receive(input.clone());
        let partial = fixture.read().unwrap();
        assert_eq!(partial.snapshot.reason, Reason::PartialSnapshot);
        assert!(partial.snapshot.five_hour.is_some() && partial.snapshot.seven_day.is_none());
        input["rate_limits"]["seven_day"] =
            json!({"used_percentage":"PRIVATE-INVALID", "resets_at":123});
        fixture.receive(input);
        let invalid = fixture.read().unwrap();
        assert_eq!(invalid.snapshot.reason, Reason::InvalidWindow);
        assert!(invalid.snapshot.five_hour.is_none() && invalid.snapshot.seven_day.is_none());
        let old = fixture.read().unwrap();
        let repeated = fixture.read().unwrap();
        assert_eq!(
            old, repeated,
            "reads cannot advance receipt time or callback sequence"
        );
    }

    #[test]
    fn rebind_and_out_of_order_callbacks_cannot_replace_current_scope() {
        let fixture = Fixture::new(true);
        fixture.receive(payload());
        let old = agent_events::begin_root_quota(&fixture.0).unwrap().unwrap();
        let snapshot = fixture.read().unwrap().snapshot;
        fixture.bind("conversation-b");
        assert!(fixture.read().is_none());
        assert!(!agent_events::append_root_quota(&fixture.0, &old, &snapshot).unwrap());
        assert_eq!(fixture.receive(payload()), ReceiveOutcome::RejectedScope);
        let mut current = payload();
        current["session_id"] = json!("conversation-b");
        fixture.receive(current);
        let first = agent_events::begin_root_quota(&fixture.0).unwrap().unwrap();
        let second = agent_events::begin_root_quota(&fixture.0).unwrap().unwrap();
        let mut unavailable = snapshot.clone();
        unavailable.five_hour = None;
        unavailable.seven_day = None;
        unavailable.reason = Reason::WindowsUnavailable;
        assert!(agent_events::append_root_quota(&fixture.0, &second, &unavailable).unwrap());
        assert!(!agent_events::append_root_quota(&fixture.0, &first, &snapshot).unwrap());
        let latest = fixture.read().unwrap();
        assert_eq!(latest.scope.generation, 2);
        assert_eq!(latest.scope.sequence, second.sequence);
        assert_eq!(latest.snapshot.reason, Reason::WindowsUnavailable);
    }

    #[test]
    fn receive_cannot_cross_a_root_rebind_while_stdin_is_reading() {
        let fixture = Fixture::new(true);
        fixture.receive(payload());
        struct RebindInput<'a> {
            fixture: &'a Fixture,
            input: std::io::Cursor<Vec<u8>>,
            rebound: bool,
        }
        impl Read for RebindInput<'_> {
            fn read(&mut self, destination: &mut [u8]) -> std::io::Result<usize> {
                if !self.rebound {
                    self.fixture.bind("conversation-b");
                    self.rebound = true;
                }
                self.input.read(destination)
            }
        }
        let input = RebindInput {
            fixture: &fixture,
            input: std::io::Cursor::new(serde_json::to_vec(&payload()).unwrap()),
            rebound: false,
        };
        assert_eq!(
            receive(&fixture.0, input).unwrap(),
            ReceiveOutcome::RejectedScope
        );
        assert!(fixture.read().is_none());
    }

    #[test]
    fn input_and_window_validation_are_bounded_and_conservative() {
        let fixture = Fixture::new(true);
        for used in [json!(-0.1), json!(100.1), json!("90"), Value::Null] {
            let mut input = payload();
            input["rate_limits"]["five_hour"]["used_percentage"] = used;
            fixture.receive(input);
            assert_eq!(
                fixture.read().unwrap().snapshot.reason,
                Reason::InvalidWindow
            );
        }
        for used in [0.0, 100.0] {
            let mut input = payload();
            input["rate_limits"]["five_hour"]["used_percentage"] = json!(used);
            fixture.receive(input);
            assert_eq!(fixture.read().unwrap().snapshot.reason, Reason::Observed);
        }
        let mut expired = payload();
        expired["rate_limits"]["seven_day"]["resets_at"] = json!(0);
        fixture.receive(expired);
        assert_eq!(
            fixture.read().unwrap().snapshot.reason,
            Reason::InvalidWindow
        );
        receive(&fixture.0, &b"PRIVATE-INVALID-JSON"[..]).unwrap();
        assert_eq!(
            fixture.read().unwrap().snapshot.reason,
            Reason::InvalidInput
        );
        receive(&fixture.0, std::io::repeat(b'x')).unwrap();
        assert_eq!(
            fixture.read().unwrap().snapshot.reason,
            Reason::InputOversized
        );
        struct Failed;
        impl Read for Failed {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("PRIVATE-READ-ERROR"))
            }
        }
        receive(&fixture.0, Failed).unwrap();
        assert_eq!(
            fixture.read().unwrap().snapshot.reason,
            Reason::InputReadFailed
        );
        let connection =
            rusqlite::Connection::open(fixture.0.with_file_name("events.sqlite3")).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM root_quota", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let stored = std::fs::read(fixture.0.with_file_name("events.sqlite3")).unwrap();
        assert!(!String::from_utf8_lossy(&stored).contains("PRIVATE-"));
    }
}
