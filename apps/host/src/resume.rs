use crate::{api_error::Error, jobs::LaunchSpec, launchers::Program};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Write, path::Path, time::Duration};

pub const DEADLINE: Duration = Duration::from_secs(60);
const START_RECORD: &str = "session-start.json";
const START_RECORD_LIMIT: u64 = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub provider: Program,
    pub conversation_id: String,
}

impl Target {
    pub fn observed(
        program: Program,
        identity: Option<&crate::agent_events::Identity>,
    ) -> Option<Self> {
        let id = identity?.provider_session_id.as_deref()?;
        (program != Program::Shell && valid_conversation_id(id)).then(|| Self {
            provider: program,
            conversation_id: id.to_owned(),
        })
    }
}

pub fn valid_conversation_id(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

pub fn unsupported_reason(program: Program) -> Option<&'static str> {
    match program {
        Program::Claude | Program::Codex => None,
        Program::Gemini => Some(
            "Gemini has no exact conversation resume here; restore without resume to start a new conversation",
        ),
        Program::Shell => Some("A shell has no provider conversation to resume"),
    }
}

pub fn check_target(program: Program, target: &Target) -> Result<()> {
    if let Some(reason) = unsupported_reason(program) {
        return Err(Error::new("unsupported", reason).into());
    }
    if target.provider != program {
        return Err(Error::new(
            "invalid_argument",
            "The recorded conversation belongs to another provider",
        )
        .into());
    }
    if !valid_conversation_id(&target.conversation_id) {
        return Err(Error::new(
            "invalid_argument",
            "Conversation ID must be the provider's exact UUID",
        )
        .into());
    }
    Ok(())
}

pub fn check_launch(spec: &LaunchSpec, lifecycle_hooks: bool) -> Result<()> {
    let Some(target) = &spec.resume else {
        return Ok(());
    };
    check_target(spec.program, target)?;
    if !spec.prompt.is_empty() || spec.resume_picker || spec.worktree {
        return Err(Error::new(
            "invalid_argument",
            "Exact resume sends no prompt, opens no picker and creates no worktree",
        )
        .into());
    }
    if !lifecycle_hooks {
        return Err(Error::new(
            "resume_unverifiable",
            "Lifecycle hooks for this provider will not be installed, so the resumed conversation cannot be verified",
        )
        .into());
    }
    Ok(())
}

pub fn prepare_restore(spec: &mut LaunchSpec, exact: bool, lifecycle_hooks: bool) -> Result<()> {
    if !exact {
        spec.resume = None;
        return Ok(());
    }
    if spec.resume_picker {
        return Err(Error::new(
            "invalid_argument",
            "Choose the conversation picker or the exact conversation, not both",
        )
        .into());
    }
    if let Some(reason) = unsupported_reason(spec.program) {
        return Err(Error::new("unsupported", reason).into());
    }
    if spec.resume.is_none() {
        return Err(Error::new(
            "resume_unavailable",
            "This saved session has no recorded provider conversation",
        )
        .into());
    }
    check_launch(spec, lifecycle_hooks)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Verification {
    Pending {
        conversation_id: String,
    },
    Verified {
        conversation_id: String,
    },
    ResumeFailed {
        conversation_id: String,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    pub source: String,
    pub session_id: String,
}

impl Start {
    fn from_hook(value: &Value) -> Option<Self> {
        let start = Self {
            source: value["source"].as_str()?.to_owned(),
            session_id: value["session_id"].as_str()?.to_owned(),
        };
        start.valid().then_some(start)
    }
    fn valid(&self) -> bool {
        let token = |text: &str, limit: usize| {
            !text.is_empty()
                && text.len() <= limit
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        };
        token(&self.source, 32) && token(&self.session_id, 128)
    }
}

pub(crate) fn record_start(report: &Path, value: &Value) -> Result<()> {
    if value["hook_event_name"] != "SessionStart" || crate::agent_context::is_child(value) {
        return Ok(());
    }
    let Some(start) = Start::from_hook(value) else {
        return Ok(());
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(report.with_file_name(START_RECORD)) {
        Ok(mut file) => file.write_all(&serde_json::to_vec(&start)?)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub async fn read_start(report: &Path) -> Option<Start> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(report.with_file_name(START_RECORD))
        .await
        .ok()?;
    let mut bytes = Vec::new();
    file.take(START_RECORD_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() as u64 > START_RECORD_LIMIT {
        return None;
    }
    serde_json::from_slice::<Start>(&bytes)
        .ok()
        .filter(Start::valid)
}

pub struct Evidence<'a> {
    pub start: Option<&'a Start>,
    pub bound: Option<&'a str>,
    pub running: bool,
    pub elapsed: Duration,
}

pub struct Gate {
    target: Target,
    verification: Verification,
}

impl Gate {
    pub fn new(target: Target) -> Self {
        let verification = Verification::Pending {
            conversation_id: target.conversation_id.clone(),
        };
        Self {
            target,
            verification,
        }
    }
    pub fn target(&self) -> &Target {
        &self.target
    }
    pub fn verification(&self) -> &Verification {
        &self.verification
    }
    pub fn pending(&self) -> bool {
        matches!(self.verification, Verification::Pending { .. })
    }
    pub fn verified(&self) -> bool {
        matches!(self.verification, Verification::Verified { .. })
    }
    pub fn fail(&mut self, reason: impl Into<String>) -> bool {
        if !self.pending() {
            return false;
        }
        self.verification = Verification::ResumeFailed {
            conversation_id: self.target.conversation_id.clone(),
            reason: reason.into(),
        };
        true
    }
    pub fn expire(&mut self, running: bool, elapsed: Duration) -> bool {
        self.observe(Evidence {
            start: None,
            bound: None,
            running,
            elapsed,
        })
    }
    pub fn observe(&mut self, evidence: Evidence<'_>) -> bool {
        if !self.pending() {
            return false;
        }
        let expected = self.target.conversation_id.as_str();
        let reason = match (evidence.start, evidence.bound) {
            (_, Some(bound)) if bound != expected => {
                format!("Provider reported conversation {bound}, not {expected}")
            }
            (Some(start), _) if start.session_id != expected => format!(
                "Provider reported conversation {}, not {expected}",
                start.session_id
            ),
            (Some(start), _) if start.source != "resume" => format!(
                "Provider started with source {}, not resume; it is a new conversation",
                start.source
            ),
            (Some(_), _) => {
                self.verification = Verification::Verified {
                    conversation_id: expected.to_owned(),
                };
                return true;
            }
            (None, _) if !evidence.running => {
                "Provider exited before confirming the resumed conversation".to_owned()
            }
            (None, _) if evidence.elapsed >= DEADLINE => format!(
                "No resumed session start arrived within {} seconds",
                DEADLINE.as_secs()
            ),
            (None, _) => return false,
        };
        self.fail(reason)
    }
    pub fn refusal(&self) -> Option<Error> {
        match self.verification {
            Verification::Verified { .. } => None,
            Verification::Pending { .. } => Some(Error::new(
                "resume_pending",
                "Waiting for the provider to confirm the resumed conversation; nothing was delivered",
            )),
            Verification::ResumeFailed { .. } => Some(Error::new(
                "resume_failed",
                "The provider did not resume the recorded conversation; automated input is refused",
            )),
        }
    }
}

pub fn recorded(
    program: Program,
    identity: Option<&crate::agent_events::Identity>,
    gate: Option<&Gate>,
) -> Option<Target> {
    match gate {
        Some(gate) if !gate.verified() => Some(gate.target().clone()),
        _ => Target::observed(program, identity),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const OTHER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn target(provider: Program) -> Target {
        Target {
            provider,
            conversation_id: ID.into(),
        }
    }
    fn start(source: &str, id: &str) -> Start {
        Start {
            source: source.into(),
            session_id: id.into(),
        }
    }
    fn evidence<'a>(start: Option<&'a Start>, bound: Option<&'a str>) -> Evidence<'a> {
        Evidence {
            start,
            bound,
            running: true,
            elapsed: Duration::from_secs(1),
        }
    }
    fn report() -> (std::path::PathBuf, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-resume-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (directory.join("events.sqlite"), directory)
    }

    #[test]
    fn resume_ids_must_be_exact_provider_uuids() {
        assert!(valid_conversation_id(ID));
        for invalid in [
            "",
            "latest",
            "0f8fad5b-d9cb-469f-a165-70867728950",
            "0f8fad5bd9cb469fa16570867728950e",
            "0f8fad5b-d9cb-469f-a165-70867728950g",
            "../0f8fad5b-d9cb-469f-a165-70867728950e",
        ] {
            assert!(!valid_conversation_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn resume_launch_refuses_prompts_pickers_worktrees_and_foreign_providers() {
        let spec = LaunchSpec {
            program: Program::Claude,
            resume: Some(target(Program::Claude)),
            ..Default::default()
        };
        check_launch(&spec, true).unwrap();
        for mutate in [
            |spec: &mut LaunchSpec| spec.prompt = "continue".into(),
            |spec: &mut LaunchSpec| spec.resume_picker = true,
            |spec: &mut LaunchSpec| spec.worktree = true,
            |spec: &mut LaunchSpec| spec.program = Program::Codex,
            |spec: &mut LaunchSpec| spec.resume.as_mut().unwrap().conversation_id = "x".into(),
        ] {
            let mut candidate = spec.clone();
            mutate(&mut candidate);
            assert!(check_launch(&candidate, true).is_err());
        }
        let gemini = LaunchSpec {
            program: Program::Gemini,
            resume: Some(target(Program::Gemini)),
            ..Default::default()
        };
        let error = check_launch(&gemini, true).unwrap_err();
        assert_eq!(error.downcast_ref::<Error>().unwrap().code, "unsupported");
        assert!(error.to_string().contains("Gemini"));
    }

    #[test]
    fn resume_restore_requests_the_exact_id_only_when_asked() {
        let mut spec = LaunchSpec {
            program: Program::Codex,
            resume: Some(target(Program::Codex)),
            ..Default::default()
        };
        let mut fresh = spec.clone();
        prepare_restore(&mut fresh, false, false).unwrap();
        assert!(fresh.resume.is_none());
        prepare_restore(&mut spec, true, true).unwrap();
        assert_eq!(spec.resume, Some(target(Program::Codex)));
        let mut missing = LaunchSpec {
            program: Program::Claude,
            ..Default::default()
        };
        let error = prepare_restore(&mut missing, true, true).unwrap_err();
        assert_eq!(
            error.downcast_ref::<Error>().unwrap().code,
            "resume_unavailable"
        );
    }

    #[test]
    fn resume_launch_and_restore_refuse_an_exact_resume_without_lifecycle_hooks() {
        let code = |result: Result<()>| result.unwrap_err().downcast::<Error>().unwrap().code;
        let spec = LaunchSpec {
            program: Program::Codex,
            resume: Some(target(Program::Codex)),
            ..Default::default()
        };
        assert_eq!(code(check_launch(&spec, false)), "resume_unverifiable");
        let mut restored = spec.clone();
        assert_eq!(
            code(prepare_restore(&mut restored, true, false)),
            "resume_unverifiable"
        );
        let mut fresh = spec.clone();
        prepare_restore(&mut fresh, false, false).unwrap();
        check_launch(&fresh, false).unwrap();
    }

    #[test]
    fn resume_gate_expires_without_a_tracker_at_the_deadline_or_after_exit() {
        let mut gate = Gate::new(target(Program::Codex));
        assert!(!gate.expire(true, DEADLINE - Duration::from_millis(1)));
        assert!(gate.pending());
        assert!(gate.expire(true, DEADLINE));
        assert_eq!(gate.refusal().unwrap().code, "resume_failed");
        assert!(!gate.expire(false, DEADLINE));
        let mut exited = Gate::new(target(Program::Codex));
        assert!(exited.expire(false, Duration::from_secs(1)));
        assert!(
            matches!(exited.verification(), Verification::ResumeFailed { reason, .. } if reason.contains("exited"))
        );
    }

    #[test]
    fn resume_gate_verifies_only_a_resumed_start_with_the_expected_id() {
        let mut gate = Gate::new(target(Program::Claude));
        assert_eq!(gate.refusal().unwrap().code, "resume_pending");
        assert!(!gate.observe(evidence(None, None)));
        assert!(gate.pending());
        let resumed = start("resume", ID);
        assert!(gate.observe(evidence(Some(&resumed), Some(ID))));
        assert!(gate.verified() && gate.refusal().is_none());
        assert_eq!(
            serde_json::to_value(gate.verification()).unwrap(),
            serde_json::json!({"state":"verified","conversationId":ID})
        );
        assert!(!gate.fail("late"));
    }

    #[test]
    fn resume_gate_marks_wrong_id_or_fresh_start_as_resume_failed() {
        for (observed, bound, needle) in [
            (start("resume", OTHER), None, OTHER),
            (start("startup", ID), Some(ID), "source startup"),
            (start("resume", ID), Some(OTHER), OTHER),
        ] {
            let mut gate = Gate::new(target(Program::Codex));
            assert!(gate.observe(evidence(Some(&observed), bound)));
            assert_eq!(gate.refusal().unwrap().code, "resume_failed");
            let value = serde_json::to_value(gate.verification()).unwrap();
            assert_eq!(value["state"], "resumeFailed");
            assert_eq!(value["conversationId"], ID);
            assert!(value["reason"].as_str().unwrap().contains(needle));
            assert!(!gate.observe(evidence(Some(&start("resume", ID)), Some(ID))));
        }
    }

    #[test]
    fn resume_gate_fails_without_a_hook_by_the_deadline_or_after_exit() {
        let mut gate = Gate::new(target(Program::Claude));
        assert!(!gate.observe(Evidence {
            elapsed: DEADLINE - Duration::from_millis(1),
            ..evidence(None, None)
        }));
        assert!(gate.observe(Evidence {
            elapsed: DEADLINE,
            ..evidence(None, None)
        }));
        assert!(
            matches!(gate.verification(), Verification::ResumeFailed { reason, .. } if reason.contains("60 seconds"))
        );
        let mut exited = Gate::new(target(Program::Claude));
        assert!(exited.observe(Evidence {
            running: false,
            ..evidence(None, None)
        }));
        assert!(
            matches!(exited.verification(), Verification::ResumeFailed { reason, .. } if reason.contains("exited"))
        );
    }

    #[test]
    fn resume_record_keeps_the_expected_id_until_verified() {
        let identity = crate::agent_events::Identity {
            host_session_id: "host".into(),
            launch_id: "0".repeat(32),
            provider_session_id: Some(OTHER.into()),
            generation: 1,
            rejected: 0,
            prompt_correlation: false,
        };
        assert_eq!(
            recorded(Program::Claude, Some(&identity), None)
                .unwrap()
                .conversation_id,
            OTHER
        );
        assert!(recorded(Program::Shell, Some(&identity), None).is_none());
        let mut gate = Gate::new(target(Program::Claude));
        gate.fail("wrong");
        assert_eq!(
            recorded(Program::Claude, Some(&identity), Some(&gate)),
            Some(target(Program::Claude))
        );
    }

    #[tokio::test]
    async fn resume_start_record_keeps_the_first_root_session_start_only() {
        let (report, directory) = report();
        assert!(read_start(&report).await.is_none());
        record_start(
            &report,
            &serde_json::json!({"hook_event_name":"Stop","session_id":ID,"source":"resume"}),
        )
        .unwrap();
        record_start(
            &report,
            &serde_json::json!({"hook_event_name":"SessionStart","session_id":OTHER,"source":"resume","agent_id":"child"}),
        )
        .unwrap();
        assert!(read_start(&report).await.is_none());
        record_start(
            &report,
            &serde_json::json!({"hook_event_name":"SessionStart","session_id":ID,"source":"resume"}),
        )
        .unwrap();
        record_start(
            &report,
            &serde_json::json!({"hook_event_name":"SessionStart","session_id":OTHER,"source":"clear"}),
        )
        .unwrap();
        assert_eq!(read_start(&report).await, Some(start("resume", ID)));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
