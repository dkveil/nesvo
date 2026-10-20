//! Private quota observations. Reader evidence never grants a native process usage.
use crate::{
    launchers::Program,
    usage::{ClaudeObservation, CodexObservation, LimitWindow, ReadOutcome, ReaderContext},
};
use serde::Serialize;

const READ_FRESHNESS_MS: u64 = 180_000;
const CLAUDE_SOURCE_FRESHNESS_MS: u64 = 900_000;
const SOURCE_FUTURE_TOLERANCE_MS: u64 = 60_000;

/// This view contains no raw account, home, path, provider body or error text.
/// `ready` describes metadata health, independently of ordinary usage permission.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    pub program: Program,
    pub source: &'static str,
    pub revision: u64,
    pub status: &'static str,
    pub reason: &'static str,
    pub attempted_at: Option<u64>,
    pub observed_at: Option<u64>,
    pub source_at: Option<u64>,
    pub expires_at: Option<u64>,
    #[serde(skip)]
    pub expires_elapsed_ms: Option<u64>,
    /// Codex read-start age, or Claude's original cache-source age.
    pub age_ms: Option<u64>,
    pub freshness: &'static str,
    pub complete: bool,
    pub ordinary_usage_allowed: Option<bool>,
    pub windows: Vec<LimitWindow>,
    pub context_id: Option<String>,
    pub account_fingerprint: Option<String>,
    /// Affirmative reader evidence only; never an account or native-session lock.
    pub ordinary_usage_eligible: bool,
    pub eligibility_reason: &'static str,
    pub scope: &'static str,
}

/// Private source evidence for a session-bound resume. Historical display data
/// never supplies a current read start or renews a failed observation.
pub(crate) struct ReadProof {
    pub view: View,
    pub started_elapsed_ms: Option<u64>,
    pub effective_now_ms: Option<u64>,
    pub known_context_id: Option<String>,
    pub known_account_fingerprint: Option<String>,
    pub identity_changed_revision: u64,
}

/// The caller supplies one random secret salt per host epoch. Neither the salt
/// nor the unhashed account/context values are retained in a serializable view.
pub(crate) struct Tracker {
    host_epoch_salt: [u8; 32],
    entries: Vec<Entry>,
}

struct Entry {
    program: Program,
    revision: u64,
    latest: Option<Attempt>,
    successful: Option<Snapshot>,
    clock: Option<ClockAnchor>,
    identity_context: Option<String>,
    identity_account: Option<String>,
    identity_changed_revision: u64,
}

struct Attempt {
    started_at_ms: u64,
    finished_elapsed_ms: u64,
    failure: Option<&'static str>,
    known_context_id: Option<String>,
}

struct Snapshot {
    revision: u64,
    observed_at_ms: u64,
    started_elapsed_ms: u64,
    finished_elapsed_ms: u64,
    read_expires_at_ms: u64,
    source_at_ms: Option<u64>,
    windows: Vec<LimitWindow>,
    complete: bool,
    ordinary_usage_allowed: Option<bool>,
    spend_control_reached: bool,
    rate_limit_reached: bool,
    context_id: Option<String>,
    account_fingerprint: Option<String>,
}

#[derive(Clone, Copy)]
struct ClockAnchor {
    wall_ms: u64,
    elapsed_ms: u64,
}
impl ClockAnchor {
    fn wall_at(self, elapsed_ms: u64) -> Option<u64> {
        elapsed_ms
            .checked_sub(self.elapsed_ms)
            .map(|age| self.wall_ms.saturating_add(age))
    }
}

impl Tracker {
    pub fn new(installed: &[Program], host_epoch_salt: [u8; 32]) -> Self {
        let mut entries = Vec::new();
        for program in installed.iter().copied().filter(|p| *p != Program::Shell) {
            if !entries.iter().any(|entry: &Entry| entry.program == program) {
                entries.push(Entry {
                    program,
                    revision: 0,
                    latest: None,
                    successful: None,
                    clock: None,
                    identity_context: None,
                    identity_account: None,
                    identity_changed_revision: 0,
                });
            }
        }
        Self {
            host_epoch_salt,
            entries,
        }
    }

    pub fn apply_codex(&mut self, observation: CodexObservation) {
        let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.program == Program::Codex)
        else {
            return;
        };
        let Some(clock) = entry.attempt(
            observation.started_at_ms,
            observation.finished_at_ms,
            observation.started_elapsed_ms,
            observation.finished_elapsed_ms,
        ) else {
            return;
        };
        let context_id = observation
            .context
            .as_ref()
            .filter(|context| valid_context(context))
            .map(|context| {
                fingerprint(
                    &self.host_epoch_salt,
                    b"context",
                    &[&context.context_id, &context.codex_home],
                )
            });
        let known_context_id = observation
            .context
            .as_ref()
            .filter(|context| context.route.verdict != crate::usage::RouteVerdict::Unknown)
            .and(context_id.clone());
        if let Some(attempt) = &mut entry.latest {
            attempt.known_context_id = known_context_id.clone();
        }
        if let Some(context) = &known_context_id {
            if entry
                .identity_context
                .as_ref()
                .is_some_and(|previous| previous != context)
            {
                entry.identity_changed_revision = entry.revision;
            }
            entry.identity_context = Some(context.clone());
        }
        match observation.outcome {
            ReadOutcome::Failure(failure) => entry.fail(failure.code()),
            ReadOutcome::Snapshot(snapshot) => {
                let account_fingerprint = snapshot
                    .account_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .map(|id| fingerprint(&self.host_epoch_salt, b"account", &[id]));
                if let Some(account) = &account_fingerprint {
                    if entry
                        .identity_account
                        .as_ref()
                        .is_some_and(|previous| previous != account)
                    {
                        entry.identity_changed_revision = entry.revision;
                    }
                    entry.identity_account = Some(account.clone());
                }
                let complete = snapshot.complete
                    && snapshot.completeness.complete_window_count()
                        == Some(snapshot.windows.len())
                    && valid_windows(&snapshot.windows);
                entry.successful = Some(Snapshot {
                    revision: entry.revision,
                    observed_at_ms: observation.finished_at_ms,
                    started_elapsed_ms: observation.started_elapsed_ms,
                    finished_elapsed_ms: observation.finished_elapsed_ms,
                    read_expires_at_ms: read_expires_at(clock, observation.started_elapsed_ms),
                    source_at_ms: None,
                    windows: snapshot.windows,
                    complete,
                    ordinary_usage_allowed: snapshot.ordinary_usage_allowed,
                    spend_control_reached: snapshot.spend_control_reached == Some(true),
                    rate_limit_reached: snapshot.rate_limit_reached,
                    context_id,
                    account_fingerprint,
                });
            }
        }
    }

    /// Claude's observation records its wall-clock read start. The caller must
    /// retain the monotonic start before awaiting I/O, plus completion afterward.
    pub fn apply_claude(
        &mut self,
        observation: ClaudeObservation,
        started_elapsed_ms: u64,
        finished_elapsed_ms: u64,
    ) {
        let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.program == Program::Claude)
        else {
            return;
        };
        let Some(clock) = entry.attempt(
            observation.observed_at_ms,
            observation.observed_at_ms,
            started_elapsed_ms,
            finished_elapsed_ms,
        ) else {
            return;
        };
        let Some(source_at_ms) = observation.source_at_ms else {
            entry.fail(claude_failure(observation.reason));
            return;
        };
        if source_at_ms > clock.wall_ms.saturating_add(SOURCE_FUTURE_TOLERANCE_MS) {
            entry.fail("future_cache");
            return;
        }
        if clock.wall_ms.saturating_sub(source_at_ms) >= CLAUDE_SOURCE_FRESHNESS_MS {
            entry.fail("stale_cache");
            return;
        }
        if !matches!(observation.reason, "observed" | "partial_snapshot")
            || observation.windows.is_empty()
        {
            entry.fail(claude_failure(observation.reason));
            return;
        }
        let complete = observation.reason == "observed" && complete_windows(&observation.windows);
        entry.successful = Some(Snapshot {
            revision: entry.revision,
            observed_at_ms: observation.observed_at_ms,
            started_elapsed_ms,
            finished_elapsed_ms,
            read_expires_at_ms: read_expires_at(clock, started_elapsed_ms),
            source_at_ms: Some(source_at_ms),
            windows: observation.windows,
            complete,
            ordinary_usage_allowed: None,
            spend_control_reached: false,
            rate_limit_reached: false,
            context_id: None,
            account_fingerprint: None,
        });
    }

    pub fn view(&mut self, now_ms: u64, elapsed_ms: u64) -> Vec<View> {
        self.entries
            .iter_mut()
            .map(|entry| entry.view(now_ms, elapsed_ms))
            .collect()
    }

    pub fn read_proof(&mut self, now_ms: u64, elapsed_ms: u64) -> Option<ReadProof> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.program == Program::Codex)?;
        let view = entry.view(now_ms, elapsed_ms);
        let current = entry.successful.as_ref().filter(|snapshot| {
            snapshot.revision == entry.revision
                && entry
                    .latest
                    .as_ref()
                    .is_some_and(|attempt| attempt.failure.is_none())
        });
        Some(ReadProof {
            view,
            started_elapsed_ms: current.map(|snapshot| snapshot.started_elapsed_ms),
            effective_now_ms: entry.clock.and_then(|clock| clock.wall_at(elapsed_ms)),
            known_context_id: entry
                .latest
                .as_ref()
                .and_then(|attempt| attempt.known_context_id.clone()),
            known_account_fingerprint: current
                .and_then(|snapshot| snapshot.account_fingerprint.clone()),
            identity_changed_revision: entry.identity_changed_revision,
        })
    }
}

impl Entry {
    /// Every completed attempt advances the revision, including failures and
    /// unchanged cache contents. Wall rollback cannot rewind the cache clock.
    fn attempt(
        &mut self,
        started_at_ms: u64,
        finished_at_ms: u64,
        started_elapsed_ms: u64,
        finished_elapsed_ms: u64,
    ) -> Option<ClockAnchor> {
        let prior_completion = self
            .latest
            .as_ref()
            .map(|attempt| attempt.finished_elapsed_ms);
        self.revision = self.revision.saturating_add(1);
        self.latest = Some(Attempt {
            started_at_ms,
            finished_elapsed_ms,
            failure: None,
            known_context_id: None,
        });
        let Some(read_duration) = finished_elapsed_ms.checked_sub(started_elapsed_ms) else {
            self.fail("clock_regressed");
            return None;
        };
        if prior_completion.is_some_and(|prior| finished_elapsed_ms < prior) {
            self.fail("clock_regressed");
            return None;
        }
        // A projection may have run after this read finished but before its
        // result acquired State. Merge at the later anchor without rewinding
        // the clock or rejecting that otherwise valid completed observation.
        let anchor_elapsed_ms = self.clock.map_or(finished_elapsed_ms, |clock| {
            clock.elapsed_ms.max(finished_elapsed_ms)
        });
        let publication_age = anchor_elapsed_ms.saturating_sub(finished_elapsed_ms);
        let prior_wall = self
            .clock
            .and_then(|clock| clock.wall_at(anchor_elapsed_ms))
            .unwrap_or(0);
        let clock = ClockAnchor {
            wall_ms: finished_at_ms
                .max(started_at_ms.saturating_add(read_duration))
                .saturating_add(publication_age)
                .max(prior_wall),
            elapsed_ms: anchor_elapsed_ms,
        };
        self.clock = Some(clock);
        Some(clock)
    }

    fn fail(&mut self, reason: &'static str) {
        if let Some(attempt) = &mut self.latest {
            attempt.failure = Some(reason);
        }
    }

    fn view(&mut self, now_ms: u64, elapsed_ms: u64) -> View {
        let mut view = View {
            program: self.program,
            source: match self.program {
                Program::Codex => "codexAppServer",
                Program::Claude => "claudeStatusCache",
                _ => "unsupported",
            },
            revision: self.revision,
            status: "unavailable",
            reason: "unsupported",
            attempted_at: self.latest.as_ref().map(|attempt| attempt.started_at_ms),
            observed_at: None,
            source_at: None,
            expires_at: None,
            expires_elapsed_ms: None,
            age_ms: None,
            freshness: "unavailable",
            complete: false,
            ordinary_usage_allowed: None,
            windows: Vec::new(),
            context_id: None,
            account_fingerprint: None,
            ordinary_usage_eligible: false,
            eligibility_reason: "unsupported",
            scope: "readerSnapshotOnly",
        };
        if !matches!(self.program, Program::Codex | Program::Claude) {
            return view;
        }
        let Some(attempt) = &self.latest else {
            view.status = "checking";
            view.reason = "awaiting_observation";
            view.eligibility_reason = view.reason;
            return view;
        };
        let effective_now = self
            .clock
            .and_then(|clock| clock.wall_at(elapsed_ms))
            .map(|wall| wall.max(now_ms));
        if let Some(wall_ms) = effective_now {
            // Viewing a forward wall clock is itself a clock observation. A
            // later rollback cannot revive this revision or rejuvenate cache
            // source age on a subsequent read.
            self.clock = Some(ClockAnchor {
                wall_ms,
                elapsed_ms,
            });
        }
        if let Some(snapshot) = &self.successful {
            view.observed_at = Some(snapshot.observed_at_ms);
            view.source_at = snapshot.source_at_ms;
            view.expires_at = Some(snapshot.expires_at());
            view.age_ms = match snapshot.source_at_ms {
                Some(source_at) => effective_now.map(|now| now.saturating_sub(source_at)),
                None => elapsed_ms.checked_sub(snapshot.started_elapsed_ms),
            };
            view.windows = snapshot.windows.clone();
            view.context_id = snapshot.context_id.clone();
            view.account_fingerprint = snapshot.account_fingerprint.clone();
        }
        if elapsed_ms < attempt.finished_elapsed_ms || effective_now.is_none() {
            view.reason = "clock_regressed";
            view.eligibility_reason = view.reason;
            return view;
        }
        if let Some(failure) = attempt.failure {
            view.status = if failure == "stale_cache" {
                "stale"
            } else {
                "unavailable"
            };
            view.freshness = if failure == "stale_cache" {
                "stale"
            } else {
                "unavailable"
            };
            view.reason = failure;
            view.eligibility_reason = failure;
            return view;
        }
        let Some(snapshot) = self
            .successful
            .as_ref()
            .filter(|snapshot| snapshot.revision == self.revision)
        else {
            view.reason = "snapshot_unavailable";
            view.eligibility_reason = view.reason;
            return view;
        };
        let now_ms = effective_now.unwrap_or(now_ms);
        view.complete = snapshot.complete;
        let expired = if elapsed_ms < snapshot.finished_elapsed_ms {
            Some("clock_regressed")
        } else if elapsed_ms.saturating_sub(snapshot.started_elapsed_ms) >= READ_FRESHNESS_MS {
            Some("read_expired")
        } else if snapshot
            .source_at_ms
            .is_some_and(|source_at| now_ms.saturating_sub(source_at) >= CLAUDE_SOURCE_FRESHNESS_MS)
        {
            Some("stale_cache")
        } else if snapshot.windows.iter().any(|window| {
            window
                .resets_at
                .is_some_and(|reset| reset_ms(reset).is_none_or(|reset| reset <= now_ms))
        }) {
            Some("window_reset_elapsed")
        } else {
            None
        };
        if let Some(reason) = expired {
            view.status = "stale";
            view.reason = reason;
            view.freshness = "stale";
            view.eligibility_reason = reason;
            return view;
        }
        view.status = if snapshot.complete {
            "ready"
        } else {
            "partial"
        };
        view.reason = if snapshot.complete {
            "observed"
        } else {
            "incomplete_snapshot"
        };
        view.freshness = "fresh";
        view.expires_elapsed_ms = Some(
            elapsed_ms
                .saturating_add(snapshot.expires_at().saturating_sub(now_ms))
                .min(
                    snapshot
                        .started_elapsed_ms
                        .saturating_add(READ_FRESHNESS_MS),
                ),
        );
        view.ordinary_usage_allowed = snapshot.ordinary_usage_allowed;
        view.eligibility_reason = snapshot.eligibility_reason();
        view.ordinary_usage_eligible = view.eligibility_reason == "observed";
        view
    }
}

impl Snapshot {
    fn expires_at(&self) -> u64 {
        let mut expires_at = self.read_expires_at_ms;
        if let Some(source_at) = self.source_at_ms {
            expires_at = expires_at.min(source_at.saturating_add(CLAUDE_SOURCE_FRESHNESS_MS));
        }
        for reset in self.windows.iter().filter_map(|window| window.resets_at) {
            if let Some(reset) = reset_ms(reset) {
                expires_at = expires_at.min(reset);
            }
        }
        expires_at
    }

    fn eligibility_reason(&self) -> &'static str {
        if self.ordinary_usage_allowed == Some(false) {
            "backend_denied"
        } else if self.spend_control_reached {
            "spend_control_reached"
        } else if self.rate_limit_reached {
            "rate_limit_reached"
        } else if self.windows.iter().any(|window| window.used_percent >= 100) {
            "quota_exhausted"
        } else if !self.complete {
            "incomplete_snapshot"
        } else if self.ordinary_usage_allowed.is_none() {
            "backend_permission_unavailable"
        } else if self.account_fingerprint.is_none() {
            "account_identity_unavailable"
        } else if self.context_id.is_none() {
            "context_unavailable"
        } else {
            "observed"
        }
    }
}

fn complete_windows(windows: &[LimitWindow]) -> bool {
    windows.len() == 2 && valid_windows(windows)
}

fn valid_windows(windows: &[LimitWindow]) -> bool {
    windows.iter().all(|window| {
        window.used_percent <= 100
            && window.duration_mins > 0
            && window
                .resets_at
                .is_some_and(|reset| reset_ms(reset).is_some())
    })
}

fn reset_ms(reset: i64) -> Option<u64> {
    u64::try_from(reset)
        .ok()
        .filter(|reset| *reset > 0)
        .and_then(|reset| reset.checked_mul(1000))
}

fn read_expires_at(clock: ClockAnchor, started_elapsed_ms: u64) -> u64 {
    clock
        .wall_ms
        .saturating_sub(clock.elapsed_ms.saturating_sub(started_elapsed_ms))
        .saturating_add(READ_FRESHNESS_MS)
}

fn valid_context(context: &ReaderContext) -> bool {
    !context.context_id.is_empty() && !context.codex_home.is_empty()
}

fn claude_failure(reason: &'static str) -> &'static str {
    match reason {
        "context_unavailable"
        | "cache_unavailable"
        | "cache_non_regular"
        | "cache_timeout"
        | "cache_oversized"
        | "invalid_cache"
        | "future_cache"
        | "stale_cache"
        | "windows_unavailable" => reason,
        _ => "invalid_response",
    }
}

fn fingerprint(salt: &[u8; 32], domain: &[u8], values: &[&str]) -> String {
    let mut context =
        ring::hmac::Context::with_key(&ring::hmac::Key::new(ring::hmac::HMAC_SHA256, salt));
    context.update(b"nesvo.providerQuota.v1\0");
    context.update(domain);
    for value in values {
        context.update(&(value.len() as u64).to_be_bytes());
        context.update(value.as_bytes());
    }
    hex::encode(context.sign().as_ref())
}

#[cfg(test)]
#[path = "provider_quota_tests.rs"]
mod tests;
