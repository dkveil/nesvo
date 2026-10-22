use clap::Args;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Launch {
    pub id: String,
    #[arg(long)]
    task: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    revision: u64,
    #[arg(long)]
    program: Program,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    cwd: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long, requires = "model")]
    effort: Option<String>,
    /// Owner-only explicit Claude display manifest; does not change global settings.
    #[arg(long)]
    claude_quota_display_profile: Option<String>,
    /// Explicitly share the existing checkout with other workers.
    #[arg(
        long,
        required_unless_present = "worktree",
        conflicts_with = "worktree"
    )]
    shared: bool,
    /// Create an isolated worktree before starting this worker.
    #[arg(long)]
    worktree: bool,
    #[arg(long, conflicts_with = "no_harness")]
    harness: bool,
    #[arg(long, conflicts_with = "harness")]
    no_harness: bool,
    /// Exact native tool additions: an owner selection or a coordinator-policy subset.
    #[arg(long = "allow-nesvo-tool", conflicts_with = "clear_nesvo_tools")]
    allowed_nesvo_tools: Vec<String>,
    /// Select no native additions, overriding the coordinator's child default.
    #[arg(long, conflicts_with = "allowed_nesvo_tools")]
    clear_nesvo_tools: bool,
    #[arg(long)]
    pub json: bool,
}
impl Launch {
    pub fn request(self) -> Request {
        Request {
            key: self.key,
            run_id: self.id,
            task_id: self.task,
            expected_revision: self.revision,
            profile: Profile {
                name: self.name,
                cwd: self.cwd,
                model: self.model,
                effort: self.effort,
                claude_quota_capture: self
                    .claude_quota_display_profile
                    .map(|display_profile| Capture { display_profile }),
                allowed_nesvo_tools: if self.clear_nesvo_tools {
                    Some(Vec::new())
                } else if self.allowed_nesvo_tools.is_empty() {
                    None
                } else {
                    Some(self.allowed_nesvo_tools)
                },
                program: self.program,
                workspace: if self.worktree {
                    Workspace::Worktree
                } else {
                    Workspace::Shared
                },
                harness: if self.harness {
                    Some(true)
                } else if self.no_harness {
                    Some(false)
                } else {
                    None
                },
            },
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Workspace {
    Shared,
    Worktree,
}
#[derive(Clone, Copy, clap::ValueEnum, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Program {
    Shell,
    Claude,
    Codex,
    Gemini,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Capture {
    pub display_profile: String,
}
fn deserialize_capture<'de, D>(deserializer: D) -> Result<Option<Capture>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Capture::deserialize(deserializer).map(Some)
}
pub(crate) fn valid_capture(value: &serde_json::Value, program: &serde_json::Value) -> bool {
    let Ok(capture) = serde_json::from_value::<Capture>(value.clone()) else {
        return false;
    };
    let path = capture.display_profile;
    let windows_absolute = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path
            .as_bytes()
            .get(2)
            .is_some_and(|byte| matches!(*byte, b'/' | b'\\'));
    program == "claude"
        && !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && (path.starts_with('/') || path.starts_with("\\\\") || windows_absolute)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_capture"
    )]
    claude_quota_capture: Option<Capture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allowed_nesvo_tools: Option<Vec<String>>,
    name: Option<String>,
    cwd: Option<String>,
    program: Program,
    workspace: Workspace,
    harness: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    key: String,
    run_id: String,
    task_id: String,
    expected_revision: u64,
    profile: Profile,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::json;

    #[derive(Parser)]
    struct Arguments {
        #[command(flatten)]
        launch: Launch,
    }
    #[test]
    fn capture_is_explicit_strict_and_uses_host_absolute_path_syntax() {
        for path in [
            "/owner/display.json",
            "C:/Owner/display.json",
            "C:\\Owner\\display.json",
        ] {
            assert!(valid_capture(
                &json!({"displayProfile":path}),
                &json!("claude")
            ));
            assert!(!valid_capture(
                &json!({"displayProfile":path}),
                &json!("codex")
            ));
        }
        for capture in [
            json!({}),
            json!({"displayProfile":"relative.json"}),
            json!({"displayProfile":"/valid","shell":"extra"}),
            json!({"displayProfile":null}),
        ] {
            assert!(!valid_capture(&capture, &json!("claude")));
        }
    }
    #[test]
    fn task_tool_flags_distinguish_defaults_empty_and_exact_selection() {
        let base = [
            "launch",
            "run",
            "--task",
            "task",
            "--key",
            "k",
            "--revision",
            "1",
            "--program",
            "claude",
            "--shared",
        ];
        let parse = |extra: &[&str]| {
            Arguments::try_parse_from(base.into_iter().chain(extra.iter().copied()))
                .map(|a| serde_json::to_value(a.launch.request()).unwrap())
        };
        assert!(
            parse(&[]).unwrap()["profile"]
                .get("allowedNesvoTools")
                .is_none()
        );
        assert_eq!(
            parse(&["--clear-nesvo-tools"]).unwrap()["profile"]["allowedNesvoTools"],
            json!([])
        );
        assert_eq!(
            parse(&[
                "--allow-nesvo-tool",
                "nesvo_get_current_task",
                "--allow-nesvo-tool",
                "nesvo_report_task_result"
            ])
            .unwrap()["profile"]["allowedNesvoTools"],
            json!(["nesvo_get_current_task", "nesvo_report_task_result"])
        );
        assert!(
            parse(&[
                "--clear-nesvo-tools",
                "--allow-nesvo-tool",
                "nesvo_get_current_task"
            ])
            .is_err()
        );
    }
}
