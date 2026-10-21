use crate::{
    model::App,
    review_comments::Side,
    review_session::{
        DiffRow, Input, Pane, ReviewTab, RowKind, SPLIT_COLUMNS, Scope, Tone, split_pairs,
    },
    theme::{BORDER, DANGER, MUTED, SUCCESS, SURFACE, TEXT, WARNING},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};

pub const TAB_MARKER: &str = "◆";
pub const TAB_MARKER_ASCII: &str = "R";
const WIDE_LIST: u16 = 70;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hit {
    File(usize),
    Row(usize),
    Inside,
}

pub struct Areas {
    pub header: Rect,
    pub files: Rect,
    pub diff: Rect,
    pub status: Rect,
    pub keys: Rect,
}

pub fn tab_label(app: &App, tab: &ReviewTab) -> String {
    let marker = if app.ascii_icons {
        TAB_MARKER_ASCII
    } else {
        TAB_MARKER
    };
    format!("{marker} {}", tab.label)
}

pub fn areas(area: Rect, tab: &ReviewTab) -> Areas {
    let inner = Block::bordered().inner(area);
    let [header, body, status, keys] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(0),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner);
    let (files, diff) = if inner.width >= WIDE_LIST {
        let width = (inner.width / 4).clamp(24, 44);
        let [files, _, diff] = Layout::horizontal([
            Constraint::Length(width),
            Constraint::Length(1),
            Constraint::Min(0),
        ])
        .areas(body);
        (files, diff)
    } else {
        let height = (tab.files().len().max(1) as u16)
            .min(4)
            .min(body.height / 3)
            .max(1);
        let [files, diff] =
            Layout::vertical([Constraint::Length(height), Constraint::Min(0)]).areas(body);
        (files, diff)
    };
    Areas {
        header,
        files,
        diff,
        status,
        keys,
    }
}

pub fn split_active(area: Rect, tab: &ReviewTab) -> bool {
    tab.view.split && area.width >= SPLIT_COLUMNS
}

pub fn page(area: Rect, tab: &ReviewTab) -> usize {
    usize::from(areas(area, tab).diff.height).max(1)
}

pub fn content_area(app: &App, area: Rect) -> Rect {
    if area.is_empty() {
        return Rect::default();
    }
    app.reviews
        .active()
        .map_or_else(Rect::default, |tab| areas(area, tab).diff)
}

fn file_top(tab: &ReviewTab, height: u16) -> usize {
    tab.view
        .file
        .saturating_sub(usize::from(height.saturating_sub(1)))
}

pub fn hit(tab: &ReviewTab, area: Rect, column: u16, row: u16) -> Option<Hit> {
    if !area.contains((column, row).into()) {
        return None;
    }
    let areas = areas(area, tab);
    if areas.files.contains((column, row).into()) {
        let index = file_top(tab, areas.files.height) + usize::from(row - areas.files.y);
        return Some(if index < tab.files().len() {
            Hit::File(index)
        } else {
            Hit::Inside
        });
    }
    if areas.diff.contains((column, row).into()) && !tab.current_rows().is_empty() {
        let offset = usize::from(row - areas.diff.y);
        if split_active(area, tab) {
            let rows = tab.current_rows();
            let pairs = split_pairs(&rows);
            let cursor = cursor_pair(&pairs, tab.view.cursor);
            let top = top_for(cursor, tab.view.scroll, usize::from(areas.diff.height));
            return Some(
                pairs
                    .get(top + offset)
                    .and_then(|(left, right)| right.or(*left))
                    .map_or(Hit::Inside, Hit::Row),
            );
        }
        return Some(Hit::Row(
            tab.visible_top(usize::from(areas.diff.height)) + offset,
        ));
    }
    Some(Hit::Inside)
}

fn top_for(cursor: usize, scroll: usize, height: usize) -> usize {
    let height = height.max(1);
    if cursor < scroll {
        cursor
    } else if cursor >= scroll + height {
        cursor + 1 - height
    } else {
        scroll
    }
}

fn cursor_pair(pairs: &[(Option<usize>, Option<usize>)], cursor: usize) -> usize {
    pairs
        .iter()
        .position(|(left, right)| *left == Some(cursor) || *right == Some(cursor))
        .unwrap_or(0)
}

fn short(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

fn stage_label(stage: Option<&str>) -> &'static str {
    match stage {
        Some("metadata") => "reading the pull request",
        Some("fetch") => "fetching the head",
        Some("checkout") => "checking out",
        _ => "starting",
    }
}

fn blocker_label(tab: &ReviewTab, code: &str) -> String {
    match code {
        "unborn" => "no commits".into(),
        "conflicts" => "conflicts".into(),
        "baseConflicts" => "conflicts with base".into(),
        "dirty" => "uncommitted changes".into(),
        "behindBase" => match tab
            .context
            .as_ref()
            .and_then(|context| context.readiness.base.as_ref())
        {
            Some(base) => format!("behind base by {}", base.behind),
            None => "behind base".into(),
        },
        "behindUpstream" => "behind upstream".into(),
        "unpushed" => "unpushed".into(),
        other => other.into(),
    }
}

fn source_line(tab: &ReviewTab, accent: Color) -> Line<'static> {
    if tab.is_opening() {
        return Line::styled(
            format!(
                "Opening {} · {}…",
                tab.label,
                stage_label(tab.stage.as_deref())
            ),
            Style::default().fg(WARNING),
        );
    }
    let Some(opened) = &tab.opened else {
        return Line::styled(
            tab.error
                .clone()
                .unwrap_or_else(|| "Review is not open on the host.".into()),
            Style::default().fg(DANGER),
        );
    };
    let mut spans = vec![Span::styled(
        tab.scope.label().to_owned(),
        Style::default().fg(accent).add_modifier(Modifier::BOLD),
    )];
    if let Some(title) = opened.source["title"].as_str() {
        spans.push(Span::styled(
            format!(" · {title}"),
            Style::default().fg(TEXT),
        ));
    }
    let base = match (tab.scope, &opened.base) {
        (Scope::Branch, Some(base)) if tab.base.is_none() => {
            format!("{}@{}", base.name, short(&base.oid))
        }
        _ => tab.base_label().unwrap_or_else(|| "default".into()),
    };
    let head = match (&opened.head.name, &opened.head.oid) {
        (Some(name), Some(oid)) => format!("{name}@{}", short(oid)),
        (None, Some(oid)) => short(oid).to_owned(),
        (Some(name), None) => name.clone(),
        (None, None) => "unborn".into(),
    };
    spans.push(Span::styled(
        format!(" · {base} → {head}"),
        Style::default().fg(MUTED),
    ));
    if let Some(revision) = tab.revision.as_ref().or(Some(&opened.revision)) {
        spans.push(Span::styled(
            format!(" · rev {}", revision.get(..12).unwrap_or(revision)),
            Style::default().fg(MUTED),
        ));
    }
    Line::from(spans)
}

fn readiness_line(tab: &ReviewTab) -> Line<'static> {
    let mut spans = Vec::new();
    match &tab.context {
        None => spans.push(Span::styled(
            "Readiness pending".to_owned(),
            Style::default().fg(MUTED),
        )),
        Some(context) => {
            let readiness = &context.readiness;
            if readiness.ready {
                spans.push(Span::styled(
                    "✓ ready".to_owned(),
                    Style::default().fg(SUCCESS),
                ));
            } else {
                let blockers: Vec<String> = readiness
                    .blockers
                    .iter()
                    .map(|code| blocker_label(tab, code))
                    .collect();
                spans.push(Span::styled(
                    if blockers.is_empty() {
                        "not ready".to_owned()
                    } else {
                        format!("not ready: {}", blockers.join(", "))
                    },
                    Style::default().fg(WARNING),
                ));
            }
            if let Some(branch) = &readiness.branch {
                spans.push(Span::styled(
                    format!(" · on {branch}"),
                    Style::default().fg(MUTED),
                ));
            }
            let checks = context
                .checks
                .as_ref()
                .or_else(|| tab.opened.as_ref().and_then(|o| o.checks.as_ref()));
            if let Some(checks) = checks {
                let stale = if checks.current == Some(false) {
                    " (older head)"
                } else {
                    ""
                };
                spans.push(Span::styled(
                    format!(
                        " · checks {}/{} passed, {} failed, {} pending{stale}",
                        checks.passed, checks.total, checks.failed, checks.pending
                    ),
                    Style::default().fg(if checks.failed > 0 { DANGER } else { MUTED }),
                ));
            }
            match context
                .provenance
                .as_ref()
                .map(|p| (p.evidence.as_str(), p.truncated))
            {
                Some(("hooks", truncated)) => spans.push(Span::styled(
                    format!(
                        " · edits: hook evidence{}",
                        if truncated { ", partial" } else { "" }
                    ),
                    Style::default().fg(MUTED),
                )),
                Some(("unavailable", _)) => spans.push(Span::styled(
                    " · edits: no hook evidence".to_owned(),
                    Style::default().fg(MUTED),
                )),
                _ => {}
            }
        }
    }
    let count = tab.comments.comments.len();
    if count > 0 {
        let drifted = tab.comments.drifted();
        spans.push(Span::styled(
            format!(
                " · {count} comment{}{}",
                if count == 1 { "" } else { "s" },
                if drifted > 0 {
                    format!(", {drifted} drifted")
                } else {
                    String::new()
                }
            ),
            Style::default().fg(if drifted > 0 { WARNING } else { MUTED }),
        ));
    }
    Line::from(spans)
}

pub fn provenance_marker(attribution: Option<&str>) -> &'static str {
    match attribution {
        Some("agent") => "A",
        Some("otherAgent") => "O",
        Some("uncertain") => "?",
        Some(_) => "·",
        None => " ",
    }
}

fn render_files(frame: &mut Frame, app: &App, tab: &ReviewTab, area: Rect, focused: bool) {
    let files = tab.files();
    if files.is_empty() {
        let message = if tab.is_loading() || tab.is_opening() {
            "Loading changes…"
        } else if tab.scope == Scope::Turn {
            "No verified agent edits this turn."
        } else {
            "No changes in this scope."
        };
        frame.render_widget(
            Paragraph::new(message).style(Style::default().fg(MUTED)),
            area,
        );
        return;
    }
    let top = file_top(tab, area.height);
    for (offset, (index, file)) in files
        .iter()
        .enumerate()
        .skip(top)
        .take(usize::from(area.height))
        .enumerate()
    {
        let selected = index == tab.view.file;
        let provenance = tab.provenance(&file.path);
        let marker = provenance_marker(provenance.map(|p| p.attribution.as_str()));
        let comments = tab.comment_counts(&file.path);
        let base = if selected && focused && tab.view.pane == Pane::Files {
            Style::default().bg(app.theme.selection()).fg(TEXT)
        } else if selected {
            Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(MUTED)
        };
        let mut spans = vec![
            Span::styled(if selected { "›" } else { " " }, base),
            Span::styled(
                marker,
                base.fg(if provenance.is_some_and(|p| p.this_turn) {
                    app.theme.accent()
                } else {
                    MUTED
                }),
            ),
            Span::styled(format!(" {} ", file.status), base),
            Span::styled(file.path.clone(), base),
            Span::styled(format!(" +{}", file.additions), base.fg(SUCCESS)),
            Span::styled(format!(" −{}", file.deletions), base.fg(DANGER)),
        ];
        if comments > 0 {
            spans.push(Span::styled(
                format!(" ●{comments}"),
                base.fg(app.theme.accent()),
            ));
        }
        if file.truncated {
            spans.push(Span::styled(" partial", base.fg(MUTED)));
        }
        let row = Rect::new(area.x, area.y + offset as u16, area.width, 1);
        frame.render_widget(Block::default().style(base), row);
        frame.render_widget(Paragraph::new(Line::from(spans)), row);
    }
}

fn tint(color: Color) -> Color {
    match (SURFACE, color) {
        (Color::Rgb(r, g, b), Color::Rgb(cr, cg, cb)) => Color::Rgb(
            ((u16::from(r) * 7 + u16::from(cr)) / 8) as u8,
            ((u16::from(g) * 7 + u16::from(cg)) / 8) as u8,
            ((u16::from(b) * 7 + u16::from(cb)) / 8) as u8,
        ),
        _ => SURFACE,
    }
}

fn row_colors(row: &DiffRow) -> (Color, Color, &'static str) {
    match row.kind {
        RowKind::Added => (Color::Rgb(105, 245, 145), tint(SUCCESS), "+"),
        RowKind::Removed => (Color::Rgb(255, 110, 130), tint(DANGER), "-"),
        RowKind::Context => (TEXT, SURFACE, " "),
        RowKind::Hunk => (TEXT, BORDER, ""),
        RowKind::Meta => (MUTED, SURFACE, ""),
    }
}

fn number(value: Option<usize>) -> String {
    value.map_or_else(String::new, |n| n.to_string())
}

fn marker(tab: &ReviewTab, row: &DiffRow) -> (&'static str, Option<bool>) {
    match tab.comment_at(row) {
        Some(comment) if comment.drifted => ("◌", Some(true)),
        Some(_) => ("●", Some(false)),
        None => (" ", None),
    }
}

struct RowStyle {
    background: Color,
    selected: bool,
}

fn row_style(app: &App, tab: &ReviewTab, index: usize, row: &DiffRow, focused: bool) -> RowStyle {
    let (_, background, _) = row_colors(row);
    let (start, end) = tab.selection();
    let cursor = index == tab.view.cursor && tab.view.pane == Pane::Diff;
    let ranged = tab.view.anchor.is_some() && (start..=end).contains(&index);
    RowStyle {
        background: if cursor && focused {
            app.theme.selection()
        } else if ranged || cursor {
            BORDER
        } else {
            background
        },
        selected: cursor,
    }
}

fn unified_line(
    app: &App,
    tab: &ReviewTab,
    index: usize,
    row: &DiffRow,
    focused: bool,
) -> (Vec<Span<'static>>, Style, String) {
    let (color, _, sign) = row_colors(row);
    let style = row_style(app, tab, index, row, focused);
    let (mark, drifted) = marker(tab, row);
    let gutter = if matches!(row.kind, RowKind::Hunk | RowKind::Meta) {
        vec![Span::styled(
            "              ".to_owned(),
            Style::default().fg(MUTED),
        )]
    } else {
        vec![
            Span::styled(
                mark,
                Style::default().fg(if drifted == Some(true) {
                    WARNING
                } else {
                    app.theme.accent()
                }),
            ),
            Span::styled(
                format!("{:>5} {:>5} │ ", number(row.old), number(row.new)),
                Style::default().fg(MUTED),
            ),
        ]
    };
    let text_style =
        Style::default()
            .fg(color)
            .add_modifier(if row.kind == RowKind::Hunk || style.selected {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
    (
        gutter,
        Style::default().bg(style.background).patch(text_style),
        format!("{sign}{}", row.text),
    )
}

fn chunks(text: &str, width: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || width == 0 {
        return vec![String::new()];
    }
    chars.chunks(width).map(|c| c.iter().collect()).collect()
}

fn render_unified(
    frame: &mut Frame,
    app: &App,
    tab: &ReviewTab,
    rows: &[DiffRow],
    area: Rect,
    focused: bool,
) {
    let top = tab.visible_top(usize::from(area.height));
    let mut y = area.y;
    for (index, row) in rows.iter().enumerate().skip(top) {
        if y >= area.bottom() {
            break;
        }
        let (gutter, style, text) = unified_line(app, tab, index, row, focused);
        let gutter_width = Line::from(gutter.clone()).width();
        let room = usize::from(area.width).saturating_sub(gutter_width).max(1);
        let pieces = if tab.view.wrap {
            chunks(&text, room)
        } else {
            vec![text]
        };
        for (part, piece) in pieces.into_iter().enumerate() {
            if y >= area.bottom() {
                break;
            }
            let line_area = Rect::new(area.x, y, area.width, 1);
            let mut spans = if part == 0 {
                gutter.clone()
            } else {
                vec![Span::raw(" ".repeat(gutter_width))]
            };
            spans.push(Span::styled(piece, style));
            frame.render_widget(
                Block::default().style(Style::default().bg(style.bg.unwrap_or(SURFACE))),
                line_area,
            );
            frame.render_widget(Paragraph::new(Line::from(spans)), line_area);
            y += 1;
        }
    }
}

fn half(
    app: &App,
    tab: &ReviewTab,
    rows: &[DiffRow],
    index: Option<usize>,
    side: Side,
    focused: bool,
) -> (Line<'static>, Color) {
    let Some(row) = index.and_then(|index| rows.get(index).map(|row| (index, row))) else {
        return (Line::from(""), SURFACE);
    };
    let (index, row) = row;
    let (color, _, sign) = row_colors(row);
    let style = row_style(app, tab, index, row, focused);
    if matches!(row.kind, RowKind::Hunk | RowKind::Meta) {
        return (
            Line::styled(row.text.clone(), Style::default().fg(color)),
            style.background,
        );
    }
    let (mark, drifted) = if row.line(side).is_some() {
        marker(tab, row)
    } else {
        (" ", None)
    };
    (
        Line::from(vec![
            Span::styled(
                mark,
                Style::default().fg(if drifted == Some(true) {
                    WARNING
                } else {
                    app.theme.accent()
                }),
            ),
            Span::styled(
                format!("{:>5} │ ", number(row.line(side))),
                Style::default().fg(MUTED),
            ),
            Span::styled(format!("{sign}{}", row.text), Style::default().fg(color)),
        ]),
        style.background,
    )
}

fn render_split(
    frame: &mut Frame,
    app: &App,
    tab: &ReviewTab,
    rows: &[DiffRow],
    area: Rect,
    focused: bool,
) {
    let pairs = split_pairs(rows);
    let cursor = cursor_pair(&pairs, tab.view.cursor);
    let top = top_for(cursor, tab.view.scroll, usize::from(area.height));
    let [left, divider, right] = Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(area);
    for (offset, (old, new)) in pairs
        .iter()
        .skip(top)
        .take(usize::from(area.height))
        .enumerate()
    {
        let y = area.y + offset as u16;
        for (column, index, side) in [(left, *old, Side::Old), (right, *new, Side::New)] {
            let (line, background) = half(app, tab, rows, index, side, focused);
            let cell = Rect::new(column.x, y, column.width, 1);
            frame.render_widget(
                Block::default().style(Style::default().bg(background)),
                cell,
            );
            frame.render_widget(Paragraph::new(line), cell);
        }
        frame.render_widget(
            Paragraph::new("│").style(Style::default().fg(BORDER)),
            Rect::new(divider.x, y, 1, 1),
        );
    }
}

fn tail(text: &str, width: usize) -> String {
    let last = text.rsplit('\n').next().unwrap_or_default();
    let count = last.chars().count();
    let lines = text.matches('\n').count();
    let prefix = if lines > 0 {
        format!("[{} lines] ", lines + 1)
    } else {
        String::new()
    };
    let room = width.saturating_sub(prefix.chars().count() + 1);
    let visible: String = last.chars().skip(count.saturating_sub(room)).collect();
    format!("{prefix}{visible}▏")
}

fn status_line(tab: &ReviewTab, width: u16, accent: Color) -> Line<'static> {
    let width = usize::from(width);
    if let Some(input) = &tab.input {
        let (label, text) = match input {
            Input::Comment { anchor, id, text } => (
                format!(
                    "{} {} › ",
                    if id.is_some() { "Edit" } else { "Comment" },
                    anchor.location()
                ),
                text.as_str(),
            ),
            Input::Summary(text) => ("Summary › ".into(), text.as_str()),
            Input::Search(text) => ("/ ".into(), text.as_str()),
            Input::Base(text) => ("Base (empty = default) › ".into(), text.as_str()),
        };
        let room = width.saturating_sub(label.chars().count());
        return Line::from(vec![
            Span::styled(
                label,
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ),
            Span::styled(tail(text, room), Style::default().fg(TEXT)),
        ]);
    }
    if let Some(status) = &tab.status {
        let color = match status.tone {
            Tone::Info => TEXT,
            Tone::Success => SUCCESS,
            Tone::Warning => WARNING,
            Tone::Danger => DANGER,
        };
        return Line::styled(status.text.clone(), Style::default().fg(color));
    }
    if let Some(error) = tab.error.as_ref().filter(|_| tab.opened.is_some()) {
        return Line::styled(error.clone(), Style::default().fg(DANGER));
    }
    let rows = tab.current_rows();
    if let Some(comment) = rows
        .get(tab.view.cursor)
        .and_then(|row| tab.comment_at(row))
    {
        return Line::from(vec![
            Span::styled(
                format!("● {}: ", comment.anchor.location()),
                Style::default().fg(accent),
            ),
            Span::styled(
                comment.text.lines().next().unwrap_or_default().to_owned(),
                Style::default().fg(TEXT),
            ),
        ]);
    }
    let files = tab.files();
    let additions: usize = files.iter().map(|f| f.additions).sum();
    let deletions: usize = files.iter().map(|f| f.deletions).sum();
    Line::styled(
        format!(
            "{} files · +{additions} −{deletions}{}",
            files.len(),
            if tab.data.truncated {
                " · partial"
            } else {
                ""
            }
        ),
        Style::default().fg(MUTED),
    )
}

fn key_items(tab: &ReviewTab) -> &'static [&'static str] {
    if tab.input.is_some() {
        &["Enter save", "Ctrl+J newline", "Esc cancel"]
    } else if tab.list.is_some() {
        &["j/k move", "Enter jump", "e edit", "d delete", "Esc close"]
    } else {
        &[
            "j/k move",
            "]/[ change",
            "f/F file",
            "Tab pane",
            "v select",
            "c comment",
            "s send",
            "l list",
            "u/b/t scope",
            "| split",
            "r refresh",
            "q close",
        ]
    }
}

fn render_list(frame: &mut Frame, app: &App, tab: &ReviewTab, area: Rect) {
    let Some(selected) = tab.list else {
        return;
    };
    let count = tab.comments.comments.len() as u16;
    let width = area.width.min(90);
    let height = (count + 2).min(area.height);
    if width < 10 || height < 3 {
        return;
    }
    let popup = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    let block = Block::bordered()
        .title(" Comments ")
        .border_style(Style::default().fg(app.theme.accent()))
        .style(Style::default().bg(SURFACE).fg(TEXT));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let top = selected.saturating_sub(usize::from(inner.height.saturating_sub(1)));
    for (offset, (index, comment)) in tab
        .comments
        .comments
        .iter()
        .enumerate()
        .skip(top)
        .take(usize::from(inner.height))
        .enumerate()
    {
        let style = if index == selected {
            Style::default().bg(app.theme.selection()).fg(TEXT)
        } else {
            Style::default().fg(MUTED)
        };
        let row = Rect::new(inner.x, inner.y + offset as u16, inner.width, 1);
        frame.render_widget(Block::default().style(style), row);
        frame.render_widget(
            Paragraph::new(format!(
                "{}. {}{} — {}",
                index + 1,
                comment.anchor.location(),
                if comment.drifted { " (drifted)" } else { "" },
                comment.text.lines().next().unwrap_or_default()
            ))
            .style(style),
            row,
        );
    }
}

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let Some(tab) = app.reviews.active() else {
        return;
    };
    if area.width < 4 || area.height < 4 {
        return;
    }
    let focused = app.reviews.focused;
    let accent = app.theme.accent();
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(format!(" Review · {} ", tab.label))
        .style(Style::default().bg(SURFACE).fg(TEXT))
        .border_style(Style::default().fg(if focused { accent } else { BORDER }));
    frame.render_widget(block, area);
    let areas = areas(area, tab);
    frame.render_widget(
        Paragraph::new(vec![source_line(tab, accent), readiness_line(tab)]),
        areas.header,
    );
    render_files(frame, app, tab, areas.files, focused);
    let rows = tab.current_rows();
    if rows.is_empty() {
        let message = match &tab.error {
            Some(error) => error.clone(),
            None if tab.is_opening() => "Waiting for the host to open this review…".into(),
            None if tab.is_loading() => "Loading changes…".into(),
            None if tab.current_file().is_some() => "No textual changes in this file.".into(),
            None => "Nothing to review in this scope; u, b and t switch scope.".into(),
        };
        frame.render_widget(
            Paragraph::new(message)
                .style(Style::default().fg(if tab.error.is_some() { DANGER } else { MUTED }))
                .wrap(ratatui::widgets::Wrap { trim: true }),
            areas.diff,
        );
    } else if split_active(area, tab) {
        render_split(frame, app, tab, &rows, areas.diff, focused);
    } else {
        render_unified(frame, app, tab, &rows, areas.diff, focused);
    }
    frame.render_widget(
        Paragraph::new(status_line(tab, areas.status.width, accent)),
        areas.status,
    );
    let keys = crate::ui::shortcut_lines(key_items(tab), areas.keys.width);
    frame.render_widget(
        Paragraph::new(keys.into_iter().next().unwrap_or_default()),
        areas.keys,
    );
    let body = Rect::new(
        areas.files.x.min(areas.diff.x),
        areas.files.y.min(areas.diff.y),
        areas.header.width,
        areas
            .status
            .y
            .saturating_sub(areas.files.y.min(areas.diff.y)),
    );
    render_list(frame, app, tab, body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_session::{self, Source};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn reviewed_app() -> App {
        let mut app = App::new(5);
        app.onboarded = true;
        app.event(json!({"type":"capabilities","workspace":"/w","gitDiff":true,"reviews":true,"programs":[]}))
            .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s","name":"Agent","cwd":"/w","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.activate_session("s");
        app.mode = crate::model::Mode::Navigate;
        let open = review_session::open(&mut app, Source::Local("s".into()));
        let get = app
            .event(
                json!({"type":"reviewOpened","requestId":open[0]["requestId"],"reviewId":"local-7",
                "directory":"/w","source":{"kind":"local","sessionId":"s","context":"Automatic"},
                "base":{"ref":"main","oid":"0123456789abcdef","mergeBase":"0123456"},
                "head":{"ref":"topic","oid":"fedcba9876543210"},"scope":"branch","revision":"r0",
                "checks":null}),
            )
            .unwrap();
        let context = app
            .event(json!({"type":"diff","sessionId":null,"reviewId":"local-7","requestId":get[0]["requestId"],
                "review":{"directory":"/w","scope":"branch","revision":"tree12345678-hash","head":"fedcba9","files":[
                    {"path":"src/a.rs","status":"M","patch":"@@ -1,3 +1,3 @@\n fn main() {\n-    old();\n+    new();\n }","additions":1,"deletions":1,"truncated":false},
                    {"path":"README.md","status":"A","patch":"@@ -0,0 +1 @@\n+hello","additions":1,"deletions":0,"truncated":false}
                ],"truncated":false}}))
            .unwrap();
        app.event(json!({"type":"reviewContext","requestId":context[0]["requestId"],"reviewId":"local-7",
            "directory":"/w","readiness":{"blockers":["dirty","unpushed"],"ready":false,"branch":"topic"},
            "provenance":{"evidence":"hooks","files":[
                {"path":"src/a.rs","attribution":"agent","thisTurn":true},
                {"path":"README.md","attribution":"unattributed","thisTurn":false}],"truncated":false},
            "checks":null}))
        .unwrap();
        let tab = app.reviews.active_mut().unwrap();
        tab.comments
            .add(
                crate::review_comments::Anchor {
                    path: "src/a.rs".into(),
                    side: crate::review_comments::Side::New,
                    start: 2,
                    end: 2,
                    snippet: "    new();".into(),
                    revision: "tree12345678-hash".into(),
                },
                "Explain new",
            )
            .unwrap();
        tab.view.pane = Pane::Diff;
        tab.view.cursor = 3;
        app
    }

    fn screen(app: &App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn review_session_renders_header_files_diff_and_footer_at_three_sizes() {
        let app = reviewed_app();
        for (width, height) in [(80, 24), (100, 32), (150, 44)] {
            let text = screen(&app, width, height);
            assert!(text.contains("Review · Agent"), "{width}x{height}\n{text}");
            assert!(text.contains("◆ Agent"), "{width}x{height}\n{text}");
            assert!(text.contains("src/a.rs"), "{width}x{height}\n{text}");
            assert!(text.contains("new();"), "{width}x{height}\n{text}");
            assert!(text.contains("●"), "{width}x{height}\n{text}");
            assert!(text.contains("branch"), "{width}x{height}\n{text}");
            assert!(text.contains("REVIEW"), "{width}x{height}\n{text}");
            assert!(text.contains("not ready"), "{width}x{height}\n{text}");
            assert!(
                !text.contains("Loading terminal"),
                "{width}x{height}\n{text}"
            );
        }
        let wide = screen(&app, 150, 44);
        assert!(wide.contains("main@0123456 → topic@fedcba9"), "{wide}");
        assert!(wide.contains("uncommitted changes, unpushed"), "{wide}");
        assert!(wide.contains("›A M src/a.rs"), "{wide}");
        assert!(
            wide.contains(" · A README.md") || wide.contains("·A README.md"),
            "{wide}"
        );
        assert!(wide.contains("● src/a.rs:2: Explain new"), "{wide}");
    }

    #[test]
    fn review_session_renders_side_by_side_from_137_columns_and_lists_comments() {
        let mut app = reviewed_app();
        let draw = |app: &App, width: u16| {
            let mut terminal = Terminal::new(TestBackend::new(width, 30)).unwrap();
            terminal
                .draw(|frame| render(frame, app, Rect::new(0, 0, width, 30)))
                .unwrap();
            let buffer = terminal.backend().buffer().clone();
            (0..30)
                .map(|y| {
                    (0..width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        };
        let split = draw(&app, 160);
        assert!(
            split
                .iter()
                .any(|row| row.contains("-    old();") && row.contains("+    new();")),
            "{}",
            split.join("\n")
        );
        let unified = draw(&app, 136);
        assert!(
            !unified
                .iter()
                .any(|row| row.contains("-    old();") && row.contains("+    new();"))
        );
        app.reviews.active_mut().unwrap().list = Some(0);
        let listed = draw(&app, 136).join("\n");
        assert!(listed.contains(" Comments "), "{listed}");
        assert!(listed.contains("1. src/a.rs:2 — Explain new"), "{listed}");
        let tab = app.reviews.active_mut().unwrap();
        tab.list = None;
        tab.input = Some(crate::review_session::Input::Search("needle".into()));
        let searching = draw(&app, 136).join("\n");
        assert!(searching.contains("/ needle▏"), "{searching}");
    }

    #[test]
    fn review_leaf_of_a_layout_hosts_the_review_beside_the_agent() {
        let mut app = reviewed_app();
        let layout = crate::layouts::shipped()
            .into_iter()
            .find(|layout| layout.name == "Agent + Review")
            .unwrap();
        app.set_pane_layout(layout.tree.clone());
        app.panes[0] = Some("s".into());
        let area = Rect::new(0, 0, 150, 44);
        let geometry = crate::ui::geometry(area, &app);
        assert!(geometry.review.width > 0 && geometry.panes[0].width > 0);
        assert!(geometry.review.x > geometry.panes[0].x);
        let text = screen(&app, 150, 44);
        assert!(text.contains("Review · Agent"), "{text}");
        let hit = hit(
            app.reviews.active().unwrap(),
            geometry.review,
            areas(geometry.review, app.reviews.active().unwrap())
                .files
                .x
                + 2,
            areas(geometry.review, app.reviews.active().unwrap())
                .files
                .y
                + 1,
        );
        assert_eq!(hit, Some(Hit::File(1)));
        let narrow = crate::ui::geometry(Rect::new(0, 0, 100, 32), &app);
        assert!(narrow.panes[0].width == 0 && narrow.review.width > 0);
    }
}
