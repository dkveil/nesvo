//! Read-only review state and rendering. All repository I/O belongs to the host.
use crate::{
    model::App,
    theme::{BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Default, Deserialize)]
pub struct ReviewData {
    pub files: Vec<FileDiff>,
    pub truncated: bool,
}
#[derive(Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub patch: String,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
}
#[derive(Default)]
pub struct ReviewState {
    pub return_to_input: bool,
    pub width: u16,
    pub directory: Option<String>,
    pub last_requested: Option<std::time::Instant>,
    pub visible: bool,
    pub focused: bool,
    pub expanded: bool,
    pub side_by_side: bool,
    pub scope: usize,
    pub session_id: String,
    pub request_id: Option<String>,
    pub data: ReviewData,
    pub error: Option<String>,
    pub file: usize,
    pub hunk: usize,
    pub scroll: u16,
    pub folded: HashSet<(String, usize)>,
}
pub const SCOPES: [&str; 3] = ["unstaged", "staged", "untracked"];

impl ReviewState {
    pub fn accept(&mut self, data: ReviewData) {
        let path = self.data.files.get(self.file).map(|f| &f.path);
        self.file = path
            .and_then(|path| data.files.iter().position(|f| &f.path == path))
            .unwrap_or(0);
        self.data = data;
        self.request_id = None;
    }
    pub fn toggle_hunk(&mut self) {
        if let Some(file) = self.data.files.get(self.file) {
            let key = (file.path.clone(), self.hunk);
            if !self.folded.remove(&key) {
                self.folded.insert(key);
            }
        }
    }
}

/// Pair adjacent deletion/addition runs, then resume shared context on one row.
pub fn aligned(lines: &[&str]) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].starts_with('-') || lines[index].starts_with('+') {
            let mut left = Vec::new();
            let mut right = Vec::new();
            while index < lines.len()
                && (lines[index].starts_with('-') || lines[index].starts_with('+'))
            {
                if lines[index].starts_with('-') {
                    left.push(lines[index]);
                } else {
                    right.push(lines[index]);
                }
                index += 1;
            }
            for i in 0..left.len().max(right.len()) {
                rows.push((
                    left.get(i).copied().unwrap_or_default().into(),
                    right.get(i).copied().unwrap_or_default().into(),
                ));
            }
        } else {
            rows.push((lines[index].into(), lines[index].into()));
            index += 1;
        }
    }
    rows
}

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }
    let state = &app.review;
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(format!(
            " Changes · {}{} ",
            SCOPES[state.scope],
            if state.data.truncated {
                " · partial"
            } else {
                ""
            }
        ))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(if state.focused {
            app.theme.accent()
        } else {
            BORDER
        }));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let shortcuts = crate::ui::shortcut_lines(
        &[
            "↑↓ file",
            "←→ hunk",
            "Space fold",
            "PgUp/PgDn scroll",
            "r refresh",
            "y copy",
            "o folder",
            "c scope",
            "[] width",
            "s split",
            "e expand",
            "Esc close",
        ],
        inner.width,
    );
    let [files, heading, content, footer] = Layout::vertical([
        Constraint::Length((state.data.files.len() as u16).clamp(1, 5)),
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(shortcuts.len() as u16),
    ])
    .areas(inner);
    let first = state
        .file
        .saturating_sub(files.height.saturating_sub(1) as usize);
    for (offset, (index, file)) in state
        .data
        .files
        .iter()
        .enumerate()
        .skip(first)
        .take(files.height as usize)
        .enumerate()
    {
        let style = if index == state.file {
            Style::default().bg(app.theme.selection()).fg(TEXT)
        } else {
            Style::default().fg(MUTED)
        };
        frame.render_widget(
            Paragraph::new(format!(
                "{} {} {}  +{} -{}{}",
                if index == state.file { ">" } else { " " },
                file.status,
                file.path,
                file.additions,
                file.deletions,
                if file.truncated { " (partial)" } else { "" }
            ))
            .style(style),
            Rect::new(files.x, files.y + offset as u16, files.width, 1),
        );
    }
    let folder = state
        .directory
        .as_deref()
        .or_else(|| app.active_session().map(|s| s.cwd.as_str()))
        .unwrap_or("No session");
    frame.render_widget(
        Paragraph::new(format!(" {folder}  [o] folder")).style(Style::default().fg(MUTED)),
        Rect::new(heading.x, heading.y, heading.width, heading.height.min(1)),
    );
    let heading = Rect::new(
        heading.x,
        heading.y + heading.height.min(1),
        heading.width,
        heading.height.saturating_sub(1),
    );
    if let Some(file) = state.data.files.get(state.file) {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!(" {} ", file.path),
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" +{} ", file.additions),
                    Style::default().fg(SUCCESS),
                ),
                Span::styled(format!(" −{}", file.deletions), Style::default().fg(DANGER)),
                Span::styled(
                    if file.truncated { " · partial" } else { "" },
                    Style::default().fg(MUTED),
                ),
            ]))
            .block(
                Block::default()
                    .borders(ratatui::widgets::Borders::BOTTOM)
                    .border_style(Style::default().fg(BORDER)),
            ),
            heading,
        );
    }
    let message = if state.request_id.is_some() && state.data.files.is_empty() {
        Some("Loading changes…")
    } else if let Some(error) = &state.error {
        Some(error.as_str())
    } else if state.data.files.is_empty() {
        Some(
            "No changes in this folder / scope.
 o change folder · c change scope",
        )
    } else {
        None
    };
    if let Some(message) = message {
        frame.render_widget(
            Paragraph::new(message).style(Style::default().fg(MUTED)),
            content,
        );
    } else if let Some(file) = state.data.files.get(state.file) {
        let mut hunk = 0usize;
        let mut seen = false;
        let mut hidden = false;
        let mut lines = Vec::new();
        for line in file.patch.lines() {
            if line.starts_with("@@") {
                if seen {
                    hunk += 1;
                }
                seen = true;
                hidden = state.folded.contains(&(file.path.clone(), hunk));
                lines.push(format!(
                    "{} {}{}",
                    if hunk == state.hunk { ">" } else { " " },
                    line,
                    if hidden { " [folded]" } else { "" }
                ));
            } else if !hidden {
                lines.push(line.to_owned());
            }
        }
        if state.side_by_side && content.width >= 100 {
            let [left, right] =
                Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
                    .areas(content);
            let refs: Vec<_> = lines.iter().map(String::as_str).collect();
            let pairs = aligned(&refs);
            frame.render_widget(
                Paragraph::new(pairs.iter().map(|(l, _)| styled(l)).collect::<Vec<_>>())
                    .scroll((state.scroll, 0)),
                left,
            );
            frame.render_widget(
                Paragraph::new(pairs.iter().map(|(_, r)| styled(r)).collect::<Vec<_>>())
                    .scroll((state.scroll, 0)),
                right,
            );
        } else {
            for (offset, line) in unified_lines(file, state, app.theme.selection())
                .into_iter()
                .skip(state.scroll as usize)
                .take(content.height as usize)
                .enumerate()
            {
                let row = Rect::new(content.x, content.y + offset as u16, content.width, 1);
                frame.render_widget(Block::default().style(line.style), row);
                frame.render_widget(Paragraph::new(line), row);
            }
        }
    }
    frame.render_widget(Paragraph::new(shortcuts), footer);
}

fn tint(color: Color) -> Color {
    match (SURFACE, color) {
        (Color::Rgb(r, g, b), Color::Rgb(cr, cg, cb)) => Color::Rgb(
            ((r as u16 * 7 + cr as u16) / 8) as u8,
            ((g as u16 * 7 + cg as u16) / 8) as u8,
            ((b as u16 * 7 + cb as u16) / 8) as u8,
        ),
        _ => SURFACE,
    }
}

fn unified_lines(file: &FileDiff, state: &ReviewState, selection: Color) -> Vec<Line<'static>> {
    let mut rows = Vec::new();
    let mut old = 0usize;
    let mut new = 0usize;
    let mut hunk = 0usize;
    let mut seen = false;
    let mut hidden = false;
    let has_hunks = file.patch.contains("@@ ");
    for text in file.patch.lines() {
        if text.starts_with("@@ ") {
            if seen {
                hunk += 1;
            }
            seen = true;
            let mut parts = text.split_whitespace().skip(1);
            let number = |part: Option<&str>| {
                part.and_then(|p| p.get(1..))
                    .and_then(|p| p.split(',').next())
                    .and_then(|n| n.parse::<usize>().ok())
                    .unwrap_or(0)
            };
            old = number(parts.next());
            new = number(parts.next());
            hidden = state.folded.contains(&(file.path.clone(), hunk));
            rows.push(Line::styled(
                format!(
                    " {}  {}{}",
                    if hidden { "+" } else { "−" },
                    text,
                    if hidden { "  folded" } else { "" }
                ),
                Style::default()
                    .fg(TEXT)
                    .bg(if hunk == state.hunk {
                        selection
                    } else {
                        BORDER
                    })
                    .add_modifier(Modifier::BOLD),
            ));
            continue;
        }
        if !seen {
            if !has_hunks {
                rows.push(Line::styled(text.to_owned(), Style::default().fg(MUTED)));
            }
            continue;
        }
        let (left, right, color, background) = match text.as_bytes().first() {
            Some(b'-') => {
                let n = old;
                old += 1;
                (
                    n.to_string(),
                    String::new(),
                    Color::Rgb(255, 110, 130),
                    tint(DANGER),
                )
            }
            Some(b'+') => {
                let n = new;
                new += 1;
                (
                    String::new(),
                    n.to_string(),
                    Color::Rgb(105, 245, 145),
                    tint(SUCCESS),
                )
            }
            Some(b' ') => {
                let a = old;
                let b = new;
                old += 1;
                new += 1;
                (a.to_string(), b.to_string(), TEXT, SURFACE)
            }
            _ => (String::new(), String::new(), MUTED, SURFACE),
        };
        if !hidden {
            rows.push(
                Line::from(vec![
                    Span::styled(
                        format!("{left:>5} {right:>5} │ "),
                        Style::default().fg(MUTED),
                    ),
                    Span::styled(text.to_owned(), Style::default().fg(color)),
                ])
                .style(Style::default().bg(background)),
            );
        }
    }
    rows
}

fn styled(text: &str) -> Line<'_> {
    let color = if text.starts_with('+') {
        Color::Rgb(105, 245, 145)
    } else if text.starts_with('-') {
        Color::Rgb(255, 110, 130)
    } else {
        TEXT
    };
    Line::from(Span::styled(text, Style::default().fg(color))).style(Style::default().bg(
        if text.starts_with(['+', '-']) {
            tint(if text.starts_with('+') {
                SUCCESS
            } else {
                DANGER
            })
        } else {
            SURFACE
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unified_gutters_follow_edits_and_folded_hunks() {
        let file = FileDiff { path: "a.rs".into(), status: "M".into(), patch: "diff --git a/a.rs b/a.rs\n@@ -10,2 +20,2 @@\n-old\n+new\n context\n@@ -30 +40 @@\n-next\n+last".into(), additions: 2, deletions: 2, truncated: false };
        let mut state = ReviewState::default();
        let text = |rows: Vec<Line<'static>>| {
            rows.into_iter()
                .map(|r| {
                    r.spans
                        .into_iter()
                        .map(|s| s.content.into_owned())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        };
        let rows = text(unified_lines(&file, &state, BORDER));
        assert!(rows[1].starts_with("   10       │ -old"));
        assert!(rows[2].starts_with("         20 │ +new"));
        assert!(rows[3].starts_with("   11    21 │  context"));
        state.folded.insert(("a.rs".into(), 0));
        let rows = text(unified_lines(&file, &state, BORDER));
        assert!(rows[0].contains("folded"));
        assert!(rows[2].contains("30       │ -next"));
    }

    #[test]
    fn asymmetric_edits_keep_following_context_aligned() {
        let rows = aligned(&[" context", "-a", "-b", "+c", " tail"]);
        assert_eq!(rows[2], ("-b".into(), "".into()));
        assert_eq!(rows[3], (" tail".into(), " tail".into()));
    }
}
