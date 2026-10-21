//! Advisory launch-directory metadata. Demand is explicit and never native input.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const LIMIT: usize = 16;
const TTL_MS: u64 = 30_000;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const OPTIONAL_BYTES: usize = 8 * 1024;
const PROJECTED_BYTES: usize = 60 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    Checking,
    Ready,
    Detached,
    NotRepository,
    Unavailable,
    Stale,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    source: &'static str,
    state: Status,
    name: Option<String>,
    branch: Option<String>,
    observed_at: Option<u64>,
    revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
}

impl Context {
    fn empty(state: Status, revision: u64) -> Self {
        Self {
            source: "launchDirectory",
            state,
            name: None,
            branch: None,
            observed_at: None,
            revision,
            root: None,
        }
    }
    fn stale(&self) -> Self {
        let mut stale = self.clone();
        stale.state = Status::Stale;
        stale.name = None;
        stale.branch = None;
        stale.root = None;
        stale.revision = stale.revision.saturating_add(1).min(MAX_REVISION);
        stale
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RootSource {
    CurrentCwd,
    LaunchDirectory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RootReason {
    InsideRoot,
    NoCurrentCwd,
    OutsideRoot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchRoot {
    source: RootSource,
    reason: RootReason,
    path: Option<String>,
    observed_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CurrentCwd {
    path: PathBuf,
    directory: PathBuf,
    observed_at: u64,
    sequence: u64,
    inside: bool,
}

#[derive(Debug)]
struct Location {
    launch: PathBuf,
    allowed: PathBuf,
    current: Option<CurrentCwd>,
}

impl Location {
    fn new(launch: &Path) -> Self {
        let canonical = launch.canonicalize().unwrap_or_else(|_| launch.to_owned());
        let allowed = canonical
            .ancestors()
            .find(|directory| directory.join(".git").symlink_metadata().is_ok())
            .unwrap_or(&canonical)
            .to_owned();
        Self {
            launch: launch.to_owned(),
            allowed,
            current: None,
        }
    }

    fn observe(&mut self, observed: Option<crate::agent_context::WorkingDirectory>) {
        let observed = observed.filter(|observed| observed.observed_at <= MAX_REVISION);
        self.current = match (observed, self.current.take()) {
            (None, _) => None,
            (Some(observed), Some(previous)) if observed.sequence < previous.sequence => {
                Some(previous)
            }
            (Some(observed), Some(previous)) if observed.path == previous.path => {
                Some(CurrentCwd {
                    sequence: observed.sequence,
                    ..previous
                })
            }
            (Some(observed), _) => Some(CurrentCwd {
                inside: observed.path.starts_with(&self.allowed),
                directory: PathBuf::from(crate::process::display_path(&observed.path)),
                path: observed.path,
                observed_at: observed.observed_at,
                sequence: observed.sequence,
            }),
        };
    }

    fn directory(&self) -> &Path {
        match &self.current {
            Some(current) if current.inside => &current.directory,
            _ => &self.launch,
        }
    }

    fn search_root(&self) -> SearchRoot {
        match &self.current {
            Some(current) if current.inside => SearchRoot {
                source: RootSource::CurrentCwd,
                reason: RootReason::InsideRoot,
                path: Some(crate::process::display_path(&current.path)),
                observed_at: Some(current.observed_at),
            },
            Some(current) => SearchRoot {
                source: RootSource::LaunchDirectory,
                reason: RootReason::OutsideRoot,
                path: None,
                observed_at: Some(current.observed_at),
            },
            None => SearchRoot {
                source: RootSource::LaunchDirectory,
                reason: RootReason::NoCurrentCwd,
                path: None,
                observed_at: None,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
    pub id: String,
    pub incarnation: [u8; 16],
    pub directory: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Work {
    pub directory: PathBuf,
    attempt: u64,
    bindings: Vec<Binding>,
}

#[derive(Default)]
struct Entry {
    context: Option<Context>,
    revision: u64,
    attempt: u64,
    cooldown_until: Option<u64>,
    expires: Option<u64>,
    interested: HashSet<u64>,
    queued: bool,
}

impl Entry {
    fn advance(&mut self) -> Option<u64> {
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_REVISION)?;
        Some(self.revision)
    }
    fn expire(&mut self, now: u64) -> bool {
        if self.expires.is_some_and(|deadline| now >= deadline)
            && let Some(context) = &self.context
            && matches!(
                context.state,
                Status::Ready | Status::Detached | Status::NotRepository
            )
        {
            let stale = context.stale();
            self.revision = stale.revision;
            self.context = Some(stale);
            self.expires = None;
            return true;
        }
        false
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    subscriptions: HashMap<String, Binding>,
    entries: HashMap<PathBuf, Entry>,
    queue: VecDeque<PathBuf>,
    active: Option<Work>,
    sealed: bool,
    locations: HashMap<String, Location>,
}

impl Registry {
    pub(crate) fn register(&mut self, binding: Binding) {
        if self.sealed
            || self.subscriptions.len() >= LIMIT && !self.subscriptions.contains_key(&binding.id)
        {
            return;
        }
        self.remove(&binding.id);
        if self.entries.len() >= LIMIT && !self.entries.contains_key(&binding.directory) {
            return;
        }
        self.entries.entry(binding.directory.clone()).or_default();
        self.locations
            .insert(binding.id.clone(), Location::new(&binding.directory));
        self.subscriptions.insert(binding.id.clone(), binding);
    }

    pub(crate) fn observe_cwd(
        &mut self,
        id: &str,
        incarnation: &[u8; 16],
        observed: Option<crate::agent_context::WorkingDirectory>,
    ) -> bool {
        if self.sealed
            || self
                .subscriptions
                .get(id)
                .is_none_or(|binding| &binding.incarnation != incarnation)
        {
            return false;
        }
        let Some(location) = self.locations.get_mut(id) else {
            return false;
        };
        let previous = location.search_root();
        location.observe(observed);
        let changed = location.search_root() != previous;
        let directory = location.directory().to_owned();
        self.retarget(id, directory);
        changed
    }

    fn retarget(&mut self, id: &str, directory: PathBuf) {
        let Some(binding) = self.subscriptions.get_mut(id) else {
            return;
        };
        if binding.directory == directory {
            return;
        }
        binding.directory = directory.clone();
        self.entries.retain(|directory, _| {
            self.subscriptions
                .values()
                .any(|binding| &binding.directory == directory)
        });
        self.entries.entry(directory).or_default();
        self.queue
            .retain(|directory| self.entries.contains_key(directory));
    }

    fn search_root(&self, id: &str, incarnation: &[u8; 16]) -> Option<SearchRoot> {
        self.subscriptions
            .get(id)
            .filter(|binding| &binding.incarnation == incarnation)?;
        Some(self.locations.get(id)?.search_root())
    }

    pub(crate) fn remove(&mut self, id: &str) {
        self.locations.remove(id);
        self.subscriptions.remove(id);
        self.entries.retain(|directory, _| {
            self.subscriptions
                .values()
                .any(|binding| &binding.directory == directory)
        });
        self.queue
            .retain(|directory| self.entries.contains_key(directory));
    }

    pub(crate) fn disconnect(&mut self, client: u64) {
        for entry in self.entries.values_mut() {
            entry.interested.remove(&client);
        }
        self.drop_uninterested_queue();
    }

    fn drop_uninterested_queue(&mut self) {
        for entry in self.entries.values_mut() {
            if entry.interested.is_empty() && entry.queued {
                entry.queued = false;
                entry.context = None;
            }
        }
        self.queue.retain(|directory| {
            self.entries
                .get(directory)
                .is_some_and(|entry| entry.queued)
        });
    }

    pub(crate) fn retain_authorized(&mut self, visible: &HashMap<u64, HashSet<String>>) {
        for (directory, entry) in &mut self.entries {
            entry.interested.retain(|client| {
                visible.get(client).is_some_and(|ids| {
                    self.subscriptions
                        .values()
                        .any(|binding| &binding.directory == directory && ids.contains(&binding.id))
                })
            });
        }
        self.drop_uninterested_queue();
    }

    pub(crate) fn demand(&mut self, client: u64, visible: &[String], now: u64) {
        if self.sealed {
            return;
        }
        let mut directories = visible
            .iter()
            .filter_map(|id| self.subscriptions.get(id))
            .map(|binding| binding.directory.clone())
            .collect::<Vec<_>>();
        directories.sort();
        directories.dedup();
        for directory in directories {
            let active_current = self.active.as_ref().is_some_and(|work| {
                work.directory == directory
                    && work
                        .bindings
                        .iter()
                        .any(|binding| self.subscriptions.get(&binding.id) == Some(binding))
            });
            let Some(entry) = self.entries.get_mut(&directory) else {
                continue;
            };
            if entry.interested.len() >= LIMIT && !entry.interested.contains(&client) {
                continue;
            }
            entry.interested.insert(client);
            entry.expire(now);
            if entry.queued
                || active_current
                || entry.cooldown_until.is_some_and(|deadline| now < deadline)
            {
                continue;
            }
            let Some(attempt) = entry.attempt.checked_add(1) else {
                continue;
            };
            // Reserve result and expiry revisions before publishing checking.
            if entry
                .revision
                .checked_add(3)
                .is_none_or(|revision| revision > MAX_REVISION)
            {
                entry.revision = MAX_REVISION;
                entry.context = Some(Context::empty(Status::Unavailable, MAX_REVISION));
                entry.expires = None;
                entry.cooldown_until = Some(u64::MAX);
                continue;
            }
            let Some(revision) = entry.advance() else {
                continue;
            };
            entry.attempt = attempt;
            entry.context = Some(Context::empty(Status::Checking, revision));
            entry.expires = None;
            entry.queued = true;
            self.queue.push_back(directory);
        }
    }

    pub(crate) fn expire(&mut self, now: u64) -> bool {
        let mut changed = false;
        for entry in self
            .entries
            .values_mut()
            .filter(|entry| !entry.interested.is_empty())
        {
            changed |= entry.expire(now);
        }
        changed
    }

    pub(crate) fn next_expiry(&self) -> Option<u64> {
        if self.sealed {
            return None;
        }
        self.entries
            .values()
            .filter(|entry| !entry.interested.is_empty())
            .filter_map(|entry| entry.expires)
            .min()
    }

    pub(crate) fn claim(&mut self) -> Option<Work> {
        if self.sealed || self.active.is_some() {
            return None;
        }
        while let Some(directory) = self.queue.pop_front() {
            let Some(entry) = self.entries.get_mut(&directory) else {
                continue;
            };
            if !entry.queued || entry.interested.is_empty() {
                continue;
            }
            entry.queued = false;
            let bindings = self
                .subscriptions
                .values()
                .filter(|binding| binding.directory == directory)
                .cloned()
                .collect::<Vec<_>>();
            if bindings.is_empty() {
                continue;
            }
            let work = Work {
                directory,
                attempt: entry.attempt,
                bindings,
            };
            self.active = Some(work.clone());
            return Some(work);
        }
        None
    }

    pub(crate) fn finish(
        &mut self,
        work: &Work,
        outcome: crate::git_repository::Outcome,
        wall: u64,
        now: u64,
    ) -> bool {
        if self.active.as_ref() != Some(work) {
            return false;
        }
        self.active = None;
        if self.sealed
            || !work
                .bindings
                .iter()
                .any(|binding| self.subscriptions.get(&binding.id) == Some(binding))
        {
            return false;
        }
        let Some(entry) = self.entries.get_mut(&work.directory) else {
            return false;
        };
        if entry.attempt != work.attempt {
            return false;
        }
        let Some(revision) = entry.advance() else {
            return false;
        };
        let mut context = Context::empty(Status::Unavailable, revision);
        if wall <= MAX_REVISION && now.checked_add(TTL_MS).is_some() {
            match outcome.validated() {
                crate::git_repository::Outcome::Ready { name, branch, root } => {
                    context.state = Status::Ready;
                    context.name = Some(name);
                    context.branch = Some(branch);
                    context.root = Some(root);
                }
                crate::git_repository::Outcome::Detached { name, root } => {
                    context.state = Status::Detached;
                    context.name = Some(name);
                    context.root = Some(root);
                }
                crate::git_repository::Outcome::NotRepository => {
                    context.state = Status::NotRepository
                }
                crate::git_repository::Outcome::Unavailable => {}
            }
        }
        if context.state != Status::Unavailable {
            context.observed_at = Some(wall);
            entry.expires = now.checked_add(TTL_MS);
        } else {
            entry.expires = None;
        }
        entry.cooldown_until = now.checked_add(TTL_MS).or(Some(u64::MAX));
        if let (Some(root), Some(name)) = (&context.root, &context.name) {
            crate::projects::observe_launch(
                crate::projects::Launch {
                    root,
                    name,
                    branch: context.branch.as_deref(),
                    folder: &work.directory,
                    sessions: work.bindings.iter().map(|binding| binding.id.as_str()),
                },
                wall,
            );
        }
        entry.context = Some(context);
        true
    }

    pub(crate) fn root(&self, id: &str) -> Option<String> {
        let binding = self.subscriptions.get(id)?;
        self.entries
            .get(&binding.directory)?
            .context
            .as_ref()
            .filter(|context| matches!(context.state, Status::Ready | Status::Detached))?
            .root
            .clone()
    }

    pub(crate) fn seal(&mut self) {
        self.sealed = true;
        self.active = None;
        self.queue.clear();
        for entry in self.entries.values_mut() {
            entry.queued = false;
            entry.interested.clear();
        }
    }

    fn context(&self, id: &str, incarnation: &[u8; 16], now: u64) -> Option<Context> {
        let binding = self
            .subscriptions
            .get(id)
            .filter(|binding| &binding.incarnation == incarnation)?;
        let entry = self.entries.get(&binding.directory)?;
        let context = entry.context.as_ref()?;
        Some(if entry.expires.is_some_and(|deadline| now >= deadline) {
            context.stale()
        } else {
            context.clone()
        })
    }

    pub(crate) fn enrich(
        &self,
        snapshot: &mut Value,
        incarnations: &HashMap<String, [u8; 16]>,
        now: u64,
    ) {
        if let Some(sessions) = snapshot["sessions"].as_array_mut() {
            for session in sessions {
                if let Some(session) = session.as_object_mut() {
                    session.remove("repositoryContext");
                    session.remove("searchRoot");
                }
            }
        }
        let Ok(baseline) = serde_json::to_vec(snapshot).map(|bytes| bytes.len()) else {
            return;
        };
        let available = OPTIONAL_BYTES.min(PROJECTED_BYTES.saturating_sub(baseline));
        if available == 0 {
            return;
        }
        let mut indices = snapshot["sessions"]
            .as_array()
            .map(|sessions| {
                sessions
                    .iter()
                    .enumerate()
                    .filter_map(|(index, session)| {
                        session["id"].as_str().map(|id| (id.to_owned(), index))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        indices.sort_by(|left, right| left.0.cmp(&right.0));
        let mut used = 0usize;
        let mut added = Vec::new();
        for (id, index) in indices {
            let Some(incarnation) = incarnations.get(&id) else {
                continue;
            };
            let mut fields = serde_json::Map::new();
            if let Some(context) = self.context(&id, incarnation, now)
                && let Ok(value) = serde_json::to_value(context)
            {
                fields.insert("repositoryContext".into(), value);
            }
            if let Some(root) = self.search_root(&id, incarnation)
                && let Ok(value) = serde_json::to_value(root)
            {
                fields.insert("searchRoot".into(), value);
            }
            if fields.is_empty() {
                continue;
            }
            let fields = Value::Object(fields);
            let Ok(field) = serde_json::to_vec(&fields) else {
                continue;
            };
            let Some(session) = snapshot["sessions"][index].as_object() else {
                continue;
            };
            let delta = field.len().saturating_sub(2) + usize::from(!session.is_empty());
            if delta > available.saturating_sub(used) {
                continue;
            }
            if let (Some(session), Value::Object(fields)) =
                (snapshot["sessions"][index].as_object_mut(), fields)
            {
                session.extend(fields);
            }
            used += delta;
            added.push(index);
        }
        // Recheck the whole payload once; capacity never changes admission.
        if serde_json::to_vec(snapshot).map_or(true, |bytes| bytes.len() > baseline + available) {
            for index in added {
                if let Some(session) = snapshot["sessions"][index].as_object_mut() {
                    session.remove("repositoryContext");
                    session.remove("searchRoot");
                }
            }
        }
    }
}

trait Inspector {
    fn read<'a>(
        &'a mut self,
        directory: &'a std::path::Path,
        stopped: &'a mut watch::Receiver<bool>,
    ) -> impl std::future::Future<Output = crate::git_repository::Outcome> + Send + 'a;
}

struct GitInspector;
impl Inspector for GitInspector {
    fn read<'a>(
        &'a mut self,
        directory: &'a std::path::Path,
        stopped: &'a mut watch::Receiver<bool>,
    ) -> impl std::future::Future<Output = crate::git_repository::Outcome> + Send + 'a {
        crate::git_repository::inspect(directory, stopped)
    }
}

async fn run(
    state: Arc<Mutex<crate::sessions::State>>,
    mut demand: tokio::sync::mpsc::Receiver<()>,
    mut stopped: watch::Receiver<bool>,
    mut inspector: impl Inspector,
    now: impl Fn() -> u64,
) -> bool {
    loop {
        if *stopped.borrow() {
            return true;
        }
        let (work, expires) = match state.lock() {
            Ok(mut state) => state.repository_next(now()),
            Err(_) => return false,
        };
        if let Some(work) = work {
            let outcome = inspector.read(&work.directory, &mut stopped).await;
            if let Ok(mut state) = state.lock() {
                state.repository_finished(&work, outcome, crate::status::now_millis(), now());
            }
            continue;
        }
        tokio::select! {
            biased;
            _ = stopped.changed() => return true,
            requested = demand.recv() => if requested.is_none() { return true; },
            _ = async {
                if let Some(deadline) = expires {
                    tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(now()))).await;
                } else { std::future::pending::<()>().await; }
            } => {},
        }
    }
}

pub(crate) struct Runtime {
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<bool>>,
}
impl Runtime {
    pub(crate) fn start(state: Arc<Mutex<crate::sessions::State>>) -> Self {
        let (stop, stopped) = watch::channel(false);
        let demand = state.lock().unwrap().repository_runtime();
        let task = tokio::spawn(run(
            state,
            demand,
            stopped,
            GitInspector,
            crate::event_log::monotonic_millis,
        ));
        Self {
            stop,
            task: Some(task),
        }
    }
    pub(crate) fn request_shutdown(&self) {
        self.stop.send_replace(true);
    }
    pub(crate) async fn shutdown(mut self) -> bool {
        self.request_shutdown();
        let Some(mut task) = self.task.take() else {
            return true;
        };
        matches!(
            tokio::time::timeout(Duration::from_secs(5), &mut task).await,
            Ok(Ok(true))
        ) && crate::git_repository::cleanup_confirmed()
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.request_shutdown();
    }
}

#[cfg(test)]
#[path = "search_root_tests.rs"]
mod search_root_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_repository::Outcome;
    use serde_json::json;

    const SESSION_EXIT_BOUND: Duration = Duration::from_secs(5);

    struct RuntimeFixture {
        state: Arc<Mutex<crate::sessions::State>>,
        root: PathBuf,
        events: tokio::sync::mpsc::Sender<crate::sessions::PtyEvent>,
        exits: std::sync::mpsc::Receiver<String>,
        running: std::collections::HashSet<String>,
        _owner_events: tokio::sync::mpsc::Receiver<Value>,
    }
    fn forward_exits(
        mut output: tokio::sync::mpsc::Receiver<crate::sessions::PtyEvent>,
    ) -> std::sync::mpsc::Receiver<String> {
        let (exited, exits) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Some(event) = output.blocking_recv() {
                if let crate::sessions::PtyEvent::Exited(id, _) = event
                    && exited.send(id).is_err()
                {
                    break;
                }
            }
        });
        exits
    }
    impl RuntimeFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nesvo-repository-runtime-{}",
                hex::encode(crate::wire::random::<16>())
            ));
            std::fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let state = crate::sessions::State::new(
                root.clone(),
                crate::storage::MetadataStore::open(std::path::Path::new(":memory:")).unwrap(),
                crate::launchers::Launchers::discover_with_fixture_shell(),
            );
            let (events, output) = tokio::sync::mpsc::channel(128);
            let (owner_events, received) = tokio::sync::mpsc::channel(128);
            let (cancelled, _cancel) = watch::channel(false);
            let mut fixture = Self {
                state: Arc::new(Mutex::new(state)),
                root,
                events,
                exits: forward_exits(output),
                running: std::collections::HashSet::new(),
                _owner_events: received,
            };
            fixture.state.lock().unwrap().clients.insert(
                1,
                crate::sessions::Client {
                    events: owner_events,
                    cancelled,
                    authority: crate::caller::Authority::Owner,
                },
            );
            for name in ["a", "b"] {
                let directory = fixture.root.join(name);
                std::fs::create_dir(&directory).unwrap();
                let id = fixture
                    .state
                    .lock()
                    .unwrap()
                    .launch(
                        &crate::jobs::LaunchSpec {
                            name: format!("Repository runtime {name}"),
                            cwd: Some(crate::process::display_path(&directory)),
                            program: crate::launchers::Program::Shell,
                            harness: Some(false),
                            ..Default::default()
                        },
                        &fixture.events,
                    )
                    .unwrap();
                fixture.running.insert(id);
            }
            fixture
        }
        fn list(&self, client: u64) {
            self.state
                .lock()
                .unwrap()
                .command(client, crate::protocol::Command::List, None, &self.events)
                .unwrap();
        }
        fn await_exits(&mut self, deadline: std::time::Instant) -> bool {
            while !self.running.is_empty() {
                match self
                    .exits
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                {
                    Ok(id) => {
                        self.running.remove(&id);
                    }
                    Err(_) => return false,
                }
            }
            true
        }
        fn cleanup(&mut self) -> bool {
            let workers = self
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .shutdown();
            let exit_deadline = std::time::Instant::now() + SESSION_EXIT_BOUND;
            let mut retired = true;
            for worker in workers {
                retired &= worker.join().is_ok();
            }
            retired &= self.await_exits(exit_deadline);
            let owned = std::env::temp_dir().canonicalize().is_ok_and(|temporary| {
                self.root.parent() == Some(temporary.as_path())
                    && self
                        .root
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("nesvo-repository-runtime-"))
            });
            retired && owned && (!self.root.exists() || std::fs::remove_dir_all(&self.root).is_ok())
        }
    }
    impl Drop for RuntimeFixture {
        fn drop(&mut self) {
            // Also retire both owned shell lifetimes on an assertion unwind.
            let _ = self.cleanup();
        }
    }

    struct ActiveRead(Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for ActiveRead {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    struct BlockingInspector {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        active: Arc<std::sync::atomic::AtomicUsize>,
        first: Option<tokio::sync::oneshot::Receiver<()>>,
    }
    impl Inspector for BlockingInspector {
        async fn read<'a>(
            &'a mut self,
            _directory: &'a std::path::Path,
            _stopped: &'a mut watch::Receiver<bool>,
        ) -> Outcome {
            use std::sync::atomic::Ordering;
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_add(1, Ordering::SeqCst);
            let _active = ActiveRead(self.active.clone());
            if let Some(first) = self.first.take() {
                let _ = first.await;
            }
            ready()
        }
    }

    #[tokio::test]
    async fn search_root_ignores_a_cwd_without_a_bound_provider_conversation() {
        let mut fixture = RuntimeFixture::new();
        let id = fixture.running.iter().next().unwrap().clone();
        fixture.state.lock().unwrap().repository_working_directory(
            &id,
            Some(crate::agent_context::WorkingDirectory {
                path: fixture.root.join("a"),
                sequence: 1,
                observed_at: 1,
                provider_session: "conversation".into(),
            }),
        );
        let listed = fixture.state.lock().unwrap().list();
        let session = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == id.as_str())
            .unwrap();
        assert_eq!(
            session["searchRoot"],
            json!({"source":"launchDirectory","reason":"noCurrentCwd","path":null,"observedAt":null})
        );
        assert!(fixture.cleanup());
    }

    #[tokio::test]
    async fn runtime_last_disconnect_drains_admitted_read_without_admitting_queued_directory() {
        use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
        // Real State/client authorization and two owned shell subscriptions;
        // the inspector is the sole substituted adapter. No Git/provider runs.
        let mut fixture = RuntimeFixture::new();
        let clock = Arc::new(AtomicU64::new(crate::event_log::monotonic_millis()));
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let (release, first) = tokio::sync::oneshot::channel();
        let (stop, stopped) = watch::channel(false);
        let demand = fixture.state.lock().unwrap().repository_runtime();
        let read_clock = clock.clone();
        let mut worker = Box::pin(run(
            fixture.state.clone(),
            demand,
            stopped,
            BlockingInspector {
                calls: calls.clone(),
                active: active.clone(),
                first: Some(first),
            },
            move || read_clock.load(Ordering::SeqCst),
        ));
        fixture.list(1);
        fixture.list(1);
        assert!(futures_util::poll!(&mut worker).is_pending());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "The first real admission reached the adapter"
        );
        assert_eq!(active.load(Ordering::SeqCst), 1);
        let checking = fixture.state.lock().unwrap().list()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|session| session["repositoryContext"]["state"] == "checking")
            .count();
        assert_eq!(
            checking, 2,
            "Both distinct directories have explicit demand"
        );
        fixture.state.lock().unwrap().disconnect(1);
        release.send(()).unwrap();
        assert!(futures_util::poll!(&mut worker).is_pending());
        assert_eq!(
            active.load(Ordering::SeqCst),
            0,
            "The admitted read drained"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "The other directory lost its last authorized demand"
        );
        clock.fetch_add(TTL_MS + 1, Ordering::SeqCst);
        // A late close notification exercises the real bounded wake channel;
        // it must not turn the advanced expiry clock into a new demand.
        fixture.state.lock().unwrap().disconnect(1);
        assert!(futures_util::poll!(&mut worker).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (next, expiry) = fixture
            .state
            .lock()
            .unwrap()
            .repository_next(clock.load(Ordering::SeqCst));
        assert!(next.is_none());
        assert_eq!(expiry, None);
        stop.send_replace(true);
        assert!(worker.await);

        // Aborting this same production loop while an admitted adapter future
        // is blocked also drops that future. Native Git cleanup is separately
        // covered by the real adapter's command-scope conformance tests.
        let (events, _received) = tokio::sync::mpsc::channel(128);
        let (cancelled, _cancel) = watch::channel(false);
        fixture.state.lock().unwrap().clients.insert(
            2,
            crate::sessions::Client {
                events,
                cancelled,
                authority: crate::caller::Authority::Owner,
            },
        );
        let (_release, first) = tokio::sync::oneshot::channel();
        let (stop, stopped) = watch::channel(false);
        let demand = fixture.state.lock().unwrap().repository_runtime();
        let calls = Arc::new(AtomicUsize::new(0));
        let read_clock = clock.clone();
        let mut worker = Box::pin(run(
            fixture.state.clone(),
            demand,
            stopped,
            BlockingInspector {
                calls: calls.clone(),
                active: active.clone(),
                first: Some(first),
            },
            move || read_clock.load(Ordering::SeqCst),
        ));
        fixture.list(2);
        assert!(futures_util::poll!(&mut worker).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 1);
        fixture.state.lock().unwrap().disconnect(2);
        stop.send_replace(true);
        drop(worker);
        assert_eq!(
            active.load(Ordering::SeqCst),
            0,
            "Dropping the worker drops the blocked read"
        );
        assert!(
            fixture.cleanup(),
            "The exact owned shell fixture retires on success and unwind"
        );
    }

    fn binding(id: &str, directory: &str, incarnation: u8) -> Binding {
        Binding {
            id: id.into(),
            directory: PathBuf::from(directory),
            incarnation: [incarnation; 16],
        }
    }
    fn ready() -> Outcome {
        Outcome::Ready {
            name: "repo łódź".into(),
            branch: "feature/żółw".into(),
            root: test_root(),
        }
    }
    fn test_root() -> String {
        crate::process::display_path(&std::env::temp_dir().join("repo łódź"))
    }
    fn observed(outcome: Outcome) -> (Registry, Binding) {
        let mut registry = Registry::default();
        let binding = binding("a", "captured-directory", 1);
        registry.register(binding.clone());
        registry.demand(1, std::slice::from_ref(&binding.id), 100);
        let work = registry.claim().unwrap();
        assert!(registry.finish(&work, outcome, 500, 120));
        (registry, binding)
    }

    #[test]
    fn registration_never_creates_demand_and_shared_directories_coalesce() {
        let mut registry = Registry::default();
        let a = binding("a", "same-directory", 1);
        let b = binding("b", "same-directory", 2);
        registry.register(a.clone());
        registry.register(b.clone());
        assert!(registry.claim().is_none());
        assert!(registry.context(&a.id, &a.incarnation, 0).is_none());
        registry.demand(1, std::slice::from_ref(&a.id), 0);
        registry.demand(2, std::slice::from_ref(&b.id), 0);
        let checking = registry.context(&a.id, &a.incarnation, 0).unwrap();
        assert_eq!(checking.state, Status::Checking);
        assert_eq!(checking.revision, 1);
        assert!(checking.observed_at.is_none());
        assert_eq!(registry.queue.len(), 1);
        let work = registry.claim().unwrap();
        assert_eq!(work.bindings.len(), 2);
        assert!(registry.claim().is_none());
        assert!(registry.finish(&work, ready(), 9, 10));
        assert_eq!(
            registry.context(&a.id, &a.incarnation, 10),
            registry.context(&b.id, &b.incarnation, 10)
        );
    }

    #[test]
    fn every_success_negative_and_error_has_exact_thirty_second_cooldown() {
        for outcome in [
            ready(),
            Outcome::Detached {
                name: "repo".into(),
                root: test_root(),
            },
            Outcome::NotRepository,
            Outcome::Unavailable,
        ] {
            let (mut registry, binding) = observed(outcome.clone());
            let context = registry
                .context(&binding.id, &binding.incarnation, 120)
                .unwrap();
            assert_eq!(
                context.observed_at,
                if outcome == Outcome::Unavailable {
                    None
                } else {
                    Some(500)
                }
            );
            registry.demand(1, std::slice::from_ref(&binding.id), 30_119);
            assert!(registry.claim().is_none());
            registry.demand(1, std::slice::from_ref(&binding.id), 30_120);
            assert!(
                registry.claim().is_some(),
                "Only an explicit due request creates a new inspection"
            );
            let pending = registry
                .context(&binding.id, &binding.incarnation, 30_120)
                .unwrap();
            assert_eq!(pending.state, Status::Checking);
            assert!(
                pending.name.is_none() && pending.branch.is_none() && pending.observed_at.is_none()
            );
        }
    }

    #[test]
    fn expiry_is_memory_only_clears_labels_and_never_renews_observation_time() {
        let (mut registry, binding) = observed(ready());
        let fresh = registry
            .context(&binding.id, &binding.incarnation, 30_119)
            .unwrap();
        let stale = registry
            .context(&binding.id, &binding.incarnation, 30_120)
            .unwrap();
        assert_eq!(stale.state, Status::Stale);
        assert_eq!(stale.observed_at, fresh.observed_at);
        assert_eq!(stale.revision, fresh.revision + 1);
        assert!(stale.name.is_none() && stale.branch.is_none());
        assert!(registry.expire(30_120));
        assert!(!registry.expire(30_121));
        assert_eq!(
            registry.context(&binding.id, &binding.incarnation, 30_121),
            Some(stale)
        );
        assert!(registry.claim().is_none());
        assert!(registry.next_expiry().is_none());
        // Wall time is not an input to expiry/cooldown: changing or moving it
        // backwards cannot refresh an observation or extend these deadlines.
        registry.demand(1, std::slice::from_ref(&binding.id), 30_120);
        let work = registry.claim().unwrap();
        assert!(registry.finish(&work, Outcome::NotRepository, 1, 30_125));
        assert_eq!(
            registry
                .context(&binding.id, &binding.incarnation, 30_125)
                .unwrap()
                .observed_at,
            Some(1)
        );
        assert_eq!(registry.next_expiry(), Some(60_125));
    }

    #[test]
    fn removed_or_recreated_incarnation_cannot_borrow_late_result_even_with_same_id_path() {
        for replacement_directory in ["same", "different"] {
            let mut registry = Registry::default();
            let old = binding("same-id", "same", 1);
            registry.register(old.clone());
            registry.demand(1, std::slice::from_ref(&old.id), 0);
            let work = registry.claim().unwrap();
            registry.remove(&old.id);
            let new = binding("same-id", replacement_directory, 2);
            registry.register(new.clone());
            assert!(!registry.finish(&work, ready(), 10, 10));
            assert!(registry.context(&new.id, &new.incarnation, 10).is_none());
            registry.demand(1, std::slice::from_ref(&new.id), 10);
            let current = registry.claim().unwrap();
            assert!(registry.finish(&current, ready(), 11, 11));
            assert!(!registry.finish(&work, Outcome::Unavailable, 12, 12));
            assert_eq!(
                registry
                    .context(&new.id, &new.incarnation, 12)
                    .unwrap()
                    .state,
                Status::Ready
            );
        }
    }

    #[test]
    fn replacement_demand_before_orphan_finishes_keeps_its_own_fresh_ticket() {
        let mut registry = Registry::default();
        let old = binding("same-id", "same-directory", 1);
        registry.register(old.clone());
        registry.demand(1, std::slice::from_ref(&old.id), 0);
        let orphan = registry.claim().unwrap();
        registry.remove(&old.id);
        let replacement = binding("same-id", "same-directory", 2);
        registry.register(replacement.clone());
        registry.demand(2, std::slice::from_ref(&replacement.id), 1);
        registry.demand(2, std::slice::from_ref(&replacement.id), 2);
        assert_eq!(
            registry.queue.len(),
            1,
            "One replacement demand despite repeated Lists"
        );
        assert!(
            registry.claim().is_none(),
            "The old inspection still owns the one active slot"
        );
        assert_eq!(
            registry
                .context(&replacement.id, &replacement.incarnation, 2)
                .unwrap()
                .state,
            Status::Checking
        );
        assert!(
            !registry.finish(&orphan, ready(), 10, 10),
            "Never borrow the removed incarnation's result"
        );
        assert_eq!(
            registry
                .context(&replacement.id, &replacement.incarnation, 10)
                .unwrap()
                .state,
            Status::Checking
        );
        let fresh = registry.claim().unwrap();
        assert_ne!(fresh.bindings, orphan.bindings);
        assert_eq!(fresh.bindings, vec![replacement.clone()]);
        assert!(registry.claim().is_none());
        assert!(registry.finish(
            &fresh,
            Outcome::Detached {
                name: "new observation".into(),
                root: test_root()
            },
            11,
            11
        ));
        assert_eq!(
            registry
                .context(&replacement.id, &replacement.incarnation, 11)
                .unwrap()
                .state,
            Status::Detached
        );
        assert!(!registry.finish(&orphan, Outcome::Unavailable, 12, 12));

        // Revocation/disconnect still removes that new queued demand while the
        // old inspection drains; it cannot become an automatic replacement.
        for revoked in [false, true] {
            let mut registry = Registry::default();
            registry.register(old.clone());
            registry.demand(1, std::slice::from_ref(&old.id), 0);
            let orphan = registry.claim().unwrap();
            registry.remove(&old.id);
            registry.register(replacement.clone());
            registry.demand(2, std::slice::from_ref(&replacement.id), 1);
            if revoked {
                registry.retain_authorized(&HashMap::new());
            } else {
                registry.disconnect(2);
            }
            assert!(!registry.finish(&orphan, ready(), 10, 10));
            assert!(registry.claim().is_none());
        }
    }

    #[test]
    fn revoked_or_disconnected_interests_cannot_keep_unrelated_queue_alive() {
        let mut registry = Registry::default();
        let a = binding("a", "a-dir", 1);
        let b = binding("b", "b-dir", 2);
        registry.register(a.clone());
        registry.register(b.clone());
        registry.demand(1, std::slice::from_ref(&a.id), 0);
        registry.demand(2, std::slice::from_ref(&b.id), 0);
        registry.retain_authorized(&HashMap::from([
            (1, HashSet::new()),
            (2, HashSet::from([b.id.clone()])),
        ]));
        let work = registry.claim().unwrap();
        assert_eq!(work.directory, b.directory);
        assert!(registry.context(&a.id, &a.incarnation, 0).is_none());
        registry.finish(&work, ready(), 1, 1);
        registry.disconnect(2);
        assert!(registry.next_expiry().is_none());
        assert!(
            !registry.expire(60_000),
            "No closed-client background expiry publication"
        );
        registry.demand(2, std::slice::from_ref(&b.id), 60_000);
        registry.disconnect(2);
        assert!(
            registry.claim().is_none(),
            "Queued demand disappears with its final client"
        );
    }

    #[test]
    fn sixteen_subscriptions_directories_fifo_and_one_active_are_hard_bounds() {
        let mut registry = Registry::default();
        let ids = (0..17)
            .map(|index| format!("session-{index:02}"))
            .collect::<Vec<_>>();
        for (index, id) in ids.iter().enumerate() {
            registry.register(binding(id, &format!("directory-{index:02}"), index as u8));
        }
        registry.demand(1, &ids, 0);
        assert_eq!(registry.subscriptions.len(), LIMIT);
        assert_eq!(registry.entries.len(), LIMIT);
        assert_eq!(registry.queue.len(), LIMIT);
        for index in 0..LIMIT {
            let work = registry.claim().unwrap();
            assert_eq!(
                work.directory,
                PathBuf::from(format!("directory-{index:02}"))
            );
            assert!(registry.claim().is_none());
            assert!(registry.finish(&work, Outcome::NotRepository, 1, 1));
        }
        assert!(registry.claim().is_none());
    }

    #[test]
    fn shutdown_retires_claim_and_counter_or_clock_overflow_never_publishes_labels() {
        let mut registry = Registry::default();
        let a = binding("a", "dir", 1);
        registry.register(a.clone());
        registry.demand(1, std::slice::from_ref(&a.id), 0);
        let work = registry.claim().unwrap();
        registry.seal();
        assert!(!registry.finish(&work, ready(), 1, 1));
        registry.demand(1, std::slice::from_ref(&a.id), 50_000);
        assert!(registry.claim().is_none());
        let (mut registry, a) = observed(ready());
        let entry = registry.entries.get_mut(&a.directory).unwrap();
        entry.revision = MAX_REVISION - 1;
        entry.context.as_mut().unwrap().revision = entry.revision;
        registry.demand(1, std::slice::from_ref(&a.id), 60_000);
        assert!(registry.claim().is_none());
        assert_eq!(
            registry
                .context(&a.id, &a.incarnation, 60_000)
                .unwrap()
                .state,
            Status::Unavailable
        );
        let (mut registry, a) = observed(ready());
        registry.demand(1, std::slice::from_ref(&a.id), 60_000);
        let work = registry.claim().unwrap();
        registry.finish(&work, ready(), MAX_REVISION + 1, u64::MAX);
        let unavailable = registry.context(&a.id, &a.incarnation, u64::MAX).unwrap();
        assert_eq!(unavailable.state, Status::Unavailable);
        assert!(unavailable.observed_at.is_none());
    }

    #[test]
    fn optional_projection_clips_whole_objects_in_id_order_without_spending_admission() {
        let mut registry = Registry::default();
        let mut incarnations = HashMap::new();
        let mut sessions = Vec::new();
        for index in (0..16).rev() {
            let id = format!("session-{index:02}");
            let a = binding(&id, &id, index as u8);
            registry.register(a.clone());
            incarnations.insert(id.clone(), a.incarnation);
            registry.demand(1, std::slice::from_ref(&id), 0);
            let work = registry.claim().unwrap();
            registry.finish(
                &work,
                Outcome::Ready {
                    name: "\\".repeat(128),
                    branch: "\"".repeat(256),
                    root: test_root(),
                },
                10,
                10,
            );
            sessions.push(json!({"id":id}));
        }
        let mut snapshot = serde_json::json!({"type":"sessions","sessions":sessions,"groups":[],"padding":"x".repeat(36 * 1024)});
        let baseline = snapshot.clone();
        let baseline_bytes = serde_json::to_vec(&baseline).unwrap().len();
        assert!(crate::budgets::admit_snapshot_bytes(baseline_bytes, 100).is_ok());
        registry.enrich(&mut snapshot, &incarnations, 11);
        let projected = serde_json::to_vec(&snapshot).unwrap().len();
        assert!(projected <= baseline_bytes + OPTIONAL_BYTES && projected <= PROJECTED_BYTES);
        assert!(
            crate::budgets::admit_snapshot_bytes(projected, 100).is_err(),
            "Reusing optional projection for admission would wrongly reject this candidate"
        );
        let included = snapshot["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|session| session.get("repositoryContext").is_some())
            .collect::<Vec<_>>();
        assert!(!included.is_empty() && included.len() < 16);
        assert_eq!(included.last().unwrap()["id"], "session-00");
        assert!(
            snapshot["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|session| session.get("repositoryContext"))
                .all(|context| context.as_object().unwrap().len() == 7
                    && context["root"] == test_root())
        );
        assert_eq!(serde_json::to_vec(&baseline).unwrap().len(), baseline_bytes);
        assert!(crate::budgets::admit_snapshot_bytes(baseline_bytes, 100).is_ok());
        snapshot["requestId"] = json!("\\".repeat(128));
        assert!(
            crate::wire::encode(snapshot, &[9; 32], &"challenge".repeat(8), MAX_REVISION).is_ok()
        );
    }

    #[test]
    fn scope_filter_and_expired_projection_never_leak_other_subscription_or_old_branch() {
        let (registry, a) = observed(ready());
        let bindings = HashMap::from([(a.id.clone(), a.incarnation)]);
        let mut hidden = serde_json::json!({"sessions":[{"id":"different"}]});
        registry.enrich(&mut hidden, &bindings, 120);
        assert!(hidden["sessions"][0].get("repositoryContext").is_none());
        let mut stale = serde_json::json!({"sessions":[{"id":a.id}]});
        registry.enrich(&mut stale, &bindings, 30_120);
        assert_eq!(stale["sessions"][0]["repositoryContext"]["state"], "stale");
        assert!(stale["sessions"][0]["repositoryContext"]["branch"].is_null());
        assert_eq!(stale["sessions"][0]["repositoryContext"]["observedAt"], 500);
    }

    #[test]
    fn projects_root_is_projected_for_resolved_repositories_and_dropped_when_stale() {
        let (registry, a) = observed(ready());
        let bindings = HashMap::from([(a.id.clone(), a.incarnation)]);
        let mut fresh = serde_json::json!({"sessions":[{"id":a.id}]});
        registry.enrich(&mut fresh, &bindings, 120);
        assert_eq!(
            fresh["sessions"][0]["repositoryContext"]["root"],
            test_root()
        );
        assert_eq!(registry.root(&a.id), Some(test_root()));
        let mut stale = serde_json::json!({"sessions":[{"id":a.id}]});
        registry.enrich(&mut stale, &bindings, 30_120);
        assert!(
            stale["sessions"][0]["repositoryContext"]
                .get("root")
                .is_none()
        );
        let (outside, b) = observed(Outcome::NotRepository);
        let mut negative = serde_json::json!({"sessions":[{"id":b.id}]});
        outside.enrich(
            &mut negative,
            &HashMap::from([(b.id.clone(), b.incarnation)]),
            120,
        );
        let context = negative["sessions"][0]["repositoryContext"]
            .as_object()
            .unwrap();
        assert_eq!(context.len(), 6);
        assert!(!context.contains_key("root"));
        assert_eq!(outside.root(&b.id), None);
    }
}
