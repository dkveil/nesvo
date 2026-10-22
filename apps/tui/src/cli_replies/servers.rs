use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpServersReply {
    pub repository: String,
    #[schemars(extend("const" = "HEAD:nesvo.toml"))]
    pub source: String,
    pub configured: bool,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(pattern("^[a-f0-9]{64}$"))]
    pub digest: Option<String>,
    pub approved: bool,
    #[schemars(length(max = 8))]
    pub servers: Vec<McpServersReplyServersItem>,
    #[schemars(length(max = 256))]
    pub attached: Vec<McpServersReplyAttachedItem>,
    pub providers: McpServersReplyProviders,
    pub bounds: McpServersReplyBounds,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpServersReplyServersItem {
    #[schemars(pattern("^[a-z0-9][a-z0-9_-]{0,63}$"))]
    pub name: String,
    #[schemars(length(min = 1, max = 1024))]
    pub command: String,
    #[schemars(length(max = 64), inner(length(max = 4096)))]
    pub args: Vec<String>,
    #[schemars(length(max = 32), inner(pattern("^[A-Za-z_][A-Za-z0-9_]{0,127}$")))]
    pub env: Vec<String>,
    #[schemars(length(min = 1, max = 512))]
    pub cwd: String,
    pub state: McpServerState,
    #[serde(deserialize_with = "present_or_null")]
    pub resolved_command: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub problem: Option<McpServerProblem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpServersReplyAttachedItem {
    pub session_id: String,
    pub server: String,
    pub program: Program,
    pub mode: PoolSessionMode,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub entry_id: Option<String>,
    pub repository: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpServersReplyProviders {
    pub claude: McpProviderSupport,
    pub codex: McpProviderSupport,
    pub gemini: McpProviderSupport,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpServersReplyBounds {
    pub servers_per_repository: u64,
    pub processes: u64,
    pub warm_per_key: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum McpServerState {
    Approved,
    Unapproved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum McpServerProblem {
    CommandUnavailable,
    CwdUnavailable,
    CwdOutsideRepository,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum McpProviderSupport {
    LaunchConfig,
    Unsupported,
}
