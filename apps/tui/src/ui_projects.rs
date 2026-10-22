use crate::{
    model::App,
    projects::{Load, Project, Projects, SetupView, age},
    theme::{BACKGROUND, BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

const SUBTITLE: &str = "Repositories on this host · pinned first, then recent activity";
const WIDE: u16 = 96;

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn text(frame: &mut Frame, area: Rect, value: &str, color: Color) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(crate::ui::truncate_cells(value, usize::from(area.width)))
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

fn pair(frame: &mut Frame, area: Rect, label: &str, value: &str, color: Color) {
    if area.is_empty() {
        return;
    }
    let label_width = 12.min(area.width);
    text(
        frame,
        Rect::new(area.x, area.y, label_width, 1),
        label,
        MUTED,
    );
    text(
        frame,
        Rect::new(area.x + label_width, area.y, area.width - label_width, 1),
        value,
        color,
    );
}

pub fn render(frame: &mut Frame, app: &App) {
    let (area, footer_area) = crate::ui_jobs::surface(frame, app);
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        area,
    );
    let projects = &app.projects;
    let content = Rect::new(
        area.x + 2.min(area.width / 2),
        area.y,
        area.width.saturating_sub(4),
        area.height,
    );
    let title = match projects
        .detail
        .as_ref()
        .and_then(|root| projects.find(root))
    {
        Some(project) => format!("Projects / {}", project.name),
        None => "Projects".to_owned(),
    };
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(content, 1),
    );
    text(frame, row(content, 2), SUBTITLE, app.theme.accent());
    if !row(content, 3).is_empty() {
        frame.render_widget(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(BORDER)),
            row(content, 3),
        );
    }
    let body = Rect::new(
        content.x,
        content.y + content.height.min(5),
        content.width,
        content.height.saturating_sub(6),
    );
    match &projects.load {
        Load::Idle | Load::Loading => text(
            frame,
            row(body, 1),
            "Loading projects from your host…",
            TEXT,
        ),
        Load::Failed(message) => {
            text(frame, row(body, 1), "Could not load projects", DANGER);
            wrapped(
                frame,
                Rect::new(
                    body.x,
                    body.y + 3.min(body.height),
                    body.width,
                    body.height.saturating_sub(3).min(3),
                ),
                message,
                TEXT,
            );
            text(frame, row(body, 7), "Press r to retry.", MUTED);
        }
        Load::Ready if projects.items.is_empty() => {
            text(frame, row(body, 1), "No projects yet.", TEXT);
            wrapped(
                frame,
                Rect::new(
                    body.x,
                    body.y + 3.min(body.height),
                    body.width,
                    body.height.saturating_sub(3).min(3),
                ),
                "Launch a session inside a Git repository and it appears here with its folders and defaults.",
                MUTED,
            );
        }
        Load::Ready => ready(frame, app, body),
    }
    footer(frame, app, footer_area);
}

fn ready(frame: &mut Frame, app: &App, body: Rect) {
    let projects = &app.projects;
    let detail = projects
        .detail
        .as_ref()
        .and_then(|root| projects.find(root));
    if body.width >= WIDE {
        let list_width = body.width * 11 / 20;
        list(
            frame,
            app,
            Rect::new(body.x, body.y, list_width, body.height),
        );
        let gap = 3;
        let side = Rect::new(
            body.x + list_width + gap,
            body.y,
            body.width.saturating_sub(list_width + gap),
            body.height,
        );
        if let Some(project) = detail.or_else(|| projects.selected_project()) {
            describe(frame, app, side, project);
        }
    } else if let Some(project) = detail {
        describe(frame, app, body, project);
    } else {
        list(frame, app, body);
    }
}

fn list(frame: &mut Frame, app: &App, area: Rect) {
    let projects: &Projects = &app.projects;
    if area.height == 0 {
        return;
    }
    let visible = usize::from(area.height);
    let first = projects.selected.saturating_sub(visible.saturating_sub(1));
    let compact = area.width < 60;
    for (offset, (index, project)) in projects
        .items
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .enumerate()
    {
        let line = row(area, offset as u16);
        let selected = index == projects.selected;
        let filtered = projects
            .filter
            .as_ref()
            .is_some_and(|filter| filter.root == project.root);
        let mut spans = vec![
            Span::styled(
                if selected { "▸ " } else { "  " },
                Style::default().fg(app.theme.accent()),
            ),
            Span::styled(
                if project.pinned { "● " } else { "  " },
                Style::default().fg(WARNING),
            ),
            Span::styled(
                project.name.clone(),
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            ),
        ];
        if !compact && let Some(branch) = &project.default_branch {
            spans.push(Span::styled(
                format!("  {branch}"),
                Style::default().fg(MUTED),
            ));
        }
        spans.push(Span::styled(
            format!("  {} open", project.open_sessions),
            Style::default().fg(if project.open_sessions > 0 {
                SUCCESS
            } else {
                MUTED
            }),
        ));
        spans.push(Span::styled(
            format!("  {}", age(projects.received_ms, project.last_activity_at)),
            Style::default().fg(MUTED),
        ));
        if filtered {
            spans.push(Span::styled(
                "  sidebar",
                Style::default().fg(app.theme.accent()),
            ));
        }
        let mut paragraph = Paragraph::new(Line::from(spans));
        if selected {
            paragraph = paragraph.style(Style::default().bg(app.theme.selection()));
        }
        frame.render_widget(paragraph, line);
    }
}

fn describe(frame: &mut Frame, app: &App, area: Rect, project: &Project) {
    let projects = &app.projects;
    let defaults = projects.defaults.get(&project.root);
    frame.render_widget(
        Paragraph::new(project.name.clone())
            .style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        row(area, 0),
    );
    text(frame, row(area, 1), &project.root, MUTED);
    pair(
        frame,
        row(area, 3),
        "Branch",
        project
            .default_branch
            .as_deref()
            .unwrap_or("not seen in the main checkout"),
        TEXT,
    );
    pair(
        frame,
        row(area, 4),
        "Sessions",
        &format!("{} open", project.open_sessions),
        TEXT,
    );
    pair(
        frame,
        row(area, 5),
        "Activity",
        &age(projects.received_ms, project.last_activity_at),
        TEXT,
    );
    pair(
        frame,
        row(area, 6),
        "Pinned",
        if project.pinned { "yes" } else { "no" },
        TEXT,
    );
    let layout = crate::projects_controller::layout_for(
        app,
        project,
        defaults.and_then(|defaults| defaults.default_layout.as_deref()),
    )
    .map(|layout| layout.name);
    pair(
        frame,
        row(area, 7),
        "Layout",
        layout.as_deref().unwrap_or("none set"),
        TEXT,
    );
    let Some(defaults) = defaults else {
        wrapped(
            frame,
            Rect::new(
                area.x,
                area.y + 9.min(area.height),
                area.width,
                area.height.saturating_sub(9).min(2),
            ),
            "Press w to read the worktree setup and usual launch folder.",
            MUTED,
        );
        return;
    };
    pair(
        frame,
        row(area, 8),
        "Launch in",
        &defaults.launch_folder,
        TEXT,
    );
    let approved = defaults.setup_approved();
    pair(
        frame,
        row(area, 9),
        "Setup",
        defaults.setup_state(),
        if approved { SUCCESS } else { TEXT },
    );
    pair(
        frame,
        row(area, 10),
        "Worktrees",
        &format!("{} open", defaults.open_worktrees()),
        TEXT,
    );
    if let Some(digest) = defaults.digest() {
        pair(
            frame,
            row(area, 11),
            "Digest",
            &digest.chars().take(16).collect::<String>(),
            MUTED,
        );
    }
    for (offset, folder) in defaults.folders.iter().skip(1).take(3).enumerate() {
        pair(
            frame,
            row(area, 12 + offset as u16),
            if offset == 0 { "Also used" } else { "" },
            &format!("{} · {} launches", folder.folder, folder.launches),
            MUTED,
        );
    }
}

fn hints(projects: &Projects) -> Vec<(&'static str, &'static str)> {
    crate::key_table::hints(crate::projects_controller::keys(projects))
}

fn footer(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }
    let mut spans = vec![
        Span::styled(
            " PROJECTS ",
            Style::default()
                .fg(BACKGROUND)
                .bg(app.theme.accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    ];
    for (key, label) in hints(&app.projects) {
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
            crate::ui::truncate_cells(&format!("· {}", app.notice), available - used),
            Style::default().fg(WARNING),
        ));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(Style::default().bg(SURFACE)), area);
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::tests::defaults;
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};

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

    #[test]
    fn projects_view_renders_list_and_details_at_three_sizes() {
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let mut app = crate::projects_controller::tests::loaded();
            app.projects.selected = 1;
            let text = screen(&draw(&app, width, height));
            assert!(text.contains("Projects"), "{width}x{height}\n{text}");
            assert!(text.contains("PROJECTS"), "{width}x{height}\n{text}");
            assert!(text.contains("nesvo"), "{width}x{height}\n{text}");
            assert!(text.contains("1 open"), "{width}x{height}\n{text}");
            assert!(text.contains("●"), "{width}x{height}\n{text}");
            if width >= 150 {
                assert!(text.contains("archive"), "{width}x{height}\n{text}");
                assert!(text.contains("Press w"), "{width}x{height}\n{text}");
            }
            app.projects
                .accept_defaults(&defaults("C:/dev/nesvo", Some("Quad")));
            app.projects.detail = Some("C:/dev/nesvo".into());
            let text = screen(&draw(&app, width, height));
            assert!(
                text.contains("Projects / nesvo"),
                "{width}x{height}\n{text}"
            );
            assert!(
                text.contains("needs approval") && text.contains("2 open"),
                "{width}x{height}\n{text}"
            );
            assert!(
                text.contains("C:/dev/nesvo/apps/tui"),
                "{width}x{height}\n{text}"
            );
            assert!(text.contains("Quad"), "{width}x{height}\n{text}");
        }
    }

    #[test]
    fn projects_view_renders_loading_failure_and_empty_states() {
        let mut app = crate::projects_controller::tests::loaded();
        app.projects.items.clear();
        let text = screen(&draw(&app, 100, 32));
        assert!(text.contains("No projects yet."), "{text}");
        app.projects.load = Load::Failed("Projects require owner authority".into());
        let text = screen(&draw(&app, 80, 24));
        assert!(text.contains("Could not load projects"), "{text}");
        assert!(text.contains("owner authority"), "{text}");
        app.projects.load = Load::Loading;
        let text = screen(&draw(&app, 150, 44));
        assert!(text.contains("Loading projects"), "{text}");
    }
}
