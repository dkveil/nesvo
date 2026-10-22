use crate::status::StatusState;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Accepted,
    Started,
    Waiting,
    Settled,
    Interrupted,
    Failed,
}
pub struct Signal<'a> {
    pub launch: &'a str,
    pub generation: u64,
    pub sequence: u64,
    pub event: &'a str,
    pub state: StatusState,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<'a> {
    pub id: &'a str,
    pub generation: u64,
    pub phase: Phase,
    pub elapsed_seconds: u64,
    pub observed_at: u64,
    pub outcome: Option<&'static str>,
}
struct Turn {
    id: String,
    generation: u64,
    phase: Phase,
    started: Duration,
    elapsed: Duration,
    observed_at: u64,
    outcome: Option<&'static str>,
}
#[derive(Default)]
pub struct Tracker {
    current: Option<Turn>,
    history: VecDeque<Turn>,
    interrupt_requested: bool,
    latest_sequence: u64,
}
impl Tracker {
    pub fn history(&self) -> Vec<Snapshot<'_>> {
        self.history
            .iter()
            .map(|turn| Snapshot {
                id: &turn.id,
                generation: turn.generation,
                phase: turn.phase,
                elapsed_seconds: turn.elapsed.as_secs(),
                observed_at: turn.observed_at,
                outcome: turn.outcome,
            })
            .collect()
    }
    pub fn snapshot(&self, elapsed: Duration) -> Option<Snapshot<'_>> {
        self.current.as_ref().map(|turn| Snapshot {
            id: &turn.id,
            generation: turn.generation,
            phase: turn.phase,
            elapsed_seconds: if active(turn.phase) {
                elapsed.saturating_sub(turn.started)
            } else {
                turn.elapsed
            }
            .as_secs(),
            observed_at: turn.observed_at,
            outcome: turn.outcome,
        })
    }
    pub fn event(&mut self, signal: Signal<'_>, elapsed: Duration, at: u64) -> bool {
        let Signal {
            launch,
            generation,
            sequence,
            event,
            state,
        } = signal;
        if self
            .current
            .as_ref()
            .is_some_and(|turn| turn.generation > generation)
        {
            return false;
        }
        if sequence <= self.latest_sequence {
            return false;
        }
        self.latest_sequence = sequence;
        if event == "UserPromptSubmit" {
            if let Some(mut old) = self.current.take() {
                if active(old.phase) {
                    old.phase = Phase::Interrupted;
                    old.elapsed = elapsed.saturating_sub(old.started);
                    old.outcome = Some("superseded by a new prompt");
                }
                if self.history.len() >= 16 {
                    self.history.pop_front();
                }
                self.history.push_back(old);
            }
            self.current = Some(Turn {
                id: format!("{launch}:{sequence}"),
                generation,
                phase: Phase::Accepted,
                started: elapsed,
                elapsed: Duration::ZERO,
                observed_at: at,
                outcome: None,
            });
            self.interrupt_requested = false;
            return true;
        }
        let Some(turn) = self.current.as_mut() else {
            return false;
        };
        if generation != turn.generation {
            if generation > turn.generation && active(turn.phase) {
                turn.phase = Phase::Interrupted;
                turn.elapsed = elapsed.saturating_sub(turn.started);
                turn.outcome = Some("conversation changed");
                return true;
            }
            return false;
        }
        let final_report = turn.phase == Phase::Interrupted
            && turn.outcome == Some("process exited without a response result")
            && !self.interrupt_requested
            && matches!(event, "Stop" | "StopFailure");
        if !active(turn.phase) && !final_report {
            return false;
        }
        let (phase, outcome) = match event {
            "Interrupt" => (Phase::Interrupted, Some("provider confirmed interruption")),
            "Stop" => (
                if self.interrupt_requested {
                    Phase::Interrupted
                } else {
                    Phase::Settled
                },
                Some("response ended; task result not established"),
            ),
            "StopFailure" if state == StatusState::Blocked => (Phase::Waiting, Some("quota")),
            "StopFailure" => (Phase::Failed, Some("provider response failed")),
            "PreToolUse" if state == StatusState::Question => (Phase::Waiting, Some("question")),
            "PermissionRequest" => (Phase::Waiting, Some("permission")),
            "Notification" if matches!(state, StatusState::Blocked | StatusState::Question) => {
                (Phase::Waiting, Some("provider needs input"))
            }
            "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => (Phase::Started, None),
            _ => return false,
        };
        let changed = (turn.phase, turn.outcome) != (phase, outcome);
        turn.phase = phase;
        turn.outcome = outcome;
        turn.observed_at = at;
        if !active(phase) && !final_report {
            turn.elapsed = elapsed.saturating_sub(turn.started);
        }
        changed
    }
    pub fn interrupt(&mut self) {
        self.interrupt_requested = true;
    }
    pub fn gap(&mut self, elapsed: Duration) {
        if let Some(turn) = &mut self.current
            && active(turn.phase)
        {
            turn.phase = Phase::Interrupted;
            turn.elapsed = elapsed.saturating_sub(turn.started);
            turn.outcome = Some("lifecycle history gap; reconciliation required");
        }
    }
    pub fn observe_idle(&mut self, state: StatusState, elapsed: Duration) -> bool {
        if !self.interrupt_requested || state != StatusState::Idle {
            return false;
        }
        if let Some(turn) = &mut self.current
            && active(turn.phase)
        {
            turn.phase = Phase::Interrupted;
            turn.elapsed = elapsed.saturating_sub(turn.started);
            turn.outcome = Some("interrupted response");
            return true;
        }
        false
    }
    pub fn process_exit(&mut self, elapsed: Duration) {
        if let Some(turn) = &mut self.current
            && active(turn.phase)
        {
            turn.phase = Phase::Interrupted;
            turn.elapsed = elapsed.saturating_sub(turn.started);
            turn.outcome = Some("process exited without a response result");
        }
    }
}
fn active(phase: Phase) -> bool {
    matches!(phase, Phase::Accepted | Phase::Started | Phase::Waiting)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_interrupt_is_observed_without_becoming_response_or_task_success() {
        let mut tracker = Tracker::default();
        tracker.event(
            Signal {
                launch: "native",
                generation: 1,
                sequence: 1,
                event: "UserPromptSubmit",
                state: StatusState::Working,
            },
            Duration::from_secs(1),
            1000,
        );
        tracker.event(
            Signal {
                launch: "native",
                generation: 1,
                sequence: 2,
                event: "Interrupt",
                state: StatusState::Idle,
            },
            Duration::from_secs(3),
            3000,
        );
        let snapshot = serde_json::to_value(tracker.snapshot(Duration::from_secs(6))).unwrap();
        assert_eq!(snapshot["phase"], "interrupted");
        tracker.event(
            Signal {
                launch: "native",
                generation: 1,
                sequence: 3,
                event: "Stop",
                state: StatusState::Idle,
            },
            Duration::from_secs(8),
            8000,
        );
        assert_eq!(
            serde_json::to_value(tracker.snapshot(Duration::from_secs(9))).unwrap()["phase"],
            "interrupted"
        );
    }
    fn emit(t: &mut Tracker, sequence: u64, event: &str, state: StatusState, seconds: u64) -> bool {
        t.event(
            Signal {
                launch: "launch",
                generation: 1,
                sequence,
                event,
                state,
            },
            Duration::from_secs(seconds),
            seconds * 100,
        )
    }
    #[test]
    fn old_idle_is_not_a_turn_and_response_stop_is_not_task_success() {
        let mut t = Tracker::default();
        assert!(!emit(&mut t, 1, "Stop", StatusState::Idle, 0));
        emit(&mut t, 2, "UserPromptSubmit", StatusState::Working, 10);
        emit(&mut t, 3, "PreToolUse", StatusState::Question, 12);
        assert_eq!(
            t.snapshot(Duration::from_secs(14)).unwrap().phase,
            Phase::Waiting
        );
        emit(&mut t, 4, "PostToolUse", StatusState::Working, 15);
        emit(&mut t, 5, "Stop", StatusState::Idle, 20);
        let snapshot = t.snapshot(Duration::from_secs(300)).unwrap();
        assert_eq!(snapshot.elapsed_seconds, 10);
        assert_eq!(snapshot.phase, Phase::Settled);
        assert!(
            snapshot
                .outcome
                .unwrap()
                .contains("task result not established")
        );
        emit(&mut t, 6, "UserPromptSubmit", StatusState::Working, 30);
        assert!(!emit(&mut t, 5, "Stop", StatusState::Idle, 31));
        assert_eq!(
            t.snapshot(Duration::from_secs(32)).unwrap().phase,
            Phase::Accepted
        );
        t.interrupt();
        t.observe_idle(StatusState::Idle, Duration::from_secs(33));
        assert_eq!(
            t.snapshot(Duration::from_secs(60)).unwrap().phase,
            Phase::Interrupted
        );
    }
    #[test]
    fn gaps_and_final_process_drain_never_invent_task_success() {
        let mut t = Tracker::default();
        emit(&mut t, 1, "UserPromptSubmit", StatusState::Working, 0);
        t.gap(Duration::from_secs(2));
        emit(&mut t, 10, "Stop", StatusState::Idle, 3);
        assert_eq!(
            t.snapshot(Duration::from_secs(4)).unwrap().phase,
            Phase::Interrupted
        );
        emit(&mut t, 11, "UserPromptSubmit", StatusState::Working, 5);
        t.process_exit(Duration::from_secs(6));
        emit(&mut t, 12, "Stop", StatusState::Idle, 7);
        assert_eq!(
            t.snapshot(Duration::from_secs(8)).unwrap().phase,
            Phase::Settled
        );
        assert_eq!(t.history().len(), 1);
        assert_eq!(
            t.snapshot(Duration::from_secs(90)).unwrap().elapsed_seconds,
            1,
            "late final evidence cannot add time after process exit"
        );
        assert!(
            t.snapshot(Duration::from_secs(9))
                .unwrap()
                .outcome
                .unwrap()
                .contains("not established")
        );
    }
    fn synthesized_codex_hook(event: &str, tool_name: Option<&str>) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "hook_event_name": event,
            "session_id": "synthesized-codex-session",
            "turn_id": "synthesized-codex-turn",
        });
        if let Some(tool_name) = tool_name {
            payload["tool_name"] = tool_name.into();
        }
        payload
    }
    fn synthesized_gemini_hook(event: &str, notification_type: Option<&str>) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "hook_event_name": event,
            "session_id": "synthesized-gemini-session",
        });
        if let Some(notification_type) = notification_type {
            payload["notification_type"] = notification_type.into();
        }
        payload
    }
    fn codex_state(payload: &serde_json::Value) -> StatusState {
        crate::codex_context::state(payload).unwrap().unwrap()
    }
    fn deliver_through_settled_gate(
        tracker: &mut Tracker,
        attention: &mut crate::attention::Attention,
        launch: &str,
        sequence: u64,
        event: &str,
        state: StatusState,
    ) -> bool {
        let elapsed = Duration::from_secs(sequence);
        tracker.event(
            Signal {
                launch,
                generation: 1,
                sequence,
                event,
                state,
            },
            elapsed,
            sequence * 100,
        );
        event == "Stop"
            && tracker.snapshot(elapsed).is_some_and(|turn| {
                turn.phase == Phase::Settled
                    && attention.response_settled(sequence, turn.id, turn.observed_at)
            })
    }
    #[test]
    fn codex_hook_payloads_drive_the_same_turn_outcomes_as_claude() {
        let mut tracker = Tracker::default();
        let mut outcome = |sequence: u64, payload: serde_json::Value| {
            let elapsed = Duration::from_secs(sequence);
            tracker.event(
                Signal {
                    launch: "codex",
                    generation: 1,
                    sequence,
                    event: payload["hook_event_name"].as_str().unwrap(),
                    state: codex_state(&payload),
                },
                elapsed,
                sequence * 100,
            );
            let turn = tracker.snapshot(elapsed).unwrap();
            (turn.phase, turn.outcome)
        };
        assert_eq!(
            outcome(1, synthesized_codex_hook("UserPromptSubmit", None)),
            (Phase::Accepted, None)
        );
        assert_eq!(
            outcome(
                2,
                synthesized_codex_hook("PreToolUse", Some("request_user_input"))
            ),
            (Phase::Waiting, Some("question"))
        );
        assert_eq!(
            outcome(3, synthesized_codex_hook("PermissionRequest", None)),
            (Phase::Waiting, Some("permission"))
        );
        assert_eq!(
            outcome(4, synthesized_codex_hook("PostToolUse", None)),
            (Phase::Started, None)
        );
        assert_eq!(
            outcome(5, synthesized_codex_hook("Stop", None)),
            (
                Phase::Settled,
                Some("response ended; task result not established")
            )
        );
        assert_eq!(
            outcome(6, synthesized_codex_hook("UserPromptSubmit", None)),
            (Phase::Accepted, None)
        );
        assert_eq!(
            outcome(7, synthesized_codex_hook("Interrupt", None)),
            (Phase::Interrupted, Some("provider confirmed interruption"))
        );
        let history = tracker.history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "codex:1");
        assert_eq!(history[0].phase, Phase::Settled);
    }
    #[test]
    fn gemini_hook_events_never_open_a_turn_or_an_unread_response() {
        let mut tracker = Tracker::default();
        let mut attention = crate::attention::Attention::default();
        let events = [
            (
                synthesized_gemini_hook("BeforeAgent", None),
                StatusState::Working,
            ),
            (
                synthesized_gemini_hook("BeforeTool", None),
                StatusState::Working,
            ),
            (
                synthesized_gemini_hook("AfterTool", None),
                StatusState::Working,
            ),
            (
                synthesized_gemini_hook("Notification", Some("ToolPermission")),
                StatusState::Blocked,
            ),
            (
                synthesized_gemini_hook("AfterAgent", None),
                StatusState::Idle,
            ),
        ];
        for (sequence, (payload, expected)) in (1..).zip(events) {
            let state = crate::gemini_adapter::state(&payload).unwrap().unwrap();
            assert_eq!(state, expected);
            assert!(!deliver_through_settled_gate(
                &mut tracker,
                &mut attention,
                "gemini",
                sequence,
                payload["hook_event_name"].as_str().unwrap(),
                state,
            ));
            assert!(tracker.snapshot(Duration::from_secs(sequence)).is_none());
        }
        assert!(tracker.history().is_empty());
        assert!(attention.event.is_none());
    }
    #[test]
    fn only_a_settled_stop_creates_one_unread_response_for_every_provider() {
        let codex =
            |event: &'static str| (event, codex_state(&synthesized_codex_hook(event, None)));
        let providers = [
            (
                "claude",
                [
                    ("UserPromptSubmit", StatusState::Working),
                    ("PostToolUse", StatusState::Working),
                    ("Stop", StatusState::Idle),
                    ("Stop", StatusState::Idle),
                ],
            ),
            (
                "codex",
                [
                    codex("UserPromptSubmit"),
                    codex("PostToolUse"),
                    codex("Stop"),
                    codex("Stop"),
                ],
            ),
        ];
        for (launch, events) in providers {
            let mut tracker = Tracker::default();
            let mut attention = crate::attention::Attention::default();
            let responses = (1..)
                .zip(events)
                .filter(|(sequence, (event, state))| {
                    deliver_through_settled_gate(
                        &mut tracker,
                        &mut attention,
                        launch,
                        *sequence,
                        event,
                        *state,
                    )
                })
                .count();
            assert_eq!(responses, 1, "{launch}");
            let response = attention.event.as_ref().unwrap();
            assert!(response.unread);
            assert_eq!(response.subject, Some("response"));
            assert_eq!(
                response.turn_id.as_deref(),
                Some(format!("{launch}:1").as_str())
            );
        }
        for ending in [
            ("Interrupt", StatusState::Idle),
            ("StopFailure", StatusState::Failed),
        ] {
            let mut tracker = Tracker::default();
            let mut attention = crate::attention::Attention::default();
            for (sequence, (event, state)) in (1..).zip([
                ("UserPromptSubmit", StatusState::Working),
                ending,
                ("Stop", StatusState::Idle),
            ]) {
                assert!(!deliver_through_settled_gate(
                    &mut tracker,
                    &mut attention,
                    "claude",
                    sequence,
                    event,
                    state,
                ));
            }
            assert!(attention.event.is_none(), "{ending:?}");
        }
        let mut tracker = Tracker::default();
        let mut attention = crate::attention::Attention::default();
        for (sequence, (event, state)) in (1..).zip([
            ("UserPromptSubmit", StatusState::Working),
            ("StopFailure", StatusState::Blocked),
        ]) {
            assert!(!deliver_through_settled_gate(
                &mut tracker,
                &mut attention,
                "claude",
                sequence,
                event,
                state,
            ));
        }
        let waiting = tracker.snapshot(Duration::from_secs(2)).unwrap();
        assert_eq!(
            (waiting.phase, waiting.outcome),
            (Phase::Waiting, Some("quota"))
        );
        assert!(attention.event.is_none());
        assert!(deliver_through_settled_gate(
            &mut tracker,
            &mut attention,
            "claude",
            3,
            "Stop",
            StatusState::Idle,
        ));
        let mut tracker = Tracker::default();
        let mut attention = crate::attention::Attention::default();
        deliver_through_settled_gate(
            &mut tracker,
            &mut attention,
            "claude",
            1,
            "UserPromptSubmit",
            StatusState::Working,
        );
        tracker.gap(Duration::from_secs(2));
        assert!(!deliver_through_settled_gate(
            &mut tracker,
            &mut attention,
            "claude",
            3,
            "Stop",
            StatusState::Idle,
        ));
        assert!(attention.event.is_none());
        let mut tracker = Tracker::default();
        let mut attention = crate::attention::Attention::default();
        deliver_through_settled_gate(
            &mut tracker,
            &mut attention,
            "claude",
            1,
            "UserPromptSubmit",
            StatusState::Working,
        );
        tracker.process_exit(Duration::from_secs(2));
        assert_eq!(
            tracker.snapshot(Duration::from_secs(2)).unwrap().phase,
            Phase::Interrupted
        );
        assert!(attention.event.is_none());
        assert!(deliver_through_settled_gate(
            &mut tracker,
            &mut attention,
            "claude",
            3,
            "Stop",
            StatusState::Idle,
        ));
        assert_eq!(
            attention.event.as_ref().unwrap().turn_id.as_deref(),
            Some("claude:1")
        );
    }
}
