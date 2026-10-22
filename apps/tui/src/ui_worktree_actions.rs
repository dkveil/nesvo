use crate::{
    model::App,
    session_row::StatusLabel,
    theme::{BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
    ui::{shortcut_spans, truncate_cells},
    worktree_actions::{
        self, APPROVAL_HINT, Action, Actions, Notice, Page, Record, SetupCheck, Tone, supported,
    },
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};

fn color(tone: Tone) -> Color {
    match tone {
        Tone::Muted => MUTED,
        Tone::Success => SUCCESS,
        Tone::Warning => WARNING,
        Tone::Danger => DANGER,
    }
}

pub fn badge(app: &App, session_id: &str) -> Option<StatusLabel> {
    app.worktrees.stage(session_id).map(|stage| StatusLabel {
        text: stage.short(),
        color: color(stage.tone()),
    })
}

pub fn area(size: Rect) -> Rect {
    let width = 96.min(size.width.saturating_sub(4)).max(1);
    let height = 20.min(size.height.saturating_sub(2)).max(1);
    Rect::new(
        size.x + size.width.saturating_sub(width) / 2,
        size.y + size.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn body(size: Rect) -> Rect {
    let inner = Block::bordered().inner(area(size));
    Rect::new(
        inner.x + 2.min(inner.width),
        inner.y,
        inner.width.saturating_sub(4),
        inner.height,
    )
}

fn line(frame: &mut Frame, area: Rect, offset: u16, text: Line<'_>, style: Style) {
    if offset < area.height {
        frame.render_widget(
            Paragraph::new(text).style(style),
            Rect::new(area.x, area.y + offset, area.width, 1),
        );
    }
}

fn plain(frame: &mut Frame, area: Rect, offset: u16, text: &str, style: Style) {
    let text = truncate_cells(text, usize::from(area.width));
    line(frame, area, offset, Line::from(text), style);
}

fn tail(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        return text.to_owned();
    }
    let keep = width.saturating_sub(1);
    let start: String = text.chars().skip(count - keep).collect();
    format!("…{start}")
}

fn session_name(app: &App, dialog: &Actions) -> String {
    app.session(&dialog.session_id).map_or_else(
        || {
            let short: String = dialog.session_id.chars().take(8).collect();
            format!("Launch {short} (no process)")
        },
        |session| session.name.clone(),
    )
}

pub fn render(frame: &mut Frame, app: &App) {
    let Some(dialog) = app.worktrees.dialog.as_ref() else {
        return;
    };
    let size = frame.area();
    if !app.connected || size.width < 10 || size.height < 6 {
        return;
    }
    let outer = area(size);
    frame.render_widget(Clear, outer);
    frame.render_widget(
        Block::bordered()
            .style(Style::default().bg(SURFACE).fg(TEXT))
            .border_style(Style::default().fg(app.theme.accent())),
        outer,
    );
    let body = body(size);
    let acting = app.worktrees.acting_record(&dialog.session_id);
    let record = acting.as_ref();
    match &dialog.page {
        Page::Menu => render_menu(frame, app, dialog, record, body),
        Page::Confirm { typed, mismatch } => {
            render_confirm(frame, app, dialog, record, typed, *mismatch, body)
        }
        Page::Log {
            action,
            path,
            text,
            scroll,
        } => render_log(
            frame,
            app,
            action.label(),
            path,
            text.as_deref(),
            *scroll,
            body,
        ),
    }
}

fn heading(frame: &mut Frame, app: &App, body: Rect, title: &str) {
    let width = usize::from(body.width);
    plain(
        frame,
        body,
        0,
        &truncate_cells(title, width.saturating_sub(7)),
        Style::default()
            .fg(app.theme.accent())
            .add_modifier(Modifier::BOLD),
    );
    if body.width >= 12 {
        plain(
            frame,
            Rect::new(body.right() - 5, body.y, 5, body.height),
            0,
            "nesvo",
            Style::default().fg(MUTED),
        );
    }
    plain(
        frame,
        body,
        1,
        &"─".repeat(width),
        Style::default().fg(BORDER),
    );
}

fn footer(frame: &mut Frame, body: Rect, page: &Page) {
    if body.height > 0 {
        let hint = crate::key_table::line(worktree_actions::keys(page));
        line(
            frame,
            body,
            body.height - 1,
            Line::from(shortcut_spans(&hint)),
            Style::default(),
        );
    }
}

fn render_notice(frame: &mut Frame, dialog: &Actions, body: Rect, offset: u16) {
    if dialog.waiting() {
        plain(
            frame,
            body,
            offset,
            "Waiting for the host…",
            Style::default().fg(WARNING),
        );
        return;
    }
    match &dialog.notice {
        Some(Notice::Info(text)) => {
            plain(frame, body, offset, text, Style::default().fg(TEXT));
        }
        Some(Notice::Refused {
            code,
            message,
            blockers,
            hint,
        }) => {
            plain(
                frame,
                body,
                offset,
                &format!("Refused · {code}: {message}"),
                Style::default().fg(DANGER),
            );
            let mut next = offset + 1;
            if !blockers.is_empty() {
                plain(
                    frame,
                    body,
                    next,
                    &format!("Blockers: {}", blockers.join(", ")),
                    Style::default().fg(WARNING),
                );
                next += 1;
            }
            plain(frame, body, next, hint, Style::default().fg(MUTED));
        }
        None => {}
    }
}

fn render_menu(
    frame: &mut Frame,
    app: &App,
    dialog: &Actions,
    record: Option<&Record>,
    body: Rect,
) {
    let width = usize::from(body.width);
    heading(frame, app, body, "Worktree actions");
    let name = session_name(app, dialog);
    let mut spans = vec![
        Span::styled("Session  ", Style::default().fg(MUTED)),
        Span::styled(name, Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
    ];
    if let Some(record) = record {
        let stage = record.stage();
        spans.push(Span::styled(" · ", Style::default().fg(MUTED)));
        spans.push(Span::styled(
            stage.phrase(),
            Style::default().fg(color(stage.tone())),
        ));
    }
    line(frame, body, 2, Line::from(spans), Style::default());
    let detail = match record {
        Some(record) => format!(
            "Branch   {} · {}",
            record.branch.as_deref().unwrap_or("detached"),
            record.worktree
        ),
        None if app.worktrees.loaded => {
            "This session does not run in a host-created worktree.".to_owned()
        }
        None => "Loading the worktree registry…".to_owned(),
    };
    plain(frame, body, 3, &detail, Style::default().fg(MUTED));
    for (index, action) in Action::ALL.iter().enumerate() {
        let offset = 5 + index as u16;
        let selected = dialog.selected == index;
        let available = action.availability(record);
        let marker = if selected { "›" } else { " " };
        let label = format!("{marker} {}  {:<20}", index + 1, action.label());
        let reason = match available {
            Ok(()) => action.detail().to_owned(),
            Err(reason) => reason.to_owned(),
        };
        let background = if selected {
            app.theme.selection()
        } else {
            SURFACE
        };
        let label_width = Line::from(label.as_str()).width();
        let spans = vec![
            Span::styled(
                label,
                Style::default()
                    .fg(if available.is_ok() { TEXT } else { MUTED })
                    .add_modifier(if selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
            Span::styled(
                truncate_cells(&reason, width.saturating_sub(label_width)),
                Style::default().fg(if available.is_ok() { MUTED } else { BORDER }),
            ),
        ];
        line(
            frame,
            body,
            offset,
            Line::from(spans),
            Style::default().bg(background),
        );
    }
    render_notice(frame, dialog, body, 12);
    plain(
        frame,
        body,
        body.height.saturating_sub(3),
        APPROVAL_HINT,
        Style::default().fg(MUTED),
    );
    footer(frame, body, &dialog.page);
}

fn render_confirm(
    frame: &mut Frame,
    app: &App,
    dialog: &Actions,
    record: Option<&Record>,
    typed: &str,
    mismatch: bool,
    body: Rect,
) {
    let width = usize::from(body.width);
    heading(frame, app, body, "Discard and archive");
    let expected = record.map(Record::confirmation).unwrap_or_default();
    let worktree = record.map_or("", |record| record.worktree.as_str());
    plain(
        frame,
        body,
        2,
        &format!("Removes {}", tail(worktree, width.saturating_sub(8))),
        Style::default().fg(TEXT),
    );
    plain(
        frame,
        body,
        3,
        "and deletes its branch with any uncommitted or unpushed work.",
        Style::default().fg(WARNING),
    );
    plain(
        frame,
        body,
        5,
        "Type the branch name to confirm:",
        Style::default().fg(MUTED),
    );
    plain(
        frame,
        body,
        6,
        &format!("  {expected}"),
        Style::default()
            .fg(app.theme.accent())
            .add_modifier(Modifier::BOLD),
    );
    if body.height > 8 {
        let input = Rect::new(body.x, body.y + 8, body.width, 1);
        let visible = tail(typed, width.saturating_sub(4));
        frame.render_widget(
            Paragraph::new(format!("  {visible}"))
                .style(Style::default().fg(TEXT).bg(app.theme.selection())),
            input,
        );
        let cursor = 2 + Line::from(visible.as_str()).width();
        if cursor < width {
            frame.set_cursor_position((input.x + cursor as u16, input.y));
        }
    }
    if mismatch {
        plain(
            frame,
            body,
            9,
            "The text does not match the branch name.",
            Style::default().fg(DANGER),
        );
    }
    render_notice(frame, dialog, body, 11);
    footer(frame, body, &dialog.page);
}

fn render_log(
    frame: &mut Frame,
    app: &App,
    title: &str,
    path: &str,
    text: Option<&str>,
    scroll: usize,
    body: Rect,
) {
    let width = usize::from(body.width);
    heading(frame, app, body, title);
    plain(
        frame,
        body,
        2,
        &tail(path, width),
        Style::default().fg(MUTED),
    );
    let rows = usize::from(body.height.saturating_sub(5));
    match text {
        None => plain(
            frame,
            body,
            3,
            "Reading the log…",
            Style::default().fg(MUTED),
        ),
        Some("") => plain(
            frame,
            body,
            3,
            "The log is empty or could not be read.",
            Style::default().fg(MUTED),
        ),
        Some(text) => {
            let lines: Vec<&str> = text.lines().collect();
            let end = lines.len().saturating_sub(scroll);
            let start = end.saturating_sub(rows);
            for (index, entry) in lines[start..end].iter().enumerate() {
                plain(
                    frame,
                    body,
                    3 + index as u16,
                    entry,
                    Style::default().fg(TEXT),
                );
            }
        }
    }
    if let Some(dialog) = app.worktrees.dialog.as_ref()
        && matches!(dialog.notice, Some(Notice::Refused { .. }))
    {
        render_notice(frame, dialog, body, body.height.saturating_sub(4));
    }
    if let Some(dialog) = app.worktrees.dialog.as_ref() {
        footer(frame, body, &dialog.page);
    }
}

pub fn render_setup_check(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() || !supported(app) {
        return;
    }
    let Some(probe) = app.worktrees.probe.as_ref() else {
        return;
    };
    let (text, tone) = match &probe.check {
        SetupCheck::Checking => ("Checking nesvo.toml setup…".to_owned(), MUTED),
        SetupCheck::NotConfigured => (
            "No nesvo.toml here: a plain worktree without setup steps".to_owned(),
            MUTED,
        ),
        SetupCheck::Approved { digest } => (
            format!(
                "✓ Setup approved ({}); it runs before the agent starts",
                digest.chars().take(12).collect::<String>()
            ),
            SUCCESS,
        ),
        SetupCheck::Unapproved { digest } => (
            format!(
                "! Setup not approved: launch is refused. nesvo worktree approve-setup --directory {} --digest {digest}",
                probe.directory
            ),
            WARNING,
        ),
        SetupCheck::Failed(message) => (format!("Setup check: {message}"), DANGER),
    };
    frame.render_widget(
        Paragraph::new(truncate_cells(
            &format!("  {text}"),
            usize::from(area.width),
        ))
        .style(Style::default().fg(tone)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree_actions::tests::{app, load, record};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
    use serde_json::json;

    const SIZES: [(u16, u16); 3] = [(80, 24), (100, 32), (150, 44)];

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

    fn press(app: &mut App, code: KeyCode) -> Vec<serde_json::Value> {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 32),
        )
        .commands
    }

    fn reply(app: &mut App, command: &serde_json::Value, mut event: serde_json::Value) {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap();
    }

    #[test]
    fn worktree_dialog_lists_actions_and_the_cli_approval_hint_at_three_sizes() {
        let mut app = app();
        load(&mut app, vec![record("passed", Some("running"))]);
        press(&mut app, KeyCode::Char('K'));
        for (width, height) in SIZES {
            let buffer = draw(&app, width, height);
            let text = screen(&buffer);
            let popup = area(Rect::new(0, 0, width, height));
            assert!(popup.right() <= width && popup.bottom() <= height);
            for needle in [
                "Worktree actions",
                "Feature work · run in progress",
                "nesvo/0123456789abcdef",
                "1  Run steps",
                "a step is already running",
                "2  Cancel step",
                "4  Discard and archive",
                "5  Open setup log",
                "6  Open run log",
                APPROVAL_HINT,
                " Esc ",
            ] {
                assert!(text.contains(needle), "{width}x{height}: {needle}\n{text}");
            }
            let selected = (0..height)
                .find(|y| line(&buffer, *y).contains("› 1  Run steps"))
                .unwrap();
            assert_eq!(buffer[(popup.x + 3, selected)].bg, app.theme.selection());
        }
    }

    #[test]
    fn worktree_refusal_renders_the_code_blockers_and_hint() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        press(&mut app, KeyCode::Char('K'));
        let archive = press(&mut app, KeyCode::Char('3'));
        reply(
            &mut app,
            &archive[0],
            json!({"type":"error","code":"worktree_unsaved","message":"The worktree has unsaved work (dirty, unpushed); commit and push it, or pass discard explicitly"}),
        );
        for (width, height) in SIZES {
            let text = screen(&draw(&app, width, height));
            assert!(text.contains("Refused · worktree_unsaved"), "{text}");
            assert!(text.contains("Blockers: dirty, unpushed"), "{text}");
            assert!(
                text.contains("Commit and push the branch, or choose Discard and archive."),
                "{text}"
            );
        }
    }

    #[test]
    fn worktree_rows_and_pane_header_show_the_state_at_three_sizes() {
        let mut app = app();
        load(&mut app, vec![record("passed", Some("running"))]);
        for (width, height) in SIZES {
            let buffer = draw(&app, width, height);
            let tree = crate::ui::geometry(Rect::new(0, 0, width, height), &app).tree;
            let row = (tree.y..tree.bottom())
                .map(|y| {
                    (tree.x..tree.right())
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                })
                .find(|row| row.contains("Feat"))
                .unwrap_or_else(|| panic!("{width}x{height}\n{}", screen(&buffer)));
            assert!(row.contains("run…"), "{width}: {row}");
            assert!(row.contains("idle"), "{width}: {row}");
            let text = screen(&buffer);
            assert!(text.contains("worktree run in progress"), "{width}: {text}");
        }
        app.worktrees.records[0] = serde_json::from_value(record("timedOut", None)).unwrap();
        let text = screen(&draw(&app, 100, 32));
        assert!(text.contains("wt t/o"), "{text}");
        assert!(text.contains("worktree setup timed out"), "{text}");
    }

    #[test]
    fn worktree_new_session_form_shows_setup_approval_at_three_sizes() {
        let mut app = app();
        press(&mut app, KeyCode::Char('n'));
        press(&mut app, KeyCode::F(2));
        let probe = press(&mut app, KeyCode::Char(' '));
        for (width, height) in SIZES {
            assert!(screen(&draw(&app, width, height)).contains("Checking nesvo.toml setup"));
        }
        reply(
            &mut app,
            &probe[0],
            json!({"type":"worktreeSetup","repository":"C:/Projects/nesvo","configured":true,"config":{"setup":["npm ci"],"run":[],"envFiles":[],"timeoutS":600},"digest":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","approved":false,"policy":"platform-shell-v1"}),
        );
        for (width, height) in SIZES {
            let text = screen(&draw(&app, width, height));
            assert!(
                text.contains("! Setup not approved: launch is refused"),
                "{width}x{height}\n{text}"
            );
        }
        app.worktrees.probe.as_mut().unwrap().check = SetupCheck::Approved {
            digest: "0f1e2d3c4b5a69788796".into(),
        };
        assert!(screen(&draw(&app, 100, 32)).contains("✓ Setup approved (0f1e2d3c4b5a)"));
    }

    #[test]
    fn worktree_log_page_shows_the_tail_and_scrolls_back() {
        let mut app = app();
        load(&mut app, vec![record("failed", None)]);
        press(&mut app, KeyCode::Char('K'));
        let read = press(&mut app, KeyCode::Char('5'));
        assert!(screen(&draw(&app, 80, 24)).contains("Reading the log…"));
        let text: String = (1..=40).map(|n| format!("step line {n}\n")).collect();
        reply(
            &mut app,
            &read[0],
            json!({"type":"file","path":"p","size":400,"offset":0,"length":400,"text":text,"truncated":false,"encoding":"utf8"}),
        );
        for (width, height) in SIZES {
            let screen = screen(&draw(&app, width, height));
            assert!(screen.contains("Open setup log"), "{screen}");
            assert!(screen.contains("step line 40"), "{screen}");
            assert!(!screen.contains("step line 1\n"), "{screen}");
        }
        press(&mut app, KeyCode::PageUp);
        let screen = screen(&draw(&app, 80, 24));
        assert!(screen.contains("step line 30"), "{screen}");
        assert!(!screen.contains("step line 40"), "{screen}");
    }
}
