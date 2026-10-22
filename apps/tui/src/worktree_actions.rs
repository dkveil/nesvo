use crate::{
    controller::Outcome,
    model::{App, Dialog},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

const REGISTRY_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const RECORD_LIMIT: usize = 128;
const CONFIRM_LIMIT: usize = 256;
pub const LOG_LIMIT: usize = 65_536;
pub const LOG_PAGE: usize = 10;
pub const APPROVAL_HINT: &str =
    "Approving nesvo.toml stays in the CLI: nesvo worktree approve-setup";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Muted,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    SetupRunning,
    SetupPassed,
    NoSetup,
    SetupFailed,
    SetupTimedOut,
    SetupCancelled,
    RunRunning,
    RunPassed,
    RunFailed,
    RunTimedOut,
    RunCancelled,
    Archived,
    Unknown,
}

impl Stage {
    pub fn short(self) -> &'static str {
        match self {
            Self::SetupRunning => "setup…",
            Self::SetupPassed | Self::RunPassed | Self::RunCancelled => "wt ✓",
            Self::NoSetup => "wt",
            Self::SetupFailed => "wt ✗",
            Self::SetupTimedOut => "wt t/o",
            Self::SetupCancelled => "wt ⊘",
            Self::RunRunning => "run…",
            Self::RunFailed | Self::RunTimedOut => "run ✗",
            Self::Archived => "wt arc",
            Self::Unknown => "wt ?",
        }
    }

    pub fn phrase(self) -> &'static str {
        match self {
            Self::SetupRunning => "setup running",
            Self::SetupPassed => "setup passed",
            Self::NoSetup => "no setup steps",
            Self::SetupFailed => "setup failed",
            Self::SetupTimedOut => "setup timed out",
            Self::SetupCancelled => "setup cancelled",
            Self::RunRunning => "run in progress",
            Self::RunPassed => "run passed",
            Self::RunFailed => "run failed",
            Self::RunTimedOut => "run timed out",
            Self::RunCancelled => "run cancelled",
            Self::Archived => "archived",
            Self::Unknown => "state unknown",
        }
    }

    pub fn tone(self) -> Tone {
        match self {
            Self::SetupRunning | Self::RunRunning => Tone::Warning,
            Self::SetupPassed | Self::RunPassed => Tone::Success,
            Self::SetupFailed | Self::SetupTimedOut | Self::RunFailed | Self::RunTimedOut => {
                Tone::Danger
            }
            Self::NoSetup
            | Self::SetupCancelled
            | Self::RunCancelled
            | Self::Archived
            | Self::Unknown => Tone::Muted,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Phase {
    pub state: String,
    pub log: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    pub session_id: String,
    pub worktree: String,
    pub branch: Option<String>,
    pub repository: String,
    pub digest: Option<String>,
    pub setup: Phase,
    pub run: Option<Phase>,
    pub archived_at: Option<u64>,
    pub discarded: bool,
    pub present: bool,
    pub session_live: bool,
    pub active: bool,
}

impl Record {
    pub fn stage(&self) -> Stage {
        if self.archived_at.is_some() {
            return Stage::Archived;
        }
        match self.setup.state.as_str() {
            "running" => return Stage::SetupRunning,
            "failed" => return Stage::SetupFailed,
            "timedOut" => return Stage::SetupTimedOut,
            "cancelled" => return Stage::SetupCancelled,
            "passed" | "notConfigured" => {}
            _ => return Stage::Unknown,
        }
        match self.run.as_ref().map(|run| run.state.as_str()) {
            Some("running") => Stage::RunRunning,
            Some("passed") => Stage::RunPassed,
            Some("failed") => Stage::RunFailed,
            Some("timedOut") => Stage::RunTimedOut,
            Some("cancelled") => Stage::RunCancelled,
            Some(_) => Stage::Unknown,
            None if self.setup.state == "notConfigured" => Stage::NoSetup,
            None => Stage::SetupPassed,
        }
    }

    pub fn busy(&self) -> bool {
        self.active || matches!(self.stage(), Stage::SetupRunning | Stage::RunRunning)
    }

    pub fn confirmation(&self) -> String {
        self.branch.clone().unwrap_or_else(|| {
            self.worktree
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or(&self.session_id)
                .to_owned()
        })
    }

    fn setup_ready(&self) -> bool {
        matches!(self.setup.state.as_str(), "passed" | "notConfigured")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Run,
    Cancel,
    Archive,
    Discard,
    SetupLog,
    RunLog,
}

impl Action {
    pub const ALL: [Self; 6] = [
        Self::Run,
        Self::Cancel,
        Self::Archive,
        Self::Discard,
        Self::SetupLog,
        Self::RunLog,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Run => "Run steps",
            Self::Cancel => "Cancel step",
            Self::Archive => "Archive",
            Self::Discard => "Discard and archive",
            Self::SetupLog => "Open setup log",
            Self::RunLog => "Open run log",
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            Self::Run => "start the run steps from nesvo.toml",
            Self::Cancel => "terminate the running setup or run step",
            Self::Archive => "remove the worktree when nothing is unsaved",
            Self::Discard => "remove it anyway; type the branch name",
            Self::SetupLog => "read .nesvo/setup.log",
            Self::RunLog => "read .nesvo/run.log",
        }
    }

    pub fn availability(self, record: Option<&Record>) -> Result<(), &'static str> {
        let record = record.ok_or("no host-created worktree for this session")?;
        if record.archived_at.is_some() {
            return Err("the worktree is archived");
        }
        match self {
            Self::Run if !record.setup_ready() => Err("setup has not passed"),
            Self::Run if record.busy() => Err("a step is already running"),
            Self::Cancel if !record.busy() => Err("nothing is running"),
            Self::SetupLog if record.setup.log.is_none() => Err("no setup steps ran"),
            Self::RunLog
                if record
                    .run
                    .as_ref()
                    .and_then(|run| run.log.as_ref())
                    .is_none() =>
            {
                Err("run steps have not started")
            }
            _ => Ok(()),
        }
    }

    fn log_path(self, record: &Record) -> Option<String> {
        match self {
            Self::SetupLog => record.setup.log.clone(),
            Self::RunLog => record.run.as_ref().and_then(|run| run.log.clone()),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Page {
    Menu,
    Confirm {
        typed: String,
        mismatch: bool,
    },
    Log {
        action: Action,
        path: String,
        text: Option<String>,
        scroll: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    Info(String),
    Refused {
        code: String,
        message: String,
        blockers: Vec<String>,
        hint: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Pending {
    request: String,
    action: Action,
    sent: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actions {
    pub session_id: String,
    pub selected: usize,
    pub page: Page,
    pub notice: Option<Notice>,
    pending: Option<Pending>,
}

impl Actions {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            selected: 0,
            page: Page::Menu,
            notice: None,
            pending: None,
        }
    }

    pub fn waiting(&self) -> bool {
        self.pending.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SetupCheck {
    Checking,
    NotConfigured,
    Approved { digest: String },
    Unapproved { digest: String },
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    pub directory: String,
    pub check: SetupCheck,
    request: Option<(String, Instant)>,
}

#[derive(Default)]
pub struct Worktrees {
    pub records: Vec<Record>,
    pub loaded: bool,
    pub dialog: Option<Actions>,
    pub probe: Option<Probe>,
    pub failed_launch: Option<String>,
    listing: Option<(String, Instant)>,
    due: bool,
    known: HashSet<String>,
    polled: Option<Instant>,
}

impl Worktrees {
    pub fn record(&self, session_id: &str) -> Option<&Record> {
        self.records
            .iter()
            .find(|record| record.session_id == session_id)
    }

    fn record_mut(&mut self, session_id: &str) -> Option<&mut Record> {
        self.records
            .iter_mut()
            .find(|record| record.session_id == session_id)
    }

    pub fn stage(&self, session_id: &str) -> Option<Stage> {
        self.record(session_id).map(Record::stage)
    }
}

pub fn supported(app: &App) -> bool {
    app.host_features["worktrees"] == true
}

pub fn header(app: &App, session_id: &str) -> Option<String> {
    app.worktrees
        .stage(session_id)
        .map(|stage| format!("worktree {}", stage.phrase()))
}

fn blockers(code: &str, message: &str) -> Vec<String> {
    if code != "worktree_unsaved" {
        return Vec::new();
    }
    message
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(inside, _)| {
            inside
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(8)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn hint(code: &str) -> &'static str {
    match code {
        "session_running" => "Close the session (d in Navigate), then archive it.",
        "worktree_unsaved" => "Commit and push the branch, or choose Discard and archive.",
        "worktree_not_prepared" => "Setup has not passed; open the setup log.",
        "worktree_setup_unapproved" => APPROVAL_HINT,
        "worktree_run_unavailable" => "Declare run steps in nesvo.toml and approve its digest.",
        "worktree_not_found" => "The host has no worktree registered for this session.",
        "busy" => "The host is busy; retry in a moment.",
        "forbidden" => "Worktree actions need owner authority.",
        _ => "",
    }
}

fn refusal(event: &Value) -> Notice {
    let code = event["code"].as_str().unwrap_or("error").to_owned();
    let message = event["message"]
        .as_str()
        .unwrap_or("The host refused the request")
        .to_owned();
    Notice::Refused {
        blockers: blockers(&code, &message),
        hint: hint(&code),
        code,
        message,
    }
}

fn sanitize(text: &str) -> String {
    text.chars()
        .take(LOG_LIMIT)
        .filter_map(|c| match c {
            '\n' => Some("\n".to_owned()),
            '\t' => Some("    ".to_owned()),
            c if c.is_control() => None,
            c => Some(c.to_string()),
        })
        .collect()
}

fn observe(app: &mut App, event: &Value) {
    let state = &mut app.worktrees;
    match event["type"].as_str() {
        Some("capabilities") => {
            if event["worktrees"] == true {
                if !state.loaded && state.listing.is_none() {
                    state.due = true;
                }
            } else {
                *state = Worktrees::default();
            }
        }
        Some("sessions") => {
            let ids: HashSet<String> = event["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|session| session["id"].as_str().map(str::to_owned))
                .collect();
            if ids.iter().any(|id| !state.known.contains(id)) {
                state.due = true;
            }
            state.known = ids;
        }
        Some("created") => state.due = true,
        Some("error")
            if event["code"]
                .as_str()
                .is_some_and(|code| code.starts_with("worktree_setup_")) =>
        {
            if let Some(id) = event["sessionId"].as_str() {
                state.failed_launch = Some(id.to_owned());
                state.due = true;
            }
        }
        _ => {}
    }
}

fn journal_facts(app: &mut App, event: &Value) {
    if event["type"] != "events" {
        return;
    }
    for record in event["events"].as_array().into_iter().flatten() {
        journal_fact(app, record);
    }
}

fn journal_fact(app: &mut App, event: &Value) {
    let kind = event["kind"].as_str().unwrap_or_default();
    if !matches!(kind, "worktree.prepared" | "worktree.ran") {
        return;
    }
    let payload = &event["payload"];
    let (Some(id), Some(result)) = (payload["sessionId"].as_str(), payload["result"].as_str())
    else {
        return;
    };
    let log = payload["log"].as_str().map(str::to_owned);
    if let Some(record) = app.worktrees.record_mut(id) {
        let phase = Phase {
            state: result.to_owned(),
            log,
        };
        if kind == "worktree.prepared" {
            record.setup = phase;
        } else {
            record.run = Some(phase);
            record.active = false;
        }
    }
    app.worktrees.due = true;
}

fn registry_reply(app: &mut App, event: &Value) {
    let state = &mut app.worktrees;
    state.listing = None;
    if event["type"] == "worktreeRegistry" {
        state.records = event["worktrees"]
            .as_array()
            .into_iter()
            .flatten()
            .take(RECORD_LIMIT)
            .filter_map(|item| serde_json::from_value::<Record>(item.clone()).ok())
            .filter(|record| !record.session_id.is_empty())
            .collect();
        state.loaded = true;
    } else if event["code"] == "busy" {
        state.due = true;
    } else if let Some(dialog) = &mut state.dialog {
        dialog.notice = Some(refusal(event));
    }
}

fn probe_reply(app: &mut App, event: &Value) {
    let Some(probe) = &mut app.worktrees.probe else {
        return;
    };
    probe.request = None;
    let digest = event["digest"].as_str().unwrap_or_default().to_owned();
    probe.check = match event["type"].as_str() {
        Some("worktreeSetup") if event["configured"] != true => SetupCheck::NotConfigured,
        Some("worktreeSetup") if event["approved"] == true => SetupCheck::Approved { digest },
        Some("worktreeSetup") => SetupCheck::Unapproved { digest },
        _ => SetupCheck::Failed(
            event["message"]
                .as_str()
                .unwrap_or("The host could not describe the worktree setup")
                .to_owned(),
        ),
    };
}

fn action_reply(app: &mut App, event: &Value, action: Action) {
    let state = &mut app.worktrees;
    let Some(dialog) = &mut state.dialog else {
        return;
    };
    let session = dialog.session_id.clone();
    if event["type"] == "error" {
        dialog.notice = Some(refusal(event));
        if let Page::Log { text, .. } = &mut dialog.page {
            *text = Some(String::new());
        }
        if matches!(dialog.page, Page::Confirm { .. }) {
            dialog.page = Page::Menu;
        }
        return;
    }
    match (action, event["type"].as_str()) {
        (Action::Run, Some("worktreeRunStarted")) => {
            let log = event["log"].as_str().map(str::to_owned);
            dialog.notice = Some(Notice::Info(format!(
                "Run steps started · log {}",
                log.as_deref().unwrap_or("unavailable")
            )));
        }
        (Action::Cancel, Some("worktreeCancelled")) => {
            dialog.notice = Some(Notice::Info(if event["cancelled"] == true {
                "Cancel sent; the step is terminating.".into()
            } else {
                "Nothing was running on the host.".into()
            }));
        }
        (Action::Archive | Action::Discard, Some("worktreeArchived")) => {
            let discarded = event["discarded"] == true;
            dialog.page = Page::Menu;
            dialog.notice = Some(Notice::Info(format!(
                "Archived: worktree removed, branch {}{}.",
                if event["branchDeleted"] == true {
                    "deleted"
                } else {
                    "kept"
                },
                if discarded {
                    ", unsaved work discarded"
                } else {
                    ""
                }
            )));
            if state.failed_launch.as_deref() == Some(session.as_str()) {
                state.failed_launch = None;
            }
        }
        (Action::SetupLog | Action::RunLog, Some("file")) => {
            if let Page::Log { text, scroll, .. } = &mut dialog.page {
                *text = Some(sanitize(event["text"].as_str().unwrap_or_default()));
                *scroll = 0;
            }
            if event["truncated"] == true {
                dialog.notice = Some(Notice::Info("Showing the first 64 KiB of the log.".into()));
            }
        }
        _ => {
            dialog.notice = Some(Notice::Info(
                "The host answered with an unexpected reply.".into(),
            ));
        }
    }
    state.due = true;
}

pub fn host_event(app: &mut App, event: &Value) -> bool {
    observe(app, event);
    journal_facts(app, event);
    let Some(request) = event["requestId"].as_str() else {
        return false;
    };
    let state = &mut app.worktrees;
    if state.listing.as_ref().is_some_and(|(id, _)| id == request) {
        registry_reply(app, event);
        return true;
    }
    if state
        .probe
        .as_ref()
        .and_then(|probe| probe.request.as_ref())
        .is_some_and(|(id, _)| id == request)
    {
        probe_reply(app, event);
        return true;
    }
    let Some(action) = state
        .dialog
        .as_mut()
        .and_then(|dialog| dialog.pending.take_if(|pending| pending.request == request))
        .map(|pending| pending.action)
    else {
        return false;
    };
    action_reply(app, event, action);
    true
}

pub fn tick(app: &mut App) -> Option<Value> {
    if !app.connected || !supported(app) {
        return None;
    }
    let state = &mut app.worktrees;
    if state
        .listing
        .as_ref()
        .is_some_and(|(_, sent)| sent.elapsed() > REGISTRY_TIMEOUT)
    {
        state.listing = None;
    }
    if state.listing.is_some() {
        return None;
    }
    let poll = state.records.iter().any(Record::busy)
        && state.polled.is_none_or(|at| at.elapsed() >= POLL_INTERVAL);
    if !state.due && !poll {
        return None;
    }
    state.due = false;
    state.polled = Some(Instant::now());
    let command = app.request(json!({"type":"listWorktrees"}));
    let id = command["requestId"].as_str().unwrap_or_default().to_owned();
    app.worktrees.listing = Some((id, Instant::now()));
    Some(command)
}

pub fn expire(app: &mut App) -> bool {
    let mut changed = false;
    if let Some(dialog) = &mut app.worktrees.dialog
        && dialog
            .pending
            .as_ref()
            .is_some_and(|pending| pending.sent.elapsed() > ACTION_TIMEOUT)
    {
        dialog.pending = None;
        dialog.notice = Some(Notice::Info(
            "The host did not answer; press r to refresh before retrying.".into(),
        ));
        changed = true;
    }
    if let Some(probe) = &mut app.worktrees.probe
        && probe
            .request
            .as_ref()
            .is_some_and(|(_, sent)| sent.elapsed() > PROBE_TIMEOUT)
    {
        probe.request = None;
        probe.check = SetupCheck::Failed("The host did not describe the setup in time.".into());
        changed = true;
    }
    changed
}

pub fn disconnect(app: &mut App) {
    let state = &mut app.worktrees;
    state.listing = None;
    state.loaded = false;
    state.probe = None;
    state.known.clear();
    if let Some(dialog) = &mut state.dialog
        && dialog.pending.take().is_some()
    {
        dialog.notice = Some(Notice::Info(
            "The connection dropped before the host answered; refresh before retrying.".into(),
        ));
    }
}

pub fn sync(app: &mut App) -> Vec<Value> {
    let wanted = match &app.dialog {
        Some(Dialog::NewSession(form)) if form.worktree && form.advanced => {
            let cwd = form.cwd.trim();
            Some(if cwd.is_empty() {
                app.capabilities
                    .as_ref()
                    .map(|caps| caps.workspace.clone())
                    .unwrap_or_default()
            } else {
                cwd.to_owned()
            })
        }
        _ => None,
    };
    let Some(directory) = wanted.filter(|directory| !directory.is_empty()) else {
        app.worktrees.probe = None;
        return Vec::new();
    };
    if !app.connected
        || !supported(app)
        || app
            .worktrees
            .probe
            .as_ref()
            .is_some_and(|probe| probe.directory == directory)
    {
        return Vec::new();
    }
    let command = app.request(json!({"type":"describeWorktreeSetup","directory":directory}));
    let id = command["requestId"].as_str().unwrap_or_default().to_owned();
    app.worktrees.probe = Some(Probe {
        directory,
        check: SetupCheck::Checking,
        request: Some((id, Instant::now())),
    });
    vec![command]
}

pub fn open(app: &mut App) {
    if !app.connected {
        app.notice = "Reconnect to the host before managing worktrees.".into();
        return;
    }
    if !supported(app) {
        app.notice = "Update the host to manage worktrees.".into();
        return;
    }
    let selected = app.review_candidate().map(|session| session.id.clone());
    let state = &app.worktrees;
    let target = match selected {
        Some(id) if state.record(&id).is_some() => Some(id),
        selected => state.failed_launch.clone().or(selected),
    };
    let Some(target) = target else {
        app.notice = "Select a session to manage its worktree.".into();
        return;
    };
    app.notice.clear();
    app.worktrees.dialog = Some(Actions::new(target));
    app.worktrees.due = true;
}

pub fn event(app: &mut App, event: Event) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key_event(app, key, &mut outcome),
        Event::Paste(text) => {
            if let Some(Actions {
                page: Page::Confirm { typed, mismatch },
                ..
            }) = &mut app.worktrees.dialog
            {
                let room = CONFIRM_LIMIT.saturating_sub(typed.chars().count());
                typed.extend(text.chars().filter(|c| !c.is_control()).take(room));
                *mismatch = false;
            }
        }
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
    let Some(dialog) = app.worktrees.dialog.as_mut() else {
        return;
    };
    match &mut dialog.page {
        Page::Menu => menu_key(app, key, outcome),
        Page::Confirm { typed, mismatch } => match key.code {
            KeyCode::Esc => dialog.page = Page::Menu,
            KeyCode::Backspace => {
                typed.pop();
                *mismatch = false;
            }
            KeyCode::Enter => confirm_discard(app, outcome),
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::ALT) => {
                if typed.chars().count() < CONFIRM_LIMIT {
                    typed.push(c);
                }
                *mismatch = false;
            }
            _ => outcome.redraw = false,
        },
        Page::Log { scroll, text, .. } => {
            let lines = text.as_deref().map_or(0, |text| text.lines().count());
            match key.code {
                KeyCode::Esc => dialog.page = Page::Menu,
                KeyCode::Up | KeyCode::Char('k') => *scroll = (*scroll + 1).min(lines),
                KeyCode::Down | KeyCode::Char('j') => *scroll = scroll.saturating_sub(1),
                KeyCode::PageUp => *scroll = (*scroll + LOG_PAGE).min(lines),
                KeyCode::PageDown => *scroll = scroll.saturating_sub(LOG_PAGE),
                KeyCode::Char('r') => reload_log(app, outcome),
                _ => outcome.redraw = false,
            }
        }
    }
}

fn menu_key(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    let Some(dialog) = app.worktrees.dialog.as_mut() else {
        return;
    };
    let rows = Action::ALL.len();
    match key.code {
        KeyCode::Esc => {
            app.worktrees.dialog = None;
        }
        KeyCode::Up | KeyCode::BackTab | KeyCode::Char('k') => {
            dialog.selected = (dialog.selected + rows - 1) % rows;
        }
        KeyCode::Down | KeyCode::Tab | KeyCode::Char('j') => {
            dialog.selected = (dialog.selected + 1) % rows;
        }
        KeyCode::Char('r') => {
            app.worktrees.due = true;
            dialog.notice = Some(Notice::Info("Refreshing the worktree registry…".into()));
        }
        KeyCode::Char(c @ '1'..='6') => {
            dialog.selected = c as usize - '1' as usize;
            choose(app, outcome);
        }
        KeyCode::Enter => choose(app, outcome),
        _ => outcome.redraw = false,
    }
}

fn send(app: &mut App, action: Action, command: Value, outcome: &mut Outcome) {
    let command = app.request(command);
    let request = command["requestId"].as_str().unwrap_or_default().to_owned();
    if let Some(dialog) = &mut app.worktrees.dialog {
        dialog.pending = Some(Pending {
            request,
            action,
            sent: Instant::now(),
        });
    }
    outcome.commands.push(command);
}

fn choose(app: &mut App, outcome: &mut Outcome) {
    let Some(dialog) = app.worktrees.dialog.as_ref() else {
        return;
    };
    let action = Action::ALL[dialog.selected.min(Action::ALL.len() - 1)];
    let session = dialog.session_id.clone();
    let waiting = dialog.waiting();
    let record = app.worktrees.record(&session).cloned();
    let Some(dialog) = app.worktrees.dialog.as_mut() else {
        return;
    };
    if waiting {
        dialog.notice = Some(Notice::Info(
            "Waiting for the host to answer the previous action.".into(),
        ));
        return;
    }
    if let Err(reason) = action.availability(record.as_ref()) {
        dialog.notice = Some(Notice::Info(format!("{}: {reason}.", action.label())));
        return;
    }
    dialog.notice = None;
    match action {
        Action::Run => send(
            app,
            action,
            json!({"type":"runWorktree","sessionId":session}),
            outcome,
        ),
        Action::Cancel => send(
            app,
            action,
            json!({"type":"cancelWorktree","sessionId":session}),
            outcome,
        ),
        Action::Archive => send(
            app,
            action,
            json!({"type":"archiveWorktree","sessionId":session,"discard":false}),
            outcome,
        ),
        Action::Discard => {
            dialog.page = Page::Confirm {
                typed: String::new(),
                mismatch: false,
            }
        }
        Action::SetupLog | Action::RunLog => {
            let Some(path) = record.as_ref().and_then(|record| action.log_path(record)) else {
                return;
            };
            dialog.page = Page::Log {
                action,
                path,
                text: None,
                scroll: 0,
            };
            reload_log(app, outcome);
        }
    }
}

fn reload_log(app: &mut App, outcome: &mut Outcome) {
    let Some(dialog) = app.worktrees.dialog.as_mut() else {
        return;
    };
    if dialog.waiting() {
        return;
    }
    let Page::Log {
        action, path, text, ..
    } = &mut dialog.page
    else {
        return;
    };
    *text = None;
    let action = *action;
    let command = json!({"type":"readFile","path":path.clone(),"offset":0,"limit":LOG_LIMIT});
    send(app, action, command, outcome);
}

fn confirm_discard(app: &mut App, outcome: &mut Outcome) {
    let Some(dialog) = app.worktrees.dialog.as_ref() else {
        return;
    };
    let session = dialog.session_id.clone();
    let Some(expected) = app.worktrees.record(&session).map(Record::confirmation) else {
        return;
    };
    let Some(dialog) = app.worktrees.dialog.as_mut() else {
        return;
    };
    let Page::Confirm { typed, mismatch } = &mut dialog.page else {
        return;
    };
    if typed.trim() != expected {
        *mismatch = true;
        return;
    }
    if dialog.pending.is_some() {
        return;
    }
    send(
        app,
        Action::Discard,
        json!({"type":"archiveWorktree","sessionId":session,"discard":true}),
        outcome,
    );
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ratatui::layout::Rect;

    pub(crate) fn record(setup: &str, run: Option<&str>) -> Value {
        json!({
            "sessionId":"s1","worktree":"C:/Projects/nesvo-nesvo-0123456789abcdef",
            "branch":"nesvo/0123456789abcdef","repository":"C:/Projects/nesvo","createdAt":1,
            "digest":"d1","setup":{"state":setup,"log":"C:/Projects/nesvo-nesvo-0123456789abcdef/.nesvo/setup.log","startedAt":1,"finishedAt":2},
            "run":run.map(|state| json!({"state":state,"log":"C:/Projects/nesvo-nesvo-0123456789abcdef/.nesvo/run.log","startedAt":3,"finishedAt":null})),
            "envFiles":[],"archivedAt":null,"discarded":false,"present":true,"sessionLive":true,
            "active":run == Some("running")
        })
    }

    pub(crate) fn app() -> App {
        let mut app = App::new(9);
        app.event(
            json!({"type":"capabilities","workspace":"C:/Projects/nesvo","worktrees":true,
            "advancedLaunch":true,"programs":[{"id":"claude","available":true}]}),
        )
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s1","name":"Feature work","cwd":"C:/Projects/nesvo-nesvo-0123456789abcdef","program":"claude","cols":100,"rows":40,"running":true,"groupId":null,"controllerId":null,"uptimeSeconds":720,"status":{"state":"idle","source":"hook","updatedAt":1}}
        ]}))
        .unwrap();
        app.panes[0] = Some("s1".into());
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app
    }

    pub(crate) fn load(app: &mut App, records: Vec<Value>) {
        let command = tick(app).expect("registry request");
        assert_eq!(command["type"], "listWorktrees");
        assert!(
            app.event(json!({"type":"worktreeRegistry","requestId":command["requestId"],"worktrees":records}))
                .unwrap()
                .is_empty()
        );
        assert!(app.worktrees.loaded);
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Value> {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 32),
        )
        .commands
    }

    fn reply(app: &mut App, command: &Value, mut event: Value) -> Vec<Value> {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap()
    }

    fn notice(app: &App) -> Option<Notice> {
        app.worktrees
            .dialog
            .as_ref()
            .and_then(|dialog| dialog.notice.clone())
    }

    fn stage(setup: &str, run: Option<&str>) -> Stage {
        serde_json::from_value::<Record>(record(setup, run))
            .unwrap()
            .stage()
    }

    #[test]
    fn worktree_stage_follows_setup_then_run_then_archive() {
        assert_eq!(stage("running", None), Stage::SetupRunning);
        assert_eq!(stage("passed", None), Stage::SetupPassed);
        assert_eq!(stage("notConfigured", None), Stage::NoSetup);
        assert_eq!(stage("failed", None), Stage::SetupFailed);
        assert_eq!(stage("timedOut", None), Stage::SetupTimedOut);
        assert_eq!(stage("cancelled", None), Stage::SetupCancelled);
        assert_eq!(stage("failed", Some("running")), Stage::SetupFailed);
        assert_eq!(stage("passed", Some("running")), Stage::RunRunning);
        assert_eq!(stage("passed", Some("passed")), Stage::RunPassed);
        assert_eq!(stage("passed", Some("failed")), Stage::RunFailed);
        assert_eq!(stage("notConfigured", Some("timedOut")), Stage::RunTimedOut);
        assert_eq!(stage("passed", Some("cancelled")), Stage::RunCancelled);
        assert_eq!(stage("mystery", None), Stage::Unknown);
        let mut archived: Record = serde_json::from_value(record("passed", None)).unwrap();
        archived.archived_at = Some(5);
        assert_eq!(archived.stage(), Stage::Archived);
        for stage in [
            Stage::SetupRunning,
            Stage::SetupFailed,
            Stage::RunRunning,
            Stage::Archived,
        ] {
            assert!(stage.short().chars().count() <= 6, "{stage:?}");
        }
        assert_eq!(Stage::SetupTimedOut.tone(), Tone::Danger);
        assert_eq!(Stage::RunRunning.tone(), Tone::Warning);
        let running: Record = serde_json::from_value(record("passed", Some("running"))).unwrap();
        assert!(running.busy());
        assert_eq!(
            Action::Run.availability(Some(&running)),
            Err("a step is already running")
        );
        assert_eq!(Action::Cancel.availability(Some(&running)), Ok(()));
        assert_eq!(running.confirmation(), "nesvo/0123456789abcdef");
        let failed: Record = serde_json::from_value(record("failed", None)).unwrap();
        assert_eq!(
            Action::Run.availability(Some(&failed)),
            Err("setup has not passed")
        );
        assert_eq!(
            Action::Cancel.availability(Some(&failed)),
            Err("nothing is running")
        );
        assert_eq!(Action::Archive.availability(Some(&failed)), Ok(()));
        assert_eq!(
            Action::RunLog.availability(Some(&failed)),
            Err("run steps have not started")
        );
        assert_eq!(
            Action::Archive.availability(Some(&archived)),
            Err("the worktree is archived")
        );
        assert!(Action::Run.availability(None).is_err());
    }

    #[test]
    fn worktree_registry_loads_on_capabilities_and_polls_only_while_steps_run() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::SetupPassed));
        assert!(tick(&mut app).is_none());
        app.worktrees.records[0] =
            serde_json::from_value(record("passed", Some("running"))).unwrap();
        assert!(tick(&mut app).is_none(), "polls wait for the interval");
        app.worktrees.polled = Some(Instant::now() - POLL_INTERVAL);
        let poll = tick(&mut app).expect("poll while a run is active");
        assert_eq!(poll["type"], "listWorktrees");
        assert!(tick(&mut app).is_none(), "one registry request at a time");
        reply(
            &mut app,
            &poll,
            json!({"type":"worktreeRegistry","worktrees":[record("passed", Some("failed"))]}),
        );
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::RunFailed));
        app.event(json!({"type":"sessions","revision":2,"groups":[],"sessions":[
            {"id":"s1","name":"Feature work","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"s2","name":"Other","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        assert_eq!(tick(&mut app).unwrap()["type"], "listWorktrees");
        app.event(journal_page(vec![journal_record(
            "worktree.ran",
            json!({"sessionId":"s1","result":"passed","log":"x"}),
        )]))
        .unwrap();
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::RunPassed));
    }

    fn journal_record(kind: &str, payload: Value) -> Value {
        json!({"sequence":7,"sessionId":"s1","kind":kind,"at":1,"payload":payload})
    }

    fn journal_page(events: Vec<Value>) -> Value {
        json!({"type":"events","events":events,"nextCursor":7,"headCursor":7,"floorCursor":0,
            "gap":false,"more":false,"subscribed":true,"health":{"observationDrops":0,"writeFailures":0}})
    }

    #[test]
    fn worktree_journal_pages_apply_setup_and_run_facts_and_ignore_other_kinds() {
        let mut app = app();
        load(&mut app, vec![record("running", None)]);
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::SetupRunning));
        app.worktrees.due = false;
        let ignored = journal_page(vec![
            journal_record("future.kind", json!({"sessionId":"s1","result":"failed"})),
            journal_record(
                "worktreePrepared",
                json!({"sessionId":"s1","result":"failed","log":"x"}),
            ),
            journal_record("worktree.archived", json!({"sessionId":"s1"})),
        ]);
        assert!(app.event(ignored).unwrap().is_empty());
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::SetupRunning));
        assert!(!app.worktrees.due);
        app.event(journal_page(vec![
            journal_record(
                "worktree.prepared",
                json!({"sessionId":"s1","result":"passed","log":"setup.log","worktree":"w","digest":"d1"}),
            ),
            journal_record(
                "worktree.ran",
                json!({"sessionId":"s1","result":"failed","log":"run.log"}),
            ),
        ]))
        .unwrap();
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::RunFailed));
        let record = app.worktrees.record("s1").unwrap();
        assert_eq!(record.setup.log.as_deref(), Some("setup.log"));
        assert_eq!(
            record.run.as_ref().and_then(|run| run.log.as_deref()),
            Some("run.log")
        );
        assert!(!record.active);
        assert!(app.worktrees.due, "polling reconciles after a journal fact");
    }

    #[test]
    fn worktree_actions_send_one_command_per_action_and_ignore_repeats() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        assert!(press(&mut app, KeyCode::Char('K')).is_empty());
        assert_eq!(app.worktrees.dialog.as_ref().unwrap().session_id, "s1");
        let refresh = tick(&mut app).unwrap();
        reply(
            &mut app,
            &refresh,
            json!({"type":"worktreeRegistry","worktrees":[record("passed", None)]}),
        );
        let run = press(&mut app, KeyCode::Enter);
        assert_eq!(run.len(), 1);
        assert_eq!(run[0]["type"], "runWorktree");
        assert_eq!(run[0]["sessionId"], "s1");
        assert!(
            press(&mut app, KeyCode::Enter).is_empty(),
            "no second send while waiting"
        );
        assert_eq!(
            notice(&app),
            Some(Notice::Info(
                "Waiting for the host to answer the previous action.".into()
            ))
        );
        reply(
            &mut app,
            &run[0],
            json!({"type":"worktreeRunStarted","sessionId":"s1","worktree":"w","log":"C:/w/.nesvo/run.log"}),
        );
        assert_eq!(
            app.worktrees.stage("s1"),
            Some(Stage::SetupPassed),
            "the run state comes from the registry, not the reply"
        );
        assert!(app.worktrees.due);
        load(&mut app, vec![record("passed", Some("running"))]);
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::RunRunning));
        assert!(press(&mut app, KeyCode::Enter).is_empty(), "run is busy");
        let cancel = press(&mut app, KeyCode::Char('2'));
        assert_eq!(
            cancel,
            [json!({"type":"cancelWorktree","sessionId":"s1","requestId":cancel[0]["requestId"]})]
        );
        reply(
            &mut app,
            &cancel[0],
            json!({"type":"worktreeCancelled","sessionId":"s1","cancelled":true}),
        );
        assert_eq!(
            notice(&app),
            Some(Notice::Info("Cancel sent; the step is terminating.".into()))
        );
        app.worktrees.records[0] =
            serde_json::from_value(record("passed", Some("cancelled"))).unwrap();
        let archive = press(&mut app, KeyCode::Char('3'));
        assert_eq!(archive[0]["type"], "archiveWorktree");
        assert_eq!(archive[0]["discard"], false);
        reply(
            &mut app,
            &archive[0],
            json!({"type":"worktreeArchived","sessionId":"s1","worktree":"w","branch":"nesvo/0123456789abcdef","discarded":false,"blockers":[],"branchDeleted":true}),
        );
        assert!(app.worktrees.records[0].archived_at.is_none());
        let mut archived = record("passed", Some("cancelled"));
        archived["archivedAt"] = 9.into();
        archived["present"] = false.into();
        load(&mut app, vec![archived]);
        assert_eq!(app.worktrees.stage("s1"), Some(Stage::Archived));
        assert!(
            press(&mut app, KeyCode::Char('3')).is_empty(),
            "archived worktrees refuse locally"
        );
        press(&mut app, KeyCode::Esc);
        assert!(app.worktrees.dialog.is_none());
        assert!(app.dialog.is_none(), "Esc closes only the worktree dialog");
    }

    #[test]
    fn worktree_archive_refusals_keep_the_hosts_blockers() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        open(&mut app);
        let archive = press(&mut app, KeyCode::Char('3'));
        reply(
            &mut app,
            &archive[0],
            json!({"type":"error","code":"worktree_unsaved",
            "message":"The worktree has unsaved work (dirty, unpushed); commit and push it, or pass discard explicitly"}),
        );
        let Some(Notice::Refused {
            code,
            blockers,
            hint,
            ..
        }) = notice(&app)
        else {
            panic!("refusal expected");
        };
        assert_eq!(code, "worktree_unsaved");
        assert_eq!(blockers, ["dirty", "unpushed"]);
        assert!(hint.contains("Discard and archive"));
        let again = press(&mut app, KeyCode::Enter);
        reply(
            &mut app,
            &again[0],
            json!({"type":"error","code":"session_running","message":"Close the session before archiving its worktree"}),
        );
        let Some(Notice::Refused {
            code,
            blockers,
            hint,
            ..
        }) = notice(&app)
        else {
            panic!("refusal expected");
        };
        assert_eq!(code, "session_running");
        assert!(blockers.is_empty());
        assert!(hint.starts_with("Close the session"));
        assert!(app.notice.is_empty(), "refusals stay in the dialog");
    }

    #[test]
    fn worktree_discard_requires_the_typed_branch_name() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        open(&mut app);
        assert!(press(&mut app, KeyCode::Char('4')).is_empty());
        assert!(matches!(
            app.worktrees.dialog.as_ref().unwrap().page,
            Page::Confirm { .. }
        ));
        for c in "nesvo/wrong".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        assert!(press(&mut app, KeyCode::Enter).is_empty());
        assert!(matches!(
            app.worktrees.dialog.as_ref().unwrap().page,
            Page::Confirm { mismatch: true, .. }
        ));
        for _ in 0.."wrong".len() {
            press(&mut app, KeyCode::Backspace);
        }
        crate::controller::event(
            &mut app,
            Event::Paste("0123456789abcdef".into()),
            Rect::new(0, 0, 100, 32),
        );
        let discard = press(&mut app, KeyCode::Enter);
        assert_eq!(discard.len(), 1);
        assert_eq!(discard[0]["type"], "archiveWorktree");
        assert_eq!(discard[0]["discard"], true);
        assert!(press(&mut app, KeyCode::Enter).is_empty());
        reply(
            &mut app,
            &discard[0],
            json!({"type":"worktreeArchived","sessionId":"s1","worktree":"w","branch":"nesvo/0123456789abcdef","discarded":true,"blockers":["dirty"],"branchDeleted":true}),
        );
        assert_eq!(app.worktrees.dialog.as_ref().unwrap().page, Page::Menu);
        assert!(!app.worktrees.records[0].discarded);
        assert!(app.worktrees.due);
    }

    #[test]
    fn worktree_setup_log_is_a_bounded_read_file() {
        let mut app = app();
        load(&mut app, vec![record("failed", None)]);
        open(&mut app);
        let read = press(&mut app, KeyCode::Char('5'));
        assert_eq!(
            read,
            [
                json!({"type":"readFile","path":"C:/Projects/nesvo-nesvo-0123456789abcdef/.nesvo/setup.log","offset":0,"limit":LOG_LIMIT,"requestId":read[0]["requestId"]})
            ]
        );
        reply(
            &mut app,
            &read[0],
            json!({"type":"file","path":"p","size":20,"offset":0,"length":20,"text":"$ npm ci\r\n\u{1b}[31mfailed\tnow\n","truncated":false,"encoding":"utf8"}),
        );
        let Page::Log { text, .. } = &app.worktrees.dialog.as_ref().unwrap().page else {
            panic!("log page expected");
        };
        assert_eq!(text.as_deref(), Some("$ npm ci\n[31mfailed    now\n"));
        let reload = press(&mut app, KeyCode::Char('r'));
        assert_eq!(reload.len(), 1);
        reply(
            &mut app,
            &reload[0],
            json!({"type":"error","code":"busy","message":"Another file request is running"}),
        );
        assert!(matches!(notice(&app), Some(Notice::Refused { code, .. }) if code == "busy"));
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.worktrees.dialog.as_ref().unwrap().page, Page::Menu);
        assert!(
            press(&mut app, KeyCode::Char('6')).is_empty(),
            "no run log yet"
        );
        assert_eq!(
            notice(&app),
            Some(Notice::Info(
                "Open run log: run steps have not started.".into()
            ))
        );
    }

    #[test]
    fn worktree_launch_failure_targets_the_reserved_session() {
        let mut app = app();
        load(&mut app, vec![]);
        app.panes[0] = None;
        app.event(json!({"type":"error","code":"worktree_setup_failed","message":"Worktree setup failed; the agent was not started.","sessionId":"r1","requestId":"tui-9-77"}))
            .unwrap();
        assert_eq!(app.worktrees.failed_launch.as_deref(), Some("r1"));
        let refresh = tick(&mut app).unwrap();
        let mut failed = record("failed", None);
        failed["sessionId"] = "r1".into();
        failed["sessionLive"] = false.into();
        reply(
            &mut app,
            &refresh,
            json!({"type":"worktreeRegistry","worktrees":[failed]}),
        );
        press(&mut app, KeyCode::Char('K'));
        assert_eq!(app.worktrees.dialog.as_ref().unwrap().session_id, "r1");
    }

    #[test]
    fn worktree_form_probe_describes_setup_once_per_directory() {
        let mut app = app();
        press(&mut app, KeyCode::Char('n'));
        press(&mut app, KeyCode::F(2));
        assert!(app.worktrees.probe.is_none());
        let probe = press(&mut app, KeyCode::Char(' '));
        assert_eq!(
            probe,
            [
                json!({"type":"describeWorktreeSetup","directory":"C:/Projects/nesvo","requestId":probe[0]["requestId"]})
            ]
        );
        assert!(
            press(&mut app, KeyCode::Tab).is_empty(),
            "one probe per directory"
        );
        reply(
            &mut app,
            &probe[0],
            json!({"type":"worktreeSetup","repository":"C:/Projects/nesvo","configured":true,
            "config":{"setup":["npm ci"],"run":[],"envFiles":[],"timeoutS":600},"digest":"abc","approved":false,"policy":"platform-shell-v1"}),
        );
        assert_eq!(
            app.worktrees.probe.as_ref().unwrap().check,
            SetupCheck::Unapproved {
                digest: "abc".into()
            }
        );
        press(&mut app, KeyCode::BackTab);
        press(&mut app, KeyCode::Char(' '));
        assert!(app.worktrees.probe.is_none());
        let again = press(&mut app, KeyCode::Char(' '));
        reply(
            &mut app,
            &again[0],
            json!({"type":"error","code":"not_repository","message":"The folder is not a Git repository"}),
        );
        assert_eq!(
            app.worktrees.probe.as_ref().unwrap().check,
            SetupCheck::Failed("The folder is not a Git repository".into())
        );
        assert!(app.notice.is_empty());
    }

    #[test]
    fn worktree_disconnect_drops_the_pending_action_without_resending() {
        let mut app = app();
        load(&mut app, vec![record("passed", None)]);
        open(&mut app);
        let run = press(&mut app, KeyCode::Enter);
        assert_eq!(run.len(), 1);
        app.disconnect("Host closed".into());
        assert!(!app.worktrees.dialog.as_ref().unwrap().waiting());
        assert!(!app.worktrees.loaded);
        assert!(
            matches!(notice(&app), Some(Notice::Info(text)) if text.contains("refresh before retrying"))
        );
        assert!(
            tick(&mut app).is_none(),
            "nothing is sent while disconnected"
        );
    }

    #[test]
    fn worktree_dialog_needs_a_worktree_capable_host() {
        let mut app = app();
        app.event(json!({"type":"capabilities","workspace":"C:/Projects/nesvo","programs":[]}))
            .unwrap();
        press(&mut app, KeyCode::Char('K'));
        assert!(app.worktrees.dialog.is_none());
        assert_eq!(app.notice, "Update the host to manage worktrees.");
        assert!(tick(&mut app).is_none());
    }
}
