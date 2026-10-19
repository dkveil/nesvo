//! Host-reported state. Terminal I/O alone is not evidence that an agent is working.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Working,
    Idle,
    Done,
    Blocked,
    Question,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Activity,
    Screen,
    Hook,
    Process,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(from = "WireStatus")]
pub struct Status {
    pub state: State,
    pub source: Source,
    // Preserve the required wire field without introducing wall-clock reads in rendering.
    pub _updated_at: u64,
}

#[derive(Deserialize)]
struct WireStatus {
    state: State,
    source: Source,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}
impl From<WireStatus> for Status {
    fn from(wire: WireStatus) -> Self {
        Self {
            state: wire.state,
            source: if wire.source == Source::Screen && wire.evidence.as_deref() == Some("hook") {
                Source::Hook
            } else {
                wire.source
            },
            _updated_at: wire.updated_at,
        }
    }
}

impl Status {
    pub fn attention_priority(&self) -> u8 {
        match (self.source, self.state) {
            (Source::Screen | Source::Hook, State::Question) => 3,
            (Source::Screen | Source::Hook, State::Blocked) => 2,
            (Source::Screen | Source::Hook | Source::Process, State::Failed) => 1,
            _ => 0,
        }
    }

    pub fn label(&self) -> &'static str {
        match (self.source, self.state) {
            (Source::Hook, state) => match state {
                State::Working => "running",
                State::Idle => "idle",
                State::Done => "done",
                State::Blocked => "blocked",
                State::Question => "question",
                State::Failed => "failed",
                State::Unknown => "unknown",
            },
            (Source::Activity, State::Working) => "open",
            (Source::Activity, State::Idle) => "quiet",
            (Source::Activity, _) => "unknown",
            (Source::Screen, State::Working) => "~working",
            (Source::Screen, State::Idle) => "~idle",
            (Source::Screen, State::Done) => "~done",
            (Source::Screen, State::Blocked) => "~blocked",
            (Source::Screen, State::Question) => "~question",
            (Source::Screen, State::Failed) => "~failed",
            (Source::Screen, State::Unknown) => "unknown",
            (Source::Process, State::Done) => "done",
            (Source::Process, State::Failed) => "failed",
            (Source::Process, _) => "unknown",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_states_are_confirmed_and_participate_in_attention() {
        let mut status: Status = serde_json::from_str(
            r#"{"state":"working","source":"screen","evidence":"hook","updatedAt":1}"#,
        )
        .unwrap();
        assert_eq!(status.label(), "running");
        status.state = State::Idle;
        assert_eq!(status.label(), "idle");
        status.state = State::Blocked;
        assert_eq!(status.attention_priority(), 2);
        assert_eq!(status.label(), "blocked");
    }
    #[test]
    fn terminal_io_does_not_claim_agent_work_and_screen_is_inferred() {
        let mut status = Status {
            state: State::Working,
            source: Source::Activity,
            _updated_at: 1,
        };
        assert_eq!(status.label(), "open");
        status.state = State::Idle;
        assert_eq!(status.label(), "quiet");
        status.state = State::Done;
        assert_eq!(status.label(), "unknown");
        status.source = Source::Screen;
        assert_eq!(status.label(), "~done");
        status.source = Source::Process;
        assert_eq!(status.label(), "done");
    }
}
