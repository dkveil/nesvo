use crate::terminal::TerminalState;
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub running: bool,
    pub group_id: Option<String>,
    pub controller_id: Option<u64>,
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
    NewSession { group_id: Option<String> },
    NewGroup { parent_id: Option<String> },
    RenameSession { id: String },
    RenameGroup { id: String },
}

pub enum MoveTarget {
    Session(String),
    Group(String),
}

pub enum Dialog {
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
        command: Value,
    },
    Help,
}

pub struct App {
    pub client_id: u64,
    pub sessions: Vec<Session>,
    pub groups: Vec<Group>,
    pub revision: u64,
    pub terminals: HashMap<String, TerminalState>,
    pub leases: HashMap<String, String>,
    pub subscribed: HashSet<String>,
    pub collapsed: HashSet<String>,
    pub selected: usize,
    pub panes: [Option<String>; 2],
    pub split: bool,
    pub focused: usize,
    pub mode: Mode,
    pub dialog: Option<Dialog>,
    pub notice: String,
    pub connected: bool,
    request_counter: u64,
    pending_create: Option<String>,
    pending_selection: Option<String>,
}

impl App {
    pub fn new(client_id: u64) -> Self {
        Self {
            client_id,
            sessions: vec![],
            groups: vec![],
            revision: 0,
            terminals: HashMap::new(),
            leases: HashMap::new(),
            subscribed: HashSet::new(),
            collapsed: HashSet::new(),
            selected: 0,
            panes: [None, None],
            split: false,
            focused: 0,
            mode: Mode::Navigate,
            dialog: None,
            notice: "Enter: open a session · n: new session · ?: help".into(),
            connected: true,
            request_counter: 0,
            pending_create: None,
            pending_selection: None,
        }
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }
    pub fn active_id(&self) -> Option<&str> {
        self.panes[self.focused].as_deref()
    }
    pub fn active_session(&self) -> Option<&Session> {
        self.active_id().and_then(|id| self.session(id))
    }
    pub fn active_terminal(&self) -> Option<&TerminalState> {
        self.active_id().and_then(|id| self.terminals.get(id))
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

    pub fn tree(&self) -> Vec<TreeRow> {
        let mut rows = vec![TreeRow {
            kind: RowKind::Root,
            depth: 0,
            label: "All sessions".into(),
        }];
        self.append_children(None, 0, &mut rows, &mut HashSet::new());
        rows
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
        for session in self
            .sessions
            .iter()
            .filter(|s| s.group_id.as_deref() == parent)
        {
            rows.push(TreeRow {
                kind: RowKind::Session(session.id.clone()),
                depth: depth + 1,
                label: session.name.clone(),
            });
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
                depth: depth + 1,
                label: group.name.clone(),
            });
            if !self.collapsed.contains(&group.id) {
                self.append_children(Some(&group.id), depth + 1, rows, visited);
            }
        }
    }

    pub fn open_session(&mut self, id: &str) -> Vec<Value> {
        if self.session(id).is_none() {
            return vec![];
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

    pub fn event(&mut self, event: Value) -> Result<Vec<Value>> {
        let mut commands = Vec::new();
        match event["type"].as_str().unwrap_or_default() {
            "sessions" => {
                let selected = self.selected_row().map(|row| row.kind);
                self.sessions = serde_json::from_value(event["sessions"].clone())?;
                self.groups = serde_json::from_value(event["groups"].clone())?;
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
                for pane in &mut self.panes {
                    if pane
                        .as_ref()
                        .is_some_and(|id| !self.sessions.iter().any(|s| &s.id == id))
                    {
                        *pane = None;
                    }
                }
                if let Some(id) = self.pending_selection.take() {
                    commands.extend(self.open_session(&id));
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
            }
            "created" => {
                if self.pending_create.is_some()
                    && event["requestId"].as_str() == self.pending_create.as_deref()
                {
                    self.pending_selection = event["sessionId"].as_str().map(str::to_owned);
                    self.pending_create = None;
                    self.notice = "Session created. Press i to control it.".into();
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
                                self.notice = "Input mode · Ctrl+G returns to navigation".into();
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
                if event["requestId"].as_str() == self.pending_create.as_deref() {
                    self.pending_create = None;
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
        self.notice = message;
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

    pub fn request(&mut self, mut command: Value) -> Value {
        self.request_counter += 1;
        let id = format!("tui-{}-{}", self.client_id, self.request_counter);
        if command["type"] == "create" {
            self.pending_create = Some(id.clone());
        }
        command["requestId"] = id.into();
        command
    }

    pub fn submit_dialog(&mut self) -> Option<Value> {
        match self.dialog.take()? {
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
                    TextAction::NewSession { group_id } => {
                        json!({"type":"create","name":name,"groupId":group_id})
                    }
                    TextAction::NewGroup { parent_id } => {
                        json!({"type":"createGroup","name":name,"parentId":parent_id,"expectedRevision":self.revision})
                    }
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
            Dialog::Help => None,
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
            vec![0, 1, 2, 3]
        );
        assert_eq!(app.group_choices(Some("a")).len(), 1);
        app.collapsed.insert("a".into());
        assert_eq!(app.tree().len(), 2);
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
