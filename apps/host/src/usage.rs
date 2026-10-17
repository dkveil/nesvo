//! Read-only subscription limits. Never read CLI credential stores or use model APIs.
use crate::launchers::{Launchers, Program};
use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};
use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
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

pub async fn read_codex_limits(command: &(PathBuf, Vec<OsString>)) -> Result<Vec<LimitWindow>> {
    let mut child = Command::new(&command.0)
        .args(&command.1)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().ok_or_else(|| anyhow!("No CLI stdin"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("No CLI stdout"))?;
    let mut lines = BufReader::new(output).lines();
    let result = timeout(Duration::from_secs(8), async {
        input
            .write_all(
                format!(
                    "{}\n",
                    json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"nesvo","version":"0.1.0"},"capabilities":{}}})
                )
                .as_bytes(),
            )
            .await?;
        loop {
            let line = lines.next_line().await?.ok_or_else(|| anyhow!("CLI exited"))?;
            let response: Value = serde_json::from_str(&line)?;
            if response["id"] == 1 {
                if response.get("error").is_some() {
                    return Err(anyhow!("CLI initialization failed"));
                }
                break;
            }
        }
        input
            .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n")
            .await?;
        loop {
            let line = lines.next_line().await?.ok_or_else(|| anyhow!("CLI exited"))?;
            let response: Value = serde_json::from_str(&line)?;
            if response["id"] == 2 {
                return parse_codex_limits(&response)
                    .ok_or_else(|| anyhow!("No Codex subscription limits available"));
            }
        }
    })
    .await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result.map_err(|_| anyhow!("CLI limit read timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_codex_windows_and_ignores_other_accounts() {
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
