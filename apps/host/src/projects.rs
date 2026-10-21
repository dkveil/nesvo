use crate::{caller::Authority, process::display_path, protocol::Command, sessions::State};
use anyhow::{Context as _, Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, mpsc};

pub(crate) const PROJECT_LIMIT: usize = 256;
pub(crate) const PIN_LIMIT: usize = 64;
const FOLDER_LIMIT: usize = 8;
const SESSION_LIMIT: usize = 64;
const QUEUE: usize = 256;
const BATCH: usize = 64;
const SEEN_LIMIT: usize = 4096;
const LAYOUT_CHARS: usize = 40;
const NAME_BYTES: usize = 128;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

static SERVICE: OnceLock<Service> = OnceLock::new();

struct Service {
    store: Arc<Mutex<Store>>,
    observations: mpsc::Sender<Observation>,
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub root: String,
    pub name: String,
    pub branch: Option<String>,
    pub folder: Option<String>,
    pub session_id: Option<String>,
    pub at: u64,
}

pub(crate) struct Launch<'a, I> {
    pub root: &'a str,
    pub name: &'a str,
    pub branch: Option<&'a str>,
    pub folder: &'a Path,
    pub sessions: I,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveSession {
    pub id: String,
    pub directory: String,
    pub root: Option<String>,
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub root: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub pinned: bool,
    pub last_activity: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Project {
    pub root: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub last_activity_at: u64,
    pub pinned: bool,
    pub open_sessions: usize,
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Folder {
    pub folder: String,
    pub launches: u64,
    pub last_launch_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Defaults {
    pub root: String,
    pub name: String,
    pub default_layout: Option<String>,
    pub folders: Vec<Folder>,
}

impl Defaults {
    pub(crate) fn launch_folder(&self) -> &str {
        self.folders
            .first()
            .map_or(self.root.as_str(), |folder| folder.folder.as_str())
    }
}

pub(crate) fn same_path(left: &str, right: &str) -> bool {
    comparable(left) == comparable(right)
}

fn comparable(path: &str) -> String {
    let separators = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_owned()
    };
    let trimmed = separators.trim_end_matches(['\\', '/']);
    let kept = if trimmed.is_empty() {
        separators.as_str()
    } else {
        trimmed
    };
    if cfg!(windows) {
        kept.to_lowercase()
    } else {
        kept.to_owned()
    }
}

fn inside(directory: &str, root: &str) -> bool {
    let directory = comparable(directory);
    let root = comparable(root);
    directory == root
        || directory
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
}

fn base_name(root: &str) -> String {
    let name = Path::new(root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(root);
    let mut end = name.len().min(NAME_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_owned()
}

fn millis(value: u64) -> i64 {
    i64::try_from(value.min(MAX_SAFE)).unwrap_or(0)
}

fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0).min(MAX_SAFE)
}

pub(crate) struct Store {
    connection: Connection,
    seen: HashSet<(String, String)>,
}

impl Store {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).context("Could not open the project registry")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        Self::with(connection)
    }

    pub(crate) fn with(connection: Connection) -> Result<Self> {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projects')",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            present,
            "The project registry schema is missing; open the journal first"
        );
        Ok(Self {
            connection,
            seen: HashSet::new(),
        })
    }

    pub(crate) fn record_all(&mut self, observations: &[Observation]) -> Result<()> {
        let mut launches = Vec::with_capacity(observations.len());
        for observation in observations {
            let launch = match (&observation.session_id, &observation.folder) {
                (Some(session), Some(folder)) => {
                    if self.seen.len() >= SEEN_LIMIT {
                        self.seen.clear();
                    }
                    self.seen.insert((session.clone(), folder.clone()))
                }
                (None, Some(_)) => true,
                _ => false,
            };
            launches.push(launch);
        }
        let transaction = self.connection.transaction()?;
        for (observation, launch) in observations.iter().zip(launches) {
            let at = millis(observation.at);
            transaction.execute(
                "INSERT INTO projects(root,name,default_branch,first_seen_ms,last_activity_ms) VALUES(?1,?2,?3,?4,?4)
                 ON CONFLICT(root) DO UPDATE SET name=excluded.name,
                 default_branch=coalesce(excluded.default_branch,projects.default_branch),
                 last_activity_ms=max(projects.last_activity_ms,excluded.last_activity_ms)",
                params![observation.root, observation.name, observation.branch, at],
            )?;
            if let (true, Some(folder)) = (launch, &observation.folder) {
                transaction.execute(
                    "INSERT INTO project_folders(root,folder,launches,last_launch_ms) VALUES(?1,?2,1,?3)
                     ON CONFLICT(root,folder) DO UPDATE SET launches=min(project_folders.launches+1,?4),
                     last_launch_ms=max(project_folders.last_launch_ms,excluded.last_launch_ms)",
                    params![observation.root, folder, at, millis(MAX_SAFE)],
                )?;
                transaction.execute(
                    "DELETE FROM project_folders WHERE root=?1 AND folder NOT IN
                     (SELECT folder FROM project_folders WHERE root=?1 ORDER BY launches DESC,last_launch_ms DESC,folder LIMIT ?2)",
                    params![observation.root, FOLDER_LIMIT as i64],
                )?;
            }
        }
        transaction.execute(
            "DELETE FROM projects WHERE root NOT IN
             (SELECT root FROM projects ORDER BY pinned DESC,last_activity_ms DESC,root LIMIT ?1)",
            [PROJECT_LIMIT as i64],
        )?;
        transaction.execute(
            "DELETE FROM project_folders WHERE root NOT IN (SELECT root FROM projects)",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn rows(&self) -> Result<Vec<Row>> {
        let mut statement = self.connection.prepare(
            "SELECT root,name,default_branch,pinned,last_activity_ms FROM projects
             ORDER BY pinned DESC,last_activity_ms DESC,root LIMIT ?1",
        )?;
        let rows = statement
            .query_map([PROJECT_LIMIT as i64], |row| {
                Ok(Row {
                    root: row.get(0)?,
                    name: row.get(1)?,
                    default_branch: row.get(2)?,
                    pinned: row.get::<_, i64>(3)? == 1,
                    last_activity: unsigned(row.get(4)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub(crate) fn resolve(&self, root: &str) -> Result<Option<String>> {
        if let Some(exact) = self
            .connection
            .query_row("SELECT root FROM projects WHERE root=?1", [root], |row| {
                row.get(0)
            })
            .optional()?
        {
            return Ok(Some(exact));
        }
        Ok(self
            .rows()?
            .into_iter()
            .map(|row| row.root)
            .find(|candidate| same_path(candidate, root)))
    }

    pub(crate) fn set_pinned(&mut self, root: &str, pinned: bool) -> Result<String> {
        let root = self.known(root)?;
        if pinned {
            let count: i64 = self.connection.query_row(
                "SELECT count(*) FROM projects WHERE pinned=1 AND root<>?1",
                [&root],
                |row| row.get(0),
            )?;
            if usize::try_from(count).unwrap_or(usize::MAX) >= PIN_LIMIT {
                return Err(failure(
                    "project_limit",
                    format!("At most {PIN_LIMIT} projects can be pinned; unpin one first"),
                ));
            }
        }
        self.connection.execute(
            "UPDATE projects SET pinned=?2 WHERE root=?1",
            params![root, i64::from(pinned)],
        )?;
        Ok(root)
    }

    pub(crate) fn set_layout(&mut self, root: &str, layout: Option<&str>) -> Result<String> {
        let root = self.known(root)?;
        self.connection.execute(
            "UPDATE projects SET default_layout=?2 WHERE root=?1",
            params![root, layout],
        )?;
        Ok(root)
    }

    pub(crate) fn defaults(&self, root: &str) -> Result<Defaults> {
        let root = self.known(root)?;
        let (name, default_layout) = self.connection.query_row(
            "SELECT name,default_layout FROM projects WHERE root=?1",
            [&root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut statement = self.connection.prepare(
            "SELECT folder,launches,last_launch_ms FROM project_folders WHERE root=?1
             ORDER BY launches DESC,last_launch_ms DESC,folder LIMIT ?2",
        )?;
        let folders = statement
            .query_map(params![root, FOLDER_LIMIT as i64], |row| {
                Ok(Folder {
                    folder: row.get(0)?,
                    launches: unsigned(row.get(1)?),
                    last_launch_at: unsigned(row.get(2)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Defaults {
            root,
            name,
            default_layout,
            folders,
        })
    }

    fn known(&self, root: &str) -> Result<String> {
        self.resolve(root)?.ok_or_else(|| {
            failure(
                "project_not_found",
                "No project is known at that root; launch a session in the repository first",
            )
        })
    }
}

pub(crate) fn derive(
    live: &[LiveSession],
    worktrees: &[crate::worktrees::ProjectWorktree],
    now: u64,
) -> Vec<Observation> {
    let mut observations: Vec<Observation> = worktrees
        .iter()
        .map(|worktree| Observation {
            root: worktree.repository.clone(),
            name: base_name(&worktree.repository),
            branch: None,
            folder: None,
            session_id: None,
            at: worktree.created_at,
        })
        .collect();
    observations.extend(live.iter().filter_map(|session| {
        let root = session.root.as_ref()?;
        Some(Observation {
            root: root.clone(),
            name: base_name(root),
            branch: None,
            folder: Some(session.directory.clone()),
            session_id: Some(session.id.clone()),
            at: if session.running { now } else { 0 },
        })
    }));
    observations
}

pub(crate) fn project_view(
    rows: Vec<Row>,
    live: &[LiveSession],
    worktrees: &[crate::worktrees::ProjectWorktree],
) -> Vec<Project> {
    let worktree_roots: HashMap<&str, &str> = worktrees
        .iter()
        .filter(|worktree| worktree.open)
        .map(|worktree| (worktree.session_id.as_str(), worktree.repository.as_str()))
        .collect();
    let mut projects: Vec<Project> = rows
        .into_iter()
        .map(|row| {
            let mut sessions: Vec<String> = live
                .iter()
                .filter(|session| session.running)
                .filter(|session| {
                    session
                        .root
                        .as_deref()
                        .is_some_and(|root| same_path(root, &row.root))
                        || worktree_roots
                            .get(session.id.as_str())
                            .is_some_and(|root| same_path(root, &row.root))
                        || inside(&session.directory, &row.root)
                })
                .map(|session| session.id.clone())
                .collect();
            sessions.sort();
            let open_sessions = sessions.len();
            sessions.truncate(SESSION_LIMIT);
            Project {
                root: row.root,
                name: row.name,
                default_branch: row.default_branch,
                last_activity_at: row.last_activity,
                pinned: row.pinned,
                open_sessions,
                sessions,
            }
        })
        .collect();
    projects.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then(right.last_activity_at.cmp(&left.last_activity_at))
            .then_with(|| left.root.cmp(&right.root))
    });
    projects
}

pub(crate) fn observe_launch<'a>(launch: Launch<'a, impl Iterator<Item = &'a str>>, at: u64) {
    let Some(service) = SERVICE.get() else {
        return;
    };
    let folder = display_path(launch.folder);
    let branch = same_path(&folder, launch.root)
        .then(|| launch.branch.map(str::to_owned))
        .flatten();
    for session in launch.sessions {
        let _ = service.observations.try_send(Observation {
            root: launch.root.to_owned(),
            name: launch.name.to_owned(),
            branch: branch.clone(),
            folder: Some(folder.clone()),
            session_id: Some(session.to_owned()),
            at,
        });
    }
}

pub(crate) fn available() -> bool {
    SERVICE.get().is_some()
}

pub(crate) fn configure(database: &Path) -> Result<()> {
    let store = Arc::new(Mutex::new(Store::open(database)?));
    let (observations, mut receiver) = mpsc::channel::<Observation>(QUEUE);
    SERVICE
        .set(Service {
            store: store.clone(),
            observations,
        })
        .map_err(|_| anyhow!("Project registry is already configured"))?;
    tokio::spawn(async move {
        while let Some(first) = receiver.recv().await {
            let mut batch = vec![first];
            while batch.len() < BATCH {
                match receiver.try_recv() {
                    Ok(next) => batch.push(next),
                    Err(_) => break,
                }
            }
            let store = store.clone();
            let _ = tokio::task::spawn_blocking(move || {
                store
                    .lock()
                    .map_err(|_| anyhow!("Project registry is unavailable"))
                    .and_then(|mut store| store.record_all(&batch))
            })
            .await;
        }
    });
    Ok(())
}

pub(crate) fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::ListProjects
            | Command::PinProject { .. }
            | Command::UnpinProject { .. }
            | Command::ProjectDefaults { .. }
            | Command::SetProjectLayout { .. }
    )
}

pub(crate) fn admit(authority: &Authority) -> Result<()> {
    match authority {
        Authority::Owner => Ok(()),
        Authority::Session { .. } | Authority::RunWake { .. } => {
            Err(failure("forbidden", "Projects require owner authority"))
        }
    }
}

pub(crate) fn valid_root(root: &str) -> Result<()> {
    if root.is_empty()
        || root.len() > crate::git_repository::ROOT_BYTES
        || root.chars().any(char::is_control)
        || !Path::new(root).is_absolute()
    {
        return Err(failure(
            "invalid_argument",
            "Use the absolute host path of a repository root",
        ));
    }
    Ok(())
}

pub(crate) fn valid_layout(layout: Option<&str>) -> Result<()> {
    if let Some(layout) = layout
        && (layout.trim() != layout
            || layout.is_empty()
            || layout.chars().count() > LAYOUT_CHARS
            || layout.chars().any(char::is_control))
    {
        return Err(failure(
            "invalid_argument",
            format!("Use a layout name of 1-{LAYOUT_CHARS} characters without control characters"),
        ));
    }
    Ok(())
}

async fn canonical(root: &str) -> Result<String> {
    valid_root(root)?;
    Ok(match tokio::fs::canonicalize(root).await {
        Ok(path) => display_path(&path),
        Err(_) => root.to_owned(),
    })
}

async fn blocking<T: Send + 'static>(
    store: &Arc<Mutex<Store>>,
    work: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let store = store.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = store
            .lock()
            .map_err(|_| anyhow!("Project registry is unavailable"))?;
        work(&mut store)
    })
    .await
    .map_err(|_| anyhow!("Project registry worker stopped"))?
}

fn live_sessions(state: &Arc<Mutex<State>>) -> Vec<LiveSession> {
    state
        .lock()
        .map(|state| state.project_sessions())
        .unwrap_or_default()
}

async fn list(state: &Arc<Mutex<State>>, store: &Arc<Mutex<Store>>) -> Result<Value> {
    let live = live_sessions(state);
    let worktrees = crate::worktrees::project_worktrees();
    let observations = derive(&live, &worktrees, crate::status::now_millis());
    let rows = blocking(store, move |store| {
        store.record_all(&observations)?;
        store.rows()
    })
    .await?;
    let projects = project_view(rows, &live, &worktrees);
    Ok(json!({"type":"projects","projects":projects,"limit":PROJECT_LIMIT}))
}

async fn pin(store: &Arc<Mutex<Store>>, root: &str, pinned: bool) -> Result<Value> {
    let root = canonical(root).await?;
    let root = blocking(store, move |store| store.set_pinned(&root, pinned)).await?;
    Ok(json!({"type":"projectPinned","root":root,"pinned":pinned}))
}

async fn layout(store: &Arc<Mutex<Store>>, root: &str, layout: Option<String>) -> Result<Value> {
    valid_layout(layout.as_deref())?;
    let root = canonical(root).await?;
    let stored = layout.clone();
    let root = blocking(store, move |store| {
        store.set_layout(&root, stored.as_deref())
    })
    .await?;
    Ok(json!({"type":"projectLayout","root":root,"defaultLayout":layout}))
}

async fn defaults(store: &Arc<Mutex<Store>>, root: &str) -> Result<Value> {
    let root = canonical(root).await?;
    let defaults = blocking(store, move |store| store.defaults(&root)).await?;
    let setup = crate::worktrees::project_setup(&defaults.root).await;
    Ok(
        json!({"type":"projectDefaults","root":defaults.root,"name":defaults.name,
        "defaultLayout":defaults.default_layout,"launchFolder":defaults.launch_folder(),
        "folders":defaults.folders,"worktreeSetup":setup}),
    )
}

fn error_event(error: &anyhow::Error) -> Value {
    let code = error
        .downcast_ref::<Failure>()
        .map_or("project_unavailable", |failure| failure.code);
    json!({"type":"error","code":code,"message":error.to_string()})
}

pub(crate) async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    authority: Authority,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let result = match (admit(&authority), SERVICE.get(), permit) {
        (Err(error), _, _) => Err(error),
        (Ok(()), _, None) => Err(failure("busy", "Project registry is busy")),
        (Ok(()), None, _) => Err(failure(
            "unsupported",
            "The host project registry is unavailable",
        )),
        (Ok(()), Some(service), Some(_permit)) => match command {
            Command::ListProjects => list(&state, &service.store).await,
            Command::PinProject { root } => pin(&service.store, &root, true).await,
            Command::UnpinProject { root } => pin(&service.store, &root, false).await,
            Command::ProjectDefaults { root } => defaults(&service.store, &root).await,
            Command::SetProjectLayout { root, layout: name } => {
                layout(&service.store, &root, name).await
            }
            _ => Err(failure("invalid_argument", "Unsupported project command")),
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
#[path = "projects_tests.rs"]
mod tests;
