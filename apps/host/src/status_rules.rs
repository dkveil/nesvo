//! Versioned literal current-screen rules. No regex code, shell or file I/O.
use crate::{launchers::Program, status::StatusState};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    revision: String,
    rules: Vec<Rule>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Visible,
    Tail,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rule {
    id: String,
    program: Option<Program>,
    state: StatusState,
    reason: String,
    scope: Scope,
    #[serde(default)]
    all: Vec<String>,
    #[serde(default)]
    any: Vec<String>,
    #[serde(default)]
    prefix_any: Vec<String>,
    #[serde(default)]
    choices_all: Vec<String>,
    #[serde(default)]
    choices_any: Vec<String>,
    #[serde(default)]
    footer_all: Vec<String>,
    #[serde(default)]
    footer_any: Vec<String>,
    cursor_prompt: Option<char>,
}

#[derive(Clone, Copy, Serialize)]
pub struct Match {
    pub state: StatusState,
    pub rule: &'static str,
    pub reason: &'static str,
    pub revision: &'static str,
}
impl Catalog {
    fn load(source: &str) -> Result<Self, String> {
        let value: Self = serde_json::from_str(source).map_err(|e| e.to_string())?;
        if value.schema_version != 1
            || value.revision.is_empty()
            || value.revision.len() > 64
            || value.rules.len() > 64
        {
            return Err("Unsupported status catalog".into());
        }
        let mut ids = HashSet::new();
        for rule in &value.rules {
            let lists = [
                &rule.all,
                &rule.any,
                &rule.prefix_any,
                &rule.choices_all,
                &rule.choices_any,
                &rule.footer_all,
                &rule.footer_any,
            ];
            if !ids.insert(&rule.id)
                || rule.id.is_empty()
                || rule.id.len() > 80
                || !rule
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
                || rule.reason.len() > 64
                || !matches!(
                    rule.state,
                    StatusState::Working
                        | StatusState::Idle
                        | StatusState::Blocked
                        | StatusState::Question
                )
                || lists.iter().all(|list| list.is_empty())
                || lists.iter().any(|list| {
                    list.len() > 12
                        || list.iter().any(|s| {
                            s.is_empty() || s.len() > 256 || s.chars().any(char::is_control)
                        })
                })
            {
                return Err("Invalid status rule".into());
            }
        }
        Ok(value)
    }
}
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        Catalog::load(include_str!("../status-rules/v1.json"))
            .expect("Embedded status rules are validated by tests")
    })
}
fn normalized(line: &str) -> &str {
    line.trim_matches(|c: char| c.is_whitespace() || matches!(c, '│' | '┃' | '║'))
}
fn choice(line: &str) -> &str {
    let line = line.trim_start_matches(['›', '❯', '>', '●', '○', ' ']);
    line.split_once(". ")
        .filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        .map_or(line, |(_, s)| s)
}
pub fn detect(program: Program, screen: &vt100::Screen) -> Option<Match> {
    if program == Program::Shell {
        return None;
    }
    let text = screen.contents().to_lowercase();
    let lines: Vec<_> = text
        .lines()
        .map(normalized)
        .filter(|s| !s.is_empty())
        .collect();
    let tail = &lines[lines.len().saturating_sub(12)..];
    let footer = &tail[tail.len().saturating_sub(3)..];
    for rule in &catalog().rules {
        if rule.program.is_some_and(|p| p != program) {
            continue;
        }
        let rows = match rule.scope {
            Scope::Visible => lines.as_slice(),
            Scope::Tail => tail,
        };
        let joined = rows.join(" ");
        let footer_text = footer.join(" ");
        let cursor_matches = rule.cursor_prompt.is_none_or(|marker| {
            let (row, _) = screen.cursor_position();
            let (_, cols) = screen.size();
            !screen.hide_cursor()
                && screen
                    .rows(0, cols)
                    .nth(usize::from(row))
                    .is_some_and(|s| s.trim_start().starts_with(marker))
        });
        if rule.all.iter().all(|s| joined.contains(s))
            && (rule.any.is_empty() || rule.any.iter().any(|s| joined.contains(s)))
            && (rule.prefix_any.is_empty()
                || rows.iter().any(|line| {
                    rule.prefix_any
                        .iter()
                        .any(|s| line.trim_start_matches(['•', '!', '●', ' ']).starts_with(s))
                }))
            && rule
                .choices_all
                .iter()
                .all(|s| rows.iter().any(|line| choice(line) == s))
            && (rule.choices_any.is_empty()
                || rule
                    .choices_any
                    .iter()
                    .any(|s| rows.iter().any(|line| choice(line) == s)))
            && rule.footer_all.iter().all(|s| footer_text.contains(s))
            && (rule.footer_any.is_empty()
                || rule.footer_any.iter().any(|s| footer_text.contains(s)))
            && cursor_matches
        {
            return Some(Match {
                state: rule.state,
                rule: &rule.id,
                reason: &rule.reason,
                revision: &catalog().revision,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_catalog_is_valid_and_never_turns_unknown_into_success() {
        let c = Catalog::load(include_str!("../status-rules/v1.json")).unwrap();
        assert!(c.rules.len() >= 8);
        assert!(Catalog::load(r#"{"schemaVersion":2,"revision":"a","rules":[]}"#).is_err());
    }
    #[test]
    fn real_startup_consent_shapes_are_blockers_and_cleared_scrollback_is_not() {
        for (text, id) in [
            (
                "Accessing workspace: FIXTURE\r\nQuick safety check:\r\n❯ No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel",
                "claude_trust_v1",
            ),
            (
                "New MCP server found in this project: fixture\r\nMCP servers may execute code or access system resources.\r\nUse this MCP server\r\n❯ Continue without using this MCP server\r\nEnter to confirm · Esc to cancel",
                "claude_mcp_consent_v1",
            ),
        ] {
            let mut p = vt100::Parser::new(32, 100, 0);
            p.process(text.as_bytes());
            assert_eq!(detect(Program::Claude, p.screen()).unwrap().rule, id);
            assert!(detect(Program::Shell, p.screen()).is_none());
            p.process(b"\x1b[2J\x1b[Hordinary text");
            assert!(detect(Program::Claude, p.screen()).is_none());
        }
    }

    const GEMINI_065_SYNTHESIZED_SCREENS: [(&str, &str, StatusState, &str); 7] = [
        (
            "╭──────────────────────────────────────╮\r\n│ ?  Shell  echo fixture                │\r\n│ ╭──────────────╮                      │\r\n│ │ echo fixture │                      │\r\n│ ╰──────────────╯                      │\r\n│ Allow execution of [Shell]?           │\r\n│                                       │\r\n│ ● 1. Allow once                       │\r\n│   2. Allow for this session           │\r\n│   3. No, suggest changes (esc)        │\r\n╰──────────────────────────────────────╯\r\n ~/fixture      no sandbox      auto",
            "gemini_permission_v",
            StatusState::Blocked,
            "permission",
        ),
        (
            "│ ?  WriteFile  fixture.txt              │\r\n│ 1 + fixture line                       │\r\n│ Apply this change?                     │\r\n│ ● 1. Allow once                        │\r\n│   2. Allow for this session            │\r\n│   3. Modify with external editor       │\r\n│   4. No, suggest changes (esc)         │\r\n ~/fixture      no sandbox      auto",
            "gemini_permission_v2",
            StatusState::Blocked,
            "permission",
        ),
        (
            "│ ?  WebFetch  https://example.invalid   │\r\n│ Do you want to proceed?                │\r\n│ ● 1. Allow once                        │\r\n│   2. No, suggest changes (esc)         │\r\n ~/fixture      no sandbox      auto",
            "gemini_permission_v2",
            StatusState::Blocked,
            "permission",
        ),
        (
            "╭──────────────────────────────────────────────╮\r\n│ Do you trust the files in this folder?       │\r\n│ ● 1. Trust folder (fixture)                  │\r\n│   2. Trust parent folder (dev)               │\r\n│   3. Don't trust                             │\r\n╰──────────────────────────────────────────────╯",
            "gemini_trust_v1",
            StatusState::Blocked,
            "folder trust",
        ),
        (
            "╭──────────────────────────────────────────────────────────╮\r\n│ ? Get started                                            │\r\n│ How would you like to authenticate for this project?     │\r\n│ ● 1. Sign in with Google                                 │\r\n│   2. Use Gemini API Key                                  │\r\n│   3. Vertex AI                                           │\r\n│ (Use Enter to select)                                    │\r\n│ Terms of Services and Privacy Notice for Gemini CLI      │\r\n│ https://geminicli.com/docs/resources/tos-privacy/        │\r\n╰──────────────────────────────────────────────────────────╯",
            "gemini_login_v1",
            StatusState::Blocked,
            "login",
        ),
        (
            "╭──────────────────────────────────────────────────────────────────╮\r\n│ ⠋ Waiting for authentication... (Press Esc or Ctrl+C to cancel) │\r\n╰──────────────────────────────────────────────────────────────────╯",
            "gemini_login_wait_v1",
            StatusState::Blocked,
            "login",
        ),
        (
            "╭──────────────────────────────────────────────────────────────────────╮\r\n│ Select Model                                                         │\r\n│ ● 1. Auto                                                            │\r\n│   2. Manual                                                          │\r\n│ Remember model for future sessions: false (Press Tab to toggle)      │\r\n│ > To use a specific Gemini model on startup, use the --model flag.   │\r\n│ (Press Esc to close)                                                 │\r\n╰──────────────────────────────────────────────────────────────────────╯",
            "gemini_model_selection_v1",
            StatusState::Question,
            "model selection",
        ),
    ];

    #[test]
    fn gemini_065_synthesized_login_model_trust_and_approval_screens_match_named_rules() {
        for (text, id, state, reason) in GEMINI_065_SYNTHESIZED_SCREENS {
            let mut p = vt100::Parser::new(32, 100, 0);
            p.process(text.as_bytes());
            let matched = detect(Program::Gemini, p.screen()).unwrap_or_else(|| panic!("{id}"));
            assert!(matched.rule.starts_with(id), "{} for {id}", matched.rule);
            assert_eq!((matched.state, matched.reason), (state, reason));
            assert_eq!(matched.revision, "2026-10-21.1");
            assert!(
                detect(Program::Claude, p.screen()).is_none_or(|m| !m.rule.starts_with("gemini_"))
            );
            p.process(b"\x1b[2J\x1b[Hordinary text");
            assert!(detect(Program::Gemini, p.screen()).is_none());
        }
        for partial in [
            "The model said: Select Model is a dialog.",
            "Allow execution of [Shell]?\r\n● 1. Allow once",
            "How would you like to authenticate for this project?",
            "Do you trust the files in this folder?",
        ] {
            let mut p = vt100::Parser::new(32, 100, 0);
            p.process(partial.as_bytes());
            assert!(detect(Program::Gemini, p.screen()).is_none(), "{partial}");
        }
    }
}
