//! Strict native task-launch DTOs; host owns run admission and native authority.
use clap::Args;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Launch {
    pub id: String,
    #[arg(long)]
    task: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    revision: u64,
    #[arg(long)]
    program: Program,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    cwd: Option<String>,
    /// Explicitly share the existing checkout with other workers.
    #[arg(
        long,
        required_unless_present = "worktree",
        conflicts_with = "worktree"
    )]
    shared: bool,
    /// Create an isolated worktree before starting this worker.
    #[arg(long)]
    worktree: bool,
    #[arg(long, conflicts_with = "no_harness")]
    harness: bool,
    #[arg(long, conflicts_with = "harness")]
    no_harness: bool,
    #[arg(long)]
    pub json: bool,
}
impl Launch {
    pub fn request(self) -> Request {
        Request {
            key: self.key,
            run_id: self.id,
            task_id: self.task,
            expected_revision: self.revision,
            profile: Profile {
                name: self.name,
                cwd: self.cwd,
                program: self.program,
                workspace: if self.worktree {
                    Workspace::Worktree
                } else {
                    Workspace::Shared
                },
                harness: if self.harness {
                    Some(true)
                } else if self.no_harness {
                    Some(false)
                } else {
                    None
                },
            },
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Workspace {
    Shared,
    Worktree,
}
#[derive(Clone, Copy, clap::ValueEnum, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Program {
    Shell,
    Claude,
    Codex,
    Gemini,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    name: Option<String>,
    cwd: Option<String>,
    program: Program,
    workspace: Workspace,
    harness: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    key: String,
    run_id: String,
    task_id: String,
    expected_revision: u64,
    profile: Profile,
}
