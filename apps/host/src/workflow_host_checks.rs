use crate::{
    api_error::Error,
    event_log::Service,
    orchestration::{Actor, Request},
    process::display_path,
    status::now_millis,
    workflow_templates,
    worktrees::{self, Log, Outcome},
};
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(crate) const TAIL_BYTES: usize = 512;
const LOG_FILE: &str = "checks.log";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckRun {
    pub(crate) index: usize,
    pub(crate) command: String,
    pub(crate) outcome: &'static str,
    pub(crate) exit_code: Option<i32>,
    pub(crate) duration_ms: u64,
    pub(crate) tail: String,
    pub(crate) tail_truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostChecks {
    pub(crate) source: &'static str,
    pub(crate) attempt_id: String,
    pub(crate) session_id: String,
    pub(crate) task_key: String,
    pub(crate) template: String,
    pub(crate) digest: String,
    pub(crate) worktree: String,
    pub(crate) log: String,
    pub(crate) passed: bool,
    pub(crate) started_at: u64,
    pub(crate) finished_at: u64,
    pub(crate) checks: Vec<CheckRun>,
}

pub(crate) struct Bounds {
    pub(crate) limit: Duration,
    pub(crate) tail: usize,
}

struct Target {
    worktree: PathBuf,
    template: String,
    digest: String,
    commands: Vec<String>,
    limit: Duration,
}

fn refused(code: &'static str, message: &'static str) -> anyhow::Error {
    Error::new(code, message).into()
}

fn error_code(error: &anyhow::Error) -> Option<&'static str> {
    error.downcast_ref::<Error>().map(|error| error.code)
}

fn printable(bytes: &[u8], limit: usize) -> (String, bool) {
    let text: String = String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| *c != '\r')
        .map(|c| {
            if c.is_control() && !matches!(c, '\n' | '\t') {
                '?'
            } else {
                c
            }
        })
        .collect();
    let mut start = text.len().saturating_sub(limit);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_owned(), start > 0)
}

pub(crate) async fn run_checks(
    commands: &[String],
    worktree: &Path,
    bounds: Bounds,
    mut cancel: watch::Receiver<bool>,
) -> Result<(Vec<CheckRun>, String)> {
    let directory = worktrees::state_dir(worktree).await.map_err(|_| {
        refused(
            "host_checks_unavailable",
            "The worktree state folder for host checks is unavailable",
        )
    })?;
    let path = directory.join(LOG_FILE);
    let mut log = Log::tailed(&path, bounds.tail).await.map_err(|_| {
        refused(
            "host_checks_unavailable",
            "The host check log could not be created",
        )
    })?;
    let deadline = Instant::now() + bounds.limit;
    let (slot, mut waited) = tokio::select! {
        biased;
        _ = worktrees::cancelled(&mut cancel) => (None, Some(Outcome::Cancelled)),
        _ = tokio::time::sleep_until(deadline.into()) => (None, Some(Outcome::TimedOut)),
        slot = worktrees::SLOTS.acquire() => match slot {
            Ok(slot) => (Some(slot), None),
            Err(_) => (None, Some(Outcome::Failed)),
        },
    };
    if slot.is_none() {
        log.line("no check slot became available").await;
    }
    let mut runs = Vec::with_capacity(commands.len());
    let mut halted = false;
    for (index, command) in commands.iter().enumerate() {
        if halted {
            runs.push(skipped(index, command));
            continue;
        }
        let (outcome, exit_code, duration_ms) = match waited.take() {
            Some(outcome) => (outcome, None, 0),
            None => {
                log.line(&format!("$ {command}")).await;
                let started = Instant::now();
                let (outcome, code) =
                    worktrees::step_status(command, worktree, deadline, &mut cancel, &mut log)
                        .await;
                (
                    outcome,
                    code,
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                )
            }
        };
        let (bytes, cut) = log.take_tail();
        let (tail, shortened) = printable(&bytes, bounds.tail);
        runs.push(CheckRun {
            index,
            command: command.clone(),
            outcome: outcome.name(),
            exit_code,
            duration_ms,
            tail,
            tail_truncated: cut || shortened,
        });
        halted = slot.is_none() || matches!(outcome, Outcome::TimedOut | Outcome::Cancelled);
    }
    log.finish().await;
    drop(slot);
    Ok((runs, display_path(&path)))
}

fn skipped(index: usize, command: &str) -> CheckRun {
    CheckRun {
        index,
        command: command.into(),
        outcome: "skipped",
        exit_code: None,
        duration_ms: 0,
        tail: String::new(),
        tail_truncated: false,
    }
}

fn target(
    worktrees: &worktrees::Store,
    templates: &workflow_templates::Store,
    run_id: &str,
    session_id: &str,
    task_key: &str,
) -> Result<Target> {
    let record = worktrees.find(session_id).ok_or_else(|| {
        refused(
            "host_checks_unavailable",
            "Host checks run only in the host-created worktree of the attempt's worker",
        )
    })?;
    if !matches!(record.setup.state.as_str(), "passed" | "notConfigured") {
        return Err(refused(
            "worktree_not_prepared",
            "Host checks run only after a passed worktree setup",
        ));
    }
    let setup_approved = match (&record.digest, &record.config) {
        (None, None) => true,
        (Some(digest), Some(config)) => {
            config.digest() == *digest && worktrees.approved(&record.repository, digest)
        }
        _ => false,
    };
    if !setup_approved {
        return Err(refused(
            "worktree_setup_unapproved",
            "The nesvo.toml setup digest recorded for this worktree is not approved",
        ));
    }
    let binding = templates
        .binding(run_id)
        .filter(|binding| binding.repository == record.repository)
        .ok_or_else(|| {
            refused(
                "host_checks_unavailable",
                "The run was not started from a template of this worktree's repository that declares checks",
            )
        })?;
    if !templates.approved(&binding.repository, &binding.digest) {
        return Err(refused(
            "workflow_templates_unapproved",
            "The workflow template digest this run was started from is not approved",
        ));
    }
    let commands = binding.commands(task_key).to_vec();
    if commands.is_empty() {
        return Err(refused(
            "host_checks_missing",
            "The template task of this attempt declares no checks",
        ));
    }
    Ok(Target {
        worktree: PathBuf::from(&record.worktree),
        template: binding.template,
        digest: binding.digest,
        commands,
        limit: Duration::from_secs(
            record
                .config
                .as_ref()
                .map_or(worktrees::DEFAULT_TIMEOUT_S, |config| config.timeout_s),
        ),
    })
}

pub(crate) async fn validate(log: Service, actor: Actor, request: Request) -> Result<Value> {
    let (Some(worktrees), Some(templates)) = (worktrees::store(), workflow_templates::store())
    else {
        return Err(refused(
            "unsupported",
            "The host worktree or workflow template registry is unavailable",
        ));
    };
    validate_with(&log, actor, request, worktrees, templates, TAIL_BYTES).await
}

pub(crate) async fn validate_with(
    log: &Service,
    actor: Actor,
    mut request: Request,
    worktrees: &worktrees::Store,
    templates: &workflow_templates::Store,
    tail: usize,
) -> Result<Value> {
    let Request::Validate {
        key,
        run_id,
        attempt_id,
        expected_revision,
        validation,
        ..
    } = &request
    else {
        return Err(refused(
            "invalid_argument",
            "Host checks apply only to result validation",
        ));
    };
    crate::workflow_attempts::validation_bounds(validation, true)?;
    let (key, run_id, attempt_id, expected_revision) = (
        key.clone(),
        run_id.clone(),
        attempt_id.clone(),
        *expected_revision,
    );
    match log
        .workflow(actor.clone(), Request::Mutation { key: key.clone() })
        .await
    {
        Ok(_) => return log.workflow(actor, request).await,
        Err(error) if error_code(&error) == Some("mutation_not_found") => {}
        Err(error) => return Err(error),
    }
    let view = log
        .workflow(
            actor.clone(),
            Request::Get {
                run_id: run_id.clone(),
            },
        )
        .await?;
    let task = view["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["currentAttempt"]["id"] == attempt_id.as_str())
        .filter(|task| {
            task["currentAttempt"]["state"] == "reported"
                && view["run"]["revision"].as_u64() == Some(expected_revision)
                && matches!(view["run"]["state"].as_str(), Some("active" | "draining"))
        });
    let Some((session_id, task_key)) = task.and_then(|task| {
        Some((
            task["currentAttempt"]["sessionId"].as_str()?.to_owned(),
            task["key"].as_str()?.to_owned(),
        ))
    }) else {
        return log.workflow(actor, request).await;
    };
    let target = target(worktrees, templates, &run_id, &session_id, &task_key)?;
    let (activity, cancel) = worktrees.hold(&session_id).map_err(|_| {
        refused(
            "busy",
            "A setup, run, archive or check is already active for this worktree",
        )
    })?;
    let started_at = now_millis();
    let (checks, log_path) = run_checks(
        &target.commands,
        &target.worktree,
        Bounds {
            limit: target.limit,
            tail,
        },
        cancel,
    )
    .await?;
    let attestation = HostChecks {
        source: "hostAttestation",
        attempt_id,
        session_id,
        task_key,
        template: target.template,
        digest: target.digest,
        worktree: display_path(&target.worktree),
        log: log_path,
        passed: !checks.is_empty() && checks.iter().all(|check| check.outcome == "passed"),
        started_at,
        finished_at: now_millis(),
        checks,
    };
    if let Request::Validate {
        host_attestation, ..
    } = &mut request
    {
        *host_attestation = Some(attestation);
    }
    let result = log.workflow(actor, request).await;
    drop(activity);
    result
}

#[cfg(test)]
#[path = "workflow_host_checks_tests.rs"]
mod tests;
