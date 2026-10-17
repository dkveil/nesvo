//! Read-only review state and rendering. All repository I/O belongs to the host.
use crate::{
    model::App,
    theme::{BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::Style,
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
        .title(format!(" Changes · {} ", SCOPES[state.scope]))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(if state.focused {
            app.theme.accent()
        } else {
            BORDER
        }));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [files, content, footer] = Layout::vertical([
        Constraint::Length((state.data.files.len() as u16).clamp(1, 5)),
        Constraint::Min(0),
        Constraint::Length(3),
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
    let message = if state.request_id.is_some() && state.data.files.is_empty() {
        Some("Loading changes…")
    } else if let Some(error) = &state.error {
        Some(error.as_str())
    } else if state.data.files.is_empty() {
        Some("No changes in this scope.")
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
            frame.render_widget(
                Paragraph::new(lines.iter().map(|line| styled(line)).collect::<Vec<_>>())
                    .scroll((state.scroll, 0)),
                content,
            );
        }
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::from("↑↓ file  ←→ hunk  Space fold"),
            Line::from("PgUp/PgDn scroll · r refresh · Tab focus"),
            Line::from(if state.data.truncated {
                "Partial · c scope · e expand · Esc close"
            } else {
                "c scope · s split · e expand · Esc close"
            }),
        ])
        .style(Style::default().fg(MUTED)),
        footer,
    );
}

fn styled(text: &str) -> Line<'_> {
    let color = if text.starts_with('+') {
        SUCCESS
    } else if text.starts_with('-') {
        DANGER
    } else {
        TEXT
    };
    Line::from(Span::styled(text, Style::default().fg(color)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asymmetric_edits_keep_following_context_aligned() {
        let rows = aligned(&[" context", "-a", "-b", "+c", " tail"]);
        assert_eq!(rows[2], ("-b".into(), "".into()));
        assert_eq!(rows[3], (" tail".into(), " tail".into()));
    }
}
