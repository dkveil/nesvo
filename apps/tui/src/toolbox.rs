//! Small modal workflows with exclusive keyboard and pointer focus.
use crate::{
    controller::Outcome,
    model::{App, Session},
    status::{Source, State},
    theme::{MUTED, SURFACE, TEXT},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, MouseButton, MouseEventKind};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{Block, Clear, Paragraph},
};
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum Overlay {
    Onboarding(usize),
    Filters(usize),
    Schedules(usize),
}
pub const FILTERS: [&str; 8] = [
    "Working",
    "Idle",
    "Done",
    "Blocked",
    "Question",
    "Failed",
    "Open / quiet",
    "Unknown",
];

pub fn status_index(session: &Session) -> usize {
    let Some(status) = &session.status else {
        return 7;
    };
    if status.source == Source::Activity {
        return 6;
    }
    match status.state {
        State::Working => 0,
        State::Idle => 1,
        State::Done => 2,
        State::Blocked => 3,
        State::Question => 4,
        State::Failed => 5,
        State::Unknown => 7,
    }
}
pub fn area(screen: Rect) -> Rect {
    let width = screen.width.saturating_sub(4).min(76);
    let height = screen.height.saturating_sub(2).min(18);
    Rect::new(
        screen.x + (screen.width - width) / 2,
        screen.y + (screen.height - height) / 2,
        width,
        height,
    )
}
pub fn event(app: &mut App, event: Event, screen: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    let Some(overlay) = app.overlay else {
        return outcome;
    };
    let code = match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key.code,
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
            let panel = area(screen);
            if !panel.contains((mouse.column, mouse.row).into()) {
                return outcome;
            }
            let row = mouse.row.saturating_sub(panel.y + 2) as usize;
            match overlay {
                Overlay::Filters(_) if row < FILTERS.len() => {
                    app.overlay = Some(Overlay::Filters(row));
                    KeyCode::Char(' ')
                }
                Overlay::Schedules(selected) if row < panel.height.saturating_sub(7) as usize => {
                    let first = selected.saturating_sub(panel.height.saturating_sub(8) as usize);
                    app.overlay = Some(Overlay::Schedules(
                        (first + row).min(app.schedules.len().saturating_sub(1)),
                    ));
                    return outcome;
                }
                _ if mouse.row == panel.bottom().saturating_sub(2) => KeyCode::Enter,
                _ => return outcome,
            }
        }
        _ => return outcome,
    };
    if code == KeyCode::Esc {
        app.overlay = None;
        return outcome;
    }
    match app.overlay {
        Some(Overlay::Onboarding(step)) => match code {
            KeyCode::Enter | KeyCode::Right => {
                if step == 2 {
                    app.onboarded = true;
                    app.overlay = None;
                } else {
                    app.overlay = Some(Overlay::Onboarding(step + 1));
                }
            }
            KeyCode::Left | KeyCode::BackTab => {
                app.overlay = Some(Overlay::Onboarding(step.saturating_sub(1)))
            }
            _ => {}
        },
        Some(Overlay::Filters(selected)) => match code {
            KeyCode::Up | KeyCode::BackTab => {
                app.overlay = Some(Overlay::Filters(selected.saturating_sub(1)))
            }
            KeyCode::Down | KeyCode::Tab => {
                app.overlay = Some(Overlay::Filters((selected + 1).min(7)))
            }
            KeyCode::Char(' ') => {
                let id = app.selected_row().map(|row| row.kind);
                if !app.status_filters.remove(&selected) {
                    app.status_filters.insert(selected);
                }
                app.selected = id
                    .and_then(|id| app.tree().iter().position(|row| row.kind == id))
                    .unwrap_or(0);
            }
            KeyCode::Char('a') => app.status_filters.clear(),
            KeyCode::Enter => app.overlay = None,
            _ => {}
        },
        Some(Overlay::Schedules(selected)) => match code {
            KeyCode::Up | KeyCode::BackTab => {
                app.overlay = Some(Overlay::Schedules(selected.saturating_sub(1)))
            }
            KeyCode::Down | KeyCode::Tab => {
                app.overlay = Some(Overlay::Schedules(
                    (selected + 1).min(app.schedules.len().saturating_sub(1)),
                ))
            }
            KeyCode::Char('r') => outcome.commands.push(json!({"type":"listSchedules"})),
            KeyCode::Char('x') => {
                if let Some(job) = app.schedules.get(selected)
                    && job["state"] == "pending"
                {
                    outcome
                        .commands
                        .push(json!({"type":"cancelSchedule", "id":job["id"]}));
                }
            }
            KeyCode::Enter => app.overlay = None,
            _ => {}
        },
        None => {}
    }
    outcome
}

pub fn render(frame: &mut Frame, app: &App) {
    let Some(overlay) = app.overlay else {
        return;
    };
    let area = area(frame.area());
    frame.render_widget(Clear, area);
    let (title, lines, hint) = match overlay {
        Overlay::Onboarding(step) => {
            let pages = [
                (
                    "Welcome to Nesvo · 1/3",
                    vec![
                        "One session is one process on your host.",
                        "Group sessions without moving their folders.",
                        "",
                        "n  New session   g  New group",
                        "/  Search   F2  Expand command palette",
                        "f  Select status filters",
                    ],
                ),
                (
                    "Your keyboard · 2/3",
                    vec![
                        "Enter opens a session. Ctrl+Q returns to navigation.",
                        "In input mode, keys belong to the agent — including Esc.",
                        "",
                        "D  Read-only Git review   z  Focus mode",
                        "Tab changes review focus. Esc closes review.",
                        "F1 opens the menu. Settings apply live to the workspace.",
                    ],
                ),
                (
                    "Launch and reconnect · 3/3",
                    vec![
                        "n, then F2: worktree, initial prompt and scheduled start.",
                        "Worktrees start at HEAD on a fresh branch.",
                        "Schedules run on the host; keep that computer awake.",
                        "Agent login, trust and permission prompts still apply.",
                        "",
                        "S  Scheduled sessions   H  Reopen this guide",
                        "Missing quota data is shown as unavailable.",
                    ],
                ),
            ];
            let (title, lines) = &pages[step];
            (
                *title,
                lines.iter().map(|line| Line::from(*line)).collect(),
                "← Back   Enter next / finish   Esc later",
            )
        }
        Overlay::Filters(selected) => (
            "Filter sessions · multiple selections",
            FILTERS
                .iter()
                .enumerate()
                .map(|(i, label)| {
                    Line::styled(
                        format!(
                            " {} [{}] {label}",
                            if i == selected { ">" } else { " " },
                            if app.status_filters.contains(&i) {
                                "x"
                            } else {
                                " "
                            }
                        ),
                        Style::default().fg(TEXT).bg(if i == selected {
                            app.theme.selection()
                        } else {
                            SURFACE
                        }),
                    )
                })
                .chain([
                    Line::from(""),
                    Line::from("No selections = all statuses. ~ means inferred from screen."),
                ])
                .collect::<Vec<_>>(),
            "↑↓ move   Space toggle   a all   Enter done",
        ),
        Overlay::Schedules(selected) => {
            let first = selected.saturating_sub(area.height.saturating_sub(8) as usize);
            let mut lines: Vec<Line> = app
                .schedules
                .iter()
                .enumerate()
                .skip(first)
                .take(area.height.saturating_sub(7) as usize)
                .map(|(i, job)| {
                    Line::styled(
                        format!(
                            "{} {} · {} · {}",
                            if i == selected { ">" } else { " " },
                            crate::ui::truncate_cells(job["name"].as_str().unwrap_or("?"), 22),
                            job["state"].as_str().unwrap_or("?"),
                            job["startsAt"].as_str().unwrap_or("unknown time")
                        ),
                        Style::default().fg(TEXT).bg(if i == selected {
                            app.theme.selection()
                        } else {
                            SURFACE
                        }),
                    )
                })
                .collect();
            if lines.is_empty() {
                lines.push(Line::from(
                    "No schedules. Create one with n → F2 → Start at.",
                ));
            }
            if let Some(detail) = app
                .schedules
                .get(selected)
                .and_then(|job| job["result"].as_str())
            {
                lines.push(Line::from(""));
                lines.push(Line::from(detail));
            }
            (
                "Scheduled sessions · host",
                lines,
                "↑↓ move   x cancel pending   r refresh   Enter close",
            )
        }
    };
    frame.render_widget(
        Block::bordered()
            .title(format!(" {title} "))
            .style(Style::default().bg(SURFACE).fg(TEXT))
            .border_style(Style::default().fg(app.theme.accent())),
        area,
    );
    let body = Rect::new(
        area.x + 2,
        area.y + 2,
        area.width.saturating_sub(4),
        area.height.saturating_sub(5),
    );
    frame.render_widget(Paragraph::new(lines), body);
    frame.render_widget(
        Paragraph::new(hint).style(Style::default().fg(MUTED)),
        Rect::new(body.x, area.bottom().saturating_sub(2), body.width, 1),
    );
}

pub fn schedule_identity(jobs: &[Value], selected: usize) -> Option<&str> {
    jobs.get(selected)?.get("id")?.as_str()
}
