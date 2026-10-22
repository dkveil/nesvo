use crate::{
    command_scope,
    job_prechecks::{self, Command, Outcome, OutcomeState},
};
use std::{
    io::{BufRead, Read, Write},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
pub const FLAG: &str = "--precheck-exec";
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stop {
    OwnerCancel,
    GuardUnavailable,
    HostShutdown,
}

pub fn scopes_settled() -> bool {
    SLOTS.available_permits() == 2
}

fn stop_now(stop: &mut tokio::sync::watch::Receiver<Option<Stop>>) -> Option<Stop> {
    let requested = *stop.borrow_and_update();
    requested.or_else(|| {
        stop.has_changed()
            .is_err()
            .then_some(Stop::GuardUnavailable)
    })
}

async fn stopping(stop: &mut tokio::sync::watch::Receiver<Option<Stop>>) -> Stop {
    loop {
        if let Some(reason) = stop_now(stop) {
            return reason;
        }
        if stop.changed().await.is_err() {
            return Stop::GuardUnavailable;
        }
    }
}

fn stopped(reason: Stop, input_released: bool) -> Outcome {
    let (state, reason) = match (reason, input_released) {
        (Stop::OwnerCancel, _) => (OutcomeState::Refused, "owner_canceled"),
        (Stop::HostShutdown, _) => (OutcomeState::Refused, "host_shutdown"),
        (Stop::GuardUnavailable, false) => (OutcomeState::Refused, "guard_unavailable"),
        (Stop::GuardUnavailable, true) => (OutcomeState::Unknown, "guard_unavailable"),
    };
    let mut outcome = Outcome::failed(state, reason);
    if input_released {
        outcome.command_started = None;
        outcome.cleanup_confirmed = false;
    }
    outcome
}

fn text(bytes: Vec<u8>) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = bytes.len() > 512;
    for c in String::from_utf8_lossy(&bytes)
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
    {
        if out.len() + c.len_utf8() > 512 {
            truncated = true;
            break;
        }
        out.push(c);
    }
    (out, truncated)
}
fn helper(spec: Command) -> Outcome {
    if job_prechecks::digest(&spec).is_err() {
        return Outcome::failed(OutcomeState::Refused, "invalid_command");
    }
    let started = Instant::now();
    let mut command = std::process::Command::new(&spec.executable);
    command
        .args(&spec.arguments)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let Ok(root) = command_scope::system_root() else {
            return Outcome::failed(OutcomeState::Refused, "platform_environment_unavailable");
        };
        command.env("SystemRoot", root);
    }
    let Ok(mut child) = command.spawn() else {
        return Outcome::failed(OutcomeState::Refused, "command_unavailable");
    };
    let (send, receive) = std::sync::mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        let send = send.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout.take(4097).read_to_end(&mut bytes).is_ok();
            let _ = send.send((true, result, bytes));
        });
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stderr.take(4097).read_to_end(&mut bytes).is_ok();
            let _ = send.send((false, result, bytes));
        });
    }
    let mut stdout = None;
    let mut stderr = None;
    let mut status = None;
    let (state, reason) = loop {
        let mut bad = false;
        let mut oversized = false;
        while let Ok((is_stdout, ok, bytes)) = receive.try_recv() {
            bad |= !ok;
            oversized |= bytes.len() > 4096;
            if is_stdout {
                stdout = Some(text(bytes));
            } else {
                stderr = Some(text(bytes));
            }
        }
        if bad {
            break (OutcomeState::Unknown, "capture_unconfirmed");
        }
        if oversized {
            break (OutcomeState::OutputLimit, "output_limit");
        }
        if started.elapsed() >= Duration::from_millis(spec.timeout_ms) {
            break (OutcomeState::TimedOut, "deadline");
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => break (OutcomeState::Unknown, "exit_unconfirmed"),
            }
        }
        if let Some(exit) = status
            .as_ref()
            .filter(|_| stdout.is_some() && stderr.is_some())
        {
            let code = exit.code();
            break if code.is_some_and(|c| spec.pass_exit_codes.contains(&c)) {
                (OutcomeState::Passed, "exit_pass")
            } else if code.is_some_and(|c| spec.skip_exit_codes.contains(&c)) {
                (OutcomeState::Skipped, "exit_skip")
            } else {
                (OutcomeState::Failed, "exit_failed")
            };
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let (stdout, stdout_truncated) = stdout.unwrap_or_default();
    let (stderr, stderr_truncated) = stderr.unwrap_or_default();
    Outcome {
        state,
        reason: reason.into(),
        exit_code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        cleanup_confirmed: false,
        command_started: Some(true),
    }
}

pub fn stdio() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: both calls only query ids; the check proves this helper leads its own group.
        anyhow::ensure!(
            unsafe { libc::getpgrp() == libc::getpid() },
            "Precheck helper needs its own process group"
        );
    }
    let mut input = std::io::BufReader::new(std::io::stdin().take(16 * 1024 + 2));
    let mut line = Vec::new();
    input.read_until(b'\n', &mut line)?;
    anyhow::ensure!(
        line.len() <= 16 * 1024 + 1 && line.last() == Some(&b'\n'),
        "Invalid precheck input frame"
    );
    let spec: Command = serde_json::from_slice(&line)?;
    #[cfg(unix)]
    std::thread::spawn(move || {
        let mut byte = [0];
        let _ = input.read(&mut byte);
        // SAFETY: leadership was checked up front, so kill(0) reaches only this helper's group.
        unsafe { libc::kill(0, libc::SIGKILL) };
    });
    let result = helper(spec);
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &result)?;
    output.write_all(b"\n")?;
    output.flush()?;
    loop {
        std::thread::park_timeout(Duration::from_secs(60));
    }
}

struct Contained {
    child: tokio::process::Child,
    scope: Option<command_scope::Scope>,
    observed_scope: Option<command_scope::Scope>,
}
impl Contained {
    fn retire_termination(&mut self) {
        if let Some(scope) = self.scope.take() {
            self.observed_scope = Some(scope);
        }
    }
    fn empty(&self) -> anyhow::Result<bool> {
        self.observed_scope
            .as_ref()
            .ok_or_else(|| {
                anyhow::anyhow!("Scope observation requires retired termination ownership")
            })?
            .empty()
    }
}
impl Drop for Contained {
    fn drop(&mut self) {
        if let Some(scope) = &self.scope {
            let _ = scope.terminate();
        }
    }
}
pub async fn run(spec: Command, mut stop: tokio::sync::watch::Receiver<Option<Stop>>) -> Outcome {
    if let Some(reason) = stop_now(&mut stop) {
        return stopped(reason, false);
    }
    let slot = tokio::select! {
        reason = stopping(&mut stop) => return stopped(reason, false),
        acquired = tokio::time::timeout(Duration::from_secs(15), SLOTS.acquire()) => {
            match acquired {
                Ok(Ok(slot)) => slot,
                _ => return Outcome::failed(OutcomeState::Refused, "precheck_busy"),
            }
        }
    };
    let Ok(exe) = std::env::current_exe() else {
        return Outcome::failed(OutcomeState::Refused, "helper_unavailable");
    };
    let Ok(mut input) = serde_json::to_vec(&spec) else {
        return Outcome::failed(OutcomeState::Refused, "invalid_command");
    };
    if input.len() > 16 * 1024 {
        return Outcome::failed(OutcomeState::Refused, "invalid_command");
    }
    input.push(b'\n');
    let deadline = Duration::from_millis(spec.timeout_ms + 1000);
    let mut command = tokio::process::Command::new(exe);
    command
        .arg(FLAG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command_scope::configure(&mut command);
    let Ok(child) = command.spawn() else {
        return Outcome::failed(OutcomeState::Refused, "helper_unavailable");
    };
    let mut owned = Contained {
        child,
        scope: None,
        observed_scope: None,
    };
    let Ok(scope) = command_scope::Scope::enroll(&owned.child) else {
        let _ = owned.child.kill().await;
        return Outcome::failed(OutcomeState::Refused, "containment_unavailable");
    };
    owned.scope = Some(scope);
    let mut input_released = false;
    let mut outcome = if let Some(reason) = stop_now(&mut stop) {
        stopped(reason, false)
    } else {
        tokio::select! {
            reason = stopping(&mut stop) => stopped(reason, input_released),
            result = tokio::time::timeout(deadline, async {
                let stdin = owned.child.stdin.as_mut().ok_or(())?;
                input_released = true;
                stdin.write_all(&input).await.map_err(|_| ())?;
                stdin.flush().await.map_err(|_| ())?;
                let stdout = owned.child.stdout.take().ok_or(())?;
                let mut output = Vec::new();
                tokio::io::BufReader::new(stdout.take(8193))
                    .read_until(b'\n', &mut output)
                    .await
                    .map_err(|_| ())?;
                if output.len() > 8192 || output.last() != Some(&b'\n') {
                    return Err(());
                }
                serde_json::from_slice::<Outcome>(&output).map_err(|_| ())
            }) => match result {
                Ok(Ok(result)) => result,
                _ => Outcome::failed(OutcomeState::Unknown, "helper_result_unconfirmed"),
            },
        }
    };
    let killed = owned
        .scope
        .as_ref()
        .is_some_and(|scope| scope.terminate().is_ok());
    let cleanup = tokio::time::timeout(Duration::from_secs(2), async {
        let result = owned.child.wait().await;
        owned.retire_termination();
        result.map_err(|_| ())?;
        while !owned.empty().map_err(|_| ())? {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, ()>(())
    })
    .await;
    outcome.cleanup_confirmed = killed && matches!(cleanup, Ok(Ok(())));
    if !outcome.cleanup_confirmed {
        outcome.state = OutcomeState::Unknown;
        outcome.reason = "cleanup_unconfirmed".into();
        tokio::spawn(async move {
            let _ = owned.child.wait().await;
            owned.retire_termination();
            while !matches!(owned.empty(), Ok(true)) {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let _ = owned.observed_scope.take();
            drop(slot);
        });
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preexisting_stop_is_observed_without_waiting_for_another_update() {
        let (_send, mut receive) = tokio::sync::watch::channel(Some(Stop::OwnerCancel));
        assert_eq!(stopping(&mut receive).await, Stop::OwnerCancel);
    }

    #[tokio::test]
    async fn a_closed_guard_is_observed_as_unavailable() {
        let (send, mut receive) = tokio::sync::watch::channel(None);
        drop(send);
        assert_eq!(stopping(&mut receive).await, Stop::GuardUnavailable);
    }

    #[tokio::test]
    async fn a_stop_update_wakes_an_existing_waiter() {
        let (send, mut receive) = tokio::sync::watch::channel(None);
        let (reason, ()) = tokio::join!(stopping(&mut receive), async {
            tokio::task::yield_now().await;
            send.send(Some(Stop::OwnerCancel)).unwrap();
        });
        assert_eq!(reason, Stop::OwnerCancel);
    }

    #[test]
    fn cancellation_does_not_invent_execution_or_cleanup_evidence() {
        let before = stopped(Stop::OwnerCancel, false);
        assert_eq!(before.state, OutcomeState::Refused);
        assert_eq!(before.reason, "owner_canceled");
        assert_eq!(before.command_started, Some(false));
        assert!(before.cleanup_confirmed);
        let after = stopped(Stop::OwnerCancel, true);
        assert_eq!(after.state, OutcomeState::Refused);
        assert_eq!(after.reason, "owner_canceled");
        assert!(after.command_started.is_none());
        assert!(after.exit_code.is_none());
        assert!(!after.cleanup_confirmed);
        let guard = stopped(Stop::GuardUnavailable, true);
        assert_eq!(guard.state, OutcomeState::Unknown);
        assert_eq!(guard.reason, "guard_unavailable");
        assert!(guard.command_started.is_none());
        assert!(!guard.cleanup_confirmed);
    }

    #[test]
    fn host_shutdown_keeps_command_and_cleanup_uncertainty_after_frame_release() {
        let before = stopped(Stop::HostShutdown, false);
        assert_eq!(before.state, OutcomeState::Refused);
        assert_eq!(before.reason, "host_shutdown");
        assert_eq!(before.command_started, Some(false));
        assert!(before.cleanup_confirmed);
        let after = stopped(Stop::HostShutdown, true);
        assert_eq!(after.state, OutcomeState::Refused);
        assert_eq!(after.reason, "host_shutdown");
        assert!(after.command_started.is_none());
        assert!(after.exit_code.is_none());
        assert!(!after.cleanup_confirmed);
    }
}
