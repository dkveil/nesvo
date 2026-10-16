//! Observed terminal activity and conservative, informational CLI screen hints.
use crate::launchers::Program;
use serde::Serialize;

const QUIET_MS: u64 = 1_500;
const VISIBLE_TAIL_LINES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusState {
    Working,
    Idle,
    Done,
    Blocked,
    Question,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusSource {
    Activity,
    Screen,
    Process,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub state: StatusState,
    pub source: StatusSource,
    pub updated_at: u64,
}

pub struct StatusTracker {
    program: Program,
    parser: Option<vt100::Parser>,
    screen_hint: Option<StatusState>,
    screen_dirty: bool,
    last_activity: Option<u64>,
    exited: bool,
    exit_code: Option<u32>,
    status: SessionStatus,
}

pub fn now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

impl StatusTracker {
    pub fn new(program: Program, rows: u16, cols: u16, now: u64) -> Self {
        Self {
            program,
            // No scrollback: inference must only see the current visible screen.
            parser: (program != Program::Shell).then(|| vt100::Parser::new(rows, cols, 0)),
            screen_hint: None,
            screen_dirty: false,
            last_activity: None,
            exited: false,
            exit_code: None,
            status: SessionStatus {
                state: StatusState::Unknown,
                source: StatusSource::Activity,
                updated_at: now,
            },
        }
    }

    pub fn status(&self) -> SessionStatus {
        self.status
    }

    pub fn output(&mut self, data: &str, now: u64) {
        if data.is_empty() || self.exited {
            return;
        }
        self.last_activity = Some(now);
        if let Some(parser) = &mut self.parser {
            parser.process(data.as_bytes());
            self.screen_dirty = true;
        }
    }

    pub fn input(&mut self, now: u64) {
        if !self.exited {
            self.last_activity = Some(now);
            // A key may answer the visible prompt. Do not retain that inference
            // until the program produces new screen output.
            self.screen_hint = None;
            self.screen_dirty = false;
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        if let Some(parser) = &mut self.parser {
            parser.screen_mut().set_size(rows, cols);
            self.screen_hint = None;
            self.screen_dirty = false;
        }
    }

    pub fn exited(&mut self, code: Option<u32>) {
        self.exited = true;
        self.exit_code = code;
    }

    /// Called by the coalesced host timer, never broadcast for each PTY chunk.
    pub fn refresh(&mut self, now: u64) -> bool {
        let (state, source) = if self.exited {
            (
                match self.exit_code {
                    Some(0) => StatusState::Done,
                    Some(_) => StatusState::Failed,
                    None => StatusState::Unknown,
                },
                StatusSource::Process,
            )
        } else {
            if self.screen_dirty {
                self.screen_hint = self
                    .parser
                    .as_ref()
                    .and_then(|parser| infer_screen(self.program, parser.screen()));
                self.screen_dirty = false;
            }
            if let Some(hint) = self.screen_hint {
                (hint, StatusSource::Screen)
            } else if self
                .last_activity
                .is_some_and(|last| now.saturating_sub(last) < QUIET_MS)
            {
                (StatusState::Working, StatusSource::Activity)
            } else if self.program == Program::Shell {
                (StatusState::Idle, StatusSource::Activity)
            } else {
                (StatusState::Unknown, StatusSource::Activity)
            }
        };
        if (state, source) == (self.status.state, self.status.source) {
            return false;
        }
        self.status = SessionStatus {
            state,
            source,
            updated_at: now,
        };
        true
    }
}

fn normalized_line(line: &str) -> &str {
    line.trim_matches(|c: char| c.is_whitespace() || matches!(c, '│' | '┃' | '║'))
}

fn option_text(line: &str) -> &str {
    let line = line.trim_start_matches(['›', '❯', '>', '●', '○', ' ']);
    line.split_once(". ")
        .filter(|(number, _)| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
        .map_or(line, |(_, text)| text)
}

fn question_progress(line: &str) -> bool {
    line.strip_prefix("Question ")
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|count| count.split_once('/'))
        .is_some_and(|(index, total)| {
            index.parse::<u32>().is_ok_and(|n| n > 0) && total.parse::<u32>().is_ok_and(|n| n > 0)
        })
}

fn infer_screen(program: Program, screen: &vt100::Screen) -> Option<StatusState> {
    let contents = screen.contents();
    let lines: Vec<&str> = contents
        .lines()
        .map(normalized_line)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = &lines[lines.len().saturating_sub(VISIBLE_TAIL_LINES)..];
    let footer = &tail[tail.len().saturating_sub(3)..];
    let has = |text: &str| tail.contains(&text);
    let choice = |text: &str| tail.iter().any(|line| option_text(line) == text);
    match program {
        Program::Codex => {
            let confirmation = has("Would you like to run the following command?")
                || has("Would you like to make the following edits?");
            if confirmation
                && choice("Yes, proceed (y)")
                && choice("No, and tell Codex what to do differently (esc)")
                && footer
                    .iter()
                    .any(|line| line.contains("enter to confirm") && line.contains("esc to cancel"))
            {
                return Some(StatusState::Blocked);
            }
            if tail.iter().any(|line| question_progress(line))
                && footer.iter().any(|line| {
                    (line.contains("to submit answer") || line.contains("to submit all"))
                        && line.contains("esc to interrupt")
                })
                && tail.iter().any(|line| line.starts_with("› "))
            {
                return Some(StatusState::Question);
            }
            if footer.iter().any(|line| {
                (line.starts_with("• Working (") || line.starts_with("• Thinking ("))
                    && line.contains("esc to interrupt")
            }) {
                return Some(StatusState::Working);
            }
            if footer.iter().any(|line| line.contains("? for shortcuts"))
                && cursor_has_prompt(screen, '›')
            {
                return Some(StatusState::Idle);
            }
        }
        Program::Gemini => {
            if tail
                .iter()
                .any(|line| line.starts_with("Allow execution of") && line.ends_with('?'))
                && (choice("Allow once") || choice("Yes, allow once"))
                && footer
                    .iter()
                    .any(|line| option_text(line) == "No, suggest changes (esc)")
            {
                return Some(StatusState::Blocked);
            }
        }
        Program::Claude => {
            if has("Do you want to proceed?")
                && choice("Yes")
                && (footer.iter().any(|line| {
                    option_text(line) == "No, and tell Claude what to do differently (esc)"
                }) || (choice("No")
                    && footer.iter().any(|line| {
                        line.contains("Esc to cancel") && line.contains("Enter to confirm")
                    })))
            {
                return Some(StatusState::Blocked);
            }
            if footer.iter().any(|line| line.contains("? for shortcuts"))
                && cursor_has_prompt(screen, '❯')
            {
                return Some(StatusState::Idle);
            }
        }
        Program::Shell => {}
    }
    None
}

fn cursor_has_prompt(screen: &vt100::Screen, marker: char) -> bool {
    let (row, _) = screen.cursor_position();
    let (_, cols) = screen.size();
    screen
        .rows(0, cols)
        .nth(usize::from(row))
        .is_some_and(|line| line.trim_start().starts_with(marker))
        && !screen.hide_cursor()
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPROVAL: &str = "\x1b[2J\x1b[HWould you like to run the following command?\r\n$ pwd\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel";
    const QUESTION: &str = "\x1b[2J\x1b[HQuestion 1/1 (1 unanswered)\r\nChoose a format.\r\n› 1. Plain text\r\n  2. Markdown\r\nenter to submit answer | esc to interrupt";

    #[test]
    fn shell_activity_is_not_semantic_completion_and_timestamp_only_changes_on_transition() {
        let mut tracker = StatusTracker::new(Program::Shell, 24, 100, 0);
        tracker.output("text", 100);
        assert!(tracker.refresh(250));
        assert_eq!(tracker.status.state, StatusState::Working);
        tracker.output("more", 300);
        assert!(!tracker.refresh(500));
        assert_eq!(tracker.status.updated_at, 250);
        assert!(tracker.refresh(2_000));
        assert_eq!(tracker.status.state, StatusState::Idle);
        tracker.input(2_100);
        assert!(tracker.refresh(2_250));
        assert_eq!(tracker.status.source, StatusSource::Activity);
    }

    #[test]
    fn screen_detection_handles_chunked_ansi_and_cleared_prompts() {
        let mut tracker = StatusTracker::new(Program::Codex, 24, 100, 0);
        for chunk in APPROVAL.as_bytes().chunks(3) {
            tracker.parser.as_mut().unwrap().process(chunk);
        }
        tracker.screen_dirty = true;
        tracker.refresh(250);
        assert_eq!(tracker.status.state, StatusState::Blocked);
        assert_eq!(tracker.status.source, StatusSource::Screen);
        tracker.output("\x1b[2J\x1b[HNew response", 300);
        tracker.refresh(500);
        assert_eq!(tracker.status.state, StatusState::Working);
        tracker.refresh(3_000);
        assert_eq!(tracker.status.state, StatusState::Unknown);
    }

    #[test]
    fn structured_question_requires_progress_options_and_footer_not_question_prose() {
        let mut tracker = StatusTracker::new(Program::Codex, 24, 100, 0);
        tracker.output(QUESTION, 1);
        tracker.refresh(250);
        assert_eq!(tracker.status.state, StatusState::Question);
        tracker.input(300);
        tracker.refresh(500);
        assert_eq!(tracker.status.state, StatusState::Working);
        tracker.output("\x1b[2J\x1b[HThe documentation says: Would you like to run the following command?\r\nQuestion 1/1 is just an example.\r\nDo you need help?", 600);
        tracker.refresh(3_000);
        assert_eq!(tracker.status.state, StatusState::Unknown);
    }

    #[test]
    fn only_actual_process_exit_produces_done_or_failed_and_late_output_cannot_revive_it() {
        for (exit, expected) in [
            (Some(0), StatusState::Done),
            (Some(7), StatusState::Failed),
            (None, StatusState::Unknown),
        ] {
            let mut tracker = StatusTracker::new(Program::Codex, 24, 100, 0);
            tracker.output("Finished successfully", 1);
            tracker.refresh(9_000);
            assert_eq!(tracker.status.state, StatusState::Unknown);
            tracker.exited(exit);
            assert!(tracker.refresh(10_000));
            assert_eq!(
                (tracker.status.state, tracker.status.source),
                (expected, StatusSource::Process)
            );
            tracker.output(QUESTION, 10_001);
            tracker.input(10_002);
            assert!(!tracker.refresh(10_250));
        }
    }

    #[test]
    fn permission_patterns_are_program_specific_and_not_matched_in_scrollback() {
        let mut tracker = StatusTracker::new(Program::Gemini, 24, 100, 0);
        tracker.output(
            "Allow execution of [Shell]?\r\n● 1. Allow once\r\n  2. No, suggest changes (esc)",
            1,
        );
        tracker.refresh(250);
        assert_eq!(tracker.status.state, StatusState::Blocked);
        tracker.output(&"\r\nordinary output".repeat(30), 300);
        tracker.refresh(2_000);
        assert_eq!(tracker.status.state, StatusState::Unknown);
        let mut shell = StatusTracker::new(Program::Shell, 24, 100, 0);
        shell.output(APPROVAL, 1);
        shell.refresh(2_000);
        assert_eq!(shell.status.state, StatusState::Idle);
    }

    #[test]
    fn idle_requires_current_prompt_and_activity_footer_is_an_inference() {
        let mut tracker = StatusTracker::new(Program::Codex, 24, 100, 0);
        tracker.output("\x1b[2J\x1b[H› \r\n? for shortcuts\x1b[1;3H", 1);
        tracker.refresh(250);
        assert_eq!(
            (tracker.status.state, tracker.status.source),
            (StatusState::Idle, StatusSource::Screen)
        );
        tracker.output("\x1b[2J\x1b[H• Working (2s • esc to interrupt)", 300);
        tracker.refresh(500);
        assert_eq!(
            (tracker.status.state, tracker.status.source),
            (StatusState::Working, StatusSource::Screen)
        );
        tracker.output("\x1b[?1049h\x1b[2J\x1b[Hdifferent full-screen program", 600);
        tracker.refresh(3_000);
        assert_eq!(tracker.status.state, StatusState::Unknown);
    }

    #[test]
    fn claude_approval_requires_the_permission_header_and_explicit_choices() {
        let mut tracker = StatusTracker::new(Program::Claude, 24, 100, 0);
        tracker.output("Do you want to proceed?\r\n> 1. Yes\r\n  2. No, and tell Claude what to do differently (esc)", 1);
        tracker.refresh(250);
        assert_eq!(tracker.status.state, StatusState::Blocked);
        tracker.output(
            "\x1b[2J\x1b[HThe user said Yes. Do you want to proceed?",
            300,
        );
        tracker.refresh(2_000);
        assert_eq!(tracker.status.state, StatusState::Unknown);
    }
}
