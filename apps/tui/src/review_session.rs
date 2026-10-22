use crate::{
    model::{App, Mode},
    review::{FileDiff, ReviewData},
    review_comments::{self, Anchor, Comments, Side},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nesvo_wire::views::{
    self, HostError, ReplyHeader,
    review::{
        DeliverReview, DeliveryPath, DiffReply, OpenReview, OpenedScope, ProvenanceFile,
        ReviewContext, ReviewContextRequest, ReviewDelivered, ReviewDiffRequest, ReviewOpened,
        ReviewProgress, ReviewSource, ReviewSourceKind,
    },
};
use ratatui::layout::Rect;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const SPLIT_COLUMNS: u16 = 137;
pub const DOCK_COLUMNS: u16 = 88;
const REFRESH: Duration = Duration::from_secs(5);
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const OPEN_TIMEOUT: Duration = Duration::from_secs(150);
const MAX_TABS: usize = 16;
const INPUT_CHARS: usize = 4000;
const LINE_INPUT_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewAction {
    Down,
    Up,
    NextChange,
    PrevChange,
    NextFile,
    PrevFile,
    PageDown,
    PageUp,
    HalfDown,
    HalfUp,
    SwitchPane,
    Search,
    Wrap,
    Split,
    ScopeUncommitted,
    ScopeBranch,
    ScopeTurn,
    BasePick,
    Select,
    Comment,
    Edit,
    Delete,
    NextComment,
    PrevComment,
    List,
    Send,
    Copy,
    Refresh,
    Summary,
    Close,
    Back,
}

const NONE: KeyModifiers = KeyModifiers::NONE;
const CONTROL: KeyModifiers = KeyModifiers::CONTROL;

pub const BINDINGS: &[(KeyCode, KeyModifiers, ReviewAction)] = &[
    (KeyCode::Char('j'), NONE, ReviewAction::Down),
    (KeyCode::Down, NONE, ReviewAction::Down),
    (KeyCode::Char('k'), NONE, ReviewAction::Up),
    (KeyCode::Up, NONE, ReviewAction::Up),
    (KeyCode::Char(']'), NONE, ReviewAction::NextChange),
    (KeyCode::Char('['), NONE, ReviewAction::PrevChange),
    (KeyCode::Char('f'), NONE, ReviewAction::NextFile),
    (KeyCode::Char('F'), NONE, ReviewAction::PrevFile),
    (KeyCode::PageDown, NONE, ReviewAction::PageDown),
    (KeyCode::PageUp, NONE, ReviewAction::PageUp),
    (KeyCode::Char('d'), CONTROL, ReviewAction::HalfDown),
    (KeyCode::Char('u'), CONTROL, ReviewAction::HalfUp),
    (KeyCode::Tab, NONE, ReviewAction::SwitchPane),
    (KeyCode::Char('/'), NONE, ReviewAction::Search),
    (KeyCode::Char('w'), NONE, ReviewAction::Wrap),
    (KeyCode::Char('|'), NONE, ReviewAction::Split),
    (KeyCode::Char('u'), NONE, ReviewAction::ScopeUncommitted),
    (KeyCode::Char('b'), NONE, ReviewAction::ScopeBranch),
    (KeyCode::Char('t'), NONE, ReviewAction::ScopeTurn),
    (KeyCode::Char('B'), NONE, ReviewAction::BasePick),
    (KeyCode::Char('v'), NONE, ReviewAction::Select),
    (KeyCode::Char('c'), NONE, ReviewAction::Comment),
    (KeyCode::Char('e'), NONE, ReviewAction::Edit),
    (KeyCode::Char('d'), NONE, ReviewAction::Delete),
    (KeyCode::Char('n'), NONE, ReviewAction::NextComment),
    (KeyCode::Char('N'), NONE, ReviewAction::PrevComment),
    (KeyCode::Char('l'), NONE, ReviewAction::List),
    (KeyCode::Char('s'), NONE, ReviewAction::Send),
    (KeyCode::Char('y'), NONE, ReviewAction::Copy),
    (KeyCode::Char('r'), NONE, ReviewAction::Refresh),
    (KeyCode::Char('C'), NONE, ReviewAction::Summary),
    (KeyCode::Char('q'), NONE, ReviewAction::Close),
    (KeyCode::Esc, NONE, ReviewAction::Back),
];

pub fn action(key: KeyEvent) -> Option<ReviewAction> {
    let modifiers = if matches!(key.code, KeyCode::Char(_)) {
        key.modifiers.difference(KeyModifiers::SHIFT)
    } else {
        key.modifiers
    };
    BINDINGS
        .iter()
        .find(|(code, required, _)| *code == key.code && *required == modifiers)
        .map(|(_, _, action)| *action)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Uncommitted,
    Branch,
    Turn,
}

impl Scope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Uncommitted => "uncommitted",
            Self::Branch => "branch",
            Self::Turn => "this turn",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Pane {
    #[default]
    Files,
    Diff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Meta,
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: RowKind,
    pub old: Option<usize>,
    pub new: Option<usize>,
    pub text: String,
}

impl DiffRow {
    pub fn is_change(&self) -> bool {
        matches!(self.kind, RowKind::Added | RowKind::Removed)
    }

    pub fn is_content(&self) -> bool {
        matches!(
            self.kind,
            RowKind::Context | RowKind::Added | RowKind::Removed
        )
    }

    pub fn line(&self, side: Side) -> Option<usize> {
        match side {
            Side::Old => self.old,
            Side::New => self.new,
        }
    }

    pub fn side(&self) -> Side {
        if self.kind == RowKind::Removed {
            Side::Old
        } else {
            Side::New
        }
    }
}

fn hunk_start(part: Option<&str>) -> usize {
    part.and_then(|p| p.get(1..))
        .and_then(|p| p.split(',').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

pub fn rows(patch: &str) -> Vec<DiffRow> {
    let has_hunks = patch.lines().any(|line| line.starts_with("@@ "));
    let mut rows = Vec::new();
    let (mut old, mut new) = (0, 0);
    let mut seen = false;
    for text in patch.lines() {
        if text.starts_with("@@ ") {
            seen = true;
            let mut parts = text.split_whitespace().skip(1);
            old = hunk_start(parts.next());
            new = hunk_start(parts.next());
            rows.push(DiffRow {
                kind: RowKind::Hunk,
                old: None,
                new: None,
                text: text.to_owned(),
            });
            continue;
        }
        if !seen {
            if !has_hunks {
                rows.push(DiffRow {
                    kind: RowKind::Meta,
                    old: None,
                    new: None,
                    text: text.to_owned(),
                });
            }
            continue;
        }
        let body = text.get(1..).unwrap_or_default().to_owned();
        let row = match text.as_bytes().first() {
            Some(b'-') => {
                old += 1;
                DiffRow {
                    kind: RowKind::Removed,
                    old: Some(old - 1),
                    new: None,
                    text: body,
                }
            }
            Some(b'+') => {
                new += 1;
                DiffRow {
                    kind: RowKind::Added,
                    old: None,
                    new: Some(new - 1),
                    text: body,
                }
            }
            Some(b' ') => {
                old += 1;
                new += 1;
                DiffRow {
                    kind: RowKind::Context,
                    old: Some(old - 1),
                    new: Some(new - 1),
                    text: body,
                }
            }
            _ => DiffRow {
                kind: RowKind::Meta,
                old: None,
                new: None,
                text: text.to_owned(),
            },
        };
        rows.push(row);
    }
    rows
}

pub fn split_pairs(rows: &[DiffRow]) -> Vec<(Option<usize>, Option<usize>)> {
    let mut pairs = Vec::with_capacity(rows.len());
    let mut index = 0;
    while index < rows.len() {
        if !rows[index].is_change() {
            pairs.push((Some(index), Some(index)));
            index += 1;
            continue;
        }
        let mut removed = Vec::new();
        let mut added = Vec::new();
        while index < rows.len() && rows[index].is_change() {
            if rows[index].kind == RowKind::Removed {
                removed.push(index);
            } else {
                added.push(index);
            }
            index += 1;
        }
        face(rows, &removed, &added, &mut pairs);
    }
    pairs
}

fn face(
    rows: &[DiffRow],
    removed: &[usize],
    added: &[usize],
    pairs: &mut Vec<(Option<usize>, Option<usize>)>,
) {
    let (mut k, mut j) = (0, 0);
    for (ak, aj) in twins(rows, removed, added)
        .into_iter()
        .chain([(removed.len(), added.len())])
    {
        let span = (ak - k).max(aj - j);
        for offset in 0..span {
            pairs.push((
                (k + offset < ak).then(|| removed[k + offset]),
                (j + offset < aj).then(|| added[j + offset]),
            ));
        }
        if ak < removed.len() && aj < added.len() {
            pairs.push((Some(removed[ak]), Some(added[aj])));
        }
        (k, j) = (ak + 1, aj + 1);
    }
}

fn twins(rows: &[DiffRow], removed: &[usize], added: &[usize]) -> Vec<(usize, usize)> {
    let mut counts: HashMap<&str, (usize, usize)> = HashMap::new();
    for &index in removed {
        counts.entry(rows[index].text.as_str()).or_default().0 += 1;
    }
    for &index in added {
        counts.entry(rows[index].text.as_str()).or_default().1 += 1;
    }
    let added_at: HashMap<&str, usize> = added
        .iter()
        .enumerate()
        .map(|(j, &index)| (rows[index].text.as_str(), j))
        .collect();
    let found: Vec<(usize, usize)> = removed
        .iter()
        .enumerate()
        .filter(|(_, index)| counts[rows[**index].text.as_str()] == (1, 1))
        .map(|(k, index)| (k, added_at[rows[*index].text.as_str()]))
        .collect();
    longest_increasing(&found)
}

fn longest_increasing(found: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![None; found.len()];
    for (i, &(_, j)) in found.iter().enumerate() {
        let n = tails.partition_point(|&t| found[t].1 < j);
        previous[i] = n.checked_sub(1).map(|m| tails[m]);
        if n == tails.len() {
            tails.push(i);
        } else {
            tails[n] = i;
        }
    }
    let mut run = Vec::with_capacity(tails.len());
    let mut at = tails.last().copied();
    while let Some(i) = at {
        run.push(found[i]);
        at = previous[i];
    }
    run.reverse();
    run
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub tone: Tone,
}

impl Status {
    fn new(tone: Tone, text: impl Into<String>) -> Option<Self> {
        Some(Self {
            text: text.into(),
            tone,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Comment {
        anchor: Anchor,
        id: Option<u64>,
        text: String,
    },
    Summary(String),
    Search(String),
    Base(String),
}

#[derive(Clone, Debug)]
pub struct View {
    pub pane: Pane,
    pub file: usize,
    pub cursor: usize,
    pub scroll: usize,
    pub anchor: Option<usize>,
    pub wrap: bool,
    pub split: bool,
    pub search: String,
}

impl Default for View {
    fn default() -> Self {
        Self {
            pane: Pane::Files,
            file: 0,
            cursor: 0,
            scroll: 0,
            anchor: None,
            wrap: false,
            split: true,
            search: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DataKey {
    scope: Scope,
    base: Option<String>,
}

pub struct ReviewTab {
    pub review_id: Option<String>,
    pub label: String,
    pub session_id: Option<String>,
    pub pull_url: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub opened: Option<ReviewOpened>,
    pub scope: Scope,
    pub base: Option<String>,
    pub data: ReviewData,
    pub revision: Option<String>,
    pub context: Option<ReviewContext>,
    pub comments: Comments,
    pub view: View,
    pub input: Option<Input>,
    pub list: Option<usize>,
    pub status: Option<Status>,
    source: ReviewSource,
    opening: Option<String>,
    expired_open: Option<String>,
    open_pending: Option<Value>,
    data_key: Option<DataKey>,
    requested_key: Option<DataKey>,
    context_revision: Option<String>,
    diff_request: Option<String>,
    context_request: Option<String>,
    delivery: Option<(String, String, String)>,
    diff_wanted: bool,
    context_wanted: bool,
    loaded: bool,
    sent_at: Option<Instant>,
    refreshed_at: Option<Instant>,
}

impl ReviewTab {
    fn new(label: String, source: ReviewSource) -> Self {
        Self {
            review_id: None,
            label,
            session_id: source.session_id.clone(),
            pull_url: source.url.clone(),
            stage: None,
            error: None,
            opened: None,
            scope: Scope::Branch,
            base: None,
            data: ReviewData::default(),
            revision: None,
            context: None,
            comments: Comments::default(),
            view: View::default(),
            input: None,
            list: None,
            status: None,
            source,
            opening: None,
            expired_open: None,
            open_pending: None,
            data_key: None,
            requested_key: None,
            context_revision: None,
            diff_request: None,
            context_request: None,
            delivery: None,
            diff_wanted: false,
            context_wanted: false,
            loaded: false,
            sent_at: None,
            refreshed_at: None,
        }
    }

    pub fn refresh(&mut self) {
        self.diff_wanted = true;
    }

    pub fn is_opening(&self) -> bool {
        self.opening.is_some()
    }

    pub fn is_loading(&self) -> bool {
        self.diff_request.is_some() || self.diff_wanted
    }

    pub fn is_sending(&self) -> bool {
        self.delivery.is_some()
    }

    fn in_flight(&self) -> bool {
        (self.opening.is_some() && self.open_pending.is_none())
            || self.diff_request.is_some()
            || self.context_request.is_some()
    }

    fn key(&self) -> DataKey {
        DataKey {
            scope: self.scope,
            base: match self.scope {
                Scope::Branch => self.base.clone(),
                Scope::Uncommitted | Scope::Turn => Some("HEAD".into()),
            },
        }
    }

    pub fn base_label(&self) -> Option<String> {
        match self.scope {
            Scope::Uncommitted | Scope::Turn => Some("HEAD".into()),
            Scope::Branch => self.base.clone().or_else(|| {
                self.opened
                    .as_ref()
                    .and_then(|opened| opened.base.as_ref())
                    .map(|base| base.name.clone())
            }),
        }
    }

    pub fn provenance(&self, path: &str) -> Option<&ProvenanceFile> {
        let wanted = path.replace('\\', "/");
        self.context
            .as_ref()?
            .provenance
            .as_ref()?
            .files
            .iter()
            .find(|file| file.path.replace('\\', "/") == wanted)
    }

    pub fn files(&self) -> Vec<&FileDiff> {
        self.data
            .files
            .iter()
            .filter(|file| {
                self.scope != Scope::Turn
                    || self.provenance(&file.path).is_some_and(|p| p.this_turn)
            })
            .collect()
    }

    pub fn current_file(&self) -> Option<&FileDiff> {
        self.files().get(self.view.file).copied()
    }

    pub fn current_rows(&self) -> Vec<DiffRow> {
        self.current_file()
            .map(|file| rows(&file.patch))
            .unwrap_or_default()
    }

    pub fn selection(&self) -> (usize, usize) {
        let anchor = self.view.anchor.unwrap_or(self.view.cursor);
        (anchor.min(self.view.cursor), anchor.max(self.view.cursor))
    }

    pub fn comment_at(&self, row: &DiffRow) -> Option<&review_comments::Comment> {
        let path = &self.current_file()?.path;
        let side = row.side();
        let line = row.line(side)?;
        self.comments
            .comments
            .iter()
            .find(|comment| comment.anchor.covers(path, side, line))
    }

    pub fn comment_counts(&self, path: &str) -> usize {
        self.comments
            .comments
            .iter()
            .filter(|comment| comment.anchor.path == path)
            .count()
    }

    fn anchor(&self) -> Option<Anchor> {
        let path = self.current_file()?.path.clone();
        let rows = self.current_rows();
        let (start, end) = self.selection();
        let chosen: Vec<&DiffRow> = rows
            .get(start..=end.min(rows.len().saturating_sub(1)))?
            .iter()
            .filter(|row| row.is_content())
            .collect();
        let side = if chosen.iter().any(|row| row.new.is_some()) {
            Side::New
        } else {
            Side::Old
        };
        let lines: Vec<(usize, &str)> = chosen
            .iter()
            .filter_map(|row| Some((row.line(side)?, row.text.as_str())))
            .collect();
        let first = lines.first()?.0;
        let last = lines.last()?.0;
        Some(Anchor {
            path,
            side,
            start: first.min(last),
            end: first.max(last),
            snippet: review_comments::snippet(lines.iter().map(|(_, text)| *text)),
            revision: self.revision.clone().unwrap_or_else(|| "pending".into()),
        })
    }

    fn select_file(&mut self, index: usize) {
        let count = self.files().len();
        self.view.file = index.min(count.saturating_sub(1));
        self.view.anchor = None;
        self.view.scroll = 0;
        self.view.cursor = self
            .current_rows()
            .iter()
            .position(DiffRow::is_change)
            .unwrap_or(0);
    }

    fn clamp(&mut self) {
        let count = self.files().len();
        self.view.file = self.view.file.min(count.saturating_sub(1));
        let rows = self.current_rows().len();
        self.view.cursor = self.view.cursor.min(rows.saturating_sub(1));
        if self.view.anchor.is_some_and(|anchor| anchor >= rows) {
            self.view.anchor = None;
        }
    }

    pub fn visible_top(&self, height: usize) -> usize {
        let height = height.max(1);
        if self.view.cursor < self.view.scroll {
            self.view.cursor
        } else if self.view.cursor >= self.view.scroll + height {
            self.view.cursor + 1 - height
        } else {
            self.view.scroll
        }
    }

    fn change_starts(rows: &[DiffRow]) -> Vec<usize> {
        (0..rows.len())
            .filter(|&index| {
                rows[index].is_change() && (index == 0 || !rows[index - 1].is_change())
            })
            .collect()
    }

    fn next_change(&mut self, forward: bool) {
        let rows = self.current_rows();
        let starts = Self::change_starts(&rows);
        let cursor = self.view.cursor;
        let found = if forward {
            starts.iter().copied().find(|start| *start > cursor)
        } else {
            starts.iter().copied().rev().find(|start| *start < cursor)
        };
        self.view.pane = Pane::Diff;
        if let Some(found) = found {
            self.view.cursor = found;
            return;
        }
        let count = self.files().len();
        let next = if forward {
            (self.view.file + 1 < count).then_some(self.view.file + 1)
        } else {
            self.view.file.checked_sub(1)
        };
        if let Some(next) = next {
            self.select_file(next);
            if !forward {
                let rows = self.current_rows();
                if let Some(last) = Self::change_starts(&rows).last() {
                    self.view.cursor = *last;
                }
            }
        }
    }

    fn comment_order(&self) -> Vec<(usize, usize, u64)> {
        let files = self.files();
        let mut order: Vec<(usize, usize, u64)> = self
            .comments
            .comments
            .iter()
            .filter_map(|comment| {
                let file = files.iter().position(|f| f.path == comment.anchor.path)?;
                Some((file, comment.anchor.start, comment.id))
            })
            .collect();
        order.sort_unstable();
        order
    }

    fn jump_to(&mut self, id: u64) -> bool {
        let Some(comment) = self.comments.find(id).cloned() else {
            return false;
        };
        let Some(file) = self
            .files()
            .iter()
            .position(|file| file.path == comment.anchor.path)
        else {
            return false;
        };
        if file != self.view.file {
            self.select_file(file);
        }
        let side = comment.anchor.side;
        if let Some(row) = self
            .current_rows()
            .iter()
            .position(|row| row.line(side) == Some(comment.anchor.start) && row.is_content())
        {
            self.view.cursor = row;
        }
        self.view.pane = Pane::Diff;
        true
    }

    fn next_comment(&mut self, forward: bool) -> bool {
        let order = self.comment_order();
        let here = (
            self.view.file,
            self.current_rows()
                .get(self.view.cursor)
                .and_then(|row| row.line(row.side()))
                .unwrap_or(0),
        );
        let target = if forward {
            order
                .iter()
                .find(|(file, line, _)| (*file, *line) > here)
                .or_else(|| order.first())
        } else {
            order
                .iter()
                .rev()
                .find(|(file, line, _)| (*file, *line) < here)
                .or_else(|| order.last())
        };
        target.is_some_and(|(_, _, id)| {
            let id = *id;
            self.jump_to(id)
        })
    }

    fn search(&mut self, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return false;
        }
        let files: Vec<(String, Vec<DiffRow>)> = self
            .files()
            .iter()
            .map(|file| (file.path.to_lowercase(), rows(&file.patch)))
            .collect();
        let count = files.len();
        for step in 0..=count {
            let file = (self.view.file + step) % count.max(1);
            let Some((path, rows)) = files.get(file) else {
                return false;
            };
            let from = if step == 0 { self.view.cursor + 1 } else { 0 };
            if let Some(row) = (from..rows.len()).find(|&index| {
                rows[index].is_content() && rows[index].text.to_lowercase().contains(&needle)
            }) {
                if file != self.view.file {
                    self.select_file(file);
                }
                self.view.cursor = row;
                self.view.pane = Pane::Diff;
                return true;
            }
            if step > 0 && path.contains(&needle) {
                self.select_file(file);
                return true;
            }
        }
        false
    }
}

fn locate(data: &ReviewData, anchor: &Anchor) -> Option<(usize, usize)> {
    let file = data.files.iter().find(|file| file.path == anchor.path)?;
    let lines: Vec<(usize, String)> = rows(&file.patch)
        .into_iter()
        .filter(|row| row.is_content())
        .filter_map(|row| Some((row.line(anchor.side)?, row.text)))
        .collect();
    let length = anchor.end.saturating_sub(anchor.start) + 1;
    let matches: Vec<(usize, usize)> = (0..lines.len())
        .filter(|&start| start + length <= lines.len())
        .filter(|&start| {
            review_comments::snippet(lines[start..start + length].iter().map(|(_, t)| t.as_str()))
                == anchor.snippet
        })
        .map(|start| (lines[start].0, lines[start + length - 1].0))
        .collect();
    matches
        .iter()
        .copied()
        .find(|(start, _)| *start == anchor.start)
        .or_else(|| matches.first().copied())
}

pub struct ReviewSessions {
    pub tabs: Vec<ReviewTab>,
    pub shown: Option<usize>,
    pub focused: bool,
    pub return_to_input: bool,
    pub picking: Option<String>,
    pub area: Rect,
    pub store: Option<PathBuf>,
}

impl Default for ReviewSessions {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            shown: None,
            focused: false,
            return_to_input: false,
            picking: None,
            area: Rect::default(),
            store: default_store(),
        }
    }
}

fn default_store() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    crate::preferences::default_path()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

impl ReviewSessions {
    pub fn active(&self) -> Option<&ReviewTab> {
        self.tabs.get(self.shown?)
    }

    pub fn active_mut(&mut self) -> Option<&mut ReviewTab> {
        self.tabs.get_mut(self.shown?)
    }

    pub fn has_focus(&self) -> bool {
        self.focused && self.shown.is_some()
    }

    pub fn by_id(&self, review_id: &str) -> Option<usize> {
        self.tabs
            .iter()
            .position(|tab| tab.review_id.as_deref() == Some(review_id))
    }

    pub fn git_busy(&self) -> bool {
        self.tabs.iter().any(ReviewTab::in_flight)
    }

    fn remove(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        let removed = self.tabs.remove(index);
        if removed.review_id.is_some() && removed.review_id == self.picking {
            self.picking = None;
        }
        self.shown = match self.shown {
            Some(shown) if shown == index => None,
            Some(shown) if shown > index => Some(shown - 1),
            other => other,
        };
        if self.shown.is_none() {
            self.focused = false;
        }
    }

    fn push(&mut self, tab: ReviewTab) -> usize {
        if self.tabs.len() >= MAX_TABS
            && let Some(oldest) = (0..self.tabs.len()).find(|index| Some(*index) != self.shown)
        {
            self.remove(oldest);
        }
        self.tabs.push(tab);
        self.tabs.len() - 1
    }
}

pub fn supported(app: &App) -> bool {
    app.host_features["reviews"] == true
}

pub fn show(app: &mut App, index: usize, focus: bool) {
    if index >= app.reviews.tabs.len() {
        return;
    }
    if app.reviews.shown.is_none() || !app.reviews.focused {
        app.reviews.return_to_input = app.mode == Mode::Input && focus;
    }
    app.reviews.shown = Some(index);
    app.review.visible = false;
    app.review.focused = false;
    if focus {
        app.reviews.focused = true;
        app.mode = Mode::Navigate;
    }
    let tab = &mut app.reviews.tabs[index];
    if tab.review_id.is_some() && tab.diff_request.is_none() && tab.data_key.is_none() {
        tab.diff_wanted = true;
    }
}

pub fn hide(app: &mut App) {
    if app.reviews.shown.take().is_some() && app.reviews.focused && app.reviews.return_to_input {
        app.mode = Mode::Input;
    }
    app.reviews.focused = false;
    app.reviews.return_to_input = false;
    app.reviews.picking = None;
}

pub fn unfocus(app: &mut App) {
    if app.reviews.focused && app.reviews.return_to_input {
        app.mode = Mode::Input;
    }
    app.reviews.focused = false;
    app.reviews.return_to_input = false;
}

pub fn close(app: &mut App, index: usize) {
    let restore = app.reviews.shown == Some(index) && app.reviews.focused;
    let input = app.reviews.return_to_input;
    app.reviews.remove(index);
    if restore && input {
        app.mode = Mode::Input;
    }
    if app.reviews.shown.is_none() {
        app.reviews.return_to_input = false;
    }
}

pub enum Source {
    Local(String),
    Pull(String),
}

pub fn open(app: &mut App, source: Source) -> Vec<Value> {
    if !app.connected {
        app.notice = "Reconnect to the host before opening a review.".into();
        return Vec::new();
    }
    if !supported(app) {
        app.notice = "Update nesvo-host to open review sessions.".into();
        return Vec::new();
    }
    let (existing, label, source) = match &source {
        Source::Local(id) => (
            app.reviews
                .tabs
                .iter()
                .position(|tab| tab.session_id.as_deref() == Some(id) && tab.pull_url.is_none()),
            app.session(id)
                .map_or_else(|| "local changes".into(), |session| session.name.clone()),
            ReviewSource::local(id),
        ),
        Source::Pull(url) => (
            app.reviews
                .tabs
                .iter()
                .position(|tab| tab.pull_url.as_deref() == Some(url)),
            pull_label(url),
            ReviewSource::pull(url),
        ),
    };
    if let Some(index) = existing {
        let tab = &mut app.reviews.tabs[index];
        if tab.review_id.is_some() {
            tab.diff_wanted = true;
        } else if tab.opening.is_none() {
            restart_open(app, index);
        }
        show(app, index, true);
        return pump(app);
    }
    let index = app.reviews.push(ReviewTab::new(label, source));
    restart_open(app, index);
    show(app, index, true);
    app.notice.clear();
    pump(app)
}

fn restart_open(app: &mut App, index: usize) {
    let source = app.reviews.tabs[index].source.clone();
    let command = app.typed_request(&OpenReview { source: &source });
    let tab = &mut app.reviews.tabs[index];
    tab.opening = command["requestId"].as_str().map(str::to_owned);
    tab.open_pending = Some(command);
    tab.stage = None;
    tab.error = None;
}

fn pull_label(url: &str) -> String {
    url.strip_prefix("https://github.com/")
        .unwrap_or(url)
        .replacen("/pull/", "#", 1)
}

fn source_label(app: &App, opened: &ReviewOpened) -> String {
    let source = &opened.source;
    if source.kind == ReviewSourceKind::Pull
        && let (Some(owner), Some(repo), Some(number)) =
            (&source.owner, &source.repo, source.number)
    {
        return format!("{owner}/{repo}#{number}");
    }
    source
        .session_id
        .as_deref()
        .and_then(|id| app.session(id))
        .map(|session| session.name.clone())
        .unwrap_or_else(|| {
            opened
                .directory
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or("review")
                .to_owned()
        })
}

pub fn pump(app: &mut App) -> Vec<Value> {
    if app.reviews.tabs.is_empty()
        || !app.connected
        || app.review.request_id.is_some()
        || app.reviews.git_busy()
    {
        return Vec::new();
    }
    let mut order: Vec<usize> = app.reviews.shown.into_iter().collect();
    order.extend((0..app.reviews.tabs.len()).filter(|index| Some(*index) != app.reviews.shown));
    for &index in &order {
        let tab = &mut app.reviews.tabs[index];
        if let Some(command) = tab.open_pending.take() {
            tab.sent_at = Some(Instant::now());
            return vec![command];
        }
    }
    for &index in &order {
        let tab = &app.reviews.tabs[index];
        let Some(review_id) = tab.review_id.clone().filter(|_| tab.diff_wanted) else {
            continue;
        };
        let key = tab.key();
        let command = app.typed_request(&ReviewDiffRequest {
            review_id: &review_id,
            scope: "branch",
            base: key.base.as_deref(),
        });
        let tab = &mut app.reviews.tabs[index];
        tab.diff_wanted = false;
        tab.diff_request = command["requestId"].as_str().map(str::to_owned);
        tab.requested_key = Some(key);
        tab.sent_at = Some(Instant::now());
        tab.refreshed_at = Some(Instant::now());
        return vec![command];
    }
    for &index in &order {
        let tab = &app.reviews.tabs[index];
        let Some(review_id) = tab.review_id.clone().filter(|_| tab.context_wanted) else {
            continue;
        };
        let command = app.typed_request(&ReviewContextRequest {
            review_id: &review_id,
        });
        let tab = &mut app.reviews.tabs[index];
        tab.context_wanted = false;
        tab.context_request = command["requestId"].as_str().map(str::to_owned);
        tab.sent_at = Some(Instant::now());
        return vec![command];
    }
    Vec::new()
}

pub fn tick(app: &mut App) -> Vec<Value> {
    if app.reviews.tabs.is_empty() {
        return Vec::new();
    }
    let now = Instant::now();
    let paused = app.dialog.is_some() || app.overlay.is_some();
    let shown = app.reviews.shown;
    for (index, tab) in app.reviews.tabs.iter_mut().enumerate() {
        let limit = if tab.opening.is_some() {
            OPEN_TIMEOUT
        } else {
            GIT_TIMEOUT
        };
        if tab.in_flight() && tab.sent_at.is_some_and(|at| now.duration_since(at) > limit) {
            if let Some(request) = tab.opening.take() {
                tab.expired_open = Some(request);
                tab.error = Some("The host did not finish opening this review; r retries.".into());
            }
            tab.diff_request = None;
            tab.context_request = None;
            tab.sent_at = None;
        }
        if Some(index) == shown
            && !paused
            && tab.review_id.is_some()
            && tab.input.is_none()
            && !tab.in_flight()
            && tab
                .refreshed_at
                .is_some_and(|at| now.duration_since(at) >= REFRESH)
        {
            tab.refresh();
        }
    }
    pump(app)
}

pub fn host_event(app: &mut App, event: &Value) -> Option<()> {
    let header = ReplyHeader::of(event);
    let request = header.request_id.as_deref();
    match header.kind.as_deref()? {
        "reviewProgress" => {
            if let Some(tab) = app
                .reviews
                .tabs
                .iter_mut()
                .find(|tab| tab.opening.is_some() && tab.opening.as_deref() == request)
            {
                let progress: ReviewProgress = views::decode(event).unwrap_or_default();
                tab.stage = progress.stage;
            }
        }
        "reviewOpened" => opened(app, event, request),
        "diff" => {
            let reply: DiffReply = views::decode(event).unwrap_or_default();
            reply.review_id.as_ref()?;
            let index = app.reviews.tabs.iter().position(|tab| {
                tab.diff_request.is_some() && tab.diff_request.as_deref() == request
            })?;
            accept_diff(app, index, reply);
        }
        "reviewContext" => {
            let index = app.reviews.tabs.iter().position(|tab| {
                tab.context_request.is_some() && tab.context_request.as_deref() == request
            })?;
            let tab = &mut app.reviews.tabs[index];
            tab.context_request = None;
            tab.sent_at = None;
            match views::decode::<ReviewContext>(event) {
                Some(context) => {
                    tab.context = Some(context);
                    tab.context_revision = tab.revision.clone();
                    tab.clamp();
                }
                None => {
                    tab.status = Status::new(Tone::Warning, "The host sent unreadable readiness.")
                }
            }
        }
        "reviewDelivered" => {
            let index = app.reviews.tabs.iter().position(|tab| {
                tab.delivery
                    .as_ref()
                    .is_some_and(|(id, _, _)| Some(id.as_str()) == request)
            })?;
            delivered(app, index, views::decode(event).unwrap_or_default());
        }
        "error" => {
            let request = request?;
            let index = app.reviews.tabs.iter().position(|tab| {
                [&tab.opening, &tab.diff_request, &tab.context_request]
                    .iter()
                    .any(|id| id.as_deref() == Some(request))
                    || tab
                        .delivery
                        .as_ref()
                        .is_some_and(|(id, _, _)| id == request)
            })?;
            failed(app, index, request, &HostError::of(event));
        }
        _ => return None,
    }
    Some(())
}

fn opened(app: &mut App, event: &Value, request: Option<&str>) {
    let Some(opened) = views::decode::<ReviewOpened>(event) else {
        app.notice = "The host sent an unreadable review.".into();
        return;
    };
    if !review_comments::valid_review_id(&opened.review_id) {
        app.notice = "The host sent an invalid review id.".into();
        return;
    }
    let by_request = request.and_then(|id| {
        app.reviews.tabs.iter().position(|tab| {
            tab.opening.as_deref() == Some(id) || tab.expired_open.as_deref() == Some(id)
        })
    });
    let by_id = app.reviews.by_id(&opened.review_id);
    let index = match (by_request, by_id) {
        (Some(pending), Some(existing)) if pending != existing => {
            app.reviews.remove(pending);
            existing - usize::from(pending < existing)
        }
        (Some(index), _) | (None, Some(index)) => index,
        (None, None) => {
            let label = source_label(app, &opened);
            app.reviews
                .push(ReviewTab::new(label, opened.source.clone()))
        }
    };
    let label = source_label(app, &opened);
    let store = app.reviews.store.clone();
    let tab = &mut app.reviews.tabs[index];
    if tab.review_id.is_none() {
        tab.scope = if opened.scope == OpenedScope::Branch {
            Scope::Branch
        } else {
            Scope::Uncommitted
        };
    }
    tab.label = label;
    tab.session_id = opened.source.session_id.clone();
    tab.pull_url = opened.source.url.clone();
    tab.review_id = Some(opened.review_id.clone());
    tab.opening = None;
    tab.expired_open = None;
    tab.open_pending = None;
    tab.stage = None;
    tab.error = None;
    tab.sent_at = None;
    tab.diff_wanted = true;
    if !tab.loaded {
        tab.loaded = true;
        if let Some(path) = store
            .as_deref()
            .and_then(|dir| review_comments::store_path(dir, &opened.review_id))
        {
            tab.comments = Comments::load(&path);
        }
    }
    tab.opened = Some(opened);
    let label = tab.label.clone();
    if by_request.is_some() {
        show(app, index, true);
    } else if app.mode == Mode::Navigate
        && app.dialog.is_none()
        && app.session_kind.is_none()
        && app.layout_picker.is_none()
        && app.overlay.is_none()
        && app.reviews.shown.is_none()
    {
        show(app, index, true);
        app.notice = format!("Review {label} opened from another client.");
    } else {
        app.notice = format!("Review {label} opened in a new tab.");
    }
}

fn accept_diff(app: &mut App, index: usize, reply: DiffReply) {
    let store = app.reviews.store.clone();
    let tab = &mut app.reviews.tabs[index];
    tab.diff_request = None;
    tab.sent_at = None;
    let key = tab.requested_key.take();
    if let Some(error) = reply.error {
        tab.error = Some(error);
        return;
    }
    let Some(data) = reply.review.0 else {
        tab.error = Some("The host sent an unreadable diff.".into());
        return;
    };
    tab.error = None;
    let path = tab.current_file().map(|file| file.path.clone());
    let same_view = key.is_some() && key == tab.data_key;
    tab.data = data;
    tab.data_key = key;
    if let Some(position) = path.and_then(|path| tab.files().iter().position(|f| f.path == path)) {
        tab.view.file = position;
    } else if !same_view {
        tab.select_file(0);
    }
    tab.clamp();
    let revision = tab.data.revision.clone();
    if revision.is_some() && revision != tab.revision {
        if same_view && let Some(revision) = revision.as_deref() {
            let ReviewTab { data, comments, .. } = &mut *tab;
            if comments.rebase(revision, |anchor| locate(data, anchor)) {
                persist(tab, store.as_deref());
            }
        }
        tab.revision = revision;
    }
    if tab.context_revision != tab.revision || tab.context.is_none() {
        tab.context_wanted = true;
    }
}

fn persist(tab: &mut ReviewTab, store: Option<&Path>) {
    let Some(path) = store
        .zip(tab.review_id.as_deref())
        .and_then(|(dir, id)| review_comments::store_path(dir, id))
    else {
        return;
    };
    if tab.comments.save(&path).is_err() {
        tab.status = Status::new(
            Tone::Warning,
            "Could not save review notes; they stay in this window.",
        );
    }
}

fn session_name(app: &App, id: &str) -> String {
    app.session(id)
        .map_or_else(|| "the session".into(), |session| session.name.clone())
}

fn delivered(app: &mut App, index: usize, reply: ReviewDelivered) {
    let Some((_, session, note)) = app.reviews.tabs[index].delivery.take() else {
        return;
    };
    let name = session_name(app, &session);
    let receipt = &reply.receipt;
    let id: String = receipt
        .id
        .as_deref()
        .or(receipt.operation_id.as_deref())
        .unwrap_or("none")
        .chars()
        .take(8)
        .collect();
    let bytes = reply.bytes.unwrap_or(0);
    let text = if reply.path == Some(DeliveryPath::Paste) {
        format!(
            "Pasted into {name} ({bytes} bytes, receipt {id}); press Enter there to submit.{note}"
        )
    } else {
        let phase = receipt.phase.as_deref().unwrap_or("accepted");
        format!("Sent to {name} ({bytes} bytes, {phase}, receipt {id}).{note}")
    };
    app.reviews.tabs[index].status = Status::new(Tone::Success, text);
}

fn refusal(code: &str, message: &str) -> String {
    match code {
        "too_large" => "Refused (too_large): without control the review is limited to 8192 bytes; take control of the agent (i) and send again.".into(),
        "control_busy" => "Refused (control_busy): another client controls that session.".into(),
        "agent_not_ready" => "Refused: the agent is not ready and idle yet; send again when it waits for input.".into(),
        "process_exited" => "Refused: that session's process has exited.".into(),
        "unsupported" => "Refused: reviews go to agent sessions, not shells.".into(),
        "paste_unsupported" => "Refused: that agent cannot receive multiline pastes.".into(),
        "review_not_found" => "The host no longer has this review; r reopens it.".into(),
        "busy" => "The host is busy with another Git request; try again.".into(),
        _ => message.to_owned(),
    }
}

fn failed(app: &mut App, index: usize, request: &str, error: &HostError) {
    let code = error.code();
    let text = refusal(code, error.message_or("Host rejected the request"));
    let tab = &mut app.reviews.tabs[index];
    if tab
        .delivery
        .as_ref()
        .is_some_and(|(id, _, _)| id == request)
    {
        tab.delivery = None;
        tab.status = Status::new(Tone::Danger, text);
        return;
    }
    tab.sent_at = None;
    if tab.opening.as_deref() == Some(request) {
        tab.opening = None;
        tab.stage = None;
        tab.error = Some(text);
    } else if tab.diff_request.as_deref() == Some(request) {
        tab.diff_request = None;
        tab.requested_key = None;
        tab.error = Some(text);
    } else {
        tab.context_request = None;
        tab.context_revision = tab.revision.clone();
        tab.status = Status::new(Tone::Warning, format!("Readiness unavailable: {text}"));
    }
    if code == "review_not_found" {
        tab.review_id = None;
    }
}

pub fn deliver(app: &mut App, review_id: &str, session_id: &str) -> Option<Value> {
    let index = app.reviews.by_id(review_id)?;
    let lease = app
        .owns(session_id)
        .then(|| app.leases.get(session_id).cloned())
        .flatten();
    let cap = if lease.is_some() {
        review_comments::PASTE_BYTES
    } else {
        review_comments::OPERATION_BYTES
    };
    let document = review_comments::document(&app.reviews.tabs[index].comments, cap);
    let command = app.typed_request(&DeliverReview {
        review_id,
        session_id,
        text: &document.text,
        lease_id: lease.as_deref(),
    });
    let note = if document.truncated() {
        format!(
            " Truncated to {} bytes: {} of {} comments included.",
            document.cap, document.included, document.total
        )
    } else {
        String::new()
    };
    let name = session_name(app, session_id);
    let tab = &mut app.reviews.tabs[index];
    tab.delivery = command["requestId"]
        .as_str()
        .map(|id| (id.to_owned(), session_id.to_owned(), note.clone()));
    tab.status = Status::new(Tone::Info, format!("Sending the review to {name}…{note}"));
    Some(command)
}

#[derive(Default)]
pub struct KeyResult {
    pub commands: Vec<Value>,
    pub clipboard: Option<String>,
}

pub fn paste(app: &mut App, text: &str) -> bool {
    let Some(tab) = app.reviews.active_mut() else {
        return false;
    };
    let (target, limit, multiline) = match &mut tab.input {
        Some(Input::Comment { text, .. } | Input::Summary(text)) => (text, INPUT_CHARS, true),
        Some(Input::Search(text) | Input::Base(text)) => (text, LINE_INPUT_CHARS, false),
        None => return false,
    };
    let room = limit.saturating_sub(target.chars().count());
    target.extend(
        text.replace("\r\n", "\n")
            .chars()
            .filter(|c| (multiline && *c == '\n') || !c.is_control())
            .take(room),
    );
    true
}

pub fn key(app: &mut App, key: KeyEvent, page: usize) -> KeyResult {
    let mut result = KeyResult::default();
    let Some(index) = app.reviews.shown.filter(|i| *i < app.reviews.tabs.len()) else {
        return result;
    };
    if app.reviews.tabs[index].input.is_some() {
        input_key(app, index, key);
        result.commands = pump(app);
        return result;
    }
    if app.reviews.tabs[index].list.is_some() {
        list_key(app, index, key);
        return result;
    }
    let Some(action) = self::action(key) else {
        return result;
    };
    apply(app, index, action, page.max(1), &mut result);
    if app.reviews.shown == Some(index)
        && let Some(tab) = app.reviews.tabs.get_mut(index)
    {
        tab.view.scroll = tab.visible_top(page);
    }
    result.commands.extend(pump(app));
    result
}

fn input_key(app: &mut App, index: usize, key: KeyEvent) {
    let store = app.reviews.store.clone();
    let tab = &mut app.reviews.tabs[index];
    let Some(input) = tab.input.as_mut() else {
        return;
    };
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let multiline = matches!(input, Input::Comment { .. } | Input::Summary(_));
    let (text, limit) = match input {
        Input::Comment { text, .. } | Input::Summary(text) => (text, INPUT_CHARS),
        Input::Search(text) | Input::Base(text) => (text, LINE_INPUT_CHARS),
    };
    let newline = multiline
        && ((key.code == KeyCode::Enter && (alt || shift))
            || (control && key.code == KeyCode::Char('j')));
    match key.code {
        _ if newline => {
            if text.chars().count() < limit {
                text.push('\n');
            }
            return;
        }
        KeyCode::Esc => {
            tab.input = None;
            return;
        }
        KeyCode::Backspace => {
            text.pop();
            return;
        }
        KeyCode::Char('u') if control => {
            text.clear();
            return;
        }
        KeyCode::Char(c) if !control && !alt && !c.is_control() => {
            if text.chars().count() < limit {
                text.push(c);
            }
            return;
        }
        KeyCode::Enter => {}
        _ => return,
    }
    let Some(input) = tab.input.take() else {
        return;
    };
    match input {
        Input::Comment { anchor, id, text } => {
            let saved = match id {
                Some(id) => tab.comments.edit(id, &text).map(|()| "Comment updated."),
                None => tab
                    .comments
                    .add(anchor.clone(), &text)
                    .map(|_| "Comment saved."),
            };
            match saved {
                Ok(message) => {
                    tab.view.anchor = None;
                    tab.status = Status::new(Tone::Success, message);
                    persist(tab, store.as_deref());
                }
                Err(message) => {
                    tab.status = Status::new(Tone::Warning, message);
                    tab.input = Some(Input::Comment { anchor, id, text });
                }
            }
        }
        Input::Summary(text) => match tab.comments.set_summary(&text) {
            Ok(()) => {
                tab.status = Status::new(Tone::Success, "Summary saved.");
                persist(tab, store.as_deref());
            }
            Err(message) => {
                tab.status = Status::new(Tone::Warning, message);
                tab.input = Some(Input::Summary(text));
            }
        },
        Input::Search(query) => {
            let found = tab.search(&query);
            tab.status = if found {
                None
            } else {
                Status::new(Tone::Warning, format!("No match for “{query}”."))
            };
            tab.view.search = query;
        }
        Input::Base(base) => {
            let base = base.trim().to_owned();
            if !base.is_empty()
                && (base.starts_with('-')
                    || base.contains("..")
                    || base.contains(char::is_whitespace))
            {
                tab.status = Status::new(
                    Tone::Warning,
                    "Use a branch, tag or commit like main or HEAD~2.",
                );
                tab.input = Some(Input::Base(base));
                return;
            }
            tab.base = (!base.is_empty()).then_some(base);
            tab.scope = Scope::Branch;
            tab.diff_wanted = true;
            tab.select_file(0);
        }
    }
}

fn list_key(app: &mut App, index: usize, key: KeyEvent) {
    let store = app.reviews.store.clone();
    let tab = &mut app.reviews.tabs[index];
    let count = tab.comments.comments.len();
    let Some(selected) = tab.list else {
        return;
    };
    let selected = selected.min(count.saturating_sub(1));
    let id = tab.comments.comments.get(selected).map(|c| c.id);
    match key.code {
        KeyCode::Char('j') | KeyCode::Down => {
            tab.list = Some((selected + 1).min(count.saturating_sub(1)))
        }
        KeyCode::Char('k') | KeyCode::Up => tab.list = Some(selected.saturating_sub(1)),
        KeyCode::Esc | KeyCode::Char('l' | 'q') => tab.list = None,
        KeyCode::Enter => {
            tab.list = None;
            if let Some(id) = id
                && !tab.jump_to(id)
            {
                tab.status =
                    Status::new(Tone::Warning, "That comment's file is not in this scope.");
            }
        }
        KeyCode::Char('e') => {
            if let Some(comment) = id.and_then(|id| tab.comments.find(id)).cloned() {
                tab.list = None;
                tab.input = Some(Input::Comment {
                    anchor: comment.anchor,
                    id: Some(comment.id),
                    text: comment.text,
                });
            }
        }
        KeyCode::Char('d') => {
            if let Some(id) = id
                && tab.comments.delete(id)
            {
                tab.list = (count > 1).then(|| selected.min(count - 2));
                tab.status = Status::new(Tone::Info, "Comment deleted.");
                persist(tab, store.as_deref());
            }
        }
        _ => {}
    }
}

fn apply(app: &mut App, index: usize, action: ReviewAction, page: usize, result: &mut KeyResult) {
    let store = app.reviews.store.clone();
    let tab = &mut app.reviews.tabs[index];
    let rows = tab.current_rows().len();
    let files = tab.files().len();
    let move_by = |tab: &mut ReviewTab, delta: isize| {
        if tab.view.pane == Pane::Files {
            let next = tab
                .view
                .file
                .saturating_add_signed(delta)
                .min(files.saturating_sub(1));
            if next != tab.view.file {
                tab.select_file(next);
            }
        } else {
            tab.view.cursor = tab
                .view
                .cursor
                .saturating_add_signed(delta)
                .min(rows.saturating_sub(1));
        }
    };
    match action {
        ReviewAction::Down => move_by(tab, 1),
        ReviewAction::Up => move_by(tab, -1),
        ReviewAction::PageDown => move_by(tab, page as isize),
        ReviewAction::PageUp => move_by(tab, -(page as isize)),
        ReviewAction::HalfDown => move_by(tab, (page / 2).max(1) as isize),
        ReviewAction::HalfUp => move_by(tab, -((page / 2).max(1) as isize)),
        ReviewAction::NextChange => tab.next_change(true),
        ReviewAction::PrevChange => tab.next_change(false),
        ReviewAction::NextFile => tab.select_file((tab.view.file + 1).min(files.saturating_sub(1))),
        ReviewAction::PrevFile => tab.select_file(tab.view.file.saturating_sub(1)),
        ReviewAction::SwitchPane => {
            tab.view.pane = match tab.view.pane {
                Pane::Files => Pane::Diff,
                Pane::Diff => Pane::Files,
            }
        }
        ReviewAction::Search => tab.input = Some(Input::Search(tab.view.search.clone())),
        ReviewAction::Wrap => tab.view.wrap = !tab.view.wrap,
        ReviewAction::Split => {
            tab.view.split = !tab.view.split;
            if tab.view.split && app.reviews.area.width < SPLIT_COLUMNS {
                tab.status = Status::new(
                    Tone::Info,
                    format!("Side by side needs {SPLIT_COLUMNS} columns; unified until it widens."),
                );
            }
        }
        ReviewAction::ScopeUncommitted | ReviewAction::ScopeBranch | ReviewAction::ScopeTurn => {
            let scope = match action {
                ReviewAction::ScopeUncommitted => Scope::Uncommitted,
                ReviewAction::ScopeBranch => Scope::Branch,
                _ => Scope::Turn,
            };
            if tab.scope != scope {
                tab.scope = scope;
                tab.diff_wanted = true;
                tab.select_file(0);
            }
            if scope == Scope::Turn
                && !tab
                    .context
                    .as_ref()
                    .and_then(|c| c.provenance.as_ref())
                    .is_some_and(|p| p.evidence == "hooks")
            {
                tab.status = Status::new(
                    Tone::Info,
                    "This turn lists files with verified agent edits; this review has no hook evidence.",
                );
            }
        }
        ReviewAction::BasePick => {
            tab.input = Some(Input::Base(
                tab.base_label().filter(|b| b != "HEAD").unwrap_or_default(),
            ))
        }
        ReviewAction::Select => {
            tab.view.pane = Pane::Diff;
            tab.view.anchor = match tab.view.anchor {
                Some(_) => None,
                None => Some(tab.view.cursor),
            };
        }
        ReviewAction::Comment => match tab.anchor() {
            Some(anchor) if tab.review_id.is_some() => {
                tab.view.pane = Pane::Diff;
                tab.input = Some(Input::Comment {
                    anchor,
                    id: None,
                    text: String::new(),
                })
            }
            _ => {
                tab.status = Status::new(Tone::Info, "Move to a code line in the diff to comment.")
            }
        },
        ReviewAction::Edit => {
            let rows = tab.current_rows();
            match rows
                .get(tab.view.cursor)
                .and_then(|row| tab.comment_at(row))
                .cloned()
            {
                Some(comment) => {
                    tab.input = Some(Input::Comment {
                        anchor: comment.anchor,
                        id: Some(comment.id),
                        text: comment.text,
                    })
                }
                None => {
                    tab.status = Status::new(Tone::Info, "No comment on this line; c adds one.")
                }
            }
        }
        ReviewAction::Delete => {
            let rows = tab.current_rows();
            match rows
                .get(tab.view.cursor)
                .and_then(|row| tab.comment_at(row))
                .map(|c| c.id)
            {
                Some(id) => {
                    tab.comments.delete(id);
                    tab.status = Status::new(Tone::Info, "Comment deleted.");
                    persist(tab, store.as_deref());
                }
                None => tab.status = Status::new(Tone::Info, "No comment on this line."),
            }
        }
        ReviewAction::NextComment | ReviewAction::PrevComment => {
            if !tab.next_comment(action == ReviewAction::NextComment) {
                tab.status = Status::new(Tone::Info, "No comments in this scope.");
            }
        }
        ReviewAction::List => {
            if tab.comments.comments.is_empty() {
                tab.status = Status::new(
                    Tone::Info,
                    "No comments yet; v selects lines and c comments.",
                );
            } else {
                tab.list = Some(0);
            }
        }
        ReviewAction::Summary => tab.input = Some(Input::Summary(tab.comments.summary.clone())),
        ReviewAction::Copy => {
            if tab.comments.is_empty() {
                tab.status = Status::new(Tone::Info, "Nothing to copy yet.");
            } else {
                let document =
                    review_comments::document(&tab.comments, review_comments::PASTE_BYTES);
                result.clipboard = Some(document.text);
                tab.status = Status::new(Tone::Info, "Review copied for pasting.");
            }
        }
        ReviewAction::Refresh => {
            if tab.review_id.is_some() {
                tab.diff_wanted = true;
                tab.context_revision = None;
                tab.status = None;
            } else if tab.opening.is_none() {
                restart_open(app, index);
            }
        }
        ReviewAction::Send => begin_send(app, index),
        ReviewAction::Close => close(app, index),
        ReviewAction::Back => {
            if tab.view.anchor.is_some() {
                tab.view.anchor = None;
            } else if tab.status.is_some() && !tab.is_sending() {
                tab.status = None;
            } else {
                unfocus(app);
            }
        }
    }
}

fn begin_send(app: &mut App, index: usize) {
    let tab = &mut app.reviews.tabs[index];
    let Some(review_id) = tab.review_id.clone() else {
        tab.status = Status::new(Tone::Info, "The review is still opening.");
        return;
    };
    if tab.comments.is_empty() {
        tab.status = Status::new(
            Tone::Info,
            "Nothing to send: add a comment (c) or a summary (C).",
        );
        return;
    }
    if tab.is_sending() {
        tab.status = Status::new(Tone::Info, "A delivery is already in progress.");
        return;
    }
    app.reviews.picking = Some(review_id);
    app.palette_expanded = false;
    app.palette_category = 0;
    app.begin_palette("@ ".into());
    app.notice = "Choose the agent that receives the review · Enter sends · Esc cancels".into();
}

pub fn click(app: &mut App, hit: crate::ui_review::Hit) {
    let Some(tab) = app.reviews.active_mut() else {
        return;
    };
    match hit {
        crate::ui_review::Hit::File(index) => {
            tab.view.pane = Pane::Files;
            if index != tab.view.file {
                tab.select_file(index);
            }
        }
        crate::ui_review::Hit::Row(row) => {
            tab.view.pane = Pane::Diff;
            tab.view.cursor = row.min(tab.current_rows().len().saturating_sub(1));
        }
        crate::ui_review::Hit::Inside => {}
    }
}

pub fn scroll(app: &mut App, up: bool) {
    if let Some(tab) = app.reviews.active_mut() {
        let rows = tab.current_rows().len();
        tab.view.scroll = if up {
            tab.view.scroll.saturating_sub(3)
        } else {
            (tab.view.scroll + 3).min(rows.saturating_sub(1))
        };
        let top = tab.view.scroll;
        tab.view.cursor = tab.view.cursor.max(top).min(rows.saturating_sub(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn review_rows_number_both_sides_and_keep_meta_without_hunks() {
        let rows = rows(
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,3 +20,3 @@ fn\n-old\n+new\n same\n\\ No newline at end of file",
        );
        assert_eq!(rows[0].kind, RowKind::Hunk);
        assert_eq!(
            (rows[1].kind, rows[1].old, rows[1].new),
            (RowKind::Removed, Some(10), None)
        );
        assert_eq!(
            (rows[2].kind, rows[2].new, rows[2].text.as_str()),
            (RowKind::Added, Some(20), "new")
        );
        assert_eq!((rows[3].old, rows[3].new), (Some(11), Some(21)));
        assert_eq!(rows[4].kind, RowKind::Meta);
        let binary = super::rows("Binary files differ");
        assert_eq!(binary.len(), 1);
        assert_eq!(binary[0].kind, RowKind::Meta);
    }

    #[test]
    fn review_split_pairs_face_unique_twins_and_fill_gaps_by_position() {
        let rows = rows("@@ -1,5 +1,5 @@\n ctx\n-a\n-moved\n-b\n+x\n+moved\n+y\n+z\n tail");
        let pairs = split_pairs(&rows);
        let text = |index: Option<usize>| index.map(|i| rows[i].text.as_str());
        let shown: Vec<_> = pairs.iter().map(|(l, r)| (text(*l), text(*r))).collect();
        assert_eq!(shown[0], (Some("@@ -1,5 +1,5 @@"), Some("@@ -1,5 +1,5 @@")));
        assert_eq!(shown[1], (Some("ctx"), Some("ctx")));
        assert_eq!(shown[2], (Some("a"), Some("x")));
        assert_eq!(shown[3], (Some("moved"), Some("moved")));
        assert_eq!(shown[4], (Some("b"), Some("y")));
        assert_eq!(shown[5], (None, Some("z")));
        assert_eq!(shown[6], (Some("tail"), Some("tail")));
        let duplicate = super::rows("@@ -1,2 +1,1 @@\n-dup\n-dup\n+dup");
        assert_eq!(
            split_pairs(&duplicate),
            vec![(Some(0), Some(0)), (Some(1), Some(3)), (Some(2), None)]
        );
        assert_eq!(
            longest_increasing(&[(0, 2), (1, 0), (2, 1)]),
            vec![(1, 0), (2, 1)]
        );
    }

    #[test]
    fn review_late_opened_reply_for_a_timed_out_request_reuses_its_tab() {
        let mut app = App::new(4);
        app.event(json!({"type":"capabilities","workspace":"/w","gitDiff":true,"reviews":true,"programs":[]}))
            .unwrap();
        let url = "https://github.com/o/r/pull/5";
        let open = open(&mut app, Source::Pull(url.into()));
        let request = open[0]["requestId"].clone();
        let expired = Instant::now()
            .checked_sub(OPEN_TIMEOUT + Duration::from_secs(1))
            .unwrap();
        app.reviews.tabs[0].sent_at = Some(expired);
        tick(&mut app);
        assert!(!app.reviews.tabs[0].is_opening() && app.reviews.tabs[0].error.is_some());
        let commands = app
            .event(json!({"type":"reviewOpened","requestId":request,"reviewId":"pull-o-r-5",
                "directory":"/cfg/o-r-5","source":{"kind":"pull","url":url,"owner":"o","repo":"r",
                "number":5,"title":"Fix","state":"OPEN","headRef":"f","baseRef":"main","headOid":"abc"},
                "base":null,"head":{"ref":"f","oid":"abc"},"scope":"unstaged","revision":"x","checks":null}))
            .unwrap();
        assert_eq!(app.reviews.tabs.len(), 1);
        let tab = &app.reviews.tabs[0];
        assert_eq!(tab.review_id.as_deref(), Some("pull-o-r-5"));
        assert!(tab.error.is_none() && tab.expired_open.is_none());
        assert_eq!(commands[0]["type"], "getDiff");
    }

    #[test]
    fn review_action_table_maps_reviewr_keys_and_ignores_shift_on_letters() {
        let key = |code, modifiers| action(KeyEvent::new(code, modifiers));
        assert_eq!(
            key(KeyCode::Char('F'), KeyModifiers::SHIFT),
            Some(ReviewAction::PrevFile)
        );
        assert_eq!(
            key(KeyCode::Char('|'), KeyModifiers::SHIFT),
            Some(ReviewAction::Split)
        );
        assert_eq!(
            key(KeyCode::Char('d'), KeyModifiers::CONTROL),
            Some(ReviewAction::HalfDown)
        );
        assert_eq!(
            key(KeyCode::Char('d'), KeyModifiers::NONE),
            Some(ReviewAction::Delete)
        );
        assert_eq!(key(KeyCode::Char('x'), KeyModifiers::NONE), None);
        assert_eq!(key(KeyCode::Char('j'), KeyModifiers::ALT), None);
        for (code, modifiers, _) in BINDINGS {
            assert!(action(KeyEvent::new(*code, *modifiers)).is_some());
        }
    }
}
