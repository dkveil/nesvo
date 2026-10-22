use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpPoolReply {
    pub available: bool,
    pub bounds: McpPoolReplyBounds,
    pub processes: McpPoolReplyProcesses,
    #[schemars(length(max = 64))]
    pub entries: Vec<McpPoolReplyEntriesItem>,
    #[schemars(length(max = 256))]
    pub sessions: Vec<McpPoolReplySessionsItem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpPoolReplyBounds {
    pub processes: u64,
    pub warm_per_key: u64,
    pub idle_ms: u64,
    pub connect_ms: u64,
    pub sessions: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpPoolReplyProcesses {
    pub warm: u64,
    pub leased: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpPoolReplyEntriesItem {
    #[schemars(pattern("^[0-9a-f]{32}$"))]
    pub entry_id: String,
    pub server: String,
    pub program: Program,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub digest: String,
    pub root: String,
    pub state: PoolEntryState,
    #[serde(deserialize_with = "present_or_null")]
    pub session_id: Option<String>,
    pub age_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct McpPoolReplySessionsItem {
    pub session_id: String,
    pub server: String,
    pub program: Program,
    pub mode: PoolSessionMode,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub entry_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum PoolEntryState {
    Warm,
    Leased,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum PoolSessionMode {
    Pooled,
    Cold,
    Dedicated,
}
