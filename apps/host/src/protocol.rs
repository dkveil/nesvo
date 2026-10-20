use serde::Deserialize;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Auth {
        client_nonce: String,
    },
    List,
    Workflow {
        request: crate::orchestration::Request,
    },
    CreateOperation {
        key: String,
        spec: crate::jobs::LaunchSpec,
    },
    SendOperation {
        key: String,
        session_id: String,
        prompt: String,
    },
    WaitOperation {
        #[serde(flatten)]
        wait: crate::operations::WaitRequest,
    },
    InterruptOperation {
        key: String,
        session_id: String,
    },
    StopOperation {
        key: String,
        session_id: String,
    },
    GetOperation {
        id: Option<String>,
        key: Option<String>,
    },
    ReadEvents {
        after: u64,
        limit: Option<usize>,
        session_id: Option<String>,
    },
    SubscribeEvents {
        after: u64,
        limit: Option<usize>,
        session_id: Option<String>,
    },
    UnsubscribeEvents,
    GetSession {
        session_id: String,
    },
    ReadSession {
        session_id: String,
        after: Option<u64>,
        max_bytes: Option<usize>,
    },
    Launch {
        spec: crate::jobs::LaunchSpec,
    },
    ScheduleSession {
        spec: crate::jobs::LaunchSpec,
        at: String,
    },
    ListSchedules,
    SetWake {
        session_id: String,
        enabled: bool,
    },
    GetQuotaWake {
        session_id: String,
    },
    CancelSchedule {
        id: String,
    },
    GetDiff {
        session_id: String,
        scope: String,
        #[serde(default)]
        directory: Option<String>,
    },
    GetCapabilities,
    GetProviderQuota {
        program: Option<crate::launchers::Program>,
        #[serde(default)]
        refresh: bool,
        #[serde(default)]
        directory: Option<String>,
    },
    GetDiagnostics {
        session_id: Option<String>,
    },
    RegisterPush {
        token: String,
        enabled: bool,
    },
    ListTemplates,
    SaveTemplate {
        name: String,
        spec: crate::jobs::LaunchSpec,
    },
    DeleteTemplate {
        id: String,
    },
    ListRecovery {
        #[serde(default)]
        offset: usize,
    },
    RestoreSession {
        id: String,
        #[serde(default)]
        resume: bool,
    },
    ForgetRecovery {
        id: String,
    },
    AcknowledgeAttention {
        session_id: String,
        sequence: u64,
    },
    MuteSession {
        session_id: String,
        muted: bool,
    },
    ListDirectories {
        path: Option<String>,
    },
    Create {
        name: String,
        cwd: Option<String>,
        group_id: Option<String>,
        #[serde(default)]
        program: crate::launchers::Program,
    },
    RenameSession {
        session_id: String,
        name: String,
    },
    Attach {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Subscribe {
        session_id: String,
    },
    Unsubscribe {
        session_id: String,
    },
    AcquireControl {
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        take_over: bool,
    },
    ReleaseControl {
        session_id: String,
        lease_id: String,
    },
    Input {
        session_id: String,
        data: String,
        lease_id: Option<String>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
        lease_id: Option<String>,
    },
    Close {
        session_id: String,
    },
    CreateGroup {
        name: String,
        parent_id: Option<String>,
        #[serde(default)]
        order: u32,
        expected_revision: u64,
    },
    UpdateGroup {
        group_id: String,
        name: String,
        parent_id: Option<String>,
        order: u32,
        expected_revision: u64,
    },
    DeleteGroup {
        group_id: String,
        expected_revision: u64,
    },
    MoveSession {
        session_id: String,
        group_id: Option<String>,
        expected_revision: u64,
    },
}
