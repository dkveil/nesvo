//! Prompt correlation is private evidence, independent of PTY delivery or idle.
use crate::{
    agent_events::{Event, Identity},
    status::StatusState,
};
use serde_json::{Value, json};
use tokio::sync::watch;

#[derive(Clone)]
pub struct Claim {
    pub id: String,
    pub issuer: String,
    pub token: String,
}
pub struct Transition {
    pub claim: Claim,
    pub phase: &'static str,
    pub result: Value,
}
pub struct Pending {
    pub claim: Claim,
    pub canceled: watch::Sender<bool>,
    pub correlation: Option<Correlation>,
    pub digest: String,
    pub source: Option<(String, u64)>,
    pub queued: bool,
    pub reconciliation_queued: bool,
}
pub struct Correlation {
    launch: String,
    generation: u64,
    after: u64,
    digest: String,
    turn: Option<String>,
    closed: bool,
    processing: bool,
}
impl Correlation {
    pub fn new(identity: &Identity, after: u64, digest: String) -> Self {
        Self {
            launch: identity.launch_id.clone(),
            generation: identity.generation,
            after,
            digest,
            turn: None,
            closed: false,
            processing: false,
        }
    }
    pub fn observe(&mut self, identity: &Identity, event: &Event) -> Option<(&'static str, Value)> {
        if self.closed || event.sequence <= self.after {
            return None;
        }
        if identity.launch_id != self.launch || event.generation != self.generation {
            self.closed = true;
            return Some((
                "unknown",
                json!({"code":"conversation_changed","sourceSequence":event.sequence,"taskResult":null}),
            ));
        }
        self.after = event.sequence;
        let phase = if event.name == "UserPromptSubmit" {
            if self.turn.is_some() {
                self.closed = true;
                "interrupted"
            } else if event.prompt_digest.as_deref() == Some(self.digest.as_str()) {
                self.turn = Some(format!("{}:{}", self.launch, event.sequence));
                "received"
            } else {
                return None;
            }
        } else {
            self.turn.as_ref()?;
            match event.name.as_str() {
                "Stop" => {
                    self.closed = true;
                    "settled"
                }
                "StopFailure" if event.state == StatusState::Blocked => "waiting",
                "StopFailure" => {
                    self.closed = true;
                    "failed"
                }
                "PermissionRequest" => "waiting",
                "PreToolUse" if event.state == StatusState::Question => "waiting",
                "Notification"
                    if matches!(event.state, StatusState::Blocked | StatusState::Question) =>
                {
                    "waiting"
                }
                "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => "started",
                _ => return None,
            }
        };
        self.processing |= matches!(
            event.name.as_str(),
            "PreToolUse"
                | "PostToolUse"
                | "PostToolUseFailure"
                | "PermissionRequest"
                | "Stop"
                | "StopFailure"
        );
        Some((
            phase,
            json!({"turnId":self.turn,"sourceSequence":event.sequence,"generation":event.generation,"taskResult":null,"providerPromptObserved":true,"processingObserved":self.processing}),
        ))
    }
}

/// Canonicalization is for matching only; sent prompt bytes are not changed.
/// Providers may normalize terminal line endings and surrounding whitespace.
pub fn digest(prompt: &str) -> Option<String> {
    if prompt.len() > 8192
        || prompt
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return None;
    }
    let canonical = prompt.replace("\r\n", "\n").replace('\r', "\n");
    Some(hex::encode(
        ring::digest::digest(&ring::digest::SHA256, canonical.trim().as_bytes()).as_ref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity {
        Identity {
            host_session_id: "host".into(),
            launch_id: "launch".into(),
            provider_session_id: Some("conversation".into()),
            generation: 1,
            rejected: 0,
            prompt_correlation: true,
        }
    }
    fn event(sequence: u64, name: &str, prompt: Option<&str>, state: StatusState) -> Event {
        Event {
            name: name.into(),
            sequence,
            generation: 1,
            state,
            prompt_digest: prompt.and_then(digest),
        }
    }
    #[test]
    fn old_idle_other_prompts_and_fast_stops_cannot_finish_an_uncorrelated_send() {
        let id = identity();
        let mut correlation = Correlation::new(&id, 10, digest("wanted").unwrap());
        assert!(
            correlation
                .observe(
                    &id,
                    &event(9, "UserPromptSubmit", Some("wanted"), StatusState::Working)
                )
                .is_none()
        );
        assert!(
            correlation
                .observe(&id, &event(11, "Stop", None, StatusState::Idle))
                .is_none()
        );
        assert!(
            correlation
                .observe(
                    &id,
                    &event(12, "UserPromptSubmit", Some("other"), StatusState::Working)
                )
                .is_none()
        );
        assert!(
            correlation
                .observe(&id, &event(13, "Stop", None, StatusState::Idle))
                .is_none()
        );
        let (phase, payload) = correlation
            .observe(
                &id,
                &event(14, "UserPromptSubmit", Some("wanted"), StatusState::Working),
            )
            .unwrap();
        assert_eq!(phase, "received");
        assert_eq!(payload["turnId"], "launch:14");
        assert!(
            correlation
                .observe(&id, &event(15, "Notification", None, StatusState::Idle))
                .is_none()
        );
        let (phase, payload) = correlation
            .observe(&id, &event(16, "Stop", None, StatusState::Idle))
            .unwrap();
        assert_eq!(phase, "settled");
        assert_eq!(payload["taskResult"], Value::Null);
        assert!(
            correlation
                .observe(&id, &event(17, "Stop", None, StatusState::Idle))
                .is_none()
        );
    }
    #[test]
    fn new_conversation_and_superseding_prompts_invalidate_old_wait_targets() {
        let id = identity();
        let mut c = Correlation::new(&id, 0, digest("wanted").unwrap());
        c.observe(
            &id,
            &event(1, "UserPromptSubmit", Some("wanted"), StatusState::Working),
        )
        .unwrap();
        let interrupted = c
            .observe(
                &id,
                &event(2, "UserPromptSubmit", Some("new"), StatusState::Working),
            )
            .unwrap();
        assert_eq!(interrupted.0, "interrupted");
        assert!(
            c.observe(&id, &event(3, "Stop", None, StatusState::Idle))
                .is_none()
        );
        let mut c = Correlation::new(&id, 0, digest("wanted").unwrap());
        let mut changed = identity();
        changed.generation = 2;
        let mut e = event(1, "SessionStart", None, StatusState::Idle);
        e.generation = 2;
        assert_eq!(c.observe(&changed, &e).unwrap().0, "unknown");
    }
    #[test]
    fn fingerprints_preserve_content_and_unicode_and_never_accept_terminal_controls() {
        assert_eq!(digest("  łódź\r\nnext\n"), digest("łódź\nnext"));
        assert_ne!(digest("literal $(keep)"), digest("literal keep"));
        assert_ne!(digest("A"), digest("a"));
        assert!(digest("\x1b[201~").is_none());
        assert!(digest(&"x".repeat(8193)).is_none());
    }
}
