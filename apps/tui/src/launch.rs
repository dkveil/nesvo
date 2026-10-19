//! Session launch choices and form editing; no filesystem or process detection.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    #[default]
    Shell,
    Claude,
    Gemini,
    Codex,
}

impl Program {
    pub const ALL: [Self; 4] = [Self::Shell, Self::Claude, Self::Gemini, Self::Codex];

    /// Portable marks, not private-use font glyphs. ASCII is an explicit fallback.
    pub fn icon(self, ascii: bool) -> &'static str {
        match (self, ascii) {
            (Self::Claude, false) => "✳",
            (Self::Codex, false) => "◈",
            (Self::Gemini, false) => "✦",
            (Self::Shell, _) => ">",
            (Self::Claude, true) => "C",
            (Self::Codex, true) => "O",
            (Self::Gemini, true) => "G",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Shell => "Terminal",
            Self::Claude => "Claude",
            Self::Gemini => "Gemini",
            Self::Codex => "Codex",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ProgramCapability {
    pub id: Program,
    pub available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percent: u8,
    pub duration_mins: u32,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderLimit {
    pub id: Program,
    pub status: String,
    pub windows: Vec<LimitWindow>,
}

#[derive(Default, Debug, Deserialize)]
pub struct Capabilities {
    pub workspace: String,
    pub programs: Vec<ProgramCapability>,
    #[serde(default, rename = "directoryBrowser")]
    pub directory_browser: bool,
    #[serde(default, rename = "gitDiff")]
    pub git_diff: bool,
    #[serde(default, rename = "advancedLaunch")]
    pub advanced_launch: bool,
    #[serde(default)]
    pub schedules: bool,
    #[serde(default)]
    pub attention: bool,
    #[serde(default)]
    pub templates: bool,
    #[serde(default)]
    pub recovery: bool,
    #[serde(default, rename = "quotaWake")]
    pub quota_wake: bool,
    #[serde(default, rename = "providerLimits")]
    pub provider_limits: Vec<ProviderLimit>,
}

impl Capabilities {
    pub fn available(&self, program: Program) -> bool {
        self.programs
            .iter()
            .any(|item| item.id == program && item.available)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Field {
    #[default]
    Name,
    Directory,
    Program,
    Worktree,
    Prompt,
    When,
}

#[derive(Clone, Default)]
pub struct SessionForm {
    pub advanced: bool,
    pub worktree: bool,
    pub prompt: String,
    pub when: String,
    pub name: String,
    pub cwd: String,
    pub program: Program,
    pub field: Field,
    pub group_id: Option<String>,
}

impl SessionForm {
    pub fn cycle_program(&mut self, backward: bool) {
        let position = Program::ALL
            .iter()
            .position(|item| item == &self.program)
            .unwrap_or(0);
        let next = (position + if backward { 3 } else { 1 }) % Program::ALL.len();
        self.program = Program::ALL[next];
    }

    pub fn append(&mut self, text: &str) {
        let (value, limit) = match self.field {
            Field::Name => (&mut self.name, 80usize),
            Field::Prompt => (&mut self.prompt, 2048),
            Field::When => (&mut self.when, 40),
            _ => return,
        };
        let remaining = limit.saturating_sub(value.chars().count());
        value.extend(text.chars().filter(|c| !c.is_control()).take(remaining));
    }

    pub fn backspace(&mut self) {
        match self.field {
            Field::Name => {
                self.name.pop();
            }
            Field::Prompt => {
                self.prompt.pop();
            }
            Field::When => {
                self.when.pop();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_name_accepts_text() {
        let mut form = SessionForm {
            field: Field::Directory,
            ..Default::default()
        };
        form.append("C:\\My Projects\\api\r\n");
        assert!(form.cwd.is_empty());
        form.field = Field::Program;
        form.cycle_program(false);
        form.append("not text");
        assert_eq!(form.program, Program::Claude);
        assert!(form.cwd.is_empty());
        form.field = Field::Name;
        form.append("A\r\nB");
        assert_eq!(form.name, "AB");
    }
}
