//! Launch and pairing views, rendered solely from validated client state.
use crate::{
    launch::{Field, Program, SessionForm},
    model::App,
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

fn input_row(frame: &mut Frame, area: Rect, value: &str, focused: bool, app: &App) {
    if area.is_empty() {
        return;
    }
    let display = if value.is_empty() {
        "Type a name…"
    } else {
        value
    };
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
        Paragraph::new("↑/↓ fields & choices   Tab next   Shift+Tab previous   Enter select")
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
            "Enter opens a folder · use the button below to choose this path"
        })
        .style(Style::default().fg(MUTED)),
        row(area, 1),
    );
    let visible = area.height.saturating_sub(4);
    let offset = ui_controls::move_offset(*selected, visible);
    let count = entries.len() + usize::from(parent.is_some());
    for index in offset..count.min(offset + usize::from(visible)) {
        let label = if parent.is_some() && index == 0 {
            "..  Parent folder".to_owned()
        } else {
            let entry = &entries[index - usize::from(parent.is_some())];
            format!("▸  {}", entry.name)
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
            row(area, 3 + (index - offset) as u16),
        );
    }
    if count == 0 && !*loading {
        frame.render_widget(
            Paragraph::new("No subfolders here.").style(Style::default().fg(MUTED)),
            row(area, 3),
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
