use crate::{
    git_pane::{Diff, GitPane, Section},
    model::App,
    review_session::RowKind,
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

const SPLIT_COLUMNS: u16 = 100;
const WIDE_HINTS: [(&str, &str); 6] = [
    ("j k", "move"),
    ("Tab", "section"),
    ("Enter", "diff"),
    ("J K", "scroll"),
    ("r", "refresh"),
    ("Esc", "close"),
];
const NARROW_HINTS: [(&str, &str); 4] = [
    ("j k", "move"),
    ("Tab", "section"),
    ("Enter", "diff"),
    ("Esc", "close"),
];
const READ_ONLY: &str = "read-only: staging and committing are not available";

pub fn render(frame: &mut Frame, app: &App) {
    let Some(pane) = &app.git else {
        return;
    };
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
    let content = Rect::new(
        area.x + inset,
        area.y + area.height.min(1),
        area.width - 2 * inset,
        area.height.saturating_sub(1),
    );
    body(frame, app, pane, content);
    footer(frame, app, footer_area);
}

pub fn render_leaf(frame: &mut Frame, app: &App, area: Rect) -> bool {
    let Some(pane) = &app.git else {
        return false;
    };
    let content = crate::ui::pane_content(area, false);
    frame.render_widget(
        Block::default()
            .borders(Borders::RIGHT | Borders::BOTTOM)
            .border_style(Style::default().fg(if pane.focused {
                app.theme.accent()
            } else {
                BORDER
            })),
        area,
    );
    let status = Rect::new(
        content.x,
        area.bottom().saturating_sub(1),
        content.width,
        area.height.min(1),
    );
    let hint = if pane.focused {
        format!("Git pane · j k · Tab · Enter diff · Esc leave · {READ_ONLY}")
    } else {
        format!("Git pane · Y to focus · {READ_ONLY}")
    };
    text(frame, status, &hint, MUTED);
    body(frame, app, pane, content);
    true
}

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(value.to_owned()).style(Style::default().fg(color)),
            area,
        );
    }
}

fn spans(frame: &mut Frame, area: Rect, spans: Vec<Span<'static>>) {
    if !area.is_empty() {
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }
}

pub fn branch_line(pane: &GitPane) -> String {
    let Some(readiness) = &pane.readiness else {
        return "Reading branch state…".into();
    };
    let branch = readiness
        .branch
        .as_deref()
        .unwrap_or(if readiness.head.is_some() {
            "detached HEAD"
        } else {
            "no commits yet"
        });
    let upstream = match (&readiness.upstream, readiness.ahead, readiness.behind) {
        (Some(upstream), ahead, behind) => format!(
            "{upstream} · ↑{} ↓{}",
            ahead.unwrap_or(0),
            behind.unwrap_or(0)
        ),
        (None, ..) => "no upstream".into(),
    };
    format!(
        "{branch} → {upstream} · {} staged · {} unstaged · {} untracked",
        readiness.staged, readiness.unstaged, readiness.untracked
    )
}

fn blocker_label(blocker: &str) -> &str {
    match blocker {
        "unborn" => "no commits",
        "conflicts" => "conflicts",
        "baseConflicts" => "conflicts with base",
        "dirty" => "uncommitted changes",
        "behindBase" => "behind base",
        "behindUpstream" => "behind upstream",
        "unpushed" => "not pushed",
        other => other,
    }
}

pub fn readiness_line(pane: &GitPane) -> (String, Color) {
    if let Some(error) = &pane.error {
        return (error.clone(), DANGER);
    }
    match &pane.readiness {
        None => ("Loading readiness…".into(), MUTED),
        Some(readiness) if readiness.ready => ("Ready · no blockers".into(), SUCCESS),
        Some(readiness) => (
            format!(
                "Blockers: {}",
                readiness
                    .blockers
                    .iter()
                    .map(|blocker| blocker_label(blocker))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            WARNING,
        ),
    }
}

fn body(frame: &mut Frame, app: &App, pane: &GitPane, area: Rect) {
    if area.is_empty() {
        return;
    }
    let mut title = match &pane.directory {
        Some(directory) => format!("Git · {} · {directory}", pane.session_name),
        None => format!("Git · {}", pane.session_name),
    };
    if pane.is_loading() {
        title.push_str(" · refreshing…");
    }
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(area, 0),
    );
    text(frame, row(area, 1), &branch_line(pane), app.theme.accent());
    let (readiness, color) = readiness_line(pane);
    text(frame, row(area, 2), &readiness, color);
    if area.height > 3 {
        frame.render_widget(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(BORDER)),
            row(area, 3),
        );
    }
    let lower = Rect::new(
        area.x,
        area.y + area.height.min(4),
        area.width,
        area.height.saturating_sub(4),
    );
    if lower.is_empty() {
        return;
    }
    match &pane.diff {
        Some(diff) if area.width >= SPLIT_COLUMNS => {
            let list_width = (area.width * 2 / 5).max(36);
            list(
                frame,
                app,
                pane,
                Rect::new(lower.x, lower.y, list_width, lower.height),
            );
            let gap = 2.min(lower.width.saturating_sub(list_width));
            diff_view(
                frame,
                app,
                diff,
                Rect::new(
                    lower.x + list_width + gap,
                    lower.y,
                    lower.width.saturating_sub(list_width + gap),
                    lower.height,
                ),
            );
        }
        Some(diff) => diff_view(frame, app, diff, lower),
        None => list(frame, app, pane, lower),
    }
}

fn age(received_ms: i64, committed_ms: i64) -> String {
    let seconds = (received_ms - committed_ms).max(0) / 1000;
    match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{}m", seconds / 60),
        3600..86_400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

fn status_color(app: &App, status: &str) -> Color {
    match status.chars().next() {
        Some('A' | 'C') => SUCCESS,
        Some('D') => DANGER,
        Some('R') => app.theme.accent(),
        Some('?') => MUTED,
        _ => WARNING,
    }
}

pub fn lines(app: &App, pane: &GitPane) -> (Vec<Line<'static>>, usize) {
    let mut lines = Vec::new();
    let mut cursor = 0;
    let active = pane.section();
    for section in Section::ALL {
        let current = section == active;
        let header = Style::default()
            .fg(if current { app.theme.accent() } else { MUTED })
            .add_modifier(Modifier::BOLD);
        lines.push(Line::from(Span::styled(
            format!(
                "{} {} ({})",
                if current { "▸" } else { " " },
                section.label(),
                pane.len(section)
            ),
            header,
        )));
        if current {
            cursor = lines.len() - 1;
        }
        let selected = pane.selected(section);
        let mark = |index: usize, line: Line<'static>| {
            if current && index == selected {
                line.style(Style::default().bg(app.theme.selection()).fg(TEXT))
            } else {
                line
            }
        };
        if pane.len(section) == 0 {
            let note = if pane.loaded[section.index()] {
                "nothing here"
            } else {
                "loading…"
            };
            lines.push(Line::from(Span::styled(
                format!("    {note}"),
                Style::default().fg(MUTED),
            )));
        }
        if section == Section::Commits {
            for (index, commit) in pane.commits.iter().enumerate() {
                if current && index == selected {
                    cursor = lines.len();
                }
                lines.push(mark(
                    index,
                    Line::from(vec![
                        Span::styled(
                            format!("    {} ", commit.short_oid),
                            Style::default().fg(app.theme.accent()),
                        ),
                        Span::styled(commit.summary.clone(), Style::default().fg(TEXT)),
                        Span::styled(
                            format!(
                                " · {} · {}",
                                commit.author,
                                age(pane.received_ms, commit.committed_ms)
                            ),
                            Style::default().fg(MUTED),
                        ),
                    ]),
                ));
            }
            if pane.commits_truncated {
                lines.push(Line::from(Span::styled(
                    format!("    older commits beyond {} not shown", pane.commits.len()),
                    Style::default().fg(MUTED),
                )));
            }
            continue;
        }
        for (index, file) in pane.entries[section.index()].iter().enumerate() {
            if current && index == selected {
                cursor = lines.len();
            }
            lines.push(mark(
                index,
                Line::from(vec![
                    Span::styled(
                        format!("    {} ", file.status),
                        Style::default()
                            .fg(status_color(app, &file.status))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(file.path.clone(), Style::default().fg(TEXT)),
                    Span::styled(
                        format!("  +{} -{}", file.additions, file.deletions),
                        Style::default().fg(MUTED),
                    ),
                ]),
            ));
        }
        if pane.truncated[section.index()] {
            lines.push(Line::from(Span::styled(
                "    more files beyond the host bound",
                Style::default().fg(MUTED),
            )));
        }
    }
    (lines, cursor)
}

fn list(frame: &mut Frame, app: &App, pane: &GitPane, area: Rect) {
    if area.is_empty() {
        return;
    }
    let (lines, cursor) = lines(app, pane);
    let height = usize::from(area.height);
    let top = (cursor + 1).saturating_sub(height);
    let visible: Vec<_> = lines.into_iter().skip(top).take(height).collect();
    frame.render_widget(Paragraph::new(visible), area);
}

fn diff_view(frame: &mut Frame, app: &App, diff: &Diff, area: Rect) {
    if area.is_empty() {
        return;
    }
    frame.render_widget(
        Paragraph::new(diff.title.clone())
            .style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(area, 0),
    );
    let body = Rect::new(
        area.x,
        area.y + area.height.min(1),
        area.width,
        area.height.saturating_sub(1),
    );
    if diff.loading {
        return text(frame, row(body, 0), "Loading diff…", MUTED);
    }
    if let Some(message) = &diff.message {
        return text(frame, row(body, 0), message, MUTED);
    }
    let mut lines: Vec<Line> = diff
        .rows
        .iter()
        .skip(diff.scroll)
        .take(usize::from(body.height))
        .map(|row| {
            let (prefix, color) = match row.kind {
                RowKind::Added => ("+", SUCCESS),
                RowKind::Removed => ("-", DANGER),
                RowKind::Hunk => ("", app.theme.accent()),
                RowKind::Meta => ("", MUTED),
                RowKind::Context => (" ", TEXT),
            };
            Line::from(Span::styled(
                format!("{prefix}{}", row.text),
                Style::default().fg(color),
            ))
        })
        .collect();
    if diff.truncated && lines.len() < usize::from(body.height) {
        lines.push(Line::from(Span::styled(
            "Patch cut at the host bound.",
            Style::default().fg(WARNING),
        )));
    }
    frame.render_widget(Paragraph::new(lines), body);
}

fn footer(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }
    let mut parts = vec![
        Span::styled(
            " GIT ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
    ];
    let hints: &[(&str, &str)] = if area.width >= 150 {
        &WIDE_HINTS
    } else {
        &NARROW_HINTS
    };
    for (key, label) in hints {
        parts.push(Span::styled(
            format!(" {key} "),
            Style::default()
                .fg(TEXT)
                .bg(BORDER)
                .add_modifier(Modifier::BOLD),
        ));
        parts.push(Span::styled(
            format!(" {label} "),
            Style::default().fg(MUTED),
        ));
    }
    let used = Line::from(parts.clone()).width();
    let note = if app.notice.is_empty() {
        READ_ONLY.to_owned()
    } else {
        format!("{} · {READ_ONLY}", app.notice)
    };
    parts.push(Span::styled(
        crate::ui::truncate_cells(&note, usize::from(area.width).saturating_sub(used)),
        Style::default().fg(WARNING),
    ));
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    spans(frame, area, parts);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_pane::tests::loaded;
    use crate::layouts::{Direction, PaneTree, Role};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};

    fn leaf_area(area: Rect, app: &App) -> Option<Rect> {
        let index = crate::git_pane::leaf_index(app)?;
        let view = crate::ui::geometry(area, app).views[index];
        (!view.is_empty()).then_some(view)
    }

    fn draw(app: &App, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    fn screen(buffer: &Buffer) -> String {
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn press(app: &mut App, code: KeyCode) {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        );
    }

    #[test]
    fn git_pane_renders_sections_readiness_and_footer_at_three_sizes() {
        let app = loaded();
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let screen = screen(&draw(&app, width, height));
            assert!(
                screen.contains("Git · Agent work"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("feature/git →"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("Blockers: uncommitted"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("▸ Staged (1)"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("M src/staged.rs"),
                "{width}x{height}\n{screen}"
            );
            assert!(
                screen.contains("Unstaged (2)"),
                "{width}x{height}\n{screen}"
            );
            assert!(screen.contains(" GIT "), "{width}x{height}\n{screen}");
            assert!(screen.contains("read-only"), "{width}x{height}\n{screen}");
            if height >= 32 {
                assert!(screen.contains("? notes.md"), "{width}x{height}\n{screen}");
                assert!(
                    screen.contains("aaaaaaa Add git view"),
                    "{width}x{height}\n{screen}"
                );
                assert!(screen.contains("6m"), "{width}x{height}\n{screen}");
            }
        }
        let wide = screen(&draw(&app, 150, 44));
        assert!(wide.contains("origin/feature/git · ↑2 ↓1"));
        assert!(wide.contains("staging and committing are not available"));
    }

    #[test]
    fn git_pane_diff_splits_on_wide_screens_and_replaces_the_list_when_narrow() {
        let mut app = loaded();
        press(&mut app, KeyCode::Enter);
        let wide = screen(&draw(&app, 150, 44));
        assert!(wide.contains("▸ Staged (1)"));
        assert!(wide.contains("Staged · M src/staged.rs"));
        assert!(wide.contains("+new"));
        assert!(wide.contains("-old"));
        let narrow = screen(&draw(&app, 80, 24));
        assert!(!narrow.contains("▸ Staged (1)"));
        assert!(narrow.contains("+new"));
        for _ in 0..3 {
            press(&mut app, KeyCode::Tab);
        }
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Enter);
        let root = screen(&draw(&app, 100, 32));
        assert!(root.contains("Root commit"));
    }

    #[test]
    fn git_pane_renders_inside_a_layout_leaf_and_keeps_the_agent_pane() {
        let mut app = loaded();
        app.set_pane_layout(PaneTree::split(
            Direction::Horizontal,
            PaneTree::leaf(Role::Agent),
            PaneTree::leaf(Role::Git),
        ));
        app.panes[0] = Some("s1".into());
        let buffer = draw(&app, 150, 44);
        let screen = screen(&buffer);
        let area = leaf_area(Rect::new(0, 0, 150, 44), &app).unwrap();
        assert!(area.x > 60);
        let leaf: String = (area.x..area.right())
            .map(|x| buffer[(x, area.y)].symbol())
            .collect();
        assert!(leaf.starts_with("Git · Agent work"), "{leaf}\n{screen}");
        assert!(screen.contains("Esc leave"));
        assert!(!screen.contains(" GIT "));
        press(&mut app, KeyCode::Esc);
        assert!(app.git.as_ref().is_some_and(|pane| !pane.focused));
        assert!(!crate::git_pane::captures(&app));
        assert!(screen_of(&app).contains("Y to focus"));
        press(&mut app, KeyCode::Char('Y'));
        assert!(app.git.as_ref().is_some_and(|pane| pane.focused));
    }

    fn screen_of(app: &App) -> String {
        screen(&draw(app, 150, 44))
    }

    #[test]
    fn git_role_leaf_without_an_open_pane_shows_the_key_hint() {
        let mut app = crate::git_pane::tests::app();
        app.set_pane_layout(PaneTree::split(
            Direction::Horizontal,
            PaneTree::leaf(Role::Agent),
            PaneTree::leaf(Role::Git),
        ));
        assert!(screen_of(&app).contains("Press Y to open Git"));
    }

    #[test]
    fn git_layout_apply_opens_the_pane_in_its_leaf_without_focus() {
        let mut app = crate::git_pane::tests::app();
        let layout = crate::layouts::shipped()
            .into_iter()
            .find(|layout| layout.name == "Agent + Git")
            .unwrap();
        let commands = crate::layouts::apply(&mut app, &layout, 150).unwrap();
        assert!(
            commands
                .iter()
                .any(|command| command["type"] == "openReview")
        );
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "acquireControl")
        );
        assert!(app.git.as_ref().is_some_and(|pane| !pane.focused));
        assert!(screen_of(&app).contains("Y to focus"));
    }
}
