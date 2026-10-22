use crate::{
    controller::Outcome,
    layouts::Role,
    model::App,
    review::{FileDiff, ReviewData},
    review_session::DiffRow,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

pub const COMMIT_LIMIT: usize = 50;
pub const DIFF_PAGE: usize = 10;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_DELAY: Duration = Duration::from_millis(400);
const TIMEOUT_MESSAGE: &str = "The host did not answer the Git request; r retries.";
const BUSY_RETRIES: u8 = 10;
const BUSY_MESSAGE: &str = "Host Git is busy; r retries.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Staged,
    Unstaged,
    Untracked,
    Commits,
}

impl Section {
    pub const ALL: [Self; 4] = [Self::Staged, Self::Unstaged, Self::Untracked, Self::Commits];
    pub const CHANGES: [Self; 3] = [Self::Staged, Self::Unstaged, Self::Untracked];

    pub fn label(self) -> &'static str {
        match self {
            Self::Staged => "Staged",
            Self::Unstaged => "Unstaged",
            Self::Untracked => "Untracked",
            Self::Commits => "Recent commits",
        }
    }

    pub fn scope(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
            Self::Untracked => "untracked",
            Self::Commits => "commits",
        }
    }

    pub fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|section| *section == self)
            .unwrap_or(0)
    }

    fn step(self, back: bool) -> Self {
        let count = Self::ALL.len();
        let index = if back {
            (self.index() + count - 1) % count
        } else {
            (self.index() + 1) % count
        };
        Self::ALL[index]
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Readiness {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub truncated: bool,
    pub clean: bool,
    pub pushed: Option<bool>,
    pub blockers: Vec<String>,
    pub ready: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub short_oid: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub committed_ms: i64,
    #[serde(default)]
    pub parents: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Open,
    Context,
    Scope(Section),
    Commit { from: String, to: String },
}

#[derive(Clone, Debug, Default)]
pub struct Diff {
    pub title: String,
    pub rows: Vec<DiffRow>,
    pub truncated: bool,
    pub loading: bool,
    pub message: Option<String>,
    pub scroll: usize,
}

#[derive(Default)]
pub struct GitPane {
    pub session_id: String,
    pub session_name: String,
    pub review_id: Option<String>,
    pub directory: Option<String>,
    pub readiness: Option<Readiness>,
    pub entries: [Vec<FileDiff>; 3],
    pub truncated: [bool; 3],
    pub loaded: [bool; 4],
    pub commits: Vec<Commit>,
    pub commits_truncated: bool,
    pub received_ms: i64,
    pub section: Option<Section>,
    pub selected: [usize; 4],
    pub diff: Option<Diff>,
    pub focused: bool,
    pub error: Option<String>,
    queue: VecDeque<Request>,
    in_flight: Option<(String, Request, Instant)>,
    commits_request: Option<(String, Instant)>,
    commits_retry_at: Option<Instant>,
    retry_at: Option<Instant>,
    outbox: VecDeque<Value>,
    busy_retries: u8,
    commits_busy_retries: u8,
}

impl GitPane {
    fn new(app: &App, session_id: &str) -> Self {
        let session_name = app
            .session(session_id)
            .map_or_else(String::new, |session| session.name.clone());
        let opened = app
            .reviews
            .tabs
            .iter()
            .find(|tab| tab.session_id.as_deref() == Some(session_id) && tab.pull_url.is_none())
            .and_then(|tab| tab.opened.as_ref());
        let mut pane = Self {
            session_id: session_id.to_owned(),
            session_name,
            review_id: opened.map(|opened| opened.review_id.clone()),
            directory: opened.map(|opened| opened.directory.clone()),
            focused: true,
            ..Default::default()
        };
        if pane.review_id.is_none() {
            pane.queue.push_back(Request::Open);
        }
        pane.queue_refresh();
        pane
    }

    fn queue_refresh(&mut self) {
        self.queue
            .retain(|request| matches!(request, Request::Open));
        self.queue.push_back(Request::Context);
        for section in Section::CHANGES {
            self.queue.push_back(Request::Scope(section));
        }
    }

    pub fn section(&self) -> Section {
        self.section.unwrap_or(Section::Staged)
    }

    pub fn len(&self, section: Section) -> usize {
        match section {
            Section::Commits => self.commits.len(),
            change => self.entries[change.index()].len(),
        }
    }

    pub fn selected(&self, section: Section) -> usize {
        self.selected[section.index()].min(self.len(section).saturating_sub(1))
    }

    pub fn is_loading(&self) -> bool {
        self.in_flight.is_some() || !self.queue.is_empty() || self.commits_request.is_some()
    }

    pub fn move_selection(&mut self, delta: isize) {
        let section = self.section();
        let len = self.len(section);
        if len == 0 {
            return;
        }
        let current = self.selected(section) as isize;
        self.selected[section.index()] = (current + delta).clamp(0, len as isize - 1) as usize;
    }

    pub fn cycle_section(&mut self, back: bool) {
        self.section = Some(self.section().step(back));
    }

    pub fn show_selected(&mut self) {
        let section = self.section();
        let index = self.selected(section);
        if section == Section::Commits {
            let Some(commit) = self.commits.get(index) else {
                return;
            };
            let title = format!("{} {}", commit.short_oid, commit.summary);
            let Some(parent) = commit.parents.first() else {
                self.diff = Some(Diff {
                    title,
                    message: Some("Root commit: there is no parent to compare with.".into()),
                    ..Default::default()
                });
                return;
            };
            let request = Request::Commit {
                from: parent.clone(),
                to: commit.oid.clone(),
            };
            self.queue
                .retain(|queued| !matches!(queued, Request::Commit { .. }));
            self.queue.push_back(request);
            self.diff = Some(Diff {
                title,
                loading: true,
                ..Default::default()
            });
            return;
        }
        let Some(file) = self.entries[section.index()].get(index) else {
            return;
        };
        self.diff = Some(file_diff(section, file));
    }

    pub fn scroll_diff(&mut self, delta: isize) {
        if let Some(diff) = &mut self.diff {
            let max = diff.rows.len().saturating_sub(1) as isize;
            diff.scroll = (diff.scroll as isize + delta).clamp(0, max.max(0)) as usize;
        }
    }

    pub fn refresh(&mut self) {
        self.error = None;
        self.loaded = [false; 4];
        self.retry_at = None;
        self.commits_retry_at = None;
        self.busy_retries = 0;
        self.commits_busy_retries = 0;
        self.outbox.clear();
        self.queue_refresh();
        if self.review_id.is_none() && !self.queue.contains(&Request::Open) {
            self.queue.push_front(Request::Open);
        }
    }

    fn command(&self, app: &mut App, request: &Request) -> Option<Value> {
        let review_id = self.review_id.clone();
        Some(match request {
            Request::Open => app.request(json!({"type":"openReview",
                "source":{"kind":"local","sessionId":self.session_id}})),
            Request::Context => app.request(json!({"type":"reviewContext","reviewId":review_id?})),
            Request::Scope(section) => {
                app.request(json!({"type":"getDiff","reviewId":review_id?,"scope":section.scope()}))
            }
            Request::Commit { from, to } => app.request(json!({"type":"getDiff",
                "reviewId":review_id?,"scope":"commits","from":from,"to":to})),
        })
    }
}

fn file_diff(section: Section, file: &FileDiff) -> Diff {
    let rows = crate::review_session::rows(&file.patch);
    Diff {
        title: format!("{} · {} {}", section.label(), file.status, file.path),
        message: rows
            .is_empty()
            .then(|| "No textual changes to show.".to_owned()),
        rows,
        truncated: file.truncated,
        ..Default::default()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

pub fn supported(app: &App) -> bool {
    app.host_features["git"] == true && app.host_features["reviews"] == true
}

pub fn leaf_index(app: &App) -> Option<usize> {
    app.pane_tree().position(Role::Git)
}

pub fn captures(app: &App) -> bool {
    app.dialog.is_none() && app.git.as_ref().is_some_and(|pane| pane.focused)
}

pub fn open(app: &mut App, focus: bool) -> Vec<Value> {
    if !app.connected {
        app.notice = "Reconnect to the host before opening the Git view.".into();
        return Vec::new();
    }
    if !supported(app) {
        app.notice = "Update nesvo-host to use the Git view.".into();
        return Vec::new();
    }
    let active = app.active_id().map(str::to_owned);
    let current = app.git.as_ref().map(|pane| pane.session_id.clone());
    match active {
        Some(session_id) if current.as_deref() != Some(session_id.as_str()) => {
            let mut pane = GitPane::new(app, &session_id);
            pane.focused = focus;
            app.git = Some(pane);
        }
        _ => {
            let Some(pane) = app.git.as_mut() else {
                app.notice = "Select a session to inspect its repository.".into();
                return Vec::new();
            };
            pane.focused |= focus;
        }
    }
    app.notice.clear();
    pump(app)
}

pub fn close(app: &mut App) {
    app.git = None;
}

fn git_idle(app: &App) -> bool {
    !app.reviews.git_busy() && app.review.request_id.is_none()
}

pub fn pump(app: &mut App) -> Vec<Value> {
    let mut commands = Vec::new();
    let idle = git_idle(app);
    let Some(mut pane) = app.git.take() else {
        return commands;
    };
    let waiting = pane.retry_at.is_some_and(|at| Instant::now() < at);
    if pane.in_flight.is_none() && idle && !waiting {
        pane.retry_at = None;
        while let Some(request) = pane.queue.pop_front() {
            if let Some(command) = pane.command(app, &request) {
                let id = command["requestId"].as_str().unwrap_or_default().to_owned();
                pane.in_flight = Some((id, request, Instant::now()));
                commands.push(command);
                break;
            }
        }
    }
    let commits_waiting = pane.commits_retry_at.is_some_and(|at| Instant::now() < at);
    if pane.commits_request.is_none()
        && !commits_waiting
        && !pane.loaded[Section::Commits.index()]
        && pane.error.is_none()
        && let Some(directory) = pane.directory.clone()
    {
        pane.commits_retry_at = None;
        let command =
            app.request(json!({"type":"listCommits","directory":directory,"limit":COMMIT_LIMIT}));
        pane.commits_request = command["requestId"]
            .as_str()
            .map(|id| (id.to_owned(), Instant::now()));
        commands.push(command);
    }
    app.git = Some(pane);
    commands
}

pub fn tick(app: &mut App) -> Option<Value> {
    let pane = app.git.as_mut()?;
    if let Some(command) = pane.outbox.pop_front() {
        return Some(command);
    }
    if pane
        .commits_request
        .as_ref()
        .is_some_and(|(_, sent)| sent.elapsed() > GIT_TIMEOUT)
    {
        pane.commits_request = None;
        pane.error = Some(TIMEOUT_MESSAGE.into());
    }
    if let Some((_, request, sent)) = &pane.in_flight {
        let limit = if *request == Request::Open {
            OPEN_TIMEOUT
        } else {
            GIT_TIMEOUT
        };
        if sent.elapsed() > limit {
            pane.in_flight = None;
            pane.queue.clear();
            pane.error = Some(TIMEOUT_MESSAGE.into());
        }
    }
    let mut commands = pump(app).into_iter();
    let first = commands.next();
    if let Some(pane) = app.git.as_mut() {
        pane.outbox.extend(commands);
    }
    first
}

fn retry(pane: &mut GitPane, request: Request) {
    if pane.busy_retries >= BUSY_RETRIES {
        pane.queue.clear();
        pane.error = Some(BUSY_MESSAGE.into());
        return;
    }
    pane.busy_retries += 1;
    pane.queue.push_front(request);
    pane.retry_at = Some(Instant::now() + RETRY_DELAY);
}

fn retry_commits(pane: &mut GitPane) {
    if pane.commits_busy_retries >= BUSY_RETRIES {
        pane.loaded[Section::Commits.index()] = true;
        pane.error = Some(BUSY_MESSAGE.into());
        return;
    }
    pane.commits_busy_retries += 1;
    pane.commits_retry_at = Some(Instant::now() + RETRY_DELAY);
}

fn busy(event: &Value) -> bool {
    event["code"] == "busy"
        || event["error"]
            .as_str()
            .is_some_and(|error| error.contains("already running"))
}

pub fn host_event(app: &mut App, event: &Value) -> Option<Vec<Value>> {
    let request = event["requestId"].as_str()?;
    let pane = app.git.as_mut()?;
    if pane
        .commits_request
        .as_ref()
        .is_some_and(|(id, _)| id == request)
    {
        pane.commits_request = None;
        match event["type"].as_str() {
            Some("commits") => {
                pane.commits = serde_json::from_value(event["commits"].clone()).unwrap_or_default();
                pane.commits_truncated = event["truncated"] == true;
                pane.received_ms = now_ms();
                pane.loaded[Section::Commits.index()] = true;
                pane.commits_busy_retries = 0;
            }
            _ if busy(event) => retry_commits(pane),
            _ => {
                pane.loaded[Section::Commits.index()] = true;
                pane.error = Some(format!(
                    "Commit history: {}",
                    event["message"]
                        .as_str()
                        .unwrap_or("the host refused the request")
                ));
            }
        }
        return Some(pump(app));
    }
    let (_, sent, _) = pane.in_flight.take_if(|(id, _, _)| id == request)?;
    accept(pane, sent, event);
    Some(pump(app))
}

fn accept(pane: &mut GitPane, sent: Request, event: &Value) {
    let kind = event["type"].as_str().unwrap_or_default();
    if busy(event) {
        return retry(pane, sent);
    }
    pane.busy_retries = 0;
    if kind == "error" && event["code"] == "review_not_found" && sent != Request::Open {
        pane.review_id = None;
        pane.queue.push_front(sent);
        pane.queue.push_front(Request::Open);
        return;
    }
    if kind == "error" {
        let message = event["message"]
            .as_str()
            .unwrap_or("The host refused the Git request.");
        pane.queue.clear();
        pane.error = Some(message.to_owned());
        if let Some(diff) = pane.diff.as_mut().filter(|diff| diff.loading) {
            diff.loading = false;
            diff.message = Some(message.to_owned());
        }
        return;
    }
    match (sent, kind) {
        (Request::Open, "reviewOpened") => {
            pane.review_id = event["reviewId"].as_str().map(str::to_owned);
            pane.directory = event["directory"].as_str().map(str::to_owned);
        }
        (Request::Context, "reviewContext") => {
            pane.readiness = serde_json::from_value(event["readiness"].clone()).ok();
            if let Some(directory) = event["directory"].as_str() {
                pane.directory = Some(directory.to_owned());
            }
        }
        (Request::Scope(section), "diff") => {
            pane.loaded[section.index()] = true;
            if let Some(error) = event["error"].as_str() {
                pane.error = Some(error.to_owned());
                return;
            }
            let data: ReviewData =
                serde_json::from_value(event["review"].clone()).unwrap_or_default();
            pane.truncated[section.index()] = data.truncated;
            pane.entries[section.index()] = data.files;
            if pane.section.is_none() && !pane.entries[section.index()].is_empty() {
                pane.section = Some(section);
            }
        }
        (Request::Commit { .. }, "diff") => {
            let Some(diff) = pane.diff.as_mut() else {
                return;
            };
            diff.loading = false;
            if let Some(error) = event["error"].as_str() {
                diff.message = Some(error.to_owned());
                return;
            }
            let data: ReviewData =
                serde_json::from_value(event["review"].clone()).unwrap_or_default();
            let mut rows = Vec::new();
            for file in &data.files {
                rows.push(DiffRow {
                    kind: crate::review_session::RowKind::Meta,
                    old: None,
                    new: None,
                    text: format!(
                        "{} {}  +{} -{}",
                        file.status, file.path, file.additions, file.deletions
                    ),
                });
                rows.extend(crate::review_session::rows(&file.patch));
            }
            diff.truncated = data.truncated || data.files.iter().any(|file| file.truncated);
            if rows.is_empty() {
                diff.message = Some("This commit changes no files.".into());
            }
            diff.rows = rows;
            diff.scroll = 0;
        }
        _ => {}
    }
}

pub fn event(app: &mut App, event: Event) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key_event(app, key, &mut outcome),
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome
}

fn key_event(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code == KeyCode::Char('c') {
            outcome.quit = true;
        } else {
            outcome.redraw = false;
        }
        return;
    }
    let in_leaf = leaf_index(app).is_some();
    let Some(pane) = app.git.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Esc if pane.diff.is_some() => pane.diff = None,
        KeyCode::Esc if in_leaf => pane.focused = false,
        KeyCode::Esc | KeyCode::Char('q') => return close(app),
        KeyCode::Down | KeyCode::Char('j') => pane.move_selection(1),
        KeyCode::Up | KeyCode::Char('k') => pane.move_selection(-1),
        KeyCode::Tab => pane.cycle_section(false),
        KeyCode::BackTab => pane.cycle_section(true),
        KeyCode::Enter => pane.show_selected(),
        KeyCode::PageDown | KeyCode::Char('J') => pane.scroll_diff(DIFF_PAGE as isize),
        KeyCode::PageUp | KeyCode::Char('K') => pane.scroll_diff(-(DIFF_PAGE as isize)),
        KeyCode::Char('r') => pane.refresh(),
        _ => {
            outcome.redraw = false;
            return;
        }
    }
    outcome.commands.extend(pump(app));
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::controller;
    use crossterm::event::KeyEvent;
    use ratatui::layout::Rect;

    pub fn app() -> App {
        let mut app = App::new(9);
        app.event(
            json!({"type":"capabilities","workspace":"C:/w","gitDiff":true,
            "reviews":true,"git":true,"programs":[{"id":"claude","available":true}]}),
        )
        .unwrap();
        app.event(
            json!({"type":"sessions","revision":1,"groups":[],"sessions":[
                {"id":"s1","name":"Agent work","cwd":"C:/w","program":"claude","cols":80,"rows":24,
                 "running":true,"groupId":null,"controllerId":null}
            ]}),
        )
        .unwrap();
        app.connected = true;
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app.panes[0] = Some("s1".into());
        app
    }

    fn key(app: &mut App, code: KeyCode) -> Outcome {
        controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 32),
        )
    }

    fn reply(app: &mut App, command: &Value, mut event: Value) -> Vec<Value> {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap()
    }

    fn file(path: &str, status: &str) -> Value {
        json!({"path":path,"status":status,"patch":format!("diff --git a/{path} b/{path}\n@@ -1 +1 @@\n-old\n+new\n"),
            "additions":1,"deletions":1,"truncated":false})
    }

    pub fn loaded() -> App {
        let mut app = app();
        let open = key(&mut app, KeyCode::Char('Y')).commands;
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["type"], "openReview");
        assert_eq!(open[0]["source"]["sessionId"], "s1");
        let next = reply(
            &mut app,
            &open[0],
            json!({"type":"reviewOpened","reviewId":"local-0123456789abcdef",
            "directory":"C:/w","source":{"kind":"local","sessionId":"s1"},"scope":"unstaged","revision":"r"}),
        );
        assert_eq!(next.len(), 2);
        assert_eq!(next[0]["type"], "reviewContext");
        assert_eq!(next[1]["type"], "listCommits");
        assert_eq!(next[1]["directory"], "C:/w");
        assert_eq!(next[1]["limit"], COMMIT_LIMIT);
        assert!(app.reviews.tabs.is_empty());
        let commits = &next[1];
        let staged = reply(
            &mut app,
            &next[0],
            json!({"type":"reviewContext","reviewId":"local-0123456789abcdef",
            "directory":"C:/w","readiness":{"branch":"feature/git","upstream":"origin/feature/git","ahead":2,"behind":1,
            "staged":1,"unstaged":2,"untracked":1,"conflicted":0,"clean":false,"pushed":false,
            "blockers":["dirty","behindUpstream","unpushed"],"ready":false},"provenance":null,"checks":null}),
        );
        assert_eq!(staged[0]["type"], "getDiff");
        assert_eq!(staged[0]["scope"], "staged");
        assert_eq!(staged[0]["reviewId"], "local-0123456789abcdef");
        let unstaged = reply(
            &mut app,
            &staged[0],
            json!({"type":"diff","sessionId":null,"reviewId":"local-0123456789abcdef",
            "review":{"files":[file("src/staged.rs","M")],"truncated":false}}),
        );
        assert_eq!(unstaged[0]["scope"], "unstaged");
        let untracked = reply(
            &mut app,
            &unstaged[0],
            json!({"type":"diff","sessionId":null,"reviewId":"local-0123456789abcdef",
            "review":{"files":[file("src/main.rs","M"),file("old.txt","D")],"truncated":false}}),
        );
        assert_eq!(untracked[0]["scope"], "untracked");
        let done = reply(
            &mut app,
            &untracked[0],
            json!({"type":"diff","sessionId":null,"reviewId":"local-0123456789abcdef",
            "review":{"files":[file("notes.md","?")],"truncated":false}}),
        );
        assert!(done.is_empty());
        let oid = |c: char| c.to_string().repeat(40);
        reply(
            &mut app,
            commits,
            json!({"type":"commits","directory":"C:/w","truncated":false,"commits":[
                {"oid":oid('a'),"shortOid":"aaaaaaa","summary":"Add git view","author":"Damian","committedMs":1_700_000_000_000i64,"parents":[oid('b')]},
                {"oid":oid('b'),"shortOid":"bbbbbbb","summary":"Initial commit","author":"Damian","committedMs":1_699_000_000_000i64,"parents":[]}
            ]}),
        );
        app.git.as_mut().unwrap().received_ms = 1_700_000_360_000;
        app
    }

    #[test]
    fn git_pane_open_sends_review_context_scopes_and_commits_in_order() {
        let app = loaded();
        let pane = app.git.as_ref().unwrap();
        assert!(!pane.is_loading());
        assert_eq!(
            pane.readiness.as_ref().unwrap().branch.as_deref(),
            Some("feature/git")
        );
        assert_eq!(pane.entries[0].len(), 1);
        assert_eq!(pane.entries[1].len(), 2);
        assert_eq!(pane.entries[2].len(), 1);
        assert_eq!(pane.commits.len(), 2);
        assert_eq!(pane.section(), Section::Staged);
        assert!(pane.error.is_none());
    }

    #[test]
    fn git_pane_reuses_an_open_review_and_needs_host_support() {
        let mut app = app();
        app.host_features["git"] = false.into();
        assert!(key(&mut app, KeyCode::Char('Y')).commands.is_empty());
        assert!(app.git.is_none());
        assert!(app.notice.contains("Update nesvo-host"));
        let mut app = self::app();
        app.event(
            json!({"type":"reviewOpened","reviewId":"local-fedcba9876543210","directory":"C:/w",
            "source":{"kind":"local","sessionId":"s1"},"scope":"unstaged","revision":"r"}),
        )
        .unwrap();
        assert_eq!(app.reviews.tabs.len(), 1);
        crate::review_session::hide(&mut app);
        let opened = key(&mut app, KeyCode::Char('Y')).commands;
        let pane = app.git.as_ref().unwrap();
        assert_eq!(pane.review_id.as_deref(), Some("local-fedcba9876543210"));
        assert_eq!(pane.directory.as_deref(), Some("C:/w"));
        assert!(opened.iter().all(|command| command["type"] != "openReview"));
        assert!(
            opened
                .iter()
                .any(|command| command["type"] == "listCommits")
        );
        key(&mut app, KeyCode::Char('q'));
        assert!(app.git.is_none());
    }

    #[test]
    fn git_pane_sections_cycle_and_selection_is_clamped_per_section() {
        let mut app = loaded();
        key(&mut app, KeyCode::Char('j'));
        assert_eq!(app.git.as_ref().unwrap().selected(Section::Staged), 0);
        key(&mut app, KeyCode::Tab);
        key(&mut app, KeyCode::Char('j'));
        key(&mut app, KeyCode::Char('j'));
        let pane = app.git.as_ref().unwrap();
        assert_eq!(pane.section(), Section::Unstaged);
        assert_eq!(pane.selected(Section::Unstaged), 1);
        key(&mut app, KeyCode::Tab);
        key(&mut app, KeyCode::Tab);
        assert_eq!(app.git.as_ref().unwrap().section(), Section::Commits);
        key(&mut app, KeyCode::Tab);
        assert_eq!(app.git.as_ref().unwrap().section(), Section::Staged);
        key(&mut app, KeyCode::BackTab);
        assert_eq!(app.git.as_ref().unwrap().section(), Section::Commits);
        key(&mut app, KeyCode::Char('k'));
        assert_eq!(app.git.as_ref().unwrap().selected(Section::Commits), 0);
    }

    #[test]
    fn git_pane_enter_shows_entry_patch_and_commit_diff_through_get_diff() {
        let mut app = loaded();
        key(&mut app, KeyCode::Tab);
        key(&mut app, KeyCode::Char('j'));
        assert!(key(&mut app, KeyCode::Enter).commands.is_empty());
        let diff = app.git.as_ref().unwrap().diff.clone().unwrap();
        assert!(diff.title.contains("old.txt"));
        assert!(diff.rows.iter().any(|row| row.text == "new"));
        key(&mut app, KeyCode::Esc);
        assert!(app.git.as_ref().unwrap().diff.is_none());
        key(&mut app, KeyCode::BackTab);
        key(&mut app, KeyCode::BackTab);
        let request = key(&mut app, KeyCode::Enter).commands;
        assert_eq!(request.len(), 1);
        assert_eq!(request[0]["type"], "getDiff");
        assert_eq!(request[0]["scope"], "commits");
        assert_eq!(request[0]["from"], "b".repeat(40));
        assert_eq!(request[0]["to"], "a".repeat(40));
        assert!(app.git.as_ref().unwrap().diff.as_ref().unwrap().loading);
        reply(
            &mut app,
            &request[0],
            json!({"type":"diff","sessionId":null,"reviewId":"local-0123456789abcdef",
            "review":{"files":[file("src/git_pane.rs","A")],"truncated":false}}),
        );
        let diff = app.git.as_ref().unwrap().diff.clone().unwrap();
        assert!(!diff.loading);
        assert!(diff.rows[0].text.contains("src/git_pane.rs"));
        key(&mut app, KeyCode::Char('j'));
        assert!(key(&mut app, KeyCode::Enter).commands.is_empty());
        let root = app.git.as_ref().unwrap().diff.clone().unwrap();
        assert!(root.message.unwrap().contains("Root commit"));
    }

    #[test]
    fn git_pane_refresh_retries_busy_and_escape_closes() {
        let mut app = loaded();
        let refresh = key(&mut app, KeyCode::Char('r')).commands;
        assert_eq!(refresh.len(), 2);
        assert_eq!(refresh[0]["type"], "reviewContext");
        assert_eq!(refresh[1]["type"], "listCommits");
        let after = reply(
            &mut app,
            &refresh[0],
            json!({"type":"error","code":"busy","message":"busy"}),
        );
        assert!(after.is_empty());
        app.git.as_mut().unwrap().retry_at = Some(Instant::now());
        let retried = tick(&mut app).unwrap();
        assert_eq!(retried["type"], "reviewContext");
        let failed = reply(
            &mut app,
            &retried,
            json!({"type":"error","code":"review_not_found","message":"gone"}),
        );
        assert_eq!(failed[0]["type"], "openReview");
        assert!(app.git.as_ref().unwrap().review_id.is_none());
        key(&mut app, KeyCode::Esc);
        assert!(app.git.is_none());
        assert!(!captures(&app));
    }

    #[test]
    fn git_pane_stops_retrying_a_busy_host_and_refresh_starts_over() {
        let mut app = loaded();
        let busy = json!({"type":"error","code":"busy","message":"busy"});
        let mut sent = key(&mut app, KeyCode::Char('r')).commands.remove(0);
        for _ in 0..BUSY_RETRIES {
            assert_eq!(sent["type"], "reviewContext");
            reply(&mut app, &sent, busy.clone());
            app.git.as_mut().unwrap().retry_at = Some(Instant::now());
            sent = tick(&mut app).unwrap();
        }
        reply(&mut app, &sent, busy.clone());
        let pane = app.git.as_mut().unwrap();
        assert_eq!(pane.error.as_deref(), Some(BUSY_MESSAGE));
        assert!(pane.queue.is_empty());
        pane.retry_at = Some(Instant::now());
        pane.outbox.push_back(json!({"type":"stale"}));
        assert!(std::iter::from_fn(|| tick(&mut app)).all(|command| command["type"] == "stale"));
        app.git
            .as_mut()
            .unwrap()
            .outbox
            .push_back(json!({"type":"stale"}));
        let refreshed = key(&mut app, KeyCode::Char('r')).commands;
        assert_eq!(refreshed[0]["type"], "reviewContext");
        let pane = app.git.as_ref().unwrap();
        assert!(pane.error.is_none());
        assert_eq!(pane.busy_retries, 0);
        assert!(pane.outbox.is_empty());
    }

    #[test]
    fn git_pane_busy_commits_wait_for_the_retry_delay() {
        let mut app = loaded();
        let refresh = key(&mut app, KeyCode::Char('r')).commands;
        assert_eq!(refresh[1]["type"], "listCommits");
        let after = reply(
            &mut app,
            &refresh[1],
            json!({"type":"error","code":"busy","message":"busy"}),
        );
        assert!(after.iter().all(|command| command["type"] != "listCommits"));
        assert!(tick(&mut app).is_none());
        assert!(app.git.as_ref().unwrap().commits_retry_at.is_some());
        app.git.as_mut().unwrap().commits_retry_at = Some(Instant::now());
        let retried = tick(&mut app).unwrap();
        assert_eq!(retried["type"], "listCommits");
        assert!(app.git.as_ref().unwrap().commits_retry_at.is_none());
    }

    #[test]
    fn git_pane_commits_request_times_out_like_the_in_flight_request() {
        let mut app = loaded();
        let refresh = key(&mut app, KeyCode::Char('r')).commands;
        assert_eq!(refresh[1]["type"], "listCommits");
        reply(
            &mut app,
            &refresh[0],
            json!({"type":"reviewContext","reviewId":"local-0123456789abcdef","directory":"C:/w","readiness":null}),
        );
        let pane = app.git.as_mut().unwrap();
        pane.queue.clear();
        pane.in_flight = None;
        let (id, _) = pane.commits_request.clone().unwrap();
        let expired = Instant::now()
            .checked_sub(GIT_TIMEOUT + Duration::from_millis(1))
            .unwrap();
        pane.commits_request = Some((id, expired));
        assert!(tick(&mut app).is_none());
        let pane = app.git.as_ref().unwrap();
        assert!(pane.commits_request.is_none());
        assert!(!pane.is_loading());
        assert_eq!(pane.error.as_deref(), Some(TIMEOUT_MESSAGE));
    }

    #[test]
    fn git_pane_tick_delivers_every_command_from_one_pump() {
        let mut app = loaded();
        let refresh = key(&mut app, KeyCode::Char('r')).commands;
        let busy = json!({"type":"error","code":"busy","message":"busy"});
        reply(&mut app, &refresh[1], busy.clone());
        reply(&mut app, &refresh[0], busy);
        let pane = app.git.as_mut().unwrap();
        pane.retry_at = Some(Instant::now());
        pane.commits_retry_at = Some(Instant::now());
        let first = tick(&mut app).unwrap();
        assert_eq!(first["type"], "reviewContext");
        let second = tick(&mut app).unwrap();
        assert_eq!(second["type"], "listCommits");
        assert_eq!(
            app.git
                .as_ref()
                .unwrap()
                .commits_request
                .as_ref()
                .unwrap()
                .0,
            second["requestId"].as_str().unwrap()
        );
        assert!(app.git.as_ref().unwrap().outbox.is_empty());
    }

    #[test]
    fn git_pane_waits_for_review_tabs_before_using_the_git_gate() {
        let mut app = app();
        app.review.request_id = Some("busy".into());
        let open = key(&mut app, KeyCode::Char('Y')).commands;
        assert!(open.is_empty());
        assert!(app.git.as_ref().unwrap().is_loading());
        app.review.request_id = None;
        assert_eq!(tick(&mut app).unwrap()["type"], "openReview");
    }

    #[test]
    fn git_pane_palette_command_opens_the_view() {
        let mut app = app();
        assert!(crate::palette::COMMANDS.contains(&('Y', "Git")));
        key(&mut app, KeyCode::Char('/'));
        controller::event(
            &mut app,
            Event::Paste("Git".into()),
            Rect::new(0, 0, 100, 32),
        );
        let results = crate::palette::results(&app, "Git");
        assert!(
            results
                .iter()
                .any(|row| row.target == crate::palette::Target::Command('Y'))
        );
    }
}
