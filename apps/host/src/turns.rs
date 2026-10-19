//! A response turn is separate from task outcome, process lifetime and unread state.
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
}
