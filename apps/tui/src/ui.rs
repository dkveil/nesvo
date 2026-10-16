//! Rendering is a pure projection of App. No filesystem, network, or process calls.
use crate::{
    model::{App, Dialog, Mode, RowKind},
    status::{Source, State, Status},
    terminal::TerminalWidget,
    ui_controls, ui_launch,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

const BACKGROUND: Color = Color::Rgb(13, 16, 14);
const SURFACE: Color = Color::Rgb(22, 27, 24);
const TEXT: Color = Color::Rgb(231, 238, 233);
const MUTED: Color = Color::Rgb(165, 177, 169);
const BORDER: Color = Color::Rgb(52, 61, 55);

pub struct Geometry {
    pub header: Rect,
    pub tree: Rect,
    pub panes: [Rect; 2],
    pub footer: Rect,
}

pub fn geometry(area: Rect, split: bool) -> Geometry {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(4),
    ])
    .areas(area);
    let sidebar = if area.width >= 65 {
        27.min(area.width / 3)
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
    Block::bordered().inner(area)
}

pub fn tree_content(area: Rect) -> Rect {
    Block::default()
        .title(" Projects ")
        .borders(Borders::RIGHT)
        .inner(area)
}

pub fn tree_offset(app: &App, height: u16) -> usize {
    app.selected
        .saturating_sub(usize::from(height.saturating_sub(3)))
}

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    let layout = geometry(area, app.split);
    let connected = if app.connected {
        "connected"
    } else {
        "offline"
    };
    let header = Line::from(vec![
        Span::styled(" nesvo ", Style::default().add_modifier(Modifier::BOLD)),
        Span::styled(
            format!(
                "  {connected}  ·  {} sessions  ·  {} groups",
                app.sessions.len(),
                app.groups.len()
            ),
            Style::default().fg(MUTED),
        ),
    ]);
    let location = app.active_session().map_or_else(
        || {
            app.capabilities
                .as_ref()
                .map_or("", |caps| caps.workspace.as_str())
        },
        |session| session.cwd.as_str(),
    );
    frame.render_widget(
        Paragraph::new(vec![
            header,
            Line::from(Span::styled(
                format!(" {location}"),
                Style::default().fg(MUTED),
            )),
        ]),
        layout.header,
    );
    render_tree(frame, app, layout.tree);
    for index in 0..if app.split { 2 } else { 1 } {
        render_pane(frame, app, index, layout.panes[index]);
    }
    let mode = if app.mode == Mode::Input {
        "INPUT  Ctrl+G: navigation"
    } else {
        "NAV  Enter: open  i: input  n: new  g/G: group  v: split  ?: help  q: detach"
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(mode, Style::default().fg(TEXT))),
            Line::from(Span::styled(
                app.notice.as_str(),
                Style::default().fg(MUTED),
            )),
        ])
        .block(
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(BORDER)),
        ),
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
                    if app.session(id).is_some_and(|s| s.running) {
                        "● "
                    } else {
                        "○ "
                    }
                }
            };
            let active = matches!(&row.kind, RowKind::Session(id) if app.active_id() == Some(id));
            let style = if index == app.selected {
                Style::default().bg(SURFACE).fg(TEXT)
            } else {
                Style::default().fg(if active { TEXT } else { MUTED })
            };
            let label = format!(
                "{}{}{}",
                "  ".repeat(row.depth.saturating_sub(1).min(12)),
                icon,
                row.label
            );
            let status = match &row.kind {
                RowKind::Session(id) => app.session(id).and_then(|session| session.status.as_ref()),
                RowKind::Group(id) => app.group_attention(id),
                RowKind::Root => None,
            };
            let badge = status.map(Status::label).or_else(|| match &row.kind {
                RowKind::Session(id) => app
                    .session(id)
                    .map(|session| if session.running { "running" } else { "ended" }),
                _ => None,
            });
            let line = if let Some(badge) = badge {
                let badge_width = Line::from(badge).width() + 1;
                let available = usize::from(tree_content(area).width).saturating_sub(badge_width);
                let label = truncate_cells(&label, available);
                let gap = available.saturating_sub(Line::from(label.as_str()).width()) + 1;
                Line::from(vec![
                    Span::raw(label),
                    Span::raw(" ".repeat(gap)),
                    Span::styled(badge, Style::default().fg(status_color(status))),
                ])
            } else {
                Line::from(label)
            };
            ListItem::new(line).style(style)
        })
        .collect();
    let mut state = ListState::default()
        .with_selected(Some(app.selected))
        .with_offset(tree_offset(app, area.height));
    frame.render_stateful_widget(
        List::new(items).block(
            Block::default()
                .title(" Projects ")
                .borders(Borders::RIGHT)
                .border_style(Style::default().fg(BORDER)),
        ),
        area,
        &mut state,
    );
}

fn render_pane(frame: &mut Frame, app: &App, index: usize, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let focused = app.focused == index;
    let session = app.panes[index].as_deref().and_then(|id| app.session(id));
    let title = match session {
        Some(session) => Line::from(vec![
            Span::raw(format!(" {}  ", index + 1)),
            Span::styled(
                session.status.as_ref().map_or(
                    if session.running { "running" } else { "ended" },
                    Status::label,
                ),
                Style::default().fg(status_color(session.status.as_ref())),
            ),
            Span::raw(format!(
                " · {} · {} ",
                session.name,
                session.program.label()
            )),
        ]),
        None => Line::from(format!(" {}  Select a session ", index + 1)),
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
            format!(" {control} · {}×{} ", session.cols, session.rows)
        })
        .unwrap_or_default();
    let block = Block::bordered()
        .title(title)
        .title_bottom(footer)
        .border_style(Style::default().fg(if focused { MUTED } else { BORDER }));
    let content = block.inner(area);
    frame.render_widget(block, area);
    let Some(session) = session else {
        render_home(frame, content);
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

fn render_home(frame: &mut Frame, content: Rect) {
    frame.render_widget(
        Paragraph::new("Your workspace").style(Style::default().fg(TEXT)),
        Rect::new(content.x, content.y, content.width, content.height.min(1)),
    );
    for (offset, description) in ui_controls::HOME_ACTION_ROWS.into_iter().zip([
        "Choose a folder and a terminal or agent.",
        "Organize sessions into groups.",
        "Continue these sessions from your phone.",
    ]) {
        let row = offset + 1;
        if row >= content.height {
            continue;
        }
        frame.render_widget(
            Paragraph::new(description)
                .style(Style::default().fg(MUTED))
                .wrap(Wrap { trim: false }),
            Rect::new(
                content.x,
                content.y + row,
                content.width,
                2.min(content.height - row),
            ),
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

fn status_color(status: Option<&Status>) -> Color {
    match status.map(|status| (status.source, status.state)) {
        Some((Source::Screen, State::Question | State::Blocked)) => Color::Rgb(213, 177, 122),
        Some((Source::Process | Source::Screen, State::Failed)) => Color::Rgb(216, 153, 146),
        Some((Source::Process | Source::Screen, State::Done)) => Color::Rgb(160, 201, 174),
        Some((_, State::Working)) => Color::Rgb(160, 201, 174),
        _ => MUTED,
    }
}

pub fn dialog_area(size: Rect, dialog: &Dialog) -> Option<Rect> {
    if size.is_empty() {
        return None;
    }
    let width = 76.min(size.width.saturating_sub(4)).max(1);
    let height = match dialog {
        Dialog::Help => 24,
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
            .highlight_style(Style::default().bg(Color::Rgb(55, 55, 55)))
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
                    "~ status: inferred from the CLI screen.\n",
                    "Activity/quiet: I/O, not task completion.\n\n",
                    "↑/↓ or j/k   Select group or session\n",
                    "Enter        Open session / expand group\n",
                    "i / t        Type / take over (confirmation)\n",
                    "x            Release control\n",
                    "n            New session in selected group\n",
                    "g / G        New root group / subgroup\n",
                    "p            Phone pairing instructions\n",
                    "r / m        Rename / move selected item\n",
                    "d            Stop session / delete empty group\n",
                    "v / Tab      Toggle split / focus next pane\n",
                    "PgUp/PgDn    Local scrollback\n",
                    "q            Detach; host processes keep running\n\n",
                    "Input: Ctrl+G navigates; Esc/Ctrl+C go to shell.\n",
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

    #[test]
    fn empty_layout_and_dialog_render_at_small_terminal_sizes() {
        let mut app = App::new(1);
        for dialog in [
            Dialog::Help,
            Dialog::PairPhone,
            Dialog::NewSession(Default::default()),
        ] {
            app.dialog = Some(dialog);
            for (width, height) in [(120, 40), (60, 20), (20, 4), (1, 1), (0, 0)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|frame| render(frame, &app)).unwrap();
            }
        }
    }
}
