use crate::{process::display_path, protocol::Command, sessions::State};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::sync::OwnedSemaphorePermit;

const ENTRY_LIMIT: usize = 2000;
const SCAN_LIMIT: usize = 20_000;
const READ_LIMIT: usize = 64 * 1024;
const SNIFF_LIMIT: u64 = 8 * 1024;
const WALK_LIMIT: usize = 5000;
const WALK_DEPTH: usize = 32;
const MATCH_DEFAULT: usize = 50;
const MATCH_LIMIT: usize = 200;
const QUERY_LIMIT: usize = 256;
const PATH_LIMIT: usize = 4096;
const STATUS_LIMIT: usize = 4 * 1024 * 1024;
const GIT_DEADLINE: Duration = Duration::from_secs(10);
const CACHE_TTL: Duration = Duration::from_secs(2);
const CACHE_ROOTS: usize = 32;

static STATUSES: LazyLock<Cache<Status>> = LazyLock::new(Cache::default);
static WALKS: LazyLock<Cache<Walk>> = LazyLock::new(Cache::default);

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

fn failure(code: &'static str, message: &'static str) -> anyhow::Error {
    Failure { code, message }.into()
}

fn error_event(error: &anyhow::Error) -> Value {
    let code = error
        .downcast_ref::<Failure>()
        .map_or("files_failed", |failure| failure.code);
    json!({"type":"error","code":code,"message":error.to_string()})
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let result = match permit {
        Some(_permit) => dispatch(command).await,
        None => Err(failure(
            "busy",
            "Another file request is running on this connection",
        )),
    };
    let mut event = result.unwrap_or_else(|error| error_event(&error));
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

async fn dispatch(command: Command) -> Result<Value> {
    match command {
        Command::ListEntries {
            directory,
            show_hidden,
        } => list_entries(&directory, show_hidden).await,
        Command::ReadFile {
            path,
            offset,
            limit,
        } => read_file(&path, offset.unwrap_or(0), limit).await,
        Command::FindFiles { root, query, limit } => find_files(&root, &query, limit).await,
        _ => Err(failure("invalid_argument", "Unsupported file command")),
    }
}

struct Cache<T> {
    entries: Mutex<HashMap<PathBuf, (Instant, Arc<T>)>>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> Cache<T> {
    fn get(&self, root: &Path) -> Option<Arc<T>> {
        let entries = self.entries.lock().ok()?;
        entries
            .get(root)
            .filter(|(at, _)| at.elapsed() < CACHE_TTL)
            .map(|(_, value)| value.clone())
    }

    fn put(&self, root: PathBuf, value: Arc<T>) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        if entries.len() >= CACHE_ROOTS
            && let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(key, _)| key.clone())
        {
            entries.remove(&oldest);
        }
        entries.insert(root, (Instant::now(), value));
    }
}

fn requested(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > PATH_LIMIT || value.chars().any(char::is_control) {
        return Err(failure(
            "invalid_argument",
            "Path must be a non-empty host path without control characters",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(failure("invalid_argument", "Path must be absolute"));
    }
    Ok(path)
}

async fn folder(path: &Path) -> Result<PathBuf> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| failure("not_found", "This folder does not exist"))?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| failure("not_found", "This folder does not exist"))?;
    if !metadata.is_dir() {
        return Err(failure("not_directory", "This path is not a folder"));
    }
    Ok(path)
}

async fn repository(directory: &Path) -> Option<PathBuf> {
    let root = crate::git::toplevel(&plain(directory)).await.ok()?;
    tokio::fs::canonicalize(root).await.ok()
}

fn plain(path: &Path) -> PathBuf {
    PathBuf::from(display_path(path))
}

fn relative_key(path: &Path) -> Option<String> {
    path.components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join("/"))
}

fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/')
        .map(move |(index, _)| &path[..index])
}

#[derive(Default)]
struct Status {
    paths: HashMap<String, &'static str>,
    folders: HashMap<String, &'static str>,
    ignored: HashSet<String>,
    truncated: bool,
}

impl Status {
    fn is_ignored(&self, key: &str) -> bool {
        self.ignored.contains(key) || ancestors(key).any(|parent| self.ignored.contains(parent))
    }

    fn letter(&self, key: &str, folder: bool) -> Option<&'static str> {
        if self.is_ignored(key) {
            return Some("!");
        }
        let letters = if folder { &self.folders } else { &self.paths };
        letters.get(key).copied()
    }
}

fn letter(x: u8, y: u8) -> &'static str {
    match (x, y) {
        (b'?', b'?') => "?",
        (b'!', b'!') => "!",
        _ if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') => "R",
        _ if x == b'A' => "A",
        _ if x == b'D' || y == b'D' => "D",
        _ => "M",
    }
}

fn rank(letter: &str) -> u8 {
    match letter {
        "M" => 5,
        "A" => 4,
        "R" => 3,
        "D" => 2,
        "?" => 1,
        _ => 0,
    }
}

fn parse_status(bytes: &[u8], truncated: bool) -> Status {
    let mut status = Status {
        truncated,
        ..Status::default()
    };
    let complete = bytes
        .iter()
        .rposition(|byte| *byte == 0)
        .map_or(&[][..], |end| &bytes[..end]);
    let mut records = complete.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            continue;
        }
        let (x, y) = (record[0], record[1]);
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            records.next();
        }
        let Ok(path) = std::str::from_utf8(&record[3..]) else {
            continue;
        };
        let path = path.trim_end_matches('/');
        let letter = letter(x, y);
        if letter == "!" {
            status.ignored.insert(path.to_owned());
            continue;
        }
        for parent in ancestors(path) {
            let slot = status.folders.entry(parent.to_owned()).or_insert(letter);
            if rank(letter) > rank(slot) {
                *slot = letter;
            }
        }
        status.paths.insert(path.to_owned(), letter);
    }
    status
}

async fn status(root: &Path) -> Arc<Status> {
    if let Some(cached) = STATUSES.get(root) {
        return cached;
    }
    let output = crate::git::run(
        &plain(root),
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
        ],
        STATUS_LIMIT,
        GIT_DEADLINE,
    )
    .await;
    let snapshot = Arc::new(match output {
        Ok(output) if output.truncated || output.code == Some(0) => {
            parse_status(&output.bytes, output.truncated)
        }
        _ => Status {
            truncated: true,
            ..Status::default()
        },
    });
    STATUSES.put(root.to_path_buf(), snapshot.clone());
    snapshot
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    kind: &'static str,
    size: u64,
    modified_ms: Option<u64>,
    status: Option<&'static str>,
    ignored: bool,
}

fn kind(metadata: &Metadata) -> &'static str {
    let kind = metadata.file_type();
    if kind.is_symlink() {
        "symlink"
    } else if kind.is_dir() {
        "dir"
    } else if kind.is_file() {
        "file"
    } else {
        "other"
    }
}

fn hidden(name: &str, metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = metadata;
    name.starts_with('.')
}

fn entry(name: String, metadata: &Metadata) -> Entry {
    let kind = kind(metadata);
    Entry {
        name,
        kind,
        size: if kind == "file" { metadata.len() } else { 0 },
        modified_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok()),
        status: None,
        ignored: false,
    }
}

fn scan(directory: &Path, show_hidden: bool) -> Result<(Vec<Entry>, bool)> {
    let items = std::fs::read_dir(directory)
        .map_err(|_| failure("not_readable", "This folder cannot be read"))?;
    let mut entries = Vec::new();
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
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        if name.chars().any(char::is_control) || (!show_hidden && hidden(&name, &metadata)) {
            continue;
        }
        entries.push(entry(name, &metadata));
    }
    Ok((entries, truncated))
}

fn child<'a>(path: &'a str, prefix: &str) -> Option<(&'a str, bool)> {
    let rest = if prefix.is_empty() {
        path
    } else {
        path.strip_prefix(prefix)?.strip_prefix('/')?
    };
    Some(match rest.split_once('/') {
        Some((name, _)) => (name, true),
        None => (rest, false),
    })
}

fn deleted_entries(entries: &mut Vec<Entry>, status: &Status, prefix: &str, show_hidden: bool) {
    let present = entries
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<HashSet<_>>();
    let missing = status
        .paths
        .iter()
        .filter(|(_, letter)| **letter == "D")
        .filter_map(|(path, _)| child(path, prefix))
        .filter(|(name, _)| !present.contains(*name) && (show_hidden || !name.starts_with('.')))
        .collect::<HashMap<_, _>>();
    entries.extend(missing.into_iter().map(|(name, folder)| Entry {
        name: name.to_owned(),
        kind: if folder { "dir" } else { "file" },
        size: 0,
        modified_ms: None,
        status: None,
        ignored: false,
    }));
}

fn annotate(entries: &mut [Entry], status: &Status, prefix: &str) {
    for entry in entries {
        let key = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{prefix}/{}", entry.name)
        };
        entry.status = status.letter(&key, entry.kind == "dir");
        entry.ignored = status.is_ignored(&key);
    }
}

fn order(entries: &mut Vec<Entry>) -> bool {
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind != "dir",
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    let truncated = entries.len() > ENTRY_LIMIT;
    entries.truncate(ENTRY_LIMIT);
    truncated
}

async fn list_entries(directory: &str, show_hidden: bool) -> Result<Value> {
    let directory = folder(&requested(directory)?).await?;
    let root = repository(&directory).await;
    let (mut entries, scan_truncated) = {
        let directory = directory.clone();
        tokio::task::spawn_blocking(move || scan(&directory, show_hidden))
            .await
            .map_err(|_| failure("files_failed", "Folder listing stopped"))??
    };
    let mut status_truncated = false;
    if let Some(root) = &root
        && let Some(prefix) = directory.strip_prefix(root).ok().and_then(relative_key)
    {
        let status = status(root).await;
        status_truncated = status.truncated;
        deleted_entries(&mut entries, &status, &prefix, show_hidden);
        annotate(&mut entries, &status, &prefix);
    }
    let truncated = order(&mut entries) || scan_truncated;
    Ok(json!({
        "type": "entries",
        "directory": display_path(&directory),
        "root": root.as_deref().map(display_path),
        "entries": entries,
        "truncated": truncated,
        "statusTruncated": status_truncated,
    }))
}

struct Chunk {
    size: u64,
    offset: u64,
    length: usize,
    text: String,
    truncated: bool,
}

fn is_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

fn complete_prefix(bytes: &[u8]) -> &[u8] {
    let tail = bytes.len().saturating_sub(4);
    let Some(start) = (tail..bytes.len())
        .rev()
        .find(|index| !is_continuation(bytes[*index]))
    else {
        return bytes;
    };
    let width = match bytes[start] {
        byte if byte >= 0xF0 => 4,
        byte if byte >= 0xE0 => 3,
        byte if byte >= 0xC0 => 2,
        _ => 1,
    };
    if bytes.len() - start < width {
        &bytes[..start]
    } else {
        bytes
    }
}

fn read_chunk(path: &Path, offset: u64, limit: usize) -> Result<Chunk> {
    let mut file =
        File::open(path).map_err(|_| failure("not_readable", "This file cannot be opened"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(failure("not_file", "This path is not a regular file"));
    }
    let size = metadata.len();
    if offset > size {
        return Err(failure(
            "invalid_argument",
            "Offset is beyond the end of the file",
        ));
    }
    let mut head = Vec::new();
    (&mut file).take(SNIFF_LIMIT).read_to_end(&mut head)?;
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(offset))?;
    (&mut file).take(limit as u64).read_to_end(&mut bytes)?;
    if head.contains(&0) || bytes.contains(&0) {
        return Err(failure("binary", "Binary files are not previewed"));
    }
    let skipped = if offset > 0 {
        bytes
            .iter()
            .take(3)
            .take_while(|byte| is_continuation(**byte))
            .count()
    } else {
        0
    };
    let body = &bytes[skipped..];
    let start = offset + skipped as u64;
    let body = if start + (body.len() as u64) < size {
        complete_prefix(body)
    } else {
        body
    };
    Ok(Chunk {
        size,
        offset: start,
        length: body.len(),
        text: String::from_utf8_lossy(body).into_owned(),
        truncated: start + (body.len() as u64) < size,
    })
}

async fn read_file(path: &str, offset: u64, limit: Option<usize>) -> Result<Value> {
    let requested = requested(path)?;
    let (Some(parent), Some(name)) = (requested.parent(), requested.file_name()) else {
        return Err(failure("invalid_argument", "Path must name a file"));
    };
    let parent = folder(parent).await?;
    let path = parent.join(name);
    let target = tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| failure("not_found", "This file does not exist"))?;
    let boundary = repository(&parent).await.unwrap_or_else(|| parent.clone());
    if !target.starts_with(&boundary) {
        return Err(failure(
            "outside_root",
            "Link target is outside the folder or its repository",
        ));
    }
    let limit = limit.unwrap_or(READ_LIMIT).clamp(1, READ_LIMIT);
    let chunk = tokio::task::spawn_blocking(move || read_chunk(&target, offset, limit))
        .await
        .map_err(|_| failure("files_failed", "File read stopped"))??;
    Ok(json!({
        "type": "file",
        "path": display_path(&path),
        "size": chunk.size,
        "offset": chunk.offset,
        "length": chunk.length,
        "text": chunk.text,
        "truncated": chunk.truncated,
        "encoding": "utf8",
    }))
}

#[derive(Default)]
struct Walk {
    paths: Vec<String>,
    scanned: usize,
    truncated: bool,
}

fn walk(root: &Path) -> Walk {
    let mut walk = Walk::default();
    let walker = ignore::WalkBuilder::new(root)
        .max_depth(Some(WALK_DEPTH))
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    for item in walker {
        let Ok(item) = item else {
            continue;
        };
        if item.depth() == 0 {
            continue;
        }
        if walk.scanned >= WALK_LIMIT {
            walk.truncated = true;
            break;
        }
        walk.scanned += 1;
        if !item
            .file_type()
            .is_some_and(|kind| kind.is_file() || kind.is_symlink())
        {
            continue;
        }
        if let Some(key) = item
            .path()
            .strip_prefix(root)
            .ok()
            .and_then(relative_key)
            .filter(|key| !key.chars().any(char::is_control))
        {
            walk.paths.push(key);
        }
    }
    walk
}

#[derive(Serialize)]
struct Match {
    path: String,
    score: i64,
}

fn fold(value: char) -> char {
    value.to_lowercase().next().unwrap_or(value)
}

fn bonus(chars: &[char], index: usize) -> i64 {
    let Some(before) = index.checked_sub(1).map(|previous| chars[previous]) else {
        return 6;
    };
    if before == '/' {
        6
    } else if matches!(before, '_' | '-' | '.' | ' ')
        || (before.is_lowercase() && chars[index].is_uppercase())
    {
        3
    } else {
        0
    }
}

fn align(chars: &[char], start: usize, basename: usize, query: &[char]) -> Option<i64> {
    let mut next = 0;
    let mut score = 0;
    let mut previous: Option<usize> = None;
    for (index, value) in chars.iter().enumerate().skip(start) {
        let Some(wanted) = query.get(next) else {
            break;
        };
        if fold(*value) != *wanted {
            continue;
        }
        score += 1 + bonus(chars, index);
        if previous.is_some_and(|previous| previous + 1 == index) {
            score += 6;
        }
        if index >= basename {
            score += 2;
        }
        previous = Some(index);
        next += 1;
    }
    (next == query.len()).then_some(score)
}

fn score(path: &str, query: &[char]) -> Option<i64> {
    let chars = path.chars().collect::<Vec<_>>();
    let basename = chars
        .iter()
        .rposition(|value| *value == '/')
        .map_or(0, |index| index + 1);
    let penalty = i64::try_from(chars.len() / 8).unwrap_or(i64::MAX);
    let starts = chars
        .iter()
        .enumerate()
        .filter(|(_, value)| **value == '/')
        .map(|(index, _)| index + 1);
    std::iter::once(0)
        .chain(starts)
        .filter_map(|start| align(&chars, start, basename, query))
        .max()
        .map(|score| score - penalty)
}

fn rank_paths(paths: &[String], query: &str, limit: usize) -> Vec<Match> {
    let query = query
        .chars()
        .filter(|value| !value.is_whitespace())
        .map(fold)
        .collect::<Vec<_>>();
    let mut matches = paths
        .iter()
        .filter_map(|path| {
            score(path, &query).map(|score| Match {
                path: path.clone(),
                score,
            })
        })
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    matches.truncate(limit);
    matches
}

async fn walked(root: &Path) -> Result<Arc<Walk>> {
    if let Some(cached) = WALKS.get(root) {
        return Ok(cached);
    }
    let walk = {
        let root = root.to_path_buf();
        tokio::task::spawn_blocking(move || walk(&root))
            .await
            .map_err(|_| failure("files_failed", "File search stopped"))?
    };
    let walk = Arc::new(walk);
    WALKS.put(root.to_path_buf(), walk.clone());
    Ok(walk)
}

async fn find_files(root: &str, query: &str, limit: Option<usize>) -> Result<Value> {
    if query.len() > QUERY_LIMIT || query.chars().any(char::is_control) {
        return Err(failure(
            "invalid_argument",
            "Query must be at most 256 bytes without control characters",
        ));
    }
    let root = folder(&requested(root)?).await?;
    let walk = walked(&root).await?;
    let limit = limit.unwrap_or(MATCH_DEFAULT).clamp(1, MATCH_LIMIT);
    Ok(json!({
        "type": "files",
        "root": display_path(&root),
        "matches": rank_paths(&walk.paths, query, limit),
        "scanned": walk.scanned,
        "truncated": walk.truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nesvo-files-{label}-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    fn git(path: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(["-c", "core.hooksPath=", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(plain(path))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn repository_fixture() -> PathBuf {
        let path = temporary("repo");
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "Nesvo Test"]);
        git(&path, &["config", "user.email", "test@example.invalid"]);
        std::fs::create_dir(path.join("sub")).unwrap();
        for name in ["tracked.txt", "modified.txt", "deleted.txt", "moved.txt"] {
            std::fs::write(path.join(name), "one\n").unwrap();
        }
        std::fs::write(path.join("sub").join("inner.txt"), "one\n").unwrap();
        std::fs::write(path.join(".gitignore"), "build/\n*.log\n").unwrap();
        git(&path, &["add", "."]);
        git(&path, &["commit", "-q", "-m", "base"]);
        std::fs::write(path.join("modified.txt"), "two\n").unwrap();
        std::fs::write(path.join("sub").join("inner.txt"), "two\n").unwrap();
        std::fs::remove_file(path.join("deleted.txt")).unwrap();
        git(&path, &["mv", "moved.txt", "renamed.txt"]);
        std::fs::write(path.join("added.txt"), "new\n").unwrap();
        git(&path, &["add", "added.txt"]);
        std::fs::write(path.join("untracked.txt"), "new\n").unwrap();
        std::fs::create_dir(path.join("build")).unwrap();
        std::fs::write(path.join("build").join("out.txt"), "artifact\n").unwrap();
        std::fs::write(path.join("debug.log"), "log\n").unwrap();
        path
    }

    fn code(error: anyhow::Error) -> &'static str {
        error.downcast_ref::<Failure>().unwrap().code
    }

    fn named<'a>(listing: &'a Value, name: &str) -> &'a Value {
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("missing {name}"))
    }

    fn names(listing: &Value) -> Vec<String> {
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect()
    }

    fn text(path: &Path) -> String {
        display_path(path)
    }

    #[tokio::test]
    async fn entries_carry_git_status_letters_and_ignored_flags() {
        let path = repository_fixture();
        let listing = list_entries(&text(&path), false).await.unwrap();
        assert_eq!(listing["type"], "entries");
        assert_eq!(listing["root"], text(&path));
        assert_eq!(listing["truncated"], false);
        for (name, letter) in [
            ("modified.txt", json!("M")),
            ("deleted.txt", json!("D")),
            ("renamed.txt", json!("R")),
            ("added.txt", json!("A")),
            ("untracked.txt", json!("?")),
            ("tracked.txt", Value::Null),
            ("sub", json!("M")),
            ("build", json!("!")),
            ("debug.log", json!("!")),
        ] {
            assert_eq!(named(&listing, name)["status"], letter, "{name}");
        }
        assert_eq!(named(&listing, "build")["ignored"], true);
        assert_eq!(named(&listing, "build")["kind"], "dir");
        assert_eq!(named(&listing, "debug.log")["ignored"], true);
        assert_eq!(named(&listing, "modified.txt")["ignored"], false);
        assert_eq!(named(&listing, "modified.txt")["size"], 4);
        assert!(named(&listing, "modified.txt")["modifiedMs"].is_u64());
        assert!(named(&listing, "deleted.txt")["modifiedMs"].is_null());
        assert_eq!(names(&listing)[..2], ["build", "sub"]);
        let nested = list_entries(&text(&path.join("build")), false)
            .await
            .unwrap();
        assert_eq!(named(&nested, "out.txt")["ignored"], true);
        assert_eq!(named(&nested, "out.txt")["status"], "!");
        let inner = list_entries(&text(&path.join("sub")), false).await.unwrap();
        assert_eq!(named(&inner, "inner.txt")["status"], "M");
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn hidden_entries_need_the_flag_and_plain_folders_have_no_status() {
        let path = temporary("plain");
        std::fs::write(path.join(".secret"), "x").unwrap();
        std::fs::write(path.join("Visible.txt"), "x").unwrap();
        std::fs::write(path.join("alpha.txt"), "x").unwrap();
        std::fs::create_dir(path.join("zeta")).unwrap();
        let listing = list_entries(&text(&path), false).await.unwrap();
        assert_eq!(names(&listing), ["zeta", "alpha.txt", "Visible.txt"]);
        assert!(listing["root"].is_null());
        assert!(
            listing["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["status"].is_null() && entry["ignored"] == false)
        );
        let shown = list_entries(&text(&path), true).await.unwrap();
        assert!(names(&shown).contains(&".secret".to_owned()));
        assert_eq!(
            code(list_entries("relative", false).await.unwrap_err()),
            "invalid_argument"
        );
        assert_eq!(
            code(
                list_entries(&text(&path.join("alpha.txt")), false)
                    .await
                    .unwrap_err()
            ),
            "not_directory"
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn listings_and_walks_are_capped_with_truncation() {
        let path = temporary("caps");
        for index in 0..WALK_LIMIT + 10 {
            std::fs::write(path.join(format!("file-{index:05}.txt")), "").unwrap();
        }
        let listing = list_entries(&text(&path), false).await.unwrap();
        assert_eq!(listing["entries"].as_array().unwrap().len(), ENTRY_LIMIT);
        assert_eq!(listing["truncated"], true);
        assert_eq!(named(&listing, "file-00000.txt")["kind"], "file");
        let found = find_files(&text(&path), "file", Some(1000)).await.unwrap();
        assert_eq!(found["scanned"], WALK_LIMIT);
        assert_eq!(found["truncated"], true);
        assert_eq!(found["matches"].as_array().unwrap().len(), MATCH_LIMIT);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn reads_are_paged_text_and_binary_is_refused() {
        let path = temporary("read");
        let body = format!("{}\u{e9} tail", "a".repeat(READ_LIMIT - 1));
        std::fs::write(path.join("long.txt"), &body).unwrap();
        std::fs::write(path.join("data.bin"), [b'x', 0, b'y']).unwrap();
        let file = text(&path.join("long.txt"));
        let first = read_file(&file, 0, None).await.unwrap();
        assert_eq!(first["type"], "file");
        assert_eq!(first["encoding"], "utf8");
        assert_eq!(first["size"], body.len());
        assert_eq!(first["truncated"], true);
        assert_eq!(first["length"], READ_LIMIT - 1);
        let next = read_file(&file, first["length"].as_u64().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(next["text"], "\u{e9} tail");
        assert_eq!(next["truncated"], false);
        let middle = read_file(&file, READ_LIMIT as u64, Some(4)).await.unwrap();
        assert_eq!(middle["offset"], READ_LIMIT + 1);
        assert_eq!(middle["text"], " ta");
        assert_eq!(
            code(
                read_file(&text(&path.join("data.bin")), 0, None)
                    .await
                    .unwrap_err()
            ),
            "binary"
        );
        assert_eq!(
            code(
                read_file(&file, body.len() as u64 + 1, None)
                    .await
                    .unwrap_err()
            ),
            "invalid_argument"
        );
        assert_eq!(
            code(
                read_file(&text(&path.join("missing.txt")), 0, None)
                    .await
                    .unwrap_err()
            ),
            "not_found"
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[cfg(windows)]
    fn link(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }

    #[cfg(unix)]
    fn link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[tokio::test]
    async fn links_leaving_the_folder_or_repository_are_refused() {
        let outside = temporary("outside");
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let path = repository_fixture();
        let escaping = path.join("escape.txt");
        let internal = path.join("sub").join("up.txt");
        if !link(&outside.join("secret.txt"), &escaping)
            || !link(&path.join("tracked.txt"), &internal)
        {
            std::fs::remove_dir_all(path).unwrap();
            std::fs::remove_dir_all(outside).unwrap();
            return;
        }
        assert_eq!(
            code(read_file(&text(&escaping), 0, None).await.unwrap_err()),
            "outside_root"
        );
        let inside = read_file(&text(&internal), 0, None).await.unwrap();
        assert_eq!(inside["text"], "one\n");
        let loose_folder = temporary("loose");
        let loose = loose_folder.join("loose.txt");
        assert!(link(&outside.join("secret.txt"), &loose));
        assert_eq!(
            code(read_file(&text(&loose), 0, None).await.unwrap_err()),
            "outside_root"
        );
        let listing = list_entries(&text(&path), false).await.unwrap();
        assert_eq!(named(&listing, "escape.txt")["kind"], "symlink");
        for folder in [path, outside, loose_folder] {
            std::fs::remove_dir_all(folder).unwrap();
        }
    }

    #[tokio::test]
    async fn find_honours_gitignore_and_ranks_segment_matches_first() {
        let path = repository_fixture();
        let found = find_files(&text(&path), "txt", Some(MATCH_LIMIT))
            .await
            .unwrap();
        let paths = found["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"sub/inner.txt"));
        assert!(paths.contains(&"untracked.txt"));
        assert!(!paths.iter().any(|path| path.starts_with("build/")));
        assert!(!paths.contains(&".gitignore"));
        assert_eq!(found["truncated"], false);
        std::fs::remove_dir_all(path).unwrap();
        let candidates = [
            "assets/m/a/i/n.txt",
            "src/domain/main.rs",
            "README.md",
            "src/main.rs",
        ]
        .map(str::to_owned);
        let ranked = rank_paths(&candidates, "MAIN", 10);
        let order = ranked
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            ["src/main.rs", "src/domain/main.rs", "assets/m/a/i/n.txt"]
        );
        assert!(ranked[0].score > ranked[2].score);
        assert_eq!(rank_paths(&candidates, "", 2).len(), 2);
        assert!(rank_paths(&candidates, "zz", 10).is_empty());
    }

    #[test]
    fn porcelain_records_tolerate_truncation_and_renames() {
        let status = parse_status(
            b"R  new.txt\0old.txt\0 M a/b/c.txt\0?? a/d.txt\0!! out/\0?? cut",
            true,
        );
        assert_eq!(status.paths.get("new.txt"), Some(&"R"));
        assert!(!status.paths.contains_key("old.txt"));
        assert_eq!(status.folders.get("a"), Some(&"M"));
        assert_eq!(status.folders.get("a/b"), Some(&"M"));
        assert!(status.is_ignored("out/deep/file"));
        assert!(!status.paths.contains_key("cut"));
        assert!(status.truncated);
        let accented = "a\u{e9}".as_bytes();
        assert_eq!(complete_prefix(accented), accented);
        assert_eq!(complete_prefix(&accented[..2]), b"a");
    }
}
