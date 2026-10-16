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

#[derive(Default, Debug, Deserialize)]
pub struct Capabilities {
    pub workspace: String,
    pub programs: Vec<ProgramCapability>,
    #[serde(default, rename = "directoryBrowser")]
    pub directory_browser: bool,
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
}

#[derive(Clone, Default)]
pub struct SessionForm {
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
            Field::Directory | Field::Program => return,
        };
        let remaining = limit.saturating_sub(value.chars().count());
        value.extend(text.chars().filter(|c| !c.is_control()).take(remaining));
    }

    pub fn backspace(&mut self) {
        match self.field {
            Field::Name => {
                self.name.pop();
            }
            Field::Directory | Field::Program => {}
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
