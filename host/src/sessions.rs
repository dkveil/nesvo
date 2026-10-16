use crate::{groups::valid_name, protocol::Command, storage::MetadataStore};
use anyhow::{Result, anyhow, ensure};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc as sync_mpsc},
    thread,
};
use tokio::sync::{mpsc, watch};

const MAX_SESSIONS: usize = 8;
const BACKLOG_BYTES: usize = 128 * 1024;

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
    // Drop the input channel first: its worker closes the input pipe before
    // ConPTY's potentially blocking ClosePseudoConsole destructor runs.
    input: sync_mpsc::SyncSender<String>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    backlog: String,
    controller: Option<ControlLease>,
    subscribers: HashSet<u64>,
    has_been_attached: bool,
}

pub enum PtyEvent {
    Data(String, String),
    Exited(String, u32),
    InputError(String),
}

pub struct State {
    workspace: PathBuf,
    sessions: HashMap<String, Session>,
    pub clients: HashMap<u64, Client>,
    metadata: MetadataStore,
}

fn bounded_append(backlog: &mut String, data: &str) {
    backlog.push_str(data);
    if backlog.len() > BACKLOG_BYTES {
        let mut cut = backlog.len() - BACKLOG_BYTES;
        while !backlog.is_char_boundary(cut) {
            cut += 1;
        }
        backlog.drain(..cut);
    }
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

fn output_chunks(text: &str) -> impl Iterator<Item = &str> {
    let mut remaining = text;
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let mut length = remaining.len().min(4096);
        while !remaining.is_char_boundary(length) {
            length -= 1;
        }
        let (chunk, tail) = remaining.split_at(length);
        remaining = tail;
        Some(chunk)
    })
}

// Replaying a terminal query must not provoke a fresh response into the running
// shell. Preserve drawing escapes, but remove historical report requests.
fn replay_history(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let mut start = 0;
    while index + 1 < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        let mut end = index + 2;
        let remove = match bytes[index + 1] {
            b'Z' => true, // DECID device attributes.
            b'[' => {
                while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let final_byte = bytes[end];
                let body = &bytes[index + 2..end];
                end += 1;
                matches!(final_byte, b'n' | b'c' | b't')
                    || (final_byte == b'p' && body.ends_with(b"$"))
                    || (final_byte == b'u' && body.starts_with(b"?"))
            }
            b']' => {
                while end < bytes.len()
                    && bytes[end] != 7
                    && !(bytes[end] == 0x1b && bytes.get(end + 1) == Some(&b'\\'))
                {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let query = bytes[index + 2..end].windows(2).any(|part| part == b";?");
                end += if bytes[end] == 7 { 1 } else { 2 };
                query
            }
            b'P' => {
                while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let body = &bytes[index + 2..end];
                let query = bytes[end] == b'q' && (body.ends_with(b"$") || body.ends_with(b"+"));
                // DECRQSS ($q) and XTGETTCAP (+q) request replies. Preserve
                // drawing DCS strings such as sixel, including their payload.
                while end + 1 < bytes.len() && !(bytes[end] == 0x1b && bytes[end + 1] == b'\\') {
                    end += 1;
                }
                if end + 1 >= bytes.len() {
                    break;
                }
                end += 2;
                query
            }
            _ => false,
        };
        if remove {
            output.push_str(&text[start..index]);
            start = end;
        }
        index = end;
    }
    output.push_str(&text[start..]);
    output
}

impl State {
    pub fn new(workspace: PathBuf, metadata: MetadataStore) -> Self {
        Self {
            workspace,
            sessions: HashMap::new(),
            clients: HashMap::new(),
            metadata,
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

    fn working_directory(&self, cwd: Option<String>) -> Result<PathBuf> {
        let path = match cwd {
            Some(cwd) => self.workspace.join(cwd).canonicalize()?,
            None => self.workspace.clone(),
        };
        ensure!(
            path.starts_with(&self.workspace) && path.is_dir(),
            "Initial directory must be inside the configured workspace."
        );
        Ok(path)
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
            session.master.resize(size)?;
        }
        session.info.cols = cols;
        session.info.rows = rows;
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
        match command {
            Command::Auth { .. } => return Err(anyhow!("Already authenticated.")),
            Command::List => self.send(client_id, self.list()),
            Command::Create {
                name,
                cwd,
                group_id,
            } => {
                let name = valid_name(&name)?;
                self.valid_group(group_id.as_deref())?;
                ensure!(
                    self.sessions.len() < MAX_SESSIONS,
                    "Maximum 8 sessions. Close an existing session first."
                );
                let cwd = self.working_directory(cwd)?;
                let mut session = spawn_session(&name, &cwd, pty_events.clone())?;
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
                    .get(&session_id)
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
                session.input.try_send(data).map_err(|_| {
                    anyhow!("Terminal input queue is full or closed. Input was not sent.")
                })?;
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
                session.master.resize(size)?;
                session.info.cols = cols;
                session.info.rows = rows;
                self.broadcast_control(&session_id);
            }
            Command::Close { session_id } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                if session.info.running {
                    session.killer.kill()?;
                }
                let removed = self.sessions.remove(&session_id);
                thread::spawn(move || drop(removed));
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

    pub fn shutdown(&mut self) {
        for client in self.clients.values() {
            let _ = client.cancelled.send(true);
        }
        for session in self.sessions.values_mut() {
            if session.info.running {
                let _ = session.killer.kill();
            }
        }
        self.sessions.clear();
    }
}

fn spawn_session(name: &str, cwd: &Path, events: mpsc::Sender<PtyEvent>) -> Result<Session> {
    let pair = native_pty_system().openpty(terminal_size(80, 24)?)?;
    let shell = if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    };
    let mut command = CommandBuilder::new(shell);
    if cfg!(windows) {
        command.args(["-NoLogo", "-NoProfile"]);
    }
    command.cwd(crate::process::display_path(cwd));
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let killer = crate::process::killer(child.as_ref())?;
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let id = hex::encode(crate::wire::random::<16>());
    let (input_tx, input_rx) = sync_mpsc::sync_channel::<String>(16);
    let input_id = id.clone();
    let input_events = events.clone();
    thread::spawn(move || {
        while let Ok(data) = input_rx.recv() {
            if writer
                .write_all(data.as_bytes())
                .and_then(|_| writer.flush())
                .is_err()
            {
                let _ = input_events.blocking_send(PtyEvent::InputError(input_id));
                break;
            }
        }
    });
    let reader_id = id.clone();
    let reader_events = events.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(length) = reader.read(&mut buffer) {
            if length == 0 {
                break;
            }
            pending.extend_from_slice(&buffer[..length]);
            let (valid, keep) = match std::str::from_utf8(&pending) {
                Ok(text) => (text.to_owned(), 0),
                Err(error) if error.error_len().is_none() => (
                    String::from_utf8_lossy(&pending[..error.valid_up_to()]).into_owned(),
                    pending.len() - error.valid_up_to(),
                ),
                Err(_) => (String::from_utf8_lossy(&pending).into_owned(), 0),
            };
            if !valid.is_empty()
                && reader_events
                    .blocking_send(PtyEvent::Data(reader_id.clone(), valid))
                    .is_err()
            {
                break;
            }
            pending.drain(..pending.len() - keep);
        }
    });
    let wait_id = id.clone();
    thread::spawn(move || {
        let exit = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = events.blocking_send(PtyEvent::Exited(wait_id, exit));
    });
    Ok(Session {
        info: SessionInfo {
            id,
            name: name.into(),
            cwd: crate::process::display_path(cwd),
            created_at: chrono::Utc::now().to_rfc3339(),
            cols: 80,
            rows: 24,
            running: true,
            group_id: None,
        },
        master: pair.master,
        input: input_tx,
        killer,
        backlog: String::new(),
        controller: None,
        subscribers: HashSet::new(),
        has_been_attached: false,
    })
}

pub async fn dispatch_output(state: Arc<Mutex<State>>, mut events: mpsc::Receiver<PtyEvent>) {
    while let Some(event) = events.recv().await {
        let mut state = state.lock().unwrap();
        match event {
            PtyEvent::Data(id, data) => {
                if let Some(session) = state.sessions.get_mut(&id) {
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
                    let data = format!("\r\n[Process exited with code {code}]\r\n");
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
                    state.broadcast_list();
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
    #[test]
    fn eight_full_replays_fit_before_writer_runs_but_output_queue_stays_bounded() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata);
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
    fn backlog_and_chunks_preserve_utf8_and_stay_bounded() {
        let text = "zażółć 🦀 東京\n".repeat(20000);
        let mut backlog = String::new();
        bounded_append(&mut backlog, &text);
        assert!(backlog.len() <= BACKLOG_BYTES);
        assert!(text.ends_with(&backlog));
        assert_eq!(output_chunks(&backlog).collect::<String>(), backlog);
        assert!(output_chunks(&backlog).all(|chunk| chunk.len() <= 4096));
    }
    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(9, 24).is_err());
        assert!(terminal_size(80, 151).is_err());
    }
    #[test]
    fn replay_preserves_drawing_but_never_reissues_terminal_queries() {
        let history = "hello\x1b[31mred\x1b[6n\x1b[>0c\x1b[?1$p\x1b]10;?\x07world\x1b[0m";
        assert_eq!(replay_history(history), "hello\x1b[31mredworld\x1b[0m");
        assert_eq!(replay_history("zażółć 🦀\x1b[6n"), "zażółć 🦀");
        assert_eq!(
            replay_history("a\x1bP$qm\x1b\\b\x1bP+q544e\x1b\\c\x1bPqDRAW\x1b\\"),
            "abc\x1bPqDRAW\x1b\\"
        );
    }
}
