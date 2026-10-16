use anyhow::{Result, anyhow, ensure};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc as sync_mpsc},
    thread,
};
use tokio::sync::{mpsc, watch};

const MAX_SESSIONS: usize = 8;
const BACKLOG_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Command {
    Auth {
        #[serde(rename = "clientNonce")]
        client_nonce: String,
    },
    List,
    Create {
        name: String,
        cwd: Option<String>,
    },
    Attach {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Input {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    Resize {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

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
}

struct Session {
    info: SessionInfo,
    // Drop the input channel first: its worker closes the input pipe before
    // ConPTY's potentially blocking ClosePseudoConsole destructor runs.
    input: sync_mpsc::SyncSender<String>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    backlog: String,
    controller: Option<u64>,
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
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            sessions: HashMap::new(),
            clients: HashMap::new(),
        }
    }

    pub fn send(&self, client_id: u64, event: Value) {
        if let Some(client) = self.clients.get(&client_id) {
            if client.events.try_send(event).is_err() {
                let _ = client.cancelled.send(true);
            }
        }
    }

    pub fn list(&self) -> Value {
        let mut sessions: Vec<&SessionInfo> = self.sessions.values().map(|s| &s.info).collect();
        sessions.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        json!({"type":"sessions", "sessions":sessions})
    }

    fn broadcast_list(&self) {
        let list = self.list();
        for id in self.clients.keys() {
            self.send(*id, list.clone());
        }
    }

    pub fn release(&mut self, client_id: u64) {
        for session in self.sessions.values_mut() {
            if session.controller == Some(client_id) {
                session.controller = None;
            }
        }
    }

    pub fn disconnect(&mut self, client_id: u64) {
        self.release(client_id);
        self.clients.remove(&client_id);
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

    pub fn command(
        &mut self,
        client_id: u64,
        command: Command,
        pty_events: &mpsc::Sender<PtyEvent>,
    ) -> Result<()> {
        match command {
            Command::Auth { .. } => return Err(anyhow!("Already authenticated.")),
            Command::List => self.send(client_id, self.list()),
            Command::Create { name, cwd } => {
                ensure!(
                    !name.trim().is_empty()
                        && name.chars().count() <= 80
                        && !name.chars().any(char::is_control),
                    "Use a session name between 1 and 80 characters."
                );
                ensure!(
                    self.sessions.len() < MAX_SESSIONS,
                    "Maximum 8 sessions. Close an existing session first."
                );
                let cwd = self.working_directory(cwd)?;
                let session = spawn_session(name.trim(), &cwd, pty_events.clone())?;
                self.sessions.insert(session.info.id.clone(), session);
                self.broadcast_list();
            }
            Command::Attach {
                session_id,
                cols,
                rows,
            } => {
                let size = terminal_size(cols, rows)?;
                let session = self
                    .sessions
                    .get(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session.controller.is_none() || session.controller == Some(client_id),
                    "Another device is controlling this session. Disconnect it first."
                );
                self.release(client_id);
                let session = self.sessions.get_mut(&session_id).unwrap();
                if session.info.running {
                    session.master.resize(size)?;
                }
                session.info.cols = cols;
                session.info.rows = rows;
                session.controller = Some(client_id);
                let history = if session.has_been_attached {
                    replay_history(&session.backlog)
                } else {
                    session.backlog.clone()
                };
                session.has_been_attached = true;
                self.send(
                    client_id,
                    json!({"type":"attached", "sessionId":session_id}),
                );
                for data in output_chunks(&history) {
                    self.send(client_id, json!({"type":"output", "sessionId":session_id, "data":data, "replay":true}));
                }
            }
            Command::Input { session_id, data } => {
                ensure!(
                    data.len() <= 32 * 1024 && data.chars().count() <= 8192,
                    "Input exceeds the 8192 character limit."
                );
                let session = self
                    .sessions
                    .get(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session.controller == Some(client_id),
                    "Attach this session before sending input."
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
            } => {
                let size = terminal_size(cols, rows)?;
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session.controller == Some(client_id),
                    "Attach this session before resizing."
                );
                ensure!(session.info.running, "This shell has exited.");
                session.master.resize(size)?;
                session.info.cols = cols;
                session.info.rows = rows;
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
                // ConPTY destruction can wait for pipe I/O. Never hold shared
                // state or a Tokio worker while the native handle is released.
                thread::spawn(move || drop(removed));
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
        },
        master: pair.master,
        input: input_tx,
        killer,
        backlog: String::new(),
        controller: None,
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
                    let controller = session.controller;
                    if let Some(client_id) = controller {
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
                    let controller = session.controller;
                    if let Some(client_id) = controller {
                        state.send(
                            client_id,
                            json!({"type":"output", "sessionId":id, "data":data}),
                        );
                    }
                    state.broadcast_list();
                }
            }
            PtyEvent::InputError(id) => {
                if let Some(client_id) = state
                    .sessions
                    .get(&id)
                    .and_then(|session| session.controller)
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
    }
}
