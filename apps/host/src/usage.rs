//! Read-only subscription limits. Never read CLI credential stores or use model APIs.
use crate::launchers::{Launchers, Program};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

#[path = "usage_codex.rs"]
mod codex;
#[cfg(test)]
pub use codex::{BucketCompleteness, BucketSource, CodexSnapshot, ReadFailure};
pub use codex::{
    CodexObservation, ReadOutcome, ReaderContext, WindowState, read_codex_observation,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percent: u8,
    pub duration_mins: u32,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderLimit {
    pub id: Program,
    pub status: &'static str,
    pub windows: Vec<LimitWindow>,
}

pub fn installed(launchers: &Launchers) -> Vec<ProviderLimit> {
    [Program::Claude, Program::Gemini, Program::Codex]
        .into_iter()
        .filter(|program| launchers.available(*program))
        .map(|id| ProviderLimit {
            id,
            status: if id == Program::Codex {
                "checking"
            } else {
                "unavailable"
            },
            windows: Vec::new(),
        })
        .collect()
}

#[cfg(test)]
pub fn parse_codex_limits(response: &Value) -> Option<Vec<LimitWindow>> {
    let result = response.get("result")?;
    let limits = result
        .get("rateLimitsByLimitId")
        .and_then(|limits| limits.get("codex"))
        .or_else(|| result.get("rateLimits"))?;
    let windows = ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| limits.get(key))
        .filter_map(|window| {
            let used_percent = u8::try_from(window.get("usedPercent")?.as_u64()?).ok()?;
            let duration_mins = u32::try_from(window.get("windowDurationMins")?.as_u64()?).ok()?;
            if used_percent > 100 || duration_mins == 0 {
                return None;
            }
            Some(LimitWindow {
                used_percent,
                duration_mins,
                resets_at: window.get("resetsAt").and_then(Value::as_i64),
            })
        })
        .collect::<Vec<_>>();
    (!windows.is_empty()).then_some(windows)
}

/// Local status-line cache contains quota windows only, never credentials.
pub fn parse_claude_limits(value: &Value, now: i64) -> Vec<LimitWindow> {
    let Some(at) = value["at"].as_i64() else {
        return vec![];
    };
    if at > now + 60 || now.saturating_sub(at) > 900 {
        return vec![];
    }
    [("five_hour", 300), ("seven_day", 10080)]
        .into_iter()
        .filter_map(|(key, duration_mins)| {
            let window = &value["rate_limits"][key];
            let used = window["used_percentage"].as_f64()?;
            let reset = window["resets_at"].as_i64()?;
            if !used.is_finite() || !(0.0..=100.0).contains(&used) || reset <= now {
                return None;
            }
            Some(LimitWindow {
                used_percent: used.ceil() as u8,
                duration_mins,
                resets_at: Some(reset),
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeObservation {
    pub source_at_ms: Option<u64>,
    pub observed_at_ms: u64,
    pub windows: Vec<LimitWindow>,
    pub reason: &'static str,
}

pub(crate) fn parse_claude_observation(value: &Value, observed_at_ms: u64) -> ClaudeObservation {
    let at = value["at"].as_i64().and_then(|at| u64::try_from(at).ok());
    let source_at_ms = at.and_then(|at| at.checked_mul(1000));
    let now = i64::try_from(observed_at_ms / 1000).unwrap_or(i64::MAX);
    let mut windows = parse_claude_limits(value, now);
    let reason = match at {
        None => "invalid_cache",
        Some(at) if source_at_ms.is_none() || at > (observed_at_ms / 1000).saturating_add(60) => {
            "future_cache"
        }
        Some(at) if (observed_at_ms / 1000).saturating_sub(at) > 900 => "stale_cache",
        Some(_) if windows.is_empty() => "windows_unavailable",
        Some(_) if windows.len() < 2 => "partial_snapshot",
        Some(_) => "observed",
    };
    if matches!(reason, "invalid_cache" | "future_cache" | "stale_cache") {
        windows.clear();
    }
    ClaudeObservation {
        source_at_ms,
        observed_at_ms,
        windows,
        reason,
    }
}

pub(crate) async fn read_claude_observation() -> ClaudeObservation {
    let observed_at_ms = crate::status::now_millis();
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|p| PathBuf::from(p).join(".claude"))
        });
    let Some(dir) = dir else {
        return unavailable_claude_observation(observed_at_ms, "context_unavailable");
    };
    read_claude_cache(&dir.join(".rate-limits.json"), observed_at_ms).await
}

const CLAUDE_CACHE_MAX_BYTES: u64 = 16_384;
const CLAUDE_CACHE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeCacheFailure {
    Unavailable,
    NonRegular,
    Oversized,
    Invalid,
    Timeout,
}

impl ClaudeCacheFailure {
    fn reason(self) -> &'static str {
        match self {
            Self::Unavailable => "cache_unavailable",
            Self::NonRegular => "cache_non_regular",
            Self::Oversized => "cache_oversized",
            Self::Invalid => "invalid_cache",
            Self::Timeout => "cache_timeout",
        }
    }
}

fn unavailable_claude_observation(observed_at_ms: u64, reason: &'static str) -> ClaudeObservation {
    ClaudeObservation {
        source_at_ms: None,
        observed_at_ms,
        windows: Vec::new(),
        reason,
    }
}

async fn read_claude_cache(path: &Path, observed_at_ms: u64) -> ClaudeObservation {
    observe_claude_cache(
        observed_at_ms,
        load_claude_cache(path),
        CLAUDE_CACHE_TIMEOUT,
    )
    .await
}

async fn observe_claude_cache(
    observed_at_ms: u64,
    read: impl std::future::Future<Output = Result<Value, ClaudeCacheFailure>>,
    deadline: Duration,
) -> ClaudeObservation {
    let result = tokio::time::timeout(deadline, read)
        .await
        .unwrap_or(Err(ClaudeCacheFailure::Timeout));
    match result {
        Ok(value) => parse_claude_observation(&value, observed_at_ms),
        Err(failure) => unavailable_claude_observation(observed_at_ms, failure.reason()),
    }
}

fn check_claude_cache_metadata(metadata: &std::fs::Metadata) -> Result<(), ClaudeCacheFailure> {
    if !metadata.is_file() {
        return Err(ClaudeCacheFailure::NonRegular);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(ClaudeCacheFailure::NonRegular);
        }
    }
    if metadata.len() > CLAUDE_CACHE_MAX_BYTES {
        return Err(ClaudeCacheFailure::Oversized);
    }
    Ok(())
}

async fn open_claude_cache(path: &Path) -> Result<tokio::fs::File, ClaudeCacheFailure> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    // A path can change after its preliminary metadata check. Never block opening a
    // replacement FIFO or follow a replacement final symlink on Unix.
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(path)
        .await
        .map_err(|_| ClaudeCacheFailure::Unavailable)?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};
        // SAFETY: the live File owns this valid handle for the duration of the query.
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
            return Err(ClaudeCacheFailure::NonRegular);
        }
    }
    let metadata = file
        .metadata()
        .await
        .map_err(|_| ClaudeCacheFailure::Unavailable)?;
    check_claude_cache_metadata(&metadata)?;
    Ok(file)
}

async fn load_claude_cache(path: &Path) -> Result<Value, ClaudeCacheFailure> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ClaudeCacheFailure::Unavailable)?;
    check_claude_cache_metadata(&metadata)?;
    read_claude_cache_bytes(open_claude_cache(path).await?).await
}

async fn read_claude_cache_bytes(
    reader: impl AsyncRead + Unpin,
) -> Result<Value, ClaudeCacheFailure> {
    let mut bytes = Vec::new();
    reader
        .take(CLAUDE_CACHE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ClaudeCacheFailure::Unavailable)?;
    if bytes.len() as u64 > CLAUDE_CACHE_MAX_BYTES {
        return Err(ClaudeCacheFailure::Oversized);
    }
    serde_json::from_slice(&bytes).map_err(|_| ClaudeCacheFailure::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_cache_rejects_stale_missing_and_invalid_windows() {
        let mut cache = json!({"at":1000,"rate_limits":{"five_hour":{"used_percentage":88.2,"resets_at":4000}}});
        assert_eq!(parse_claude_limits(&cache, 1100)[0].used_percent, 89);
        assert!(parse_claude_limits(&cache, 2000).is_empty());
        cache["rate_limits"]["five_hour"]["used_percentage"] = json!(1792192800);
        assert!(parse_claude_limits(&cache, 1100).is_empty());
        assert!(parse_claude_limits(&json!({}), 1100).is_empty());
    }

    #[test]
    fn legacy_display_selects_codex_bucket_without_claiming_account_identity() {
        let response = json!({"result":{"rateLimitsByLimitId":{
            "codex":{"primary":{"usedPercent":81,"windowDurationMins":300,"resetsAt":100},
                     "secondary":{"usedPercent":47,"windowDurationMins":10080,"resetsAt":200}},
            "other":{"primary":{"usedPercent":2,"windowDurationMins":60}}
        }}});
        let windows = parse_codex_limits(&response).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].used_percent, 81);
        assert_eq!(windows[1].duration_mins, 10080);
    }

    #[test]
    fn missing_or_invalid_limits_are_not_shown() {
        assert!(parse_codex_limits(&json!({"error":{"message":"not signed in"}})).is_none());
        assert!(parse_codex_limits(&json!({"result":{"rateLimits":{"primary":{"usedPercent":101,"windowDurationMins":300}}}})).is_none());
    }
}
