use crate::{process::display_path, protocol::Command, sessions::State};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::OwnedSemaphorePermit;

const LIMIT_DEFAULT: usize = 50;
const LIMIT_MAX: usize = 200;
const PATH_LIMIT: usize = 4096;
const SUMMARY_CHARS: usize = 200;
const AUTHOR_CHARS: usize = 80;
const PARENTS_MAX: usize = 8;
const RECORD_BYTES: usize = 1024;
const GIT_DEADLINE: Duration = Duration::from_secs(10);
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

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

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author: String,
    pub committed_ms: i64,
    pub parents: Vec<String>,
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let result = match (permit, command) {
        (None, _) => Err(failure(
            "busy",
            "Another file or commit request is running on this connection",
        )),
        (Some(_permit), Command::ListCommits { directory, limit }) => {
            list_commits(&directory, limit).await
        }
        (Some(_), _) => Err(failure("invalid_argument", "Unsupported commit command")),
    };
    let mut event = result.unwrap_or_else(|error| {
        let code = error
            .downcast_ref::<Failure>()
            .map_or("git_failed", |failure| failure.code);
        json!({"type":"error","code":code,"message":error.to_string()})
    });
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

async fn folder(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > PATH_LIMIT || value.chars().any(char::is_control) {
        return Err(failure(
            "invalid_argument",
            "Directory must be a non-empty host path without control characters",
        ));
    }
    if !Path::new(value).is_absolute() {
        return Err(failure("invalid_argument", "Directory must be absolute"));
    }
    let path = tokio::fs::canonicalize(value)
        .await
        .map_err(|_| failure("not_found", "This folder does not exist"))?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| failure("not_found", "This folder does not exist"))?;
    if !metadata.is_dir() {
        return Err(failure("not_directory", "This path is not a folder"));
    }
    Ok(PathBuf::from(display_path(&path)))
}

pub async fn list_commits(directory: &str, limit: Option<usize>) -> Result<Value> {
    let limit = limit.unwrap_or(LIMIT_DEFAULT).clamp(1, LIMIT_MAX);
    let path = folder(directory).await?;
    let root = crate::git::toplevel(&path).await.map_err(|_| {
        failure(
            "not_repository",
            "This folder is not inside a Git repository",
        )
    })?;
    let (commits, truncated) = read(&root, limit).await?;
    Ok(json!({
        "type": "commits",
        "directory": directory,
        "commits": commits,
        "truncated": truncated,
    }))
}

async fn read(root: &Path, limit: usize) -> Result<(Vec<Commit>, bool)> {
    if crate::git::head(root).await?.is_none() {
        return Ok((Vec::new(), false));
    }
    let count = format!("--max-count={}", limit + 1);
    let format = format!("--format=%H{FIELD}%h{FIELD}%an{FIELD}%ct{FIELD}%P{FIELD}%s{RECORD}");
    let output = crate::git::run(
        root,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--no-color",
            "--no-decorate",
            &count,
            &format,
            "HEAD",
            "--",
        ],
        (limit + 1) * RECORD_BYTES,
        GIT_DEADLINE,
    )
    .await
    .map_err(|_| failure("timeout", "Git history did not finish within 10 seconds"))?;
    if !output.truncated && output.code != Some(0) {
        return Err(failure("git_failed", "Git could not read this history"));
    }
    let mut commits = parse(&String::from_utf8_lossy(&output.bytes), output.truncated);
    let truncated = commits.len() > limit || output.truncated;
    commits.truncate(limit);
    Ok((commits, truncated))
}

fn clip(value: &str, chars: usize) -> String {
    value.chars().take(chars).collect()
}

pub fn parse(text: &str, truncated: bool) -> Vec<Commit> {
    let mut records: Vec<&str> = text.split(RECORD).collect();
    if truncated || !text.ends_with(RECORD) {
        records.pop();
    }
    records
        .into_iter()
        .filter_map(|record| {
            let mut fields = record.trim_start_matches(['\n', '\r']).split(FIELD);
            let oid = fields.next()?;
            if !crate::git::is_oid(oid) {
                return None;
            }
            let short_oid = fields.next()?;
            let author = fields.next()?;
            let committed = fields.next()?.parse::<i64>().ok()?;
            let parents = fields.next()?;
            let summary = fields.next().unwrap_or_default();
            Some(Commit {
                oid: oid.to_owned(),
                short_oid: clip(short_oid, 64),
                summary: clip(summary.trim_end(), SUMMARY_CHARS),
                author: clip(author, AUTHOR_CHARS),
                committed_ms: committed.saturating_mul(1000),
                parents: parents
                    .split_whitespace()
                    .filter(|parent| crate::git::is_oid(parent))
                    .take(PARENTS_MAX)
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(path: &Path, args: &[&str]) {
        let output = crate::git::run(path, args, 64 * 1024, GIT_DEADLINE)
            .await
            .unwrap();
        assert_eq!(output.code, Some(0), "git {args:?}");
    }

    async fn repository() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nesvo-commits-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "-q"]).await;
        git(&path, &["config", "user.name", "Nesvo Test"]).await;
        git(&path, &["config", "user.email", "test@example.invalid"]).await;
        path
    }

    async fn commit(path: &Path, file: &str, message: &str) {
        std::fs::write(path.join(file), message).unwrap();
        git(path, &["add", "."]).await;
        git(
            path,
            &["-c", "core.hooksPath=", "commit", "-q", "-m", message],
        )
        .await;
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn commits_list_newest_first_with_parents_and_bounds() {
        let path = repository().await;
        commit(&path, "a.txt", "first change").await;
        commit(&path, "b.txt", "second change\n\nbody line").await;
        commit(&path, "c.txt", "third change").await;
        let event = list_commits(&text(&path), None).await.unwrap();
        assert_eq!(event["type"], "commits");
        assert_eq!(event["directory"], text(&path));
        assert_eq!(event["truncated"], false);
        let commits = event["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0]["summary"], "third change");
        assert_eq!(commits[1]["summary"], "second change");
        assert_eq!(commits[0]["author"], "Nesvo Test");
        assert_eq!(commits[0]["parents"][0], commits[1]["oid"]);
        assert_eq!(commits[2]["parents"].as_array().unwrap().len(), 0);
        assert!(commits[0]["committedMs"].as_i64().unwrap() > 1_000_000_000_000);
        assert!(
            commits[0]["oid"]
                .as_str()
                .unwrap()
                .starts_with(commits[0]["shortOid"].as_str().unwrap())
        );
        let limited = list_commits(&text(&path), Some(2)).await.unwrap();
        assert_eq!(limited["commits"].as_array().unwrap().len(), 2);
        assert_eq!(limited["truncated"], true);
        let floor = list_commits(&text(&path), Some(0)).await.unwrap();
        assert_eq!(floor["commits"].as_array().unwrap().len(), 1);
        let capped = list_commits(&text(&path), Some(5000)).await.unwrap();
        assert_eq!(capped["commits"].as_array().unwrap().len(), 3);
        assert_eq!(capped["truncated"], false);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn commits_refuse_bad_paths_and_non_repositories_and_accept_unborn() {
        let path = repository().await;
        let empty = list_commits(&text(&path), None).await.unwrap();
        assert_eq!(empty["commits"].as_array().unwrap().len(), 0);
        assert_eq!(empty["truncated"], false);
        let code = |error: anyhow::Error| error.downcast_ref::<Failure>().unwrap().code;
        assert_eq!(
            code(list_commits("relative/path", None).await.unwrap_err()),
            "invalid_argument"
        );
        assert_eq!(
            code(
                list_commits(&text(&path.join("missing")), None)
                    .await
                    .unwrap_err()
            ),
            "not_found"
        );
        let outside = std::env::temp_dir().join(format!(
            "nesvo-commits-plain-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("file.txt"), "x").unwrap();
        assert_eq!(
            code(
                list_commits(&text(&outside.join("file.txt")), None)
                    .await
                    .unwrap_err()
            ),
            "not_directory"
        );
        assert_eq!(
            code(list_commits(&text(&outside), None).await.unwrap_err()),
            "not_repository"
        );
        std::fs::remove_dir_all(outside).unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn commits_parse_drops_partial_records_and_clips_fields() {
        let oid = "a".repeat(40);
        let parent = "b".repeat(40);
        let long = "x".repeat(400);
        let text = format!(
            "{oid}{FIELD}aaaaaaa{FIELD}Ann{FIELD}1700000000{FIELD}{parent} not-an-oid{FIELD}{long}{RECORD}\n{oid}{FIELD}aaa{FIELD}Bo"
        );
        let commits = parse(&text, true);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary.chars().count(), SUMMARY_CHARS);
        assert_eq!(commits[0].parents, vec![parent]);
        assert_eq!(commits[0].committed_ms, 1_700_000_000_000);
        assert!(parse("garbage", false).is_empty());
    }
}
