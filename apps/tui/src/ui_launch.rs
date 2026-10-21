//! Launch and pairing views, rendered solely from validated client state.
use crate::{
    launch::{Field, Program, SessionForm},
    model::{App, folder_choices},
    session_kind::SessionKind,
    theme::{BORDER, MUTED, TEXT},
    ui_controls,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Paragraph, Wrap},
};

fn row(area: Rect, index: u16) -> Rect {
    Rect::new(
        area.x,
        area.y + index,
        area.width,
        u16::from(index < area.height),
    )
}

fn input_row(
    frame: &mut Frame,
    area: Rect,
    value: &str,
    focused: bool,
    app: &App,
    placeholder: &str,
) {
    if area.is_empty() {
        return;
    }
    let display = if value.is_empty() { placeholder } else { value };
    let width = usize::from(area.width.saturating_sub(4));
    let visible: String = display
        .chars()
        .rev()
        .take(width)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    frame.render_widget(
        Paragraph::new(format!("  {visible}")).style(
            Style::default()
                .fg(if value.is_empty() { MUTED } else { TEXT })
                .bg(if focused {
                    app.theme.selection()
                } else {
                    BORDER
                }),
        ),
        area,
    );
    if focused && area.width > 2 {
        let cursor_width = if value.is_empty() {
            0
        } else {
            Line::from(visible.as_str()).width()
        };
        frame.set_cursor_position((
            area.x + (2 + cursor_width).min(usize::from(area.width - 1)) as u16,
            area.y,
        ));
    }
}

pub fn render_form(frame: &mut Frame, app: &App, form: &SessionForm, area: Rect) {
    if form.advanced {
        for (offset, label) in [
            (0, "LAUNCH OPTIONS · F2 back · F3 save template"),
            (2, "WORKTREE · new branch from HEAD"),
            (5, "INITIAL PROMPT"),
            (8, "START AT · empty = now"),
            (10, "HH:MM today on host, or RFC3339 with offset"),
            (12, "Host must stay running. Agent permissions still apply."),
            (14, "Tab / Shift+Tab fields · Enter submit · Esc cancel"),
        ] {
            frame.render_widget(
                Paragraph::new(label).style(Style::default().fg(MUTED)),
                row(area, offset),
            );
        }
        input_row(
            frame,
            row(area, 3),
            if form.worktree {
                "[x] Create isolated worktree"
            } else {
                "[ ] Use selected folder"
            },
            form.field == Field::Worktree && app.dialog_button.is_none(),
            app,
            "",
        );
        if form.worktree {
            crate::ui_worktree_actions::render_setup_check(frame, app, row(area, 4));
        }
        input_row(
            frame,
            row(area, 6),
            &form.prompt,
            form.field == Field::Prompt && app.dialog_button.is_none(),
            app,
            "Describe the task…",
        );
        input_row(
            frame,
            row(area, 9),
            &form.when,
            form.field == Field::When && app.dialog_button.is_none(),
            app,
            "Now · or 16:02",
        );
        frame.render_widget(
            Paragraph::new(app.notice.as_str()).style(Style::default().fg(MUTED)),
            row(area, 16),
        );
        return;
    }
    let group = app
        .group_choices(None)
        .into_iter()
        .find(|(id, _)| id == &form.group_id)
        .map_or_else(|| "Root / ungrouped".to_owned(), |(_, name)| name);
    frame.render_widget(
        Paragraph::new(format!("Group  {group}")).style(Style::default().fg(MUTED)),
        row(area, 0),
    );
    frame.render_widget(
        Paragraph::new("NAME").style(Style::default().fg(MUTED)),
        row(area, 2),
    );
    input_row(
        frame,
        row(area, 3),
        &form.name,
        form.field == Field::Name && app.dialog_button.is_none(),
        app,
        if form.program == Program::Shell {
            "Type a name…"
        } else {
            "Optional — auto title from prompt / agent"
        },
    );
    frame.render_widget(
        Paragraph::new("FOLDER").style(Style::default().fg(MUTED)),
        row(area, 5),
    );
    let directory = if form.cwd.is_empty() {
        app.capabilities
            .as_ref()
            .map_or("Waiting for host…", |caps| caps.workspace.as_str())
    } else {
        form.cwd.as_str()
    };
    let max_path = usize::from(area.width.saturating_sub(6));
    let path_tail: String = directory
        .chars()
        .rev()
        .take(max_path)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let path_label = if path_tail.chars().count() < directory.chars().count() {
        format!("…{path_tail}")
    } else {
        path_tail
    };
    frame.render_widget(
        Paragraph::new(format!("  {path_label}  ›")).style(Style::default().fg(TEXT).bg(
            if form.field == Field::Directory && app.dialog_button.is_none() {
                app.theme.selection()
            } else {
                BORDER
            },
        )),
        row(area, 6),
    );
    frame.render_widget(
        Paragraph::new("Enter to browse folders on the host").style(Style::default().fg(MUTED)),
        row(area, 7),
    );
    let programs = form.programs();
    if programs.len() > 1 {
        frame.render_widget(
            Paragraph::new("PROGRAM").style(Style::default().fg(MUTED)),
            row(area, 9),
        );
    } else {
        frame.render_widget(
            Paragraph::new("PROGRAM  Terminal · a plain shell in this folder")
                .style(Style::default().fg(MUTED)),
            row(area, 9),
        );
    }
    if form.kind == Some(SessionKind::Agent) {
        frame.render_widget(
            Paragraph::new("   Coding agents · Clean terminal opens a shell")
                .style(Style::default().fg(MUTED)),
            row(area, 10),
        );
    }
    for (index, program) in Program::ALL
        .into_iter()
        .enumerate()
        .filter(|(_, program)| programs.len() > 1 && programs.contains(program))
    {
        let availability = match &app.capabilities {
            None => "checking…",
            Some(caps) if caps.available(program) => "available",
            Some(_) => "not installed",
        };
        let selected = form.program == program;
        frame.render_widget(
            Paragraph::new(format!(
                " {} {:<10} {availability}",
                if selected { "›" } else { " " },
                program.label()
            ))
            .style(
                Style::default()
                    .fg(if selected { TEXT } else { MUTED })
                    .bg(
                        if selected && form.field == Field::Program && app.dialog_button.is_none() {
                            app.theme.selection()
                        } else {
                            ratatui::style::Color::Reset
                        },
                    )
                    .add_modifier(if selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
            row(area, 10 + index as u16),
        );
    }
    if form.kind == Some(SessionKind::Agent) {
        render_profile(frame, app, form, row(area, 14));
    }
    frame.render_widget(
        Paragraph::new(match form.kind {
            Some(SessionKind::Terminal) => "Tab fields · Shift+Tab back · Enter create",
            Some(_) => "Tab fields · ←→ effort · F2 worktree / prompt / schedule",
            None => "Tab fields · Shift+Tab back · F2 worktree / prompt / schedule",
        })
        .style(Style::default().fg(MUTED)),
        row(area, 15),
    );
    frame.render_widget(
        Paragraph::new(app.notice.as_str()).style(Style::default().fg(MUTED)),
        row(area, 16),
    );
}

fn render_profile(frame: &mut Frame, app: &App, form: &SessionForm, area: Rect) {
    if area.is_empty() {
        return;
    }
    if form.profile_efforts(app.capabilities.as_ref()).is_none() {
        let reason = match &app.capabilities {
            None => "checking the host…",
            Some(caps) if !caps.session_model_profiles => "update the host for model profiles",
            Some(_) => "this provider version has no profile support",
        };
        frame.render_widget(
            Paragraph::new(format!("PROFILE  default · {reason}"))
                .style(Style::default().fg(MUTED)),
            area,
        );
        return;
    }
    let label = 7.min(area.width);
    let effort = format!(
        "  EFFORT ‹ {} ›",
        if form.effort.is_empty() {
            "default"
        } else {
            form.effort.as_str()
        }
    );
    let effort_width = (Line::from(effort.as_str()).width() as u16).min(area.width - label);
    let input_width = area.width - label - effort_width;
    frame.render_widget(
        Paragraph::new("MODEL").style(Style::default().fg(MUTED)),
        Rect::new(area.x, area.y, label, 1),
    );
    input_row(
        frame,
        Rect::new(area.x + label, area.y, input_width, 1),
        &form.model,
        form.field == Field::Model && app.dialog_button.is_none(),
        app,
        "default",
    );
    let focused = form.field == Field::Effort && app.dialog_button.is_none();
    frame.render_widget(
        Paragraph::new(effort).style(Style::default().fg(if focused { TEXT } else { MUTED }).bg(
            if focused {
                app.theme.selection()
            } else {
                ratatui::style::Color::Reset
            },
        )),
        Rect::new(area.x + label + input_width, area.y, effort_width, 1),
    );
}

pub fn render_folder_picker(frame: &mut Frame, app: &App, area: Rect) {
    let Some(crate::model::Dialog::FolderPicker {
        path,
        parent,
        entries,
        query,
        selected,
        loading,
        ..
    }) = &app.dialog
    else {
        return;
    };
    frame.render_widget(
        Paragraph::new(path.as_str()).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(area, 0),
    );
    frame.render_widget(
        Paragraph::new(if *loading {
            "Loading folders…"
        } else {
            "↑↓ highlight  ·  Enter choose  ·  → open  ·  ← parent  ·  F2 current"
        })
        .style(Style::default().fg(MUTED)),
        row(area, 1),
    );
    frame.render_widget(
        Paragraph::new(format!(
            "Search  {}",
            if query.is_empty() {
                "Type to filter…"
            } else {
                query
            }
        ))
        .style(
            Style::default()
                .fg(if query.is_empty() { MUTED } else { TEXT })
                .bg(app.theme.selection()),
        ),
        row(area, 2),
    );
    let visible = area.height.saturating_sub(5);
    let offset = ui_controls::move_offset(*selected, visible);
    let choices = folder_choices(parent, entries, query);
    let count = choices.len();
    for (index, choice) in choices
        .iter()
        .enumerate()
        .skip(offset)
        .take(usize::from(visible))
    {
        let label = if query.is_empty() && parent.is_some() && index == 0 {
            choice.0.to_owned()
        } else {
            format!("▸  {}", choice.0)
        };
        let focused = app.dialog_button.is_none() && *selected == index;
        frame.render_widget(
            Paragraph::new(format!("{} {label}", if focused { "›" } else { " " })).style(
                Style::default()
                    .fg(if focused { TEXT } else { MUTED })
                    .bg(if focused {
                        app.theme.selection()
                    } else {
                        ratatui::style::Color::Reset
                    }),
            ),
            row(area, 4 + (index - offset) as u16),
        );
    }
    if count == 0 && !*loading {
        frame.render_widget(
            Paragraph::new(if query.is_empty() {
                "No subfolders here. F2 chooses this folder."
            } else {
                "No matching folders. Backspace edits the search."
            })
            .style(Style::default().fg(MUTED)),
            row(area, 4),
        );
    }
}

pub fn render_pairing(frame: &mut Frame, app: &App, area: Rect) {
    frame.render_widget(
        Paragraph::new(vec![
            Line::from("1. Open this private QR image on the host computer:"),
            Line::from(app.pairing_qr_path.as_str()),
            Line::from(""),
            Line::from("2. In the mobile app choose Connect host, then scan it."),
            Line::from("   The phone must reach the host's LAN or private VPN address."),
            Line::from(""),
            Line::from("If the QR image is missing, use the private pairing file:"),
            Line::from(app.pairing_path.as_str()),
            Line::from(""),
            Line::from("Pairing grants access to the host's sessions. Keep it private."),
            Line::from("Esc: return"),
        ])
        .wrap(Wrap { trim: false }),
        area,
    );
}

#[cfg(test)]
mod tests {
    use crate::{
        launch::{Field, Program},
        model::{App, Dialog},
        session_kind::SessionKind,
    };
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
    use serde_json::json;

    fn app(profiles: bool) -> App {
        let mut app = App::new(9);
        app.event(json!({"type":"capabilities","workspace":"C:/work","programs":[
            {"id":"shell","available":true},{"id":"claude","available":true},
            {"id":"codex","available":true},{"id":"gemini","available":false}
        ],"sessionModelProfiles":profiles,"launchProfileSupport":[
            {"program":"claude","supported":true,"effortValues":["low","medium","high","xhigh","max"],"effortSource":"cli"},
            {"program":"gemini","supported":false}
        ]}))
        .unwrap();
        app.dialog = None;
        app.onboarded = true;
        app
    }

    fn text(app: &App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        let buffer: &Buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn open(app: &mut App, kind: SessionKind, program: Program) {
        let mut form = kind.preset(None, program, ["Terminal 1"]).unwrap();
        form.field = Field::Model;
        form.model = "opus".into();
        form.effort = "high".into();
        app.dialog = Some(Dialog::NewSession(form));
    }

    #[test]
    fn launch_agent_form_shows_profile_only_when_supported() {
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut supported = app(true);
            open(&mut supported, SessionKind::Agent, Program::Claude);
            let screen = text(&supported, width, height);
            assert!(
                screen.contains("New agent session"),
                "{width}x{height}\n{screen}"
            );
            assert!(screen.contains("MODEL"), "{width}x{height}\n{screen}");
            assert!(screen.contains("opus"));
            assert!(screen.contains("EFFORT ‹ high ›"));
            assert!(screen.contains("Claude"));
            assert!(screen.contains("Codex"));
            assert!(!screen.contains("Terminal   "), "{screen}");
            let mut gemini = app(true);
            open(&mut gemini, SessionKind::Agent, Program::Gemini);
            let screen = text(&gemini, width, height);
            assert!(!screen.contains("MODEL"), "{screen}");
            assert!(screen.contains("PROFILE  default"), "{screen}");
            let mut legacy = app(false);
            open(&mut legacy, SessionKind::Agent, Program::Claude);
            let screen = text(&legacy, width, height);
            assert!(!screen.contains("MODEL"));
            assert!(screen.contains("update the host for model profiles"));
        }
    }

    #[test]
    fn launch_terminal_form_hides_programs_and_prefills_name() {
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut app = app(true);
            open(&mut app, SessionKind::Terminal, Program::Claude);
            let screen = text(&app, width, height);
            assert!(screen.contains("New terminal"), "{screen}");
            assert!(screen.contains("Terminal 2"), "{screen}");
            assert!(screen.contains("a plain shell in this folder"));
            assert!(!screen.contains("Claude"), "{screen}");
            assert!(!screen.contains("MODEL"));
            assert!(!screen.contains("F2 worktree"));
            app.dialog = Some(Dialog::NewSession(crate::launch::SessionForm {
                field: Field::Program,
                ..Default::default()
            }));
            let screen = text(&app, width, height);
            assert!(screen.contains("New session"));
            assert!(screen.contains("Terminal   "), "{screen}");
            assert!(!screen.contains("MODEL"));
        }
    }
}
