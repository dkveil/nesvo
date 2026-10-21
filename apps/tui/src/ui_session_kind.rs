use crate::{
    model::App,
    session_kind::{Picker, ReviewSource, SessionKind},
    theme::{BORDER, DANGER, MUTED, SURFACE, TEXT},
    ui::truncate_cells,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Clear, Paragraph},
};

const URL_PLACEHOLDER: &str = "https://github.com/owner/repo/pull/123";

pub fn area(size: Rect) -> Rect {
    let width = 68.min(size.width.saturating_sub(4)).max(1);
    let height = 13.min(size.height.saturating_sub(2)).max(1);
    Rect::new(
        size.x + size.width.saturating_sub(width) / 2,
        size.y + size.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn body(size: Rect) -> Rect {
    let inner = Block::bordered().inner(area(size));
    Rect::new(
        inner.x + 2.min(inner.width),
        inner.y,
        inner.width.saturating_sub(4),
        inner.height,
    )
}

fn row_area(body: Rect, index: usize) -> Rect {
    let top = 2 + index as u16 * 2;
    Rect::new(
        body.x,
        body.y + top,
        body.width,
        body.height.saturating_sub(top).min(2),
    )
}

pub fn row_at(size: Rect, picker: &Picker, column: u16, row: u16) -> Option<usize> {
    let body = body(size);
    (0..picker.rows()).find(|index| row_area(body, *index).contains((column, row).into()))
}

fn line(frame: &mut Frame, area: Rect, offset: u16, text: Line<'_>, style: Style) {
    if offset < area.height {
        frame.render_widget(
            Paragraph::new(text).style(style),
            Rect::new(area.x, area.y + offset, area.width, 1),
        );
    }
}

pub fn render(frame: &mut Frame, app: &App, picker: &Picker) {
    let size = frame.area();
    if size.width < 8 || size.height < 4 {
        return;
    }
    let outer = area(size);
    frame.render_widget(Clear, outer);
    frame.render_widget(
        Block::bordered()
            .style(Style::default().bg(SURFACE).fg(TEXT))
            .border_style(Style::default().fg(BORDER)),
        outer,
    );
    let body = body(size);
    let width = usize::from(body.width);
    let title = match picker {
        Picker::Kind { .. } => "New session kind",
        Picker::ReviewSource { .. } => "Review source",
    };
    line(
        frame,
        body,
        0,
        Line::from(truncate_cells(title, width.saturating_sub(7))),
        Style::default()
            .fg(app.theme.accent())
            .add_modifier(Modifier::BOLD),
    );
    if body.width >= 12 {
        line(
            frame,
            Rect::new(body.right() - 5, body.y, 5, body.height),
            0,
            Line::from("nesvo"),
            Style::default().fg(MUTED),
        );
    }
    line(
        frame,
        body,
        1,
        Line::from("─".repeat(width)),
        Style::default().fg(BORDER),
    );
    let rows: Vec<(String, String)> = match picker {
        Picker::Kind { .. } => SessionKind::ALL
            .iter()
            .map(|kind| (kind.label().to_owned(), kind.detail().to_owned()))
            .collect(),
        Picker::ReviewSource { url, .. } => ReviewSource::ALL
            .iter()
            .map(|source| {
                let detail = match source {
                    ReviewSource::LocalChanges => app.review_candidate().map_or_else(
                        || "Select a session in the sidebar first".to_owned(),
                        |session| format!("Opens the F4 changes dock for {}", session.name),
                    ),
                    ReviewSource::PullRequest => url.clone(),
                };
                (source.label().to_owned(), detail)
            })
            .collect(),
    };
    for (index, (label, detail)) in rows.iter().enumerate() {
        let selected = picker.selected() == index;
        let area = row_area(body, index);
        let marker = if selected { "›" } else { " " };
        line(
            frame,
            area,
            0,
            Line::from(truncate_cells(
                &format!("{marker} {}  {label}", index + 1),
                width,
            )),
            Style::default()
                .fg(if selected { TEXT } else { MUTED })
                .bg(if selected {
                    app.theme.selection()
                } else {
                    SURFACE
                })
                .add_modifier(if selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        );
        let input = matches!(picker, Picker::ReviewSource { .. }) && index == 1;
        if input {
            render_url(frame, app, area, detail, selected);
        } else {
            line(
                frame,
                area,
                1,
                Line::from(truncate_cells(&format!("     {detail}"), width)),
                Style::default().fg(MUTED),
            );
        }
    }
    if let Picker::ReviewSource {
        error: Some(error), ..
    } = picker
    {
        line(
            frame,
            body,
            7,
            Line::from(truncate_cells(error, width)),
            Style::default().fg(DANGER),
        );
    }
    let hint = match picker {
        Picker::Kind { .. } => "↑↓ j k choose · 1-3 pick · Enter open · Esc cancel",
        Picker::ReviewSource { .. } => "↑↓ choose · type or paste the URL · Enter open · Esc back",
    };
    line(
        frame,
        body,
        body.height.saturating_sub(1),
        Line::from(truncate_cells(hint, width)),
        Style::default().fg(MUTED),
    );
}

fn render_url(frame: &mut Frame, app: &App, area: Rect, url: &str, focused: bool) {
    if area.height < 2 || area.width < 8 {
        return;
    }
    let field = Rect::new(area.x + 5, area.y + 1, area.width - 5, 1);
    let visible_width = usize::from(field.width.saturating_sub(3));
    let shown = if url.is_empty() {
        URL_PLACEHOLDER.to_owned()
    } else {
        let tail: Vec<char> = url.chars().rev().take(visible_width).collect();
        tail.into_iter().rev().collect()
    };
    frame.render_widget(
        Paragraph::new(format!(" {shown}")).style(
            Style::default()
                .fg(if url.is_empty() { MUTED } else { TEXT })
                .bg(if focused {
                    app.theme.selection()
                } else {
                    BORDER
                }),
        ),
        field,
    );
    if focused {
        let offset = if url.is_empty() {
            0
        } else {
            Line::from(shown.as_str()).width() as u16
        };
        frame.set_cursor_position((
            field.x + (1 + offset).min(field.width.saturating_sub(1)),
            field.y,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn app() -> App {
        let mut app = App::new(3);
        app.event(
            json!({"type":"capabilities","workspace":"C:/work","programs":[
                {"id":"claude","available":true}
            ]}),
        )
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s1","name":"Api agent","cwd":"C:/work/api","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.onboarded = true;
        app
    }

    fn screen(app: &App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn session_kind_menu_renders_rows_and_hit_tests_at_three_sizes() {
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut app = app();
            app.session_kind = Some(Picker::Kind { selected: 1 });
            let text = screen(&app, width, height);
            for expected in [
                "New session kind",
                "› 2  Clean terminal",
                "1  Agent session",
                "3  Review",
                "Esc cancel",
            ] {
                assert!(
                    text.contains(expected),
                    "{width}x{height} {expected}\n{text}"
                );
            }
            let size = Rect::new(0, 0, width, height);
            let picker = app.session_kind.as_ref().unwrap();
            for index in 0..3 {
                let target = row_area(body(size), index);
                assert_eq!(
                    row_at(size, picker, target.x, target.y + 1),
                    Some(index),
                    "{width}x{height}"
                );
            }
            assert_eq!(row_at(size, picker, 0, 0), None);
            assert!(area(size).bottom() <= height && area(size).right() <= width);
        }
    }

    #[test]
    fn session_kind_review_source_renders_session_url_and_error() {
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut app = app();
            app.session_kind = Some(Picker::ReviewSource {
                selected: 1,
                url: "https://github.com/o/r/issues/1".into(),
                error: Some("Use a GitHub pull request URL"),
            });
            let text = screen(&app, width, height);
            for expected in [
                "Review source",
                "1  Local changes of a session",
                "Opens the F4 changes dock for Api agent",
                "› 2  GitHub PR URL",
                "github.com/o/r/issues/1",
                "Use a GitHub pull request URL",
                "Esc back",
            ] {
                assert!(
                    text.contains(expected),
                    "{width}x{height} {expected}\n{text}"
                );
            }
            app.sessions.clear();
            app.session_kind = Some(Picker::ReviewSource {
                selected: 0,
                url: String::new(),
                error: None,
            });
            let text = screen(&app, width, height);
            assert!(
                text.contains("Select a session in the sidebar first"),
                "{text}"
            );
            assert!(text.contains(URL_PLACEHOLDER), "{text}");
        }
    }
}
