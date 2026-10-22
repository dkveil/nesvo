use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "receipt")]
pub struct Receipt {
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub id: String,
    pub operation: NativeOperation,
    pub phase: ReceiptPhase,
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub session_id: String,
    pub result: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "pasteReceipt")]
pub struct PasteReceipt {
    #[schemars(pattern("^[a-f0-9]{32}$"))]
    pub id: String,
    #[schemars(extend("const" = "paste"))]
    pub operation: String,
    #[schemars(extend("const" = "pasted"))]
    pub phase: String,
    pub session_id: Id,
    pub result: PasteReceiptResult,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "providerAvailability")]
pub struct ProviderAvailability {
    pub state: ProviderAvailabilityState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "session")]
pub struct Session {
    pub id: Id,
    pub name: String,
    pub cwd: String,
    pub created_at: String,
    #[schemars(range(min = 10, max = 300))]
    pub cols: u64,
    #[schemars(range(min = 2, max = 150))]
    pub rows: u64,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<Program>,
    #[serde(deserialize_with = "present_or_null")]
    pub group_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub controller_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_profile: Option<LaunchProfile>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub harness: Option<Option<HarnessConfiguration>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_context: Option<RepositoryContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_root: Option<SearchRoot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hibernation: Option<SessionHibernation>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "sessionHibernation")]
pub struct SessionHibernation {
    #[schemars(extend("const" = "hibernated"))]
    pub state: String,
    pub hibernated_at: Cursor,
    #[schemars(pattern(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ))]
    pub conversation_id: String,
    pub trigger: SessionHibernationTrigger,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 1024))]
    pub last_resume_failure: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "resumeTarget")]
pub struct ResumeTarget {
    pub provider: Provider,
    #[schemars(pattern(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ))]
    pub conversation_id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "resumeVerification")]
#[schemars(extend(
    "if" = {"properties": {"state": {"const": "resumeFailed"}}},
    "then" = {"required": ["reason"]},
    "else" = {"not": {"required": ["reason"]}}
))]
pub struct ResumeVerification {
    pub state: ResumeVerificationState,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "recoveryRecord")]
pub struct RecoveryRecord {
    pub id: Id,
    pub state: RecoveryRecordState,
    pub spec: RecoveryRecordSpec,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "page")]
pub struct Page {
    #[schemars(extend("const" = "terminalReplay"))]
    pub format: String,
    #[schemars(length(max = 8192))]
    pub data: String,
    pub from_cursor: Cursor,
    pub next_cursor: Cursor,
    pub floor_cursor: Cursor,
    pub head_cursor: Cursor,
    pub gap: bool,
    pub more: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "harnessConfiguration")]
pub struct HarnessConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_permissions: Option<HarnessConfigurationNativePermissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_tool_policy: Option<HarnessConfigurationChildToolPolicy>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "nativeToolNames")]
pub struct NativeToolNames(
    #[schemars(length(max = 32), extend("uniqueItems" = true), inner(length(min = 1, max = 128), pattern("^nesvo_[a-z0-9_]+$")))]
    pub Vec<String>,
);

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "launchProfile")]
pub struct LaunchProfile {
    pub requested: LaunchProfileRequested,
    pub resolved: (),
    pub source: LaunchProfileSource,
    #[schemars(extend("const" = "process"))]
    pub scope: String,
    #[schemars(extend("const" = false))]
    pub inherited_by_children: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "launchProfileSupport")]
pub struct LaunchProfileSupport {
    pub program: Provider,
    #[serde(deserialize_with = "present_or_null")]
    pub version: Option<String>,
    pub probe_status: String,
    pub supported: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub model_flag: Option<ModelFlag>,
    #[serde(deserialize_with = "present_or_null")]
    pub effort_values: Option<Vec<String>>,
    #[serde(deserialize_with = "present_or_null")]
    pub effort_source: Option<EffortSource>,
    #[schemars(extend("const" = true))]
    pub explicit_model_required_for_effort: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(
    rename = "searchRoot",
    description = "Additive F31 evidence of the directory that roots contextual search and why; repository labels and root stay bound to the launch repository. A cwd outside the launch repository toplevel or launch directory is never exposed. Grants no authority."
)]
#[schemars(extend(
    "oneOf" = [
        {
            "properties": {
                "source": {"const": "currentCwd"},
                "reason": {"const": "insideRoot"},
                "path": {"type": "string"},
                "observedAt": {"type": "integer"},
            },
        },
        {
            "properties": {
                "source": {"const": "launchDirectory"},
                "reason": {"const": "outsideRoot"},
                "path": {"type": "null"},
                "observedAt": {"type": "integer"},
            },
        },
        {
            "properties": {
                "source": {"const": "launchDirectory"},
                "reason": {"const": "noCurrentCwd"},
                "path": {"type": "null"},
                "observedAt": {"type": "null"},
            },
        },
    ]
))]
pub struct SearchRoot {
    pub source: SearchRootSource,
    pub reason: SearchRootReason,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 4096))]
    pub path: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 9007199254740991u64))]
    pub observed_at: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "repositoryContext")]
#[schemars(extend(
    "oneOf" = [
        {
            "properties": {
                "state": {"const": "ready"},
                "name": {"type": "string"},
                "branch": {"type": "string"},
                "observedAt": {"type": "integer"},
            },
        },
        {
            "properties": {
                "state": {"const": "detached"},
                "name": {"type": "string"},
                "branch": {"type": "null"},
                "observedAt": {"type": "integer"},
            },
        },
        {
            "properties": {
                "state": {"enum": ["notRepository", "stale"]},
                "name": {"type": "null"},
                "branch": {"type": "null"},
                "observedAt": {"type": "integer"},
            },
        },
        {
            "properties": {
                "state": {"enum": ["checking", "unavailable"]},
                "name": {"type": "null"},
                "branch": {"type": "null"},
                "observedAt": {"type": "null"},
            },
        },
    ]
))]
pub struct RepositoryContext {
    #[schemars(extend("const" = "launchDirectory"))]
    pub source: String,
    pub state: RepositoryContextState,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(
        length(min = 1, max = 128),
        pattern("^[^\u{0000}-\u{001f}-]+$"),
        description = "Nonempty repository/worktree label, at most 128 UTF-8 bytes; runtime validation enforces byte length."
    )]
    pub name: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(
        length(min = 1, max = 256),
        pattern("^[^\u{0000}-\u{001f}-]+$"),
        description = "Actual symbolic branch label, at most 256 UTF-8 bytes; runtime validation enforces byte length."
    )]
    pub branch: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(max = 9007199254740991u64))]
    pub observed_at: Option<u64>,
    #[schemars(range(max = 9007199254740991u64))]
    pub revision: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct OperationReply {
    pub receipt: Receipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<OperationReplyWait>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct EventsReply {
    #[schemars(length(max = 32))]
    pub events: Vec<EventsReplyEventsItem>,
    pub next_cursor: Cursor,
    pub head_cursor: Cursor,
    pub floor_cursor: Cursor,
    pub gap: bool,
    pub more: bool,
    pub health: EventsReplyHealth,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct SessionReply {
    pub session: Session,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct SessionsReply {
    pub sessions: Vec<Session>,
    pub groups: Vec<Value>,
    pub revision: Cursor,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProvidersReply {
    pub providers: ProvidersReplyProviders,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct SessionReadReply {
    pub session_id: Id,
    #[schemars(range(min = 10, max = 300))]
    pub cols: u64,
    #[schemars(range(min = 2, max = 150))]
    pub rows: u64,
    pub page: Page,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct RecoveryReply {
    pub records: Vec<RecoveryRecord>,
    #[serde(deserialize_with = "present_or_null")]
    pub next_offset: Option<Cursor>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct CreatedReply {
    pub session_id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeVerification>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[schemars(extend(
    "if" = {"properties": {"state": {"const": "hibernated"}}},
    "then" = {"required": ["hibernation"]},
    "else" = {"required": ["resume"]}
))]
pub struct SessionHibernationReply {
    pub session_id: Id,
    pub state: HibernationState,
    pub replayed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hibernation: Option<SessionHibernation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SessionResumeReason>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DiagnosticsReport {
    #[schemars(extend("const" = 1))]
    pub schema_version: u64,
    pub host: DiagnosticsReportHost,
    pub programs: Vec<Value>,
    pub provider_versions: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_profile_support: Option<Vec<LaunchProfileSupport>>,
    pub sessions: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_restore: Option<SessionRestoreReport>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "sessionRestoreReport")]
pub struct SessionRestoreReport {
    pub policy: SessionRestorePolicy,
    #[schemars(length(max = 256))]
    pub sessions: Vec<SessionRestoreEntry>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionRestorePolicy {
    pub enabled: bool,
    #[schemars(range(min = 1))]
    pub concurrency: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[schemars(extend(
    "if" = {"properties": {"outcome": {"enum": ["hibernated", "reaped"]}}},
    "then" = {"properties": {"code": {"type": "string"}}}
))]
pub struct SessionRestoreEntry {
    pub session_id: Id,
    pub outcome: SessionRestoreOutcome,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 64))]
    pub code: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(max = 1024))]
    pub message: Option<String>,
    pub shutdown_at: Cursor,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct PasteReceiptResult {
    #[schemars(range(min = 1))]
    pub bytes: u64,
    #[schemars(extend("const" = false))]
    pub submitted: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct RecoveryRecordSpec {
    pub name: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub cwd: Option<Option<String>>,
    pub program: Program,
    #[schemars(extend("const" = ""))]
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeTarget>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct HarnessConfigurationNativePermissions {
    pub allow: NativeToolNames,
    #[schemars(extend("const" = "process"))]
    pub scope: String,
    #[schemars(extend("const" = false))]
    pub inherited_by_children: bool,
    pub source: NativePermissionsSource,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(length(min = 1, max = 128), transform = nullable)]
    pub origin_session_id: Option<Option<String>>,
    #[schemars(extend("const" = true))]
    pub provider_rules_still_apply: bool,
    #[schemars(extend("const" = false))]
    pub restricts_other_tools: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct HarnessConfigurationChildToolPolicy {
    pub allow: NativeToolNames,
    #[schemars(extend("const" = "authenticatedClaudeChildren"))]
    pub scope: String,
    #[schemars(extend("const" = false))]
    pub recursive: bool,
    pub source: ChildToolPolicySource,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct LaunchProfileRequested {
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 256))]
    pub model: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 32))]
    pub effort: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct OperationReplyWait {
    pub until: WaitUntil,
    pub outcome: WaitOutcome,
    pub reached: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct EventsReplyEventsItem {
    #[schemars(range(min = 1))]
    pub sequence: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub session_id: Option<String>,
    pub kind: String,
    pub at: Cursor,
    pub payload: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct EventsReplyHealth {
    pub observation_drops: Cursor,
    pub write_failures: Cursor,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct ProvidersReplyProviders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<ProviderAvailability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<ProviderAvailability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini: Option<ProviderAvailability>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct DiagnosticsReportHost {
    pub id: Id,
    #[schemars(pattern("^[a-f0-9]{16}$"))]
    pub build_id: String,
    pub version: String,
    #[schemars(extend("const" = 2))]
    pub protocol_version: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum NativeOperation {
    Create,
    Send,
    Interrupt,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ReceiptPhase {
    Accepted,
    Dispatching,
    Created,
    Failed,
    Unknown,
    Delivered,
    Received,
    Started,
    Waiting,
    Settled,
    Interrupted,
    StopRequested,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderAvailabilityState {
    Ok,
    NoCli,
    NotLoggedIn,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum Program {
    Shell,
    Claude,
    Codex,
    Gemini,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SessionHibernationTrigger {
    Owner,
    IdlePolicy,
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SessionResumeReason {
    Owner,
    Restored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SessionRestoreOutcome {
    Pending,
    Restored,
    Hibernated,
    Reaped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ResumeVerificationState {
    Pending,
    Verified,
    ResumeFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RecoveryRecordState {
    Saved,
    Starting,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum LaunchProfileSource {
    Launch,
    ProviderDefaults,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ModelFlag {
    #[serde(rename = "--model")]
    Model,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum EffortSource {
    Cli,
    ModelAdvertised,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SearchRootSource {
    CurrentCwd,
    LaunchDirectory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum SearchRootReason {
    InsideRoot,
    OutsideRoot,
    NoCurrentCwd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum RepositoryContextState {
    Checking,
    Ready,
    Detached,
    NotRepository,
    Unavailable,
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum HibernationState {
    Hibernated,
    Resumed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum NativePermissionsSource {
    None,
    OwnerLaunch,
    OwnerChildPolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ChildToolPolicySource {
    None,
    OwnerLaunch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WaitUntil {
    Delivered,
    Received,
    Started,
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum WaitOutcome {
    Reached,
    Timeout,
    Failed,
    Unknown,
    Interrupted,
    Settled,
}
