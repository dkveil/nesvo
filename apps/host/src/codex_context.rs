//! Codex 0.156 native hook adapter. No transcript parsing or global config writes.
use anyhow::{Result, ensure};
use portable_pty::CommandBuilder;
use serde_json::Value;
use std::path::Path;

pub fn supported(version: &str) -> bool {
    version.split(['-', '+']).next() == Some("0.156.0")
}

pub fn configure(command: &mut CommandBuilder, report: &Path) -> Result<()> {
    let executable = std::env::current_exe()?;
    let command_text = helper_command(&crate::process::display_path(&executable));
    let handler = format!(
        "{{type=\"command\",command={},timeout=3}}",
        serde_json::to_string(&command_text)?
    );
    let hooks = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
        "Interrupt",
    ]
    .into_iter()
    .map(|event| format!("{event}=[{{hooks=[{handler}]}}]"))
    .collect::<Vec<_>>()
    .join(",");
    command.env("NESVO_LIFECYCLE_REPORT", report);
    let argv = command.get_argv_mut();
    let index = argv
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(argv.len());
    // A separate local executor keeps another app-server's environment from
    // owning this process's hook path. Login and approval policy stay native.
    argv.splice(
        index..index,
        [
            "--no-daemon".into(),
            "-c".into(),
            format!("hooks={{{hooks}}}").into(),
        ],
    );
    Ok(())
}

fn helper_command(executable: &str) -> String {
    #[cfg(windows)]
    {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let script = format!(
            "& '{}' --codex-context-hook",
            executable.replace('\'', "''")
        );
        let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(bytes)
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "'{}' --codex-context-hook",
            executable.replace('\'', "'\\''")
        )
    }
}

pub fn state(value: &Value) -> Result<Option<crate::status::StatusState>> {
    use crate::status::StatusState::*;
    if crate::agent_context::is_child(value) {
        return Ok(None);
    }
    let Some(event) = value["hook_event_name"].as_str() else {
        return Ok(None);
    };
    let state = match event {
        "SessionStart" if value["source"] == "compact" => Working,
        "SessionStart" | "Stop" | "Interrupt" => Idle,
        "UserPromptSubmit" | "PostToolUse" => Working,
        "PreToolUse" if value["tool_name"] == "request_user_input" => Question,
        "PreToolUse" => Working,
        "PermissionRequest" => Blocked,
        _ => return Ok(None),
    };
    ensure!(
        value["session_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "Missing native Codex session identity"
    );
    if event != "SessionStart" {
        ensure!(
            value["turn_id"].as_str().is_some_and(|id| !id.is_empty()),
            "Missing native Codex turn identity"
        );
    }
    Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    #[ignore = "requires installed Codex CLI; reads config/features only, no model or hook execution"]
    async fn installed_cli_parses_the_generated_inline_config_without_running_hooks() {
        let mut launcher = CommandBuilder::new("codex");
        configure(&mut launcher, Path::new("unused parser-only report")).unwrap();
        let config = &launcher.get_argv()[3];
        let mut probe = tokio::process::Command::new(
            std::env::var_os("NESVO_CODEX_BINARY").unwrap_or_else(|| "codex".into()),
        );
        probe
            .args([
                std::ffi::OsStr::new("-c"),
                config.as_os_str(),
                std::ffi::OsStr::new("features"),
                std::ffi::OsStr::new("list"),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        probe.creation_flags(0x08000000);
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), probe.status())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.success(),
            "Installed CLI rejected generated hook configuration"
        );
    }
    #[test]
    fn root_native_turns_are_required_and_child_hooks_cannot_change_parent() {
        assert!(supported("0.156.0"));
        assert!(!supported("0.155.0"));
        assert!(!supported("0.157.0"));
        assert_eq!(
            state(&json!({"hook_event_name":"SessionStart","session_id":"root"})).unwrap(),
            Some(crate::status::StatusState::Idle)
        );
        assert_eq!(
            state(
                &json!({"hook_event_name":"SessionStart","session_id":"root","source":"compact"})
            )
            .unwrap(),
            Some(crate::status::StatusState::Working)
        );
        assert!(state(&json!({"hook_event_name":"Stop","session_id":"root"})).is_err());
        assert_eq!(state(&json!({"hook_event_name":"Stop","session_id":"root","turn_id":"turn","agent_id":"child"})).unwrap(),None);
        assert_eq!(
            state(
                &json!({"hook_event_name":"SubagentStop","session_id":"root","agent_id":"child"})
            )
            .unwrap(),
            None
        );
        assert_eq!(state(&json!({"hook_event_name":"PreToolUse","tool_name":"request_user_input","session_id":"root","turn_id":"turn"})).unwrap(),Some(crate::status::StatusState::Question));
        assert_eq!(
            state(&json!({"hook_event_name":"Interrupt","session_id":"root","turn_id":"turn"}))
                .unwrap(),
            Some(crate::status::StatusState::Idle)
        );
    }
    #[test]
    fn session_config_preserves_literal_prompt_and_never_bypasses_hook_trust() {
        let mut command = CommandBuilder::new("codex");
        command.args(["resume", "--", "literal hooks={} ; x"]);
        configure(&mut command, Path::new("unused owned report")).unwrap();
        assert_eq!(command.get_argv().last().unwrap(), "literal hooks={} ; x");
        assert_eq!(command.get_argv()[2], "--no-daemon");
        assert!(
            !command
                .get_argv()
                .iter()
                .any(|arg| arg.to_string_lossy().contains("bypass"))
        );
        let config = command.get_argv()[4].to_string_lossy();
        assert!(config.starts_with("hooks={SessionStart="));
        assert!(
            !config.contains("unused owned report"),
            "trust definition must not include an ephemeral report path"
        );
    }
}
