use crate::{
    model::App,
    notes::{self, Editor},
    notes_controller::{NotesState, View},
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SURFACE, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
};

const SPLIT_COLUMNS: u16 = 44;
const WIDE_FOOTER: u16 = 120;
const BROWSE_WIDE: [(&str, &str); 10] = [
    ("j k", "move"),
    ("Enter", "edit"),
    ("n", "new"),
    ("d", "delete"),
    ("/", "search"),
    ("y", "copy"),
    ("p", "paste path"),
    ("PgUp PgDn", "scroll"),
    ("r", "refresh"),
    ("Esc q", "close"),
];
const BROWSE_NARROW: [(&str, &str); 4] = [
    ("Enter", "edit"),
    ("n", "new"),
    ("/", "search"),
    ("Esc", "close"),
];
const EDIT_HINTS: [(&str, &str); 2] = [("Esc", "save and leave"), ("Ctrl+S", "save")];
const SEARCH_HINTS: [(&str, &str); 3] =
    [("↑↓", "move"), ("Enter", "keep filter"), ("Esc", "clear")];
const CONFIRM_HINTS: [(&str, &str); 2] = [("y Enter", "delete"), ("n Esc", "keep")];

pub fn leaf_area(area: Rect, app: &App) -> Option<Rect> {
    let index = crate::notes_controller::leaf_index(app)?;
    let view = crate::ui::geometry(area, app).views[index];
    (!view.is_empty()).then_some(view)
}

fn full_area(frame_area: Rect, app: &App) -> (Rect, Rect) {
    let layout = crate::ui::geometry(frame_area, app);
    let area = Rect::new(
        layout.tree.right(),
        frame_area.y,
        frame_area.right().saturating_sub(layout.tree.right()),
        layout.footer.y.saturating_sub(frame_area.y),
    );
    (area, layout.footer)
}

fn content_area(frame_area: Rect, app: &App) -> Rect {
    if let Some(area) = leaf_area(frame_area, app) {
        return crate::ui::pane_content(area, false);
    }
    let (area, _) = full_area(frame_area, app);
    inset(area)
}

fn inset(area: Rect) -> Rect {
    let side = 2.min(area.width / 2);
    Rect::new(
        area.x + side,
        area.y + area.height.min(1),
        area.width - 2 * side,
        area.height.saturating_sub(1),
    )
}

struct Panels {
    list: Rect,
    note: Rect,
}

fn panels(area: Rect, view: View) -> Panels {
    let body = Rect::new(
        area.x,
        area.y + 2.min(area.height),
        area.width,
        area.height.saturating_sub(2),
    );
    let threshold = if view == View::Edit {
        SPLIT_COLUMNS * 2
    } else {
        SPLIT_COLUMNS
    };
    if body.width < threshold {
        return if matches!(view, View::Edit | View::ConfirmDelete) {
            Panels {
                list: Rect::default(),
                note: body,
            }
        } else {
            Panels {
                list: body,
                note: Rect::default(),
            }
        };
    }
    let list = (body.width * 35 / 100).clamp(22, 40);
    Panels {
        list: Rect::new(body.x, body.y, list, body.height),
        note: Rect::new(
            body.x + list + 1,
            body.y,
            body.width.saturating_sub(list + 1),
            body.height,
        ),
    }
}

pub fn editor_height(app: &App, frame_area: Rect) -> usize {
    let note = panels(content_area(frame_area, app), View::Edit).note;
    usize::from(note.height.saturating_sub(1))
}

pub fn render(frame: &mut Frame, app: &App) {
    let (area, footer_area) = full_area(frame.area(), app);
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    body(frame, app, inset(area), true);
    footer(frame, app, footer_area);
}

pub fn render_leaf(frame: &mut Frame, app: &App, area: Rect) -> bool {
    if !app.notes.open {
        return false;
    }
    let focused = app.notes.focused;
    frame.render_widget(
        Block::default()
            .borders(Borders::RIGHT | Borders::BOTTOM)
            .border_style(Style::default().fg(if focused { app.theme.accent() } else { BORDER })),
        area,
    );
    let content = crate::ui::pane_content(area, false);
    let status = Rect::new(
        content.x,
        area.bottom().saturating_sub(1),
        content.width,
        area.height.min(1),
    );
    let hint = if focused {
        hint_line(app.notes.view, false)
    } else {
        "Notes pane · T to focus · Ctrl+T quick note".into()
    };
    text(frame, status, &hint, MUTED);
    body(frame, app, content, focused);
    true
}

fn hint_line(view: View, wide: bool) -> String {
    let hints = hints(view, wide);
    let parts: Vec<String> = hints
        .iter()
        .map(|(key, label)| format!("{key} {label}"))
        .collect();
    format!("Notes pane · {}", parts.join(" · "))
}

fn hints(view: View, wide: bool) -> &'static [(&'static str, &'static str)] {
    match view {
        View::Edit => &EDIT_HINTS,
        View::Search => &SEARCH_HINTS,
        View::ConfirmDelete => &CONFIRM_HINTS,
        View::Browse if wide => &BROWSE_WIDE,
        View::Browse => &BROWSE_NARROW,
    }
}

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(crate::ui::truncate_cells(value, usize::from(area.width)))
                .style(Style::default().fg(color)),
            area,
        );
    }
}

fn spans(frame: &mut Frame, area: Rect, spans: Vec<Span<'static>>) {
    if !area.is_empty() {
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }
}

fn body(frame: &mut Frame, app: &App, area: Rect, focused: bool) {
    if area.is_empty() {
        return;
    }
    let notes = &app.notes;
    let title = match &notes.listing {
        Some(listing) => format!("Notes · {} · {} folder", listing.place(), listing.location),
        None => "Notes".into(),
    };
    spans(
        frame,
        row(area, 0),
        vec![Span::styled(
            crate::ui::truncate_cells(&title, usize::from(area.width)),
            Style::default()
                .fg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        )],
    );
    let folder = notes
        .listing
        .as_ref()
        .map(|listing| listing.directory.clone())
        .or_else(|| notes.error.clone())
        .unwrap_or_else(|| "Reading the notes folder…".into());
    text(frame, row(area, 1), &folder, MUTED);
    let panels = panels(area, notes.view);
    list(frame, app, panels.list, focused);
    if !panels.note.is_empty() {
        if !panels.list.is_empty() {
            frame.render_widget(
                Block::default()
                    .borders(Borders::LEFT)
                    .border_style(Style::default().fg(BORDER)),
                Rect::new(panels.note.x - 1, panels.note.y, 1, panels.note.height),
            );
        }
        note(frame, app, panels.note, focused);
    }
}

fn list(frame: &mut Frame, app: &App, area: Rect, focused: bool) {
    if area.is_empty() {
        return;
    }
    let notes = &app.notes;
    let mut top = 0;
    if notes.view == View::Search || !notes.query.is_empty() {
        let cursor = if notes.view == View::Search && focused {
            "▏"
        } else {
            ""
        };
        text(
            frame,
            row(area, 0),
            &format!("/ {}{cursor}", notes.query),
            app.theme.accent(),
        );
        top = 1;
    }
    let visible = notes.visible();
    let height = usize::from(area.height.saturating_sub(top));
    if visible.is_empty() {
        let message = match (&notes.listing, notes.query.is_empty()) {
            (None, _) if notes.loading() => vec!["Loading notes…".to_owned()],
            (None, _) => vec![
                notes
                    .error
                    .clone()
                    .unwrap_or_else(|| "Notes are not loaded.".into()),
            ],
            (Some(_), false) => vec!["No notes match.".into()],
            (Some(_), true) => vec![
                "No notes yet.".into(),
                "n writes one · Ctrl+T captures a line".into(),
            ],
        };
        for (index, line) in message.iter().enumerate() {
            text(frame, row(area, top + index as u16), line, MUTED);
        }
        return;
    }
    let selected = notes.index_in(&visible);
    let first = notes::visible_start(0, selected.unwrap_or(0), height);
    for (offset, summary) in visible.iter().skip(first).take(height).enumerate() {
        let chosen = Some(first + offset) == selected;
        let marker = if chosen { "▸ " } else { "  " };
        let style = if chosen {
            Style::default()
                .fg(TEXT)
                .bg(if focused {
                    app.theme.selection()
                } else {
                    SURFACE
                })
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(TEXT)
        };
        let heading = summary.heading();
        let mut parts = vec![Span::styled(format!("{marker}{}", summary.title()), style)];
        if !heading.is_empty() && !heading.eq_ignore_ascii_case(summary.title()) {
            parts.push(Span::styled(
                format!("  {heading}"),
                Style::default().fg(MUTED),
            ));
        }
        let line = Line::from(parts);
        let width = usize::from(area.width);
        let line = if line.width() > width {
            Line::from(Span::styled(
                crate::ui::truncate_cells(
                    &line
                        .spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>(),
                    width,
                ),
                style,
            ))
        } else {
            line
        };
        frame.render_widget(Paragraph::new(line), row(area, top + offset as u16));
    }
    if let Some(listing) = &notes.listing
        && listing.truncated
        && area.height > top + 1
    {
        text(
            frame,
            row(area, area.height - 1),
            "Showing the newest 500 notes",
            WARNING,
        );
    }
}

fn note(frame: &mut Frame, app: &App, area: Rect, focused: bool) {
    let notes = &app.notes;
    let selected = notes.selected_summary();
    let selected_name = selected.map(|summary| summary.name.clone());
    match notes.view {
        View::Edit => {
            let Some(draft) = &notes.draft else {
                return;
            };
            let name = draft
                .name
                .clone()
                .unwrap_or_else(|| "new note (named from its first line)".into());
            let mut header = format!("Editing {name}");
            if draft.dirty {
                header.push_str(" · modified");
            }
            if draft.saving {
                header.push_str(" · saving…");
            }
            let color = if draft.conflict.is_some() {
                header.push_str(" · changed elsewhere");
                WARNING
            } else {
                app.theme.accent()
            };
            text(frame, row(area, 0), &header, color);
            editor(frame, app, &draft.editor, inner(area), focused);
        }
        View::ConfirmDelete => {
            let name = selected_name.unwrap_or_default();
            spans(
                frame,
                row(area, 0),
                vec![Span::styled(
                    crate::ui::truncate_cells(
                        &format!("Delete {name}? y/n"),
                        usize::from(area.width),
                    ),
                    Style::default().fg(DANGER).add_modifier(Modifier::BOLD),
                )],
            );
            preview(frame, notes, inner(area));
        }
        View::Browse | View::Search => {
            let Some(summary) = selected else {
                return;
            };
            let header = match notes.draft.as_ref() {
                Some(draft)
                    if draft.path.as_deref() == Some(summary.path.as_str()) && draft.dirty =>
                {
                    format!("{} · unsaved edits · Enter resumes", summary.name)
                }
                _ => format!("{} · {} B", summary.name, summary.size),
            };
            text(frame, row(area, 0), &header, TEXT);
            preview(frame, notes, inner(area));
        }
    }
}

fn inner(area: Rect) -> Rect {
    Rect::new(
        area.x,
        area.y + 1.min(area.height),
        area.width,
        area.height.saturating_sub(1),
    )
}

fn preview(frame: &mut Frame, notes: &NotesState, area: Rect) {
    let Some(path) = notes.selected.as_deref() else {
        return;
    };
    if let Some(error) = notes.failed.get(path) {
        return text(frame, row(area, 0), error, WARNING);
    }
    let Some(loaded) = notes.contents.get(path) else {
        return text(frame, row(area, 0), "Loading…", MUTED);
    };
    let lines: Vec<&str> = loaded.text.lines().collect();
    let first = notes.preview_scroll.min(lines.len().saturating_sub(1));
    for (offset, line) in lines
        .iter()
        .skip(first)
        .take(usize::from(area.height))
        .enumerate()
    {
        text(frame, row(area, offset as u16), line, TEXT);
    }
}

fn editor(frame: &mut Frame, app: &App, editor: &Editor, area: Rect, focused: bool) {
    if area.is_empty() {
        return;
    }
    let (cursor_row, cursor_column) = editor.cursor();
    let height = usize::from(area.height);
    let first = notes::visible_start(editor.scroll, cursor_row, height);
    let width = usize::from(area.width);
    for (offset, line) in editor.lines().iter().skip(first).take(height).enumerate() {
        let index = first + offset;
        let chars: Vec<char> = line.chars().collect();
        let start = if index == cursor_row {
            cursor_column.saturating_sub(width.saturating_sub(1))
        } else {
            0
        };
        let shown: String = chars.iter().skip(start).collect();
        let area_row = row(area, offset as u16);
        text(frame, area_row, &shown, TEXT);
        if index == cursor_row && focused {
            let before: String = chars[start..cursor_column.min(chars.len())]
                .iter()
                .collect();
            let x = area_row.x + u16::try_from(Span::raw(before).width()).unwrap_or(0);
            if x < area_row.right() {
                let cell = &mut frame.buffer_mut()[(x, area_row.y)];
                if cell.symbol().trim().is_empty() {
                    cell.set_symbol(" ");
                }
                cell.set_style(Style::default().fg(BACKGROUND).bg(app.theme.accent()));
            }
        }
    }
}

fn footer(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }
    let mut parts = vec![
        Span::styled(
            " NOTES ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
    ];
    for (key, label) in hints(app.notes.view, area.width >= WIDE_FOOTER) {
        parts.push(Span::styled(
            format!(" {key} "),
            Style::default()
                .fg(TEXT)
                .bg(BORDER)
                .add_modifier(Modifier::BOLD),
        ));
        parts.push(Span::styled(
            format!(" {label} "),
            Style::default().fg(MUTED),
        ));
    }
    let used = Line::from(parts.clone()).width();
    if !app.notice.is_empty() {
        parts.push(Span::styled(
            crate::ui::truncate_cells(&app.notice, usize::from(area.width).saturating_sub(used)),
            Style::default().fg(WARNING),
        ));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    spans(frame, area, parts);
}

pub fn capture_fits(screen: Rect) -> bool {
    screen.width.saturating_sub(4).min(64) >= 10 && screen.height >= 6
}

pub fn render_capture(frame: &mut Frame, app: &App) {
    let Some(input) = &app.notes.capture else {
        return;
    };
    let screen = frame.area();
    if !capture_fits(screen) {
        return;
    }
    let width = screen.width.saturating_sub(4).min(64);
    let footer = crate::ui::geometry(screen, app).footer;
    let bottom = footer.y.max(screen.y + 4);
    let area = Rect::new(
        screen.x + (screen.width - width) / 2,
        bottom.saturating_sub(4),
        width,
        4,
    );
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(app.theme.accent()))
        .title(format!(" Quick note → {} ", notes::today_name(&input.date)))
        .style(Style::default().bg(SURFACE).fg(TEXT));
    let content = block.inner(area);
    frame.render_widget(block, area);
    let room = usize::from(content.width).saturating_sub(3);
    let chars: Vec<char> = input.text.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(room)..].iter().collect();
    text(frame, row(content, 0), &format!("> {tail}▏"), TEXT);
    text(
        frame,
        row(content, 1),
        "Enter adds a timestamped line · Esc cancels",
        MUTED,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layouts::{Direction, PaneTree, Role};
    use crate::notes_controller::{
        CaptureInput,
        tests::{loaded, press},
    };
    use crossterm::event::KeyCode;
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};

    const SIZES: [(u16, u16); 3] = [(80, 24), (100, 32), (150, 44)];

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

    #[test]
    fn notes_view_renders_list_preview_and_footer_at_three_sizes() {
        let app = loaded();
        for (width, height) in SIZES {
            let screen = screen(&draw(&app, width, height));
            for expected in [
                "Notes · w · repository folder",
                "/w/.nesvo/notes",
                "▸ plan",
                "ideas  deploy later",
                "plan.md · 14 B",
                "ship it",
                " NOTES ",
                "Enter",
            ] {
                assert!(
                    screen.contains(expected),
                    "{expected} at {width}x{height}\n{screen}"
                );
            }
            assert_eq!(
                screen.contains("paste path"),
                width >= 150,
                "{width}x{height}\n{screen}"
            );
        }
    }

    #[test]
    fn notes_editor_and_delete_confirmation_render_at_three_sizes() {
        let mut app = loaded();
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('x'));
        for (width, height) in SIZES {
            let buffer = draw(&app, width, height);
            let screen = screen(&buffer);
            assert!(
                screen.contains("Editing plan.md · modified"),
                "{width}x{height}\n{screen}"
            );
            assert!(screen.contains("x# Plan"), "{width}x{height}\n{screen}");
            assert!(
                screen.contains("save and leave"),
                "{width}x{height}\n{screen}"
            );
            let accent = (0..buffer.area.height)
                .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
                .filter(|(x, y)| buffer[(*x, *y)].bg == app.theme.accent())
                .count();
            assert!(accent >= 1, "{width}x{height}");
        }
        press(&mut app, KeyCode::Esc);
        app.notes.view = crate::notes_controller::View::ConfirmDelete;
        for (width, height) in SIZES {
            let screen = screen(&draw(&app, width, height));
            assert!(
                screen.contains("Delete plan.md? y/n"),
                "{width}x{height}\n{screen}"
            );
        }
    }

    #[test]
    fn notes_leaf_renders_beside_the_agent_and_capture_overlays_any_view() {
        let mut app = loaded();
        crate::notes_controller::close(&mut app);
        let layout = crate::layouts::shipped()
            .into_iter()
            .find(|layout| layout.name == "Agent + Notes")
            .unwrap();
        let commands = crate::layouts::apply(&mut app, &layout, 150).unwrap();
        assert!(
            commands
                .iter()
                .any(|command| command["type"] == "listNotes")
        );
        assert!(app.notes.open && !app.notes.focused);
        assert_eq!(app.pane_tree().slots()[1].role, Role::Notes);
        let leaf = screen_of(&app);
        assert!(leaf.contains("T to focus"), "{leaf}");
        assert!(!leaf.contains(" NOTES "), "{leaf}");
        assert!(leaf.contains("▸ plan"), "{leaf}");
        app.set_pane_layout(PaneTree::split(
            Direction::Horizontal,
            PaneTree::leaf(Role::Agent),
            PaneTree::leaf(Role::Notes),
        ));
        app.notes.open = false;
        assert!(screen_of(&app).contains("Press T to open Notes"));
        app.notes.capture = Some(CaptureInput {
            text: "remember the flag".into(),
            date: "2026-10-21".into(),
        });
        for (width, height) in SIZES {
            let screen = screen(&draw(&app, width, height));
            assert!(
                screen.contains("Quick note → 2026-10-21.md"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("> remember the flag"),
                "{width}x{height}\n{screen}"
            );
        }
    }

    fn screen_of(app: &App) -> String {
        screen(&draw(app, 150, 44))
    }
}
