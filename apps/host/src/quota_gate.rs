use crate::{
    api_error::Error,
    launchers::Program,
    provider_quota::View,
    sessions::State,
    usage::{ClaudeObservation, LimitWindow},
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

pub(crate) const CLAUDE_FRESHNESS_MS: u64 = 15_000;
const CLAUDE_FUTURE_TOLERANCE_MS: u64 = 2_000;
const AWAITING_BOUND_MS: u64 = 30_000;
const QUEUE_CAPACITY: usize = 64;
const UNVERIFIED_CAPACITY: usize = 256;
const ACCOUNT_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const ACCOUNT_READ_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const UNTIMED_EXPIRY: u64 = i64::MAX as u64;
const LIMIT_REASONS: [&str; 4] = [
    "backend_denied",
    "spend_control_reached",
    "rate_limit_reached",
    "quota_exhausted",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Allow,
    Hold {
        reason: &'static str,
        resets_at_ms: Option<u64>,
    },
    Unknown {
        reason: &'static str,
    },
}
impl Verdict {
    fn name(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Hold { .. } => "hold",
            Self::Unknown { .. } => "unknown",
        }
    }
    fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Allow => None,
            Self::Hold { reason, .. } | Self::Unknown { reason } => Some(reason),
        }
    }
    fn resets_at_ms(&self) -> Option<u64> {
        match self {
            Self::Hold { resets_at_ms, .. } => *resets_at_ms,
            _ => None,
        }
    }
    pub(crate) fn held(&self) -> bool {
        matches!(self, Self::Hold { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Limit {
    pub reason: &'static str,
    pub resets_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Admission {
    pub revision: u64,
    pub fresh_until_elapsed_ms: Option<u64>,
    pub account: Option<String>,
    pub limit: Option<Limit>,
    pub reason: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Publication {
    hold: Option<&'static str>,
    expires_elapsed_ms: u64,
}

struct Source {
    program: Program,
    kind: &'static str,
    registered_elapsed_ms: u64,
    latest: Option<Admission>,
    limit: Option<(Option<String>, Limit)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Held {
    pub id: String,
    pub kind: &'static str,
    pub program: Program,
    pub reason: &'static str,
    pub resets_at_ms: Option<u64>,
    pub since_ms: u64,
    pub checks: u64,
}

pub(crate) struct Gate {
    salt: [u8; 32],
    installed: Vec<Program>,
    sources: Vec<Source>,
    published: Vec<(Program, Publication)>,
    publication_revision: u64,
    verdicts: Vec<(Program, Verdict)>,
    queue: Vec<Held>,
    unverified: VecDeque<(String, &'static str)>,
    closed: bool,
    changed: watch::Sender<u64>,
}

impl Gate {
    pub(crate) fn new(salt: [u8; 32], installed: &[Program]) -> Self {
        let mut programs: Vec<Program> = Vec::new();
        for program in installed.iter().copied().filter(|p| *p != Program::Shell) {
            if !programs.contains(&program) {
                programs.push(program);
            }
        }
        Self {
            salt,
            installed: programs,
            sources: Vec::new(),
            published: Vec::new(),
            publication_revision: 0,
            verdicts: Vec::new(),
            queue: Vec::new(),
            unverified: VecDeque::new(),
            closed: false,
            changed: watch::channel(0).0,
        }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn notify(&self) {
        self.changed.send_modify(|revision| *revision += 1);
    }

    pub(crate) fn register(&mut self, program: Program, kind: &'static str, elapsed_ms: u64) {
        if program == Program::Shell || self.sources.iter().any(|s| s.program == program) {
            return;
        }
        if !self.installed.contains(&program) {
            self.installed.push(program);
        }
        self.sources.push(Source {
            program,
            kind,
            registered_elapsed_ms: elapsed_ms,
            latest: None,
            limit: None,
        });
        self.notify();
    }

    pub(crate) fn observe(
        &mut self,
        program: Program,
        admission: Admission,
        elapsed_ms: u64,
    ) -> bool {
        let Some(source) = self.sources.iter_mut().find(|s| s.program == program) else {
            return false;
        };
        if source
            .latest
            .as_ref()
            .is_some_and(|latest| latest.revision >= admission.revision)
        {
            return false;
        }
        if admission
            .fresh_until_elapsed_ms
            .is_some_and(|until| until > elapsed_ms)
        {
            source.limit = admission
                .limit
                .clone()
                .map(|limit| (admission.account.clone(), limit));
        } else if let Some((account, _)) = &source.limit
            && admission.account.is_some()
            && account.is_some()
            && admission.account != *account
        {
            source.limit = None;
        }
        source.latest = Some(admission);
        self.notify();
        true
    }

    pub(crate) fn fingerprint(&self, values: &[&str]) -> String {
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &self.salt);
        let mut context = ring::hmac::Context::with_key(&key);
        context.update(b"nesvo.quotaGate.v1\0");
        for value in values {
            context.update(&(value.len() as u64).to_be_bytes());
            context.update(value.as_bytes());
        }
        hex::encode(context.sign().as_ref())
    }

    pub(crate) fn verdict(&self, program: Program, now_ms: u64, elapsed_ms: u64) -> Verdict {
        if program == Program::Shell {
            return Verdict::Allow;
        }
        let Some(source) = self.sources.iter().find(|s| s.program == program) else {
            return Verdict::Unknown {
                reason: "no_admission_source",
            };
        };
        if let Some(latest) = source.latest.as_ref().filter(|latest| {
            latest
                .fresh_until_elapsed_ms
                .is_some_and(|u| u > elapsed_ms)
        }) {
            return match &latest.limit {
                Some(limit) if limit.resets_at_ms.is_none_or(|reset| reset > now_ms) => {
                    Verdict::Hold {
                        reason: limit.reason,
                        resets_at_ms: limit.resets_at_ms,
                    }
                }
                Some(_) => Verdict::Unknown {
                    reason: "window_reset_elapsed",
                },
                None if latest.reason == "observed" => Verdict::Allow,
                None => Verdict::Unknown {
                    reason: latest.reason,
                },
            };
        }
        if let Some((_, limit)) = &source.limit
            && limit.resets_at_ms.is_none_or(|reset| reset > now_ms)
        {
            return Verdict::Hold {
                reason: limit.reason,
                resets_at_ms: limit.resets_at_ms,
            };
        }
        match &source.latest {
            None if elapsed_ms
                < source
                    .registered_elapsed_ms
                    .saturating_add(AWAITING_BOUND_MS) =>
            {
                Verdict::Hold {
                    reason: "awaiting_observation",
                    resets_at_ms: None,
                }
            }
            None => Verdict::Unknown {
                reason: "source_unavailable",
            },
            Some(_) if source.limit.is_some() => Verdict::Unknown {
                reason: "window_reset_elapsed",
            },
            Some(latest) if latest.fresh_until_elapsed_ms.is_some() => Verdict::Unknown {
                reason: "observation_expired",
            },
            Some(latest) => Verdict::Unknown {
                reason: latest.reason,
            },
        }
    }

    pub(crate) fn wake_after_ms(
        &self,
        program: Program,
        now_ms: u64,
        elapsed_ms: u64,
    ) -> Option<u64> {
        let source = self.sources.iter().find(|s| s.program == program)?;
        match self.verdict(program, now_ms, elapsed_ms) {
            Verdict::Hold {
                resets_at_ms: Some(reset),
                ..
            } => Some(reset.saturating_sub(now_ms).max(1)),
            Verdict::Hold {
                reason: "awaiting_observation",
                ..
            } => Some(
                source
                    .registered_elapsed_ms
                    .saturating_add(AWAITING_BOUND_MS)
                    .saturating_sub(elapsed_ms)
                    .max(1),
            ),
            _ => None,
        }
    }

    pub(crate) fn tick(
        &mut self,
        now_ms: u64,
        elapsed_ms: u64,
    ) -> Vec<crate::job_quota::Observation> {
        let programs: Vec<Program> = self.sources.iter().map(|s| s.program).collect();
        let mut changed = false;
        let mut observations = Vec::new();
        for program in programs {
            let verdict = self.verdict(program, now_ms, elapsed_ms);
            match self.verdicts.iter_mut().find(|(p, _)| *p == program) {
                Some((_, previous)) if *previous == verdict => {}
                Some((_, previous)) => {
                    *previous = verdict.clone();
                    changed = true;
                }
                None => {
                    self.verdicts.push((program, verdict.clone()));
                    changed = true;
                }
            }
            let desired = match &verdict {
                Verdict::Hold {
                    reason,
                    resets_at_ms,
                } => Publication {
                    hold: Some(reason),
                    expires_elapsed_ms: resets_at_ms.map_or(UNTIMED_EXPIRY, |reset| {
                        elapsed_ms.saturating_add(reset.saturating_sub(now_ms))
                    }),
                },
                _ => Publication {
                    hold: None,
                    expires_elapsed_ms: elapsed_ms,
                },
            };
            let current = self.published.iter_mut().find(|(p, _)| *p == program);
            let stale = match &current {
                None => true,
                Some((_, published)) => {
                    published.hold != desired.hold
                        || (desired.hold.is_some()
                            && published
                                .expires_elapsed_ms
                                .abs_diff(desired.expires_elapsed_ms)
                                > 1_000)
                }
            };
            if !stale {
                continue;
            }
            match current {
                Some((_, published)) => *published = desired,
                None => self.published.push((program, desired)),
            }
            self.publication_revision += 1;
            observations.push(crate::job_quota::Observation {
                source_id: crate::job_quota::gate_source(program),
                revision: self.publication_revision,
                binding: None,
                expires_elapsed_ms: desired.expires_elapsed_ms,
                eligible: desired.hold.is_none(),
                reason: desired.hold.unwrap_or("allow").into(),
            });
        }
        if changed {
            self.notify();
        }
        observations
    }

    pub(crate) fn enqueue(&mut self, held: Held) -> Result<()> {
        if let Some(current) = self.queue.iter_mut().find(|item| item.id == held.id) {
            current.checks += 1;
            if current.reason != held.reason || current.resets_at_ms != held.resets_at_ms {
                current.reason = held.reason;
                current.resets_at_ms = held.resets_at_ms;
                self.changed.send_modify(|revision| *revision += 1);
            }
            return Ok(());
        }
        if self.queue.len() >= QUEUE_CAPACITY {
            return Err(
                Error::new("busy", "The quota hold queue is full; no launch was queued").into(),
            );
        }
        self.queue.push(held);
        self.notify();
        Ok(())
    }

    pub(crate) fn dequeue(&mut self, id: &str) {
        let before = self.queue.len();
        self.queue.retain(|item| item.id != id);
        if self.queue.len() != before {
            self.notify();
        }
    }

    pub(crate) fn mark_unverified(&mut self, session: &str, reason: &'static str) {
        self.unverified.retain(|(id, _)| id != session);
        if self.unverified.len() >= UNVERIFIED_CAPACITY {
            self.unverified.pop_front();
        }
        self.unverified.push_back((session.to_owned(), reason));
    }

    pub(crate) fn unverified(&self, session: &str) -> Value {
        self.unverified
            .iter()
            .find(|(id, _)| id == session)
            .map_or(Value::Null, |(_, reason)| json!({"reason": reason}))
    }

    pub(crate) fn close(&mut self) {
        if !self.closed {
            self.closed = true;
            self.notify();
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    pub(crate) fn view(&self, now_ms: u64, elapsed_ms: u64) -> Value {
        let providers: Vec<Value> = self
            .installed
            .iter()
            .map(|program| {
                let verdict = self.verdict(*program, now_ms, elapsed_ms);
                let source = self.sources.iter().find(|s| s.program == *program);
                let fresh_until = source
                    .and_then(|s| s.latest.as_ref())
                    .and_then(|latest| latest.fresh_until_elapsed_ms)
                    .filter(|until| *until > elapsed_ms)
                    .map(|until| now_ms.saturating_add(until - elapsed_ms));
                json!({
                    "program": program,
                    "source": source.map_or("unsupported", |s| s.kind),
                    "verdict": verdict.name(),
                    "reason": verdict.reason(),
                    "resetsAt": verdict.resets_at_ms(),
                    "freshUntil": fresh_until,
                    "sourceRevision": source.and_then(|s| s.latest.as_ref()).map(|l| l.revision),
                })
            })
            .collect();
        let holds: Vec<Value> = self
            .queue
            .iter()
            .map(|held| {
                json!({
                    "id": held.id,
                    "kind": held.kind,
                    "program": held.program,
                    "reason": held.reason,
                    "resetsAt": held.resets_at_ms,
                    "since": held.since_ms,
                    "checks": held.checks,
                })
            })
            .collect();
        json!({"revision": *self.changed.borrow(), "providers": providers, "holds": holds})
    }
}

fn exhausted_reset_ms(windows: &[LimitWindow]) -> Option<u64> {
    windows
        .iter()
        .filter(|window| window.used_percent >= 100)
        .filter_map(|window| window.resets_at)
        .filter_map(|reset| u64::try_from(reset).ok())
        .filter_map(|reset| reset.checked_mul(1000))
        .max()
}

pub(crate) fn codex_admission(view: &View) -> Admission {
    let fresh = view.freshness == "fresh";
    let limit = (fresh && LIMIT_REASONS.contains(&view.eligibility_reason)).then(|| Limit {
        reason: view.eligibility_reason,
        resets_at_ms: exhausted_reset_ms(&view.windows),
    });
    Admission {
        revision: view.revision,
        fresh_until_elapsed_ms: if fresh { view.expires_elapsed_ms } else { None },
        account: view.account_fingerprint.clone(),
        limit,
        reason: if fresh {
            view.eligibility_reason
        } else {
            view.reason
        },
    }
}

pub(crate) fn observe_codex_view(gate: &mut Gate, view: &View) {
    if view.program == Program::Codex && view.revision > 0 {
        gate.observe(
            Program::Codex,
            codex_admission(view),
            crate::event_log::monotonic_millis(),
        );
    }
}

pub(crate) fn claude_admission(
    observation: &ClaudeObservation,
    account: Option<String>,
    revision: u64,
    started_elapsed_ms: u64,
) -> Admission {
    let unknown = |reason: &'static str, account: Option<String>| Admission {
        revision,
        fresh_until_elapsed_ms: None,
        account,
        limit: None,
        reason,
    };
    let Some(source_at_ms) = observation.source_at_ms else {
        return unknown(observation.reason, account);
    };
    if source_at_ms
        > observation
            .observed_at_ms
            .saturating_add(CLAUDE_FUTURE_TOLERANCE_MS)
    {
        return unknown("future_cache", account);
    }
    if !matches!(observation.reason, "observed" | "partial_snapshot")
        || observation.windows.is_empty()
    {
        return unknown(observation.reason, account);
    }
    let age_ms = observation.observed_at_ms.saturating_sub(source_at_ms);
    if age_ms >= CLAUDE_FRESHNESS_MS {
        return unknown("source_stale", account);
    }
    if account.is_none() {
        return unknown("account_unavailable", None);
    }
    let exhausted = observation.windows.iter().any(|w| w.used_percent >= 100);
    Admission {
        revision,
        fresh_until_elapsed_ms: Some(
            started_elapsed_ms.saturating_add(CLAUDE_FRESHNESS_MS - age_ms),
        ),
        account,
        limit: exhausted.then(|| Limit {
            reason: "quota_exhausted",
            resets_at_ms: exhausted_reset_ms(&observation.windows),
        }),
        reason: if observation.reason == "observed" {
            "observed"
        } else {
            "partial_snapshot"
        },
    }
}

pub(crate) fn claude_account_identity(value: &Value) -> Option<(String, String)> {
    let account = &value["oauthAccount"];
    let id = account["accountUuid"]
        .as_str()
        .filter(|id| valid_identity(id))?;
    let organization = account["organizationUuid"]
        .as_str()
        .filter(|id| valid_identity(id))
        .unwrap_or_default();
    Some((id.to_owned(), organization.to_owned()))
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(crate) fn claude_account_paths() -> Vec<PathBuf> {
    if let Some(directory) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return vec![PathBuf::from(directory).join(".claude.json")];
    }
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    vec![
        home.join(".claude").join(".claude.json"),
        home.join(".claude.json"),
    ]
}

async fn read_account_file(path: &Path) -> Option<(String, String)> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() > ACCOUNT_FILE_MAX_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    if bytes.len() as u64 > ACCOUNT_FILE_MAX_BYTES {
        return None;
    }
    claude_account_identity(&serde_json::from_slice(&bytes).ok()?)
}

pub(crate) async fn read_claude_account(paths: &[PathBuf]) -> Option<(String, String)> {
    for path in paths {
        let found = tokio::time::timeout(ACCOUNT_READ_TIMEOUT, read_account_file(path))
            .await
            .ok()
            .flatten();
        if found.is_some() {
            return found;
        }
    }
    None
}

pub(crate) fn admit_now(gate: &Gate, program: Program) -> Result<Option<&'static str>> {
    match gate.verdict(
        program,
        crate::status::now_millis(),
        crate::event_log::monotonic_millis(),
    ) {
        Verdict::Allow => Ok(None),
        Verdict::Unknown { reason } => Ok(Some(reason)),
        Verdict::Hold { .. } => Err(Error::new(
            "quota_hold",
            "Provider quota is held at a known limit; inspect nesvo quota for the reason and reset time",
        )
        .into()),
    }
}

pub(crate) fn sync(state: &mut State) {
    let observations = state.quota_gate.tick(
        crate::status::now_millis(),
        crate::event_log::monotonic_millis(),
    );
    for observation in observations {
        state.retain_quota_observation(observation);
    }
}

struct Queued<'a> {
    state: &'a Arc<Mutex<State>>,
    id: String,
}
impl Drop for Queued<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.quota_gate.dequeue(&self.id);
        }
    }
}

async fn abandoned(cancel: &mut Option<watch::Receiver<bool>>) {
    let Some(receiver) = cancel else {
        return std::future::pending().await;
    };
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

pub(crate) async fn admit<F>(
    state: &Arc<Mutex<State>>,
    id: &str,
    kind: &'static str,
    program: Program,
    mut cancel: Option<watch::Receiver<bool>>,
    mut on_hold: F,
) -> Result<()>
where
    F: FnMut(&Verdict),
{
    let mut changed = state
        .lock()
        .map_err(|_| anyhow!("Host state is unavailable"))?
        .quota_gate
        .subscribe();
    let queued = Queued {
        state,
        id: id.to_owned(),
    };
    let mut notified = false;
    loop {
        changed.borrow_and_update();
        let (verdict, wake) = {
            let mut current = state
                .lock()
                .map_err(|_| anyhow!("Host state is unavailable"))?;
            if current.quota_gate.is_closed() {
                return Err(Error::new("host_stopping", "Host is shutting down").into());
            }
            let now = crate::status::now_millis();
            let elapsed = crate::event_log::monotonic_millis();
            let verdict = current.quota_gate.verdict(program, now, elapsed);
            if let Verdict::Hold {
                reason,
                resets_at_ms,
            } = &verdict
            {
                current.quota_gate.enqueue(Held {
                    id: queued.id.clone(),
                    kind,
                    program,
                    reason,
                    resets_at_ms: *resets_at_ms,
                    since_ms: now,
                    checks: 1,
                })?;
                changed.borrow_and_update();
            }
            let wake = current.quota_gate.wake_after_ms(program, now, elapsed);
            (verdict, wake)
        };
        if !verdict.held() {
            return Ok(());
        }
        if !notified {
            notified = true;
            on_hold(&verdict);
        }
        let deadline = async {
            match wake {
                Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            result = changed.changed() => if result.is_err() {
                return Err(anyhow!("Quota gate closed while a launch was held"));
            },
            () = deadline => {},
            () = abandoned(&mut cancel) => {
                return Err(Error::new("quota_hold_abandoned", "The requesting client disconnected while the launch was held").into());
            },
        }
    }
}

pub(crate) async fn admit_launch(
    state: &Arc<Mutex<State>>,
    client: u64,
    reserved: &str,
    program: Program,
    request_id: Option<&str>,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    let result = admit(
        state,
        reserved,
        "launch",
        program,
        Some(cancel),
        |verdict| {
            if let Ok(state) = state.lock() {
                state.send(client, hold_event(verdict, program, reserved, request_id));
            }
        },
    )
    .await;
    if let Err(error) = &result
        && let Some(code) = error
            .downcast_ref::<Error>()
            .map(|error| error.code)
            .filter(|code| *code != "quota_hold_abandoned")
        && let Ok(state) = state.lock()
    {
        let mut event =
            json!({"type":"error","code":code,"message":error.to_string(),"sessionId":reserved});
        if let Some(request_id) = request_id {
            event["requestId"] = request_id.into();
        }
        state.send(client, event);
    }
    result
}

pub(crate) fn hold_event(
    verdict: &Verdict,
    program: Program,
    session_id: &str,
    request_id: Option<&str>,
) -> Value {
    let mut event = json!({
        "type": "quotaHold",
        "program": program,
        "sessionId": session_id,
        "reason": verdict.reason(),
        "resetsAt": verdict.resets_at_ms(),
    });
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    event
}

#[cfg(test)]
#[path = "quota_gate_tests.rs"]
mod tests;
