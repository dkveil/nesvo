use crate::{process::display_path, protocol::Command, sessions::State};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tokio::sync::OwnedSemaphorePermit;

const NOTE_LIMIT: usize = 64 * 1024;
const LIST_LIMIT: usize = 500;
const SCAN_LIMIT: usize = 5000;
const NAME_LIMIT: usize = 128;
const PATH_LIMIT: usize = 4096;
const HEAD_BYTES: u64 = 512;
const FIRST_LINE_CHARS: usize = 120;
const EXTENSION: &str = ".md";
const NOTES_DIRECTORY: &str = "notes";
const PROJECT_DIRECTORY: &str = ".nesvo";

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: &'static str,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for Failure {}

#[derive(Debug)]
struct Stale {
    revision: Option<String>,
}

impl fmt::Display for Stale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("The note changed since it was read")
    }
}

impl std::error::Error for Stale {}

fn failure(code: &'static str, message: &'static str) -> anyhow::Error {
    Failure { code, message }.into()
}

fn error_event(error: &anyhow::Error) -> Value {
    if let Some(stale) = error.downcast_ref::<Stale>() {
        return json!({"type":"error","code":"stale_revision","message":error.to_string(),
            "revision":stale.revision});
    }
    let code = error
        .downcast_ref::<Failure>()
        .map_or("notes_failed", |failure| failure.code);
    json!({"type":"error","code":code,"message":error.to_string()})
}

pub fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::ListNotes { .. }
            | Command::ReadNote { .. }
            | Command::WriteNote { .. }
            | Command::DeleteNote { .. }
    )
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let host_id = state
        .lock()
        .map(|state| state.metadata.host_id.clone())
        .unwrap_or_default();
    let result = match (permit, config_base()) {
        (None, _) => Err(failure(
            "busy",
            "Another notes request is running on this connection",
        )),
        (Some(_), None) => Err(failure(
            "unsupported",
            "Cannot find a user configuration directory",
        )),
        (Some(_permit), Some(config)) => dispatch(command, &Roots::new(&config, &host_id)).await,
    };
    let mut event = result.unwrap_or_else(|error| error_event(&error));
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

async fn dispatch(command: Command, roots: &Roots) -> Result<Value> {
    match command {
        Command::ListNotes { root } => list_notes(roots, &root).await,
        Command::ReadNote { path } => read_note(roots, &path).await,
        Command::WriteNote {
            path,
            text,
            expected_revision,
        } => write_note(roots, &path, text, expected_revision).await,
        Command::DeleteNote { path } => delete_note(roots, &path).await,
        _ => Err(failure("invalid_argument", "Unsupported notes command")),
    }
}

fn config_base() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    }
}

#[derive(Clone)]
struct Roots {
    config: PathBuf,
    host: String,
}

impl Roots {
    fn host_directory(&self) -> PathBuf {
        self.config
            .join("nesvo")
            .join(NOTES_DIRECTORY)
            .join(&self.host)
    }

    fn new(config: &Path, host_id: &str) -> Self {
        let host = if !host_id.is_empty()
            && host_id.len() <= 64
            && host_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            host_id
        } else {
            "host"
        };
        Self {
            config: config.to_path_buf(),
            host: host.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Location {
    Repository(PathBuf),
    Host,
}

impl Location {
    fn label(&self) -> &'static str {
        match self {
            Self::Repository(_) => "repository",
            Self::Host => "host",
        }
    }
}

fn valid_name(name: &str) -> bool {
    name.len() <= NAME_LIMIT
        && name.len() > EXTENSION.len()
        && name.ends_with(EXTENSION)
        && !name.starts_with('.')
        && !name.ends_with(' ')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

fn requested(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > PATH_LIMIT || value.chars().any(char::is_control) {
        return Err(failure(
            "invalid_argument",
            "Path must be a non-empty host path without control characters",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(failure(
            "invalid_argument",
            "Path must be absolute without . or .. segments",
        ));
    }
    Ok(path)
}

async fn canonical(path: &Path) -> Option<PathBuf> {
    tokio::fs::canonicalize(path).await.ok()
}

async fn repository(directory: &Path) -> Option<PathBuf> {
    let root = crate::git::toplevel(&PathBuf::from(display_path(directory)))
        .await
        .ok()?;
    canonical(&root).await
}

fn lexical(path: &Path) -> String {
    let value = display_path(path);
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

async fn same(left: &Path, right: &Path) -> bool {
    match (canonical(left).await, canonical(right).await) {
        (Some(left), Some(right)) => left == right,
        _ => lexical(left) == lexical(right),
    }
}

async fn classify(roots: &Roots, parent: &Path) -> Result<Location> {
    if same(parent, &roots.host_directory()).await {
        return Ok(Location::Host);
    }
    let outside = || {
        failure(
            "outside_notes",
            "Notes live in <repository>/.nesvo/notes or the host notes folder",
        )
    };
    let named = |path: &Path, name: &str| path.file_name().is_some_and(|value| value == name);
    let project = parent
        .parent()
        .filter(|_| named(parent, NOTES_DIRECTORY))
        .filter(|project| named(project, PROJECT_DIRECTORY))
        .and_then(Path::parent)
        .ok_or_else(outside)?;
    let project = canonical(project).await.ok_or_else(outside)?;
    match repository(&project).await {
        Some(root) if root == project => Ok(Location::Repository(root)),
        _ => Err(outside()),
    }
}

fn notes_directory(roots: &Roots, location: &Location) -> PathBuf {
    match location {
        Location::Repository(root) => root.join(PROJECT_DIRECTORY).join(NOTES_DIRECTORY),
        Location::Host => roots.host_directory(),
    }
}

fn linked() -> anyhow::Error {
    failure("outside_notes", "The notes folder links outside its root")
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<Failure>()
        .is_some_and(|failure| failure.code == "not_found")
}

fn descend(path: &Path, create: bool) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(linked()),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(failure(
            "not_directory",
            "A notes folder level is not a folder",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            match std::fs::create_dir(path) {
                Ok(()) => descend(path, false),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    descend(path, false)
                }
                Err(_) => Err(failure(
                    "not_writable",
                    "The notes folder cannot be created",
                )),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(failure("not_found", "This note does not exist"))
        }
        Err(_) => Err(failure(
            "not_readable",
            "The notes folder cannot be inspected",
        )),
    }
}

fn secure(roots: &Roots, location: &Location, create: bool) -> Result<PathBuf> {
    let (mut directory, levels) = match location {
        Location::Repository(root) => (
            root.clone(),
            vec![PROJECT_DIRECTORY.to_owned(), NOTES_DIRECTORY.to_owned()],
        ),
        Location::Host => (
            std::fs::canonicalize(&roots.config)
                .map_err(|_| failure("not_found", "The configuration folder does not exist"))?,
            vec![
                "nesvo".to_owned(),
                NOTES_DIRECTORY.to_owned(),
                roots.host.clone(),
            ],
        ),
    };
    for level in levels {
        directory.push(level);
        descend(&directory, create)?;
    }
    let resolved = std::fs::canonicalize(&directory).map_err(|_| linked())?;
    if lexical(&resolved) != lexical(&directory) {
        return Err(linked());
    }
    Ok(directory)
}

struct Target {
    roots: Roots,
    location: Location,
    name: String,
}

impl Target {
    fn directory(&self, create: bool) -> Result<PathBuf> {
        secure(&self.roots, &self.location, create)
    }
}

async fn target(roots: &Roots, value: &str) -> Result<Target> {
    let path = requested(value)?;
    let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return Err(failure("invalid_argument", "Path must name a note"));
    };
    if !valid_name(name) {
        return Err(failure(
            "invalid_argument",
            "Note names use letters, digits, spaces, '-', '_' or '.' and end in .md",
        ));
    }
    Ok(Target {
        location: classify(roots, parent).await?,
        roots: roots.clone(),
        name: name.to_owned(),
    })
}

fn modified_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
}

fn revision(bytes: &[u8]) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

fn first_line(head: &[u8]) -> String {
    let text = String::from_utf8_lossy(head);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(FIRST_LINE_CHARS)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    name: String,
    path: String,
    size: u64,
    modified_ms: Option<u64>,
    first_line: String,
}

fn scan(directory: &Path) -> (Vec<Summary>, bool) {
    let Ok(items) = std::fs::read_dir(directory) else {
        return (Vec::new(), false);
    };
    let mut notes = Vec::new();
    let mut truncated = false;
    for (index, item) in items.enumerate() {
        if index >= SCAN_LIMIT {
            truncated = true;
            break;
        }
        let Ok(item) = item else {
            continue;
        };
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_name(&name) || !item.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        let mut head = Vec::new();
        if let Ok(file) = File::open(item.path()) {
            let _ = file.take(HEAD_BYTES).read_to_end(&mut head);
        }
        notes.push(Summary {
            path: display_path(&directory.join(&name)),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            first_line: first_line(&head),
            name,
        });
    }
    notes.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    truncated |= notes.len() > LIST_LIMIT;
    notes.truncate(LIST_LIMIT);
    (notes, truncated)
}

async fn list_notes(roots: &Roots, root: &str) -> Result<Value> {
    let requested = requested(root)?;
    let folder = canonical(&requested)
        .await
        .ok_or_else(|| failure("not_found", "This folder does not exist"))?;
    if !tokio::fs::metadata(&folder)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(failure("not_directory", "This path is not a folder"));
    }
    let location = match repository(&folder).await {
        Some(root) => Location::Repository(root),
        None => Location::Host,
    };
    let (directory, notes, truncated) = {
        let roots = roots.clone();
        let location = location.clone();
        tokio::task::spawn_blocking(move || match secure(&roots, &location, false) {
            Ok(directory) => {
                let (notes, truncated) = scan(&directory);
                Ok((directory, notes, truncated))
            }
            Err(error) if missing(&error) => {
                Ok((notes_directory(&roots, &location), Vec::new(), false))
            }
            Err(error) => Err(error),
        })
        .await
        .map_err(|_| failure("notes_failed", "Notes listing stopped"))??
    };
    let repository = match &location {
        Location::Repository(root) => Some(display_path(root)),
        Location::Host => None,
    };
    Ok(json!({
        "type": "notes",
        "root": display_path(&folder),
        "directory": display_path(&directory),
        "location": location.label(),
        "repository": repository,
        "notes": notes,
        "truncated": truncated,
    }))
}

struct Contents {
    text: String,
    size: u64,
    modified_ms: Option<u64>,
}

fn regular(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata)),
        Ok(_) => Err(failure("not_file", "This note is not a regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(failure("not_readable", "This note cannot be read")),
    }
}

fn decode(bytes: Vec<u8>) -> Result<String> {
    if bytes.contains(&0) {
        return Err(failure("binary", "Binary files are not notes"));
    }
    String::from_utf8(bytes).map_err(|_| failure("not_text", "Notes must be UTF-8 text"))
}

fn load(path: &Path) -> Result<Option<Contents>> {
    let Some(metadata) = regular(path)? else {
        return Ok(None);
    };
    if metadata.len() > NOTE_LIMIT as u64 {
        return Err(failure("too_large", "Notes are limited to 64 KiB"));
    }
    let file = File::open(path).map_err(|_| failure("not_readable", "This note cannot be read"))?;
    if !path
        .parent()
        .is_some_and(|directory| crate::handle_paths::opened_inside(&file, directory))
    {
        return Err(linked());
    }
    let mut bytes = Vec::new();
    file.take(NOTE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("not_readable", "This note cannot be read"))?;
    if bytes.len() > NOTE_LIMIT {
        return Err(failure("too_large", "Notes are limited to 64 KiB"));
    }
    Ok(Some(Contents {
        text: decode(bytes)?,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
    }))
}

async fn read_note(roots: &Roots, path: &str) -> Result<Value> {
    let target = target(roots, path).await?;
    let name = target.name.clone();
    let (file, contents) = tokio::task::spawn_blocking(move || -> Result<(PathBuf, Contents)> {
        let file = target.directory(false)?.join(&target.name);
        let contents =
            load(&file)?.ok_or_else(|| failure("not_found", "This note does not exist"))?;
        Ok((file, contents))
    })
    .await
    .map_err(|_| failure("notes_failed", "Note read stopped"))??;
    Ok(json!({
        "type": "note",
        "path": display_path(&file),
        "name": name,
        "text": contents.text,
        "size": contents.size,
        "modifiedMs": contents.modified_ms,
        "revision": revision(contents.text.as_bytes()),
    }))
}

struct Stored {
    path: PathBuf,
    created: bool,
    metadata: std::fs::Metadata,
}

fn store(target: &Target, text: &str, expected: Option<&str>) -> Result<Stored> {
    store_with(target, text, expected, |_| {})
}

fn store_with(
    target: &Target,
    text: &str,
    expected: Option<&str>,
    checked: impl FnOnce(&Path),
) -> Result<Stored> {
    let _guard = WRITES
        .lock()
        .map_err(|_| failure("notes_failed", "Note writer stopped"))?;
    let directory = target.directory(true)?;
    checked(&directory);
    let path = directory.join(&target.name);
    let current = load(&path)?;
    let actual = current
        .as_ref()
        .map(|contents| revision(contents.text.as_bytes()));
    if actual.as_deref() != expected {
        return Err(Stale { revision: actual }.into());
    }
    let temporary = directory.join(format!(
        ".{}.{}.tmp",
        target.name,
        hex::encode(crate::wire::random::<6>())
    ));
    let written = (|| -> std::io::Result<bool> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if !crate::handle_paths::opened_inside(&file, &directory) {
            return Ok(false);
        }
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        Ok(true)
    })();
    match written {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(linked());
        }
        Err(_) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(failure("not_writable", "The note cannot be written"));
        }
    }
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| failure("not_readable", "The saved note cannot be inspected"))?;
    Ok(Stored {
        path,
        created: current.is_none(),
        metadata,
    })
}

async fn write_note(
    roots: &Roots,
    path: &str,
    text: String,
    expected: Option<String>,
) -> Result<Value> {
    if text.len() > NOTE_LIMIT {
        return Err(failure("too_large", "Notes are limited to 64 KiB"));
    }
    if text.contains('\0') {
        return Err(failure("invalid_argument", "Notes cannot contain NUL"));
    }
    if expected
        .as_deref()
        .is_some_and(|value| value.len() != 64 || !value.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(failure(
            "invalid_argument",
            "expectedRevision must be a note revision",
        ));
    }
    let target = target(roots, path).await?;
    let name = target.name.clone();
    let revision = revision(text.as_bytes());
    let stored = tokio::task::spawn_blocking(move || store(&target, &text, expected.as_deref()))
        .await
        .map_err(|_| failure("notes_failed", "Note write stopped"))??;
    Ok(json!({
        "type": "noteSaved",
        "path": display_path(&stored.path),
        "name": name,
        "revision": revision,
        "size": stored.metadata.len(),
        "modifiedMs": modified_ms(&stored.metadata),
        "created": stored.created,
    }))
}

async fn delete_note(roots: &Roots, path: &str) -> Result<Value> {
    let target = target(roots, path).await?;
    let name = target.name.clone();
    let file = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let _guard = WRITES
            .lock()
            .map_err(|_| failure("notes_failed", "Note writer stopped"))?;
        let file = target.directory(false)?.join(&target.name);
        regular(&file)?.ok_or_else(|| failure("not_found", "This note does not exist"))?;
        std::fs::remove_file(&file)
            .map_err(|_| failure("not_writable", "The note cannot be deleted"))?;
        Ok(file)
    })
    .await
    .map_err(|_| failure("notes_failed", "Note delete stopped"))??;
    Ok(json!({
        "type": "noteDeleted",
        "path": display_path(&file),
        "name": name,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nesvo-notes-{label}-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    fn repository_fixture() -> PathBuf {
        let path = temporary("repo");
        let status = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(display_path(&path))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::create_dir(path.join("src")).unwrap();
        path
    }

    fn roots() -> (PathBuf, Roots) {
        let config = PathBuf::from(display_path(&temporary("config")));
        let roots = Roots::new(&config, "abc123");
        (config, roots)
    }

    fn code(error: &anyhow::Error) -> String {
        error_event(error)["code"].as_str().unwrap().to_owned()
    }

    fn note(directory: &str, name: &str) -> String {
        display_path(&PathBuf::from(directory).join(name))
    }

    #[tokio::test]
    async fn notes_root_selection_prefers_the_repository_and_falls_back_to_the_host_folder() {
        let (config, roots) = roots();
        let repository = repository_fixture();
        let listed = list_notes(&roots, &display_path(&repository.join("src")))
            .await
            .unwrap();
        assert_eq!(listed["location"], "repository");
        assert_eq!(listed["repository"], display_path(&repository));
        assert_eq!(
            listed["directory"],
            display_path(&repository.join(".nesvo").join("notes"))
        );
        assert_eq!(listed["notes"], json!([]));
        let plain = temporary("plain");
        let listed = list_notes(&roots, &display_path(&plain)).await.unwrap();
        assert_eq!(listed["location"], "host");
        assert_eq!(listed["repository"], Value::Null);
        assert_eq!(
            listed["directory"],
            display_path(&config.join("nesvo").join("notes").join("abc123"))
        );
        assert_eq!(
            Roots::new(&config, "../escape").host_directory(),
            config.join("nesvo").join("notes").join("host")
        );
        assert!(!repository.join(".nesvo").exists());
    }

    #[tokio::test]
    async fn notes_write_read_list_and_delete_round_trip_with_first_lines() {
        let (_config, roots) = roots();
        let repository = repository_fixture();
        let directory = display_path(&repository.join(".nesvo").join("notes"));
        let path = note(&directory, "plan.md");
        let saved = write_note(&roots, &path, "\n# Plan\n- ship notes\n".into(), None)
            .await
            .unwrap();
        assert_eq!(saved["type"], "noteSaved");
        assert_eq!(saved["created"], true);
        assert_eq!(saved["name"], "plan.md");
        let read = read_note(&roots, &path).await.unwrap();
        assert_eq!(read["text"], "\n# Plan\n- ship notes\n");
        assert_eq!(read["revision"], saved["revision"]);
        let listed = list_notes(&roots, &display_path(&repository))
            .await
            .unwrap();
        assert_eq!(listed["notes"][0]["name"], "plan.md");
        assert_eq!(listed["notes"][0]["firstLine"], "# Plan");
        assert_eq!(listed["notes"][0]["path"], read["path"]);
        let deleted = delete_note(&roots, &path).await.unwrap();
        assert_eq!(deleted["type"], "noteDeleted");
        let missing = read_note(&roots, &path).await.unwrap_err();
        assert_eq!(code(&missing), "not_found");
        let missing = delete_note(&roots, &path).await.unwrap_err();
        assert_eq!(code(&missing), "not_found");
    }

    #[tokio::test]
    async fn notes_stale_revisions_are_refused_with_the_current_revision() {
        let (_config, roots) = roots();
        let plain = temporary("stale");
        let listed = list_notes(&roots, &display_path(&plain)).await.unwrap();
        let path = note(listed["directory"].as_str().unwrap(), "today.md");
        let first = write_note(&roots, &path, "one".into(), None).await.unwrap();
        let again = write_note(&roots, &path, "blind".into(), None)
            .await
            .unwrap_err();
        let event = error_event(&again);
        assert_eq!(event["code"], "stale_revision");
        assert_eq!(event["revision"], first["revision"]);
        let second = write_note(
            &roots,
            &path,
            "two".into(),
            first["revision"].as_str().map(str::to_owned),
        )
        .await
        .unwrap();
        assert_eq!(second["created"], false);
        let stale = write_note(
            &roots,
            &path,
            "three".into(),
            first["revision"].as_str().map(str::to_owned),
        )
        .await
        .unwrap_err();
        assert_eq!(error_event(&stale)["revision"], second["revision"]);
        assert_eq!(read_note(&roots, &path).await.unwrap()["text"], "two");
        std::fs::remove_file(PathBuf::from(&path)).unwrap();
        let gone = write_note(
            &roots,
            &path,
            "four".into(),
            second["revision"].as_str().map(str::to_owned),
        )
        .await
        .unwrap_err();
        assert_eq!(error_event(&gone)["revision"], Value::Null);
        let malformed = write_note(&roots, &path, "x".into(), Some("nope".into()))
            .await
            .unwrap_err();
        assert_eq!(code(&malformed), "invalid_argument");
    }

    #[tokio::test]
    async fn notes_caps_refuse_large_binary_and_oversized_files() {
        let (_config, roots) = roots();
        let plain = temporary("caps");
        let listed = list_notes(&roots, &display_path(&plain)).await.unwrap();
        let directory = listed["directory"].as_str().unwrap().to_owned();
        let path = note(&directory, "big.md");
        let exact = "a".repeat(NOTE_LIMIT);
        write_note(&roots, &path, exact, None).await.unwrap();
        let over = write_note(
            &roots,
            &note(&directory, "over.md"),
            "a".repeat(NOTE_LIMIT + 1),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&over), "too_large");
        let nul = write_note(&roots, &note(&directory, "nul.md"), "a\0b".into(), None)
            .await
            .unwrap_err();
        assert_eq!(code(&nul), "invalid_argument");
        std::fs::write(
            PathBuf::from(&directory).join("huge.md"),
            vec![b'a'; NOTE_LIMIT + 1],
        )
        .unwrap();
        let huge = read_note(&roots, &note(&directory, "huge.md"))
            .await
            .unwrap_err();
        assert_eq!(code(&huge), "too_large");
        std::fs::write(PathBuf::from(&directory).join("bin.md"), b"a\0b").unwrap();
        let binary = read_note(&roots, &note(&directory, "bin.md"))
            .await
            .unwrap_err();
        assert_eq!(code(&binary), "binary");
        std::fs::write(PathBuf::from(&directory).join("latin.md"), [0xff, 0xfe]).unwrap();
        let latin = read_note(&roots, &note(&directory, "latin.md"))
            .await
            .unwrap_err();
        assert_eq!(code(&latin), "not_text");
        assert_eq!(read_note(&roots, &path).await.unwrap()["size"], NOTE_LIMIT);
    }

    #[tokio::test]
    async fn notes_path_validation_refuses_paths_outside_note_roots() {
        let (_config, roots) = roots();
        let repository = repository_fixture();
        let notes = repository.join(".nesvo").join("notes");
        let directory = display_path(&notes);
        for (path, expected) in [
            (String::new(), "invalid_argument"),
            ("relative/.nesvo/notes/a.md".to_owned(), "invalid_argument"),
            (note(&directory, "a.txt"), "invalid_argument"),
            (note(&directory, ".hidden.md"), "invalid_argument"),
            (note(&directory, "bad\u{7}.md"), "invalid_argument"),
            (
                format!(
                    "{}{}..{}a.md",
                    directory,
                    std::path::MAIN_SEPARATOR,
                    std::path::MAIN_SEPARATOR
                ),
                "invalid_argument",
            ),
            (display_path(&repository.join("a.md")), "outside_notes"),
            (
                display_path(&repository.join("src").join("a.md")),
                "outside_notes",
            ),
            (
                display_path(
                    &repository
                        .join("src")
                        .join(".nesvo")
                        .join("notes")
                        .join("a.md"),
                ),
                "outside_notes",
            ),
            (
                display_path(&temporary("loose").join(".nesvo").join("notes").join("a.md")),
                "outside_notes",
            ),
        ] {
            let error = write_note(&roots, &path, "x".into(), None)
                .await
                .unwrap_err();
            assert_eq!(code(&error), expected, "{path}");
            let error = read_note(&roots, &path).await.unwrap_err();
            assert_eq!(code(&error), expected, "{path}");
        }
        assert!(!repository.join("src").join(".nesvo").exists());
        std::fs::create_dir_all(notes.join("folder.md")).unwrap();
        let folder = read_note(&roots, &note(&directory, "folder.md"))
            .await
            .unwrap_err();
        assert_eq!(code(&folder), "not_file");
        write_note(&roots, &note(&directory, "Plan 2.md"), "ok".into(), None)
            .await
            .unwrap();
        let listed = list_notes(&roots, &display_path(&repository))
            .await
            .unwrap();
        let names: Vec<_> = listed["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|note| note["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, ["Plan 2.md"]);
    }

    fn link_directory(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
                || std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(display_path(link))
                    .arg(display_path(target))
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
        }
    }

    #[tokio::test]
    async fn notes_refuse_a_notes_folder_linked_outside_the_repository() {
        let (_config, roots) = roots();
        let repository = repository_fixture();
        let elsewhere = temporary("elsewhere");
        std::fs::write(elsewhere.join("seed.md"), "outside").unwrap();
        std::fs::create_dir(repository.join(".nesvo")).unwrap();
        let notes = repository.join(".nesvo").join("notes");
        assert!(link_directory(&elsewhere, &notes));
        let path = display_path(&notes.join("a.md"));
        let error = write_note(&roots, &path, "x".into(), None)
            .await
            .unwrap_err();
        assert_eq!(code(&error), "outside_notes");
        assert!(!elsewhere.join("a.md").exists());
        let seed = display_path(&notes.join("seed.md"));
        assert_eq!(
            code(&read_note(&roots, &seed).await.unwrap_err()),
            "outside_notes"
        );
        assert_eq!(
            code(&delete_note(&roots, &seed).await.unwrap_err()),
            "outside_notes"
        );
        assert!(elsewhere.join("seed.md").exists());
        let listed = list_notes(&roots, &display_path(&repository))
            .await
            .unwrap_err();
        assert_eq!(code(&listed), "outside_notes");
    }

    #[tokio::test]
    async fn a_notes_folder_swapped_for_a_link_after_the_check_keeps_the_save_inside() {
        let (_config, roots) = roots();
        let repository = repository_fixture();
        let elsewhere = temporary("swapped");
        let path = display_path(&repository.join(".nesvo").join("notes").join("a.md"));
        let target = target(&roots, &path).await.unwrap();
        let error = store_with(&target, "x", None, |directory| {
            std::fs::rename(directory, directory.with_file_name("moved")).unwrap();
            assert!(link_directory(&elsewhere, directory));
        })
        .err()
        .unwrap();
        assert_eq!(code(&error), "outside_notes");
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        std::fs::write(elsewhere.join("a.md"), "outside").unwrap();
        let read = read_note(&roots, &path).await.unwrap_err();
        assert_eq!(code(&read), "outside_notes");
    }

    #[tokio::test]
    async fn notes_refuse_a_project_folder_that_is_a_linked_directory_or_a_regular_file() {
        let (_config, roots) = roots();
        let repository = repository_fixture();
        let elsewhere = temporary("project-link");
        assert!(link_directory(&elsewhere, &repository.join(".nesvo")));
        let path = display_path(&repository.join(".nesvo").join("notes").join("a.md"));
        let error = write_note(&roots, &path, "x".into(), None)
            .await
            .unwrap_err();
        assert_eq!(code(&error), "outside_notes");
        assert!(!elsewhere.join("notes").exists());
        let repository = repository_fixture();
        std::fs::write(repository.join(".nesvo"), "file").unwrap();
        let path = display_path(&repository.join(".nesvo").join("notes").join("a.md"));
        let error = write_note(&roots, &path, "x".into(), None)
            .await
            .unwrap_err();
        assert_eq!(code(&error), "not_directory");
        assert_eq!(std::fs::read(repository.join(".nesvo")).unwrap(), b"file");
        let listed = list_notes(&roots, &display_path(&repository))
            .await
            .unwrap_err();
        assert_eq!(code(&listed), "not_directory");
    }
}
