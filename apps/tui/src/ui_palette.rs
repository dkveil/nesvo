//! Session switcher geometry shared by rendering and mouse hit testing.
use crate::{
    model::App,
    terminal::TerminalWidget,
    theme::{BORDER, MUTED, SURFACE, TEXT},
    ui::truncate_cells,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

pub struct Geometry {
    pub panel: Rect,
    pub input: Rect,
    pub results: Rect,
    pub preview: Rect,
    pub footer: Rect,
}

pub fn geometry(size: Rect, session_count: usize) -> Geometry {
    let width = size.width.saturating_sub(4).min(116);
    let height = size
        .height
        .saturating_sub(4)
        .min(session_count.saturating_add(8).clamp(16, 28) as u16);
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
    let input = Rect::new(
        body.x + 1,
        body.y + 1,
        body.width.saturating_sub(2),
        body.height.min(1),
    );
    let footer = Rect::new(
        body.x,
        body.bottom().saturating_sub(1),
        body.width,
        body.height.min(1),
    );
    let rows = body.height.saturating_sub(6);
    let list_width = if body.width >= 86 {
        body.width * 3 / 5
    } else {
        body.width
    };
    let results = Rect::new(body.x, body.y + body.height.min(4), list_width, rows);
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

pub fn row_height(_app: &App, _size: Rect) -> u16 {
    1
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

pub fn category_areas(size: Rect, app: &App) -> Vec<(usize, Rect)> {
    if !app.palette_expanded {
        return vec![];
    }
    let layout = for_app(size, app);
    let mut x = layout.input.x;
    crate::palette::CATEGORIES
        .iter()
        .enumerate()
        .filter_map(|(index, label)| {
            let width = label.len() as u16 + 4;
            let target = Rect::new(x, layout.input.y + 2, width, 1);
            x += width + 1;
            (target.right() <= layout.input.right() && target.bottom() <= layout.panel.bottom())
                .then_some((index, target))
        })
        .collect()
}

pub fn render(frame: &mut Frame, app: &App, query: &str, selected: usize) {
    let layout = for_app(frame.area(), app);
    frame.render_widget(Clear, layout.panel);
    let inline = !app.palette_expanded && frame.area().width >= 65;
    frame.render_widget(
        Block::default().style(Style::default().bg(SURFACE)),
        layout.panel,
    );
    frame.render_widget(
        Block::bordered()
            .border_style(Style::default().fg(if inline { app.theme.accent() } else { BORDER }))
            .style(Style::default().bg(SURFACE).fg(TEXT)),
        if inline {
            Rect::new(
                layout.panel.x,
                layout.panel.y,
                layout.panel.width,
                layout.panel.height.min(3),
            )
        } else {
            layout.panel
        },
    );
    if !inline {
        frame.render_widget(
            Block::bordered()
                .border_style(Style::default().fg(app.theme.accent()))
                .style(Style::default().bg(crate::theme::BACKGROUND)),
            Rect::new(
                layout.input.x.saturating_sub(1),
                layout.input.y.saturating_sub(1),
                layout.input.width + 2,
                3,
            )
            .intersection(layout.panel),
        );
    }
    if layout.input.is_empty() {
        return;
    }
    frame.render_widget(
        Paragraph::new(format!(
            "⌕ {}",
            elide(
                if query.is_empty() {
                    "Search sessions, groups, commands…"
                } else {
                    query
                },
                layout.input.width.saturating_sub(2) as usize
            )
        ))
        .style(Style::default().bg(crate::theme::BACKGROUND).fg(TEXT)),
        layout.input,
    );
    for (index, target) in category_areas(frame.area(), app) {
        let selected = index == app.palette_category;
        frame.render_widget(
            Paragraph::new(format!(" {} ", crate::palette::CATEGORIES[index]))
                .centered()
                .style(
                    Style::default()
                        .fg(if selected { TEXT } else { MUTED })
                        .bg(if selected {
                            app.theme.selection()
                        } else {
                            crate::theme::BACKGROUND
                        }),
                ),
            target,
        );
    }
    let scope_label = crate::model::search_scope(query).0.label();
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
        frame.render_widget(
            Block::default().style(Style::default().bg(if active {
                app.theme.selection()
            } else {
                SURFACE
            })),
            Rect::new(
                layout.results.x,
                layout.results.y + (index - start) as u16 * row_height,
                layout.results.width,
                row_height,
            ),
        );
        let row_y = layout.results.y + (index - start) as u16 * row_height;
        let session = result.target.session_id().and_then(|id| app.session(id));
        if let Some(session) = session {
            let program = app.effective_program(session);
            let project = session
                .cwd
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(&session.cwd);
            frame.render_widget(
                crate::session_row::SessionRow {
                    name: &session.name,
                    icon: program.icon(app.ascii_icons),
                    icon_color: crate::ui::program_color(program),
                    status: crate::session_row::status_label(session, program),
                    runtime: &session.runtime_label,
                    project: (!inline).then_some(project),
                    indent: 0,
                    query: crate::model::search_scope(query).1,
                    accent: app.theme.accent(),
                },
                Rect::new(layout.results.x, row_y, layout.results.width, 1),
            );
            continue;
        }
        let name = elide(
            &result.title,
            layout.results.width.saturating_sub(5) as usize,
        );
        let kind = match &result.target {
            crate::palette::Target::Group(_) => "/",
            crate::palette::Target::Command(_) => ">",
            crate::palette::Target::Session(_) => "·",
        };
        let mut spans = vec![Span::styled(
            format!(" {kind} "),
            Style::default().fg(MUTED),
        )];
        spans.extend(matched_name(&name, query, app.theme.accent()));
        frame.render_widget(
            Paragraph::new(Line::from(spans)),
            Rect::new(layout.results.x, row_y, layout.results.width, 1),
        );
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
            Block::default()
                .borders(Borders::LEFT)
                .border_style(Style::default().fg(BORDER)),
            Rect::new(
                layout.preview.x.saturating_sub(1),
                layout.preview.y,
                1,
                layout.preview.height,
            ),
        );
        let attention = result
            .target
            .session_id()
            .and_then(|id| app.session(id))
            .and_then(|session| {
                session
                    .attention
                    .as_ref()
                    .filter(|a| a.unread && !session.muted)
            })
            .map(|a| {
                format!(
                    "New {}{}",
                    if a.source == Some(crate::status::Source::Screen) {
                        "~"
                    } else {
                        ""
                    },
                    a.kind
                )
            })
            .unwrap_or_default();
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(
                    elide(&result.title, layout.preview.width as usize),
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                ),
                Line::styled(
                    elide(&result.context, layout.preview.width as usize),
                    Style::default().fg(MUTED),
                ),
                Line::styled(
                    elide(&attention, layout.preview.width as usize),
                    Style::default().fg(crate::theme::WARNING),
                ),
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
        Paragraph::new(Line::from(crate::ui::shortcut_spans(
            &if app.palette_expanded {
                format!("↑↓ move · Enter open · Tab filter · Esc close · {scope_label}")
            } else {
                "Enter open · F2 expand".to_owned()
            },
        )))
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

fn matched_name(name: &str, query: &str, accent: ratatui::style::Color) -> Vec<Span<'static>> {
    let mut wanted = crate::model::search_scope(query)
        .1
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .peekable();
    name.chars()
        .map(|c| {
            let matched = wanted
                .peek()
                .is_some_and(|next| c.to_lowercase().any(|lower| lower == *next));
            if matched {
                wanted.next();
            }
            Span::styled(
                c.to_string(),
                Style::default()
                    .fg(if matched { accent } else { TEXT })
                    .add_modifier(Modifier::BOLD),
            )
        })
        .collect()
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
    fn selection_covers_the_complete_result_row() {
        let mut app = App::new(1);
        app.palette_expanded = true;
        let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
        terminal.draw(|f| render(f, &app, "", 0)).unwrap();
        let layout = for_app(Rect::new(0, 0, 100, 32), &app);
        for y in layout.results.y..layout.results.y + 1 {
            for x in layout.results.x..layout.results.right() {
                assert_eq!(
                    terminal.backend().buffer()[(x, y)].bg,
                    app.theme.selection()
                );
            }
        }
    }

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
                assert!(
                    text.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .contains("Enter open")
                );
            } else {
                assert_eq!(layout.preview.width, 0);
            }
        }
    }
    #[test]
    fn single_line_provider_project_and_status_do_not_overlap() {
        let mut app = App::new(1);
        app.palette_expanded = true;
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"工程 very long session title that must be clipped","cwd":"C:/dev/project","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,"status":{"state":"question","source":"screen","updatedAt":1}}
        ]})).unwrap();
        let size = Rect::new(0, 0, 150, 44);
        let layout = for_app(size, &app);
        let mut terminal = Terminal::new(TestBackend::new(150, 44)).unwrap();
        terminal
            .draw(|frame| render(frame, &app, "工程", 0))
            .unwrap();
        let line: String = (layout.results.x..layout.results.right())
            .map(|x| terminal.backend().buffer()[(x, layout.results.y)].symbol())
            .collect();
        assert!(
            line.contains("✳") && line.contains("project") && line.contains("~needs you"),
            "{line}"
        );
        assert_eq!(row_height(&app, size), 1);
        app.ascii_icons = true;
        terminal
            .draw(|frame| render(frame, &app, "工程", 0))
            .unwrap();
        assert_eq!(
            terminal.backend().buffer()[(layout.results.x + 1, layout.results.y)].symbol(),
            "C"
        );
    }
}
