//! Launch and pairing views, rendered solely from validated client state.
use crate::{
    launch::{Field, Program, SessionForm},
    model::{App, folder_choices},
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
            (0, "LAUNCH OPTIONS · F2 back to session"),
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
        "Type a name…",
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
    frame.render_widget(
        Paragraph::new("PROGRAM").style(Style::default().fg(MUTED)),
        row(area, 9),
    );
    for (index, program) in Program::ALL.into_iter().enumerate() {
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
    frame.render_widget(
        Paragraph::new("Tab fields · Shift+Tab back · F2 worktree / prompt / schedule")
            .style(Style::default().fg(MUTED)),
        row(area, 15),
    );
    frame.render_widget(
        Paragraph::new(app.notice.as_str()).style(Style::default().fg(MUTED)),
        row(area, 16),
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
