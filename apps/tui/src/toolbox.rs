//! Small modal workflows with exclusive keyboard and pointer focus.
use crate::{
    controller::Outcome,
    model::{App, Session},
    status::{Source, State},
    theme::{SURFACE, TEXT},
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
    Themes(usize, crate::theme::Theme),
    Onboarding(usize),
    Shortcuts(usize, bool),
    Recipes(bool, usize),
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
    if let Some(attention) = &session.current_attention
        && attention.priority > 0
    {
        return match attention.reason.as_deref() {
            Some("startup" | "failure") => 5,
            Some("question") => 4,
            _ => 3,
        };
    }
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
                Overlay::Themes(_, original) if row < crate::theme::Theme::ALL.len() => {
                    app.theme = crate::theme::Theme::ALL[row];
                    app.overlay = Some(Overlay::Themes(row, original));
                    return outcome;
                }
                Overlay::Shortcuts(_, false) if row < 5 => {
                    app.overlay = Some(Overlay::Shortcuts(row, false));
                    KeyCode::Enter
                }
                Overlay::Filters(_) if row < FILTERS.len() => {
                    app.overlay = Some(Overlay::Filters(row));
                    KeyCode::Char(' ')
                }
                Overlay::Recipes(recovery, selected)
                    if row < panel.height.saturating_sub(7) as usize =>
                {
                    let count = if recovery {
                        app.recoveries.len()
                    } else {
                        app.templates.len()
                    };
                    let first = selected.saturating_sub(panel.height.saturating_sub(8) as usize);
                    app.overlay = Some(Overlay::Recipes(
                        recovery,
                        (first + row).min(count.saturating_sub(1)),
                    ));
                    return outcome;
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
        if let Overlay::Themes(_, original) = overlay {
            app.theme = original;
        }
        app.overlay = None;
        return outcome;
    }
    match app.overlay {
        Some(Overlay::Themes(selected, original)) => {
            let count = crate::theme::Theme::ALL.len();
            let next = match code {
                KeyCode::Up | KeyCode::BackTab => selected.saturating_sub(1),
                KeyCode::Down | KeyCode::Tab => (selected + 1).min(count - 1),
                KeyCode::Enter => {
                    app.overlay = None;
                    return outcome;
                }
                _ => selected,
            };
            app.theme = crate::theme::Theme::ALL[next];
            app.overlay = Some(Overlay::Themes(next, original));
        }

        Some(Overlay::Recipes(recovery, selected)) => {
            let rows = if recovery {
                &app.recoveries
            } else {
                &app.templates
            };
            match code {
                KeyCode::Up | KeyCode::BackTab => {
                    app.overlay = Some(Overlay::Recipes(recovery, selected.saturating_sub(1)))
                }
                KeyCode::Down | KeyCode::Tab => {
                    app.overlay = Some(Overlay::Recipes(
                        recovery,
                        (selected + 1).min(rows.len().saturating_sub(1)),
                    ))
                }
                KeyCode::Char(']') if recovery => {
                    if let Some(offset) = app.recovery_next {
                        outcome
                            .commands
                            .push(json!({"type":"listRecovery","offset":offset}));
                    }
                }
                KeyCode::Char('r') => outcome
                    .commands
                    .push(json!({"type":if recovery {"listRecovery"} else {"listTemplates"}})),
                KeyCode::Char('e') if recovery => {
                    if let Some(row) = rows.get(selected).cloned() {
                        resume_conversation(app, &row);
                    }
                }
                KeyCode::Enter | KeyCode::Char('c') => {
                    if code == KeyCode::Char('c') && !recovery {
                        return outcome;
                    }
                    let resume = code == KeyCode::Char('c');
                    if let Some(row) = rows.get(selected).cloned() {
                        if resume
                            && !matches!(row["spec"]["program"].as_str(), Some("claude" | "codex"))
                        {
                            app.notice =
                                "Conversation picker is available for Claude and Codex.".into();
                            return outcome;
                        }
                        app.overlay = None;
                        if recovery {
                            if row["state"] != "saved" {
                                app.notice = "Interrupted restart: inspect live sessions before forgetting this record.".into();
                            } else {
                                app.dialog = Some(crate::model::Dialog::Confirm {
                                title: "Restart saved session?".into(),
                                detail: if resume { "Starts the provider conversation picker in the saved folder. Choose the conversation explicitly." } else { "Starts a new process in the saved folder. Old prompts and conversations are not replayed." }.into(),
                                command:json!({"type":"restoreSession","id":row["id"],"resume":resume})
                            });
                                app.dialog_button = Some(1);
                            }
                        } else {
                            let spec = &row["spec"];
                            app.dialog = Some(crate::model::Dialog::NewSession(
                                crate::launch::SessionForm {
                                    name: spec["name"].as_str().unwrap_or_default().into(),
                                    cwd: spec["cwd"].as_str().unwrap_or_default().into(),
                                    prompt: spec["prompt"].as_str().unwrap_or_default().into(),
                                    program: serde_json::from_value(spec["program"].clone())
                                        .unwrap_or_default(),
                                    worktree: spec["worktree"].as_bool().unwrap_or(false),
                                    group_id: spec["groupId"]
                                        .as_str()
                                        .filter(|id| app.groups.iter().any(|g| g.id == *id))
                                        .map(str::to_owned),
                                    ..Default::default()
                                },
                            ));
                            app.dialog_button = None;
                        }
                    }
                }
                KeyCode::Char('x') => {
                    if let Some(row) = rows.get(selected) {
                        app.dialog = Some(crate::model::Dialog::Confirm {
                        title: if recovery { "Forget saved session?" } else { "Delete template?" }.into(),
                        detail: "Removes only this saved description. Running processes and files remain untouched.".into(),
                        command:json!({"type":if recovery {"forgetRecovery"} else {"deleteTemplate"},"id":row["id"]})
                    });
                        app.dialog_button = Some(1);
                        app.overlay = None;
                    }
                }
                _ => {}
            }
        }
        Some(Overlay::Shortcuts(selected, capturing)) => match code {
            KeyCode::F(key) if capturing => {
                if app.shortcuts.assign(selected, key) {
                    app.overlay = Some(Overlay::Shortcuts(selected, false));
                    app.notice.clear();
                } else {
                    app.notice = "Choose an unused F3–F12 key. F1/F2 are reserved.".into();
                }
            }
            KeyCode::Enter => app.overlay = Some(Overlay::Shortcuts(selected, true)),
            KeyCode::Up if !capturing => {
                app.overlay = Some(Overlay::Shortcuts(selected.saturating_sub(1), false))
            }
            KeyCode::Down if !capturing => {
                app.overlay = Some(Overlay::Shortcuts((selected + 1).min(4), false))
            }
            KeyCode::Char('r') if !capturing => app.shortcuts = Default::default(),
            _ => {}
        },
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
        Overlay::Themes(selected, _) => (
            "Appearance",
            crate::theme::Theme::ALL
                .iter()
                .enumerate()
                .map(|(index, theme)| {
                    Line::styled(
                        format!("  {}", theme.label()),
                        if index == selected {
                            Style::default().fg(TEXT).bg(theme.selection())
                        } else {
                            Style::default().fg(theme.accent())
                        },
                    )
                })
                .collect(),
            "↑↓ preview   Enter apply   Esc cancel",
        ),
        Overlay::Recipes(recovery, selected) => {
            let rows = if recovery {
                &app.recoveries
            } else {
                &app.templates
            };
            let first = selected.saturating_sub(area.height.saturating_sub(8) as usize);
            let mut lines: Vec<Line> = rows
                .iter()
                .enumerate()
                .skip(first)
                .take(area.height.saturating_sub(7) as usize)
                .map(|(i, row)| {
                    let name = if recovery {
                        &row["spec"]["name"]
                    } else {
                        &row["name"]
                    };
                    Line::styled(
                        format!(
                            "{} {} · {}",
                            if i == selected { ">" } else { " " },
                            name.as_str().unwrap_or("?"),
                            if recovery {
                                row["state"].as_str().unwrap_or("?")
                            } else {
                                row["spec"]["program"].as_str().unwrap_or("?")
                            }
                        ),
                        Style::default().fg(TEXT).bg(if i == selected {
                            app.theme.selection()
                        } else {
                            SURFACE
                        }),
                    )
                })
                .collect();
            if rows.is_empty() {
                lines.push(Line::from(if recovery {
                    "No saved sessions from previous host runs."
                } else {
                    "No templates. In New session press F3 to save one."
                }));
            }
            if let Some(row) = rows.get(selected) {
                lines.push(Line::from(
                    row["spec"]["cwd"]
                        .as_str()
                        .filter(|path| !path.is_empty())
                        .unwrap_or("Host workspace"),
                ));
                if recovery && let Some(label) = conversation_row(row) {
                    lines.push(Line::from(label));
                }
            }
            lines.push(Line::from(app.notice.as_str()));
            (
                if recovery {
                    "Restore sessions · new processes"
                } else {
                    "Launch templates · host"
                },
                lines,
                if recovery {
                    "Enter restart · e resume conversation · c conversations · x forget · ] next · r first · Esc"
                } else {
                    "↑↓ select · Enter edit · x delete · r refresh · Esc close"
                },
            )
        }
        Overlay::Shortcuts(selected, capturing) => {
            let mut lines: Vec<Line> = crate::shortcuts::LABELS
                .iter()
                .enumerate()
                .map(|(i, label)| {
                    Line::styled(
                        format!(
                            "{} F{:<2}  {label}",
                            if selected == i { ">" } else { " " },
                            app.shortcuts.keys[i]
                        ),
                        Style::default().fg(TEXT).bg(if selected == i {
                            app.theme.selection()
                        } else {
                            SURFACE
                        }),
                    )
                })
                .collect();
            lines.extend([
                Line::from(""),
                Line::from("Terminal: Ctrl+Q navigation · Esc belongs to the agent"),
                Line::from("Navigation: n new · / search · f filters · u mute"),
                Line::from("Review: arrows files/hunks · Space fold · r refresh"),
                Line::from(app.notice.as_str()),
            ]);
            (
                "Keyboard shortcuts · global actions",
                lines,
                if capturing {
                    "Press an unused F3–F12 key · Esc close"
                } else {
                    "↑↓ select · Enter rebind · r defaults · Esc settings"
                },
            )
        }
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
                        "F4 Read-only Git review   F6 Previous · F7 Attention",
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
                        "F8 Templates · F9 Restore · S Scheduled · H This guide",
                        "Missing quota data is shown as unavailable.",
                    ],
                ),
            ];
            let (title, lines) = &pages[step];
            (
                *title,
                lines
                    .iter()
                    .map(|line| Line::from(app.shortcuts.hints(line)))
                    .collect(),
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
        Paragraph::new(Line::from(crate::ui::shortcut_spans(hint))),
        Rect::new(body.x, area.bottom().saturating_sub(2), body.width, 1),
    );
}

pub fn schedule_identity(jobs: &[Value], selected: usize) -> Option<&str> {
    jobs.get(selected)?.get("id")?.as_str()
}

fn recorded_conversation(row: &Value) -> Option<&str> {
    row["spec"]["resume"]["conversationId"]
        .as_str()
        .filter(|id| !id.is_empty())
}

fn conversation_row(row: &Value) -> Option<String> {
    let id = recorded_conversation(row)?;
    Some(if row["spec"]["program"] == "gemini" {
        "Resume conversation: not supported for Gemini".to_owned()
    } else {
        format!("Resume conversation {id}")
    })
}

fn resume_conversation(app: &mut App, row: &Value) {
    let Some(id) = recorded_conversation(row) else {
        app.notice = "No provider conversation was recorded for this session.".into();
        return;
    };
    if row["spec"]["program"] == "gemini" {
        app.notice = "Gemini cannot resume an exact conversation; Enter starts a new one.".into();
        return;
    }
    if row["state"] != "saved" {
        app.notice =
            "Interrupted restart: inspect live sessions before forgetting this record.".into();
        return;
    }
    app.overlay = None;
    app.dialog = Some(crate::model::Dialog::Confirm {
        title: "Resume conversation?".into(),
        detail: format!(
            "Starts the provider in the saved folder with conversation {id}. Nothing is sent until the provider confirms that exact conversation; otherwise the session is marked resume failed."
        ),
        command: json!({"type":"restoreSession","id":row["id"],"exact":true}),
    });
    app.dialog_button = Some(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn app(program: &str, resume: bool) -> App {
        let mut app = App::new(1);
        let mut spec = json!({"name":"Prior session","cwd":"/repo","program":program});
        if resume {
            spec["resume"] = json!({"provider":program,"conversationId":ID});
        }
        app.recoveries = vec![json!({"id":"old","state":"saved","spec":spec})];
        app.overlay = Some(Overlay::Recipes(true, 0));
        app
    }
    fn press(app: &mut App, code: KeyCode) -> Outcome {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        )
    }
    fn screen(app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(150, 44)).unwrap();
        terminal.draw(|frame| render(frame, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn toolbox_recovery_offers_resume_conversation_only_for_a_recorded_id() {
        let mut app = app("claude", true);
        assert!(screen(&app).contains(&format!("Resume conversation {ID}")));
        assert!(press(&mut app, KeyCode::Char('e')).commands.is_empty());
        assert!(matches!(
            &app.dialog,
            Some(crate::model::Dialog::Confirm { command, .. })
                if command == &json!({"type":"restoreSession","id":"old","exact":true})
        ));
        assert_eq!(app.dialog_button, Some(1));

        let mut plain = super::tests::app("codex", false);
        assert!(!screen(&plain).contains("Resume conversation"));
        press(&mut plain, KeyCode::Char('e'));
        assert!(plain.dialog.is_none());
        assert!(plain.notice.contains("No provider conversation"));
    }

    #[test]
    fn toolbox_recovery_explains_that_gemini_cannot_resume_a_conversation() {
        let mut app = app("gemini", true);
        assert!(screen(&app).contains("not supported for Gemini"));
        press(&mut app, KeyCode::Char('e'));
        assert!(app.dialog.is_none());
        assert!(app.notice.contains("Gemini"));
    }
}
