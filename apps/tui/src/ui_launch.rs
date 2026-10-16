//! Launch and pairing views, rendered solely from validated client state.
use crate::{
    launch::{Field, Program, SessionForm},
    model::App,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
};

const MUTED: Color = Color::Rgb(165, 177, 169);
const SELECTED: Color = Color::Rgb(35, 42, 37);

pub fn render_form(frame: &mut Frame, app: &App, form: &SessionForm, area: Rect) {
    let directory = if form.cwd.is_empty() {
        app.capabilities
            .as_ref()
            .map_or("Waiting for host workspace…", |caps| {
                caps.workspace.as_str()
            })
    } else {
        &form.cwd
    };
    let group = app
        .group_choices(None)
        .into_iter()
        .find(|(id, _)| id == &form.group_id)
        .map_or_else(|| "Root / ungrouped".to_owned(), |(_, name)| name);
    let mut lines = vec![
        Line::from(Span::styled(
            format!("Group: {group}"),
            Style::default().fg(MUTED),
        )),
        Line::from(""),
        field_line("Name", &form.name, form.field == Field::Name),
        Line::from(""),
        field_line("Folder", directory, form.field == Field::Directory),
        Line::from(Span::styled(
            "Leave folder empty to use the host workspace.",
            Style::default().fg(MUTED),
        )),
        Line::from(""),
        Line::from("Program  (↑/↓ or ←/→ to choose)"),
    ];
    for program in Program::ALL {
        let availability = match &app.capabilities {
            None => "checking…",
            Some(caps) if caps.available(program) => "available",
            Some(_) => "not installed",
        };
        let selected = form.program == program;
        let label = format!(
            " {} {:<10} {availability}",
            if selected { "›" } else { " " },
            program.label()
        );
        lines.push(Line::from(Span::styled(
            label,
            if selected && form.field == Field::Program {
                Style::default().bg(SELECTED)
            } else {
                Style::default().fg(if selected { Color::White } else { MUTED })
            },
        )));
    }
    lines.extend([
        Line::from(""),
        Line::from("Tab: next field   Enter: create   Esc: cancel"),
        Line::from(Span::styled(
            app.notice.as_str(),
            Style::default().fg(MUTED),
        )),
    ]);
    frame.render_widget(Paragraph::new(lines), area);
    let cursor = match form.field {
        Field::Name => Some((&form.name, 6u16, 2u16)),
        Field::Directory => Some((&form.cwd, 8u16, 4u16)),
        Field::Program => None,
    };
    if let Some((value, prefix, row)) = cursor
        && area.height > row
        && area.width > 0
    {
        // Keep the end of a long path visible while editing, without truncating
        // the value sent to the host or performing filesystem work in rendering.
        let full_width = usize::from(prefix) + Line::from(value.as_str()).width();
        let scroll = full_width.saturating_sub(usize::from(area.width - 1));
        if scroll > 0 {
            let label = if form.field == Field::Name {
                "Name"
            } else {
                "Folder"
            };
            frame.render_widget(
                Paragraph::new(field_line(label, value, true))
                    .scroll((0, scroll.min(usize::from(u16::MAX)) as u16)),
                Rect::new(area.x, area.y + row, area.width, 1),
            );
        }
        let offset = (usize::from(prefix) + Line::from(value.as_str()).width())
            .min(usize::from(area.width - 1)) as u16;
        frame.set_cursor_position((area.x + offset, area.y + row));
    }
}

fn field_line<'a>(label: &str, value: &str, focused: bool) -> Line<'a> {
    Line::from(Span::styled(
        format!("{label}: {value}"),
        if focused {
            Style::default().bg(SELECTED)
        } else {
            Style::default()
        },
    ))
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
