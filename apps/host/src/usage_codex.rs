//! Bounded full usage snapshots from the original CLI, never model or auth RPCs.
use super::LimitWindow;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Semaphore,
};

const READ_BOUND: Duration = Duration::from_secs(8);
const CLEANUP_BOUND: Duration = Duration::from_secs(2);
const MAX_LINE: usize = 256 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_FRAMES: usize = 64;
static READERS: Semaphore = Semaphore::const_new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderContext {
    pub codex_home: String,
    pub context_id: String,
    pub route: RouteObservation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteVerdict {
    ChatgptConfiguredOpenai,
    ApiKey,
    AmazonBedrock,
    Custom,
    Unknown,
}
impl RouteVerdict {
    pub fn code(self) -> &'static str {
        match self {
            Self::ChatgptConfiguredOpenai => "chatgptConfiguredOpenai",
            Self::ApiKey => "apiKey",
            Self::AmazonBedrock => "amazonBedrock",
            Self::Custom => "custom",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteObservation {
    pub verdict: RouteVerdict,
    pub reason: &'static str,
    pub config_fingerprint: Option<String>,
}
impl RouteObservation {
    pub fn unknown(reason: &'static str) -> Self {
        Self {
            verdict: RouteVerdict::Unknown,
            reason,
            config_fingerprint: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    Timeout,
    Io,
    ProviderError,
    InvalidResponse,
    ContextUnavailable,
    CleanupUnconfirmed,
}
impl ReadFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::ProviderError => "provider_error",
            Self::InvalidResponse => "invalid_response",
            Self::ContextUnavailable => "context_unavailable",
            Self::CleanupUnconfirmed => "cleanup_unconfirmed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BucketSource {
    NamedCodex,
    Legacy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowState {
    Missing,
    Null,
    Incomplete,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BucketCompleteness {
    pub primary: WindowState,
    pub secondary: WindowState,
}

impl BucketCompleteness {
    /// A full RPC may legitimately omit either quota window. Absence supplies
    /// no numeric capacity; every advertised window must still be complete.
    pub fn complete_window_count(self) -> Option<usize> {
        let states = [self.primary, self.secondary];
        (!states.contains(&WindowState::Incomplete)).then(|| {
            states
                .iter()
                .filter(|state| **state == WindowState::Complete)
                .count()
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSnapshot {
    // Opaque reader account/workspace metadata, never a native-process binding.
    pub account_id: Option<String>,
    pub ordinary_usage_allowed: Option<bool>,
    pub windows: Vec<LimitWindow>,
    pub complete: bool,
    pub reason: &'static str,
    pub bucket: BucketSource,
    pub completeness: BucketCompleteness,
    pub spend_control_reached: Option<bool>,
    pub rate_limit_reached: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReadOutcome {
    Snapshot(CodexSnapshot),
    Failure(ReadFailure),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexObservation {
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub started_elapsed_ms: u64,
    pub finished_elapsed_ms: u64,
    pub context: Option<ReaderContext>,
    pub outcome: ReadOutcome,
}
impl CodexObservation {
    /// A fresh read is still only reader evidence, never a grant to a native CLI.
    pub fn fresh_at(&self, elapsed_ms: u64, max_age_ms: u64) -> bool {
        matches!(self.outcome, ReadOutcome::Snapshot(_))
            && self.finished_elapsed_ms >= self.started_elapsed_ms
            && elapsed_ms >= self.finished_elapsed_ms
            && elapsed_ms.saturating_sub(self.started_elapsed_ms) <= max_age_ms
    }
}

fn optional_bool(value: &Value, key: &str) -> Result<Option<bool>, ReadFailure> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(ReadFailure::InvalidResponse),
    }
}
fn optional_text(value: &Value, key: &str, limit: usize) -> Result<Option<String>, ReadFailure> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text))
            if !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control) =>
        {
            Ok(Some(text.clone()))
        }
        _ => Err(ReadFailure::InvalidResponse),
    }
}
fn optional_integer(value: &Value, key: &str) -> Result<Option<i64>, ReadFailure> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_i64().map(Some).ok_or(ReadFailure::InvalidResponse),
    }
}

fn window(bucket: &Value, key: &str) -> Result<(WindowState, Option<LimitWindow>), ReadFailure> {
    let Some(value) = bucket.get(key) else {
        return Ok((WindowState::Missing, None));
    };
    if value.is_null() {
        return Ok((WindowState::Null, None));
    }
    if !value.is_object() {
        return Err(ReadFailure::InvalidResponse);
    }
    let used = value
        .get("usedPercent")
        .and_then(Value::as_u64)
        .filter(|n| *n <= 100)
        .ok_or(ReadFailure::InvalidResponse)? as u8;
    let duration = optional_integer(value, "windowDurationMins")?;
    if duration.is_some_and(|n| n <= 0 || n > i64::from(u32::MAX)) {
        return Err(ReadFailure::InvalidResponse);
    }
    let resets_at = optional_integer(value, "resetsAt")?;
    let state = if duration.is_some() && resets_at.is_some_and(|n| n > 0) {
        WindowState::Complete
    } else {
        WindowState::Incomplete
    };
    // The legacy display requires a duration; absent reset remains visible.
    let display = duration.map(|duration| LimitWindow {
        used_percent: used,
        duration_mins: duration as u32,
        resets_at,
    });
    Ok((state, display))
}

struct Bucket {
    completeness: BucketCompleteness,
    windows: Vec<LimitWindow>,
    spend_control_reached: Option<bool>,
    rate_limit_reached: bool,
}
fn bucket(value: &Value) -> Result<Bucket, ReadFailure> {
    if !value.is_object() {
        return Err(ReadFailure::InvalidResponse);
    }
    let (primary, first) = window(value, "primary")?;
    let (secondary, second) = window(value, "secondary")?;
    let spend_control_reached = optional_bool(value, "spendControlReached")?;
    let reached = optional_text(value, "rateLimitReachedType", 128)?;
    if reached.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "rate_limit_reached"
                | "workspace_owner_credits_depleted"
                | "workspace_member_credits_depleted"
                | "workspace_owner_usage_limit_reached"
                | "workspace_member_usage_limit_reached"
        )
    }) {
        return Err(ReadFailure::InvalidResponse);
    }
    for name in ["limitId", "limitName", "normalModelSlug", "planType"] {
        optional_text(value, name, 256)?;
    }
    if let Some(credits) = value.get("credits").filter(|v| !v.is_null()) {
        if !credits.is_object()
            || credits.get("hasCredits").and_then(Value::as_bool).is_none()
            || credits.get("unlimited").and_then(Value::as_bool).is_none()
        {
            return Err(ReadFailure::InvalidResponse);
        }
        optional_text(credits, "balance", 256)?;
    }
    if let Some(limit) = value.get("individualLimit").filter(|v| !v.is_null()) {
        if !limit.is_object()
            || !limit
                .get("remainingPercent")
                .and_then(Value::as_i64)
                .is_some_and(|n| (0..=100).contains(&n))
            || limit.get("resetsAt").and_then(Value::as_i64).is_none()
        {
            return Err(ReadFailure::InvalidResponse);
        }
        for key in ["limit", "used"] {
            if optional_text(limit, key, 256)?.is_none() {
                return Err(ReadFailure::InvalidResponse);
            }
        }
    }
    Ok(Bucket {
        completeness: BucketCompleteness { primary, secondary },
        windows: first.into_iter().chain(second).collect(),
        spend_control_reached,
        rate_limit_reached: reached.is_some(),
    })
}

pub(super) fn parse_snapshot(response: &Value) -> Result<CodexSnapshot, ReadFailure> {
    let result = response
        .get("result")
        .filter(|v| v.is_object())
        .ok_or(ReadFailure::InvalidResponse)?;
    let legacy = result
        .get("rateLimits")
        .ok_or(ReadFailure::InvalidResponse)?;
    let mut selected = bucket(legacy)?;
    let mut source = BucketSource::Legacy;
    match result.get("rateLimitsByLimitId") {
        None | Some(Value::Null) => {}
        Some(Value::Object(buckets)) if buckets.len() <= 32 => {
            for (name, value) in buckets {
                if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
                    return Err(ReadFailure::InvalidResponse);
                }
                let parsed = bucket(value)?;
                if name == "codex" {
                    selected = parsed;
                    source = BucketSource::NamedCodex;
                }
            }
        }
        _ => return Err(ReadFailure::InvalidResponse),
    }
    let account_id = optional_text(result, "accountId", 512)?;
    let ordinary_usage_allowed = optional_bool(result, "ordinaryUsageAllowed")?;
    let complete = selected.completeness.complete_window_count().is_some();
    let reason = if ordinary_usage_allowed == Some(false) {
        "backend_denied"
    } else if !complete {
        "incomplete_snapshot"
    } else if ordinary_usage_allowed.is_none() {
        "backend_permission_unavailable"
    } else if account_id.is_none() {
        "account_identity_unavailable"
    } else {
        "observed"
    };
    Ok(CodexSnapshot {
        account_id,
        ordinary_usage_allowed,
        windows: selected.windows,
        complete,
        reason,
        bucket: source,
        completeness: selected.completeness,
        spend_control_reached: selected.spend_control_reached,
        rate_limit_reached: selected.rate_limit_reached,
    })
}

struct Frames<R> {
    input: BufReader<R>,
    bytes: usize,
    frames: usize,
}
impl<R: AsyncRead + Unpin> Frames<R> {
    fn new(input: R) -> Self {
        Self {
            input: BufReader::new(input),
            bytes: 0,
            frames: 0,
        }
    }
    async fn next(&mut self) -> Result<Value, ReadFailure> {
        if self.frames >= MAX_FRAMES || self.bytes >= MAX_OUTPUT {
            return Err(ReadFailure::InvalidResponse);
        }
        let mut bytes = Vec::new();
        let limit = MAX_LINE.min(MAX_OUTPUT - self.bytes);
        (&mut self.input)
            .take(limit as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| ReadFailure::Io)?;
        if bytes.len() > limit || bytes.last() != Some(&b'\n') {
            return Err(ReadFailure::InvalidResponse);
        }
        self.bytes += bytes.len();
        self.frames += 1;
        serde_json::from_slice(&bytes)
            .ok()
            .filter(Value::is_object)
            .ok_or(ReadFailure::InvalidResponse)
    }
    async fn response(&mut self, id: u64) -> Result<Value, ReadFailure> {
        loop {
            let value = self.next().await?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if value.get("error").is_some() {
                    return Err(ReadFailure::ProviderError);
                }
                if value.get("result").is_none() {
                    return Err(ReadFailure::InvalidResponse);
                }
                return Ok(value);
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct RouteEnvironment {
    openai_base_url: bool,
    api_key: bool,
}
impl RouteEnvironment {
    fn current() -> Self {
        // Only presence is inspected. Never read or retain a credential or URL.
        Self {
            openai_base_url: std::env::var_os("OPENAI_BASE_URL").is_some(),
            api_key: std::env::var_os("OPENAI_API_KEY").is_some()
                || std::env::var_os("CODEX_API_KEY").is_some(),
        }
    }
}

const ROUTE_CONFIG_FIELDS: &[&str] = &[
    "model_provider",
    "model_providers",
    "model",
    "service_tier",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "openai_base_url",
    "chatgpt_base_url",
    "oss",
    "oss_provider",
    "local_provider",
    "auth_mode",
];

fn config_origins(result: &Value) -> Result<Value, ReadFailure> {
    let origins = result
        .get("origins")
        .and_then(Value::as_object)
        .filter(|origins| origins.len() <= 512)
        .ok_or(ReadFailure::InvalidResponse)?;
    let mut selected = Vec::new();
    for field in ROUTE_CONFIG_FIELDS {
        let Some(origin) = origins.get(*field) else {
            continue;
        };
        let kind = origin
            .get("name")
            .and_then(|name| name.get("type"))
            .and_then(Value::as_str)
            .filter(|kind| {
                matches!(
                    *kind,
                    "packagedDefaults"
                        | "mdm"
                        | "system"
                        | "enterpriseManaged"
                        | "user"
                        | "project"
                        | "sessionFlags"
                        | "legacyManagedConfigTomlFromFile"
                        | "legacyManagedConfigTomlFromMdm"
                )
            })
            .ok_or(ReadFailure::InvalidResponse)?;
        let version = optional_text(origin, "version", 512)?.ok_or(ReadFailure::InvalidResponse)?;
        // File paths, profile names and layer bodies are deliberately excluded.
        selected.push(json!([field, kind, version]));
    }
    Ok(Value::Array(selected))
}

fn parse_route(
    account: &Result<Value, ReadFailure>,
    configuration: &Result<Value, ReadFailure>,
    environment: RouteEnvironment,
) -> RouteObservation {
    let Ok(account) = account else {
        return RouteObservation::unknown("route_account_read_failed");
    };
    let Some(account) = account.get("result").filter(|result| result.is_object()) else {
        return RouteObservation::unknown("route_account_invalid");
    };
    let Some(requires_auth) = account.get("requiresOpenaiAuth").and_then(Value::as_bool) else {
        return RouteObservation::unknown("route_account_invalid");
    };
    let Some(auth) = account.get("account").filter(|account| account.is_object()) else {
        return RouteObservation::unknown("route_account_unavailable");
    };
    let (auth_verdict, auth_reason) = match auth.get("type").and_then(Value::as_str) {
        Some("chatgpt") => (
            RouteVerdict::ChatgptConfiguredOpenai,
            "route_chatgpt_configured_openai",
        ),
        Some("apiKey") => (RouteVerdict::ApiKey, "route_auth_api_key"),
        Some("amazonBedrock") => (RouteVerdict::AmazonBedrock, "route_auth_amazon_bedrock"),
        _ => return RouteObservation::unknown("route_account_unsupported"),
    };
    if auth_verdict != RouteVerdict::ChatgptConfiguredOpenai {
        return RouteObservation {
            verdict: auth_verdict,
            reason: auth_reason,
            config_fingerprint: None,
        };
    }
    let Ok(configuration) = configuration else {
        return RouteObservation::unknown("route_config_read_failed");
    };
    let parsed = || -> Result<(RouteVerdict, &'static str, String), ReadFailure> {
        let result = configuration
            .get("result")
            .filter(|result| result.is_object())
            .ok_or(ReadFailure::InvalidResponse)?;
        let config = result
            .get("config")
            .filter(|config| config.is_object())
            .ok_or(ReadFailure::InvalidResponse)?;
        let provider = optional_text(config, "model_provider", 128)?;
        let model = optional_text(config, "model", 256)?;
        let tier = optional_text(config, "service_tier", 128)?;
        let login = optional_text(config, "forced_login_method", 32)?;
        if login
            .as_deref()
            .is_some_and(|login| !matches!(login, "chatgpt" | "api"))
        {
            return Err(ReadFailure::InvalidResponse);
        }
        let oss = optional_bool(config, "oss")?;
        let oss_provider = optional_text(config, "oss_provider", 128)?;
        let local_provider = optional_text(config, "local_provider", 128)?;
        let auth_mode = optional_text(config, "auth_mode", 32)?;
        if auth_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "chatgpt" | "apiKey" | "api" | "amazonBedrock"))
        {
            return Err(ReadFailure::InvalidResponse);
        }
        let openai_base_url = optional_text(config, "openai_base_url", 8192)?;
        let chatgpt_base_url = optional_text(config, "chatgpt_base_url", 8192)?;
        let openai_provider_override = match config.get("model_providers") {
            None | Some(Value::Null) => false,
            Some(Value::Object(providers)) if providers.len() <= 128 => {
                providers.contains_key("openai")
            }
            _ => return Err(ReadFailure::InvalidResponse),
        };
        // These are configured-route facts at read time, not an immutable auth
        // lease. No endpoint, header, environment value or raw config is hashed.
        let projection = json!({
            "provider":provider,"model":model,"serviceTier":tier,"login":login,
            "requiresOpenaiAuth":requires_auth,"oss":oss,"ossProvider":oss_provider,
            "localProvider":local_provider,"authMode":auth_mode,
            "openaiEndpointOverride":openai_base_url.is_some(),
            "chatgptEndpointOverride":chatgpt_base_url.is_some(),
            "openaiProviderOverride":openai_provider_override,
            "environmentEndpointOverride":environment.openai_base_url,
            "environmentApiKey":environment.api_key,
            "origins":config_origins(result)?
        });
        let bytes = serde_json::to_vec(&projection).map_err(|_| ReadFailure::InvalidResponse)?;
        let fingerprint = hex::encode(ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref());
        let verdict = if environment.openai_base_url
            || openai_base_url.is_some()
            || chatgpt_base_url.is_some()
        {
            (RouteVerdict::Custom, "route_custom_endpoint")
        } else if openai_provider_override {
            (RouteVerdict::Custom, "route_openai_provider_override")
        } else if provider
            .as_deref()
            .is_some_and(|provider| provider != "openai")
        {
            (RouteVerdict::Custom, "route_custom_provider")
        } else if oss == Some(true) || oss_provider.is_some() || local_provider.is_some() {
            (RouteVerdict::Custom, "route_oss")
        } else if auth_mode.as_deref() == Some("amazonBedrock") {
            (RouteVerdict::AmazonBedrock, "route_auth_amazon_bedrock")
        } else if environment.api_key
            || login.as_deref() == Some("api")
            || matches!(auth_mode.as_deref(), Some("apiKey" | "api"))
        {
            (RouteVerdict::ApiKey, "route_auth_api_key")
        } else if !requires_auth {
            (RouteVerdict::Unknown, "route_auth_unavailable")
        } else {
            (auth_verdict, auth_reason)
        };
        Ok((verdict.0, verdict.1, fingerprint))
    };
    match parsed() {
        Ok((verdict, reason, fingerprint)) => RouteObservation {
            verdict,
            reason,
            config_fingerprint: Some(fingerprint),
        },
        Err(_) => RouteObservation::unknown("route_config_unsupported"),
    }
}

fn normalized_context_path(path: &Path) -> Result<String, ReadFailure> {
    if !path.is_absolute() || path.to_str().is_none() {
        return Err(ReadFailure::ContextUnavailable);
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(ReadFailure::ContextUnavailable);
                }
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    let normalized = crate::process::display_path(&normalized);
    if normalized.len() > 32 * 1024 || normalized.chars().any(char::is_control) {
        return Err(ReadFailure::ContextUnavailable);
    }
    #[cfg(windows)]
    let normalized = normalized.to_ascii_lowercase();
    Ok(normalized)
}

fn reader_context(
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
    initialized: &Value,
    expected_home: Option<&Path>,
    mut route: RouteObservation,
) -> Result<Option<ReaderContext>, ReadFailure> {
    let result = initialized
        .get("result")
        .filter(|v| v.is_object())
        .ok_or(ReadFailure::InvalidResponse)?;
    let home = match result.get("codexHome") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(home))
            if home.len() <= 32 * 1024
                && !home.chars().any(char::is_control)
                && Path::new(home).is_absolute() =>
        {
            home
        }
        _ => return Err(ReadFailure::ContextUnavailable),
    };
    let normalized_home = normalized_context_path(Path::new(home))?;
    if expected_home
        .map(normalized_context_path)
        .transpose()?
        .is_some_and(|expected| expected != normalized_home)
    {
        return Err(ReadFailure::ContextUnavailable);
    }
    let user_agent = optional_text(result, "userAgent", 1024).unwrap_or(None);
    if user_agent.is_none() {
        route = RouteObservation::unknown("route_reader_version_unavailable");
    }
    let executable = command.0.to_str().ok_or(ReadFailure::ContextUnavailable)?;
    let cwd = normalized_context_path(cwd)?;
    let args = command
        .1
        .iter()
        .map(|s| s.to_str().ok_or(ReadFailure::ContextUnavailable))
        .collect::<Result<Vec<_>, _>>()?;
    let encoded = serde_json::to_vec(&(
        executable,
        args,
        cwd,
        normalized_home,
        user_agent,
        route.verdict.code(),
        route.reason,
        &route.config_fingerprint,
    ))
    .map_err(|_| ReadFailure::ContextUnavailable)?;
    let context_id = hex::encode(ring::digest::digest(&ring::digest::SHA256, &encoded).as_ref());
    Ok(Some(ReaderContext {
        codex_home: home.clone(),
        context_id,
        route,
    }))
}

struct ReadContext<'a> {
    command: &'a (PathBuf, Vec<OsString>),
    cwd: &'a Path,
    home: Option<&'a Path>,
    environment: RouteEnvironment,
}

async fn rpc(
    child: &mut Child,
    requested: &ReadContext<'_>,
    context: &mut Option<ReaderContext>,
    snapshot: &mut Option<CodexSnapshot>,
) -> Result<(), ReadFailure> {
    let input = child.stdin.take().ok_or(ReadFailure::Io)?;
    let output = child.stdout.take().ok_or(ReadFailure::Io)?;
    rpc_io(input, output, requested, context, snapshot).await
}

async fn rpc_io(
    mut input: impl AsyncWrite + Unpin,
    output: impl AsyncRead + Unpin,
    requested: &ReadContext<'_>,
    context: &mut Option<ReaderContext>,
    snapshot: &mut Option<CodexSnapshot>,
) -> Result<(), ReadFailure> {
    let mut output = Frames::new(output);
    let initialize = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"nesvo","version":"0.1.0"},"capabilities":{}}});
    input
        .write_all(format!("{initialize}\n").as_bytes())
        .await
        .map_err(|_| ReadFailure::Io)?;
    input.flush().await.map_err(|_| ReadFailure::Io)?;
    let initialized = output.response(1).await?;
    *context = reader_context(
        requested.command,
        requested.cwd,
        &initialized,
        requested.home,
        RouteObservation::unknown("route_metadata_unavailable"),
    )
    .ok()
    .flatten();
    let requests = [
        json!({"method":"initialized","params":{}}),
        json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
        json!({"id":3,"method":"config/read","params":{"cwd":requested.cwd.to_str().ok_or(ReadFailure::ContextUnavailable)?,"includeLayers":false}}),
        json!({"id":4,"method":"account/rateLimits/read","params":{}}),
    ];
    for request in requests {
        input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|_| ReadFailure::Io)?;
    }
    input.flush().await.map_err(|_| ReadFailure::Io)?;
    collect_observation(&mut output, requested, &initialized, context, snapshot).await
}

async fn collect_observation<R: AsyncRead + Unpin>(
    output: &mut Frames<R>,
    requested: &ReadContext<'_>,
    initialized: &Value,
    context: &mut Option<ReaderContext>,
    snapshot: &mut Option<CodexSnapshot>,
) -> Result<(), ReadFailure> {
    let mut account = None;
    let mut configuration = None;
    loop {
        let response = output.next().await?;
        let id = response.get("id").and_then(Value::as_u64);
        let result = if response.get("error").is_some() {
            Err(ReadFailure::ProviderError)
        } else if response.get("result").is_none() {
            Err(ReadFailure::InvalidResponse)
        } else {
            Ok(response)
        };
        match id {
            Some(2) if account.is_none() => account = Some(result),
            Some(3) if configuration.is_none() => configuration = Some(result),
            Some(4) if snapshot.is_none() => *snapshot = Some(parse_snapshot(&result?)?),
            Some(2..=4) => return Err(ReadFailure::InvalidResponse),
            _ => continue,
        }
        if let (Some(account), Some(configuration)) = (&account, &configuration) {
            *context = reader_context(
                requested.command,
                requested.cwd,
                initialized,
                requested.home,
                parse_route(account, configuration, requested.environment),
            )
            .ok()
            .flatten();
            if snapshot.is_some() {
                return Ok(());
            }
        }
    }
}

fn read_outcome(
    answer: Result<(), ReadFailure>,
    snapshot: Option<CodexSnapshot>,
    context: &mut Option<ReaderContext>,
) -> ReadOutcome {
    match (answer, snapshot) {
        (Ok(()), Some(snapshot)) => ReadOutcome::Snapshot(snapshot),
        (Err(_), Some(snapshot)) => {
            // A full quota result remains useful for display even when another
            // read fails. No incomplete RPC exchange grants route admission.
            if let Some(context) = context {
                context.route = RouteObservation::unknown("route_metadata_unavailable");
                let bytes = format!("{}\0route_metadata_unavailable", context.context_id);
                context.context_id = hex::encode(
                    ring::digest::digest(&ring::digest::SHA256, bytes.as_bytes()).as_ref(),
                );
            }
            ReadOutcome::Snapshot(snapshot)
        }
        (Err(reason), None) => ReadOutcome::Failure(reason),
        (Ok(()), None) => ReadOutcome::Failure(ReadFailure::InvalidResponse),
    }
}

pub async fn read_codex_in_context(
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
    home: Option<&Path>,
) -> CodexObservation {
    let started_at_ms = crate::status::now_millis();
    let started_elapsed_ms = crate::event_log::monotonic_millis();
    let mut child = None;
    let mut slot = None;
    let mut context = None;
    let mut snapshot = None;
    let requested = ReadContext {
        command,
        cwd,
        home,
        environment: RouteEnvironment::current(),
    };
    let answer = tokio::time::timeout(READ_BOUND, async {
        normalized_context_path(cwd)?;
        if let Some(home) = home {
            normalized_context_path(home)?;
        }
        slot = Some(READERS.acquire().await.map_err(|_| ReadFailure::Io)?);
        let mut process = Command::new(&command.0);
        process
            .args(&command.1)
            .arg("app-server")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(home) = home {
            process.env("CODEX_HOME", home);
        }
        #[cfg(windows)]
        process.creation_flags(0x08000000);
        child = Some(process.spawn().map_err(|_| ReadFailure::Io)?);
        rpc(
            child.as_mut().ok_or(ReadFailure::Io)?,
            &requested,
            &mut context,
            &mut snapshot,
        )
        .await
    })
    .await
    .unwrap_or(Err(ReadFailure::Timeout));
    let mut outcome = read_outcome(answer, snapshot, &mut context);
    if let Some(mut child) = child {
        let _ = child.start_kill();
        if !matches!(
            tokio::time::timeout(CLEANUP_BOUND, child.wait()).await,
            Ok(Ok(_))
        ) {
            outcome = ReadOutcome::Failure(ReadFailure::CleanupUnconfirmed);
            // Keep sole-reader capacity until the exact child is reaped. No
            // retry or fresh numeric process signal is issued by this observer.
            tokio::spawn(async move {
                loop {
                    if child.wait().await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                drop(slot);
            });
        }
    }
    CodexObservation {
        started_at_ms,
        finished_at_ms: crate::status::now_millis(),
        started_elapsed_ms,
        finished_elapsed_ms: crate::event_log::monotonic_millis(),
        context,
        outcome,
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
