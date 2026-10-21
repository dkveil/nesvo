use crate::{
    agent_context::{EDIT_HASH_LIMIT, Ledger, content_hash},
    git,
    launchers::Program,
    protocol::Command,
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
    time::timeout,
};

const REGISTRY_LIMIT: usize = 64;
const FETCH_DEADLINE: Duration = Duration::from_secs(120);
const TEXT_LIMIT: usize = 32 * 1024;
const OPERATION_TEXT_LIMIT: usize = 8192;
const PASTE_CHUNK: usize = 4096;
const TOOL_OUTPUT_LIMIT: usize = 64 * 1024;
const TOOL_ERROR_LIMIT: usize = 512;
const PROVENANCE_FILES: usize = 128;
const PROVENANCE_SESSIONS: usize = 8;
const LEDGER_SESSIONS: usize = 64;
const HASH_BUDGET: u64 = 64 * 1024 * 1024;
const TITLE_LIMIT: usize = 256;
const HEAD_REF: &str = "refs/nesvo/head";
const BASE_REF: &str = "refs/nesvo/base";
const PULL_FIELDS: &str = "number,title,state,headRefName,headRefOid,baseRefName,statusCheckRollup";
const PULL_SUMMARY: &str = r#"{number,title,state,headRefName,headRefOid,baseRefName,checks:([.statusCheckRollup[]? | if ((.conclusion // "") != "") then .conclusion elif ((.state // "") != "") then .state else "PENDING" end][:200])}"#;

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}

fn failure(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Failure {
        code,
        message: message.into(),
    }
    .into()
}

fn git_failure(error: anyhow::Error) -> anyhow::Error {
    failure("git_unavailable", error.to_string())
}

fn error_event(error: &anyhow::Error) -> Value {
    let (code, message) = if let Some(failure) = error.downcast_ref::<Failure>() {
        (failure.code, failure.message.clone())
    } else if let Some(error) = error.downcast_ref::<crate::api_error::Error>() {
        (error.code, error.to_string())
    } else {
        ("review_failed", error.to_string())
    };
    json!({"type":"error","code":code,"message":message})
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceRequest {
    Local {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        directory: Option<String>,
    },
    Pull {
        url: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pull {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl Pull {
    pub fn parse(value: &str) -> Result<Self> {
        let invalid = || {
            failure(
                "invalid_argument",
                "Use a https://github.com/OWNER/REPO/pull/NUMBER URL",
            )
        };
        if value.len() > 512 || value.chars().any(char::is_control) {
            return Err(invalid());
        }
        let url = url::Url::parse(value).map_err(|_| invalid())?;
        if url.scheme() != "https"
            || !matches!(url.host_str(), Some("github.com" | "www.github.com"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
        {
            return Err(invalid());
        }
        let segments: Vec<&str> = url
            .path_segments()
            .ok_or_else(invalid)?
            .filter(|segment| !segment.is_empty())
            .collect();
        let [owner, repo, "pull", number, rest @ ..] = segments.as_slice() else {
            return Err(invalid());
        };
        let owner_valid = (1..=39).contains(&owner.len())
            && owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let repo_valid = (1..=100).contains(&repo.len())
            && !matches!(*repo, "." | "..")
            && repo
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        let tail_valid = rest.len() <= 1
            && rest
                .first()
                .is_none_or(|tail| matches!(*tail, "files" | "commits" | "checks"));
        let number = (1..=10).contains(&number.len()) && number.bytes().all(|b| b.is_ascii_digit());
        let number = segments[3]
            .parse::<u64>()
            .ok()
            .filter(|value| number && *value > 0);
        match number {
            Some(number) if owner_valid && repo_valid && tail_valid => Ok(Self {
                owner: (*owner).into(),
                repo: (*repo).into(),
                number,
            }),
            _ => Err(invalid()),
        }
    }
    pub fn url(&self) -> String {
        format!(
            "https://github.com/{}/{}/pull/{}",
            self.owner, self.repo, self.number
        )
    }
    pub fn remote(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.repo)
    }
    pub fn slug(&self) -> String {
        format!("{}-{}-{}", self.owner, self.repo, self.number).to_ascii_lowercase()
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub directory: PathBuf,
    pub source: Value,
    pub session_id: Option<String>,
    pub base: Option<String>,
    pub base_label: Option<String>,
    pub head_ref: Option<String>,
    pub remote_head: Option<String>,
    pub checks: Option<Value>,
}

pub struct Registry {
    entries: VecDeque<Entry>,
    fetch: Arc<Semaphore>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            fetch: Arc::new(Semaphore::new(1)),
        }
    }
}

impl Registry {
    pub fn insert(&mut self, entry: Entry) {
        self.entries.retain(|current| current.id != entry.id);
        self.entries.push_back(entry);
        while self.entries.len() > REGISTRY_LIMIT {
            self.entries.pop_front();
        }
    }
    pub fn get(&self, id: &str) -> Option<Entry> {
        self.entries.iter().find(|entry| entry.id == id).cloned()
    }
    fn fetch_gate(&self) -> Arc<Semaphore> {
        self.fetch.clone()
    }
}

pub struct Target {
    pub agent: bool,
    pub running: bool,
    pub controller: Option<u64>,
    pub ready: bool,
    pub bracketed_paste: bool,
}

pub struct Delivery {
    pub review_id: String,
    pub session_id: String,
    pub text: String,
    pub key: Option<String>,
    pub lease_id: Option<String>,
}

struct DiffRequest {
    session_id: Option<String>,
    scope: String,
    directory: Option<String>,
    review_id: Option<String>,
    base: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

fn lock(state: &Mutex<State>) -> Result<MutexGuard<'_, State>> {
    state
        .lock()
        .map_err(|_| anyhow!("Host state is unavailable"))
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(failure("invalid_argument", "Invalid identifier"));
    }
    Ok(())
}

fn display(path: &Path) -> String {
    crate::process::display_path(path)
}

fn join(root: &Path, path: String) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn digest(parts: &[&str]) -> String {
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    for part in parts {
        context.update(part.as_bytes());
        context.update(b"\0");
    }
    hex::encode(context.finish().as_ref())
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    client: u64,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let mut event = match command {
        Command::GetDiff {
            session_id,
            scope,
            directory,
            review_id,
            base,
            from,
            to,
        } => {
            let held = permit;
            let request = DiffRequest {
                session_id,
                scope,
                directory,
                review_id,
                base,
                from,
                to,
            };
            diff_event(&state, request, held.is_some()).await
        }
        command => {
            let result = match permit {
                Some(_permit) => {
                    dispatch(&state, &events, client, request_id.as_deref(), command).await
                }
                None => Err(failure(
                    "busy",
                    "Another Git inspection or delivery is running on this connection",
                )),
            };
            result.unwrap_or_else(|error| error_event(&error))
        }
    };
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

async fn dispatch(
    state: &Arc<Mutex<State>>,
    events: &mpsc::Sender<PtyEvent>,
    client: u64,
    request_id: Option<&str>,
    command: Command,
) -> Result<Value> {
    match command {
        Command::OpenReview { source, base } => open(state, client, request_id, source, base).await,
        Command::ReviewContext { review_id } => context(state, &review_id).await,
        Command::DeliverReview {
            review_id,
            session_id,
            text,
            key,
            lease_id,
        } => {
            let request = Delivery {
                review_id,
                session_id,
                text,
                key,
                lease_id,
            };
            deliver(state, events, client, request).await
        }
        _ => Err(failure("invalid_argument", "Unsupported review command")),
    }
}

async fn diff_event(state: &Mutex<State>, request: DiffRequest, admitted: bool) -> Value {
    let mut event = json!({"type":"diff","sessionId":request.session_id});
    if let Some(review_id) = &request.review_id {
        event["reviewId"] = review_id.clone().into();
    }
    let result = if admitted {
        diff(state, request).await
    } else {
        Err(anyhow!("A Git inspection is already running."))
    };
    match result {
        Ok(review) => event["review"] = json!(review),
        Err(error) => event["error"] = error.to_string().into(),
    }
    event
}

async fn diff(state: &Mutex<State>, request: DiffRequest) -> Result<git::Review> {
    let pinned = request.directory.filter(|path| !path.is_empty());
    if let Some(path) = &pinned {
        ensure!(
            path.len() <= 4096 && !path.chars().any(char::is_control),
            "Invalid review folder"
        );
    }
    let (context, default_base) = match (&request.review_id, &request.session_id) {
        (Some(review_id), _) => {
            let entry = review_entry(state, review_id)?;
            let directory = match pinned {
                Some(path) => join(&entry.directory, path),
                None => entry.directory.clone(),
            };
            let context = crate::agent_context::Context {
                directory,
                source: "Review".into(),
            };
            (context, entry.base)
        }
        (None, Some(session_id)) => {
            let (session_dir, report) = {
                let host = lock(state)?;
                (
                    host.session_directory(session_id)?,
                    host.context_report(session_id),
                )
            };
            let context = match pinned {
                Some(path) => crate::agent_context::Context {
                    directory: join(&session_dir, path),
                    source: "Pinned".into(),
                },
                None => {
                    crate::agent_context::resolve(session_dir, report, Some(session_id.clone()))
                        .await
                }
            };
            (context, None)
        }
        (None, None) => return Err(anyhow!("A diff needs a sessionId or a reviewId")),
    };
    let base = if request.scope == "branch" {
        request.base.or(default_base)
    } else {
        request.base
    };
    let scope = git::Scope::parse(&request.scope, base, request.from, request.to)?;
    let mut review = git::review(&context.directory, &scope)
        .await
        .map_err(|error| {
            anyhow!(
                "{} · {}: {error}",
                context.source,
                context.directory.display()
            )
        })?;
    review.source = Some(context.source);
    Ok(review)
}

fn review_entry(state: &Mutex<State>, review_id: &str) -> Result<Entry> {
    valid_id(review_id)?;
    lock(state)?.reviews.get(review_id).ok_or_else(|| {
        failure(
            "review_not_found",
            "Review is not open on this host; open it again",
        )
    })
}

async fn open(
    state: &Arc<Mutex<State>>,
    client: u64,
    request_id: Option<&str>,
    source: SourceRequest,
    base: Option<String>,
) -> Result<Value> {
    if let Some(base) = &base {
        git::validate_ref(base).map_err(|_| failure("invalid_argument", "Invalid base ref"))?;
    }
    let entry = match source {
        SourceRequest::Local {
            session_id,
            directory,
        } => open_local(state, session_id, directory, base).await?,
        SourceRequest::Pull { url } => open_pull(state, client, request_id, &url, base).await?,
    };
    let event = opened_event(&entry).await?;
    let mut host = lock(state)?;
    host.reviews.insert(entry);
    broadcast(&host, client, &event);
    Ok(event)
}

fn broadcast(host: &State, origin: u64, event: &Value) {
    for (id, client) in &host.clients {
        if *id != origin && matches!(client.authority, crate::caller::Authority::Owner) {
            host.send(*id, event.clone());
        }
    }
}

fn progress(state: &Mutex<State>, client: u64, request_id: Option<&str>, stage: &str) {
    if let Ok(host) = state.lock() {
        let mut event = json!({"type":"reviewProgress","stage":stage});
        if let Some(request_id) = request_id {
            event["requestId"] = request_id.into();
        }
        host.send(client, event);
    }
}

async fn local_start(
    state: &Mutex<State>,
    session_id: Option<&str>,
    directory: Option<String>,
) -> Result<(PathBuf, String)> {
    let directory = directory.filter(|path| !path.is_empty());
    if directory
        .as_ref()
        .is_some_and(|path| path.len() > 4096 || path.chars().any(char::is_control))
    {
        return Err(failure("invalid_argument", "Invalid review folder"));
    }
    let Some(session_id) = session_id else {
        let path = directory
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| {
                failure(
                    "invalid_argument",
                    "A local review needs a sessionId or an absolute directory",
                )
            })?;
        return Ok((path, "Pinned".into()));
    };
    let (session_dir, report) = {
        let host = lock(state)?;
        let session_dir = host
            .session_directory(session_id)
            .map_err(|_| failure("session_not_found", "Session no longer exists"))?;
        (session_dir, host.context_report(session_id))
    };
    Ok(match directory {
        Some(path) => (join(&session_dir, path), "Pinned".into()),
        None => {
            let context =
                crate::agent_context::resolve(session_dir, report, Some(session_id.to_owned()))
                    .await;
            (context.directory, context.source)
        }
    })
}

async fn open_local(
    state: &Mutex<State>,
    session_id: Option<String>,
    directory: Option<String>,
    base: Option<String>,
) -> Result<Entry> {
    if let Some(session_id) = &session_id {
        valid_id(session_id)?;
    }
    let (start, label) = local_start(state, session_id.as_deref(), directory).await?;
    let root = git::toplevel(&start).await.map_err(|error| {
        failure(
            "git_unavailable",
            format!("{label} · {}: {error}", start.display()),
        )
    })?;
    local_entry(root, session_id, label, base).await
}

async fn local_entry(
    root: PathBuf,
    session_id: Option<String>,
    label: String,
    base: Option<String>,
) -> Result<Entry> {
    let base = match base {
        Some(base) => {
            git::resolve_commit(&root, &base)
                .await
                .map_err(|_| failure("invalid_argument", format!("Base {base} was not found")))?;
            Some(base)
        }
        None => git::default_base(&root).await,
    };
    let directory = display(&root);
    let id = digest(&[session_id.as_deref().unwrap_or_default(), &directory]);
    Ok(Entry {
        id: format!("local-{}", &id[..16]),
        source: json!({"kind":"local","sessionId":session_id,"context":label}),
        directory: root,
        session_id,
        base_label: base.clone(),
        base,
        head_ref: None,
        remote_head: None,
        checks: None,
    })
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    number: u64,
    title: String,
    state: String,
    head_ref_name: String,
    head_ref_oid: String,
    base_ref_name: String,
    #[serde(default)]
    checks: Vec<String>,
}

fn parse_metadata(pull: &Pull, bytes: &[u8]) -> Result<Metadata> {
    let unexpected = || {
        failure(
            "pull_unavailable",
            "GitHub returned unexpected pull request metadata",
        )
    };
    let mut metadata: Metadata = serde_json::from_slice(bytes).map_err(|_| unexpected())?;
    let plain = |value: &str| {
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    };
    if metadata.number != pull.number
        || !git::is_oid(&metadata.head_ref_oid)
        || git::validate_ref(&metadata.base_ref_name).is_err()
        || metadata.base_ref_name.contains(':')
        || !plain(&metadata.head_ref_name)
        || !plain(&metadata.state)
    {
        return Err(unexpected());
    }
    metadata.title = metadata
        .title
        .chars()
        .filter(|c| !c.is_control())
        .take(TITLE_LIMIT)
        .collect();
    metadata.checks.truncate(200);
    Ok(metadata)
}

pub fn checks_summary(states: &[String], head_oid: &str) -> Value {
    let (mut passed, mut failed, mut pending) = (0, 0, 0);
    for state in states {
        match state.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => passed += 1,
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => failed += 1,
            _ => pending += 1,
        }
    }
    json!({"headOid":head_oid,"total":states.len(),"passed":passed,"failed":failed,"pending":pending})
}

fn reviews_root() -> Result<PathBuf> {
    let config = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    };
    Ok(config
        .ok_or_else(|| failure("unsupported", "Cannot find a user configuration directory"))?
        .join("nesvo")
        .join("reviews"))
}

fn error_tail(bytes: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let chars: Vec<char> = text.trim().chars().collect();
    chars[chars.len().saturating_sub(TOOL_ERROR_LIMIT)..]
        .iter()
        .collect()
}

async fn tool(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    deadline: Instant,
) -> Result<Vec<u8>> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| {
        failure(
            "tool_unavailable",
            format!("{program} is not installed or not on PATH"),
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("{program} output is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("{program} errors are unavailable"))?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let (output, errors, status) = timeout(remaining, async {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let mut stdout = stdout.take(TOOL_OUTPUT_LIMIT as u64 + 1);
        let mut stderr = stderr.take(TOOL_OUTPUT_LIMIT as u64);
        let (read, failed) = tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        );
        read?;
        failed?;
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((output, errors, status))
    })
    .await
    .map_err(|_| {
        failure(
            "timeout",
            format!("{program} did not finish within the 120 s review deadline"),
        )
    })??;
    if output.len() > TOOL_OUTPUT_LIMIT {
        return Err(failure(
            "pull_unavailable",
            format!("{program} output exceeded the review limit"),
        ));
    }
    if !status.success() {
        return Err(failure(
            "pull_unavailable",
            format!("{program} failed: {}", error_tail(&errors)),
        ));
    }
    Ok(output)
}

async fn git_step(directory: &Path, args: &[&str], deadline: Instant) -> Result<Vec<u8>> {
    let mut full = vec!["--no-pager", "-c", "core.quotepath=false"];
    full.extend_from_slice(args);
    tool("git", &full, Some(directory), deadline).await
}

async fn pull_metadata(pull: &Pull, deadline: Instant) -> Result<Metadata> {
    let url = pull.url();
    let output = tool(
        "gh",
        &[
            "pr",
            "view",
            &url,
            "--json",
            PULL_FIELDS,
            "--jq",
            PULL_SUMMARY,
        ],
        None,
        deadline,
    )
    .await?;
    parse_metadata(pull, &output)
}

async fn initialize_checkout(directory: &Path, remote: &str, deadline: Instant) -> Result<()> {
    if let Ok(mut entries) = tokio::fs::read_dir(directory).await
        && entries.next_entry().await?.is_some()
    {
        return Err(failure(
            "conflict",
            format!(
                "{} exists and is not a review checkout; move it away",
                display(directory)
            ),
        ));
    }
    tokio::fs::create_dir_all(directory).await?;
    git_step(directory, &["init", "--quiet"], deadline).await?;
    git_step(directory, &["remote", "add", "origin", remote], deadline).await?;
    for (key, value) in [
        ("core.repositoryformatversion", "1"),
        ("extensions.partialClone", "origin"),
        ("remote.origin.promisor", "true"),
        ("remote.origin.partialclonefilter", "blob:none"),
        ("credential.helper", ""),
    ] {
        git_step(directory, &["config", key, value], deadline).await?;
    }
    git_step(
        directory,
        &[
            "config",
            "--add",
            "credential.helper",
            "!gh auth git-credential",
        ],
        deadline,
    )
    .await?;
    Ok(())
}

async fn fetch_pull(
    directory: &Path,
    pull: &Pull,
    metadata: &Metadata,
    deadline: Instant,
) -> Result<()> {
    let remote = pull.remote();
    if tokio::fs::metadata(directory.join(".git")).await.is_ok() {
        let current = git_step(
            directory,
            &["config", "--get", "remote.origin.url"],
            deadline,
        )
        .await?;
        if String::from_utf8_lossy(&current).trim() != remote {
            return Err(failure(
                "conflict",
                format!("{} belongs to another repository", display(directory)),
            ));
        }
    } else {
        initialize_checkout(directory, &remote, deadline).await?;
    }
    let head = format!("+refs/pull/{}/head:{HEAD_REF}", pull.number);
    let base = format!("+refs/heads/{}:{BASE_REF}", metadata.base_ref_name);
    git_step(
        directory,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            "--filter=blob:none",
            "origin",
            &head,
            &base,
        ],
        deadline,
    )
    .await?;
    Ok(())
}

async fn checkout_pull(directory: &Path, deadline: Instant) -> Result<()> {
    git_step(
        directory,
        &["checkout", "--quiet", "--detach", HEAD_REF],
        deadline,
    )
    .await
    .map_err(|error| {
        failure(
            "conflict",
            format!(
                "{error}; the review checkout at {} may have local changes",
                display(directory)
            ),
        )
    })?;
    if let Ok(merge_base) = git_step(directory, &["merge-base", BASE_REF, HEAD_REF], deadline).await
    {
        let merge_base = String::from_utf8_lossy(&merge_base).trim().to_owned();
        let _ = git_step(
            directory,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--shortstat",
                &merge_base,
                HEAD_REF,
            ],
            deadline,
        )
        .await;
    }
    Ok(())
}

async fn open_pull(
    state: &Mutex<State>,
    client: u64,
    request_id: Option<&str>,
    url: &str,
    base: Option<String>,
) -> Result<Entry> {
    let pull = Pull::parse(url)?;
    let gate = lock(state)?.reviews.fetch_gate();
    let _permit = gate.try_acquire_owned().map_err(|_| {
        failure(
            "busy",
            "Another pull request fetch is running; retry when it finishes",
        )
    })?;
    let deadline = Instant::now() + FETCH_DEADLINE;
    progress(state, client, request_id, "metadata");
    let metadata = pull_metadata(&pull, deadline).await?;
    let directory = reviews_root()?.join(pull.slug());
    progress(state, client, request_id, "fetch");
    fetch_pull(&directory, &pull, &metadata, deadline).await?;
    progress(state, client, request_id, "checkout");
    checkout_pull(&directory, deadline).await?;
    Ok(Entry {
        id: format!("pull-{}", pull.slug()),
        source: json!({"kind":"pull","url":pull.url(),"owner":pull.owner,"repo":pull.repo,"number":pull.number,"title":metadata.title,"state":metadata.state,"headRef":metadata.head_ref_name,"baseRef":metadata.base_ref_name,"headOid":metadata.head_ref_oid}),
        checks: Some(checks_summary(&metadata.checks, &metadata.head_ref_oid)),
        directory,
        session_id: None,
        base_label: Some(
            base.clone()
                .unwrap_or_else(|| metadata.base_ref_name.clone()),
        ),
        base: Some(base.unwrap_or_else(|| BASE_REF.into())),
        head_ref: Some(metadata.head_ref_name),
        remote_head: Some(metadata.head_ref_oid),
    })
}

async fn opened_event(entry: &Entry) -> Result<Value> {
    let head = git::head(&entry.directory).await.map_err(git_failure)?;
    let head_ref = match &entry.head_ref {
        Some(name) => Some(name.clone()),
        None => git::current_branch(&entry.directory).await,
    };
    let branch = match &entry.base {
        Some(base) => git::review(
            &entry.directory,
            &git::Scope::Branch {
                base: Some(base.clone()),
            },
        )
        .await
        .ok(),
        None => None,
    };
    let (scope, review) = match branch {
        Some(review) => ("branch", review),
        None => (
            "unstaged",
            git::review(&entry.directory, &git::Scope::Unstaged)
                .await
                .map_err(git_failure)?,
        ),
    };
    let base = review.base.as_ref().map(|base| {
        json!({"ref":entry.base_label.clone().unwrap_or_else(|| base.name.clone()),"oid":base.oid,"mergeBase":base.merge_base})
    });
    Ok(json!({
        "type":"reviewOpened","reviewId":entry.id,"directory":display(&entry.directory),"source":entry.source,
        "base":base,"head":{"ref":head_ref,"oid":head},"scope":scope,"revision":review.revision,"checks":entry.checks
    }))
}

pub struct SessionLedger {
    pub session_id: String,
    pub hooks: bool,
    pub ledger: Option<Ledger>,
}

async fn ledgers(state: &Mutex<State>, subject: Option<&str>) -> Result<Vec<SessionLedger>> {
    let mut reports = lock(state)?.context_reports();
    reports.sort_by_key(|(id, _, _)| Some(id.as_str()) != subject);
    let mut ledgers = Vec::new();
    for (session_id, program, report) in reports.into_iter().take(LEDGER_SESSIONS) {
        let hooks = program == Program::Claude && report.is_some();
        let ledger = match report {
            Some(report) if hooks => crate::agent_context::edit_ledger(&report).await,
            _ => None,
        };
        ledgers.push(SessionLedger {
            session_id,
            hooks,
            ledger,
        });
    }
    Ok(ledgers)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub path: String,
    pub hash: Option<String>,
    pub changed: bool,
}

fn comparable(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    }
}

fn relative(root: &str, path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let key = comparable(normalized);
    let rest = key.strip_prefix(&comparable(root))?.strip_prefix('/')?;
    normalized
        .get(normalized.len().checked_sub(rest.len())?..)
        .filter(|tail| !tail.is_empty())
        .map(str::to_owned)
}

fn candidates(
    root: &str,
    status: &git::Status,
    ledgers: &[SessionLedger],
    subject: Option<&str>,
) -> (BTreeMap<String, bool>, bool) {
    let mut paths: BTreeMap<String, bool> = BTreeMap::new();
    let mut truncated = status.truncated;
    for path in &status.paths {
        if paths.len() >= PROVENANCE_FILES {
            truncated = true;
            break;
        }
        paths.insert(path.clone(), true);
    }
    let edits = ledgers
        .iter()
        .filter(|session| Some(session.session_id.as_str()) == subject)
        .filter_map(|session| session.ledger.as_ref())
        .flat_map(|ledger| &ledger.edits);
    for edit in edits {
        let Some(path) = relative(root, &edit.path) else {
            continue;
        };
        if paths.contains_key(&path) {
            continue;
        }
        if paths.len() >= PROVENANCE_FILES {
            truncated = true;
            break;
        }
        paths.insert(path, false);
    }
    (paths, truncated)
}

async fn observe(root: &Path, paths: BTreeMap<String, bool>) -> Vec<Observed> {
    let mut budget = HASH_BUDGET;
    let mut observed = Vec::new();
    for (path, changed) in paths {
        let file = root.join(&path);
        let size = tokio::fs::symlink_metadata(&file)
            .await
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let hash = match size {
            Some(size) if size <= EDIT_HASH_LIMIT && size <= budget => {
                budget -= size;
                tokio::task::spawn_blocking(move || content_hash(&file, EDIT_HASH_LIMIT))
                    .await
                    .ok()
                    .flatten()
            }
            _ => None,
        };
        observed.push(Observed {
            path,
            hash,
            changed,
        });
    }
    observed
}

pub fn worktree_revision(status: &git::Status, observed: &[Observed]) -> String {
    let head = status.head.as_deref().unwrap_or("unborn");
    let counts = format!(
        "{}:{}:{}:{}",
        status.staged, status.unstaged, status.untracked, status.conflicted
    );
    let mut parts = vec![
        head,
        status.branch.as_deref().unwrap_or_default(),
        counts.as_str(),
    ];
    for file in observed.iter().filter(|file| file.changed) {
        parts.push(&file.path);
        parts.push(file.hash.as_deref().unwrap_or("unread"));
    }
    format!("{}-{}", &head[..head.len().min(12)], &digest(&parts)[..16])
}

struct Record<'a> {
    session: &'a str,
    edit: &'a crate::agent_context::Edit,
    current_turn: bool,
}

pub fn attribute(
    root: &str,
    observed: &[Observed],
    ledgers: &[SessionLedger],
    subject: &str,
) -> Vec<Value> {
    let mut records: HashMap<String, Vec<Record>> = HashMap::new();
    for session in ledgers {
        let Some(ledger) = &session.ledger else {
            continue;
        };
        for edit in &ledger.edits {
            records
                .entry(comparable(&edit.path))
                .or_default()
                .push(Record {
                    session: &session.session_id,
                    edit,
                    current_turn: ledger.complete && edit.turn == ledger.turns,
                });
        }
    }
    let root = comparable(root);
    observed
        .iter()
        .map(|file| {
            let found = records
                .get(&format!("{root}/{}", comparable(&file.path)))
                .map(Vec::as_slice)
                .unwrap_or_default();
            let latest = found.iter().max_by_key(|record| record.edit.at);
            let mut sessions: Vec<&str> = found.iter().map(|record| record.session).collect();
            sessions.sort_unstable();
            sessions.dedup();
            sessions.truncate(PROVENANCE_SESSIONS);
            let attribution = match latest {
                None => "unattributed",
                Some(record) if record.edit.hash.is_some() && record.edit.hash == file.hash => {
                    if record.session == subject {
                        "agent"
                    } else {
                        "otherAgent"
                    }
                }
                Some(_) => "uncertain",
            };
            json!({
                "path":file.path,"changed":file.changed,"attribution":attribution,
                "thisTurn":attribution == "agent" && latest.is_some_and(|record| record.current_turn),
                "subagent":latest.is_some_and(|record| record.edit.subagent),
                "sessions":sessions,"editedAt":latest.map(|record| record.edit.at)
            })
        })
        .collect()
}

pub async fn inspect(entry: &Entry, ledgers: &[SessionLedger]) -> Result<Value> {
    let mut readiness = git::readiness(
        &entry.directory,
        entry.base.as_deref(),
        entry.remote_head.as_deref(),
    )
    .await
    .map_err(git_failure)?;
    let root = display(&entry.directory);
    let subject = entry.session_id.as_deref();
    let (paths, mut truncated) = candidates(&root, &readiness.status, ledgers, subject);
    let observed = observe(&entry.directory, paths).await;
    readiness.worktree_revision = worktree_revision(&readiness.status, &observed);
    let subject_ledger = ledgers
        .iter()
        .find(|session| Some(session.session_id.as_str()) == subject);
    let evidence = match (subject, subject_ledger) {
        (None, _) => "notSession",
        (Some(_), Some(session)) if session.hooks => "hooks",
        _ => "unavailable",
    };
    let mut files = match subject {
        Some(subject) => attribute(&root, &observed, ledgers, subject),
        None => Vec::new(),
    };
    let ledger = subject_ledger.and_then(|session| session.ledger.as_ref());
    let mut provenance = json!({
        "evidence":evidence,"sessionId":subject,"turn":ledger.map(|ledger| ledger.turns),
        "complete":ledger.is_none_or(|ledger| ledger.complete)
    });
    let checks = entry.checks.clone().map(|mut checks| {
        checks["current"] = (readiness.status.head.as_deref() == checks["headOid"].as_str()).into();
        checks
    });
    let mut event = json!({"type":"reviewContext","reviewId":entry.id,"directory":root,"readiness":readiness,"provenance":null,"checks":checks});
    loop {
        provenance["files"] = json!(files);
        provenance["truncated"] = truncated.into();
        event["provenance"] = provenance.clone();
        if files.is_empty()
            || serde_json::to_vec(&event)?.len() <= crate::wire::MAX_PLAINTEXT - 4096
        {
            break;
        }
        files.pop();
        truncated = true;
    }
    Ok(event)
}

async fn context(state: &Mutex<State>, review_id: &str) -> Result<Value> {
    let entry = review_entry(state, review_id)?;
    let ledgers = ledgers(state, entry.session_id.as_deref()).await?;
    inspect(&entry, &ledgers).await
}

pub fn validate_text(text: &str) -> Result<()> {
    if text.trim().is_empty()
        || text.len() > TEXT_LIMIT
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(failure(
            "invalid_argument",
            "Review text must be nonempty UTF-8, at most 32768 bytes, without terminal controls",
        ));
    }
    Ok(())
}

pub fn check_target(target: &Target, text: &str) -> Result<()> {
    if !target.agent {
        return Err(failure(
            "unsupported",
            "Review delivery targets agent sessions, not shells",
        ));
    }
    if !target.running {
        return Err(failure("process_exited", "Process has exited"));
    }
    if !target.ready {
        return Err(failure(
            "agent_not_ready",
            "Agent must be ready and idle before review delivery",
        ));
    }
    if !target.bracketed_paste && text.contains(['\n', '\r', '\t']) {
        return Err(failure(
            "paste_unsupported",
            "Multiline review text needs provider bracketed-paste support",
        ));
    }
    Ok(())
}

fn delivery_key(request: &Delivery) -> String {
    let id = digest(&[&request.review_id, &request.session_id, &request.text]);
    format!("review-{}", &id[..32])
}

pub fn paste_chunks(text: &str, bracketed: bool) -> Vec<String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let data = if bracketed {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text
    };
    let chars: Vec<char> = data.chars().collect();
    chars
        .chunks(PASTE_CHUNK)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

async fn deliver(
    state: &Arc<Mutex<State>>,
    events: &mpsc::Sender<PtyEvent>,
    client: u64,
    request: Delivery,
) -> Result<Value> {
    valid_id(&request.session_id)?;
    if let Some(key) = &request.key {
        valid_id(key)?;
    }
    validate_text(&request.text)?;
    review_entry(state, &request.review_id)?;
    let target = lock(state)?
        .delivery_target(&request.session_id)
        .ok_or_else(|| failure("session_not_found", "Session no longer exists"))?;
    check_target(&target, &request.text)?;
    match target.controller {
        Some(holder) if holder == client => {
            paste(state, events, client, &request, target.bracketed_paste)
        }
        Some(_) => Err(failure(
            "control_busy",
            "Another client holds control of this session; deliver from that client or release control",
        )),
        None => submit(state, client, request).await,
    }
}

fn paste(
    state: &Mutex<State>,
    events: &mpsc::Sender<PtyEvent>,
    client: u64,
    request: &Delivery,
    bracketed: bool,
) -> Result<Value> {
    let chunks = paste_chunks(&request.text, bracketed);
    let written: usize = chunks.iter().map(String::len).sum();
    let mut host = lock(state)?;
    for data in chunks {
        let input = Command::Input {
            session_id: request.session_id.clone(),
            data,
            lease_id: request.lease_id.clone(),
        };
        host.command(client, input, None, events)
            .map_err(|error| failure("control_required", error.to_string()))?;
    }
    let receipt = json!({
        "id":hex::encode(crate::wire::random::<16>()),"operation":"paste","phase":"pasted",
        "sessionId":request.session_id,"result":{"bytes":written,"submitted":false}
    });
    Ok(json!({
        "type":"reviewDelivered","reviewId":request.review_id,"sessionId":request.session_id,
        "path":"paste","key":null,"bytes":request.text.len(),"receipt":receipt
    }))
}

async fn submit(state: &Arc<Mutex<State>>, client: u64, request: Delivery) -> Result<Value> {
    if request.text.len() > OPERATION_TEXT_LIMIT {
        return Err(failure(
            "too_large",
            "Without a control lease review text is limited to 8192 bytes; deliver from the client holding control for up to 32768 bytes",
        ));
    }
    let (log, issuer, authority) = {
        let host = lock(state)?;
        (
            host.event_log()?,
            host.operation_caller(client)?.0,
            host.operation_authority(client)?,
        )
    };
    let key = request
        .key
        .clone()
        .unwrap_or_else(|| delivery_key(&request));
    let bytes = request.text.len();
    let receipt = crate::operations::send(
        state.clone(),
        log,
        issuer,
        key.clone(),
        request.session_id.clone(),
        request.text,
        authority,
    )
    .await
    .map_err(|error| {
        if error.downcast_ref::<crate::api_error::Error>().is_some() {
            error
        } else {
            failure(
                "operation_unconfirmed",
                "Delivery outcome is unconfirmed; retry with the same key",
            )
        }
    })?;
    Ok(json!({
        "type":"reviewDelivered","reviewId":request.review_id,"sessionId":request.session_id,
        "path":"operation","key":key,"bytes":bytes,"receipt":receipt
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_context::Edit;

    fn code(error: anyhow::Error) -> &'static str {
        error
            .downcast_ref::<Failure>()
            .map_or("other", |failure| failure.code)
    }
    fn entry(id: &str) -> Entry {
        Entry {
            id: id.into(),
            directory: PathBuf::from(id),
            source: json!({"kind":"local"}),
            session_id: None,
            base: None,
            base_label: None,
            head_ref: None,
            remote_head: None,
            checks: None,
        }
    }
    fn edit(path: &str, hash: Option<&str>, at: i64, turn: u32) -> Edit {
        Edit {
            path: path.into(),
            hash: hash.map(str::to_owned),
            at,
            turn,
            subagent: false,
        }
    }
    fn observed(path: &str, hash: Option<&str>, changed: bool) -> Observed {
        Observed {
            path: path.into(),
            hash: hash.map(str::to_owned),
            changed,
        }
    }
    async fn git(path: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn pull_sources_accept_only_strict_github_pull_links() {
        let pull = Pull::parse("https://github.com/Octo-Org/my.repo_1/pull/42/files").unwrap();
        assert_eq!(
            pull,
            Pull {
                owner: "Octo-Org".into(),
                repo: "my.repo_1".into(),
                number: 42
            }
        );
        assert_eq!(pull.slug(), "octo-org-my.repo_1-42");
        assert_eq!(pull.url(), "https://github.com/Octo-Org/my.repo_1/pull/42");
        assert_eq!(pull.remote(), "https://github.com/Octo-Org/my.repo_1.git");
        assert!(Pull::parse("https://github.com/a/b/pull/7#discussion_r1").is_ok());
        for bad in [
            "http://github.com/a/b/pull/1",
            "https://gitlab.com/a/b/pull/1",
            "https://user@github.com/a/b/pull/1",
            "https://github.com:8443/a/b/pull/1",
            "https://github.com/a/b/pull/1?diff=split",
            "https://github.com/a/b/issues/1",
            "https://github.com/a/b/pull/0",
            "https://github.com/a/b/pull/+1",
            "https://github.com/a/b/pull/12345678901",
            "https://github.com/a_b/c/pull/1",
            "https://github.com/a/b/pull/1/merge",
            "https://github.com/a/b/pull/1/files/extra",
            "https://github.com/a/b/pull/1\n",
        ] {
            assert_eq!(
                code(Pull::parse(bad).unwrap_err()),
                "invalid_argument",
                "{bad}"
            );
        }
    }

    #[test]
    fn open_requests_are_strict_tagged_sources() {
        let command: Command = serde_json::from_value(json!({"type":"openReview","source":{"kind":"pull","url":"https://github.com/a/b/pull/1"},"base":"main"})).unwrap();
        assert!(matches!(
            command,
            Command::OpenReview {
                source: SourceRequest::Pull { .. },
                base: Some(_)
            }
        ));
        let command: Command = serde_json::from_value(
            json!({"type":"openReview","source":{"kind":"local","sessionId":"s"}}),
        )
        .unwrap();
        assert!(matches!(
            command,
            Command::OpenReview {
                source: SourceRequest::Local {
                    session_id: Some(_),
                    directory: None
                },
                base: None
            }
        ));
        for bad in [
            json!({"type":"openReview","source":{"kind":"pull","url":"u","owner":"x"}}),
            json!({"type":"openReview","source":{"kind":"remote"}}),
            json!({"type":"openReview"}),
            json!({"type":"deliverReview","reviewId":"r","sessionId":"s"}),
        ] {
            assert!(serde_json::from_value::<Command>(bad).is_err());
        }
    }

    #[test]
    fn registry_replaces_reopened_reviews_and_stays_bounded() {
        let mut registry = Registry::default();
        registry.insert(entry("first"));
        let mut reopened = entry("first");
        reopened.base = Some("main".into());
        registry.insert(reopened);
        assert_eq!(registry.get("first").unwrap().base.as_deref(), Some("main"));
        for index in 0..REGISTRY_LIMIT {
            registry.insert(entry(&format!("review-{index}")));
        }
        assert!(registry.get("first").is_none());
        assert!(registry.get("review-0").is_some());
        assert_eq!(registry.entries.len(), REGISTRY_LIMIT);
    }

    #[test]
    fn paths_compare_across_separators_and_stay_inside_the_root() {
        assert_eq!(
            relative("C:/work/repo", r"C:\work\repo\src\main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            relative("/work/repo", "/work/repo/a b.txt").as_deref(),
            Some("a b.txt")
        );
        assert_eq!(relative("/work/repo", "/work/repository/file"), None);
        assert_eq!(relative("/work/repo", "/work/repo"), None);
        assert_eq!(relative("/work/repo", "/elsewhere/file"), None);
        assert_eq!(comparable(r"\\?\C:\x\"), comparable("C:/x"));
    }

    #[test]
    fn provenance_separates_verified_agent_other_session_uncertain_and_unattributed_files() {
        let root = "/repo";
        let mine = SessionLedger {
            session_id: "mine".into(),
            hooks: true,
            ledger: Some(Ledger {
                edits: vec![
                    edit("/repo/agent.rs", Some("h1"), 10, 0),
                    edit("/repo/current.rs", Some("h2"), 20, 1),
                    edit("/repo/manual.rs", Some("old"), 30, 1),
                    edit("/repo/shared.rs", Some("first"), 40, 1),
                    edit("/repo/large.bin", None, 50, 1),
                ],
                turns: 1,
                complete: true,
            }),
        };
        let other = SessionLedger {
            session_id: "other".into(),
            hooks: true,
            ledger: Some(Ledger {
                edits: vec![edit("/repo/shared.rs", Some("second"), 45, 3)],
                turns: 3,
                complete: true,
            }),
        };
        let files = [
            observed("agent.rs", Some("h1"), true),
            observed("current.rs", Some("h2"), false),
            observed("manual.rs", Some("new"), true),
            observed("shared.rs", Some("second"), true),
            observed("large.bin", None, true),
            observed("human.rs", Some("x"), true),
        ];
        let ledgers = [mine, other];
        let result = attribute(root, &files, &ledgers, "mine");
        let summary: Vec<_> = result
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap(),
                    file["attribution"].as_str().unwrap(),
                    file["thisTurn"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("agent.rs", "agent", false),
                ("current.rs", "agent", true),
                ("manual.rs", "uncertain", false),
                ("shared.rs", "otherAgent", false),
                ("large.bin", "uncertain", false),
                ("human.rs", "unattributed", false)
            ]
        );
        assert_eq!(result[3]["sessions"], json!(["mine", "other"]));
        assert_eq!(result[5]["editedAt"], Value::Null);
        let mut incomplete = ledgers;
        incomplete[0].ledger.as_mut().unwrap().complete = false;
        assert_eq!(
            attribute(root, &files[1..2], &incomplete, "mine")[0]["thisTurn"],
            false
        );
    }

    #[test]
    fn worktree_revision_changes_with_content_but_not_with_unchanged_ledger_files() {
        let status = git::Status {
            head: Some("a".repeat(40)),
            unstaged: 1,
            ..git::Status::default()
        };
        let base = worktree_revision(&status, &[observed("a.rs", Some("1"), true)]);
        assert_eq!(
            base,
            worktree_revision(
                &status,
                &[
                    observed("a.rs", Some("1"), true),
                    observed("clean.rs", Some("9"), false)
                ]
            )
        );
        assert_ne!(
            base,
            worktree_revision(&status, &[observed("a.rs", Some("2"), true)])
        );
        assert!(base.starts_with("aaaaaaaaaaaa-"));
    }

    #[test]
    fn delivery_refuses_unbounded_text_and_unready_targets_with_specific_codes() {
        validate_text("Fix src/main.rs:3\n\tthe guard").unwrap();
        let long = "x".repeat(TEXT_LIMIT + 1);
        for bad in ["", "  \n", "\u{1b}[201~", long.as_str()] {
            assert_eq!(code(validate_text(bad).unwrap_err()), "invalid_argument");
        }
        let ready = || Target {
            agent: true,
            running: true,
            controller: None,
            ready: true,
            bracketed_paste: true,
        };
        check_target(&ready(), "a\nb").unwrap();
        for (target, expected) in [
            (
                Target {
                    agent: false,
                    ..ready()
                },
                "unsupported",
            ),
            (
                Target {
                    running: false,
                    ..ready()
                },
                "process_exited",
            ),
            (
                Target {
                    ready: false,
                    ..ready()
                },
                "agent_not_ready",
            ),
            (
                Target {
                    bracketed_paste: false,
                    ..ready()
                },
                "paste_unsupported",
            ),
        ] {
            assert_eq!(code(check_target(&target, "a\nb").unwrap_err()), expected);
        }
        check_target(
            &Target {
                bracketed_paste: false,
                ..ready()
            },
            "single line",
        )
        .unwrap();
        let request = Delivery {
            review_id: "r".into(),
            session_id: "s".into(),
            text: "t".into(),
            key: None,
            lease_id: None,
        };
        let key = delivery_key(&request);
        assert_eq!(key, delivery_key(&request));
        assert!(key.len() <= 128 && key.starts_with("review-"));
    }

    #[test]
    fn paste_chunks_keep_text_and_brackets_within_input_limits() {
        let text = "é".repeat(PASTE_CHUNK * 2) + "\r\nend";
        let chunks = paste_chunks(&text, true);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.chars().count() <= PASTE_CHUNK)
        );
        assert!(chunks.iter().all(|chunk| chunk.len() <= 32 * 1024));
        let joined = chunks.concat();
        assert!(joined.starts_with("\u{1b}[200~") && joined.ends_with("\nend\u{1b}[201~"));
        assert_eq!(paste_chunks("plain", false), ["plain"]);
    }

    #[test]
    fn pull_metadata_is_validated_and_checks_are_bound_to_the_head() {
        let pull = Pull::parse("https://github.com/a/b/pull/5").unwrap();
        let oid = "c".repeat(40);
        let valid = json!({"number":5,"title":"Fix\u{7}","state":"OPEN","headRefName":"feature","headRefOid":oid,"baseRefName":"main","checks":["SUCCESS","FAILURE","PENDING","SKIPPED"]});
        let metadata = parse_metadata(&pull, valid.to_string().as_bytes()).unwrap();
        assert_eq!(metadata.title, "Fix");
        let summary = checks_summary(&metadata.checks, &metadata.head_ref_oid);
        assert_eq!(
            summary,
            json!({"headOid":oid,"total":4,"passed":2,"failed":1,"pending":1})
        );
        for (field, value) in [
            ("number", json!(6)),
            ("headRefOid", json!("short")),
            ("baseRefName", json!("--upload-pack=x")),
            ("baseRefName", json!("a:b")),
            ("headRefName", json!("")),
        ] {
            let mut bad = valid.clone();
            bad[field] = value;
            assert_eq!(
                code(parse_metadata(&pull, bad.to_string().as_bytes()).unwrap_err()),
                "pull_unavailable"
            );
        }
    }

    #[tokio::test]
    async fn local_review_opens_with_a_branch_revision_and_reports_readiness() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-review-session-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "-q", "-b", "main"]).await;
        git(&path, &["config", "user.name", "Nesvo Test"]).await;
        git(&path, &["config", "user.email", "test@example.invalid"]).await;
        std::fs::write(path.join("a.txt"), "a\n").unwrap();
        git(&path, &["add", "."]).await;
        git(
            &path,
            &["-c", "core.hooksPath=", "commit", "-q", "-m", "base"],
        )
        .await;
        git(&path, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(path.join("a.txt"), "changed\n").unwrap();
        let root = git::toplevel(&path).await.unwrap();
        let mut entry = local_entry(root.clone(), Some("mine".into()), "Pinned".into(), None)
            .await
            .unwrap();
        assert_eq!(entry.base.as_deref(), Some("main"));
        assert!(entry.id.starts_with("local-") && entry.id.len() == 22);
        let again = local_entry(root.clone(), Some("mine".into()), "Pinned".into(), None)
            .await
            .unwrap();
        assert_eq!(entry.id, again.id);
        let opened = opened_event(&entry).await.unwrap();
        assert_eq!(opened["scope"], "branch");
        assert_eq!(opened["base"]["ref"], "main");
        assert_eq!(opened["head"]["ref"], "feature");
        assert!(opened["revision"].as_str().unwrap().contains('-'));
        let edited = path.join("a.txt");
        let ledgers = [SessionLedger {
            session_id: "mine".into(),
            hooks: true,
            ledger: Some(Ledger {
                edits: vec![edit(
                    &edited.display().to_string(),
                    content_hash(&edited, EDIT_HASH_LIMIT).as_deref(),
                    1,
                    0,
                )],
                turns: 0,
                complete: true,
            }),
        }];
        let context = inspect(&entry, &ledgers).await.unwrap();
        assert_eq!(context["type"], "reviewContext");
        assert_eq!(context["readiness"]["unstaged"], 1);
        assert_eq!(
            context["readiness"]["blockers"],
            json!(["dirty", "unpushed"])
        );
        assert_eq!(context["provenance"]["evidence"], "hooks");
        assert_eq!(context["provenance"]["files"][0]["path"], "a.txt");
        assert_eq!(context["provenance"]["files"][0]["attribution"], "agent");
        assert_eq!(context["provenance"]["files"][0]["thisTurn"], true);
        let first = context["readiness"]["worktreeRevision"].clone();
        std::fs::write(&edited, "human\n").unwrap();
        let changed = inspect(&entry, &ledgers).await.unwrap();
        assert_ne!(changed["readiness"]["worktreeRevision"], first);
        assert_eq!(
            changed["provenance"]["files"][0]["attribution"],
            "uncertain"
        );
        entry.session_id = None;
        let unbound = inspect(&entry, &ledgers).await.unwrap();
        assert_eq!(unbound["provenance"]["evidence"], "notSession");
        assert!(
            local_entry(root, None, "Pinned".into(), Some("missing".into()))
                .await
                .is_err()
        );
        std::fs::remove_dir_all(&path).unwrap();
    }

    #[tokio::test]
    #[ignore = "network: fetches a public GitHub pull request with gh"]
    async fn live_pull_request_fetch_creates_and_reuses_a_partial_review_checkout() {
        let pull = Pull::parse("https://github.com/octocat/Hello-World/pull/1").unwrap();
        let deadline = Instant::now() + FETCH_DEADLINE;
        let metadata = pull_metadata(&pull, deadline).await.unwrap();
        let directory = reviews_root().unwrap().join(pull.slug());
        assert!(!directory.exists());
        for _ in 0..2 {
            fetch_pull(&directory, &pull, &metadata, deadline)
                .await
                .unwrap();
            checkout_pull(&directory, deadline).await.unwrap();
        }
        let entry = Entry {
            id: format!("pull-{}", pull.slug()),
            directory: directory.clone(),
            source: json!({"kind":"pull"}),
            session_id: None,
            base: Some(BASE_REF.into()),
            base_label: Some(metadata.base_ref_name.clone()),
            head_ref: Some(metadata.head_ref_name.clone()),
            remote_head: Some(metadata.head_ref_oid.clone()),
            checks: Some(checks_summary(&metadata.checks, &metadata.head_ref_oid)),
        };
        let opened = opened_event(&entry).await.unwrap();
        assert_eq!(opened["head"]["oid"], metadata.head_ref_oid.as_str());
        assert_eq!(opened["scope"], "branch");
        assert_eq!(opened["base"]["ref"], "master");
        let context = inspect(&entry, &[]).await.unwrap();
        assert_eq!(context["readiness"]["pushed"], true);
        assert_eq!(context["readiness"]["clean"], true);
        assert_eq!(context["checks"]["current"], true);
        let diff = git::review(
            &directory,
            &git::Scope::Branch {
                base: Some(BASE_REF.into()),
            },
        )
        .await
        .unwrap();
        assert!(!diff.files.is_empty());
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
