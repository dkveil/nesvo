//! Launch-scoped Claude hooks. Never store prompts, output, or transcript contents.
use anyhow::Result;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub struct Tracker(PathBuf);
impl Tracker {
    pub fn install(command: &mut CommandBuilder) -> Result<Self> {
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
        let tracker = Self(directory);
        let hook = json!({"type":"command", "command": std::env::current_exe()?,
            "args":["--agent-context-hook", tracker.report()], "timeout":3});
        let settings = json!({"hooks": {
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
        }})
        .to_string();
        // Insert before any prompt separator, preserving launcher and resume arguments.
        let argv = command.get_argv_mut();
        let index = argv
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(argv.len());
        argv.splice(index..index, ["--settings".into(), settings.into()]);
        Ok(tracker)
    }
    pub fn report(&self) -> PathBuf {
        self.0.join("context.json")
    }
}
impl Drop for Tracker {
    fn drop(&mut self) {
        // Only this randomly allocated session directory is owned by the tracker.
        let _ = std::fs::remove_dir_all(&self.0);
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
    let result = receive_from(report, std::io::stdin());
    let diagnostic = report.with_file_name("diagnostic.json");
    if result.is_err() {
        // Constant metadata only: serde errors can contain supplied payload text.
        let _ = crate::private_write(&diagnostic, br#"{"code":"hook_receive_failed"}"#);
    } else if diagnostic.exists() {
        let _ = std::fs::remove_file(diagnostic);
    }
    result
}
fn receive_from(report: &Path, input: impl Read) -> Result<()> {
    let mut bytes = Vec::new();
    input.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if let Some(state) = lifecycle_state(&value) {
        let status = LifecycleReport {
            state,
            sequence: chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
                .max(0) as u64,
        };
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
    if let Some(context) = extract(&value) {
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
    if value.get("agent_id").and_then(Value::as_str).is_some() {
        return None;
    }
    Some(match value["hook_event_name"].as_str()? {
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
