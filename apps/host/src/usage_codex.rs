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
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
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
    let complete = selected.completeness.primary == WindowState::Complete
        && selected.completeness.secondary == WindowState::Complete;
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

fn reader_context(
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
    initialized: &Value,
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
    let executable = command.0.to_str().ok_or(ReadFailure::ContextUnavailable)?;
    let cwd = cwd.to_str().ok_or(ReadFailure::ContextUnavailable)?;
    let args = command
        .1
        .iter()
        .map(|s| s.to_str().ok_or(ReadFailure::ContextUnavailable))
        .collect::<Result<Vec<_>, _>>()?;
    let encoded = serde_json::to_vec(&(executable, args, cwd, home))
        .map_err(|_| ReadFailure::ContextUnavailable)?;
    let context_id = hex::encode(ring::digest::digest(&ring::digest::SHA256, &encoded).as_ref());
    Ok(Some(ReaderContext {
        codex_home: home.clone(),
        context_id,
    }))
}

async fn rpc(
    child: &mut Child,
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
    context: &mut Option<ReaderContext>,
) -> Result<CodexSnapshot, ReadFailure> {
    let mut input = child.stdin.take().ok_or(ReadFailure::Io)?;
    let mut output = Frames::new(child.stdout.take().ok_or(ReadFailure::Io)?);
    let initialize = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"nesvo","version":"0.1.0"},"capabilities":{}}});
    input
        .write_all(format!("{initialize}\n").as_bytes())
        .await
        .map_err(|_| ReadFailure::Io)?;
    input.flush().await.map_err(|_| ReadFailure::Io)?;
    let initialized = output.response(1).await?;
    *context = reader_context(command, cwd, &initialized)?;
    input.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n").await.map_err(|_| ReadFailure::Io)?;
    input.flush().await.map_err(|_| ReadFailure::Io)?;
    parse_snapshot(&output.response(2).await?)
}

pub async fn read_codex_observation(
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
) -> CodexObservation {
    let started_at_ms = crate::status::now_millis();
    let started_elapsed_ms = crate::event_log::monotonic_millis();
    let mut child = None;
    let mut slot = None;
    let mut context = None;
    let answer = tokio::time::timeout(READ_BOUND, async {
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
        #[cfg(windows)]
        process.creation_flags(0x08000000);
        child = Some(process.spawn().map_err(|_| ReadFailure::Io)?);
        rpc(
            child.as_mut().ok_or(ReadFailure::Io)?,
            command,
            cwd,
            &mut context,
        )
        .await
    })
    .await
    .unwrap_or(Err(ReadFailure::Timeout));
    let mut outcome = match answer {
        Ok(snapshot) => ReadOutcome::Snapshot(snapshot),
        Err(reason) => ReadOutcome::Failure(reason),
    };
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
