//! Observed terminal activity and conservative, informational CLI screen hints.
use crate::launchers::Program;
use serde::{Deserialize, Serialize};

const QUIET_MS: u64 = 1_500;
const VISIBLE_TAIL_LINES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusSource {
    Activity,
    Screen,
    Hook,
    Program,
    Process,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    screen_rule: Option<crate::status_rules::Match>,
    screen_dirty: bool,
    lifecycle: Option<StatusState>,
    lifecycle_sequence: u64,
    lifecycle_received: u64,
    observation_order: u64,
    lifecycle_order: u64,
    program_order: u64,
    lifecycle_ordering: &'static str,
    interrupt_received: Option<u64>,
    interrupt_settled: bool,
    program_status: Option<crate::program_status::Report>,
    program_received: u64,
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
            screen_rule: None,
            screen_dirty: false,
            lifecycle: None,
            lifecycle_sequence: 0,
            lifecycle_received: 0,
            observation_order: 0,
            lifecycle_order: 0,
            program_order: 0,
            lifecycle_ordering: "legacy-wall-clock",
            interrupt_received: None,
            interrupt_settled: false,
            program_status: None,
            program_received: 0,
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

    pub fn lifecycle(&mut self, report: crate::agent_context::LifecycleReport, now: u64) {
        if self.exited || report.sequence <= self.lifecycle_sequence {
            return;
        }
        self.lifecycle_sequence = report.sequence;
        self.observation_order = self.observation_order.saturating_add(1);
        self.lifecycle_order = self.observation_order;
        self.lifecycle_received = now;
        self.interrupt_received = None;
        self.interrupt_settled = false;
        self.lifecycle = Some(report.state);
        self.screen_hint = None;
        self.screen_rule = None;
        self.screen_dirty = false;
    }
    pub fn lifecycle_ordered(&mut self, report: crate::agent_context::LifecycleReport, now: u64) {
        self.lifecycle(report, now);
        self.lifecycle_ordering = "launch-sequence";
    }

    pub fn rate_limited(&self) -> bool {
        !self.exited
            && self
                .parser
                .as_ref()
                .is_some_and(|parser| quota_screen(parser.screen()))
    }

    pub fn program_report(&mut self, report: Option<&crate::program_status::Report>, now: u64) {
        if self.exited {
            return;
        }
        self.program_status = report.cloned();
        self.interrupt_settled = false;
        if report.is_some() {
            self.interrupt_received = None;
        }
        self.observation_order = self.observation_order.saturating_add(1);
        self.program_order = self.observation_order;
        self.program_received = now;
    }

    pub fn status(&self) -> SessionStatus {
        self.status
    }
    pub fn rule_reason(&self) -> Option<&'static str> {
        (self.status.source == StatusSource::Screen)
            .then_some(self.screen_rule)
            .flatten()
            .map(|r| r.reason)
    }

    pub fn explain(&self, now: u64) -> serde_json::Value {
        let reason = match self.status.source {
            StatusSource::Process => "observed process exit",
            StatusSource::Hook => "provider lifecycle event",
            StatusSource::Program => "program status root report",
            StatusSource::Screen => "current visible terminal rule",
            StatusSource::Activity if self.status.state == StatusState::Unknown => {
                "no supported semantic signal; inspect startup consent or disabled integration"
            }
            StatusSource::Activity => "terminal I/O only; no task outcome inferred",
        };
        serde_json::json!({"selected":self.status, "reason":reason, "screenHint":self.screen_hint, "matchedRule":self.screen_rule,
            "hook":{"state":self.lifecycle,"sequence":self.lifecycle_sequence,
                "receivedAt":if self.lifecycle.is_some(){Some(self.lifecycle_received)}else{None},
                "ageMs":self.lifecycle.map(|_|now.saturating_sub(self.lifecycle_received)), "ordering":self.lifecycle_ordering},
            "lastOutputAgeMs":self.last_activity.map(|at|now.saturating_sub(at)),
            "processExited":self.exited,"exitCode":self.exit_code})
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
            self.screen_rule = None;
            self.screen_dirty = false;
        }
    }

    pub fn interrupted(&mut self, now: u64) {
        if !self.exited {
            self.interrupt_received = Some(now);
            self.interrupt_settled = false;
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        if let Some(parser) = &mut self.parser {
            parser.screen_mut().set_size(rows, cols);
            self.screen_hint = None;
            self.screen_rule = None;
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
                self.screen_rule = self
                    .parser
                    .as_ref()
                    .and_then(|parser| crate::status_rules::detect(self.program, parser.screen()));
                self.screen_hint = self.parser.as_ref().and_then(|parser| {
                    self.screen_rule
                        .map(|e| e.state)
                        .or_else(|| infer_screen(self.program, parser.screen()))
                });
                self.screen_dirty = false;
            }
            let recent_interrupt = self.interrupt_received.is_some_and(|at| {
                at >= self.lifecycle_received
                    && now.saturating_sub(at) <= 5000
                    && self.last_activity.is_some_and(|last| last > at)
            });
            if self.screen_hint == Some(StatusState::Idle) && recent_interrupt {
                self.interrupt_settled = true;
            }
            let screen = self.screen_hint.filter(|hint| {
                if self.lifecycle.is_none() {
                    return true;
                }
                // A prompt can remain visible during a real turn. New output or
                // elapsed time alone cannot turn confirmed work into idle.
                self.lifecycle != Some(*hint)
                    && !(*hint == StatusState::Idle
                        && self.lifecycle == Some(StatusState::Working)
                        && !self.interrupt_settled)
                    && (now.saturating_sub(self.lifecycle_received) >= 750
                        && self
                            .last_activity
                            .is_some_and(|at| at > self.lifecycle_received))
            });
            let program = self.program_status.as_ref().filter(|report| {
                (self.lifecycle.is_none() || self.program_order >= self.lifecycle_order)
                    && !(self.interrupt_settled
                        && report.state == crate::program_status::State::Working
                        && self.screen_hint == Some(StatusState::Idle))
            });
            if let Some(report) = program {
                use crate::program_status::{Kind, State};
                let state = match report.state {
                    State::Idle | State::Done => StatusState::Idle,
                    State::Working => StatusState::Working,
                    State::Blocked if report.kind == Some(Kind::Question) => StatusState::Question,
                    State::Blocked => StatusState::Blocked,
                    State::Error => StatusState::Failed,
                    State::Clear => StatusState::Unknown,
                };
                (state, StatusSource::Program)
            } else if let Some(hint) = screen {
                (hint, StatusSource::Screen)
            } else if let Some(hint) = self.lifecycle {
                (hint, StatusSource::Hook)
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

fn quota_screen(screen: &vt100::Screen) -> bool {
    screen
        .contents()
        .lines()
        .rev()
        .take(VISIBLE_TAIL_LINES)
        .any(|line| {
            let line = normalized_line(line)
                .trim_start_matches(['•', '!', ' ', '●'])
                .to_lowercase();
            line.starts_with("you've hit your usage limit")
                || line.starts_with("you’ve hit your usage limit")
                || line.starts_with("you've hit your limit")
                || line.starts_with("usage limit reached")
        })
}

fn infer_screen(program: Program, screen: &vt100::Screen) -> Option<StatusState> {
    if program != Program::Shell && quota_screen(screen) {
        return Some(StatusState::Blocked);
    }
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
            if footer
                .iter()
                .any(|line| line.to_lowercase().contains("esc to interrupt"))
            {
                return Some(StatusState::Working);
            }
            if footer
                .iter()
                .any(|line| line.contains("? for shortcuts") || line.contains("shift+tab to cycle"))
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
    #[test]
    fn source_order_and_event_sequences_survive_wall_clock_regression() {
        let mut tracker = StatusTracker::new(Program::Claude, 24, 100, 1000);
        tracker.lifecycle_ordered(
            crate::agent_context::LifecycleReport {
                state: StatusState::Working,
                sequence: 1,
            },
            1000,
        );
        let report = crate::program_status::parse("state=blocked:kind=permission").unwrap();
        tracker.program_report(Some(&report), 900);
        tracker.refresh(900);
        assert_eq!(tracker.status.source, StatusSource::Program);
        tracker.lifecycle_ordered(
            crate::agent_context::LifecycleReport {
                state: StatusState::Working,
                sequence: 2,
            },
            800,
        );
        tracker.lifecycle_ordered(
            crate::agent_context::LifecycleReport {
                state: StatusState::Idle,
                sequence: 1,
            },
            1200,
        );
        tracker.refresh(1200);
        assert_eq!(tracker.status.state, StatusState::Working);
        assert_eq!(tracker.status.source, StatusSource::Hook);
    }

    #[test]
    fn lifecycle_survives_silence_rejects_old_events_and_yields_to_exit() {
        let mut tracker = StatusTracker::new(Program::Claude, 24, 100, 0);
        let report = |state, sequence| crate::agent_context::LifecycleReport { state, sequence };
        tracker.lifecycle(report(StatusState::Working, 1), 10);
        tracker.refresh(60_000);
        assert_eq!(
            (tracker.status.state, tracker.status.source),
            (StatusState::Working, StatusSource::Hook)
        );
        tracker.lifecycle(report(StatusState::Blocked, 2), 60_001);
        tracker.refresh(60_100);
        assert_eq!(tracker.status.state, StatusState::Blocked);
        tracker.lifecycle(report(StatusState::Working, 1), 60_200);
        tracker.refresh(60_300);
        assert_eq!(tracker.status.state, StatusState::Blocked);
        tracker.lifecycle(report(StatusState::Idle, 3), 60_400);
        tracker.refresh(60_500);
        assert_eq!(tracker.status.state, StatusState::Idle);
        tracker.exited(Some(1));
        tracker.lifecycle(report(StatusState::Working, 4), 60_600);
        tracker.refresh(60_700);
        assert_eq!(
            (tracker.status.state, tracker.status.source),
            (StatusState::Failed, StatusSource::Process)
        );
    }

    #[test]
    fn visible_idle_does_not_override_work_until_a_real_interrupt_and_new_prompt() {
        let mut tracker = StatusTracker::new(Program::Claude, 24, 100, 0);
        tracker.lifecycle(
            crate::agent_context::LifecycleReport {
                state: StatusState::Working,
                sequence: 1,
            },
            10,
        );
        tracker.output(
            "\x1b[2J\x1b[H❯ \r\naccept edits on (shift+tab to cycle)\x1b[1;3H",
            100,
        );
        tracker.refresh(250);
        assert_eq!(tracker.status.source, StatusSource::Hook);
        tracker.refresh(1000);
        assert_eq!(tracker.status.state, StatusState::Working);
        tracker.refresh(120_000);
        assert_eq!(
            tracker.status.state,
            StatusState::Working,
            "silence is not completion"
        );
        tracker.interrupted(120_001);
        tracker.output(
            "\x1b[2J\x1b[H❯ \r\naccept edits on (shift+tab to cycle)\x1b[1;3H",
            120_002,
        );
        tracker.refresh(120_003);
        assert_eq!(
            (tracker.status.state, tracker.status.source),
            (StatusState::Idle, StatusSource::Screen)
        );
        tracker.refresh(180_000);
        assert_eq!(
            tracker.status.state,
            StatusState::Idle,
            "an old hook cannot revive interrupted work after the grace window"
        );
        tracker.output("\x1b[2J\x1b[H✻ Thinking… (esc to interrupt)", 180_004);
        tracker.refresh(180_005);
        assert_eq!(tracker.status.state, StatusState::Working);
    }
    #[test]
    fn interrupted_protocol_work_stays_settled_until_new_structured_evidence() {
        let mut tracker = StatusTracker::new(Program::Claude, 24, 100, 0);
        let work = crate::program_status::parse("state=working").unwrap();
        tracker.program_report(Some(&work), 1);
        tracker.interrupted(2);
        tracker.output(
            "\x1b[2J\x1b[H❯ \r\naccept edits on (shift+tab to cycle)\x1b[1;3H",
            3,
        );
        tracker.refresh(4);
        assert_eq!(tracker.status.state, StatusState::Idle);
        tracker.refresh(60_000);
        assert_eq!(tracker.status.state, StatusState::Idle);
        tracker.program_report(Some(&work), 60_001);
        tracker.refresh(60_002);
        assert_eq!(tracker.status.state, StatusState::Working);
        assert_eq!(tracker.status.source, StatusSource::Program);
    }

    #[test]
    fn quota_detection_uses_current_screen_and_never_marks_shell_output() {
        let mut tracker = StatusTracker::new(Program::Codex, 24, 80, 0);
        tracker.output("You've hit your usage limit. Try again later.\r\n› ", 1);
        tracker.refresh(2);
        assert!(tracker.rate_limited());
        assert_eq!(tracker.status().state, StatusState::Blocked);
        tracker.output("\x1b[2J\x1b[H› ", 3);
        tracker.refresh(4);
        assert!(!tracker.rate_limited());
        let mut shell = StatusTracker::new(Program::Shell, 24, 80, 0);
        shell.output("You've hit your usage limit", 1);
        assert!(!shell.rate_limited());
    }

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
