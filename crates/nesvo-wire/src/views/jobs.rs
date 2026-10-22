use super::lenient;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobScheduleKind {
    Once,
    Cron,
    Rrule,
    External,
    #[serde(untagged)]
    Other(String),
}

impl JobScheduleKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Once => "once",
            Self::Cron => "cron",
            Self::Rrule => "rrule",
            Self::External => "external",
            Self::Other(kind) => kind,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSchedule {
    pub kind: JobScheduleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl JobSchedule {
    pub fn new(kind: JobScheduleKind) -> Self {
        Self {
            kind,
            at: None,
            expression: None,
            rule: None,
            start: None,
            time_zone: None,
            rest: Map::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobWorkspace {
    Shared,
    Worktree,
    #[serde(untagged)]
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Misfire {
    Skip,
    CatchUp,
    #[serde(untagged)]
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Overlap {
    Skip,
    Queue,
    #[serde(untagged)]
    Other(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProfile {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<JobWorkspace>,
    #[serde(default)]
    pub harness: Option<bool>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    #[serde(default)]
    pub profile: JobProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<JobSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub misfire: Option<Misfire>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grace_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlap: Option<Overlap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_policy: Option<Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarState {
    Ready,
    Blocked,
    Exhausted,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDefinition {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub enabled: bool,
    pub next_due_at: Option<i64>,
    pub schedule: JobSchedule,
    #[serde(default)]
    pub calendar_state: Option<CalendarState>,
    #[serde(default)]
    pub spec: Option<JobSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaState {
    Eligible,
    Waiting,
    Held,
    NotRequired,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceQuota {
    #[serde(default, deserialize_with = "lenient")]
    pub state: Option<QuotaState>,
    #[serde(default, deserialize_with = "lenient")]
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOccurrence {
    pub id: String,
    pub state: String,
    pub reason: Option<String>,
    pub run_id: Option<String>,
    pub due_at: i64,
    pub started_at: Option<i64>,
    #[serde(default, deserialize_with = "lenient")]
    pub quota: OccurrenceQuota,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPage {
    #[serde(default, deserialize_with = "lenient")]
    pub jobs: Vec<JobDefinition>,
    #[serde(default, deserialize_with = "lenient")]
    pub next_offset: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrencePage {
    #[serde(default, deserialize_with = "lenient")]
    pub occurrences: Vec<JobOccurrence>,
    #[serde(default, deserialize_with = "lenient")]
    pub next_offset: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReply {
    #[serde(default, deserialize_with = "lenient")]
    pub job: Option<JobDefinition>,
    #[serde(default, deserialize_with = "lenient")]
    pub occurrence: Option<JobOccurrence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobRequest {
    List {
        offset: u64,
    },
    Get {
        job_id: String,
    },
    History {
        job_id: String,
        offset: u64,
    },
    Occurrence {
        job_id: String,
        occurrence_id: String,
    },
    CancelOccurrence {
        job_id: String,
        occurrence_id: String,
    },
    SetEnabled {
        job_id: String,
        expected_revision: u64,
        enabled: bool,
    },
    RunNow {
        job_id: String,
        expected_revision: u64,
    },
    Create {
        spec: JobSpec,
    },
    Update {
        job_id: String,
        expected_revision: u64,
        spec: JobSpec,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Keyed<'a, T> {
    pub key: &'a str,
    #[serde(flatten)]
    pub request: &'a T,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct JobsCall<T> {
    pub request: T,
}
