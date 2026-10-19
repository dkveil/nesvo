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

const MAX_SESSIONS: usize = 8;

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
    caller_context: Option<crate::caller::Context>,
    started: std::time::Instant,
    elapsed_at_exit: Option<Duration>,
    agent_context: Option<crate::agent_context::Tracker>,
    integration_delivery: crate::agent_context::Delivery,
    integration_shadow_sequence: Option<u64>,
    conversation_identity: Option<crate::agent_events::Identity>,
    lifecycle_cursor: u64,
    lifecycle_gap: bool,
    status_latency: crate::status_latency::Tracker,
    info: SessionInfo,
    status: StatusTracker,
    readiness: crate::readiness::Tracker,
    turn: crate::turns::Tracker,
    pending_input: Option<crate::submission::Pending>,
    human_input_dirty: bool,
    terminal_protocol: crate::terminal_protocol::Decoder,
    program_status: crate::program_status::Records,
    program_status_dirty: bool,
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
    fn current_attention(&self) -> crate::attention_projection::Projection {
        crate::attention_projection::Projection::current(
            self.status.status(),
            self.readiness.snapshot().phase,
            self.status.block_reason(),
            self.program_status.blocked_children(),
        )
    }
}

pub struct State {
    event_log: Option<crate::event_log::Service>,
    submission_updates: Vec<crate::submission::Transition>,
    caller_url: Option<String>,
    workspace: PathBuf,
    sessions: HashMap<String, Session>,
    cleanup_workers: Vec<thread::JoinHandle<()>>,
    shutting_down: bool,
    pub clients: HashMap<u64, Client>,
    pub(crate) metadata: MetadataStore,
    push_queue: std::collections::VecDeque<crate::notifications::Job>,
    launchers: Launchers,
    provider_versions: Vec<crate::launchers::Version>,
    provider_limits: Vec<ProviderLimit>,
    limits_read_at: i64,
    schedule_watchers: HashSet<u64>,
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
        let provider_versions = launchers.pending_versions();
        Self {
            event_log: None,
            submission_updates: Vec::new(),
            caller_url: None,
            workspace,
            sessions: HashMap::new(),
            cleanup_workers: Vec::new(),
            shutting_down: false,
            clients: HashMap::new(),
            metadata,
            push_queue: Default::default(),
            launchers,
            provider_versions,
            provider_limits,
            limits_read_at: 0,
            schedule_watchers: HashSet::new(),
        }
    }

    pub fn update_codex_limits(&mut self, windows: Vec<LimitWindow>) {
        self.limits_read_at = chrono::Utc::now().timestamp();
        self.update_provider_limits(Program::Codex, windows);
    }
    pub fn set_caller_url(&mut self, url: String) {
        self.caller_url = Some(url);
    }
    pub fn set_event_log(&mut self, service: crate::event_log::Service) {
        self.event_log = Some(service);
    }
    pub fn event_log(&self) -> Result<crate::event_log::Service> {
        self.event_log.clone().ok_or_else(|| {
            crate::api_error::Error::new("unsupported", "Host event journal is unavailable").into()
        })
    }
    pub fn operation_caller(&self, client_id: u64) -> Result<(String, bool)> {
        Ok(match self.caller_session(client_id)? {
            Some(id) => (format!("session:{id}"), false),
            None => ("owner".into(), true),
        })
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
            if requested.as_ref().is_some_and(|target| target != id) {
                return Err(crate::api_error::Error::new(
                    "forbidden",
                    "Caller cannot observe this event subject",
                )
                .into());
            }
            return Ok(Some(id.into()));
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
        match &client.authority {
            crate::caller::Authority::Owner => Ok(None),
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
                Ok(Some(id))
            }
        }
    }
    pub fn authorize(&self, client_id: u64, command: &Command) -> Result<()> {
        let Some(caller) = self.caller_session(client_id)? else {
            return Ok(());
        };
        let target = match command {
            Command::GetOperation { .. } | Command::WaitOperation { .. } => return Ok(()),
            Command::UnsubscribeEvents => return Ok(()),
            Command::ReadEvents { session_id, .. }
            | Command::SubscribeEvents { session_id, .. } => {
                if session_id.as_ref().is_none_or(|id| id == caller) {
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
                session_id,
                directory: None,
                ..
            } => Some(session_id.as_str()),
            _ => None,
        };
        if target != Some(caller) {
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

    pub fn update_provider_limits(&mut self, program: Program, windows: Vec<LimitWindow>) {
        let Some(index) = self
            .provider_limits
            .iter()
            .position(|limit| limit.id == program)
        else {
            return;
        };
        let status = if windows.is_empty() {
            "unavailable"
        } else {
            "ready"
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
        event["domainEvents"] = self.event_log.is_some().into();
        event["operationReceipts"] = self.event_log.is_some().into();
        event["promptReceipts"] = self.event_log.is_some().into();
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
                program: session.info.program,
                auto_title: session.auto_title,
                muted: session.attention.muted,
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

    pub fn list(&self) -> Value {
        self.list_scoped(None)
    }
    fn list_scoped(&self, caller: Option<&str>) -> Value {
        let mut sessions: Vec<&Session> = self.sessions.values().collect();
        sessions.retain(|s| caller.is_none_or(|id| s.info.id == id));
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
            .is_some_and(|target| target != id)
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
            event["caller"] =
                json!({"sessionId":id,"permissions":["session:read"],"expires":"processExit"});
            if let Some(session) = self.sessions.get(id) {
                event["workspace"] = session.info.cwd.clone().into();
            }
            return Some(event);
        }
        Some(event)
    }

    fn wake_after_reset(&mut self) -> bool {
        let now = chrono::Utc::now().timestamp();
        let mut changed = false;
        for session in self.sessions.values_mut() {
            if session
                .wake_at
                .is_some_and(|at| now.saturating_sub(at) > 300)
            {
                session.wake_at = None;
                changed = true;
            }
        }
        if now - self.limits_read_at > 180 {
            return changed;
        }
        let Some(provider) = self
            .provider_limits
            .iter()
            .find(|p| p.id == Program::Codex && p.status == "ready")
        else {
            return changed;
        };
        let reset_available = provider.windows.iter().any(|w| {
            w.duration_mins == 300 && w.used_percent < 90 && w.resets_at.is_some_and(|at| at > now)
        }) && provider.windows.iter().all(|w| w.used_percent < 100);
        if !reset_available {
            return changed;
        }
        for session in self.sessions.values_mut() {
            if let Some(at) = session.wake_at
                && now >= at
                && self.limits_read_at >= at
            {
                // A fresh reading after reset is mandatory. Never type into a busy agent.
                if session.info.running
                    && session.info.program == Program::Codex
                    && session.status.rate_limited()
                {
                    session.wake_at = None;
                    if session
                        .pty
                        .send_input("Continue the previous task.\r".into())
                        .is_ok()
                    {
                        session.status.input(now_millis());
                    }
                    changed = true;
                }
            }
        }
        changed
    }

    pub fn next_push(&mut self) -> Option<crate::notifications::Job> {
        while let Some(job) = self.push_queue.pop_front() {
            if self.sessions.get(&job.session_id).is_some_and(|s| {
                !s.attention.muted
                    && s.attention
                        .event
                        .as_ref()
                        .is_some_and(|e| e.unread && e.sequence == job.sequence)
            }) && self
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
            changed |= std::mem::take(&mut session.program_status_dirty);
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
        self.schedule_watchers.remove(&client_id);
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
        ensure!(!self.shutting_down, "Host is shutting down.");
        valid_name(&spec.name)?;
        self.valid_group(spec.group_id.as_deref())?;
        ensure!(
            self.sessions.len() < MAX_SESSIONS,
            "Maximum 8 sessions. Close a session first."
        );
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
        working_directory(&self.workspace, spec.cwd.as_deref())
    }

    pub fn begin_submission(
        &mut self,
        id: &str,
        claim: crate::submission::Claim,
        prompt: &str,
    ) -> Result<(Option<PathBuf>, watch::Receiver<bool>)> {
        use crate::api_error::Error;
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
            .get_mut(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        if !session.info.running {
            return Err(Error::new("process_exited", "Process has exited").into());
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
        let (canceled, cancellation) = watch::channel(false);
        session.pending_input = Some(crate::submission::Pending {
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
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
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
        if session.info.program != Program::Shell
            && (!matches!(
                session.status.status().state,
                crate::status::StatusState::Idle | crate::status::StatusState::Done
            ) || session.readiness.snapshot().phase != crate::readiness::Phase::Ready)
        {
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
        session.wake_at = None;
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
        }
    }
    pub fn launch(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
    ) -> Result<String> {
        self.launch_inner(spec, events, None)
    }
    pub fn launch_reserved(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
        id: &str,
    ) -> Result<String> {
        ensure!(
            id.len() == 32
                && id.bytes().all(|b| b.is_ascii_hexdigit())
                && !self.sessions.contains_key(id),
            "Reserved process identity is invalid or already running"
        );
        self.launch_inner(spec, events, Some(id))
    }
    fn launch_inner(
        &mut self,
        spec: &crate::jobs::LaunchSpec,
        events: &mpsc::Sender<PtyEvent>,
        reserved: Option<&str>,
    ) -> Result<String> {
        let cwd = self.validate_launch(spec)?;
        let mut command = self.launchers.command(spec.program, &cwd)?;
        if spec.resume_picker {
            ensure!(
                spec.prompt.is_empty(),
                "Resume picker cannot send an initial prompt"
            );
            command.args(crate::launchers::resume_arguments(spec.program)?);
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
            reserved,
        )?;
        session.info.group_id = spec.group_id.clone();
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
        if let Err(error) = self.persist_session(&session) {
            #[cfg(windows)]
            let _ = session.pty.answer_unattached_cursor_query();
            let _ = session.pty.kill();
            self.cleanup_workers
                .push(thread::spawn(move || drop(session)));
            return Err(error);
        }
        self.sessions.insert(id.clone(), session);
        self.emit(
            Some(&id),
            "session.created",
            json!({"program":spec.program}),
        );
        self.broadcast_list();
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

    pub fn context_report(&self, id: &str) -> Option<PathBuf> {
        self.sessions
            .get(id)?
            .agent_context
            .as_ref()
            .map(|tracker| tracker.report())
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
            "inputOperation":session.pending_input.as_ref().map(|pending|json!({"id":pending.claim.id,"queued":pending.queued,"canceled":*pending.canceled.borrow(),"correlated":pending.correlation.is_some()})),
            "integration":{"configured":session.agent_context.is_some(), "adapter":if session.agent_context.is_some(){"claude-hooks-v2"}else{"screen/protocol"},
                "helperBuildId":if session.agent_context.is_some(){Some(env!("NESVO_BUILD_ID"))}else{None},
                "delivery":session.integration_delivery, "shadowSequence":session.integration_shadow_sequence, "cursor":session.lifecycle_cursor, "gap":session.lifecycle_gap},
            "conversationIdentity":session.conversation_identity,
            "publicationLatency":session.status_latency.snapshot(),
            "status":session.status.explain(now), "readiness":session.readiness.snapshot(), "turn":session.turn.snapshot(session.elapsed_at_exit.unwrap_or_else(||session.started.elapsed())), "turnHistory":session.turn.history(), "terminalProtocol":session.terminal_protocol.diagnostics(),
        })).collect();
        Ok(
            json!({"schemaVersion":1,"host":{"id":self.metadata.host_id,"buildId":env!("NESVO_BUILD_ID"),"version":env!("CARGO_PKG_VERSION"),"protocolVersion":2},
            "programs":self.launchers.capabilities(),"providerVersions":self.provider_versions,"eventJournal":self.event_log.as_ref().map(|log|log.health()),"sessions":sessions}),
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
            Command::CreateOperation { .. }
            | Command::SendOperation { .. }
            | Command::WaitOperation { .. }
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
                let report = self.diagnostics(session_id.as_deref())?;
                self.respond(
                    client_id,
                    json!({"type":"diagnostics", "report":report}),
                    request_id,
                );
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
            Command::SetWake {
                session_id,
                enabled,
            } => {
                let now = chrono::Utc::now().timestamp();
                let reset = if enabled {
                    ensure!(
                        now - self.limits_read_at <= 180,
                        "Quota reading is stale. Wait for a fresh reading."
                    );
                    Some(self.provider_limits.iter().find(|p| p.id == Program::Codex && p.status == "ready")
                        .and_then(|p| p.windows.iter().find(|w| w.duration_mins == 300 && w.used_percent >= 90))
                        .and_then(|w| w.resets_at).filter(|at| *at > now)
                        .ok_or_else(|| anyhow!("Wake is offered at 90% of a known 5-hour limit with a reset time."))?)
                } else {
                    None
                };
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| anyhow!("Session no longer exists."))?;
                ensure!(
                    session
                        .controller
                        .as_ref()
                        .is_none_or(|lease| lease.client_id == client_id),
                    "Another client controls this session."
                );
                ensure!(
                    !enabled || (session.info.running && session.info.program == Program::Codex),
                    "Reliable quota wake is currently supported for native Codex sessions only."
                );
                session.wake_at = reset;
                self.respond(
                    client_id,
                    json!({"type":"wakeConfigured", "sessionId":session_id, "wakeAt":reset}),
                    request_id,
                );
                self.broadcast_list();
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
            Command::GetDiff { .. } => return Err(anyhow!("Diff requires asynchronous dispatch.")),
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
            Command::RegisterPush { token, enabled } => {
                self.metadata.register_push(&token, enabled)?;
                self.respond(
                    client_id,
                    json!({"type":"pushRegistered","enabled":enabled}),
                    request_id,
                );
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
            Command::RestoreSession { id, resume } => {
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
                let result = self.launch(&spec, pty_events);
                self.metadata.finish_recovery(&id, result.is_ok())?;
                let new_id = result?;
                self.respond(
                    client_id,
                    json!({"type":"created","sessionId":new_id}),
                    request_id,
                );
                self.respond(client_id, self.recovery_event(0)?, request_id);
                self.broadcast_list();
            }
            Command::List => self.respond(client_id, self.list(), request_id),
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
                ensure!(
                    self.sessions.len() < MAX_SESSIONS,
                    "Maximum 8 sessions. Close an existing session first."
                );
                let cwd = working_directory(&self.workspace, cwd.as_deref())?;
                let command = self.launchers.command(program, &cwd)?;
                let mut session = spawn_session(
                    &name,
                    &cwd,
                    program,
                    command,
                    pty_events.clone(),
                    self.caller_url.as_deref(),
                    None,
                )?;
                session.info.group_id = group_id;
                let session_id = session.info.id.clone();
                self.persist_session(&session)?;
                self.sessions.insert(session_id.clone(), session);
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
                    #[cfg(windows)]
                    if !session.has_been_attached {
                        session.pty.answer_unattached_cursor_query()?;
                    }
                    session.pty.kill()?;
                }
                self.metadata.finish_recovery(&session_id, true)?;
                let mut removed = self.sessions.remove(&session_id);
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

    pub fn shutdown(&mut self) -> Vec<thread::JoinHandle<()>> {
        self.shutting_down = true;
        for client in self.clients.values() {
            let _ = client.cancelled.send(true);
        }
        for session in self.sessions.values_mut() {
            if session.info.running {
                #[cfg(windows)]
                if !session.has_been_attached {
                    let _ = session.pty.answer_unattached_cursor_query();
                }
                let _ = session.pty.kill();
            }
        }
        for (_, session) in self.sessions.drain() {
            self.cleanup_workers
                .push(thread::spawn(move || drop(session)));
        }
        std::mem::take(&mut self.cleanup_workers)
    }
}

fn spawn_session(
    name: &str,
    cwd: &Path,
    program: Program,
    mut command: CommandBuilder,
    events: mpsc::Sender<PtyEvent>,
    caller_url: Option<&str>,
    reserved: Option<&str>,
) -> Result<Session> {
    let id = reserved
        .map(str::to_owned)
        .unwrap_or_else(|| hex::encode(crate::wire::random::<16>()));
    command.env("NESVO_SESSION_ID", &id);
    let caller_context = caller_url
        .map(|url| crate::caller::Context::new(url, &id))
        .transpose()?;
    if let Some(context) = &caller_context {
        command.env("NESVO_AGENT_CONTEXT", context.path());
    }
    let agent_context = if program == Program::Claude {
        Some(crate::agent_context::Tracker::install_for(
            &mut command,
            &id,
        )?)
    } else {
        None
    };
    let pty = Pty::spawn(&id, command, terminal_size(80, 24)?, events)?;
    Ok(Session {
        caller_context,
        started: std::time::Instant::now(),
        elapsed_at_exit: None,
        agent_context,
        integration_delivery: Default::default(),
        integration_shadow_sequence: None,
        conversation_identity: None,
        lifecycle_cursor: 0,
        status_latency: Default::default(),
        lifecycle_gap: false,
        status: StatusTracker::new(program, 24, 80, now_millis()),
        readiness: crate::readiness::Tracker::new(program),
        turn: Default::default(),
        pending_input: None,
        human_input_dirty: false,
        terminal_protocol: Default::default(),
        program_status: Default::default(),
        program_status_dirty: false,
        info: SessionInfo {
            id,
            name: name.into(),
            cwd: crate::process::display_path(cwd),
            created_at: chrono::Utc::now().to_rfc3339(),
            cols: 80,
            rows: 24,
            running: true,
            group_id: None,
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

pub async fn dispatch_output(state: Arc<Mutex<State>>, mut events: mpsc::Receiver<PtyEvent>) {
    let weak = Arc::downgrade(&state);
    // File I/O runs independently of PTY dispatch and outside the host mutex.
    let lifecycle_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let Some(state) = weak.upgrade() else { break };
            flush_submission_updates(&state).await;
            let reports: Vec<_> = state
                .lock()
                .unwrap()
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.info.running
                        || session.elapsed_at_exit.is_some_and(|at| {
                            session.started.elapsed().saturating_sub(at) < Duration::from_secs(2)
                        })
                })
                .filter_map(|(id, session)| {
                    session
                        .agent_context
                        .as_ref()
                        .map(|tracker| (id.clone(), tracker.report(), session.lifecycle_cursor))
                })
                .collect();
            for (id, path, after) in reports {
                let observation = crate::agent_context::observe(&path).await;
                let expected = id.clone();
                let batch = tokio::task::spawn_blocking(move || {
                    crate::agent_events::read(&path, &expected, after)
                })
                .await;
                let mut state = state.lock().unwrap();
                let event_log = state.event_log.clone();
                let mut submission_updates = Vec::new();
                if let Some(session) = state.sessions.get_mut(&id) {
                    let elapsed = session
                        .elapsed_at_exit
                        .unwrap_or_else(|| session.started.elapsed());
                    session.integration_delivery = observation.delivery;
                    session.integration_shadow_sequence = observation.report.map(|r| r.sequence);
                    match batch {
                        Ok(Ok(batch)) => {
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
                                        submission_updates.push(crate::submission::Transition {
                                            claim: pending.claim.clone(),
                                            phase,
                                            result,
                                        });
                                    }
                                    session.program_status_dirty |= session.turn.event(
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
                                        session.program_status_dirty = true;
                                        if let Some(log) = &event_log {
                                            log.observe(crate::event_log::Observation{session_id:Some(id.clone()),kind:"agent.lifecycle",at:now_millis(),payload:json!({"event":event.name,"state":event.state,"generation":event.generation,"sourceSequence":event.sequence,"submissionEvidence":event.prompt_digest.is_some()})});
                                        }
                                    }
                                }
                            }
                            session.conversation_identity = Some(batch.identity);
                            if !session.info.running {
                                session.turn.process_exit(elapsed);
                            }
                        }
                        _ => session.integration_delivery.outcome = "queueUnreadable",
                    }
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
                                session.program_status_dirty = true;
                            }
                            crate::terminal_protocol::Event::Reset => {
                                session.program_status.reset();
                                session.program_status_dirty = true;
                            }
                            crate::terminal_protocol::Event::Prompt => {
                                session.program_status.end_program();
                                session.program_status_dirty = true;
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

    #[test]
    fn wake_requires_fresh_ninety_percent_five_hour_reading() {
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
        let now = chrono::Utc::now().timestamp();
        state.provider_limits = vec![ProviderLimit {
            id: Program::Codex,
            status: "ready",
            windows: vec![LimitWindow {
                used_percent: 89,
                duration_mins: 300,
                resets_at: Some(now + 60),
            }],
        }];
        state.limits_read_at = now;
        let (events, _) = mpsc::channel(1);
        let command = || Command::SetWake {
            session_id: "absent".into(),
            enabled: true,
        };
        assert!(
            state
                .command(1, command(), None, &events)
                .unwrap_err()
                .to_string()
                .contains("90%")
        );
        state.provider_limits[0].windows[0].used_percent = 90;
        assert!(
            state
                .command(1, command(), None, &events)
                .unwrap_err()
                .to_string()
                .contains("Session no longer exists")
        );
        state.limits_read_at = now - 181;
        assert!(
            state
                .command(1, command(), None, &events)
                .unwrap_err()
                .to_string()
                .contains("stale")
        );
        state.limits_read_at = now;
        state.provider_limits[0].windows[0].duration_mins = 10080;
        assert!(
            state
                .command(1, command(), None, &events)
                .unwrap_err()
                .to_string()
                .contains("90%")
        );
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
        for index in 0..MAX_SESSIONS {
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
        assert_eq!(restored_bytes, MAX_SESSIONS * BACKLOG_BYTES);
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
}
