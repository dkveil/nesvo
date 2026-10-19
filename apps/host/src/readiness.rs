//! Startup readiness is separate from process lifetime and task success.
use crate::{
    launchers::Program,
    status::{SessionStatus, StatusSource, StatusState},
};
use serde::Serialize;
use std::time::Duration;

const START_TIMEOUT: Duration = Duration::from_secs(45);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    NotApplicable,
    Starting,
    Waiting,
    Ready,
    TimedOut,
    Exited,
}
#[derive(Clone, Copy, Serialize)]
pub struct Snapshot {
    pub phase: Phase,
    pub initialized: bool,
    pub reason: &'static str,
}
pub struct Tracker {
    snapshot: Snapshot,
    phase_at: Duration,
}
impl Tracker {
    pub fn new(program: Program) -> Self {
        Self {
            snapshot: Snapshot {
                phase: if program == Program::Shell {
                    Phase::NotApplicable
                } else {
                    Phase::Starting
                },
                initialized: false,
                reason: "awaiting provider readiness",
            },
            phase_at: Duration::ZERO,
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
    }
    pub fn observe(
        &mut self,
        status: SessionStatus,
        rule_reason: Option<&'static str>,
        elapsed: Duration,
    ) -> bool {
        if matches!(self.snapshot.phase, Phase::NotApplicable | Phase::Exited) {
            return false;
        }
        let (phase, reason) = if status.source == StatusSource::Process {
            (Phase::Exited, "process exited")
        } else if matches!(status.state, StatusState::Blocked | StatusState::Question) {
            (
                Phase::Waiting,
                rule_reason.unwrap_or("provider needs input"),
            )
        } else if status.source != StatusSource::Activity
            && matches!(status.state, StatusState::Idle | StatusState::Working)
        {
            self.snapshot.initialized = true;
            (Phase::Ready, "provider readiness observed")
        } else if self.snapshot.initialized {
            (
                Phase::Ready,
                "provider initialized; inspect current agent state separately",
            )
        } else {
            // Consent can wait indefinitely; clearing it starts a fresh readiness window.
            if self.snapshot.phase == Phase::Waiting {
                self.phase_at = elapsed;
            }
            if elapsed.saturating_sub(self.phase_at) >= START_TIMEOUT {
                (
                    Phase::TimedOut,
                    "no semantic readiness signal within 45 seconds",
                )
            } else {
                (Phase::Starting, "awaiting provider readiness")
            }
        };
        let changed = (self.snapshot.phase, self.snapshot.reason) != (phase, reason);
        if changed {
            if phase == Phase::Waiting {
                self.phase_at = elapsed;
            }
            self.snapshot.phase = phase;
            self.snapshot.reason = reason;
        }
        changed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn status(state: StatusState, source: StatusSource) -> SessionStatus {
        SessionStatus {
            state,
            source,
            updated_at: 0,
        }
    }
    #[test]
    fn output_is_not_readiness_consent_pauses_timeout_and_exit_is_final() {
        let mut r = Tracker::new(Program::Claude);
        r.observe(
            status(StatusState::Working, StatusSource::Activity),
            None,
            Duration::from_secs(10),
        );
        assert_eq!(r.snapshot.phase, Phase::Starting);
        r.observe(
            status(StatusState::Blocked, StatusSource::Screen),
            Some("folder trust"),
            Duration::from_secs(12),
        );
        r.observe(
            status(StatusState::Blocked, StatusSource::Screen),
            Some("folder trust"),
            Duration::from_secs(600),
        );
        assert_eq!(r.snapshot.phase, Phase::Waiting);
        r.observe(
            status(StatusState::Unknown, StatusSource::Activity),
            None,
            Duration::from_secs(601),
        );
        assert_eq!(r.snapshot.phase, Phase::Starting);
        r.observe(
            status(StatusState::Unknown, StatusSource::Activity),
            None,
            Duration::from_secs(647),
        );
        assert_eq!(r.snapshot.phase, Phase::TimedOut);
        r.observe(
            status(StatusState::Idle, StatusSource::Hook),
            None,
            Duration::from_secs(648),
        );
        assert_eq!(r.snapshot.phase, Phase::Ready);
        assert!(r.snapshot.initialized);
        r.observe(
            status(StatusState::Done, StatusSource::Process),
            None,
            Duration::from_secs(649),
        );
        assert_eq!(r.snapshot.phase, Phase::Exited);
        r.observe(
            status(StatusState::Idle, StatusSource::Hook),
            None,
            Duration::from_secs(650),
        );
        assert_eq!(
            r.snapshot.phase,
            Phase::Exited,
            "late reports cannot revive an exited process"
        );
    }
}
