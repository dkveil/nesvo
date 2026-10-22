use crate::{
    event_log::{DomainEvent, model},
    launchers::Program,
    mcp_bridge::{self, Endpoint, Launch, Lease},
    mcp_pool::{self, Origin, Pool, Spec},
    process::display_path,
    worktrees::{self, CONFIG_FILE, Item, Store, command_failure},
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub(crate) const TABLE: &str = "mcp.server";
pub(crate) const SERVER_LIMIT: usize = 8;
const NAME_BYTES: usize = 64;
const COMMAND_BYTES: usize = 1024;
const ARGUMENT_BYTES: usize = 4096;
const ENV_LIMIT: usize = 32;
const ENV_NAME_BYTES: usize = 128;
const CWD_BYTES: usize = 512;
const RESERVED: &str = "nesvo";
const PRIVATE_PREFIXES: [&str; 2] = ["NESVO_", "POCKET_"];
const RESOLVE_DEADLINE: Duration = Duration::from_secs(5);
const LEASE_PREFIX: &str = "nesvo-mcp-lease-";
const SOURCE: &str = "HEAD:nesvo.toml";

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub cwd: String,
}

impl Declaration {
    fn bytes(&self) -> usize {
        self.command.len()
            + self
                .args
                .iter()
                .chain(&self.env)
                .map(String::len)
                .sum::<usize>()
    }
}

#[derive(Default)]
pub(crate) struct Draft {
    name: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<Vec<String>>,
    cwd: Option<String>,
}

fn set<T>(slot: &mut Option<T>, key: &str, value: T) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("duplicate key {key}"));
    }
    *slot = Some(value);
    Ok(())
}

impl Draft {
    pub(crate) fn assign(&mut self, key: &str, value: Item) -> Result<(), String> {
        match (key, value) {
            ("name", Item::Text(text)) => set(&mut self.name, key, text),
            ("command", Item::Text(text)) => set(&mut self.command, key, text),
            ("args", Item::List(list)) => set(&mut self.args, key, list),
            ("env", Item::List(list)) => set(&mut self.env, key, list),
            ("cwd", Item::Text(text)) => set(&mut self.cwd, key, text),
            ("name" | "command" | "args" | "env" | "cwd", _) => {
                Err(format!("{key} has the wrong value type"))
            }
            _ => Err(format!("unsupported key {key} in [[{TABLE}]]")),
        }
    }

    fn finish(self) -> Result<Declaration, String> {
        let name = self
            .name
            .ok_or_else(|| format!("every [[{TABLE}]] entry needs a name"))?;
        if !valid_name(&name) {
            return Err(format!(
                "server name {name:?} must be 1-{NAME_BYTES} lowercase letters, digits, '-' or '_', start with a letter or digit and not be {RESERVED}"
            ));
        }
        let command = self
            .command
            .ok_or_else(|| format!("server {name} needs a command"))?;
        if !valid_command(&command) {
            return Err(format!(
                "server {name}: command must be a program name looked up on the host PATH or an absolute path of at most {COMMAND_BYTES} bytes"
            ));
        }
        let args = self.args.unwrap_or_default();
        if args.len() > mcp_pool::BOUNDS.arguments
            || !args.iter().all(|arg| valid_text(arg, ARGUMENT_BYTES))
        {
            return Err(format!(
                "server {name}: args holds at most {} single-line arguments of at most {ARGUMENT_BYTES} bytes",
                mcp_pool::BOUNDS.arguments
            ));
        }
        let env = self.env.unwrap_or_default();
        let mut unique = HashSet::new();
        if env.len() > ENV_LIMIT
            || !env.iter().all(|variable| {
                valid_env_name(variable) && unique.insert(variable.to_ascii_uppercase())
            })
        {
            return Err(format!(
                "server {name}: env lists at most {ENV_LIMIT} unique variable names, none starting with NESVO_ or POCKET_"
            ));
        }
        let cwd = self.cwd.unwrap_or_else(|| ".".into());
        if !valid_cwd(&cwd) {
            return Err(format!(
                "server {name}: cwd must be a relative folder with forward slashes inside the repository, outside .git and .nesvo"
            ));
        }
        let declaration = Declaration {
            name,
            command,
            args,
            env,
            cwd,
        };
        if declaration.bytes() > mcp_pool::BOUNDS.config_bytes {
            return Err(format!(
                "server {}: the declaration exceeds {} bytes",
                declaration.name,
                mcp_pool::BOUNDS.config_bytes
            ));
        }
        Ok(declaration)
    }
}

pub(crate) fn finish(drafts: Vec<Draft>) -> Result<Vec<Declaration>> {
    let mut names = HashSet::new();
    let mut declarations = Vec::with_capacity(drafts.len());
    for (index, draft) in drafts.into_iter().enumerate() {
        let declaration = draft.finish().map_err(|message| {
            anyhow!("{CONFIG_FILE} [[{TABLE}]] entry {}: {message}", index + 1)
        })?;
        if !names.insert(declaration.name.clone()) {
            return Err(anyhow!(
                "{CONFIG_FILE}: MCP server {} is declared twice",
                declaration.name
            ));
        }
        declarations.push(declaration);
    }
    Ok(declarations)
}

fn valid_name(name: &str) -> bool {
    name != RESERVED
        && (1..=NAME_BYTES).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
}

fn valid_text(text: &str, limit: usize) -> bool {
    text.len() <= limit && !text.chars().any(|c| c.is_control() && c != '\t')
}

fn bare(command: &str) -> bool {
    !command.contains(['/', '\\', ':']) && command != "." && command != ".."
}

fn valid_command(command: &str) -> bool {
    !command.is_empty()
        && command.trim() == command
        && valid_text(command, COMMAND_BYTES)
        && (bare(command) || Path::new(command).is_absolute())
}

fn valid_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    (1..=ENV_NAME_BYTES).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && !PRIVATE_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
}

fn valid_cwd(cwd: &str) -> bool {
    if cwd == "." {
        return true;
    }
    let components: Vec<&str> = cwd.split('/').collect();
    cwd.len() <= CWD_BYTES
        && !cwd
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':'))
        && components
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != "..")
        && !matches!(components[0], ".git" | ".nesvo")
}

struct Source {
    repository: String,
    root: PathBuf,
    digest: String,
    approved: bool,
    declarations: Vec<Declaration>,
}

fn has_config(root: &Path) -> bool {
    root.join(CONFIG_FILE).is_file()
}

fn checkout(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .find(|folder| folder.join(".git").exists())
        .filter(|folder| has_config(folder))
        .map(Path::to_owned)
}

async fn head_source(
    store: Option<&Store>,
    repository_root: &Path,
    root: PathBuf,
) -> Option<Source> {
    let text = worktrees::head_text(repository_root).await.ok()??;
    let config = worktrees::parse(&text).ok()?;
    if config.mcp_servers.is_empty() {
        return None;
    }
    let repository = worktrees::repository_key(repository_root);
    let digest = config.digest();
    Some(Source {
        approved: store.is_some_and(|store| store.approved(&repository, &digest)),
        repository,
        root,
        digest,
        declarations: config.mcp_servers,
    })
}

enum Lookup {
    Recorded(Source),
    Head {
        repository_root: PathBuf,
        root: Option<PathBuf>,
    },
}

fn lookup(store: Option<&Store>, session_id: &str, cwd: &Path) -> Option<Lookup> {
    if let Some(record) = store
        .and_then(|store| store.find(session_id))
        .filter(|record| record.archived_at.is_none())
    {
        let root = PathBuf::from(&record.worktree);
        if let (Some(config), Some(digest)) = (&record.config, &record.digest) {
            if config.mcp_servers.is_empty() {
                return None;
            }
            return Some(Lookup::Recorded(Source {
                approved: store.is_some_and(|store| store.approved(&record.repository, digest)),
                repository: record.repository.clone(),
                root,
                digest: digest.clone(),
                declarations: config.mcp_servers.clone(),
            }));
        }
        let repository_root = PathBuf::from(&record.repository);
        return has_config(&repository_root).then_some(Lookup::Head {
            repository_root,
            root: Some(root),
        });
    }
    checkout(cwd).map(|_| Lookup::Head {
        repository_root: cwd.to_owned(),
        root: None,
    })
}

async fn resolve_head(
    store: Option<&Store>,
    directory: &Path,
    root: Option<PathBuf>,
) -> Option<Source> {
    match root {
        Some(root) => head_source(store, directory, root).await,
        None => {
            let repository_root = crate::git::discover(directory).await.ok()??;
            head_source(store, &repository_root, repository_root.clone()).await
        }
    }
}

fn discover(session_id: &str, cwd: &Path) -> Option<Source> {
    let store = worktrees::store();
    match lookup(store, session_id, cwd)? {
        Lookup::Recorded(source) => Some(source),
        Lookup::Head {
            repository_root,
            root,
        } => std::thread::scope(|scope| {
            scope
                .spawn(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .ok()?;
                    runtime.block_on(async {
                        tokio::time::timeout(
                            RESOLVE_DEADLINE,
                            resolve_head(store, &repository_root, root),
                        )
                        .await
                        .ok()
                        .flatten()
                    })
                })
                .join()
                .ok()
                .flatten()
        }),
    }
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

#[cfg(windows)]
fn candidates(directory: &Path, name: &str) -> Vec<PathBuf> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
    let mut found = Vec::new();
    if Path::new(name).extension().is_some() {
        found.push(directory.join(name));
    }
    found.extend(
        extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| directory.join(format!("{name}{extension}"))),
    );
    found
}

#[cfg(not(windows))]
fn candidates(directory: &Path, name: &str) -> Vec<PathBuf> {
    vec![directory.join(name)]
}

pub(crate) fn locate(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() {
        return executable(path).then(|| path.to_owned());
    }
    if !bare(command) {
        return None;
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .filter(|directory| directory.is_absolute())
        .flat_map(|directory| candidates(&directory, command))
        .find(|candidate| executable(candidate))
}

fn server_root(checkout: &Path, cwd: &str) -> Result<PathBuf, &'static str> {
    let checkout = checkout.canonicalize().map_err(|_| "cwdUnavailable")?;
    let root = checkout
        .join(cwd)
        .canonicalize()
        .map_err(|_| "cwdUnavailable")?;
    if !root.starts_with(&checkout) {
        return Err("cwdOutsideRepository");
    }
    if !root.is_dir() {
        return Err("cwdUnavailable");
    }
    Ok(root)
}

fn spec(
    program: Program,
    source: &Source,
    declaration: &Declaration,
) -> Result<Spec, &'static str> {
    let root = server_root(&source.root, &declaration.cwd)?;
    let command = locate(&declaration.command).ok_or("commandUnavailable")?;
    let env: BTreeMap<String, String> = declaration
        .env
        .iter()
        .filter_map(|name| Some((name.clone(), std::env::var(name).ok()?)))
        .collect();
    Ok(Spec {
        program,
        server: declaration.name.clone(),
        command,
        args: declaration.args.clone(),
        env,
        root,
        origin: Some(Origin {
            repository: source.repository.clone(),
            digest: source.digest.clone(),
        }),
    })
}

fn leases() -> &'static Mutex<HashMap<String, PathBuf>> {
    static LEASES: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    LEASES.get_or_init(Mutex::default)
}

fn lease_directory(session_id: &str) -> Option<PathBuf> {
    let mut leases = leases().lock().ok()?;
    if let Some(directory) = leases.get(session_id) {
        return Some(directory.clone());
    }
    let directory = std::env::temp_dir().join(format!(
        "{LEASE_PREFIX}{}",
        hex::encode(crate::wire::random::<16>())
    ));
    std::fs::create_dir(&directory).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).is_err() {
            let _ = std::fs::remove_dir(&directory);
            return None;
        }
    }
    leases.insert(session_id.to_owned(), directory.clone());
    Some(directory)
}

fn remove_lease_directory(directory: &Path) {
    let owned = directory.parent() == Some(std::env::temp_dir().as_path())
        && directory
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(LEASE_PREFIX));
    if owned {
        let _ = std::fs::remove_dir_all(directory);
    }
}

pub(crate) fn release(session_id: &str) {
    let directory = leases()
        .lock()
        .ok()
        .and_then(|mut leases| leases.remove(session_id));
    if let Some(directory) = directory {
        remove_lease_directory(&directory);
    }
}

pub(crate) fn release_all() {
    let directories: Vec<PathBuf> = leases()
        .lock()
        .map(|mut leases| leases.drain().map(|(_, directory)| directory).collect())
        .unwrap_or_default();
    for directory in directories {
        remove_lease_directory(&directory);
    }
}

fn lease_document(spec: &Spec, outcome: &Value) -> Lease {
    let lease = (outcome["mode"] == "pooled")
        .then(|| {
            Some(Endpoint {
                endpoint: outcome["endpoint"].as_str()?.to_owned(),
                token: outcome["token"].as_str()?.to_owned(),
            })
        })
        .flatten();
    Lease {
        version: mcp_bridge::VERSION,
        server: spec.server.clone(),
        lease,
        spawn: Launch {
            command: spec.command.clone(),
            args: spec.args.clone(),
            cwd: PathBuf::from(display_path(&spec.root)),
            env: spec.env.clone(),
        },
    }
}

fn expose(
    pool: &Arc<Pool>,
    program: Program,
    session_id: &str,
    source: &Source,
    bridge: &Path,
) -> Map<String, Value> {
    let mut servers = Map::new();
    if !source.approved {
        return servers;
    }
    let Some(directory) = lease_directory(session_id) else {
        return servers;
    };
    for declaration in &source.declarations {
        let Ok(spec) = spec(program, source, declaration) else {
            continue;
        };
        let outcome = pool.attach(&spec, session_id);
        let file = directory.join(format!("{}.json", declaration.name));
        let Ok(bytes) = serde_json::to_vec(&lease_document(&spec, &outcome)) else {
            continue;
        };
        if crate::private_write(&file, &bytes).is_err() {
            continue;
        }
        pool.journal(
            Some(session_id.into()),
            DomainEvent::McpServerAttached(model::McpServerAttached {
                server: declaration.name.clone(),
                repository: source.repository.clone(),
                digest: source.digest.clone(),
                root: display_path(&spec.root),
                mode: outcome["mode"].as_str().unwrap_or("cold").to_owned(),
                reason: outcome["reason"].as_str().map(str::to_owned),
                entry_id: outcome["entryId"].as_str().map(str::to_owned),
            }),
        );
        servers.insert(
            declaration.name.clone(),
            json!({"type":"stdio","command":display_path(bridge),"args":[mcp_bridge::FLAG, display_path(&file)]}),
        );
    }
    servers
}

pub(crate) fn claude(command: &portable_pty::CommandBuilder) -> Map<String, Value> {
    let session = command.get_env("NESVO_SESSION_ID").and_then(OsStr::to_str);
    let cwd = command.get_cwd().map(Path::new);
    let (Some(session), Some(cwd), Ok(bridge)) = (session, cwd, std::env::current_exe()) else {
        return Map::new();
    };
    match discover(session, cwd) {
        Some(source) => expose(
            mcp_pool::global(),
            Program::Claude,
            session,
            &source,
            &bridge,
        ),
        None => Map::new(),
    }
}

fn server_view(source: Option<&Source>, declaration: &Declaration, approved: bool) -> Value {
    let resolution = source.map_or(Ok(()), |source| {
        server_root(&source.root, &declaration.cwd).map(|_| ())
    });
    let command = locate(&declaration.command);
    json!({
        "name":declaration.name,
        "command":declaration.command,
        "args":declaration.args,
        "env":declaration.env,
        "cwd":declaration.cwd,
        "state":if approved {"approved"} else {"unapproved"},
        "resolvedCommand":command.as_deref().map(display_path),
        "problem":resolution.err().or(command.is_none().then_some("commandUnavailable")),
    })
}

pub(crate) async fn list(store: &Store, directory: &str) -> Result<Value> {
    let root = crate::git::toplevel(&worktrees::host_directory(directory)?)
        .await
        .map_err(|_| {
            command_failure(
                "invalid_argument",
                "The folder is not inside a Git repository",
            )
        })?;
    let repository = worktrees::repository_key(&root);
    let config = worktrees::head_text(&root)
        .await
        .and_then(|text| text.as_deref().map(worktrees::parse).transpose())
        .map_err(|error| command_failure("worktree_config_invalid", error.to_string()))?;
    let digest = config.as_ref().map(worktrees::Config::digest);
    let approved = digest
        .as_deref()
        .is_some_and(|digest| store.approved(&repository, digest));
    let declarations = config.map(|config| config.mcp_servers).unwrap_or_default();
    let source = Source {
        repository: repository.clone(),
        root: root.clone(),
        digest: digest.clone().unwrap_or_default(),
        approved,
        declarations,
    };
    let servers: Vec<Value> = source
        .declarations
        .iter()
        .map(|declaration| server_view(Some(&source), declaration, approved))
        .collect();
    Ok(json!({
        "type":"mcpServers",
        "repository":repository,
        "source":SOURCE,
        "configured":!servers.is_empty(),
        "digest":digest,
        "approved":approved,
        "servers":servers,
        "attached":mcp_pool::attachments(&repository),
        "providers":{"claude":"launchConfig","codex":"unsupported","gemini":"unsupported"},
        "bounds":{"serversPerRepository":SERVER_LIMIT,"processes":mcp_pool::BOUNDS.processes,"warmPerKey":mcp_pool::BOUNDS.warm_per_key},
    }))
}

#[cfg(test)]
#[path = "mcp_servers_tests.rs"]
mod tests;
