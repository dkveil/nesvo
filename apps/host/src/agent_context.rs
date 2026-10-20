//! Launch-scoped native hooks. Never store prompts, output, or transcript contents.
use anyhow::Result;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

enum Adapter {
    Claude,
    ClaudeHarness,
    Codex,
}
pub struct Tracker(PathBuf, Adapter, Option<Value>);
impl Tracker {
    #[cfg(test)]
    pub fn install(command: &mut CommandBuilder) -> Result<Self> {
        Self::install_inner(command, None, None, None)
    }
    #[cfg(test)]
    pub fn install_for(command: &mut CommandBuilder, session_id: &str) -> Result<Self> {
        Self::install_inner(command, Some(session_id), None, None)
    }
    #[cfg(test)]
    pub fn install_harness(
        command: &mut CommandBuilder,
        session_id: &str,
        recovery: Value,
        permissions: Vec<String>,
    ) -> Result<Self> {
        Self::install_inner(
            command,
            Some(session_id),
            Some((recovery, permissions)),
            None,
        )
    }
    pub fn install_claude(
        command: &mut CommandBuilder,
        session_id: &str,
        recovery: Option<(Value, Vec<String>)>,
        capture: Option<&crate::claude_statusline::Prepared>,
    ) -> Result<Self> {
        Self::install_inner(command, Some(session_id), recovery, capture)
    }
    pub fn capture_diagnostic(&self) -> Option<&Value> {
        self.2.as_ref()
    }
    pub fn install_codex(command: &mut CommandBuilder, session_id: &str) -> Result<Self> {
        let mut tracker = Self::create(Some(session_id))?;
        tracker.1 = Adapter::Codex;
        crate::codex_context::configure(command, &tracker.report())?;
        Ok(tracker)
    }
    pub fn adapter(&self) -> &'static str {
        match self.1 {
            Adapter::Codex => "codex-hooks-v1",
            Adapter::Claude => "claude-hooks-v3",
            Adapter::ClaudeHarness => "claude-hooks-v4",
        }
    }
    fn install_inner(
        command: &mut CommandBuilder,
        session_id: Option<&str>,
        recovery: Option<(Value, Vec<String>)>,
        capture: Option<&crate::claude_statusline::Prepared>,
    ) -> Result<Self> {
        let mut tracker = Self::create(session_id)?;
        if let Some(id) = session_id {
            command.env("NESVO_SESSION_ID", id);
        }
        let hook = json!({"type":"command", "command": std::env::current_exe()?,
            "args":["--agent-context-hook", tracker.report()], "timeout":3});
        let mut settings = json!({"hooks": {
            "SessionStart":[{"hooks":[hook.clone()]}],
            "UserPromptSubmit":[{"hooks":[hook.clone()]}],
            "PreToolUse":[{"hooks":[hook.clone()]}],
            "PostToolUse":[{"hooks":[hook.clone()]}],
            "PostToolUseFailure":[{"hooks":[hook.clone()]}],
            "PermissionRequest":[{"hooks":[hook.clone()]}],
            "Notification":[{"hooks":[hook.clone()]}],
            "Stop":[{"hooks":[hook.clone()]}],
            "StopFailure":[{"hooks":[hook.clone()]}],
            "CwdChanged":[{"hooks":[hook]}]
        }});
        if let Some((recovery, permissions)) = recovery {
            tracker.1 = Adapter::ClaudeHarness;
            settings["hooks"]["SessionStart"][0]["hooks"]
                .as_array_mut()
                .ok_or_else(|| anyhow::anyhow!("Missing startup hook array"))?
                .push(recovery);
            if !permissions.is_empty() {
                settings["permissions"] = json!({"allow":permissions});
            }
        }
        if let Some(capture) = capture {
            settings["statusLine"] = capture.install(&tracker.report())?;
            tracker.2 = Some(capture.diagnostic());
        }
        let settings = settings.to_string();
        let argv = command.get_argv_mut();
        let index = argv
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(argv.len());
        argv.splice(index..index, ["--settings".into(), settings.into()]);
        Ok(tracker)
    }
    fn create(session_id: Option<&str>) -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-context-{}",
            hex::encode(crate::wire::random::<16>())
        ));
        std::fs::create_dir(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let tracker = Self(directory, Adapter::Claude, None);
        if let Some(session_id) = session_id {
            crate::agent_events::initialize(&tracker.report(), session_id)?;
        }
        Ok(tracker)
    }
    pub fn report(&self) -> PathBuf {
        self.0.join("context.json")
    }
}
impl Drop for Tracker {
    fn drop(&mut self) {
        // Only this randomly allocated session directory is owned by the tracker.
        let Ok(parent) = std::env::temp_dir().canonicalize() else {
            return;
        };
        let Ok(target) = self.0.canonicalize() else {
            return;
        };
        if target.parent() != Some(parent.as_path())
            || !target
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|name| {
                    name.strip_prefix("nesvo-context-").is_some_and(|suffix| {
                        suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                })
        {
            return;
        }
        for attempt in 0..4 {
            match std::fs::remove_dir_all(&target) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) if cfg!(windows) && attempt < 3 => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(_) => {
                    eprintln!("Private lifecycle scope cleanup did not complete");
                    return;
                }
            }
        }
    }
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Context {
    pub directory: PathBuf,
    pub source: String,
}
fn extract(value: &Value) -> Option<Context> {
    let (path, source, file) = match value["hook_event_name"].as_str()? {
        "PostToolUse" if matches!(value["tool_name"].as_str(), Some("Edit" | "Write")) => (
            value["tool_input"]["file_path"].as_str()?,
            "Auto: edited file",
            true,
        ),
        "CwdChanged" => (value["new_cwd"].as_str()?, "Auto: agent directory", false),
        _ => return None,
    };
    if path.len() > 4096 || path.chars().any(char::is_control) {
        return None;
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return None;
    }
    Some(Context {
        directory: if file {
            path.parent()?.to_owned()
        } else {
            path
        },
        source: source.into(),
    })
}
pub fn receive(report: &Path) -> Result<()> {
    receive_adapter(report, std::io::stdin(), false)
}
pub fn receive_codex(report: &Path) -> Result<()> {
    receive_adapter(report, std::io::stdin(), true)
}
fn receive_adapter(report: &Path, input: impl Read, codex: bool) -> Result<()> {
    let result = receive_inner(report, input, codex);
    let diagnostic = report.with_file_name("diagnostic.json");
    if result.is_err() {
        // Constant metadata only: serde errors can contain supplied payload text.
        let _ = crate::private_write(&diagnostic, br#"{"code":"hook_receive_failed"}"#);
    } else if diagnostic.exists() {
        let _ = std::fs::remove_file(diagnostic);
    }
    result
}
#[cfg(test)]
fn receive_from(report: &Path, input: impl Read) -> Result<()> {
    receive_inner(report, input, false)
}
fn receive_inner(report: &Path, input: impl Read, codex: bool) -> Result<()> {
    let mut bytes = Vec::new();
    input.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if is_child(&value) {
        return Ok(());
    }
    if let Some(state) = if codex {
        crate::codex_context::state(&value)?
    } else {
        lifecycle_state(&value)
    } {
        let digest = (value["hook_event_name"] == "UserPromptSubmit")
            .then(|| value["prompt"].as_str().and_then(crate::submission::digest))
            .flatten();
        let paste_digest = (!codex && value["hook_event_name"] == "UserPromptSubmit")
            .then(|| {
                value["prompt"]
                    .as_str()
                    .and_then(crate::submission::claude_paste_digest)
            })
            .flatten();
        let sequence = if crate::agent_events::exists(report) {
            match crate::agent_events::append_scoped(
                report,
                crate::agent_events::SourceEvent {
                    provider_session: value["session_id"].as_str(),
                    provider_turn: if codex {
                        value["turn_id"].as_str()
                    } else {
                        None
                    },
                    event: value["hook_event_name"].as_str().unwrap_or_default(),
                    state,
                    allow_rebind: matches!(
                        value["source"].as_str(),
                        Some("clear" | "resume" | "compact")
                    ),
                    prompt_digest: digest.as_deref(),
                    paste_digest: paste_digest.as_deref(),
                },
            )? {
                Some(sequence) => sequence,
                None => return Ok(()),
            }
        } else {
            // Existing launch scopes created by older hosts retain compatibility.
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
                .max(0) as u64
        };
        let status = LifecycleReport { state, sequence };
        let destination = report.with_file_name("status.json");
        let temporary =
            destination.with_extension(format!("{}.tmp", hex::encode(crate::wire::random::<8>())));
        crate::private_write(&temporary, &serde_json::to_vec(&status)?)?;
        let result = std::fs::rename(&temporary, &destination);
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
    }
    if !codex && let Some(context) = extract(&value) {
        if crate::agent_events::exists(report)
            && !crate::agent_events::accepts_context(report, value["session_id"].as_str())?
        {
            return Ok(());
        }
        let temporary =
            report.with_extension(format!("{}.tmp", hex::encode(crate::wire::random::<8>())));
        crate::private_write(&temporary, &serde_json::to_vec(&context)?)?;
        let result = std::fs::rename(&temporary, report);
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
    }
    Ok(())
}
/// Only lifecycle metadata is persisted; never prompts or tool arguments.
#[derive(Serialize, Deserialize)]
pub struct LifecycleReport {
    pub state: crate::status::StatusState,
    pub sequence: u64,
}
fn lifecycle_state(value: &Value) -> Option<crate::status::StatusState> {
    use crate::status::StatusState::*;
    // A subagent finishing must not mark the owning conversation idle.
    if is_child(value) {
        return None;
    }
    Some(match value["hook_event_name"].as_str()? {
        "SessionStart" if value["source"] == "compact" => Working,
        "SessionStart" | "Stop" => Idle,
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" => Working,
        "PreToolUse" if value["tool_name"] == "AskUserQuestion" => Question,
        "PreToolUse" => Working,
        "PermissionRequest" => Blocked,
        "StopFailure" if value["error"] == "rate_limit" => Blocked,
        "StopFailure" => Failed,
        "Notification" => match value["notification_type"].as_str()? {
            "permission_prompt" => Blocked,
            "elicitation_dialog" => Question,
            "idle_prompt" => Idle,
            _ => return None,
        },
        _ => return None,
    })
}
pub(crate) fn is_child(value: &Value) -> bool {
    match value.get("agent_id") {
        None | Some(Value::Null) => false,
        Some(Value::String(id)) => !id.is_empty(),
        Some(_) => true,
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub outcome: &'static str,
    pub helper_error: bool,
}
impl Default for Delivery {
    fn default() -> Self {
        Self {
            outcome: "notObserved",
            helper_error: false,
        }
    }
}
pub struct Observation {
    pub report: Option<LifecycleReport>,
    pub delivery: Delivery,
}
pub async fn observe(report: &Path) -> Observation {
    use tokio::io::AsyncReadExt;
    let helper_error = tokio::fs::try_exists(report.with_file_name("diagnostic.json"))
        .await
        .unwrap_or(false);
    let (report, outcome) = match tokio::fs::File::open(report.with_file_name("status.json")).await
    {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, "missing"),
        Err(_) => (None, "unreadable"),
        Ok(file) => {
            let mut bytes = Vec::new();
            match file.take(1025).read_to_end(&mut bytes).await {
                Err(_) => (None, "unreadable"),
                Ok(_) if bytes.len() > 1024 => (None, "oversized"),
                Ok(_) => match serde_json::from_slice(&bytes) {
                    Ok(report) => (Some(report), "received"),
                    Err(_) => (None, "malformed"),
                },
            }
        }
    };
    Observation {
        report,
        delivery: Delivery {
            outcome,
            helper_error,
        },
    }
}
#[cfg(test)]
async fn read_lifecycle(report: &Path) -> Option<LifecycleReport> {
    observe(report).await.report
}

pub async fn resolve(fallback: PathBuf, report: Option<PathBuf>) -> Context {
    if let Some(report) = report {
        // Reports contain only two bounded strings, never the original hook payload.
        if let Ok(file) = tokio::fs::File::open(report).await {
            use tokio::io::AsyncReadExt;
            let mut bytes = Vec::new();
            if file.take(8193).read_to_end(&mut bytes).await.is_ok()
                && bytes.len() <= 8192
                && let Ok(context) = serde_json::from_slice::<Context>(&bytes)
                && context.directory.is_absolute()
            {
                return context;
            }
        }
    }
    Context {
        directory: fallback,
        source: "Auto: launch folder".into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn harness_recovery_appends_only_a_launch_local_startup_hook_without_replacing_lifecycle() {
        let mut command = CommandBuilder::new("fixture");
        let recovery = json!({"type":"command","command":"literal native client","args":["--pairing","private context.json","run","recover-hook"],"timeout":3});
        let tracker = Tracker::install_harness(
            &mut command,
            "host-session",
            recovery.clone(),
            vec!["mcp__nesvo__nesvo_get_session".into()],
        )
        .unwrap();
        assert_eq!(tracker.adapter(), "claude-hooks-v4");
        let argv = command.get_argv();
        let index = argv.iter().position(|arg| arg == "--settings").unwrap();
        assert_eq!(argv.iter().filter(|arg| *arg == "--settings").count(), 1);
        let settings: Value = serde_json::from_str(argv[index + 1].to_str().unwrap()).unwrap();
        let startup = settings["hooks"]["SessionStart"][0]["hooks"]
            .as_array()
            .unwrap();
        assert_eq!(startup.len(), 2);
        assert_eq!(startup[1], recovery);
        assert_eq!(
            settings["permissions"]["allow"],
            json!(["mcp__nesvo__nesvo_get_session"])
        );
        assert_eq!(
            startup[0],
            settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]
        );
        assert_eq!(
            settings["hooks"]["UserPromptSubmit"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn claude_paste_envelope_is_separate_private_evidence_not_general_prompt_rewriting() {
        let mut command = CommandBuilder::new("claude");
        let tracker = Tracker::install_for(&mut command, "host-session").unwrap();
        assert_eq!(tracker.adapter(), "claude-hooks-v3");
        let text =
            "literal owner context\nDo not lose this rule.\n\nTask instruction:\nReply only.";
        let prompt =
            format!("\n\n<pasted_content id=\"f558\">\n{text}\n</pasted_content id=\"f558\">\n");
        receive_from(&tracker.report(), json!({"hook_event_name":"UserPromptSubmit","session_id":"conversation","prompt":prompt}).to_string().as_bytes()).unwrap();
        let batch = crate::agent_events::read(&tracker.report(), "host-session", 0).unwrap();
        assert_eq!(
            batch.events[0].prompt_digest,
            crate::submission::digest(&prompt)
        );
        assert_eq!(
            batch.events[0].paste_digest,
            crate::submission::digest(text)
        );
        assert_ne!(batch.events[0].paste_digest, batch.events[0].prompt_digest);
        let maximum = "x".repeat(8192);
        let prompt =
            format!("<pasted_content id=\"f558\">\n{maximum}\n</pasted_content id=\"f558\">");
        receive_from(&tracker.report(),json!({"hook_event_name":"UserPromptSubmit","session_id":"conversation","prompt":prompt}).to_string().as_bytes()).unwrap();
        let batch = crate::agent_events::read(&tracker.report(), "host-session", 0).unwrap();
        assert!(batch.events[1].prompt_digest.is_none());
        assert_eq!(
            batch.events[1].paste_digest,
            crate::submission::digest(&maximum)
        );
        let stored = std::fs::read(tracker.report().with_file_name("events.sqlite3")).unwrap();
        assert!(!String::from_utf8_lossy(&stored).contains("literal owner context"));
        assert!(!String::from_utf8_lossy(&stored).contains("pasted_content"));
    }
    #[test]
    fn empty_agent_id_is_root_but_children_cannot_change_parent_context() {
        assert_eq!(
            lifecycle_state(&json!({"hook_event_name":"Stop","agent_id":""})),
            Some(crate::status::StatusState::Idle)
        );
        let mut command = CommandBuilder::new("claude");
        let tracker = Tracker::install_for(&mut command, "host-session").unwrap();
        for value in [
            json!({"hook_event_name":"SessionStart","session_id":"conversation-a","source":"startup","agent_id":""}),
            json!({"hook_event_name":"UserPromptSubmit","session_id":"conversation-a"}),
            json!({"hook_event_name":"Stop","session_id":"conversation-a","agent_id":"child"}),
            json!({"hook_event_name":"CwdChanged","session_id":"conversation-a","agent_id":"child","new_cwd":tracker.0}),
            json!({"hook_event_name":"CwdChanged","session_id":"old-conversation","new_cwd":tracker.0}),
            json!({"hook_event_name":"Stop","session_id":"conversation-a","agent_id":""}),
        ] {
            receive_from(&tracker.report(), value.to_string().as_bytes()).unwrap();
        }
        let batch = crate::agent_events::read(&tracker.report(), "host-session", 0).unwrap();
        assert_eq!(batch.events.len(), 3);
        assert_eq!(
            batch.identity.provider_session_id.as_deref(),
            Some("conversation-a")
        );
        assert!(
            !tracker.report().exists(),
            "child directory signals cannot change the parent review context"
        );
    }
    #[tokio::test]
    async fn diagnostics_distinguish_missing_bad_and_received_reports_without_payloads() {
        let mut command = CommandBuilder::new("claude");
        let tracker = Tracker::install(&mut command).unwrap();
        assert_eq!(observe(&tracker.report()).await.delivery.outcome, "missing");
        let path = tracker.report().with_file_name("status.json");
        std::fs::write(&path, "{PRIVATE INVALID PAYLOAD").unwrap();
        let observation = observe(&tracker.report()).await;
        assert_eq!(observation.delivery.outcome, "malformed");
        assert!(
            !serde_json::to_string(&observation.delivery)
                .unwrap()
                .contains("PRIVATE")
        );
        std::fs::write(&path, "x".repeat(1025)).unwrap();
        assert_eq!(
            observe(&tracker.report()).await.delivery.outcome,
            "oversized"
        );
        receive_from(
            &tracker.report(),
            br#"{"hook_event_name":"SessionStart"}"#.as_slice(),
        )
        .unwrap();
        assert_eq!(
            observe(&tracker.report()).await.delivery.outcome,
            "received"
        );
    }
    #[tokio::test]
    async fn lifecycle_events_store_only_state_and_ignore_subagents() {
        use crate::status::StatusState::*;
        let mut command = CommandBuilder::new("claude");
        let tracker = Tracker::install(&mut command).unwrap();
        let settings: Value =
            serde_json::from_str(&command.get_argv()[2].to_string_lossy()).unwrap();
        for (event, expected) in [
            ("SessionStart", Idle),
            ("UserPromptSubmit", Working),
            ("PermissionRequest", Blocked),
            ("PostToolUse", Working),
            ("Stop", Idle),
            ("StopFailure", Failed),
        ] {
            assert!(settings["hooks"][event].is_array());
            receive_from(
                &tracker.report(),
                json!({"hook_event_name":event,"prompt":"SECRET"})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            assert_eq!(
                read_lifecycle(&tracker.report()).await.unwrap().state,
                expected
            );
        }
        receive_from(
            &tracker.report(),
            br#"{"hook_event_name":"Stop","agent_id":"child"}"#.as_slice(),
        )
        .unwrap();
        assert_eq!(
            read_lifecycle(&tracker.report()).await.unwrap().state,
            Failed
        );
        let bytes =
            std::fs::read_to_string(tracker.report().with_file_name("status.json")).unwrap();
        assert!(!bytes.contains("SECRET"));
        assert!(
            lifecycle_state(
                &json!({"hook_event_name":"Notification","notification_type":"auth_success"})
            )
            .is_none()
        );
        assert_eq!(
            lifecycle_state(&json!({"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"})),
            Some(Question)
        );
    }

    #[test]
    fn edited_file_and_cwd_are_explicit_signals() {
        let root = std::env::temp_dir();
        let context = extract(&json!({"hook_event_name":"PostToolUse", "tool_name":"Edit", "tool_input":{"file_path":root.join("repo/file.rs")}})).unwrap();
        assert_eq!(context.directory, root.join("repo"));
        assert!(extract(&json!({"hook_event_name":"PostToolUse", "tool_name":"Bash", "tool_input":{"command":"cd other"}})).is_none());
        assert!(extract(&json!({"hook_event_name":"CwdChanged", "new_cwd":"relative"})).is_none());
        assert_eq!(
            extract(&json!({"hook_event_name":"CwdChanged", "new_cwd":root}))
                .unwrap()
                .directory,
            root
        );
    }
    #[test]
    fn settings_precede_prompt_and_are_session_scoped() {
        let mut command = CommandBuilder::new("claude");
        command.args(["--", "hello"]);
        let tracker = Tracker::install(&mut command).unwrap();
        assert_eq!(command.get_argv()[1], "--settings");
        assert_eq!(command.get_argv()[3], "--");
        let directory = tracker.0.clone();
        drop(tracker);
        assert!(!directory.exists());
    }
    #[tokio::test]
    async fn reports_replace_atomically_and_follow_external_repository() {
        let mut command = CommandBuilder::new("claude");
        let tracker = Tracker::install(&mut command).unwrap();
        let root = tracker.0.join("external");
        std::fs::create_dir(&root).unwrap();
        let status = tokio::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(&root)
            .status()
            .await
            .unwrap();
        assert!(status.success());
        std::fs::write(root.join("changed.txt"), "hello").unwrap();
        let fallback = tracker.0.join("launch");
        assert_eq!(
            resolve(fallback.clone(), Some(tracker.report()))
                .await
                .directory,
            fallback
        );
        for event in [
            json!({"hook_event_name":"CwdChanged", "new_cwd":fallback}),
            json!({"hook_event_name":"PostToolUse", "tool_name":"Write", "tool_input":{"file_path":root.join("changed.txt"), "content":"SECRET NOT STORED"}}),
        ] {
            receive_from(&tracker.report(), event.to_string().as_bytes()).unwrap();
        }
        let context = resolve(fallback, Some(tracker.report())).await;
        assert_eq!(context.directory, root);
        let report = std::fs::read_to_string(tracker.report()).unwrap();
        assert!(!report.contains("SECRET"));
        let diff = crate::git::review(&context.directory, "untracked")
            .await
            .unwrap();
        assert_eq!(diff.files[0].path, "changed.txt");
        receive_from(&tracker.report(), b"{invalid".as_slice()).unwrap_err();
        assert_eq!(std::fs::read_to_string(tracker.report()).unwrap(), report);
    }
}
