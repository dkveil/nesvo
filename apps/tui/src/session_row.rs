//! Shared single-row presentation for the sidebar and both session switchers.
use crate::{
    launch::Program,
    model::Session,
    status::{EvidenceSource, Source, State},
    theme::{DANGER, MUTED, SUCCESS, TEXT, WARNING},
};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

pub fn duration_label(seconds: u64) -> String {
    let minutes = seconds / 60;
    match minutes {
        0 => "<1m".into(),
        1..60 => format!("{minutes}m"),
        60..1440 => format!("{}h{:02}m", minutes / 60, minutes % 60),
        _ => format!("{}d{}h", minutes / 1440, minutes % 1440 / 60),
    }
}

pub struct StatusLabel {
    pub text: &'static str,
    pub color: Color,
}

pub fn status_label(session: &Session, program: Program) -> StatusLabel {
    let label = |text, color| StatusLabel { text, color };
    if let Some(readiness) = &session.readiness {
        match readiness.phase {
            crate::status::ReadinessPhase::Starting => return label("starting", MUTED),
            crate::status::ReadinessPhase::TimedOut => return label("start fail", DANGER),
            _ => {}
        }
    }
    if let Some(attention) = &session.current_attention
        && attention.priority > 0
    {
        return label(
            match attention.reason.as_deref() {
                Some("startup") => "start fail",
                Some("failure") => "failed",
                _ if attention
                    .status
                    .as_ref()
                    .is_some_and(|s| s.source == Source::Screen) =>
                {
                    "~needs you"
                }
                _ => "needs you",
            },
            if attention.priority == 1 {
                DANGER
            } else {
                WARNING
            },
        );
    }
    if session.rate_limited {
        return label("needs you", WARNING);
    }
    let Some(status) = session.status.as_ref() else {
        return if session.running && program == Program::Shell {
            label("terminal", MUTED)
        } else if !session.running {
            label("exited", MUTED)
        } else {
            label("unknown", MUTED)
        };
    };
    if let Some(freshness) = status.freshness.as_ref().filter(|f| f.stale) {
        return label(
            match freshness.last_known.as_ref().map(|known| known.state) {
                Some(State::Working) => "?working",
                Some(State::Idle) => "?idle",
                Some(State::Question | State::Blocked) => "?needs you",
                Some(State::Done) => "?done",
                Some(State::Failed) => "?failed",
                Some(State::Unknown) | None => "?stale",
            },
            MUTED,
        );
    }
    if status.source == Source::Activity {
        return if program == Program::Shell && session.running {
            label("terminal", MUTED)
        } else {
            label("unknown", MUTED)
        };
    }
    let inferred = status.source == Source::Screen;
    match status.state {
        State::Working => label(if inferred { "~working" } else { "working" }, WARNING),
        State::Idle => label(if inferred { "~idle" } else { "idle" }, SUCCESS),
        State::Question | State::Blocked => {
            label(if inferred { "~needs you" } else { "needs you" }, WARNING)
        }
        State::Done => label(if inferred { "~done" } else { "done" }, SUCCESS),
        State::Failed => label(if inferred { "~failed" } else { "failed" }, DANGER),
        State::Unknown => label("unknown", MUTED),
    }
}

pub fn status_source(session: &Session) -> &'static str {
    let status = session
        .current_attention
        .as_ref()
        .filter(|attention| attention.priority > 0)
        .and_then(|attention| attention.status.as_ref())
        .or(session.status.as_ref());
    match status.map(|status| status.source) {
        Some(Source::Program) => "program",
        Some(Source::Hook) => "hook",
        Some(Source::Screen) => "screen",
        Some(Source::Process) => "process",
        Some(Source::Activity) | None => "unknown",
    }
}

fn state_word(state: State) -> &'static str {
    match state {
        State::Working => "working",
        State::Idle => "idle",
        State::Done => "done",
        State::Blocked => "blocked",
        State::Question => "question",
        State::Failed => "failed",
        State::Unknown => "unknown",
    }
}

pub fn freshness_header(session: &Session) -> Option<String> {
    let freshness = session.status.as_ref()?.freshness.as_ref()?;
    let label = if session.freshness_label.is_empty() {
        freshness.age_label(0)
    } else {
        session.freshness_label.clone()
    };
    let age = label.trim_start_matches('!');
    Some(match (freshness.source, freshness.last_known.as_ref()) {
        (_, Some(known)) if freshness.stale => {
            format!("stale · last {} {age} ago", state_word(known.state))
        }
        (EvidenceSource::Hook, _) => format!("hook {age}"),
        (EvidenceSource::Process, _) => format!("exit {age} ago"),
        (EvidenceSource::Journal, _) => format!("journal {age}"),
        (EvidenceSource::Unknown, _) => return None,
    })
}

pub struct SessionRow<'a> {
    pub name: &'a str,
    pub icon: &'a str,
    pub icon_color: Color,
    pub status: StatusLabel,
    pub runtime: &'a str,
    pub freshness: &'a str,
    pub project: Option<&'a str>,
    pub indent: u16,
    pub query: &'a str,
    pub accent: Color,
}

fn clipped(text: &str, width: u16) -> String {
    if Line::from(text).width() <= usize::from(width) {
        return text.into();
    }
    if width == 0 {
        return String::new();
    }
    format!(
        "{}…",
        crate::ui::truncate_cells(text, usize::from(width - 1))
    )
}

impl Widget for SessionRow<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let status_width = if area.width >= 20 { 10 } else { 0 };
        let age_width = if area.width >= 30 { 6 } else { 0 };
        let freshness_width = if area.width >= 40 && !self.freshness.is_empty() {
            5
        } else {
            0
        };
        let stale = self.freshness.starts_with('!');
        let project_width = if area.width >= 60 && self.project.is_some() {
            14
        } else {
            0
        };
        let indent = self.indent.min(
            area.width
                .saturating_sub(status_width + age_width + freshness_width + project_width + 10),
        );
        let prefix = (indent + 3).min(area.width);
        let status_x = area.right().saturating_sub(status_width + 1).max(area.x);
        let age_x = status_x.saturating_sub(age_width + 1).max(area.x);
        let freshness_x = age_x.saturating_sub(freshness_width).max(area.x);
        let project_x = freshness_x.saturating_sub(project_width).max(area.x);
        let name_width = project_x.saturating_sub(area.x + prefix + 1);
        Paragraph::new(self.icon)
            .style(Style::default().fg(self.icon_color))
            .render(
                Rect::new(
                    area.x + indent + 1,
                    area.y,
                    area.width.saturating_sub(indent + 1).min(1),
                    1,
                ),
                buffer,
            );
        let name = clipped(self.name, name_width);
        let mut wanted = self
            .query
            .chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(char::to_lowercase)
            .peekable();
        let spans: Vec<_> = name
            .chars()
            .map(|c| {
                let matched = wanted
                    .peek()
                    .is_some_and(|next| c.to_lowercase().any(|v| v == *next));
                if matched {
                    wanted.next();
                }
                Span::styled(
                    c.to_string(),
                    Style::default()
                        .fg(if matched { self.accent } else { TEXT })
                        .add_modifier(Modifier::BOLD),
                )
            })
            .collect();
        Paragraph::new(Line::from(spans))
            .render(Rect::new(area.x + prefix, area.y, name_width, 1), buffer);
        if status_width > 0 {
            Paragraph::new(self.status.text)
                .right_aligned()
                .style(Style::default().fg(self.status.color))
                .render(Rect::new(status_x, area.y, status_width, 1), buffer);
        }
        if age_width > 0 {
            let (runtime, color) = if stale && freshness_width == 0 {
                (self.freshness, WARNING)
            } else {
                (self.runtime, MUTED)
            };
            Paragraph::new(clipped(runtime, age_width))
                .right_aligned()
                .style(Style::default().fg(color))
                .render(Rect::new(age_x, area.y, age_width, 1), buffer);
        }
        if freshness_width > 0 {
            Paragraph::new(clipped(self.freshness, freshness_width - 1))
                .right_aligned()
                .style(Style::default().fg(if stale { WARNING } else { MUTED }))
                .render(
                    Rect::new(freshness_x, area.y, freshness_width - 1, 1),
                    buffer,
                );
        }
        if project_width > 0 {
            Paragraph::new(clipped(self.project.unwrap_or_default(), project_width - 2))
                .right_aligned()
                .style(Style::default().fg(MUTED))
                .render(Rect::new(project_x, area.y, project_width - 1, 1), buffer);
        }
    }
}

const BADGE_WIDTH: u16 = 6;

pub fn badge_area(area: Rect) -> Option<Rect> {
    if area.width < 30 {
        return None;
    }
    let status_x = area.right().saturating_sub(11).max(area.x);
    let x = status_x.saturating_sub(BADGE_WIDTH + 1).max(area.x);
    Some(Rect::new(x, area.y, BADGE_WIDTH, 1))
}

pub fn paint_badge(area: Rect, buffer: &mut Buffer, label: &StatusLabel) {
    let Some(slot) = badge_area(area) else {
        return;
    };
    Paragraph::new(" ".repeat(usize::from(BADGE_WIDTH))).render(slot, buffer);
    Paragraph::new(clipped(label.text, BADGE_WIDTH))
        .right_aligned()
        .style(Style::default().fg(label.color))
        .render(slot, buffer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn columns_preserve_unicode_status_and_duration_at_sidebar_and_palette_widths() {
        for width in [0, 1, 8, 20, 30, 32, 40, 42, 60, 66, 100] {
            let area = Rect::new(3, 2, width, 1);
            let mut buffer = Buffer::empty(Rect::new(0, 0, 110, 5));
            SessionRow {
                name: "工程 long session title with emoji 🎯",
                icon: "✳",
                icon_color: TEXT,
                status: StatusLabel {
                    text: "~needs you",
                    color: WARNING,
                },
                runtime: "2h14m",
                freshness: "",
                project: Some("project"),
                indent: 8,
                query: "工程",
                accent: TEXT,
            }
            .render(area, &mut buffer);
            let line: String = (area.x..area.right())
                .map(|x| buffer[(x, 2)].symbol())
                .collect();
            if width >= 20 {
                assert!(line.ends_with("~needs you "), "{width}: {line}");
            }
            if width >= 30 {
                assert!(line.contains("2h14m"), "{width}: {line}");
            }
            assert_eq!(buffer[(area.right(), 2)].symbol(), " ");
        }
    }
    #[test]
    fn worktree_badge_replaces_the_runtime_column_and_keeps_the_status() {
        for width in [20, 30, 32, 42, 66] {
            let area = Rect::new(3, 2, width, 1);
            let mut buffer = Buffer::empty(Rect::new(0, 0, 110, 5));
            SessionRow {
                name: "Feature work",
                icon: "✳",
                icon_color: TEXT,
                status: StatusLabel {
                    text: "idle",
                    color: SUCCESS,
                },
                runtime: "2h14m",
                freshness: "",
                project: None,
                indent: 0,
                query: "",
                accent: TEXT,
            }
            .render(area, &mut buffer);
            paint_badge(
                area,
                &mut buffer,
                &StatusLabel {
                    text: "setup…",
                    color: WARNING,
                },
            );
            let line: String = (area.x..area.right())
                .map(|x| buffer[(x, 2)].symbol())
                .collect();
            assert!(line.ends_with("idle "), "{width}: {line}");
            if width >= 30 {
                assert!(line.contains("setup…"), "{width}: {line}");
                assert!(!line.contains("2h14m"), "{width}: {line}");
            } else {
                assert!(!line.contains("setup"), "{width}: {line}");
            }
        }
    }
    #[test]
    fn attention_labels_use_current_state_and_do_not_replace_working_with_unread_history() {
        let mut session: Session = serde_json::from_value(json!({"id":"s","name":"S","cwd":".","running":true,"program":"claude","cols":80,"rows":24,"groupId":null,"controllerId":null,"attention":{"sequence":1,"kind":"permission","at":1,"unread":true},"status":{"state":"working","source":"screen","evidence":"hook","updatedAt":2}})).unwrap();
        assert_eq!(status_label(&session, Program::Claude).text, "working");
        session.status.as_mut().unwrap().state = State::Blocked;
        assert_eq!(status_label(&session, Program::Claude).text, "needs you");
        session.status.as_mut().unwrap().source = Source::Screen;
        assert_eq!(status_label(&session, Program::Claude).text, "~needs you");
        session.status.as_mut().unwrap().source = Source::Activity;
        assert_eq!(status_label(&session, Program::Claude).text, "unknown");
    }
    #[test]
    fn launch_phase_is_visible_without_inventing_an_idle_agent() {
        let mut session: Session = serde_json::from_value(json!({"id":"s","name":"S","cwd":".","running":true,"program":"claude","cols":80,"rows":24,"groupId":null,"controllerId":null,"status":{"state":"unknown","source":"activity","updatedAt":0},"readiness":{"phase":"starting","initialized":false,"reason":"awaiting provider readiness"}})).unwrap();
        assert_eq!(status_label(&session, Program::Claude).text, "starting");
        session.readiness.as_mut().unwrap().phase = crate::status::ReadinessPhase::TimedOut;
        assert_eq!(status_label(&session, Program::Claude).text, "start fail");
        session.readiness = None;
        assert_eq!(
            status_label(&session, Program::Claude).text,
            "unknown",
            "legacy hosts remain honest"
        );
    }

    fn freshness_snapshot() -> serde_json::Value {
        json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"fresh","name":"Fresh task","cwd":".","cols":80,"rows":24,"running":true,
             "program":"claude","groupId":null,"controllerId":null,
             "status":{"state":"working","source":"screen","evidence":"hook","updatedAt":1,
                "freshness":{"source":"hook","observedAt":1,"ageMs":120_000,"stale":false,"boundMs":4000,"lastKnown":null}}},
            {"id":"lost","name":"Lost task","cwd":".","cols":80,"rows":24,"running":true,
             "program":"codex","groupId":null,"controllerId":null,
             "status":{"state":"unknown","source":"screen","evidence":"hook","updatedAt":1,
                "freshness":{"source":"journal","observedAt":1,"ageMs":754_000,"stale":true,"boundMs":4000,
                    "lastKnown":{"state":"working","observedAt":1}}}},
            {"id":"legacy","name":"Legacy task","cwd":".","cols":80,"rows":24,"running":true,
             "program":"gemini","groupId":null,"controllerId":null,
             "status":{"state":"idle","source":"screen","evidence":"hook","updatedAt":1}}
        ]})
    }

    #[test]
    fn stale_sessions_show_the_last_known_state_as_a_marker_not_a_live_state() {
        let mut app = crate::model::App::new(1);
        app.event(freshness_snapshot()).unwrap();
        app.refresh_session_times(std::time::Instant::now());
        let fresh = app.session("fresh").unwrap();
        let lost = app.session("lost").unwrap();
        let legacy = app.session("legacy").unwrap();
        assert_eq!(status_label(fresh, Program::Claude).text, "working");
        assert_eq!(status_label(lost, Program::Codex).text, "?working");
        assert_eq!(status_label(legacy, Program::Gemini).text, "idle");
        assert_eq!(fresh.freshness_label, "2m");
        assert_eq!(lost.freshness_label, "!12m");
        assert!(legacy.freshness_label.is_empty());
        assert_eq!(freshness_header(fresh).as_deref(), Some("hook 2m"));
        assert_eq!(
            freshness_header(lost).as_deref(),
            Some("stale · last working 12m ago")
        );
        assert_eq!(freshness_header(legacy), None);
    }

    #[test]
    fn rows_and_pane_header_show_evidence_age_and_stale_marker_at_supported_sizes() {
        use ratatui::{Terminal, backend::TestBackend};
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut app = crate::model::App::new(1);
            app.event(freshness_snapshot()).unwrap();
            app.refresh_session_times(std::time::Instant::now());
            app.panes[0] = Some("lost".into());
            let area = Rect::new(0, 0, width, height);
            let layout = crate::ui::geometry(area, &app);
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| crate::ui::render(frame, &app, 0))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let line = |y: u16, from: u16, to: u16| -> String {
                (from..to).map(|x| buffer[(x, y)].symbol()).collect()
            };
            let tree = crate::ui::tree_content(layout.tree);
            let rows: Vec<String> = (tree.y..tree.bottom())
                .map(|y| line(y, tree.x, tree.right()))
                .collect();
            let row = |name: &str| {
                rows.iter()
                    .find(|row| row.contains(name))
                    .unwrap_or_else(|| panic!("{width}x{height}: {name} missing in {rows:?}"))
                    .clone()
            };
            let lost = row("Lost t");
            assert!(lost.contains("?working"), "{width}x{height}: {lost}");
            assert!(lost.contains("!12m"), "{width}x{height}: {lost}");
            let fresh = row("Fresh");
            assert!(fresh.contains("working") && !fresh.contains("?working"));
            if tree.width >= 40 {
                assert!(fresh.contains("2m "), "{width}x{height}: {fresh}");
            }
            let legacy = row("Legacy");
            assert!(legacy.contains("idle") && !legacy.contains('!'), "{legacy}");
            let pane = layout.panes[0];
            let footer = line(pane.bottom() - 1, pane.x, pane.right());
            assert!(
                footer.contains("stale · last working 12m ago"),
                "{width}x{height}: {footer}"
            );
        }
    }
}
