//! Session switcher geometry shared by rendering and mouse hit testing.
use crate::{
    launch::Program,
    model::{App, search_scope},
    terminal::TerminalWidget,
    theme::{BORDER, MUTED, SURFACE, TEXT},
    ui::{display_status, program_color, status_color, truncate_cells},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
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

pub fn offset(selected: usize, rows: u16) -> usize {
    selected.saturating_sub(usize::from(rows.saturating_sub(1)))
}

pub fn render(frame: &mut Frame, app: &App, query: &str, selected: usize) {
    let layout = geometry(frame.area(), app.sessions.len());
    for cell in &mut frame.buffer_mut().content {
        cell.set_fg(MUTED);
    }
    frame.render_widget(Clear, layout.panel);
    frame.render_widget(
        Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(BORDER))
            .style(Style::default().bg(SURFACE).fg(TEXT)),
        layout.panel,
    );
    if layout.input.width == 0 || layout.input.height == 0 {
        return;
    }
    let (scope, _) = search_scope(query);
    let scope_label = scope.label();
    let hints = if layout.input.width >= 96 {
        "  @ agents   $ terminals   ! needs you"
    } else {
        ""
    };
    let right = format!("{hints}  {scope_label}");
    let right_width = (right.len() as u16).min(layout.input.width.saturating_sub(12));
    let input_width = layout.input.width.saturating_sub(right_width);
    let prompt = if query.is_empty() {
        "Jump to a session, agent or folder…"
    } else {
        query
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("› ", Style::default().fg(app.theme.accent())),
            Span::styled(
                truncate_cells(prompt, usize::from(input_width.saturating_sub(2))),
                Style::default().fg(if query.is_empty() { MUTED } else { TEXT }),
            ),
        ])),
        Rect::new(layout.input.x, layout.input.y, input_width, 1),
    );
    frame.render_widget(
        Paragraph::new(right).style(Style::default().fg(app.theme.accent())),
        Rect::new(
            layout.input.right() - right_width,
            layout.input.y,
            right_width,
            1,
        ),
    );
    for y in [layout.input.y + 1, layout.footer.y.saturating_sub(1)] {
        if y < layout.panel.bottom().saturating_sub(1) {
            frame.render_widget(
                Paragraph::new("─".repeat(usize::from(layout.input.width)))
                    .style(Style::default().fg(BORDER)),
                Rect::new(layout.input.x, y, layout.input.width, 1),
            );
        }
    }
    let matches = app.quick_switch_results(query);
    let start = offset(selected, layout.results.height);
    for (index, session) in matches
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(layout.results.height))
    {
        let active = index == selected;
        let area = Rect::new(
            layout.results.x,
            layout.results.y + (index - start) as u16,
            layout.results.width,
            1,
        );
        frame.render_widget(
            Block::default().style(Style::default().bg(if active {
                app.theme.selection()
            } else {
                SURFACE
            })),
            area,
        );
        let program = app.effective_program(session);
        let mark = match program {
            Program::Claude => "✳",
            Program::Codex => "◈",
            Program::Gemini => "✦",
            Program::Shell => ">",
        };
        let status = display_status(session);
        let metadata_width = if area.width >= 48 {
            24
        } else if area.width >= 30 {
            12
        } else {
            0
        };
        let name_width = area.width.saturating_sub(5 + metadata_width);
        let name = elide(&session.name, usize::from(name_width));
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    if active { "▎" } else { " " },
                    Style::default().fg(app.theme.accent()),
                ),
                Span::styled(
                    format!("{mark} "),
                    Style::default().fg(program_color(program)),
                ),
                Span::styled(
                    name,
                    Style::default().fg(TEXT).add_modifier(if active {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
                ),
            ])),
            Rect::new(area.x, area.y, area.width.saturating_sub(metadata_width), 1),
        );
        if metadata_width > 0 {
            let x = area.right() - metadata_width;
            if metadata_width == 24 {
                frame.render_widget(
                    Paragraph::new(elide(
                        session
                            .cwd
                            .trim_end_matches(['/', '\\'])
                            .rsplit(['/', '\\'])
                            .next()
                            .unwrap_or(&session.cwd),
                        11,
                    ))
                    .style(Style::default().fg(MUTED)),
                    Rect::new(x, area.y, 11, 1),
                );
            }
            frame.render_widget(
                Paragraph::new(truncate_cells(status, 11))
                    .style(Style::default().fg(status_color(session.status.as_ref(), app.theme))),
                Rect::new(area.right().saturating_sub(11), area.y, 11, 1),
            );
        }
    }
    if matches.is_empty() {
        frame.render_widget(
            Paragraph::new("No matching sessions. Try another name or filter.")
                .style(Style::default().fg(MUTED)),
            layout.results,
        );
    }
    if layout.preview.width > 0 {
        for y in layout.preview.y..layout.preview.bottom() {
            frame.render_widget(
                Paragraph::new("│").style(Style::default().fg(BORDER)),
                Rect::new(layout.preview.x - 1, y, 1, 1),
            );
        }
        if let Some(session) = matches.get(selected) {
            frame.render_widget(
                Paragraph::new(truncate_cells(
                    &session.name,
                    usize::from(layout.preview.width),
                ))
                .style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
                Rect::new(
                    layout.preview.x,
                    layout.preview.y,
                    layout.preview.width,
                    1.min(layout.preview.height),
                ),
            );
            if layout.preview.height > 1 {
                frame.render_widget(
                    Paragraph::new(truncate_cells(
                        &session.cwd,
                        usize::from(layout.preview.width),
                    ))
                    .style(Style::default().fg(MUTED)),
                    Rect::new(
                        layout.preview.x,
                        layout.preview.y + 1,
                        layout.preview.width,
                        1,
                    ),
                );
            }
            if layout.preview.height > 3 {
                let terminal_area = Rect::new(
                    layout.preview.x,
                    layout.preview.y + 3,
                    layout.preview.width,
                    layout.preview.height - 3,
                );
                if let Some(terminal) = app.terminals.get(&session.id)
                    && !terminal.screen().contents().trim().is_empty()
                {
                    frame.render_widget(TerminalWidget(terminal.screen()), terminal_area);
                } else {
                    frame.render_widget(
                        Paragraph::new("No terminal output yet.").style(Style::default().fg(MUTED)),
                        terminal_area,
                    );
                }
            }
        }
    }
    let footer = format!(
        "↑↓ move   Enter open   Esc close     {} results",
        matches.len()
    );
    frame.render_widget(
        Paragraph::new(truncate_cells(&footer, usize::from(layout.footer.width)))
            .style(Style::default().fg(MUTED)),
        layout.footer,
    );
    if input_width > 2 {
        let cursor = Line::from(query).width().min(usize::from(input_width - 3)) as u16;
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
                assert!(text.contains("@ agents"));
            } else {
                assert_eq!(layout.preview.width, 0);
            }
        }
    }
}
