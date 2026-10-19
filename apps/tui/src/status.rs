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
    Program,
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
#[derive(Clone, Debug, Deserialize)]
pub struct Readiness {
    pub phase: ReadinessPhase,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Lifecycle {
    pub turn: Option<Turn>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub phase: TurnPhase,
    pub elapsed_seconds: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnPhase {
    Accepted,
    Started,
    Waiting,
    Settled,
    Interrupted,
    Failed,
}
impl TurnPhase {
    pub fn active(self) -> bool {
        matches!(self, Self::Accepted | Self::Started | Self::Waiting)
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Accepted | Self::Started | Self::Waiting => "turn",
            Self::Settled => "response",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAttention {
    pub priority: u8,
    pub reason: Option<String>,
    pub status: Option<Status>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct AttentionSummary {
    pub sessions: usize,
    pub highest: Option<CurrentAttention>,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReadinessPhase {
    NotApplicable,
    Starting,
    Waiting,
    Ready,
    TimedOut,
    Exited,
}

#[derive(Deserialize)]
struct WireStatus {
    state: State,
    source: Source,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(default, rename = "confirmedSource")]
    confirmed_source: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}
impl From<WireStatus> for Status {
    fn from(wire: WireStatus) -> Self {
        Self {
            state: wire.state,
            source: if wire.source == Source::Screen && wire.evidence.as_deref() == Some("hook") {
                Source::Hook
            } else if wire.source == Source::Screen
                && wire.confirmed_source.as_deref() == Some("osc7501")
            {
                Source::Program
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
            (Source::Screen | Source::Hook | Source::Program, State::Question) => 3,
            (Source::Screen | Source::Hook | Source::Program, State::Blocked) => 2,
            (Source::Screen | Source::Hook | Source::Program | Source::Process, State::Failed) => 1,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn program_status_is_confirmed_without_breaking_legacy_screen_wire() {
        let status: Status = serde_json::from_str(
            r#"{"state":"blocked","source":"screen","confirmedSource":"osc7501","updatedAt":2}"#,
        )
        .unwrap();
        assert_eq!(status.source, Source::Program);
        assert_eq!(status.attention_priority(), 2);
    }
    #[test]
    fn hook_states_are_confirmed_and_participate_in_attention() {
        let mut status: Status = serde_json::from_str(
            r#"{"state":"working","source":"screen","evidence":"hook","updatedAt":1}"#,
        )
        .unwrap();
        assert_eq!(status.source, Source::Hook);
        status.state = State::Idle;
        assert_eq!(status.attention_priority(), 0);
        status.state = State::Blocked;
        assert_eq!(status.attention_priority(), 2);
    }
}
