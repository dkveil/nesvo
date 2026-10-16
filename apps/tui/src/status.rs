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
    Process,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Status {
    pub state: State,
    pub source: Source,
    // Preserve the required wire field without introducing wall-clock reads in rendering.
    #[serde(rename = "updatedAt")]
    pub _updated_at: u64,
}

impl Status {
    pub fn attention_priority(&self) -> u8 {
        match (self.source, self.state) {
            (Source::Screen, State::Question) => 3,
            (Source::Screen, State::Blocked) => 2,
            (Source::Screen | Source::Process, State::Failed) => 1,
            _ => 0,
        }
    }

    pub fn label(&self) -> &'static str {
        match (self.source, self.state) {
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
