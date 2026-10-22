use crate::{cli, network::Connection, workflow_launches::Profile};
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Configure separately authenticated external delivery; never shares owner pairing.
    Trigger {
        #[command(subcommand)]
        command: crate::job_triggers::Command,
    },
    /// Inspect, explicitly approve and revoke exact owner command checks.
    Precheck {
        #[command(subcommand)]
        command: crate::job_prechecks::Command,
    },
    /// Acknowledge an unknown precheck and abandon its occurrence; never resume it.
    AbandonPrecheck {
        id: String,
        occurrence: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        digest: String,
        /// Exact current dispatch generation; required after generation 1.
        #[arg(long)]
        job_attempt_id: Option<String>,
        #[arg(long, required = true)]
        acknowledge_unknown_effects: bool,
        #[arg(long)]
        json: bool,
    },
    /// Acknowledge exact no-effect launch cleanup; never stop or retry work.
    AbandonLaunch {
        id: String,
        occurrence: String,
        /// Exact current generation from its available launchReconciliation descriptor.
        #[arg(long)]
        job_attempt_id: String,
        #[arg(long)]
        key: String,
        /// Previously inspected launchReconciliation digest for this generation.
        #[arg(long)]
        digest: String,
        /// Release logical overlap; does not prove exit or undo earlier effects.
        #[arg(long, required = true)]
        acknowledge_unknown_effects: bool,
        #[arg(long)]
        json: bool,
    },
    /// Reauthorize the reader binding of a quota-waiting occurrence; never retries effects.
    AuthorizeQuota {
        id: String,
        occurrence: String,
        #[arg(long)]
        key: String,
        #[arg(long, value_parser = quota_binding_argument)]
        expected_context: String,
        #[arg(long, value_parser = quota_binding_argument)]
        expected_account: String,
        #[arg(long, value_parser = quota_binding_argument)]
        context: String,
        #[arg(long, value_parser = quota_binding_argument)]
        account: String,
        #[arg(long)]
        json: bool,
    },
    /// Save an enabled host-owned job; does not start a model immediately.
    Create {
        #[arg(long)]
        key: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Read one definition with its exact requested profile.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Read a bounded definition page without prompts or native effects.
    List {
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Replace future intent; accepted occurrences retain their old snapshot.
    Edit {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Enable future scheduled admissions. Does not resume native processes.
    Enable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Pause future scheduled admissions; already admitted work may finish.
    Disable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Deliberately admit a separate occurrence, also for a disabled definition.
    RunNow {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Cancel one admitted occurrence; acceptance is not proof of native exit.
    Cancel {
        id: String,
        occurrence: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        json: bool,
    },
    /// Read bounded occurrence history with run pointers and explicit outcomes.
    History {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Inspect an occurrence's immutable profile and run pointer.
    Occurrence {
        id: String,
        occurrence: String,
        #[arg(long)]
        json: bool,
    },
    /// Read a bounded page of retained dispatch generations; never retries work.
    Attempts {
        id: String,
        occurrence: String,
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=4096))]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Inspect one exact job dispatch generation and its retained precheck.
    Attempt {
        id: String,
        occurrence: String,
        attempt: String,
        #[arg(long)]
        json: bool,
    },
    /// Recover the original accepted job mutation without dispatching it again.
    Mutation {
        #[arg(long)]
        key: String,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Trigger { command } => command.machine(),
            Self::Precheck { command } => command.machine(),
            Self::AbandonPrecheck { json, .. } | Self::AbandonLaunch { json, .. } => *json,
            Self::AuthorizeQuota { json, .. } => *json,
            Self::Create { json, .. }
            | Self::Show { json, .. }
            | Self::List { json, .. }
            | Self::Edit { json, .. }
            | Self::Enable { json, .. }
            | Self::Disable { json, .. }
            | Self::RunNow { json, .. }
            | Self::Cancel { json, .. }
            | Self::History { json, .. }
            | Self::Occurrence { json, .. }
            | Self::Attempts { json, .. }
            | Self::Attempt { json, .. }
            | Self::Mutation { json, .. } => *json,
        }
    }
    pub(crate) fn request(self) -> Result<Request> {
        Ok(match self {
            Self::Trigger { command } => Request::Triggers {
                request: command.request()?,
            },
            Self::Precheck { command } => Request::Prechecks {
                request: command.request()?,
            },
            Self::AbandonPrecheck {
                id,
                occurrence,
                key,
                digest,
                job_attempt_id,
                acknowledge_unknown_effects,
                ..
            } => Request::AbandonPrecheck {
                key,
                job_id: id,
                occurrence_id: occurrence,
                expected_digest: digest,
                job_attempt_id,
                acknowledge_unknown_effects,
            },
            Self::AbandonLaunch {
                id,
                occurrence,
                job_attempt_id,
                key,
                digest,
                acknowledge_unknown_effects,
                ..
            } => Request::AbandonLaunchNoEffect {
                key,
                job_id: id,
                occurrence_id: occurrence,
                job_attempt_id,
                expected_digest: digest,
                acknowledge_unknown_effects,
            },
            Self::AuthorizeQuota {
                id,
                occurrence,
                key,
                expected_context,
                expected_account,
                context,
                account,
                ..
            } => Request::AuthorizeQuota {
                key,
                job_id: id,
                occurrence_id: occurrence,
                expected_context_id: expected_context,
                expected_account_fingerprint: expected_account,
                context_id: context,
                account_fingerprint: account,
            },
            Self::Create { key, file, .. } => Request::Create {
                key,
                spec: read_spec(&file)?,
            },
            Self::Show { id, .. } => Request::Get { job_id: id },
            Self::List { offset, .. } => Request::List { offset },
            Self::Edit {
                id,
                key,
                revision,
                file,
                ..
            } => Request::Update {
                key,
                job_id: id,
                expected_revision: revision,
                spec: read_spec(&file)?,
            },
            Self::Enable {
                id, key, revision, ..
            } => Request::SetEnabled {
                key,
                job_id: id,
                expected_revision: revision,
                enabled: true,
            },
            Self::Disable {
                id, key, revision, ..
            } => Request::SetEnabled {
                key,
                job_id: id,
                expected_revision: revision,
                enabled: false,
            },
            Self::RunNow {
                id, key, revision, ..
            } => Request::RunNow {
                key,
                job_id: id,
                expected_revision: revision,
            },
            Self::Cancel {
                id,
                occurrence,
                key,
                ..
            } => Request::CancelOccurrence {
                key,
                job_id: id,
                occurrence_id: occurrence,
            },
            Self::History { id, offset, .. } => Request::History { job_id: id, offset },
            Self::Occurrence { id, occurrence, .. } => Request::Occurrence {
                job_id: id,
                occurrence_id: occurrence,
            },
            Self::Attempts {
                id,
                occurrence,
                offset,
                ..
            } => Request::Attempts {
                job_id: id,
                occurrence_id: occurrence,
                offset,
            },
            Self::Attempt {
                id,
                occurrence,
                attempt,
                ..
            } => Request::Attempt {
                job_id: id,
                occurrence_id: occurrence,
                job_attempt_id: attempt,
            },
            Self::Mutation { key, .. } => Request::Mutation { key },
        })
    }
}
fn read_spec(path: &std::path::Path) -> Result<Spec> {
    serde_json::from_str(&crate::workflow::read_file(path, 16 * 1024)?).map_err(|_| {
        cli::failure(
            "invalid_argument",
            "Job file must match the advertised job schema",
        )
    })
}
fn launch_reconciliation_digest<'de, D>(deserializer: D) -> std::result::Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let digest = String::deserialize(deserializer)?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(serde::de::Error::custom(
            "Launch reconciliation requires the inspected 64-character lowercase hexadecimal digest",
        ));
    }
    Ok(digest)
}

fn launch_reconciliation_acknowledgement<'de, D>(
    deserializer: D,
) -> std::result::Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    if !bool::deserialize(deserializer)? {
        return Err(serde::de::Error::custom(
            "Launch reconciliation requires explicit acknowledgement of unknown effects",
        ));
    }
    Ok(true)
}

fn quota_binding_argument(value: &str) -> std::result::Result<String, &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "Quota binding requires 64 lowercase hexadecimal characters from an inspected observation",
        );
    }
    Ok(value.into())
}
fn quota_binding<'de, D>(deserializer: D) -> std::result::Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    quota_binding_argument(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum QuotaMode {
    Wait,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaPolicy {
    mode: QuotaMode,
    #[serde(deserialize_with = "quota_binding")]
    context_id: String,
    #[serde(deserialize_with = "quota_binding")]
    account_fingerprint: String,
}
fn explicit_quota_policy<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<QuotaPolicy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    QuotaPolicy::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Schedule {
    External,
    Once {
        at: String,
    },
    Cron {
        expression: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
    Rrule {
        rule: String,
        start: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
}
fn default_zone() -> String {
    "Europe/Warsaw".into()
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Misfire {
    Skip,
    #[default]
    CatchUp,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Overlap {
    #[default]
    Skip,
    Queue,
}
fn grace() -> u64 {
    60_000
}
fn budget() -> u64 {
    300_000
}
fn execution_timeout<'de, D>(deserializer: D) -> std::result::Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|milliseconds| !(1_000..=604_800_000).contains(&milliseconds)) {
        return Err(serde::de::Error::custom(
            "Job execution timeout must be between 1 second and 7 days",
        ));
    }
    Ok(value)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum RetryKind {
    LaunchNoEffect,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", try_from = "RetryPolicyFields")]
struct RetryPolicy {
    on: RetryKind,
    max_attempts: u8,
    initial_delay_ms: u64,
    max_delay_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetryPolicyFields {
    on: RetryKind,
    max_attempts: u8,
    initial_delay_ms: u64,
    max_delay_ms: u64,
}
impl TryFrom<RetryPolicyFields> for RetryPolicy {
    type Error = &'static str;

    fn try_from(fields: RetryPolicyFields) -> std::result::Result<Self, Self::Error> {
        if !(1..=8).contains(&fields.max_attempts)
            || !(1_000..=3_600_000).contains(&fields.initial_delay_ms)
            || fields.max_delay_ms < fields.initial_delay_ms
            || fields.max_delay_ms > 86_400_000
        {
            return Err("Job retry policy exceeds its supported attempt or delay bounds");
        }
        Ok(Self {
            on: fields.on,
            max_attempts: fields.max_attempts,
            initial_delay_ms: fields.initial_delay_ms,
            max_delay_ms: fields.max_delay_ms,
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    title: String,
    instruction: String,
    profile: Profile,
    schedule: Schedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    precheck_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry: Option<RetryPolicy>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "explicit_quota_policy"
    )]
    quota_policy: Option<QuotaPolicy>,
    #[serde(default)]
    misfire: Misfire,
    #[serde(default = "grace")]
    grace_ms: u64,
    #[serde(default)]
    overlap: Overlap,
    #[serde(default = "budget")]
    max_elapsed_ms: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "execution_timeout"
    )]
    execution_timeout_ms: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Triggers {
        request: crate::job_triggers::Request,
    },
    Prechecks {
        request: crate::job_prechecks::Request,
    },
    AbandonPrecheck {
        key: String,
        job_id: String,
        occurrence_id: String,
        expected_digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_attempt_id: Option<String>,
        acknowledge_unknown_effects: bool,
    },
    AbandonLaunchNoEffect {
        key: String,
        job_id: String,
        occurrence_id: String,
        job_attempt_id: String,
        #[serde(deserialize_with = "launch_reconciliation_digest")]
        expected_digest: String,
        #[serde(deserialize_with = "launch_reconciliation_acknowledgement")]
        acknowledge_unknown_effects: bool,
    },
    AuthorizeQuota {
        key: String,
        job_id: String,
        occurrence_id: String,
        #[serde(deserialize_with = "quota_binding")]
        expected_context_id: String,
        #[serde(deserialize_with = "quota_binding")]
        expected_account_fingerprint: String,
        #[serde(deserialize_with = "quota_binding")]
        context_id: String,
        #[serde(deserialize_with = "quota_binding")]
        account_fingerprint: String,
    },
    Create {
        key: String,
        spec: Spec,
    },
    Get {
        job_id: String,
    },
    List {
        #[serde(default)]
        offset: u16,
    },
    Update {
        key: String,
        job_id: String,
        expected_revision: u64,
        spec: Spec,
    },
    SetEnabled {
        key: String,
        job_id: String,
        expected_revision: u64,
        enabled: bool,
    },
    RunNow {
        key: String,
        job_id: String,
        expected_revision: u64,
    },
    CancelOccurrence {
        key: String,
        job_id: String,
        occurrence_id: String,
    },
    History {
        job_id: String,
        #[serde(default)]
        offset: u16,
    },
    Occurrence {
        job_id: String,
        occurrence_id: String,
    },
    Attempts {
        job_id: String,
        occurrence_id: String,
        #[serde(default)]
        offset: u16,
    },
    Attempt {
        job_id: String,
        occurrence_id: String,
        job_attempt_id: String,
    },
    Mutation {
        key: String,
    },
}
pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let request = crate::workflow::tool("jobs", json!({"request":command.request()?}))?;
    crate::workflow::capability(connection, &request).await?;
    cli::print_data(
        machine,
        cli::request(connection, request, "workflow").await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const LEGACY: &str = concat!(
        r#"{"title":"Legacy","instruction":"Report result","profile":{"name":null,"cwd":null,"program":"claude","workspace":"shared","harness":null},"#,
        r#""schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},"misfire":"catchUp","graceMs":60000,"overlap":"skip","maxElapsedMs":300000}"#
    );

    #[test]
    fn execution_timeout_round_trip_preserves_legacy_fingerprint_and_run_budget() {
        let legacy: Spec = serde_json::from_str(LEGACY).unwrap();
        assert!(legacy.execution_timeout_ms.is_none());
        assert_eq!(serde_json::to_string(&legacy).unwrap(), LEGACY);
        let mut omitted: Value = serde_json::from_str(LEGACY).unwrap();
        omitted["executionTimeoutMs"] = Value::Null;
        let normalized: Spec = serde_json::from_value(omitted).unwrap();
        assert_eq!(serde_json::to_string(&normalized).unwrap(), LEGACY);

        for milliseconds in [1_000, 604_800_000] {
            let mut selected: Value = serde_json::from_str(LEGACY).unwrap();
            selected["executionTimeoutMs"] = json!(milliseconds);
            selected["maxElapsedMs"] = json!(12_345);
            let parsed: Spec = serde_json::from_value(selected.clone()).unwrap();
            assert_eq!(parsed.execution_timeout_ms, Some(milliseconds));
            assert_eq!(parsed.max_elapsed_ms, 12_345);
            assert_eq!(serde_json::to_value(&parsed).unwrap(), selected);
            let round_trip: Spec =
                serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).unwrap();
            assert_eq!(serde_json::to_value(round_trip).unwrap(), selected);
        }
    }

    #[test]
    fn execution_timeout_refuses_unbounded_or_untyped_intent() {
        for invalid in [
            json!(0),
            json!(999),
            json!(604_800_001_u64),
            json!(u64::MAX),
            json!(-1),
            json!(1_000.5),
            json!("1000"),
            json!(true),
            json!([]),
            json!({}),
        ] {
            let mut spec: Value = serde_json::from_str(LEGACY).unwrap();
            spec["executionTimeoutMs"] = invalid;
            assert!(serde_json::from_value::<Spec>(spec).is_err());
        }
    }
}
