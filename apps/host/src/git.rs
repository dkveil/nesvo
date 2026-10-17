//! Bounded, read-only Git inspection on the machine owning the session.
use anyhow::{Result, anyhow, ensure};
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

const OUTPUT_LIMIT: usize = 24 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub scope: String,
    pub files: Vec<FileDiff>,
    pub truncated: bool,
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

/// No shell expansion, external diff drivers, pagers, or text conversion hooks.
async fn git(cwd: &Path, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool)> {
    let mut command = Command::new("git");
    command
        .args(["--no-pager", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Git output unavailable"))?;
    let result = timeout(Duration::from_secs(10), async {
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
        ensure!(
            truncated || status.success(),
            "Git could not read this repository or path."
        );
        Ok((bytes, truncated))
    })
    .await;
    result.map_err(|_| anyhow!("Git inspection timed out"))?
}

pub async fn review(cwd: &Path, scope: &str) -> Result<Review> {
    ensure!(
        matches!(scope, "unstaged" | "staged" | "untracked"),
        "Invalid diff scope"
    );
    let (root, _) = git(cwd, &["rev-parse", "--show-toplevel"], 4096).await?;
    let root = std::path::PathBuf::from(String::from_utf8(root)?.trim());
    let cwd = root.as_path();
    let args = if scope == "untracked" {
        vec!["ls-files", "--others", "--exclude-standard", "-z"]
    } else if scope == "staged" {
        vec![
            "diff",
            "--cached",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
        ]
    } else {
        vec![
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
        ]
    };
    let (names, cut) = git(cwd, &args, 64 * 1024).await?;
    ensure!(
        !cut,
        "Too many changed paths; narrow the repository before reviewing."
    );
    let names = std::str::from_utf8(&names)
        .map_err(|_| anyhow!("Non UTF-8 Git paths are not supported"))?;
    let mut fields = names.split('\0').filter(|s| !s.is_empty());
    let mut review = Review {
        directory: crate::process::display_path(&root),
        source: None,
        scope: scope.into(),
        files: Vec::new(),
        truncated: false,
    };
    let mut budget = OUTPUT_LIMIT;
    while let Some(first) = fields.next() {
        if review.files.len() >= 128 || budget == 0 {
            review.truncated = true;
            break;
        }
        let (status, old_path, path) = if scope == "untracked" {
            ("?", None, first)
        } else {
            let path = fields
                .next()
                .ok_or_else(|| anyhow!("Incomplete Git path"))?;
            if first.starts_with(['R', 'C']) {
                (
                    first,
                    Some(path.to_owned()),
                    fields.next().ok_or_else(|| anyhow!("Incomplete rename"))?,
                )
            } else {
                (first, None, path)
            }
        };
        let limit = budget.min(8 * 1024);
        let (patch, truncated) = if scope == "untracked" {
            // Do not follow symlinks out of the repository while reading untracked files.
            let file_path = cwd.join(path);
            let metadata = tokio::fs::symlink_metadata(&file_path).await?;
            if !metadata.is_file() {
                (
                    "Untracked symlink or special file (content not read).".into(),
                    false,
                )
            } else {
                let file = tokio::fs::File::open(file_path).await?;
                let mut bytes = Vec::new();
                file.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
                let cut = bytes.len() > limit;
                bytes.truncate(limit);
                if bytes.contains(&0) {
                    ("Binary file (content not displayed).".into(), cut)
                } else {
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
                    (patch, cut)
                }
            }
        } else {
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--find-renames",
                "--no-color",
                "--unified=3",
            ];
            if scope == "staged" {
                args.push("--cached");
            }
            args.push("--");
            if let Some(old) = &old_path {
                args.push(old);
            }
            args.push(path);
            let (bytes, cut) = git(cwd, &args, limit).await?;
            (String::from_utf8_lossy(&bytes).into_owned(), cut)
        };
        budget = budget.saturating_sub(patch.len());
        let additions = patch
            .lines()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
            .count();
        let deletions = patch
            .lines()
            .filter(|l| l.starts_with('-') && !l.starts_with("---"))
            .count();
        review.files.push(FileDiff {
            path: path.into(),
            old_path,
            status: status.into(),
            patch,
            additions,
            deletions,
            truncated,
        });
        // Wire frames are bounded at 64 KiB of plaintext, including JSON escaping.
        if serde_json::to_vec(&review)?.len() > crate::wire::MAX_PLAINTEXT - 2048 {
            review.files.pop();
            review.truncated = true;
            break;
        }
    }
    Ok(review)
}

/// Create a fresh branch from HEAD; never alter or clean the source checkout.
pub async fn create_worktree(cwd: &Path) -> Result<std::path::PathBuf> {
    let (root, _) = git(cwd, &["rev-parse", "--show-toplevel"], 4096).await?;
    let root = std::path::PathBuf::from(String::from_utf8(root)?.trim());
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
        let untracked = review(&path.join("nested"), "untracked").await.unwrap();
        assert_eq!(untracked.files[0].path, "nested/a file.txt");
        git(&path, &["add", "."], 8192).await.unwrap();
        assert_eq!(review(&path, "staged").await.unwrap().files[0].additions, 1);
        git(
            &path,
            &["-c", "core.hooksPath=", "commit", "-m", "test"],
            8192,
        )
        .await
        .unwrap();
        assert!(review(&path, "staged").await.unwrap().files.is_empty());
        std::fs::write(path.join("nested/a file.txt"), "after\n").unwrap();
        let changed = review(&path, "unstaged").await.unwrap();
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
        let staged = review(&path, "staged").await.unwrap();
        assert!(staged.files[0].status.starts_with('R'));
        std::fs::write(path.join("binary.dat"), [0, 1, 2]).unwrap();
        assert!(
            review(&path, "untracked").await.unwrap().files[0]
                .patch
                .contains("Binary")
        );
        assert!(review(&path, "invalid").await.is_err());
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
        assert!(worktree.starts_with(&parent));
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
        assert!(review(&path, "unstaged").await.is_err());
        initialize(&path).await;
        std::fs::write(path.join("large"), vec![b'a'; 100_000]).unwrap();
        let result = review(&path, "untracked").await.unwrap();
        assert!(result.files[0].truncated);
        assert!(result.files[0].patch.len() < 66_000);
        std::fs::remove_dir_all(path).unwrap();
    }
}
