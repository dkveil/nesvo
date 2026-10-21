use crate::{
    jobs::{Definition, FormField, Jobs, Load, Page},
    model::App,
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

const SUBTITLE: &str = "Host jobs · run without an open client";

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn inset(area: Rect, horizontal: u16, vertical: u16) -> Rect {
    let x = horizontal.min(area.width / 2);
    let y = vertical.min(area.height / 2);
    Rect::new(
        area.x + x,
        area.y + y,
        area.width - 2 * x,
        area.height - 2 * y,
    )
}

fn below(area: Rect, offset: u16, limit: u16) -> Rect {
    Rect::new(
        area.x,
        area.y + offset.min(area.height),
        area.width,
        area.height.saturating_sub(offset).min(limit),
    )
}

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(value.to_owned()).style(Style::default().fg(color)),
            area,
        );
    }
}

fn wrapped(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(value.to_owned())
                .style(Style::default().fg(color))
                .wrap(Wrap { trim: true }),
            area,
        );
    }
}

fn rule(frame: &mut Frame, area: Rect) {
    if !area.is_empty() {
        frame.render_widget(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(BORDER)),
            area,
        );
    }
}

fn section(frame: &mut Frame, area: Rect, title: &str) {
    text(frame, area, title, MUTED);
}

fn pair(frame: &mut Frame, area: Rect, label: &str, value: &str, color: Color) {
    if area.is_empty() {
        return;
    }
    let label_width = if area.width >= 62 { 18 } else { 12 }.min(area.width);
    text(
        frame,
        Rect::new(area.x, area.y, label_width, area.height),
        label,
        MUTED,
    );
    text(
        frame,
        Rect::new(
            area.x + label_width,
            area.y,
            area.width - label_width,
            area.height,
        ),
        value,
        color,
    );
}

fn state_color(enabled: bool) -> Color {
    if enabled { SUCCESS } else { MUTED }
}

fn occurrence_color(state: &str) -> Color {
    match state {
        "succeeded" => SUCCESS,
        "failed" => DANGER,
        "canceled" | "skipped" => MUTED,
        _ => WARNING,
    }
}

pub fn surface(frame: &Frame, app: &App) -> (Rect, Rect) {
    let layout = crate::ui::geometry(frame.area(), app);
    let area = Rect::new(
        layout.tree.right(),
        frame.area().y,
        frame.area().right().saturating_sub(layout.tree.right()),
        layout.footer.y.saturating_sub(frame.area().y),
    );
    (area, layout.footer)
}

pub fn render(frame: &mut Frame, app: &App, jobs: &Jobs) {
    let (area, footer_area) = surface(frame, app);
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    let content = inset(area, 2, 0);
    let selected = jobs.selected_definition();
    let title = match (jobs.page, selected, &jobs.form) {
        (Page::Form, _, Some(form)) if form.target.is_some() => "Jobs / Edit job".to_owned(),
        (Page::Form, _, _) => "Jobs / New job".to_owned(),
        (Page::Detail | Page::History, Some(job), _) => format!("Jobs / {}", job.title),
        _ => "Jobs".to_owned(),
    };
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(content, 1),
    );
    text(frame, row(content, 2), SUBTITLE, app.theme.accent());
    rule(frame, row(content, 3));
    let body = Rect::new(
        content.x,
        content.y + content.height.min(5),
        content.width,
        content.height.saturating_sub(6),
    );
    match (&jobs.load, jobs.page) {
        (_, Page::Form) => form(frame, app, body, jobs),
        (Load::Loading, _) => {
            text(frame, row(body, 2), "Loading jobs from your host…", TEXT);
            text(
                frame,
                row(body, 4),
                "Session processes keep running.",
                MUTED,
            );
        }
        (Load::Failed(message), _) => {
            text(frame, row(body, 2), "Could not load jobs", DANGER);
            wrapped(frame, below(body, 4, 2), message, TEXT);
            wrapped(
                frame,
                below(body, 6, 3),
                "No changes were submitted. Reconnect to inspect the current state.",
                MUTED,
            );
        }
        (Load::Ready, Page::Definitions) => definitions(frame, app, body, jobs),
        (Load::Ready, Page::Detail) => detail(frame, app, body, jobs),
        (Load::Ready, Page::History) => history(frame, app, body, jobs),
    }
    footer(frame, app, footer_area, jobs);
}

fn definitions(frame: &mut Frame, app: &App, area: Rect, jobs: &Jobs) {
    let wide = area.width >= 96;
    let list_width = if wide { area.width * 3 / 5 } else { area.width };
    let list = Rect::new(area.x, area.y, list_width, area.height);
    section(
        frame,
        row(list, 0),
        &format!("DEFINITIONS  {}", jobs.definitions.len()),
    );
    let next_width = if list.width >= 54 { 19 } else { 12 }.min(list.width / 2);
    let visible = usize::from(list.height.saturating_sub(8).max(1));
    let first = jobs
        .selected_index()
        .unwrap_or(0)
        .saturating_sub(visible.saturating_sub(1));
    let shown = jobs.definitions.len().min(visible);
    for (offset, job) in jobs
        .definitions
        .iter()
        .skip(first)
        .take(visible)
        .enumerate()
    {
        let target = row(list, offset as u16 + 2);
        if target.is_empty() {
            break;
        }
        let selected = jobs.selected.as_deref() == Some(job.id.as_str());
        if selected {
            frame.render_widget(
                Block::default().style(Style::default().bg(app.theme.selection())),
                target,
            );
        }
        let name_width = list.width.saturating_sub(next_width + 2);
        let mark = if job.enabled { "●" } else { "○" };
        text(
            frame,
            Rect::new(target.x, target.y, name_width, 1),
            &format!(
                " {mark} {}",
                crate::ui::truncate_cells(&job.title, usize::from(name_width.saturating_sub(3)))
            ),
            TEXT,
        );
        frame.render_widget(
            Paragraph::new(job.next_label(jobs.now_ms))
                .right_aligned()
                .style(Style::default().fg(if selected { TEXT } else { MUTED })),
            Rect::new(
                target.right().saturating_sub(next_width + 1),
                target.y,
                next_width,
                1,
            ),
        );
    }
    if jobs.definitions.is_empty() {
        text(
            frame,
            row(list, 2),
            "No jobs yet. Press n to create one.",
            MUTED,
        );
    }
    text(
        frame,
        row(list, shown.max(1) as u16 + 5),
        "● enabled   ○ paused",
        MUTED,
    );
    let Some(selected) = jobs.selected_definition() else {
        return;
    };
    if !wide {
        let offset = shown as u16 + 8;
        section(frame, row(list, offset), "SELECTED DEFINITION");
        text(frame, row(list, offset + 2), &selected.title, TEXT);
        text(
            frame,
            row(list, offset + 3),
            &selected.summary(jobs.now_ms),
            MUTED,
        );
        text(
            frame,
            row(list, offset + 5),
            "Enter opens profile and history",
            MUTED,
        );
        return;
    }
    let preview = Rect::new(
        list.right() + 3,
        area.y,
        area.width.saturating_sub(list.width + 3),
        area.height,
    );
    frame.render_widget(
        Block::default()
            .borders(Borders::LEFT)
            .border_style(Style::default().fg(BORDER)),
        Rect::new(list.right() + 1, area.y, 1, area.height),
    );
    selected_preview(frame, preview, selected, jobs.now_ms);
}

fn selected_preview(frame: &mut Frame, area: Rect, job: &Definition, now_ms: i64) {
    section(frame, row(area, 0), "SELECTED DEFINITION");
    text(frame, row(area, 2), &job.title, TEXT);
    text(
        frame,
        row(area, 3),
        &format!("{} · {}", job.state_label(), job.schedule_kind_label()),
        state_color(job.enabled),
    );
    section(frame, row(area, 6), "NEXT START");
    text(frame, row(area, 7), &job.next_detail(now_ms), TEXT);
    section(frame, row(area, 10), "PROFILE");
    text(
        frame,
        row(area, 11),
        &job.program_label(),
        if job.spec.is_some() { TEXT } else { MUTED },
    );
    if job.spec.is_some() {
        text(
            frame,
            row(area, 12),
            &format!("{} workspace", job.workspace_label()),
            MUTED,
        );
    }
    section(frame, row(area, 15), "INSTRUCTION");
    if let Some(instruction) = job.instruction() {
        wrapped(frame, below(area, 17, 4), instruction, TEXT);
    }
    text(frame, row(area, 23), "Enter opens full details", MUTED);
}

fn tabs(frame: &mut Frame, app: &App, area: Rect, history: bool) {
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " Overview ",
                Style::default().fg(if history { MUTED } else { app.theme.accent() }),
            ),
            Span::raw("  "),
            Span::styled(
                " History ",
                Style::default().fg(if history { app.theme.accent() } else { MUTED }),
            ),
        ])),
        area,
    );
}

fn detail(frame: &mut Frame, app: &App, area: Rect, jobs: &Jobs) {
    tabs(frame, app, row(area, 0), false);
    let Some(job) = jobs.selected_definition() else {
        return;
    };
    let narrow = area.width < 62;
    pair(frame, row(area, 3), "Schedule", &job.schedule_label(), TEXT);
    pair(
        frame,
        row(area, 4),
        "Next start",
        &job.next_detail(jobs.now_ms),
        TEXT,
    );
    pair(
        frame,
        row(area, 5),
        "State",
        job.state_label(),
        state_color(job.enabled),
    );
    if job.spec.is_none() {
        text(frame, row(area, 7), "Loading details…", MUTED);
        return;
    }
    pair(frame, row(area, 7), "Agent", &job.program_label(), TEXT);
    pair(
        frame,
        row(area, 8),
        "Workspace",
        job.workspace_label(),
        TEXT,
    );
    pair(frame, row(area, 9), "Folder", &job.folder_label(), MUTED);
    let instruction = job.instruction().unwrap_or_default();
    if narrow {
        section(frame, row(area, 11), "INSTRUCTION");
        wrapped(frame, below(area, 12, 3), instruction, TEXT);
        return;
    }
    section(frame, row(area, 12), "INSTRUCTION");
    wrapped(frame, below(area, 14, 2), instruction, TEXT);
    rule(frame, row(area, 17));
    section(frame, row(area, 19), "EXECUTION POLICY");
    for (offset, (label, value, configured)) in job.policy().iter().enumerate() {
        pair(
            frame,
            row(area, 21 + offset as u16),
            label,
            value,
            if *configured { TEXT } else { MUTED },
        );
    }
    text(
        frame,
        row(area, 28),
        &format!(
            "Definition revision {} · edits affect future occurrences",
            job.revision
        ),
        MUTED,
    );
    text(
        frame,
        row(area, 30),
        "Disabling future starts does not stop an admitted occurrence.",
        MUTED,
    );
}

fn history(frame: &mut Frame, app: &App, area: Rect, jobs: &Jobs) {
    tabs(frame, app, row(area, 0), true);
    let offset = jobs.selected_definition().and_then(Definition::offset);
    let wide = area.width >= 70;
    let started_width = if wide { 23 } else { 15 }.min(area.width);
    let state_width = area.width.saturating_sub(started_width).min(24);
    let header = row(area, 3);
    if !header.is_empty() {
        text(
            frame,
            Rect::new(header.x, header.y, started_width, 1),
            "STARTED",
            MUTED,
        );
        text(
            frame,
            Rect::new(header.x + started_width, header.y, state_width, 1),
            "STATE",
            MUTED,
        );
    }
    if jobs.occurrences.is_empty() {
        let message = if jobs.history_loading {
            "Loading history…"
        } else {
            "No occurrences yet."
        };
        text(frame, row(area, 5), message, MUTED);
        return;
    }
    for (index, occurrence) in jobs.occurrences.iter().take(6).enumerate() {
        let target = row(area, index as u16 + 5);
        if target.is_empty() {
            break;
        }
        if jobs.occurrence.as_deref() == Some(occurrence.id.as_str()) {
            frame.render_widget(
                Block::default().style(Style::default().bg(app.theme.selection())),
                target,
            );
        }
        text(
            frame,
            Rect::new(target.x, target.y, started_width, 1),
            &occurrence.started(jobs.now_ms, offset),
            TEXT,
        );
        text(
            frame,
            Rect::new(target.x + started_width, target.y, state_width, 1),
            &occurrence.state,
            occurrence_color(&occurrence.state),
        );
        if wide {
            text(
                frame,
                Rect::new(
                    target.x + started_width + state_width,
                    target.y,
                    target.width.saturating_sub(started_width + state_width),
                    1,
                ),
                occurrence.reason_label(),
                MUTED,
            );
        }
    }
    let Some(selected) = jobs.selected_occurrence() else {
        return;
    };
    section(frame, row(area, 12), "SELECTED OCCURRENCE");
    pair(
        frame,
        row(area, 14),
        "Reason",
        selected.reason_label(),
        WARNING,
    );
    pair(frame, row(area, 15), "Run", &selected.run_label(), MUTED);
    pair(
        frame,
        row(area, 16),
        "Quota",
        &selected.quota_label(),
        if selected.waiting() { WARNING } else { MUTED },
    );
    text(
        frame,
        row(area, 19),
        "Cancellation is a request; it is not proof of process exit.",
        MUTED,
    );
    text(
        frame,
        row(area, 21),
        "A reported result still needs explicit validation.",
        MUTED,
    );
}

fn field(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    offset: u16,
    label: &str,
    value: &str,
    focused: bool,
) {
    section(frame, row(area, offset), label);
    let input = row(area, offset + 1);
    if input.is_empty() {
        return;
    }
    frame.render_widget(
        Paragraph::new(format!(" {value}")).style(Style::default().fg(TEXT).bg(if focused {
            app.theme.selection()
        } else {
            SURFACE
        })),
        input,
    );
}

fn form(frame: &mut Frame, app: &App, area: Rect, jobs: &Jobs) {
    let Some(draft) = &jobs.form else {
        return;
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Basics ", Style::default().fg(app.theme.accent())),
            Span::styled("   Advanced ", Style::default().fg(MUTED)),
        ])),
        row(area, 0),
    );
    let area = Rect::new(area.x, area.y, area.width.min(76), area.height);
    let focused = |field: FormField| draft.field == field;
    field(
        frame,
        app,
        area,
        3,
        "TITLE",
        &draft.title,
        focused(FormField::Title),
    );
    field(
        frame,
        app,
        area,
        6,
        "AGENT",
        draft.program.label(),
        focused(FormField::Agent),
    );
    field(
        frame,
        app,
        area,
        9,
        "FOLDER · shared workspace",
        &draft.folder,
        focused(FormField::Folder),
    );
    section(frame, row(area, 12), "INSTRUCTION");
    let prompt = below(area, 13, 3);
    if !prompt.is_empty() {
        frame.render_widget(
            Paragraph::new(format!(" {}", draft.instruction))
                .style(
                    Style::default()
                        .fg(TEXT)
                        .bg(if focused(FormField::Instruction) {
                            app.theme.selection()
                        } else {
                            SURFACE
                        }),
                )
                .wrap(Wrap { trim: false }),
            prompt,
        );
    }
    field(
        frame,
        app,
        area,
        18,
        "START · one time, explicit offset",
        &draft.start,
        focused(FormField::Start),
    );
    text(
        frame,
        row(area, 22),
        "Host must remain running. Provider consent can still be required.",
        MUTED,
    );
    text(
        frame,
        row(area, 25),
        "Advanced: recurrence, worktree, overlap, budget, precheck and quota.",
        MUTED,
    );
}

fn hints(jobs: &Jobs) -> Vec<(&'static str, &'static str)> {
    let paused = jobs.selected_definition().is_some_and(|job| !job.enabled);
    match (&jobs.load, jobs.page) {
        (_, Page::Form) => vec![("Tab", "field"), ("Enter", "save"), ("Esc", "discard")],
        (Load::Loading, _) => vec![("Esc", "back")],
        (Load::Failed(_), _) => vec![("r", "retry read"), ("Esc", "back")],
        (Load::Ready, Page::Definitions) => vec![
            ("↑↓", "select"),
            ("Enter", "details"),
            ("n", "new"),
            ("Esc", "back"),
        ],
        (Load::Ready, Page::Detail) => vec![
            ("e", "edit"),
            ("Space", if paused { "resume" } else { "pause" }),
            ("R", "run now"),
            ("h", "history"),
            ("Esc", "back"),
        ],
        (Load::Ready, Page::History) => vec![
            ("↑↓", "select"),
            ("Enter", "inspect"),
            ("c", "cancel occurrence"),
            ("Esc", "back"),
        ],
    }
}

fn footer(frame: &mut Frame, app: &App, area: Rect, jobs: &Jobs) {
    if area.is_empty() {
        return;
    }
    let mut spans = vec![
        Span::styled(
            " JOBS ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];
    for (key, label) in hints(jobs) {
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
    let available = usize::from(area.width);
    if !app.notice.is_empty() && available > used + 4 {
        spans.push(Span::styled(
            crate::ui::truncate_cells(&format!("· {}", app.notice), available - used),
            Style::default().fg(WARNING),
        ));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{jobs::tests as fixtures, launch::Program};
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
    use serde_json::json;

    fn app(jobs: Jobs) -> App {
        let mut app = App::new(71);
        app.event(json!({
            "type":"capabilities", "workspace":"C:/Projects/nesvo", "programs":[
                {"id":"claude","available":true}, {"id":"codex","available":true}
            ]
        }))
        .unwrap();
        app.event(json!({"type":"sessions", "revision":1, "groups":[
            {"id":"g","name":"nesvo","parentId":null,"order":0}
        ], "sessions":[
            {"id":"s1","name":"Review navigation","cwd":"C:/Projects/nesvo","program":"claude","cols":100,"rows":40,"running":true,"groupId":"g","controllerId":null,"uptimeSeconds":720,"status":{"state":"idle","source":"hook","updatedAt":1}}
        ]}))
        .unwrap();
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app.jobs = Some(jobs);
        app
    }

    fn jobs(app: &mut App) -> &mut Jobs {
        app.jobs.as_mut().unwrap()
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
    fn wide_list_keeps_sidebar_and_shows_selected_definition_beside_the_list() {
        let app = app(fixtures::loaded());
        let buffer = draw(&app, 150, 44);
        let sidebar = crate::ui::geometry(Rect::new(0, 0, 150, 44), &app).tree;
        assert_eq!(sidebar.width, 42);
        assert!(screen(&buffer).contains("Review navigation"));
        assert_eq!(find(&buffer, "Jobs"), Some((44, 1)));
        assert!(line(&buffer, 2).contains(SUBTITLE));
        assert_eq!(find(&buffer, "DEFINITIONS  4"), Some((44, 5)));
        let (_, daily) = find(&buffer, "● Daily review").unwrap();
        assert_eq!(daily, 7);
        assert_eq!(buffer[(46, daily)].bg, app.theme.selection());
        assert!(line(&buffer, daily).contains("Today 16:02"));
        assert!(line(&buffer, 8).contains("Tomorrow 00:00 UTC"));
        assert!(line(&buffer, 10).contains("○ Release notes"));
        assert!(line(&buffer, 10).contains("Paused"));
        assert!(line(&buffer, 14).contains("● enabled   ○ paused"));
        assert_eq!(find(&buffer, "SELECTED DEFINITION"), Some((109, 5)));
        assert!(line(&buffer, 8).contains("Enabled · one-time schedule"));
        assert_eq!(buffer[(109, 8)].fg, SUCCESS);
        assert!(line(&buffer, 12).contains("Today 16:02 · UTC+02:00"));
        assert!(line(&buffer, 16).contains("Claude"));
        assert!(line(&buffer, 17).contains("Shared workspace"));
        assert!(line(&buffer, 22).contains("Review changes and report findings."));
        assert!(line(&buffer, 28).contains("Enter opens full details"));
        let footer = line(&buffer, 43);
        assert!(footer.starts_with(" JOBS "));
        for hint in [
            " ↑↓ ", " select", " Enter ", " details", " n ", " new", " Esc ", " back",
        ] {
            assert!(footer.contains(hint), "{hint}");
        }
        assert_eq!(buffer[(0, 43)].bg, app.theme.accent());
    }

    #[test]
    fn compact_list_moves_selected_definition_below_the_rows() {
        let app = app(fixtures::loaded());
        let buffer = draw(&app, 80, 24);
        assert_eq!(
            crate::ui::geometry(Rect::new(0, 0, 80, 24), &app)
                .tree
                .width,
            32
        );
        assert_eq!(find(&buffer, "DEFINITIONS  4"), Some((34, 5)));
        assert!(line(&buffer, 7).contains("● Daily review"));
        assert!(line(&buffer, 14).contains("● enabled   ○ paused"));
        assert!(line(&buffer, 17).contains("SELECTED DEFINITION"));
        assert!(line(&buffer, 19).contains("Daily review"));
        assert!(line(&buffer, 20).contains("Once · today at 16:02"));
        assert!(line(&buffer, 23).starts_with(" JOBS "));
    }

    #[test]
    fn detail_overview_lists_profile_and_execution_policy_when_wide() {
        let mut app = app(fixtures::loaded());
        jobs(&mut app).page = Page::Detail;
        let buffer = draw(&app, 150, 44);
        assert!(line(&buffer, 1).contains("Jobs / Daily review"));
        assert_eq!(buffer[(46, 5)].fg, app.theme.accent());
        for (y, expected) in [
            (8, "Schedule          Once · 21 Oct, 16:02 +02:00"),
            (9, "Next start        Today 16:02 · UTC+02:00"),
            (10, "State             Enabled"),
            (12, "Agent             Claude"),
            (13, "Workspace         Shared"),
            (14, "Folder            C:/Projects/nesvo"),
            (17, "INSTRUCTION"),
            (
                19,
                "Review changes and report findings. Do not modify files.",
            ),
            (24, "EXECUTION POLICY"),
            (26, "Overlap           Queue a separate occurrence"),
            (27, "Run budget        5 minutes"),
            (28, "Native timeout    Not configured"),
            (29, "Retry             Off"),
            (30, "Quota wait        Off"),
            (
                33,
                "Definition revision 3 · edits affect future occurrences",
            ),
            (
                35,
                "Disabling future starts does not stop an admitted occurrence.",
            ),
        ] {
            assert!(line(&buffer, y).contains(expected), "{y}: {expected}");
        }
        let footer = line(&buffer, 43);
        for hint in [
            " e ", " edit", " Space ", " pause", " R ", " run now", " h ", " history",
        ] {
            assert!(footer.contains(hint), "{hint}");
        }
    }

    #[test]
    fn compact_detail_wraps_instruction_after_profile() {
        let mut app = app(fixtures::loaded());
        jobs(&mut app).page = Page::Detail;
        let buffer = draw(&app, 80, 24);
        assert!(line(&buffer, 8).contains("Schedule    Once · 21 Oct, 16:02 +02:00"));
        assert!(line(&buffer, 14).contains("Folder      C:/Projects/nesvo"));
        assert!(line(&buffer, 16).contains("INSTRUCTION"));
        assert!(line(&buffer, 17).contains("Review changes and report findings. Do not"));
        assert!(line(&buffer, 18).contains("modify files."));
        assert!(!screen(&buffer).contains("EXECUTION POLICY"));
    }

    #[test]
    fn history_tab_shows_occurrences_and_selected_details() {
        let mut app = app(fixtures::loaded());
        let features = fixtures::features();
        let history = jobs(&mut app).open_history(&features);
        jobs(&mut app).response(
            &features,
            &json!({"type":"workflow","requestId":history.commands[0]["requestId"],"occurrences":fixtures::occurrences()}),
            fixtures::NOW,
        );
        let buffer = draw(&app, 150, 44);
        assert_eq!(buffer[(57, 5)].fg, app.theme.accent());
        assert!(line(&buffer, 8).contains("STARTED                STATE"));
        let first = line(&buffer, 10);
        assert!(first.contains("Today 15:40            queued"));
        assert!(first.contains("quota_wait"));
        assert_eq!(buffer[(44, 10)].bg, app.theme.selection());
        assert!(line(&buffer, 11).contains("Yesterday 16:02        needsValidation"));
        assert!(line(&buffer, 12).contains("19 Oct 16:02           canceled"));
        assert_eq!(buffer[(67, 12)].fg, MUTED);
        assert!(line(&buffer, 17).contains("SELECTED OCCURRENCE"));
        assert!(line(&buffer, 19).contains("Reason            quota_wait"));
        assert!(line(&buffer, 20).contains("Run               Not allocated"));
        assert!(line(&buffer, 21).contains("Quota             Waiting · source_unavailable"));
        assert!(line(&buffer, 24).contains("Cancellation is a request"));
        let footer = line(&buffer, 43);
        assert!(footer.contains(" c ") && footer.contains(" cancel occurrence"));
    }

    #[test]
    fn form_highlights_the_focused_field_and_keeps_the_advanced_hint() {
        let mut app = app(fixtures::loaded());
        jobs(&mut app).new_form(vec![Program::Claude], "C:/Projects/nesvo".into());
        let form = jobs(&mut app).form.as_mut().unwrap();
        form.title = "Daily review".into();
        form.instruction = "Review changes and report findings. Do not modify files.".into();
        form.start = "2026-10-22 16:02 +02:00".into();
        let buffer = draw(&app, 150, 44);
        assert!(line(&buffer, 1).contains("Jobs / New job"));
        assert!(line(&buffer, 5).contains("Basics    Advanced"));
        assert!(line(&buffer, 8).contains("TITLE"));
        assert!(line(&buffer, 9).contains(" Daily review"));
        assert_eq!(buffer[(44, 9)].bg, app.theme.selection());
        assert_eq!(buffer[(119, 9)].bg, app.theme.selection());
        assert_eq!(buffer[(120, 9)].bg, BACKGROUND);
        assert!(line(&buffer, 12).contains(" Claude"));
        assert_eq!(buffer[(44, 12)].bg, SURFACE);
        assert!(line(&buffer, 14).contains("FOLDER · shared workspace"));
        assert!(line(&buffer, 18).contains("Review changes and report findings."));
        assert!(line(&buffer, 23).contains("START · one time, explicit offset"));
        assert!(line(&buffer, 24).contains("2026-10-22 16:02 +02:00"));
        assert!(line(&buffer, 27).contains("Host must remain running."));
        assert!(line(&buffer, 30).contains("Advanced: recurrence, worktree"));
        let footer = line(&buffer, 43);
        for hint in [" Tab ", " field", " Enter ", " save", " Esc ", " discard"] {
            assert!(footer.contains(hint), "{hint}");
        }
    }

    #[test]
    fn loading_and_error_states_keep_sidebar_and_offer_retry() {
        let features = fixtures::features();
        let (loading, list) = Jobs::open(71, &features, fixtures::NOW).unwrap();
        let mut app = app(loading);
        let buffer = draw(&app, 80, 24);
        assert!(line(&buffer, 7).contains("Loading jobs from your host…"));
        assert!(line(&buffer, 9).contains("Session processes keep running."));
        assert!(screen(&buffer).contains("Review"));
        assert!(line(&buffer, 23).contains(" Esc ") && !line(&buffer, 23).contains(" r "));
        jobs(&mut app).failure(
            &features,
            &json!({"type":"error","requestId":list["requestId"],"message":"The host connection was interrupted."}),
        );
        let buffer = draw(&app, 80, 24);
        assert!(line(&buffer, 7).contains("Could not load jobs"));
        assert_eq!(buffer[(34, 7)].fg, DANGER);
        assert!(line(&buffer, 9).contains("The host connection was interrupted."));
        assert!(line(&buffer, 11).contains("No changes were submitted."));
        assert!(line(&buffer, 23).contains(" r ") && line(&buffer, 23).contains(" retry read"));
    }

    #[test]
    fn layout_fits_the_intermediate_terminal_size() {
        let mut app = app(fixtures::loaded());
        assert_eq!(
            crate::ui::geometry(Rect::new(0, 0, 100, 32), &app)
                .tree
                .width,
            42
        );
        for page in [Page::Definitions, Page::Detail, Page::History] {
            jobs(&mut app).page = page;
            let buffer = draw(&app, 100, 32);
            assert!(line(&buffer, 31).starts_with(" JOBS "), "{page:?}");
            assert!(screen(&buffer).contains("Daily review"), "{page:?}");
        }
        jobs(&mut app).page = Page::Definitions;
        let buffer = draw(&app, 100, 32);
        assert!(line(&buffer, 17).contains("SELECTED DEFINITION"));
        assert!(line(&buffer, 22).contains("Enter opens profile and history"));
    }

    #[test]
    fn footer_appends_host_notice_and_sidebar_is_not_highlighted() {
        let mut app = app(fixtures::loaded());
        app.notice = "Future starts paused".into();
        app.selected = 2;
        let buffer = draw(&app, 150, 44);
        let footer = line(&buffer, 43);
        assert!(footer.contains(" Esc ") && footer.contains("· Future starts paused"));
        let (_, row) = find(&buffer, "Review navigation").unwrap();
        assert_ne!(buffer[(41, row)].fg, app.theme.accent());
        app.jobs = None;
        assert_eq!(draw(&app, 150, 44)[(41, row)].fg, app.theme.accent());
    }
}
