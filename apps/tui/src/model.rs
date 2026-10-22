use crate::{
    launch::{Capabilities, DirectoryEntry, Program, SessionForm},
    status::Status,
    terminal::TerminalState,
    theme::Theme,
};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

fn fuzzy_contains(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|character| chars.any(|candidate| candidate == character))
}

struct SessionSearch {
    scope: SearchScope,
    words: Vec<String>,
}
impl SessionSearch {
    fn new(query: &str) -> Self {
        let (scope, query) = search_scope(query);
        Self {
            scope,
            words: query.split_whitespace().map(str::to_lowercase).collect(),
        }
    }
}

struct SessionSearchRank<'a> {
    relevance: u32,
    needs_you: u8,
    unread_completion: bool,
    active: bool,
    recent: usize,
    name: String,
    id: &'a str,
}
impl SessionSearchRank<'_> {
    fn compare(&self, other: &Self) -> Ordering {
        other
            .relevance
            .cmp(&self.relevance)
            .then_with(|| other.needs_you.cmp(&self.needs_you))
            .then_with(|| other.unread_completion.cmp(&self.unread_completion))
            // Keep the current session last only within the same urgency bucket.
            .then_with(|| self.active.cmp(&other.active))
            .then_with(|| self.recent.cmp(&other.recent))
            .then_with(|| self.name.cmp(&other.name))
            .then_with(|| self.id.cmp(other.id))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContext {
    source: String,
    state: RepositoryState,
    #[serde(deserialize_with = "required_nullable")]
    name: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    branch: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    observed_at: Option<u64>,
    revision: u64,
    #[serde(default)]
    root: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RepositoryState {
    Checking,
    Ready,
    Detached,
    NotRepository,
    Unavailable,
    Stale,
}

fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl RepositoryContext {
    fn valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        let label = |value: &Option<String>, max| {
            value.as_ref().is_some_and(|text| {
                !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
            })
        };
        if self.source != "launchDirectory"
            || self.revision > MAX_SAFE_INTEGER
            || self.observed_at.is_some_and(|at| at > MAX_SAFE_INTEGER)
        {
            return false;
        }
        if self.root.is_some()
            && !(label(&self.root, 4096)
                && matches!(
                    self.state,
                    RepositoryState::Ready | RepositoryState::Detached
                ))
        {
            return false;
        }
        match self.state {
            RepositoryState::Ready => {
                label(&self.name, 128) && label(&self.branch, 256) && self.observed_at.is_some()
            }
            RepositoryState::Detached => {
                label(&self.name, 128) && self.branch.is_none() && self.observed_at.is_some()
            }
            RepositoryState::NotRepository | RepositoryState::Stale => {
                self.name.is_none() && self.branch.is_none() && self.observed_at.is_some()
            }
            RepositoryState::Checking | RepositoryState::Unavailable => {
                self.name.is_none() && self.branch.is_none() && self.observed_at.is_none()
            }
        }
    }

    pub(crate) fn repository_name(&self) -> Option<&str> {
        matches!(
            self.state,
            RepositoryState::Ready | RepositoryState::Detached
        )
        .then_some(self.name.as_deref())
        .flatten()
    }

    pub(crate) fn root(&self) -> Option<&str> {
        self.repository_name().and(self.root.as_deref())
    }

    pub(crate) fn branch_name(&self) -> Option<&str> {
        matches!(self.state, RepositoryState::Ready)
            .then_some(self.branch.as_deref())
            .flatten()
    }

    fn append_search_terms(&self, terms: &mut String) {
        if matches!(
            self.state,
            RepositoryState::Ready | RepositoryState::Detached
        ) {
            for label in [&self.name, &self.branch].into_iter().flatten() {
                terms.push(' ');
                terms.push_str(label);
            }
        }
    }
}

fn repository_context<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<RepositoryContext>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    // Optional metadata cannot make an otherwise valid legacy snapshot unusable.
    Ok(serde_json::from_value::<RepositoryContext>(value)
        .ok()
        .filter(RepositoryContext::valid))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRoot {
    source: String,
    reason: String,
    #[serde(deserialize_with = "required_nullable")]
    path: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    observed_at: Option<u64>,
}

impl SearchRoot {
    fn valid(&self) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        let path = self.path.as_ref().is_some_and(|path| {
            !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
        });
        if self.observed_at.is_some_and(|at| at > MAX_SAFE_INTEGER) {
            return false;
        }
        match (self.source.as_str(), self.reason.as_str()) {
            ("currentCwd", "insideRoot") => path && self.observed_at.is_some(),
            ("launchDirectory", "outsideRoot") => self.path.is_none() && self.observed_at.is_some(),
            ("launchDirectory", "noCurrentCwd") => {
                self.path.is_none() && self.observed_at.is_none()
            }
            _ => false,
        }
    }

    pub(crate) fn current_cwd(&self) -> Option<&str> {
        (self.source == "currentCwd")
            .then_some(self.path.as_deref())
            .flatten()
    }
}

fn search_root<'de, D>(deserializer: D) -> std::result::Result<Option<SearchRoot>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<SearchRoot>(value)
        .ok()
        .filter(SearchRoot::valid))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default, deserialize_with = "repository_context")]
    pub repository_context: Option<RepositoryContext>,
    #[serde(default, deserialize_with = "search_root")]
    pub search_root: Option<SearchRoot>,
    #[serde(default)]
    pub program: Program,
    pub cols: u16,
    pub rows: u16,
    pub running: bool,
    #[serde(default)]
    pub uptime_seconds: Option<u64>,
    #[serde(skip, default = "std::time::Instant::now")]
    received_at: std::time::Instant,
    #[serde(skip)]
    pub runtime_label: String,
    #[serde(skip)]
    pub turn_runtime_label: String,
    #[serde(skip)]
    pub freshness_label: String,
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
    #[serde(default)]
    pub readiness: Option<crate::status::Readiness>,
    #[serde(default)]
    pub current_attention: Option<crate::status::CurrentAttention>,
    #[serde(default)]
    pub lifecycle: Option<crate::status::Lifecycle>,
}

impl Session {
    pub(crate) fn search_root_label(&self) -> (&'static str, &str) {
        let Some(root) = &self.search_root else {
            return ("launch", &self.cwd);
        };
        if let Some(cwd) = root.current_cwd() {
            return ("cwd", cwd);
        }
        if root.reason == "outsideRoot" {
            return ("launch, cwd outside", &self.cwd);
        }
        ("launch", &self.cwd)
    }
    pub fn attention_priority(&self) -> u8 {
        self.current_attention.as_ref().map_or_else(
            || self.status.as_ref().map_or(0, Status::attention_priority),
            |a| a.priority,
        )
    }
    pub(crate) fn unread_completion(&self) -> bool {
        // Historical notifications survive a new turn. They are not current
        // completion evidence while the host reports new work in progress.
        let working = self
            .status
            .as_ref()
            .is_some_and(|status| status.state == crate::status::State::Working);
        let active_turn = self
            .lifecycle
            .as_ref()
            .and_then(|lifecycle| lifecycle.turn.as_ref())
            .is_some_and(|turn| turn.phase.active());
        !working
            && !active_turn
            && self
                .attention
                .as_ref()
                .is_some_and(|attention| attention.unread && attention.kind == "done")
    }
    fn refresh_time(&mut self, now: std::time::Instant) -> bool {
        let label = self
            .uptime_seconds
            .map(|seconds| {
                let live = if self.running {
                    now.saturating_duration_since(self.received_at).as_secs()
                } else {
                    0
                };
                crate::session_row::duration_label(seconds.saturating_add(live))
            })
            .unwrap_or_else(|| "—".into());
        let turn_label = self
            .lifecycle
            .as_ref()
            .and_then(|l| l.turn.as_ref())
            .map(|turn| {
                let live = if self.running && turn.phase.active() {
                    now.saturating_duration_since(self.received_at).as_secs()
                } else {
                    0
                };
                let seconds = turn.elapsed_seconds.saturating_add(live);
                format!(
                    "{} {}",
                    turn.phase.label(),
                    if seconds < 60 {
                        format!("{seconds}s")
                    } else {
                        crate::session_row::duration_label(seconds)
                    }
                )
            })
            .unwrap_or_default();
        let freshness_label = self
            .status
            .as_ref()
            .and_then(|status| status.freshness.as_ref())
            .filter(|freshness| freshness.source != crate::status::EvidenceSource::Unknown)
            .map(|freshness| {
                freshness
                    .age_label(now.saturating_duration_since(self.received_at).as_millis() as u64)
            })
            .unwrap_or_default();
        let changed = self.runtime_label != label
            || self.turn_runtime_label != turn_label
            || self.freshness_label != freshness_label;
        self.runtime_label = label;
        self.turn_runtime_label = turn_label;
        self.freshness_label = freshness_label;
        changed
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Attention {
    pub sequence: u64,
    pub kind: String,
    pub at: u64,
    pub unread: bool,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub source: Option<crate::status::Source>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
    Everything,
    Agents,
    Terminals,
    Attention,
    Files,
    Projects,
}

impl SearchScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Everything => "everything",
            Self::Agents => "agents",
            Self::Terminals => "terminals",
            Self::Attention => "needs you",
            Self::Files => "files",
            Self::Projects => "projects",
        }
    }
}

pub fn search_scope(query: &str) -> (SearchScope, &str) {
    let query = query.trim_start();
    for (prefix, scope) in [
        ('@', SearchScope::Agents),
        ('$', SearchScope::Terminals),
        ('!', SearchScope::Attention),
        ('#', SearchScope::Files),
        ('%', SearchScope::Projects),
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
    #[serde(default)]
    pub attention_summary: Option<crate::status::AttentionSummary>,
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
    ReviewDirectory,
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
        selected: Option<crate::palette::Target>,
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
    pub sidebar_width: u16,
    pub ascii_icons: bool,
    pub selection: Option<crate::selection::Selection>,
    pub menu_phase: u8,
    pub toast: Option<(String, std::time::Instant)>,
    pub palette_expanded: bool,
    pub palette_category: usize,
    pub overlay: Option<crate::toolbox::Overlay>,
    pub status_filters: HashSet<usize>,
    pub overview: crate::overview::Overview,
    pub schedules: Vec<Value>,
    pub jobs: Option<crate::jobs::Jobs>,
    pub runs: Option<crate::runs::Runs>,
    pub projects: crate::projects::Projects,
    pub git: Option<crate::git_pane::GitPane>,
    pub host_features: Value,
    pub review: crate::review::ReviewState,
    pub reviews: crate::review_session::ReviewSessions,
    pub files: crate::files_controller::FilesState,
    pub notes: crate::notes_controller::NotesState,
    pub worktrees: crate::worktree_actions::Worktrees,
    pub client_id: u64,
    pub sessions: Vec<Session>,
    pub groups: Vec<Group>,
    pub revision: u64,
    pub terminals: HashMap<String, TerminalState>,
    pub leases: HashMap<String, String>,
    pub pending_input: Option<String>,
    pub subscribed: HashSet<String>,
    pub collapsed: HashSet<String>,
    pub selected: usize,
    pub tabs: Vec<String>,
    pub recent_sessions: Vec<String>,
    pub templates: Vec<Value>,
    pub recoveries: Vec<Value>,
    pub recovery_next: Option<u64>,
    pub panes: [Option<String>; crate::layouts::MAX_LEAVES],
    pub pane_layout: Option<crate::layouts::PaneTree>,
    pub layouts: crate::layouts::Library,
    pub layout_picker: Option<crate::layouts::Picker>,
    pub split: bool,
    pub fullscreen: bool,
    pub fullscreen_default: bool,
    pub focused: usize,
    pub mode: Mode,
    pub dialog: Option<Dialog>,
    pub session_kind: Option<crate::session_kind::Picker>,
    pub dialog_button: Option<usize>,
    pub menu_selected: usize,
    pub help_page: usize,
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
            sidebar_width: 0,
            ascii_icons: false,
            selection: None,
            menu_phase: 0,
            toast: None,
            review: Default::default(),
            reviews: Default::default(),
            files: Default::default(),
            notes: Default::default(),
            worktrees: Default::default(),
            overlay: None,
            palette_expanded: false,
            palette_category: 0,
            status_filters: HashSet::new(),
            overview: Default::default(),
            schedules: Vec::new(),
            jobs: None,
            runs: None,
            projects: Default::default(),
            git: None,
            host_features: Value::Null,
            client_id,
            sessions: vec![],
            groups: vec![],
            revision: 0,
            terminals: HashMap::new(),
            leases: HashMap::new(),
            pending_input: None,
            subscribed: HashSet::new(),
            collapsed: HashSet::new(),
            selected: 0,
            tabs: Vec::new(),
            recent_sessions: Vec::new(),
            templates: Vec::new(),
            recoveries: Vec::new(),
            recovery_next: None,
            panes: Default::default(),
            pane_layout: None,
            layouts: Default::default(),
            layout_picker: None,
            split: false,
            fullscreen: false,
            fullscreen_default: false,
            focused: 0,
            mode: Mode::Navigate,
            dialog: None,
            session_kind: None,
            dialog_button: None,
            menu_selected: 0,
            help_page: 0,
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

    pub fn refresh_session_times(&mut self, now: std::time::Instant) -> bool {
        let mut changed = false;
        for session in &mut self.sessions {
            changed |= session.refresh_time(now);
        }
        changed
            | crate::jobs_controller::tick(self)
            | crate::overview::tick(self, now)
            | crate::worktree_actions::expire(self)
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }
    pub fn active_id(&self) -> Option<&str> {
        self.panes[self.focused].as_deref()
    }
    pub fn wake_available(&self) -> bool {
        self.active_session()
            .is_some_and(|session| self.wake_offered(session))
    }
    pub fn wake_offered(&self, session: &Session) -> bool {
        session.program == Program::Codex
            && session.running
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
    pub fn pane_tree(&self) -> crate::layouts::PaneTree {
        match &self.pane_layout {
            Some(tree) if (tree.leaf_count() > 1) == self.split && tree.valid() => tree.clone(),
            _ if self.split => crate::layouts::PaneTree::classic(),
            _ => crate::layouts::PaneTree::single(),
        }
    }
    pub fn leaf_count(&self) -> usize {
        self.pane_tree()
            .leaf_count()
            .clamp(1, crate::layouts::MAX_LEAVES)
    }
    pub fn set_pane_layout(&mut self, tree: crate::layouts::PaneTree) {
        self.split = tree.leaf_count() > 1;
        self.pane_layout = Some(tree);
        self.panes = Default::default();
        self.focused = 0;
    }
    pub fn clear_hidden_panes(&mut self) {
        let count = self.leaf_count();
        for pane in &mut self.panes[count..] {
            *pane = None;
        }
        self.focused = self.focused.min(count - 1);
    }
    pub fn focus_session_leaf(&mut self) {
        let slots = self.pane_tree().slots();
        if slots
            .get(self.focused)
            .is_some_and(|slot| slot.role.hosts_session())
        {
            return;
        }
        if let Some(index) = slots.iter().position(|slot| slot.role.hosts_session()) {
            self.focused = index;
        } else {
            let mut replaced = slots;
            if let Some(slot) = replaced.get_mut(self.focused) {
                slot.role = crate::layouts::Role::Empty;
                slot.provider = None;
            }
            self.pane_layout = Some(self.pane_tree().with_slots(&replaced));
        }
    }
    pub fn focus_next(&mut self, backward: bool) {
        let slots = self.pane_tree().slots();
        let count = slots.len();
        let step = if backward { count - 1 } else { 1 };
        let mut index = self.focused.min(count - 1);
        for _ in 1..count {
            index = (index + step) % count;
            if slots[index].role.hosts_session() {
                self.focused = index;
                return;
            }
        }
    }
    pub fn project_key(&self) -> Option<String> {
        self.active_session()
            .or_else(|| match self.selected_row().map(|row| row.kind) {
                Some(RowKind::Session(id)) => self.session(&id),
                _ => None,
            })
            .and_then(|session| session.repository_context.as_ref())
            .and_then(|context| {
                self.layouts
                    .project_key(context.root(), context.repository_name())
            })
    }
    pub fn layout_candidates(&self) -> Vec<crate::layouts::Candidate> {
        let mut ordered: Vec<&Session> = self
            .recent_sessions
            .iter()
            .filter_map(|id| self.session(id))
            .collect();
        for session in &self.sessions {
            if !ordered.iter().any(|known| known.id == session.id) {
                ordered.push(session);
            }
        }
        ordered
            .into_iter()
            .map(|session| crate::layouts::Candidate {
                id: session.id.clone(),
                program: self.effective_program(session),
                running: session.running,
            })
            .collect()
    }
    pub fn current_layout(&self, name: &str) -> crate::layouts::NamedLayout {
        let tree = self.pane_tree();
        let slots: Vec<_> = tree
            .slots()
            .into_iter()
            .enumerate()
            .map(|(index, slot)| {
                match self.panes[index].as_deref().and_then(|id| self.session(id)) {
                    Some(session) => match self.effective_program(session) {
                        Program::Shell => crate::layouts::Slot {
                            role: crate::layouts::Role::Terminal,
                            provider: None,
                        },
                        program => crate::layouts::Slot {
                            role: crate::layouts::Role::Agent,
                            provider: Some(program),
                        },
                    },
                    None => slot,
                }
            })
            .collect();
        crate::layouts::NamedLayout {
            name: name.into(),
            tree: tree.with_slots(&slots),
            sidebar_mode: self.files.mode.key().into(),
            sidebar_width: self.sidebar_width,
            min_columns: 0,
        }
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
    pub fn review_candidate(&self) -> Option<&Session> {
        match self.selected_row().map(|row| row.kind) {
            Some(RowKind::Session(id)) => self.session(&id),
            _ => None,
        }
        .or_else(|| self.active_session())
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

    pub fn begin_palette(&mut self, query: String) {
        let selected = self
            .palette_results(&query)
            .first()
            .map(|row| row.target.clone());
        self.dialog = Some(Dialog::QuickSwitch { query, selected });
    }

    pub fn palette_index(&self) -> Option<usize> {
        let Some(Dialog::QuickSwitch {
            query,
            selected: Some(target),
        }) = &self.dialog
        else {
            return None;
        };
        self.palette_results(query)
            .iter()
            .position(|row| &row.target == target)
    }

    pub fn select_palette(&mut self, index: usize) {
        let target = match &self.dialog {
            Some(Dialog::QuickSwitch { query, .. }) => self
                .palette_results(query)
                .get(index)
                .map(|row| row.target.clone()),
            _ => return,
        };
        if let Some(Dialog::QuickSwitch { selected, .. }) = &mut self.dialog {
            *selected = target;
        }
    }

    pub fn move_palette(&mut self, up: bool) {
        let count = match &self.dialog {
            Some(Dialog::QuickSwitch { query, .. }) => self.palette_results(query).len(),
            _ => return,
        };
        let index = match self.palette_index() {
            Some(index) if up => index.saturating_sub(1),
            Some(index) => (index + 1).min(count.saturating_sub(1)),
            None if up => count.saturating_sub(1),
            None => 0,
        };
        self.select_palette(index);
    }

    pub fn reconcile_palette(&mut self) {
        let Some(Dialog::QuickSwitch {
            query,
            selected: Some(target),
        }) = &self.dialog
        else {
            return;
        };
        if !crate::palette::eligible(self, query, target) {
            if let Some(Dialog::QuickSwitch { selected, .. }) = &mut self.dialog {
                *selected = None;
            }
            self.notice = "Selected result is no longer available. Choose another result.".into();
        }
    }

    pub fn matches_status(&self, session: &Session) -> bool {
        (self.status_filters.is_empty()
            || self
                .status_filters
                .contains(&crate::toolbox::status_index(session)))
            && self.projects.allows(session)
    }

    pub fn quick_switch_results(&self, query: &str) -> Vec<&Session> {
        let search = SessionSearch::new(query);
        let mut matches: Vec<_> = self
            .sessions
            .iter()
            .filter_map(|session| {
                self.session_search_score(session, &search).map(|score| {
                    (
                        session,
                        SessionSearchRank {
                            relevance: score,
                            needs_you: session.attention_priority(),
                            unread_completion: session.unread_completion(),
                            active: self.active_id() == Some(session.id.as_str()),
                            recent: self
                                .recent_sessions
                                .iter()
                                .position(|id| id == &session.id)
                                .unwrap_or(usize::MAX),
                            name: session.name.to_lowercase(),
                            id: &session.id,
                        },
                    )
                })
            })
            .collect();
        matches.sort_by(|(_, a), (_, b)| a.compare(b));
        matches.into_iter().map(|(session, _)| session).collect()
    }

    pub(crate) fn session_search_matches(&self, id: &str, query: &str) -> bool {
        self.session(id).is_some_and(|session| {
            self.session_search_score(session, &SessionSearch::new(query))
                .is_some()
        })
    }

    fn session_search_score(&self, session: &Session, search: &SessionSearch) -> Option<u32> {
        if !self.matches_status(session)
            || search.scope == SearchScope::Files
            || search.scope == SearchScope::Projects
            || (search.scope == SearchScope::Attention && session.attention_priority() == 0)
        {
            return None;
        }
        let program = if matches!(search.scope, SearchScope::Agents | SearchScope::Terminals)
            || !search.words.is_empty()
        {
            Some(self.effective_program(session))
        } else {
            None
        };
        if (search.scope == SearchScope::Agents && program == Some(Program::Shell))
            || (search.scope == SearchScope::Terminals && program != Some(Program::Shell))
        {
            return None;
        }
        let mut score = 0;
        if search.words.is_empty() {
            return Some(score);
        }
        let mut terms = format!("{} {} {}", session.name, session.cwd, program?.label());
        if let Some(cwd) = session
            .search_root
            .as_ref()
            .and_then(SearchRoot::current_cwd)
        {
            terms.push(' ');
            terms.push_str(cwd);
        }
        if let Some(context) = &session.repository_context {
            context.append_search_terms(&mut terms);
        }
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
        let name = session.name.to_lowercase();
        for word in &search.words {
            if name.starts_with(word) {
                score += 6;
            } else if haystack.contains(word) {
                score += 3;
            } else if fuzzy_contains(&haystack, word) {
                score += 1;
            } else {
                return None;
            }
        }
        Some(score)
    }

    pub fn group_attention(&self, group_id: &str) -> Option<&Status> {
        if let Some(summary) = self
            .groups
            .iter()
            .find(|g| g.id == group_id)
            .and_then(|g| g.attention_summary.as_ref())
        {
            return summary.highest.as_ref().and_then(|p| p.status.as_ref());
        }
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
            label: self.projects.filter.as_ref().map_or_else(
                || "sessions".into(),
                |filter| format!("sessions · {}", filter.name),
            ),
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
        let count = self.leaf_count();
        self.focused = self.focused.min(count - 1);
        if let Some(index) = (0..count)
            .find(|index| *index != self.focused && self.panes[*index].as_deref() == Some(id))
        {
            self.focused = index;
        }
        self.focus_session_leaf();
        self.panes[self.focused] = Some(id.into());
        self.mode = Mode::Navigate;
        let mut commands = Vec::new();
        if self.subscribed.insert(id.into()) {
            commands.push(json!({"type":"subscribe", "sessionId":id}));
        }
        commands.extend(self.drop_hidden_subscriptions());
        commands
    }

    pub fn drop_hidden_subscriptions(&mut self) -> Vec<Value> {
        let mut commands = Vec::new();
        let count = self.leaf_count();
        // Only currently visible panes are subscribed. Hidden shells keep running on the host.
        let stale: Vec<_> = self
            .subscribed
            .iter()
            .filter(|id| !self.panes[..count].iter().flatten().any(|pane| pane == *id))
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
        let mut commands = self.show_session(id);
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
            let (cols, rows) = (session.cols, session.rows);
            self.pending_input = Some(id.into());
            commands.push(json!({"type":"acquireControl","sessionId":id,
                "takeOver":false,"cols":cols,"rows":rows}));
            self.notice = "Starting terminal…".into();
        } else {
            self.notice = "Read-only view · another device has control · t takes over".into();
        }
        commands
    }

    pub fn show_session(&mut self, id: &str) -> Vec<Value> {
        if self.reviews.shown.is_some()
            && self
                .pane_tree()
                .position(crate::layouts::Role::Review)
                .is_none()
        {
            self.reviews.shown = None;
            self.reviews.focused = false;
            self.reviews.return_to_input = false;
        }
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
        commands
    }

    pub fn event(&mut self, event: Value) -> Result<Vec<Value>> {
        let mut commands = Vec::new();
        let kind = if crate::worktree_actions::host_event(self, &event) {
            ""
        } else if let Some(next) = crate::git_pane::host_event(self, &event) {
            commands.extend(next);
            ""
        } else if let Some(next) = crate::projects_controller::host_event(self, &event) {
            commands.extend(next);
            ""
        } else if crate::review_session::host_event(self, &event).is_some()
            || crate::usage_panel::host_event(self, &event)
        {
            ""
        } else {
            event["type"].as_str().unwrap_or_default()
        };
        match kind {
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
                if event["reviews"] == true && self.host_features["reviews"] != true {
                    commands.push(json!({"type":"watchReviews"}));
                }
                self.host_features = event.clone();
                self.capabilities = Some(serde_json::from_value(event)?);
            }
            "workflow" => {
                commands.extend(crate::jobs_controller::host_event(self, &event));
                commands.extend(crate::runs_controller::host_event(self, &event));
            }
            "workflowTemplates" | "workflowTemplateStarted" => {
                commands.extend(crate::runs_controller::host_event(self, &event));
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
                let selected = self
                    .pending_selection
                    .as_ref()
                    .map(|id| RowKind::Session(id.clone()))
                    .or_else(|| self.selected_row().map(|row| row.kind));
                self.sessions = serde_json::from_value(event["sessions"].clone())?;
                self.refresh_session_times(std::time::Instant::now());
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
                if recovery {
                    self.recovery_next = event["nextOffset"].as_u64();
                }
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
                    commands.push(json!({"type":"list"}));
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
                            if fresh
                                && self.pending_input.as_deref() == Some(id)
                                && self.active_id() == Some(id)
                                && self.dialog.is_none()
                                && self.overlay.is_none()
                                && self.session_kind.is_none()
                                && self.layout_picker.is_none()
                                && !self.review.focused
                                && !self.reviews.focused
                            {
                                self.mode = Mode::Input;
                                self.notice.clear();
                            }
                        }
                        if self.pending_input.as_deref() == Some(id) {
                            self.pending_input = None;
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
                    if event["replay"] != true && !data.is_empty() {
                        self.overview.observe_output(id, std::time::Instant::now());
                    }
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
                commands.extend(crate::jobs_controller::host_event(self, &event));
                commands.extend(crate::runs_controller::host_event(self, &event));
                crate::files_controller::host_error(self, &event);
                crate::notes_controller::host_error(self, &event);
            }
            "entries" | "file" | "files" => crate::files_controller::host_event(self, &event),
            "notes" | "note" | "noteSaved" | "noteDeleted" => {
                crate::notes_controller::host_event(self, &event);
            }
            _ => {}
        }
        commands.extend(crate::review_session::pump(self));
        commands.extend(crate::files_controller::sync(self));
        commands.extend(crate::notes_controller::sync(self));
        commands.extend(crate::worktree_actions::sync(self));
        self.reconcile_palette();
        Ok(commands)
    }

    pub fn disconnect(&mut self, message: String) {
        self.connected = false;
        self.leases.clear();
        self.pending_input = None;
        self.mode = Mode::Navigate;
        self.dialog = None;
        self.session_kind = None;
        self.layout_picker = None;
        self.dialog_button = None;
        self.pending_directory = None;
        self.reviews.picking = None;
        self.reviews.focused = false;
        self.notes.disconnected();
        crate::worktree_actions::disconnect(self);
        self.notice = if self.capabilities.is_none() {
            "Host disconnected during setup; update nesvo-host and reconnect.".into()
        } else {
            message
        };
        if let Some(key) = self
            .jobs
            .take()
            .and_then(|jobs| jobs.unconfirmed_key().map(str::to_owned))
        {
            self.notice = crate::jobs::unconfirmed_notice(&self.notice, &key);
        }
        if let Some(runs) = self.runs.take()
            && let Some((key, change)) = runs.unconfirmed_key()
        {
            self.notice = crate::runs::unconfirmed_notice(&self.notice, change, key);
        }
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
        if self.review.request_id.is_some()
            && self
                .review
                .last_requested
                .is_some_and(|at| at.elapsed() > std::time::Duration::from_secs(15))
        {
            self.review.request_id = None;
        }

        if self.connected
            && self.review.visible
            && self.dialog.is_none()
            && self.overlay.is_none()
            && self.review.request_id.is_none()
            && !self.reviews.git_busy()
            && self.capabilities.as_ref().is_some_and(|caps| caps.git_diff)
            && self
                .review
                .last_requested
                .is_some_and(|at| at.elapsed() >= std::time::Duration::from_secs(3))
        {
            self.request_diff()
        } else {
            crate::review_session::tick(self)
                .into_iter()
                .next()
                .or_else(|| crate::git_pane::tick(self))
                .or_else(|| crate::usage_panel::tick(self))
                .or_else(|| crate::worktree_actions::tick(self))
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
            self.review.directory = None;
            self.review.data = Default::default();
            self.review.file = 0;
            self.review.hunk = 0;
            self.review.scroll = 0;
            self.review.folded.clear();
        }
        self.review.session_id = id.clone();
        let command = self.request(json!({"type":"getDiff", "sessionId":id, "scope":crate::review::SCOPES[self.review.scope], "directory":self.review.directory}));
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
                    Some("Use a name of 1–80 characters.".to_owned())
                } else if !self.connected {
                    Some("Reconnect to the host before creating a session.".to_owned())
                } else if self.capabilities.is_none() {
                    Some("Waiting for available programs from the host.".to_owned())
                } else {
                    self.capabilities
                        .as_ref()
                        .and_then(|caps| caps.launch_refusal(form.program))
                };
                if let Some(message) = error {
                    self.notice = message;
                    self.dialog = Some(Dialog::NewSession(form));
                    return None;
                }
                let efforts = form.profile_efforts(self.capabilities.as_ref());
                let profile = match form.profile(efforts.as_deref()) {
                    Ok(profile) => profile,
                    Err(message) => {
                        self.notice = message.into();
                        self.dialog = Some(Dialog::NewSession(form));
                        return None;
                    }
                };
                let advanced = auto_title
                    || form.worktree
                    || !form.prompt.is_empty()
                    || !form.when.is_empty()
                    || profile.is_some();
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
                let mut spec = json!({"name":name,"cwd":form.cwd.trim(), "program":form.program,"groupId":form.group_id,"prompt":form.prompt,"worktree":form.worktree,"autoTitle":auto_title});
                if let Some((model, effort)) = profile {
                    spec["model"] = model.into();
                    if let Some(effort) = effort {
                        spec["effort"] = effort.into();
                    }
                }
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
                if matches!(action, TextAction::ReviewDirectory) {
                    let path = value.trim();
                    if path.len() > 4096 || path.chars().any(char::is_control) {
                        self.notice = "Invalid folder path.".into();
                        return None;
                    }
                    self.review.directory = (!path.is_empty()).then(|| path.to_owned());
                    self.review.data = Default::default();
                    self.review.scroll = 0;
                    return self.request_diff();
                }
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
                    TextAction::ReviewDirectory => unreachable!(),
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
            if let Some(path) = self.group_path(group, exclude) {
                choices.push((Some(group.id.clone()), path));
            }
        }
        choices[1..].sort_by(|a, b| a.1.cmp(&b.1));
        choices
    }

    pub(crate) fn group_search_path(&self, id: &str) -> Option<String> {
        self.groups
            .iter()
            .find(|group| group.id == id)
            .and_then(|group| self.group_path(group, None))
    }

    fn group_path(&self, group: &Group, exclude: Option<&str>) -> Option<String> {
        let mut cursor = Some(group.id.as_str());
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        while let Some(id) = cursor {
            if Some(id) == exclude || !seen.insert(id) {
                return None;
            }
            let Some(parent) = self.groups.iter().find(|group| group.id == id) else {
                break;
            };
            path.push(parent.name.as_str());
            cursor = parent.parent_id.as_deref();
        }
        path.reverse();
        Some(path.join(" / "))
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
    fn session_time_advances_locally_freezes_on_exit_and_accepts_legacy_hosts() {
        use std::time::{Duration, Instant};
        let mut session: Session = serde_json::from_value(json!({"id":"s","name":"S","cwd":".","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null,"uptimeSeconds":59})).unwrap();
        let now = Instant::now();
        session.received_at = now;
        assert!(session.refresh_time(now));
        assert_eq!(session.runtime_label, "<1m");
        assert!(!session.refresh_time(now + Duration::from_millis(500)));
        assert!(session.refresh_time(now + Duration::from_secs(1)));
        assert_eq!(session.runtime_label, "1m");
        session.running = false;
        session.uptime_seconds = Some(120);
        session.refresh_time(now + Duration::from_secs(86400));
        assert_eq!(session.runtime_label, "2m");
        session.uptime_seconds = None;
        session.refresh_time(now);
        assert_eq!(session.runtime_label, "—");
    }

    #[test]
    fn process_age_and_response_duration_use_separate_clocks_and_stop_on_their_own_boundaries() {
        use std::time::{Duration, Instant};
        let mut session:Session=serde_json::from_value(json!({"id":"s","name":"S","cwd":".","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null,"uptimeSeconds":120,"lifecycle":{"turn":{"phase":"started","elapsedSeconds":3}}})).unwrap();
        let now = Instant::now();
        session.received_at = now;
        session.refresh_time(now + Duration::from_secs(8));
        assert_eq!(session.runtime_label, "2m");
        assert_eq!(session.turn_runtime_label, "turn 11s");
        let turn = session.lifecycle.as_mut().unwrap().turn.as_mut().unwrap();
        turn.phase = crate::status::TurnPhase::Settled;
        turn.elapsed_seconds = 13;
        session.refresh_time(now + Duration::from_secs(120));
        assert_eq!(session.runtime_label, "4m");
        assert_eq!(session.turn_runtime_label, "response 13s");
        session.uptime_seconds = Some(240);
        session.running = false;
        session.refresh_time(now + Duration::from_secs(86400));
        assert_eq!(
            session.runtime_label, "4m",
            "host exit snapshot provides frozen process age"
        );
        assert_eq!(session.turn_runtime_label, "response 13s");
        session.lifecycle = None;
        session.refresh_time(now);
        assert!(
            session.turn_runtime_label.is_empty(),
            "legacy data does not invent turn time"
        );
    }

    #[test]
    fn fullscreen_review_refreshes_and_recovers_expired_requests() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[{"id":"s","name":"Shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}]})).unwrap();
        app.event(json!({"type":"capabilities","workspace":".","programs":[],"gitDiff":true}))
            .unwrap();
        app.connected = true;
        app.dialog = None;
        app.fullscreen = true;
        app.mode = Mode::Input;
        app.request_diff().unwrap();
        app.review.directory = Some("other-repo".into());
        app.review.last_requested =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(16));
        let command = app.auto_refresh_diff().unwrap();
        assert_eq!(command["directory"], "other-repo");
        assert!(app.auto_refresh_diff().is_none());
    }

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

    fn search_root_app(root: Value) -> App {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s","name":"Repair","cwd":"C:/dev/launch","program":"claude","cols":80,"rows":24,
                "running":true,"groupId":null,"controllerId":null,"searchRoot":root}
        ]}))
        .unwrap();
        app
    }

    #[test]
    fn current_cwd_search_root_is_search_evidence_and_the_named_root() {
        let current = search_root_app(
            json!({"source":"currentCwd","reason":"insideRoot","path":"C:/dev/launch/agent-łódź","observedAt":5}),
        );
        assert_eq!(current.quick_switch_results("agent-łódź")[0].id, "s");
        assert_eq!(
            current.sessions[0].search_root_label(),
            ("cwd", "C:/dev/launch/agent-łódź")
        );
        let outside = search_root_app(
            json!({"source":"launchDirectory","reason":"outsideRoot","path":null,"observedAt":5}),
        );
        assert_eq!(
            outside.sessions[0].search_root_label(),
            ("launch, cwd outside", "C:/dev/launch")
        );
        assert!(outside.quick_switch_results("agent").is_empty());
        for malformed in [
            json!({"source":"currentCwd","reason":"insideRoot","path":null,"observedAt":5}),
            json!({"source":"currentCwd","reason":"outsideRoot","path":"C:/dev/launch/agent","observedAt":5}),
            json!({"source":"launchDirectory","reason":"noCurrentCwd","path":"C:/dev/launch/agent","observedAt":null}),
            json!({"source":"currentCwd","reason":"insideRoot","path":"C:/dev/launch/agent","observedAt":9_007_199_254_740_992_u64}),
            json!({"source":"currentCwd","reason":"insideRoot","path":"C:/dev/launch/agent\ncontrol","observedAt":5}),
            json!("currentCwd"),
        ] {
            let app = search_root_app(malformed);
            assert_eq!(app.sessions.len(), 1);
            assert!(app.sessions[0].search_root.is_none());
            assert_eq!(
                app.sessions[0].search_root_label(),
                ("launch", "C:/dev/launch")
            );
            assert!(app.quick_switch_results("agent").is_empty());
        }
    }

    fn repository_projection(state: &str) -> Value {
        json!({
            "source":"launchDirectory", "state":state,
            "name":if matches!(state, "ready" | "detached") { json!("répertoire工程") } else { Value::Null },
            "branch":if state == "ready" { json!("feature/zażółć") } else { Value::Null },
            "observedAt":if matches!(state, "checking" | "unavailable") { Value::Null } else { json!(7) },
            "revision":2
        })
    }

    #[test]
    fn repository_search_shares_unicode_provider_group_and_branch_eligibility() {
        let mut value = snapshot();
        value["sessions"][0]["program"] = json!("codex");
        value["groups"][1]["name"] = json!("工程API");
        value["sessions"][0]["repositoryContext"] = repository_projection("ready");
        let mut app = App::new(1);
        app.event(value).unwrap();
        let target = crate::palette::Target::Session("s".into());
        for query in [
            "répertoire工程",
            "feature/zażółć",
            "@ codex feature/zażółć",
            "工程API répertoire工程",
        ] {
            assert_eq!(app.quick_switch_results(query)[0].id, "s");
            assert!(app.session_search_matches("s", query));
            assert!(crate::palette::eligible(&app, query, &target));
            assert!(
                app.palette_results(query)
                    .iter()
                    .any(|row| row.target == target)
            );
        }
        assert!(app.quick_switch_results("$ feature/zażółć").is_empty());
        assert!(app.quick_switch_results("! feature/zażółć").is_empty());
        assert!(app.recent_sessions.is_empty());
    }

    #[test]
    fn only_current_ready_or_detached_repository_labels_are_search_evidence() {
        for state in [
            "ready",
            "detached",
            "checking",
            "notRepository",
            "unavailable",
            "stale",
        ] {
            let mut value = snapshot();
            value["sessions"][0]["repositoryContext"] = repository_projection(state);
            let mut app = App::new(1);
            app.event(value).unwrap();
            assert!(
                app.sessions[0].repository_context.is_some(),
                "Valid {state} projection"
            );
            assert_eq!(
                app.session_search_matches("s", "répertoire工程"),
                matches!(state, "ready" | "detached"),
                "Repository state {state}"
            );
            assert_eq!(
                app.session_search_matches("s", "feature/zażółć"),
                state == "ready"
            );
        }
        let mut legacy = App::new(1);
        legacy.event(snapshot()).unwrap();
        assert!(legacy.sessions[0].repository_context.is_none());
        assert!(legacy.session_search_matches("s", "API"));
        assert!(!legacy.session_search_matches("s", "répertoire工程"));
    }

    #[test]
    fn malformed_optional_repository_context_cannot_reject_legacy_sessions_or_add_terms() {
        let valid = repository_projection("ready");
        let mut invalid = vec![Value::Null, json!(false), json!([]), json!({})];
        for (field, bad) in [
            ("source", json!("agentDirectory")),
            ("state", json!("unknown")),
            ("name", Value::Null),
            ("name", json!("")),
            ("name", json!("private\u{001b}sentinel")),
            ("name", json!("é".repeat(65))),
            ("branch", Value::Null),
            ("branch", json!("界".repeat(86))),
            ("observedAt", Value::Null),
            ("observedAt", json!(-1)),
            ("observedAt", json!(9_007_199_254_740_992_u64)),
            ("revision", json!(0.5)),
            ("revision", json!(9_007_199_254_740_992_u64)),
        ] {
            let mut context = valid.clone();
            context[field] = bad;
            invalid.push(context);
        }
        for field in [
            "source",
            "state",
            "name",
            "branch",
            "observedAt",
            "revision",
        ] {
            let mut context = valid.clone();
            context.as_object_mut().unwrap().remove(field);
            invalid.push(context);
        }
        for state in [
            "detached",
            "checking",
            "notRepository",
            "unavailable",
            "stale",
        ] {
            let mut context = repository_projection(state);
            context["branch"] = json!("feature/zażółć");
            invalid.push(context);
        }
        for context in invalid {
            let mut value = snapshot();
            value["sessions"][0]["repositoryContext"] = context;
            let mut app = App::new(1);
            app.event(value).unwrap();
            assert_eq!(app.sessions[0].id, "s");
            assert!(app.sessions[0].repository_context.is_none());
            assert!(app.session_search_matches("s", "API"));
            assert!(!app.session_search_matches("s", "feature/zażółć"));
        }
    }

    #[test]
    fn repository_context_bounds_are_utf8_bytes_and_checked_safe_integers() {
        let mut context = repository_projection("ready");
        context["name"] = json!("é".repeat(64));
        context["branch"] = json!("界".repeat(85));
        context["observedAt"] = json!(9_007_199_254_740_991_u64);
        context["revision"] = json!(9_007_199_254_740_991_u64);
        let mut value = snapshot();
        value["sessions"][0]["repositoryContext"] = context;
        let mut app = App::new(1);
        app.event(value).unwrap();
        assert!(app.sessions[0].repository_context.is_some());
        assert!(app.session_search_matches("s", &"é".repeat(64)));
        assert!(app.session_search_matches("s", &"界".repeat(85)));
    }

    #[test]
    fn only_correlated_successful_create_requests_repository_refresh_once() {
        let mut app = App::new(1);
        let request = app.request(json!({"type":"create","name":"same"}));
        let accepted = json!({"type":"created","sessionId":"s","requestId":request["requestId"]});
        assert!(
            app.event(json!({"type":"created","sessionId":"s","requestId":"foreign"}))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app.event(accepted.clone()).unwrap(),
            [json!({"type":"list"})]
        );
        assert!(app.event(accepted).unwrap().is_empty());
        assert!(
            app.event(snapshot())
                .unwrap()
                .iter()
                .all(|command| command["type"] != "list")
        );
        assert!(
            app.event(json!({"type":"output","sessionId":"s","data":"idle"}))
                .unwrap()
                .iter()
                .all(|command| command["type"] != "list")
        );
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
        assert_eq!(
            app.group_attention("a").unwrap().state,
            crate::status::State::Blocked
        );
        let mut question = snapshot["sessions"][0].clone();
        question["id"] = "q".into();
        question["status"] = json!({"state":"question","source":"screen","updatedAt":2});
        snapshot["sessions"].as_array_mut().unwrap().push(question);
        app.event(snapshot).unwrap();
        assert_eq!(
            app.group_attention("a").unwrap().state,
            crate::status::State::Question
        );
        assert!(app.group_attention("unrelated").is_none());
    }

    #[test]
    fn canonical_attention_covers_child_blockers_without_replacing_the_running_agent() {
        let mut app = App::new(1);
        let mut value = snapshot();
        value["sessions"][0]["status"] =
            json!({"state":"working","source":"screen","evidence":"hook","updatedAt":2});
        let issue = json!({"priority":2,"reason":"child","status":{"state":"blocked","source":"program","updatedAt":2},"blockedChildren":2});
        value["sessions"][0]["currentAttention"] = issue.clone();
        value["groups"][0]["attentionSummary"] = json!({"sessions":1,"needsYou":1,"highest":issue});
        app.event(value.clone()).unwrap();
        let id = app.sessions[0].id.clone();
        assert_eq!(app.quick_switch_results("!")[0].id, id);
        assert_eq!(
            crate::session_row::status_label(&app.sessions[0], Program::Claude).text,
            "needs you"
        );
        assert_eq!(
            app.group_attention(app.groups[0].id.as_str())
                .unwrap()
                .state,
            crate::status::State::Blocked
        );
        let collapsed = app.collapsed.clone();
        let panes = app.panes.clone();
        let focused = app.focused;
        value["sessions"][0]["currentAttention"] =
            json!({"priority":0,"reason":null,"status":null,"blockedChildren":0});
        value["groups"][0]["attentionSummary"] = json!({"sessions":1,"needsYou":0,"highest":null});
        app.event(value).unwrap();
        assert!(app.quick_switch_results("!").is_empty());
        assert_eq!(app.panes, panes);
        assert_eq!(app.focused, focused);
        assert_eq!(app.collapsed, collapsed);
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
    fn background_same_name_child_preserves_input_focus_and_the_existing_lease() {
        let mut app = App::new(1);
        let mut data = snapshot();
        app.event(data.clone()).unwrap();
        app.activate_session("s");
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"human"})).unwrap();
        assert!(app.mode == Mode::Input);
        data["sessions"][0]["controllerId"] = json!(1);
        let mut child = data["sessions"][0].clone();
        child["id"] = json!("child");
        child["parentSessionId"] = json!("s");
        child["controllerId"] = Value::Null;
        data["sessions"].as_array_mut().unwrap().insert(0, child);
        let commands = app.event(data).unwrap();
        assert_eq!(app.active_id(), Some("s"));
        assert!(app.mode == Mode::Input);
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "acquireControl")
        );
        assert_eq!(app.input("still human".into()).unwrap()["leaseId"], "human");
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
        app.activate_session("s");
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

    fn profile_app() -> App {
        let mut app = App::new(5);
        app.event(json!({"type":"capabilities","workspace":"/work","advancedLaunch":true,
            "programs":[{"id":"shell","available":true},{"id":"claude","available":true},
                {"id":"codex","available":true},{"id":"gemini","available":true}],
            "sessionModelProfiles":true,"launchProfileSupport":[
                {"program":"claude","supported":true,"effortValues":["low","medium","high","xhigh","max"],"effortSource":"cli"},
                {"program":"codex","supported":true,"effortValues":null,"effortSource":"modelAdvertised"},
                {"program":"gemini","supported":false}
            ]}))
        .unwrap();
        app
    }

    #[test]
    fn session_kind_agent_submit_sends_launch_with_model_and_effort() {
        let mut app = profile_app();
        let mut form = crate::session_kind::SessionKind::Agent
            .preset(Some("g".into()), Program::Claude, [])
            .unwrap();
        form.cwd = "/work/api".into();
        form.model = " opus ".into();
        form.effort = "high".into();
        app.dialog = Some(Dialog::NewSession(form));
        let command = app.submit_dialog().unwrap();
        assert_eq!(command["type"], "launch");
        assert_eq!(command["spec"]["program"], "claude");
        assert_eq!(command["spec"]["model"], "opus");
        assert_eq!(command["spec"]["effort"], "high");
        assert_eq!(command["spec"]["autoTitle"], true);
        assert_eq!(command["spec"]["groupId"], "g");
        assert_eq!(app.pending_create.as_deref(), command["requestId"].as_str());
        app.event(
            json!({"type":"error","requestId":command["requestId"],"message":"Unsupported effort"}),
        )
        .unwrap();
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.kind == Some(crate::session_kind::SessionKind::Agent) && form.model == " opus "));
        let mut plain = crate::session_kind::SessionKind::Agent
            .preset(None, Program::Codex, [])
            .unwrap();
        plain.name = "Worker".into();
        app.dialog = Some(Dialog::NewSession(plain));
        let command = app.submit_dialog().unwrap();
        assert_eq!(command["type"], "create");
        assert!(command.get("model").is_none());
        let mut gemini = crate::session_kind::SessionKind::Agent
            .preset(None, Program::Gemini, [])
            .unwrap();
        gemini.model = "stale".into();
        app.dialog = Some(Dialog::NewSession(gemini));
        let command = app.submit_dialog().unwrap();
        assert_eq!(command["type"], "launch");
        assert!(command["spec"].get("model").is_none());
    }

    #[test]
    fn session_kind_terminal_submit_sends_create_and_effort_needs_a_model() {
        let mut app = profile_app();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"t","name":"Terminal 1","cwd":"/work","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        let form = crate::session_kind::SessionKind::Terminal
            .preset(
                None,
                Program::Claude,
                app.sessions.iter().map(|s| s.name.as_str()),
            )
            .unwrap();
        app.dialog = Some(Dialog::NewSession(form));
        let command = app.submit_dialog().unwrap();
        assert_eq!(command["type"], "create");
        assert_eq!(command["name"], "Terminal 2");
        assert_eq!(command["program"], "shell");
        let mut form = crate::session_kind::SessionKind::Agent
            .preset(None, Program::Claude, [])
            .unwrap();
        form.effort = "max".into();
        app.dialog = Some(Dialog::NewSession(form));
        assert!(app.submit_dialog().is_none());
        assert!(app.notice.contains("explicit model"));
        assert!(matches!(app.dialog, Some(Dialog::NewSession(_))));
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::review_session::{self, Scope, Source};

    const PATCH: &str = "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d";

    fn app(reviews: bool) -> App {
        let mut app = App::new(3);
        app.event(json!({"type":"capabilities","workspace":"/w","gitDiff":true,"reviews":reviews,"programs":[]}))
            .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s","name":"Agent","cwd":"/w","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.mode = Mode::Navigate;
        app
    }

    fn opened(request: Option<&Value>, id: &str, scope: &str) -> Value {
        let mut event = json!({"type":"reviewOpened","reviewId":id,"directory":"/w",
            "source":{"kind":"local","sessionId":"s","context":"Automatic"},
            "base":{"ref":"main","oid":"aaaaaaaaaaaa","mergeBase":"bbbbbbb"},
            "head":{"ref":"topic","oid":"cccccccccccc"},"scope":scope,"revision":"r0","checks":null});
        if let Some(request) = request {
            event["requestId"] = request["requestId"].clone();
        }
        event
    }

    fn diff(request: &Value, revision: &str, patch: &str) -> Value {
        json!({"type":"diff","sessionId":null,"reviewId":request["reviewId"],"requestId":request["requestId"],
            "review":{"directory":"/w","scope":"branch","revision":revision,"head":null,"files":[
                {"path":"a.rs","status":"M","patch":patch,"additions":1,"deletions":1,"truncated":false}
            ],"truncated":false}})
    }

    fn context(request: &Value) -> Value {
        json!({"type":"reviewContext","requestId":request["requestId"],"reviewId":request["reviewId"],
            "directory":"/w","readiness":{"blockers":["unpushed"],"ready":false},"provenance":null,"checks":null})
    }

    fn bound(app: &mut App, scope: &str) -> Value {
        let open = review_session::open(app, Source::Local("s".into()));
        let commands = app.event(opened(Some(&open[0]), "local-1", scope)).unwrap();
        commands[0].clone()
    }

    #[test]
    fn review_model_opts_into_review_broadcasts_once_when_the_host_advertises_reviews() {
        let capabilities = |reviews: bool| json!({"type":"capabilities","workspace":"/w","gitDiff":true,"reviews":reviews,"programs":[]});
        let mut legacy = App::new(3);
        assert!(legacy.event(capabilities(false)).unwrap().is_empty());
        let mut app = App::new(3);
        assert_eq!(
            app.event(capabilities(true)).unwrap(),
            [json!({"type":"watchReviews"})]
        );
        assert!(app.event(capabilities(true)).unwrap().is_empty());
        assert!(
            app.event(json!({"type":"reviewsWatched"}))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn review_model_open_review_commands_follow_the_source_and_capability() {
        let mut legacy = app(false);
        assert!(review_session::open(&mut legacy, Source::Local("s".into())).is_empty());
        assert!(legacy.notice.contains("Update nesvo-host"));
        let mut app = app(true);
        let local = review_session::open(&mut app, Source::Local("s".into()));
        assert_eq!(local.len(), 1);
        assert_eq!(local[0]["type"], "openReview");
        assert_eq!(local[0]["source"], json!({"kind":"local","sessionId":"s"}));
        assert!(local[0]["requestId"].is_string());
        assert_eq!(app.reviews.tabs[0].label, "Agent");
        let url = "https://github.com/a/b/pull/9";
        assert!(review_session::open(&mut app, Source::Pull(url.into())).is_empty());
        assert_eq!(app.reviews.tabs.len(), 2);
        let pull = app
            .event(json!({"type":"error","requestId":local[0]["requestId"],"code":"git_unavailable","message":"not a repository"}))
            .unwrap();
        assert_eq!(
            app.reviews.tabs[0].error.as_deref(),
            Some("not a repository")
        );
        assert_eq!(pull[0]["type"], "openReview");
        assert_eq!(pull[0]["source"], json!({"kind":"pull","url":url}));
        app.event(
            json!({"type":"reviewProgress","requestId":pull[0]["requestId"],"stage":"fetch"}),
        )
        .unwrap();
        assert_eq!(app.reviews.tabs[1].stage.as_deref(), Some("fetch"));
    }

    #[test]
    fn review_model_get_diff_uses_review_id_scope_and_base() {
        let mut app = app(true);
        let first = bound(&mut app, "unstaged");
        assert_eq!(app.reviews.tabs[0].scope, Scope::Uncommitted);
        assert_eq!(first["type"], "getDiff");
        assert_eq!(first["reviewId"], "local-1");
        assert_eq!(first["scope"], "branch");
        assert_eq!(first["base"], "HEAD");
        assert!(first.get("sessionId").is_none());
        let next = app.event(diff(&first, "r1", PATCH)).unwrap();
        assert_eq!(next[0]["type"], "reviewContext");
        assert_eq!(next[0]["reviewId"], "local-1");
        assert!(app.event(context(&next[0])).unwrap().is_empty());
        let tab = &mut app.reviews.tabs[0];
        tab.scope = Scope::Branch;
        tab.base = Some("release".into());
        let key = review_session::key(
            &mut app,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('r'),
                crossterm::event::KeyModifiers::NONE,
            ),
            10,
        );
        assert_eq!(key.commands[0]["type"], "getDiff");
        assert_eq!(key.commands[0]["base"], "release");
    }

    #[test]
    fn review_model_requests_context_once_per_revision_and_marks_drift() {
        let mut app = app(true);
        let first = bound(&mut app, "branch");
        let next = app.event(diff(&first, "r1", PATCH)).unwrap();
        assert_eq!(next.len(), 1);
        assert!(app.event(context(&next[0])).unwrap().is_empty());
        let tab = &mut app.reviews.tabs[0];
        tab.comments
            .add(
                crate::review_comments::Anchor {
                    path: "a.rs".into(),
                    side: crate::review_comments::Side::New,
                    start: 2,
                    end: 2,
                    snippet: "c".into(),
                    revision: "r1".into(),
                },
                "Why c?",
            )
            .unwrap();
        tab.comments
            .add(
                crate::review_comments::Anchor {
                    path: "a.rs".into(),
                    side: crate::review_comments::Side::New,
                    start: 3,
                    end: 3,
                    snippet: "d".into(),
                    revision: "r1".into(),
                },
                "Keep d",
            )
            .unwrap();
        let refresh = |app: &mut App| {
            app.reviews.tabs[0].refresh();
            review_session::pump(app)
        };
        let again = refresh(&mut app);
        assert!(app.event(diff(&again[0], "r1", PATCH)).unwrap().is_empty());
        let moved = refresh(&mut app);
        let follow = app
            .event(diff(&moved[0], "r2", "@@ -1,4 +1,4 @@\n a\n x\n-b\n+e\n d"))
            .unwrap();
        assert_eq!(follow[0]["type"], "reviewContext");
        let comments = &app.reviews.tabs[0].comments;
        let why = comments
            .comments
            .iter()
            .find(|c| c.text == "Why c?")
            .unwrap();
        let keep = comments
            .comments
            .iter()
            .find(|c| c.text == "Keep d")
            .unwrap();
        assert!(why.drifted && why.anchor.revision == "r1");
        assert!(!keep.drifted && keep.anchor.start == 4 && keep.anchor.revision == "r2");
        assert_eq!(app.reviews.tabs[0].revision.as_deref(), Some("r2"));
    }

    #[test]
    fn review_model_deliver_review_caps_text_without_lease_and_uses_own_lease() {
        let mut app = app(true);
        let first = bound(&mut app, "branch");
        let next = app.event(diff(&first, "r1", PATCH)).unwrap();
        app.event(context(&next[0])).unwrap();
        let tab = &mut app.reviews.tabs[0];
        for line in 0..20 {
            tab.comments
                .add(
                    crate::review_comments::Anchor {
                        path: "a.rs".into(),
                        side: crate::review_comments::Side::New,
                        start: line,
                        end: line,
                        snippet: "c".into(),
                        revision: "r1".into(),
                    },
                    &"n".repeat(900),
                )
                .unwrap();
        }
        let command = review_session::deliver(&mut app, "local-1", "s").unwrap();
        assert_eq!(command["type"], "deliverReview");
        assert_eq!(command["reviewId"], "local-1");
        assert_eq!(command["sessionId"], "s");
        assert!(command.get("leaseId").is_none());
        let text = command["text"].as_str().unwrap();
        assert!(text.len() <= crate::review_comments::OPERATION_BYTES);
        assert!(text.contains("comments omitted"));
        let status = app.reviews.tabs[0].status.clone().unwrap();
        assert!(
            status.text.contains("Truncated to 8192 bytes"),
            "{}",
            status.text
        );
        app.event(json!({"type":"error","requestId":command["requestId"],"code":"too_large","message":"x"}))
            .unwrap();
        assert!(
            app.reviews.tabs[0]
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("too_large")
        );
        app.event(json!({"type":"control","sessionId":"s","controllerId":3,"cols":80,"rows":24,"leaseId":"own"}))
            .unwrap();
        let pasted = review_session::deliver(&mut app, "local-1", "s").unwrap();
        assert_eq!(pasted["leaseId"], "own");
        let text = pasted["text"].as_str().unwrap();
        assert!(text.len() > crate::review_comments::OPERATION_BYTES);
        assert!(text.len() <= crate::review_comments::PASTE_BYTES);
        app.event(json!({"type":"reviewDelivered","requestId":pasted["requestId"],"reviewId":"local-1","sessionId":"s",
            "path":"paste","key":null,"bytes":text.len(),"receipt":{"id":"feedfacecafe","operation":"paste","phase":"pasted"}}))
            .unwrap();
        let status = app.reviews.tabs[0].status.clone().unwrap();
        assert!(
            status.text.starts_with("Pasted into Agent"),
            "{}",
            status.text
        );
        assert!(review_session::deliver(&mut app, "missing", "s").is_none());
    }

    #[test]
    fn review_model_broadcast_review_opened_opens_one_tab_and_loads_saved_notes() {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-review-broadcast-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        let mut saved = crate::review_comments::Comments::default();
        saved.set_summary("Saved summary").unwrap();
        saved
            .save(&crate::review_comments::store_path(&directory, "local-9").unwrap())
            .unwrap();
        let mut app = app(true);
        app.reviews.store = Some(directory.clone());
        let commands = app.event(opened(None, "local-9", "branch")).unwrap();
        assert_eq!(commands[0]["type"], "getDiff");
        assert_eq!(app.reviews.tabs.len(), 1);
        assert_eq!(app.reviews.shown, Some(0));
        assert!(app.reviews.has_focus());
        assert_eq!(app.reviews.tabs[0].comments.summary, "Saved summary");
        assert_eq!(app.reviews.tabs[0].label, "Agent");
        app.event(opened(None, "local-9", "branch")).unwrap();
        assert_eq!(app.reviews.tabs.len(), 1);
        app.mode = Mode::Input;
        app.reviews.shown = None;
        app.event(opened(None, "local-10", "branch")).unwrap();
        assert_eq!(app.reviews.tabs.len(), 2);
        assert!(app.reviews.shown.is_none());
        assert!(app.notice.contains("new tab"));
        app.event(opened(None, "../bad", "branch")).unwrap();
        assert_eq!(app.reviews.tabs.len(), 2);
        app.mode = Mode::Navigate;
        review_session::show(&mut app, 0, true);
        app.activate_session("s");
        assert!(app.reviews.shown.is_none() && !app.reviews.focused);
        let _ = std::fs::remove_dir_all(directory);
    }
}
