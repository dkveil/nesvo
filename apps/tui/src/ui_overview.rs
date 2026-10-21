use crate::{
    model::App,
    overview::{self, Flag, Row, Wake},
    theme::{BACKGROUND, BORDER, DANGER, MUTED, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::{Constraint, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row as TableRow, Table, TableState},
};

#[derive(Clone, Copy)]
struct Columns {
    group: bool,
    source: bool,
    quiet: bool,
    age: bool,
    repository: bool,
    wake: bool,
}

impl Columns {
    fn fit(app: &App, width: u16) -> Self {
        Self {
            group: width >= 64,
            source: width >= 44,
            quiet: width >= 44,
            age: width >= 96,
            repository: width >= 96,
            wake: overview::wake_supported(app) && width >= 56,
        }
    }
}

fn line(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

pub fn render(frame: &mut Frame, app: &App) {
    let layout = crate::ui::geometry(frame.area(), app);
    if app.overview.open {
        let screen = frame.area();
        let area = Rect::new(
            screen.x,
            screen.y,
            screen.width,
            layout.footer.y.saturating_sub(screen.y),
        );
        frame.render_widget(Clear, area);
        frame.render_widget(
            Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
            area,
        );
        let horizontal = 1.min(area.width / 2);
        let content = Rect::new(
            area.x + horizontal,
            area.y,
            area.width - 2 * horizontal,
            area.height,
        );
        heading(frame, app, content);
        let body = Rect::new(
            content.x,
            content.y + content.height.min(3),
            content.width,
            content.height.saturating_sub(3),
        );
        table(frame, app, body, true);
    }
    footer(frame, app, layout.footer);
}

pub fn render_leaf(frame: &mut Frame, app: &App, area: Rect) {
    table(frame, app, area, app.overview.focused);
}

fn heading(frame: &mut Frame, app: &App, area: Rect) {
    let rows = overview::rows(app);
    let waiting = rows
        .iter()
        .filter(|row| matches!(row.flag, Flag::Attention(_)))
        .count();
    let mut summary = format!(
        "  {} of {} sessions · {waiting} need you",
        rows.len(),
        app.sessions.len()
    );
    if !app.status_filters.is_empty() {
        summary.push_str(" · status filter on");
    }
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                "Overview",
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(summary, Style::default().fg(MUTED)),
        ])),
        line(area, 0),
    );
    let search = if app.overview.editing {
        Line::from(vec![
            Span::styled("/ ", Style::default().fg(app.theme.accent())),
            Span::styled(
                format!("{}▏", app.overview.query),
                Style::default().fg(TEXT),
            ),
        ])
    } else if app.overview.query.is_empty() {
        Line::styled(
            "Attention first, then most recent activity",
            Style::default().fg(app.theme.accent()),
        )
    } else {
        Line::from(vec![
            Span::styled("/ ", Style::default().fg(MUTED)),
            Span::styled(app.overview.query.clone(), Style::default().fg(TEXT)),
        ])
    };
    frame.render_widget(Paragraph::new(search), line(area, 1));
    let rule = line(area, 2);
    if !rule.is_empty() {
        frame.render_widget(
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(BORDER)),
            rule,
        );
    }
}

fn flag_cell(app: &App, flag: Flag) -> Cell<'static> {
    match flag {
        Flag::Clear => Cell::from(" "),
        Flag::Unread => Cell::from("•").style(Style::default().fg(app.theme.accent())),
        Flag::Attention(1) => Cell::from("!").style(Style::default().fg(DANGER)),
        Flag::Attention(_) => Cell::from("!").style(Style::default().fg(WARNING)),
    }
}

fn wake_color(app: &App, wake: Wake) -> Color {
    match wake {
        Wake::Armed => app.theme.accent(),
        Wake::Offered | Wake::Limited => WARNING,
        Wake::Unsupported | Wake::Idle => MUTED,
    }
}

fn body_row(app: &App, row: &Row<'_>, columns: Columns) -> TableRow<'static> {
    let muted = Style::default().fg(MUTED);
    let name = if row.faded() {
        muted
    } else {
        Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
    };
    let mut cells = vec![
        flag_cell(app, row.flag),
        Cell::from(row.program.icon(app.ascii_icons))
            .style(Style::default().fg(crate::ui::program_color(row.program))),
        Cell::from(row.session.name.clone()).style(name),
    ];
    if columns.group {
        cells.push(Cell::from(row.group.clone()).style(muted));
    }
    cells.push(Cell::from(row.status.text).style(Style::default().fg(row.status.color)));
    if columns.source {
        cells.push(Cell::from(row.source).style(muted));
    }
    if columns.quiet {
        cells.push(Cell::from(row.quiet_label()).style(muted));
    }
    if columns.age {
        cells.push(Cell::from(row.session.runtime_label.clone()).style(muted));
    }
    if columns.repository {
        cells.push(Cell::from(row.repository.clone()).style(muted));
    }
    if columns.wake {
        cells.push(
            Cell::from(row.wake.label()).style(Style::default().fg(wake_color(app, row.wake))),
        );
    }
    TableRow::new(cells)
}

fn layout(columns: Columns) -> (Vec<Constraint>, Vec<&'static str>) {
    let mut widths = vec![
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(2),
    ];
    let mut titles = vec!["", "", "Session"];
    let mut add = |enabled: bool, width: Constraint, title: &'static str| {
        if enabled {
            widths.push(width);
            titles.push(title);
        }
    };
    add(columns.group, Constraint::Length(14), "Group");
    add(true, Constraint::Length(10), "Status");
    add(columns.source, Constraint::Length(7), "Source");
    add(columns.quiet, Constraint::Length(8), "Last out");
    add(columns.age, Constraint::Length(6), "Age");
    add(columns.repository, Constraint::Fill(1), "Repository");
    add(columns.wake, Constraint::Length(5), "Wake");
    (widths, titles)
}

fn table(frame: &mut Frame, app: &App, area: Rect, highlight: bool) {
    if area.is_empty() {
        return;
    }
    let rows = overview::rows(app);
    if rows.is_empty() {
        let message = if app.sessions.is_empty() {
            "No sessions on this host yet. Esc, then n starts one."
        } else {
            "No sessions match the filters. f changes status filters, / edits the text filter."
        };
        frame.render_widget(
            Paragraph::new(message)
                .style(Style::default().fg(MUTED))
                .wrap(ratatui::widgets::Wrap { trim: true }),
            area,
        );
        return;
    }
    let columns = Columns::fit(app, area.width);
    let (widths, titles) = layout(columns);
    let header =
        TableRow::new(titles).style(Style::default().fg(MUTED).add_modifier(Modifier::BOLD));
    let body: Vec<_> = rows.iter().map(|row| body_row(app, row, columns)).collect();
    let table = Table::new(body, widths)
        .header(header)
        .column_spacing(1)
        .row_highlight_style(Style::default().bg(app.theme.selection()));
    let mut state = TableState::default()
        .with_selected(highlight.then(|| overview::selected_index(app, &rows)));
    frame.render_stateful_widget(table, area, &mut state);
}

fn footer(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }
    let mut hints: Vec<(&str, &str)> = if app.overview.editing {
        vec![("type", "filter"), ("Enter", "keep"), ("Esc", "clear")]
    } else {
        let mut hints = vec![("↑↓", "select"), ("Enter", "jump")];
        if overview::wake_supported(app) {
            hints.push(("w", "wake"));
        }
        hints.extend([("f", "filter"), ("/", "search"), ("Esc", "close")]);
        hints
    };
    let width = |hints: &[(&str, &str)]| {
        12 + hints
            .iter()
            .map(|(key, label)| Line::from(format!(" {key}  {label}  ")).width())
            .sum::<usize>()
    };
    while hints.len() > 1 && width(&hints) > usize::from(area.width) {
        hints.remove(0);
    }
    let mut spans = vec![
        Span::styled(
            " OVERVIEW ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];
    for (key, label) in hints {
        spans.push(Span::styled(
            format!(" {key} "),
            Style::default()
                .fg(TEXT)
                .bg(BORDER)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {label}  "),
            Style::default().fg(MUTED),
        ));
    }
    let used = Line::from(spans.clone()).width();
    if !app.notice.is_empty() && usize::from(area.width) > used + 4 {
        spans.push(Span::styled(
            crate::ui::truncate_cells(&app.notice, usize::from(area.width) - used),
            Style::default().fg(WARNING),
        ));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(crate::theme::SURFACE)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        layouts::{Direction, PaneTree, Role},
        overview::tests::app,
    };
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};

    fn draw(app: &App, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    fn text_line(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect()
    }

    fn screen(buffer: &Buffer) -> String {
        (0..buffer.area.height)
            .map(|y| text_line(buffer, y))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn row_of(buffer: &Buffer, needle: &str) -> Option<u16> {
        (0..buffer.area.height).find(|y| text_line(buffer, *y).contains(needle))
    }

    #[test]
    fn overview_renders_full_view_at_three_sizes() {
        let mut app = app();
        app.overview.open = true;
        for (width, height, wide) in [(80, 24, false), (100, 32, true), (150, 44, true)] {
            let buffer = draw(&app, width, height);
            let text = screen(&buffer);
            assert!(text.contains("Overview"), "{width}x{height}\n{text}");
            assert!(text.contains("5 of 5 sessions · 1 need you"), "{text}");
            assert!(text.contains("Status") && text.contains("Source"), "{text}");
            assert!(text.contains("Last out") && text.contains("Wake"), "{text}");
            assert_eq!(
                text.contains("Repository"),
                wide,
                "{width}x{height}\n{text}"
            );
            assert_eq!(text.contains("nesvo (main)"), wide, "{text}");
            assert!(text.contains(" OVERVIEW "), "{text}");
            assert!(text.contains(" Esc  close"), "{text}");
            let ask = row_of(&buffer, "Needs answer").unwrap();
            let busy = row_of(&buffer, "Busy builder").unwrap();
            let old = row_of(&buffer, "Old shell").unwrap();
            assert!(ask < busy && busy < old, "{text}");
            let ask_line = text_line(&buffer, ask);
            assert!(
                ask_line.contains('!') && ask_line.contains("program"),
                "{ask_line}"
            );
            assert!(text_line(&buffer, busy).contains("offer"), "{text}");
            assert!(text_line(&buffer, busy).contains("now"), "{text}");
            assert_eq!(
                buffer[(2, ask)].bg,
                app.theme.selection(),
                "selected row is highlighted"
            );
            for y in 0..height {
                assert_eq!(text_line(&buffer, y).chars().count(), usize::from(width));
            }
        }
    }

    #[test]
    fn overview_full_view_keeps_confirm_dialog_on_top() {
        let mut app = app();
        app.overview.open = true;
        let session = app.session("wake").unwrap();
        app.dialog = Some(crate::overview::wake_confirm(session));
        let text = screen(&draw(&app, 100, 32));
        assert!(text.contains("Disable automatic wake?"), "{text}");
        assert!(text.contains("Overview"), "{text}");
    }

    #[test]
    fn overview_renders_inside_a_layout_leaf() {
        let mut app = app();
        app.set_pane_layout(PaneTree::split(
            Direction::Horizontal,
            PaneTree::leaf(Role::Agent),
            PaneTree::leaf(Role::Overview),
        ));
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let buffer = draw(&app, width, height);
            let text = screen(&buffer);
            assert!(
                text.contains("Session") && text.contains("Status"),
                "{width}x{height}\n{text}"
            );
            assert!(text.contains("Needs"), "{text}");
            assert!(!text.contains("Repository"), "{text}");
            assert!(!text.contains(" OVERVIEW "), "{text}");
        }
        app.overview.focused = true;
        let buffer = draw(&app, 150, 44);
        let text = screen(&buffer);
        assert!(text.contains(" OVERVIEW "), "{text}");
        let ask = row_of(&buffer, "Needs answer").unwrap();
        let column = text_line(&buffer, ask).find("Needs answer").unwrap();
        let x = text_line(&buffer, ask)[..column].chars().count() as u16;
        assert_eq!(buffer[(x, ask)].bg, app.theme.selection());
    }

    #[test]
    fn overview_shows_search_and_empty_states() {
        let mut app = app();
        app.overview.open = true;
        app.overview.editing = true;
        app.overview.query = "zzz".into();
        let text = screen(&draw(&app, 80, 24));
        assert!(text.contains("/ zzz▏"), "{text}");
        assert!(text.contains("No sessions match the filters"), "{text}");
        assert!(text.contains(" Esc  clear"), "{text}");
    }
}
