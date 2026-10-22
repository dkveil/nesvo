use super::{Tolerant, lenient};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub last_activity_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub open_sessions: usize,
    #[serde(default)]
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ProjectList {
    pub projects: Vec<Tolerant<Project>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ProjectPinned {
    #[serde(default, deserialize_with = "lenient")]
    pub pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Folder {
    pub folder: String,
    #[serde(default)]
    pub launches: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct SetupError {
    #[serde(default, deserialize_with = "lenient")]
    pub code: String,
    #[serde(default, deserialize_with = "lenient")]
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    #[serde(default, deserialize_with = "lenient")]
    pub available: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub configured: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    pub digest: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub approved: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    pub open_worktrees: u64,
    #[serde(default)]
    pub error: Option<Tolerant<SetupError>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub default_layout: Option<String>,
    pub launch_folder: String,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default, deserialize_with = "lenient")]
    pub worktree_setup: WorktreeSetup,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "listProjects")]
pub struct ListProjects {}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "projectDefaults")]
pub struct ProjectDefaults<'a> {
    pub root: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectPin<'a> {
    PinProject { root: &'a str },
    UnpinProject { root: &'a str },
}
