use crate::{
    caller::Authority,
    command_scope, event_log, git,
    handle_paths::without_links,
    jobs::LaunchSpec,
    process::display_path,
    protocol::Command,
    registry_files::{self, Registry},
    sessions::State,
    status::now_millis,
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
};

pub const CONFIG_FILE: &str = "nesvo.toml";
pub(crate) const CONFIG_LIMIT: usize = 64 * 1024;
const FOREIGN_TABLES: [&str; 2] = ["workflow", "workflow.task"];
const LOG_LIMIT: usize = 64 * 1024;
const LOG_CONTENT_LIMIT: usize = LOG_LIMIT - 64;
const STEP_LIMIT: usize = 32;
const STEP_BYTES: usize = 4096;
const ENV_FILE_BYTES: u64 = 1024 * 1024;
pub(crate) const DEFAULT_TIMEOUT_S: u64 = 600;
const MAX_TIMEOUT_S: u64 = 3600;
const APPROVAL_LIMIT: usize = 256;
const RECORD_LIMIT: usize = 512;
const REGISTRY_PAGE: usize = 128;
const STORE_LIMIT: u64 = 4 * 1024 * 1024;
const STORE_FILE: &str = "worktrees.json";
const GIT_DEADLINE: Duration = Duration::from_secs(10);
const REMOVE_DEADLINE: Duration = Duration::from_secs(60);
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);
const POLICY: &str = "platform-shell-v1";
const STATE_DIR: &str = ".nesvo";
pub(crate) static SLOTS: Semaphore = Semaphore::const_new(4);
static STORE: OnceLock<Store> = OnceLock::new();

#[derive(Debug)]
pub(crate) struct Failure {
    pub code: &'static str,
    pub message: String,
    stage: Stage,
    log: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Plan,
    Create,
    Setup,
    Command,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}

impl Failure {
    fn raise(stage: Stage, code: &'static str, message: impl Into<String>) -> anyhow::Error {
        Self {
            code,
            message: message.into(),
            stage,
            log: None,
        }
        .into()
    }
    pub(crate) fn of(error: &anyhow::Error) -> Option<&Self> {
        error.downcast_ref::<Self>()
    }
    pub(crate) fn receipt(
        &self,
        session_id: &str,
        directory: Option<&str>,
    ) -> (&'static str, Value) {
        let message: String = self.message.chars().take(240).collect();
        match self.stage {
            Stage::Create => (
                "unknown",
                json!({"code":"worktree_unconfirmed","message":"Inspect the repository before creating another worktree"}),
            ),
            Stage::Setup => (
                "failed",
                json!({"code":self.code,"message":message,"log":self.log,"reservedSessionId":session_id,"directory":directory}),
            ),
            Stage::Plan | Stage::Command => (
                "failed",
                json!({"code":self.code,"message":message,"effectStarted":false}),
            ),
        }
    }
}

pub(crate) fn command_failure(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Failure::raise(Stage::Command, code, message)
}

pub(crate) fn error_code(error: &anyhow::Error) -> Option<&'static str> {
    Failure::of(error).map(|failure| failure.code).or_else(|| {
        error
            .downcast_ref::<crate::api_error::Error>()
            .map(|error| error.code)
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub setup: Vec<String>,
    pub run: Vec<String>,
    pub env_files: Vec<String>,
    pub timeout_s: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<crate::mcp_servers::Declaration>,
}

impl Config {
    fn is_empty(&self) -> bool {
        self.setup.is_empty() && self.run.is_empty() && self.env_files.is_empty()
    }
    pub fn digest(&self) -> String {
        let mut canonical = json!({"version":1,"policy":POLICY,"setup":self.setup,"run":self.run,"envFiles":self.env_files,"timeoutS":self.timeout_s});
        if !self.mcp_servers.is_empty() {
            canonical["mcpServers"] = json!(self.mcp_servers);
        }
        canonical_digest(&canonical)
    }
}

pub(crate) fn canonical_digest(canonical: &Value) -> String {
    hex::encode(
        ring::digest::digest(&ring::digest::SHA256, canonical.to_string().as_bytes()).as_ref(),
    )
}

pub(crate) enum Item {
    Integer(u64),
    List(Vec<String>),
    Text(String),
    Flag(bool),
}

pub(crate) struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Parser<'a> {
    pub(crate) fn document(text: &'a str) -> Result<Self> {
        if text.len() > CONFIG_LIMIT {
            return Err(anyhow!("{CONFIG_FILE} exceeds {CONFIG_LIMIT} bytes"));
        }
        Ok(Self {
            text: text.strip_prefix('\u{feff}').unwrap_or(text),
            at: 0,
        })
    }
    pub(crate) fn peek(&self) -> Option<char> {
        self.text[self.at..].chars().next()
    }
    pub(crate) fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.at += c.len_utf8();
        Some(c)
    }
    pub(crate) fn line(&self) -> usize {
        self.text[..self.at].matches('\n').count() + 1
    }
    pub(crate) fn error(&self, message: &str) -> anyhow::Error {
        anyhow!("{CONFIG_FILE} line {}: {message}", self.line())
    }
    pub(crate) fn header(&mut self) -> Result<(bool, String)> {
        self.expect('[')?;
        let array = self.peek() == Some('[');
        if array {
            self.bump();
        }
        self.blank();
        let mut name = self.key()?.to_owned();
        while self.peek() == Some('.') {
            self.bump();
            name.push('.');
            name.push_str(self.key()?);
        }
        self.blank();
        self.expect(']')?;
        if array {
            self.expect(']')?;
        }
        self.line_end()?;
        Ok((array, name))
    }
    pub(crate) fn entry(&mut self) -> Result<(&'a str, Item)> {
        let key = self.key()?;
        self.blank();
        self.expect('=')?;
        self.blank();
        let value = self.value()?;
        self.line_end()?;
        Ok((key, value))
    }
    fn expect(&mut self, wanted: char) -> Result<()> {
        if self.bump() == Some(wanted) {
            Ok(())
        } else {
            Err(self.error(&format!("expected '{wanted}'")))
        }
    }
    fn blank(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
    }
    fn comment(&mut self) -> Result<()> {
        if self.peek() != Some('#') {
            return Ok(());
        }
        while let Some(c) = self.peek() {
            if c == '\n' || c == '\r' {
                break;
            }
            if c.is_control() && c != '\t' {
                return Err(self.error("control characters are not allowed in comments"));
            }
            self.bump();
        }
        Ok(())
    }
    fn newline(&mut self) -> Result<bool> {
        match self.peek() {
            Some('\n') => {
                self.bump();
                Ok(true)
            }
            Some('\r') => {
                self.bump();
                self.expect('\n')?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    pub(crate) fn trivia(&mut self) -> Result<()> {
        loop {
            self.blank();
            self.comment()?;
            if !self.newline()? {
                return Ok(());
            }
        }
    }
    fn line_end(&mut self) -> Result<()> {
        self.blank();
        self.comment()?;
        if self.peek().is_none() || self.newline()? {
            Ok(())
        } else {
            Err(self.error("expected the end of the line"))
        }
    }
    fn key(&mut self) -> Result<&'a str> {
        let start = self.at;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            self.bump();
        }
        if start == self.at {
            return Err(self.error("expected a bare key"));
        }
        Ok(&self.text[start..self.at])
    }
    fn hex(&mut self, digits: usize) -> Result<char> {
        let mut value = 0u32;
        for _ in 0..digits {
            let digit = self
                .bump()
                .and_then(|c| c.to_digit(16))
                .ok_or_else(|| self.error("invalid unicode escape"))?;
            value = value * 16 + digit;
        }
        char::from_u32(value).ok_or_else(|| self.error("invalid unicode scalar"))
    }
    fn string(&mut self) -> Result<String> {
        let quote = self.bump().ok_or_else(|| self.error("expected a string"))?;
        if self.text[self.at..].starts_with(quote) && self.text[self.at + 1..].starts_with(quote) {
            return Err(self.error("multi-line strings are not supported"));
        }
        let mut value = String::new();
        loop {
            let c = self
                .bump()
                .ok_or_else(|| self.error("unterminated string"))?;
            match c {
                c if c == quote => return Ok(value),
                '\\' if quote == '"' => {
                    let escaped = self
                        .bump()
                        .ok_or_else(|| self.error("unterminated escape"))?;
                    value.push(match escaped {
                        'b' => '\u{8}',
                        't' => '\t',
                        'n' => '\n',
                        'f' => '\u{c}',
                        'r' => '\r',
                        '"' => '"',
                        '\\' => '\\',
                        'u' => self.hex(4)?,
                        'U' => self.hex(8)?,
                        _ => return Err(self.error("unsupported escape sequence")),
                    });
                }
                c if c.is_control() && c != '\t' => {
                    return Err(self.error("control characters are not allowed in strings"));
                }
                c => value.push(c),
            }
        }
    }
    fn integer(&mut self) -> Result<u64> {
        let start = self.at;
        let mut previous_digit = false;
        while let Some(c) = self.peek() {
            match c {
                '0'..='9' => previous_digit = true,
                '_' if previous_digit => previous_digit = false,
                _ => break,
            }
            self.bump();
        }
        let digits: String = self.text[start..self.at]
            .chars()
            .filter(|c| *c != '_')
            .collect();
        if !previous_digit || (digits.len() > 1 && digits.starts_with('0')) {
            return Err(self.error("invalid integer"));
        }
        digits
            .parse()
            .map_err(|_| self.error("integer is out of range"))
    }
    fn list(&mut self) -> Result<Vec<String>> {
        self.expect('[')?;
        let mut items = Vec::new();
        loop {
            self.trivia()?;
            if self.peek() == Some(']') {
                self.bump();
                return Ok(items);
            }
            if !matches!(self.peek(), Some('"' | '\'')) {
                return Err(self.error("arrays may contain only strings"));
            }
            items.push(self.string()?);
            self.trivia()?;
            match self.bump() {
                Some(',') => {}
                Some(']') => return Ok(items),
                _ => return Err(self.error("expected ',' or ']' in an array")),
            }
        }
    }
    fn value(&mut self) -> Result<Item> {
        match self.peek() {
            Some('[') => self.list().map(Item::List),
            Some('0'..='9') => self.integer().map(Item::Integer),
            Some('"' | '\'') => self.string().map(Item::Text),
            Some('t' | 'f') => {
                let rest = &self.text[self.at..];
                let (flag, word) = if rest.starts_with("true") {
                    (true, "true")
                } else if rest.starts_with("false") {
                    (false, "false")
                } else {
                    return Err(self.error("expected a value"));
                };
                self.at += word.len();
                Ok(Item::Flag(flag))
            }
            _ => Err(self.error("expected a string, a boolean, an integer or an array of strings")),
        }
    }
}

pub(crate) fn valid_step(step: &str) -> bool {
    !step.trim().is_empty()
        && step.len() <= STEP_BYTES
        && !step.chars().any(|c| c.is_control() && c != '\t')
}

fn validate_steps(key: &str, steps: Vec<String>) -> Result<Vec<String>> {
    if steps.len() > STEP_LIMIT {
        return Err(anyhow!("{key} declares more than {STEP_LIMIT} steps"));
    }
    for step in &steps {
        if !valid_step(step) {
            return Err(anyhow!(
                "{key} steps must be nonempty single-line commands of at most {STEP_BYTES} bytes"
            ));
        }
    }
    Ok(steps)
}

fn validate_env_file(path: &str) -> bool {
    let components: Vec<&str> = path.split('/').collect();
    !path.is_empty()
        && path.len() <= 512
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':'))
        && components
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != "..")
        && !matches!(components[0], ".git" | STATE_DIR)
}

pub fn parse(text: &str) -> Result<Config> {
    let mut parser = Parser::document(text)?;
    let mut config = Config {
        timeout_s: DEFAULT_TIMEOUT_S,
        ..Config::default()
    };
    let mut in_table = false;
    let mut foreign = false;
    let mut seen_table = false;
    let mut keys = HashSet::new();
    let mut servers: Vec<crate::mcp_servers::Draft> = Vec::new();
    let mut in_server = false;
    loop {
        parser.trivia()?;
        match parser.peek() {
            None => break,
            Some('[') => {
                let (array, name) = parser.header()?;
                in_server = array && name == crate::mcp_servers::TABLE;
                if in_server {
                    if servers.len() == crate::mcp_servers::SERVER_LIMIT {
                        return Err(parser.error(&format!(
                            "at most {} [[{}]] entries are supported",
                            crate::mcp_servers::SERVER_LIMIT,
                            crate::mcp_servers::TABLE
                        )));
                    }
                    servers.push(crate::mcp_servers::Draft::default());
                    in_table = false;
                    foreign = false;
                    continue;
                }
                if array && FOREIGN_TABLES.contains(&name.as_str()) {
                    in_table = false;
                    foreign = true;
                    continue;
                }
                if array || name != "worktree" || seen_table {
                    return Err(parser.error("only one [worktree] table is defined"));
                }
                seen_table = true;
                in_table = true;
                foreign = false;
            }
            Some(_) if foreign => {
                parser.entry()?;
            }
            Some(_) if in_server => {
                let (key, value) = parser.entry()?;
                if let Some(draft) = servers.last_mut() {
                    draft
                        .assign(key, value)
                        .map_err(|message| parser.error(&message))?;
                }
            }
            Some(_) => {
                if !in_table {
                    return Err(parser.error("keys must be inside the [worktree] table"));
                }
                let (key, value) = parser.entry()?;
                if !keys.insert(key) {
                    return Err(parser.error(&format!("duplicate key {key}")));
                }
                match (key, value) {
                    ("setup", Item::List(steps)) => config.setup = validate_steps(key, steps)?,
                    ("run", Item::List(steps)) => config.run = validate_steps(key, steps)?,
                    ("env_files", Item::List(files)) => {
                        let mut unique = HashSet::new();
                        if files.len() > STEP_LIMIT
                            || !files
                                .iter()
                                .all(|file| validate_env_file(file) && unique.insert(file.clone()))
                        {
                            return Err(anyhow!(
                                "env_files must list at most {STEP_LIMIT} unique relative paths with forward slashes, outside .git and {STATE_DIR}"
                            ));
                        }
                        config.env_files = files;
                    }
                    ("timeout_s", Item::Integer(seconds)) => {
                        if !(1..=MAX_TIMEOUT_S).contains(&seconds) {
                            return Err(anyhow!("timeout_s must be between 1 and {MAX_TIMEOUT_S}"));
                        }
                        config.timeout_s = seconds;
                    }
                    ("setup" | "run" | "env_files" | "timeout_s", _) => {
                        return Err(parser.error(&format!("{key} has the wrong value type")));
                    }
                    _ => return Err(parser.error(&format!("unsupported key {key}"))),
                }
            }
        }
    }
    config.mcp_servers = crate::mcp_servers::finish(servers)?;
    Ok(config)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Approval {
    repository: String,
    digest: String,
    approved_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub state: String,
    pub log: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Copied {
    path: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub session_id: String,
    pub worktree: String,
    pub branch: Option<String>,
    pub repository: String,
    pub created_at: u64,
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) config: Option<Config>,
    pub setup: Phase,
    pub run: Option<Phase>,
    env_files: Vec<Copied>,
    pub archived_at: Option<u64>,
    pub discarded: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    approvals: Vec<Approval>,
    worktrees: Vec<Record>,
}

pub struct Store {
    registry: Registry<Document>,
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
}

fn registry_full(stage: Stage) -> anyhow::Error {
    Failure::raise(
        stage,
        "worktree_registry_full",
        format!(
            "The host tracks {RECORD_LIMIT} active worktrees; archive one before creating another"
        ),
    )
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        let mut registry = Registry::open(
            directory,
            STORE_FILE,
            "Worktree registry",
            STORE_LIMIT,
            || Document {
                version: 1,
                ..Document::default()
            },
            |document: &Document| document.version == 1,
        )?;
        registry.amend(|document| {
            for record in &mut document.worktrees {
                for phase in std::iter::once(&mut record.setup).chain(record.run.as_mut()) {
                    if phase.state == "running" {
                        phase.state = "interrupted".into();
                    }
                }
            }
        });
        Ok(Self {
            registry,
            active: Mutex::new(HashMap::new()),
        })
    }
    async fn update<T>(&self, change: impl FnOnce(&mut Document) -> Result<T>) -> Result<T> {
        self.registry.update_async(change).await
    }
    fn read<T>(&self, view: impl FnOnce(&Document) -> T) -> Result<T> {
        self.registry.read(view)
    }
    pub(crate) fn approved(&self, repository: &str, digest: &str) -> bool {
        self.read(|document| {
            document
                .approvals
                .iter()
                .any(|approval| approval.repository == repository && approval.digest == digest)
        })
        .unwrap_or(false)
    }
    async fn approve(&self, repository: &str, digest: &str) -> Result<u64> {
        self.update(|document| {
            if let Some(existing) = document
                .approvals
                .iter()
                .find(|approval| approval.repository == repository && approval.digest == digest)
            {
                return Ok(existing.approved_at);
            }
            let approved_at = now_millis();
            document.approvals.push(Approval {
                repository: repository.into(),
                digest: digest.into(),
                approved_at,
            });
            let excess = document.approvals.len().saturating_sub(APPROVAL_LIMIT);
            document.approvals.drain(..excess);
            Ok(approved_at)
        })
        .await
    }
    async fn revoke(&self, repository: &str, digest: &str) -> Result<bool> {
        self.update(|document| {
            let before = document.approvals.len();
            document
                .approvals
                .retain(|approval| approval.repository != repository || approval.digest != digest);
            Ok(document.approvals.len() != before)
        })
        .await
    }
    fn has_room(&self) -> bool {
        self.read(|document| {
            document.worktrees.len() < RECORD_LIMIT
                || document
                    .worktrees
                    .iter()
                    .any(|record| record.archived_at.is_some())
        })
        .unwrap_or(false)
    }
    async fn insert(&self, record: Record) -> Result<()> {
        self.update(|document| {
            if document.worktrees.len() >= RECORD_LIMIT {
                let index = document
                    .worktrees
                    .iter()
                    .position(|record| record.archived_at.is_some())
                    .ok_or_else(|| registry_full(Stage::Setup))?;
                document.worktrees.remove(index);
            }
            document.worktrees.push(record);
            Ok(())
        })
        .await
    }
    async fn modify(&self, session_id: &str, change: impl FnOnce(&mut Record)) -> Result<()> {
        self.update(|document| {
            let record = document
                .worktrees
                .iter_mut()
                .rev()
                .find(|record| record.session_id == session_id && record.archived_at.is_none())
                .ok_or_else(|| anyhow!("Worktree record is unavailable"))?;
            change(record);
            Ok(())
        })
        .await
    }
    pub(crate) fn find(&self, session_id: &str) -> Option<Record> {
        self.read(|document| {
            document
                .worktrees
                .iter()
                .rev()
                .find(|record| record.session_id == session_id && record.archived_at.is_none())
                .cloned()
        })
        .ok()
        .flatten()
    }
    fn records(&self) -> Vec<Record> {
        self.read(|document| {
            document
                .worktrees
                .iter()
                .rev()
                .take(REGISTRY_PAGE)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
    }
    fn begin(&self, session_id: &str) -> Result<watch::Receiver<bool>> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| anyhow!("Worktree activity is unavailable"))?;
        if active.contains_key(session_id) {
            return Err(command_failure(
                "busy",
                "A setup, run or archive is already active for this worktree",
            ));
        }
        let (sender, receiver) = watch::channel(false);
        active.insert(session_id.into(), sender);
        Ok(receiver)
    }
    fn end(&self, session_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(session_id);
        }
    }
    fn cancel(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .ok()
            .and_then(|active| {
                active
                    .get(session_id)
                    .map(|sender| sender.send(true).is_ok())
            })
            .unwrap_or(false)
    }
    pub(crate) fn hold(&self, session_id: &str) -> Result<(Activity<'_>, watch::Receiver<bool>)> {
        let cancel = self.begin(session_id)?;
        Ok((
            Activity {
                store: self,
                session_id: session_id.into(),
            },
            cancel,
        ))
    }
    fn running(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .map(|active| active.contains_key(session_id))
            .unwrap_or(true)
    }
}

pub(crate) struct Activity<'a> {
    store: &'a Store,
    session_id: String,
}
impl Drop for Activity<'_> {
    fn drop(&mut self) {
        self.store.end(&self.session_id);
    }
}

pub fn available() -> bool {
    STORE.get().is_some()
}

pub(crate) fn store() -> Option<&'static Store> {
    STORE.get()
}

pub fn configure(directory: &Path) -> Result<()> {
    let store = Store::open(directory)?;
    STORE
        .set(store)
        .map_err(|_| anyhow!("Worktree registry is already configured"))?;
    let _ = REGISTRY_DIRECTORY.set(directory.to_owned());
    Ok(())
}

static REGISTRY_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn registry_directory() -> Option<&'static Path> {
    REGISTRY_DIRECTORY.get().map(PathBuf::as_path)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFact {
    pub digest: String,
    pub result: &'static str,
    pub log: String,
}

pub(crate) struct Plan {
    root: PathBuf,
    repository: String,
    prepared: Option<(Config, String)>,
}

pub(crate) fn repository_key(root: &Path) -> String {
    display_path(&std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned()))
}

async fn head_config(root: &Path) -> Result<Option<Config>> {
    head_text(root).await?.as_deref().map(parse).transpose()
}

pub(crate) async fn head_text(root: &Path) -> Result<Option<String>> {
    let spec = format!("HEAD:{CONFIG_FILE}");
    let output = git::run(
        root,
        &["cat-file", "blob", &spec],
        CONFIG_LIMIT,
        GIT_DEADLINE,
    )
    .await?;
    if output.truncated {
        return Err(anyhow!("{CONFIG_FILE} exceeds {CONFIG_LIMIT} bytes"));
    }
    if output.code != Some(0) {
        return Ok(None);
    }
    String::from_utf8(output.bytes)
        .map(Some)
        .map_err(|_| anyhow!("{CONFIG_FILE} must be UTF-8"))
}

async fn plan_with(store: Option<&Store>, directory: &Path) -> Result<Plan> {
    let root = match git::discover(directory).await {
        Ok(Some(root)) => root,
        Ok(None) => {
            return Err(Failure::raise(
                Stage::Plan,
                "not_repository",
                "The folder is not inside a Git repository; choose a folder in a repository to create a worktree",
            ));
        }
        Err(_) => {
            return Err(Failure::raise(
                Stage::Plan,
                "worktree_unconfirmed",
                "Inspect the repository before creating another worktree",
            ));
        }
    };
    let repository = repository_key(&root);
    if store.is_some_and(|store| !store.has_room()) {
        return Err(registry_full(Stage::Plan));
    }
    let config = head_config(&root).await.map_err(|error| {
        Failure::raise(Stage::Plan, "worktree_config_invalid", error.to_string())
    })?;
    let prepared = match config.filter(|config| !config.is_empty()) {
        None => None,
        Some(config) => {
            let digest = config.digest();
            let Some(store) = store else {
                return Err(Failure::raise(
                    Stage::Plan,
                    "unsupported",
                    "The host worktree registry is unavailable, so declared setup cannot be approved",
                ));
            };
            if !store.approved(&repository, &digest) {
                return Err(Failure::raise(
                    Stage::Plan,
                    "worktree_setup_unapproved",
                    format!(
                        "{CONFIG_FILE} setup for {repository} is not approved; inspect it with nesvo worktree describe and approve digest {digest}"
                    ),
                ));
            }
            Some((config, digest))
        }
    };
    Ok(Plan {
        root,
        repository,
        prepared,
    })
}

pub(crate) async fn plan(directory: &Path) -> Result<Plan> {
    plan_with(STORE.get(), directory).await
}

async fn journal(
    log: Option<&event_log::Service>,
    session_id: &str,
    event: event_log::DomainEvent,
) {
    if let Some(log) = log {
        let _ = tokio::time::timeout(
            DRAIN_DEADLINE,
            log.append(vec![event_log::Observation {
                session_id: Some(session_id.into()),
                at: now_millis(),
                event,
            }]),
        )
        .await;
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

fn contained(base: &Path, path: &Path) -> bool {
    std::fs::canonicalize(path).is_ok_and(|resolved| resolved.starts_with(base))
}

fn read_env_file(root: &Path, file: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let missing = || format!("environment file {file} is missing in the source checkout");
    let linked = || format!("environment file {file} must stay inside the source checkout");
    let mut source = root.to_owned();
    for part in file.split('/') {
        source.push(part);
        let metadata = std::fs::symlink_metadata(&source).map_err(|_| missing())?;
        if metadata.file_type().is_symlink() || !contained(root, &source) {
            return Err(linked());
        }
    }
    let oversized = || {
        format!("environment file {file} must be a regular file of at most {ENV_FILE_BYTES} bytes")
    };
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    without_links(&mut options);
    let opened = options.open(&source).map_err(|_| linked())?;
    let metadata = opened.metadata().map_err(|_| missing())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > ENV_FILE_BYTES {
        return Err(oversized());
    }
    let mut bytes = Vec::new();
    opened
        .take(ENV_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("environment file {file} cannot be read"))?;
    if bytes.len() as u64 > ENV_FILE_BYTES {
        return Err(oversized());
    }
    Ok(bytes)
}

fn write_env_file(worktree: &Path, file: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let folder = || format!("environment file {file} has no writable folder inside the worktree");
    let parts: Vec<&str> = file.split('/').collect();
    let (name, parents) = parts.split_last().ok_or_else(folder)?;
    let mut target = worktree.to_owned();
    for part in parents {
        target.push(part);
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(folder()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&target).map_err(|_| folder())?;
            }
            Err(_) => return Err(folder()),
        }
        if !contained(worktree, &target) {
            return Err(folder());
        }
    }
    target.push(name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!(
            "environment file {file} would overwrite a checked-out path"
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    without_links(&mut options);
    options
        .open(&target)
        .and_then(|mut opened| opened.write_all(bytes))
        .map_err(|_| format!("environment file {file} cannot be written"))
}

fn copy_env_files(root: &Path, worktree: &Path, files: &[String]) -> Result<Vec<Copied>, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|_| "the source checkout cannot be resolved".to_owned())?;
    let worktree = std::fs::canonicalize(worktree)
        .map_err(|_| "the worktree cannot be resolved".to_owned())?;
    let mut copied = Vec::new();
    for file in files {
        let bytes = read_env_file(&root, file)?;
        write_env_file(&worktree, file, &bytes)?;
        copied.push(Copied {
            path: file.clone(),
            sha256: sha256(&bytes),
        });
    }
    Ok(copied)
}

fn state_folder(worktree: &Path) -> std::io::Result<PathBuf> {
    let base = std::fs::canonicalize(worktree)?;
    Ok(registry_files::walk(&base, &[STATE_DIR], true)?)
}

pub(crate) async fn state_dir(worktree: &Path) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let worktree = worktree.to_owned();
    tokio::task::spawn_blocking(move || {
        let directory = state_folder(&worktree)?;
        registry_files::open_plain(&directory.join(".gitignore"))?.write_all(b"*\n")?;
        Ok(directory)
    })
    .await
    .map_err(std::io::Error::other)?
}

async fn read_worktree_config(worktree: &Path) -> Result<Option<Config>> {
    let path = worktree.join(CONFIG_FILE);
    let file = match tokio::fs::File::open(&path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(file) => file,
    };
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    parse(&String::from_utf8(bytes).map_err(|_| anyhow!("{CONFIG_FILE} must be UTF-8"))?).map(Some)
}

async fn prepare_with(
    store: Option<&Store>,
    plan: Plan,
    worktree: &Path,
    session_id: &str,
    log: Option<event_log::Service>,
) -> Result<Option<SetupFact>> {
    let started_at = now_millis();
    let display = display_path(worktree);
    let Some(store) = store else {
        return Ok(None);
    };
    let branch = git::current_branch(worktree).await;
    let digest = plan.prepared.as_ref().map(|(_, digest)| digest.clone());
    let log_path = display_path(&worktree.join(STATE_DIR).join("setup.log"));
    store
        .insert(Record {
            session_id: session_id.into(),
            worktree: display.clone(),
            branch,
            repository: plan.repository.clone(),
            created_at: started_at,
            digest: digest.clone(),
            config: plan.prepared.as_ref().map(|(config, _)| config.clone()),
            setup: Phase {
                state: if plan.prepared.is_some() {
                    "running"
                } else {
                    "notConfigured"
                }
                .into(),
                log: plan.prepared.as_ref().map(|_| log_path.clone()),
                started_at,
                finished_at: plan.prepared.is_none().then_some(started_at),
            },
            run: None,
            env_files: Vec::new(),
            archived_at: None,
            discarded: false,
        })
        .await?;
    let Some((config, digest)) = plan.prepared else {
        return Ok(None);
    };
    let cancel = store.begin(session_id)?;
    let activity = Activity {
        store,
        session_id: session_id.into(),
    };
    let (outcome, copied) = setup(&plan.root, worktree, &config, &digest, cancel).await;
    drop(activity);
    let result = outcome.name();
    store
        .modify(session_id, |record| {
            record.setup.state = result.into();
            record.setup.finished_at = Some(now_millis());
            record.env_files = copied;
        })
        .await?;
    journal(
        log.as_ref(),
        session_id,
        event_log::DomainEvent::WorktreePrepared(event_log::model::WorktreePrepared {
            session_id: session_id.into(),
            result: result.into(),
            log: log_path.clone(),
            worktree: display.clone(),
            digest: digest.clone(),
        }),
    )
    .await;
    if outcome != Outcome::Passed {
        return Err(Failure {
            code: match outcome {
                Outcome::TimedOut => "worktree_setup_timed_out",
                Outcome::Cancelled => "worktree_setup_cancelled",
                _ => "worktree_setup_failed",
            },
            message: format!(
                "Worktree setup {result}; the agent was not started. Inspect {log_path}"
            ),
            stage: Stage::Setup,
            log: Some(log_path),
        }
        .into());
    }
    Ok(Some(SetupFact {
        digest,
        result,
        log: log_path,
    }))
}

async fn setup(
    root: &Path,
    worktree: &Path,
    config: &Config,
    digest: &str,
    cancel: watch::Receiver<bool>,
) -> (Outcome, Vec<Copied>) {
    let Ok(directory) = state_dir(worktree).await else {
        return (Outcome::Failed, Vec::new());
    };
    let Ok(mut log) = Log::create(&directory.join("setup.log")).await else {
        return (Outcome::Failed, Vec::new());
    };
    match read_worktree_config(worktree).await {
        Ok(Some(current)) if current.digest() == digest => {}
        _ => {
            log.line("nesvo.toml in the new worktree does not match the approved digest")
                .await;
            log.finish().await;
            return (Outcome::Failed, Vec::new());
        }
    }
    let (source, target, files) = (
        root.to_owned(),
        worktree.to_owned(),
        config.env_files.clone(),
    );
    let copied = match tokio::task::spawn_blocking(move || copy_env_files(&source, &target, &files))
        .await
        .unwrap_or_else(|_| Err("environment files could not be copied".into()))
    {
        Ok(copied) => copied,
        Err(message) => {
            log.line(&message).await;
            log.finish().await;
            return (Outcome::Failed, Vec::new());
        }
    };
    for file in &copied {
        log.line(&format!("copied environment file {}", file.path))
            .await;
    }
    let outcome = execute(
        &config.setup,
        worktree,
        &mut log,
        Duration::from_secs(config.timeout_s),
        cancel,
    )
    .await;
    log.finish().await;
    (outcome, copied)
}

pub(crate) async fn prepare(
    plan: Plan,
    worktree: &Path,
    session_id: &str,
    log: Option<event_log::Service>,
) -> Result<Option<SetupFact>> {
    prepare_with(STORE.get(), plan, worktree, session_id, log).await
}

pub(crate) async fn derive(
    directory: &Path,
    session_id: &str,
    log: Option<event_log::Service>,
    spec: &mut LaunchSpec,
) -> Result<()> {
    let plan = plan(directory).await?;
    let worktree = git::create_worktree(directory).await.map_err(|error| {
        Failure::raise(Stage::Create, "worktree_unconfirmed", error.to_string())
    })?;
    spec.cwd = Some(display_path(&worktree));
    spec.worktree = false;
    spec.worktree_setup = prepare(plan, &worktree, session_id, log).await?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Passed,
    Failed,
    TimedOut,
    Cancelled,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
            Self::Cancelled => "cancelled",
        }
    }
}

pub(crate) struct Log {
    file: tokio::fs::File,
    written: usize,
    truncated: bool,
    tail: Vec<u8>,
    tail_limit: usize,
    tail_seen: usize,
}

impl Log {
    pub(crate) async fn create(path: &Path) -> std::io::Result<Self> {
        Self::tailed(path, 0).await
    }
    pub(crate) async fn tailed(path: &Path, tail_limit: usize) -> std::io::Result<Self> {
        let path = path.to_owned();
        let file = tokio::task::spawn_blocking(move || registry_files::open_plain(&path))
            .await
            .map_err(std::io::Error::other)??;
        Ok(Self {
            file: tokio::fs::File::from_std(file),
            written: 0,
            truncated: false,
            tail: Vec::new(),
            tail_limit,
            tail_seen: 0,
        })
    }
    async fn append(&mut self, bytes: &[u8]) {
        let take = bytes.len().min(LOG_CONTENT_LIMIT - self.written);
        if take > 0 && self.file.write_all(&bytes[..take]).await.is_ok() {
            self.written += take;
        }
        self.truncated |= take < bytes.len();
    }
    async fn write(&mut self, bytes: &[u8]) {
        self.append(bytes).await;
        if self.tail_limit > 0 {
            self.tail_seen += bytes.len();
            self.tail.extend_from_slice(bytes);
            let excess = self.tail.len().saturating_sub(self.tail_limit);
            self.tail.drain(..excess);
        }
    }
    pub(crate) fn take_tail(&mut self) -> (Vec<u8>, bool) {
        let truncated = self.tail_seen > self.tail.len();
        self.tail_seen = 0;
        (std::mem::take(&mut self.tail), truncated)
    }
    pub(crate) async fn line(&mut self, text: &str) {
        self.append(format!("{text}\n").as_bytes()).await;
    }
    pub(crate) async fn finish(mut self) {
        if self.truncated {
            let _ = self
                .file
                .write_all(format!("\n[log truncated at {LOG_LIMIT} bytes]\n").as_bytes())
                .await;
        }
        let _ = self.file.flush().await;
    }
}

fn shell(step: &str) -> Result<std::process::Command> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let executable = PathBuf::from(command_scope::system_root()?)
            .join("System32")
            .join("cmd.exe");
        let mut command = std::process::Command::new(executable);
        command
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{step}\""));
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new("/bin/sh");
        command.arg("-c").arg(step);
        Ok(command)
    }
}

fn private_variable(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name.starts_with("NESVO_") || name.starts_with("POCKET_")
}

fn without_private_environment(command: &mut std::process::Command) {
    for (name, _) in std::env::vars_os() {
        if private_variable(&name) {
            command.env_remove(name);
        }
    }
}

#[cfg(windows)]
pub(crate) const STEP_HELPER_FLAG: &str = "--worktree-step-helper";
#[cfg(all(windows, test))]
const STEP_TEST_GATE: &str = "NESVO_WORKTREE_STEP_TEST_HELPER";

#[cfg(windows)]
fn step_command(_: &str) -> Result<std::process::Command> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    without_private_environment(&mut command);
    #[cfg(not(test))]
    command.arg(STEP_HELPER_FLAG);
    #[cfg(test)]
    command
        .args([
            "--ignored",
            "--exact",
            "worktrees::tests::step_helper_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(STEP_TEST_GATE, "1");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    Ok(command)
}

#[cfg(not(windows))]
fn step_command(text: &str) -> Result<std::process::Command> {
    let mut command = shell(text)?;
    without_private_environment(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

#[cfg(windows)]
fn step_frame(text: &str) -> Vec<u8> {
    let mut frame = u32::try_from(text.len())
        .unwrap_or(u32::MAX)
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(text.as_bytes());
    frame
}

#[cfg(windows)]
fn read_step(input: &mut impl std::io::Read) -> Option<String> {
    let mut length = [0; 4];
    input.read_exact(&mut length).ok()?;
    let length = usize::try_from(u32::from_be_bytes(length)).ok()?;
    if length == 0 || length > STEP_BYTES {
        return None;
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).ok()?;
    String::from_utf8(bytes)
        .ok()
        .filter(|text| valid_step(text))
}

#[cfg(windows)]
pub(crate) fn step_helper() -> i32 {
    use std::os::windows::process::CommandExt;
    let Some(text) = read_step(&mut std::io::stdin().lock()) else {
        eprintln!("the step request was refused");
        return 1;
    };
    let Ok(mut command) = shell(&text) else {
        eprintln!("the platform shell is unavailable");
        return 1;
    };
    without_private_environment(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::io::stderr()))
        .stderr(Stdio::inherit())
        .creation_flags(0x0800_0000);
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => {
            eprintln!("the step could not be started");
            1
        }
    }
}

#[cfg(windows)]
async fn release(child: &mut tokio::process::Child, text: &str) -> Result<()> {
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("The step helper input is unavailable"))?;
    input.write_all(&step_frame(text)).await?;
    input.flush().await?;
    Ok(())
}

#[cfg(not(windows))]
async fn release(_: &mut tokio::process::Child, _: &str) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn exited(child: &mut tokio::process::Child) -> std::io::Result<bool> {
    child.try_wait().map(|status| status.is_some())
}

#[cfg(unix)]
fn exited(child: &mut tokio::process::Child) -> std::io::Result<bool> {
    let Some(id) = child.id() else {
        return Ok(true);
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
    if result == 0 {
        return Ok(info.si_signo == libc::SIGCHLD);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::Interrupted {
        Ok(false)
    } else {
        Err(error)
    }
}

struct Owned {
    child: tokio::process::Child,
    scope: Option<command_scope::Scope>,
    may_terminate: bool,
}
impl Owned {
    fn terminate(&mut self) {
        if !self.may_terminate {
            return;
        }
        self.may_terminate = false;
        match &self.scope {
            Some(scope) => {
                let _ = scope.terminate();
            }
            None => {
                let _ = self.child.start_kill();
            }
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn forward(mut pipe: impl AsyncRead + Unpin, output: mpsc::Sender<Vec<u8>>) {
    let mut buffer = vec![0; 8192];
    while let Ok(read) = pipe.read(&mut buffer).await {
        if read == 0 || output.send(buffer[..read].to_vec()).await.is_err() {
            return;
        }
    }
}

pub(crate) async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

enum Ended {
    Exited,
    TimedOut,
    Cancelled,
    Lost,
}

async fn step(
    text: &str,
    cwd: &Path,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
    log: &mut Log,
) -> Outcome {
    step_status(text, cwd, deadline, cancel, log).await.0
}

pub(crate) async fn step_status(
    text: &str,
    cwd: &Path,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
    log: &mut Log,
) -> (Outcome, Option<i32>) {
    let Ok(command) = step_command(text) else {
        log.line("the platform shell is unavailable").await;
        return (Outcome::Failed, None);
    };
    let mut command = tokio::process::Command::from(command);
    command.current_dir(cwd).kill_on_drop(true);
    command_scope::configure(&mut command);
    let Ok(child) = command.spawn() else {
        log.line("the step could not be started").await;
        return (Outcome::Failed, None);
    };
    let mut owned = Owned {
        child,
        scope: None,
        may_terminate: true,
    };
    match command_scope::Scope::enroll(&owned.child) {
        Ok(scope) => owned.scope = Some(scope),
        Err(_) => {
            log.line("the step could not be contained").await;
            return (Outcome::Failed, None);
        }
    }
    if !matches!(
        tokio::time::timeout_at(deadline.into(), release(&mut owned.child, text)).await,
        Ok(Ok(()))
    ) {
        log.line("the step could not be started").await;
        return (Outcome::Failed, None);
    }
    let (sender, mut output) = mpsc::channel(8);
    let mut readers = Vec::new();
    if let Some(stdout) = owned.child.stdout.take() {
        readers.push(tokio::spawn(forward(stdout, sender.clone())));
    }
    if let Some(stderr) = owned.child.stderr.take() {
        readers.push(tokio::spawn(forward(stderr, sender.clone())));
    }
    drop(sender);
    let mut poll = tokio::time::interval(Duration::from_millis(20));
    let mut open = true;
    let ended = loop {
        tokio::select! {
            biased;
            _ = cancelled(cancel) => break Ended::Cancelled,
            _ = tokio::time::sleep_until(deadline.into()) => break Ended::TimedOut,
            chunk = output.recv(), if open => match chunk {
                Some(bytes) => log.write(&bytes).await,
                None => open = false,
            },
            _ = poll.tick() => match exited(&mut owned.child) {
                Ok(true) => break Ended::Exited,
                Ok(false) => {}
                Err(_) => break Ended::Lost,
            },
        }
    };
    owned.terminate();
    let _ = tokio::time::timeout(DRAIN_DEADLINE, async {
        while let Some(bytes) = output.recv().await {
            log.write(&bytes).await;
        }
    })
    .await;
    for reader in readers {
        reader.abort();
    }
    let status = tokio::time::timeout(DRAIN_DEADLINE, owned.child.wait()).await;
    match (ended, status) {
        (Ended::Exited, Ok(Ok(status))) if status.success() => (Outcome::Passed, status.code()),
        (Ended::Exited, Ok(Ok(status))) => {
            log.line(&format!(
                "step failed with exit code {}",
                status
                    .code()
                    .map_or_else(|| "unknown".into(), |code| code.to_string())
            ))
            .await;
            (Outcome::Failed, status.code())
        }
        (Ended::Exited | Ended::Lost, _) => {
            log.line("the step exit could not be observed").await;
            (Outcome::Failed, None)
        }
        (Ended::TimedOut, _) => {
            log.line("the step timed out and was terminated").await;
            (Outcome::TimedOut, None)
        }
        (Ended::Cancelled, _) => {
            log.line("the step was cancelled and terminated").await;
            (Outcome::Cancelled, None)
        }
    }
}

async fn execute(
    steps: &[String],
    cwd: &Path,
    log: &mut Log,
    limit: Duration,
    mut cancel: watch::Receiver<bool>,
) -> Outcome {
    let deadline = Instant::now() + limit;
    let _slot = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => {
            log.line("cancelled before the first step").await;
            return Outcome::Cancelled;
        }
        _ = tokio::time::sleep_until(deadline.into()) => {
            log.line("no step slot became available before the deadline").await;
            return Outcome::TimedOut;
        }
        slot = SLOTS.acquire() => match slot {
            Ok(slot) => slot,
            Err(_) => return Outcome::Failed,
        },
    };
    for text in steps {
        log.line(&format!("$ {text}")).await;
        let outcome = step(text, cwd, deadline, &mut cancel, log).await;
        if outcome != Outcome::Passed {
            return outcome;
        }
    }
    Outcome::Passed
}

pub(crate) fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::DescribeWorktreeSetup { .. }
            | Command::ApproveWorktreeSetup { .. }
            | Command::RevokeWorktreeSetup { .. }
            | Command::RunWorktree { .. }
            | Command::CancelWorktree { .. }
            | Command::ArchiveWorktree { .. }
            | Command::ListWorktrees
            | Command::ListMcpServers { .. }
    )
}

fn target_session(command: &Command) -> Option<&str> {
    match command {
        Command::RunWorktree { session_id }
        | Command::CancelWorktree { session_id }
        | Command::ArchiveWorktree { session_id, .. } => Some(session_id),
        _ => None,
    }
}

fn owner_action(command: &Command) -> &'static str {
    match command {
        Command::ApproveWorktreeSetup { .. } => "Approving a worktree setup digest",
        Command::RevokeWorktreeSetup { .. } => "Revoking a worktree setup digest",
        Command::RunWorktree { .. } => "Running worktree steps",
        Command::CancelWorktree { .. } => "Cancelling worktree steps",
        Command::ArchiveWorktree { .. } => "Archiving a worktree",
        Command::ListMcpServers { .. } => "Listing declared MCP servers",
        _ => "Inspecting worktree setup and the worktree registry",
    }
}

pub(crate) fn admit(authority: &Authority, command: &Command) -> Result<()> {
    registry_files::owner_only(authority, |scope| {
        if target_session(command).is_some_and(|target| target != scope) {
            return command_failure(
                "forbidden",
                "The target worktree session is outside the caller's session scope",
            );
        }
        command_failure(
            "forbidden",
            format!(
                "{} requires owner authority; setup approval is a human act through the owner CLI",
                owner_action(command)
            ),
        )
    })
}

pub(crate) fn host_directory(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || !path.is_absolute()
    {
        return Err(command_failure(
            "invalid_argument",
            "Use an absolute host folder inside a Git repository",
        ));
    }
    Ok(path)
}

fn valid_session(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(command_failure(
            "invalid_argument",
            "Invalid session identifier",
        ));
    }
    Ok(())
}

pub(crate) fn valid_digest(digest: &str) -> Result<()> {
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(command_failure(
            "invalid_argument",
            "Use the 64-character digest reported by describe",
        ));
    }
    Ok(())
}

async fn inspect(directory: &str) -> Result<(String, Option<Config>)> {
    let root = git::toplevel(&host_directory(directory)?)
        .await
        .map_err(|_| {
            command_failure(
                "invalid_argument",
                "The folder is not inside a Git repository",
            )
        })?;
    let config = head_config(&root)
        .await
        .map_err(|error| command_failure("worktree_config_invalid", error.to_string()))?;
    Ok((repository_key(&root), config))
}

async fn describe(store: &Store, directory: &str) -> Result<Value> {
    let (repository, config) = inspect(directory).await?;
    let digest = config.as_ref().map(Config::digest);
    let approved = digest
        .as_deref()
        .is_some_and(|digest| store.approved(&repository, digest));
    Ok(
        json!({"type":"worktreeSetup","repository":repository,"configured":config.is_some(),"config":config,"digest":digest,"approved":approved,
        "policy":{"version":1,"shell":POLICY,"source":format!("HEAD:{CONFIG_FILE}"),"logLimit":LOG_LIMIT}}),
    )
}

async fn approve(
    store: &Store,
    log: Option<&event_log::Service>,
    directory: &str,
    digest: &str,
) -> Result<Value> {
    valid_digest(digest)?;
    let (repository, config) = inspect(directory).await?;
    let current = config
        .ok_or_else(|| command_failure("worktree_config_missing", "HEAD has no nesvo.toml"))?
        .digest();
    if current != digest.to_ascii_lowercase() {
        return Err(command_failure(
            "digest_mismatch",
            format!("The committed setup changed; inspect it again (current digest {current})"),
        ));
    }
    let approved_at = store.approve(&repository, &current).await?;
    if let Some(log) = log {
        log.observe(event_log::Observation {
            session_id: None,
            at: now_millis(),
            event: event_log::DomainEvent::WorktreeSetupApproved(
                event_log::model::RepositoryDigest {
                    repository: repository.clone(),
                    digest: current.clone(),
                },
            ),
        });
    }
    Ok(
        json!({"type":"worktreeSetupApproved","repository":repository,"digest":current,"approvedAt":approved_at}),
    )
}

async fn revoke(
    store: &Store,
    log: Option<&event_log::Service>,
    directory: &str,
    digest: &str,
) -> Result<Value> {
    valid_digest(digest)?;
    let root = git::toplevel(&host_directory(directory)?)
        .await
        .map_err(|_| {
            command_failure(
                "invalid_argument",
                "The folder is not inside a Git repository",
            )
        })?;
    let repository = repository_key(&root);
    let digest = digest.to_ascii_lowercase();
    let revoked = store.revoke(&repository, &digest).await?;
    if revoked {
        crate::mcp_pool::revoke(&repository, &digest);
    }
    if revoked && let Some(log) = log {
        log.observe(event_log::Observation {
            session_id: None,
            at: now_millis(),
            event: event_log::DomainEvent::WorktreeSetupRevoked(
                event_log::model::RepositoryDigest {
                    repository: repository.clone(),
                    digest: digest.clone(),
                },
            ),
        });
    }
    Ok(
        json!({"type":"worktreeSetupRevoked","repository":repository,"digest":digest,"revoked":revoked}),
    )
}

fn active_record(store: &Store, session_id: &str) -> Result<Record> {
    valid_session(session_id)?;
    store.find(session_id).ok_or_else(|| {
        command_failure(
            "worktree_not_found",
            "No host-created worktree is registered for this session",
        )
    })
}

async fn run(
    store: &'static Store,
    log: Option<event_log::Service>,
    session_id: &str,
) -> Result<Value> {
    let record = active_record(store, session_id)?;
    if !matches!(record.setup.state.as_str(), "passed" | "notConfigured") {
        return Err(command_failure(
            "worktree_not_prepared",
            "Run steps start only after a passed setup",
        ));
    }
    let worktree = PathBuf::from(&record.worktree);
    let config = record
        .config
        .clone()
        .filter(|config| !config.run.is_empty())
        .ok_or_else(|| {
            command_failure(
                "worktree_run_unavailable",
                "The nesvo.toml approved for this worktree declares no run steps",
            )
        })?;
    let digest = config.digest();
    if record.digest.as_deref() != Some(digest.as_str())
        || !store.approved(&record.repository, &digest)
    {
        return Err(command_failure(
            "worktree_setup_unapproved",
            format!("The nesvo.toml digest {digest} recorded for this worktree is not approved"),
        ));
    }
    let cancel = store.begin(session_id)?;
    let activity = Activity {
        store,
        session_id: session_id.into(),
    };
    let log_path = display_path(&worktree.join(STATE_DIR).join("run.log"));
    store
        .modify(session_id, |record| {
            record.run = Some(Phase {
                state: "running".into(),
                log: Some(log_path.clone()),
                started_at: now_millis(),
                finished_at: None,
            });
        })
        .await?;
    let session = session_id.to_owned();
    let started = log_path.clone();
    tokio::spawn(async move {
        let outcome = async {
            let directory = state_dir(&worktree).await.ok()?;
            let mut file = Log::create(&directory.join("run.log")).await.ok()?;
            let outcome = execute(
                &config.run,
                &worktree,
                &mut file,
                Duration::from_secs(config.timeout_s),
                cancel,
            )
            .await;
            file.finish().await;
            Some(outcome)
        }
        .await
        .unwrap_or(Outcome::Failed);
        let result = outcome.name();
        let _ = store
            .modify(&session, |record| {
                if let Some(run) = &mut record.run {
                    run.state = result.into();
                    run.finished_at = Some(now_millis());
                }
            })
            .await;
        drop(activity);
        journal(
            log.as_ref(),
            &session,
            event_log::DomainEvent::WorktreeRan(event_log::model::WorktreeRan {
                session_id: session.clone(),
                result: result.into(),
                log: log_path.clone(),
            }),
        )
        .await;
    });
    Ok(
        json!({"type":"worktreeRunStarted","sessionId":session_id,"worktree":record.worktree,"log":started}),
    )
}

fn cancel(store: &Store, session_id: &str) -> Result<Value> {
    active_record(store, session_id)?;
    Ok(
        json!({"type":"worktreeCancelled","sessionId":session_id,"cancelled":store.cancel(session_id)}),
    )
}

fn host_owned(record: &Record, worktree: &Path, path: &str) -> bool {
    path.split('/').next() == Some(STATE_DIR)
        || record.env_files.iter().any(|copied| {
            copied.path == path
                && std::fs::read(worktree.join(path))
                    .is_ok_and(|bytes| sha256(&bytes) == copied.sha256)
        })
}

fn without_host_files(record: &Record, worktree: &Path, bytes: &[u8]) -> Vec<u8> {
    let mut kept = Vec::with_capacity(bytes.len());
    for entry in bytes.split(|byte| *byte == 0) {
        let untracked = entry.strip_prefix(b"? ");
        if untracked
            .is_some_and(|path| host_owned(record, worktree, &String::from_utf8_lossy(path)))
        {
            continue;
        }
        kept.extend_from_slice(entry);
        kept.push(0);
    }
    kept.pop();
    kept
}

async fn unique_commits(cwd: &Path, branch: Option<&str>, worktree_present: bool) -> Result<u64> {
    let mut args = vec!["rev-list".to_owned(), "--count".to_owned()];
    if worktree_present {
        args.push("HEAD".into());
    }
    let exclude = branch.map(|branch| format!("--exclude={branch}"));
    if let Some(branch) = branch {
        let reference = format!("refs/heads/{branch}");
        let exists = git::run(
            cwd,
            &["rev-parse", "--verify", "--quiet", &reference],
            256,
            GIT_DEADLINE,
        )
        .await?;
        if exists.code == Some(0) {
            args.push(reference);
        }
    }
    if args.len() == 2 {
        return Ok(0);
    }
    args.push("--not".into());
    args.extend(exclude);
    args.extend(["--branches".into(), "--tags".into(), "--remotes".into()]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git::run(cwd, &args, 64, GIT_DEADLINE).await?;
    anyhow::ensure!(
        output.code == Some(0),
        "Git could not count unsaved commits"
    );
    Ok(String::from_utf8(output.bytes)?.trim().parse()?)
}

async fn blockers(record: &Record, worktree: &Path, present: bool) -> Result<Vec<&'static str>> {
    let repository = PathBuf::from(&record.repository);
    if !present {
        let unique = unique_commits(&repository, record.branch.as_deref(), false).await?;
        return Ok(if unique > 0 {
            vec!["unpushed"]
        } else {
            Vec::new()
        });
    }
    let output = git::run(
        worktree,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        CONFIG_LIMIT,
        GIT_DEADLINE,
    )
    .await?;
    anyhow::ensure!(
        output.truncated || output.code == Some(0),
        "Git could not read the worktree status"
    );
    let status = git::parse_status(
        &without_host_files(record, worktree, &output.bytes),
        output.truncated,
    );
    let unique = unique_commits(worktree, record.branch.as_deref(), true).await?;
    Ok(git::blockers(&status, None, Some(unique == 0))
        .into_iter()
        .filter(|blocker| matches!(*blocker, "conflicts" | "dirty" | "unpushed" | "unborn"))
        .collect())
}

async fn archive(
    store: &Store,
    log: Option<&event_log::Service>,
    session_id: &str,
    discard: bool,
    live: bool,
) -> Result<Value> {
    let record = active_record(store, session_id)?;
    if live {
        return Err(command_failure(
            "session_running",
            "Close the session before archiving its worktree",
        ));
    }
    let _cancel = store.begin(session_id)?;
    let _activity = Activity {
        store,
        session_id: session_id.into(),
    };
    let worktree = PathBuf::from(&record.worktree);
    let repository = PathBuf::from(&record.repository);
    let present = tokio::fs::metadata(worktree.join(".git")).await.is_ok();
    let blockers = blockers(&record, &worktree, present)
        .await
        .map_err(|error| command_failure("git_unavailable", error.to_string()))?;
    if !blockers.is_empty() && !discard {
        return Err(command_failure(
            "worktree_unsaved",
            format!(
                "The worktree has unsaved work ({}); commit and push it, or pass discard explicitly",
                blockers.join(", ")
            ),
        ));
    }
    let removal = if present {
        let path = display_path(&worktree);
        git::run(
            &repository,
            &[
                "-c",
                "core.hooksPath=",
                "worktree",
                "remove",
                "--force",
                "--",
                &path,
            ],
            8192,
            REMOVE_DEADLINE,
        )
        .await
    } else {
        git::run(&repository, &["worktree", "prune"], 8192, GIT_DEADLINE).await
    }
    .map_err(|error| command_failure("git_unavailable", error.to_string()))?;
    if removal.code != Some(0) {
        return Err(command_failure(
            "git_unavailable",
            "Git could not remove the worktree; close programs using it and retry",
        ));
    }
    let branch_deleted = match record
        .branch
        .as_deref()
        .filter(|branch| branch.starts_with("nesvo/"))
    {
        Some(branch) => git::run(&repository, &["branch", "-D", branch], 8192, GIT_DEADLINE)
            .await
            .is_ok_and(|output| output.code == Some(0)),
        None => false,
    };
    let discarded = !blockers.is_empty();
    store
        .modify(session_id, |record| {
            record.archived_at = Some(now_millis());
            record.discarded = discarded;
        })
        .await?;
    let payload = json!({"sessionId":session_id,"worktree":record.worktree,"branch":record.branch,"discarded":discarded,"blockers":blockers,"branchDeleted":branch_deleted});
    let archived = event_log::model::WorktreeArchived {
        session_id: session_id.into(),
        worktree: record.worktree.clone(),
        branch: record.branch.clone(),
        discarded,
        blockers: blockers
            .iter()
            .map(|blocker| (*blocker).to_owned())
            .collect(),
        branch_deleted,
    };
    journal(
        log,
        session_id,
        event_log::DomainEvent::WorktreeArchived(archived),
    )
    .await;
    let mut event = payload;
    event["type"] = "worktreeArchived".into();
    Ok(event)
}

fn comparable(path: &str) -> String {
    let path = Path::new(path);
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let text = display_path(&path).replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

async fn listed(repository: &str) -> HashSet<String> {
    let Ok(output) = git::run(
        Path::new(repository),
        &["worktree", "list", "--porcelain", "-z"],
        CONFIG_LIMIT,
        GIT_DEADLINE,
    )
    .await
    else {
        return HashSet::new();
    };
    String::from_utf8_lossy(&output.bytes)
        .split('\0')
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(comparable)
        .collect()
}

async fn registry(store: &Store, live: impl Fn(&str) -> bool) -> Result<Value> {
    let records = store.records();
    let mut known: HashMap<String, HashSet<String>> = HashMap::new();
    let mut worktrees = Vec::new();
    for record in records {
        let present = if record.archived_at.is_some() {
            false
        } else {
            if !known.contains_key(&record.repository) && known.len() < 16 {
                known.insert(record.repository.clone(), listed(&record.repository).await);
            }
            known
                .get(&record.repository)
                .is_some_and(|paths| paths.contains(&comparable(&record.worktree)))
        };
        let mut value = serde_json::to_value(&record)?;
        if let Some(fields) = value.as_object_mut() {
            fields.remove("config");
        }
        value["present"] = present.into();
        value["sessionLive"] = live(&record.session_id).into();
        value["active"] = store.running(&record.session_id).into();
        worktrees.push(value);
    }
    Ok(json!({"type":"worktreeRegistry","worktrees":worktrees}))
}

pub(crate) struct ProjectWorktree {
    pub repository: String,
    pub session_id: String,
    pub created_at: u64,
    pub open: bool,
}

pub(crate) fn session_branch(session_id: &str) -> Option<(String, Option<String>)> {
    STORE
        .get()?
        .find(session_id)
        .map(|record| (record.worktree, record.branch))
}

pub(crate) fn project_worktrees() -> Vec<ProjectWorktree> {
    STORE.get().map_or_else(Vec::new, |store| {
        store
            .records()
            .into_iter()
            .map(|record| ProjectWorktree {
                open: record.archived_at.is_none(),
                repository: record.repository,
                session_id: record.session_id,
                created_at: record.created_at,
            })
            .collect()
    })
}

pub(crate) async fn project_setup(root: &str) -> Value {
    let Some(store) = STORE.get() else {
        return json!({"available":false});
    };
    let open = store
        .records()
        .iter()
        .filter(|record| record.repository == root && record.archived_at.is_none())
        .count();
    match describe(store, root).await {
        Ok(described) => json!({"available":true,"configured":described["configured"],
            "digest":described["digest"],"approved":described["approved"],"openWorktrees":open}),
        Err(error) => json!({"available":true,"configured":false,"openWorktrees":open,
            "error":{"code":error_code(&error).unwrap_or("worktree_unavailable"),"message":error.to_string()}}),
    }
}

fn error_event(error: &anyhow::Error) -> Value {
    match error_code(error) {
        Some(code) => json!({"type":"error","code":code,"message":error.to_string()}),
        None => json!({"type":"error","code":"worktree_unavailable","message":error.to_string()}),
    }
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    authority: Authority,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let log = state.lock().ok().and_then(|state| state.event_log().ok());
    let result = match (admit(&authority, &command), STORE.get(), permit) {
        (Err(error), _, _) => Err(error),
        (Ok(()), _, None) => Err(command_failure("busy", "Worktree service is busy")),
        (Ok(()), None, _) => Err(command_failure(
            "unsupported",
            "The host worktree registry is unavailable",
        )),
        (Ok(()), Some(store), Some(_permit)) => match command {
            Command::DescribeWorktreeSetup { directory } => describe(store, &directory).await,
            Command::ListMcpServers { directory } => {
                crate::mcp_servers::list(store, &directory).await
            }
            Command::ApproveWorktreeSetup { directory, digest } => {
                approve(store, log.as_ref(), &directory, &digest).await
            }
            Command::RevokeWorktreeSetup { directory, digest } => {
                revoke(store, log.as_ref(), &directory, &digest).await
            }
            Command::RunWorktree { session_id } => run(store, log, &session_id).await,
            Command::CancelWorktree { session_id } => cancel(store, &session_id),
            Command::ArchiveWorktree {
                session_id,
                discard,
            } => {
                let live = state
                    .lock()
                    .map(|state| state.session_directory(&session_id).is_ok())
                    .unwrap_or(true);
                archive(store, log.as_ref(), &session_id, discard, live).await
            }
            Command::ListWorktrees => {
                registry(store, |id| {
                    state
                        .lock()
                        .map(|state| state.session_directory(id).is_ok())
                        .unwrap_or(false)
                })
                .await
            }
            _ => Err(command_failure(
                "invalid_argument",
                "Unsupported worktree command",
            )),
        },
    };
    let mut event = result.unwrap_or_else(|error| error_event(&error));
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

#[cfg(test)]
#[path = "worktrees_tests.rs"]
mod tests;
