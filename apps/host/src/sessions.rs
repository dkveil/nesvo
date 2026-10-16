pub use crate::pty::PtyEvent;
use crate::{
    groups::valid_name,
    launchers::{Launchers, Program, working_directory},
    protocol::Command,
    pty::Pty,
    replay::{bounded_append, output_chunks, replay_history},
    status::{StatusTracker, now_millis},
    storage::MetadataStore,
};
use anyhow::{Result, anyhow, ensure};
use portable_pty::{CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const MAX_SESSIONS: usize = 8;

#[derive(Clone)]
pub struct Client {
    pub events: mpsc::Sender<Value>,
    pub cancelled: watch::Sender<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    name: String,
    cwd: String,
    created_at: String,
    cols: u16,
    rows: u16,
    running: bool,
    group_id: Option<String>,
    program: Program,
}

#[derive(Clone)]
struct ControlLease {
    client_id: u64,
    id: String,
    legacy: bool,
}

impl ControlLease {
    fn accepts(&self, client_id: u64, lease_id: Option<&str>) -> bool {
        self.client_id == client_id
            && match lease_id {
                Some(id) => id == self.id,
                None => self.legacy,
            }
    }
}

struct Session {
    info: SessionInfo,
    status: StatusTracker,
    pty: Pty,
    backlog: String,
    controller: Option<ControlLease>,
    subscribers: HashSet<u64>,
    has_been_attached: bool,
}

pub struct State {
    workspace: PathBuf,
    sessions: HashMap<String, Session>,
    cleanup_workers: Vec<thread::JoinHandle<()>>,
    shutting_down: bool,
    pub clients: HashMap<u64, Client>,
    metadata: MetadataStore,
    launchers: Launchers,
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize> {
    ensure!(
        (10..=300).contains(&cols) && (2..=150).contains(&rows),
        "Terminal size must be 10–300 columns and 2–150 rows."
    );
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl State {
    pub fn new(workspace: PathBuf, metadata: MetadataStore, launchers: Launchers) -> Self {
        Self {
            workspace,
            sessions: HashMap::new(),
            cleanup_workers: Vec::new(),
            shutting_down: false,
            clients: HashMap::new(),
            metadata,
            launchers,
        }
    }

    pub fn send(&self, client_id: u64, event: Value) {
        if let Some(client) = self.clients.get(&client_id)
            && client.events.try_send(event).is_err()
        {
            let _ = client.cancelled.send(true);
        }
    }

    fn respond(&self, client_id: u64, mut event: Value, request_id: Option<&str>) {
        if let Some(request_id) = request_id {
            event["requestId"] = request_id.into();
        }
        self.send(client_id, event);
    }

    pub fn list(&self) -> Value {
        let mut sessions: Vec<&Session> = self.sessions.values().collect();
        sessions.sort_by(|left, right| left.info.created_at.cmp(&right.info.created_at));
        let sessions: Vec<Value> = sessions
            .into_iter()
            .map(|session| {
                let mut info =
                    serde_json::to_value(&session.info).expect("Session metadata serializes");
                info["controllerId"] =
                    json!(session.controller.as_ref().map(|lease| lease.client_id));
                info["status"] = json!(session.status.status());
                info
            })
            .collect();
        json!({"type":"sessions", "sessions":sessions, "groups":self.metadata.groups(), "revision":self.metadata.revision()})
    }

    fn broadcast_list(&self) {
        let list = self.list();
        for id in self.clients.keys() {
            self.send(*id, list.clone());
        }
    }

    fn refresh_status(&mut self) {
        let now = now_millis();
        let mut changed = false;
        for session in self.sessions.values_mut() {
            changed |= session.status.refresh(now);
        }
        if changed {
            self.broadcast_list();
        }
    }

    fn control_event(&self, session_id: &str, recipient: u64) -> Option<Value> {
        self.sessions.get(session_id).map(|session| {
            let mut event = json!({"type":"control", "sessionId":session_id,
                "controllerId":session.controller.as_ref().map(|lease| lease.client_id),
                "cols":session.info.cols, "rows":session.info.rows});
            if let Some(lease) = &session.controller
                && lease.client_id == recipient
            {
                event["leaseId"] = lease.id.clone().into();
            }
            event
        })
    }

    fn broadcast_control(&self, session_id: &str) {
        for id in self.clients.keys() {
            if let Some(event) = self.control_event(session_id, *id) {
                self.send(*id, event);
            }
        }
    }

    fn release_all(&mut self, client_id: u64) {
        let mut changed = Vec::new();
        for session in self.sessions.values_mut() {
            if session
                .controller
                .as_ref()
                .is_some_and(|lease| lease.client_id == client_id)
            {
                session.controller = None;
                changed.push(session.info.id.clone());
            }
        }
        for session_id in changed {
            self.broadcast_control(&session_id);
        }
    }

    pub fn disconnect(&mut self, client_id: u64) {
        self.clients.remove(&client_id);
        for session in self.sessions.values_mut() {
            session.subscribers.remove(&client_id);
        }
        self.release_all(client_id);
    }

    fn valid_group(&self, group_id: Option<&str>) -> Result<()> {
        if let Some(id) = group_id {
            ensure!(self.metadata.contains(id), "Group does not exist.");
        }
        Ok(())
    }

    fn send_replay(&self, client_id: u64, session_id: &str, original: bool) {
        if let Some(session) = self.sessions.get(session_id) {
            self.send_history(client_id, session_id, &session.backlog, original);
        }
    }

    fn send_history(&self, client_id: u64, session_id: &str, backlog: &str, original: bool) {
        let filtered;
        let history = if original {
            backlog
        } else {
            filtered = replay_history(backlog);
            &filtered
        };
        for data in output_chunks(history) {
            let mut event =
                json!({"type":"output", "sessionId":session_id, "data":data, "replay":true});
            if original {
                event["allowResponses"] = true.into();
            }
            self.send(client_id, event);
        }
    }

    fn subscribe(&mut self, client_id: u64, session_id: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Session no longer exists."))?;
        session.subscribers.insert(client_id);
        let event = json!({"type":"subscribed", "sessionId":session_id, "cols":session.info.cols, "rows":session.info.rows});
        self.send(client_id, event);
        if let Some(event) = self.control_event(session_id, client_id) {
            self.send(client_id, event);
        }
        self.send_replay(client_id, session_id, false);
        Ok(())
    }

    fn acquire(
        &mut self,
        client_id: u64,
        session_id: &str,
        cols: u16,
        rows: u16,
        take_over: bool,
        legacy: bool,
    ) -> Result<()> {
        let size = terminal_size(cols, rows)?;
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session no longer exists."))?;
        ensure!(
            legacy || session.info.running,
            "This shell has exited. Open it as a viewer."
        );
        ensure!(
            take_over
                || session
                    .controller
                    .as_ref()
                    .is_none_or(|lease| lease.client_id == client_id),
            "Another device is controlling this session. Request takeover explicitly."
        );
        if legacy {
            self.release_all(client_id);
            for session in self.sessions.values_mut() {
                session.subscribers.remove(&client_id);
            }
        }
        let session = self.sessions.get_mut(session_id).unwrap();
        if session.info.running {
            session.pty.resize(size)?;
        }
        session.info.cols = cols;
        session.info.rows = rows;
        session.status.resize(rows, cols);
        session.subscribers.insert(client_id);
        session.controller = Some(ControlLease {
            client_id,
            id: hex::encode(crate::wire::random::<16>()),
            legacy,
        });
        let first_controller = !session.has_been_attached;
        session.has_been_attached = true;
        if legacy {
            self.send(
                client_id,
                json!({"type":"attached", "sessionId":session_id}),
            );
        } else if first_controller {
            // Subscription can observe startup queries before control is granted.
            // Reset/replay only the first controller after it receives its lease.
            self.send(
                client_id,
                json!({"type":"subscribed", "sessionId":session_id, "cols":cols, "rows":rows}),
            );
        }
        self.broadcast_control(session_id);
        if legacy || first_controller {
            self.send_replay(client_id, session_id, first_controller);
        }
        Ok(())
    }

    pub fn command(
        &mut self,
        client_id: u64,
        command: Command,
        request_id: Option<&str>,
        pty_events: &mpsc::Sender<PtyEvent>,
    ) -> Result<()> {
        ensure!(!self.shutting_down, "Host is shutting down.");
        match command {
            Command::Auth { .. } => return Err(anyhow!("Already authenticated.")),
            Command::List => self.send(client_id, self.list()),
            Command::GetCapabilities => self.respond(client_id, json!({"type":"capabilities", "workspace":crate::process::display_path(&self.workspace), "programs":self.launchers.capabilities()}), request_id),
            Command::Create {
                name,
                cwd,
                group_id,
                program,
            } => {
                let name = valid_name(&name)?;
                self.valid_group(group_id.as_deref())?;
                ensure!(
                    self.sessions.len() < MAX_SESSIONS,
                    "Maximum 8 sessions. Close an existing session first."
                );
                let cwd = working_directory(&self.workspace, cwd.as_deref())?;
                let command = self.launchers.command(program, &cwd)?;
                let mut session = spawn_session(&name, &cwd, program, command, pty_events.clone())?;
                session.info.group_id = group_id;
                let session_id = session.info.id.clone();
                self.sessions.insert(session_id.clone(), session);
                self.respond(
                    client_id,
                    json!({"type":"created", "sessionId":session_id}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::RenameSession { session_id, name } => {
                let name = valid_name(&name)?;
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                session.info.name = name;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::Attach {
                session_id,
                cols,
                rows,
            } => self.acquire(client_id, &session_id, cols, rows, false, true)?,
            Command::Subscribe { session_id } => self.subscribe(client_id, &session_id)?,
            Command::Unsubscribe { session_id } => {
                if let Some(session) = self.sessions.get_mut(&session_id) {
                    session.subscribers.remove(&client_id);
                }
                self.send(
                    client_id,
                    json!({"type":"unsubscribed", "sessionId":session_id}),
                );
            }
            Command::AcquireControl {
                session_id,
                cols,
                rows,
                take_over,
            } => self.acquire(client_id, &session_id, cols, rows, take_over, false)?,
            Command::ReleaseControl {
                session_id,
                lease_id,
            } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, Some(&lease_id))),
                    "Control lease is missing or stale."
                );
                session.controller = None;
                self.broadcast_control(&session_id);
            }
            Command::Input {
                session_id,
                data,
                lease_id,
            } => {
                ensure!(
                    data.len() <= 32 * 1024 && data.chars().count() <= 8192,
                    "Input exceeds the 8192 character limit."
                );
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, lease_id.as_deref())),
                    "Control lease is missing or stale. Acquire this session before sending input."
                );
                ensure!(
                    session.info.running,
                    "This shell has exited. Create a new session."
                );
                let has_input = !data.is_empty();
                session.pty.send_input(data)?;
                if has_input {
                    session.status.input(now_millis());
                }
            }
            Command::Resize {
                session_id,
                cols,
                rows,
                lease_id,
            } => {
                let size = terminal_size(cols, rows)?;
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, lease_id.as_deref())),
                    "Control lease is missing or stale. Acquire this session before resizing."
                );
                ensure!(session.info.running, "This shell has exited.");
                session.pty.resize(size)?;
                session.info.cols = cols;
                session.info.rows = rows;
                session.status.resize(rows, cols);
                self.broadcast_control(&session_id);
            }
            Command::Close { session_id } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                if session.info.running {
                    #[cfg(windows)]
                    if !session.has_been_attached {
                        session.pty.answer_unattached_cursor_query()?;
                    }
                    session.pty.kill()?;
                }
                let removed = self.sessions.remove(&session_id);
                self.cleanup_workers.retain(|worker| !worker.is_finished());
                self.cleanup_workers
                    .push(thread::spawn(move || drop(removed)));
                self.broadcast_list();
            }
            Command::CreateGroup {
                name,
                parent_id,
                order,
                expected_revision,
            } => {
                let id = self
                    .metadata
                    .create(&name, parent_id, order, expected_revision)?;
                self.respond(client_id, json!({"type":"groupCreated", "groupId":id, "revision":self.metadata.revision()}), request_id);
                self.broadcast_list();
            }
            Command::UpdateGroup {
                group_id,
                name,
                parent_id,
                order,
                expected_revision,
            } => {
                self.metadata
                    .update(&group_id, &name, parent_id, order, expected_revision)?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::DeleteGroup {
                group_id,
                expected_revision,
            } => {
                self.metadata.check_revision(expected_revision)?;
                ensure!(
                    !self
                        .sessions
                        .values()
                        .any(|session| session.info.group_id.as_deref() == Some(&group_id)),
                    "Group contains sessions. Move or close them first."
                );
                self.metadata.delete(&group_id, expected_revision)?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::MoveSession {
                session_id,
                group_id,
                expected_revision,
            } => {
                self.metadata.check_revision(expected_revision)?;
                self.valid_group(group_id.as_deref())?;
                ensure!(
                    self.sessions.contains_key(&session_id),
                    "Session no longer exists."
                );
                self.metadata.bump(expected_revision)?;
                self.sessions.get_mut(&session_id).unwrap().info.group_id = group_id;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
        }
        Ok(())
    }

    pub fn shutdown(&mut self) -> Vec<thread::JoinHandle<()>> {
        self.shutting_down = true;
        for client in self.clients.values() {
            let _ = client.cancelled.send(true);
        }
        for session in self.sessions.values_mut() {
            if session.info.running {
                #[cfg(windows)]
                if !session.has_been_attached {
                    let _ = session.pty.answer_unattached_cursor_query();
                }
                let _ = session.pty.kill();
            }
        }
        for (_, session) in self.sessions.drain() {
            self.cleanup_workers
                .push(thread::spawn(move || drop(session)));
        }
        std::mem::take(&mut self.cleanup_workers)
    }
}

fn spawn_session(
    name: &str,
    cwd: &Path,
    program: Program,
    command: CommandBuilder,
    events: mpsc::Sender<PtyEvent>,
) -> Result<Session> {
    let id = hex::encode(crate::wire::random::<16>());
    let pty = Pty::spawn(&id, command, terminal_size(80, 24)?, events)?;
    Ok(Session {
        status: StatusTracker::new(program, 24, 80, now_millis()),
        info: SessionInfo {
            id,
            name: name.into(),
            cwd: crate::process::display_path(cwd),
            created_at: chrono::Utc::now().to_rfc3339(),
            cols: 80,
            rows: 24,
            running: true,
            group_id: None,
            program,
        },
        pty,
        backlog: String::new(),
        controller: None,
        subscribers: HashSet::new(),
        has_been_attached: false,
    })
}

pub async fn dispatch_output(state: Arc<Mutex<State>>, mut events: mpsc::Receiver<PtyEvent>) {
    let mut status_tick = tokio::time::interval(Duration::from_millis(250));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let event = tokio::select! {
            event = events.recv() => match event { Some(event) => event, None => break },
            _ = status_tick.tick() => {
                state.lock().unwrap().refresh_status();
                continue;
            }
        };
        let mut state = state.lock().unwrap();
        match event {
            PtyEvent::Data(id, data) => {
                if let Some(session) = state.sessions.get_mut(&id) {
                    session.status.output(&data, now_millis());
                    bounded_append(&mut session.backlog, &data);
                    let subscribers: Vec<u64> = session.subscribers.iter().copied().collect();
                    for client_id in subscribers {
                        for chunk in output_chunks(&data) {
                            state.send(
                                client_id,
                                json!({"type":"output", "sessionId":id, "data":chunk}),
                            );
                        }
                    }
                }
            }
            PtyEvent::Exited(id, code) => {
                if let Some(session) = state.sessions.get_mut(&id) {
                    session.info.running = false;
                    session.status.exited(code);
                    let data = match code {
                        Some(code) => format!("\r\n[Process exited with code {code}]\r\n"),
                        None => "\r\n[Process ended without a readable exit status]\r\n".into(),
                    };
                    bounded_append(&mut session.backlog, &data);
                    let subscribers: Vec<u64> = session.subscribers.iter().copied().collect();
                    session.controller = None;
                    for client_id in subscribers {
                        state.send(
                            client_id,
                            json!({"type":"output", "sessionId":id, "data":data}),
                        );
                    }
                    state.broadcast_control(&id);
                    // The timer coalesces final state with other status changes.
                }
            }
            PtyEvent::InputError(id) => {
                if let Some(client_id) = state
                    .sessions
                    .get(&id)
                    .and_then(|session| session.controller.as_ref().map(|lease| lease.client_id))
                {
                    state.send(client_id, json!({"type":"error", "message":"The shell could not accept input. It may have exited."}));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::BACKLOG_BYTES;
    #[test]
    fn shutdown_rejects_new_commands() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        assert!(state.shutdown().is_empty());
        let (events, _) = mpsc::channel(1);
        let error = state.command(1, Command::List, None, &events).unwrap_err();
        assert_eq!(error.to_string(), "Host is shutting down.");
    }

    #[test]
    fn eight_full_replays_fit_before_writer_runs_but_output_queue_stays_bounded() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let (events, mut receiver) = mpsc::channel(crate::transport::CLIENT_EVENT_CAPACITY);
        let (cancelled, cancellation) = watch::channel(false);
        state.clients.insert(1, Client { events, cancelled });
        let history = "a".repeat(BACKLOG_BYTES);
        // Exercise the real replay chunking and queue overflow path without a
        // scheduler draining messages between subscriptions or any local PTYs.
        for index in 0..MAX_SESSIONS {
            let id = index.to_string();
            state.send(
                1,
                json!({"type":"subscribed", "sessionId":id, "cols":80, "rows":24}),
            );
            state.send(1, json!({"type":"control", "sessionId":id, "controllerId":null, "cols":80, "rows":24}));
            state.send_history(1, &id, &history, false);
        }
        assert!(!*cancellation.borrow());
        let mut restored_bytes = 0;
        while let Ok(event) = receiver.try_recv() {
            if let Some(data) = event["data"].as_str() {
                assert_eq!(event["replay"], true);
                restored_bytes += data.len();
            }
        }
        assert_eq!(restored_bytes, MAX_SESSIONS * BACKLOG_BYTES);
        for _ in 0..=crate::transport::CLIENT_EVENT_CAPACITY {
            state.send(1, json!({"type":"output", "sessionId":"0", "data":"x"}));
        }
        assert!(
            *cancellation.borrow(),
            "A stalled writer is still disconnected"
        );
    }
    #[test]
    fn v2_leases_reject_wrong_owner_missing_and_replaced_tokens() {
        let current = ControlLease {
            client_id: 7,
            id: "new-token".into(),
            legacy: false,
        };
        assert!(current.accepts(7, Some("new-token")));
        assert!(!current.accepts(7, None));
        assert!(!current.accepts(8, Some("new-token")));
        assert!(!current.accepts(7, Some("old-token")));
        let legacy = ControlLease {
            legacy: true,
            ..current
        };
        assert!(legacy.accepts(7, None));
        assert!(!legacy.accepts(7, Some("old-token")));
    }
    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(9, 24).is_err());
        assert!(terminal_size(80, 151).is_err());
    }
}
