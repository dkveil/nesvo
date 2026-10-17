//! Rendering is a pure projection of App. No filesystem, network, or process calls.
use crate::{
    brand,
    launch::Program,
    model::{App, Dialog, Mode, RowKind},
    status::{Source, State, Status},
    terminal::TerminalWidget,
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, Theme, WARNING},
    ui_controls, ui_launch, ui_palette,
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

pub fn immersive(app: &App) -> bool {
    app.fullscreen && app.mode == Mode::Input && app.dialog.is_none()
}

pub fn tab_areas(app: &App, layout: &Geometry) -> (Vec<(usize, Rect)>, Rect) {
    let mut tabs = Vec::new();
    let mut x = layout.tree.right();
    let available = layout.header.right().saturating_sub(x).saturating_sub(3);
    let widths: Vec<u16> = app
        .tabs
        .iter()
        .map(|id| {
            app.session(id).map_or(3, |session| {
                (Line::from(tab_label(app, session).as_str()).width() as u16 + 2).min(20)
            })
        })
        .collect();
    let active = app
        .active_id()
        .and_then(|id| app.tabs.iter().position(|tab| tab == id));
    let mut start = 0;
    let mut used = 0u16;
    if let Some(active) = active {
        for index in 0..=active {
            used = used.saturating_add(widths[index]);
            while used > available && start < index {
                used = used.saturating_sub(widths[start]);
                start += 1;
            }
        }
    }
    for (index, width) in widths.into_iter().enumerate().skip(start) {
        let visible = width.min(available.saturating_sub(x.saturating_sub(layout.tree.right())));
        if visible == 0 {
            break;
        }
        tabs.push((
            index,
            Rect::new(x, layout.header.y, visible, layout.header.height.min(1)),
        ));
        x = x.saturating_add(visible);
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
    let immersive = immersive(app);
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(if immersive { 0 } else { 1 }),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(area);
    let sidebar = if immersive || area.width < 65 {
        0
    } else {
        27.min(area.width / 3)
    };
    let [tree, content] =
        Layout::horizontal([Constraint::Length(sidebar), Constraint::Min(0)]).areas(body);
    let panes = if immersive {
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
    // The tab is the title. Keep only side borders and the ownership row;
    // controller resize and mouse geometry use this same content rectangle.
    Block::default()
        .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
        .inner(area)
}

pub fn tree_content(area: Rect) -> Rect {
    Block::default().borders(Borders::RIGHT).inner(area)
}

fn row_height(row: &crate::model::TreeRow) -> u16 {
    if matches!(row.kind, RowKind::Session(_)) {
        2
    } else {
        1
    }
}

fn sidebar_entries(app: &App, area: Rect) -> Vec<(Rect, usize)> {
    let area = sidebar_rows_area(app, area);
    let rows = app.tree();
    if area.height == 0 || rows.is_empty() {
        return Vec::new();
    }
    let mut start = 0;
    let mut used = 0u16;
    for (index, row) in rows
        .iter()
        .enumerate()
        .take(app.selected.min(rows.len() - 1) + 1)
    {
        used = used.saturating_add(row_height(row));
        while used > area.height && start < index {
            used = used.saturating_sub(row_height(&rows[start]));
            start += 1;
        }
    }
    let mut y = area.y;
    let mut entries = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let height = row_height(row).min(area.bottom() - y);
        entries.push((Rect::new(area.x, y, area.width, height), index));
        y += height;
    }
    entries
}

fn sidebar_rows_area(app: &App, area: Rect) -> Rect {
    if matches!(app.dialog, Some(Dialog::QuickSwitch { .. })) {
        return area;
    }
    let count = app
        .capabilities
        .as_ref()
        .map_or(0, |caps| caps.provider_limits.len());
    let reserved = if count == 0 {
        0
    } else {
        (count as u16 + 2).min(area.height / 3)
    };
    Rect {
        height: area.height.saturating_sub(reserved),
        ..area
    }
}

fn limit_label(minutes: u32) -> String {
    if minutes.is_multiple_of(1440) {
        format!("{}d", minutes / 1440)
    } else if minutes.is_multiple_of(60) {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

pub fn sidebar_hit(app: &App, area: Rect, column: u16, row: u16) -> Option<usize> {
    let content = tree_content(area);
    if !content.contains((column, row).into()) {
        return None;
    }
    let rows = app.tree();
    sidebar_entries(app, content)
        .into_iter()
        .find_map(|(area, index)| {
            (area.contains((column, row).into()) && !matches!(rows[index].kind, RowKind::Root))
                .then_some(index)
        })
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
    if !app.connected {
        let width = area.width.min(54);
        let height = area.height.min(7);
        let panel = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        frame.render_widget(
            Block::bordered()
                .title(" nesvo · reconnecting ")
                .border_style(Style::default().fg(app.theme.accent()))
                .style(Style::default().bg(SURFACE).fg(TEXT)),
            panel,
        );
        let inner = Block::bordered().inner(panel);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from("Connecting to your host…"),
                Line::from(""),
                Line::from(Span::styled(
                    "Sessions stay on the host. Ctrl+C to quit.",
                    Style::default().fg(MUTED),
                )),
            ]),
            inner,
        );
        return;
    }
    if matches!(app.dialog, Some(Dialog::Menu)) {
        render_menu(frame, app, logo_frame);
        ui_controls::render(frame, app);
        return;
    }
    if matches!(
        app.dialog,
        Some(Dialog::ExitConfirm {
            from_menu: true,
            ..
        })
    ) {
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
    if !immersive(app) {
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
        for (index, tab) in tabs {
            if tab.width == 0 {
                continue;
            }
            let name = app
                .session(&app.tabs[index])
                .map_or_else(|| "session".to_owned(), |session| tab_label(app, session));
            let label = format!(
                " {} ",
                truncate_cells(&name, usize::from(tab.width.saturating_sub(2)))
            );
            let active = app.active_id() == Some(app.tabs[index].as_str());
            frame.render_widget(
                Paragraph::new(label).style(if active && app.mode == Mode::Input {
                    Style::default()
                        .fg(BACKGROUND)
                        .bg(app.theme.accent())
                        .add_modifier(Modifier::BOLD)
                } else if active {
                    Style::default()
                        .fg(app.theme.accent())
                        .bg(app.theme.selection())
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
    let rows = app.tree();
    for (entry, index) in sidebar_entries(app, content) {
        let row = &rows[index];
        let selected = index == app.selected;
        let background = if selected && matches!(row.kind, RowKind::Session(_)) {
            app.theme.selection()
        } else if matches!(row.kind, RowKind::Root | RowKind::Group(_)) {
            SURFACE
        } else {
            BACKGROUND
        };
        frame.render_widget(
            Block::default().style(Style::default().bg(background)),
            entry,
        );
        let indent = "  ".repeat(row.depth.min(4));
        match &row.kind {
            RowKind::Root | RowKind::Group(_) => {
                if matches!(row.kind, RowKind::Root) {
                    frame.render_widget(
                        Paragraph::new(Line::from(vec![
                            Span::styled(" ⌕ ", Style::default().fg(app.theme.accent())),
                            Span::styled("Search sessions", Style::default().fg(MUTED)),
                            Span::styled("  /", Style::default().fg(MUTED)),
                        ]))
                        .style(Style::default().bg(SURFACE)),
                        entry,
                    );
                    continue;
                }
                let (marker, count, attention) = match &row.kind {
                    RowKind::Root => (" ", app.sessions.len(), None),
                    RowKind::Group(id) => (
                        if app.collapsed.contains(id) {
                            "›"
                        } else {
                            "⌄"
                        },
                        group_session_count(app, id),
                        app.group_attention(id),
                    ),
                    RowKind::Session(_) => unreachable!(),
                };
                let available = usize::from(entry.width).saturating_sub(6 + indent.len());
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled(
                            if selected { "▎" } else { " " },
                            Style::default().fg(app.theme.accent()),
                        ),
                        Span::raw(indent),
                        Span::styled(
                            format!("{marker} "),
                            Style::default().fg(status_color(attention, app.theme)),
                        ),
                        Span::styled(
                            truncate_cells(&row.label, available),
                            Style::default()
                                .fg(if selected { app.theme.accent() } else { MUTED })
                                .add_modifier(if selected {
                                    Modifier::BOLD
                                } else {
                                    Modifier::empty()
                                }),
                        ),
                    ]))
                    .style(Style::default().bg(background)),
                    Rect::new(entry.x, entry.y, entry.width, 1),
                );
                if entry.width >= 4 {
                    frame.render_widget(
                        Paragraph::new(format!("{count:>2}"))
                            .style(Style::default().fg(MUTED).bg(background)),
                        Rect::new(entry.right() - 3, entry.y, 2, 1),
                    );
                }
            }
            RowKind::Session(id) => {
                let Some(session) = app.session(id) else {
                    continue;
                };
                let status = session.status.as_ref();
                let marker = match status.map(|status| (status.source, status.state)) {
                    Some((Source::Screen, State::Working)) => "●",
                    Some((_, State::Question)) => "?",
                    Some((_, State::Blocked)) => "!",
                    Some((_, State::Done)) => "✓",
                    Some((_, State::Failed)) => "×",
                    _ => "○",
                };
                let available = usize::from(entry.width).saturating_sub(4 + indent.len());
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled(
                            if selected { "▎" } else { " " },
                            Style::default().fg(app.theme.accent()),
                        ),
                        Span::raw(indent.clone()),
                        Span::styled(marker, Style::default().fg(status_color(status, app.theme))),
                        Span::raw(" "),
                        Span::styled(
                            truncate_cells(&row.label, available),
                            Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                        ),
                    ]))
                    .style(Style::default().bg(background)),
                    Rect::new(entry.x, entry.y, entry.width, 1),
                );
                if entry.height > 1 {
                    frame.render_widget(
                        Paragraph::new(Line::from(vec![
                            Span::raw(format!("  {indent}  ")),
                            Span::styled(
                                display_status(session),
                                Style::default().fg(status_color(status, app.theme)),
                            ),
                            Span::styled(" · ", Style::default().fg(MUTED)),
                            Span::styled(
                                app.effective_program(session).label(),
                                Style::default().fg(program_color(app.effective_program(session))),
                            ),
                        ]))
                        .style(Style::default().bg(background)),
                        Rect::new(entry.x, entry.y + 1, entry.width, 1),
                    );
                }
            }
        }
    }
    if let Some(caps) = &app.capabilities {
        let rows_end = sidebar_rows_area(app, content).bottom();
        if rows_end < content.bottom() {
            let mut lines = vec![Line::from(Span::styled(
                " LIMITS · USED",
                Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
            ))];
            for provider in &caps.provider_limits {
                let label = provider.id.label();
                let detail = if provider.status == "ready" {
                    provider
                        .windows
                        .iter()
                        .map(|window| {
                            format!(
                                "{} {}%",
                                limit_label(window.duration_mins),
                                window.used_percent
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                } else if provider.status == "checking" {
                    "checking…".into()
                } else {
                    match provider.id {
                        Program::Claude => "/usage in CLI".into(),
                        Program::Gemini => "/stats in CLI".into(),
                        _ => "unavailable".into(),
                    }
                };
                lines.push(Line::from(vec![
                    Span::styled(format!(" {label} "), Style::default().fg(TEXT)),
                    Span::styled(detail, Style::default().fg(MUTED)),
                ]));
            }
            frame.render_widget(
                Paragraph::new(lines).style(Style::default().bg(SURFACE)),
                Rect::new(
                    content.x,
                    rows_end,
                    content.width,
                    content.bottom() - rows_end,
                ),
            );
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
    let content = pane_content(area, immersive(app));
    if !immersive(app) {
        frame.render_widget(
            Block::default()
                .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
                .border_style(Style::default().fg(if controlling {
                    app.theme.accent()
                } else {
                    BORDER
                })),
            area,
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

pub fn home_panel(content: Rect) -> Rect {
    let logo = brand::area(content);
    let width = logo.map_or(29, |area| area.width).min(content.width);
    let height = if logo.is_some() { brand::ROWS + 8 } else { 7 }.min(content.height);
    Rect::new(
        content.x + content.width.saturating_sub(width) / 2,
        content.y + content.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn render_home(frame: &mut Frame, content: Rect, logo_frame: usize, theme: Theme) {
    let panel = home_panel(content);
    if let Some(logo) = brand::area(content) {
        frame.render_widget(
            brand::Logo(logo_frame, theme),
            Rect::new(panel.x, panel.y, logo.width, brand::ROWS),
        );
    }
    let offset = brand::home_offset(content);
    frame.render_widget(
        Paragraph::new("A place for your next session.").style(Style::default().fg(MUTED)),
        Rect::new(
            panel.x,
            panel.y + offset,
            panel.width,
            panel.height.saturating_sub(offset).min(1),
        ),
    );
}

pub(crate) fn truncate_cells(text: &str, max_width: usize) -> String {
    let mut width = 0;
    text.chars()
        .take_while(|character| {
            width += Span::raw(character.to_string()).width();
            width <= max_width
        })
        .collect()
}

pub(crate) fn display_status(session: &crate::model::Session) -> &'static str {
    match session.status.as_ref().map(Status::label) {
        Some("unknown") | None => {
            if session.running {
                "open"
            } else {
                "ended"
            }
        }
        Some(label) => label,
    }
}

fn group_session_count(app: &App, id: &str) -> usize {
    app.sessions
        .iter()
        .filter(|session| {
            let mut parent = session.group_id.as_deref();
            let mut seen = std::collections::HashSet::new();
            while let Some(group_id) = parent {
                if group_id == id {
                    return true;
                }
                if !seen.insert(group_id) {
                    break;
                }
                parent = app
                    .groups
                    .iter()
                    .find(|group| group.id == group_id)
                    .and_then(|group| group.parent_id.as_deref());
            }
            false
        })
        .count()
}

pub(crate) fn status_color(status: Option<&Status>, theme: Theme) -> Color {
    match status.map(|status| (status.source, status.state)) {
        Some((Source::Screen, State::Question | State::Blocked)) => WARNING,
        Some((Source::Process | Source::Screen, State::Failed)) => DANGER,
        Some((Source::Process | Source::Screen, State::Done)) => SUCCESS,
        Some((Source::Screen, State::Working)) => theme.accent(),
        _ => MUTED,
    }
}

pub(crate) fn program_color(program: Program) -> Color {
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
        if target.is_empty() {
            continue;
        }
        let selected = index == app.menu_selected;
        frame.render_widget(
            Block::bordered()
                .border_style(Style::default().fg(if selected {
                    app.theme.accent()
                } else {
                    BORDER
                }))
                .style(Style::default().bg(if selected {
                    app.theme.selection()
                } else {
                    SURFACE
                })),
            target,
        );
        let inside = Block::bordered().inner(target);
        frame.render_widget(
            Paragraph::new(match index {
                0 => "Enter workspace",
                1 => "Pair mobile",
                _ => "Settings",
            })
            .centered()
            .style(Style::default().fg(if selected {
                app.theme.accent()
            } else {
                TEXT
            })),
            inside,
        );
    }
    if area.height > 0 {
        frame.render_widget(
            Paragraph::new("↑ ↓ choose  ·  Enter open  ·  Esc leave")
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
    if matches!(dialog, Dialog::Settings { .. }) {
        let width = 52.min(size.width.saturating_sub(2)).max(1);
        let height = 13.min(size.height.saturating_sub(2)).max(1);
        return Some(Rect::new(
            size.right().saturating_sub(width + 1),
            size.y + 2.min(size.height.saturating_sub(height)),
            width,
            height,
        ));
    }
    let width = if matches!(dialog, Dialog::ExitConfirm { .. }) {
        52
    } else if matches!(dialog, Dialog::Confirm { .. } | Dialog::Text { .. }) {
        62
    } else {
        76
    }
    .min(size.width.saturating_sub(4))
    .max(1);
    let height = match dialog {
        Dialog::Menu => 20,
        Dialog::Settings { .. } => 13,
        Dialog::ExitConfirm { .. } => 10,
        Dialog::NewGroup { .. } => 18,
        Dialog::Help => 27,
        Dialog::NewSession(_) | Dialog::FolderPicker { .. } => 27,
        Dialog::PairPhone => 20,
        Dialog::Move { choices, .. } => (choices.len() + 8).min(22) as u16,
        Dialog::QuickSwitch { .. } => 19,
        _ => 10,
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
    if let Dialog::QuickSwitch { query, selected } = dialog {
        ui_palette::render(frame, app, query, *selected);
        return;
    }
    let Some(area) = dialog_area(frame.area(), dialog) else {
        return;
    };
    frame.render_widget(Clear, area);
    let title = match dialog {
        Dialog::Menu => "Menu",
        Dialog::QuickSwitch { .. } => "Jump to session",
        Dialog::ExitConfirm { .. } => "Leave nesvo?",
        Dialog::Settings { .. } => "Settings",
        Dialog::NewGroup { .. } => "New group",
        Dialog::Text { title, .. } | Dialog::Confirm { title, .. } => title.as_str(),
        Dialog::Move { .. } => "Move to group",
        Dialog::Help => "Keyboard",
        Dialog::NewSession(_) => "New session",
        Dialog::FolderPicker { .. } => "Choose folder",
        Dialog::PairPhone => "Pair your phone",
    };
    let block = Block::bordered()
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(BORDER));
    let content = block.inner(area);
    let inner = ui_controls::dialog_body(content);
    frame.render_widget(block, area);
    if content.height > 0 && content.width > 4 {
        let inset = content.x + 2;
        let width = content.width - 4;
        let title_color = if matches!(dialog, Dialog::Confirm { .. }) {
            WARNING
        } else {
            app.theme.accent()
        };
        frame.render_widget(
            Paragraph::new(truncate_cells(title, usize::from(width.saturating_sub(8)))).style(
                Style::default()
                    .fg(title_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Rect::new(inset, content.y, width.saturating_sub(8), 1),
        );
        if width >= 8 {
            frame.render_widget(
                Paragraph::new("nesvo").style(Style::default().fg(MUTED)),
                Rect::new(inset + width - 5, content.y, 5, 1),
            );
        }
        if content.height > 1 {
            frame.render_widget(
                Paragraph::new("─".repeat(usize::from(width))).style(Style::default().fg(BORDER)),
                Rect::new(inset, content.y + 1, width, 1),
            );
        }
        if content.height > 3 {
            frame.render_widget(
                Paragraph::new("─".repeat(usize::from(width))).style(Style::default().fg(BORDER)),
                Rect::new(inset, content.bottom() - 2, width, 1),
            );
        }
    }
    match dialog {
        Dialog::Menu => {}
        Dialog::QuickSwitch { .. } => unreachable!("Palette has its own renderer"),
        Dialog::ExitConfirm { .. } => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from("Disconnect this client from the host?"),
                    Line::from(Span::styled(
                        "Your sessions will keep running.",
                        Style::default().fg(MUTED),
                    )),
                    Line::from(Span::styled(
                        "← → or Tab: choose    Enter: select",
                        Style::default().fg(MUTED),
                    )),
                ])
                .style(Style::default().fg(TEXT)),
                inner,
            );
        }
        Dialog::Settings { selected } => {
            for (index, label) in [
                format!("Theme: {}   ← →", app.theme.label()),
                format!(
                    "Full screen session by default: {}",
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
                        .style(
                            if index == *selected && app.dialog_button.is_none() {
                                Style::default().bg(app.theme.selection())
                            } else {
                                Style::default()
                            },
                        ),
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
                    Paragraph::new(format!(
                        "  {}",
                        if name.is_empty() {
                            "Type a group name…"
                        } else {
                            name
                        }
                    ))
                    .style(
                        if !editing_parent && app.dialog_button.is_none() {
                            Style::default().fg(TEXT).bg(app.theme.selection())
                        } else {
                            Style::default().fg(TEXT).bg(BORDER)
                        },
                    ),
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
                        .style(
                            if index == *parent_index && app.dialog_button.is_none() {
                                Style::default().fg(TEXT).bg(app.theme.selection())
                            } else {
                                Style::default().fg(MUTED)
                            },
                        ),
                        Rect::new(inner.x, inner.y + row, inner.width, 1),
                    );
                }
            }
            if !editing_parent && app.dialog_button.is_none() && inner.height > 1 {
                frame.set_cursor_position((
                    inner.x + (2 + name.len()).min(inner.width.saturating_sub(1) as usize) as u16,
                    inner.y + 1,
                ));
            }
        }
        Dialog::NewSession(form) => ui_launch::render_form(frame, app, form, inner),
        Dialog::FolderPicker { .. } => ui_launch::render_folder_picker(frame, app, inner),
        Dialog::PairPhone => ui_launch::render_pairing(frame, app, inner),
        Dialog::Text { value, .. } => {
            frame.render_widget(
                Paragraph::new("NEW NAME").style(Style::default().fg(MUTED)),
                Rect::new(inner.x, inner.y, inner.width, 1.min(inner.height)),
            );
            if inner.height > 1 {
                frame.render_widget(
                    Paragraph::new(format!(
                        "  {}",
                        if value.is_empty() {
                            "Type a name…"
                        } else {
                            value
                        }
                    ))
                    .style(Style::default().fg(TEXT).bg(
                        if app.dialog_button.is_none() {
                            app.theme.selection()
                        } else {
                            BORDER
                        },
                    )),
                    Rect::new(inner.x, inner.y + 1, inner.width, 1),
                );
            }
            if inner.height > 1 && inner.width > 0 {
                let offset = Line::from(value.as_str())
                    .width()
                    .min(usize::from(inner.width - 1)) as u16;
                if app.dialog_button.is_none() {
                    frame.set_cursor_position((
                        inner.x + (2 + offset).min(inner.width - 1),
                        inner.y + 1,
                    ));
                }
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
            .highlight_style(Style::default().bg(if app.dialog_button.is_none() {
                app.theme.selection()
            } else {
                BORDER
            }))
            .highlight_symbol("› ");
            let mut state = ListState::default()
                .with_selected(Some(*selected))
                .with_offset(ui_controls::move_offset(*selected, inner.height));
            frame.render_stateful_widget(list, inner, &mut state);
        }
        Dialog::Confirm { detail, .. } => {
            frame.render_widget(
                Paragraph::new(detail.as_str())
                    .style(Style::default().fg(TEXT))
                    .wrap(Wrap { trim: false }),
                Rect::new(
                    inner.x,
                    inner.y,
                    inner.width,
                    inner.height.saturating_sub(1),
                ),
            );
            if inner.height > 1 {
                frame.render_widget(
                    Paragraph::new("← → choose   Enter select   Esc cancel")
                        .style(Style::default().fg(MUTED)),
                    Rect::new(inner.x, inner.bottom() - 1, inner.width, 1),
                );
            }
        }
        Dialog::Help => {
            frame.render_widget(
                Paragraph::new(concat!(
                    "~ status: screen inference; open/quiet: I/O.\n\n",
                    "↑/↓ or j/k   Select and preview · Enter opens / expands\n",
                    "/ or Ctrl+K   Search sessions by name, agent, folder or group\n",
                    "i / t / x    Type / take over (confirm) / release\n",
                    "n / g        New session / group (choose parent)\n",
                    "r / m / d    Rename / move / delete (confirmation)\n",
                    "v / Tab      Split / focus next pane\n",
                    "PgUp/PgDn    Local scrollback\n",
                    "F1 / p / ?   Menu / pair mobile / keyboard help\n",
                    "z            Full screen / workspace\n",
                    "Esc          Session key / cancel dialog / confirm exit\n",
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
    fn installed_provider_limits_render_without_stealing_session_clicks() {
        let mut app = App::new(1);
        app.event(
            json!({"type":"capabilities","workspace":"/work","programs":[],
            "providerLimits":[{"id":"codex","status":"ready","windows":[
                {"usedPercent":73,"durationMins":300}
            ]}]}),
        )
        .unwrap();
        let area = Rect::new(0, 0, 100, 24);
        let tree = tree_content(geometry(area, &app).tree);
        let panel_y = sidebar_rows_area(&app, tree).bottom();
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let text = (tree.x..tree.right())
            .map(|x| terminal.backend().buffer()[(x, panel_y + 1)].symbol())
            .collect::<String>();
        assert!(text.contains("Codex"));
        assert!(text.contains("5h 73%"));
        assert_eq!(
            sidebar_hit(&app, geometry(area, &app).tree, tree.x, panel_y + 1),
            None
        );
    }

    #[test]
    fn search_opens_a_palette_and_disconnect_hides_stale_sessions() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"Docs","cwd":"C:/dev/docs","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        let tree = tree_content(geometry(area, &app).tree);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let heading = (tree.x..tree.right())
            .map(|x| terminal.backend().buffer()[(x, tree.y)].symbol())
            .collect::<String>();
        assert!(heading.contains("Search sessions"));
        app.dialog = Some(Dialog::QuickSwitch {
            query: "docs".into(),
            selected: 0,
        });
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let palette = crate::ui_palette::geometry(area, app.sessions.len());
        let result = (palette.results.x..palette.results.right())
            .map(|x| terminal.backend().buffer()[(x, palette.results.y)].symbol())
            .collect::<String>();
        assert!(result.contains("Docs"));
        app.disconnect("connection lost".into());
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("Connecting to your host"));
        assert!(!screen.contains("Docs"));
    }

    #[test]
    fn confirmation_uses_a_clear_header_and_destructive_action() {
        let mut app = App::new(1);
        app.connected = true;
        app.dialog = Some(Dialog::Confirm {
            title: "Delete session?".into(),
            detail: "Example will be removed. Its running process will stop.".into(),
            command: json!({"type":"close","sessionId":"example"}),
        });
        app.dialog_button = Some(1);
        let area = Rect::new(0, 0, 100, 30);
        let popup = dialog_area(area, app.dialog.as_ref().unwrap()).unwrap();
        let content = Block::bordered().inner(popup);
        let body = ui_controls::dialog_body(content);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let row = |y| {
            (popup.x..popup.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        };
        assert!(row(content.y).contains("Delete session?"));
        assert!(row(body.y).contains("Example will be removed"));
        assert!(!row(popup.y).contains("Its running process"));
        let delete = ui_controls::controls(&app, area)
            .into_iter()
            .find(|control| control.action == ui_controls::Action::Submit)
            .unwrap();
        assert_eq!(buffer[(delete.area.x, delete.area.y)].bg, BACKGROUND);
        let cancel = ui_controls::controls(&app, area)
            .into_iter()
            .find(|control| control.action == ui_controls::Action::Cancel)
            .unwrap();
        assert_eq!(
            buffer[(cancel.area.x, cancel.area.y)].bg,
            app.theme.accent()
        );
        app.dialog_button = Some(0);
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        assert_eq!(
            terminal.backend().buffer()[(delete.area.x, delete.area.y)].bg,
            DANGER
        );
        assert_eq!(
            ui_controls::hit_test(&app, area, delete.area.x, delete.area.y),
            Some(ui_controls::Action::Submit)
        );
    }

    #[test]
    fn exit_confirmation_highlights_the_keyboard_choice() {
        let area = Rect::new(0, 0, 100, 30);
        let mut app = App::new(1);
        app.dialog = Some(Dialog::ExitConfirm {
            from_menu: false,
            leave_selected: false,
        });
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let controls = ui_controls::controls(&app, area);
        let leave = controls
            .iter()
            .find(|control| control.action == ui_controls::Action::Submit)
            .unwrap();
        let stay = controls
            .iter()
            .find(|control| control.action == ui_controls::Action::Cancel)
            .unwrap();
        assert_eq!(
            terminal.backend().buffer()[(stay.area.x, stay.area.y)].bg,
            app.theme.accent()
        );
        assert_eq!(
            terminal.backend().buffer()[(leave.area.x, leave.area.y)].bg,
            BACKGROUND
        );
        if let Some(Dialog::ExitConfirm { leave_selected, .. }) = &mut app.dialog {
            *leave_selected = true;
        }
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        assert_eq!(
            terminal.backend().buffer()[(leave.area.x, leave.area.y)].bg,
            app.theme.accent()
        );
        assert_eq!(
            terminal.backend().buffer()[(stay.area.x, stay.area.y)].bg,
            BACKGROUND
        );
    }

    #[test]
    fn launch_input_and_focused_footer_have_full_width_highlights() {
        let area = Rect::new(0, 0, 100, 32);
        let mut app = App::new(1);
        app.dialog = Some(Dialog::NewSession(Default::default()));
        let popup = dialog_area(area, app.dialog.as_ref().unwrap()).unwrap();
        let body = ui_controls::dialog_body(Block::bordered().inner(popup));
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(
            buffer[(body.x + body.width - 1, body.y + 3)].bg,
            app.theme.selection()
        );
        assert_eq!(buffer[(body.x + body.width - 1, body.y + 6)].bg, BORDER);
        if let Some(Dialog::NewSession(form)) = &mut app.dialog {
            form.field = crate::launch::Field::Directory;
        }
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        assert_eq!(
            terminal.backend().buffer()[(body.x + body.width - 1, body.y + 6)].bg,
            app.theme.selection()
        );
        app.dialog_button = Some(1);
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let cancel = ui_controls::controls(&app, area)
            .into_iter()
            .find(|control| control.action == ui_controls::Action::Cancel)
            .unwrap();
        assert_eq!(
            terminal.backend().buffer()[(cancel.area.x, cancel.area.y)].bg,
            app.theme.accent()
        );
    }

    #[test]
    fn start_menu_actions_render_as_full_clickable_buttons() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Menu);
        let area = Rect::new(0, 0, 100, 30);
        let selected = ui_controls::menu_action_area(area, 0);
        let other = ui_controls::menu_action_area(area, 1);
        assert_eq!(selected.height, 3);
        assert_eq!(other.height, 3);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(selected.x, selected.y)].fg, app.theme.accent());
        assert_eq!(
            buffer[(selected.x + 1, selected.y + 1)].bg,
            app.theme.selection()
        );
        assert_eq!(buffer[(other.x, other.y)].fg, BORDER);
    }

    #[test]
    fn unknown_agent_state_is_shown_as_an_open_process() {
        let mut app = App::new(1);
        app.event(
            json!({"type":"sessions","revision":0,"groups":[],"sessions":[
                {"id":"agent","name":"Claude task","cwd":".","cols":80,"rows":24,
                 "running":true,"groupId":null,"controllerId":null,
                 "status":{"state":"unknown","source":"activity","updatedAt":1}}
            ]}),
        )
        .unwrap();
        let session = app.session("agent").unwrap();
        assert_eq!(session.status.as_ref().unwrap().label(), "unknown");
        assert_eq!(display_status(session), "open");
        let area = Rect::new(0, 0, 100, 24);
        let layout = geometry(area, &app);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let line: String = (layout.tree.x..layout.tree.right())
            .map(|x| buffer[(x, layout.tree.y + 2)].symbol())
            .collect();
        assert!(line.contains("open"), "{line}");
        assert!(!line.contains("unknown"), "{line}");
    }

    #[test]
    fn terminal_io_alone_is_not_shown_as_agent_activity() {
        let mut app = App::new(1);
        app.event(
            json!({"type":"sessions","revision":0,"groups":[],"sessions":[
                {"id":"agent","name":"Claude task","cwd":".","cols":80,"rows":24,
                 "running":true,"program":"claude","groupId":null,"controllerId":null,
                 "status":{"state":"working","source":"activity","updatedAt":1}}
            ]}),
        )
        .unwrap();
        let status = app.sessions[0].status.as_ref().unwrap();
        assert_eq!(display_status(&app.sessions[0]), "open");
        assert_eq!(status_color(Some(status), app.theme), MUTED);
        let area = Rect::new(0, 0, 100, 30);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let tree = tree_content(geometry(area, &app).tree);
        let row: String = (tree.x..tree.right())
            .map(|x| terminal.backend().buffer()[(x, tree.y + 1)].symbol())
            .collect();
        assert!(row.contains("○"), "{row}");
        app.sessions[0].status = Some(Status {
            state: State::Working,
            source: Source::Screen,
            _updated_at: 2,
        });
        assert_eq!(display_status(&app.sessions[0]), "~working");
        assert_eq!(
            status_color(app.sessions[0].status.as_ref(), app.theme),
            app.theme.accent()
        );
    }

    #[test]
    fn settings_preview_keeps_the_workspace_visible() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,
            "groups":[{"id":"work","parentId":null,"name":"Work","order":0}],
            "sessions":[]}))
            .unwrap();
        app.theme = Theme::Graphite;
        app.dialog = Some(Dialog::Settings { selected: 0 });
        let area = Rect::new(0, 0, 120, 30);
        let layout = geometry(area, &app);
        let popup = dialog_area(area, app.dialog.as_ref().unwrap()).unwrap();
        assert!(popup.x > layout.tree.right());
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let sidebar: String = (layout.tree.x..layout.tree.right())
            .map(|x| buffer[(x, layout.tree.y)].symbol())
            .collect();
        assert!(sidebar.contains("sessions"), "{sidebar}");
        assert_eq!(
            buffer[(layout.tree.x, layout.tree.y + 1)].fg,
            app.theme.accent()
        );
    }

    #[test]
    fn workspace_shows_groups_and_their_sessions_in_one_clickable_list() {
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
        let rows = app.tree();
        let group_index = rows
            .iter()
            .position(|row| row.kind == RowKind::Group("project".into()))
            .unwrap();
        let agent_index = rows
            .iter()
            .position(|row| row.kind == RowKind::Session("agent".into()))
            .unwrap();
        let group = sidebar_entries(&app, tree)
            .into_iter()
            .find(|(_, index)| *index == group_index)
            .unwrap()
            .0;
        let agent = sidebar_entries(&app, tree)
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
        assert_eq!(group.height, 1);
        assert_eq!(agent.height, 2);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let line = |y| {
            (tree.x..tree.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        };
        assert!(line(tree.y).contains("sessions"));
        assert!(line(group.y).contains("Workspace"));
        assert!(!line(group.y).contains('▣'));
        assert!(line(agent.y + 1).contains("~question"));
        assert!(line(agent.y + 1).contains("Claude"));
        assert!(
            (agent.x..agent.right())
                .any(|x| { buffer[(x, agent.y + 1)].fg == program_color(Program::Claude) })
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
        let pane_top: String = (layout.panes[0].x..layout.panes[0].right())
            .map(|x| buffer[(x, layout.panes[0].y)].symbol())
            .collect();
        assert!(!pane_top.contains("~question"));
        assert!(!pane_top.contains("A very long session"));
        let group_index = app
            .tree()
            .iter()
            .position(|row| row.kind == RowKind::Group("g".into()))
            .unwrap();
        let tree = tree_content(layout.tree);
        let group_y = sidebar_entries(&app, tree)
            .into_iter()
            .find_map(|(area, index)| (index == group_index).then_some(area.y))
            .unwrap();
        let group: String = (tree.x..tree.right())
            .map(|x| buffer[(x, group_y)].symbol())
            .collect();
        assert!(group.contains("A very long"), "{group}");
        assert_eq!(buffer[(tree.x + 1, group_y)].fg, WARNING);
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
        let content = pane_content(geometry(area, &app).panes[0], app.fullscreen);
        let panel = home_panel(content);
        let logo = Rect::new(
            panel.x,
            panel.y,
            brand::area(content).unwrap().width,
            brand::ROWS,
        );
        assert_eq!(panel.x, content.x + (content.width - panel.width) / 2);
        assert_eq!(panel.y, content.y + (content.height - panel.height) / 2);
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
            Dialog::QuickSwitch {
                query: String::new(),
                selected: 0,
            },
            Dialog::Settings { selected: 0 },
            Dialog::NewGroup {
                name: String::new(),
                parent_index: 0,
                editing_parent: false,
            },
            Dialog::Help,
            Dialog::PairPhone,
            Dialog::NewSession(Default::default()),
            Dialog::FolderPicker {
                form: Default::default(),
                path: "C:\\work".into(),
                parent: None,
                entries: vec![],
                query: String::new(),
                selected: 0,
                loading: false,
            },
        ] {
            app.dialog = Some(dialog);
            for (width, height) in [(120, 40), (60, 20), (20, 4), (1, 1), (0, 0)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|frame| render(frame, &app, 0)).unwrap();
            }
        }
    }
}
