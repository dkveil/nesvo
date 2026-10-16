//! Rendering is a pure projection of App. No filesystem, network, or process calls.
use crate::{
    brand,
    launch::Program,
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

pub fn tab_areas(app: &App, layout: &Geometry) -> ([Rect; 2], Rect) {
    let mut tabs = [Rect::default(), Rect::default()];
    let mut x = layout.tree.right();
    for (index, tab) in tabs
        .iter_mut()
        .enumerate()
        .take(if app.split { 2 } else { 1 })
    {
        let name = app.panes[index]
            .as_deref()
            .and_then(|id| app.session(id))
            .map_or_else(
                || "new session".to_owned(),
                |session| tab_label(app, session),
            );
        let width = (Line::from(name.as_str()).width() as u16 + 2)
            .min(20)
            .min(layout.header.right().saturating_sub(x));
        *tab = Rect::new(x, layout.header.y, width, layout.header.height.min(1));
        x = x.saturating_add(width);
    }
    let add = Rect::new(
        x,
        layout.header.y,
        3.min(layout.header.right().saturating_sub(x)),
        layout.header.height.min(1),
    );
    (tabs, add)
}

pub fn geometry(area: Rect, app: &App) -> Geometry {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(if app.fullscreen { 0 } else { 1 }),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(area);
    let sidebar = if app.fullscreen || area.width < 65 {
        0
    } else {
        27.min(area.width / 3)
    };
    let [tree, content] =
        Layout::horizontal([Constraint::Length(sidebar), Constraint::Min(0)]).areas(body);
    let panes = if app.fullscreen {
        let mut panes = [Rect::default(), Rect::default()];
        panes[app.focused] = content;
        panes
    } else if app.split && content.width >= 40 {
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(content)
    } else if app.split {
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

pub fn pane_content(area: Rect, fullscreen: bool) -> Rect {
    if fullscreen {
        return area;
    }
    // Reserve a quiet title and ownership row, with one cell of horizontal
    // breathing room. Controller resize and mouse geometry use this same area.
    Block::bordered().inner(area)
}

pub fn tree_content(area: Rect) -> Rect {
    Block::default().borders(Borders::RIGHT).inner(area)
}

fn sidebar_sections(area: Rect, app: &App) -> (Rect, Rect) {
    let desired =
        5u16.saturating_add(u16::try_from(app.groups.len().saturating_mul(2)).unwrap_or(u16::MAX));
    let spaces_height = desired
        .min((area.height / 2).max(1))
        .min(area.height.saturating_sub(1).max(1));
    (
        Rect::new(area.x, area.y, area.width, spaces_height.min(area.height)),
        Rect::new(
            area.x,
            area.y.saturating_add(spaces_height.min(area.height)),
            area.width,
            area.height.saturating_sub(spaces_height),
        ),
    )
}

fn sidebar_entries(app: &App, section: Rect, spaces: bool) -> Vec<(Rect, usize)> {
    let rows = app.tree();
    let indices: Vec<_> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let is_space = !matches!(row.kind, RowKind::Session(_));
            (is_space == spaces).then_some(index)
        })
        .collect();
    let capacity = usize::from(section.height.saturating_sub(1) / 2);
    if capacity == 0 {
        return Vec::new();
    }
    let selected_position = indices.iter().position(|index| *index == app.selected);
    let offset = selected_position
        .map(|position| position.saturating_sub(capacity.saturating_sub(1)))
        .unwrap_or(0);
    indices
        .into_iter()
        .skip(offset)
        .take(capacity)
        .enumerate()
        .map(|(position, index)| {
            (
                Rect::new(
                    section.x,
                    section.y + 1 + position as u16 * 2,
                    section.width,
                    2,
                ),
                index,
            )
        })
        .collect()
}

pub fn sidebar_hit(app: &App, area: Rect, column: u16, row: u16) -> Option<usize> {
    let content = tree_content(area);
    if !content.contains((column, row).into()) {
        return None;
    }
    let (spaces, agents) = sidebar_sections(content, app);
    sidebar_entries(app, spaces, true)
        .into_iter()
        .chain(sidebar_entries(app, agents, false))
        .find_map(|(area, index)| area.contains((column, row).into()).then_some(index))
}

fn footer_copy(app: &App) -> (&'static str, &'static str) {
    match app.mode {
        Mode::Input => (" SESSION ", " Ctrl+Q navigation · Esc session · F1 menu"),
        Mode::Navigate => (
            " NAVIGATION ",
            " Enter open · i type · n new · g group · ? help",
        ),
    }
}

pub fn fullscreen_handle_area(_app: &App, footer: Rect) -> Rect {
    if footer.width < 3 {
        return Rect::default();
    }
    Rect::new(footer.right() - 3, footer.y, 3, 1)
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
    if matches!(app.dialog, Some(Dialog::Settings { .. })) {
        render_menu(frame, app, logo_frame);
        if let Some(dialog) = &app.dialog {
            render_dialog(frame, app, dialog);
        }
        ui_controls::render(frame, app);
        return;
    }
    let layout = geometry(area, app);
    let connected = if app.connected {
        "connected"
    } else {
        "offline"
    };
    if !app.fullscreen {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " nesvo ",
                    Style::default()
                        .fg(app.theme.accent())
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("· {connected}"), Style::default().fg(MUTED)),
            ])),
            Rect::new(layout.header.x, layout.header.y, layout.tree.width, 1),
        );
        let tab_strip = Rect::new(
            layout.tree.right(),
            layout.header.y,
            layout.header.right().saturating_sub(layout.tree.right()),
            1,
        );
        frame.render_widget(
            Block::default().style(Style::default().bg(SURFACE)),
            tab_strip,
        );
        let (tabs, add) = tab_areas(app, &layout);
        for (index, tab) in tabs.into_iter().enumerate() {
            if tab.width == 0 {
                continue;
            }
            let name = app.panes[index]
                .as_deref()
                .and_then(|id| app.session(id))
                .map_or_else(
                    || "new session".to_owned(),
                    |session| tab_label(app, session),
                );
            let label = format!(
                " {} ",
                truncate_cells(&name, usize::from(tab.width.saturating_sub(2)))
            );
            let active = index == app.focused && app.mode == Mode::Input;
            frame.render_widget(
                Paragraph::new(label).style(if active {
                    Style::default()
                        .fg(BACKGROUND)
                        .bg(app.theme.accent())
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(MUTED).bg(SURFACE)
                }),
                tab,
            );
        }
        if add.width > 0 {
            frame.render_widget(
                Paragraph::new(" + ").style(Style::default().fg(MUTED).bg(SURFACE)),
                add,
            );
        }
        render_tree(frame, app, layout.tree);
    }
    for index in 0..if app.split { 2 } else { 1 } {
        render_pane(frame, app, index, layout.panes[index], logo_frame);
    }
    let (full_mode, full_hint) = footer_copy(app);
    let handle = fullscreen_handle_area(app, layout.footer);
    let text_width = usize::from(handle.x.saturating_sub(layout.footer.x));
    let (mode, hint) = if text_width < Line::from(full_mode).width() + 12 {
        match app.mode {
            Mode::Input => (" INPUT ", " Ctrl+Q NAV"),
            Mode::Navigate => (" NAV ", " i TYPE"),
        }
    } else {
        (full_mode, full_hint)
    };
    let base_width = Line::from(format!("{mode}{hint}")).width();
    let notice = if !app.notice.is_empty() && text_width > base_width + 4 {
        truncate_cells(&format!("  · {}", app.notice), text_width - base_width)
    } else {
        String::new()
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                mode,
                Style::default()
                    .fg(app.theme.accent())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(hint, Style::default().fg(MUTED)),
            Span::styled(notice, Style::default().fg(WARNING)),
        ])),
        Rect::new(
            layout.footer.x,
            layout.footer.y,
            text_width as u16,
            layout.footer.height,
        ),
    );
    if !handle.is_empty() {
        frame.render_widget(
            Paragraph::new(" z ").style(Style::default().fg(BACKGROUND).bg(app.theme.accent())),
            handle,
        );
    }
    if let Some(dialog) = &app.dialog {
        render_dialog(frame, app, dialog);
    }
    ui_controls::render(frame, app);
}

fn render_tree(frame: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    frame.render_widget(
        Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(BORDER)),
        area,
    );
    let content = tree_content(area);
    let (spaces, agents) = sidebar_sections(content, app);
    let rows = app.tree();
    if spaces.height > 0 {
        let location = app
            .space_filter
            .as_deref()
            .and_then(|id| app.groups.iter().find(|group| group.id == id))
            .map_or("all", |group| group.name.as_str());
        frame.render_widget(
            Paragraph::new(format!(
                " spaces / {}",
                truncate_cells(location, usize::from(spaces.width.saturating_sub(10)))
            ))
            .style(Style::default().fg(MUTED).bg(SURFACE)),
            Rect::new(spaces.x, spaces.y, spaces.width, 1),
        );
    }
    if agents.height > 0 {
        frame.render_widget(
            Paragraph::new(format!(
                " agents  {:>2}",
                rows.iter()
                    .filter(|row| matches!(row.kind, RowKind::Session(_)))
                    .count()
            ))
            .style(Style::default().fg(MUTED).bg(SURFACE)),
            Rect::new(agents.x, agents.y, agents.width, 1),
        );
    }
    for (section, is_space) in [(spaces, true), (agents, false)] {
        for (entry, index) in sidebar_entries(app, section, is_space) {
            let row = &rows[index];
            let selected = index == app.selected;
            let active = matches!(&row.kind, RowKind::Session(id) if app.active_id() == Some(id));
            let background = if active {
                app.theme.selection()
            } else {
                BACKGROUND
            };
            frame.render_widget(
                Block::default().style(Style::default().bg(background)),
                entry,
            );
            let indent = " ".repeat(row.depth.saturating_sub(1).min(5));
            let available = usize::from(entry.width).saturating_sub(4 + indent.len());
            let (marker, marker_color, detail, detail_color) = match &row.kind {
                RowKind::Root => (
                    "◇ ",
                    app.theme.accent(),
                    format!("{} sessions", app.sessions.len()),
                    MUTED,
                ),
                RowKind::Group(id) => {
                    let count = app
                        .sessions
                        .iter()
                        .filter(|s| s.group_id.as_deref() == Some(id))
                        .count();
                    let status = app.group_attention(id);
                    let location = app
                        .sessions
                        .iter()
                        .find(|session| session.group_id.as_deref() == Some(id))
                        .map(|session| session.cwd.as_str());
                    (
                        if app.collapsed.contains(id) {
                            "▸ "
                        } else {
                            "▾ "
                        },
                        status_color(status, app.theme),
                        status.map_or_else(
                            || {
                                location.map_or_else(
                                    || format!("{count} direct sessions"),
                                    str::to_owned,
                                )
                            },
                            |status| format!("{} · {count} sessions", status.label()),
                        ),
                        status.map_or(MUTED, |_| status_color(status, app.theme)),
                    )
                }
                RowKind::Session(id) => {
                    let session = app.session(id);
                    let status = session.and_then(|session| session.status.as_ref());
                    let state = status.map(Status::label).unwrap_or_else(|| {
                        if session.is_some_and(|session| session.running) {
                            "unknown"
                        } else {
                            "ended"
                        }
                    });
                    let program = session
                        .map(|session| app.effective_program(session).label())
                        .unwrap_or("Terminal");
                    let marker = match status.map(|status| status.state) {
                        Some(State::Working) => "● ",
                        Some(State::Question) => "? ",
                        Some(State::Blocked) => "! ",
                        Some(State::Done) => "✓ ",
                        Some(State::Failed) => "× ",
                        _ => "○ ",
                    };
                    (
                        marker,
                        status_color(status, app.theme),
                        format!("{state} · {program}"),
                        session
                            .map(|session| program_color(app.effective_program(session)))
                            .unwrap_or(MUTED),
                    )
                }
            };
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(
                        if selected { "›" } else { " " },
                        Style::default().fg(app.theme.accent()),
                    ),
                    Span::raw(indent.clone()),
                    Span::styled(marker, Style::default().fg(marker_color)),
                    Span::styled(
                        truncate_cells(&row.label, available),
                        Style::default()
                            .fg(if selected || active { TEXT } else { MUTED })
                            .add_modifier(Modifier::BOLD),
                    ),
                ]))
                .style(Style::default().bg(background)),
                Rect::new(entry.x, entry.y, entry.width, 1),
            );
            if entry.height > 1 {
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::raw("   "),
                        Span::raw(indent),
                        Span::styled(
                            truncate_cells(&detail, usize::from(entry.width).saturating_sub(4)),
                            Style::default().fg(detail_color),
                        ),
                    ]))
                    .style(Style::default().bg(background)),
                    Rect::new(entry.x, entry.y + 1, entry.width, 1),
                );
            }
        }
    }
}

fn render_pane(frame: &mut Frame, app: &App, index: usize, area: Rect, logo_frame: usize) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let focused = app.focused == index;
    let controlling = focused && app.mode == Mode::Input && app.dialog.is_none();
    let session = app.panes[index].as_deref().and_then(|id| app.session(id));
    let title = match session {
        Some(session) => {
            let status = session.status.as_ref().map_or(
                if session.running { "running" } else { "ended" },
                Status::label,
            );
            let width = usize::from(pane_content(area, app.fullscreen).width);
            let status_width = Line::from(status).width();
            let effective_program = app.effective_program(session);
            let program = if width > status_width + effective_program.label().len() + 14 {
                format!("  {}", effective_program.label())
            } else {
                String::new()
            };
            let name = truncate_cells(
                &session.name,
                width.saturating_sub(5 + status_width + program.len()),
            );
            Line::from(vec![
                Span::styled(
                    if controlling { "▎ " } else { "  " },
                    Style::default().fg(app.theme.accent()),
                ),
                Span::styled(name, Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
                Span::styled(
                    program,
                    Style::default().fg(program_color(effective_program)),
                ),
                Span::styled(" · ", Style::default().fg(MUTED)),
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
    let content = pane_content(area, app.fullscreen);
    if !app.fullscreen {
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(if controlling {
                    app.theme.accent()
                } else {
                    BORDER
                })),
            area,
        );
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
    }
    let Some(session) = session else {
        render_home(frame, content, logo_frame, app.theme);
        return;
    };
    frame.render_widget(
        Block::default().style(Style::default().fg(Color::Reset).bg(Color::Reset)),
        content,
    );
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

fn program_color(program: Program) -> Color {
    match program {
        Program::Shell => MUTED,
        Program::Claude => Color::Rgb(230, 145, 113),
        Program::Gemini => Color::Rgb(139, 175, 226),
        Program::Codex => Color::Rgb(139, 201, 203),
    }
}

fn tab_label(app: &App, session: &crate::model::Session) -> String {
    let program = app.effective_program(session);
    if program == Program::Shell || session.name.eq_ignore_ascii_case(program.label()) {
        session.name.clone()
    } else {
        format!("{} · {}", program.label(), session.name)
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
        frame.render_widget(
            Paragraph::new(match index {
                0 => " Enter workspace ",
                1 => " Pair mobile ",
                _ => " Settings ",
            })
            .style(Style::default().fg(if index == app.menu_selected {
                app.theme.accent()
            } else {
                MUTED
            })),
            target,
        );
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
        Dialog::Settings { .. } => 10,
        Dialog::NewGroup { .. } => 16,
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
        Dialog::Settings { .. } => "Settings",
        Dialog::NewGroup { .. } => "New group",
        Dialog::Text { title, .. } | Dialog::Confirm { title, .. } => title.as_str(),
        Dialog::Move { .. } => "Move to group",
        Dialog::Help => "Keyboard",
        Dialog::NewSession(_) => "New session",
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
        Dialog::Settings { selected } => {
            for (index, label) in [
                format!("Theme                       {}   ← →", app.theme.label()),
                format!(
                    "Full screen session by default   {}",
                    if app.fullscreen_default { "on" } else { "off" }
                ),
            ]
            .into_iter()
            .enumerate()
            {
                let row = 1 + index as u16 * 2;
                if row < inner.height {
                    frame.render_widget(
                        Paragraph::new(Line::from(vec![
                            Span::styled(
                                if index == *selected { "› " } else { "  " },
                                Style::default().fg(app.theme.accent()),
                            ),
                            Span::styled(label, Style::default().fg(TEXT)),
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
            if inner.height > 6 {
                frame.render_widget(
                    Paragraph::new("Changes are shown and saved immediately.")
                        .style(Style::default().fg(MUTED)),
                    Rect::new(inner.x, inner.y + 6, inner.width, 1),
                );
            }
        }
        Dialog::NewGroup {
            name,
            parent_index,
            editing_parent,
        } => {
            if inner.height > 1 {
                frame.render_widget(
                    Paragraph::new(format!("Name: {name}")).style(if !editing_parent {
                        Style::default().bg(app.theme.selection())
                    } else {
                        Style::default()
                    }),
                    Rect::new(inner.x, inner.y + 1, inner.width, 1),
                );
            }
            if inner.height > 3 {
                frame.render_widget(
                    Paragraph::new("Inside:").style(Style::default().fg(MUTED)),
                    Rect::new(inner.x, inner.y + 3, inner.width, 1),
                );
            }
            let choices = app.group_choices(None);
            let offset = ui_controls::move_offset(*parent_index, inner.height.saturating_sub(4));
            for (index, (_, label)) in choices
                .iter()
                .enumerate()
                .skip(offset)
                .take(usize::from(inner.height.saturating_sub(4)))
            {
                let row = 4 + (index - offset) as u16;
                if row < inner.height {
                    frame.render_widget(
                        Paragraph::new(format!(
                            "{} {label}",
                            if *editing_parent && index == *parent_index {
                                "›"
                            } else {
                                " "
                            }
                        ))
                        .style(if index == *parent_index {
                            Style::default().fg(TEXT).bg(app.theme.selection())
                        } else {
                            Style::default().fg(MUTED)
                        }),
                        Rect::new(inner.x, inner.y + row, inner.width, 1),
                    );
                }
            }
            if !editing_parent && inner.height > 1 {
                frame.set_cursor_position((
                    inner.x + (6 + name.len()).min(inner.width.saturating_sub(1) as usize) as u16,
                    inner.y + 1,
                ));
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
                    "n / g        New session / group (choose parent)\n",
                    "r / m / d    Rename / move / delete (confirmation)\n",
                    "v / Tab      Split / focus next pane\n",
                    "PgUp/PgDn    Local scrollback\n",
                    "F1 / p / ?   Menu / pair mobile / keyboard help\n",
                    "z            Full screen / workspace\n",
                    "Esc          Session key / cancel dialog / exit from navigation\n",
                    "q            Detach from navigation\n\n",
                    "INPUT sends keys to the session.\n",
                    "Ctrl+Q switches to NAVIGATION for nesvo.\n",
                    "Esc goes to the controlled session.\n",
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
    fn workspace_has_separate_spaces_and_agents_with_clickable_rows() {
        let mut app = App::new(1);
        app.event(json!({
            "type":"sessions", "revision":1,
            "groups":[{"id":"project", "parentId":null, "name":"Workspace", "order":0}],
            "sessions":[
                {"id":"agent", "name":"Build feature", "cwd":"C:/projects/nesvo", "program":"claude",
                    "cols":80, "rows":24, "running":true, "groupId":"project", "controllerId":null,
                    "status":{"state":"question", "source":"screen", "updatedAt":1}},
                {"id":"shell", "name":"Tests", "cwd":"C:/projects/nesvo", "program":"shell",
                    "cols":80, "rows":24, "running":true, "groupId":null, "controllerId":null}
            ]
        })).unwrap();
        let area = Rect::new(0, 0, 120, 30);
        let layout = geometry(area, &app);
        let tree = tree_content(layout.tree);
        let (spaces, agents) = sidebar_sections(tree, &app);
        let rows = app.tree();
        let group_index = rows
            .iter()
            .position(|row| row.kind == RowKind::Group("project".into()))
            .unwrap();
        let agent_index = rows
            .iter()
            .position(|row| row.kind == RowKind::Session("agent".into()))
            .unwrap();
        let group = sidebar_entries(&app, spaces, true)
            .into_iter()
            .find(|(_, index)| *index == group_index)
            .unwrap()
            .0;
        let agent = sidebar_entries(&app, agents, false)
            .into_iter()
            .find(|(_, index)| *index == agent_index)
            .unwrap()
            .0;
        assert_eq!(
            sidebar_hit(&app, layout.tree, group.x, group.y),
            Some(group_index)
        );
        assert_eq!(
            sidebar_hit(&app, layout.tree, agent.x, agent.y),
            Some(agent_index)
        );
        assert!(agent.y > group.y);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let line = |y| {
            (tree.x..tree.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        };
        assert!(line(spaces.y).contains("spaces"));
        assert!(line(agents.y).contains("agents"));
        assert!(line(group.y + 1).contains("~question"));
        assert!(line(agent.y + 1).contains("Claude"));
        assert_eq!(
            buffer[(agent.x + 3, agent.y + 1)].fg,
            program_color(Program::Claude)
        );
    }

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
        let layout = geometry(area, &app);
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
        let (spaces, _) = sidebar_sections(tree, &app);
        let group_y = sidebar_entries(&app, spaces, true)
            .into_iter()
            .find_map(|(area, index)| (index == group_index).then_some(area.y))
            .unwrap();
        let group: String = (tree.x..tree.right())
            .map(|x| buffer[(x, group_y + 1)].symbol())
            .collect();
        assert!(
            group.contains("~question"),
            "Attention must remain visible: {group}"
        );
    }

    #[test]
    fn fullscreen_gives_terminal_all_but_one_row_and_keeps_mode_visible() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"Shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.terminals
            .get_mut("s")
            .unwrap()
            .process("A\x1b[31mR", false);
        app.mode = Mode::Input;
        app.fullscreen = true;
        let area = Rect::new(0, 0, 80, 24);
        let layout = geometry(area, &app);
        assert_eq!(layout.header.height, 0);
        assert_eq!(layout.tree.width, 0);
        assert_eq!(layout.footer.height, 1);
        assert_eq!(pane_content(layout.panes[0], true), Rect::new(0, 0, 80, 23));
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(0, 0)].symbol(), "A");
        assert_eq!(buffer[(0, 0)].fg, Color::Reset);
        assert_eq!(buffer[(0, 0)].bg, Color::Reset);
        assert_eq!(buffer[(1, 0)].fg, Color::Indexed(1));
        let footer: String = (0..area.width)
            .map(|x| buffer[(x, layout.footer.y)].symbol())
            .collect();
        assert!(footer.contains("SESSION"), "{footer}");
        assert!(footer.contains("Ctrl+Q navigation"), "{footer}");
        assert!(footer.contains(" z "), "{footer}");
        let handle = fullscreen_handle_area(&app, layout.footer);
        assert_eq!(buffer[(handle.x, handle.y)].bg, app.theme.accent());
    }

    #[test]
    fn home_animation_changes_only_logo_cells_not_layout_or_controls() {
        let app = App::new(1);
        let area = Rect::new(0, 0, 120, 36);
        let logo =
            brand::area(pane_content(geometry(area, &app).panes[0], app.fullscreen)).unwrap();
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
            Dialog::Settings { selected: 0 },
            Dialog::NewGroup {
                name: String::new(),
                parent_index: 0,
                editing_parent: false,
            },
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
