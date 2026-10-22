use crate::launch::{Program, SessionForm};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::HashSet;

pub const AGENT_PROGRAMS: [Program; 3] = [Program::Claude, Program::Gemini, Program::Codex];
const URL_LIMIT: usize = 2048;
const INVALID_PULL_REQUEST: &str =
    "Use a GitHub pull request URL: https://github.com/owner/repo/pull/123";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKind {
    Agent,
    Terminal,
    Review,
}

impl SessionKind {
    pub const ALL: [Self; 3] = [Self::Agent, Self::Terminal, Self::Review];

    pub fn label(self) -> &'static str {
        match self {
            Self::Agent => "Agent session",
            Self::Terminal => "Clean terminal",
            Self::Review => "Review",
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            Self::Agent => "Claude, Gemini or Codex with an optional model profile",
            Self::Terminal => "A plain shell in a folder",
            Self::Review => "Local changes of a session or a GitHub pull request",
        }
    }

    pub fn programs(self) -> &'static [Program] {
        match self {
            Self::Agent => &AGENT_PROGRAMS,
            Self::Terminal => &[Program::Shell],
            Self::Review => &[],
        }
    }

    pub fn preset<'a>(
        self,
        group_id: Option<String>,
        agent: Program,
        names: impl IntoIterator<Item = &'a str>,
    ) -> Option<SessionForm> {
        match self {
            Self::Agent => Some(SessionForm {
                kind: Some(self),
                group_id,
                program: if AGENT_PROGRAMS.contains(&agent) {
                    agent
                } else {
                    Program::Claude
                },
                ..Default::default()
            }),
            Self::Terminal => Some(SessionForm {
                kind: Some(self),
                group_id,
                program: Program::Shell,
                name: next_terminal_name(names),
                ..Default::default()
            }),
            Self::Review => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewSource {
    LocalChanges,
    PullRequest,
}

impl ReviewSource {
    pub const ALL: [Self; 2] = [Self::LocalChanges, Self::PullRequest];

    pub fn label(self) -> &'static str {
        match self {
            Self::LocalChanges => "Local changes of a session",
            Self::PullRequest => "GitHub PR URL",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Picker {
    Kind {
        selected: usize,
    },
    ReviewSource {
        selected: usize,
        url: String,
        error: Option<&'static str>,
    },
}

impl Default for Picker {
    fn default() -> Self {
        Self::Kind { selected: 0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKindAction {
    Previous,
    Next,
    Pick(usize),
    Confirm,
    Cancel,
    Type(char),
    Erase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    Pending,
    Closed,
    Kind(SessionKind),
    LocalChanges,
    PullRequest(String),
}

impl Picker {
    pub fn rows(&self) -> usize {
        match self {
            Self::Kind { .. } => SessionKind::ALL.len(),
            Self::ReviewSource { .. } => ReviewSource::ALL.len(),
        }
    }

    pub fn typing(&self) -> bool {
        matches!(self, Self::ReviewSource { selected: 1, .. })
    }

    pub fn selected(&self) -> usize {
        match self {
            Self::Kind { selected } | Self::ReviewSource { selected, .. } => *selected,
        }
    }

    pub fn action(&self, key: KeyEvent) -> Option<SessionKindAction> {
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return None;
        }
        let typing = self.typing();
        Some(match key.code {
            KeyCode::Esc => SessionKindAction::Cancel,
            KeyCode::Enter => SessionKindAction::Confirm,
            KeyCode::Up | KeyCode::BackTab => SessionKindAction::Previous,
            KeyCode::Down | KeyCode::Tab => SessionKindAction::Next,
            KeyCode::Backspace if typing => SessionKindAction::Erase,
            KeyCode::Char(c) if typing && !c.is_control() => SessionKindAction::Type(c),
            KeyCode::Char('k') => SessionKindAction::Previous,
            KeyCode::Char('j') => SessionKindAction::Next,
            KeyCode::Char(c @ '1'..='9') => SessionKindAction::Pick(c as usize - '1' as usize),
            _ => return None,
        })
    }

    pub fn paste(&mut self, text: &str) {
        if let Self::ReviewSource {
            selected,
            url,
            error,
        } = self
        {
            *selected = 1;
            *error = None;
            let remaining = URL_LIMIT.saturating_sub(url.chars().count());
            url.extend(text.chars().filter(|c| !c.is_control()).take(remaining));
        }
    }

    pub fn apply(&mut self, action: SessionKindAction) -> Choice {
        let rows = self.rows();
        match self {
            Self::Kind { selected } => match action {
                SessionKindAction::Previous => *selected = (*selected + rows - 1) % rows,
                SessionKindAction::Next => *selected = (*selected + 1) % rows,
                SessionKindAction::Pick(index) if index < rows => {
                    *selected = index;
                    return self.apply(SessionKindAction::Confirm);
                }
                SessionKindAction::Confirm => match SessionKind::ALL[*selected] {
                    SessionKind::Review => {
                        *self = Self::ReviewSource {
                            selected: 0,
                            url: String::new(),
                            error: None,
                        }
                    }
                    kind => return Choice::Kind(kind),
                },
                SessionKindAction::Cancel => return Choice::Closed,
                _ => {}
            },
            Self::ReviewSource {
                selected,
                url,
                error,
            } => match action {
                SessionKindAction::Previous => *selected = (*selected + rows - 1) % rows,
                SessionKindAction::Next => *selected = (*selected + 1) % rows,
                SessionKindAction::Pick(index) if index < rows => {
                    *selected = index;
                    if ReviewSource::ALL[index] == ReviewSource::LocalChanges {
                        return Choice::LocalChanges;
                    }
                }
                SessionKindAction::Type(c) if url.chars().count() < URL_LIMIT => {
                    url.push(c);
                    *error = None;
                }
                SessionKindAction::Erase => {
                    url.pop();
                    *error = None;
                }
                SessionKindAction::Confirm => match ReviewSource::ALL[*selected] {
                    ReviewSource::LocalChanges => return Choice::LocalChanges,
                    ReviewSource::PullRequest => match pull_request_url(url) {
                        Ok(normalized) => return Choice::PullRequest(normalized),
                        Err(message) => *error = Some(message),
                    },
                },
                SessionKindAction::Cancel => {
                    *self = Self::Kind {
                        selected: SessionKind::ALL
                            .iter()
                            .position(|kind| *kind == SessionKind::Review)
                            .unwrap_or(0),
                    }
                }
                _ => {}
            },
        }
        Choice::Pending
    }
}

pub fn agent_program(hint: Option<Program>, available: impl Fn(Program) -> bool) -> Program {
    hint.filter(|program| AGENT_PROGRAMS.contains(program))
        .or_else(|| {
            AGENT_PROGRAMS
                .into_iter()
                .find(|program| available(*program))
        })
        .unwrap_or(Program::Claude)
}

pub fn next_terminal_name<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    let taken: HashSet<&str> = names.into_iter().collect();
    (1..)
        .map(|index| format!("Terminal {index}"))
        .find(|name| !taken.contains(name.as_str()))
        .unwrap_or_else(|| "Terminal".into())
}

fn valid_owner(owner: &str) -> bool {
    (1..=39).contains(&owner.len())
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn valid_repository(repository: &str) -> bool {
    (1..=100).contains(&repository.len())
        && repository != "."
        && repository != ".."
        && repository
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn valid_number(number: &str) -> bool {
    (1..=10).contains(&number.len())
        && !number.starts_with('0')
        && number.bytes().all(|b| b.is_ascii_digit())
}

pub fn pull_request_url(text: &str) -> Result<String, &'static str> {
    let text = text.trim();
    if text.len() > URL_LIMIT {
        return Err(INVALID_PULL_REQUEST);
    }
    let rest = text.strip_prefix("https://").ok_or(INVALID_PULL_REQUEST)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let mut parts = rest.trim_end_matches('/').split('/');
    let (Some("github.com"), Some(owner), Some(repository), Some("pull"), Some(number)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(INVALID_PULL_REQUEST);
    };
    let tail: Vec<&str> = parts.collect();
    let tail_ok = match tail.as_slice() {
        [] => true,
        [page] => matches!(*page, "files" | "commits" | "checks"),
        _ => false,
    };
    if !(tail_ok && valid_owner(owner) && valid_repository(repository) && valid_number(number)) {
        return Err(INVALID_PULL_REQUEST);
    }
    Ok(format!(
        "https://github.com/{owner}/{repository}/pull/{number}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn run(picker: &mut Picker, code: KeyCode) -> Choice {
        picker
            .action(key(code))
            .map_or(Choice::Pending, |action| picker.apply(action))
    }

    #[test]
    fn kind_picker_moves_wraps_picks_digits_and_cancels() {
        let mut picker = Picker::default();
        assert_eq!(run(&mut picker, KeyCode::Up), Choice::Pending);
        assert_eq!(picker.selected(), 2);
        run(&mut picker, KeyCode::Char('j'));
        assert_eq!(picker.selected(), 0);
        run(&mut picker, KeyCode::Down);
        assert_eq!(
            run(&mut picker, KeyCode::Enter),
            Choice::Kind(SessionKind::Terminal)
        );
        let mut picker = Picker::default();
        assert_eq!(
            run(&mut picker, KeyCode::Char('1')),
            Choice::Kind(SessionKind::Agent)
        );
        assert_eq!(run(&mut picker, KeyCode::Char('9')), Choice::Pending);
        assert_eq!(run(&mut picker, KeyCode::Char('x')), Choice::Pending);
        assert!(
            picker
                .action(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::CONTROL))
                .is_none()
        );
        assert_eq!(run(&mut picker, KeyCode::Esc), Choice::Closed);
        let mut picker = Picker::default();
        assert_eq!(run(&mut picker, KeyCode::Char('3')), Choice::Pending);
        assert!(matches!(
            picker,
            Picker::ReviewSource {
                selected: 0,
                ref url,
                error: None
            } if url.is_empty()
        ));
    }

    #[test]
    fn review_source_types_url_validates_and_esc_returns_to_kinds() {
        let mut picker = Picker::ReviewSource {
            selected: 0,
            url: String::new(),
            error: None,
        };
        assert_eq!(run(&mut picker, KeyCode::Char('j')), Choice::Pending);
        assert_eq!(picker.selected(), 1);
        for c in "https://github.com/o/r/pull/1x".chars() {
            run(&mut picker, KeyCode::Char(c));
        }
        assert_eq!(run(&mut picker, KeyCode::Enter), Choice::Pending);
        assert!(matches!(
            picker,
            Picker::ReviewSource {
                error: Some(INVALID_PULL_REQUEST),
                ..
            }
        ));
        run(&mut picker, KeyCode::Backspace);
        assert!(matches!(picker, Picker::ReviewSource { error: None, .. }));
        assert_eq!(
            run(&mut picker, KeyCode::Enter),
            Choice::PullRequest("https://github.com/o/r/pull/1".into())
        );
        assert_eq!(run(&mut picker, KeyCode::Char('k')), Choice::Pending);
        assert_eq!(picker.selected(), 1);
        run(&mut picker, KeyCode::Up);
        assert_eq!(run(&mut picker, KeyCode::Enter), Choice::LocalChanges);
        let mut pasted = Picker::ReviewSource {
            selected: 0,
            url: String::new(),
            error: None,
        };
        pasted.paste("https://github.com/a/b/pull/7\r\n");
        assert_eq!(
            pasted.apply(SessionKindAction::Confirm),
            Choice::PullRequest("https://github.com/a/b/pull/7".into())
        );
        assert_eq!(run(&mut pasted, KeyCode::Esc), Choice::Pending);
        assert_eq!(pasted, Picker::Kind { selected: 2 });
        let mut digits = Picker::ReviewSource {
            selected: 0,
            url: String::new(),
            error: None,
        };
        assert_eq!(run(&mut digits, KeyCode::Char('1')), Choice::LocalChanges);
        run(&mut digits, KeyCode::Char('2'));
        assert_eq!(digits.selected(), 1);
        run(&mut digits, KeyCode::Char('2'));
        assert!(matches!(&digits, Picker::ReviewSource { url, .. } if url == "2"));
    }

    #[test]
    fn pull_request_urls_are_normalized_or_refused() {
        for (input, expected) in [
            (
                " https://github.com/dkveil/nesvo/pull/42 ",
                "https://github.com/dkveil/nesvo/pull/42",
            ),
            (
                "https://www.github.com/a-b/c.d_e/pull/9/files?w=1#diff",
                "https://github.com/a-b/c.d_e/pull/9",
            ),
            (
                "https://github.com/a/b/pull/3/",
                "https://github.com/a/b/pull/3",
            ),
        ] {
            assert_eq!(pull_request_url(input).as_deref(), Ok(expected));
        }
        for input in [
            "",
            "http://github.com/a/b/pull/1",
            "https://gitlab.com/a/b/pull/1",
            "https://github.com/a/b/issues/1",
            "https://github.com/a/b/pull/0",
            "https://github.com/a/b/pull/01",
            "https://github.com/-a/b/pull/1",
            "https://github.com/a/../pull/1",
            "https://github.com/a/b/pull/1/files/x",
            "https://github.com/a/b/pull/1/blame",
            "https://github.com/a/b/pull/12345678901",
        ] {
            assert!(pull_request_url(input).is_err(), "{input}");
        }
        assert!(
            pull_request_url(&format!(
                "https://github.com/a/b/pull/1?{}",
                "x".repeat(3000)
            ))
            .is_err()
        );
    }

    #[test]
    fn presets_restrict_programs_and_name_terminals() {
        let agent = SessionKind::Agent
            .preset(Some("g".into()), Program::Shell, [])
            .unwrap();
        assert_eq!(agent.kind, Some(SessionKind::Agent));
        assert_eq!(agent.program, Program::Claude);
        assert_eq!(agent.group_id.as_deref(), Some("g"));
        assert_eq!(agent.programs(), &AGENT_PROGRAMS);
        assert!(agent.name.is_empty());
        let codex = SessionKind::Agent.preset(None, Program::Codex, []).unwrap();
        assert_eq!(codex.program, Program::Codex);
        let terminal = SessionKind::Terminal
            .preset(None, Program::Codex, ["Terminal 1", "Terminal 3", "api"])
            .unwrap();
        assert_eq!(terminal.program, Program::Shell);
        assert_eq!(terminal.name, "Terminal 2");
        assert_eq!(terminal.programs(), &[Program::Shell]);
        assert!(!terminal.advanced);
        assert!(
            SessionKind::Review
                .preset(None, Program::Claude, [])
                .is_none()
        );
        assert_eq!(next_terminal_name([]), "Terminal 1");
    }

    #[test]
    fn agent_program_prefers_hint_then_available() {
        assert_eq!(
            agent_program(Some(Program::Gemini), |_| false),
            Program::Gemini
        );
        assert_eq!(
            agent_program(Some(Program::Shell), |program| program == Program::Codex),
            Program::Codex
        );
        assert_eq!(agent_program(None, |_| false), Program::Claude);
    }
}
