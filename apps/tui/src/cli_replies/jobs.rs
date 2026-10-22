use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobRetryPolicy")]
pub struct JobRetryPolicy {
    pub on: JobRetryPolicyOn,
    #[schemars(
        range(min = 1, max = 8),
        description = "Total dispatch generations, including the first."
    )]
    pub max_attempts: u64,
    #[schemars(range(min = 1000, max = 3600000))]
    pub initial_delay_ms: u64,
    #[schemars(
        range(min = 1000, max = 86400000),
        description = "At least initialDelayMs; enforced at the command boundary."
    )]
    pub max_delay_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "jobRetryDecision",
    description = "Immutable outgoing retry decision facts. These do not authorize replay; current occurrence state identifies waiting, cancellation or a later generation. A noEffect decision always names its native attempt, receipt and next ordinal; an uncertainEffect decision carries its deciding probe and has a null next ordinal when it was blocked or exhausted."
)]
pub struct JobRetryDecision {
    pub job_attempt_id: Id,
    #[serde(deserialize_with = "present_or_null")]
    pub attempt_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub launch_receipt_id: Option<Id>,
    pub decided_at: Timestamp,
    pub not_before: Cursor,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 2, max = 8))]
    pub next_ordinal: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<JobRetryDecisionClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<JobRetryProbe>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "jobRetryProbe",
    description = "Journal-only probe keyed by the generation's launch idempotency key. It never contacts a process or provider."
)]
pub struct JobRetryProbe {
    pub observed_at: Timestamp,
    pub result: JobRetryProbeResult,
    #[schemars(length(min = 1))]
    pub launch_key: String,
    #[serde(deserialize_with = "present_or_null")]
    pub run_id: Option<String>,
    pub executor_accepted: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub attempt_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub attempt_state: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub launch_receipt_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "jobRetryClassification",
    description = "Retry class ledger for one generation. Attempt records carry the immutable facts; the launch reconciliation diagnostic adds the live state, retry generation and claim probe."
)]
pub struct JobRetryClassification {
    pub class: EffectClass,
    #[serde(deserialize_with = "present_or_null")]
    pub failure: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub launch_key: Option<String>,
    pub decision: JobRetryClassificationDecision,
    #[serde(deserialize_with = "present_or_null")]
    pub decided_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub not_before: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(range(min = 2, max = 8))]
    pub next_ordinal: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub probe: Option<JobRetryProbe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<JobRetryClassificationState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub retry_job_attempt_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub claim_probe: Option<Option<JobRetryProbe>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "jobRetryAdmission",
    description = "Names the failed generation and class that admitted this retry generation."
)]
pub struct JobRetryAdmission {
    pub source_job_attempt_id: Id,
    pub class: JobRetryDecisionClass,
    #[serde(deserialize_with = "present_or_null")]
    pub claim_probe: Option<JobRetryProbe>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "jobDefinition")]
pub struct JobDefinition {
    pub id: Id,
    pub title: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub enabled: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub next_due_at: Option<Cursor>,
    pub created_at: Timestamp,
    pub schedule: JobSchedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_state: Option<JobDefinitionCalendarState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub calendar_error: Option<Option<JobDefinitionCalendarError>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<JobDefinitionSpec>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "jobOccurrence")]
pub struct JobOccurrence {
    pub id: Id,
    pub job_id: Id,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub job_attempt_id: Option<Option<Id>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 1), transform = nullable)]
    pub job_attempt_ordinal: Option<Option<u64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub retry: Option<Option<JobRetryDecision>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Current generation's retained timeout evidence, or null without a timeout; historical accepted envelopes may omit this field. Cleanup acceptance is not observed native exit.", transform = nullable)]
    pub execution_timeout: Option<Option<JobExecutionTimeout>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Inspected exact-generation launch cleanup descriptor. Only available:true with its current digest permits an explicit owner acknowledgement. Historical accepted envelopes may omit this field.", transform = nullable)]
    pub launch_reconciliation: Option<Option<JobLaunchReconciliation>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Retained owner acknowledgement releasing logical overlap after an exact no-effect launch. This does not prove exit, complete a native stop, retry work or undo precheck effects. Historical accepted envelopes may omit this field.", transform = nullable)]
    pub launch_resolution: Option<Option<JobLaunchResolution>>,
    #[schemars(range(min = 1))]
    pub job_revision: u64,
    pub trigger: JobOccurrenceTrigger,
    pub due_at: Timestamp,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub coalesced_from_at: Option<Option<Cursor>>,
    pub created_at: Timestamp,
    pub state: JobOccurrenceState,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    pub run_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub started_at: Option<Cursor>,
    #[serde(deserialize_with = "present_or_null")]
    pub finished_at: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<JobOccurrenceSpec>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub attempt_id: Option<Option<Id>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub session_id: Option<Option<Id>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub launch_receipt_id: Option<Option<Id>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub cancellation: Option<Option<JobCancellation>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub precheck: Option<Option<JobOccurrencePrecheck>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<JobQuotaDecision>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "jobAttemptSummary")]
pub struct JobAttemptSummary {
    pub id: Id,
    pub job_id: Id,
    pub occurrence_id: Id,
    #[schemars(range(min = 1))]
    pub ordinal: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub retry: Option<Option<JobRetryDecision>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub retry_classification: Option<Option<JobRetryClassification>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub retry_admission: Option<Option<JobRetryAdmission>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Current generation's retained timeout evidence, or null without a timeout; historical accepted envelopes may omit this field. Cleanup acceptance is not observed native exit.", transform = nullable)]
    pub execution_timeout: Option<Option<JobExecutionTimeout>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Inspected exact-generation launch cleanup descriptor. Only available:true with its current digest permits an explicit owner acknowledgement. Historical accepted envelopes may omit this field.", transform = nullable)]
    pub launch_reconciliation: Option<Option<JobLaunchReconciliation>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(description = "Retained owner acknowledgement releasing logical overlap after an exact no-effect launch. This does not prove exit, complete a native stop, retry work or undo precheck effects. Historical accepted envelopes may omit this field.", transform = nullable)]
    pub launch_resolution: Option<Option<JobLaunchResolution>>,
    #[serde(deserialize_with = "present_or_null")]
    pub run_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub run_state: Option<String>,
    pub state: JobAttemptSummaryState,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    pub created_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub claimed_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub finished_at: Option<u64>,
    #[serde(deserialize_with = "present_or_null")]
    pub attempt_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub session_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub launch_receipt_id: Option<Id>,
    #[serde(deserialize_with = "present_or_null")]
    pub precheck: Option<JobOccurrencePrecheck>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "jobAttemptDetail")]
pub struct JobAttemptDetail {
    #[serde(flatten)]
    pub summary: JobAttemptSummary,
    #[serde(deserialize_with = "present_or_null")]
    pub result: Option<JobAttemptResult>,
    #[serde(deserialize_with = "present_or_null")]
    pub validation: Option<JobAttemptValidation>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "jobAttemptChecks")]
pub struct JobAttemptChecks(#[schemars(length(max = 16))] pub Vec<JobAttemptChecksItem>);

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobAttemptResult")]
pub struct JobAttemptResult {
    pub outcome: ReportedOutcome,
    #[schemars(length(min = 1, max = 2048))]
    pub summary: String,
    #[schemars(length(max = 32), inner(length(min = 1, max = 1024)))]
    pub files: Vec<String>,
    #[schemars(length(max = 16), inner(length(min = 1, max = 1024)))]
    pub artifacts: Vec<String>,
    pub checks: JobAttemptChecks,
    #[schemars(length(max = 16), inner(length(min = 1, max = 1024)))]
    pub limitations: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobAttemptValidation")]
pub struct JobAttemptValidation {
    pub passed: bool,
    #[schemars(length(min = 1, max = 1024))]
    pub summary: String,
    pub checks: JobAttemptChecks,
    pub source: JobAttemptValidationSource,
    #[serde(deserialize_with = "present_or_null")]
    pub validator_session_id: Option<Id>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobCancellation")]
pub struct JobCancellation {
    pub state: JobCancellationState,
    pub requested_at: Timestamp,
    pub observed_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[schemars(length(min = 1, max = 128))]
    pub control_key: String,
    #[serde(deserialize_with = "present_or_null")]
    pub control_id: Option<Id>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobExecutionTimeout")]
pub struct JobExecutionTimeout {
    pub job_id: Id,
    pub occurrence_id: Id,
    pub job_attempt_id: Id,
    pub run_id: Id,
    pub attempt_id: Id,
    pub session_id: Id,
    pub launch_receipt_id: Id,
    #[schemars(
        range(min = 1000, max = 604800000),
        description = "Optional per-generation execution window from native launch admission; excludes prechecks and remains independent of maxElapsedMs. An accepted explicit worker report before the deadline disarms it."
    )]
    pub execution_timeout_ms: u64,
    pub armed_at: Timestamp,
    pub deadline_at: Timestamp,
    pub state: JobExecutionTimeoutState,
    #[serde(deserialize_with = "present_or_null")]
    pub requested_at: Option<u64>,
    pub observed_at: Timestamp,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 1, max = 128))]
    pub reason: Option<String>,
    #[schemars(length(min = 1, max = 128))]
    pub control_key: String,
    #[serde(deserialize_with = "present_or_null")]
    pub control_id: Option<Id>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobLaunchReconciliation")]
pub struct JobLaunchReconciliation {
    #[schemars(extend("const" = "launchNoEffect"))]
    pub kind: String,
    pub job_id: Id,
    pub occurrence_id: Id,
    pub job_attempt_id: Id,
    pub run_id: Id,
    pub attempt_id: Id,
    pub session_id: Id,
    pub launch_receipt_id: Id,
    pub available: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "present_or_null")]
    #[schemars(length(min = 64, max = 64), pattern("^[0-9a-f]{64}$"))]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_classification: Option<JobRetryClassification>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "jobLaunchResolution")]
pub struct JobLaunchResolution {
    #[schemars(extend("const" = "launchNoEffect"))]
    pub kind: String,
    pub job_id: Id,
    pub occurrence_id: Id,
    pub job_attempt_id: Id,
    pub run_id: Id,
    pub attempt_id: Id,
    pub session_id: Id,
    pub launch_receipt_id: Id,
    #[schemars(length(min = 64, max = 64), pattern("^[0-9a-f]{64}$"))]
    pub digest: String,
    #[schemars(length(min = 1, max = 128))]
    pub mutation_key: String,
    pub acknowledged_at: Timestamp,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "precheckApproval")]
pub struct PrecheckApproval {
    pub id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<PrecheckApprovalSpec>,
    #[schemars(length(min = 64, max = 64))]
    pub digest: String,
    #[schemars(range(min = 1))]
    pub revision: u64,
    pub enabled: bool,
    pub created_at: Timestamp,
    #[schemars(extend("const" = "ownerExactCommand"))]
    pub trust: String,
    #[schemars(extend("const" = false))]
    pub sandboxed: bool,
    #[schemars(extend("const" = "isolated-platform-v1"))]
    pub environment_policy: String,
    #[schemars(length(max = 1), extend("items" = {"const": "SystemRoot"}))]
    pub platform_environment_keys: Vec<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "precheckOutcome")]
pub struct PrecheckOutcome {
    pub state: PrecheckOutcomeState,
    pub reason: String,
    #[serde(deserialize_with = "present_or_null")]
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    pub cleanup_confirmed: bool,
    #[serde(deserialize_with = "present_or_null")]
    pub command_started: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub stderr: Option<String>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(
    rename = "jobQuotaPolicy",
    description = "Explicit owner opt-in to configured-reader quota admission; currently Codex only. Requires jobQuotaAdmission:true. Reader observations are not an immutable native-account lease or a guarantee of provider acceptance. Omission preserves legacy intent."
)]
pub struct JobQuotaPolicy {
    #[schemars(extend("const" = "wait"))]
    pub mode: String,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub context_id: String,
    #[schemars(pattern("^[0-9a-f]{64}$"))]
    pub account_fingerprint: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(
    rename = "jobQuotaDecision",
    description = "Additive retained quota admission evidence. Historical accepted envelopes may omit it. Waiting does not imply a native effect or authorize retry; reader eligibility does not guarantee provider acceptance."
)]
pub struct JobQuotaDecision {
    pub state: JobQuotaDecisionState,
    #[serde(deserialize_with = "present_or_null")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[schemars(extend(
    "anyOf" = [
        {"required": ["job"]},
        {"required": ["jobs"]},
        {"required": ["occurrence"]},
        {"required": ["occurrences"]},
        {"required": ["jobAttempts", "nextOffset"]},
        {"required": ["jobAttempt"]},
    ]
))]
pub struct WorkflowJobs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<JobDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 16))]
    pub jobs: Option<Vec<JobDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<JobOccurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 8))]
    pub occurrences: Option<Vec<JobOccurrence>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 8))]
    pub job_attempts: Option<Vec<JobAttemptSummary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_attempt: Option<JobAttemptDetail>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub next_offset: Option<Option<u64>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[schemars(extend(
    "anyOf" = [
        {"required": ["precheckApproval"]},
        {"required": ["precheckApprovals"]},
        {"required": ["precheckDescription"]},
    ]
))]
pub struct WorkflowPrechecks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<WorkflowRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck_approval: Option<PrecheckApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 16))]
    pub precheck_approvals: Option<Vec<PrecheckApproval>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck_description: Option<WorkflowPrechecksPrecheckDescription>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(transform = nullable)]
    pub next_offset: Option<Option<u64>>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobSchedule {
    Once(OnceSchedule),
    Cron(CronSchedule),
    Rrule(RruleSchedule),
    External(ExternalSchedule),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct OnceSchedule {
    pub at: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct CronSchedule {
    pub expression: String,
    pub time_zone: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct RruleSchedule {
    pub rule: String,
    pub start: String,
    pub time_zone: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct ExternalSchedule {}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct JobDefinitionCalendarError {
    pub code: String,
    pub message: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct JobDefinitionSpec {
    pub profile: JobSpecProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<JobRetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        range(min = 1000, max = 604800000),
        description = "Optional per-generation execution window from native launch admission; excludes prechecks and remains independent of maxElapsedMs. An accepted explicit worker report before the deadline disarms it."
    )]
    pub execution_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_policy: Option<JobQuotaPolicy>,
    pub title: Value,
    pub instruction: Value,
    pub schedule: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct JobOccurrenceSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<JobRetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        range(min = 1000, max = 604800000),
        description = "Immutable execution window accepted for this occurrence; omission preserves legacy behavior."
    )]
    pub execution_timeout_ms: Option<u64>,
    pub profile: JobSpecProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_policy: Option<JobQuotaPolicy>,
    pub title: Value,
    pub instruction: Value,
    pub schedule: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct JobOccurrencePrecheck {
    pub approval_id: String,
    #[serde(deserialize_with = "present_or_null")]
    pub approval_digest: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 1), description = "Observed approval revision for generation 2 and later, or null when unavailable; omitted from legacy generation-1 records.", transform = nullable)]
    pub approval_revision: Option<Option<u64>>,
    pub state: PrecheckState,
    pub reason: String,
    pub authorized_at: u64,
    #[serde(deserialize_with = "present_or_null")]
    pub finished_at: Option<i64>,
    #[serde(deserialize_with = "present_or_null")]
    pub result: Option<PrecheckOutcome>,
    #[serde(deserialize_with = "present_or_null")]
    pub observed_at: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct JobAttemptChecksItem {
    #[schemars(length(min = 1, max = 128))]
    pub name: String,
    pub outcome: CheckOutcome,
    #[schemars(length(min = 1, max = 1024))]
    pub details: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct PrecheckApprovalSpec {
    pub version: Value,
    pub title: Value,
    pub executable: Value,
    pub arguments: Value,
    pub cwd: Value,
    pub timeout_ms: Value,
    pub pass_exit_codes: Value,
    pub skip_exit_codes: Value,
    pub environment: Value,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct WorkflowPrechecksPrecheckDescription {
    pub spec: Map<String, Value>,
    #[schemars(length(min = 64, max = 64))]
    pub digest: String,
    #[schemars(extend("const" = "notApproved"))]
    pub trust: String,
    #[schemars(extend("const" = false))]
    pub sandboxed: bool,
    #[schemars(extend("const" = "isolated-platform-v1"))]
    pub environment_policy: String,
    #[schemars(length(max = 1), extend("items" = {"const": "SystemRoot"}))]
    pub platform_environment_keys: Vec<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct JobSpecProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_quota_capture: Option<ClaudeQuotaCapture>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobRetryPolicyOn {
    LaunchNoEffect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobRetryDecisionClass {
    NoEffect,
    UncertainEffect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobRetryProbeResult {
    Absent,
    NoEffectProven,
    AttemptFound,
    SessionFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum EffectClass {
    #[serde(rename = "noEffect")]
    No,
    #[serde(rename = "uncertainEffect")]
    Uncertain,
    #[serde(rename = "definiteEffect")]
    Definite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobRetryClassificationDecision {
    Probing,
    Adopted,
    RetryWaiting,
    Blocked,
    Canceled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobRetryClassificationState {
    Waiting,
    Claimed,
    Canceled,
    Blocked,
    Adopted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobDefinitionCalendarState {
    Ready,
    Exhausted,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobOccurrenceTrigger {
    Schedule,
    Manual,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobOccurrenceState {
    Queued,
    Dispatching,
    Running,
    NeedsValidation,
    Reconcile,
    Skipped,
    Succeeded,
    Failed,
    Canceled,
    Prechecking,
    Canceling,
    RetryWaiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobAttemptSummaryState {
    Dispatching,
    Prechecking,
    Running,
    NeedsValidation,
    Reconcile,
    Canceling,
    Succeeded,
    Failed,
    Skipped,
    Canceled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ReportedOutcome {
    Succeeded,
    Failed,
    Blocked,
    Canceled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobAttemptValidationSource {
    OwnerAttestation,
    CoordinatorAttestation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobCancellationState {
    Requested,
    AwaitingPrecheck,
    Dispatching,
    AwaitingExit,
    Blocked,
    Unconfirmed,
    Completed,
    Abandoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobExecutionTimeoutState {
    Armed,
    Disarmed,
    Dispatching,
    AwaitingExit,
    Blocked,
    Unconfirmed,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum PrecheckOutcomeState {
    Passed,
    Skipped,
    Failed,
    TimedOut,
    OutputLimit,
    Refused,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum JobQuotaDecisionState {
    Waiting,
    Eligible,
    NotRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum PrecheckState {
    Running,
    Passed,
    Skipped,
    Failed,
    TimedOut,
    OutputLimit,
    Refused,
    Unknown,
    Abandoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum CheckOutcome {
    Passed,
    Failed,
    Skipped,
}
