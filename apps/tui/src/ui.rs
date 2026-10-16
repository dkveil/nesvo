//! Rendering is a pure projection of App. No filesystem, network, or process calls.
use crate::{
    brand,
    model::{App, Dialog, Mode, RowKind},
    status::{Source, State, Status},
    terminal::TerminalWidget,
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, Theme, WARNING},
    ui_controls, ui_launch,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

pub struct Geometry {
    pub header: Rect,
    pub tree: Rect,
    pub panes: [Rect; 2],
    pub footer: Rect,
}

pub fn geometry(area: Rect, split: bool) -> Geometry {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(0),
        Constraint::Length(2),
    ])
    .areas(area);
    let sidebar = if area.width >= 65 {
        24.min(area.width / 3)
    } else {
        0
    };
    let [tree, content] =
        Layout::horizontal([Constraint::Length(sidebar), Constraint::Min(0)]).areas(body);
    let panes = if split && content.width >= 40 {
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(content)
    } else if split {
        Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(content)
    } else {
        [content, Rect::default()]
    };
    Geometry {
        header,
        tree,
        panes,
        footer,
    }
}

pub fn pane_content(area: Rect) -> Rect {
    // Reserve a quiet title and ownership row, with one cell of horizontal
    // breathing room. Controller resize and mouse geometry use this same area.
    Block::bordered().inner(area)
}

pub fn tree_content(area: Rect) -> Rect {
    Block::default()
        .title(" Sessions ")
        .borders(Borders::RIGHT)
        .inner(area)
}

pub fn tree_offset(app: &App, height: u16) -> usize {
    app.selected
        .saturating_sub(usize::from(height.saturating_sub(3)))
}

pub fn render(frame: &mut Frame, app: &App, logo_frame: usize) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    if matches!(app.dialog, Some(Dialog::Menu)) {
        render_menu(frame, app, logo_frame);
        ui_controls::render(frame, app);
        return;
    }
    let layout = geometry(area, app.split);
    let connected = if app.connected {
        "connected"
    } else {
        "offline"
    };
    let header = Line::from(vec![
        Span::styled(
            " nesvo ",
            Style::default()
                .fg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" · {connected}"), Style::default().fg(MUTED)),
    ]);
    frame.render_widget(Paragraph::new(header), layout.header);
    render_tree(frame, app, layout.tree);
    for index in 0..if app.split { 2 } else { 1 } {
        render_pane(frame, app, index, layout.panes[index], logo_frame);
    }
    let mode = if app.mode == Mode::Input {
        "input · Ctrl+G navigate"
    } else {
        "navigate · Enter open · Esc detach"
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(""),
            Line::from(vec![
                Span::styled(format!(" {mode}"), Style::default().fg(MUTED)),
                Span::styled(
                    if app.notice.is_empty() {
                        String::new()
                    } else {
                        format!("   · {}", app.notice)
                    },
                    Style::default().fg(MUTED),
                ),
            ]),
        ]),
        layout.footer,
    );
    if let Some(dialog) = &app.dialog {
        render_dialog(frame, app, dialog);
    }
    ui_controls::render(frame, app);
}

fn render_tree(frame: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 {
        return;
    }
    let rows = app.tree();
    let items: Vec<_> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let status = match &row.kind {
                RowKind::Session(id) => app.session(id).and_then(|session| session.status.as_ref()),
                RowKind::Group(id) => app.group_attention(id),
                RowKind::Root => None,
            };
            let icon = match &row.kind {
                RowKind::Root => "",
                RowKind::Group(id) => {
                    if app.collapsed.contains(id) {
                        "▸ "
                    } else {
                        "▾ "
                    }
                }
                RowKind::Session(id) => {
                    if let Some(status) = status {
                        status_marker(status)
                    } else if app.session(id).is_some_and(|s| s.running) {
                        "● "
                    } else {
                        "○ "
                    }
                }
            };
            let attention = if matches!(row.kind, RowKind::Group(_)) {
                status.map_or(String::new(), |status| {
                    format!(" {}", status_marker(status).trim())
                })
            } else {
                String::new()
            };
            let active = matches!(&row.kind, RowKind::Session(id) if app.active_id() == Some(id));
            let selected = index == app.selected;
            let style = if selected {
                Style::default().bg(app.theme.selection()).fg(TEXT)
            } else {
                Style::default().fg(if active { TEXT } else { MUTED })
            };
            let indent = "  ".repeat(row.depth.saturating_sub(1).min(12));
            let available = usize::from(tree_content(area).width).saturating_sub(
                2 + indent.len()
                    + Line::from(icon).width()
                    + Line::from(attention.as_str()).width(),
            );
            let label = truncate_cells(&row.label, available);
            let line = Line::from(vec![
                Span::styled(
                    if selected { "› " } else { "  " },
                    Style::default().fg(app.theme.accent()),
                ),
                Span::raw(indent),
                Span::styled(icon, Style::default().fg(status_color(status, app.theme))),
                Span::raw(label),
                Span::styled(
                    attention,
                    Style::default().fg(status_color(status, app.theme)),
                ),
            ]);
            ListItem::new(line).style(style)
        })
        .collect();
    let mut state = ListState::default()
        .with_selected(Some(app.selected))
        .with_offset(tree_offset(app, area.height));
    frame.render_stateful_widget(
        List::new(items).block(
            Block::default()
                .title(" Sessions ")
                .title_style(Style::default().fg(MUTED))
                .borders(Borders::RIGHT)
                .border_style(Style::default().fg(BORDER)),
        ),
        area,
        &mut state,
    );
}

fn render_pane(frame: &mut Frame, app: &App, index: usize, area: Rect, logo_frame: usize) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let focused = app.focused == index;
    let session = app.panes[index].as_deref().and_then(|id| app.session(id));
    let title = match session {
        Some(session) => {
            let status = session.status.as_ref().map_or(
                if session.running { "running" } else { "ended" },
                Status::label,
            );
            let width = usize::from(pane_content(area).width);
            let status_width = Line::from(status).width();
            let program = if width > status_width + session.program.label().len() + 14 {
                format!("  {}", session.program.label())
            } else {
                String::new()
            };
            let name = truncate_cells(
                &session.name,
                width.saturating_sub(5 + status_width + program.len()),
            );
            Line::from(vec![
                Span::styled(
                    if focused { "▎ " } else { "  " },
                    Style::default().fg(app.theme.accent()),
                ),
                Span::styled(name, Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
                Span::styled(format!("{program} · "), Style::default().fg(MUTED)),
                Span::styled(
                    status,
                    Style::default().fg(status_color(session.status.as_ref(), app.theme)),
                ),
            ])
        }
        None => Line::default(),
    };
    let footer = session
        .map(|session| {
            let control = if !session.running {
                "process exited"
            } else if app.owns(&session.id) {
                "you control"
            } else if session.controller_id.is_some() {
                "view · another client controls"
            } else {
                "view · i to control"
            };
            format!(
                "{control} · {}×{} · {}",
                session.cols, session.rows, session.cwd
            )
        })
        .unwrap_or_default();
    let content = pane_content(area);
    if index > 0 {
        let first = geometry(frame.area(), app.split).panes[0];
        frame.render_widget(
            Block::default()
                .borders(if first.y == area.y {
                    Borders::LEFT
                } else {
                    Borders::TOP
                })
                .border_style(Style::default().fg(BORDER)),
            area,
        );
    }
    frame.render_widget(
        Paragraph::new(title),
        Rect::new(content.x, area.y, content.width, area.height.min(1)),
    );
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(MUTED)),
        Rect::new(
            content.x,
            area.bottom().saturating_sub(1),
            content.width,
            area.height.min(1),
        ),
    );
    let Some(session) = session else {
        render_home(frame, content, logo_frame, app.theme);
        return;
    };
    if let Some(terminal) = app.terminals.get(&session.id) {
        frame.render_widget(TerminalWidget(terminal.screen()), content);
        if focused
            && app.mode == Mode::Input
            && app.dialog.is_none()
            && !terminal.screen().hide_cursor()
            && terminal.screen().scrollback() == 0
        {
            let (row, col) = terminal.screen().cursor_position();
            if row < content.height && col < content.width {
                frame.set_cursor_position((content.x + col, content.y + row));
            }
        }
    } else {
        frame.render_widget(
            Paragraph::new("Loading terminal…").style(Style::default().fg(MUTED)),
            content,
        );
    }
}

fn render_home(frame: &mut Frame, content: Rect, logo_frame: usize, theme: Theme) {
    if let Some(area) = brand::area(content) {
        frame.render_widget(brand::Logo(logo_frame, theme), area);
    }
    let offset = brand::home_offset(content);
    frame.render_widget(
        Paragraph::new("A place for your next session.").style(Style::default().fg(MUTED)),
        Rect::new(
            content.x,
            content.y + offset,
            content.width,
            content.height.min(1),
        ),
    );
    for (offset, description) in ui_controls::home_action_rows(content).into_iter().zip([
        "Choose a folder and a shell or agent.",
        "Keep related sessions together.",
        "Pick up the same session on mobile.",
    ]) {
        let row = offset + 1;
        if row >= content.height {
            continue;
        }
        frame.render_widget(
            Paragraph::new(description)
                .style(Style::default().fg(MUTED))
                .wrap(Wrap { trim: false }),
            Rect::new(content.x, content.y + row, content.width, 1),
        );
    }
}

fn truncate_cells(text: &str, max_width: usize) -> String {
    let mut width = 0;
    text.chars()
        .take_while(|character| {
            width += Span::raw(character.to_string()).width();
            width <= max_width
        })
        .collect()
}

fn status_color(status: Option<&Status>, theme: Theme) -> Color {
    match status.map(|status| (status.source, status.state)) {
        Some((Source::Screen, State::Question | State::Blocked)) => WARNING,
        Some((Source::Process | Source::Screen, State::Failed)) => DANGER,
        Some((Source::Process | Source::Screen, State::Done)) => SUCCESS,
        Some((_, State::Working)) => theme.accent(),
        _ => MUTED,
    }
}

fn status_marker(status: &Status) -> &'static str {
    match (status.source, status.state) {
        (Source::Screen, State::Working) => "~● ",
        (Source::Screen, State::Idle) => "~○ ",
        (Source::Screen, State::Question) => "~? ",
        (Source::Screen, State::Blocked) => "~! ",
        (Source::Screen, State::Done) => "~✓ ",
        (Source::Screen, State::Failed) => "~× ",
        (Source::Activity, State::Working) => "● ",
        (Source::Activity, State::Idle) => "○ ",
        (Source::Process, State::Done) => "✓ ",
        (Source::Process, State::Failed) => "× ",
        _ => "· ",
    }
}

fn render_menu(frame: &mut Frame, app: &App, logo_frame: usize) {
    let area = frame.area();
    let menu = ui_controls::menu_area(area);
    if let Some(mut logo) = brand::area(menu) {
        logo.x += menu.width.saturating_sub(logo.width) / 2;
        frame.render_widget(brand::Logo(logo_frame, app.theme), logo);
    }
    let title_y = if brand::area(menu).is_some() { 7 } else { 0 };
    if title_y < menu.height {
        frame.render_widget(
            Paragraph::new("Your terminals. One workspace.")
                .centered()
                .style(Style::default().fg(MUTED)),
            Rect::new(menu.x, menu.y + title_y, menu.width, 1),
        );
    }
    for index in 0..3 {
        let target = ui_controls::menu_action_area(area, index);
        if target.width > 0 && target.height > 0 && target.x > menu.x {
            frame.render_widget(
                Paragraph::new(if index == app.menu_selected {
                    "›"
                } else {
                    " "
                })
                .style(Style::default().fg(app.theme.accent())),
                Rect::new(target.x - 1, target.y, 1, 1),
            );
        }
    }
    if area.height > 0 {
        frame.render_widget(
            Paragraph::new("↑ ↓ choose  ·  Enter open  ·  Esc detach")
                .centered()
                .style(Style::default().fg(MUTED)),
            Rect::new(area.x, area.bottom() - 1, area.width, 1),
        );
    }
}

pub fn dialog_area(size: Rect, dialog: &Dialog) -> Option<Rect> {
    if size.is_empty() {
        return None;
    }
    let width = 76.min(size.width.saturating_sub(4)).max(1);
    let height = match dialog {
        Dialog::Menu => 20,
        Dialog::Theme { .. } => 10,
        Dialog::Help => 22,
        Dialog::NewSession(_) => 19,
        Dialog::PairPhone => 18,
        Dialog::Move { choices, .. } => (choices.len() + 4).min(18) as u16,
        _ => 8,
    }
    .min(size.height.saturating_sub(2))
    .max(1);
    Some(Rect::new(
        size.x + (size.width - width) / 2,
        size.y + (size.height - height) / 2,
        width,
        height,
    ))
}

fn render_dialog(frame: &mut Frame, app: &App, dialog: &Dialog) {
    let Some(area) = dialog_area(frame.area(), dialog) else {
        return;
    };
    frame.render_widget(Clear, area);
    let title = match dialog {
        Dialog::Menu => "Menu",
        Dialog::Theme { .. } => "Theme",
        Dialog::Text { title, .. } | Dialog::Confirm { title, .. } => title.as_str(),
        Dialog::Move { .. } => "Move to group",
        Dialog::Help => "Keyboard",
        Dialog::NewSession(_) => "New session on host",
        Dialog::PairPhone => "Pair your phone",
    };
    let block = Block::bordered()
        .title(format!(" {title} "))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(MUTED));
    let inner = ui_controls::dialog_body(block.inner(area));
    frame.render_widget(block, area);
    match dialog {
        Dialog::Menu => {}
        Dialog::Theme { selected } => {
            for (index, theme) in Theme::ALL.into_iter().enumerate() {
                let description = if theme == Theme::Ultraviolet {
                    "Violet accents, dark canvas"
                } else {
                    "Neutral accents, dark canvas"
                };
                let row = 1 + index as u16 * 2;
                if row < inner.height {
                    frame.render_widget(
                        Paragraph::new(Line::from(vec![
                            Span::styled(
                                if index == *selected { "› " } else { "  " },
                                Style::default().fg(app.theme.accent()),
                            ),
                            Span::styled(format!("{}  ", theme.label()), Style::default().fg(TEXT)),
                            Span::styled(description, Style::default().fg(MUTED)),
                        ]))
                        .style(if index == *selected {
                            Style::default().bg(app.theme.selection())
                        } else {
                            Style::default()
                        }),
                        Rect::new(inner.x, inner.y + row, inner.width, 1),
                    );
                }
            }
        }
        Dialog::NewSession(form) => ui_launch::render_form(frame, app, form, inner),
        Dialog::PairPhone => ui_launch::render_pairing(frame, app, inner),
        Dialog::Text { value, .. } => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(value.as_str()),
                    Line::from(""),
                    Line::from(Span::styled(
                        "Enter: save   Esc: cancel",
                        Style::default().fg(MUTED),
                    )),
                ]),
                inner,
            );
            if inner.height > 1 && inner.width > 0 {
                let offset = Line::from(value.as_str())
                    .width()
                    .min(usize::from(inner.width - 1)) as u16;
                frame.set_cursor_position((inner.x + offset, inner.y + 1));
            }
        }
        Dialog::Move {
            choices, selected, ..
        } => {
            let list = List::new(
                choices
                    .iter()
                    .map(|(_, label)| ListItem::new(label.as_str()))
                    .collect::<Vec<_>>(),
            )
            .highlight_style(Style::default().bg(app.theme.selection()))
            .highlight_symbol("› ");
            let mut state = ListState::default()
                .with_selected(Some(*selected))
                .with_offset(ui_controls::move_offset(*selected, inner.height));
            frame.render_stateful_widget(list, inner, &mut state);
        }
        Dialog::Confirm { .. } => {
            frame.render_widget(
                Paragraph::new(
                    "This changes the live host session.\n\ny / Enter: confirm\nEsc: cancel",
                )
                .wrap(Wrap { trim: false }),
                inner,
            );
        }
        Dialog::Help => {
            frame.render_widget(
                Paragraph::new(concat!(
                    "~ status: screen inference; activity/quiet: I/O.\n\n",
                    "↑/↓ or j/k   Select · Enter opens / expands\n",
                    "i / t / x    Type / take over (confirm) / release\n",
                    "n / g / G    New session / group / subgroup\n",
                    "r / m / d    Rename / move / delete (confirmation)\n",
                    "v / Tab      Split / focus next pane\n",
                    "PgUp/PgDn    Local scrollback\n",
                    "F1 / p / ?   Menu / pair mobile / keyboard help\n",
                    "Esc          Detach; open dialogs close first\n",
                    "q            Detach from navigation\n\n",
                    "Typing: Ctrl+G switches to navigation.\n",
                    "Then e sends Escape to the controlled session.\n",
                    "Ctrl+C goes to the shell while typing.\n\n",
                    "Click controls or use shortcuts. Splits are local."
                ))
                .wrap(Wrap { trim: false }),
                inner,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    #[test]
    fn long_names_do_not_hide_session_status_or_group_attention() {
        let mut app = App::new(1);
        app.event(json!({
            "type":"sessions", "revision":1,
            "groups":[{"id":"g", "parentId":null, "name":"A very long project name that fills the sidebar", "order":0}],
            "sessions":[{"id":"s", "name":"A very long session name that fills the split pane",
                "cwd":".", "cols":80, "rows":24, "running":true,
                "groupId":"g", "controllerId":null,
                "status":{"state":"question", "source":"screen", "updatedAt":1}}]
        })).unwrap();
        app.panes[0] = Some("s".into());
        app.split = true;
        let area = Rect::new(0, 0, 80, 24);
        let layout = geometry(area, true);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let title: String = (layout.panes[0].x..layout.panes[0].right())
            .map(|x| buffer[(x, layout.panes[0].y)].symbol())
            .collect();
        assert!(
            title.contains("~question"),
            "Status must remain visible: {title}"
        );
        let group_index = app
            .tree()
            .iter()
            .position(|row| row.kind == RowKind::Group("g".into()))
            .unwrap();
        let tree = tree_content(layout.tree);
        let group: String = (tree.x..tree.right())
            .map(|x| buffer[(x, tree.y + group_index as u16)].symbol())
            .collect();
        assert!(
            group.contains("~?"),
            "Attention must remain visible: {group}"
        );
    }

    #[test]
    fn home_animation_changes_only_logo_cells_not_layout_or_controls() {
        let app = App::new(1);
        let area = Rect::new(0, 0, 120, 36);
        let logo = brand::area(pane_content(geometry(area, false).panes[0])).unwrap();
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let initial = terminal.backend().buffer().clone();
        terminal.draw(|frame| render(frame, &app, 1)).unwrap();
        let animated = terminal.backend().buffer();
        let mut changed = 0;
        for y in 0..area.height {
            for x in 0..area.width {
                if initial[(x, y)] != animated[(x, y)] {
                    assert!(
                        logo.contains((x, y).into()),
                        "Animation changed a cell outside the logo"
                    );
                    changed += 1;
                }
            }
        }
        assert!(changed > 0);
    }

    #[test]
    fn empty_layout_and_dialog_render_at_small_terminal_sizes() {
        let mut app = App::new(1);
        for dialog in [
            Dialog::Menu,
            Dialog::Theme { selected: 0 },
            Dialog::Help,
            Dialog::PairPhone,
            Dialog::NewSession(Default::default()),
        ] {
            app.dialog = Some(dialog);
            for (width, height) in [(120, 40), (60, 20), (20, 4), (1, 1), (0, 0)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|frame| render(frame, &app, 0)).unwrap();
            }
        }
    }
}
