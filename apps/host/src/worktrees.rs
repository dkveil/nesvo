use crate::{
    command_scope, event_log, git, jobs::LaunchSpec, process::display_path, protocol::Command,
    sessions::State,
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
const CONFIG_LIMIT: usize = 64 * 1024;
const LOG_LIMIT: usize = 64 * 1024;
const LOG_CONTENT_LIMIT: usize = LOG_LIMIT - 64;
const STEP_LIMIT: usize = 32;
const STEP_BYTES: usize = 4096;
const ENV_FILE_BYTES: u64 = 1024 * 1024;
const DEFAULT_TIMEOUT_S: u64 = 600;
const MAX_TIMEOUT_S: u64 = 3600;
const APPROVAL_LIMIT: usize = 256;
const RECORD_LIMIT: usize = 512;
const REGISTRY_PAGE: usize = 128;
const STORE_LIMIT: u64 = 4 * 1024 * 1024;
const GIT_DEADLINE: Duration = Duration::from_secs(10);
const REMOVE_DEADLINE: Duration = Duration::from_secs(60);
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);
const POLICY: &str = "platform-shell-v1";
const STATE_DIR: &str = ".nesvo";
static SLOTS: Semaphore = Semaphore::const_new(4);
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

fn command_failure(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Failure::raise(Stage::Command, code, message)
}

pub(crate) fn error_code(error: &anyhow::Error) -> Option<&'static str> {
    Failure::of(error).map(|failure| failure.code).or_else(|| {
        error
            .downcast_ref::<crate::api_error::Error>()
            .map(|error| error.code)
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub setup: Vec<String>,
    pub run: Vec<String>,
    pub env_files: Vec<String>,
    pub timeout_s: u64,
}

impl Config {
    fn is_empty(&self) -> bool {
        self.setup.is_empty() && self.run.is_empty() && self.env_files.is_empty()
    }
    pub fn digest(&self) -> String {
        let canonical = json!({"version":1,"policy":POLICY,"setup":self.setup,"run":self.run,"envFiles":self.env_files,"timeoutS":self.timeout_s});
        hex::encode(
            ring::digest::digest(&ring::digest::SHA256, canonical.to_string().as_bytes()).as_ref(),
        )
    }
}

enum Item {
    Integer(u64),
    List(Vec<String>),
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.text[self.at..].chars().next()
    }
    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.at += c.len_utf8();
        Some(c)
    }
    fn error(&self, message: &str) -> anyhow::Error {
        let line = self.text[..self.at].matches('\n').count() + 1;
        anyhow!("{CONFIG_FILE} line {line}: {message}")
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
    fn trivia(&mut self) -> Result<()> {
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
            _ => Err(self.error("expected an integer or an array of strings")),
        }
    }
}

fn validate_steps(key: &str, steps: Vec<String>) -> Result<Vec<String>> {
    if steps.len() > STEP_LIMIT {
        return Err(anyhow!("{key} declares more than {STEP_LIMIT} steps"));
    }
    for step in &steps {
        if step.trim().is_empty()
            || step.len() > STEP_BYTES
            || step.chars().any(|c| c.is_control() && c != '\t')
        {
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
    if text.len() > CONFIG_LIMIT {
        return Err(anyhow!("{CONFIG_FILE} exceeds {CONFIG_LIMIT} bytes"));
    }
    let mut parser = Parser {
        text: text.strip_prefix('\u{feff}').unwrap_or(text),
        at: 0,
    };
    let mut config = Config {
        timeout_s: DEFAULT_TIMEOUT_S,
        ..Config::default()
    };
    let mut in_table = false;
    let mut seen_table = false;
    let mut keys = HashSet::new();
    loop {
        parser.trivia()?;
        match parser.peek() {
            None => break,
            Some('[') => {
                parser.bump();
                parser.blank();
                let name = parser.key()?;
                parser.blank();
                parser.expect(']')?;
                parser.line_end()?;
                if name != "worktree" || seen_table {
                    return Err(parser.error("only one [worktree] table is defined"));
                }
                seen_table = true;
                in_table = true;
            }
            Some(_) => {
                if !in_table {
                    return Err(parser.error("keys must be inside the [worktree] table"));
                }
                let key = parser.key()?;
                parser.blank();
                parser.expect('=')?;
                parser.blank();
                let value = parser.value()?;
                parser.line_end()?;
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
    pub setup: Phase,
    pub run: Option<Phase>,
    env_files: Vec<Copied>,
    pub archived_at: Option<u64>,
    pub discarded: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    approvals: Vec<Approval>,
    worktrees: Vec<Record>,
}

pub struct Store {
    path: PathBuf,
    document: Mutex<Document>,
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        use std::io::Read;
        let path = directory.join("worktrees.json");
        let mut document = match std::fs::File::open(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Document {
                version: 1,
                ..Document::default()
            },
            Err(error) => return Err(error.into()),
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(STORE_LIMIT + 1).read_to_end(&mut bytes)?;
                anyhow::ensure!(
                    bytes.len() as u64 <= STORE_LIMIT,
                    "Worktree registry is too large"
                );
                let document: Document = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(document.version == 1, "Unsupported worktree registry");
                document
            }
        };
        for record in &mut document.worktrees {
            for phase in std::iter::once(&mut record.setup).chain(record.run.as_mut()) {
                if phase.state == "running" {
                    phase.state = "interrupted".into();
                }
            }
        }
        Ok(Self {
            path,
            document: Mutex::new(document),
            active: Mutex::new(HashMap::new()),
        })
    }
    fn update<T>(&self, change: impl FnOnce(&mut Document) -> Result<T>) -> Result<T> {
        let mut document = self
            .document
            .lock()
            .map_err(|_| anyhow!("Worktree registry is unavailable"))?;
        let value = change(&mut document)?;
        let bytes = serde_json::to_vec_pretty(&*document)?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, &self.path)?;
        Ok(value)
    }
    fn read<T>(&self, view: impl FnOnce(&Document) -> T) -> Result<T> {
        let document = self
            .document
            .lock()
            .map_err(|_| anyhow!("Worktree registry is unavailable"))?;
        Ok(view(&document))
    }
    fn approved(&self, repository: &str, digest: &str) -> bool {
        self.read(|document| {
            document
                .approvals
                .iter()
                .any(|approval| approval.repository == repository && approval.digest == digest)
        })
        .unwrap_or(false)
    }
    fn approve(&self, repository: &str, digest: &str) -> Result<u64> {
        self.update(|document| {
            if let Some(existing) = document
                .approvals
                .iter()
                .find(|approval| approval.repository == repository && approval.digest == digest)
            {
                return Ok(existing.approved_at);
            }
            let approved_at = now();
            document.approvals.push(Approval {
                repository: repository.into(),
                digest: digest.into(),
                approved_at,
            });
            let excess = document.approvals.len().saturating_sub(APPROVAL_LIMIT);
            document.approvals.drain(..excess);
            Ok(approved_at)
        })
    }
    fn revoke(&self, repository: &str, digest: &str) -> Result<bool> {
        self.update(|document| {
            let before = document.approvals.len();
            document
                .approvals
                .retain(|approval| approval.repository != repository || approval.digest != digest);
            Ok(document.approvals.len() != before)
        })
    }
    fn insert(&self, record: Record) -> Result<()> {
        self.update(|document| {
            document.worktrees.push(record);
            while document.worktrees.len() > RECORD_LIMIT {
                let index = document
                    .worktrees
                    .iter()
                    .position(|record| record.archived_at.is_some())
                    .unwrap_or(0);
                document.worktrees.remove(index);
            }
            Ok(())
        })
    }
    fn modify(&self, session_id: &str, change: impl FnOnce(&mut Record)) -> Result<()> {
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
    }
    fn find(&self, session_id: &str) -> Option<Record> {
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
    fn running(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .map(|active| active.contains_key(session_id))
            .unwrap_or(true)
    }
}

struct Activity<'a> {
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

pub fn configure(directory: &Path) -> Result<()> {
    let store = Store::open(directory)?;
    STORE
        .set(store)
        .map_err(|_| anyhow!("Worktree registry is already configured"))
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

fn repository_key(root: &Path) -> String {
    display_path(&std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned()))
}

async fn head_config(root: &Path) -> Result<Option<Config>> {
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
    parse(&String::from_utf8(output.bytes).map_err(|_| anyhow!("{CONFIG_FILE} must be UTF-8"))?)
        .map(Some)
}

async fn plan_with(store: Option<&Store>, directory: &Path) -> Result<Plan> {
    let root = git::toplevel(directory).await.map_err(|_| {
        Failure::raise(
            Stage::Plan,
            "worktree_unconfirmed",
            "Inspect the repository before creating another worktree",
        )
    })?;
    let repository = repository_key(&root);
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
    kind: &'static str,
    payload: Value,
) {
    if let Some(log) = log {
        let _ = tokio::time::timeout(
            DRAIN_DEADLINE,
            log.append(vec![event_log::Observation {
                session_id: Some(session_id.into()),
                kind,
                at: now(),
                payload,
            }]),
        )
        .await;
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

async fn copy_env_files(
    root: &Path,
    worktree: &Path,
    files: &[String],
) -> Result<Vec<Copied>, String> {
    let mut copied = Vec::new();
    for file in files {
        let source = root.join(file);
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|_| format!("environment file {file} is missing in the source checkout"))?;
        if !metadata.is_file() || metadata.len() > ENV_FILE_BYTES {
            return Err(format!(
                "environment file {file} must be a regular file of at most {ENV_FILE_BYTES} bytes"
            ));
        }
        let target = worktree.join(file);
        if tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(format!(
                "environment file {file} would overwrite a checked-out path"
            ));
        }
        let bytes = tokio::fs::read(&source)
            .await
            .map_err(|_| format!("environment file {file} cannot be read"))?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| format!("environment file {file} has no writable folder"))?;
        }
        tokio::fs::write(&target, &bytes)
            .await
            .map_err(|_| format!("environment file {file} cannot be written"))?;
        copied.push(Copied {
            path: file.clone(),
            sha256: sha256(&bytes),
        });
    }
    Ok(copied)
}

async fn state_dir(worktree: &Path) -> std::io::Result<PathBuf> {
    let directory = worktree.join(STATE_DIR);
    tokio::fs::create_dir_all(&directory).await?;
    tokio::fs::write(directory.join(".gitignore"), "*\n").await?;
    Ok(directory)
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
    let started_at = now();
    let display = display_path(worktree);
    let Some(store) = store else {
        return Ok(None);
    };
    let branch = git::current_branch(worktree).await;
    let digest = plan.prepared.as_ref().map(|(_, digest)| digest.clone());
    let log_path = display_path(&worktree.join(STATE_DIR).join("setup.log"));
    store.insert(Record {
        session_id: session_id.into(),
        worktree: display.clone(),
        branch,
        repository: plan.repository.clone(),
        created_at: started_at,
        digest: digest.clone(),
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
    })?;
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
    store.modify(session_id, |record| {
        record.setup.state = result.into();
        record.setup.finished_at = Some(now());
        record.env_files = copied;
    })?;
    journal(
        log.as_ref(),
        session_id,
        "worktreePrepared",
        json!({"sessionId":session_id,"result":result,"log":log_path,"worktree":display,"digest":digest}),
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
    let copied = match copy_env_files(root, worktree, &config.env_files).await {
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

struct Log {
    file: tokio::fs::File,
    written: usize,
    truncated: bool,
}

impl Log {
    async fn create(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            file: tokio::fs::File::create(path).await?,
            written: 0,
            truncated: false,
        })
    }
    async fn write(&mut self, bytes: &[u8]) {
        let take = bytes.len().min(LOG_CONTENT_LIMIT - self.written);
        if take > 0 && self.file.write_all(&bytes[..take]).await.is_ok() {
            self.written += take;
        }
        self.truncated |= take < bytes.len();
    }
    async fn line(&mut self, text: &str) {
        self.write(format!("{text}\n").as_bytes()).await;
    }
    async fn finish(mut self) {
        if self.truncated {
            let _ = self
                .file
                .write_all(format!("\n[log truncated at {LOG_LIMIT} bytes]\n").as_bytes())
                .await;
        }
        let _ = self.file.flush().await;
    }
}

fn shell(step: &str) -> Result<tokio::process::Command> {
    #[cfg(windows)]
    {
        let executable = PathBuf::from(command_scope::system_root()?)
            .join("System32")
            .join("cmd.exe");
        let mut command = tokio::process::Command::new(executable);
        command
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{step}\""));
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg(step);
        Ok(command)
    }
}

fn private_variable(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name.starts_with("NESVO_") || name.starts_with("POCKET_")
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

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
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
    Exited(Option<i32>),
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
    let Ok(mut command) = shell(text) else {
        log.line("the platform shell is unavailable").await;
        return Outcome::Failed;
    };
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, _) in std::env::vars_os() {
        if private_variable(&name) {
            command.env_remove(name);
        }
    }
    command_scope::configure(&mut command);
    let Ok(child) = command.spawn() else {
        log.line("the step could not be started").await;
        return Outcome::Failed;
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
            return Outcome::Failed;
        }
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
            _ = poll.tick() => match owned.child.try_wait() {
                Ok(Some(status)) => {
                    owned.may_terminate = cfg!(windows);
                    break Ended::Exited(status.code());
                }
                Ok(None) => {}
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
    if !matches!(ended, Ended::Exited(_)) {
        let _ = tokio::time::timeout(DRAIN_DEADLINE, owned.child.wait()).await;
    }
    match ended {
        Ended::Exited(Some(0)) => Outcome::Passed,
        Ended::Exited(code) => {
            log.line(&format!(
                "step failed with exit code {}",
                code.map_or_else(|| "unknown".into(), |code| code.to_string())
            ))
            .await;
            Outcome::Failed
        }
        Ended::Lost => {
            log.line("the step exit could not be observed").await;
            Outcome::Failed
        }
        Ended::TimedOut => {
            log.line("the step timed out and was terminated").await;
            Outcome::TimedOut
        }
        Ended::Cancelled => {
            log.line("the step was cancelled and terminated").await;
            Outcome::Cancelled
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
    )
}

fn host_directory(value: &str) -> Result<PathBuf> {
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

fn valid_digest(digest: &str) -> Result<()> {
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
    let approved_at = store.approve(&repository, &current)?;
    if let Some(log) = log {
        log.observe(event_log::Observation {
            session_id: None,
            kind: "worktreeSetupApproved",
            at: now(),
            payload: json!({"repository":repository,"digest":current}),
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
    let revoked = store.revoke(&repository, &digest)?;
    if revoked && let Some(log) = log {
        log.observe(event_log::Observation {
            session_id: None,
            kind: "worktreeSetupRevoked",
            at: now(),
            payload: json!({"repository":repository,"digest":digest}),
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
    let config = read_worktree_config(&worktree)
        .await
        .map_err(|error| command_failure("worktree_config_invalid", error.to_string()))?
        .filter(|config| !config.run.is_empty())
        .ok_or_else(|| {
            command_failure(
                "worktree_run_unavailable",
                "nesvo.toml declares no run steps",
            )
        })?;
    let digest = config.digest();
    if !store.approved(&record.repository, &digest) {
        return Err(command_failure(
            "worktree_setup_unapproved",
            format!("This worktree's nesvo.toml digest {digest} is not approved"),
        ));
    }
    let cancel = store.begin(session_id)?;
    let activity = Activity {
        store,
        session_id: session_id.into(),
    };
    let log_path = display_path(&worktree.join(STATE_DIR).join("run.log"));
    store.modify(session_id, |record| {
        record.run = Some(Phase {
            state: "running".into(),
            log: Some(log_path.clone()),
            started_at: now(),
            finished_at: None,
        });
    })?;
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
        drop(activity);
        let result = outcome.name();
        let _ = store.modify(&session, |record| {
            if let Some(run) = &mut record.run {
                run.state = result.into();
                run.finished_at = Some(now());
            }
        });
        journal(
            log.as_ref(),
            &session,
            "worktreeRan",
            json!({"sessionId":session,"result":result,"log":log_path}),
        )
        .await;
    });
    Ok(
        json!({"type":"worktreeRunStarted","sessionId":session_id,"worktree":record.worktree,"log":started}),
    )
}

fn cancel(store: &Store, session_id: &str) -> Result<Value> {
    valid_session(session_id)?;
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
    store.modify(session_id, |record| {
        record.archived_at = Some(now());
        record.discarded = discarded;
    })?;
    let payload = json!({"sessionId":session_id,"worktree":record.worktree,"branch":record.branch,"discarded":discarded,"blockers":blockers,"branchDeleted":branch_deleted});
    journal(log, session_id, "worktreeArchived", payload.clone()).await;
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
        value["present"] = present.into();
        value["sessionLive"] = live(&record.session_id).into();
        value["active"] = store.running(&record.session_id).into();
        worktrees.push(value);
    }
    Ok(json!({"type":"worktreeRegistry","worktrees":worktrees}))
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
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let log = state.lock().ok().and_then(|state| state.event_log().ok());
    let result = match (STORE.get(), permit) {
        (_, None) => Err(command_failure("busy", "Worktree service is busy")),
        (None, _) => Err(command_failure(
            "unsupported",
            "The host worktree registry is unavailable",
        )),
        (Some(store), Some(_permit)) => match command {
            Command::DescribeWorktreeSetup { directory } => describe(store, &directory).await,
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
