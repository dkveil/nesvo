//! Rendering is a pure projection of App. No filesystem, network, or process calls.
use crate::{
    model::{App, Dialog, Mode, RowKind},
    terminal::TerminalWidget,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

const BACKGROUND: Color = Color::Rgb(11, 11, 11);
const SURFACE: Color = Color::Rgb(25, 25, 25);
const TEXT: Color = Color::Rgb(244, 244, 244);
const MUTED: Color = Color::Rgb(150, 150, 150);
const BORDER: Color = Color::Rgb(55, 55, 55);

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
        Constraint::Length(3),
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
    let location = app
        .active_session()
        .map_or("", |session| session.cwd.as_str());
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
        render_dialog(frame, dialog);
    }
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
            ListItem::new(format!(
                "{}{}{}",
                "  ".repeat(row.depth.saturating_sub(1).min(12)),
                icon,
                row.label
            ))
            .style(style)
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
        Some(session) => format!(" {}  {} ", index + 1, session.name),
        None => format!(" {}  Select a session ", index + 1),
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
        frame.render_widget(Paragraph::new("Open a session from the tree.\n\nn  New shell on the host\nTab  Switch pane\nv  Toggle split")
            .style(Style::default().fg(MUTED)).wrap(Wrap { trim: false }), content);
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

fn render_dialog(frame: &mut Frame, dialog: &Dialog) {
    let size = frame.area();
    if size.is_empty() {
        return;
    }
    let width = 76.min(size.width.saturating_sub(4)).max(1);
    let height = match dialog {
        Dialog::Help => 24,
        Dialog::Move { choices, .. } => (choices.len() + 4).min(18) as u16,
        _ => 8,
    }
    .min(size.height.saturating_sub(2))
    .max(1);
    let area = Rect::new(
        size.x + (size.width - width) / 2,
        size.y + (size.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, area);
    let title = match dialog {
        Dialog::Text { title, .. } | Dialog::Confirm { title, .. } => title.as_str(),
        Dialog::Move { .. } => "Move to group",
        Dialog::Help => "Keyboard",
    };
    let block = Block::bordered()
        .title(format!(" {title} "))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(MUTED));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    match dialog {
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
            let mut state = ListState::default().with_selected(Some(*selected));
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
                    "Navigation\n",
                    "  ↑/↓ or j/k   Select a group or session\n",
                    "  Enter        Open session / expand group\n",
                    "  i            Acquire free session and type\n",
                    "  t            Take over control (confirmation)\n",
                    "  x            Release control\n",
                    "  n            New session in selected group\n",
                    "  g / G        New root group / subgroup\n",
                    "  r / m        Rename / move selected item\n",
                    "  d            Close session / delete empty group\n",
                    "  v / Tab      Toggle two panes / focus next pane\n",
                    "  PgUp/PgDn    Local scrollback\n",
                    "  q            Detach; host processes keep running\n\n",
                    "Input mode\n",
                    "  Ctrl+G       Return to navigation\n",
                    "  Esc/Ctrl+C   Sent to the selected terminal\n",
                    "  Paste        Honors the program's bracketed-paste mode\n\n",
                    "Esc closes this help. Splits are local to this TUI."
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
        app.dialog = Some(Dialog::Help);
        for (width, height) in [(120, 40), (60, 20), (20, 4), (1, 1), (0, 0)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal.draw(|frame| render(frame, &app)).unwrap();
        }
    }
}
