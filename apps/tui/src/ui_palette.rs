//! Session switcher geometry shared by rendering and mouse hit testing.
use crate::{
    model::App,
    terminal::TerminalWidget,
    theme::{MUTED, SURFACE, TEXT},
    ui::truncate_cells,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, Paragraph},
};

pub struct Geometry {
    pub panel: Rect,
    pub input: Rect,
    pub results: Rect,
    pub preview: Rect,
    pub footer: Rect,
}

pub fn geometry(size: Rect, session_count: usize) -> Geometry {
    let width = size.width.saturating_sub(4).min(132);
    let height = size
        .height
        .saturating_sub(4)
        .min(session_count.saturating_add(6).clamp(14, 26) as u16);
    let panel = Rect::new(
        size.x + (size.width - width) / 2,
        size.y + (size.height - height) / 2,
        width,
        height,
    );
    let inner = Block::bordered().inner(panel);
    let body = Rect::new(
        inner.x.saturating_add(1),
        inner.y,
        inner.width.saturating_sub(2),
        inner.height,
    );
    let input = Rect::new(body.x, body.y, body.width, body.height.min(1));
    let footer = Rect::new(
        body.x,
        body.bottom().saturating_sub(1),
        body.width,
        body.height.min(1),
    );
    let rows = body.height.saturating_sub(4);
    let list_width = if body.width >= 86 {
        body.width * 3 / 5
    } else {
        body.width
    };
    let results = Rect::new(body.x, body.y + body.height.min(2), list_width, rows);
    let preview = Rect::new(
        results.right().saturating_add(2),
        results.y,
        body.width.saturating_sub(list_width + 2),
        rows,
    );
    Geometry {
        panel,
        input,
        results,
        preview,
        footer,
    }
}

pub fn row_height(app: &App, size: Rect) -> u16 {
    if !app.palette_expanded && size.width >= 65 {
        2
    } else {
        1
    }
}

pub fn offset(selected: usize, rows: u16) -> usize {
    selected.saturating_sub(usize::from(rows.saturating_sub(1)))
}

pub fn for_app(size: Rect, app: &App) -> Geometry {
    if app.palette_expanded || size.width < 65 {
        return geometry(size, app.sessions.len() + app.groups.len() + 9);
    }
    let tree = crate::ui::geometry(size, app).tree;
    let panel = Rect::new(tree.x, tree.y, tree.width, tree.height);
    let inner = Block::bordered().inner(panel);
    Geometry {
        panel,
        input: Rect::new(inner.x, inner.y, inner.width, inner.height.min(1)),
        results: Rect::new(
            inner.x,
            inner.y.saturating_add(2).min(inner.bottom()),
            inner.width,
            inner.height.saturating_sub(4),
        ),
        preview: Rect::default(),
        footer: Rect::new(
            inner.x,
            inner.bottom().saturating_sub(1),
            inner.width,
            inner.height.min(1),
        ),
    }
}

pub fn render(frame: &mut Frame, app: &App, query: &str, selected: usize) {
    let layout = for_app(frame.area(), app);
    frame.render_widget(Clear, layout.panel);
    frame.render_widget(
        Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(app.theme.accent()))
            .style(Style::default().bg(SURFACE).fg(TEXT)),
        layout.panel,
    );
    if layout.input.is_empty() {
        return;
    }
    frame.render_widget(
        Paragraph::new(format!(
            "> {}",
            elide(
                if query.is_empty() {
                    "Search sessions / groups"
                } else {
                    query
                },
                layout.input.width.saturating_sub(2) as usize
            )
        )),
        layout.input,
    );
    let category = if app.palette_expanded {
        crate::palette::CATEGORIES[app.palette_category]
    } else {
        "F2 expand"
    };
    if layout.panel.height > 4 {
        frame.render_widget(
            Paragraph::new(format!(
                "{category} · {} · Tab categories",
                crate::model::search_scope(query).0.label()
            ))
            .style(Style::default().fg(MUTED)),
            Rect::new(layout.input.x, layout.input.y + 1, layout.input.width, 1),
        );
    }
    let matches = app.palette_results(query);
    let row_height = row_height(app, frame.area());
    let start = offset(selected, layout.results.height / row_height);
    for (index, result) in matches
        .iter()
        .enumerate()
        .skip(start)
        .take((layout.results.height / row_height) as usize)
    {
        let active = index == selected;
        let metadata_width = if layout.results.width >= 48 { 26 } else { 0 };
        let name_width = layout.results.width.saturating_sub(metadata_width + 3) as usize;
        let name = elide(&result.title, name_width);
        let kind = match &result.target {
            crate::palette::Target::Session(_) => "·",
            crate::palette::Target::Group(_) => "/",
            crate::palette::Target::Command(_) => ">",
        };
        let line = Line::from(vec![
            Span::styled(format!("{kind} {name}"), Style::default().fg(TEXT)),
            Span::styled(
                if metadata_width > 0 {
                    format!("  {}", elide(&result.context, metadata_width as usize - 2))
                } else {
                    String::new()
                },
                Style::default().fg(MUTED),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(line).style(Style::default().bg(if active {
                app.theme.selection()
            } else {
                SURFACE
            })),
            Rect::new(
                layout.results.x,
                layout.results.y + (index - start) as u16 * row_height,
                layout.results.width,
                1,
            ),
        );
        if row_height == 2 {
            frame.render_widget(
                Paragraph::new(elide(
                    &result.context,
                    layout.results.width.saturating_sub(2) as usize,
                ))
                .style(Style::default().fg(MUTED).bg(if active {
                    app.theme.selection()
                } else {
                    SURFACE
                })),
                Rect::new(
                    layout.results.x + 2,
                    layout.results.y + (index - start) as u16 * row_height + 1,
                    layout.results.width.saturating_sub(2),
                    1,
                ),
            );
        }
    }
    if matches.is_empty() {
        frame.render_widget(
            Paragraph::new("No results. Change query or filters.")
                .style(Style::default().fg(MUTED)),
            layout.results,
        );
    }
    if !layout.preview.is_empty()
        && let Some(result) = matches.get(selected)
    {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(result.title.as_str()),
                Line::from(result.context.as_str()),
            ]),
            layout.preview,
        );
        if let Some(id) = result.target.session_id()
            && layout.preview.height > 3
        {
            let terminal_area = Rect::new(
                layout.preview.x,
                layout.preview.y + 3,
                layout.preview.width,
                layout.preview.height - 3,
            );
            if let Some(terminal) = app.terminals.get(id) {
                frame.render_widget(TerminalWidget(terminal.screen()), terminal_area);
            } else {
                frame.render_widget(
                    Paragraph::new("Waiting for session output…").style(Style::default().fg(MUTED)),
                    terminal_area,
                );
            }
        }
    }
    frame.render_widget(
        Paragraph::new(if app.palette_expanded {
            "↑↓ move · Enter open · Esc close · @ agents $ terminals ! attention"
        } else {
            "Enter open · F2 expand"
        })
        .style(Style::default().fg(MUTED)),
        layout.footer,
    );
    let cursor = Line::from(query)
        .width()
        .min(layout.input.width.saturating_sub(3) as usize) as u16;
    if layout.input.width > 2 {
        frame.set_cursor_position((layout.input.x + 2 + cursor, layout.input.y));
    }
}

fn elide(text: &str, width: usize) -> String {
    if Line::from(text).width() <= width {
        text.to_owned()
    } else if width == 0 {
        String::new()
    } else {
        format!("{}…", truncate_cells(text, width - 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    #[test]
    fn palette_previews_selected_terminal_and_fits_small_screens() {
        let mut app = App::new(1);
        app.palette_expanded = true;
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"Review API","cwd":"C:/dev/api","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let mut terminal_state = crate::terminal::TerminalState::new(24, 80);
        terminal_state.process("Live preview content", false);
        app.terminals.insert("one".into(), terminal_state);
        for (width, height) in [(132, 36), (80, 24), (30, 10), (8, 4)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| render(frame, &app, "api", 0))
                .unwrap();
            let layout = geometry(Rect::new(0, 0, width, height), app.sessions.len());
            assert!(layout.panel.right() <= width && layout.panel.bottom() <= height);
            let text = terminal
                .backend()
                .buffer()
                .content()
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            if width == 132 {
                assert!(text.contains("Live preview content"));
                assert!(text.contains("Enter open"));
            } else {
                assert_eq!(layout.preview.width, 0);
            }
        }
    }
}
