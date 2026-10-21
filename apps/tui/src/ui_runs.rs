use crate::{
    model::App,
    runs::{Detail, Digest, Load, Page, Runs, Summary, Templates},
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
    ui::truncate_cells,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

const SUBTITLE: &str = "Host runs · tasks, attempts, inbox and decisions";
const TEMPLATE_ROW: &str = "+ Start from template";
const STATE_WIDTH: u16 = 10;

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(truncate_cells(value, usize::from(area.width)))
                .style(Style::default().fg(color)),
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

fn below(area: Rect, offset: u16, limit: u16) -> Rect {
    Rect::new(
        area.x,
        area.y + offset.min(area.height),
        area.width,
        area.height.saturating_sub(offset).min(limit),
    )
}

pub fn state_mark(state: &str) -> &'static str {
    match state {
        "active" => "●",
        "draining" | "drained" => "◐",
        "stopping" | "stopped" => "■",
        "succeeded" => "✓",
        "failed" | "canceling" | "canceled" => "×",
        _ => "○",
    }
}

pub fn state_color(state: &str) -> Color {
    match state {
        "active" | "succeeded" | "accepted" => SUCCESS,
        "failed" | "canceling" | "canceled" | "stopped" | "stopping" => DANGER,
        "draft" | "planned" => MUTED,
        _ => WARNING,
    }
}

pub fn render(frame: &mut Frame, app: &App, runs: &Runs) {
    let (area, footer_area) = crate::ui_jobs::surface(frame, app);
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    let inset = 2.min(area.width / 2);
    let content = Rect::new(area.x + inset, area.y, area.width - 2 * inset, area.height);
    let title = match runs.page {
        Page::Runs => "Runs",
        Page::Templates => "Runs / Start from template",
        Page::Answer => "Runs / Answer decision",
    };
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(content, 1),
    );
    text(frame, row(content, 2), SUBTITLE, app.theme.accent());
    let rule = row(content, 3);
    if !rule.is_empty() {
        frame.render_widget(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(BORDER)),
            rule,
        );
    }
    let body = Rect::new(
        content.x,
        content.y + content.height.min(5),
        content.width,
        content.height.saturating_sub(6),
    );
    match (&runs.load, runs.page) {
        (_, Page::Answer) => answer(frame, app, body, runs),
        (_, Page::Templates) => templates(frame, app, body, runs.templates.as_ref()),
        (Load::Loading, Page::Runs) if runs.runs.is_empty() => {
            text(frame, row(body, 2), "Loading runs from your host…", TEXT);
        }
        (Load::Failed(message), Page::Runs) => {
            text(frame, row(body, 2), "Could not load runs", DANGER);
            wrapped(frame, below(body, 4, 3), message, TEXT);
        }
        (_, Page::Runs) => overview(frame, app, body, runs),
    }
    footer(frame, app, footer_area, runs);
}

fn run_row(frame: &mut Frame, area: Rect, run: &Summary, selected: bool, app: &App) {
    if area.is_empty() {
        return;
    }
    if selected {
        frame.render_widget(
            Block::default().style(Style::default().bg(app.theme.selection())),
            area,
        );
    }
    let state_width = STATE_WIDTH.min(area.width / 2);
    let name_width = area.width.saturating_sub(state_width + 1);
    text(
        frame,
        Rect::new(area.x, area.y, name_width, 1),
        &format!(" {} {}", state_mark(&run.state), run.title),
        TEXT,
    );
    frame.render_widget(
        Paragraph::new(truncate_cells(&run.state, usize::from(state_width)))
            .right_aligned()
            .style(Style::default().fg(state_color(&run.state))),
        Rect::new(
            area.right().saturating_sub(state_width + 1),
            area.y,
            state_width,
            1,
        ),
    );
}

fn overview(frame: &mut Frame, app: &App, area: Rect, runs: &Runs) {
    let wide = area.width >= 96;
    let list_width = if wide { area.width * 2 / 5 } else { area.width };
    let list = Rect::new(area.x, area.y, list_width, area.height);
    let more = if runs.more { "  · newest 16" } else { "" };
    text(
        frame,
        row(list, 0),
        &format!("RUNS  {}{more}", runs.runs.len()),
        MUTED,
    );
    let capacity = if wide {
        list.height.saturating_sub(3)
    } else {
        list.height.saturating_sub(3).min(6)
    };
    let visible = usize::from(capacity.max(1));
    let first = runs
        .selected_row()
        .saturating_sub(visible.saturating_sub(1));
    let rows = std::iter::once(None).chain(runs.runs.iter().map(Some));
    let mut shown = 0;
    for (offset, run) in rows.skip(first).take(visible).enumerate() {
        let target = row(list, offset as u16 + 2);
        if target.is_empty() {
            break;
        }
        shown = offset + 1;
        match run {
            None => {
                if runs.selected.is_none() {
                    frame.render_widget(
                        Block::default().style(Style::default().bg(app.theme.selection())),
                        target,
                    );
                }
                text(
                    frame,
                    target,
                    &format!(" {TEMPLATE_ROW}"),
                    app.theme.accent(),
                );
            }
            Some(run) => run_row(
                frame,
                target,
                run,
                runs.selected.as_deref() == Some(run.id.as_str()),
                app,
            ),
        }
    }
    let detail_area = if wide {
        frame.render_widget(
            Block::default()
                .borders(Borders::LEFT)
                .border_style(Style::default().fg(BORDER)),
            Rect::new(list.right() + 1, area.y, 1, area.height),
        );
        Rect::new(
            list.right() + 3,
            area.y,
            area.width.saturating_sub(list.width + 3),
            area.height,
        )
    } else {
        let offset = (shown as u16 + 3).min(area.height);
        Rect::new(area.x, area.y + offset, area.width, area.height - offset)
    };
    match (runs.selected_run(), runs.selected_detail()) {
        (Some(run), detail) => run_detail(frame, detail_area, run, detail),
        (None, _) => template_hint(frame, detail_area),
    }
}

fn template_hint(frame: &mut Frame, area: Rect) {
    text(frame, row(area, 0), "START FROM TEMPLATE", MUTED);
    wrapped(
        frame,
        below(area, 2, 3),
        "Enter lists the approved [[workflow]] templates committed in HEAD:nesvo.toml and starts one as a new run.",
        TEXT,
    );
    wrapped(
        frame,
        below(area, 5, 3),
        "Approval is an owner CLI step: nesvo workflow approve-templates.",
        MUTED,
    );
}

fn task_line(task: &crate::runs::Task) -> String {
    let attempt = match &task.current_attempt {
        Some(attempt) => format!(
            "attempt {}/{} {} · {}",
            attempt.ordinal, task.attempts, attempt.state, attempt.session_id
        ),
        None if task.dependency_state == "waiting" => "waiting on dependencies".into(),
        None => "ready, no attempt".into(),
    };
    format!(" {} {}  {}", state_mark(&task.state), task.key, attempt)
}

fn digest_label(digest: &Digest) -> &'static str {
    if digest.settled() {
        "final digest"
    } else {
        "working state"
    }
}

fn digest_headline(digest: &Digest) -> String {
    let next = digest
        .next_steps
        .first()
        .map(|step| format!(" · next {step}"))
        .unwrap_or_default();
    format!(
        "{} · {}/{} accepted{next}",
        digest_label(digest),
        digest.accepted,
        digest.total
    )
}

fn digest_section(frame: &mut Frame, area: Rect, mut y: u16, digest: &Digest) {
    let heading = if digest.settled() {
        "DIGEST"
    } else {
        "WORKING STATE"
    };
    text(
        frame,
        row(area, y),
        &format!(
            "{heading}  revision {} · journal {}",
            digest.source_revision, digest.journal_cursor
        ),
        MUTED,
    );
    y += 1;
    let omitted = if digest.omitted > 0 {
        format!(" · {} omitted", digest.omitted)
    } else {
        String::new()
    };
    let lines = [
        format!(
            " tasks {}/{} accepted{omitted} · decisions {} pending, {} answered",
            digest.accepted, digest.total, digest.decisions_pending, digest.decisions_answered
        ),
        format!(
            " budget {} · {} active · {} checkpoints",
            digest.time_state, digest.active_attempts, digest.checkpoints
        ),
    ];
    for line in lines {
        text(frame, row(area, y), &line, TEXT);
        y += 1;
    }
    for step in digest.next_steps.iter().take(2) {
        text(frame, row(area, y), &format!(" next {step}"), TEXT);
        y += 1;
    }
    if let Some(branch) = digest.branches.first() {
        text(frame, row(area, y), &format!(" branch {branch}"), MUTED);
    }
}

fn run_detail(frame: &mut Frame, area: Rect, run: &Summary, detail: Option<&Detail>) {
    text(frame, row(area, 0), "SELECTED RUN", MUTED);
    text(frame, row(area, 1), &run.title, TEXT);
    text(
        frame,
        row(area, 2),
        &format!("{} · revision {}", run.state, run.revision),
        state_color(&run.state),
    );
    let Some(detail) = detail else {
        text(frame, row(area, 4), "Loading tasks…", MUTED);
        return;
    };
    if let Some(digest) = &detail.digest {
        text(frame, row(area, 3), &digest_headline(digest), MUTED);
    }
    let mut y = 4;
    if detail.wakes.loaded {
        let line = if detail.digest.is_some() { 4 } else { 3 };
        text(
            frame,
            row(area, line),
            &detail.wakes.summary(),
            wake_color(&detail.wakes),
        );
        y = line + 1;
    }
    text(
        frame,
        row(area, y),
        &format!("TASKS  {}", detail.tasks.len()),
        MUTED,
    );
    y += 1;
    let task_rows = area.height.saturating_sub(12).clamp(1, 8);
    for task in detail.tasks.iter().take(usize::from(task_rows)) {
        text(
            frame,
            row(area, y),
            &task_line(task),
            state_color(&task.state),
        );
        y += 1;
    }
    if detail.tasks.len() > usize::from(task_rows) {
        text(
            frame,
            row(area, y),
            &format!(" +{} more", detail.tasks.len() - usize::from(task_rows)),
            MUTED,
        );
        y += 1;
    }
    y += 1;
    let inbox = if detail.inbox_loaded {
        format!("INBOX  {} pending", detail.pending_messages)
    } else {
        "INBOX  loading".into()
    };
    text(frame, row(area, y), &inbox, MUTED);
    y += 1;
    for message in detail.messages.iter().take(2) {
        text(
            frame,
            row(area, y),
            &format!(
                " {}: {}",
                message.kind,
                message.body.replace(['\r', '\n'], " ")
            ),
            TEXT,
        );
        y += 1;
    }
    y += 1;
    let decisions = if detail.decisions_loaded {
        format!("DECISIONS  {} pending", detail.decisions.len())
    } else {
        "DECISIONS  loading".into()
    };
    text(frame, row(area, y), &decisions, MUTED);
    y += 1;
    for decision in detail.decisions.iter().take(2) {
        let task = detail
            .tasks
            .iter()
            .find(|task| task.id == decision.task_id)
            .map_or("task", |task| task.key.as_str());
        text(
            frame,
            row(area, y),
            &format!(
                " ? {} ({} · {task})",
                decision.question.replace(['\r', '\n'], " "),
                decision.audience
            ),
            WARNING,
        );
        y += 1;
    }
    if !detail.decisions.is_empty() {
        text(frame, row(area, y), " a answers the first one", MUTED);
        y += 1;
    }
    if detail.wakes.loaded && !detail.wakes.batches.is_empty() {
        y += 1;
        text(
            frame,
            row(area, y),
            &format!(
                "WAKE BATCHES  delivered through notice {}",
                detail.wakes.delivered_through
            ),
            MUTED,
        );
        y += 1;
        for batch in detail.wakes.batches.iter().take(3) {
            text(frame, row(area, y), &batch_line(batch), batch_color(batch));
            y += 1;
        }
    }
    if let Some(digest) = &detail.digest {
        digest_section(frame, area, y + 1, digest);
    }
}

fn wake_color(wakes: &crate::runs::Wakes) -> Color {
    match &wakes.policy {
        None => MUTED,
        Some(policy) if policy.enabled && !policy.held => SUCCESS,
        Some(_) => WARNING,
    }
}

fn batch_line(batch: &crate::runs::WakeBatch) -> String {
    let id: String = batch.id.chars().take(8).collect();
    let delivery = if batch.delivery == "full" {
        "full"
    } else {
        "delta"
    };
    let reason = batch
        .reason
        .as_deref()
        .map_or_else(String::new, |reason| format!(" ({reason})"));
    format!(
        " {} {id} · {} notices · {}{reason} · {delivery}",
        if batch.phase == "settled" { "✓" } else { "!" },
        batch.notice_count,
        batch.phase
    )
}

fn batch_color(batch: &crate::runs::WakeBatch) -> Color {
    match batch.phase.as_str() {
        "settled" => TEXT,
        "dispatching" => WARNING,
        _ => DANGER,
    }
}

fn templates(frame: &mut Frame, app: &App, area: Rect, templates: Option<&Templates>) {
    let Some(templates) = templates else {
        text(
            frame,
            row(area, 2),
            "This host cannot start workflow templates.",
            MUTED,
        );
        return;
    };
    match &templates.load {
        Load::Loading => {
            text(
                frame,
                row(area, 2),
                "Reading HEAD:nesvo.toml from your host…",
                TEXT,
            );
            return;
        }
        Load::Failed(message) => {
            text(
                frame,
                row(area, 2),
                "Could not read workflow templates",
                DANGER,
            );
            wrapped(frame, below(area, 4, 4), message, TEXT);
            return;
        }
        Load::Ready => {}
    }
    text(
        frame,
        row(area, 0),
        &format!(
            "TEMPLATES  {}  · {}",
            templates.items.len(),
            templates.repository
        ),
        MUTED,
    );
    if templates.items.is_empty() {
        wrapped(
            frame,
            below(area, 2, 3),
            "No [[workflow]] entries are committed in HEAD:nesvo.toml of this repository.",
            TEXT,
        );
        return;
    }
    let mut y = 2;
    if !templates.approved {
        let digest = templates.digest.as_deref().unwrap_or_default();
        wrapped(
            frame,
            below(area, y, 2),
            "These templates are not approved. Inspect them, then approve the digest from the owner CLI:",
            WARNING,
        );
        wrapped(
            frame,
            below(area, y + 2, 3),
            &format!(
                "nesvo workflow approve-templates --directory {} --digest {digest}",
                templates.directory
            ),
            TEXT,
        );
        y += 6;
    }
    for (index, template) in templates.items.iter().enumerate() {
        let target = row(area, y + index as u16);
        if target.is_empty() {
            break;
        }
        if templates.approved && index == templates.selected {
            frame.render_widget(
                Block::default().style(Style::default().bg(app.theme.selection())),
                target,
            );
        }
        text(
            frame,
            target,
            &format!(
                " {}  {}  · {} · {} tasks",
                template.name,
                template.title,
                template.start,
                template.tasks.len()
            ),
            if templates.approved { TEXT } else { MUTED },
        );
    }
}

fn answer(frame: &mut Frame, app: &App, area: Rect, runs: &Runs) {
    let Some(form) = &runs.answer else {
        return;
    };
    text(frame, row(area, 0), "DECISION", MUTED);
    wrapped(frame, below(area, 1, 4), &form.question, TEXT);
    text(frame, row(area, 6), "ANSWER", MUTED);
    let input = row(area, 7);
    if !input.is_empty() {
        frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), input);
        let shown = format!("{}▏", form.text);
        let width = usize::from(input.width.saturating_sub(1));
        let tail: String = shown
            .chars()
            .rev()
            .take(width)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        text(
            frame,
            Rect::new(input.x + 1, input.y, input.width.saturating_sub(1), 1),
            &tail,
            app.theme.accent(),
        );
    }
    wrapped(
        frame,
        below(area, 9, 3),
        &format!(
            "Enter records the answer at decision revision {}; it never validates the task or approves provider permissions.",
            form.revision
        ),
        MUTED,
    );
}

fn hints(runs: &Runs) -> Vec<(&'static str, &'static str)> {
    match runs.page {
        Page::Answer => vec![("Enter", "answer"), ("Esc", "cancel")],
        Page::Templates => vec![
            ("↑↓", "select"),
            ("Enter", "start"),
            ("F5", "reload"),
            ("Esc", "back"),
        ],
        Page::Runs if runs.selected.is_none() => vec![
            ("↑↓", "select"),
            ("Enter", "templates"),
            ("F5", "refresh"),
            ("Esc", "back"),
        ],
        Page::Runs
            if runs
                .selected_detail()
                .is_some_and(|detail| detail.wakes.loaded) =>
        {
            vec![
                ("↑↓", "select"),
                ("p", "pause"),
                ("r", "resume"),
                ("d", "drain"),
                ("a", "answer"),
                ("w", "wakes"),
                ("f", "delivery"),
                ("n", "template"),
                ("Esc", "back"),
            ]
        }
        Page::Runs => vec![
            ("↑↓", "select"),
            ("p", "pause"),
            ("r", "resume"),
            ("d", "drain"),
            ("a", "answer"),
            ("n", "template"),
            ("Esc", "back"),
        ],
    }
}

fn footer(frame: &mut Frame, app: &App, area: Rect, runs: &Runs) {
    if area.is_empty() {
        return;
    }
    let mut spans = vec![
        Span::styled(
            " RUNS ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];
    for (key, label) in hints(runs) {
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
            truncate_cells(&format!("· {}", app.notice), available - used),
            Style::default().fg(WARNING),
        ));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

pub fn render_leaf(frame: &mut Frame, app: &App, area: Rect) -> bool {
    let Some(runs) = &app.runs else {
        return false;
    };
    if area.is_empty() {
        return true;
    }
    text(
        frame,
        row(area, 0),
        &format!("RUNS  {}", runs.runs.len()),
        MUTED,
    );
    for (offset, run) in runs.runs.iter().enumerate() {
        let target = row(area, offset as u16 + 2);
        if target.is_empty() {
            break;
        }
        let pending = runs
            .details
            .get(&run.id)
            .map_or(0, |detail| detail.decisions.len());
        let mut summary = run.clone();
        if pending > 0 {
            summary.title = format!("{} · {pending}?", run.title);
        }
        run_row(frame, target, &summary, false, app);
    }
    if runs.runs.is_empty() {
        text(
            frame,
            row(area, 2),
            "No runs yet. Press W to start one.",
            MUTED,
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::tests as fixtures;
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
    use serde_json::json;

    fn app(runs: Runs) -> App {
        let mut app = App::new(71);
        app.event(json!({
            "type":"capabilities", "workspace":"C:/Projects/nesvo", "programs":[
                {"id":"claude","available":true}
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
        app.runs = Some(runs);
        app
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
    fn runs_render_wide_list_with_tasks_attempts_inbox_and_decisions_at_150x44() {
        let app = app(fixtures::loaded());
        let buffer = draw(&app, 150, 44);
        let all = screen(&buffer);
        assert!(all.contains("Review navigation"), "sidebar stays visible");
        let (x, y) = find(&buffer, "Runs").unwrap();
        assert_eq!((x, y), (44, 1));
        assert!(line(&buffer, 2).contains(SUBTITLE));
        assert!(line(&buffer, 5).contains("RUNS  2"));
        assert!(line(&buffer, 7).contains(TEMPLATE_ROW));
        let (_, selected) = find(&buffer, "● Branch review").unwrap();
        assert_eq!(selected, 8);
        assert_eq!(buffer[(45, selected)].bg, app.theme.selection());
        assert!(line(&buffer, selected).contains("active"));
        assert!(line(&buffer, 9).contains("◐ Release notes"));
        assert!(all.contains("SELECTED RUN"));
        assert!(all.contains("active · revision 4"));
        assert!(all.contains("TASKS  2"));
        assert!(all.contains("implement  attempt 2/2 reported · s-worker"));
        assert!(all.contains("review  waiting on dependencies"));
        assert!(all.contains("INBOX  3 pending"));
        assert!(all.contains("result: Implementation reported"));
        assert!(all.contains("DECISIONS  1 pending"));
        assert!(all.contains("? Ship the migration now? (owner · implement)"));
        assert!(line(&buffer, 43).starts_with(" RUNS "));
        assert!(line(&buffer, 43).contains(" p  pause"));
    }

    #[test]
    fn runs_render_the_selected_run_digest_at_150x44_100x32_and_80x24() {
        let loaded = app(fixtures::loaded());
        for (width, height, section) in [(150, 44, true), (100, 32, true), (80, 24, false)] {
            let buffer = draw(&loaded, width, height);
            let all = screen(&buffer);
            let (_, state) = find(&buffer, "active · revision 4").unwrap();
            let (_, line) = find(&buffer, "working state · 1/2")
                .unwrap_or_else(|| panic!("{width}x{height}\n{all}"));
            assert_eq!(line, state + 1, "{width}x{height}");
            assert!(
                all.contains("working state · 1/2 accepted · next implemen"),
                "{width}x{height}\n{all}"
            );
            if section {
                assert!(
                    all.contains("WORKING STATE  revision 4 · journal 41"),
                    "{width}x{height}\n{all}"
                );
                assert!(all.contains("tasks 1/2 accepted · decisions 1 pending, 1 answered"));
                assert!(all.contains("budget open · 1 active · 2 checkpoints"));
                assert!(all.contains(" next implement: Wire"));
                assert_eq!(
                    all.contains("branch nesvo/0123456789abcdef"),
                    height >= 44,
                    "{width}x{height}\n{all}"
                );
            }
        }
        let mut runs = fixtures::loaded();
        let digest = runs
            .details
            .get_mut("run-a")
            .unwrap()
            .digest
            .as_mut()
            .unwrap();
        digest.kind = "final".into();
        digest.omitted = 3;
        let all = screen(&draw(&app(runs), 150, 44));
        assert!(all.contains("final digest · 1/2 accepted"));
        assert!(all.contains("DIGEST  revision 4 · journal 41"));
        assert!(all.contains("tasks 1/2 accepted · 3 omitted"));
        let mut runs = fixtures::loaded();
        runs.details.get_mut("run-a").unwrap().digest = None;
        let all = screen(&draw(&app(runs), 150, 44));
        assert!(!all.contains("WORKING STATE") && !all.contains("working state"));
    }

    #[test]
    fn runs_render_compact_detail_below_the_list_at_80x24() {
        let app = app(fixtures::loaded());
        let buffer = draw(&app, 80, 24);
        let all = screen(&buffer);
        assert!(all.contains("RUNS  2"));
        assert!(all.contains(TEMPLATE_ROW));
        assert!(all.contains("● Branch review"));
        let (_, list) = find(&buffer, "◐ Release notes").unwrap();
        let (_, detail) = find(&buffer, "SELECTED RUN").unwrap();
        assert!(detail > list);
        assert!(all.contains("active · revision 4"));
        assert!(line(&buffer, 23).starts_with(" RUNS "));
    }

    #[test]
    fn runs_render_templates_and_the_answer_form_at_100x32() {
        let mut runs = fixtures::loaded();
        let features = fixtures::features();
        let open = runs
            .open_templates(&features, "C:/Projects/nesvo".into())
            .commands
            .remove(0);
        fixtures::reply(&mut runs, &open, fixtures::templates());
        let mut app = app(runs);
        let buffer = draw(&app, 100, 32);
        let all = screen(&buffer);
        assert!(all.contains("Runs / Start from template"));
        assert!(all.contains("TEMPLATES  2"));
        let (x, review) = find(&buffer, "review  Branch review  · active · 2 tasks").unwrap();
        assert_eq!(buffer[(x, review)].bg, app.theme.selection());
        assert!(all.contains("triage  Triage  · draft · 1 tasks"));
        let runs = app.runs.as_mut().unwrap();
        runs.templates.as_mut().unwrap().approved = false;
        let buffer = draw(&app, 100, 32);
        assert!(screen(&buffer).contains("not approved"));
        assert!(screen(&buffer).contains("nesvo workflow approve-templates --directory"));
        let runs = app.runs.as_mut().unwrap();
        runs.back();
        runs.begin_answer();
        runs.answer.as_mut().unwrap().text = "Yes".into();
        let buffer = draw(&app, 100, 32);
        let all = screen(&buffer);
        assert!(all.contains("Runs / Answer decision"));
        assert!(all.contains("Ship the migration now?"));
        assert!(all.contains("Yes▏"));
        assert!(all.contains("decision revision 1"));
    }

    #[test]
    fn runs_render_wake_policy_and_batches_at_every_supported_size() {
        let delivering = app(fixtures::loaded_with_wakes());
        let summary = "Wakes · delivering · delta only · 2 pending";
        for (width, height) in [(150, 44), (100, 32), (80, 24)] {
            let buffer = draw(&delivering, width, height);
            let all = screen(&buffer);
            assert!(all.contains(summary), "{width}x{height}\n{all}");
            let (x, y) = find(&buffer, summary).unwrap();
            assert_eq!(buffer[(x, y)].fg, SUCCESS);
            assert!(line(&buffer, height - 1).starts_with(" RUNS "));
        }
        let wide = draw(&delivering, 150, 44);
        let all = screen(&wide);
        assert!(all.contains("WAKE BATCHES  delivered through notice 11"));
        assert!(all.contains("✓ b2aaaaaa · 8 notices · settled · delta"));
        let (x, y) = find(
            &wide,
            "! b1bbbbbb · 3 notices · unknown (host_restart) · full",
        )
        .unwrap();
        assert_eq!(wide[(x, y)].fg, DANGER);
        let footer = line(&wide, 43);
        assert!(footer.contains(" w  wakes") && footer.contains(" f  delivery"));
        let mut held = fixtures::loaded_with_wakes();
        held.details.get_mut("run-a").unwrap().wakes.policy = serde_json::from_value(
            json!({"enabled":true,"held":true,"phase":"held","reason":"owner_held","delivery":"full"}),
        )
        .ok();
        let buffer = draw(&app(held), 100, 32);
        let (x, y) = find(&buffer, "Wakes · held · full context · 2 waiting").unwrap();
        assert_eq!(buffer[(x, y)].fg, WARNING);
        let plain = draw(&app(fixtures::loaded()), 150, 44);
        assert!(!screen(&plain).contains("Wakes ·"));
        assert!(!line(&plain, 43).contains(" w  wakes"));
    }

    #[test]
    fn runs_leaf_lists_the_last_snapshot_with_pending_decisions() {
        let mut runs = fixtures::loaded();
        runs.open = false;
        let mut app = app(runs);
        app.set_pane_layout(crate::layouts::PaneTree::split(
            crate::layouts::Direction::Horizontal,
            crate::layouts::PaneTree::leaf(crate::layouts::Role::Agent),
            crate::layouts::PaneTree::leaf(crate::layouts::Role::Runs),
        ));
        let buffer = draw(&app, 150, 44);
        let all = screen(&buffer);
        assert!(all.contains("Branch review · 1?"), "{all}");
        assert!(all.contains("Release notes"));
        app.runs = None;
        let buffer = draw(&app, 150, 44);
        assert!(screen(&buffer).contains("Press W to open Runs"));
    }
}
