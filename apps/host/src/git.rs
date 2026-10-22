use anyhow::{Result, anyhow, ensure};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

const OUTPUT_LIMIT: usize = 24 * 1024;
const NAMES_LIMIT: usize = 64 * 1024;
const STATUS_LIMIT: usize = 64 * 1024;
const STATUS_PATHS: usize = 512;
const CONFLICT_PATHS: usize = 32;
const REF_LIMIT: usize = 256;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const FRAME_HEADROOM_BYTES: usize = 2048;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Unstaged,
    Staged,
    Untracked,
    Branch { base: Option<String> },
    Commits { from: String, to: Option<String> },
}

impl Scope {
    pub fn parse(
        name: &str,
        base: Option<String>,
        from: Option<String>,
        to: Option<String>,
    ) -> Result<Self> {
        ensure!(
            (name == "branch" || base.is_none())
                && (name == "commits" || (from.is_none() && to.is_none())),
            "This diff scope does not accept base, from or to"
        );
        for value in base.iter().chain(&from).chain(&to) {
            validate_ref(value)?;
        }
        Ok(match name {
            "unstaged" => Self::Unstaged,
            "staged" => Self::Staged,
            "untracked" => Self::Untracked,
            "branch" => Self::Branch { base },
            "commits" => Self::Commits {
                from: from.ok_or_else(|| anyhow!("The commits scope requires from"))?,
                to,
            },
            _ => return Err(anyhow!("Invalid diff scope")),
        })
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Unstaged => "unstaged",
            Self::Staged => "staged",
            Self::Untracked => "untracked",
            Self::Branch { .. } => "branch",
            Self::Commits { .. } => "commits",
        }
    }
}

pub fn validate_ref(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= REF_LIMIT
            && !value.starts_with('-')
            && !value.contains("..")
            && !value.chars().any(|c| c.is_control() || c.is_whitespace()),
        "Invalid Git revision"
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub scope: String,
    pub revision: String,
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Base>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    pub files: Vec<FileDiff>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    #[serde(rename = "ref")]
    pub name: String,
    pub oid: String,
    pub merge_base: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Range {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub patch: String,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
}

pub(crate) struct Output {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub code: Option<i32>,
}

fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(["--no-pager", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

pub(crate) async fn run(
    cwd: &Path,
    args: &[&str],
    limit: usize,
    deadline: Duration,
) -> Result<Output> {
    let mut child = command(cwd, args).spawn()?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Git output unavailable"))?;
    let result = timeout(deadline, async {
        let mut bytes = Vec::new();
        output
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        let truncated = bytes.len() > limit;
        if truncated {
            child.kill().await?;
            bytes.truncate(limit);
        }
        let status = child.wait().await?;
        Ok(Output {
            bytes,
            truncated,
            code: status.code(),
        })
    })
    .await;
    result.map_err(|_| anyhow!("Git inspection timed out"))?
}

async fn git(cwd: &Path, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool)> {
    let output = run(cwd, args, limit, GIT_TIMEOUT).await?;
    ensure!(
        output.truncated || output.code == Some(0),
        "Git could not read this repository or path."
    );
    Ok((output.bytes, output.truncated))
}

pub fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub async fn toplevel(cwd: &Path) -> Result<PathBuf> {
    let (root, _) = git(cwd, &["rev-parse", "--show-toplevel"], 4096).await?;
    Ok(PathBuf::from(String::from_utf8(root)?.trim()))
}

pub(crate) async fn discover(cwd: &Path) -> Result<Option<PathBuf>> {
    let mut command = command(cwd, &["rev-parse", "--show-toplevel"]);
    command
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .stderr(Stdio::piped());
    let output = timeout(GIT_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("Git inspection timed out"))??;
    if output.status.success() {
        return Ok(Some(PathBuf::from(
            String::from_utf8(output.stdout)?.trim(),
        )));
    }
    ensure!(
        output.status.code() == Some(128)
            && output.stderr.starts_with(b"fatal: not a git repository"),
        "Git could not read this repository or path."
    );
    Ok(None)
}

async fn object(root: &Path, spec: &str) -> Result<Option<String>> {
    let output = run(
        root,
        &["rev-parse", "--verify", "--quiet", spec],
        256,
        GIT_TIMEOUT,
    )
    .await?;
    let oid = String::from_utf8(output.bytes)?.trim().to_owned();
    Ok((output.code == Some(0) && is_oid(&oid)).then_some(oid))
}

pub async fn resolve_commit(root: &Path, value: &str) -> Result<String> {
    validate_ref(value)?;
    object(root, &format!("{value}^{{commit}}"))
        .await?
        .ok_or_else(|| anyhow!("Git revision {value} was not found"))
}

pub async fn head(root: &Path) -> Result<Option<String>> {
    object(root, "HEAD^{commit}").await
}

pub async fn current_branch(root: &Path) -> Option<String> {
    let (bytes, _) = git(root, &["branch", "--show-current"], 512).await.ok()?;
    let name = String::from_utf8(bytes).ok()?.trim().to_owned();
    (!name.is_empty()).then_some(name)
}

pub async fn default_base(root: &Path) -> Option<String> {
    if let Ok(output) = run(
        root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        512,
        GIT_TIMEOUT,
    )
    .await
        && output.code == Some(0)
    {
        let name = String::from_utf8_lossy(&output.bytes).trim().to_owned();
        if validate_ref(&name).is_ok() {
            return Some(name);
        }
    }
    for candidate in ["main", "master", "origin/main", "origin/master"] {
        if resolve_commit(root, candidate).await.is_ok() {
            return Some(candidate.into());
        }
    }
    None
}

pub async fn merge_base(root: &Path, base: &str, head: &str) -> Result<String> {
    let (bytes, _) = git(root, &["merge-base", base, head], 256).await?;
    let oid = String::from_utf8(bytes)?.trim().to_owned();
    ensure!(is_oid(&oid), "Git found no merge base");
    Ok(oid)
}

struct Selection {
    args: Vec<String>,
    tracked: bool,
    untracked: bool,
    base: Option<Base>,
    range: Option<Range>,
}

async fn select(root: &Path, scope: &Scope) -> Result<Selection> {
    let plain = |args: &[&str], tracked: bool, untracked: bool| Selection {
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        tracked,
        untracked,
        base: None,
        range: None,
    };
    Ok(match scope {
        Scope::Unstaged => plain(&[], true, false),
        Scope::Staged => plain(&["--cached"], true, false),
        Scope::Untracked => plain(&[], false, true),
        Scope::Branch { base } => {
            let name = match base {
                Some(base) => base.clone(),
                None => default_base(root)
                    .await
                    .ok_or_else(|| anyhow!("No default branch was found; pass a base ref"))?,
            };
            let oid = resolve_commit(root, &name).await?;
            let head = head(root)
                .await?
                .ok_or_else(|| anyhow!("The branch scope needs a commit at HEAD"))?;
            let merge_base = merge_base(root, &oid, &head).await?;
            Selection {
                args: vec![merge_base.clone()],
                tracked: true,
                untracked: true,
                base: Some(Base {
                    name,
                    oid,
                    merge_base,
                }),
                range: None,
            }
        }
        Scope::Commits { from, to } => {
            let from = resolve_commit(root, from).await?;
            let to = resolve_commit(root, to.as_deref().unwrap_or("HEAD")).await?;
            Selection {
                args: vec![from.clone(), to.clone()],
                tracked: true,
                untracked: false,
                base: None,
                range: Some(Range { from, to }),
            }
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    status: String,
    old_path: Option<String>,
    path: String,
    untracked: bool,
}

fn parse_name_status(names: &str) -> Result<Vec<Entry>> {
    let mut fields = names.split('\0').filter(|s| !s.is_empty());
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        let path = fields
            .next()
            .ok_or_else(|| anyhow!("Incomplete Git path"))?;
        entries.push(if status.starts_with(['R', 'C']) {
            Entry {
                status: status.into(),
                old_path: Some(path.into()),
                path: fields
                    .next()
                    .ok_or_else(|| anyhow!("Incomplete rename"))?
                    .into(),
                untracked: false,
            }
        } else {
            Entry {
                status: status.into(),
                old_path: None,
                path: path.into(),
                untracked: false,
            }
        });
    }
    Ok(entries)
}

async fn names(root: &Path, args: &[&str]) -> Result<String> {
    let (names, cut) = git(root, args, NAMES_LIMIT).await?;
    ensure!(
        !cut,
        "Too many changed paths; narrow the repository before reviewing."
    );
    String::from_utf8(names).map_err(|_| anyhow!("Non UTF-8 Git paths are not supported"))
}

async fn entries(root: &Path, selection: &Selection) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    if selection.tracked {
        let mut args = vec![
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
        ];
        args.extend(selection.args.iter().map(String::as_str));
        entries = parse_name_status(&names(root, &args).await?)?;
    }
    if selection.untracked {
        let listed = names(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
        entries.extend(
            listed
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(|path| Entry {
                    status: "?".into(),
                    old_path: None,
                    path: path.into(),
                    untracked: true,
                }),
        );
    }
    Ok(entries)
}

async fn untracked_patch_without_following_symlinks(
    root: &Path,
    path: &str,
    limit: usize,
) -> Result<(String, bool)> {
    let file_path = root.join(path);
    let metadata = tokio::fs::symlink_metadata(&file_path).await?;
    if !metadata.is_file() {
        return Ok((
            "Untracked symlink or special file (content not read).".into(),
            false,
        ));
    }
    let file = tokio::fs::File::open(file_path).await?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    let cut = bytes.len() > limit;
    bytes.truncate(limit);
    if bytes.contains(&0) {
        return Ok(("Binary file (content not displayed).".into(), cut));
    }
    let body = String::from_utf8_lossy(&bytes);
    let mut patch = format!(
        "--- /dev/null\n+++ {path}\n@@ -0,0 +1,{} @@\n",
        body.lines().count()
    );
    for line in body.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    Ok((patch, cut))
}

async fn tracked_patch(
    root: &Path,
    selection: &Selection,
    entry: &Entry,
    limit: usize,
) -> Result<(String, bool)> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--no-color",
        "--unified=3",
    ];
    args.extend(selection.args.iter().map(String::as_str));
    args.push("--");
    if let Some(old) = &entry.old_path {
        args.push(old);
    }
    args.push(&entry.path);
    let (bytes, cut) = git(root, &args, limit).await?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), cut))
}

fn counts(patch: &str) -> (usize, usize) {
    let additions = patch
        .lines()
        .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
        .count();
    let deletions = patch
        .lines()
        .filter(|l| l.starts_with('-') && !l.starts_with("---"))
        .count();
    (additions, deletions)
}

pub fn revision(tree: &str, selection: &str, files: &[FileDiff], truncated: bool) -> String {
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut feed = |part: &str| {
        context.update(part.as_bytes());
        context.update(b"\0");
    };
    feed(tree);
    feed(selection);
    feed(if truncated { "truncated" } else { "complete" });
    for file in files {
        feed(&file.path);
        feed(file.old_path.as_deref().unwrap_or_default());
        feed(&file.status);
        feed(&file.patch);
    }
    let digest = hex::encode(context.finish().as_ref());
    format!("{}-{}", &tree[..tree.len().min(12)], &digest[..16])
}

pub async fn review(cwd: &Path, scope: &Scope) -> Result<Review> {
    let root = toplevel(cwd).await?;
    let selection = select(&root, scope).await?;
    let entries = entries(&root, &selection).await?;
    let mut review = Review {
        directory: crate::process::display_path(&root),
        source: None,
        scope: scope.name().into(),
        revision: String::new(),
        head: head(&root).await?,
        base: selection.base.clone(),
        range: selection.range.clone(),
        files: Vec::new(),
        truncated: false,
    };
    let mut budget = OUTPUT_LIMIT;
    for entry in entries {
        if review.files.len() >= 128 || budget == 0 {
            review.truncated = true;
            break;
        }
        let limit = budget.min(8 * 1024);
        let (patch, truncated) = if entry.untracked {
            untracked_patch_without_following_symlinks(&root, &entry.path, limit).await?
        } else {
            tracked_patch(&root, &selection, &entry, limit).await?
        };
        budget = budget.saturating_sub(patch.len());
        let (additions, deletions) = counts(&patch);
        review.files.push(FileDiff {
            path: entry.path,
            old_path: entry.old_path,
            status: entry.status,
            patch,
            additions,
            deletions,
            truncated,
        });
        if serde_json::to_vec(&review)?.len() > crate::wire::MAX_PLAINTEXT - FRAME_HEADROOM_BYTES {
            review.files.pop();
            review.truncated = true;
            break;
        }
    }
    let tree = object(&root, "HEAD^{tree}")
        .await?
        .unwrap_or_else(|| "unborn".into());
    let selection_key = format!("{}:{}", scope.name(), selection.args.join(":"));
    review.revision = revision(&tree, &selection_key, &review.files, review.truncated);
    Ok(review)
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    #[serde(skip)]
    pub paths: Vec<String>,
    pub truncated: bool,
}

fn status_path(record: &str, fields: usize) -> Option<&str> {
    record.splitn(fields, ' ').nth(fields - 1)
}

pub fn parse_status(bytes: &[u8], truncated: bool) -> Status {
    let text = String::from_utf8_lossy(bytes);
    let mut records: Vec<&str> = text.split('\0').collect();
    if truncated || records.last().is_some_and(|last| last.is_empty()) {
        records.pop();
    }
    let mut status = Status {
        truncated,
        ..Status::default()
    };
    let mut records = records.into_iter();
    while let Some(record) = records.next() {
        let kind = record.get(..2).unwrap_or_default();
        let rest = record.get(2..).unwrap_or_default();
        let path = match kind {
            "# " => {
                apply_header(&mut status, rest);
                None
            }
            "1 " | "2 " => {
                let xy = rest.as_bytes();
                if xy.len() >= 2 {
                    status.staged += u32::from(xy[0] != b'.');
                    status.unstaged += u32::from(xy[1] != b'.');
                }
                if kind == "2 " {
                    records.next();
                }
                status_path(rest, if kind == "1 " { 8 } else { 9 })
            }
            "u " => {
                status.conflicted += 1;
                status_path(rest, 10)
            }
            "? " => {
                status.untracked += 1;
                Some(rest)
            }
            _ => None,
        };
        if let Some(path) = path
            && status.paths.len() < STATUS_PATHS
        {
            status.paths.push(path.to_owned());
        } else if path.is_some() {
            status.truncated = true;
        }
    }
    status
}

fn apply_header(status: &mut Status, header: &str) {
    let Some((key, value)) = header.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" if is_oid(value) => status.head = Some(value.into()),
        "branch.head" if value != "(detached)" => status.branch = Some(value.into()),
        "branch.upstream" => status.upstream = Some(value.into()),
        "branch.ab" => {
            let mut parts = value.split(' ');
            status.ahead = parts
                .next()
                .and_then(|part| part.strip_prefix('+')?.parse().ok());
            status.behind = parts
                .next()
                .and_then(|part| part.strip_prefix('-')?.parse().ok());
        }
        _ => {}
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRelation {
    #[serde(rename = "ref")]
    pub name: String,
    pub oid: String,
    pub ahead: u32,
    pub behind: u32,
    pub merge_conflicts: Option<bool>,
    pub conflict_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub worktree_revision: String,
    #[serde(flatten)]
    pub status: Status,
    pub clean: bool,
    pub base: Option<BaseRelation>,
    pub pushed: Option<bool>,
    pub blockers: Vec<&'static str>,
    pub ready: bool,
}

pub fn blockers(
    status: &Status,
    base: Option<&BaseRelation>,
    pushed: Option<bool>,
) -> Vec<&'static str> {
    let mut blockers = Vec::new();
    if status.head.is_none() {
        blockers.push("unborn");
    }
    if status.conflicted > 0 {
        blockers.push("conflicts");
    }
    if base.is_some_and(|base| base.merge_conflicts == Some(true)) {
        blockers.push("baseConflicts");
    }
    if status.staged + status.unstaged + status.untracked > 0 {
        blockers.push("dirty");
    }
    if base.is_some_and(|base| base.behind > 0) {
        blockers.push("behindBase");
    }
    if status.behind.is_some_and(|behind| behind > 0) {
        blockers.push("behindUpstream");
    }
    if pushed == Some(false) {
        blockers.push("unpushed");
    }
    blockers
}

async fn base_relation(root: &Path, name: &str) -> Result<BaseRelation> {
    let oid = resolve_commit(root, name).await?;
    let range = format!("{oid}...HEAD");
    let (counts, _) = git(root, &["rev-list", "--left-right", "--count", &range], 128).await?;
    let counts = String::from_utf8(counts)?;
    let mut numbers = counts.split_whitespace().map(str::parse::<u32>);
    let behind = numbers.next().transpose()?.unwrap_or_default();
    let ahead = numbers.next().transpose()?.unwrap_or_default();
    let merge = run(
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &oid,
            "HEAD",
        ],
        16 * 1024,
        GIT_TIMEOUT,
    )
    .await?;
    let merge_conflicts = match merge.code {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    };
    let conflict_paths = if merge_conflicts == Some(true) {
        String::from_utf8_lossy(&merge.bytes)
            .lines()
            .skip(1)
            .filter(|line| !line.is_empty())
            .take(CONFLICT_PATHS)
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    Ok(BaseRelation {
        name: name.into(),
        oid,
        ahead,
        behind,
        merge_conflicts,
        conflict_paths,
    })
}

async fn contained_in_remote(root: &Path) -> Result<bool> {
    let (refs, _) = git(
        root,
        &[
            "for-each-ref",
            "--contains",
            "HEAD",
            "--count=1",
            "--format=%(refname)",
            "refs/remotes",
        ],
        1024,
    )
    .await?;
    Ok(!refs.iter().all(u8::is_ascii_whitespace))
}

pub async fn readiness(
    cwd: &Path,
    base: Option<&str>,
    remote_head: Option<&str>,
) -> Result<Readiness> {
    let root = toplevel(cwd).await?;
    let output = run(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        STATUS_LIMIT,
        GIT_TIMEOUT,
    )
    .await?;
    ensure!(
        output.truncated || output.code == Some(0),
        "Git could not read this repository status."
    );
    let status = parse_status(&output.bytes, output.truncated);
    let base = match base {
        Some(name) => Some(base_relation(&root, name).await?),
        None => None,
    };
    let pushed = match (&status.head, remote_head) {
        (None, _) => None,
        (Some(head), Some(remote)) => Some(head == remote),
        (Some(_), None) if status.upstream.is_some() => Some(status.ahead == Some(0)),
        (Some(_), None) => Some(contained_in_remote(&root).await?),
    };
    let blockers = blockers(&status, base.as_ref(), pushed);
    Ok(Readiness {
        worktree_revision: String::new(),
        clean: status.staged + status.unstaged + status.untracked + status.conflicted == 0,
        ready: blockers.is_empty(),
        status,
        base,
        pushed,
        blockers,
    })
}

pub async fn create_worktree(cwd: &Path) -> Result<PathBuf> {
    let root = toplevel(cwd).await?;
    let id = hex::encode(crate::wire::random::<8>());
    let parent = root
        .parent()
        .ok_or_else(|| anyhow!("Repository has no parent folder"))?;
    let name = root
        .file_name()
        .ok_or_else(|| anyhow!("Repository has no name"))?
        .to_string_lossy();
    let path = parent.join(format!("{name}-nesvo-{id}"));
    let branch = format!("nesvo/{id}");
    let display = crate::process::display_path(&path);
    git(
        &root,
        &[
            "-c",
            "core.hooksPath=",
            "worktree",
            "add",
            "-b",
            &branch,
            "--",
            &display,
            "HEAD",
        ],
        8192,
    )
    .await
    .map_err(|error| anyhow!("{error} Worktree may need inspection at {display}."))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nesvo-review-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    async fn diff(path: &Path, scope: &str) -> Result<Review> {
        review(path, &Scope::parse(scope, None, None, None)?).await
    }
    async fn commit(path: &Path, message: &str) {
        git(path, &["add", "."], 8192).await.unwrap();
        git(
            path,
            &["-c", "core.hooksPath=", "commit", "-q", "-m", message],
            8192,
        )
        .await
        .unwrap();
    }
    async fn initialize(path: &Path) {
        git(path, &["init"], 8192).await.unwrap();
        git(path, &["config", "user.name", "Nesvo Test"], 8192)
            .await
            .unwrap();
        git(
            path,
            &["config", "user.email", "test@example.invalid"],
            8192,
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn scopes_handle_unborn_rename_binary_and_nested_directory() {
        let path = setup();
        initialize(&path).await;
        std::fs::create_dir(path.join("nested")).unwrap();
        std::fs::write(path.join("nested/a file.txt"), "before\n").unwrap();
        let untracked = diff(&path.join("nested"), "untracked").await.unwrap();
        assert_eq!(untracked.files[0].path, "nested/a file.txt");
        git(&path, &["add", "."], 8192).await.unwrap();
        assert_eq!(diff(&path, "staged").await.unwrap().files[0].additions, 1);
        git(
            &path,
            &["-c", "core.hooksPath=", "commit", "-m", "test"],
            8192,
        )
        .await
        .unwrap();
        assert!(diff(&path, "staged").await.unwrap().files.is_empty());
        std::fs::write(path.join("nested/a file.txt"), "after\n").unwrap();
        let changed = diff(&path, "unstaged").await.unwrap();
        assert_eq!(
            (changed.files[0].additions, changed.files[0].deletions),
            (1, 1)
        );
        git(
            &path,
            &["mv", "nested/a file.txt", "nested/renamed.txt"],
            8192,
        )
        .await
        .unwrap();
        let staged = diff(&path, "staged").await.unwrap();
        assert!(staged.files[0].status.starts_with('R'));
        std::fs::write(path.join("binary.dat"), [0, 1, 2]).unwrap();
        assert!(
            diff(&path, "untracked").await.unwrap().files[0]
                .patch
                .contains("Binary")
        );
        assert!(Scope::parse("invalid", None, None, None).is_err());
        std::fs::remove_dir_all(&path).unwrap();
    }
    #[tokio::test]
    async fn worktree_has_a_new_branch_and_keeps_source_changes() {
        let parent = setup();
        let path = parent.join("source");
        std::fs::create_dir(&path).unwrap();
        initialize(&path).await;
        std::fs::write(path.join("file"), "original").unwrap();
        git(&path, &["add", "."], 8192).await.unwrap();
        git(
            &path,
            &["-c", "core.hooksPath=", "commit", "-m", "test"],
            8192,
        )
        .await
        .unwrap();
        std::fs::write(path.join("file"), "uncommitted").unwrap();
        let worktree = create_worktree(&path).await.unwrap();
        assert!(
            worktree
                .canonicalize()
                .unwrap()
                .starts_with(parent.canonicalize().unwrap())
        );
        assert_eq!(
            std::fs::read_to_string(path.join("file")).unwrap(),
            "uncommitted"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("file")).unwrap(),
            "original"
        );
        assert!(
            String::from_utf8(
                git(&worktree, &["branch", "--show-current"], 8192)
                    .await
                    .unwrap()
                    .0
            )
            .unwrap()
            .starts_with("nesvo/")
        );
        std::fs::remove_dir_all(&parent).unwrap();
    }
    #[tokio::test]
    async fn large_untracked_content_is_bounded_and_non_repo_is_an_error() {
        let path = setup();
        assert!(diff(&path, "unstaged").await.is_err());
        initialize(&path).await;
        std::fs::write(path.join("large"), vec![b'a'; 100_000]).unwrap();
        let result = diff(&path, "untracked").await.unwrap();
        assert!(result.files[0].truncated);
        assert!(result.files[0].patch.len() < 66_000);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn scope_parsing_binds_refs_to_their_scope_and_rejects_option_like_refs() {
        assert_eq!(
            Scope::parse("branch", Some("origin/main".into()), None, None).unwrap(),
            Scope::Branch {
                base: Some("origin/main".into())
            }
        );
        assert_eq!(
            Scope::parse("commits", None, Some("HEAD~2".into()), None).unwrap(),
            Scope::Commits {
                from: "HEAD~2".into(),
                to: None
            }
        );
        assert_eq!(
            Scope::parse("branch", None, None, None).unwrap().name(),
            "branch"
        );
        for (scope, base, from, to) in [
            ("commits", None, None, None),
            ("unstaged", Some("main"), None, None),
            ("staged", None, Some("HEAD"), None),
            ("branch", None, None, Some("HEAD")),
            ("branch", Some("--output=x"), None, None),
            ("commits", None, Some("a..b"), None),
            ("commits", None, Some("HEAD"), Some("bad ref")),
            ("commits", None, Some("HEAD\n"), None),
            ("everything", None, None, None),
        ] {
            assert!(
                Scope::parse(
                    scope,
                    base.map(str::to_owned),
                    from.map(str::to_owned),
                    to.map(str::to_owned)
                )
                .is_err(),
                "{scope} {base:?} {from:?} {to:?}"
            );
        }
        assert!(validate_ref(&"a".repeat(REF_LIMIT + 1)).is_err());
    }
    #[tokio::test]
    async fn branch_scope_diffs_the_merge_base_with_untracked_files_and_a_stable_revision() {
        let path = setup();
        initialize(&path).await;
        git(&path, &["checkout", "-q", "-b", "main"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("base.txt"), "base\n").unwrap();
        commit(&path, "base").await;
        git(&path, &["checkout", "-q", "-b", "feature"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("feature.txt"), "feature\n").unwrap();
        commit(&path, "feature").await;
        git(&path, &["checkout", "-q", "main"], 8192).await.unwrap();
        std::fs::write(path.join("main-only.txt"), "main\n").unwrap();
        commit(&path, "main moves").await;
        git(&path, &["checkout", "-q", "feature"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("base.txt"), "edited\n").unwrap();
        std::fs::write(path.join("new.txt"), "new\n").unwrap();
        let scope = Scope::Branch { base: None };
        let first = review(&path, &scope).await.unwrap();
        let mut paths: Vec<_> = first.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["base.txt", "feature.txt", "new.txt"]);
        let base = first.base.as_ref().unwrap();
        assert_eq!(base.name, "main");
        assert_ne!(base.oid, base.merge_base);
        assert_eq!(first.scope, "branch");
        let again = review(&path, &scope).await.unwrap();
        assert_eq!(first.revision, again.revision);
        std::fs::write(path.join("new.txt"), "changed\n").unwrap();
        let changed = review(&path, &scope).await.unwrap();
        assert_ne!(first.revision, changed.revision);
        let explicit = review(
            &path,
            &Scope::Branch {
                base: Some("main".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(explicit.revision, changed.revision);
        assert!(
            review(
                &path,
                &Scope::Branch {
                    base: Some("missing".into())
                }
            )
            .await
            .is_err()
        );
        std::fs::remove_dir_all(&path).unwrap();
    }
    #[tokio::test]
    async fn commits_scope_reads_exactly_the_requested_range() {
        let path = setup();
        initialize(&path).await;
        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        commit(&path, "one").await;
        std::fs::write(path.join("a.txt"), "two\n").unwrap();
        commit(&path, "two").await;
        std::fs::write(path.join("b.txt"), "three\n").unwrap();
        commit(&path, "three").await;
        std::fs::write(path.join("a.txt"), "uncommitted\n").unwrap();
        let range = review(
            &path,
            &Scope::Commits {
                from: "HEAD~2".into(),
                to: Some("HEAD~1".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(range.files.len(), 1);
        assert_eq!(range.files[0].path, "a.txt");
        assert!(range.files[0].patch.contains("+two"));
        let range_ids = range.range.as_ref().unwrap();
        assert_ne!(range_ids.from, range_ids.to);
        let to_head = review(
            &path,
            &Scope::Commits {
                from: "HEAD~1".into(),
                to: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(to_head.files.len(), 1);
        assert_eq!(to_head.files[0].path, "b.txt");
        std::fs::remove_dir_all(&path).unwrap();
    }
    #[test]
    fn status_parser_counts_index_worktree_conflicts_renames_and_upstream() {
        let oid = "a".repeat(40);
        let bytes = [
            format!("# branch.oid {oid}"),
            "# branch.head feature".into(),
            "# branch.upstream origin/feature".into(),
            "# branch.ab +2 -1".into(),
            format!("1 M. N... 100644 100644 100644 {oid} {oid} staged file.txt"),
            format!("1 .M N... 100644 100644 100644 {oid} {oid} worktree.txt"),
            format!("2 R. N... 100644 100644 100644 {oid} {oid} R100 renamed.txt"),
            "original.txt".into(),
            format!("u UU N... 100644 100644 100644 100644 {oid} {oid} {oid} conflict.txt"),
            "? new file.txt".into(),
            String::new(),
        ]
        .join("\0");
        let status = parse_status(bytes.as_bytes(), false);
        assert_eq!(status.head.as_deref(), Some(oid.as_str()));
        assert_eq!(status.branch.as_deref(), Some("feature"));
        assert_eq!(status.upstream.as_deref(), Some("origin/feature"));
        assert_eq!((status.ahead, status.behind), (Some(2), Some(1)));
        assert_eq!(
            (
                status.staged,
                status.unstaged,
                status.untracked,
                status.conflicted
            ),
            (2, 1, 1, 1)
        );
        assert_eq!(
            status.paths,
            [
                "staged file.txt",
                "worktree.txt",
                "renamed.txt",
                "conflict.txt",
                "new file.txt"
            ]
        );
        assert!(!status.truncated);
        let cut = parse_status(&bytes.as_bytes()[..bytes.len() - 4], true);
        assert!(cut.truncated);
        assert_eq!(cut.untracked, 0);
        let detached = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0", false);
        assert_eq!((detached.head, detached.branch), (None, None));
    }
    #[test]
    fn readiness_blockers_are_empty_only_for_a_clean_pushed_branch_on_its_base() {
        let clean = Status {
            head: Some("a".repeat(40)),
            ahead: Some(0),
            behind: Some(0),
            ..Status::default()
        };
        let base = BaseRelation {
            name: "main".into(),
            oid: "b".repeat(40),
            ahead: 3,
            behind: 0,
            merge_conflicts: Some(false),
            conflict_paths: Vec::new(),
        };
        assert!(blockers(&clean, Some(&base), Some(true)).is_empty());
        let dirty = Status {
            unstaged: 1,
            conflicted: 1,
            behind: Some(2),
            ..Status::default()
        };
        let stale = BaseRelation {
            behind: 4,
            merge_conflicts: Some(true),
            ..base
        };
        assert_eq!(
            blockers(&dirty, Some(&stale), Some(false)),
            [
                "unborn",
                "conflicts",
                "baseConflicts",
                "dirty",
                "behindBase",
                "behindUpstream",
                "unpushed"
            ]
        );
    }
    #[tokio::test]
    async fn readiness_reports_dirty_state_base_divergence_and_merge_conflicts() {
        let path = setup();
        initialize(&path).await;
        git(&path, &["checkout", "-q", "-b", "main"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("shared.txt"), "base\n").unwrap();
        commit(&path, "base").await;
        git(&path, &["checkout", "-q", "-b", "feature"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("shared.txt"), "feature\n").unwrap();
        commit(&path, "feature").await;
        let clean = readiness(&path, Some("main"), None).await.unwrap();
        assert!(clean.clean);
        let relation = clean.base.as_ref().unwrap();
        assert_eq!((relation.ahead, relation.behind), (1, 0));
        assert_eq!(relation.merge_conflicts, Some(false));
        assert_eq!(clean.pushed, Some(false));
        assert_eq!(clean.blockers, ["unpushed"]);
        let head = clean.status.head.clone().unwrap();
        let matched = readiness(&path, Some("main"), Some(&head)).await.unwrap();
        assert!(matched.ready);
        git(&path, &["checkout", "-q", "main"], 8192).await.unwrap();
        std::fs::write(path.join("shared.txt"), "main\n").unwrap();
        commit(&path, "main").await;
        git(&path, &["checkout", "-q", "feature"], 8192)
            .await
            .unwrap();
        std::fs::write(path.join("extra.txt"), "x").unwrap();
        let dirty = readiness(&path, Some("main"), Some(&head)).await.unwrap();
        let relation = dirty.base.as_ref().unwrap();
        assert_eq!(relation.behind, 1);
        assert_eq!(relation.merge_conflicts, Some(true));
        assert_eq!(relation.conflict_paths, ["shared.txt"]);
        assert_eq!(dirty.status.untracked, 1);
        assert_eq!(dirty.blockers, ["baseConflicts", "dirty", "behindBase"]);
        assert!(readiness(&path, Some("missing"), None).await.is_err());
        std::fs::remove_dir_all(&path).unwrap();
    }
}
