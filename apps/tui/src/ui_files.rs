use crate::{
    files_controller::{self, Preview, SidebarMode},
    files_tree::{self, Kind, Row, RowKind, Tree},
    model::App,
    theme::{BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
    ui::{pane_content, tree_content, truncate_cells},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

pub const DOCK_COLUMNS: u16 = 88;

pub fn dock(content: Rect) -> (Rect, Rect) {
    if content.width < DOCK_COLUMNS {
        return (Rect::default(), content);
    }
    let [terminal, preview] = Layout::horizontal([
        Constraint::Min(48),
        Constraint::Length((content.width / 4).clamp(40, 60)),
    ])
    .areas(content);
    (terminal, preview)
}

pub fn footer_copy(app: &App) -> Option<(&'static str, &'static str)> {
    if !files_controller::keys_active(app) || app.reviews.has_focus() {
        return None;
    }
    Some(if files_controller::preview_docked(app) {
        (
            " FILES ",
            " PgUp PgDn scroll · Esc close preview · p A paste path · r refresh",
        )
    } else {
        (
            " FILES ",
            " Enter preview · h l fold · p A paste path · o pin · . hidden · Ctrl+P find · Esc sessions",
        )
    })
}

pub fn render_mode(frame: &mut Frame, app: &App, header: Rect) {
    let label = format!(" {} ", app.files.mode.label());
    let width = Line::from(label.as_str()).width() as u16;
    if header.width < width + 8 || header.height == 0 {
        return;
    }
    let style = if app.files.mode == SidebarMode::Files {
        Style::default()
            .fg(app.theme.accent())
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(MUTED)
    };
    frame.render_widget(
        Paragraph::new(label).style(style.bg(SURFACE)),
        Rect::new(header.right() - width - 1, header.y, width, 1),
    );
}

fn status_color(letter: &str, app: &App) -> Color {
    match letter {
        "M" => WARNING,
        "A" | "?" => SUCCESS,
        "D" => DANGER,
        "R" => app.theme.accent(),
        _ => MUTED,
    }
}

fn marker(row: &Row, ascii: bool) -> &'static str {
    match row.entry().map(|entry| entry.kind) {
        Some(Kind::Dir) if row.expanded => {
            if ascii {
                "v "
            } else {
                "⌄ "
            }
        }
        Some(Kind::Dir) => {
            if ascii {
                "> "
            } else {
                "› "
            }
        }
        Some(Kind::Symlink) => {
            if ascii {
                "@ "
            } else {
                "↪ "
            }
        }
        _ => "  ",
    }
}

fn row_line(app: &App, row: &Row, width: usize) -> Line<'static> {
    let indent = "  ".repeat(row.depth.min(8));
    let (text, style) = match row.kind {
        RowKind::Entry(entry) => {
            let base = if entry.ignored {
                Style::default().fg(MUTED).add_modifier(Modifier::DIM)
            } else if entry.kind == Kind::Dir {
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(TEXT)
            };
            (
                format!("{}{}", marker(row, app.ascii_icons), entry.name),
                base,
            )
        }
        RowKind::Loading => ("  Loading…".to_owned(), Style::default().fg(MUTED)),
        RowKind::Failed(message) => (format!("! {message}"), Style::default().fg(DANGER)),
        RowKind::Truncated => (
            "  … more entries not shown".to_owned(),
            Style::default().fg(MUTED),
        ),
    };
    let letter = row
        .entry()
        .and_then(|entry| entry.status.clone())
        .filter(|letter| !letter.is_empty());
    let reserved = if letter.is_some() { 3 } else { 1 };
    let available = width.saturating_sub(indent.len() + reserved);
    let label = truncate_cells(&sanitize(&text), available);
    let used = indent.len() + Line::from(label.as_str()).width();
    let mut spans = vec![Span::raw(format!(" {indent}")), Span::styled(label, style)];
    if let Some(letter) = letter {
        spans.push(Span::raw(" ".repeat(width.saturating_sub(used + 3))));
        spans.push(Span::styled(
            letter.clone(),
            Style::default()
                .fg(status_color(&letter, app))
                .add_modifier(Modifier::BOLD),
        ));
    }
    Line::from(spans)
}

fn sanitize(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { '·' } else { c })
        .collect()
}

fn window(selected: usize, height: usize) -> usize {
    if height == 0 {
        0
    } else {
        (selected + 1).saturating_sub(height)
    }
}

fn header_lines(app: &App, tree: Option<&Tree>, width: usize) -> Vec<Line<'static>> {
    let root = tree.map(Tree::root);
    let mut flags = Vec::new();
    if app.files.pinned.is_some() {
        flags.push("pinned");
    }
    if app.files.show_hidden {
        flags.push("hidden shown");
    }
    let title = match root {
        Some(root) => format!("Files · {}", files_tree::base_name(root)),
        None => "Files".to_owned(),
    };
    let detail = if flags.is_empty() {
        root.unwrap_or_default().to_owned()
    } else {
        flags.join(" · ")
    };
    vec![
        Line::from(Span::styled(
            format!(
                " {}",
                truncate_cells(&sanitize(&title), width.saturating_sub(1))
            ),
            Style::default()
                .fg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!(
                " {}",
                truncate_cells(&sanitize(&detail), width.saturating_sub(1))
            ),
            Style::default().fg(MUTED),
        )),
    ]
}

fn placeholder(app: &App) -> &'static str {
    if !files_controller::supported(app) {
        "Update nesvo-host to browse files."
    } else if files_controller::root(app).is_none() {
        "Select a session or pin a folder to browse its files."
    } else {
        "Loading…"
    }
}

fn render_files(frame: &mut Frame, app: &App, area: Rect, focused: bool) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let tree = app
        .files
        .tree
        .as_ref()
        .filter(|_| files_controller::supported(app));
    let width = usize::from(area.width);
    let header = header_lines(app, tree, width);
    let header_height = (header.len() as u16).min(area.height);
    frame.render_widget(
        Paragraph::new(header),
        Rect::new(area.x, area.y, area.width, header_height),
    );
    let body = Rect::new(
        area.x,
        area.y + header_height,
        area.width,
        area.height - header_height,
    );
    let Some(tree) = tree else {
        frame.render_widget(
            Paragraph::new(format!(" {}", placeholder(app)))
                .style(Style::default().fg(MUTED))
                .wrap(Wrap { trim: true }),
            body,
        );
        return;
    };
    let rows = tree.rows();
    let selected = tree.selected_index(&rows);
    let start = window(selected, usize::from(body.height));
    for (offset, row) in rows
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(body.height))
    {
        let y = body.y + (offset - start) as u16;
        let line = Rect::new(body.x, y, body.width, 1);
        let highlighted = focused && offset == selected;
        let background = if highlighted {
            app.theme.selection()
        } else {
            SURFACE
        };
        frame.render_widget(
            Paragraph::new(row_line(app, row, width)).style(Style::default().bg(background)),
            line,
        );
    }
}

pub fn render_sidebar(frame: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    frame.render_widget(
        Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(if files_controller::keys_active(app) {
                app.theme.accent()
            } else {
                BORDER
            })),
        area,
    );
    let content = tree_content(area);
    frame.render_widget(
        Block::default().style(Style::default().bg(SURFACE)),
        content,
    );
    render_files(frame, app, content, files_controller::keys_active(app));
}

pub fn render_leaf(frame: &mut Frame, app: &App, area: Rect) -> bool {
    if !files_controller::supported(app) || app.files.tree.is_none() {
        return false;
    }
    let active = files_controller::keys_active(app);
    frame.render_widget(
        Block::default()
            .borders(Borders::RIGHT | Borders::BOTTOM)
            .border_style(Style::default().fg(if active { app.theme.accent() } else { BORDER })),
        area,
    );
    let content = pane_content(area, false);
    frame.render_widget(
        Block::default().style(Style::default().bg(SURFACE)),
        content,
    );
    render_files(frame, app, content, active);
    frame.render_widget(
        Paragraph::new(if active {
            "Files pane · 1 sessions"
        } else {
            "Files pane · 2 to browse"
        })
        .style(Style::default().fg(MUTED)),
        Rect::new(
            content.x,
            area.bottom().saturating_sub(1),
            content.width,
            area.height.min(1),
        ),
    );
    true
}

fn size_label(size: u64) -> String {
    if size >= 1024 * 1024 {
        format!("{:.1} MiB", size as f64 / (1024.0 * 1024.0))
    } else if size >= 1024 {
        format!("{:.1} KiB", size as f64 / 1024.0)
    } else {
        format!("{size} B")
    }
}

fn preview_footer(preview: &Preview, shown: usize) -> String {
    let lines = preview.line_count();
    let first = (preview.scroll + 1).min(lines);
    let last = (preview.scroll + shown).min(lines);
    let more = if preview.loading() {
        " · loading"
    } else if preview.limit_reached() && preview.truncated {
        " · preview limit"
    } else if preview.truncated {
        " · more below"
    } else {
        ""
    };
    format!(
        " {} · lines {first}–{last} of {lines}{more}",
        size_label(preview.size)
    )
}

pub fn render_preview(frame: &mut Frame, app: &App, area: Rect) {
    let Some(preview) = app.files.preview.as_ref() else {
        return;
    };
    if area.width < 4 || area.height < 3 {
        return;
    }
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(format!(
            " {} ",
            truncate_cells(&sanitize(&preview.relative), usize::from(area.width - 4))
        ))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(app.theme.accent()));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [body, footer] = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(inner);
    if let Some(error) = &preview.error {
        frame.render_widget(
            Paragraph::new(sanitize(error))
                .style(Style::default().fg(DANGER))
                .wrap(Wrap { trim: true }),
            body,
        );
        return;
    }
    if preview.text.is_empty() {
        frame.render_widget(
            Paragraph::new(if preview.loading() {
                "Loading…"
            } else {
                "Empty file."
            })
            .style(Style::default().fg(MUTED)),
            body,
        );
        return;
    }
    let lines = preview.line_count();
    let gutter = lines.to_string().len().max(3);
    let text_width = usize::from(body.width).saturating_sub(gutter + 1);
    let rendered: Vec<Line> = preview
        .text
        .lines()
        .enumerate()
        .skip(preview.scroll)
        .take(usize::from(body.height))
        .map(|(index, text)| {
            Line::from(vec![
                Span::styled(
                    format!("{:>gutter$} ", index + 1),
                    Style::default().fg(MUTED),
                ),
                Span::raw(truncate_cells(
                    &sanitize(&text.replace('\t', "    ")),
                    text_width,
                )),
            ])
        })
        .collect();
    let shown = rendered.len();
    frame.render_widget(Paragraph::new(rendered), body);
    frame.render_widget(
        Paragraph::new(preview_footer(preview, shown)).style(Style::default().fg(MUTED)),
        footer,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{controller::Outcome, layouts::PaneTree};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
    use serde_json::{Value, json};

    fn app() -> App {
        let mut app = App::new(9);
        app.event(json!({"type":"capabilities","workspace":"/work","programs":[],"files":true}))
            .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s","name":"agent","cwd":"/work/nesvo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Value> {
        let mut outcome = Outcome::default();
        files_controller::key(
            app,
            KeyEvent::new(code, KeyModifiers::NONE),
            Rect::new(0, 0, 150, 44),
            &mut outcome,
        );
        outcome.commands.extend(files_controller::sync(app));
        outcome.commands
    }

    fn reply(app: &mut App, command: &Value, mut event: Value) {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap();
    }

    fn browsing() -> App {
        let mut app = app();
        let list = press(&mut app, KeyCode::Char('2'));
        reply(
            &mut app,
            &list[0],
            json!({"type":"entries","entries":[
                {"name":"src","kind":"dir","size":0,"status":"M","ignored":false},
                {"name":"target","kind":"dir","size":0,"status":"!","ignored":true},
                {"name":"new.rs","kind":"file","size":12,"status":"?","ignored":false},
                {"name":"README.md","kind":"file","size":40,"status":null,"ignored":false}
            ],"truncated":false}),
        );
        app
    }

    fn previewing() -> App {
        let mut app = browsing();
        for _ in 0..3 {
            press(&mut app, KeyCode::Char('j'));
        }
        let read = press(&mut app, KeyCode::Enter);
        reply(
            &mut app,
            &read[0],
            json!({"type":"file","offset":0,"length":30,"size":30,"truncated":false,
                "text":"# nesvo\n\tindented\u{1b}[31mred\n"}),
        );
        app
    }

    fn draw(app: &App, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    fn line(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect()
    }

    fn screen(buffer: &Buffer) -> String {
        (0..buffer.area.height)
            .map(|y| line(buffer, y))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn find(buffer: &Buffer, needle: &str) -> Option<(u16, u16)> {
        (0..buffer.area.height).find_map(|y| {
            let text = line(buffer, y);
            text.find(needle)
                .map(|byte| (text[..byte].chars().count() as u16, y))
        })
    }

    #[test]
    fn files_sidebar_renders_mode_root_rows_and_status_letters_at_100x32() {
        let app = browsing();
        let buffer = draw(&app, 100, 32);
        let tree = crate::ui::geometry(Rect::new(0, 0, 100, 32), &app).tree;
        let text = screen(&buffer);
        assert!(text.contains("Files · nesvo"), "{text}");
        assert!(line(&buffer, 0).contains(" Files "));
        let (x, y) = find(&buffer, "› src").unwrap();
        assert!(x < tree.right());
        assert_eq!(buffer[(x, y)].bg, app.theme.selection());
        let letter = tree.right() - 3;
        assert_eq!(buffer[(letter, y)].symbol(), "M");
        assert_eq!(buffer[(letter, y)].fg, WARNING);
        let (_, ignored) = find(&buffer, "› target").unwrap();
        assert_eq!(buffer[(letter, ignored)].symbol(), "!");
        assert!(buffer[(x + 2, ignored)].modifier.contains(Modifier::DIM));
        assert_eq!(buffer[(x + 2, ignored)].fg, MUTED);
        let (_, untracked) = find(&buffer, "new.rs").unwrap();
        assert_eq!(buffer[(letter, untracked)].fg, SUCCESS);
        let readme: String = line(&buffer, untracked + 1)
            .chars()
            .take(usize::from(tree.right()))
            .collect();
        assert!(!readme.contains('?'));
        assert!(text.contains(" FILES "));
        assert!(text.contains("Ctrl+P"));
    }

    #[test]
    fn files_preview_replaces_the_terminal_at_80x24_and_sanitizes_text() {
        let app = previewing();
        let area = Rect::new(0, 0, 80, 24);
        let geometry = crate::ui::geometry(area, &app);
        assert_eq!(geometry.panes[0], Rect::default());
        assert_eq!(geometry.files_preview.x, geometry.tree.right());
        let buffer = draw(&app, 80, 24);
        let text = screen(&buffer);
        assert!(text.contains("README.md"), "{text}");
        assert!(text.contains("  1 # nesvo"), "{text}");
        assert!(text.contains("  2     indented·[31mred"), "{text}");
        assert!(text.contains("lines 1–2 of 2"), "{text}");
        assert!(!text.contains('\u{1b}'));
    }

    #[test]
    fn files_preview_docks_beside_the_terminal_at_150x44_and_restores_it_on_input() {
        let mut app = previewing();
        let area = Rect::new(0, 0, 150, 44);
        let geometry = crate::ui::geometry(area, &app);
        assert!(geometry.panes[0].width >= 48);
        assert_eq!(geometry.files_preview.width, 40);
        assert_eq!(geometry.files_preview.right(), area.right());
        let buffer = draw(&app, 150, 44);
        let (x, _) = find(&buffer, "  1 # nesvo").unwrap();
        assert!(x > geometry.panes[0].right() - 1);
        app.mode = crate::model::Mode::Input;
        assert_eq!(
            crate::ui::geometry(area, &app).files_preview,
            Rect::default()
        );
        app.mode = crate::model::Mode::Navigate;
        press(&mut app, KeyCode::Char('1'));
        let geometry = crate::ui::geometry(area, &app);
        assert_eq!(geometry.files_preview, Rect::default());
        assert!(!screen(&draw(&app, 150, 44)).contains("Files · nesvo"));
    }

    #[test]
    fn files_leaf_renders_the_tree_and_keeps_sessions_in_the_sidebar_at_150x44() {
        let mut app = browsing();
        let agent_files = crate::layouts::shipped()
            .into_iter()
            .find(|layout| layout.name == "Agent + Files")
            .unwrap();
        crate::layouts::apply(&mut app, &agent_files, 150).unwrap();
        assert!(app.pane_tree() != PaneTree::single());
        files_controller::set_mode(&mut app, SidebarMode::Files);
        let buffer = draw(&app, 150, 44);
        let geometry = crate::ui::geometry(Rect::new(0, 0, 150, 44), &app);
        let (x, _) = find(&buffer, "› src").unwrap();
        assert!(x >= geometry.views[1].x, "{}", screen(&buffer));
        assert!(screen(&buffer).contains("Files pane · 1 sessions"));
        let sidebar: String = (geometry.tree.y..geometry.tree.bottom())
            .map(|y| {
                line(&buffer, y)
                    .chars()
                    .take(usize::from(geometry.tree.width))
                    .collect::<String>()
            })
            .collect();
        assert!(sidebar.contains("agent"), "{sidebar}");
    }

    #[test]
    fn files_hint_and_unsupported_host_render_without_a_tree_at_80x24() {
        let mut app = app();
        app.host_features = json!({"type":"capabilities"});
        files_controller::set_mode(&mut app, SidebarMode::Files);
        files_controller::sync(&mut app);
        let text = screen(&draw(&app, 80, 24));
        assert!(text.contains("Update nesvo-host"), "{text}");
        let mut app = self::app();
        app.sessions.clear();
        app.panes = Default::default();
        files_controller::set_mode(&mut app, SidebarMode::Files);
        files_controller::sync(&mut app);
        let text = screen(&draw(&app, 80, 24));
        assert!(text.contains("Select a session or pin"), "{text}");
    }
}
