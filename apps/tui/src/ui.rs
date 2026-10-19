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
    pub sidebar_header: Rect,
    pub tree: Rect,
    pub panes: [Rect; 2],
    pub footer: Rect,
    pub review: Rect,
}

pub fn immersive(app: &App) -> bool {
    app.fullscreen
        && (app.mode == Mode::Input
            || (app.review.visible && app.review.focused && app.review.return_to_input))
        && app.dialog.is_none()
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
        if app.sidebar_width == 0 {
            42.min(area.width / 2).min(area.width.saturating_sub(48))
        } else {
            app.sidebar_width
                .clamp(22, 80)
                .min(area.width.saturating_sub(48))
        }
    };
    let [tree, content] =
        Layout::horizontal([Constraint::Length(sidebar), Constraint::Min(0)]).areas(body);
    let sidebar_header = Rect::new(
        tree.x,
        area.y,
        tree.width,
        (tree.height + header.height).min(1),
    );
    let inset = sidebar_header
        .height
        .saturating_sub(header.height)
        .min(tree.height);
    let tree = Rect::new(tree.x, tree.y + inset, tree.width, tree.height - inset);
    let (content, review) = if app.review.visible {
        if app.review.expanded || content.width < 88 {
            (Rect::default(), content)
        } else {
            let [terminal, review] = Layout::horizontal([
                Constraint::Min(48),
                Constraint::Length(if app.review.width == 0 {
                    (content.width / 4).clamp(40, 60)
                } else {
                    app.review.width.clamp(28, content.width.saturating_sub(48))
                }),
            ])
            .areas(content);
            (terminal, review)
        }
    } else {
        (content, Rect::default())
    };
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
        sidebar_header,
        tree,
        panes,
        footer,
        review,
    }
}

pub fn pane_content(area: Rect, fullscreen: bool) -> Rect {
    if fullscreen {
        return area;
    }
    // The tab is the title. Keep only side borders and the ownership row;
    // controller resize and mouse geometry use this same content rectangle.
    Block::default()
        .borders(Borders::RIGHT | Borders::BOTTOM)
        .inner(area)
}

pub fn tree_content(area: Rect) -> Rect {
    Block::default().borders(Borders::RIGHT).inner(area)
}

fn row_height(row: &crate::model::TreeRow) -> u16 {
    if matches!(row.kind, RowKind::Root) {
        3
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

fn sidebar_rows_area(_app: &App, area: Rect) -> Rect {
    area
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
    if app.review.visible && app.review.focused && app.mode == Mode::Navigate {
        return (" DIFF REVIEW ", " F4 / Esc close · r refresh");
    }
    if app.mode == Mode::Navigate
        && (app.wake_available() || app.active_session().is_some_and(|s| s.wake_at.is_some()))
    {
        return (" NESVO MENU ", " Enter resume · w quota wake · F4 diff");
    }
    match app.mode {
        Mode::Input => (" SESSION INPUT ", " Ctrl+Q menu · F4 diff"),
        Mode::Navigate => (
            " NESVO MENU ",
            " Enter resume · n new · / search · F4 diff · ? help",
        ),
    }
}

pub(crate) fn shortcut_spans(hint: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for part in hint.split_inclusive(' ') {
        let key = part.trim();
        let is_key = matches!(
            key,
            "Ctrl+Q"
                | "Ctrl+K"
                | "Enter"
                | "Esc"
                | "Tab"
                | "Space"
                | "PgUp/PgDn"
                | "↑↓"
                | "←→"
                | "↑"
                | "↓"
                | "←"
                | "→"
                | "[]"
                | "n"
                | "z"
                | "w"
                | "r"
                | "c"
                | "s"
                | "e"
                | "o"
                | "y"
                | "Y"
                | "x"
                | "/"
                | "?"
        ) || key
            .strip_prefix('F')
            .is_some_and(|n| n.parse::<u8>().is_ok());
        if is_key {
            spans.push(Span::styled(
                format!(" {key} "),
                Style::default()
                    .fg(TEXT)
                    .bg(BORDER)
                    .add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::raw(" "));
        } else {
            spans.push(Span::styled(part.to_owned(), Style::default().fg(MUTED)));
        }
    }
    spans
}

/// Wrap complete key-description pairs; never leave a keycap without its label.
pub(crate) fn shortcut_lines(items: &[&str], width: u16) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut spans = Vec::new();
    let mut used = 0;
    for item in items {
        let next = shortcut_spans(item);
        let size = Line::from(next.clone()).width();
        if used > 0 && used + size + 2 > usize::from(width) {
            lines.push(Line::from(std::mem::take(&mut spans)));
            used = 0;
        }
        if used > 0 {
            spans.push(Span::raw("  "));
            used += 2;
        }
        spans.extend(next);
        used += size;
    }
    if !spans.is_empty() {
        lines.push(Line::from(spans));
    }
    lines
}

fn footer_limits(app: &App) -> String {
    app.capabilities.as_ref().map_or_else(String::new, |caps| {
        caps.provider_limits
            .iter()
            .map(|p| {
                let values = if p.status == "ready" {
                    p.windows
                        .iter()
                        .map(|w| format!("{} {}%", limit_label(w.duration_mins), w.used_percent))
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    "—".into()
                };
                format!(" {} {} ", p.id.label(), values)
            })
            .collect::<Vec<_>>()
            .join("·")
    })
}

pub fn fullscreen_handle_area(_app: &App, footer: Rect) -> Rect {
    if footer.width < 3 {
        return Rect::default();
    }
    let width = footer.width.min(14);
    Rect::new(
        footer.right() - width,
        footer.bottom().saturating_sub(1),
        width,
        1,
    )
}

pub fn render(frame: &mut Frame, app: &App, logo_frame: usize) {
    render_workspace(frame, app, logo_frame);
    crate::toolbox::render(frame, app);
    if let Some(selection) = &app.selection {
        selection.render(frame.buffer_mut(), app.theme.selection());
    }
    if let Some((message, _)) = &app.toast {
        let area = geometry(frame.area(), app).footer;
        frame.render_widget(
            Paragraph::new(format!(" {message} ")).style(Style::default().fg(TEXT).bg(SURFACE)),
            area,
        );
    }
}

fn render_workspace(frame: &mut Frame, app: &App, logo_frame: usize) {
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
        crate::review::render(frame, app, geometry(area, app).review);
        if let Some(dialog) = &app.dialog {
            render_dialog(frame, app, dialog);
        }
        ui_controls::render(frame, app);
        return;
    }
    let layout = geometry(area, app);
    if !immersive(app) {
        frame.render_widget(
            Block::default().style(Style::default().bg(SURFACE)),
            layout.sidebar_header,
        );
        frame.render_widget(
            Paragraph::new(" nesvo")
                .style(Style::default().fg(crate::theme::BRAND_MUTED).bg(SURFACE)),
            layout.sidebar_header,
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
    let usage = footer_limits(app);
    let usage_width =
        (Line::from(usage.as_str()).width() as u16).min(handle.x.saturating_sub(layout.footer.x));
    let text_width = if layout.footer.height > 1 {
        usize::from(layout.footer.width)
    } else {
        usize::from(
            handle
                .x
                .saturating_sub(layout.footer.x)
                .saturating_sub(usage_width),
        )
    };
    let (mode, hint) = if text_width < Line::from(full_mode).width() + 12 {
        match app.mode {
            Mode::Input => (" INPUT ", " Ctrl+Q NAV"),
            Mode::Navigate => (" MENU ", " Enter TYPE"),
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
    let navigating = app.mode == Mode::Navigate;
    frame.render_widget(
        Block::default().style(Style::default().bg(SURFACE)),
        layout.footer,
    );
    let mut spans = vec![
        Span::styled(
            mode,
            Style::default()
                .fg(if navigating { BACKGROUND } else { TEXT })
                .bg(if navigating {
                    app.theme.accent()
                } else {
                    BORDER
                })
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];
    spans.extend(shortcut_spans(&app.shortcuts.hints(hint)));
    spans.push(Span::styled(notice, Style::default().fg(WARNING)));
    frame.render_widget(
        Paragraph::new(Line::from(spans)),
        Rect::new(
            layout.footer.x,
            layout.footer.y,
            text_width as u16,
            layout.footer.height,
        ),
    );
    if usage_width > 0 {
        frame.render_widget(
            Paragraph::new(usage).style(Style::default().fg(MUTED)),
            Rect::new(handle.x - usage_width, handle.y, usage_width, 1),
        );
    }
    if !handle.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " z ",
                    Style::default()
                        .fg(TEXT)
                        .bg(BORDER)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(if app.fullscreen {
                    " full · on "
                } else {
                    " full · off "
                }),
            ]))
            .style(
                Style::default()
                    .fg(if app.fullscreen {
                        app.theme.accent()
                    } else {
                        MUTED
                    })
                    .bg(SURFACE),
            ),
            handle,
        );
    }
    crate::review::render(frame, app, geometry(area, app).review);
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
    frame.render_widget(
        Block::default().style(Style::default().bg(SURFACE)),
        tree_content(area),
    );
    let content = tree_content(area);
    let rows = app.tree();
    for (entry, index) in sidebar_entries(app, content) {
        let row = &rows[index];
        let selected = index == app.selected;
        let background = if selected && matches!(row.kind, RowKind::Session(_)) {
            app.theme.selection()
        } else {
            SURFACE
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
                        .style(Style::default().bg(crate::theme::BACKGROUND))
                        .block(Block::bordered().border_style(Style::default().fg(BORDER))),
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
                        Span::styled(" ", Style::default().fg(app.theme.accent())),
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
                let program = app.effective_program(session);
                frame.render_widget(
                    crate::session_row::SessionRow {
                        name: &session.name,
                        icon: program.icon(app.ascii_icons),
                        icon_color: program_color(program),
                        status: crate::session_row::status_label(session, program),
                        runtime: &session.runtime_label,
                        project: None,
                        indent: (row.depth.min(4) * 2) as u16,
                        query: "",
                        accent: app.theme.accent(),
                    },
                    entry,
                );
            }
        }
        if selected && app.mode == Mode::Navigate && app.dialog.is_none() && app.overlay.is_none() {
            // Highlight the entire selectable row, including provider and status.
            let highlight_start = entry.x;
            for y in entry.y..entry.bottom() {
                for x in highlight_start..entry.right() {
                    if let Some(cell) = frame.buffer_mut().cell_mut((x, y)) {
                        cell.set_bg(app.theme.selection());
                    }
                }
            }
            frame.render_widget(
                Block::default()
                    .borders(Borders::RIGHT)
                    .border_style(Style::default().fg(app.theme.accent())),
                Rect::new(area.right().saturating_sub(1), entry.y, 1, entry.height),
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
            } else if focused && app.mode == Mode::Navigate {
                "PREVIEW ONLY · Enter to type in session"
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
                .borders(Borders::RIGHT | Borders::BOTTOM)
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
    Span::raw(text)
        .styled_graphemes(Style::default())
        .take_while(|grapheme| {
            width += Span::raw(grapheme.symbol).width();
            width <= max_width
        })
        .map(|grapheme| grapheme.symbol)
        .collect()
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
        Some((Source::Screen | Source::Hook, State::Question | State::Blocked)) => WARNING,
        Some((Source::Process | Source::Screen | Source::Hook, State::Failed)) => DANGER,
        Some((Source::Process | Source::Screen | Source::Hook, State::Done)) => SUCCESS,
        Some((Source::Screen | Source::Hook, State::Working)) => theme.accent(),
        _ => MUTED,
    }
}

pub(crate) fn program_color(program: Program) -> Color {
    match program {
        Program::Shell => crate::theme::PROGRAM_TERMINAL,
        Program::Claude => crate::theme::PROGRAM_CLAUDE,
        Program::Gemini => crate::theme::PROGRAM_GEMINI,
        Program::Codex => crate::theme::PROGRAM_CODEX,
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
            Paragraph::new(format!(
                "{} sessions · {}",
                app.sessions.len(),
                if app.connected {
                    "Ready to work"
                } else {
                    "Connecting to host…"
                }
            ))
            .centered()
            .style(Style::default().fg(MUTED)),
            Rect::new(menu.x, menu.y + title_y, menu.width, 1),
        );
    }
    for index in 0..4 {
        let target = ui_controls::menu_action_area(area, index);
        if target.is_empty() {
            continue;
        }
        let selected = index == app.menu_selected;
        frame.render_widget(
            Block::bordered()
                .border_style(Style::default().fg(if selected {
                    let strength = 60 + app.menu_phase.abs_diff(20) * 2;
                    match app.theme.accent() {
                        Color::Rgb(r, g, b) => Color::Rgb(
                            (u16::from(r) * u16::from(strength) / 100) as u8,
                            (u16::from(g) * u16::from(strength) / 100) as u8,
                            (u16::from(b) * u16::from(strength) / 100) as u8,
                        ),
                        color => color,
                    }
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
                2 => "Settings",
                _ => "Keyboard shortcuts",
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
                format!("Theme: {}   Enter choose", app.theme.label()),
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
                    Paragraph::new("Theme: preview then apply. k: shortcuts")
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
        Dialog::Help => render_keyboard_help(frame, app, inner),
    }
}

fn render_keyboard_help(frame: &mut Frame, app: &App, area: Rect) {
    let pages: [&[(&str, &str)]; 3] = [
        &[
            ("Ctrl+Q", "Leave terminal input / navigate Nesvo"),
            ("↑ ↓", "Select session or group"),
            ("Enter", "Open selected session"),
            ("/  Ctrl+K", "Open command palette"),
            ("z", "Toggle full screen"),
            ("[ ]", "Resize sidebar; when diff is open, resize diff"),
            ("F6", "Previous session"),
            ("F7", "Next session needing attention"),
            ("F1  ?", "Main menu / keyboard help"),
        ],
        &[
            ("n  g", "New session / group"),
            ("r  m  d", "Rename / move / delete"),
            ("f  u", "Filter status / mute attention"),
            ("F8  F9", "Templates / restore sessions"),
            ("S", "Scheduled sessions"),
            ("F2 / F3", "New session: options / save template"),
            ("v  Tab", "Split / change pane"),
            ("i  t  x", "Type / take control / release"),
        ],
        &[
            ("F4", "Toggle diff (preserves sidebar)"),
            ("↑ ↓ / ← →", "Diff: select file / hunk"),
            ("Space", "Diff: fold selected hunk"),
            ("e  s", "Diff: expand / side-by-side"),
            ("PgUp PgDn", "Scroll review or terminal history"),
            ("Esc", "Close diff / cancel dialog"),
            ("Ctrl+Q → z", "Toggle full screen from terminal input"),
            ("Settings → k", "Customize global function keys"),
        ],
    ];
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                " NAVIGATION ",
                Style::default().fg(if app.help_page == 0 {
                    app.theme.accent()
                } else {
                    MUTED
                }),
            ),
            Span::styled(
                " SESSIONS ",
                Style::default().fg(if app.help_page == 1 {
                    app.theme.accent()
                } else {
                    MUTED
                }),
            ),
            Span::styled(
                " REVIEW ",
                Style::default().fg(if app.help_page == 2 {
                    app.theme.accent()
                } else {
                    MUTED
                }),
            ),
        ]),
        Line::from(""),
    ];
    for (key, description) in pages[app.help_page % 3] {
        let mut keys = shortcut_spans(&app.shortcuts.hints(key));
        let width = Line::from(keys.clone()).width();
        keys.push(Span::raw(" ".repeat(22usize.saturating_sub(width).max(1))));
        keys.push(Span::styled(*description, Style::default().fg(TEXT)));
        lines.push(Line::from(keys));
        if area.height >= 23 {
            lines.push(Line::from(""));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::styled(
        " ← → sections · Tab close button · Esc back",
        Style::default().fg(MUTED),
    ));
    lines.push(Line::styled(
        " In terminal input, Esc and Ctrl+C go to the session.",
        Style::default().fg(MUTED),
    ));
    frame.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    #[test]
    fn compact_text_header_only_uses_one_sidebar_row() {
        let app = App::new(1);
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let layout = geometry(Rect::new(0, 0, width, height), &app);
            assert_eq!(layout.header.height, 1);
            assert_eq!(layout.panes[0].y, 1);
            assert_eq!(layout.sidebar_header.height, 1);
            assert_eq!(layout.tree.y, 1);
            assert_eq!(layout.sidebar_header.right(), layout.panes[0].x);
        }
    }

    #[test]
    fn diff_preserves_workspace_sidebar_and_fullscreen_visibility() {
        let mut app = App::new(1);
        app.dialog = None;
        app.mode = Mode::Input;
        app.fullscreen = false;
        let area = Rect::new(0, 0, 150, 44);
        let before = geometry(area, &app).tree;
        app.review.visible = true;
        app.review.return_to_input = true;
        app.review.focused = true;
        app.mode = Mode::Navigate;
        assert_eq!(geometry(area, &app).tree, before);
        assert!(geometry(area, &app).review.width > 0);
        app.fullscreen = true;
        assert_eq!(geometry(area, &app).tree.width, 0);
        assert!(geometry(area, &app).review.width > 0);
    }

    #[test]
    fn keyboard_reference_fits_small_terminal() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Help);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("Toggle full screen"));
        assert!(text.contains("Tab close button"));
    }

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
        let panel_y = geometry(area, &app).footer.bottom() - 1;
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let text = (0..area.width)
            .map(|x| terminal.backend().buffer()[(x, panel_y)].symbol())
            .collect::<String>();
        let all: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(!all.contains("LIMITS · USED"));
        assert_eq!(all.matches("Codex").count(), 1);
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
            .map(|x| terminal.backend().buffer()[(x, tree.y + 1)].symbol())
            .collect::<String>();
        assert!(heading.contains("Search sessions"));
        app.dialog = Some(Dialog::QuickSwitch {
            query: "docs".into(),
            selected: 0,
        });
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let palette = crate::ui_palette::for_app(area, &app);
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
    fn unclassified_shell_is_shown_as_a_terminal() {
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
        assert_eq!(session.status.as_ref().unwrap().state, State::Unknown);
        assert_eq!(
            crate::session_row::status_label(session, app.effective_program(session)).text,
            "terminal"
        );
        let area = Rect::new(0, 0, 100, 24);
        let layout = geometry(area, &app);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let line: String = (layout.tree.x..layout.tree.right())
            .map(|x| buffer[(x, layout.tree.y + 3)].symbol())
            .collect();
        assert!(
            line.contains("Claude task") && line.contains("terminal"),
            "{line}"
        );
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
        assert_eq!(
            crate::session_row::status_label(
                &app.sessions[0],
                app.effective_program(&app.sessions[0])
            )
            .text,
            "unknown"
        );
        assert_eq!(status_color(Some(status), app.theme), MUTED);
        let area = Rect::new(0, 0, 100, 30);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let tree = tree_content(geometry(area, &app).tree);
        let row: String = (tree.x..tree.right())
            .map(|x| terminal.backend().buffer()[(x, tree.y + 3)].symbol())
            .collect();
        assert!(row.contains("unknown"), "{row}");
        app.sessions[0].status = Some(Status {
            state: State::Working,
            source: Source::Screen,
            _updated_at: 2,
        });
        assert_eq!(
            crate::session_row::status_label(
                &app.sessions[0],
                app.effective_program(&app.sessions[0])
            )
            .text,
            "~working"
        );
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
            .map(|x| buffer[(x, layout.tree.y + 1)].symbol())
            .collect();
        assert!(sidebar.contains("sessions"), "{sidebar}");
        assert_eq!(
            buffer[(layout.tree.x, layout.tree.y + 3)].fg,
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
        assert_eq!(agent.height, 1);
        let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        let buffer = terminal.backend().buffer();
        let line = |y| {
            (tree.x..tree.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        };
        assert!(line(tree.y + 1).contains("sessions"));
        assert!(line(group.y).contains("Workspace"));
        assert!(!line(group.y).contains('▣'));
        assert!(line(agent.y).contains("~needs you"));
        assert!(line(agent.y).contains("✳"));
        app.selected = agent_index;
        app.mode = Mode::Navigate;
        terminal.draw(|frame| render(frame, &app, 0)).unwrap();
        for y in agent.y..agent.bottom() {
            for x in agent.x..agent.right() {
                assert_eq!(
                    terminal.backend().buffer()[(x, y)].bg,
                    app.theme.selection()
                );
            }
        }
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
        assert_eq!(buffer[(tree.x + 1, group_y)].bg, app.theme.selection());
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
        assert!(
            footer.contains("Ctrl+Q") && footer.contains("menu"),
            "{footer}"
        );
        assert!(footer.contains(" z "), "{footer}");
        let handle = fullscreen_handle_area(&app, layout.footer);
        assert_eq!(buffer[(handle.x, handle.y)].bg, BORDER);
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
