use crate::{
    launch::{Capabilities, DirectoryEntry, Program, SessionForm},
    status::Status,
    terminal::TerminalState,
    theme::Theme,
};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn fuzzy_contains(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|character| chars.any(|candidate| candidate == character))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub program: Program,
    pub cols: u16,
    pub rows: u16,
    pub running: bool,
    #[serde(default)]
    pub rate_limited: bool,
    #[serde(default)]
    pub wake_at: Option<i64>,
    #[serde(default)]
    pub attention: Option<Attention>,
    #[serde(default)]
    pub muted: bool,
    pub group_id: Option<String>,
    pub controller_id: Option<u64>,
    #[serde(default)]
    pub status: Option<Status>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Attention {
    pub sequence: u64,
    pub kind: String,
    pub at: u64,
    pub unread: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
    Everything,
    Agents,
    Terminals,
    Attention,
}

impl SearchScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Everything => "everything",
            Self::Agents => "agents",
            Self::Terminals => "terminals",
            Self::Attention => "needs you",
        }
    }
}

pub fn search_scope(query: &str) -> (SearchScope, &str) {
    let query = query.trim_start();
    for (prefix, scope) in [
        ('@', SearchScope::Agents),
        ('$', SearchScope::Terminals),
        ('!', SearchScope::Attention),
    ] {
        if let Some(rest) = query.strip_prefix(prefix) {
            return (scope, rest.trim_start());
        }
    }
    (SearchScope::Everything, query)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub order: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Root,
    Group(String),
    Session(String),
}

#[derive(Clone, Debug)]
pub struct TreeRow {
    pub kind: RowKind,
    pub depth: usize,
    pub label: String,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Navigate,
    Input,
}

pub enum TextAction {
    RenameSession { id: String },
    RenameGroup { id: String },
}

pub enum MoveTarget {
    Session(String),
    Group(String),
}

pub enum Dialog {
    Menu,
    QuickSwitch {
        query: String,
        selected: usize,
    },
    ExitConfirm {
        from_menu: bool,
        leave_selected: bool,
    },
    Settings {
        selected: usize,
    },
    NewGroup {
        name: String,
        parent_index: usize,
        editing_parent: bool,
    },
    NewSession(SessionForm),
    FolderPicker {
        form: SessionForm,
        path: String,
        parent: Option<String>,
        entries: Vec<DirectoryEntry>,
        query: String,
        selected: usize,
        loading: bool,
    },
    PairPhone,
    Text {
        title: String,
        value: String,
        action: TextAction,
    },
    Move {
        target: MoveTarget,
        choices: Vec<(Option<String>, String)>,
        selected: usize,
    },
    Confirm {
        title: String,
        detail: String,
        command: Value,
    },
    Help,
}

pub(crate) fn folder_choices<'a>(
    parent: &'a Option<String>,
    entries: &'a [DirectoryEntry],
    query: &str,
) -> Vec<(&'a str, &'a str)> {
    let mut choices = Vec::new();
    if query.is_empty()
        && let Some(path) = parent
    {
        choices.push(("..  Parent folder", path.as_str()));
    }
    let needle = query.to_lowercase();
    choices.extend(
        entries
            .iter()
            .filter(|entry| entry.name.to_lowercase().contains(&needle))
            .map(|entry| (entry.name.as_str(), entry.path.as_str())),
    );
    choices
}

pub struct App {
    pub palette_expanded: bool,
    pub palette_category: usize,
    pub overlay: Option<crate::toolbox::Overlay>,
    pub status_filters: HashSet<usize>,
    pub schedules: Vec<Value>,
    pub review: crate::review::ReviewState,
    pub client_id: u64,
    pub sessions: Vec<Session>,
    pub groups: Vec<Group>,
    pub revision: u64,
    pub terminals: HashMap<String, TerminalState>,
    pub leases: HashMap<String, String>,
    pub subscribed: HashSet<String>,
    pub collapsed: HashSet<String>,
    pub selected: usize,
    pub tabs: Vec<String>,
    pub recent_sessions: Vec<String>,
    pub templates: Vec<Value>,
    pub recoveries: Vec<Value>,
    pub panes: [Option<String>; 2],
    pub split: bool,
    pub fullscreen: bool,
    pub fullscreen_default: bool,
    pub focused: usize,
    pub mode: Mode,
    pub dialog: Option<Dialog>,
    pub dialog_button: Option<usize>,
    pub menu_selected: usize,
    pub theme: Theme,
    pub shortcuts: crate::shortcuts::Shortcuts,
    pub onboarded: bool,
    pub notice: String,
    pub connected: bool,
    pub capabilities: Option<Capabilities>,
    pub pairing_path: String,
    pub pairing_qr_path: String,
    request_counter: u64,
    pending_create: Option<String>,
    pending_create_form: Option<SessionForm>,
    pending_selection: Option<String>,
    pending_directory: Option<String>,
}

impl App {
    pub fn new(client_id: u64) -> Self {
        Self {
            review: Default::default(),
            overlay: None,
            palette_expanded: false,
            palette_category: 0,
            status_filters: HashSet::new(),
            schedules: Vec::new(),
            client_id,
            sessions: vec![],
            groups: vec![],
            revision: 0,
            terminals: HashMap::new(),
            leases: HashMap::new(),
            subscribed: HashSet::new(),
            collapsed: HashSet::new(),
            selected: 0,
            tabs: Vec::new(),
            recent_sessions: Vec::new(),
            templates: Vec::new(),
            recoveries: Vec::new(),
            panes: [None, None],
            split: false,
            fullscreen: false,
            fullscreen_default: false,
            focused: 0,
            mode: Mode::Navigate,
            dialog: None,
            dialog_button: None,
            menu_selected: 0,
            theme: Theme::default(),
            shortcuts: Default::default(),
            onboarded: false,
            notice: String::new(),
            connected: true,
            capabilities: None,
            pairing_path: String::new(),
            pairing_qr_path: String::new(),
            request_counter: 0,
            pending_create: None,
            pending_create_form: None,
            pending_selection: None,
            pending_directory: None,
        }
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }
    pub fn active_id(&self) -> Option<&str> {
        self.panes[self.focused].as_deref()
    }
    pub fn wake_available(&self) -> bool {
        self.active_session()
            .is_some_and(|s| s.program == Program::Codex && s.running)
            && self.capabilities.as_ref().is_some_and(|caps| {
                caps.quota_wake
                    && caps.provider_limits.iter().any(|p| {
                        p.id == Program::Codex
                            && p.status == "ready"
                            && p.windows.iter().any(|w| {
                                w.duration_mins == 300
                                    && w.used_percent >= 90
                                    && w.resets_at.is_some()
                            })
                    })
            })
    }
    pub fn active_session(&self) -> Option<&Session> {
        self.active_id().and_then(|id| self.session(id))
    }
    pub fn active_terminal(&self) -> Option<&TerminalState> {
        self.active_id().and_then(|id| self.terminals.get(id))
    }
    pub fn effective_program(&self, session: &Session) -> Program {
        if session.program != Program::Shell || !session.running {
            return session.program;
        }
        let Some(terminal) = self.terminals.get(&session.id) else {
            return Program::Shell;
        };
        let screen = terminal.screen().contents();
        if screen
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .is_some_and(|line| {
                line.trim_start().starts_with("PS ") && line.trim_end().ends_with('>')
            })
        {
            return Program::Shell;
        }
        // An agent started inside a shell has no launcher identity. Its current
        // banner is a display hint only; the host still owns the real program.
        if screen.contains("Claude Code v") {
            Program::Claude
        } else if screen.contains("Gemini CLI") {
            Program::Gemini
        } else if screen.contains("OpenAI Codex") {
            Program::Codex
        } else {
            Program::Shell
        }
    }
    pub fn owns(&self, id: &str) -> bool {
        self.connected
            && self.leases.contains_key(id)
            && self
                .session(id)
                .is_some_and(|s| s.controller_id == Some(self.client_id) && s.running)
    }
    pub fn selected_row(&self) -> Option<TreeRow> {
        self.tree().get(self.selected).cloned()
    }
    pub fn selected_group(&self) -> Option<String> {
        match self.selected_row()?.kind {
            RowKind::Root => None,
            RowKind::Group(id) => Some(id),
            RowKind::Session(id) => self.session(&id).and_then(|s| s.group_id.clone()),
        }
    }

    pub fn palette_results(&self, query: &str) -> Vec<crate::palette::ResultRow> {
        crate::palette::results(self, query)
    }

    pub fn matches_status(&self, session: &Session) -> bool {
        self.status_filters.is_empty()
            || self
                .status_filters
                .contains(&crate::toolbox::status_index(session))
    }

    pub fn quick_switch_results(&self, query: &str) -> Vec<&Session> {
        let (scope, query) = search_scope(query);
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut matches: Vec<(&Session, u32)> = self
            .sessions
            .iter()
            .filter_map(|session| {
                if !self.matches_status(session) {
                    return None;
                }
                let program = self.effective_program(session);
                if (scope == SearchScope::Agents && program == Program::Shell)
                    || (scope == SearchScope::Terminals && program != Program::Shell)
                    || (scope == SearchScope::Attention
                        && !session
                            .status
                            .as_ref()
                            .is_some_and(|status| status.attention_priority() > 0))
                {
                    return None;
                }
                let mut terms = format!(
                    "{} {} {}",
                    session.name,
                    session.cwd,
                    self.effective_program(session).label()
                );
                let mut parent = session.group_id.as_deref();
                let mut seen = HashSet::new();
                while let Some(id) = parent {
                    if !seen.insert(id) {
                        break;
                    }
                    let Some(group) = self.groups.iter().find(|group| group.id == id) else {
                        break;
                    };
                    terms.push(' ');
                    terms.push_str(&group.name);
                    parent = group.parent_id.as_deref();
                }
                let haystack = terms.to_lowercase();
                let mut score = 0;
                for word in &words {
                    if session.name.to_lowercase().starts_with(word) {
                        score += 6;
                    } else if haystack.contains(word) {
                        score += 3;
                    } else if fuzzy_contains(&haystack, word) {
                        score += 1;
                    } else {
                        return None;
                    }
                }
                score += u32::from(
                    session
                        .status
                        .as_ref()
                        .is_some_and(|status| status.attention_priority() > 0),
                );
                Some((session, score))
            })
            .collect();
        matches.sort_by(|(a, a_score), (b, b_score)| {
            b_score
                .cmp(a_score)
                .then_with(|| {
                    b.status
                        .as_ref()
                        .map_or(0, Status::attention_priority)
                        .cmp(&a.status.as_ref().map_or(0, Status::attention_priority))
                })
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        matches.into_iter().map(|(session, _)| session).collect()
    }

    pub fn group_attention(&self, group_id: &str) -> Option<&Status> {
        self.sessions
            .iter()
            .filter_map(|session| {
                let status = session.status.as_ref()?;
                if status.attention_priority() == 0 {
                    return None;
                }
                let mut parent = session.group_id.as_deref();
                let mut visited = HashSet::new();
                while let Some(id) = parent {
                    if id == group_id {
                        return Some(status);
                    }
                    if !visited.insert(id) {
                        break;
                    }
                    parent = self
                        .groups
                        .iter()
                        .find(|group| group.id == id)
                        .and_then(|group| group.parent_id.as_deref());
                }
                None
            })
            .max_by_key(|status| status.attention_priority())
    }

    pub fn tree(&self) -> Vec<TreeRow> {
        let mut rows = vec![TreeRow {
            kind: RowKind::Root,
            depth: 0,
            label: "sessions".into(),
        }];
        self.append_sessions(None, 1, &mut rows);
        self.append_children(None, 0, &mut rows, &mut HashSet::new());
        rows
    }

    fn append_sessions(&self, group_id: Option<&str>, depth: usize, rows: &mut Vec<TreeRow>) {
        rows.extend(self.sessions.iter().filter_map(|session| {
            let belongs = match (group_id, session.group_id.as_deref()) {
                (Some(group), Some(id)) => group == id,
                (None, None) => true,
                // A stale group reference must not make a live session disappear.
                (None, Some(id)) => !self.groups.iter().any(|group| group.id == id),
                _ => false,
            };
            (belongs && self.matches_status(session)).then(|| TreeRow {
                kind: RowKind::Session(session.id.clone()),
                depth,
                label: session.name.clone(),
            })
        }));
    }

    fn append_children(
        &self,
        parent: Option<&str>,
        depth: usize,
        rows: &mut Vec<TreeRow>,
        visited: &mut HashSet<String>,
    ) {
        if depth > 64 {
            return;
        }
        let mut groups: Vec<_> = self
            .groups
            .iter()
            .filter(|g| g.parent_id.as_deref() == parent)
            .collect();
        groups.sort_by_key(|g| (g.order, g.name.as_str(), g.id.as_str()));
        for group in groups {
            if !visited.insert(group.id.clone()) {
                continue;
            }
            rows.push(TreeRow {
                kind: RowKind::Group(group.id.clone()),
                depth,
                label: group.name.clone(),
            });
            if !self.collapsed.contains(&group.id) {
                self.append_sessions(Some(&group.id), depth + 1, rows);
                self.append_children(Some(&group.id), depth + 1, rows, visited);
            }
        }
    }

    pub fn open_session(&mut self, id: &str) -> Vec<Value> {
        if self.session(id).is_none() {
            return vec![];
        }
        if !self.tabs.iter().any(|tab| tab == id) {
            self.tabs.push(id.into());
        }
        if self.split && self.panes[1 - self.focused].as_deref() == Some(id) {
            self.focused = 1 - self.focused;
        }
        self.panes[self.focused] = Some(id.into());
        self.mode = Mode::Navigate;
        let mut commands = Vec::new();
        if self.subscribed.insert(id.into()) {
            commands.push(json!({"type":"subscribe", "sessionId":id}));
        }
        // Only currently visible panes are subscribed. Hidden shells keep running on the host.
        let stale: Vec<_> = self
            .subscribed
            .iter()
            .filter(|id| {
                self.panes[0].as_ref() != Some(id)
                    && (!self.split || self.panes[1].as_ref() != Some(id))
            })
            .cloned()
            .collect();
        for id in stale {
            if let Some(lease) = self.leases.remove(&id) {
                commands.push(json!({"type":"releaseControl","sessionId":id,"leaseId":lease}));
            }
            self.subscribed.remove(&id);
            self.terminals.remove(&id);
            commands.push(json!({"type":"unsubscribe","sessionId":id}));
        }
        commands
    }

    /// Explicitly entering a pane starts an unowned shell, but never takes a lease away.
    pub fn preview_session(&mut self, id: &str) -> Vec<Value> {
        let mut commands = Vec::new();
        let stale: Vec<_> = self
            .subscribed
            .iter()
            .filter(|candidate| {
                candidate.as_str() != id
                    && !self.panes.iter().flatten().any(|pane| pane == *candidate)
            })
            .cloned()
            .collect();
        for stale in stale {
            if self.leases.contains_key(&stale) {
                continue;
            }
            self.subscribed.remove(&stale);
            self.terminals.remove(&stale);
            commands.push(json!({"type":"unsubscribe", "sessionId":stale}));
        }
        if self.subscribed.insert(id.to_owned()) {
            commands.push(json!({"type":"subscribe", "sessionId":id}));
        }
        commands
    }

    pub fn activate_session(&mut self, id: &str) -> Vec<Value> {
        if self.session(id).is_some() {
            self.recent_sessions.retain(|recent| recent != id);
            self.recent_sessions.insert(0, id.to_owned());
            self.recent_sessions.truncate(32);
        }
        let mut commands = self.open_session(id);
        if let Some(attention) = self
            .session(id)
            .and_then(|s| s.attention.as_ref())
            .filter(|a| a.unread)
        {
            commands.push(
                json!({"type":"acknowledgeAttention","sessionId":id,"sequence":attention.sequence}),
            );
        }
        let mut parent = self
            .session(id)
            .and_then(|session| session.group_id.clone());
        let mut visited = HashSet::new();
        while let Some(group_id) = parent {
            if !visited.insert(group_id.clone()) {
                break;
            }
            self.collapsed.remove(&group_id);
            parent = self
                .groups
                .iter()
                .find(|group| group.id == group_id)
                .and_then(|group| group.parent_id.clone());
        }
        if let Some(index) = self
            .tree()
            .iter()
            .position(|row| row.kind == RowKind::Session(id.into()))
        {
            self.selected = index;
        }
        let Some(session) = self.session(id) else {
            return commands;
        };
        if !self.connected || !session.running {
            return commands;
        }
        if self.owns(id) {
            self.mode = Mode::Input;
            self.notice.clear();
        } else if session.controller_id.is_none() {
            commands.push(json!({"type":"acquireControl","sessionId":id,
                "takeOver":false,"cols":session.cols,"rows":session.rows}));
            self.notice = "Starting terminal…".into();
        } else {
            self.notice = "Read-only view · another device has control · t takes over".into();
        }
        commands
    }

    pub fn event(&mut self, event: Value) -> Result<Vec<Value>> {
        let mut commands = Vec::new();
        match event["type"].as_str().unwrap_or_default() {
            "diff" => {
                if event["requestId"].as_str() == self.review.request_id.as_deref()
                    && event["sessionId"].as_str() == Some(self.review.session_id.as_str())
                {
                    self.review.request_id = None;
                    self.review.error = event["error"].as_str().map(str::to_owned);
                    if self.review.error.is_none() {
                        self.review
                            .accept(serde_json::from_value(event["review"].clone())?);
                    }
                }
            }
            "capabilities" => {
                self.capabilities = Some(serde_json::from_value(event)?);
            }
            "directories" => {
                if event["requestId"].as_str() == self.pending_directory.as_deref() {
                    self.pending_directory = None;
                    if let Some(Dialog::FolderPicker {
                        path,
                        parent,
                        entries,
                        query,
                        selected,
                        loading,
                        ..
                    }) = &mut self.dialog
                    {
                        *path = event["path"].as_str().unwrap_or_default().to_owned();
                        *parent = event["parent"].as_str().map(str::to_owned);
                        *entries = serde_json::from_value(event["entries"].clone())?;
                        query.clear();
                        *selected = 0;
                        *loading = false;
                    }
                }
            }
            "sessions" => {
                let palette_target =
                    if let Some(Dialog::QuickSwitch { query, selected }) = &self.dialog {
                        self.palette_results(query)
                            .get(*selected)
                            .map(|row| row.target.clone())
                    } else {
                        None
                    };
                let selected = self
                    .pending_selection
                    .as_ref()
                    .map(|id| RowKind::Session(id.clone()))
                    .or_else(|| self.selected_row().map(|row| row.kind));
                self.sessions = serde_json::from_value(event["sessions"].clone())?;
                self.groups = serde_json::from_value(event["groups"].clone())?;
                self.collapsed
                    .retain(|id| self.groups.iter().any(|group| &group.id == id));
                self.revision = event["revision"].as_u64().unwrap_or(0);
                self.leases.retain(|id, _| {
                    self.sessions
                        .iter()
                        .any(|s| s.id == *id && s.controller_id == Some(self.client_id))
                });
                self.terminals
                    .retain(|id, _| self.sessions.iter().any(|s| s.id == *id));
                self.subscribed
                    .retain(|id| self.sessions.iter().any(|s| s.id == *id));
                self.tabs
                    .retain(|id| self.sessions.iter().any(|s| s.id == *id));
                self.recent_sessions
                    .retain(|id| self.sessions.iter().any(|s| s.id == *id));
                for pane in &mut self.panes {
                    if pane
                        .as_ref()
                        .is_some_and(|id| !self.sessions.iter().any(|s| &s.id == id))
                    {
                        *pane = None;
                    }
                }
                if let Some(id) = self.pending_selection.take() {
                    commands.extend(self.activate_session(&id));
                }
                if self.panes[0].is_none()
                    && self.focused == 0
                    && let Some(id) = self.sessions.first().map(|s| s.id.clone())
                {
                    commands.extend(self.open_session(&id));
                }
                let tree = self.tree();
                self.selected = selected
                    .and_then(|kind| tree.iter().position(|row| row.kind == kind))
                    .unwrap_or(self.selected.min(tree.len().saturating_sub(1)));
                if self.selected == 0 && tree.len() > 1 {
                    self.selected = 1;
                }
                if let Some(target) = palette_target
                    && let Some(Dialog::QuickSwitch { query, .. }) = &self.dialog
                {
                    let index = self
                        .palette_results(query)
                        .iter()
                        .position(|row| row.target == target)
                        .unwrap_or(0);
                    if let Some(Dialog::QuickSwitch { selected, .. }) = &mut self.dialog {
                        *selected = index;
                    }
                }
            }
            "schedules" => {
                let id = if let Some(crate::toolbox::Overlay::Schedules(selected)) = self.overlay {
                    crate::toolbox::schedule_identity(&self.schedules, selected).map(str::to_owned)
                } else {
                    None
                };
                self.schedules = serde_json::from_value(event["schedules"].clone())?;
                if matches!(self.overlay, Some(crate::toolbox::Overlay::Schedules(_))) {
                    let selected = id
                        .and_then(|id| self.schedules.iter().position(|job| job["id"] == id))
                        .unwrap_or(0);
                    self.overlay = Some(crate::toolbox::Overlay::Schedules(selected));
                }
            }
            "templates" | "recovery" => {
                let recovery = event["type"] == "recovery";
                let rows = if recovery {
                    &mut self.recoveries
                } else {
                    &mut self.templates
                };
                let selected_id =
                    if let Some(crate::toolbox::Overlay::Recipes(kind, index)) = self.overlay {
                        if kind == recovery {
                            rows.get(index)
                                .and_then(|row| row["id"].as_str())
                                .map(str::to_owned)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                *rows = serde_json::from_value(
                    event[if recovery { "records" } else { "templates" }].clone(),
                )?;
                if matches!(self.overlay, Some(crate::toolbox::Overlay::Recipes(kind, _)) if kind == recovery)
                {
                    let index = selected_id
                        .and_then(|id| rows.iter().position(|r| r["id"] == id))
                        .unwrap_or(0);
                    self.overlay = Some(crate::toolbox::Overlay::Recipes(recovery, index));
                }
                self.notice = if recovery {
                    "Saved processes require explicit restart; old prompts are not replayed."
                } else {
                    "Launch templates loaded."
                }
                .into();
            }
            "wakeConfigured" => {
                self.notice = if event["wakeAt"].is_null() {
                    "Automatic wake disabled."
                } else {
                    "One retry armed after verified reset. Typing into this session cancels it."
                }
                .into();
            }
            "scheduled" => {
                self.pending_create = None;
                self.pending_create_form = None;
                self.notice = "Session scheduled on the host. S opens schedules.".into();
            }
            "created" => {
                if self.pending_create.is_some()
                    && event["requestId"].as_str() == self.pending_create.as_deref()
                {
                    self.pending_selection = event["sessionId"].as_str().map(str::to_owned);
                    self.pending_create = None;
                    self.pending_create_form = None;
                    self.notice = "Session created. Starting terminal…".into();
                }
            }
            "subscribed" => {
                if let Some(id) = event["sessionId"].as_str() {
                    let (rows, cols) = dimensions(&event);
                    self.terminals
                        .insert(id.into(), TerminalState::new(rows, cols));
                }
            }
            "control" => {
                if let Some(id) = event["sessionId"].as_str() {
                    let (rows, cols) = dimensions(&event);
                    let owner = event["controllerId"].as_u64();
                    if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                        session.controller_id = owner;
                        session.cols = cols;
                        session.rows = rows;
                    }
                    if let Some(terminal) = self.terminals.get_mut(id) {
                        terminal.resize(rows, cols);
                    }
                    if owner == Some(self.client_id) {
                        if let Some(lease) = event["leaseId"].as_str() {
                            let fresh =
                                self.leases.get(id).is_none_or(|previous| previous != lease);
                            self.leases.insert(id.into(), lease.into());
                            if fresh && self.active_id() == Some(id) {
                                self.mode = Mode::Input;
                                self.notice.clear();
                            }
                        }
                    } else {
                        let lost = self.leases.remove(id).is_some();
                        if lost && self.active_id() == Some(id) {
                            self.mode = Mode::Navigate;
                            self.notice =
                                "Control changed. You are watching; t explicitly takes control."
                                    .into();
                        }
                    }
                }
            }
            "output" => {
                if let (Some(id), Some(data)) =
                    (event["sessionId"].as_str(), event["data"].as_str())
                {
                    let may_reply = self.owns(id)
                        && (event["replay"] != true || event["allowResponses"] == true);
                    if let Some(terminal) = self.terminals.get_mut(id) {
                        let replies = terminal.process(data, may_reply);
                        if let Some(lease) = self.leases.get(id) {
                            commands.extend(replies.into_iter().map(|data| json!({"type":"input","sessionId":id,"leaseId":lease,"data":data})));
                        }
                    }
                }
            }
            "error" => {
                self.notice = event["message"]
                    .as_str()
                    .unwrap_or("Host rejected the request")
                    .into();
                if event["code"] == "revision_conflict" {
                    commands.push(json!({"type":"list"}));
                }
                if event["requestId"].as_str() == self.pending_directory.as_deref() {
                    self.pending_directory = None;
                    if let Some(Dialog::FolderPicker { loading, .. }) = &mut self.dialog {
                        *loading = false;
                    }
                }
                if self.pending_create.is_some()
                    && event["requestId"].as_str() == self.pending_create.as_deref()
                {
                    self.pending_create = None;
                    if let Some(form) = self.pending_create_form.take() {
                        self.dialog = Some(Dialog::NewSession(form));
                    }
                }
            }
            _ => {}
        }
        Ok(commands)
    }

    pub fn disconnect(&mut self, message: String) {
        self.connected = false;
        self.leases.clear();
        self.mode = Mode::Navigate;
        self.dialog = None;
        self.dialog_button = None;
        self.pending_directory = None;
        self.notice = if self.capabilities.is_none() {
            "Host disconnected during setup; update nesvo-host and reconnect.".into()
        } else {
            message
        };
    }

    pub fn input(&mut self, data: String) -> Option<Value> {
        let id = self.active_id()?.to_owned();
        if !self.owns(&id) {
            self.notice = "Read-only view. Press i to acquire control, or t to take over.".into();
            return None;
        }
        if data.len() > 32 * 1024 || data.chars().count() > 8192 {
            self.notice = "Input exceeds 8192 characters / 32 KiB; nothing was sent.".into();
            return None;
        }
        if let Some(terminal) = self.terminals.get_mut(&id) {
            terminal.scroll_to_bottom();
        }
        Some(json!({"type":"input","sessionId":id,"leaseId":self.leases.get(&id),"data":data}))
    }

    pub fn auto_refresh_diff(&mut self) -> Option<Value> {
        if self.connected
            && self.review.visible
            && !crate::ui::immersive(self)
            && self.dialog.is_none()
            && self.overlay.is_none()
            && self.review.request_id.is_none()
            && self.capabilities.as_ref().is_some_and(|caps| caps.git_diff)
            && self
                .review
                .last_requested
                .is_some_and(|at| at.elapsed() >= std::time::Duration::from_secs(3))
        {
            self.request_diff()
        } else {
            None
        }
    }

    pub fn request_diff(&mut self) -> Option<Value> {
        let id = self.active_id()?.to_owned();
        self.review.last_requested = Some(std::time::Instant::now());
        self.review.visible = true;
        self.review.error = None;
        if !self.capabilities.as_ref().is_some_and(|caps| caps.git_diff) {
            self.review.error =
                Some("This host does not support Git review. Update nesvo-host.".into());
            return None;
        }
        if self.review.session_id != id {
            self.review.data = Default::default();
            self.review.file = 0;
            self.review.hunk = 0;
            self.review.scroll = 0;
            self.review.folded.clear();
        }
        self.review.session_id = id.clone();
        let command = self.request(json!({"type":"getDiff", "sessionId":id, "scope":crate::review::SCOPES[self.review.scope]}));
        self.review.request_id = command["requestId"].as_str().map(str::to_owned);
        Some(command)
    }

    pub fn request(&mut self, mut command: Value) -> Value {
        self.request_counter += 1;
        let id = format!("tui-{}-{}", self.client_id, self.request_counter);
        if matches!(
            command["type"].as_str(),
            Some("create" | "launch" | "scheduleSession" | "restoreSession")
        ) {
            self.pending_create = Some(id.clone());
        }
        command["requestId"] = id.into();
        command
    }

    pub fn browse_directory(&mut self, path: String) -> Value {
        if let Some(Dialog::FolderPicker { loading, .. }) = &mut self.dialog {
            *loading = true;
        }
        let command = self.request(json!({"type":"listDirectories", "path":path}));
        self.pending_directory = command["requestId"].as_str().map(str::to_owned);
        command
    }

    pub fn pending_directory_cancel(&mut self) {
        self.pending_directory = None;
    }

    pub fn submit_dialog(&mut self) -> Option<Value> {
        let dialog = self.dialog.take()?;
        self.dialog_button = None;
        match dialog {
            Dialog::NewSession(form) => {
                let auto_title = form.name.trim().is_empty() && form.program != Program::Shell;
                let name = if auto_title {
                    form.program.label()
                } else {
                    form.name.trim()
                };
                let error = if name.is_empty() || name.chars().count() > 80 {
                    Some("Use a name of 1–80 characters.")
                } else if !self.connected {
                    Some("Reconnect to the host before creating a session.")
                } else if self.capabilities.is_none() {
                    Some("Waiting for available programs from the host.")
                } else if !self
                    .capabilities
                    .as_ref()
                    .is_some_and(|caps| caps.available(form.program))
                {
                    Some(
                        "This program is unavailable on the host. Install it and restart the host.",
                    )
                } else {
                    None
                };
                if let Some(message) = error {
                    self.notice = message.into();
                    self.dialog = Some(Dialog::NewSession(form));
                    return None;
                }
                let advanced =
                    auto_title || form.worktree || !form.prompt.is_empty() || !form.when.is_empty();
                if advanced
                    && !self
                        .capabilities
                        .as_ref()
                        .is_some_and(|caps| caps.advanced_launch)
                {
                    self.notice = "Update the host to use launch options.".into();
                    self.dialog = Some(Dialog::NewSession(form));
                    return None;
                }
                let spec = json!({"name":name,"cwd":form.cwd.trim(), "program":form.program,"groupId":form.group_id,"prompt":form.prompt,"worktree":form.worktree,"autoTitle":auto_title});
                let command = if !form.when.is_empty() {
                    json!({"type":"scheduleSession","spec":spec,"at":form.when.trim()})
                } else if advanced {
                    json!({"type":"launch","spec":spec})
                } else {
                    json!({"type":"create","name":name,"cwd":form.cwd.trim(),"program":form.program,"groupId":form.group_id})
                };
                self.pending_create_form = Some(form);
                Some(self.request(command))
            }
            Dialog::NewGroup {
                name, parent_index, ..
            } => {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 80 {
                    self.notice = "Use a group name of 1–80 characters.".into();
                    self.dialog = Some(Dialog::NewGroup {
                        name: name.into(),
                        parent_index,
                        editing_parent: false,
                    });
                    return None;
                }
                let parent_id = self.group_choices(None).get(parent_index)?.0.clone();
                Some(self.request(json!({"type":"createGroup", "name":name, "parentId":parent_id, "expectedRevision":self.revision})))
            }
            Dialog::Text {
                title,
                value,
                action,
            } => {
                let name = value.trim();
                if name.is_empty()
                    || name.chars().count() > 80
                    || name.chars().any(char::is_control)
                {
                    self.notice = "Use a name of 1–80 characters.".into();
                    self.dialog = Some(Dialog::Text {
                        title,
                        value,
                        action,
                    });
                    return None;
                }
                let command = match action {
                    TextAction::RenameSession { id } => {
                        json!({"type":"renameSession","sessionId":id,"name":name})
                    }
                    TextAction::RenameGroup { id } => {
                        let group = self.groups.iter().find(|g| g.id == id)?;
                        json!({"type":"updateGroup","groupId":id,"name":name,"parentId":group.parent_id,"order":group.order,"expectedRevision":self.revision})
                    }
                };
                Some(self.request(command))
            }
            Dialog::Move {
                target,
                choices,
                selected,
            } => {
                let parent = choices.get(selected)?.0.clone();
                let command = match target {
                    MoveTarget::Session(id) => {
                        json!({"type":"moveSession","sessionId":id,"groupId":parent,"expectedRevision":self.revision})
                    }
                    MoveTarget::Group(id) => {
                        let group = self.groups.iter().find(|g| g.id == id)?;
                        json!({"type":"updateGroup","groupId":id,"name":group.name,"parentId":parent,"order":group.order,"expectedRevision":self.revision})
                    }
                };
                Some(self.request(command))
            }
            Dialog::Confirm { command, .. } => Some(self.request(command)),
            Dialog::Help
            | Dialog::QuickSwitch { .. }
            | Dialog::PairPhone
            | Dialog::Menu
            | Dialog::ExitConfirm { .. }
            | Dialog::FolderPicker { .. }
            | Dialog::Settings { .. } => None,
        }
    }

    pub fn group_choices(&self, exclude: Option<&str>) -> Vec<(Option<String>, String)> {
        let mut choices = vec![(None, "Root / ungrouped".into())];
        for group in &self.groups {
            let mut cursor = Some(group.id.as_str());
            let mut path = Vec::new();
            let mut seen = HashSet::new();
            let mut valid = true;
            while let Some(id) = cursor {
                if Some(id) == exclude || !seen.insert(id) {
                    valid = false;
                    break;
                }
                let Some(parent) = self.groups.iter().find(|g| g.id == id) else {
                    break;
                };
                path.push(parent.name.as_str());
                cursor = parent.parent_id.as_deref();
            }
            if valid {
                path.reverse();
                choices.push((Some(group.id.clone()), path.join(" / ")));
            }
        }
        choices[1..].sort_by(|a, b| a.1.cmp(&b.1));
        choices
    }
}

fn dimensions(event: &Value) -> (u16, u16) {
    (
        event["rows"].as_u64().unwrap_or(24).clamp(2, 150) as u16,
        event["cols"].as_u64().unwrap_or(80).clamp(10, 300) as u16,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_before_capabilities_points_to_host_update() {
        let mut app = App::new(1);
        app.disconnect("Host connection interrupted".into());
        assert!(app.notice.contains("update nesvo-host"));
        app.capabilities = Some(Capabilities::default());
        app.disconnect("Network connection lost".into());
        assert_eq!(app.notice, "Network connection lost");
    }

    #[test]
    fn opening_another_session_keeps_both_tabs_and_prunes_closed_ones() {
        let mut app = App::new(1);
        app.event(serde_json::json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"first","name":"First","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.open_session("second");
        assert_eq!(app.tabs, ["first", "second"]);
        assert_eq!(app.active_id(), Some("second"));
        app.event(serde_json::json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        assert_eq!(app.tabs, ["second"]);
    }

    fn snapshot() -> Value {
        json!({"type":"sessions","revision":7,"groups":[
        {"id":"a","parentId":null,"name":"Work","order":0},
        {"id":"b","parentId":"a","name":"API","order":0}],"sessions":[
        {"id":"s","name":"same","cwd":".","cols":80,"rows":24,"running":true,"groupId":"b","controllerId":null}]})
    }

    #[test]
    fn nested_tree_and_move_picker_do_not_allow_descendant_parent() {
        let mut app = App::new(1);
        app.event(snapshot()).unwrap();
        let rows = app.tree();
        assert_eq!(
            rows.iter().map(|row| row.depth).collect::<Vec<_>>(),
            vec![0, 0, 1, 2]
        );
        assert_eq!(app.group_choices(Some("a")).len(), 1);
        app.collapsed.insert("a".into());
        assert_eq!(app.tree().len(), 2);
        app.activate_session("s");
        assert_eq!(app.tree().len(), 4);
        assert_eq!(app.selected, 3);
        assert_eq!(app.sessions[0].program, Program::Shell);
    }

    #[test]
    fn quick_switch_finds_agent_folder_and_group_with_fuzzy_terms() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[
            {"id":"work","parentId":null,"name":"Workspace","order":0}
        ],"sessions":[
            {"id":"claude","name":"Repair login","cwd":"C:/dev/auth","program":"claude","cols":80,"rows":24,"running":true,"groupId":"work","controllerId":null},
            {"id":"codex","name":"Refactor UI","cwd":"C:/dev/app","program":"codex","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        assert_eq!(app.quick_switch_results("repair auth")[0].id, "claude");
        assert_eq!(app.quick_switch_results("codex")[0].id, "codex");
        assert_eq!(app.quick_switch_results("wrkspace")[0].id, "claude");
        assert!(app.quick_switch_results("missing").is_empty());
    }

    #[test]
    fn palette_scopes_filter_real_programs_and_verified_attention() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"shell","name":"API terminal","cwd":"/api","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"agent","name":"API review","cwd":"/api","program":"codex","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,"status":{"state":"question","source":"screen","updatedAt":1}}
        ]})).unwrap();
        assert_eq!(app.quick_switch_results("@ api")[0].id, "agent");
        assert_eq!(app.quick_switch_results("$ api")[0].id, "shell");
        assert_eq!(app.quick_switch_results("! api")[0].id, "agent");
        assert_eq!(app.quick_switch_results("api").len(), 2);
        assert!(app.quick_switch_results("$ review").is_empty());
        app.sessions[1].status.as_mut().unwrap().source = crate::status::Source::Activity;
        assert!(app.quick_switch_results("!").is_empty());
    }

    #[test]
    fn sessions_follow_their_group_and_collapse_with_it() {
        let mut app = App::new(1);
        let mut data = snapshot();
        data["sessions"].as_array_mut().unwrap().push(json!({"id":"outside","name":"other","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}));
        app.event(data).unwrap();
        assert_eq!(
            app.tree()
                .iter()
                .map(|row| row.kind.clone())
                .collect::<Vec<_>>(),
            vec![
                RowKind::Root,
                RowKind::Session("outside".into()),
                RowKind::Group("a".into()),
                RowKind::Group("b".into()),
                RowKind::Session("s".into()),
            ]
        );
        app.collapsed.insert("a".into());
        assert_eq!(app.tree().len(), 3);
    }

    #[test]
    fn shell_banner_identifies_agent_for_chrome_only() {
        let mut app = App::new(1);
        app.event(snapshot()).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        assert_eq!(
            app.effective_program(app.session("s").unwrap()),
            Program::Shell
        );
        app.terminals
            .get_mut("s")
            .unwrap()
            .process("Claude Code v2.1.302\r\n", false);
        assert_eq!(
            app.effective_program(app.session("s").unwrap()),
            Program::Claude
        );
        assert_eq!(app.session("s").unwrap().program, Program::Shell);
        app.terminals
            .get_mut("s")
            .unwrap()
            .process("PS C:\\work>\r\n", false);
        assert_eq!(
            app.effective_program(app.session("s").unwrap()),
            Program::Shell
        );
    }

    #[test]
    fn group_attention_includes_collapsed_descendants_and_prefers_questions() {
        let mut app = App::new(1);
        let mut snapshot = snapshot();
        snapshot["sessions"][0]["status"] =
            json!({"state":"blocked","source":"screen","updatedAt":1});
        app.event(snapshot.clone()).unwrap();
        app.collapsed.insert("a".into());
        assert_eq!(app.group_attention("a").unwrap().label(), "~blocked");
        let mut question = snapshot["sessions"][0].clone();
        question["id"] = "q".into();
        question["status"] = json!({"state":"question","source":"screen","updatedAt":2});
        snapshot["sessions"].as_array_mut().unwrap().push(question);
        app.event(snapshot).unwrap();
        assert_eq!(app.group_attention("a").unwrap().label(), "~question");
        assert!(app.group_attention("unrelated").is_none());
    }

    #[test]
    fn create_form_preserves_group_directory_and_detected_program() {
        let mut app = App::new(7);
        app.event(
            json!({"type":"capabilities","workspace":"/work","programs":[
                {"id":"shell","label":"Terminal","available":true},
                {"id":"claude","label":"Claude","available":true},
                {"id":"gemini","label":"Gemini","available":false},
                {"id":"codex","label":"Codex","available":false}
            ]}),
        )
        .unwrap();
        app.dialog = Some(Dialog::NewSession(SessionForm {
            name: "  API work  ".into(),
            cwd: "  ../another project  ".into(),
            program: Program::Claude,
            group_id: Some("child-group".into()),
            ..Default::default()
        }));
        let command = app.submit_dialog().unwrap();
        assert_eq!(command["type"], "create");
        assert_eq!(command["name"], "API work");
        assert_eq!(command["cwd"], "../another project");
        assert_eq!(command["program"], "claude");
        assert_eq!(command["groupId"], "child-group");
        assert_eq!(command["requestId"], "tui-7-1");
        app.event(json!({"type":"error","requestId":command["requestId"],"message":"Directory does not exist"})).unwrap();
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.cwd == "  ../another project  " && form.program == Program::Claude)
        );
        assert_eq!(app.notice, "Directory does not exist");
    }

    #[test]
    fn unavailable_program_does_not_submit_or_discard_the_form() {
        let mut app = App::new(1);
        app.capabilities = Some(Capabilities::default());
        app.dialog = Some(Dialog::NewSession(SessionForm {
            name: "Work".into(),
            cwd: "C:\\My Projects".into(),
            program: Program::Codex,
            ..Default::default()
        }));
        assert!(app.submit_dialog().is_none());
        assert!(
            matches!(app.dialog, Some(Dialog::NewSession(ref form)) if form.cwd == "C:\\My Projects")
        );
        assert!(app.notice.contains("unavailable"));
        assert!(app.pending_create.is_none());
    }

    #[test]
    fn only_current_lease_can_send_and_snapshot_revokes_it() {
        let mut app = App::new(9);
        app.event(snapshot()).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        assert!(app.input("pwd\r".into()).is_none());
        app.event(json!({"type":"control","sessionId":"s","controllerId":9,"cols":80,"rows":24,"leaseId":"fresh"})).unwrap();
        assert_eq!(app.input("pwd\r".into()).unwrap()["leaseId"], "fresh");
        app.event(json!({"type":"control","sessionId":"s","controllerId":10,"cols":90,"rows":30}))
            .unwrap();
        assert!(app.input("pwd\r".into()).is_none());
        assert_eq!(app.terminals["s"].screen().size(), (30, 90));
    }

    #[test]
    fn create_response_matches_request_id_not_duplicate_name() {
        let mut app = App::new(1);
        app.event(snapshot()).unwrap();
        let request = app.request(json!({"type":"create","name":"same"}));
        app.event(json!({"type":"created","sessionId":"new","requestId":"someone-else"}))
            .unwrap();
        assert!(app.pending_selection.is_none());
        app.event(json!({"type":"created","sessionId":"new","requestId":request["requestId"]}))
            .unwrap();
        assert_eq!(app.pending_selection.as_deref(), Some("new"));
    }

    #[test]
    fn explicit_open_acquires_only_unowned_running_sessions() {
        let mut app = App::new(1);
        let initial = app.event(snapshot()).unwrap();
        assert!(
            !initial
                .iter()
                .any(|command| command["type"] == "acquireControl")
        );
        let opened = app.activate_session("s");
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0]["type"], "acquireControl");
        assert_eq!(opened[0]["takeOver"], false);
        // Opening is only a request; input waits for the host's actual lease.
        assert!(app.input("x".into()).is_none());
        app.event(json!({"type":"control","sessionId":"s","controllerId":2,"cols":80,"rows":24}))
            .unwrap();
        assert!(app.activate_session("s").is_empty());
        assert!(app.mode == Mode::Navigate);
        assert!(app.notice.contains("another device"));
        app.sessions[0].controller_id = None;
        app.sessions[0].running = false;
        assert!(app.activate_session("s").is_empty());
    }

    #[test]
    fn created_shell_enters_input_and_answers_startup_query_after_lease() {
        let mut app = App::new(1);
        let request = app.request(json!({"type":"create","name":"same"}));
        app.event(json!({"type":"created","sessionId":"s","requestId":request["requestId"]}))
            .unwrap();
        let commands = app.event(snapshot()).unwrap();
        assert_eq!(commands[0]["type"], "subscribe");
        assert_eq!(commands[1]["type"], "acquireControl");
        assert_eq!(commands[1]["takeOver"], false);
        assert_eq!(
            app.selected_row().unwrap().kind,
            RowKind::Session("s".into())
        );
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        assert!(
            app.event(json!({"type":"output","sessionId":"s","data":"\u{001b}[6n","replay":true}))
                .unwrap()
                .is_empty()
        );
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"first"})).unwrap();
        assert!(app.mode == Mode::Input);
        let reply = app.event(json!({"type":"output","sessionId":"s","data":"\u{001b}[6n","replay":true,"allowResponses":true})).unwrap();
        assert_eq!(reply.len(), 1);
        assert_eq!(reply[0]["data"], "\u{001b}[1;1R");
        assert_eq!(reply[0]["leaseId"], "first");
    }

    #[test]
    fn resize_control_event_does_not_leave_navigation_mode() {
        let mut app = App::new(9);
        app.event(snapshot()).unwrap();
        app.event(json!({"type":"control","sessionId":"s","controllerId":9,"cols":80,"rows":24,"leaseId":"same"})).unwrap();
        assert!(app.mode == Mode::Input);
        app.mode = Mode::Navigate;
        app.event(json!({"type":"control","sessionId":"s","controllerId":9,"cols":90,"rows":30,"leaseId":"same"})).unwrap();
        assert!(app.mode == Mode::Navigate);
        assert!(app.input("x".repeat(8193)).is_none());
    }

    #[test]
    fn query_replies_require_ownership_and_explicit_startup_replay_permission() {
        let mut app = App::new(9);
        app.event(snapshot()).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        let query = json!({"type":"output","sessionId":"s","data":"\u{001b}[6n","replay":true,"allowResponses":true});
        assert!(app.event(query.clone()).unwrap().is_empty());
        app.event(json!({"type":"control","sessionId":"s","controllerId":9,"cols":80,"rows":24,"leaseId":"fresh"})).unwrap();
        assert_eq!(app.event(query).unwrap().len(), 1);
        assert!(
            app.event(json!({"type":"output","sessionId":"s","data":"\u{001b}[6n","replay":true}))
                .unwrap()
                .is_empty()
        );
    }
}
