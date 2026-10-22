use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "project")]
pub struct Project {
    #[schemars(length(min = 1, max = 4096))]
    pub root: String,
    #[schemars(length(max = 128))]
    pub name: String,
    #[serde(deserialize_with = "present_or_null")]
    pub default_branch: Option<String>,
    pub last_activity_at: Timestamp,
    pub pinned: bool,
    pub open_sessions: u64,
    #[schemars(length(max = 64))]
    pub sessions: Vec<Id>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectsReply {
    #[schemars(length(max = 256))]
    pub projects: Vec<Project>,
    #[schemars(range(min = 1))]
    pub limit: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectPinnedReply {
    #[schemars(length(min = 1, max = 4096))]
    pub root: String,
    pub pinned: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectLayoutReply {
    #[schemars(length(min = 1, max = 4096))]
    pub root: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 40))]
    pub default_layout: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectDefaultsReply {
    #[schemars(length(min = 1, max = 4096))]
    pub root: String,
    #[schemars(length(max = 128))]
    pub name: String,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 40))]
    pub default_layout: Option<String>,
    #[schemars(length(min = 1))]
    pub launch_folder: String,
    #[schemars(length(max = 8))]
    pub folders: Vec<ProjectDefaultsReplyFoldersItem>,
    pub worktree_setup: ProjectDefaultsReplyWorktreeSetup,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectDefaultsReplyFoldersItem {
    #[schemars(length(min = 1))]
    pub folder: String,
    #[schemars(range(min = 1))]
    pub launches: u64,
    pub last_launch_at: Timestamp,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectDefaultsReplyWorktreeSetup {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(pattern("^[a-f0-9]{64}$"), transform = nullable)]
    pub digest: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_worktrees: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProjectDefaultsReplyWorktreeSetupError>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProjectDefaultsReplyWorktreeSetupError {
    #[schemars(pattern("^[a-z][a-z0-9_]+$"))]
    pub code: String,
    pub message: String,
}
