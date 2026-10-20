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
    pub authority: crate::caller::Authority,
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
    matched_by: Option<&'static str>,
    last_prompt: Option<(u64, bool)>,
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
            matched_by: None,
            last_prompt: None,
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
            let matched_by = if event.prompt_digest.as_deref() == Some(self.digest.as_str()) {
                Some("exact")
            } else if event.paste_digest.as_deref() == Some(self.digest.as_str()) {
                Some("claudePasteWrapper")
            } else {
                None
            };
            self.last_prompt = Some((event.sequence, matched_by.is_some()));
            if self.turn.is_some() {
                self.closed = true;
                "interrupted"
            } else {
                let matched_by = matched_by?;
                self.matched_by = Some(matched_by);
                self.turn = Some(format!("{}:{}", self.launch, event.sequence));
                "received"
            }
        } else {
            self.turn.as_ref()?;
            match event.name.as_str() {
                "Interrupt" => {
                    self.closed = true;
                    "interrupted"
                }
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
            json!({"turnId":self.turn,"sourceSequence":event.sequence,"generation":event.generation,"taskResult":null,"providerPromptObserved":true,"processingObserved":self.processing,"promptMatch":self.matched_by}),
        ))
    }
    /// Explain unmatched pickup without exposing either fingerprint or prompt.
    pub fn diagnostic(&self) -> Value {
        json!({"closed":self.closed,"matchedBy":self.matched_by,"lastPromptSequence":self.last_prompt.map(|p|p.0),"lastPromptMatched":self.last_prompt.map(|p|p.1)})
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

/// Claude can mark one whole pasted prompt in its hook payload. Preserve the raw
/// fingerprint too: only this bounded, complete envelope adds an alternative.
/// Inline/malformed tags and their contents are never generally rewritten.
pub fn claude_paste_digest(prompt: &str) -> Option<String> {
    if prompt.len() > 8192 + 128 {
        return None;
    }
    let canonical = prompt.replace("\r\n", "\n").replace('\r', "\n");
    let (id, content) = canonical
        .trim()
        .strip_prefix("<pasted_content id=\"")?
        .split_once("\">\n")?;
    if id.is_empty() || id.len() > 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let suffix = format!("\n</pasted_content id=\"{id}\">");
    digest(content.strip_suffix(&suffix)?)
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
            paste_digest: None,
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
    #[test]
    fn paste_envelope_requires_complete_matching_tags_and_keeps_inner_content_exact() {
        let text = "literal łódź\r\n\t[1] owner rule\r\n\r\nTask";
        let wrapped = format!(
            "\n\n<pasted_content id=\"f558\">\r\n{text}\r\n</pasted_content id=\"f558\">\n"
        );
        assert_eq!(claude_paste_digest(&wrapped), digest(text));
        assert_ne!(digest(&wrapped), digest(text));
        for invalid in [
            wrapped.replace(
                "</pasted_content id=\"f558\">",
                "</pasted_content id=\"b123\">",
            ),
            format!("prefix {wrapped}"),
            format!("{wrapped} suffix"),
            wrapped.replace("f558", ""),
            wrapped.replace("f558", "bad identity"),
            wrapped.replace("f558", &"a".repeat(17)),
            wrapped.replace("literal", "\x1bliteral"),
        ] {
            assert!(claude_paste_digest(&invalid).is_none());
        }
        let maximum = format!(
            "<pasted_content id=\"f558\">\n{}\n</pasted_content id=\"f558\">",
            "x".repeat(8192)
        );
        assert!(digest(&maximum).is_none());
        assert_eq!(claude_paste_digest(&maximum), digest(&"x".repeat(8192)));
        assert!(
            claude_paste_digest(&maximum.replace(&"x".repeat(8192), &"x".repeat(8193))).is_none()
        );
        // Strip exactly one envelope; literal nested tags remain significant.
        let nested = format!("<pasted_content id=\"a\">\n{wrapped}\n</pasted_content id=\"a\">");
        assert_eq!(claude_paste_digest(&nested), digest(&wrapped));
    }
    #[test]
    fn wrapped_pickup_requires_exact_body_and_cannot_settle_other_or_stale_work() {
        let id = identity();
        let mut c = Correlation::new(&id, 10, digest("wanted\nowner rule").unwrap());
        let wrap = |text: &str| {
            format!("<pasted_content id=\"f558\">\n{text}\n</pasted_content id=\"f558\">")
        };
        let mut wrong = event(
            11,
            "UserPromptSubmit",
            Some(&wrap("other\nowner rule")),
            StatusState::Working,
        );
        wrong.paste_digest = claude_paste_digest(&wrap("other\nowner rule"));
        assert!(c.observe(&id, &wrong).is_none());
        assert_eq!(c.diagnostic()["lastPromptMatched"], false);
        assert!(
            c.observe(&id, &event(12, "Stop", None, StatusState::Idle))
                .is_none()
        );
        let mut correct = event(
            13,
            "UserPromptSubmit",
            Some(&wrap("wanted\nowner rule")),
            StatusState::Working,
        );
        correct.paste_digest = claude_paste_digest(&wrap("wanted\nowner rule"));
        let matched = c.observe(&id, &correct).unwrap();
        assert_eq!(matched.0, "received");
        assert_eq!(matched.1["promptMatch"], "claudePasteWrapper");
        assert_eq!(c.diagnostic()["lastPromptMatched"], true);
        assert_eq!(
            c.observe(&id, &event(14, "Stop", None, StatusState::Idle))
                .unwrap()
                .0,
            "settled"
        );
        assert!(
            c.observe(&id, &event(15, "Stop", None, StatusState::Idle))
                .is_none()
        );
        let literal = wrap("literal body");
        let mut c = Correlation::new(&id, 0, digest(&literal).unwrap());
        let mut e = event(1, "UserPromptSubmit", Some(&literal), StatusState::Working);
        e.paste_digest = claude_paste_digest(&literal);
        assert_eq!(c.observe(&id, &e).unwrap().1["promptMatch"], "exact");
    }
}
