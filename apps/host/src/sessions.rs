pub use crate::pty::PtyEvent;
use crate::{
    groups::valid_name,
    launchers::{Launchers, Program, working_directory},
    protocol::Command,
    pty::Pty,
    replay::{bounded_append, output_chunks, replay_history},
    status::{StatusTracker, now_millis},
    storage::MetadataStore,
    usage::{self, LimitWindow, ProviderLimit},
};
use anyhow::{Result, anyhow, ensure};
use portable_pty::{CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, watch};
#[path = "quota_wake_session.rs"]
mod quota_wake_session;
#[path = "session_quota.rs"]
pub(crate) mod session_quota;

#[derive(Clone)]
pub struct Client {
    pub events: mpsc::Sender<Value>,
    pub cancelled: watch::Sender<bool>,
    pub authority: crate::caller::Authority,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    name: String,
    cwd: String,
    created_at: String,
    cols: u16,
    rows: u16,
    running: bool,
    group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    program: Program,
}

#[derive(Clone)]
struct ControlLease {
    client_id: u64,
    id: String,
    legacy: bool,
}

impl ControlLease {
    fn accepts(&self, client_id: u64, lease_id: Option<&str>) -> bool {
        self.client_id == client_id
            && match lease_id {
                Some(id) => id == self.id,
                None => self.legacy,
            }
    }
}

struct Session {
    repository_binding: crate::session_repository::Binding,
    quota_binding: Option<session_quota::LaunchBinding>,
    quota_wake: Option<crate::quota_wakes::Arm>,
    claude_quota: Option<crate::claude_quota::Observation>,
    claude_capture_diagnostic: Option<crate::claude_quota_diagnostics::View>,
    model_selection: crate::launch_profile::Selection,
    harness_enabled: bool,
    policy: crate::caller::Policy,
    caller_context: Option<crate::caller::Context>,
    started: std::time::Instant,
    elapsed_at_exit: Option<Duration>,
    agent_context: Option<crate::agent_context::Tracker>,
    integration_delivery: crate::agent_context::Delivery,
    integration_shadow_sequence: Option<u64>,
    conversation_identity: Option<crate::agent_events::Identity>,
    resume: Option<crate::resume::Gate>,
    lifecycle_cursor: u64,
    lifecycle_gap: bool,
    status_latency: crate::status_latency::Tracker,
    info: SessionInfo,
    status: StatusTracker,
    readiness: crate::readiness::Tracker,
    turn: crate::turns::Tracker,
    pending_input: Option<crate::submission::Pending>,
    quota_predecessor: Option<crate::submission::Pending>,
    human_input_dirty: bool,
    human_control_epoch: u64,
    terminal_protocol: crate::terminal_protocol::Decoder,
    program_status: crate::program_status::Records,
    status_projection_dirty: bool,
    wake_attention: crate::wake_attention::Publisher,
    pty: Pty,
    backlog: String,
    output_cursor: u64,
    controller: Option<ControlLease>,
    subscribers: HashSet<u64>,
    has_been_attached: bool,
    wake_at: Option<i64>,
    attention: crate::attention::Attention,
    attention_dirty: bool,
    titles: crate::titles::Titles,
    auto_title: bool,
}

impl Session {
    fn capture_diagnostic(&self) -> Option<Value> {
        let mut configured = self.agent_context.as_ref()?.capture_diagnostic()?.clone();
        let view = self
            .claude_capture_diagnostic
            .clone()
            .unwrap_or_else(crate::claude_quota_diagnostics::View::not_polled);
        configured["delivery"] = json!(view.delivery);
        configured["reader"] = json!(view.reader);
        Some(configured)
    }

    fn kill(&mut self) -> Result<()> {
        // Early native stop can precede ConPTY's first query reaching the reader.
        // Confirm its one reply before termination; the decoder consumes it later.
        #[cfg(windows)]
        {
            let reply_needed = self.terminal_protocol.initial_cursor_reply_needed();
            self.pty.prepare_termination(reply_needed)?;
            if reply_needed {
                self.terminal_protocol.confirm_initial_cursor_reply();
            }
        }
        self.pty.kill()
    }
    fn current_attention(&self) -> crate::attention_projection::Projection {
        crate::attention_projection::Projection::current(
            self.status.status(),
            self.readiness.snapshot().phase,
            self.status.block_reason(),
            self.program_status.blocked_children(),
        )
    }
    fn wake_attention_payload(&self) -> Value {
        let attention = self.current_attention();
        let exit = self.status.observed_exit();
        json!({"priority":attention.priority,"reason":attention.reason,"blockedChildren":attention.blocked_children,"processExited":exit.is_some(),"exitCode":exit.flatten()})
    }
}

pub struct State {
    human_control_epoch: u64,
    budget: crate::budgets::Shared,
    event_log: Option<crate::event_log::Service>,
    lifecycle_observer: crate::agent_events::ReadCounts,
    submission_updates: Vec<crate::submission::Transition>,
    caller_url: Option<String>,
    job_trigger_address: Option<String>,
    workspace: PathBuf,
    sessions: HashMap<String, Session>,
    repository: crate::session_repository::Registry,
    repository_wakeup: Option<mpsc::Sender<()>>,
    cleanup_workers: Vec<thread::JoinHandle<()>>,
    shutting_down: bool,
    pub clients: HashMap<u64, Client>,
    pub reviews: crate::review::Registry,
    pub(crate) metadata: MetadataStore,
    push_queue: std::collections::VecDeque<crate::notifications::Job>,
    launchers: Launchers,
    provider_versions: Vec<crate::launchers::Version>,
    provider_limits: Vec<ProviderLimit>,
    provider_quota: crate::provider_quota::Tracker,
    quota_contexts: crate::quota_contexts::Registry,
    quota_wakeup: Option<mpsc::Sender<()>>,
    quota_publications: Vec<crate::job_quota::Observation>,
    quota_refresh: Vec<crate::provider_quota_runtime::RefreshControl>,
    pub(crate) quota_gate: crate::quota_gate::Gate,
    limits_read_at: i64,
    schedule_watchers: HashSet<u64>,
    review_watchers: HashSet<u64>,
    attention_watchers: HashSet<u64>,
    native_run_gates: HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>,
}

#[cfg(test)]
#[path = "provider_quota_host_tests.rs"]
mod provider_quota_host_tests;

#[cfg(test)]
mod repository_tests {
    use super::*;

    #[test]
    fn unauthenticated_and_revoked_list_never_fall_back_to_owner_repository_demand() {
        let mut state = State::new(
            PathBuf::from("captured-launch-directory"),
            MetadataStore::open(Path::new(":memory:")).unwrap(),
            Launchers::discover(),
        );
        state
            .repository
            .register(crate::session_repository::Binding {
                id: "target".into(),
                incarnation: [1; 16],
                directory: PathBuf::from("captured-launch-directory"),
            });
        assert!(state.repository_view_requested(99).is_err());
        let (events, _received) = mpsc::channel(8);
        let (cancelled, _cancel) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events,
                cancelled,
                authority: crate::caller::Authority::Session {
                    id: "expired-provider".into(),
                    scope_id: "expired-scope".into(),
                },
            },
        );
        assert!(state.repository_view_requested(1).is_err());
        let (output, _received) = mpsc::channel(8);
        assert!(state.command(1, Command::List, None, &output).is_err());
        assert!(state.repository_next(0).0.is_none());
        let (events, mut owner_events) = mpsc::channel(8);
        let (cancelled, _owner_cancel) = watch::channel(false);
        state.clients.insert(
            2,
            Client {
                events,
                cancelled,
                authority: crate::caller::Authority::Owner,
            },
        );
        let mut wake = state.repository_runtime();
        let cached = state.list();
        state.begin_shutdown();
        let _ = wake.try_recv();
        assert!(state.repository_view_requested(1).is_err());
        assert!(state.repository_view_requested(2).is_ok());
        assert_eq!(state.list(), cached);
        assert!(state.command(2, Command::List, None, &output).is_err());
        assert!(owner_events.try_recv().is_err());
        assert!(
            wake.try_recv().is_err(),
            "A sealed advisory read creates no new demand wake"
        );
        assert!(state.repository_next(0).0.is_none());
    }
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize> {
    ensure!(
        (10..=300).contains(&cols) && (2..=150).contains(&rows),
        "Terminal size must be 10–300 columns and 2–150 rows."
    );
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl State {
    pub fn new(workspace: PathBuf, metadata: MetadataStore, launchers: Launchers) -> Self {
        let provider_limits = usage::installed(&launchers);
        let quota_salt = nesvo_wire::random::<32>();
        let provider_quota = crate::provider_quota::Tracker::new(
            &provider_limits
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            quota_salt,
        );
        let provider_versions = launchers.pending_versions();
        let quota_gate = crate::quota_gate::Gate::new(
            quota_salt,
            &provider_limits
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
        );
        Self {
            human_control_epoch: 0,
            budget: crate::budgets::defaults(),
            event_log: None,
            lifecycle_observer: Default::default(),
            submission_updates: Vec::new(),
            caller_url: None,
            job_trigger_address: None,
            workspace,
            sessions: HashMap::new(),
            repository: Default::default(),
            repository_wakeup: None,
            cleanup_workers: Vec::new(),
            shutting_down: false,
            clients: HashMap::new(),
            reviews: Default::default(),
            metadata,
            push_queue: Default::default(),
            launchers,
            provider_versions,
            provider_limits,
            provider_quota,
            quota_contexts: crate::quota_contexts::Registry::new(quota_salt),
            quota_wakeup: None,
            quota_publications: Vec::new(),
            quota_refresh: Vec::new(),
            quota_gate,
            limits_read_at: 0,
            schedule_watchers: HashSet::new(),
            review_watchers: HashSet::new(),
            attention_watchers: HashSet::new(),
            native_run_gates: HashMap::new(),
        }
    }

    pub fn quota_reader(
        &mut self,
        program: Program,
    ) -> Option<crate::provider_quota_runtime::Reader> {
        let command = self.launchers.probe_command(program)?;
        let (sender, receiver) = mpsc::channel(1);
        self.quota_refresh
            .push(crate::provider_quota_runtime::RefreshControl {
                program,
                sender,
                in_flight: false,
                last_started: None,
            });
        Some((command, self.workspace.clone(), receiver))
    }
    pub fn codex_readers(&mut self) -> Option<mpsc::Receiver<()>> {
        let command = self.launchers.probe_command(Program::Codex)?;
        let (sender, receiver) = mpsc::channel(1);
        self.quota_contexts
            .register(
                crate::quota_contexts::ReaderSpec {
                    command,
                    directory: self.workspace.clone(),
                    home: self.codex_home(&self.workspace),
                },
                true,
            )
            .ok()?;
        self.quota_wakeup = Some(sender);
        Some(receiver)
    }
    fn codex_home(&self, directory: &Path) -> Option<PathBuf> {
        let home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .map(|home| PathBuf::from(home).join(".codex"))
            })?;
        Some(if home.is_absolute() {
            home
        } else {
            directory.join(home)
        })
    }
    pub fn next_quota_context(&mut self) -> Option<crate::quota_contexts::Read> {
        if self.shutting_down {
            return None;
        }
        self.quota_contexts
            .next(crate::event_log::monotonic_millis())
    }
    pub fn finish_quota_context(&mut self, id: &str, observation: usage::CodexObservation) {
        let ambient = self.quota_contexts.ambient() == Some(id);
        self.quota_contexts.finish(id, observation.clone());
        if ambient {
            self.observe_codex_quota(observation);
        }
        self.collect_quota_observations();
    }
    pub fn collect_quota_observations(&mut self) {
        let observations = self
            .quota_contexts
            .observations(now_millis(), crate::event_log::monotonic_millis());
        for observation in observations {
            self.retain_quota_observation(observation);
        }
        crate::quota_gate::sync(self);
    }
    pub fn retain_quota_observation(&mut self, observation: crate::job_quota::Observation) {
        if let Some(current) = self
            .quota_publications
            .iter_mut()
            .find(|current| current.source_id == observation.source_id)
        {
            if current.revision < observation.revision {
                *current = observation;
            }
        } else {
            self.quota_publications.push(observation);
        }
    }
    pub fn take_quota_observations(&mut self) -> Vec<crate::job_quota::Observation> {
        self.collect_quota_observations();
        std::mem::take(&mut self.quota_publications)
    }
    pub fn register_quota_context(&mut self, directory: PathBuf) -> Result<String> {
        ensure!(!self.shutting_down, "Host is shutting down.");
        let command = self
            .launchers
            .probe_command(Program::Codex)
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "provider_unavailable",
                    "Codex is not installed on the host",
                )
            })?;
        self.quota_contexts.register(
            crate::quota_contexts::ReaderSpec {
                command,
                home: self.codex_home(&directory),
                directory,
            },
            false,
        )
    }
    pub fn quota_context_query(&mut self, id: &str, refresh: bool) -> Result<Value> {
        ensure!(!self.shutting_down, "Host is shutting down.");
        let now = now_millis();
        let elapsed = crate::event_log::monotonic_millis();
        let view = self
            .quota_contexts
            .public_view(id, now, elapsed)
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "quota_context_not_found",
                    "Quota reader context is no longer registered",
                )
            })?;
        let request = if refresh {
            let request = self.quota_contexts.request(id, now, elapsed)?;
            if let Some(wake) = &self.quota_wakeup {
                let _ = wake.try_send(());
            }
            request
        } else {
            Value::Null
        };
        Ok(json!({"type":"providerQuota","providers":[view],"refresh":request}))
    }
    pub fn quota_launch_ready(
        &mut self,
        permit: &crate::job_quota::Permit,
        receipt: &str,
        directory: &Path,
        derived_worktree: bool,
    ) -> Result<()> {
        if self.shutting_down {
            return Err(
                crate::api_error::Error::new("host_stopping", "Host is shutting down").into(),
            );
        }
        let now = now_millis();
        let elapsed = crate::event_log::monotonic_millis();
        let directory = PathBuf::from(crate::process::display_path(directory));
        let mut spec = self
            .quota_contexts
            .spec_for_context(&permit.binding.context_id, now, elapsed)
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "quota_wait",
                    "The approved quota reader context is unavailable or changed",
                )
            })?;
        if self.launchers.probe_command(Program::Codex).as_ref() != Some(&spec.command)
            || spec.home.is_none()
            || (!derived_worktree && spec.directory != directory)
        {
            return Err(crate::api_error::Error::new(
                "quota_wait",
                "Native launch does not match the approved reader configuration",
            )
            .into());
        }
        spec.directory = directory;
        let id = if derived_worktree {
            self.quota_contexts.consume_derived(receipt, spec)?
        } else {
            self.quota_contexts.transient(spec)?
        };
        if self
            .quota_contexts
            .ready(&id, &permit.binding.account_fingerprint, now, elapsed)
        {
            return Ok(());
        }
        let _ = self.quota_contexts.request(&id, now, elapsed)?;
        if let Some(wake) = &self.quota_wakeup {
            let _ = wake.try_send(());
        }
        Err(crate::api_error::Error::new(
            "quota_wait",
            "Waiting for fresh matching configured-account quota evidence",
        )
        .into())
    }
    pub fn quota_reserve_derived_reader(&mut self, receipt: &str) -> Result<()> {
        if self.shutting_down {
            return Err(
                crate::api_error::Error::new("host_stopping", "Host is shutting down").into(),
            );
        }
        self.quota_contexts.reserve_derived(receipt)
    }
    pub fn quota_launch_done(&mut self, receipt: &str) {
        self.quota_contexts.release_derived(receipt);
    }
    pub fn quota_read_started(&mut self, program: Program) -> bool {
        if self.shutting_down {
            return false;
        }
        let now = crate::event_log::monotonic_millis();
        let Some(control) = self
            .quota_refresh
            .iter_mut()
            .find(|control| control.program == program)
        else {
            return false;
        };
        if control.in_flight
            || control
                .last_started
                .is_some_and(|at| now.saturating_sub(at) < 5000)
        {
            return false;
        }
        control.in_flight = true;
        control.last_started = Some(now);
        true
    }
    fn quota_read_finished(&mut self, program: Program) {
        if let Some(control) = self
            .quota_refresh
            .iter_mut()
            .find(|control| control.program == program)
        {
            control.in_flight = false;
        }
    }
    pub fn observe_codex_quota(&mut self, observation: usage::CodexObservation) {
        self.limits_read_at = match &observation.outcome {
            usage::ReadOutcome::Snapshot(snapshot)
                if snapshot.complete
                    && snapshot.account_id.is_some()
                    && observation.context.is_some()
                    && snapshot.ordinary_usage_allowed == Some(true)
                    && !snapshot.rate_limit_reached
                    && snapshot.spend_control_reached != Some(true)
                    && observation.fresh_at(crate::event_log::monotonic_millis(), 180_000) =>
            {
                i64::try_from(observation.started_at_ms / 1000).unwrap_or(0)
            }
            _ => 0,
        };
        self.provider_quota.apply_codex(observation);
        // The ambient display reader is not authority over another session's
        // configured context. Each armed wake checks its exact pinned reader.
        self.quota_read_finished(Program::Codex);
        self.refresh_quota_projection();
    }
    pub fn observe_claude_quota(
        &mut self,
        observation: usage::ClaudeObservation,
        started: u64,
        finished: u64,
    ) {
        self.provider_quota
            .apply_claude(observation, started, finished);
        self.quota_read_finished(Program::Claude);
        self.refresh_quota_projection();
    }
    fn quota_views(&mut self) -> Vec<crate::provider_quota::View> {
        let now = now_millis();
        let elapsed = crate::event_log::monotonic_millis();
        let mut views = self.provider_quota.view(now, elapsed);
        if let Some(id) = self.quota_contexts.ambient().map(str::to_owned)
            && let Some(view) = self.quota_contexts.view(&id, now, elapsed)
        {
            if let Some(current) = views.iter_mut().find(|view| view.program == Program::Codex) {
                *current = view;
            } else {
                views.push(view);
            }
        }
        views
    }
    fn refresh_quota_projection(&mut self) {
        for view in self.quota_views() {
            crate::quota_gate::observe_codex_view(&mut self.quota_gate, &view);
            let current = view.freshness == "fresh";
            if view.program == Program::Codex && !current {
                self.limits_read_at = 0;
            }
            let status = if view.status == "checking" {
                "checking"
            } else if current && !view.windows.is_empty() {
                "ready"
            } else {
                "unavailable"
            };
            self.update_provider_limits(
                view.program,
                status,
                if current { view.windows } else { Vec::new() },
            );
        }
    }
    fn provider_quota_query(&mut self, program: Option<Program>, refresh: bool) -> Result<Value> {
        if program == Some(Program::Shell) || (refresh && program.is_none()) {
            return Err(crate::api_error::Error::new(
                "invalid_argument",
                "Quota refresh requires a named provider",
            )
            .into());
        }
        let providers: Vec<_> = self
            .quota_views()
            .into_iter()
            .filter(|view| program.is_none_or(|program| view.program == program))
            .collect();
        if program.is_some() && providers.is_empty() {
            return Err(crate::api_error::Error::new(
                "provider_unavailable",
                "Provider is not installed on the host",
            )
            .into());
        }
        let request = if refresh {
            let program = program.ok_or_else(|| {
                crate::api_error::Error::new("invalid_argument", "Provider is required")
            })?;
            if program == Program::Codex
                && let Some(id) = self.quota_contexts.ambient().map(str::to_owned)
            {
                let request = self.quota_contexts.request(
                    &id,
                    now_millis(),
                    crate::event_log::monotonic_millis(),
                )?;
                if let Some(wake) = &self.quota_wakeup {
                    let _ = wake.try_send(());
                }
                let gate = self
                    .quota_gate
                    .view(now_millis(), crate::event_log::monotonic_millis());
                return Ok(
                    json!({"type":"providerQuota","providers":providers,"refresh":request,"gate":gate}),
                );
            }
            let revision = providers.first().map_or(0, |view| view.revision);
            let control = self
                .quota_refresh
                .iter_mut()
                .find(|control| control.program == program)
                .ok_or_else(|| {
                    crate::api_error::Error::new(
                        "unsupported",
                        "No read-only quota source is available for this provider",
                    )
                })?;
            let age = control
                .last_started
                .map(|at| crate::event_log::monotonic_millis().saturating_sub(at));
            let (status, target, delay) = if control.in_flight {
                ("pending", revision.saturating_add(1), 0)
            } else if control.sender.capacity() == 0 {
                ("queued", revision.saturating_add(1), 0)
            } else if let Some(age) = age.filter(|age| *age < 5000) {
                ("cooldown", revision, 5000 - age)
            } else {
                control.sender.try_send(()).map_err(|_| {
                    crate::api_error::Error::new("busy", "Quota reader is unavailable")
                })?;
                ("queued", revision.saturating_add(1), 0)
            };
            json!({"program":program,"state":status,"revision":target,"retryAfterMs":delay})
        } else {
            Value::Null
        };
        let gate = self
            .quota_gate
            .view(now_millis(), crate::event_log::monotonic_millis());
        Ok(json!({"type":"providerQuota","providers":providers,"refresh":request,"gate":gate}))
    }
    pub fn set_caller_url(&mut self, url: String) {
        self.caller_url = Some(url);
    }
    pub fn set_job_trigger_listener(&mut self, address: Option<String>) {
        self.job_trigger_address = address;
    }
    fn job_trigger_listener(&self) -> Value {
        json!({"enabled":self.job_trigger_address.is_some(),"address":self.job_trigger_address})
    }
    pub fn set_event_log(&mut self, service: crate::event_log::Service) {
        self.budget = service.budget();
        self.event_log = Some(service);
    }
    pub fn event_log(&self) -> Result<crate::event_log::Service> {
        self.event_log.clone().ok_or_else(|| {
            crate::api_error::Error::new("unsupported", "Host event journal is unavailable").into()
        })
    }
    /// Serialize physical launch/control for one run; never hold the State lock
    /// across native setup. Weak entries retain only currently active effects.
    pub fn native_run_permit(&mut self, run: &str) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        if run.is_empty() || run.len() > 128 || run.chars().any(char::is_control) {
            return Err(
                crate::api_error::Error::new("invalid_argument", "Invalid run identity").into(),
            );
        }
        self.native_run_gates
            .retain(|_, gate| gate.strong_count() > 0);
        let gate = self
            .native_run_gates
            .get(run)
            .and_then(std::sync::Weak::upgrade)
            .unwrap_or_else(|| {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                self.native_run_gates
                    .insert(run.into(), Arc::downgrade(&gate));
                gate
            });
        gate.try_lock_owned().map_err(|_|crate::api_error::Error::new("busy","A native run launch/control is in progress; inspect original mutations and receipts before retrying").into())
    }
    /// An explicit owner launch into a coordinator's run delegates this fresh
    /// worker through that coordinator's existing bounded native capability.
    pub fn workflow_launch_authority(
        &self,
        authority: &crate::caller::Authority,
        coordinator: Option<&str>,
    ) -> Result<crate::caller::Authority> {
        if let Some(caller) = self.actor_session(authority)? {
            if coordinator != Some(caller.info.id.as_str())
                || caller.policy.role != crate::caller::Role::Coordinator
            {
                return Err(crate::api_error::Error::new(
                    "forbidden",
                    "Only the bound coordinator can launch this run's workers",
                )
                .into());
            }
            return Ok(authority.clone());
        }
        let Some(id) = coordinator else {
            return Ok(crate::caller::Authority::Owner);
        };
        let coordinator = self
            .sessions
            .get(id)
            .filter(|session| {
                session.info.running && session.policy.role == crate::caller::Role::Coordinator
            })
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "scope_revoked",
                    "Run coordinator is not a live native coordinator; adoption is required",
                )
            })?;
        let context = coordinator.caller_context.as_ref().ok_or_else(|| {
            crate::api_error::Error::new(
                "scope_revoked",
                "Run coordinator capability is unavailable",
            )
        })?;
        Ok(crate::caller::Authority::Session {
            id: id.into(),
            scope_id: context.scope_id.clone(),
        })
    }
    pub fn coordinator_rebind_facts(
        &self,
        previous: Option<&str>,
        target: &str,
    ) -> Result<crate::workflow_coordinator::Facts> {
        use crate::workflow_coordinator::{Facts, Location};
        let previous = previous.and_then(|id| self.sessions.get(id));
        if previous.is_some_and(|s| s.info.running) {
            return Err(crate::api_error::Error::new(
                "coordinator_alive",
                "Previous coordinator is still running; recovery does not take over a live process",
            )
            .into());
        }
        if previous.is_some_and(|s| s.policy.role != crate::caller::Role::Coordinator) {
            return Err(crate::api_error::Error::new(
                "coordinator_context_missing",
                "Retained source is not a native coordinator",
            )
            .into());
        }
        let target = self
            .sessions
            .get(target)
            .filter(|s| {
                s.info.running
                    && s.policy.role == crate::caller::Role::Coordinator
                    && s.caller_context.is_some()
            })
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "session_not_found",
                    "Replacement must be a live native coordinator with a scoped capability",
                )
            })?;
        // Metadata changes neither the target's lease/draft nor native control.
        let location = |s: &Session| Location {
            directory: s.info.cwd.clone(),
            group_id: s.info.group_id.clone(),
        };
        Ok(Facts {
            target_id: target.info.id.clone(),
            target: location(target),
            previous: previous.map(location),
        })
    }
    pub fn operation_caller(&self, client_id: u64) -> Result<(String, bool)> {
        Ok(match self.caller_session(client_id)? {
            Some(id) => (format!("session:{id}"), false),
            None => ("owner".into(), true),
        })
    }
    pub fn operation_authority(&self, client_id: u64) -> Result<crate::caller::Authority> {
        self.caller_session(client_id)?;
        Ok(self
            .clients
            .get(&client_id)
            .ok_or_else(|| {
                crate::api_error::Error::new("forbidden", "Caller is not authenticated")
            })?
            .authority
            .clone())
    }
    pub fn workflow_actor(
        &self,
        client_id: u64,
        request: &mut crate::orchestration::Request,
    ) -> Result<crate::orchestration::Actor> {
        let caller = self.caller_session(client_id)?;
        if caller
            .is_some_and(|id| self.sessions[id].policy.role != crate::caller::Role::Coordinator)
            && !matches!(
                request,
                crate::orchestration::Request::Context { .. }
                    | crate::orchestration::Request::Recover { .. }
                    | crate::orchestration::Request::Report { .. }
                    | crate::orchestration::Request::Mutation { .. }
                    | crate::orchestration::Request::Inbox { .. }
                    | crate::orchestration::Request::Decision { .. }
            )
        {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Workers have access only to their own attempt context and result",
            )
            .into());
        }
        if let crate::orchestration::Request::Assign { session_id, .. } = request {
            self.authorize_automation(&self.operation_authority(client_id)?, session_id)?;
            let target = self
                .sessions
                .get(session_id)
                .filter(|s| s.info.running && s.policy.role == crate::caller::Role::Worker)
                .ok_or_else(|| {
                    crate::api_error::Error::new(
                        "session_not_found",
                        "Assignment requires a live worker process",
                    )
                })?;
            if target.controller.is_some()
                || target.human_input_dirty
                || target.pending_input.is_some()
            {
                return Err(crate::api_error::Error::new(
                    "control_busy",
                    "Cannot assign over human control, a draft or a pending submission",
                )
                .into());
            }
        }
        if let crate::orchestration::Request::Create { spec, .. } = request {
            if let Some(id) = caller {
                if spec
                    .coordinator_session_id
                    .as_ref()
                    .is_some_and(|requested| requested != id)
                {
                    return Err(crate::api_error::Error::new(
                        "forbidden",
                        "Coordinator may create runs only under its own identity",
                    )
                    .into());
                }
                spec.coordinator_session_id = Some(id.into());
            } else if let Some(id) = &spec.coordinator_session_id
                && !self.sessions.get(id).is_some_and(|session| {
                    session.info.running && session.policy.role == crate::caller::Role::Coordinator
                })
            {
                return Err(crate::api_error::Error::new(
                    "invalid_argument",
                    "Run coordinator must be a live coordinator process",
                )
                .into());
            }
        }
        let (issuer, _) = self.operation_caller(client_id)?;
        Ok(crate::orchestration::Actor {
            issuer,
            scope: caller.map_or(crate::orchestration::Scope::Owner, |id| {
                if self.sessions[id].policy.role == crate::caller::Role::Coordinator {
                    crate::orchestration::Scope::Coordinator(id.into())
                } else {
                    crate::orchestration::Scope::Worker(id.into())
                }
            }),
        })
    }
    fn can_read(&self, caller: &str, target: &str) -> bool {
        self.sessions
            .get(caller)
            .is_some_and(|session| session.policy.can_read(caller, target))
    }
    pub fn event_subject(
        &self,
        client_id: u64,
        requested: Option<String>,
    ) -> Result<Option<String>> {
        if requested
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control))
        {
            return Err(
                crate::api_error::Error::new("invalid_argument", "Invalid event subject").into(),
            );
        }
        if let Some(id) = self.caller_session(client_id)? {
            if requested
                .as_ref()
                .is_some_and(|target| !self.can_read(id, target))
            {
                return Err(crate::api_error::Error::new(
                    "forbidden",
                    "Caller cannot observe this event subject",
                )
                .into());
            }
            return Ok(requested.or_else(|| Some(id.into())));
        }
        Ok(requested)
    }
    fn emit(&self, id: Option<&str>, kind: &'static str, payload: Value) {
        if let Some(log) = &self.event_log {
            log.observe(crate::event_log::Observation {
                session_id: id.map(str::to_owned),
                kind,
                at: now_millis(),
                payload,
            });
        }
    }
    pub fn resolve_caller(&self, scope_id: &str) -> Option<([u8; 32], crate::caller::Authority)> {
        if !crate::caller::valid_scope_id(scope_id) {
            return None;
        }
        self.sessions
            .values()
            .filter(|s| s.info.running)
            .find_map(|s| {
                s.caller_context
                    .as_ref()
                    .filter(|c| c.scope_id == scope_id)
                    .map(|c| {
                        (
                            c.key,
                            crate::caller::Authority::Session {
                                id: s.info.id.clone(),
                                scope_id: c.scope_id.clone(),
                            },
                        )
                    })
            })
    }
    fn caller_session(&self, client_id: u64) -> Result<Option<&str>> {
        let client = self.clients.get(&client_id).ok_or_else(|| {
            crate::api_error::Error::new("forbidden", "Caller is not authenticated")
        })?;
        Ok(self
            .actor_session(&client.authority)?
            .map(|session| session.info.id.as_str()))
    }
    fn actor_session(&self, authority: &crate::caller::Authority) -> Result<Option<&Session>> {
        match authority {
            crate::caller::Authority::Owner => Ok(None),
            crate::caller::Authority::RunWake { .. } => Err(crate::api_error::Error::new(
                "forbidden",
                "A wake grant is valid only for its fixed coordinator input",
            )
            .into()),
            crate::caller::Authority::Session { id, scope_id } => {
                let active = self.sessions.get(id).is_some_and(|s| {
                    s.info.running
                        && s.caller_context
                            .as_ref()
                            .is_some_and(|c| c.scope_id == *scope_id)
                });
                if !active {
                    return Err(crate::api_error::Error::new(
                        "scope_revoked",
                        "Caller process capability has expired",
                    )
                    .into());
                }
                Ok(self.sessions.get(id))
            }
        }
    }
    /// Captures native authority before an admitted quota launch starts waiting.
    /// The global counter is compared only against the bound actor's own epoch:
    /// an unrelated human session does not revoke coordinatorless owner jobs.
    pub(crate) fn quota_native_authority_epoch(
        &self,
        authority: &crate::caller::Authority,
    ) -> Result<u64> {
        let before = self.human_control_epoch;
        self.quota_native_authority_ready(authority, before)?;
        Ok(before)
    }
    pub(crate) fn quota_native_authority_ready(
        &self,
        authority: &crate::caller::Authority,
        before: u64,
    ) -> Result<()> {
        if self.shutting_down {
            return Err(
                crate::api_error::Error::new("host_stopping", "Host is shutting down").into(),
            );
        }
        if let Some(actor) = self.actor_session(authority)? {
            if actor.controller.is_some() || actor.human_control_epoch > before {
                return Err(crate::api_error::Error::new(
                    "control_busy",
                    "Human takeover of the coordinator requires deliberate fresh launch intent",
                )
                .into());
            }
            if actor.human_input_dirty {
                return Err(crate::api_error::Error::new(
                    "unsafe_draft",
                    "Coordinator editor needs deliberate reconciliation before another automated launch",
                )
                .into());
            }
        }
        Ok(())
    }
    pub fn authorize_automation(
        &self,
        authority: &crate::caller::Authority,
        target: &str,
    ) -> Result<()> {
        if let crate::caller::Authority::RunWake { id, scope_id } = authority {
            let caller = self.actor_session(&crate::caller::Authority::Session {
                id: id.clone(),
                scope_id: scope_id.clone(),
            })?;
            if target == id
                && caller.is_some_and(|s| s.policy.role == crate::caller::Role::Coordinator)
            {
                return Ok(());
            }
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Wake input cannot control another process",
            )
            .into());
        }
        let Some(session) = self.actor_session(authority)? else {
            return Ok(());
        };
        if !session.policy.can_control(target) {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Automation requires an explicit child capability",
            )
            .into());
        }
        Ok(())
    }
    pub fn wake_authority(
        &self,
        source: &crate::caller::Authority,
        coordinator: &str,
    ) -> Result<crate::caller::Authority> {
        match self.workflow_launch_authority(source, Some(coordinator))? {
            crate::caller::Authority::Session { id, scope_id } => {
                Ok(crate::caller::Authority::RunWake { id, scope_id })
            }
            _ => Err(crate::api_error::Error::new(
                "coordinator_required",
                "Wake requires a live coordinator capability",
            )
            .into()),
        }
    }
    pub fn check_wake_priority(
        &self,
        source: &crate::caller::Authority,
        coordinator: &str,
        before: u64,
    ) -> Result<()> {
        self.wake_authority(source, coordinator)?;
        let session = self.sessions.get(coordinator).ok_or_else(|| {
            crate::api_error::Error::new("scope_revoked", "Coordinator no longer exists")
        })?;
        if self.shutting_down {
            return Err(
                crate::api_error::Error::new("host_stopping", "Host is shutting down").into(),
            );
        }
        if session.controller.is_some() || session.human_control_epoch > before {
            return Err(crate::api_error::Error::new(
                "control_busy",
                "Human takeover pauses coordinator wakes until a deliberate enable",
            )
            .into());
        }
        if session.human_input_dirty {
            return Err(crate::api_error::Error::new(
                "unsafe_draft",
                "Coordinator editor needs deliberate reconciliation",
            )
            .into());
        }
        Ok(())
    }
    pub fn wake_attention_events(&self, sessions: &[String]) -> Vec<crate::event_log::Observation> {
        sessions
            .iter()
            .filter_map(|id| self.sessions.get(id))
            .map(|s| crate::event_log::Observation {
                session_id: Some(s.info.id.clone()),
                kind: "agent.attention",
                at: now_millis(),
                payload: s.wake_attention_payload(),
            })
            .collect()
    }
    pub fn normalize_launch_intent(
        &self,
        authority: &crate::caller::Authority,
        spec: &mut crate::jobs::LaunchSpec,
    ) -> Result<()> {
        let Some(session) = self.actor_session(authority)? else {
            return Ok(());
        };
        if spec.claude_quota_capture.is_some() && !spec.claude_quota_owner_selected {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Only the owner may select a declared Claude quota display profile",
            )
            .into());
        }
        if spec.resume.is_some() {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Only the owner may resume an exact provider conversation",
            )
            .into());
        }
        if spec.allowed_nesvo_tools.is_some() || spec.child_allowed_nesvo_tools.is_some() {
            return Err(crate::api_error::Error::new("forbidden", "Only owner launch may add native tool permissions; children do not inherit these additions").into());
        }
        if session.policy.role != crate::caller::Role::Coordinator
            || spec.role != crate::caller::Role::Worker
            || spec
                .parent_session_id
                .as_ref()
                .is_some_and(|id| id != &session.info.id)
        {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Coordinator may create worker children only under its own identity",
            )
            .into());
        }
        spec.parent_session_id = Some(session.info.id.clone());
        if spec.harness.is_none() {
            spec.harness = Some(session.harness_enabled);
        }
        Ok(())
    }
    pub fn resolve_launch(
        &self,
        authority: &crate::caller::Authority,
        spec: &mut crate::jobs::LaunchSpec,
    ) -> Result<PathBuf> {
        self.normalize_launch_intent(authority, spec)?;
        if let Some(session) = self.actor_session(authority)? {
            if !session.policy.can_spawn() {
                return Err(crate::api_error::Error::new(
                    "busy",
                    "Coordinator child capability capacity is exhausted",
                )
                .into());
            }
            let root = working_directory(&self.workspace, Some(&session.info.cwd))?;
            let target = working_directory(&root, spec.cwd.as_deref())?;
            if !target.starts_with(&root)
                || spec
                    .group_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != session.info.group_id.as_ref())
            {
                return Err(crate::api_error::Error::new(
                    "forbidden",
                    "Child launch must stay within the coordinator workspace and group",
                )
                .into());
            }
            spec.cwd = Some(crate::process::display_path(&target));
            spec.group_id = session.info.group_id.clone();
        }
        self.validate_launch(spec)
    }
    pub fn resolve_task_launch(
        &self,
        authority: &crate::caller::Authority,
        spec: &mut crate::jobs::LaunchSpec,
        tools: Option<&[String]>,
    ) -> Result<PathBuf> {
        let directory = self.resolve_launch(authority, spec)?;
        self.task_tool_grant(authority, spec, tools)?;
        Ok(directory)
    }
    fn task_tool_grant(
        &self,
        authority: &crate::caller::Authority,
        spec: &crate::jobs::LaunchSpec,
        selected: Option<&[String]>,
    ) -> Result<Option<crate::tool_permissions::Grant>> {
        let parent = self.actor_session(authority)?;
        if let Some(tools) = selected {
            crate::tool_permissions::validate(tools)?;
            if spec.program != Program::Claude || spec.harness != Some(true) {
                return Err(crate::api_error::Error::new("unsupported", "Task native tools require a supported Claude harness launch, including an explicit empty selection").into());
            }
            if let Some(parent) = parent {
                let policy = parent
                    .caller_context
                    .as_ref()
                    .map_or(&[][..], |c| c.child_tools());
                if tools.iter().any(|tool| !policy.contains(tool)) {
                    return Err(crate::api_error::Error::new("forbidden", "Task native tools must be a subset of the coordinator's immutable owner child policy").into());
                }
            }
        }
        if let Some(parent) = parent {
            if spec.program == Program::Claude && spec.harness == Some(true) {
                let policy = parent
                    .caller_context
                    .as_ref()
                    .map_or(&[][..], |c| c.child_tools());
                return Ok(Some(crate::tool_permissions::Grant::child(
                    selected.unwrap_or(policy),
                    parent.info.id.clone(),
                )));
            }
            Ok(None)
        } else {
            Ok(selected.map(crate::tool_permissions::Grant::owner))
        }
    }
    pub fn launch_authorized(
        &mut self,
        authority: &crate::caller::Authority,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
        reserved: &str,
        tools: Option<&[String]>,
    ) -> Result<String> {
        let mut check = spec.clone();
        self.normalize_launch_intent(authority, &mut check)?;
        let parent = self
            .actor_session(authority)?
            .map(|session| session.info.id.clone());
        if let Some(parent) = &parent
            && !self.sessions[parent].policy.can_spawn()
        {
            return Err(crate::api_error::Error::new(
                "busy",
                "Coordinator child capability capacity is exhausted",
            )
            .into());
        }
        let grant = self.task_tool_grant(authority, &check, tools)?;
        let id = self.launch_reserved(&check, events, reserved, grant)?;
        if let Some(parent) = parent
            && let Some(session) = self.sessions.get_mut(&parent)
        {
            session.policy.grant_created_child(id.clone());
        }
        self.broadcast_list();
        Ok(id)
    }
    pub fn authorize(&self, client_id: u64, command: &Command) -> Result<()> {
        let Some(caller) = self.caller_session(client_id)? else {
            return Ok(());
        };
        let target = match command {
            Command::Workflow { request } => {
                return self
                    .workflow_actor(client_id, &mut request.clone())
                    .map(|_| ());
            }
            Command::CreateOperation { spec, .. } => {
                let mut spec = spec.clone();
                return self
                    .normalize_launch_intent(&self.operation_authority(client_id)?, &mut spec);
            }
            Command::SendOperation { session_id, .. }
            | Command::InterruptOperation { session_id, .. }
            | Command::StopOperation { session_id, .. } => {
                return self
                    .authorize_automation(&self.operation_authority(client_id)?, session_id);
            }
            Command::GetOperation { .. } | Command::WaitOperation { .. } => return Ok(()),
            Command::UnsubscribeEvents => return Ok(()),
            Command::ReadEvents { session_id, .. }
            | Command::SubscribeEvents { session_id, .. } => {
                if session_id
                    .as_ref()
                    .is_none_or(|id| self.can_read(caller, id))
                {
                    return Ok(());
                }
                None
            }
            Command::List | Command::GetCapabilities => return Ok(()),
            Command::GetSession { session_id } | Command::ReadSession { session_id, .. } => {
                Some(session_id.as_str())
            }
            Command::GetDiagnostics {
                session_id: Some(session_id),
            } => Some(session_id.as_str()),
            Command::GetDiff {
                session_id: Some(session_id),
                directory: None,
                review_id: None,
                ..
            } => Some(session_id.as_str()),
            _ => None,
        };
        if target.is_none_or(|target| !self.can_read(caller, target)) {
            return Err(crate::api_error::Error::new(
                "forbidden",
                "Caller capability does not permit this operation or target",
            )
            .into());
        }
        Ok(())
    }
    pub fn provider_version(&mut self, version: crate::launchers::Version) {
        if let Some(current) = self
            .provider_versions
            .iter_mut()
            .find(|v| v.program == version.program)
        {
            *current = version;
        }
    }
    pub fn provider_probes_pending(&self) -> bool {
        self.provider_versions
            .iter()
            .any(|version| version.status == "checking")
    }
    fn codex_hooks_available(&self) -> bool {
        self.provider_versions.iter().any(|version| {
            version.program == Program::Codex
                && version.status == "ready"
                && version
                    .version
                    .as_deref()
                    .is_some_and(crate::codex_context::supported)
        })
    }
    fn lifecycle_hooks_available(&self, program: Program) -> bool {
        match program {
            Program::Claude => true,
            Program::Codex => self.codex_hooks_available(),
            Program::Gemini => self.gemini_gate().ready,
            Program::Shell => false,
        }
    }
    fn expire_unobserved_resumes(&mut self) {
        let expired: Vec<String> = self
            .sessions
            .iter_mut()
            .filter_map(|(id, session)| {
                let observed = session.agent_context.is_some() && lifecycle_eligible(session);
                let running = session.info.running;
                let elapsed = session
                    .elapsed_at_exit
                    .unwrap_or_else(|| session.started.elapsed());
                (!observed && session.resume.as_mut()?.expire(running, elapsed)).then(|| id.clone())
            })
            .collect();
        for id in &expired {
            if let Err(error) = self.persist_session(&self.sessions[id]) {
                eprintln!("Could not persist the conversation identity: {error}");
            }
        }
        if !expired.is_empty() {
            self.broadcast_list();
        }
    }
    fn gemini_gate(&self) -> crate::gemini_adapter::Gate {
        crate::gemini_adapter::gate(
            self.provider_versions
                .iter()
                .find(|version| version.program == Program::Gemini),
        )
    }

    fn update_provider_limits(
        &mut self,
        program: Program,
        status: &'static str,
        windows: Vec<LimitWindow>,
    ) {
        let Some(index) = self
            .provider_limits
            .iter()
            .position(|limit| limit.id == program)
        else {
            return;
        };
        if self.provider_limits[index].status == status
            && self.provider_limits[index].windows == windows
        {
            return;
        }
        self.provider_limits[index].status = status;
        self.provider_limits[index].windows = windows;
        let event = self.capabilities_event();
        for id in self.clients.keys() {
            self.send(*id, event.clone());
        }
    }

    fn capabilities_event(&self) -> Value {
        let mut event = json!({"type":"capabilities", "buildId":env!("NESVO_BUILD_ID"), "version":env!("CARGO_PKG_VERSION"), "workspace":crate::process::display_path(&self.workspace),
            "hostId":self.metadata.host_id, "pushNotifications":true, "diagnostics":true, "sessionQueries":true, "programs":self.launchers.capabilities(), "directoryBrowser":true, "gitDiff":true, "advancedLaunch":true, "schedules":true, "quotaWake":true, "attention":true, "autoTitles":true, "templates":true, "recovery":true,
            "providerLimits":self.provider_limits});
        event["providerQuotaObservations"] = true.into();
        event["providerQuotaContexts"] = true.into();
        event["quotaGate"] = true.into();
        event["jobQuotaAdmission"] = self.event_log.is_some().into();
        event["durableQuotaWake"] = self.event_log.is_some().into();
        event["domainEvents"] = self.event_log.is_some().into();
        event["operationReceipts"] = self.event_log.is_some().into();
        event["promptReceipts"] = self.event_log.is_some().into();
        event["controlReceipts"] = self.event_log.is_some().into();
        event["sessionLineage"] = true.into();
        event["conversationResume"] = true.into();
        event["attentionInbox"] = self.event_log.is_some().into();
        event["decisions"] = self.event_log.is_some().into();
        event["jobPages"] = self.event_log.is_some().into();
        event["coordinatorScopes"] = true.into();
        event["workflowAttempts"] = self.event_log.is_some().into();
        event["workflowInbox"] = self.event_log.is_some().into();
        event["workflowDecisions"] = self.event_log.is_some().into();
        event["hostBudgets"] = self.event_log.is_some().into();
        event["runBudgets"] = self.event_log.is_some().into();
        event["runDrain"] = self.event_log.is_some().into();
        event["runControls"] = self.event_log.is_some().into();
        event["runLaunch"] = self.event_log.is_some().into();
        event["runDelivery"] = self.event_log.is_some().into();
        event["runExecutor"] = self.event_log.is_some().into();
        event["runWakes"] = self.event_log.is_some().into();
        event["runCheckpoints"] = self.event_log.is_some().into();
        event["runRecovery"] = self.event_log.is_some().into();
        event["runCoordinatorRecovery"] = self.event_log.is_some().into();
        event["runConstraints"] = self.event_log.is_some().into();
        event["sessionHarness"] = true.into();
        event["sessionToolPermissions"] = true.into();
        event["childToolPolicy"] = true.into();
        event["sessionModelProfiles"] = true.into();
        event["claudeQuotaCapture"] = true.into();
        event["taskNativeToolProfiles"] = true.into();
        event["durableJobs"] = true.into();
        event["jobPrechecks"] = true.into();
        event["jobPrecheckGenerations"] = true.into();
        event["jobCancellation"] = true.into();
        event["jobAttempts"] = true.into();
        event["jobRetries"] = true.into();
        event["jobExecutionTimeouts"] = true.into();
        event["jobLaunchReconciliation"] = true.into();
        event["jobExternalTriggers"] = true.into();
        event["jobTriggerProviders"] = json!(["webhook", "github"]);
        event["jobTriggerListener"] = self.job_trigger_listener();
        event["jobRetryKinds"] = json!(["launchNoEffect"]);
        event["jobScheduleKinds"] = json!(["once", "cron", "rrule", "external"]);
        event["launchProfileSupport"] =
            crate::launch_profile::capabilities(&self.provider_versions);
        event["workflowPlans"] = true.into();
        event["reviews"] = true.into();
        event["files"] = true.into();
        event["notes"] = true.into();
        event["worktrees"] = crate::worktrees::available().into();
        event["workflowTemplates"] = crate::workflow_templates::available().into();
        event["workflowHostChecks"] = (self.event_log.is_some()
            && crate::workflow_templates::available()
            && crate::worktrees::available())
        .into();
        event["projects"] = crate::projects::available().into();
        event["git"] = true.into();
        event
    }

    pub fn send(&self, client_id: u64, event: Value) {
        let Some(event) = self.project_event(client_id, event) else {
            return;
        };
        if let Some(client) = self.clients.get(&client_id)
            && client.events.try_send(event).is_err()
        {
            let _ = client.cancelled.send(true);
        }
    }

    fn respond(&self, client_id: u64, mut event: Value, request_id: Option<&str>) {
        if let Some(request_id) = request_id {
            event["requestId"] = request_id.into();
        }
        self.send(client_id, event);
    }

    fn persist_session(&self, session: &Session) -> Result<()> {
        self.metadata.save_recovery(
            &session.info.id,
            &crate::jobs::LaunchSpec {
                name: session.info.name.clone(),
                cwd: Some(session.info.cwd.clone()),
                group_id: session.info.group_id.clone(),
                parent_session_id: session.info.parent_session_id.clone(),
                role: session.policy.role,
                harness: session.harness_enabled.then_some(true),
                model: session.model_selection.model.clone(),
                effort: session.model_selection.effort.clone(),
                program: session.info.program,
                auto_title: session.auto_title,
                muted: session.attention.muted,
                resume: crate::resume::recorded(
                    session.info.program,
                    session.conversation_identity.as_ref(),
                    session.resume.as_ref(),
                ),
                ..Default::default()
            },
        )
    }
    fn recovery_event(&self, offset: usize) -> Result<Value> {
        let records: Vec<_> = self
            .metadata
            .recoveries()?
            .into_iter()
            .filter(|r| {
                !self
                    .sessions
                    .contains_key(r["id"].as_str().unwrap_or_default())
            })
            .collect();
        let total = records.len();
        let mut page = Vec::new();
        let mut size = 0;
        for record in records.into_iter().skip(offset) {
            let bytes = serde_json::to_vec(&record)?.len() + 1;
            if size + bytes > 48 * 1024 {
                break;
            }
            size += bytes;
            page.push(record);
        }
        let next = offset.saturating_add(page.len());
        Ok(
            json!({"type":"recovery","records":page,"nextOffset":if next < total {Some(next)} else {None}}),
        )
    }

    fn repository_visible(&self) -> HashMap<u64, HashSet<String>> {
        self.clients
            .iter()
            .filter_map(|(id, client)| {
                if client.events.is_closed() || *client.cancelled.borrow() {
                    return None;
                }
                let caller = self.caller_session(*id).ok()?;
                Some((
                    *id,
                    self.sessions
                        .keys()
                        .filter(|target| caller.is_none_or(|caller| self.can_read(caller, target)))
                        .cloned()
                        .collect(),
                ))
            })
            .collect()
    }

    pub(crate) fn repository_runtime(&mut self) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::channel(1);
        self.repository_wakeup = Some(sender);
        receiver
    }

    fn repository_notify(&self) {
        if let Some(wakeup) = &self.repository_wakeup {
            let _ = wakeup.try_send(());
        }
    }

    pub(crate) fn repository_view_requested(&mut self, client_id: u64) -> Result<()> {
        // An expired/unknown scoped client never falls back to owner demand.
        self.caller_session(client_id)?;
        // This advisory hook cannot revive work during drain. State::command
        // retains its existing independent shutdown refusal for all commands.
        if self.shutting_down {
            return Ok(());
        }
        if let Some(visible) = self.repository_visible().remove(&client_id) {
            self.repository.demand(
                client_id,
                &visible.into_iter().collect::<Vec<_>>(),
                crate::event_log::monotonic_millis(),
            );
            self.repository_notify();
        }
        Ok(())
    }

    pub(crate) fn repository_next(
        &mut self,
        now: u64,
    ) -> (Option<crate::session_repository::Work>, Option<u64>) {
        let visible = self.repository_visible();
        self.repository.retain_authorized(&visible);
        if self.repository.expire(now) {
            self.broadcast_list();
        }
        (self.repository.claim(), self.repository.next_expiry())
    }

    pub(crate) fn repository_finished(
        &mut self,
        work: &crate::session_repository::Work,
        outcome: crate::git_repository::Outcome,
        wall: u64,
        now: u64,
    ) {
        if self.shutting_down {
            return;
        }
        let visible = self.repository_visible();
        self.repository.retain_authorized(&visible);
        if self.repository.finish(work, outcome, wall, now) {
            self.broadcast_list();
        }
    }

    pub fn list(&self) -> Value {
        self.list_scoped(None)
    }
    fn list_scoped(&self, caller: Option<&str>) -> Value {
        let mut snapshot = self.baseline_with_candidate(caller, None);
        let incarnations = self
            .sessions
            .iter()
            .map(|(id, session)| (id.clone(), session.repository_binding.incarnation))
            .collect();
        self.repository.enrich(
            &mut snapshot,
            &incarnations,
            crate::event_log::monotonic_millis(),
        );
        snapshot
    }
    fn baseline_with_candidate(&self, caller: Option<&str>, candidate: Option<&Session>) -> Value {
        let mut sessions: Vec<&Session> = self.sessions.values().chain(candidate).collect();
        sessions.retain(|s| caller.is_none_or(|id| self.can_read(id, &s.info.id)));
        sessions.sort_by(|left, right| left.info.created_at.cmp(&right.info.created_at));
        let projections: Vec<_> = sessions
            .iter()
            .map(|s| (s.info.group_id.as_deref(), s.current_attention()))
            .collect();
        let mut visible_groups = HashSet::new();
        if caller.is_some() {
            for session in &sessions {
                let mut parent = session.info.group_id.as_deref();
                while let Some(id) = parent {
                    if !visible_groups.insert(id) {
                        break;
                    }
                    parent = self
                        .metadata
                        .groups()
                        .iter()
                        .find(|g| g.id == id)
                        .and_then(|g| g.parent_id.as_deref());
                }
            }
        }
        let groups: Vec<_> = self
            .metadata
            .groups()
            .iter()
            .filter(|g| caller.is_none() || visible_groups.contains(g.id.as_str()))
            .cloned()
            .collect();
        let (summary, by_group) = crate::attention_projection::rollup(
            &groups,
            projections.iter().map(|(id, p)| (*id, p)),
        );
        let groups: Vec<_> = groups
            .iter()
            .map(|g| {
                let mut value = json!(g);
                value["attentionSummary"] = json!(by_group.get(&g.id));
                value
            })
            .collect();
        let sessions: Vec<Value> = sessions
            .into_iter()
            .map(|session| {
                let mut info =
                    serde_json::to_value(&session.info).expect("Session metadata serializes");
                info["role"]=json!(session.policy.role);
                info["launchProfile"]=session.model_selection.diagnostic();
                info["harness"]=json!(session.caller_context.as_ref().map(|context|context.configuration(session.harness_enabled)));
                info["attention"] = json!(session.attention.event);
                info["currentAttention"] = json!(session.current_attention());
                info["muted"] = json!(session.attention.muted);
                info["autoTitle"] = json!(session.auto_title);
                info["controllerId"] =
                    json!(session.controller.as_ref().map(|lease| lease.client_id));
                info["uptimeSeconds"] = json!(
                    session
                        .elapsed_at_exit
                        .unwrap_or_else(|| session.started.elapsed())
                        .as_secs()
                );
                info["status"] = json!(session.status.status());
                info["readiness"] = json!(session.readiness.snapshot());
                info["lifecycle"] = json!({"process":{"running":session.info.running,"pid":session.pty.process_id()},
                    "agent":session.status.agent_projection(),"turn":session.turn.snapshot(session.elapsed_at_exit.unwrap_or_else(||session.started.elapsed())),"task":null});
                // Legacy v2 clients accept screen evidence and ignore extra fields.
                if session.status.status().source == crate::status::StatusSource::Hook {
                    info["status"]["source"] = json!("screen");
                    info["status"]["evidence"] = json!("hook");
                }
                if session.status.status().source == crate::status::StatusSource::Program {
                    info["status"]["source"] = json!("screen");
                    info["status"]["confirmedSource"] = json!("osc7501");
                }
                info["programStatus"] = session.program_status.summary();
                if matches!(
                    info["attention"]["source"].as_str(),
                    Some("hook" | "program")
                ) {
                    info["attention"]["source"] = json!("screen");
                }
                info["rateLimited"] = json!(session.status.rate_limited());
                info["wakeAt"] = json!(session.wake_at);
                info["quotaWakeId"] = json!(session.quota_wake.as_ref().map(|arm| &arm.id));
                info["quotaUnverified"] = self.quota_gate.unverified(&session.info.id);
                if let Some(gate) = &session.resume {
                    info["resume"] = json!(gate.verification());
                }
                info
            })
            .collect();
        json!({"type":"sessions", "sessions":sessions, "groups":groups, "attentionSummary":summary,"revision":self.metadata.revision()})
    }

    pub fn broadcast_list(&mut self) {
        let list = self.list();
        let mut recipients = 0;
        for id in self.clients.keys() {
            let Some(event) = self.project_event(*id, list.clone()) else {
                continue;
            };
            if let Some(client) = self.clients.get(id) {
                if client.events.try_send(event).is_ok() {
                    recipients += 1;
                } else {
                    let _ = client.cancelled.send(true);
                }
            }
        }
        let now = std::time::Instant::now();
        for session in self.sessions.values_mut() {
            session.status_latency.published(now, recipients);
        }
    }

    fn project_event(&self, client_id: u64, event: Value) -> Option<Value> {
        let Ok(Some(id)) = self.caller_session(client_id) else {
            return Some(
                if self.clients.get(&client_id).is_some_and(|c| {
                    matches!(c.authority, crate::caller::Authority::Session { .. })
                }) && event["type"] == "sessions"
                {
                    let mut empty = json!({"type":"sessions","sessions":[],"groups":[],"revision":self.metadata.revision()});
                    if let Some(request) = event.get("requestId") {
                        empty["requestId"] = request.clone();
                    }
                    empty
                } else if self.clients.get(&client_id).is_some_and(|c| {
                    matches!(c.authority, crate::caller::Authority::Session { .. })
                }) && event["type"] != "error"
                {
                    json!({"type":"error","code":"scope_revoked","message":"Caller process capability has expired"})
                } else {
                    event
                },
            );
        };
        if event
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|target| !self.can_read(id, target))
        {
            return None;
        }
        if event["type"] == "sessions" {
            let mut projection = self.list_scoped(Some(id));
            if let Some(request) = event.get("requestId") {
                projection["requestId"] = request.clone();
            }
            return Some(projection);
        }
        if event["type"] == "capabilities" {
            let mut event = event;
            let role = self.sessions.get(id)?.policy.role;
            let permissions = if role == crate::caller::Role::Coordinator {
                vec![
                    "session:read",
                    "child:create",
                    "child:read",
                    "child:send",
                    "child:interrupt",
                    "child:stop",
                    "run:plan",
                    "run:assign",
                    "run:validate",
                    "run:inbox",
                    "run:decisions",
                    "decision:answer-coordinator",
                ]
            } else {
                vec![
                    "session:read",
                    "attempt:context",
                    "attempt:report",
                    "inbox:own",
                    "inbox:send-coordinator",
                    "decision:own",
                    "decision:ask",
                    "decision:withdraw",
                ]
            };
            event["caller"] = json!({"sessionId":id,"role":role,"permissions":permissions,"expires":"processExit"});
            if let Some(session) = self.sessions.get(id) {
                event["workspace"] = session.info.cwd.clone().into();
            }
            return Some(event);
        }
        Some(event)
    }

    // The status tick never sends input. The durable quota runtime owns wakes.
    fn wake_after_reset(&mut self) -> bool {
        let now = crate::event_log::monotonic_millis();
        let mut changed = false;
        for session in self.sessions.values_mut() {
            if session
                .quota_wake
                .as_ref()
                .is_some_and(|arm| now > arm.proof.reset_elapsed_ms.saturating_add(300_000))
            {
                session.wake_at = None;
                changed = true;
            }
        }
        changed
    }

    pub fn next_push(&mut self) -> Option<crate::notifications::Job> {
        while let Some(job) = self.push_queue.pop_front() {
            if (job.item.is_some()
                || self.sessions.get(&job.session_id).is_some_and(|s| {
                    !s.attention.muted
                        && s.attention
                            .event
                            .as_ref()
                            .is_some_and(|e| e.unread && e.sequence == job.sequence)
                }))
                && self
                    .metadata
                    .push_tokens()
                    .is_ok_and(|tokens| tokens.contains(&job.token))
            {
                return Some(job);
            }
        }
        None
    }

    fn refresh_status(&mut self) {
        let now = now_millis();
        self.refresh_quota_projection();
        let mut changed = self.wake_after_reset();
        let mut renamed = Vec::new();
        let mut alerts = Vec::new();
        for session in self.sessions.values_mut() {
            changed |= session.status.refresh(now);
            changed |= session
                .turn
                .observe_idle(session.status.status().state, session.started.elapsed());
            changed |= session.readiness.observe(
                session.status.status(),
                session.status.rule_reason(),
                session.started.elapsed(),
            );
            if let Some(log) = &self.event_log {
                let payload = session.wake_attention_payload();
                session.wake_attention.offer(
                    log,
                    &session.info.id,
                    payload,
                    now,
                    std::time::Instant::now(),
                );
            }
            changed |= std::mem::take(&mut session.status_projection_dirty);
            if session.auto_title
                && let Some(title) = &session.titles.title
                && session.info.name != *title
            {
                session.info.name = title.clone();
                renamed.push(session.info.id.clone());
                changed = true;
            }
            let attention_changed = session
                .attention
                .observe(session.status.status(), session.status.rate_limited());
            if std::mem::take(&mut session.attention_dirty) | attention_changed {
                changed = true;
                if !session.attention.muted
                    && session.info.program != Program::Shell
                    && let Some(event) = &session.attention.event
                {
                    alerts.push((session.info.id.clone(), event.clone()));
                }
            }
        }
        if !alerts.is_empty() {
            self.notify_attention("session", None);
            match self.metadata.push_tokens() {
                Ok(tokens) => {
                    for (id, event) in alerts {
                        for token in &tokens {
                            if self.push_queue.len() < 64 {
                                self.push_queue.push_back(crate::notifications::Job::new(
                                    token.clone(),
                                    self.metadata.host_id.clone(),
                                    id.clone(),
                                    event.clone(),
                                ));
                            }
                        }
                    }
                }
                Err(_) => eprintln!("Could not load notification registrations"),
            }
        }
        for id in renamed {
            if let Some(session) = self.sessions.get(&id)
                && let Err(error) = self.persist_session(session)
            {
                eprintln!("Could not persist session title: {error}");
            }
        }
        if changed {
            self.broadcast_list();
        }
    }

    fn control_event(&self, session_id: &str, recipient: u64) -> Option<Value> {
        self.sessions.get(session_id).map(|session| {
            let mut event = json!({"type":"control", "sessionId":session_id,
                "controllerId":session.controller.as_ref().map(|lease| lease.client_id),
                "cols":session.info.cols, "rows":session.info.rows});
            if let Some(lease) = &session.controller
                && lease.client_id == recipient
            {
                event["leaseId"] = lease.id.clone().into();
            }
            event
        })
    }

    fn broadcast_control(&self, session_id: &str) {
        for id in self.clients.keys() {
            if let Some(event) = self.control_event(session_id, *id) {
                self.send(*id, event);
            }
        }
    }

    fn release_all(&mut self, client_id: u64) {
        let mut changed = Vec::new();
        for session in self.sessions.values_mut() {
            if session
                .controller
                .as_ref()
                .is_some_and(|lease| lease.client_id == client_id)
            {
                session.controller = None;
                changed.push(session.info.id.clone());
            }
        }
        for session_id in changed {
            self.broadcast_control(&session_id);
        }
    }

    pub fn disconnect(&mut self, client_id: u64) {
        self.clients.remove(&client_id);
        self.repository.disconnect(client_id);
        self.repository_notify();
        self.schedule_watchers.remove(&client_id);
        self.review_watchers.remove(&client_id);
        self.attention_watchers.remove(&client_id);
        for session in self.sessions.values_mut() {
            session.subscribers.remove(&client_id);
        }
        self.release_all(client_id);
    }

    fn valid_group(&self, group_id: Option<&str>) -> Result<()> {
        if let Some(id) = group_id {
            ensure!(self.metadata.contains(id), "Group does not exist.");
        }
        Ok(())
    }

    fn send_replay(&self, client_id: u64, session_id: &str, original: bool) {
        if let Some(session) = self.sessions.get(session_id) {
            self.send_history(client_id, session_id, &session.backlog, original);
        }
    }

    fn send_history(&self, client_id: u64, session_id: &str, backlog: &str, original: bool) {
        let filtered;
        let history = if original {
            backlog
        } else {
            filtered = replay_history(backlog);
            &filtered
        };
        for data in output_chunks(history) {
            let mut event =
                json!({"type":"output", "sessionId":session_id, "data":data, "replay":true});
            if original {
                event["allowResponses"] = true.into();
            }
            self.send(client_id, event);
        }
    }

    fn subscribe(&mut self, client_id: u64, session_id: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Session no longer exists."))?;
        session.subscribers.insert(client_id);
        let event = json!({"type":"subscribed", "sessionId":session_id, "cols":session.info.cols, "rows":session.info.rows});
        self.send(client_id, event);
        if let Some(event) = self.control_event(session_id, client_id) {
            self.send(client_id, event);
        }
        self.send_replay(client_id, session_id, false);
        Ok(())
    }

    fn acquire(
        &mut self,
        client_id: u64,
        session_id: &str,
        cols: u16,
        rows: u16,
        take_over: bool,
        legacy: bool,
    ) -> Result<()> {
        let size = terminal_size(cols, rows)?;
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session no longer exists."))?;
        ensure!(
            legacy || session.info.running,
            "This shell has exited. Open it as a viewer."
        );
        ensure!(
            take_over
                || session
                    .controller
                    .as_ref()
                    .is_none_or(|lease| lease.client_id == client_id),
            "Another device is controlling this session. Request takeover explicitly."
        );
        if legacy {
            self.release_all(client_id);
            for session in self.sessions.values_mut() {
                session.subscribers.remove(&client_id);
            }
        }
        let session = self.sessions.get_mut(session_id).unwrap();
        if let Some(pending) = &session.pending_input {
            pending.canceled.send_replace(true);
        }
        if session.info.running {
            session.pty.resize(size)?;
        }
        session.info.cols = cols;
        session.info.rows = rows;
        session.status.resize(rows, cols);
        session.subscribers.insert(client_id);
        session.controller = Some(ControlLease {
            client_id,
            id: hex::encode(crate::wire::random::<16>()),
            legacy,
        });
        self.human_control_epoch = self.human_control_epoch.saturating_add(1);
        session.human_control_epoch = self.human_control_epoch;
        // Taking control is deliberate human priority, even without typing.
        // Releasing that lease must not reactivate an earlier automatic wake.
        session.wake_at = None;
        let first_controller = !session.has_been_attached;
        session.has_been_attached = true;
        if legacy {
            self.send(
                client_id,
                json!({"type":"attached", "sessionId":session_id}),
            );
        } else if first_controller {
            // Subscription can observe startup queries before control is granted.
            // Reset/replay only the first controller after it receives its lease.
            self.send(
                client_id,
                json!({"type":"subscribed", "sessionId":session_id, "cols":cols, "rows":rows}),
            );
        }
        self.broadcast_control(session_id);
        if legacy || first_controller {
            self.send_replay(client_id, session_id, first_controller);
        }
        Ok(())
    }

    pub fn validate_launch(&self, spec: &crate::jobs::LaunchSpec) -> Result<PathBuf> {
        if let Some(options) = &spec.claude_quota_capture {
            crate::claude_statusline::validate(options, spec.program, &self.provider_versions)?;
        }
        ensure!(!self.shutting_down, "Host is shutting down.");
        valid_name(&spec.name)?;
        if let Some(tools) = &spec.child_allowed_nesvo_tools {
            if spec.role != crate::caller::Role::Coordinator {
                return Err(crate::api_error::Error::new(
                    "invalid_argument",
                    "Child native tool policy requires an explicit owner-created coordinator role",
                )
                .into());
            }
            crate::tool_permissions::validate(tools)?;
        }
        crate::launch_profile::validate(
            spec.program,
            &self.provider_versions,
            &crate::launch_profile::Selection {
                model: spec.model.clone(),
                effort: spec.effort.clone(),
            },
        )?;
        if let Some(tools) = &spec.allowed_nesvo_tools {
            if spec.harness != Some(true) {
                return Err(crate::api_error::Error::new("invalid_argument", "Native Nesvo tool permission additions require an explicit supported harness launch").into());
            }
            crate::tool_permissions::validate(tools)?;
        }
        if spec.harness == Some(true) {
            if spec.program != Program::Claude
                || !self.provider_versions.iter().any(|version| {
                    version.program == Program::Claude
                        && version.status == "ready"
                        && version
                            .version
                            .as_deref()
                            .is_some_and(crate::caller::supports_claude_harness)
                })
            {
                return Err(crate::api_error::Error::new("unsupported","Session harness currently requires verified Claude Code 2.1.303+ in the 2.1 series; inspect doctor providerVersions").into());
            }
            if crate::caller::runtime_client().is_none() {
                return Err(crate::api_error::Error::new("harness_client_unavailable","Harness needs a discoverable native nesvo executable beside the host or NESVO_CLIENT_BINARY").into());
            }
        }
        self.valid_group(spec.group_id.as_deref())?;
        if let Some(parent) = &spec.parent_session_id {
            ensure!(
                self.sessions
                    .get(parent)
                    .is_some_and(|session| session.info.running),
                "Parent session is not a live process"
            );
        }
        self.admit_launch(spec.program, spec.role)?;
        ensure!(
            self.launchers.available(spec.program),
            "Program is not installed on the host."
        );
        ensure!(
            spec.prompt.len() <= 8192 && !spec.prompt.contains('\0'),
            "Prompt exceeds 8192 bytes or contains NUL."
        );
        ensure!(
            spec.prompt.is_empty() || spec.program != Program::Shell,
            "Initial prompts require an agent program."
        );
        let directory = working_directory(&self.workspace, spec.cwd.as_deref())?;
        self.admit_metadata(&spec.name, &directory)?;
        Ok(directory)
    }

    fn admit_metadata(&self, name: &str, directory: &Path) -> Result<()> {
        crate::budgets::admit_snapshot_bytes(
            serde_json::to_vec(&self.baseline_with_candidate(None, None))?.len(),
            serde_json::to_vec(&json!([name, crate::process::display_path(directory)]))?.len(),
        )
    }

    fn admit_snapshot(&self, session: &Session) -> Result<()> {
        // Keep headroom for status updates/request IDs within the legacy 64 KiB
        // plaintext frame. A rejected candidate is never persisted or announced.
        if serde_json::to_vec(&self.baseline_with_candidate(None, Some(session)))?.len() > 48 * 1024
        {
            return Err(crate::api_error::Error::new(
                "budget_snapshot_capacity",
                "Session metadata capacity reached; close retained sessions before creating more",
            )
            .into());
        }
        Ok(())
    }
    fn admit_launch(&self, program: Program, role: crate::caller::Role) -> Result<()> {
        let limits = self.budget.read().map_err(|_| {
            crate::api_error::Error::new("budget_unavailable", "Admission policy is unavailable")
        })?;
        let limits = limits.as_ref().ok_or_else(|| {
            crate::api_error::Error::new(
                "budget_unavailable",
                "Current admission policy could not be loaded; existing work is preserved",
            )
        })?;
        let live = self
            .sessions
            .values()
            .filter(|session| session.info.running);
        limits.limits.admit(
            crate::budgets::Usage {
                retained: self.sessions.len(),
                workers: live
                    .clone()
                    .filter(|s| s.policy.role == crate::caller::Role::Worker)
                    .count(),
                provider: live.filter(|s| s.info.program == program).count(),
            },
            program,
            role,
        )
    }

    pub fn run_control_process_running(&self, id: &str) -> Option<bool> {
        self.sessions.get(id).map(|session| session.info.running)
    }
    pub fn dispatch_control(
        &mut self,
        id: &str,
        action: crate::operations::ControlAction,
        authority: &crate::caller::Authority,
    ) -> Result<crate::operations::ControlDispatch> {
        use crate::{
            api_error::Error,
            operations::{ControlAction, ControlDispatch},
        };
        if matches!(authority, crate::caller::Authority::RunWake { .. }) {
            return Err(Error::new(
                "forbidden",
                "Wake input does not grant interrupt or stop authority",
            )
            .into());
        }
        self.authorize_automation(authority, id)?;
        if self.shutting_down {
            return Err(Error::new(
                "host_stopping",
                "Host is shutting down; no control effect was started",
            )
            .into());
        }
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        // The epoch fence and physical effect share this State lock. Releasing
        // a lease cannot restore automatic timeout authority over a taken worker.
        action.check_human_priority(
            session.info.running,
            session.controller.is_some(),
            session.human_input_dirty,
            session.human_control_epoch,
        )?;
        if !session.info.running {
            return match action {
                ControlAction::Stop
                | ControlAction::StopRunWorker
                | ControlAction::StopJobTimeoutWorker => Ok(ControlDispatch::AlreadyExited),
                ControlAction::Interrupt => {
                    Err(Error::new("process_exited", "Process has already exited").into())
                }
            };
        }
        if let Some(pending) = &session.pending_input {
            pending.canceled.send_replace(true);
        }
        let answer = match action {
            ControlAction::Interrupt => {
                ControlDispatch::Write(session.pty.send_confirmed("\x03".into()).map_err(|_| {
                    Error::new(
                        "busy",
                        "Interrupt was not queued; terminal input is unavailable",
                    )
                })?)
            }
            ControlAction::Stop
            | ControlAction::StopRunWorker
            | ControlAction::StopJobTimeoutWorker => {
                session.kill()?;
                ControlDispatch::StopRequested
            }
        };
        session.human_input_dirty = true;
        session.wake_at = None;
        session.status.input(now_millis());
        session.status.interrupted(now_millis());
        session.turn.interrupt();
        Ok(answer)
    }
    pub fn check_submission(
        &self,
        id: &str,
        prompt: &str,
        authority: &crate::caller::Authority,
    ) -> Result<String> {
        use crate::api_error::Error;
        self.authorize_automation(authority, id)?;
        if self.shutting_down {
            return Err(Error::new(
                "host_stopping",
                "Host is shutting down; no prompt was queued",
            )
            .into());
        }
        let digest = crate::submission::digest(prompt)
            .filter(|_| !prompt.trim().is_empty())
            .ok_or_else(|| {
                Error::new(
                    "invalid_argument",
                    "Prompt must be nonempty UTF-8, at most 8192 bytes, without terminal controls",
                )
            })?;
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        if !session.info.running {
            return Err(Error::new("process_exited", "Process has exited").into());
        }
        if let Some(refusal) = session
            .resume
            .as_ref()
            .and_then(crate::resume::Gate::refusal)
        {
            return Err(refusal.into());
        }
        if session.controller.is_some() {
            return Err(Error::new(
                "control_busy",
                "Release human terminal control before automated submission",
            )
            .into());
        }
        if session.human_input_dirty {
            return Err(Error::new(
                "unsafe_draft",
                "This process has human input; reconcile its editor before automated reuse",
            )
            .into());
        }
        if session.pending_input.is_some() {
            return Err(Error::new(
                "submission_pending",
                "A previous submission still needs correlation or reconciliation",
            )
            .into());
        }
        if session.info.program != Program::Shell
            && (!matches!(
                session.status.status().state,
                crate::status::StatusState::Idle | crate::status::StatusState::Done
            ) || session.readiness.snapshot().phase != crate::readiness::Phase::Ready)
        {
            return Err(Error::new(
                "agent_not_ready",
                "Agent must be ready and observably idle before submission",
            )
            .into());
        }
        if !session.status.bracketed_paste() && prompt.contains(['\r', '\n', '\t']) {
            return Err(Error::new(
                "paste_unsupported",
                "Multiline/tab input needs provider bracketed-paste support",
            )
            .into());
        }
        Ok(digest)
    }
    pub fn human_control_epoch(&self) -> u64 {
        self.human_control_epoch
    }
    pub fn conversation_id(&self, id: &str) -> Option<String> {
        self.sessions
            .get(id)?
            .conversation_identity
            .as_ref()?
            .provider_session_id
            .clone()
    }
    pub fn human_controlled_sessions(&self) -> HashSet<String> {
        self.sessions
            .iter()
            .filter(|(_, s)| s.controller.is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }
    pub fn check_task_delivery(
        &self,
        id: &str,
        authority: &crate::caller::Authority,
        before: u64,
    ) -> Result<()> {
        if self
            .sessions
            .get(id)
            .is_some_and(|s| s.human_control_epoch > before)
        {
            return Err(crate::api_error::Error::new(
                "control_busy",
                "Human takeover after queuing requires a deliberate new input decision",
            )
            .into());
        }
        if self
            .sessions
            .get(id)
            .is_some_and(|s| s.info.program == Program::Shell)
        {
            return Err(crate::api_error::Error::new(
                "unsupported",
                "Task instruction delivery targets agents, not shell command interpreters",
            )
            .into());
        }
        self.check_submission(id, "Task readiness probe", authority)
            .map(|_| ())
    }
    pub fn begin_submission(
        &mut self,
        id: &str,
        claim: crate::submission::Claim,
        prompt: &str,
        authority: &crate::caller::Authority,
    ) -> Result<(Option<PathBuf>, watch::Receiver<bool>)> {
        let digest = self.check_submission(id, prompt, authority)?;
        let session = self.sessions.get_mut(id).ok_or_else(|| {
            crate::api_error::Error::new("session_not_found", "Session no longer exists")
        })?;
        let (canceled, cancellation) = watch::channel(false);
        session.pending_input = Some(crate::submission::Pending {
            quota_resume: None,
            quota_sequence: None,
            quota_semantic_revision: None,
            authority: authority.clone(),
            claim,
            canceled,
            correlation: None,
            digest,
            source: None,
            queued: false,
            reconciliation_queued: false,
        });
        Ok((
            session
                .agent_context
                .as_ref()
                .map(|tracker| tracker.report()),
            cancellation,
        ))
    }
    pub fn enqueue_submission(
        &mut self,
        id: &str,
        operation: &str,
        text: Option<&str>,
        fence: Option<&crate::agent_events::Batch>,
    ) -> Result<tokio::sync::oneshot::Receiver<bool>> {
        use crate::api_error::Error;
        if self.shutting_down {
            return Err(Error::new("host_stopping", "Host is shutting down").into());
        }
        let authority = self
            .sessions
            .get(id)
            .and_then(|s| s.pending_input.as_ref())
            .map(|pending| pending.authority.clone())
            .ok_or_else(|| Error::new("submission_preempted", "Submission is no longer active"))?;
        self.authorize_automation(&authority, id)?;
        let quota_resume = self.guard_quota_submission(id, operation)?;
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        // Queue admission must see PTY evidence newer than the last coalesced
        // timer tick. Leave publication to that timer, including unchanged ticks.
        session.status_projection_dirty |= session.status.refresh(now_millis());
        session.status_projection_dirty |= session.readiness.observe(
            session.status.status(),
            session.status.rule_reason(),
            session.started.elapsed(),
        );
        let pending = session
            .pending_input
            .as_mut()
            .filter(|p| p.claim.id == operation && !*p.canceled.borrow())
            .ok_or_else(|| {
                Error::new(
                    "submission_preempted",
                    "Human control or reconciliation superseded this submission",
                )
            })?;
        if session.controller.is_some() || !session.info.running {
            return Err(Error::new(
                "submission_preempted",
                "Target is no longer available for automated input",
            )
            .into());
        }
        if let Some(fence) = fence {
            if text.is_none()
                && pending.source.as_ref().is_some_and(|(launch, generation)| {
                    launch != &fence.identity.launch_id || *generation != fence.identity.generation
                })
            {
                return Err(Error::new(
                    "conversation_changed",
                    "Conversation changed after paste; Enter was not queued",
                )
                .into());
            }
            if session.lifecycle_cursor != fence.head_sequence
                || session
                    .conversation_identity
                    .as_ref()
                    .is_none_or(|identity| {
                        identity.launch_id != fence.identity.launch_id
                            || identity.generation != fence.identity.generation
                    })
            {
                return Err(Error::new(
                    "lifecycle_pending",
                    "Wait for pending lifecycle evidence before submitting",
                )
                .into());
            }
            if text.is_none() && fence.identity.prompt_correlation {
                pending.correlation = Some(crate::submission::Correlation::new(
                    &fence.identity,
                    fence.head_sequence,
                    pending.digest.clone(),
                ));
            }
        }
        if !quota_resume
            && session.info.program != Program::Shell
            && (!matches!(
                session.status.status().state,
                crate::status::StatusState::Idle | crate::status::StatusState::Done
            ) || session.readiness.snapshot().phase != crate::readiness::Phase::Ready)
        {
            // Pasting invalidates a screen-only prompt until the provider draws
            // its editor again. Wait for new idle evidence, never send on I/O
            // activity alone. Semantic work/permission evidence fails at once.
            if text.is_none()
                && pending.queued
                && session.readiness.snapshot().phase == crate::readiness::Phase::Ready
                && session.status.status().source == crate::status::StatusSource::Activity
                && matches!(
                    session.status.status().state,
                    crate::status::StatusState::Working | crate::status::StatusState::Unknown
                )
            {
                return Err(Error::new(
                    "editor_pending",
                    "Waiting for fresh idle editor evidence after paste; Enter was not queued",
                )
                .into());
            }
            return Err(Error::new(
                "agent_not_ready",
                "Agent is no longer ready and idle; no further input was queued",
            )
            .into());
        }
        let data = match text {
            Some(prompt) if session.status.bracketed_paste() => {
                format!("\x1b[200~{prompt}\x1b[201~")
            }
            Some(prompt) => prompt.into(),
            None => "\r".into(),
        };
        let answer = session.pty.send_confirmed(data)?;
        if text.is_some() {
            pending.source =
                fence.map(|batch| (batch.identity.launch_id.clone(), batch.identity.generation));
        }
        pending.queued = true;
        if !quota_resume || text.is_none() {
            session.wake_at = None;
        }
        session.status.input(now_millis());
        Ok(answer)
    }
    pub fn end_submission(&mut self, id: &str, operation: &str, phase: &str) {
        if let Some(session) = self.sessions.get_mut(id)
            && session
                .pending_input
                .as_ref()
                .is_some_and(|p| p.claim.id == operation)
            && (!matches!(phase, "delivered" | "received" | "started" | "waiting")
                || session.info.program == Program::Shell)
        {
            // A partial write or preempted Enter can leave a draft in the editor.
            // A new idempotency key is not permission to append to that draft.
            if phase == "unknown"
                && session
                    .pending_input
                    .as_ref()
                    .is_some_and(|pending| pending.queued || pending.reconciliation_queued)
            {
                session.human_input_dirty = true;
            }
            session.pending_input = None;
            if let Some(original) = session.quota_predecessor.take() {
                self.submission_updates.push(crate::submission::Transition {
                    claim: original.claim,
                    phase: "unknown",
                    result: json!({"code":"quota_resume_unconfirmed","supersededBy":operation,"taskResult":null}),
                });
            }
        }
    }
    pub fn launch(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
    ) -> Result<String> {
        self.launch_inner(spec, events, None, None)
    }
    pub(crate) fn launch_reserved(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
        id: &str,
        grant: Option<crate::tool_permissions::Grant>,
    ) -> Result<String> {
        ensure!(
            id.len() == 32
                && id.bytes().all(|b| b.is_ascii_hexdigit())
                && !self.sessions.contains_key(id),
            "Reserved process identity is invalid or already running"
        );
        self.launch_inner(spec, events, Some(id), grant)
    }
    fn launch_inner(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
        reserved: Option<&str>,
        grant: Option<crate::tool_permissions::Grant>,
    ) -> Result<String> {
        let cwd = self.validate_launch(spec)?;
        crate::resume::check_launch(spec, self.lifecycle_hooks_available(spec.program))?;
        ensure!(
            spec.claude_quota_capture.is_none() || spec.claude_quota_prepared.is_some(),
            "Declared Claude quota display profile was not prepared"
        );
        let grant = grant.unwrap_or_else(|| {
            crate::tool_permissions::Grant::owner(
                spec.allowed_nesvo_tools.as_deref().unwrap_or_default(),
            )
        });
        if let Some(context) = &spec.quota_launch {
            ensure!(
                spec.program == Program::Codex,
                "Quota admission requires Codex"
            );
            self.quota_launch_ready(
                &context.permit,
                &context.receipt_id,
                &cwd,
                context.derived_worktree,
            )?;
        }
        let quota_unverified = match spec.quota_launch {
            Some(_) => None,
            None => crate::quota_gate::admit_now(&self.quota_gate, spec.program)?,
        };
        let mut command = self.launchers.command(spec.program, &cwd)?;
        if let Some(context) = &spec.quota_launch {
            let reader = self
                .quota_contexts
                .spec_for_context(
                    &context.permit.binding.context_id,
                    now_millis(),
                    crate::event_log::monotonic_millis(),
                )
                .ok_or_else(|| {
                    crate::api_error::Error::new(
                        "quota_wait",
                        "The approved reader context changed before native launch",
                    )
                })?;
            if let Some(home) = reader.home {
                command.env("CODEX_HOME", home);
            }
        }
        let selection = crate::launch_profile::Selection {
            model: spec.model.clone(),
            effort: spec.effort.clone(),
        };
        command.args(crate::launch_profile::arguments(spec.program, &selection)?);
        if spec.resume_picker {
            ensure!(
                spec.prompt.is_empty(),
                "Resume picker cannot send an initial prompt"
            );
            command.args(crate::launchers::resume_arguments(spec.program)?);
        }
        if let Some(target) = &spec.resume {
            command.args(crate::launchers::conversation_resume_arguments(
                spec.program,
                target,
            )?);
        }
        if !spec.prompt.is_empty() {
            if spec.program == Program::Gemini {
                command.arg("--prompt-interactive");
            } else {
                command.arg("--");
            }
            command.arg(&spec.prompt);
        }
        let mut session = spawn_session(
            spec.name.trim(),
            &cwd,
            spec.program,
            command,
            events.clone(),
            self.caller_url.as_deref(),
            SpawnIdentity {
                id: reserved,
                role: spec.role,
                harness: spec.harness == Some(true),
                codex_hooks: self.codex_hooks_available(),
                gemini_hooks: spec.program == Program::Gemini && self.gemini_gate().ready,
                claude_quota_capture: spec.claude_quota_prepared.as_ref(),
                native_grant: &grant,
                child_tools: spec
                    .child_allowed_nesvo_tools
                    .as_deref()
                    .unwrap_or_default(),
            },
        )?;
        session.quota_binding = if spec.program == Program::Codex {
            self.launchers
                .probe_command(Program::Codex)
                .zip(self.codex_home(&cwd))
                .and_then(|(command, home)| {
                    session_quota::LaunchBinding::capture(command, cwd.clone(), home).ok()
                })
        } else {
            None
        };
        session.resume = spec.resume.clone().map(crate::resume::Gate::new);
        if session.agent_context.is_none()
            && let Some(gate) = session.resume.as_mut()
        {
            gate.fail(
                "Lifecycle hooks are unavailable, so the resumed conversation cannot be verified",
            );
        }
        session.info.group_id = spec.group_id.clone();
        session.model_selection = selection;
        session.info.parent_session_id = spec.parent_session_id.clone();
        session.auto_title = spec.auto_title && spec.program != Program::Shell;
        session.attention.muted = spec.muted;
        if session.auto_title && !spec.prompt.trim().is_empty() {
            session.info.name = spec
                .prompt
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
        }
        let id = session.info.id.clone();
        if let Err(error) = self
            .admit_snapshot(&session)
            .and_then(|()| self.persist_session(&session))
        {
            let _ = session.kill();
            self.cleanup_workers
                .push(thread::spawn(move || drop(session)));
            return Err(error);
        }
        self.repository.register(session.repository_binding.clone());
        self.sessions.insert(id.clone(), session);
        if let Some(reason) = quota_unverified {
            self.quota_gate.mark_unverified(&id, reason);
        }
        self.emit(
            Some(&id),
            "session.created",
            json!({"program":spec.program,"parentSessionId":spec.parent_session_id}),
        );
        // Durable launches publish once the authenticated child's grant is installed.
        if reserved.is_none() {
            self.broadcast_list();
        }
        Ok(id)
    }

    pub fn claim_job(&mut self) -> Option<(String, crate::jobs::LaunchSpec)> {
        if self.shutting_down {
            return None;
        }
        match self.metadata.claim_schedule() {
            Ok(job) => job,
            Err(error) => {
                eprintln!("Scheduler storage error: {error}");
                None
            }
        }
    }

    pub fn finish_job(&mut self, id: &str, result: Result<String>) {
        let (status, detail) = match result {
            Ok(id) => ("started", id),
            Err(error) => ("failed", error.to_string()),
        };
        if let Err(error) = self.metadata.finish_schedule(id, status, &detail) {
            eprintln!("Cannot record schedule completion: {error}");
        }
        self.broadcast_schedules();
    }

    pub fn broadcast_schedules(&self) {
        if let Ok(schedules) = self.metadata.schedules() {
            for id in &self.schedule_watchers {
                self.send(*id, json!({"type":"schedules", "schedules":schedules}));
            }
        }
    }

    pub fn watch_reviews(&mut self, client_id: u64) {
        if self.clients.contains_key(&client_id) {
            self.review_watchers.insert(client_id);
        }
    }

    pub fn review_watchers(&self) -> impl Iterator<Item = u64> + '_ {
        self.review_watchers.iter().copied()
    }

    pub(crate) fn watch_attention(&mut self, client_id: u64) {
        self.attention_watchers.insert(client_id);
    }

    pub(crate) fn notify_attention(&self, reason: &str, item: Option<&str>) {
        for id in &self.attention_watchers {
            let mut event = json!({"type":"attentionInboxChanged","reason":reason});
            if let Some(item) = item {
                event["itemId"] = item.into();
            }
            self.send(*id, event);
        }
    }

    pub(crate) fn attention_signal(&mut self, signal: crate::attention_inbox::Signal) {
        self.notify_attention(signal.reason, signal.item.as_deref());
        let (Some(kind), Some(item)) = (signal.push, signal.item) else {
            return;
        };
        match self.metadata.push_tokens_for(kind) {
            Ok(tokens) => {
                for token in tokens {
                    if self.push_queue.len() < 64 {
                        self.push_queue.push_back(crate::notifications::Job::inbox(
                            token,
                            self.metadata.host_id.clone(),
                            kind,
                            item.clone(),
                        ));
                    }
                }
            }
            Err(_) => eprintln!("Could not load notification registrations"),
        }
    }

    pub(crate) fn attention_sessions(&self) -> Vec<crate::attention_inbox::SessionItem> {
        self.sessions
            .values()
            .filter(|s| !s.attention.muted && s.info.program != Program::Shell)
            .filter_map(|s| {
                let projection = s.current_attention();
                let unread = s.attention.event.as_ref().filter(|e| e.unread);
                let event_priority = unread.map_or(0, |e| match e.kind {
                    "question" => 3,
                    "permission" | "limit" => 2,
                    _ => 1,
                });
                let (priority, reason) = match (projection.priority, projection.reason, unread) {
                    (priority, Some(reason), _) if priority >= event_priority && priority > 0 => {
                        (priority, reason)
                    }
                    (_, _, Some(event)) => (event_priority, event.kind),
                    _ => return None,
                };
                Some(crate::attention_inbox::SessionItem {
                    session_id: s.info.id.clone(),
                    name: s.info.name.clone(),
                    program: s.info.program,
                    priority,
                    reason,
                    revision: s.attention.event.as_ref().map_or(0, |e| e.sequence),
                    at: s.attention.event.as_ref().map_or(0, |e| e.at),
                })
            })
            .collect()
    }

    pub(crate) fn acknowledge_session_attention(&mut self, session_id: &str, sequence: u64) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.attention.acknowledge(sequence);
            self.broadcast_list();
        }
    }

    pub fn context_report(&self, id: &str) -> Option<PathBuf> {
        self.sessions
            .get(id)?
            .agent_context
            .as_ref()
            .map(|tracker| tracker.report())
    }

    pub fn delivery_target(&self, id: &str) -> Option<crate::review::Target> {
        let session = self.sessions.get(id)?;
        Some(crate::review::Target {
            agent: session.info.program != Program::Shell,
            running: session.info.running,
            controller: session.controller.as_ref().map(|lease| lease.client_id),
            ready: matches!(
                session.status.status().state,
                crate::status::StatusState::Idle | crate::status::StatusState::Done
            ) && session.readiness.snapshot().phase == crate::readiness::Phase::Ready
                && session
                    .resume
                    .as_ref()
                    .is_none_or(crate::resume::Gate::verified),
            bracketed_paste: session.status.bracketed_paste(),
        })
    }

    pub fn context_reports(&self) -> Vec<(String, Program, Option<PathBuf>)> {
        self.sessions
            .iter()
            .map(|(id, session)| {
                (
                    id.clone(),
                    session.info.program,
                    session
                        .agent_context
                        .as_ref()
                        .map(|tracker| tracker.report()),
                )
            })
            .collect()
    }

    pub(crate) fn project_sessions(&self) -> Vec<crate::projects::LiveSession> {
        self.sessions
            .iter()
            .map(|(id, session)| crate::projects::LiveSession {
                id: id.clone(),
                directory: session.info.cwd.clone(),
                root: self.repository.root(id),
                running: session.info.running,
            })
            .collect()
    }

    pub fn session_directory(&self, id: &str) -> Result<PathBuf> {
        self.sessions
            .get(id)
            .map(|s| PathBuf::from(&s.info.cwd))
            .ok_or_else(|| anyhow!("Session no longer exists."))
    }

    fn diagnostics(&self, id: Option<&str>) -> Result<Value> {
        if let Some(id) = id
            && !self.sessions.contains_key(id)
        {
            return Err(crate::api_error::Error::new(
                "session_not_found",
                "Session no longer exists",
            )
            .into());
        }
        let now = now_millis();
        let mut sessions: Vec<_> = self
            .sessions
            .values()
            .filter(|s| id.is_none_or(|id| s.info.id == id))
            .collect();
        sessions.sort_by(|a, b| a.info.id.cmp(&b.info.id));
        let sessions: Vec<_> = sessions.into_iter().map(|session| json!({
            "sessionId":session.info.id, "program":session.info.program, "running":session.info.running,
            "processIdentity":{"pid":session.pty.process_id(),"launchedAt":session.info.created_at,"launchId":session.info.id},
            "processAgeSeconds":session.elapsed_at_exit.unwrap_or_else(||session.started.elapsed()).as_secs(),
            "harness":session.caller_context.as_ref().map(|context|context.configuration(session.harness_enabled)),
            "launchProfile":session.model_selection.diagnostic(),
            "inputOperation":session.pending_input.as_ref().map(|pending|json!({"id":pending.claim.id,"queued":pending.queued,"canceled":*pending.canceled.borrow(),"correlated":pending.correlation.is_some(),"correlationEvidence":pending.correlation.as_ref().map(crate::submission::Correlation::diagnostic)})),
            "integration":{"configured":session.agent_context.is_some(), "adapter":session.agent_context.as_ref().map_or("screen/protocol",|tracker|tracker.adapter()),
                "helperBuildId":if session.agent_context.is_some(){Some(env!("NESVO_BUILD_ID"))}else{None},
                "delivery":session.integration_delivery, "shadowSequence":session.integration_shadow_sequence, "cursor":session.lifecycle_cursor, "gap":session.lifecycle_gap},
            "conversationIdentity":session.conversation_identity,
            "nativeQuotaCallback":session.claude_quota.as_ref().map(|quota|json!({"source":"claudeStatusLine","sequence":quota.scope.sequence,"generation":quota.scope.generation,"snapshot":quota.snapshot,"backendFreshness":"unknown","ordinaryUsageAllowed":null,"accountFingerprint":null})),
            "claudeQuotaCapture":session.capture_diagnostic(),
            "publicationLatency":session.status_latency.snapshot(),
            "status":session.status.explain(now), "readiness":session.readiness.snapshot(), "turn":session.turn.snapshot(session.elapsed_at_exit.unwrap_or_else(||session.started.elapsed())), "turnHistory":session.turn.history(), "terminalProtocol":session.terminal_protocol.diagnostics(),
        })).collect();
        Ok(
            json!({"schemaVersion":1,"host":{"id":self.metadata.host_id,"buildId":env!("NESVO_BUILD_ID"),"version":env!("CARGO_PKG_VERSION"),"protocolVersion":2},
            "jobTriggerListener":self.job_trigger_listener(),"programs":self.launchers.capabilities(),"providerVersions":self.provider_versions,"launchProfileSupport":crate::launch_profile::capabilities(&self.provider_versions),"geminiIntegration":self.gemini_gate(),"eventJournal":self.event_log.as_ref().map(|log|log.health()),"sessions":sessions}),
        )
    }

    pub fn command(
        &mut self,
        client_id: u64,
        command: Command,
        request_id: Option<&str>,
        pty_events: &mpsc::Sender<PtyEvent>,
    ) -> Result<()> {
        ensure!(!self.shutting_down, "Host is shutting down.");
        self.authorize(client_id, &command)?;
        match command {
            Command::Workflow { .. }
            | Command::CreateOperation { .. }
            | Command::SendOperation { .. }
            | Command::WaitOperation { .. }
            | Command::InterruptOperation { .. }
            | Command::StopOperation { .. }
            | Command::GetOperation { .. } => {
                return Err(anyhow!("Operations require asynchronous dispatch"));
            }
            Command::ReadEvents { .. }
            | Command::SubscribeEvents { .. }
            | Command::UnsubscribeEvents => {
                return Err(anyhow!("Event observation requires asynchronous dispatch"));
            }
            Command::GetSession { session_id } => {
                let snapshot = self.list();
                let session = snapshot["sessions"]
                    .as_array()
                    .and_then(|sessions| sessions.iter().find(|s| s["id"] == session_id))
                    .ok_or_else(|| {
                        crate::api_error::Error::new(
                            "session_not_found",
                            "Session no longer exists",
                        )
                    })?;
                self.respond(
                    client_id,
                    json!({"type":"session","session":session}),
                    request_id,
                );
            }
            Command::ReadSession {
                session_id,
                after,
                max_bytes,
            } => {
                let session = self.sessions.get(&session_id).ok_or_else(|| {
                    crate::api_error::Error::new("session_not_found", "Session no longer exists")
                })?;
                let page = crate::replay::page(
                    &session.backlog,
                    session.output_cursor,
                    after,
                    max_bytes.unwrap_or(4096),
                )?;
                self.respond(client_id,json!({"type":"sessionRead","sessionId":session_id,"cols":session.info.cols,"rows":session.info.rows,"page":page}),request_id);
            }
            Command::GetDiagnostics { session_id } => {
                let mut report = self.diagnostics(session_id.as_deref())?;
                if self.caller_session(client_id)?.is_none() {
                    report["providerQuota"] = serde_json::to_value(self.quota_views())?;
                    report["lifecycleObserver"] = json!({
                        "sampledAtElapsedMs": crate::event_log::monotonic_millis(),
                        "counts": self.lifecycle_observer,
                    });
                }
                self.respond(
                    client_id,
                    json!({"type":"diagnostics", "report":report}),
                    request_id,
                );
            }
            Command::GetProviderQuota {
                program,
                refresh,
                directory,
            } => {
                ensure!(
                    directory.is_none(),
                    "Context quota queries require asynchronous transport resolution"
                );
                let result = self.provider_quota_query(program, refresh)?;
                self.respond(client_id, result, request_id);
            }
            Command::Auth { .. } => return Err(anyhow!("Already authenticated.")),
            Command::Launch { .. } => {
                return Err(anyhow!("Launch requires asynchronous dispatch."));
            }
            Command::ScheduleSession { mut spec, at } => {
                let cwd = self.validate_launch(&spec)?;
                spec.cwd = Some(crate::process::display_path(&cwd));
                ensure!(
                    !spec.prompt.trim().is_empty(),
                    "A scheduled session needs an initial prompt."
                );
                let due = crate::jobs::timestamp(&at)?;
                let id = self.metadata.add_schedule(&spec, due)?;
                self.schedule_watchers.insert(client_id);
                self.respond(
                    client_id,
                    json!({"type":"scheduled", "id":id, "due":due}),
                    request_id,
                );
                self.broadcast_schedules();
            }
            Command::SetWake { .. } => {
                return Err(anyhow!("Quota wake requires asynchronous durable dispatch"));
            }
            Command::GetQuotaWake { .. } => {
                return Err(anyhow!(
                    "Quota wake observation requires asynchronous journal access"
                ));
            }
            Command::ListSchedules => {
                self.schedule_watchers.insert(client_id);
                self.respond(
                    client_id,
                    json!({"type":"schedules", "schedules":self.metadata.schedules()?}),
                    request_id,
                );
            }
            Command::CancelSchedule { id } => {
                self.metadata.cancel_schedule(&id)?;
                self.broadcast_schedules();
            }
            Command::WatchReviews => {
                self.watch_reviews(client_id);
                self.respond(client_id, json!({"type":"reviewsWatched"}), request_id);
            }
            Command::GetDiff { .. } => return Err(anyhow!("Diff requires asynchronous dispatch.")),
            Command::OpenReview { .. }
            | Command::ReviewContext { .. }
            | Command::DeliverReview { .. } => {
                return Err(anyhow!("Reviews require asynchronous dispatch."));
            }
            Command::ListEntries { .. } | Command::ReadFile { .. } | Command::FindFiles { .. } => {
                return Err(anyhow!("Files require asynchronous dispatch."));
            }
            Command::ListCommits { .. } => {
                return Err(anyhow!("Commit history requires asynchronous dispatch."));
            }
            Command::ListNotes { .. }
            | Command::ReadNote { .. }
            | Command::WriteNote { .. }
            | Command::DeleteNote { .. } => {
                return Err(anyhow!("Notes require asynchronous dispatch."));
            }
            Command::DescribeWorktreeSetup { .. }
            | Command::ApproveWorktreeSetup { .. }
            | Command::RevokeWorktreeSetup { .. }
            | Command::RunWorktree { .. }
            | Command::CancelWorktree { .. }
            | Command::ArchiveWorktree { .. }
            | Command::ListWorktrees => {
                return Err(anyhow!("Worktrees require asynchronous dispatch."));
            }
            Command::AttentionInbox { .. }
            | Command::AcknowledgeInbox { .. }
            | Command::Decisions { .. }
            | Command::Decide { .. } => {
                return Err(anyhow!("Attention inbox requires asynchronous dispatch."));
            }
            Command::ListWorkflowTemplates { .. }
            | Command::ApproveWorkflowTemplates { .. }
            | Command::RevokeWorkflowTemplates { .. }
            | Command::StartWorkflowTemplate { .. } => {
                return Err(anyhow!("Workflow templates require asynchronous dispatch."));
            }
            Command::ListProjects
            | Command::PinProject { .. }
            | Command::UnpinProject { .. }
            | Command::ProjectDefaults { .. }
            | Command::SetProjectLayout { .. } => {
                return Err(anyhow!("Projects require asynchronous dispatch."));
            }
            Command::AcknowledgeAttention {
                session_id,
                sequence,
            } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                session.attention.acknowledge(sequence);
                self.broadcast_list();
            }
            Command::MuteSession { session_id, muted } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                session.attention.muted = muted;
                if let Some(session) = self.sessions.get(&session_id) {
                    self.persist_session(session)?;
                }
                self.broadcast_list();
            }
            Command::RegisterPush {
                token,
                enabled,
                kinds,
            } => {
                ensure!(
                    kinds.as_ref().is_none_or(|kinds| kinds.len() <= 8
                        && kinds.iter().all(|kind| {
                            crate::attention_inbox::PUSH_KINDS.contains(&kind.as_str())
                        })),
                    "Unknown notification kind"
                );
                self.metadata.register_push(&token, enabled)?;
                let mut event = json!({"type":"pushRegistered","enabled":enabled});
                if let Some(kinds) = kinds.filter(|_| enabled) {
                    event["kinds"] = json!(self.metadata.set_push_kinds(&token, &kinds)?);
                }
                self.respond(client_id, event, request_id);
            }
            Command::ListTemplates => self.respond(
                client_id,
                json!({"type":"templates","templates":self.metadata.templates()?}),
                request_id,
            ),
            Command::SaveTemplate { name, spec } => {
                self.metadata.save_template(&name, &spec)?;
                self.respond(
                    client_id,
                    json!({"type":"templates","templates":self.metadata.templates()?}),
                    request_id,
                );
            }
            Command::DeleteTemplate { id } => {
                self.metadata.delete_template(&id)?;
                self.respond(
                    client_id,
                    json!({"type":"templates","templates":self.metadata.templates()?}),
                    request_id,
                );
            }
            Command::ListRecovery { offset } => {
                self.respond(client_id, self.recovery_event(offset)?, request_id)
            }
            Command::ForgetRecovery { id } => {
                ensure!(
                    !self.sessions.contains_key(&id),
                    "Cannot forget a live session."
                );
                self.metadata.finish_recovery(&id, true)?;
                self.respond(client_id, self.recovery_event(0)?, request_id);
            }
            Command::RestoreSession { id, resume, exact } => {
                ensure!(
                    !self.sessions.contains_key(&id),
                    "Session is already running."
                );
                let mut spec = self.metadata.claim_recovery(&id)?;
                spec.resume_picker = resume;
                if spec
                    .group_id
                    .as_ref()
                    .is_some_and(|id| !self.metadata.contains(id))
                {
                    spec.group_id = None;
                }
                let hooks = self.lifecycle_hooks_available(spec.program);
                let result = crate::resume::prepare_restore(&mut spec, exact, hooks)
                    .and_then(|()| self.launch(&spec, pty_events));
                self.metadata.finish_recovery(&id, result.is_ok())?;
                let new_id = result?;
                let mut created = json!({"type":"created","sessionId":new_id});
                if let Some(gate) = self.sessions.get(&new_id).and_then(|s| s.resume.as_ref()) {
                    created["resume"] = json!(gate.verification());
                }
                self.respond(client_id, created, request_id);
                self.respond(client_id, self.recovery_event(0)?, request_id);
                self.broadcast_list();
            }
            Command::List => {
                self.repository_view_requested(client_id)?;
                self.respond(client_id, self.list(), request_id);
            }
            Command::GetCapabilities => {
                self.respond(client_id, self.capabilities_event(), request_id)
            }
            Command::ListDirectories { path } => {
                let directory = match path.as_deref().filter(|value| !value.is_empty()) {
                    Some(value) => {
                        ensure!(
                            value.len() <= 4096 && !value.chars().any(char::is_control),
                            "Invalid folder path."
                        );
                        let requested = PathBuf::from(value);
                        if requested.is_absolute() {
                            requested
                        } else {
                            self.workspace.join(requested)
                        }
                    }
                    None => self.workspace.clone(),
                };
                let directory = directory.canonicalize()?;
                ensure!(directory.is_dir(), "This folder does not exist.");
                let mut entries = std::fs::read_dir(&directory)?
                    .filter_map(|item| item.ok())
                    .filter(|item| {
                        item.path().is_dir()
                            && !item
                                .file_name()
                                .to_string_lossy()
                                .chars()
                                .any(char::is_control)
                    })
                    .map(|item| {
                        json!({
                            "name": item.file_name().to_string_lossy(),
                            "path": crate::process::display_path(&item.path()),
                        })
                    })
                    .collect::<Vec<_>>();
                #[cfg(windows)]
                if directory.parent().is_none() {
                    for letter in b'A'..=b'Z' {
                        let drive = format!("{}:\\", char::from(letter));
                        if Path::new(&drive).is_dir() {
                            entries.push(json!({"name":drive, "path":drive}));
                        }
                    }
                }
                entries.sort_by(|a, b| {
                    a["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .cmp(&b["name"].as_str().unwrap_or_default().to_lowercase())
                });
                entries.truncate(512);
                self.respond(
                    client_id,
                    json!({
                        "type": "directories",
                        "path": crate::process::display_path(&directory),
                        "parent": directory.parent().map(crate::process::display_path),
                        "entries": entries,
                    }),
                    request_id,
                );
            }
            Command::Create {
                name,
                cwd,
                group_id,
                program,
            } => {
                let name = valid_name(&name)?;
                self.valid_group(group_id.as_deref())?;
                self.admit_launch(program, crate::caller::Role::Worker)?;
                let cwd = working_directory(&self.workspace, cwd.as_deref())?;
                self.admit_metadata(&name, &cwd)?;
                let quota_unverified = crate::quota_gate::admit_now(&self.quota_gate, program)?;
                let command = self.launchers.command(program, &cwd)?;
                let mut session = spawn_session(
                    &name,
                    &cwd,
                    program,
                    command,
                    pty_events.clone(),
                    self.caller_url.as_deref(),
                    SpawnIdentity {
                        id: None,
                        role: crate::caller::Role::Worker,
                        harness: false,
                        codex_hooks: self.codex_hooks_available(),
                        gemini_hooks: program == Program::Gemini && self.gemini_gate().ready,
                        claude_quota_capture: None,
                        native_grant: &crate::tool_permissions::Grant::owner(&[]),
                        child_tools: &[],
                    },
                )?;
                session.info.group_id = group_id;
                let session_id = session.info.id.clone();
                if let Err(error) = self
                    .admit_snapshot(&session)
                    .and_then(|()| self.persist_session(&session))
                {
                    let _ = session.kill();
                    self.cleanup_workers
                        .push(thread::spawn(move || drop(session)));
                    return Err(error);
                }
                self.repository.register(session.repository_binding.clone());
                self.sessions.insert(session_id.clone(), session);
                if let Some(reason) = quota_unverified {
                    self.quota_gate.mark_unverified(&session_id, reason);
                }
                self.emit(
                    Some(&session_id),
                    "session.created",
                    json!({"program":program}),
                );
                self.respond(
                    client_id,
                    json!({"type":"created", "sessionId":session_id}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::RenameSession { session_id, name } => {
                let name = valid_name(&name)?;
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                session.info.name = name;
                session.auto_title = false;
                self.persist_session(self.sessions.get(&session_id).unwrap())?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::Attach {
                session_id,
                cols,
                rows,
            } => self.acquire(client_id, &session_id, cols, rows, false, true)?,
            Command::Subscribe { session_id } => self.subscribe(client_id, &session_id)?,
            Command::Unsubscribe { session_id } => {
                if let Some(session) = self.sessions.get_mut(&session_id) {
                    session.subscribers.remove(&client_id);
                }
                self.send(
                    client_id,
                    json!({"type":"unsubscribed", "sessionId":session_id}),
                );
            }
            Command::AcquireControl {
                session_id,
                cols,
                rows,
                take_over,
            } => self.acquire(client_id, &session_id, cols, rows, take_over, false)?,
            Command::ReleaseControl {
                session_id,
                lease_id,
            } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, Some(&lease_id))),
                    "Control lease is missing or stale."
                );
                session.controller = None;
                self.broadcast_control(&session_id);
            }
            Command::Input {
                session_id,
                data,
                lease_id,
            } => {
                ensure!(
                    data.len() <= 32 * 1024 && data.chars().count() <= 8192,
                    "Input exceeds the 8192 character limit."
                );
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, lease_id.as_deref())),
                    "Control lease is missing or stale. Acquire this session before sending input."
                );
                ensure!(
                    session.info.running,
                    "This shell has exited. Create a new session."
                );
                let has_input = !data.is_empty();
                let interrupt = data == "\x03" || data == "\x1b";
                session.pty.send_input(data)?;
                if has_input {
                    session.human_input_dirty = true;
                    session.wake_at = None;
                    session.status.input(now_millis());
                    if interrupt {
                        session.status.interrupted(now_millis());
                        session.turn.interrupt();
                    }
                }
            }
            Command::Resize {
                session_id,
                cols,
                rows,
                lease_id,
            } => {
                let size = terminal_size(cols, rows)?;
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_some_and(|lease| lease.accepts(client_id, lease_id.as_deref())),
                    "Control lease is missing or stale. Acquire this session before resizing."
                );
                ensure!(session.info.running, "This shell has exited.");
                session.pty.resize(size)?;
                session.info.cols = cols;
                session.info.rows = rows;
                session.status.resize(rows, cols);
                self.broadcast_control(&session_id);
            }
            Command::Close { session_id } => {
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                if session.info.running {
                    session.kill()?;
                }
                self.metadata.finish_recovery(&session_id, true)?;
                let mut removed = self.sessions.remove(&session_id);
                self.repository.remove(&session_id);
                self.repository_notify();
                if let Some(pending) = removed
                    .as_mut()
                    .and_then(|session| session.pending_input.take())
                {
                    pending.canceled.send_replace(true);
                    self.submission_updates.push(crate::submission::Transition {
                        claim: pending.claim,
                        phase: "unknown",
                        result: json!({"code":"session_closed","taskResult":null}),
                    });
                }
                self.cleanup_workers.retain(|worker| !worker.is_finished());
                self.cleanup_workers
                    .push(thread::spawn(move || drop(removed)));
                self.emit(Some(&session_id), "session.closed", json!({}));
                self.broadcast_list();
            }
            Command::CreateGroup {
                name,
                parent_id,
                order,
                expected_revision,
            } => {
                let id = self
                    .metadata
                    .create(&name, parent_id, order, expected_revision)?;
                self.respond(client_id, json!({"type":"groupCreated", "groupId":id, "revision":self.metadata.revision()}), request_id);
                self.broadcast_list();
            }
            Command::UpdateGroup {
                group_id,
                name,
                parent_id,
                order,
                expected_revision,
            } => {
                self.metadata
                    .update(&group_id, &name, parent_id, order, expected_revision)?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::DeleteGroup {
                group_id,
                expected_revision,
            } => {
                self.metadata.check_revision(expected_revision)?;
                ensure!(
                    !self
                        .sessions
                        .values()
                        .any(|session| session.info.group_id.as_deref() == Some(&group_id)),
                    "Group contains sessions. Move or close them first."
                );
                self.metadata.delete(&group_id, expected_revision)?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
            Command::MoveSession {
                session_id,
                group_id,
                expected_revision,
            } => {
                self.metadata.check_revision(expected_revision)?;
                self.valid_group(group_id.as_deref())?;
                ensure!(
                    self.sessions.contains_key(&session_id),
                    "Session no longer exists."
                );
                self.metadata.bump(expected_revision)?;
                self.sessions.get_mut(&session_id).unwrap().info.group_id = group_id;
                self.persist_session(self.sessions.get(&session_id).unwrap())?;
                self.respond(
                    client_id,
                    json!({"type":"updated", "revision":self.metadata.revision()}),
                    request_id,
                );
                self.broadcast_list();
            }
        }
        Ok(())
    }

    /// Fence new native launches and input while owned command scopes drain.
    /// Existing PTYs stay available until the final resource shutdown below.
    pub fn begin_shutdown(&mut self) {
        self.shutting_down = true;
        self.repository.seal();
        self.repository_notify();
        for session in self.sessions.values_mut() {
            session.wake_at = None;
        }
    }

    pub fn shutdown(&mut self) -> Vec<thread::JoinHandle<()>> {
        self.begin_shutdown();
        for client in self.clients.values() {
            let _ = client.cancelled.send(true);
        }
        for session in self.sessions.values_mut() {
            if session.info.running {
                let _ = session.kill();
            }
        }
        for (_, session) in self.sessions.drain() {
            self.cleanup_workers
                .push(thread::spawn(move || drop(session)));
        }
        std::mem::take(&mut self.cleanup_workers)
    }
}

struct SpawnIdentity<'a> {
    id: Option<&'a str>,
    role: crate::caller::Role,
    harness: bool,
    codex_hooks: bool,
    gemini_hooks: bool,
    claude_quota_capture: Option<&'a crate::claude_statusline::Prepared>,
    native_grant: &'a crate::tool_permissions::Grant,
    child_tools: &'a [String],
}
fn spawn_session(
    name: &str,
    cwd: &Path,
    program: Program,
    mut command: CommandBuilder,
    events: mpsc::Sender<PtyEvent>,
    caller_url: Option<&str>,
    identity: SpawnIdentity<'_>,
) -> Result<Session> {
    let id = identity
        .id
        .map(str::to_owned)
        .unwrap_or_else(|| hex::encode(crate::wire::random::<16>()));
    command.env("NESVO_SESSION_ID", &id);
    let mut caller_context = caller_url
        .map(|url| crate::caller::Context::new(url, &id, identity.role))
        .transpose()?;
    if let Some(context) = &mut caller_context {
        context.set_child_policy(identity.child_tools)?;
        context.bind(&mut command);
        if identity.harness {
            context.configure_claude(&mut command, identity.native_grant)?;
        }
    }
    let agent_context = if program == Program::Claude {
        let recovery = if identity.harness {
            let context = caller_context
                .as_ref()
                .ok_or_else(|| anyhow!("Harness caller context is unavailable"))?;
            Some((context.recovery_hook()?, context.permission_rules()))
        } else {
            None
        };
        Some(crate::agent_context::Tracker::install_claude(
            &mut command,
            &id,
            recovery,
            identity.claude_quota_capture,
        )?)
    } else if program == Program::Codex && identity.codex_hooks {
        Some(crate::agent_context::Tracker::install_codex(
            &mut command,
            &id,
        )?)
    } else if program == Program::Gemini && identity.gemini_hooks {
        Some(crate::agent_context::Tracker::install_gemini(
            &mut command,
            &id,
        )?)
    } else {
        None
    };
    let pty = Pty::spawn(&id, command, terminal_size(80, 24)?, events)?;
    Ok(Session {
        repository_binding: crate::session_repository::Binding {
            id: id.clone(),
            incarnation: crate::wire::random::<16>(),
            directory: cwd.to_path_buf(),
        },
        quota_binding: None,
        quota_wake: None,
        claude_quota: None,
        claude_capture_diagnostic: None,
        model_selection: Default::default(),
        harness_enabled: identity.harness,
        policy: crate::caller::Policy::new(identity.role),
        caller_context,
        started: std::time::Instant::now(),
        elapsed_at_exit: None,
        agent_context,
        integration_delivery: Default::default(),
        integration_shadow_sequence: None,
        conversation_identity: None,
        resume: None,
        lifecycle_cursor: 0,
        status_latency: Default::default(),
        lifecycle_gap: false,
        status: StatusTracker::new(program, 24, 80, now_millis()),
        readiness: crate::readiness::Tracker::new(program),
        turn: Default::default(),
        pending_input: None,
        quota_predecessor: None,
        human_input_dirty: false,
        human_control_epoch: 0,
        terminal_protocol: Default::default(),
        program_status: Default::default(),
        status_projection_dirty: false,
        wake_attention: Default::default(),
        info: SessionInfo {
            id,
            name: name.into(),
            cwd: crate::process::display_path(cwd),
            created_at: chrono::Utc::now().to_rfc3339(),
            cols: 80,
            rows: 24,
            running: true,
            group_id: None,
            parent_session_id: None,
            program,
        },
        pty,
        backlog: String::new(),
        output_cursor: 0,
        controller: None,
        subscribers: HashSet::new(),
        has_been_attached: false,
        wake_at: None,
        attention: Default::default(),
        attention_dirty: false,
        titles: Default::default(),
        auto_title: false,
    })
}

async fn flush_submission_updates(state: &Arc<Mutex<State>>) {
    let (log, updates) = {
        let mut state = state.lock().unwrap();
        for session in state.sessions.values_mut() {
            let exit_expired = session.elapsed_at_exit.is_some_and(|at| {
                session.started.elapsed().saturating_sub(at) >= Duration::from_secs(2)
            });
            if let Some(pending) = &mut session.pending_input
                && pending.queued
                && (*pending.canceled.borrow() || exit_expired)
            {
                pending.canceled.send_replace(true);
                pending.correlation = None;
                pending.queued = false;
                pending.reconciliation_queued = true;
            }
        }
        let canceled: Vec<_> = state
            .sessions
            .values()
            .filter_map(|session| session.pending_input.as_ref())
            .filter(|p| p.reconciliation_queued)
            .map(|p| p.claim.clone())
            .collect();
        for claim in canceled {
            if !state
                .submission_updates
                .iter()
                .any(|update| update.claim.id == claim.id)
            {
                state
                    .submission_updates
                    .push(crate::submission::Transition {
                        claim,
                        phase: "unknown",
                        result: json!({"code":"submission_reconciliation","taskResult":null}),
                    });
            }
        }
        let updates = std::mem::take(&mut state.submission_updates);
        (state.event_log.clone(), updates)
    };
    let Some(log) = log else {
        return;
    };
    for update in updates {
        let claim = update.claim;
        match log
            .finish(
                claim.issuer.clone(),
                claim.id.clone(),
                claim.token.clone(),
                update.phase.into(),
                update.result.clone(),
            )
            .await
        {
            Ok(receipt) => state.lock().unwrap().end_submission(
                &receipt.session_id,
                &receipt.id,
                &receipt.phase,
            ),
            Err(error)
                if error
                    .downcast_ref::<crate::api_error::Error>()
                    .is_some_and(|error| {
                        matches!(error.code, "stale_operation" | "operation_not_found")
                    }) =>
            {
                // A fenced/terminal claim can never become writable by retrying.
                let mut state = state.lock().unwrap();
                for session in state.sessions.values_mut() {
                    if session
                        .pending_input
                        .as_ref()
                        .is_some_and(|pending| pending.claim.id == claim.id)
                    {
                        session.pending_input = None;
                        if error
                            .downcast_ref::<crate::api_error::Error>()
                            .is_some_and(|error| error.code == "operation_not_found")
                        {
                            session.human_input_dirty = true;
                        }
                    }
                }
            }
            Err(_) => {
                state
                    .lock()
                    .unwrap()
                    .submission_updates
                    .push(crate::submission::Transition {
                        claim,
                        phase: update.phase,
                        result: update.result,
                    })
            }
        }
    }
}

fn lifecycle_eligible(session: &Session) -> bool {
    session.info.running
        || session
            .elapsed_at_exit
            .is_some_and(|at| session.started.elapsed().saturating_sub(at) < Duration::from_secs(2))
}

pub async fn dispatch_output(state: Arc<Mutex<State>>, mut events: mpsc::Receiver<PtyEvent>) {
    let weak = Arc::downgrade(&state);
    // File I/O runs independently of PTY dispatch and outside the host mutex.
    let lifecycle_task = tokio::spawn(async move {
        let mut observers = HashMap::<String, crate::agent_events::Observer>::new();
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let Some(state) = weak.upgrade() else { break };
            flush_submission_updates(&state).await;
            state.lock().unwrap().expire_unobserved_resumes();
            let reports: Vec<_> = {
                let state = state.lock().unwrap();
                observers.retain(|id, _| {
                    state.sessions.get(id).is_some_and(|session| {
                        lifecycle_eligible(session) && session.agent_context.is_some()
                    })
                });
                state
                    .sessions
                    .iter()
                    .filter(|(_, session)| lifecycle_eligible(session))
                    .filter_map(|(id, session)| {
                        session.agent_context.as_ref().map(|tracker| {
                            (
                                id.clone(),
                                tracker.report(),
                                session.lifecycle_cursor,
                                session.info.program == Program::Claude,
                                session.caller_context.as_ref().and_then(|context| {
                                    session.harness_enabled.then(|| context.recovery_report())
                                }),
                                tracker.capture_anchor().cloned(),
                                session
                                    .resume
                                    .as_ref()
                                    .is_some_and(crate::resume::Gate::pending),
                            )
                        })
                    })
                    .collect()
            };
            for (id, path, after, claude, recovery_path, capture_anchor, resume_pending) in reports
            {
                let resume_start = if resume_pending {
                    crate::resume::read_start(&path).await
                } else {
                    None
                };
                let observation = crate::agent_context::observe(&path).await;
                let recovery = match recovery_path {
                    Some(path) => Some(crate::caller::observe_recovery(&path).await),
                    None => None,
                };
                let capture_configured = capture_anchor.is_some();
                let mut observer = observers
                    .remove(&id)
                    .filter(|observer| observer.matches(&path, &id))
                    .unwrap_or_else(|| {
                        crate::agent_events::Observer::new(path, id.clone())
                            .with_capture(capture_anchor)
                    });
                let batch = tokio::task::spawn_blocking(move || {
                    let mut counts = crate::agent_events::ReadCounts::default();
                    let result = observer.poll(after, claude, &mut counts);
                    (observer, result, counts)
                })
                .await;
                let mut state = state.lock().unwrap();
                let (batch, capture_view) = match batch {
                    Ok((observer, result, counts)) => {
                        let capture_view = observer.capture_diagnostic().cloned();
                        observers.insert(id.clone(), observer);
                        state.lifecycle_observer.accumulate(counts);
                        (result.ok(), capture_view)
                    }
                    Err(_) => {
                        state
                            .lifecycle_observer
                            .accumulate(crate::agent_events::ReadCounts {
                                scope_polls: 1,
                                blocking_task_failures: 1,
                                ..Default::default()
                            });
                        (
                            None,
                            capture_configured
                                .then(crate::claude_quota_diagnostics::View::failed_read),
                        )
                    }
                };
                let event_log = state.event_log.clone();
                let mut submission_updates = Vec::new();
                let mut conversation_changed = false;
                let mut resume_changed = false;
                if let Some(session) = state.sessions.get_mut(&id) {
                    let previous_conversation = session
                        .conversation_identity
                        .as_ref()
                        .and_then(|identity| identity.provider_session_id.clone());
                    session.claude_capture_diagnostic = capture_view;
                    if let Some(recovery) = recovery
                        && let Some(context) = session.caller_context.as_mut()
                        && context.recovery_status != recovery
                    {
                        context.recovery_status = recovery;
                        session.status_projection_dirty = true;
                    }
                    let elapsed = session
                        .elapsed_at_exit
                        .unwrap_or_else(|| session.started.elapsed());
                    session.integration_delivery = observation.delivery;
                    session.integration_shadow_sequence = observation.report.map(|r| r.sequence);
                    match batch {
                        Some(crate::agent_events::Observed {
                            lifecycle: batch,
                            quota,
                        }) => {
                            session.claude_quota = quota.filter(|quota| {
                                quota.scope.launch_id == batch.identity.launch_id
                                    && quota.scope.generation == batch.identity.generation
                                    && Some(&quota.scope.provider_session_id)
                                        == batch.identity.provider_session_id.as_ref()
                            });
                            session.lifecycle_gap |= batch.gap;
                            if batch.gap {
                                session.turn.gap(elapsed);
                                if let Some(pending) = &session.pending_input {
                                    pending.canceled.send_replace(true);
                                }
                            }
                            if !batch.observed {
                                session.integration_delivery.outcome = "missing";
                            } else {
                                session.integration_delivery.outcome =
                                    if batch.gap { "gap" } else { "received" };
                            }
                            for event in batch.events {
                                session.lifecycle_cursor = event.sequence;
                                if event.generation == batch.identity.generation {
                                    if let Some(pending) = &mut session.pending_input
                                        && !*pending.canceled.borrow()
                                        && let Some(correlation) = &mut pending.correlation
                                        && let Some((phase, result)) =
                                            correlation.observe(&batch.identity, &event)
                                    {
                                        if phase == "received"
                                            && let Some(arm) = &pending.quota_resume
                                            && let Some(mut original) =
                                                session.quota_predecessor.take()
                                            && let Some(correlation) = &mut original.correlation
                                            && let Some(("interrupted", mut result)) =
                                                correlation.observe(&batch.identity, &event)
                                        {
                                            result["code"] = json!("quota_resumed");
                                            result["quotaWakeId"] = json!(arm.id);
                                            result["supersededBy"] = json!(pending.claim.id);
                                            submission_updates.push(
                                                crate::submission::Transition {
                                                    claim: original.claim,
                                                    phase: "interrupted",
                                                    result,
                                                },
                                            );
                                        }
                                        submission_updates.push(crate::submission::Transition {
                                            claim: pending.claim.clone(),
                                            phase,
                                            result,
                                        });
                                    }
                                    session.status_projection_dirty |= session.turn.event(
                                        crate::turns::Signal {
                                            launch: &batch.identity.launch_id,
                                            generation: event.generation,
                                            sequence: event.sequence,
                                            event: &event.name,
                                            state: event.state,
                                        },
                                        elapsed,
                                        now_millis(),
                                    );
                                    if event.name == "Stop"
                                        && let Some(turn) = session.turn.snapshot(elapsed)
                                        && turn.phase == crate::turns::Phase::Settled
                                    {
                                        let new_response = session.attention.response_settled(
                                            event.sequence,
                                            turn.id,
                                            turn.observed_at,
                                        );
                                        session.attention_dirty |= new_response;
                                        if new_response && let Some(log) = &event_log {
                                            log.observe(crate::event_log::Observation{session_id:Some(id.clone()),kind:"response.settled",at:now_millis(),payload:json!({"turnId":turn.id,"taskResult":null})});
                                        }
                                    }
                                    if session.status.lifecycle_ordered(
                                        crate::agent_context::LifecycleReport {
                                            state: event.state,
                                            sequence: event.sequence,
                                        },
                                        now_millis(),
                                    ) {
                                        session.status_latency.received(std::time::Instant::now());
                                        session.status.record_hook_reason(&event.name, event.state);
                                        session.status_projection_dirty = true;
                                        if let Some(log) = &event_log {
                                            log.observe(crate::event_log::Observation{session_id:Some(id.clone()),kind:"agent.lifecycle",at:now_millis(),payload:json!({"event":event.name,"state":event.state,"generation":event.generation,"sourceSequence":event.sequence,"submissionEvidence":event.prompt_digest.is_some()||event.paste_digest.is_some()})});
                                        }
                                    }
                                }
                            }
                            session.conversation_identity = Some(batch.identity);
                            if !session.info.running {
                                session.turn.process_exit(elapsed);
                            }
                        }
                        None => {
                            session.claude_quota = None;
                            session.integration_delivery.outcome = "queueUnreadable";
                        }
                    }
                    let bound = session
                        .conversation_identity
                        .as_ref()
                        .and_then(|identity| identity.provider_session_id.clone());
                    conversation_changed = bound != previous_conversation;
                    if let Some(gate) = session.resume.as_mut() {
                        resume_changed = gate.observe(crate::resume::Evidence {
                            start: resume_start.as_ref(),
                            bound: bound.as_deref(),
                            running: session.info.running,
                            elapsed,
                        });
                    }
                }
                if (conversation_changed || resume_changed)
                    && let Some(session) = state.sessions.get(&id)
                    && let Err(error) = state.persist_session(session)
                {
                    eprintln!("Could not persist the conversation identity: {error}");
                }
                if resume_changed {
                    state.broadcast_list();
                }
                state.submission_updates.extend(submission_updates);
            }
            flush_submission_updates(&state).await;
        }
    });
    let mut status_tick = tokio::time::interval(Duration::from_millis(250));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let event = tokio::select! {
            event = events.recv() => match event { Some(event) => event, None => break },
            _ = status_tick.tick() => {
                state.lock().unwrap().refresh_status();
                continue;
            }
        };
        let mut state = state.lock().unwrap();
        match event {
            PtyEvent::Data(id, data) => {
                if let Some(session) = state.sessions.get_mut(&id) {
                    let feed = session.terminal_protocol.feed(&data);
                    let previous_root = session.program_status.root().cloned();
                    let mut root_reported = false;
                    let mut replies = String::new();
                    for event in feed.events {
                        if !session.info.running {
                            continue;
                        }
                        match event {
                            crate::terminal_protocol::Event::Reply(reply) => {
                                // Bound reply amplification per PTY chunk and enqueue once.
                                if replies.len() + reply.len() <= 4096 {
                                    replies.push_str(reply);
                                }
                            }
                            crate::terminal_protocol::Event::Report(report) => {
                                session.status_latency.received(std::time::Instant::now());
                                root_reported |= report.id.is_none();
                                session.program_status.apply(report);
                                session.status_projection_dirty = true;
                            }
                            crate::terminal_protocol::Event::Reset => {
                                session.program_status.reset();
                                session.status_projection_dirty = true;
                            }
                            crate::terminal_protocol::Event::Prompt => {
                                session.program_status.end_program();
                                session.status_projection_dirty = true;
                            }
                        }
                    }
                    // Protocol replies precede forwarding the DA1/output sentinel and
                    // never pass through user input/turn accounting.
                    if !replies.is_empty()
                        && let Err(error) = session.pty.send_input(replies)
                    {
                        eprintln!(
                            "Terminal protocol replies could not be queued for {id}: {error}"
                        );
                    }
                    if root_reported || previous_root.as_ref() != session.program_status.root() {
                        session
                            .status
                            .program_report(session.program_status.root(), now_millis());
                    }
                    let data = feed.visible;
                    session.status.output(&data, now_millis());
                    if session.auto_title {
                        session.titles.feed(&data);
                    }
                    bounded_append(&mut session.backlog, &data);
                    session.output_cursor = session.output_cursor.saturating_add(data.len() as u64);
                    let subscribers: Vec<u64> = session.subscribers.iter().copied().collect();
                    for client_id in subscribers {
                        for chunk in output_chunks(&data) {
                            state.send(
                                client_id,
                                json!({"type":"output", "sessionId":id, "data":chunk}),
                            );
                        }
                    }
                }
            }
            PtyEvent::Exited(id, code) => {
                if let Some(session) = state.sessions.get_mut(&id) {
                    session.info.running = false;
                    session.elapsed_at_exit = Some(session.started.elapsed());
                    session.status.exited(code);
                    session.turn.process_exit(session.started.elapsed());
                    session.program_status.end_program();
                    let data = match code {
                        Some(code) => format!("\r\n[Process exited with code {code}]\r\n"),
                        None => "\r\n[Process ended without a readable exit status]\r\n".into(),
                    };
                    bounded_append(&mut session.backlog, &data);
                    session.output_cursor = session.output_cursor.saturating_add(data.len() as u64);
                    let subscribers: Vec<u64> = session.subscribers.iter().copied().collect();
                    session.controller = None;
                    for client_id in subscribers {
                        state.send(
                            client_id,
                            json!({"type":"output", "sessionId":id, "data":data}),
                        );
                    }
                    state.broadcast_control(&id);
                    state.emit(Some(&id), "process.exited", json!({"exitCode":code}));
                    // The timer coalesces final state with other status changes.
                }
            }
            PtyEvent::InputError(id) => {
                if let Some(client_id) = state
                    .sessions
                    .get(&id)
                    .and_then(|session| session.controller.as_ref().map(|lease| lease.client_id))
                {
                    state.send(client_id, json!({"type":"error", "message":"The shell could not accept input. It may have exited."}));
                }
            }
        }
    }
    lifecycle_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_native_launch_fence_retains_human_takeover_and_scope_revocation() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        state.set_caller_url("ws://127.0.0.1:1".into());
        let (events, _output) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Owned quota authority fixture".into(),
                    role: crate::caller::Role::Coordinator,
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let authority = crate::caller::Authority::Session {
            id: id.clone(),
            scope_id: state.sessions[&id]
                .caller_context
                .as_ref()
                .unwrap()
                .scope_id
                .clone(),
        };
        let before = state.quota_native_authority_epoch(&authority).unwrap();
        state.acquire(71, &id, 80, 24, true, false).unwrap();
        state.release_all(71);
        assert!(state.sessions[&id].controller.is_none());
        let refused = state
            .quota_native_authority_ready(&authority, before)
            .unwrap_err();
        assert_eq!(
            refused
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "control_busy"
        );
        let fresh = state.quota_native_authority_epoch(&authority).unwrap();
        state.sessions.get_mut(&id).unwrap().human_input_dirty = true;
        let refused = state
            .quota_native_authority_ready(&authority, fresh)
            .unwrap_err();
        assert_eq!(
            refused
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "unsafe_draft"
        );
        state.sessions.get_mut(&id).unwrap().human_input_dirty = false;
        state
            .sessions
            .get_mut(&id)
            .unwrap()
            .caller_context
            .as_mut()
            .unwrap()
            .scope_id = "revoked-fixture".into();
        let refused = state
            .quota_native_authority_ready(&authority, fresh)
            .unwrap_err();
        assert_eq!(
            refused
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "scope_revoked"
        );
        state
            .quota_native_authority_ready(&crate::caller::Authority::Owner, before)
            .unwrap();
        state.begin_shutdown();
        let refused = state
            .quota_native_authority_ready(&crate::caller::Authority::Owner, fresh)
            .unwrap_err();
        assert_eq!(
            refused
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "host_stopping"
        );
        assert_eq!(state.sessions.len(), 1);
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn shutdown_admission_fence_preserves_sessions_but_refuses_late_paste_and_enter() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, _output) = mpsc::channel(128);
        let spec = crate::jobs::LaunchSpec {
            name: "Owned shutdown input fence".into(),
            ..Default::default()
        };
        let id = state.launch(&spec, &events).unwrap();
        let operation = "shutdown-input-fixture";
        let _pending = state
            .begin_submission(
                &id,
                crate::submission::Claim {
                    id: operation.into(),
                    issuer: "owner".into(),
                    token: "owned-fixture-only".into(),
                },
                "literal fixture text",
                &crate::caller::Authority::Owner,
            )
            .unwrap();
        state.begin_shutdown();
        assert!(state.sessions[&id].info.running);
        assert_eq!(state.sessions.len(), 1);
        assert!(state.launch(&spec, &events).is_err());
        for text in [Some("literal fixture text"), None] {
            let error = state
                .enqueue_submission(&id, operation, text, None)
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                "host_stopping"
            );
        }
        assert!(!state.sessions[&id].pending_input.as_ref().unwrap().queued);
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn listener_is_default_off_and_doctor_matches_the_advertised_runtime_address() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let disabled = json!({"enabled":false,"address":null});
        assert_eq!(state.capabilities_event()["jobTriggerListener"], disabled);
        assert_eq!(
            state.diagnostics(None).unwrap()["jobTriggerListener"],
            disabled
        );
        let capabilities = state.capabilities_event();
        assert_eq!(capabilities["jobExternalTriggers"], true);
        assert_eq!(
            capabilities["jobTriggerProviders"],
            json!(["webhook", "github"])
        );
        assert!(
            capabilities["jobScheduleKinds"]
                .as_array()
                .unwrap()
                .contains(&json!("external"))
        );

        state.set_job_trigger_listener(Some("http://127.0.0.1:1234".into()));
        let enabled = json!({"enabled":true,"address":"http://127.0.0.1:1234"});
        assert_eq!(state.capabilities_event()["jobTriggerListener"], enabled);
        assert_eq!(
            state.diagnostics(None).unwrap()["jobTriggerListener"],
            enabled
        );
        state.set_job_trigger_listener(None);
        assert_eq!(state.capabilities_event()["jobTriggerListener"], disabled);
    }

    #[test]
    fn internal_wake_grant_is_self_only_revocable_and_not_general_api_or_control_authority() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        state.set_caller_url("ws://127.0.0.1:1".into());
        let (events, _) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Owned wake authority fixture".into(),
                    role: crate::caller::Role::Coordinator,
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let scope = state.sessions[&id]
            .caller_context
            .as_ref()
            .unwrap()
            .scope_id
            .clone();
        let normal = crate::caller::Authority::Session {
            id: id.clone(),
            scope_id: scope,
        };
        assert!(
            state.authorize_automation(&normal, &id).is_err(),
            "Normal coordinator does not gain self input authority"
        );
        let wake = state.wake_authority(&normal, &id).unwrap();
        assert!(state.authorize_automation(&wake, &id).is_ok());
        assert!(state.authorize_automation(&wake, "foreign").is_err());
        assert!(state.actor_session(&wake).is_err());
        assert!(
            state
                .dispatch_control(&id, crate::operations::ControlAction::Stop, &wake)
                .is_err()
        );
        assert!(
            state
                .resolve_launch(&wake, &mut crate::jobs::LaunchSpec::default())
                .is_err()
        );
        state.lifecycle_observer.scope_polls = 7;
        for (client_id, authority, owner) in [
            (1, crate::caller::Authority::Owner, true),
            (2, normal.clone(), false),
        ] {
            let (client_events, mut replies) = mpsc::channel(8);
            let (cancelled, _) = watch::channel(false);
            state.clients.insert(
                client_id,
                Client {
                    events: client_events,
                    cancelled,
                    authority,
                },
            );
            state
                .command(
                    client_id,
                    Command::GetDiagnostics {
                        session_id: Some(id.clone()),
                    },
                    None,
                    &events,
                )
                .unwrap();
            let response = replies.try_recv().unwrap();
            assert_eq!(response["type"], "diagnostics");
            let report = &response["report"];
            assert_eq!(report.get("lifecycleObserver").is_some(), owner);
            if owner {
                assert_eq!(report["lifecycleObserver"]["counts"]["scopePolls"], 7);
                assert!(
                    report["lifecycleObserver"]["counts"]
                        .as_object()
                        .unwrap()
                        .values()
                        .all(Value::is_u64)
                );
            } else {
                assert!(report.get("providerQuota").is_none());
            }
        }
        state
            .sessions
            .get_mut(&id)
            .unwrap()
            .caller_context
            .as_mut()
            .unwrap()
            .scope_id = "revoked-fixture".into();
        assert!(state.authorize_automation(&wake, &id).is_err());
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn native_run_gates_are_scoped_released_and_do_not_retain_inactive_runs() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let first = state.native_run_permit("first").unwrap();
        assert!(state.native_run_permit("first").is_err());
        let second = state.native_run_permit("second").unwrap();
        drop(first);
        drop(second);
        for index in 0..100 {
            drop(state.native_run_permit(&format!("run-{index}")).unwrap());
        }
        assert!(state.native_run_gates.len() <= 1);
        assert!(state.native_run_permit("").is_err());
    }

    #[test]
    fn schedule_notifications_are_opt_in_for_older_clients() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let (events, mut receiver) = mpsc::channel(8);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events,
                cancelled,
                authority: Default::default(),
            },
        );
        state.broadcast_schedules();
        assert!(receiver.try_recv().is_err());
        let (pty_events, _) = mpsc::channel(1);
        state
            .command(1, Command::ListSchedules, None, &pty_events)
            .unwrap();
        assert_eq!(receiver.try_recv().unwrap()["type"], "schedules");
        state.broadcast_schedules();
        assert_eq!(receiver.try_recv().unwrap()["type"], "schedules");
        state.disconnect(1);
        assert!(!state.schedule_watchers.contains(&1));
    }

    fn review_client(state: &mut State, id: u64) -> mpsc::Receiver<Value> {
        let (events, inbox) = mpsc::channel(64);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            id,
            Client {
                events,
                cancelled,
                authority: Default::default(),
            },
        );
        inbox
    }

    #[test]
    fn review_notifications_are_opt_in_and_scoped_callers_are_refused_review_and_files_commands() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        state.set_caller_url("ws://127.0.0.1:1".into());
        let (events, _output) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Owned scoped review fixture".into(),
                    role: crate::caller::Role::Coordinator,
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let scope_id = state.sessions[&id]
            .caller_context
            .as_ref()
            .unwrap()
            .scope_id
            .clone();
        let mut owner = review_client(&mut state, 1);
        let (scoped_events, _scoped) = mpsc::channel(8);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            2,
            Client {
                events: scoped_events,
                cancelled,
                authority: crate::caller::Authority::Session {
                    id: id.clone(),
                    scope_id,
                },
            },
        );
        let directory = crate::process::display_path(&std::env::temp_dir());
        let commands = [
            Command::OpenReview {
                source: crate::review::SourceRequest::Local {
                    session_id: Some(id.clone()),
                    directory: None,
                },
                base: None,
            },
            Command::ReviewContext {
                review_id: "local-0000000000000000".into(),
            },
            Command::DeliverReview {
                review_id: "local-0000000000000000".into(),
                session_id: id.clone(),
                text: "Fix the guard".into(),
                key: None,
                lease_id: None,
            },
            Command::WatchReviews,
            Command::ListEntries {
                directory: directory.clone(),
                show_hidden: false,
            },
            Command::ReadFile {
                path: directory.clone(),
                offset: None,
                limit: None,
            },
            Command::FindFiles {
                root: directory,
                query: "a".into(),
                limit: None,
            },
        ];
        for command in &commands {
            assert!(state.authorize(1, command).is_ok());
            let refused = state.authorize(2, command).unwrap_err();
            assert_eq!(
                refused
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                "forbidden"
            );
        }
        assert_eq!(state.review_watchers().count(), 0);
        state
            .command(1, Command::WatchReviews, None, &events)
            .unwrap();
        assert_eq!(owner.try_recv().unwrap()["type"], "reviewsWatched");
        assert_eq!(state.review_watchers().collect::<Vec<_>>(), [1]);
        state.watch_reviews(9);
        state.disconnect(1);
        assert_eq!(state.review_watchers().count(), 0);
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[tokio::test]
    async fn review_delivery_routes_by_control_lease_and_caps_the_operation_path() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, _output) = mpsc::channel(128);
        let spec = crate::jobs::LaunchSpec {
            name: "Owned review delivery fixture".into(),
            ..Default::default()
        };
        let id = state.launch(&spec, &events).unwrap();
        let now = now_millis();
        let session = state.sessions.get_mut(&id).unwrap();
        session.info.program = Program::Claude;
        session.status = StatusTracker::new(Program::Claude, 24, 80, now);
        session.status.lifecycle(
            crate::agent_context::LifecycleReport {
                state: crate::status::StatusState::Idle,
                sequence: 1,
            },
            now,
        );
        session.status.refresh(now);
        session.readiness = crate::readiness::Tracker::new(Program::Claude);
        session
            .readiness
            .observe(session.status.status(), None, Duration::ZERO);
        let _first = review_client(&mut state, 1);
        let _second = review_client(&mut state, 2);
        state.reviews.insert(crate::review::Entry {
            id: "local-delivery".into(),
            directory: std::env::temp_dir(),
            source: json!({"kind":"local"}),
            session_id: None,
            base: None,
            base_label: None,
            head_ref: None,
            remote_head: None,
            checks: None,
        });
        let state = Arc::new(Mutex::new(state));
        let request = |text: &str, lease_id: Option<String>| crate::review::Delivery {
            review_id: "local-delivery".into(),
            session_id: id.clone(),
            text: text.into(),
            key: None,
            lease_id,
        };
        let review_code = |error: anyhow::Error| {
            error
                .downcast_ref::<crate::review::Failure>()
                .map(|failure| failure.code)
                .or_else(|| {
                    error
                        .downcast_ref::<crate::api_error::Error>()
                        .map(|error| error.code)
                })
                .unwrap_or("other")
        };
        let large = "x".repeat(8193);
        let refused = crate::review::deliver(&state, &events, 1, request(&large, None)).await;
        assert_eq!(review_code(refused.unwrap_err()), "too_large");
        let journal = crate::review::deliver(&state, &events, 1, request("Fix it", None)).await;
        assert_eq!(review_code(journal.unwrap_err()), "unsupported");

        state
            .lock()
            .unwrap()
            .acquire(1, &id, 80, 24, false, false)
            .unwrap();
        let lease = state.lock().unwrap().sessions[&id]
            .controller
            .as_ref()
            .unwrap()
            .id
            .clone();
        let busy = crate::review::deliver(&state, &events, 2, request("Fix it", None)).await;
        assert_eq!(review_code(busy.unwrap_err()), "control_busy");
        let pasted = crate::review::deliver(&state, &events, 1, request(&large, Some(lease)))
            .await
            .unwrap();
        assert_eq!(pasted["path"], "paste");
        assert_eq!(pasted["bytes"], 8193);
        assert_eq!(pasted["receipt"]["result"]["submitted"], false);
        let workers = state.lock().unwrap().shutdown();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn attention_inbox_events_and_pushes_reach_only_opted_in_clients_and_phones() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let capabilities = state.capabilities_event();
        for flag in ["attentionInbox", "decisions", "jobPages"] {
            assert_eq!(capabilities[flag], false);
        }
        let mut receivers = Vec::new();
        for id in [1, 2] {
            let (events, receiver) = mpsc::channel(8);
            let (cancelled, _) = watch::channel(false);
            state.clients.insert(
                id,
                Client {
                    events,
                    cancelled,
                    authority: Default::default(),
                },
            );
            receivers.push(receiver);
        }
        let (pty_events, _) = mpsc::channel(1);
        let legacy = "ExpoPushToken[legacyphone01]";
        let current = "ExpoPushToken[currentphone1]";
        state
            .command(
                1,
                Command::RegisterPush {
                    token: legacy.into(),
                    enabled: true,
                    kinds: None,
                },
                None,
                &pty_events,
            )
            .unwrap();
        let legacy_reply = receivers[0].try_recv().unwrap();
        assert_eq!(legacy_reply["type"], "pushRegistered");
        assert!(legacy_reply.get("kinds").is_none());
        let signal = || crate::attention_inbox::Signal {
            reason: "decision",
            item: Some("decision:run:question".into()),
            push: Some(crate::attention_inbox::PUSH_DECISION),
        };
        state.attention_signal(signal());
        state.notify_attention("session", None);
        assert!(receivers[0].try_recv().is_err());
        assert!(receivers[1].try_recv().is_err());
        assert!(state.next_push().is_none());
        state
            .command(
                2,
                Command::RegisterPush {
                    token: current.into(),
                    enabled: true,
                    kinds: Some(vec![
                        crate::attention_inbox::PUSH_DECISION.into(),
                        crate::attention_inbox::PUSH_DECISION.into(),
                    ]),
                },
                None,
                &pty_events,
            )
            .unwrap();
        assert_eq!(
            receivers[1].try_recv().unwrap()["kinds"],
            json!([crate::attention_inbox::PUSH_DECISION])
        );
        assert!(
            state
                .command(
                    2,
                    Command::RegisterPush {
                        token: current.into(),
                        enabled: true,
                        kinds: Some(vec!["everything".into()]),
                    },
                    None,
                    &pty_events,
                )
                .is_err()
        );
        state.watch_attention(2);
        state.attention_signal(signal());
        let changed = receivers[1].try_recv().unwrap();
        assert_eq!(changed["type"], "attentionInboxChanged");
        assert_eq!(changed["itemId"], "decision:run:question");
        assert!(receivers[0].try_recv().is_err());
        let job = state.next_push().unwrap();
        assert_eq!(job.token, current);
        assert_eq!(job.item.as_deref(), Some("decision:run:question"));
        assert!(state.next_push().is_none());
        state.attention_signal(crate::attention_inbox::Signal {
            reason: "result",
            item: Some("result:occurrence".into()),
            push: Some(crate::attention_inbox::PUSH_RESULT),
        });
        assert!(state.next_push().is_none());
        assert!(
            state
                .command(
                    2,
                    Command::AttentionInbox {
                        page: None,
                        limit: None,
                    },
                    None,
                    &pty_events,
                )
                .is_err()
        );
        state.disconnect(2);
        assert!(!state.attention_watchers.contains(&2));
    }

    #[test]
    fn legacy_wake_command_requires_the_durable_async_path() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let (client_events, _) = mpsc::channel(16);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events: client_events,
                cancelled,
                authority: Default::default(),
            },
        );
        let (events, _) = mpsc::channel(1);
        for enabled in [true, false] {
            let error = state
                .command(
                    1,
                    Command::SetWake {
                        session_id: "absent".into(),
                        enabled,
                    },
                    None,
                    &events,
                )
                .unwrap_err();
            assert!(error.to_string().contains("asynchronous durable"));
        }
    }
    #[test]
    fn quota_wake_never_types_over_a_human_draft_or_unsettled_submission() {
        // One owned shell supplies native resource lifetime only; no model runs.
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            workspace,
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, _receiver) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Quota guard fixture".into(),
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let now = chrono::Utc::now().timestamp();
        state.provider_limits = vec![ProviderLimit {
            id: Program::Codex,
            status: "ready",
            windows: vec![LimitWindow {
                used_percent: 20,
                duration_mins: 300,
                resets_at: Some(now + 60),
            }],
        }];
        state.limits_read_at = now;
        let session = state.sessions.get_mut(&id).unwrap();
        session.info.program = Program::Codex;
        session.status = StatusTracker::new(Program::Codex, 24, 80, 0);
        session
            .status
            .output("You've hit your usage limit. Try again later.\r\n› ", 1);
        session.status.refresh(2);
        assert!(session.status.rate_limited());
        session.wake_at = Some(now - 1);
        session.controller = Some(ControlLease {
            client_id: 1,
            id: "owned-fixture-only".into(),
            legacy: false,
        });
        assert!(
            !state.wake_after_reset(),
            "a current human lease must prevent automatic input"
        );
        assert_eq!(state.sessions[&id].wake_at, Some(now - 1));
        let session = state.sessions.get_mut(&id).unwrap();
        session.controller = None;
        session.human_input_dirty = true;
        assert!(
            !state.wake_after_reset(),
            "releasing control does not discard an unresolved draft"
        );
        let session = state.sessions.get_mut(&id).unwrap();
        session.human_input_dirty = false;
        let (canceled, _) = watch::channel(false);
        session.pending_input = Some(crate::submission::Pending {
            quota_resume: None,
            quota_sequence: None,
            quota_semantic_revision: None,
            authority: Default::default(),
            claim: crate::submission::Claim {
                id: "owned-pending".into(),
                issuer: "owner".into(),
                token: "fixture".into(),
            },
            canceled,
            correlation: None,
            digest: String::new(),
            source: None,
            queued: false,
            reconciliation_queued: false,
        });
        assert!(
            !state.wake_after_reset(),
            "quota recovery must not append to another pending submission"
        );
        assert_eq!(state.sessions[&id].wake_at, Some(now - 1));
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    fn quota_wake_input_fixture() -> (
        State,
        String,
        std::sync::mpsc::Receiver<crate::pty::InputTraceEvent>,
        mpsc::Receiver<PtyEvent>,
    ) {
        // An owned ordinary shell gives us the real native input queue without
        // starting any provider. All quota evidence below is explicit fixture data.
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            workspace,
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, output) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Quota wake native input fence".into(),
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let now = chrono::Utc::now().timestamp();
        state.provider_limits = vec![ProviderLimit {
            id: Program::Codex,
            status: "ready",
            windows: vec![LimitWindow {
                used_percent: 20,
                duration_mins: 300,
                resets_at: Some(now + 60),
            }],
        }];
        state.limits_read_at = now;
        let session = state.sessions.get_mut(&id).unwrap();
        session.info.program = Program::Codex;
        session.status = StatusTracker::new(Program::Codex, 24, 80, 0);
        session
            .status
            .output("You've hit your usage limit. Try again later.\r\n› ", 1);
        session.status.refresh(2);
        assert!(session.status.rate_limited());
        assert_eq!(
            session.status.status().state,
            crate::status::StatusState::Blocked
        );
        session.wake_at = Some(now - 1);
        let trace = session.pty.trace_input();
        // An empty confirmed barrier proves the real writer is live without
        // submitting text or executing a command in this shell.
        let _barrier = session.pty.send_confirmed(String::new()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let event = trace
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("Owned empty input barrier did not finish within two seconds");
            if event.phase == crate::pty::InputTracePhase::WriteFinished {
                assert_eq!(event.kind, crate::pty::InputTraceKind::Receipt);
                assert_eq!(event.bytes, 0);
                assert_eq!(event.written, Some(true));
                break;
            }
        }
        (state, id, trace, output)
    }

    #[test]
    fn quota_wake_shutdown_disarms_and_never_queues_native_input() {
        let (mut state, id, trace, _output) = quota_wake_input_fixture();
        state.begin_shutdown();
        assert!(state.sessions[&id].wake_at.is_none());
        assert!(state.sessions[&id].info.running);
        assert!(!state.wake_after_reset());
        // Even a stale in-memory callback holding the old timer cannot bypass
        // the final shutdown fence while terminal cleanup is still pending.
        state.sessions.get_mut(&id).unwrap().wake_at = Some(chrono::Utc::now().timestamp() - 1);
        assert!(!state.wake_after_reset());
        assert!(matches!(
            trace.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn ambient_reader_identity_cannot_replace_exact_session_wake_evidence() {
        let (mut state, id, trace, _output) = quota_wake_input_fixture();
        state.provider_quota = crate::provider_quota::Tracker::new(&[Program::Codex], [7; 32]);
        let observation = |account: &str| {
            let now = now_millis();
            let elapsed = crate::event_log::monotonic_millis();
            usage::CodexObservation {
                started_at_ms: now,
                finished_at_ms: now,
                started_elapsed_ms: elapsed,
                finished_elapsed_ms: elapsed,
                context: Some(usage::ReaderContext {
                    codex_home: "private-fixture-home".into(),
                    context_id: "private-fixture-context".into(),
                    route: usage::RouteObservation::unknown("fixture_route_unknown"),
                }),
                outcome: usage::ReadOutcome::Snapshot(usage::CodexSnapshot {
                    account_id: Some(account.into()),
                    ordinary_usage_allowed: Some(true),
                    windows: vec![
                        LimitWindow {
                            used_percent: 20,
                            duration_mins: 300,
                            resets_at: Some((now / 1000) as i64 + 3600),
                        },
                        LimitWindow {
                            used_percent: 20,
                            duration_mins: 10080,
                            resets_at: Some((now / 1000) as i64 + 86400),
                        },
                    ],
                    complete: true,
                    reason: "observed",
                    bucket: usage::BucketSource::NamedCodex,
                    completeness: usage::BucketCompleteness {
                        primary: usage::WindowState::Complete,
                        secondary: usage::WindowState::Complete,
                    },
                    spend_control_reached: None,
                    rate_limit_reached: false,
                }),
            }
        };
        state.observe_codex_quota(observation("owned-reader-A"));
        state.sessions.get_mut(&id).unwrap().wake_at = Some(chrono::Utc::now().timestamp() - 1);
        let armed = state.sessions[&id].wake_at;
        state.observe_codex_quota(observation("owned-reader-A"));
        assert_eq!(
            state.sessions[&id].wake_at, armed,
            "An unchanged reader does not cancel explicit intent"
        );
        state.observe_codex_quota(observation("owned-reader-B"));
        assert_eq!(
            state.sessions[&id].wake_at, armed,
            "An unrelated ambient reader cannot authorize or revoke a captured session context"
        );
        assert!(!state.wake_after_reset());
        assert!(matches!(
            trace.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn quota_wake_human_takeover_and_release_never_rearms_or_queues_native_input() {
        let (mut state, id, trace, _output) = quota_wake_input_fixture();
        let (client_events, _client_output) = mpsc::channel(128);
        let (cancelled, _cancellation) = watch::channel(false);
        state.clients.insert(
            2,
            Client {
                events: client_events,
                cancelled,
                authority: crate::caller::Authority::Owner,
            },
        );
        state.sessions.get_mut(&id).unwrap().controller = Some(ControlLease {
            client_id: 1,
            id: "previous-owned-controller".into(),
            legacy: false,
        });
        let armed = state.sessions[&id].wake_at;
        assert!(state.acquire(2, &id, 80, 24, false, false).is_err());
        assert_eq!(
            state.sessions[&id].wake_at, armed,
            "A rejected acquisition changes no wake intent"
        );
        state.acquire(2, &id, 80, 24, true, false).unwrap();
        assert!(state.sessions[&id].wake_at.is_none());
        assert!(state.sessions[&id].human_control_epoch > 0);
        assert!(
            !state.sessions[&id].human_input_dirty,
            "No human text is needed to disarm"
        );
        let lease_id = state.sessions[&id].controller.as_ref().unwrap().id.clone();
        let (events, _command_output) = mpsc::channel(1);
        state
            .command(
                2,
                Command::ReleaseControl {
                    session_id: id.clone(),
                    lease_id,
                },
                None,
                &events,
            )
            .unwrap();
        assert!(state.sessions[&id].controller.is_none());
        assert!(!state.wake_after_reset());
        assert!(state.sessions[&id].wake_at.is_none());
        assert!(matches!(
            trace.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }
    use crate::replay::BACKLOG_BYTES;
    #[test]
    fn directory_browser_returns_host_paths_and_echoes_request_id() {
        let workspace = std::env::temp_dir().join(format!(
            "nesvo-folder-test-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        let child = workspace.join("child folder");
        std::fs::create_dir_all(&child).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let child = child.canonicalize().unwrap();
        std::fs::write(workspace.join("file.txt"), "not a directory").unwrap();
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(workspace.clone(), metadata, Launchers::discover());
        let (events, mut receiver) = mpsc::channel(8);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events,
                cancelled,
                authority: Default::default(),
            },
        );
        let (pty_events, _) = mpsc::channel(1);
        state
            .command(
                1,
                Command::ListDirectories { path: None },
                Some("browse-1"),
                &pty_events,
            )
            .unwrap();
        let event = receiver.try_recv().unwrap();
        assert_eq!(event["type"], "directories");
        assert_eq!(event["requestId"], "browse-1");
        assert_eq!(event["path"], crate::process::display_path(&workspace));
        assert_eq!(event["entries"][0]["name"], "child folder");
        assert_eq!(
            event["entries"][0]["path"],
            crate::process::display_path(&child)
        );
        assert_eq!(event["entries"].as_array().unwrap().len(), 1);
        state
            .command(
                1,
                Command::ListDirectories {
                    path: Some(child.to_string_lossy().into_owned()),
                },
                Some("browse-2"),
                &pty_events,
            )
            .unwrap();
        let nested = receiver.try_recv().unwrap();
        assert_eq!(nested["parent"], crate::process::display_path(&workspace));
        std::fs::remove_dir_all(workspace).unwrap();
    }
    #[test]
    fn shutdown_rejects_new_commands() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        assert!(state.shutdown().is_empty());
        let (events, _) = mpsc::channel(1);
        let error = state.command(1, Command::List, None, &events).unwrap_err();
        assert_eq!(error.to_string(), "Host is shutting down.");
    }

    #[test]
    fn eight_full_replays_fit_before_writer_runs_but_output_queue_stays_bounded() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let (events, mut receiver) = mpsc::channel(crate::transport::CLIENT_EVENT_CAPACITY);
        let (cancelled, cancellation) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events,
                cancelled,
                authority: Default::default(),
            },
        );
        let history = "a".repeat(BACKLOG_BYTES);
        // Exercise the real replay chunking and queue overflow path without a
        // scheduler draining messages between subscriptions or any local PTYs.
        let sessions = usize::from(crate::budgets::Limits::default().max_sessions);
        for index in 0..sessions {
            let id = index.to_string();
            state.send(
                1,
                json!({"type":"subscribed", "sessionId":id, "cols":80, "rows":24}),
            );
            state.send(1, json!({"type":"control", "sessionId":id, "controllerId":null, "cols":80, "rows":24}));
            state.send_history(1, &id, &history, false);
        }
        assert!(!*cancellation.borrow());
        let mut restored_bytes = 0;
        while let Ok(event) = receiver.try_recv() {
            if let Some(data) = event["data"].as_str() {
                assert_eq!(event["replay"], true);
                restored_bytes += data.len();
            }
        }
        assert_eq!(restored_bytes, sessions * BACKLOG_BYTES);
        for _ in 0..=crate::transport::CLIENT_EVENT_CAPACITY {
            state.send(1, json!({"type":"output", "sessionId":"0", "data":"x"}));
        }
        assert!(
            *cancellation.borrow(),
            "A stalled writer is still disconnected"
        );
    }
    #[test]
    fn v2_leases_reject_wrong_owner_missing_and_replaced_tokens() {
        let current = ControlLease {
            client_id: 7,
            id: "new-token".into(),
            legacy: false,
        };
        assert!(current.accepts(7, Some("new-token")));
        assert!(!current.accepts(7, None));
        assert!(!current.accepts(8, Some("new-token")));
        assert!(!current.accepts(7, Some("old-token")));
        let legacy = ControlLease {
            legacy: true,
            ..current
        };
        assert!(legacy.accepts(7, None));
        assert!(!legacy.accepts(7, Some("old-token")));
    }
    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(9, 24).is_err());
        assert!(terminal_size(80, 151).is_err());
    }

    const RESUME_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const OTHER_ID: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn owner_client(state: &mut State) -> mpsc::Receiver<Value> {
        let (events, receiver) = mpsc::channel(16);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            1,
            Client {
                events,
                cancelled,
                authority: Default::default(),
            },
        );
        receiver
    }

    #[test]
    fn resume_restore_refuses_unverifiable_and_missing_conversations_without_consuming_the_record()
    {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let gemini = "a".repeat(32);
        let missing = "b".repeat(32);
        let codex = "c".repeat(32);
        metadata
            .save_recovery(
                &codex,
                &crate::jobs::LaunchSpec {
                    name: "Codex".into(),
                    program: Program::Codex,
                    resume: Some(crate::resume::Target {
                        provider: Program::Codex,
                        conversation_id: RESUME_ID.into(),
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        metadata
            .save_recovery(
                &gemini,
                &crate::jobs::LaunchSpec {
                    name: "Gemini".into(),
                    program: Program::Gemini,
                    resume: Some(crate::resume::Target {
                        provider: Program::Gemini,
                        conversation_id: RESUME_ID.into(),
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        metadata
            .save_recovery(
                &missing,
                &crate::jobs::LaunchSpec {
                    name: "Claude".into(),
                    program: Program::Claude,
                    ..Default::default()
                },
            )
            .unwrap();
        let mut state = State::new(PathBuf::new(), metadata, Launchers::discover());
        let mut receiver = owner_client(&mut state);
        assert_eq!(state.capabilities_event()["conversationResume"], true);
        let (events, _) = mpsc::channel(1);
        for (id, code) in [
            (&gemini, "unsupported"),
            (&missing, "resume_unavailable"),
            (&codex, "resume_unverifiable"),
        ] {
            let error = state
                .command(
                    1,
                    Command::RestoreSession {
                        id: id.clone(),
                        resume: false,
                        exact: true,
                    },
                    None,
                    &events,
                )
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                code
            );
        }
        state
            .command(1, Command::ListRecovery { offset: 0 }, Some("r"), &events)
            .unwrap();
        let listed = receiver.try_recv().unwrap();
        assert_eq!(listed["type"], "recovery");
        let records = listed["records"].as_array().unwrap();
        assert_eq!(records.len(), 3);
        assert!(records.iter().all(|record| record["state"] == "saved"));
        let gemini_record = records.iter().find(|r| r["id"] == gemini.as_str()).unwrap();
        assert_eq!(gemini_record["spec"]["resume"]["conversationId"], RESUME_ID);
    }

    #[test]
    fn resume_gate_without_a_tracker_fails_at_the_deadline_and_after_exit() {
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            workspace,
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, _receiver) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Untracked resume fixture".into(),
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let target = crate::resume::Target {
            provider: Program::Codex,
            conversation_id: RESUME_ID.into(),
        };
        let verification =
            |state: &State| json!(state.sessions[&id].resume.as_ref().unwrap().verification());
        let session = state.sessions.get_mut(&id).unwrap();
        assert!(session.agent_context.is_none());
        session.resume = Some(crate::resume::Gate::new(target.clone()));
        state.expire_unobserved_resumes();
        assert_eq!(verification(&state)["state"], "pending");
        let session = state.sessions.get_mut(&id).unwrap();
        session.started = std::time::Instant::now()
            .checked_sub(crate::resume::DEADLINE)
            .unwrap();
        state.expire_unobserved_resumes();
        assert_eq!(verification(&state)["state"], "resumeFailed");
        assert!(
            verification(&state)["reason"]
                .as_str()
                .unwrap()
                .contains("60 seconds")
        );
        let session = state.sessions.get_mut(&id).unwrap();
        session.resume = Some(crate::resume::Gate::new(target));
        session.kill().unwrap();
        session.info.running = false;
        session.elapsed_at_exit = Some(Duration::from_secs(1));
        state.expire_unobserved_resumes();
        assert_eq!(verification(&state)["state"], "resumeFailed");
        assert!(
            verification(&state)["reason"]
                .as_str()
                .unwrap()
                .contains("exited")
        );
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn resume_failure_marks_the_session_and_refuses_automated_input() {
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            workspace,
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        let (events, _receiver) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Resume gate fixture".into(),
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let target = crate::resume::Target {
            provider: Program::Claude,
            conversation_id: RESUME_ID.into(),
        };
        let session = state.sessions.get_mut(&id).unwrap();
        session.info.program = Program::Claude;
        session.resume = Some(crate::resume::Gate::new(target.clone()));
        let authority = crate::caller::Authority::default();
        let refusal = |state: &State| {
            state
                .check_submission(&id, "continue", &authority)
                .unwrap_err()
                .downcast_ref::<crate::api_error::Error>()
                .map(|error| error.code)
        };
        assert_eq!(refusal(&state), Some("resume_pending"));
        assert!(!state.delivery_target(&id).unwrap().ready);
        let fresh = crate::resume::Start {
            source: "startup".into(),
            session_id: OTHER_ID.into(),
        };
        let session = state.sessions.get_mut(&id).unwrap();
        assert!(
            session
                .resume
                .as_mut()
                .unwrap()
                .observe(crate::resume::Evidence {
                    start: Some(&fresh),
                    bound: Some(OTHER_ID),
                    running: true,
                    elapsed: Duration::ZERO,
                })
        );
        state.persist_session(&state.sessions[&id]).unwrap();
        assert_eq!(refusal(&state), Some("resume_failed"));
        let listed = state.list();
        let view = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == id.as_str())
            .unwrap()
            .clone();
        assert_eq!(view["resume"]["state"], "resumeFailed");
        assert!(
            view["resume"]["reason"]
                .as_str()
                .unwrap()
                .contains(OTHER_ID)
        );
        let saved = state.metadata.recoveries().unwrap();
        let record = saved.iter().find(|r| r["id"] == id.as_str()).unwrap();
        assert_eq!(record["spec"]["resume"], json!(target));
        assert!(record["spec"]["prompt"].as_str().unwrap().is_empty());
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }

    #[test]
    fn notes_capability_is_advertised_and_scoped_callers_are_refused_notes_commands() {
        let metadata = MetadataStore::open(Path::new(":memory:")).unwrap();
        let mut state = State::new(
            std::env::temp_dir().canonicalize().unwrap(),
            metadata,
            Launchers::discover_with_fixture_shell(),
        );
        assert_eq!(state.capabilities_event()["notes"], true);
        state.set_caller_url("ws://127.0.0.1:1".into());
        let (events, _output) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Scoped notes fixture".into(),
                    role: crate::caller::Role::Coordinator,
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let scope_id = state.sessions[&id]
            .caller_context
            .as_ref()
            .unwrap()
            .scope_id
            .clone();
        let _owner = review_client(&mut state, 1);
        let (scoped_events, _scoped) = mpsc::channel(8);
        let (cancelled, _) = watch::channel(false);
        state.clients.insert(
            2,
            Client {
                events: scoped_events,
                cancelled,
                authority: crate::caller::Authority::Session { id, scope_id },
            },
        );
        let path = crate::process::display_path(&std::env::temp_dir().join("a.md"));
        for command in [
            Command::ListNotes {
                root: crate::process::display_path(&std::env::temp_dir()),
            },
            Command::ReadNote { path: path.clone() },
            Command::WriteNote {
                path: path.clone(),
                text: "x".into(),
                expected_revision: None,
            },
            Command::DeleteNote { path },
        ] {
            assert!(crate::notes::handles(&command));
            assert!(state.authorize(1, &command).is_ok());
            let refused = state.authorize(2, &command).unwrap_err();
            assert_eq!(
                refused
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                "forbidden"
            );
            assert!(state.command(1, command, None, &events).is_err());
        }
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
    }
}
