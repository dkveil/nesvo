use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "quotaWake",
    description = "Retained owner-authorized one-shot native Codex continuation. Configured-reader evidence is not an immutable provider account lease. Operation settlement does not establish task success; restart pauses automatic authority."
)]
pub struct QuotaWake {
    #[schemars(pattern("^[0-9a-f]{32}$"))]
    pub id: String,
    pub session_id: Id,
    pub launch_id: Id,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub phase: QuotaWakePhase,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub predecessor_id: Option<String>,
    pub source: QuotaWakeSource,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 128))]
    pub operation_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub operation_phase: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "providerQuotaWindow")]
pub struct ProviderQuotaWindow {
    #[schemars(range(max = 100))]
    pub used_percent: u64,
    #[schemars(range(min = 1, max = 4294967295u64))]
    pub duration_mins: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "providerQuotaObservation")]
pub struct ProviderQuotaObservation {
    pub program: Provider,
    pub source: ProviderQuotaObservationSource,
    pub revision: Cursor,
    pub status: ProviderQuotaObservationStatus,
    #[schemars(length(min = 1, max = 128))]
    pub reason: String,
    #[serde(deserialize_with = "present_or_null")]
    pub attempted_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub observed_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub source_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub expires_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub age_ms: Option<u64>,
    pub freshness: ProviderQuotaObservationFreshness,
    pub complete: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub ordinary_usage_allowed: Option<bool>,
    #[schemars(length(max = 2))]
    pub windows: Vec<ProviderQuotaWindow>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub context_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub account_fingerprint: Option<String>,
    pub ordinary_usage_eligible: bool,
    #[schemars(length(min = 1, max = 128))]
    pub eligibility_reason: String,
    #[schemars(extend("const" = "readerSnapshotOnly"))]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub reader_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "providerQuotaGateProvider")]
pub struct ProviderQuotaGateProvider {
    pub program: Provider,
    pub source: ProviderQuotaGateProviderSource,
    pub verdict: ProviderQuotaGateProviderVerdict,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub resets_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub fresh_until: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub source_revision: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "providerQuotaGateHold")]
pub struct ProviderQuotaGateHold {
    pub id: Id,
    pub kind: ProviderQuotaGateHoldKind,
    pub program: Provider,
    #[schemars(length(min = 1, max = 128))]
    pub reason: String,
    #[serde(deserialize_with = "present_or_null")]
    pub resets_at: Option<u64>,
    pub since: u64,
    #[schemars(range(min = 1))]
    pub checks: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "providerQuotaGate")]
pub struct ProviderQuotaGate {
    pub revision: Cursor,
    #[schemars(length(max = 3))]
    pub providers: Vec<ProviderQuotaGateProvider>,
    #[schemars(length(max = 64))]
    pub holds: Vec<ProviderQuotaGateHold>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProviderQuotaReply {
    #[schemars(length(max = 3))]
    pub providers: Vec<ProviderQuotaObservation>,
    #[serde(deserialize_with = "present_or_null")]
    pub refresh: Option<ProviderQuotaReplyRefresh>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<ProviderQuotaGate>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct QuotaWakeReply {
    pub session_id: Id,
    #[serde(deserialize_with = "present_or_null")]
    pub quota_wake: Option<QuotaWake>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct WakeConfiguredReply {
    pub session_id: Id,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 1))]
    pub wake_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub quota_wake: Option<QuotaWake>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct QuotaWakeSource {
    #[schemars(pattern("^[0-9a-f]{32}$"))]
    pub reader_id: String,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub context_id: String,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub account_fingerprint: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    #[schemars(range(min = 1))]
    pub reset_at: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProviderQuotaReplyRefresh {
    pub program: Provider,
    pub state: QuotaRefreshState,
    pub revision: Cursor,
    pub retry_after_ms: Cursor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub reader_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum QuotaWakePhase {
    Armed,
    Dispatching,
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaObservationSource {
    CodexAppServer,
    ClaudeStatusCache,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaObservationStatus {
    Checking,
    Ready,
    Partial,
    Unavailable,
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaObservationFreshness {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaGateProviderSource {
    CodexAppServer,
    ClaudeStatusline,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaGateProviderVerdict {
    Allow,
    Hold,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderQuotaGateHoldKind {
    Launch,
    Operation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum QuotaRefreshState {
    Queued,
    Pending,
    Cooldown,
}
