use crate::{
    command_scope,
    event_log::{self, DomainEvent, model},
    launchers::Program,
    process::display_path,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, ChildStdin, ChildStdout},
    sync::{Notify, oneshot, watch},
};

pub(crate) const UNAVAILABLE: &str = "mcp_pool_unavailable";

#[derive(Clone, Copy, Debug)]
pub(crate) struct Bounds {
    pub(crate) processes: usize,
    pub(crate) warm_per_key: usize,
    pub(crate) idle: Duration,
    pub(crate) connect: Duration,
    pub(crate) handshake: Duration,
    pub(crate) sessions: usize,
    pub(crate) arguments: usize,
    pub(crate) config_bytes: usize,
}

pub(crate) const BOUNDS: Bounds = Bounds {
    processes: 4,
    warm_per_key: 1,
    idle: Duration::from_secs(600),
    connect: Duration::from_secs(30),
    handshake: Duration::from_secs(2),
    sessions: 256,
    arguments: 64,
    config_bytes: 16 * 1024,
};

const INHERITED: [&str; 10] = [
    "PATH",
    "PATHEXT",
    "SystemDrive",
    "windir",
    "ComSpec",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
];
const CREDENTIAL_MARKERS: [&str; 7] = [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "CREDENTIAL",
    "API_KEY",
    "AUTH",
    "COOKIE",
];
const TEMP_PREFIX: &str = "nesvo-mcp-";
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Origin {
    pub(crate) repository: String,
    pub(crate) digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Spec {
    pub(crate) program: Program,
    pub(crate) server: String,
    pub(crate) command: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) root: PathBuf,
    pub(crate) origin: Option<Origin>,
}

impl Spec {
    pub(crate) fn harness(program: Program, root: &Path, context: &Path) -> Option<Self> {
        Some(Self {
            program,
            server: "nesvo".into(),
            command: crate::caller::runtime_client()?,
            args: vec!["mcp".into()],
            env: BTreeMap::from([("NESVO_AGENT_CONTEXT".to_owned(), display_path(context))]),
            root: root.to_owned(),
            origin: None,
        })
    }

    fn same_server(&self, other: &Self) -> bool {
        self.program == other.program && self.server == other.server && self.root == other.root
    }

    fn dedicated_reason(&self, bounds: &Bounds) -> Option<&'static str> {
        let names: Vec<String> = self
            .env
            .keys()
            .map(|key| key.to_ascii_uppercase())
            .collect();
        if names.iter().any(|name| name.starts_with("NESVO_")) {
            return Some("sessionCredential");
        }
        if names.iter().any(|name| {
            CREDENTIAL_MARKERS
                .iter()
                .any(|marker| name.contains(marker))
        }) {
            return Some("credentialEnvironment");
        }
        if !self.command.is_absolute() {
            return Some("relativeCommand");
        }
        if !self.root.is_absolute() {
            return Some("relativeRoot");
        }
        if self.server.is_empty()
            || self.server.len() > 64
            || !self
                .server
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        {
            return Some("invalidServer");
        }
        let bytes = self.args.iter().map(String::len).sum::<usize>()
            + self
                .env
                .iter()
                .map(|(key, value)| key.len() + value.len())
                .sum::<usize>();
        if self.args.len() > bounds.arguments
            || bytes > bounds.config_bytes
            || self
                .args
                .iter()
                .chain(self.env.keys())
                .chain(self.env.values())
                .any(|text| text.contains('\0'))
        {
            return Some("oversizedConfig");
        }
        None
    }

    fn digest(&self) -> Option<String> {
        let metadata = std::fs::metadata(&self.command)
            .ok()
            .filter(std::fs::Metadata::is_file)?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        let canonical = json!({
            "version":1,
            "program":self.program,
            "server":self.server,
            "command":display_path(&self.command),
            "commandBytes":metadata.len(),
            "commandModified":modified.to_string(),
            "args":self.args,
            "env":self.env,
            "root":display_path(&self.root),
        });
        let bytes = serde_json::to_vec(&canonical).ok()?;
        Some(hex::encode(
            ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref(),
        ))
    }
}

enum Slot {
    Warm {
        stdin: ChildStdin,
        stdout: ChildStdout,
    },
    Leased {
        session_id: String,
        cancel: Option<oneshot::Sender<&'static str>>,
    },
}

struct Entry {
    id: String,
    spec: Spec,
    digest: String,
    since: Instant,
    slot: Slot,
    process: Process,
}

impl Entry {
    fn warm(&self) -> bool {
        matches!(self.slot, Slot::Warm { .. })
    }
    fn serves(&self, spec: &Spec, digest: &str) -> bool {
        self.spec.program == spec.program && self.digest == digest && self.spec.root == spec.root
    }
    fn session(&self) -> Option<String> {
        match &self.slot {
            Slot::Leased { session_id, .. } => Some(session_id.clone()),
            Slot::Warm { .. } => None,
        }
    }
}

struct Attachment {
    session_id: String,
    server: String,
    program: Program,
    mode: &'static str,
    reason: Option<&'static str>,
    entry_id: Option<String>,
    origin: Option<Origin>,
}

type Key = (Program, String, PathBuf);

#[derive(Default)]
struct Inner {
    entries: Vec<Entry>,
    starting: Vec<Key>,
    sessions: VecDeque<Attachment>,
    closed: bool,
    reaping: bool,
}

pub(crate) struct Pool {
    bounds: Bounds,
    inner: Mutex<Inner>,
    changed: Arc<Notify>,
    revision: Revision,
    journal: OnceLock<event_log::Service>,
}

type Revision = Arc<watch::Sender<u64>>;

fn advance(revision: &Revision) {
    revision.send_modify(|value| *value = value.wrapping_add(1));
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.signal();
    }
}

impl Pool {
    pub(crate) fn configure(&self, journal: event_log::Service) {
        let _ = self.journal.set(journal);
    }

    pub(crate) fn new(bounds: Bounds) -> Arc<Self> {
        Arc::new(Self {
            bounds,
            inner: Mutex::new(Inner::default()),
            changed: Arc::new(Notify::new()),
            revision: Arc::new(watch::channel(0).0),
            journal: OnceLock::new(),
        })
    }

    fn signal(&self) {
        self.changed.notify_one();
        advance(&self.revision);
    }

    #[cfg(test)]
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    pub(crate) fn attach(self: &Arc<Self>, spec: &Spec, session_id: &str) -> Value {
        let outcome = self.resolve(spec, session_id);
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.retain(|attachment| {
            attachment.session_id != session_id || attachment.server != spec.server
        });
        if inner.sessions.len() >= self.bounds.sessions {
            inner.sessions.pop_front();
        }
        inner.sessions.push_back(Attachment {
            session_id: session_id.into(),
            server: spec.server.clone(),
            program: spec.program,
            mode: match outcome["mode"].as_str() {
                Some("pooled") => "pooled",
                Some("dedicated") => "dedicated",
                _ => "cold",
            },
            reason: outcome["reason"].as_str().and_then(known_reason),
            entry_id: outcome["entryId"].as_str().map(str::to_owned),
            origin: spec.origin.clone(),
        });
        drop(inner);
        advance(&self.revision);
        outcome
    }

    fn resolve(self: &Arc<Self>, spec: &Spec, session_id: &str) -> Value {
        if let Some(reason) = spec.dedicated_reason(&self.bounds) {
            return json!({"mode":"dedicated","reason":reason});
        }
        let Some(digest) = spec.digest() else {
            return cold("commandUnavailable");
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return cold("runtimeUnavailable");
        };
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return cold("closed");
        }
        self.reap_stale(&mut inner, spec, &digest);
        let Some(index) = inner
            .entries
            .iter()
            .position(|entry| entry.warm() && entry.serves(spec, &digest))
        else {
            return match self.prepare(&mut inner, spec, &digest, &runtime) {
                Ok(()) => cold("notPrepared"),
                Err(reason) => cold(reason),
            };
        };
        let Ok(endpoint) = endpoint::Endpoint::open() else {
            return cold("endpointUnavailable");
        };
        let token = crate::wire::random::<32>();
        let (cancel, cancelled) = oneshot::channel();
        let entry = &mut inner.entries[index];
        let previous = std::mem::replace(
            &mut entry.slot,
            Slot::Leased {
                session_id: session_id.into(),
                cancel: Some(cancel),
            },
        );
        let Slot::Warm { stdin, stdout } = previous else {
            entry.slot = previous;
            return cold("notPrepared");
        };
        entry.since = Instant::now();
        let id = entry.id.clone();
        let address = endpoint.address.clone();
        self.journal(
            Some(session_id.into()),
            DomainEvent::McpPoolAttached(model::McpPoolAttached {
                entry_id: id.clone(),
                server: spec.server.clone(),
                program: event_log::program(spec.program),
                digest: digest.clone(),
                root: display_path(&spec.root),
            }),
        );
        runtime.spawn(relay(
            self.clone(),
            id.clone(),
            endpoint,
            token,
            stdin,
            stdout,
            cancelled,
        ));
        let _ = self.prepare(&mut inner, spec, &digest, &runtime);
        json!({"mode":"pooled","entryId":id,"endpoint":address,"token":hex::encode(token)})
    }

    fn prepare(
        self: &Arc<Self>,
        inner: &mut Inner,
        spec: &Spec,
        digest: &str,
        runtime: &tokio::runtime::Handle,
    ) -> Result<(), &'static str> {
        let key = (spec.program, digest.to_owned(), spec.root.clone());
        let warm = inner
            .entries
            .iter()
            .filter(|entry| entry.warm() && entry.serves(spec, digest))
            .count()
            + inner
                .starting
                .iter()
                .filter(|starting| **starting == key)
                .count();
        if warm >= self.bounds.warm_per_key {
            return Ok(());
        }
        if inner.entries.len() + inner.starting.len() >= self.bounds.processes {
            return Err("boundReached");
        }
        inner.starting.push(key.clone());
        let pool = self.clone();
        let spec = spec.clone();
        let handle = runtime.clone();
        runtime.spawn_blocking(move || {
            let spawned = spawn(&spec, pool.revision.clone());
            pool.started(&key, spec, spawned, &handle);
        });
        Ok(())
    }

    fn started(
        self: &Arc<Self>,
        key: &Key,
        spec: Spec,
        spawned: Option<(Process, ChildStdin, ChildStdout)>,
        runtime: &tokio::runtime::Handle,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(index) = inner.starting.iter().position(|starting| starting == key) {
            inner.starting.remove(index);
        }
        let Some((process, stdin, stdout)) = spawned else {
            drop(inner);
            advance(&self.revision);
            return;
        };
        if inner.closed {
            drop(inner);
            process.retire();
            advance(&self.revision);
            return;
        }
        inner.entries.push(Entry {
            id: hex::encode(crate::wire::random::<16>()),
            spec,
            digest: key.1.clone(),
            since: Instant::now(),
            slot: Slot::Warm { stdin, stdout },
            process,
        });
        if !inner.reaping {
            inner.reaping = true;
            runtime.spawn(reap(Arc::downgrade(self), self.changed.clone()));
        }
        self.signal();
    }

    fn reap_stale(&self, inner: &mut Inner, spec: &Spec, digest: &str) {
        let mut index = 0;
        while index < inner.entries.len() {
            let entry = &mut inner.entries[index];
            let reason = if !entry.warm() {
                None
            } else if entry.process.exited() {
                Some("exited")
            } else if (entry.spec.same_server(spec) && entry.digest != digest)
                || entry.spec.digest().as_deref() != Some(entry.digest.as_str())
            {
                Some("digestChanged")
            } else {
                None
            };
            match reason {
                Some(reason) => {
                    let entry = inner.entries.remove(index);
                    self.reaped(entry, reason);
                }
                None => index += 1,
            }
        }
    }

    fn reap_idle(&self) -> Option<Option<Instant>> {
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            inner.reaping = false;
            return None;
        }
        let now = Instant::now();
        let mut next: Option<Instant> = None;
        let mut index = 0;
        while index < inner.entries.len() {
            let entry = &mut inner.entries[index];
            let deadline = entry.since + self.bounds.idle;
            let reason = if !entry.warm() {
                None
            } else if entry.process.exited() {
                Some("exited")
            } else if deadline <= now {
                Some("idle")
            } else {
                next = Some(next.map_or(deadline, |next| next.min(deadline)));
                None
            };
            match reason {
                Some(reason) => {
                    let entry = inner.entries.remove(index);
                    self.reaped(entry, reason);
                }
                None => index += 1,
            }
        }
        drop(inner);
        advance(&self.revision);
        Some(next)
    }

    fn reaped(&self, entry: Entry, reason: &'static str) {
        self.journal_reaped(&entry, reason);
        entry.process.retire();
    }

    fn journal_reaped(&self, entry: &Entry, reason: &'static str) {
        self.journal(
            None,
            DomainEvent::McpPoolReaped(model::McpPoolReaped {
                entry_id: entry.id.clone(),
                server: entry.spec.server.clone(),
                digest: entry.digest.clone(),
                reason: reason.into(),
            }),
        );
        if let Some(origin) = &entry.spec.origin {
            self.journal(
                None,
                DomainEvent::McpServerReaped(model::McpServerReaped {
                    entry_id: entry.id.clone(),
                    server: entry.spec.server.clone(),
                    repository: origin.repository.clone(),
                    digest: origin.digest.clone(),
                    reason: reason.into(),
                }),
            );
        }
    }

    pub(crate) fn revoke(&self, repository: &str, digest: &str) -> usize {
        let revoked: Vec<Entry> = {
            let mut inner = self.inner.lock().unwrap();
            let (revoked, kept) =
                std::mem::take(&mut inner.entries)
                    .into_iter()
                    .partition(|entry| {
                        entry.warm()
                            && entry.spec.origin.as_ref().is_some_and(|origin| {
                                origin.repository == repository && origin.digest == digest
                            })
                    });
            inner.entries = kept;
            revoked
        };
        let count = revoked.len();
        for entry in revoked {
            self.reaped(entry, "revoked");
        }
        self.signal();
        count
    }

    pub(crate) fn attachments(&self, repository: &str) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        inner
            .sessions
            .iter()
            .filter(|attachment| {
                attachment
                    .origin
                    .as_ref()
                    .is_some_and(|origin| origin.repository == repository)
            })
            .map(attachment_view)
            .collect()
    }

    fn finish(&self, id: &str, reason: &'static str) {
        let entry = {
            let mut inner = self.inner.lock().unwrap();
            let index = inner.entries.iter().position(|entry| entry.id == id);
            index.map(|index| inner.entries.remove(index))
        };
        if let Some(entry) = entry {
            self.released(entry, reason).retire();
        }
        self.signal();
    }

    fn released(&self, entry: Entry, reason: &'static str) -> Process {
        self.journal(
            entry.session(),
            DomainEvent::McpPoolReleased(model::McpPoolReleased {
                entry_id: entry.id.clone(),
                server: entry.spec.server.clone(),
                reason: reason.into(),
            }),
        );
        entry.process
    }

    pub(crate) fn release_session(&self, session_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        for attachment in &inner.sessions {
            if let Some(origin) = attachment.origin.as_ref()
                && attachment.session_id == session_id
            {
                self.journal(
                    Some(session_id.into()),
                    DomainEvent::McpServerReleased(model::McpServerReleased {
                        server: attachment.server.clone(),
                        repository: origin.repository.clone(),
                        reason: "sessionClosed".into(),
                    }),
                );
            }
        }
        inner
            .sessions
            .retain(|attachment| attachment.session_id != session_id);
        for entry in &mut inner.entries {
            if let Slot::Leased {
                session_id: owner,
                cancel,
            } = &mut entry.slot
                && owner == session_id
                && let Some(cancel) = cancel.take()
            {
                let _ = cancel.send("sessionClosed");
            }
        }
        drop(inner);
        advance(&self.revision);
    }

    pub(crate) async fn shutdown(&self) {
        let entries = {
            let mut inner = self.inner.lock().unwrap();
            inner.closed = true;
            std::mem::take(&mut inner.entries)
        };
        self.signal();
        let mut stopping = Vec::new();
        for entry in entries {
            let process = if entry.warm() {
                self.journal_reaped(&entry, "shutdown");
                entry.process
            } else {
                self.released(entry, "shutdown")
            };
            stopping.push(process.stop());
        }
        futures_util::future::join_all(stopping).await;
    }

    pub(crate) fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let now = Instant::now();
        let entries: Vec<Value> = inner
            .entries
            .iter()
            .map(|entry| {
                json!({
                    "entryId":entry.id,
                    "server":entry.spec.server,
                    "program":entry.spec.program,
                    "digest":entry.digest,
                    "root":display_path(&entry.spec.root),
                    "state":if entry.warm() {"warm"} else {"leased"},
                    "sessionId":entry.session(),
                    "ageMs":millis(now.duration_since(entry.since)),
                })
            })
            .collect();
        let warm = inner.entries.iter().filter(|entry| entry.warm()).count();
        let sessions: Vec<Value> = inner.sessions.iter().map(attachment_view).collect();
        json!({
            "type":"mcpPool",
            "available":!inner.closed,
            "bounds":{
                "processes":self.bounds.processes,
                "warmPerKey":self.bounds.warm_per_key,
                "idleMs":millis(self.bounds.idle),
                "connectMs":millis(self.bounds.connect),
                "sessions":self.bounds.sessions,
            },
            "processes":{"warm":warm,"leased":inner.entries.len() - warm},
            "entries":entries,
            "sessions":sessions,
        })
    }

    pub(crate) fn journal(&self, session_id: Option<String>, event: DomainEvent) {
        if let Some(log) = self.journal.get() {
            log.observe(event_log::Observation {
                session_id,
                at: crate::status::now_millis(),
                event,
            });
        }
    }
}

fn attachment_view(attachment: &Attachment) -> Value {
    json!({
        "sessionId":attachment.session_id,
        "server":attachment.server,
        "program":attachment.program,
        "mode":attachment.mode,
        "reason":attachment.reason,
        "entryId":attachment.entry_id,
        "repository":attachment.origin.as_ref().map(|origin| origin.repository.clone()),
    })
}

fn cold(reason: &'static str) -> Value {
    json!({"mode":"cold","code":UNAVAILABLE,"reason":reason})
}

fn known_reason(reason: &str) -> Option<&'static str> {
    [
        "sessionCredential",
        "credentialEnvironment",
        "relativeCommand",
        "relativeRoot",
        "invalidServer",
        "oversizedConfig",
        "commandUnavailable",
        "runtimeUnavailable",
        "closed",
        "notPrepared",
        "boundReached",
        "endpointUnavailable",
    ]
    .into_iter()
    .find(|known| *known == reason)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

async fn reap(pool: Weak<Pool>, changed: Arc<Notify>) {
    loop {
        let Some(next) = pool.upgrade().and_then(|pool| pool.reap_idle()) else {
            return;
        };
        match next {
            Some(deadline) => {
                tokio::select! {
                    _ = changed.notified() => {}
                    _ = tokio::time::sleep_until(deadline.into()) => {}
                }
            }
            None => changed.notified().await,
        }
    }
}

async fn relay(
    pool: Arc<Pool>,
    id: String,
    endpoint: endpoint::Endpoint,
    token: [u8; 32],
    stdin: ChildStdin,
    stdout: ChildStdout,
    cancelled: oneshot::Receiver<&'static str>,
) {
    let bounds = pool.bounds;
    let reason = tokio::select! {
        reason = cancelled => reason.unwrap_or("shutdown"),
        reason = serve(endpoint, token, stdin, stdout, bounds) => reason,
    };
    pool.finish(&id, reason);
}

async fn serve(
    endpoint: endpoint::Endpoint,
    token: [u8; 32],
    mut stdin: ChildStdin,
    mut stdout: ChildStdout,
    bounds: Bounds,
) -> &'static str {
    let Ok(Ok(stream)) = tokio::time::timeout(bounds.connect, endpoint.accept()).await else {
        return "connectTimeout";
    };
    let (mut read, mut write) = tokio::io::split(stream);
    let mut presented = [0u8; 65];
    if !matches!(
        tokio::time::timeout(bounds.handshake, read.read_exact(&mut presented)).await,
        Ok(Ok(_))
    ) || !presented_token(&presented, &token)
    {
        return "refused";
    }
    tokio::select! {
        _ = tokio::io::copy(&mut read, &mut stdin) => "disconnected",
        _ = tokio::io::copy(&mut stdout, &mut write) => "serverClosed",
    }
}

fn presented_token(presented: &[u8; 65], token: &[u8; 32]) -> bool {
    let expected = format!("{}\n", hex::encode(token));
    presented
        .iter()
        .zip(expected.as_bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

struct Process {
    child: Option<Child>,
    scope: command_scope::Scope,
    temp: PathBuf,
    revision: Revision,
}

impl Process {
    fn exited(&mut self) -> bool {
        self.child.as_mut().is_none_or(exited)
    }

    fn retire(self) {
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(self.stop());
            }
            Err(_) => drop(self),
        }
    }

    async fn stop(mut self) {
        let _ = self.scope.terminate();
        if let Some(mut child) = self.child.take() {
            let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
        }
        for _ in 0..10 {
            if remove_temp(&self.temp) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        advance(&self.revision);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = self.scope.terminate();
            drop(child);
            remove_temp(&self.temp);
            advance(&self.revision);
        }
    }
}

pub(crate) fn remove_temp(temp: &Path) -> bool {
    let owned = temp.parent() == Some(std::env::temp_dir().as_path())
        && temp
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(TEMP_PREFIX));
    !owned || !temp.exists() || std::fs::remove_dir_all(temp).is_ok()
}

#[cfg(windows)]
fn exited(child: &mut Child) -> bool {
    child.try_wait().map_or(true, |status| status.is_some())
}

#[cfg(unix)]
fn exited(child: &mut Child) -> bool {
    let Some(id) = child.id() else {
        return true;
    };
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            id as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result != 0 || info.si_signo == libc::SIGCHLD
}

pub(crate) fn private_temp() -> Option<PathBuf> {
    let temp = std::env::temp_dir().join(format!(
        "{TEMP_PREFIX}{}",
        hex::encode(crate::wire::random::<16>())
    ));
    std::fs::create_dir(&temp).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700)).is_err() {
            remove_temp(&temp);
            return None;
        }
    }
    Some(temp)
}

pub(crate) fn isolate(
    command: &mut tokio::process::Command,
    env: &BTreeMap<String, String>,
    temp: &Path,
) {
    command.env_clear();
    for name in INHERITED {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    if let Ok(root) = command_scope::system_root() {
        command.env("SystemRoot", root);
    }
    command
        .envs(env)
        .env("TEMP", temp)
        .env("TMP", temp)
        .env("TMPDIR", temp);
}

fn spawn(spec: &Spec, revision: Revision) -> Option<(Process, ChildStdin, ChildStdout)> {
    let temp = private_temp()?;
    let mut command = tokio::process::Command::new(&spec.command);
    command.args(&spec.args).current_dir(&spec.root);
    isolate(&mut command, &spec.env, &temp);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command_scope::configure(&mut command);
    let Ok(mut child) = command.spawn() else {
        remove_temp(&temp);
        return None;
    };
    let Ok(scope) = command_scope::Scope::enroll(&child) else {
        let _ = child.start_kill();
        remove_temp(&temp);
        return None;
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = scope.terminate();
        remove_temp(&temp);
        return None;
    };
    Some((
        Process {
            child: Some(child),
            scope,
            temp,
            revision,
        },
        stdin,
        stdout,
    ))
}

#[cfg(windows)]
mod endpoint {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub(super) struct Endpoint {
        pub(super) address: String,
        server: NamedPipeServer,
    }

    impl Endpoint {
        pub(super) fn open() -> std::io::Result<Self> {
            let address = format!(
                r"\\.\pipe\nesvo-mcp-{}",
                hex::encode(crate::wire::random::<16>())
            );
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(1)
                .create(&address)?;
            Ok(Self { address, server })
        }

        pub(super) async fn accept(self) -> std::io::Result<NamedPipeServer> {
            self.server.connect().await?;
            Ok(self.server)
        }
    }
}

#[cfg(unix)]
mod endpoint {
    use std::path::PathBuf;
    use tokio::net::{UnixListener, UnixStream};

    pub(super) struct Endpoint {
        pub(super) address: String,
        listener: UnixListener,
        directory: PathBuf,
    }

    impl Endpoint {
        pub(super) fn open() -> std::io::Result<Self> {
            use std::os::unix::fs::PermissionsExt;
            let directory = std::env::temp_dir().join(format!(
                "nesvo-mcp-relay-{}",
                hex::encode(crate::wire::random::<8>())
            ));
            std::fs::create_dir(&directory)?;
            let socket = directory.join("s");
            let bound =
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                    .and_then(|()| UnixListener::bind(&socket));
            match bound {
                Ok(listener) => Ok(Self {
                    address: socket.display().to_string(),
                    listener,
                    directory,
                }),
                Err(error) => {
                    let _ = std::fs::remove_dir(&directory);
                    Err(error)
                }
            }
        }

        pub(super) async fn accept(self) -> std::io::Result<UnixStream> {
            Ok(self.listener.accept().await?.0)
        }
    }

    impl Drop for Endpoint {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.directory.join("s"));
            let _ = std::fs::remove_dir(&self.directory);
        }
    }
}

static POOL: OnceLock<Arc<Pool>> = OnceLock::new();

pub(crate) fn global() -> &'static Arc<Pool> {
    POOL.get_or_init(|| Pool::new(BOUNDS))
}

pub(crate) fn configure(journal: event_log::Service) {
    global().configure(journal);
}

pub(crate) fn attach_harness(session_id: &str, program: Program, root: &Path, context: &Path) {
    if let Some(spec) = Spec::harness(program, root, context) {
        global().attach(&spec, session_id);
    }
}

pub(crate) fn revoke(repository: &str, digest: &str) -> usize {
    crate::mcp_servers::invalidate(repository, digest);
    global().revoke(repository, digest)
}

pub(crate) fn attachments(repository: &str) -> Vec<Value> {
    global().attachments(repository)
}

pub(crate) fn release_session(session_id: &str) {
    global().release_session(session_id);
    crate::mcp_servers::release(session_id);
}

pub(crate) fn status() -> Value {
    global().status()
}

pub(crate) async fn shutdown() {
    global().shutdown().await;
    crate::mcp_servers::release_all();
}

#[cfg(test)]
#[path = "mcp_pool_tests.rs"]
mod tests;
