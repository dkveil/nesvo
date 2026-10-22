use crate::{job_time, launch::Program};
use anyhow::Result;
use nesvo_wire::views::{
    self, HostError, ReplyHeader,
    jobs::{
        CalendarState, JobDefinition, JobOccurrence, JobPage, JobProfile, JobReply, JobRequest,
        JobSchedule, JobScheduleKind, JobSpec, JobWorkspace, JobsCall, Keyed, Misfire,
        OccurrencePage, Overlap, QuotaState,
    },
};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Definitions,
    Detail,
    History,
    Form,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Load {
    Loading,
    Ready,
    Failed(String),
}

pub trait DefinitionView {
    fn offset(&self) -> Option<i32>;
    fn schedule_kind_label(&self) -> &'static str;
    fn schedule_label(&self) -> String;
    fn summary(&self, now_ms: i64) -> String;
    fn next_label(&self, now_ms: i64) -> String;
    fn next_detail(&self, now_ms: i64) -> String;
    fn state_label(&self) -> &'static str;
    fn program(&self) -> Option<&str>;
    fn program_label(&self) -> String;
    fn workspace_label(&self) -> &'static str;
    fn folder_label(&self) -> String;
    fn instruction(&self) -> Option<&str>;
    fn policy(&self) -> Vec<(&'static str, String, bool)>;
}

fn text(field: Option<&String>) -> &str {
    field.map_or("?", String::as_str)
}

impl DefinitionView for JobDefinition {
    fn offset(&self) -> Option<i32> {
        self.schedule.at.as_deref().and_then(job_time::offset_of)
    }

    fn schedule_kind_label(&self) -> &'static str {
        match self.schedule.kind {
            JobScheduleKind::Once => "one-time schedule",
            JobScheduleKind::Cron => "cron schedule",
            JobScheduleKind::Rrule => "calendar schedule",
            JobScheduleKind::External => "external trigger",
            JobScheduleKind::Other(_) => "unknown schedule",
        }
    }

    fn schedule_label(&self) -> String {
        let schedule = &self.schedule;
        let zone = schedule.time_zone.as_deref().unwrap_or("UTC");
        match &schedule.kind {
            JobScheduleKind::Once => schedule
                .at
                .as_deref()
                .and_then(job_time::once_label)
                .map_or_else(|| "Once".to_owned(), |at| format!("Once · {at}")),
            JobScheduleKind::Cron => {
                format!("Cron · {} · {zone}", text(schedule.expression.as_ref()))
            }
            JobScheduleKind::Rrule => {
                format!("Calendar · {} · {zone}", text(schedule.rule.as_ref()))
            }
            JobScheduleKind::External => "External delivery".to_owned(),
            JobScheduleKind::Other(other) => other.clone(),
        }
    }

    fn summary(&self, now_ms: i64) -> String {
        let schedule = &self.schedule;
        match (&schedule.kind, self.next_due_at) {
            (JobScheduleKind::Once, Some(due)) => format!(
                "Once · {}",
                lowercase_day(&job_time::moment(due, now_ms, self.offset()))
            ),
            (JobScheduleKind::Cron, _) => {
                format!("Cron · {}", text(schedule.expression.as_ref()))
            }
            (JobScheduleKind::Rrule, _) => {
                format!("Calendar · {}", text(schedule.rule.as_ref()))
            }
            (JobScheduleKind::External, _) => "External delivery".to_owned(),
            _ => self.schedule_label(),
        }
    }

    fn next_label(&self, now_ms: i64) -> String {
        if !self.enabled {
            return "Paused".into();
        }
        if self.calendar_state == Some(CalendarState::Blocked) {
            return "Calendar blocked".into();
        }
        match self.next_due_at {
            Some(due) => job_time::moment(due, now_ms, self.offset()),
            None if self.schedule.kind == JobScheduleKind::External => "External".into(),
            None => "Not scheduled".into(),
        }
    }

    fn next_detail(&self, now_ms: i64) -> String {
        let next = self.next_label(now_ms);
        match (
            self.next_due_at,
            self.offset(),
            self.schedule.time_zone.as_deref(),
        ) {
            (Some(_), Some(offset), _) if self.enabled => {
                format!("{next} · {}", job_time::offset_label(offset))
            }
            (Some(_), None, Some(zone)) if self.enabled => format!("{next} · {zone}"),
            _ => next,
        }
    }

    fn state_label(&self) -> &'static str {
        if self.enabled { "Enabled" } else { "Paused" }
    }

    fn program(&self) -> Option<&str> {
        self.spec.as_ref()?.profile.program.as_deref()
    }

    fn program_label(&self) -> String {
        match self.program() {
            Some("claude") => "Claude".into(),
            Some("codex") => "Codex".into(),
            Some("gemini") => "Gemini".into(),
            Some(other) => other.into(),
            None => "Loading details…".into(),
        }
    }

    fn workspace_label(&self) -> &'static str {
        match self
            .spec
            .as_ref()
            .and_then(|spec| spec.profile.workspace.as_ref())
        {
            Some(JobWorkspace::Worktree) => "Worktree",
            Some(JobWorkspace::Shared) => "Shared",
            _ => "Unknown",
        }
    }

    fn folder_label(&self) -> String {
        self.spec
            .as_ref()
            .and_then(|spec| spec.profile.cwd.as_deref())
            .unwrap_or("Host workspace")
            .to_owned()
    }

    fn instruction(&self) -> Option<&str> {
        self.spec.as_ref()?.instruction.as_deref()
    }

    fn policy(&self) -> Vec<(&'static str, String, bool)> {
        let Some(spec) = &self.spec else {
            return Vec::new();
        };
        let overlap = match spec.overlap {
            Some(Overlap::Queue) => "Queue a separate occurrence",
            _ => "Skip while one is active",
        };
        let budget = spec
            .max_elapsed_ms
            .map_or_else(|| "Host default".to_owned(), job_time::duration_label);
        let timeout = spec.execution_timeout_ms;
        let retry = spec.retry.as_ref().and_then(|retry| retry.max_attempts);
        let quota = spec.quota_policy.is_some();
        vec![
            ("Overlap", overlap.to_owned(), true),
            ("Run budget", budget, true),
            (
                "Native timeout",
                timeout.map_or_else(|| "Not configured".to_owned(), job_time::duration_label),
                timeout.is_some(),
            ),
            (
                "Retry",
                retry.map_or_else(
                    || "Off".to_owned(),
                    |attempts| format!("Up to {attempts} no-effect launches"),
                ),
                retry.is_some(),
            ),
            (
                "Quota wait",
                if quota {
                    "Configured account"
                } else {
                    "Host gate"
                }
                .to_owned(),
                quota,
            ),
        ]
    }
}

fn lowercase_day(moment: &str) -> String {
    for (prefix, replacement) in [
        ("Today ", "today at "),
        ("Tomorrow ", "tomorrow at "),
        ("Yesterday ", "yesterday at "),
    ] {
        if let Some(rest) = moment.strip_prefix(prefix) {
            return format!("{replacement}{rest}");
        }
    }
    moment.to_owned()
}

pub trait OccurrenceView {
    fn started(&self, now_ms: i64, offset: Option<i32>) -> String;
    fn reason_label(&self) -> &str;
    fn run_label(&self) -> String;
    fn quota_label(&self, now_ms: i64, offset: Option<i32>) -> String;
    fn quota_column(&self, now_ms: i64, offset: Option<i32>) -> String;
    fn waiting(&self) -> bool;
}

fn quota_reset(occurrence: &JobOccurrence, now_ms: i64, offset: Option<i32>) -> Option<String> {
    occurrence
        .quota
        .resets_at
        .map(|reset| job_time::moment(reset, now_ms, offset))
}

impl OccurrenceView for JobOccurrence {
    fn started(&self, now_ms: i64, offset: Option<i32>) -> String {
        job_time::moment(self.started_at.unwrap_or(self.due_at), now_ms, offset)
    }

    fn reason_label(&self) -> &str {
        self.reason.as_deref().unwrap_or("—")
    }

    fn run_label(&self) -> String {
        self.run_id
            .as_deref()
            .map_or_else(|| "Not allocated".to_owned(), |run| format!("Run · {run}"))
    }

    fn quota_label(&self, now_ms: i64, offset: Option<i32>) -> String {
        let reason = self.quota.reason.as_deref().unwrap_or("unknown");
        match self.quota.state {
            Some(QuotaState::Eligible) => "Eligible".into(),
            Some(QuotaState::Waiting) => format!("Waiting · {reason}"),
            Some(QuotaState::Held) => match quota_reset(self, now_ms, offset) {
                Some(reset) => format!("Held until {reset} · {reason}"),
                None => format!("Held · {reason} · until a newer read"),
            },
            _ => "Not held".into(),
        }
    }

    fn quota_column(&self, now_ms: i64, offset: Option<i32>) -> String {
        match self.quota.state {
            Some(QuotaState::Eligible) => "eligible".into(),
            Some(QuotaState::Waiting) => "waiting".into(),
            Some(QuotaState::Held) => quota_reset(self, now_ms, offset)
                .map_or_else(|| "held".into(), |reset| format!("held → {reset}")),
            _ => "—".into(),
        }
    }

    fn waiting(&self) -> bool {
        matches!(
            self.quota.state,
            Some(QuotaState::Waiting | QuotaState::Held)
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormField {
    Title,
    Agent,
    Folder,
    Instruction,
    Schedule,
    Start,
    Expression,
    Rule,
    LocalStart,
    TimeZone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleKind {
    Once,
    Cron,
    Rrule,
    External,
}

impl ScheduleKind {
    const ALL: [Self; 4] = [Self::Once, Self::Cron, Self::Rrule, Self::External];

    pub fn wire(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Cron => "cron",
            Self::Rrule => "rrule",
            Self::External => "external",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Once => "One time",
            Self::Cron => "Cron (recurring)",
            Self::Rrule => "Calendar RRULE (recurring)",
            Self::External => "External trigger only",
        }
    }

    fn parse(kind: &JobScheduleKind) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|candidate| candidate.wire() == kind.as_str())
    }

    fn schedule(self) -> JobSchedule {
        JobSchedule::new(match self {
            Self::Once => JobScheduleKind::Once,
            Self::Cron => JobScheduleKind::Cron,
            Self::Rrule => JobScheduleKind::Rrule,
            Self::External => JobScheduleKind::External,
        })
    }

    pub fn advertised(features: &Value) -> Vec<Self> {
        let listed = features["jobScheduleKinds"].as_array();
        Self::ALL
            .into_iter()
            .filter(|kind| {
                *kind == Self::Once
                    || listed.is_some_and(|kinds| kinds.iter().any(|item| item == kind.wire()))
            })
            .collect()
    }

    fn fields(self) -> &'static [FormField] {
        match self {
            Self::Once => &[FormField::Start],
            Self::Cron => &[FormField::Expression, FormField::TimeZone],
            Self::Rrule => &[FormField::Rule, FormField::LocalStart, FormField::TimeZone],
            Self::External => &[],
        }
    }
}

impl FormField {
    const BASE: [Self; 5] = [
        Self::Title,
        Self::Agent,
        Self::Folder,
        Self::Instruction,
        Self::Schedule,
    ];

    pub fn limit(self) -> usize {
        match self {
            Self::Title => 80,
            Self::Folder => 4096,
            Self::Instruction => 8192,
            Self::Start | Self::TimeZone => 64,
            Self::Expression => 256,
            Self::Rule => 1024,
            Self::LocalStart => 19,
            Self::Agent | Self::Schedule => 0,
        }
    }

    pub fn order(kind: ScheduleKind) -> Vec<Self> {
        Self::BASE.iter().chain(kind.fields()).copied().collect()
    }

    fn step(self, kind: ScheduleKind, forward: bool) -> Self {
        let order = Self::order(kind);
        let index = order.iter().position(|field| *field == self).unwrap_or(0);
        let next = if forward {
            (index + 1) % order.len()
        } else {
            (index + order.len() - 1) % order.len()
        };
        order[next]
    }
}

#[derive(Clone, Debug)]
pub struct EditTarget {
    pub job_id: String,
    pub revision: u64,
    pub spec: JobSpec,
}

fn program_name(program: Program) -> Option<String> {
    serde_json::to_value(program)
        .ok()?
        .as_str()
        .map(str::to_owned)
}

fn parse_program(name: Option<&str>) -> Option<Program> {
    Program::ALL
        .into_iter()
        .find(|program| program_name(*program).as_deref() == name)
}

fn trimmed(text: &str) -> Option<String> {
    Some(text.trim().to_owned())
}

fn new_spec() -> JobSpec {
    JobSpec {
        profile: JobProfile {
            workspace: Some(JobWorkspace::Shared),
            harness: Some(true),
            ..JobProfile::default()
        },
        misfire: Some(Misfire::CatchUp),
        grace_ms: Some(60_000),
        overlap: Some(Overlap::Skip),
        max_elapsed_ms: Some(300_000),
        ..JobSpec::default()
    }
}

#[derive(Clone, Debug)]
pub struct Form {
    pub target: Option<EditTarget>,
    pub title: String,
    pub program: Program,
    pub programs: Vec<Program>,
    pub folder: String,
    pub instruction: String,
    pub kind: ScheduleKind,
    pub kinds: Vec<ScheduleKind>,
    pub start: String,
    pub expression: String,
    pub rule: String,
    pub local_start: String,
    pub time_zone: String,
    pub field: FormField,
    pub return_page: Page,
}

impl Form {
    pub fn step(&mut self, forward: bool) {
        self.field = self.field.step(self.kind, forward);
    }

    pub fn cycle_kind(&mut self, forward: bool) {
        let count = self.kinds.len();
        let Some(index) = self.kinds.iter().position(|kind| *kind == self.kind) else {
            if let Some(first) = self.kinds.first() {
                self.kind = *first;
            }
            return;
        };
        self.kind = self.kinds[if forward {
            (index + 1) % count
        } else {
            (index + count - 1) % count
        }];
    }

    pub fn cycle_program(&mut self, forward: bool) {
        let Some(index) = self.programs.iter().position(|p| *p == self.program) else {
            if let Some(first) = self.programs.first() {
                self.program = *first;
            }
            return;
        };
        let count = self.programs.len();
        self.program = self.programs[if forward {
            (index + 1) % count
        } else {
            (index + count - 1) % count
        }];
    }

    pub fn type_text(&mut self, input: &str) {
        let limit = self.field.limit();
        if let Some(text) = self.text_mut() {
            crate::input::append_field(text, input, limit);
        }
    }

    pub fn text_mut(&mut self) -> Option<&mut String> {
        match self.field {
            FormField::Title => Some(&mut self.title),
            FormField::Folder => Some(&mut self.folder),
            FormField::Instruction => Some(&mut self.instruction),
            FormField::Start => Some(&mut self.start),
            FormField::Expression => Some(&mut self.expression),
            FormField::Rule => Some(&mut self.rule),
            FormField::LocalStart => Some(&mut self.local_start),
            FormField::TimeZone => Some(&mut self.time_zone),
            FormField::Agent | FormField::Schedule => None,
        }
    }

    fn schedule(&self) -> std::result::Result<JobSchedule, &'static str> {
        let mut schedule = self.kind.schedule();
        match self.kind {
            ScheduleKind::Once => {
                if let Some(schedule) = self.unchanged_schedule() {
                    return Ok(schedule);
                }
                schedule.at = Some(
                    job_time::rfc3339(&self.start)
                        .ok_or("Start needs a date, time and offset: 2026-10-22 16:02 +02:00.")?,
                );
                return Ok(schedule);
            }
            ScheduleKind::External => return Ok(schedule),
            ScheduleKind::Cron => {
                if self.expression.trim().is_empty() {
                    return Err("Give the five cron fields: minute hour day month weekday.");
                }
                schedule.expression = trimmed(&self.expression);
            }
            ScheduleKind::Rrule => {
                if self.rule.trim().is_empty() || self.local_start.trim().is_empty() {
                    return Err("Give the RRULE and its local start: 2026-11-02T09:00:00.");
                }
                schedule.rule = trimmed(&self.rule);
                schedule.start = trimmed(&self.local_start);
            }
        }
        if !self.time_zone.trim().is_empty() {
            schedule.time_zone = trimmed(&self.time_zone);
        }
        Ok(schedule)
    }

    fn spec(&self) -> std::result::Result<JobSpec, &'static str> {
        if self.title.trim().is_empty() {
            return Err("Give the job a title.");
        }
        if self.instruction.trim().is_empty() {
            return Err("Write the instruction the agent receives.");
        }
        if self.program == Program::Shell {
            return Err("Jobs need an installed agent.");
        }
        let schedule = self.schedule()?;
        let folder = self.folder.trim();
        let mut spec = self
            .target
            .as_ref()
            .map_or_else(new_spec, |target| target.spec.clone());
        spec.title = trimmed(&self.title);
        spec.instruction = trimmed(&self.instruction);
        spec.profile.program = program_name(self.program);
        spec.profile.cwd = (!folder.is_empty()).then(|| folder.to_owned());
        spec.schedule = Some(schedule);
        Ok(spec)
    }

    fn unchanged_schedule(&self) -> Option<JobSchedule> {
        let schedule = self.target.as_ref()?.spec.schedule.as_ref()?;
        if schedule.kind != JobScheduleKind::Once {
            return None;
        }
        let at = schedule.at.as_deref()?;
        (job_time::form_start(at) == self.start.trim()).then(|| schedule.clone())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Read {
    List { offset: u64 },
    Detail(String),
    History(String),
    Occurrence(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Change {
    Create,
    Update(String),
    SetEnabled(String, bool),
    RunNow(String),
    Cancel(String),
}

#[derive(Clone, Debug)]
struct Mutation {
    request_id: String,
    key: String,
    change: Change,
    request: JobRequest,
}

#[derive(Clone, Debug)]
struct Unconfirmed {
    key: String,
    change: Change,
    request: JobRequest,
}

pub fn unconfirmed_notice(context: &str, key: &str) -> String {
    format!("{context} · Job change unconfirmed; inspect it with nesvo job mutation --key {key}")
}

#[derive(Default, Debug)]
pub struct Effect {
    pub commands: Vec<Value>,
    pub notice: Option<String>,
}

impl Effect {
    fn notice(message: impl Into<String>) -> Self {
        Self {
            commands: Vec::new(),
            notice: Some(message.into()),
        }
    }
}

pub struct Jobs {
    pub page: Page,
    pub load: Load,
    pub definitions: Vec<JobDefinition>,
    pub selected: Option<String>,
    pub details: HashMap<String, JobDefinition>,
    pub occurrences: Vec<JobOccurrence>,
    pub history_loading: bool,
    pub occurrence: Option<String>,
    pub form: Option<Form>,
    pub now_ms: i64,
    pub schedule_kinds: Vec<ScheduleKind>,
    prefix: String,
    counter: u64,
    reads: HashMap<String, Read>,
    mutation: Option<Mutation>,
    unconfirmed: Option<Unconfirmed>,
    staged: Vec<JobDefinition>,
}

const BUSY: &str = "Waiting for the host to confirm the previous job change.";

fn history(job_id: String) -> JobRequest {
    JobRequest::History { job_id, offset: 0 }
}

impl Jobs {
    pub fn open(client_id: u64, features: &Value, now_ms: i64) -> Result<(Self, Value)> {
        let mut jobs = Self {
            page: Page::Definitions,
            load: Load::Loading,
            definitions: Vec::new(),
            selected: None,
            details: HashMap::new(),
            occurrences: Vec::new(),
            history_loading: false,
            occurrence: None,
            form: None,
            now_ms,
            schedule_kinds: ScheduleKind::advertised(features),
            prefix: format!("tui-{client_id}-jobs"),
            counter: 0,
            reads: HashMap::new(),
            mutation: None,
            unconfirmed: None,
            staged: Vec::new(),
        };
        let command = jobs.list(features, 0)?;
        Ok((jobs, command))
    }

    pub fn selected_definition(&self) -> Option<&JobDefinition> {
        let id = self.selected.as_deref()?;
        self.details
            .get(id)
            .or_else(|| self.definitions.iter().find(|job| job.id == id))
    }

    pub fn selected_index(&self) -> Option<usize> {
        let id = self.selected.as_deref()?;
        self.definitions.iter().position(|job| job.id == id)
    }

    pub fn selected_occurrence(&self) -> Option<&JobOccurrence> {
        let id = self.occurrence.as_deref()?;
        self.occurrences.iter().find(|item| item.id == id)
    }

    pub fn unconfirmed_key(&self) -> Option<&str> {
        self.mutation.as_ref().map_or_else(
            || self.unconfirmed.as_ref().map(|item| item.key.as_str()),
            |mutation| Some(mutation.key.as_str()),
        )
    }

    pub fn tick(&mut self, now_ms: i64) -> bool {
        let minute_changed = self.now_ms.div_euclid(60_000) != now_ms.div_euclid(60_000);
        self.now_ms = now_ms;
        minute_changed
    }

    fn key_for(&self, change: &Change, request: &JobRequest) -> String {
        match &self.unconfirmed {
            Some(item) if item.change == *change && item.request == *request => item.key.clone(),
            _ => format!("tui-job-{}", hex::encode(nesvo_wire::random::<8>())),
        }
    }

    fn command(&mut self, features: &Value, arguments: Value) -> Result<(String, Value)> {
        let mut command = crate::workflow::tool("jobs", arguments)?;
        crate::workflow::supported(features, &command)?;
        self.counter += 1;
        let id = format!("{}-{}", self.prefix, self.counter);
        command["requestId"] = id.clone().into();
        Ok((id, command))
    }

    fn read(&mut self, features: &Value, read: Read, request: JobRequest) -> Result<Value> {
        let (id, command) = self.command(features, views::encode(&JobsCall { request }))?;
        self.reads.retain(|_, pending| *pending != read);
        self.reads.insert(id, read);
        Ok(command)
    }

    fn list(&mut self, features: &Value, offset: u64) -> Result<Value> {
        self.reads
            .retain(|_, pending| !matches!(pending, Read::List { .. }));
        self.read(features, Read::List { offset }, JobRequest::List { offset })
    }

    fn detail(&mut self, features: &Value, job_id: &str) -> Result<Value> {
        self.read(
            features,
            Read::Detail(job_id.to_owned()),
            JobRequest::Get {
                job_id: job_id.to_owned(),
            },
        )
    }

    fn effect(result: Result<Value>) -> Effect {
        match result {
            Ok(command) => Effect {
                commands: vec![command],
                notice: None,
            },
            Err(error) => Effect::notice(error.to_string()),
        }
    }

    fn change(&mut self, features: &Value, change: Change, request: JobRequest) -> Effect {
        if self.mutation.is_some() {
            return Effect::notice(BUSY);
        }
        let key = self.key_for(&change, &request);
        let keyed = views::encode(&JobsCall {
            request: Keyed {
                key: &key,
                request: &request,
            },
        });
        match self.command(features, keyed) {
            Ok((request_id, command)) => {
                self.unconfirmed = None;
                self.mutation = Some(Mutation {
                    request_id,
                    key,
                    change,
                    request,
                });
                Effect {
                    commands: vec![command],
                    notice: None,
                }
            }
            Err(error) => Effect::notice(error.to_string()),
        }
    }

    pub fn refresh(&mut self, features: &Value) -> Effect {
        self.load = Load::Loading;
        self.staged.clear();
        Self::effect(self.list(features, 0))
    }

    pub fn move_selection(&mut self, features: &Value, delta: isize) -> Effect {
        if self.definitions.is_empty() {
            return Effect::default();
        }
        let current = self.selected_index().unwrap_or(0);
        let next = current
            .saturating_add_signed(delta)
            .min(self.definitions.len() - 1);
        let id = self.definitions[next].id.clone();
        if self.selected.as_deref() == Some(id.as_str()) {
            return Effect::default();
        }
        self.selected = Some(id.clone());
        if self.details.contains_key(&id) {
            return Effect::default();
        }
        Self::effect(self.detail(features, &id))
    }

    pub fn open_detail(&mut self, features: &Value) -> Effect {
        let Some(id) = self.selected.clone() else {
            return Effect::default();
        };
        self.page = Page::Detail;
        Self::effect(self.detail(features, &id))
    }

    pub fn open_history(&mut self, features: &Value) -> Effect {
        let Some(id) = self.selected.clone() else {
            return Effect::default();
        };
        self.page = Page::History;
        self.history_loading = true;
        Self::effect(self.read(features, Read::History(id.clone()), history(id)))
    }

    pub fn move_occurrence(&mut self, delta: isize) {
        if self.occurrences.is_empty() {
            return;
        }
        let current = self
            .occurrence
            .as_deref()
            .and_then(|id| self.occurrences.iter().position(|item| item.id == id))
            .unwrap_or(0);
        let next = current
            .saturating_add_signed(delta)
            .min(self.occurrences.len() - 1);
        self.occurrence = Some(self.occurrences[next].id.clone());
    }

    pub fn inspect_occurrence(&mut self, features: &Value) -> Effect {
        let (Some(job_id), Some(occurrence_id)) = (self.selected.clone(), self.occurrence.clone())
        else {
            return Effect::default();
        };
        Self::effect(self.read(
            features,
            Read::Occurrence(occurrence_id.clone()),
            JobRequest::Occurrence {
                job_id,
                occurrence_id,
            },
        ))
    }

    pub fn cancel_occurrence(&mut self, features: &Value) -> Effect {
        let (Some(job_id), Some(occurrence_id)) = (self.selected.clone(), self.occurrence.clone())
        else {
            return Effect::default();
        };
        self.change(
            features,
            Change::Cancel(occurrence_id.clone()),
            JobRequest::CancelOccurrence {
                job_id,
                occurrence_id,
            },
        )
    }

    pub fn toggle_enabled(&mut self, features: &Value) -> Effect {
        let Some(job) = self.selected_definition().cloned() else {
            return Effect::default();
        };
        let enabled = !job.enabled;
        self.change(
            features,
            Change::SetEnabled(job.id.clone(), enabled),
            JobRequest::SetEnabled {
                job_id: job.id,
                expected_revision: job.revision,
                enabled,
            },
        )
    }

    pub fn run_now(&mut self, features: &Value) -> Effect {
        let Some(job) = self.selected_definition().cloned() else {
            return Effect::default();
        };
        self.change(
            features,
            Change::RunNow(job.id.clone()),
            JobRequest::RunNow {
                job_id: job.id,
                expected_revision: job.revision,
            },
        )
    }

    pub fn new_form(&mut self, programs: Vec<Program>, folder: String) {
        let program = programs.first().copied().unwrap_or(Program::Claude);
        self.form = Some(Form {
            target: None,
            title: String::new(),
            program,
            programs,
            folder,
            instruction: String::new(),
            kind: ScheduleKind::Once,
            kinds: self.schedule_kinds.clone(),
            start: String::new(),
            expression: String::new(),
            rule: String::new(),
            local_start: String::new(),
            time_zone: String::new(),
            field: FormField::Title,
            return_page: self.page,
        });
        self.page = Page::Form;
    }

    pub fn edit_form(&mut self, programs: Vec<Program>) -> Effect {
        let Some(job) = self.selected_definition().cloned() else {
            return Effect::default();
        };
        let Some(spec) = job.spec.clone() else {
            return Effect::notice("Job details are still loading.");
        };
        let Some(kind) = ScheduleKind::parse(&job.schedule.kind) else {
            return Effect::notice("This schedule kind is edited with nesvo job edit.");
        };
        let mut kinds = self.schedule_kinds.clone();
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
        let schedule = spec.schedule.clone();
        let text = |field: fn(&JobSchedule) -> &Option<String>| {
            schedule
                .as_ref()
                .and_then(|schedule| field(schedule).clone())
                .unwrap_or_default()
        };
        let program = parse_program(spec.profile.program.as_deref()).unwrap_or(Program::Claude);
        self.form = Some(Form {
            target: Some(EditTarget {
                job_id: job.id.clone(),
                revision: job.revision,
                spec: spec.clone(),
            }),
            title: job.title.clone(),
            program,
            programs,
            folder: spec.profile.cwd.clone().unwrap_or_default(),
            instruction: spec.instruction.clone().unwrap_or_default(),
            kind,
            kinds,
            start: job_time::form_start(&text(|schedule| &schedule.at)),
            expression: text(|schedule| &schedule.expression),
            rule: text(|schedule| &schedule.rule),
            local_start: text(|schedule| &schedule.start),
            time_zone: text(|schedule| &schedule.time_zone),
            field: FormField::Title,
            return_page: self.page,
        });
        self.page = Page::Form;
        Effect::default()
    }

    pub fn discard_form(&mut self) {
        if let Some(form) = self.form.take() {
            self.page = form.return_page;
        }
    }

    pub fn save_form(&mut self, features: &Value) -> Effect {
        let Some(form) = &self.form else {
            return Effect::default();
        };
        let spec = match form.spec() {
            Ok(spec) => spec,
            Err(message) => return Effect::notice(message),
        };
        let (change, request) = match &form.target {
            Some(target) => (
                Change::Update(target.job_id.clone()),
                JobRequest::Update {
                    job_id: target.job_id.clone(),
                    expected_revision: target.revision,
                    spec,
                },
            ),
            None => (Change::Create, JobRequest::Create { spec }),
        };
        self.change(features, change, request)
    }

    pub fn response(&mut self, features: &Value, event: &Value, now_ms: i64) -> Option<Effect> {
        let request_id = ReplyHeader::of(event).request_id?;
        if let Some(read) = self.reads.remove(&request_id) {
            self.now_ms = now_ms;
            return Some(self.read_response(features, read, event));
        }
        if self
            .mutation
            .as_ref()
            .is_some_and(|mutation| mutation.request_id == request_id)
        {
            self.now_ms = now_ms;
            let mutation = self.mutation.take()?;
            let reply = views::decode(event).unwrap_or_default();
            return Some(self.change_response(features, mutation.change, reply));
        }
        None
    }

    fn read_response(&mut self, features: &Value, read: Read, event: &Value) -> Effect {
        match read {
            Read::List { offset } => {
                let page: JobPage = views::decode(event).unwrap_or_default();
                if offset == 0 {
                    self.staged.clear();
                }
                self.staged.extend(page.jobs);
                if let Some(next) = page.next_offset {
                    return Self::effect(self.list(features, next));
                }
                self.definitions = std::mem::take(&mut self.staged);
                self.load = Load::Ready;
                let kept = self
                    .selected
                    .as_deref()
                    .is_some_and(|id| self.definitions.iter().any(|job| job.id == id));
                if !kept {
                    self.selected = self.definitions.first().map(|job| job.id.clone());
                }
                match self.selected.clone() {
                    Some(id) => Self::effect(self.detail(features, &id)),
                    None => Effect::default(),
                }
            }
            Read::Detail(id) => {
                let reply: JobReply = views::decode(event).unwrap_or_default();
                if let Some(job) = reply.job {
                    if let Some(row) = self.definitions.iter_mut().find(|row| row.id == id) {
                        *row = JobDefinition {
                            spec: None,
                            ..job.clone()
                        };
                    }
                    self.details.insert(id, job);
                }
                Effect::default()
            }
            Read::History(id) => {
                if self.selected.as_deref() == Some(id.as_str()) {
                    self.history_loading = false;
                    let page: OccurrencePage = views::decode(event).unwrap_or_default();
                    self.occurrences = page.occurrences;
                    let kept = self
                        .occurrence
                        .as_deref()
                        .is_some_and(|id| self.occurrences.iter().any(|item| item.id == id));
                    if !kept {
                        self.occurrence = self.occurrences.first().map(|item| item.id.clone());
                    }
                }
                Effect::default()
            }
            Read::Occurrence(_) => {
                let reply: JobReply = views::decode(event).unwrap_or_default();
                self.replace_occurrence(reply.occurrence);
                Effect::default()
            }
        }
    }

    fn replace_occurrence(&mut self, occurrence: Option<JobOccurrence>) {
        if let Some(occurrence) = occurrence
            && let Some(row) = self
                .occurrences
                .iter_mut()
                .find(|row| row.id == occurrence.id)
        {
            *row = occurrence;
        }
    }

    fn change_response(&mut self, features: &Value, change: Change, reply: JobReply) -> Effect {
        let mut effect = Effect::default();
        if let Some(job) = reply.job {
            self.selected = Some(job.id.clone());
            self.details.insert(job.id.clone(), job);
        }
        effect.notice = Some(match change {
            Change::Create | Change::Update(_) => {
                self.form = None;
                self.page = Page::Detail;
                "Job saved on the host; it affects future occurrences.".into()
            }
            Change::SetEnabled(_, true) => "Future starts enabled.".into(),
            Change::SetEnabled(_, false) => {
                "Future starts paused; an admitted occurrence may still finish.".into()
            }
            Change::RunNow(_) => "Occurrence admitted on the host.".into(),
            Change::Cancel(_) => {
                self.replace_occurrence(reply.occurrence);
                "Cancellation requested; this is not proof of process exit.".into()
            }
        });
        self.staged.clear();
        if let Ok(command) = self.list(features, 0) {
            effect.commands.push(command);
        }
        if self.page == Page::History
            && let Some(id) = self.selected.clone()
            && let Ok(command) = self.read(features, Read::History(id.clone()), history(id))
        {
            effect.commands.push(command);
        }
        effect
    }

    pub fn failure(&mut self, features: &Value, event: &Value) -> Option<Effect> {
        let error = HostError::of(event);
        let request_id = error.request_id.as_deref()?;
        let message = error.message_or("Host rejected the request").to_owned();
        if let Some(read) = self.reads.remove(request_id) {
            return Some(match read {
                Read::List { .. } => {
                    self.staged.clear();
                    self.load = Load::Failed(message);
                    Effect::notice(String::new())
                }
                Read::History(_) => {
                    self.history_loading = false;
                    Effect::default()
                }
                Read::Detail(_) | Read::Occurrence(_) => Effect::default(),
            });
        }
        if !self
            .mutation
            .as_ref()
            .is_some_and(|mutation| mutation.request_id == request_id)
        {
            return None;
        }
        let mutation = self.mutation.take()?;
        if error.code() != "revision_conflict" {
            let notice = unconfirmed_notice(&message, &mutation.key);
            self.unconfirmed = Some(Unconfirmed {
                key: mutation.key,
                change: mutation.change,
                request: mutation.request,
            });
            return Some(Effect::notice(notice));
        }
        let mut effect =
            Effect::notice("This job changed on the host; review the current revision and retry.");
        let job = match &mutation.change {
            Change::Update(id) | Change::SetEnabled(id, _) | Change::RunNow(id) => Some(id.clone()),
            Change::Create | Change::Cancel(_) => None,
        };
        if let Some(id) = job
            && let Ok(command) = self.detail(features, &id)
        {
            effect.commands.push(command);
        }
        self.staged.clear();
        if let Ok(command) = self.list(features, 0) {
            effect.commands.push(command);
        }
        Some(effect)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) const NOW: i64 = 1_792_540_800_000;

    pub(crate) fn features() -> Value {
        json!({
            "workflowPlans": true,
            "workflowAttempts": true,
            "durableJobs": true,
            "jobCancellation": true,
            "jobScheduleKinds": ["once", "cron", "rrule", "external"]
        })
    }

    pub(crate) fn definitions() -> Value {
        json!([
            {"id":"daily","title":"Daily review","revision":3,"enabled":true,"nextDueAt":NOW + 50_520_000,"createdAt":1,"schedule":{"kind":"once","at":"2026-10-21T16:02:00+02:00"},"calendarState":"ready"},
            {"id":"nightly","title":"Nightly checks","revision":1,"enabled":true,"nextDueAt":NOW + 86_400_000,"createdAt":2,"schedule":{"kind":"cron","expression":"0 2 * * *","timeZone":"Europe/Warsaw"},"calendarState":"ready"},
            {"id":"watch","title":"Dependency watch","revision":1,"enabled":true,"nextDueAt":null,"createdAt":3,"schedule":{"kind":"external"},"calendarState":"exhausted"},
            {"id":"notes","title":"Release notes","revision":2,"enabled":false,"nextDueAt":NOW + 172_800_000,"createdAt":4,"schedule":{"kind":"rrule","rule":"FREQ=WEEKLY;BYDAY=MO","start":"2026-10-19T09:00:00","timeZone":"Europe/Warsaw"},"calendarState":"ready"}
        ])
    }

    pub(crate) fn detail() -> Value {
        let mut job = definitions()[0].clone();
        job["spec"] = json!({
            "title":"Daily review",
            "instruction":"Review changes and report findings. Do not modify files.",
            "profile":{"name":null,"cwd":"C:/Projects/nesvo","program":"claude","workspace":"shared","harness":true},
            "schedule":{"kind":"once","at":"2026-10-21T16:02:00+02:00"},
            "misfire":"catchUp","graceMs":60000,"overlap":"queue","maxElapsedMs":300000
        });
        job
    }

    pub(crate) fn occurrences() -> Value {
        json!([
            {"id":"o3","jobId":"daily","state":"queued","reason":"quota_wait","runId":null,"dueAt":NOW + 49_200_000,"createdAt":1,"startedAt":null,"quota":{"state":"waiting","reason":"source_unavailable"}},
            {"id":"o2","jobId":"daily","state":"needsValidation","reason":"result_reported","runId":"run-02","dueAt":NOW - 35_880_000,"createdAt":1,"startedAt":NOW - 35_880_000,"quota":{"state":"notRequired"}},
            {"id":"o1","jobId":"daily","state":"canceled","reason":"owner_canceled","runId":"run-01","dueAt":NOW - 122_280_000,"createdAt":1,"startedAt":NOW - 122_280_000,"quota":{"state":"notRequired"}}
        ])
    }

    pub(crate) fn loaded() -> Jobs {
        let features = features();
        let (mut jobs, list) = Jobs::open(7, &features, NOW).unwrap();
        let effect = jobs
            .response(
                &features,
                &json!({"type":"workflow","requestId":list["requestId"],"jobs":definitions(),"nextOffset":null}),
                NOW,
            )
            .unwrap();
        let get = &effect.commands[0];
        jobs.response(
            &features,
            &json!({"type":"workflow","requestId":get["requestId"],"job":detail()}),
            NOW,
        )
        .unwrap();
        jobs
    }

    #[test]
    fn list_pages_load_with_correlated_requests_and_stable_selection() {
        let features = features();
        let (mut jobs, list) = Jobs::open(7, &features, NOW).unwrap();
        assert_eq!(list["type"], "workflow");
        assert_eq!(list["request"]["request"]["action"], "list");
        assert_eq!(jobs.load, Load::Loading);
        assert!(
            jobs.response(
                &features,
                &json!({"type":"workflow","requestId":"foreign","jobs":[]}),
                NOW
            )
            .is_none()
        );
        let rows = definitions();
        let next = jobs
            .response(
                &features,
                &json!({"type":"workflow","requestId":list["requestId"],"jobs":[rows[0],rows[1]],"nextOffset":16}),
                NOW,
            )
            .unwrap();
        assert_eq!(next.commands[0]["request"]["request"]["offset"], 16);
        assert_eq!(jobs.load, Load::Loading);
        let done = jobs
            .response(
                &features,
                &json!({"type":"workflow","requestId":next.commands[0]["requestId"],"jobs":[rows[2],rows[3]],"nextOffset":null}),
                NOW,
            )
            .unwrap();
        assert_eq!(jobs.load, Load::Ready);
        assert_eq!(jobs.definitions.len(), 4);
        assert_eq!(jobs.selected.as_deref(), Some("daily"));
        assert_eq!(done.commands[0]["request"]["request"]["action"], "get");
        jobs.move_selection(&features, 2);
        assert_eq!(jobs.selected.as_deref(), Some("watch"));
        let refresh = jobs.refresh(&features);
        jobs.response(
            &features,
            &json!({"type":"workflow","requestId":refresh.commands[0]["requestId"],"jobs":[rows[3],rows[2]],"nextOffset":null}),
            NOW,
        );
        assert_eq!(jobs.selected.as_deref(), Some("watch"));
        assert_eq!(jobs.selected_index(), Some(1));
    }

    #[test]
    fn read_failure_shows_retryable_error_and_unsupported_hosts_refuse_locally() {
        let features = features();
        let (mut jobs, list) = Jobs::open(7, &features, NOW).unwrap();
        jobs.failure(
            &features,
            &json!({"type":"error","requestId":list["requestId"],"code":"disconnected","message":"Host is busy"}),
        )
        .unwrap();
        assert_eq!(jobs.load, Load::Failed("Host is busy".into()));
        let retry = jobs.refresh(&features);
        assert_eq!(jobs.load, Load::Loading);
        assert_eq!(retry.commands.len(), 1);
        assert!(Jobs::open(7, &json!({"workflowPlans":true}), NOW).is_err());
    }

    #[test]
    fn mutations_carry_keys_and_revisions_and_allow_one_in_flight() {
        let features = features();
        let mut jobs = loaded();
        let pause = jobs.toggle_enabled(&features);
        let request = &pause.commands[0]["request"]["request"];
        assert_eq!(request["action"], "setEnabled");
        assert_eq!(request["expectedRevision"], 3);
        assert_eq!(request["enabled"], false);
        let key = request["key"].as_str().unwrap().to_owned();
        assert!(key.starts_with("tui-job-"));
        assert_eq!(jobs.unconfirmed_key(), Some(key.as_str()));
        assert_eq!(jobs.run_now(&features).notice.as_deref(), Some(BUSY));
        let mut paused = detail();
        paused["enabled"] = false.into();
        paused["revision"] = 4.into();
        let effect = jobs
            .response(
                &features,
                &json!({"type":"workflow","requestId":pause.commands[0]["requestId"],"job":paused}),
                NOW,
            )
            .unwrap();
        assert!(effect.notice.unwrap().contains("paused"));
        assert_eq!(jobs.unconfirmed_key(), None);
        assert_eq!(jobs.selected_definition().unwrap().revision, 4);
        let run = jobs.run_now(&features);
        let run_request = &run.commands[0]["request"]["request"];
        assert_eq!(run_request["expectedRevision"], 4);
        assert_ne!(run_request["key"], key.as_str());
    }

    #[test]
    fn revision_conflict_rereads_the_definition_and_list() {
        let features = features();
        let mut jobs = loaded();
        let run = jobs.run_now(&features);
        let effect = jobs
            .failure(
                &features,
                &json!({"type":"error","requestId":run.commands[0]["requestId"],"code":"revision_conflict","message":"stale"}),
            )
            .unwrap();
        assert!(effect.notice.unwrap().contains("changed on the host"));
        let actions: Vec<_> = effect
            .commands
            .iter()
            .map(|command| command["request"]["request"]["action"].clone())
            .collect();
        assert_eq!(actions, [json!("get"), json!("list")]);
        assert_eq!(jobs.unconfirmed_key(), None);
    }

    const UNCONFIRMED: &str = "Job outcome is unconfirmed; inspect the original occurrence";

    fn key_of(effect: &Effect) -> String {
        effect.commands[0]["request"]["request"]["key"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn fail_unconfirmed(jobs: &mut Jobs, effect: &Effect) -> Effect {
        jobs.failure(
            &features(),
            &json!({"type":"error","requestId":effect.commands[0]["requestId"],"code":"internal","message":UNCONFIRMED}),
        )
        .unwrap()
    }

    #[test]
    fn unconfirmed_failure_keeps_the_key_and_shows_the_mutation_hint() {
        let features = features();
        let mut jobs = loaded();
        let run = jobs.run_now(&features);
        let key = key_of(&run);
        let effect = fail_unconfirmed(&mut jobs, &run);
        let notice = effect.notice.unwrap();
        assert!(notice.starts_with(UNCONFIRMED));
        assert!(notice.contains(&format!("nesvo job mutation --key {key}")));
        assert!(effect.commands.is_empty());
        assert_eq!(jobs.unconfirmed_key(), Some(key.as_str()));
    }

    #[test]
    fn retrying_the_same_change_reuses_the_unconfirmed_key() {
        let features = features();
        let mut jobs = loaded();
        let run = jobs.run_now(&features);
        let key = key_of(&run);
        fail_unconfirmed(&mut jobs, &run);
        let retry = jobs.run_now(&features);
        assert_eq!(key_of(&retry), key);
        assert_ne!(retry.commands[0]["requestId"], run.commands[0]["requestId"]);

        jobs.mutation = None;
        jobs.new_form(vec![Program::Claude], "C:/Projects/nesvo".into());
        let form = jobs.form.as_mut().unwrap();
        form.title = "Nightly".into();
        form.instruction = "Report".into();
        form.start = "2026-10-22 16:02 +02:00".into();
        let create = jobs.save_form(&features);
        let create_key = key_of(&create);
        assert_ne!(create_key, key);
        fail_unconfirmed(&mut jobs, &create);
        assert_eq!(jobs.page, Page::Form);
        assert_eq!(key_of(&jobs.save_form(&features)), create_key);
    }

    #[test]
    fn a_different_change_after_an_unconfirmed_failure_gets_a_new_key() {
        let features = features();
        let mut jobs = loaded();
        let run = jobs.run_now(&features);
        let key = key_of(&run);
        fail_unconfirmed(&mut jobs, &run);
        let pause = jobs.toggle_enabled(&features);
        assert_ne!(key_of(&pause), key);
        assert_eq!(jobs.unconfirmed_key(), Some(key_of(&pause).as_str()));
        jobs.mutation = None;
        assert_ne!(key_of(&jobs.run_now(&features)), key);
    }

    #[test]
    fn tick_refreshes_the_clock_and_reports_only_minute_changes() {
        let mut jobs = loaded();
        assert!(!jobs.tick(NOW + 30_000));
        assert_eq!(jobs.now_ms, NOW + 30_000);
        assert!(jobs.tick(NOW + 60_000));
        assert_eq!(jobs.now_ms, NOW + 60_000);
    }

    #[test]
    fn editing_without_touching_start_keeps_the_original_instant() {
        let features = features();
        let mut jobs = loaded();
        let precise = json!({"kind":"once","at":"2026-10-21T16:02:45.250+02:00"});
        jobs.details
            .get_mut("daily")
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .schedule = Some(serde_json::from_value(precise.clone()).unwrap());
        jobs.page = Page::Detail;
        jobs.edit_form(vec![Program::Claude]);
        assert_eq!(jobs.form.as_ref().unwrap().start, "2026-10-21 16:02 +02:00");
        jobs.form.as_mut().unwrap().title = "Daily review v2".into();
        let update = jobs.save_form(&features);
        assert_eq!(
            update.commands[0]["request"]["request"]["spec"]["schedule"],
            precise
        );

        jobs.mutation = None;
        jobs.form.as_mut().unwrap().start = "2026-10-21 16:05 +02:00".into();
        let moved = jobs.save_form(&features);
        assert_eq!(
            moved.commands[0]["request"]["request"]["spec"]["schedule"]["at"],
            "2026-10-21T16:05:00+02:00"
        );
    }

    #[test]
    fn history_selection_follows_occurrence_identity_and_cancel_targets_it() {
        let features = features();
        let mut jobs = loaded();
        let history = jobs.open_history(&features);
        assert!(jobs.history_loading);
        jobs.response(
            &features,
            &json!({"type":"workflow","requestId":history.commands[0]["requestId"],"occurrences":occurrences()}),
            NOW,
        );
        assert_eq!(jobs.occurrence.as_deref(), Some("o3"));
        jobs.move_occurrence(1);
        assert_eq!(jobs.selected_occurrence().unwrap().state, "needsValidation");
        let cancel = jobs.cancel_occurrence(&features);
        let request = &cancel.commands[0]["request"]["request"];
        assert_eq!(request["action"], "cancelOccurrence");
        assert_eq!(request["occurrenceId"], "o2");
        let mut canceled = occurrences()[1].clone();
        canceled["state"] = "canceled".into();
        let effect = jobs
            .response(
                &features,
                &json!({"type":"workflow","requestId":cancel.commands[0]["requestId"],"occurrence":canceled}),
                NOW,
            )
            .unwrap();
        assert_eq!(jobs.selected_occurrence().unwrap().state, "canceled");
        assert!(
            effect
                .commands
                .iter()
                .any(|command| command["request"]["request"]["action"] == "history")
        );
    }

    #[test]
    fn form_creates_and_edits_once_jobs_while_preserving_unshown_fields() {
        let features = features();
        let mut jobs = loaded();
        jobs.new_form(
            vec![Program::Claude, Program::Codex],
            "C:/Projects/nesvo".into(),
        );
        assert_eq!(jobs.page, Page::Form);
        assert!(jobs.save_form(&features).notice.unwrap().contains("title"));
        let form = jobs.form.as_mut().unwrap();
        form.title = "Nightly".into();
        form.instruction = "Report".into();
        form.start = "2026-10-22 16:02".into();
        assert!(jobs.save_form(&features).notice.unwrap().contains("offset"));
        let form = jobs.form.as_mut().unwrap();
        form.start = "2026-10-22 16:02 +02:00".into();
        form.cycle_program(true);
        let create = jobs.save_form(&features);
        let request = &create.commands[0]["request"]["request"];
        assert_eq!(request["action"], "create");
        assert_eq!(
            request["spec"]["schedule"]["at"],
            "2026-10-22T16:02:00+02:00"
        );
        assert_eq!(request["spec"]["profile"]["program"], "codex");
        assert_eq!(request["spec"]["profile"]["workspace"], "shared");
        jobs.failure(
            &features,
            &json!({"type":"error","requestId":create.commands[0]["requestId"],"code":"invalid_argument","message":"no"}),
        );
        jobs.discard_form();
        assert_eq!(jobs.page, Page::Definitions);

        jobs.page = Page::Detail;
        assert!(jobs.edit_form(vec![Program::Claude]).notice.is_none());
        let form = jobs.form.as_ref().unwrap();
        assert_eq!(form.start, "2026-10-21 16:02 +02:00");
        assert_eq!(form.folder, "C:/Projects/nesvo");
        jobs.form.as_mut().unwrap().title = "Daily review v2".into();
        let update = jobs.save_form(&features);
        let request = &update.commands[0]["request"]["request"];
        assert_eq!(request["action"], "update");
        assert_eq!(request["expectedRevision"], 3);
        assert_eq!(request["spec"]["overlap"], "queue");
        assert_eq!(request["spec"]["title"], "Daily review v2");

        jobs.mutation = None;
        jobs.selected = Some("nightly".into());
        jobs.details.insert(
            "nightly".into(),
            JobDefinition {
                spec: Some(JobSpec::default()),
                ..jobs.definitions[1].clone()
            },
        );
        assert!(jobs.edit_form(vec![Program::Claude]).notice.is_none());
        assert_eq!(jobs.form.as_ref().unwrap().kind, ScheduleKind::Cron);
    }

    fn draft(jobs: &mut Jobs, kind: ScheduleKind) -> &mut Form {
        jobs.mutation = None;
        jobs.new_form(vec![Program::Claude], "C:/Projects/nesvo".into());
        let form = jobs.form.as_mut().unwrap();
        form.title = "Recurring".into();
        form.instruction = "Report".into();
        form.kind = kind;
        form
    }

    fn sent_schedule(effect: &Effect) -> Value {
        effect.commands[0]["request"]["request"]["spec"]["schedule"].clone()
    }

    #[test]
    fn form_offers_advertised_kinds_and_orders_their_fields() {
        let mut jobs = loaded();
        jobs.new_form(vec![Program::Claude], "C:/Projects/nesvo".into());
        let form = jobs.form.as_mut().unwrap();
        assert_eq!(
            form.kinds,
            [
                ScheduleKind::Once,
                ScheduleKind::Cron,
                ScheduleKind::Rrule,
                ScheduleKind::External
            ]
        );
        form.field = FormField::Instruction;
        form.step(true);
        assert_eq!(form.field, FormField::Schedule);
        assert!(form.text_mut().is_none());
        form.cycle_kind(true);
        form.cycle_kind(true);
        assert_eq!(form.kind, ScheduleKind::Rrule);
        assert_eq!(
            FormField::order(form.kind)[5..],
            [FormField::Rule, FormField::LocalStart, FormField::TimeZone]
        );
        form.cycle_kind(false);
        form.cycle_kind(false);
        form.cycle_kind(false);
        assert_eq!(form.kind, ScheduleKind::External);
        form.step(true);
        assert_eq!(form.field, FormField::Title);
        assert_eq!(
            ScheduleKind::advertised(&json!({"jobScheduleKinds":["once"]})),
            [ScheduleKind::Once]
        );
        assert_eq!(ScheduleKind::advertised(&json!({})), [ScheduleKind::Once]);
    }

    #[test]
    fn form_sends_recurring_and_external_schedules_through_the_cli_job_model() {
        let features = features();
        let mut jobs = loaded();
        assert!(
            jobs.save_form(&features).commands.is_empty(),
            "no form, no command"
        );
        draft(&mut jobs, ScheduleKind::Cron);
        assert!(
            jobs.save_form(&features)
                .notice
                .unwrap()
                .contains("five cron fields")
        );
        jobs.form.as_mut().unwrap().expression = "0 9 * * MON-FRI".into();
        let cron = jobs.save_form(&features);
        assert_eq!(
            sent_schedule(&cron),
            json!({"kind":"cron","expression":"0 9 * * MON-FRI","timeZone":"Europe/Warsaw"})
        );
        let request = &cron.commands[0]["request"]["request"];
        assert_eq!(request["action"], "create");
        assert!(request["key"].as_str().unwrap().starts_with("tui-job-"));

        let form = draft(&mut jobs, ScheduleKind::Cron);
        form.expression = "every weekday".into();
        let unparsed = jobs.save_form(&features);
        assert_eq!(sent_schedule(&unparsed)["expression"], "every weekday");

        let form = draft(&mut jobs, ScheduleKind::Rrule);
        form.rule = "FREQ=WEEKLY;BYDAY=MO".into();
        assert!(
            jobs.save_form(&features)
                .notice
                .unwrap()
                .contains("local start")
        );
        let form = jobs.form.as_mut().unwrap();
        form.local_start = "2026-11-02T09:00:00".into();
        form.time_zone = " America/New_York ".into();
        assert_eq!(
            sent_schedule(&jobs.save_form(&features)),
            json!({"kind":"rrule","rule":"FREQ=WEEKLY;BYDAY=MO","start":"2026-11-02T09:00:00","timeZone":"America/New_York"})
        );

        draft(&mut jobs, ScheduleKind::External);
        assert!(
            jobs.save_form(&features)
                .notice
                .unwrap()
                .contains("external job or trigger provider")
        );
        let mut triggers = features.clone();
        triggers["jobExternalTriggers"] = true.into();
        triggers["jobTriggerProviders"] = json!(["webhook", "github"]);
        assert_eq!(
            sent_schedule(&jobs.save_form(&triggers)),
            json!({"kind":"external"})
        );
        let once_only = json!({"workflowPlans":true,"workflowAttempts":true,"durableJobs":true,"jobScheduleKinds":["once"]});
        let form = draft(&mut jobs, ScheduleKind::Cron);
        form.expression = "0 2 * * *".into();
        assert!(
            jobs.save_form(&once_only)
                .notice
                .unwrap()
                .contains("job calendar")
        );
    }

    #[test]
    fn editing_a_recurring_job_prefills_its_schedule_and_keeps_unshown_fields() {
        let features = features();
        let mut jobs = loaded();
        let mut nightly = definitions()[1].clone();
        nightly["spec"] = json!({
            "title":"Nightly checks","instruction":"Run the checks",
            "profile":{"name":null,"cwd":null,"program":"codex","workspace":"worktree","harness":true},
            "schedule":{"kind":"cron","expression":"0 2 * * *","timeZone":"Europe/Warsaw"},
            "misfire":"skip","graceMs":60000,"overlap":"queue","maxElapsedMs":300000
        });
        jobs.details
            .insert("nightly".into(), serde_json::from_value(nightly).unwrap());
        jobs.selected = Some("nightly".into());
        jobs.page = Page::Detail;
        assert!(jobs.edit_form(vec![Program::Codex]).notice.is_none());
        let form = jobs.form.as_mut().unwrap();
        assert_eq!(form.kind, ScheduleKind::Cron);
        assert_eq!(form.expression, "0 2 * * *");
        assert_eq!(form.time_zone, "Europe/Warsaw");
        form.title = "Nightly checks v2".into();
        let update = jobs.save_form(&features);
        let request = &update.commands[0]["request"]["request"];
        assert_eq!(request["action"], "update");
        assert_eq!(request["expectedRevision"], 1);
        assert_eq!(request["spec"]["profile"]["workspace"], "worktree");
        assert_eq!(request["spec"]["misfire"], "skip");
        assert_eq!(
            request["spec"]["schedule"],
            json!({"kind":"cron","expression":"0 2 * * *","timeZone":"Europe/Warsaw"})
        );
        jobs.mutation = None;
        let form = jobs.form.as_mut().unwrap();
        form.kind = ScheduleKind::Rrule;
        form.rule = "FREQ=DAILY".into();
        form.local_start = "2026-11-02T02:00:00".into();
        let moved = jobs.save_form(&features);
        assert_eq!(
            sent_schedule(&moved),
            json!({"kind":"rrule","rule":"FREQ=DAILY","start":"2026-11-02T02:00:00","timeZone":"Europe/Warsaw"})
        );
    }

    #[test]
    fn labels_describe_schedules_without_inventing_zones() {
        let jobs = loaded();
        let daily = jobs.selected_definition().unwrap();
        assert_eq!(daily.next_label(NOW), "Today 16:02");
        assert_eq!(daily.next_detail(NOW), "Today 16:02 · UTC+02:00");
        assert_eq!(daily.schedule_label(), "Once · 21 Oct, 16:02 +02:00");
        assert_eq!(daily.summary(NOW), "Once · today at 16:02");
        let nightly = &jobs.definitions[1];
        assert_eq!(nightly.next_label(NOW), "Tomorrow 00:00 UTC");
        assert_eq!(
            nightly.next_detail(NOW),
            "Tomorrow 00:00 UTC · Europe/Warsaw"
        );
        assert_eq!(jobs.definitions[2].next_label(NOW), "External");
        assert_eq!(jobs.definitions[3].next_label(NOW), "Paused");
        let policy = daily.policy();
        assert_eq!(policy[0].1, "Queue a separate occurrence");
        assert_eq!(policy[1].1, "5 minutes");
        assert_eq!(policy[2].1, "Not configured");
    }
}
