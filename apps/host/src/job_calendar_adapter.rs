use crate::job_calendar::{self, Answer, Failure, Query, Schedule};
use std::io::{Read, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const FLAG: &str = "--calendar-eval";
const MAX_INPUT: u64 = 4096;
const MAX_OUTPUT: u64 = 2048;
const DEADLINE: std::time::Duration = std::time::Duration::from_millis(750);
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub fn stdio() -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)?;
    let answer: Answer = if bytes.len() as u64 > MAX_INPUT {
        Err(Failure::new(
            "invalid_calendar",
            "Calendar input is too large",
        ))
    } else {
        serde_json::from_slice::<Query>(&bytes)
            .map_err(|_| Failure::new("invalid_calendar", "Invalid calendar query"))
            .and_then(job_calendar::evaluate)
    };
    std::io::stdout().write_all(&serde_json::to_vec(&answer)?)?;
    Ok(())
}

pub async fn next(schedule: Schedule, after: u64) -> Answer {
    if matches!(schedule, Schedule::Once { .. } | Schedule::External) {
        return job_calendar::evaluate(Query { schedule, after });
    }
    let _slot = SLOTS.try_acquire().map_err(|_| {
        Failure::new(
            "calendar_busy",
            "Calendar capacity is occupied; no work was accepted",
        )
    })?;
    evaluate_child(schedule, after).await
}
async fn evaluate_child(schedule: Schedule, after: u64) -> Answer {
    let input = serde_json::to_vec(&Query { schedule, after })
        .map_err(|_| Failure::new("invalid_calendar", "Invalid calendar query"))?;
    if input.len() as u64 > MAX_INPUT {
        return Err(Failure::new(
            "invalid_calendar",
            "Calendar input is too large",
        ));
    }
    let executable = std::env::current_exe()
        .map_err(|_| Failure::new("calendar_unavailable", "Calendar executable is unavailable"))?;
    let mut command = tokio::process::Command::new(executable);
    command
        .arg(FLAG)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| {
        Failure::new(
            "calendar_unavailable",
            "Cannot start isolated calendar evaluation",
        )
    })?;
    let result = tokio::time::timeout(DEADLINE, async {
        let mut stdin = child.stdin.take().ok_or(())?;
        stdin.write_all(&input).await.map_err(|_| ())?;
        stdin.shutdown().await.map_err(|_| ())?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or(())?;
        let mut output = Vec::new();
        stdout
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| ())?;
        if output.len() as u64 > MAX_OUTPUT {
            return Err(());
        }
        let status = child.wait().await.map_err(|_| ())?;
        if !status.success() {
            return Err(());
        }
        serde_json::from_slice::<Answer>(&output).map_err(|_| ())
    })
    .await;
    match result {
        Ok(Ok(answer)) => answer,
        failed => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(Failure::new(
                if failed.is_err() {
                    "calendar_timeout"
                } else {
                    "calendar_unavailable"
                },
                "Isolated calendar evaluation failed within its time/output bounds",
            ))
        }
    }
}
