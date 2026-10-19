//! Shared single-row presentation for the sidebar and both session switchers.
use crate::{
    launch::Program,
    model::Session,
    status::{Source, State},
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

pub struct SessionRow<'a> {
    pub name: &'a str,
    pub icon: &'a str,
    pub icon_color: Color,
    pub status: StatusLabel,
    pub runtime: &'a str,
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
        let project_width = if area.width >= 60 && self.project.is_some() {
            14
        } else {
            0
        };
        let indent = self.indent.min(
            area.width
                .saturating_sub(status_width + age_width + project_width + 10),
        );
        let prefix = (indent + 3).min(area.width);
        let status_x = area.right().saturating_sub(status_width + 1).max(area.x);
        let age_x = status_x.saturating_sub(age_width + 1).max(area.x);
        let project_x = age_x.saturating_sub(project_width).max(area.x);
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
            Paragraph::new(clipped(self.runtime, age_width))
                .right_aligned()
                .style(Style::default().fg(MUTED))
                .render(Rect::new(age_x, area.y, age_width, 1), buffer);
        }
        if project_width > 0 {
            Paragraph::new(clipped(self.project.unwrap_or_default(), project_width - 2))
                .right_aligned()
                .style(Style::default().fg(MUTED))
                .render(Rect::new(project_x, area.y, project_width - 1, 1), buffer);
        }
    }
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
}
