use crate::status::{SessionStatus, StatusSource, StatusState};
use serde::Serialize;
use serde_json::{Value, json};

pub const JOURNAL_READ_INTERVAL_MS: u64 = 500;
pub const LIFECYCLE_DRAIN_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Hook,
    Process,
    Journal,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bound {
    pub source: Source,
    pub stale_after_ms: Option<u64>,
    pub measured_from: &'static str,
}

pub const BOUNDS: [Bound; 4] = [
    Bound {
        source: Source::Hook,
        stale_after_ms: Some(2 * LIFECYCLE_DRAIN_MS),
        measured_from: "lastJournalRead",
    },
    Bound {
        source: Source::Process,
        stale_after_ms: None,
        measured_from: "exitObserved",
    },
    Bound {
        source: Source::Journal,
        stale_after_ms: Some(2 * LIFECYCLE_DRAIN_MS),
        measured_from: "lastRecord",
    },
    Bound {
        source: Source::Unknown,
        stale_after_ms: None,
        measured_from: "none",
    },
];

pub fn bound(source: Source) -> Option<u64> {
    BOUNDS
        .iter()
        .find(|bound| bound.source == source)
        .and_then(|bound| bound.stale_after_ms)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastKnown {
    pub state: StatusState,
    pub observed_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    #[serde(skip)]
    pub state: StatusState,
    pub source: Source,
    pub observed_at: u64,
    pub age_ms: u64,
    pub stale: bool,
    pub bound_ms: Option<u64>,
    pub last_known: Option<LastKnown>,
}

#[derive(Default)]
pub struct Tracker {
    hook_at: Option<u64>,
    journal_read_at: Option<u64>,
    exit_at: Option<u64>,
    published: Option<(Source, bool)>,
}

impl Tracker {
    pub fn hook(&mut self, now: u64) {
        self.hook_at = Some(now);
        self.journal_read_at = Some(now);
    }
    pub fn journal_read(&mut self, now: u64) {
        self.journal_read_at = Some(now);
    }
    pub fn exited(&mut self, now: u64) {
        self.exit_at.get_or_insert(now);
    }

    pub fn project(&self, status: SessionStatus, now: u64) -> Projection {
        let fresh = |source: Source, observed_at: u64| Projection {
            state: status.state,
            source,
            observed_at,
            age_ms: now.saturating_sub(observed_at),
            stale: false,
            bound_ms: bound(source),
            last_known: None,
        };
        match status.source {
            StatusSource::Process => {
                fresh(Source::Process, self.exit_at.unwrap_or(status.updated_at))
            }
            StatusSource::Hook => {
                let observed_at = self.hook_at.unwrap_or(status.updated_at);
                let read_at = self.journal_read_at.unwrap_or(observed_at);
                if bound(Source::Hook).is_some_and(|ms| now.saturating_sub(read_at) <= ms) {
                    return fresh(Source::Hook, observed_at);
                }
                Projection {
                    state: StatusState::Unknown,
                    stale: bound(Source::Journal)
                        .is_some_and(|ms| now.saturating_sub(observed_at) > ms),
                    last_known: Some(LastKnown {
                        state: status.state,
                        observed_at,
                    }),
                    ..fresh(Source::Journal, observed_at)
                }
            }
            StatusSource::Activity | StatusSource::Screen | StatusSource::Program => {
                fresh(Source::Unknown, status.updated_at)
            }
        }
    }

    pub fn refresh(&mut self, status: SessionStatus, now: u64) -> bool {
        let projection = self.project(status, now);
        let key = (projection.source, projection.stale);
        let changed = self.published.is_some_and(|published| published != key);
        self.published = Some(key);
        changed
    }
}

pub fn capability() -> Value {
    json!(BOUNDS)
}

pub fn attach(info: &mut Value, projection: Projection) {
    info["status"]["freshness"] = json!(projection);
}

pub fn publish(event: &mut Value, negotiated: bool) {
    if event["type"] == "session" {
        if let Some(session) = event.get_mut("session") {
            rewrite(session, negotiated);
        }
        return;
    }
    if event["type"] != "sessions" {
        return;
    }
    let Some(sessions) = event["sessions"].as_array_mut() else {
        return;
    };
    for session in sessions {
        rewrite(session, negotiated);
    }
}

fn rewrite(session: &mut Value, negotiated: bool) {
    let Some(status) = session.get_mut("status").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(freshness) = status.remove("freshness") else {
        return;
    };
    if !negotiated {
        return;
    }
    let disconnected = !freshness["lastKnown"].is_null();
    status.insert("freshness".into(), freshness);
    if disconnected {
        status.insert("state".into(), json!(StatusState::Unknown));
        if let Some(agent) = session
            .get_mut("lifecycle")
            .and_then(|lifecycle| lifecycle.get_mut("agent"))
        {
            agent["current"] = Value::Null;
            agent["freshness"] = json!("unknown");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launchers::Program;
    use crate::status::StatusTracker;

    const START: u64 = 1_000_000;

    fn deliver(
        tracker: &mut StatusTracker,
        freshness: &mut Tracker,
        state: StatusState,
        sequence: u64,
        now: u64,
    ) {
        assert!(tracker.lifecycle_ordered(
            crate::agent_context::LifecycleReport { state, sequence },
            now,
        ));
        freshness.hook(now);
        tracker.refresh(now);
    }

    fn provider_states(program: Program) -> Vec<StatusState> {
        let payloads: Vec<Value> = match program {
            Program::Claude => vec![
                json!({"hook_event_name":"UserPromptSubmit","session_id":"claude-root"}),
                json!({"hook_event_name":"PermissionRequest","session_id":"claude-root"}),
                json!({"hook_event_name":"Stop","session_id":"claude-root"}),
            ],
            Program::Codex => vec![
                json!({"hook_event_name":"UserPromptSubmit","session_id":"codex-root","turn_id":"turn-1"}),
                json!({"hook_event_name":"PermissionRequest","session_id":"codex-root","turn_id":"turn-1"}),
                json!({"hook_event_name":"Stop","session_id":"codex-root","turn_id":"turn-1"}),
            ],
            Program::Gemini => vec![
                json!({"hook_event_name":"BeforeAgent","session_id":"gemini-root"}),
                json!({"hook_event_name":"Notification","notification_type":"ToolPermission","session_id":"gemini-root"}),
                json!({"hook_event_name":"AfterAgent","session_id":"gemini-root"}),
            ],
            Program::Shell => Vec::new(),
        };
        payloads
            .iter()
            .map(|payload| {
                match program {
                    Program::Claude => crate::agent_context::lifecycle_state(payload),
                    Program::Codex => crate::codex_context::state(payload).unwrap(),
                    _ => crate::gemini_adapter::state(payload).unwrap(),
                }
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn freshness_bounds_live_in_one_table_with_one_entry_per_source() {
        let sources: Vec<_> = BOUNDS.iter().map(|bound| bound.source).collect();
        assert_eq!(
            sources,
            [
                Source::Hook,
                Source::Process,
                Source::Journal,
                Source::Unknown
            ]
        );
        assert_eq!(bound(Source::Hook), Some(4_000));
        assert_eq!(bound(Source::Journal), Some(4_000));
        assert_eq!(bound(Source::Process), None);
        assert_eq!(bound(Source::Unknown), None);
        assert!(bound(Source::Hook).unwrap() >= 2 * JOURNAL_READ_INTERVAL_MS);
        assert_eq!(
            capability()[0],
            json!({"source":"hook","staleAfterMs":4000,"measuredFrom":"lastJournalRead"})
        );
    }

    #[test]
    fn freshness_hook_states_stay_current_while_the_journal_is_read_for_every_provider() {
        for program in [Program::Claude, Program::Codex, Program::Gemini] {
            let states = provider_states(program);
            assert_eq!(
                states,
                [
                    StatusState::Working,
                    StatusState::Blocked,
                    StatusState::Idle
                ],
                "{program:?}"
            );
            let mut status = StatusTracker::new(program, 24, 80, START);
            let mut freshness = Tracker::default();
            for (index, state) in states.into_iter().enumerate() {
                let at = START + index as u64 * 100;
                deliver(&mut status, &mut freshness, state, index as u64 + 1, at);
                let projection = freshness.project(status.status(), at);
                assert_eq!(
                    (projection.source, projection.state, projection.stale),
                    (Source::Hook, state, false)
                );
                assert_eq!(projection.observed_at, at);
            }
            let last = START + 200;
            for offset in (500..=600_000).step_by(500) {
                freshness.journal_read(last + offset);
            }
            let silent = freshness.project(status.status(), last + 600_250);
            assert_eq!(
                (silent.source, silent.state, silent.stale, silent.last_known),
                (Source::Hook, StatusState::Idle, false, None),
                "{program:?}: provider silence with a readable journal is not staleness"
            );
            assert_eq!(silent.age_ms, 600_250);
        }
    }

    #[test]
    fn freshness_disconnect_keeps_last_known_and_never_infers_progress() {
        for program in [Program::Claude, Program::Codex, Program::Gemini] {
            let working = provider_states(program)[0];
            let mut status = StatusTracker::new(program, 24, 80, START);
            let mut freshness = Tracker::default();
            deliver(&mut status, &mut freshness, working, 1, START);
            assert!(!freshness.refresh(status.status(), START));
            let within = START + bound(Source::Hook).unwrap();
            assert_eq!(
                freshness.project(status.status(), within).source,
                Source::Hook
            );
            assert!(!freshness.refresh(status.status(), within));
            let lost = within + 1;
            let projection = freshness.project(status.status(), lost);
            assert_eq!(projection.source, Source::Journal);
            assert_eq!(projection.state, StatusState::Unknown);
            assert!(projection.stale);
            assert_eq!(
                projection.last_known,
                Some(LastKnown {
                    state: StatusState::Working,
                    observed_at: START
                })
            );
            assert!(freshness.refresh(status.status(), lost));
            assert!(!freshness.refresh(status.status(), lost + 60_000));
            status.refresh(lost + 60_000);
            assert_eq!(
                status.status().state,
                StatusState::Working,
                "{program:?}: the legacy state is unchanged; only the projection withdraws it"
            );
            freshness.journal_read(lost + 60_500);
            let resumed = freshness.project(status.status(), lost + 60_500);
            assert_eq!(
                (
                    resumed.source,
                    resumed.state,
                    resumed.stale,
                    resumed.last_known
                ),
                (Source::Hook, StatusState::Working, false, None)
            );
            assert!(freshness.refresh(status.status(), lost + 60_500));
        }
    }

    #[test]
    fn freshness_process_exit_is_final_and_terminal_inference_has_no_bound() {
        let mut status = StatusTracker::new(Program::Codex, 24, 80, START);
        let mut freshness = Tracker::default();
        deliver(&mut status, &mut freshness, StatusState::Working, 1, START);
        status.exited(Some(0));
        freshness.exited(START + 10);
        freshness.exited(START + 99);
        status.refresh(START + 20);
        let exited = freshness.project(status.status(), START + 86_400_000);
        assert_eq!(
            (exited.source, exited.state, exited.stale, exited.bound_ms),
            (Source::Process, StatusState::Done, false, None)
        );
        assert_eq!(exited.observed_at, START + 10);

        let mut shell = StatusTracker::new(Program::Shell, 24, 80, START);
        shell.refresh(START + 5_000);
        let projection = Tracker::default().project(shell.status(), START + 900_000);
        assert_eq!(
            (projection.source, projection.stale, projection.bound_ms),
            (Source::Unknown, false, None)
        );
        assert_eq!(projection.observed_at, START + 5_000);
    }

    #[test]
    fn freshness_fields_reach_only_negotiated_clients() {
        let mut freshness = Tracker::default();
        let mut status = StatusTracker::new(Program::Gemini, 24, 80, START);
        deliver(&mut status, &mut freshness, StatusState::Blocked, 1, START);
        let lost = START + 10_000;
        let snapshot = || {
            let mut info = json!({"id":"s","status":status.status(),"lifecycle":{"agent":status.agent_projection()}});
            attach(&mut info, freshness.project(status.status(), lost));
            json!({"type":"sessions","sessions":[info],"groups":[],"revision":0})
        };
        let mut legacy = snapshot();
        publish(&mut legacy, false);
        assert!(legacy["sessions"][0]["status"].get("freshness").is_none());
        assert_eq!(legacy["sessions"][0]["status"]["state"], "blocked");
        assert_eq!(
            legacy["sessions"][0]["lifecycle"]["agent"]["freshness"],
            "observed"
        );

        let mut current = snapshot();
        publish(&mut current, true);
        let session = &current["sessions"][0];
        assert_eq!(session["status"]["state"], "unknown");
        assert_eq!(
            session["status"]["freshness"],
            json!({"source":"journal","observedAt":START,"ageMs":10_000,"stale":true,"boundMs":4000,
                "lastKnown":{"state":"blocked","observedAt":START}})
        );
        assert!(session["lifecycle"]["agent"]["current"].is_null());
        assert_eq!(session["lifecycle"]["agent"]["freshness"], "unknown");
        assert_eq!(
            session["lifecycle"]["agent"]["lastKnown"]["state"],
            "blocked"
        );

        let single = || {
            let snapshot = snapshot();
            json!({"type":"session","session":snapshot["sessions"][0].clone()})
        };
        let mut legacy = single();
        publish(&mut legacy, false);
        assert!(legacy["session"]["status"].get("freshness").is_none());
        assert_eq!(legacy["session"]["status"]["state"], "blocked");
        assert_eq!(
            legacy["session"]["lifecycle"]["agent"]["freshness"],
            "observed"
        );
        let mut current = single();
        publish(&mut current, true);
        assert_eq!(current["session"], session.clone());

        let mut other = json!({"type":"capabilities","status":{"freshness":1}});
        publish(&mut other, false);
        assert_eq!(other["status"]["freshness"], 1);
    }
}
