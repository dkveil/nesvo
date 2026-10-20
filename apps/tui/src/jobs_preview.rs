//! Jobs design review only. The pure surface composes with the real workspace
//! renderer; it has no runtime entry, transport, effects, or active shortcuts.
use crate::{
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

#[derive(Clone, Copy)]
enum Page {
    Definitions,
    Detail,
    History,
    Form,
    Loading,
    Error,
}

struct Definition<'a> {
    title: &'a str,
    enabled: bool,
    schedule: &'a str,
    next: &'a str,
}

struct Detail<'a> {
    title: &'a str,
    program: &'a str,
    directory: &'a str,
    instruction: &'a str,
    schedule: &'a str,
    next: &'a str,
    revision: u64,
}

struct Occurrence<'a> {
    started: &'a str,
    state: &'a str,
    reason: &'a str,
    run: &'a str,
    color: Color,
}

struct Draft<'a> {
    title: &'a str,
    program: &'a str,
    directory: &'a str,
    instruction: &'a str,
    start: &'a str,
}

struct View<'a> {
    page: Page,
    definitions: &'a [Definition<'a>],
    selected: usize,
    detail: &'a Detail<'a>,
    occurrences: &'a [Occurrence<'a>],
    draft: &'a Draft<'a>,
}

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

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(value.to_owned()).style(Style::default().fg(color)),
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
    frame.render_widget(
        Paragraph::new(title.to_owned()).style(Style::default().fg(MUTED)),
        area,
    );
}

fn pair(frame: &mut Frame, area: Rect, label: &str, value: &str, color: Color) {
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

/// Shares the production geometry and never changes the approved sidebar width.
fn render(frame: &mut Frame, app: &App, view: &View<'_>) {
    let layout = super::geometry(frame.area(), app);
    let area = Rect::new(
        layout.tree.right(),
        frame.area().y,
        frame.area().right().saturating_sub(layout.tree.right()),
        layout.footer.y.saturating_sub(frame.area().y),
    );
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    let content = inset(area, 2, 0);
    let title = match view.page {
        Page::Definitions | Page::Loading | Page::Error => "Jobs".to_owned(),
        Page::Detail | Page::History => format!("Jobs / {}", view.detail.title),
        Page::Form => "Jobs / New job".to_owned(),
    };
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(content, 1),
    );
    text(
        frame,
        row(content, 2),
        "DESIGN PREVIEW · example data",
        app.theme.accent(),
    );
    rule(frame, row(content, 3));
    let body = Rect::new(
        content.x,
        content.y + content.height.min(5),
        content.width,
        content.height.saturating_sub(6),
    );
    match view.page {
        Page::Definitions => definitions(frame, app, body, view),
        Page::Detail => detail(frame, app, body, view.detail),
        Page::History => history(frame, app, body, view),
        Page::Form => form(frame, app, body, view.draft),
        Page::Loading => {
            text(frame, row(body, 2), "Loading jobs from your host…", TEXT);
            text(
                frame,
                row(body, 4),
                "Session processes keep running.",
                MUTED,
            );
        }
        Page::Error => {
            text(frame, row(body, 2), "Could not load jobs", DANGER);
            text(
                frame,
                row(body, 4),
                "The host connection was interrupted.",
                TEXT,
            );
            frame.render_widget(
                Paragraph::new(
                    "No changes were submitted. Reconnect to inspect the current state.",
                )
                .style(Style::default().fg(MUTED))
                .wrap(Wrap { trim: true }),
                Rect::new(
                    body.x,
                    body.y + 6.min(body.height),
                    body.width,
                    body.height.saturating_sub(6).min(3),
                ),
            );
        }
    }
    footer(frame, app, layout.footer, view.page);
}

fn definitions(frame: &mut Frame, app: &App, area: Rect, view: &View<'_>) {
    let wide = area.width >= 96;
    let list_width = if wide { area.width * 3 / 5 } else { area.width };
    let list = Rect::new(area.x, area.y, list_width, area.height);
    let count = format!("DEFINITIONS  {}", view.definitions.len());
    section(frame, row(list, 0), &count);
    let next_width = if list.width >= 54 { 19 } else { 12 }.min(list.width / 2);
    for (index, job) in view.definitions.iter().enumerate() {
        let target = row(list, index as u16 + 2);
        if target.is_empty() {
            break;
        }
        let selected = index == view.selected;
        if selected {
            frame.render_widget(
                Block::default().style(Style::default().bg(app.theme.selection())),
                target,
            );
        }
        let name_width = list.width.saturating_sub(next_width + 2);
        let mark = if job.enabled { "●" } else { "○" };
        let name = format!(" {mark} {}", job.title);
        text(
            frame,
            Rect::new(target.x, target.y, name_width, 1),
            &name,
            TEXT,
        );
        frame.render_widget(
            Paragraph::new(job.next)
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
    text(
        frame,
        row(list, view.definitions.len() as u16 + 5),
        "● enabled   ○ paused",
        MUTED,
    );
    if !wide {
        if let Some(selected) = view.definitions.get(view.selected) {
            let offset = view.definitions.len() as u16 + 8;
            section(frame, row(list, offset), "SELECTED DEFINITION");
            text(frame, row(list, offset + 2), selected.title, TEXT);
            text(frame, row(list, offset + 3), selected.schedule, MUTED);
            text(
                frame,
                row(list, offset + 5),
                "Enter opens profile and history",
                MUTED,
            );
        }
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
    section(frame, row(preview, 0), "SELECTED DEFINITION");
    text(frame, row(preview, 2), view.detail.title, TEXT);
    text(
        frame,
        row(preview, 3),
        "Enabled · one-time schedule",
        SUCCESS,
    );
    section(frame, row(preview, 6), "NEXT START");
    text(frame, row(preview, 7), view.detail.next, TEXT);
    section(frame, row(preview, 10), "PROFILE");
    text(frame, row(preview, 11), view.detail.program, TEXT);
    text(frame, row(preview, 12), "Shared workspace", MUTED);
    section(frame, row(preview, 15), "INSTRUCTION");
    frame.render_widget(
        Paragraph::new(view.detail.instruction)
            .style(Style::default().fg(TEXT))
            .wrap(Wrap { trim: true }),
        Rect::new(
            preview.x,
            preview.y + 17.min(preview.height),
            preview.width,
            preview.height.saturating_sub(17).min(4),
        ),
    );
    text(frame, row(preview, 23), "Enter opens full details", MUTED);
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

fn detail(frame: &mut Frame, app: &App, area: Rect, detail: &Detail<'_>) {
    tabs(frame, app, row(area, 0), false);
    let narrow = area.width < 62;
    pair(frame, row(area, 3), "Schedule", detail.schedule, TEXT);
    pair(frame, row(area, 4), "Next start", detail.next, TEXT);
    pair(frame, row(area, 5), "State", "Enabled", SUCCESS);
    pair(frame, row(area, 7), "Agent", detail.program, TEXT);
    pair(frame, row(area, 8), "Workspace", "Shared", TEXT);
    pair(frame, row(area, 9), "Folder", detail.directory, MUTED);
    if narrow {
        section(frame, row(area, 11), "INSTRUCTION");
        frame.render_widget(
            Paragraph::new(detail.instruction)
                .style(Style::default().fg(TEXT))
                .wrap(Wrap { trim: true }),
            Rect::new(
                area.x,
                area.y + 12.min(area.height),
                area.width,
                area.height.saturating_sub(12).min(3),
            ),
        );
    } else {
        section(frame, row(area, 12), "INSTRUCTION");
        text(frame, row(area, 14), detail.instruction, TEXT);
        rule(frame, row(area, 17));
        section(frame, row(area, 19), "EXECUTION POLICY");
        pair(
            frame,
            row(area, 21),
            "Overlap",
            "Queue a separate occurrence",
            TEXT,
        );
        pair(frame, row(area, 22), "Run budget", "5 minutes", TEXT);
        pair(
            frame,
            row(area, 23),
            "Native timeout",
            "Not configured",
            MUTED,
        );
        pair(frame, row(area, 24), "Retry", "Off", MUTED);
        pair(frame, row(area, 25), "Quota wait", "Off", MUTED);
        text(
            frame,
            row(area, 28),
            &format!(
                "Definition revision {} · edits affect future occurrences",
                detail.revision
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
}

fn history(frame: &mut Frame, app: &App, area: Rect, view: &View<'_>) {
    tabs(frame, app, row(area, 0), true);
    let wide = area.width >= 70;
    let started_width = if wide { 23 } else { 15 }.min(area.width);
    let state_width = area.width.saturating_sub(started_width).min(24);
    text(
        frame,
        Rect::new(
            area.x,
            area.y + 3.min(area.height),
            started_width,
            1.min(area.height),
        ),
        "STARTED",
        MUTED,
    );
    text(
        frame,
        Rect::new(
            area.x + started_width,
            area.y + 3.min(area.height),
            state_width,
            1.min(area.height),
        ),
        "STATE",
        MUTED,
    );
    for (index, occurrence) in view.occurrences.iter().enumerate() {
        let target = row(area, index as u16 + 5);
        if target.is_empty() {
            break;
        }
        if index == 0 {
            frame.render_widget(
                Block::default().style(Style::default().bg(app.theme.selection())),
                target,
            );
        }
        text(
            frame,
            Rect::new(target.x, target.y, started_width, 1),
            occurrence.started,
            TEXT,
        );
        text(
            frame,
            Rect::new(target.x + started_width, target.y, state_width, 1),
            occurrence.state,
            occurrence.color,
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
                occurrence.reason,
                MUTED,
            );
        }
    }
    if let Some(selected) = view.occurrences.first() {
        section(frame, row(area, 12), "SELECTED OCCURRENCE");
        pair(frame, row(area, 14), "Reason", selected.reason, WARNING);
        pair(frame, row(area, 15), "Run", selected.run, MUTED);
        pair(
            frame,
            row(area, 16),
            "Quota",
            "Waiting for matching reader",
            WARNING,
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
    frame.render_widget(
        Paragraph::new(format!(" {value}")).style(Style::default().fg(TEXT).bg(if focused {
            app.theme.selection()
        } else {
            SURFACE
        })),
        input,
    );
}

fn form(frame: &mut Frame, app: &App, area: Rect, draft: &Draft<'_>) {
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Basics ", Style::default().fg(app.theme.accent())),
            Span::styled("   Advanced ", Style::default().fg(MUTED)),
        ])),
        row(area, 0),
    );
    let form_width = area.width.min(76);
    let area = Rect::new(area.x, area.y, form_width, area.height);
    field(frame, app, area, 3, "TITLE", draft.title, true);
    field(frame, app, area, 6, "AGENT", draft.program, false);
    field(
        frame,
        app,
        area,
        9,
        "FOLDER · shared workspace",
        draft.directory,
        false,
    );
    section(frame, row(area, 12), "INSTRUCTION");
    let prompt = Rect::new(
        area.x,
        area.y + 13.min(area.height),
        area.width,
        area.height.saturating_sub(13).min(3),
    );
    frame.render_widget(
        Paragraph::new(format!(" {}", draft.instruction))
            .style(Style::default().fg(TEXT).bg(SURFACE))
            .wrap(Wrap { trim: false }),
        prompt,
    );
    field(
        frame,
        app,
        area,
        18,
        "START · one time, explicit offset",
        draft.start,
        false,
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

fn footer(frame: &mut Frame, app: &App, area: Rect, page: Page) {
    if area.is_empty() {
        return;
    }
    let hints: &[(&str, &str)] = match page {
        Page::Definitions => &[
            ("↑↓", "select"),
            ("Enter", "details"),
            ("n", "new"),
            ("Esc", "back"),
        ],
        Page::Detail => &[
            ("e", "edit"),
            ("Space", "pause"),
            ("R", "run now"),
            ("h", "history"),
            ("Esc", "back"),
        ],
        Page::History => &[
            ("↑↓", "select"),
            ("Enter", "inspect"),
            ("c", "cancel occurrence"),
            ("Esc", "back"),
        ],
        Page::Form => &[("Tab", "field"), ("Enter", "save"), ("Esc", "discard")],
        Page::Loading => &[("Esc", "back")],
        Page::Error => &[("r", "retry read"), ("Esc", "back")],
    };
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
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn fixture_app() -> anyhow::Result<App> {
    let mut app = App::new(71);
    app.sidebar_width = 42;
    app.event(serde_json::json!({
        "type":"capabilities", "workspace":"C:/Projects/nesvo", "programs":[
            {"id":"claude","available":true}, {"id":"codex","available":true}
        ]
    }))?;
    app.event(serde_json::json!({"type":"sessions", "revision":1, "groups":[
        {"id":"preview-group","name":"nesvo","parentId":null,"order":0}
    ], "sessions":[
        {"id":"preview-review","name":"Review navigation","cwd":"C:/Projects/nesvo","program":"claude","cols":100,"rows":40,"running":true,"groupId":"preview-group","controllerId":null,"uptimeSeconds":720,"status":{"state":"idle","source":"hook","updatedAt":1}},
        {"id":"preview-pairing","name":"Fix pairing","cwd":"C:/Projects/nesvo","program":"codex","cols":100,"rows":40,"running":true,"groupId":"preview-group","controllerId":null,"uptimeSeconds":1440,"status":{"state":"blocked","source":"hook","updatedAt":1}}
    ]}))?;
    app.dialog = None;
    app.overlay = None;
    app.onboarded = true;
    // The preview surface owns visual focus. The real sidebar remains in its
    // inactive-session projection; no keyboard routing is installed by this.
    app.mode = crate::model::Mode::Input;
    app.notice.clear();
    Ok(app)
}

fn color(value: Color) -> String {
    match value {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::Reset => "reset".into(),
        Color::Indexed(index) => format!("index:{index}"),
        other => format!("{other:?}").to_lowercase(),
    }
}

#[test]
#[ignore = "explicit design review export; requires NESVO_JOBS_PREVIEW_DIR outside the repository"]
fn export_jobs_review_mockups() -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    use ratatui::{Terminal, backend::TestBackend};
    let destination =
        std::path::PathBuf::from(std::env::var_os("NESVO_JOBS_PREVIEW_DIR").context(
            "Set NESVO_JOBS_PREVIEW_DIR to an existing absolute directory outside the repository",
        )?);
    ensure!(
        destination.is_absolute(),
        "Preview output must be an absolute path"
    );
    let destination = destination
        .canonicalize()
        .context("Create the preview output directory before exporting")?;
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    ensure!(
        destination.is_dir() && !destination.starts_with(repository),
        "Preview output must be outside the repository"
    );
    let definitions = [
        Definition {
            title: "Daily review",
            enabled: true,
            schedule: "Once · today at 16:02",
            next: "Today 16:02",
        },
        Definition {
            title: "Nightly checks",
            enabled: true,
            schedule: "Cron · 0 2 * * *",
            next: "Tomorrow 02:00",
        },
        Definition {
            title: "Dependency watch",
            enabled: true,
            schedule: "External delivery",
            next: "External",
        },
        Definition {
            title: "Release notes",
            enabled: false,
            schedule: "Weekly · Monday",
            next: "Paused",
        },
    ];
    let detail = Detail {
        title: "Daily review",
        program: "Claude",
        directory: "C:/Projects/nesvo",
        instruction: "Review changes and report findings. Do not modify files.",
        schedule: "Once · 22 Oct, 16:02 +02:00",
        next: "Today 16:02 · Europe/Warsaw",
        revision: 3,
    };
    let occurrences = [
        Occurrence {
            started: "Today 15:40",
            state: "queued",
            reason: "quota_wait",
            run: "Not allocated",
            color: WARNING,
        },
        Occurrence {
            started: "Yesterday 16:02",
            state: "needsValidation",
            reason: "Result reported",
            run: "Run · preview-02",
            color: WARNING,
        },
        Occurrence {
            started: "20 Oct 16:02",
            state: "canceled",
            reason: "Owner canceled",
            run: "Run · preview-01",
            color: MUTED,
        },
    ];
    let draft = Draft {
        title: "Daily review",
        program: "Claude",
        directory: "C:/Projects/nesvo",
        instruction: "Review changes and report findings. Do not modify files.",
        start: "2026-10-22 16:02 +02:00",
    };
    let scenarios = [
        ("jobs-list-150x44", 150, 44, Page::Definitions),
        ("jobs-detail-150x44", 150, 44, Page::Detail),
        ("jobs-history-150x44", 150, 44, Page::History),
        ("jobs-form-150x44", 150, 44, Page::Form),
        ("jobs-list-80x24", 80, 24, Page::Definitions),
        ("jobs-detail-80x24", 80, 24, Page::Detail),
        ("jobs-loading-80x24", 80, 24, Page::Loading),
        ("jobs-error-80x24", 80, 24, Page::Error),
    ];
    let mut exports = Vec::new();
    for (name, width, height, page) in scenarios {
        let app = fixture_app()?;
        let view = View {
            page,
            definitions: &definitions,
            selected: 0,
            detail: &detail,
            occurrences: &occurrences,
            draft: &draft,
        };
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        terminal.draw(|frame| {
            super::render(frame, &app, 0);
            render(frame, &app, &view);
        })?;
        let layout = super::geometry(Rect::new(0, 0, width, height), &app);
        let buffer = terminal.backend().buffer();
        let cells: Vec<_> = buffer
            .content
            .iter()
            .map(|cell| {
                serde_json::json!({
                    "s":cell.symbol(), "fg":color(cell.fg), "bg":color(cell.bg),
                    "bold":cell.modifier.contains(Modifier::BOLD),
                    "italic":cell.modifier.contains(Modifier::ITALIC),
                    "underline":cell.modifier.contains(Modifier::UNDERLINED)
                })
            })
            .collect();
        let filename = format!("{name}.json");
        std::fs::write(
            destination.join(&filename),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1, "scenario":name, "fixture":true,
                "renderer":"ui::render + ui::jobs_preview::render", "productionActivation":false,
                "width":width, "height":height, "sidebarWidth":layout.tree.width,
                "cells":cells
            }))?,
        )?;
        exports.push(serde_json::json!({"scenario":name,"file":filename,"width":width,"height":height,"sidebarWidth":layout.tree.width}));
    }
    std::fs::write(
        destination.join("manifest.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion":1, "fixture":true, "purpose":"Design approval before runtime activation",
            "exports":exports
        }))?,
    )?;
    Ok(())
}
