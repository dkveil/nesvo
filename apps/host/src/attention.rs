//! Stable attention episodes, independent of output volume and viewer redraws.
use crate::status::{SessionStatus, StatusSource, StatusState};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub sequence: u64,
    pub kind: &'static str,
    pub at: u64,
    pub unread: bool,
    pub source: StatusSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Default)]
pub struct Attention {
    pub event: Option<Event>,
    pub muted: bool,
    last_kind: Option<&'static str>,
    sequence: u64,
    last_response_sequence: u64,
    last_response_turn: Option<String>,
    projected: Option<&'static str>,
    projected_children: usize,
    projection_sequence: u64,
}

impl Attention {
    pub fn response_settled(&mut self, sequence: u64, turn_id: &str, at: u64) -> bool {
        if sequence <= self.last_response_sequence {
            return false;
        }
        self.last_response_sequence = sequence;
        if self.last_response_turn.as_deref() == Some(turn_id) {
            return false;
        }
        self.last_response_turn = Some(turn_id.into());
        self.last_kind = None;
        self.sequence += 1;
        self.event = Some(Event {
            sequence: self.sequence,
            kind: "done",
            at,
            unread: true,
            source: StatusSource::Hook,
            subject: Some("response"),
            turn_id: Some(turn_id.into()),
        });
        true
    }
    pub fn observe(&mut self, status: SessionStatus, limited: bool) -> bool {
        let kind = if limited {
            Some("limit")
        } else if status.source == StatusSource::Activity {
            None
        } else {
            match status.state {
                StatusState::Question => Some("question"),
                StatusState::Blocked => Some("permission"),
                StatusState::Done if status.source != StatusSource::Process => Some("done"),
                StatusState::Done => None,
                StatusState::Failed => Some("failed"),
                StatusState::Working | StatusState::Idle => {
                    self.last_kind = None;
                    None
                }
                StatusState::Unknown => None,
            }
        };
        let Some(kind) = kind else {
            return false;
        };
        if self.last_kind == Some(kind) {
            return false;
        }
        self.last_kind = Some(kind);
        self.sequence += 1;
        self.event = Some(Event {
            sequence: self.sequence,
            kind,
            at: status.updated_at,
            unread: true,
            source: if limited {
                StatusSource::Screen
            } else {
                status.source
            },
            subject: None,
            turn_id: None,
        });
        true
    }
    pub fn project(&mut self, reason: Option<&'static str>, blocked_children: usize) -> bool {
        let renewed = reason.is_some()
            && (reason != self.projected || blocked_children > self.projected_children);
        self.projected = reason;
        self.projected_children = blocked_children;
        if renewed {
            self.sequence += 1;
            self.projection_sequence = self.sequence;
        }
        renewed
    }
    pub fn revision(&self) -> u64 {
        self.event
            .as_ref()
            .map_or(0, |event| event.sequence)
            .max(self.projection_sequence)
    }
    pub fn acknowledge(&mut self, sequence: u64) {
        if let Some(event) = &mut self.event
            && event.sequence <= sequence
        {
            event.unread = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settled_response_is_unread_but_neither_process_exit_nor_new_work_becomes_task_success() {
        let mut attention = Attention::default();
        assert!(attention.response_settled(3, "launch:2", 5));
        let event = attention.event.as_ref().unwrap();
        assert_eq!(event.subject, Some("response"));
        assert_eq!(event.turn_id.as_deref(), Some("launch:2"));
        assert!(!attention.response_settled(3, "launch:2", 6));
        assert!(!attention.response_settled(4, "launch:2", 6));
        assert!(!attention.response_settled(1, "older", 6));
        for (source, state) in [
            (StatusSource::Hook, StatusState::Working),
            (StatusSource::Process, StatusState::Done),
        ] {
            assert!(!attention.observe(
                SessionStatus {
                    source,
                    state,
                    updated_at: 6
                },
                false
            ));
            assert_eq!(attention.event.as_ref().unwrap().sequence, 1);
        }
        attention.acknowledge(1);
        assert!(attention.response_settled(8, "launch:7", 9));
        attention.acknowledge(1);
        assert!(attention.event.as_ref().unwrap().unread);
        assert!(attention.observe(
            SessionStatus {
                state: StatusState::Question,
                source: StatusSource::Hook,
                updated_at: 10
            },
            false
        ));
        assert_eq!(attention.event.as_ref().unwrap().kind, "question");
    }
    #[test]
    fn redraws_silence_and_stale_acknowledgements_cannot_repeat_or_hide_new_alerts() {
        let mut attention = Attention::default();
        let mut status = SessionStatus {
            state: StatusState::Question,
            source: StatusSource::Screen,
            updated_at: 1,
        };
        assert!(attention.observe(status, false));
        assert!(!attention.observe(status, false));
        attention.acknowledge(1);
        status.source = StatusSource::Activity;
        status.state = StatusState::Unknown;
        assert!(!attention.observe(status, false));
        status.source = StatusSource::Screen;
        status.state = StatusState::Question;
        assert!(!attention.observe(status, false));
        assert!(attention.observe(status, true));
        attention.acknowledge(1);
        assert!(attention.event.as_ref().unwrap().unread);
        assert_eq!(attention.event.as_ref().unwrap().sequence, 2);
    }
    #[test]
    fn blocked_children_and_startup_projections_renew_the_inbox_revision() {
        let mut attention = Attention::default();
        assert!(!attention.project(None, 0));
        assert_eq!(attention.revision(), 0);
        assert!(attention.project(Some("child"), 1));
        let first = attention.revision();
        assert!(first > 0);
        assert!(!attention.project(Some("child"), 1));
        assert_eq!(attention.revision(), first);
        assert!(attention.project(Some("child"), 2));
        let second = attention.revision();
        assert!(second > first);
        assert!(!attention.project(None, 0));
        assert!(attention.project(Some("child"), 1));
        let third = attention.revision();
        assert!(third > second);
        assert!(attention.project(Some("startup"), 0));
        assert!(attention.revision() > third);
    }
}
