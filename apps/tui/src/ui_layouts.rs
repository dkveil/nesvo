use crate::{
    layouts::{Entry, Picker},
    model::App,
    theme::{BORDER, MUTED, SURFACE, TEXT, WARNING},
    ui::truncate_cells,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};

const CHROME_ROWS: u16 = 6;

pub fn area(size: Rect, entries: usize) -> Rect {
    let width = 76.min(size.width.saturating_sub(4)).max(1);
    let wanted = entries as u16 + CHROME_ROWS + 2;
    let height = wanted.min(size.height.saturating_sub(2)).max(1);
    Rect::new(
        size.x + size.width.saturating_sub(width) / 2,
        size.y + size.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn body(outer: Rect) -> Rect {
    let inner = Block::bordered().inner(outer);
    Rect::new(
        inner.x + 1.min(inner.width),
        inner.y,
        inner.width.saturating_sub(2),
        inner.height,
    )
}

fn line(frame: &mut Frame, area: Rect, offset: u16, text: Line<'_>, style: Style) {
    if offset < area.height {
        frame.render_widget(
            Paragraph::new(text).style(style),
            Rect::new(area.x, area.y + offset, area.width, 1),
        );
    }
}

fn visible_rows(body: Rect) -> usize {
    usize::from(body.height.saturating_sub(CHROME_ROWS - 1))
}

fn first_row(selected: usize, visible: usize) -> usize {
    (selected + 1).saturating_sub(visible.max(1))
}

fn entry_text(entry: &Entry, width: u16, columns: usize) -> (String, bool) {
    let marks = format!(
        "{}{}",
        if entry.active { "●" } else { " " },
        if entry.default { "★" } else { " " }
    );
    let blocked = width < entry.layout.min_columns;
    let detail = if blocked {
        format!("needs {} columns", entry.layout.min_columns)
    } else {
        entry.layout.tree.summary()
    };
    let name = truncate_cells(&entry.layout.name, 22);
    let text = format!("{marks} {name:<22}  {:<8} {detail}", entry.origin.label());
    (truncate_cells(&text, columns), blocked)
}

pub fn render(frame: &mut Frame, app: &App, picker: &Picker) {
    let size = frame.area();
    if size.width < 12 || size.height < 6 {
        return;
    }
    let entries = app.layouts.entries(app.project_key().as_deref());
    let outer = area(size, entries.len());
    frame.render_widget(Clear, outer);
    frame.render_widget(
        Block::bordered()
            .style(Style::default().bg(SURFACE).fg(TEXT))
            .border_style(Style::default().fg(BORDER)),
        outer,
    );
    let body = body(outer);
    let columns = usize::from(body.width);
    let scope = app
        .project_key()
        .map_or_else(|| "host layouts".to_owned(), |key| format!("project {key}"));
    line(
        frame,
        body,
        0,
        Line::from(vec![
            Span::styled(
                "Layouts",
                Style::default()
                    .fg(app.theme.accent())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                truncate_cells(&format!("  · {scope}"), columns.saturating_sub(7)),
                Style::default().fg(MUTED),
            ),
        ]),
        Style::default(),
    );
    line(
        frame,
        body,
        1,
        Line::from("─".repeat(columns)),
        Style::default().fg(BORDER),
    );
    let visible = visible_rows(body);
    let start = first_row(picker.selected, visible);
    for (offset, (index, entry)) in entries
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .enumerate()
    {
        let selected = index == picker.selected;
        let (text, blocked) = entry_text(entry, size.width, columns.saturating_sub(2));
        let marker = if selected { "›" } else { " " };
        line(
            frame,
            body,
            2 + offset as u16,
            Line::from(format!("{marker} {text}")),
            Style::default()
                .fg(if blocked {
                    MUTED
                } else if selected {
                    TEXT
                } else {
                    MUTED
                })
                .bg(if selected {
                    app.theme.selection()
                } else {
                    SURFACE
                })
                .add_modifier(if selected && !blocked {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        );
    }
    let status_row = body.height.saturating_sub(2);
    if let Some(naming) = &picker.naming {
        let label = if naming.renaming.is_some() {
            "Rename: "
        } else {
            "Save as: "
        };
        let shown = truncate_cells(&naming.value, columns.saturating_sub(label.len() + 1));
        line(
            frame,
            body,
            status_row,
            Line::from(vec![
                Span::styled(label, Style::default().fg(MUTED)),
                Span::styled(shown.clone(), Style::default().fg(TEXT)),
            ]),
            Style::default(),
        );
        let cursor = body.x + (label.len() + Line::from(shown.as_str()).width()) as u16;
        if cursor < body.right() && status_row < body.height {
            frame.set_cursor_position((cursor, body.y + status_row));
        }
    } else if let Some(message) = &picker.message {
        line(
            frame,
            body,
            status_row,
            Line::from(truncate_cells(message, columns)),
            Style::default().fg(WARNING),
        );
    }
    let hint = if picker.naming.is_some() {
        "Enter confirm · Esc cancel"
    } else {
        "Enter apply · s save · r rename · d delete · D default · Esc"
    };
    line(
        frame,
        body,
        body.height.saturating_sub(1),
        Line::from(truncate_cells(hint, columns)),
        Style::default().fg(MUTED),
    );
}

#[cfg(test)]
mod tests {
    use crate::{layouts, model::App};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, layout::Rect};
    use serde_json::json;

    const SIZES: [(u16, u16); 3] = [(80, 24), (100, 32), (150, 44)];

    fn app() -> App {
        let mut app = App::new(9);
        app.event(
            json!({"type":"capabilities","workspace":"/work","gitDiff":true,"programs":[
                {"id":"claude","available":true},{"id":"shell","available":true}
            ]}),
        )
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"agent","name":"Agent work","cwd":"/work","program":"claude","cols":80,"rows":24,
                "running":true,"groupId":null,"controllerId":null,
                "repositoryContext":{"source":"launchDirectory","state":"ready","name":"nesvo",
                    "branch":"main","observedAt":1,"revision":1}},
            {"id":"shell","name":"Shell","cwd":"/work","cols":80,"rows":24,"running":true,
                "groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app
    }

    fn draw(app: &App, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    fn screen(buffer: &Buffer) -> String {
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn region(buffer: &Buffer, area: Rect) -> String {
        (area.y..area.bottom())
            .map(|y| {
                (area.x..area.right())
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn layouts_dialog_lists_shipped_layouts_at_each_size() {
        for (width, height) in SIZES {
            let mut app = app();
            layouts::open(&mut app);
            let text = screen(&draw(&app, width, height));
            assert!(text.contains("Layouts"), "{width}x{height}");
            assert!(text.contains("project nesvo"), "{width}x{height}");
            for name in [
                "Agent + Terminal",
                "Agent + Review",
                "Agent + Files",
                "Quad",
            ] {
                assert!(text.contains(name), "{name} at {width}x{height}");
            }
            assert_eq!(
                text.contains("needs 150 columns"),
                width < 150,
                "{width}x{height}"
            );
            assert!(text.contains("Enter apply"), "{width}x{height}");
        }
    }

    #[test]
    fn layouts_dialog_shows_the_name_field_and_the_saved_layout() {
        let mut app = app();
        layouts::open(&mut app);
        layouts::key(
            &mut app,
            KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE),
            100,
        );
        let text = screen(&draw(&app, 100, 32));
        assert!(text.contains("Save as: Layout 1"));
        assert!(text.contains("Enter confirm · Esc cancel"));
        layouts::key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            100,
        );
        let text = screen(&draw(&app, 100, 32));
        assert!(text.contains("Saved layout Layout 1."));
        assert!(text.contains("Layout 1"));
        assert!(text.contains("project"));
    }

    #[test]
    fn layouts_view_leaves_render_hints_and_session_leaves_render_terminals() {
        for (width, height) in SIZES {
            let mut app = app();
            let files = layouts::shipped()[2].clone();
            layouts::apply(&mut app, &files, width).unwrap();
            let area = Rect::new(0, 0, width, height);
            let geometry = crate::ui::geometry(area, &app);
            assert!(!geometry.panes[0].is_empty(), "{width}x{height}");
            assert!(geometry.panes[1].is_empty(), "{width}x{height}");
            assert!(!geometry.views[1].is_empty(), "{width}x{height}");
            assert!(!geometry.panes[0].intersects(geometry.views[1]));
            let buffer = draw(&app, width, height);
            let view = region(&buffer, geometry.views[1]);
            assert!(view.contains("Files"), "{width}x{height}: {view}");
            assert!(view.contains("browse files"), "{width}x{height}: {view}");
            assert_eq!(app.active_id(), Some("agent"));
        }
    }

    #[test]
    fn layouts_review_leaf_hosts_the_review_on_wide_screens_only() {
        let review = layouts::shipped()[1].clone();
        let mut app = app();
        let commands = layouts::apply(&mut app, &review, 150).unwrap();
        assert!(commands.iter().any(|command| command["type"] == "getDiff"));
        let wide = crate::ui::geometry(Rect::new(0, 0, 150, 44), &app);
        assert!(wide.views[1].is_empty());
        assert!(!wide.panes[0].is_empty());
        assert_eq!(wide.review.x, wide.panes[0].right());
        assert_eq!(wide.review.width, wide.panes[0].width);
        let narrow = crate::ui::geometry(Rect::new(0, 0, 100, 32), &app);
        assert!(narrow.panes[0].is_empty());
        assert!(narrow.review.width >= 48);
        app.review.visible = false;
        let closed = crate::ui::geometry(Rect::new(0, 0, 150, 44), &app);
        assert!(!closed.views[1].is_empty());
        let buffer = draw(&app, 150, 44);
        assert!(region(&buffer, closed.views[1]).contains("Press F4"));
    }

    #[test]
    fn layouts_quad_renders_four_panes_and_empty_role_hints() {
        let mut app = app();
        let quad = layouts::shipped().pop().unwrap();
        layouts::apply(&mut app, &quad, 150).unwrap();
        app.review.visible = false;
        let area = Rect::new(0, 0, 150, 44);
        let geometry = crate::ui::geometry(area, &app);
        assert_eq!(app.panes[0].as_deref(), Some("agent"));
        assert_eq!(app.panes[1], None);
        assert_eq!(app.panes[2].as_deref(), Some("shell"));
        for index in [0, 1, 2] {
            assert!(!geometry.panes[index].is_empty());
        }
        assert!(!geometry.views[3].is_empty());
        let buffer = draw(&app, 150, 44);
        let text = screen(&buffer);
        assert!(text.contains("Agent pane · Press n to start a session"));
        assert!(text.contains("Review pane"));
        for (width, height) in [(80, 24), (100, 32)] {
            let small = crate::ui::geometry(Rect::new(0, 0, width, height), &app);
            let filled = small
                .panes
                .iter()
                .chain(small.views.iter())
                .filter(|area| !area.is_empty())
                .count();
            assert_eq!(filled, 4, "{width}x{height}");
            draw(&app, width, height);
        }
    }
}
