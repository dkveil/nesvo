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
}

#[derive(Default)]
pub struct Attention {
    pub event: Option<Event>,
    pub muted: bool,
    last_kind: Option<&'static str>,
    sequence: u64,
}

impl Attention {
    pub fn observe(&mut self, status: SessionStatus, limited: bool) -> bool {
        let kind = if limited {
            Some("limit")
        } else if status.source == StatusSource::Activity {
            None
        } else {
            match status.state {
                StatusState::Question => Some("question"),
                StatusState::Blocked => Some("permission"),
                StatusState::Done => Some("done"),
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
        });
        true
    }
    pub fn acknowledge(&mut self, sequence: u64) {
        if let Some(event) = &mut self.event
            && event.sequence == sequence
        {
            event.unread = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
