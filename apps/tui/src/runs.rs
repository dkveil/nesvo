use anyhow::Result;
use nesvo_wire::views::{
    self, HostError, ReplyHeader, Tolerant,
    runs::{
        ControlKind, ControlRequest, DecisionPage, DecisionRequest, DecisionState, DigestReply,
        InboxPage, InboxRequest, RunCall, RunChanged, RunDigest, RunPage, RunView, TemplateRequest,
        WakeDelivery, WakeRequest, WakeState, WorkflowTemplate, WorkflowTemplates,
    },
};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const DECISION_PAGES: u64 = 8;
pub const ANSWER_BYTES: usize = 2048;
const BUSY: &str = "Waiting for the host to confirm the previous run change.";
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const CHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const TIMEOUT_MESSAGE: &str = "The host did not answer in time; F5 retries.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Runs,
    Templates,
    Answer,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Load {
    #[default]
    Loading,
    Ready,
    Failed(String),
}

pub use nesvo_wire::views::runs::{
    Decision, InboxMessage as Message, RunSummary as Summary, RunTask as Task, WakeBatch,
    WakePolicy,
};

fn kept<T>(items: Vec<Tolerant<T>>) -> Vec<T> {
    items.into_iter().filter_map(|item| item.0).collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Digest {
    pub kind: String,
    pub source_revision: u64,
    pub total: u64,
    pub accepted: u64,
    pub omitted: u64,
    pub decisions_pending: u64,
    pub decisions_answered: u64,
    pub time_state: String,
    pub active_attempts: u64,
    pub journal_cursor: u64,
    pub checkpoints: u64,
    pub next_steps: Vec<String>,
    pub branches: Vec<String>,
}

impl From<RunDigest> for Digest {
    fn from(body: RunDigest) -> Self {
        let tasks = kept(body.task_digests);
        Self {
            kind: body.kind,
            source_revision: body.source_revision,
            total: body.tasks.total,
            accepted: body.tasks.by_state.succeeded,
            omitted: body.omitted_tasks,
            decisions_pending: body.decisions.pending,
            decisions_answered: body.decisions.answered,
            time_state: body.budget.time_state,
            active_attempts: body.budget.active_attempts,
            journal_cursor: body.evidence.journal_cursor,
            checkpoints: body.evidence.checkpoint_count,
            next_steps: tasks
                .iter()
                .flat_map(|task| {
                    task.next_steps
                        .iter()
                        .filter_map(|step| step.0.as_deref())
                        .map(|step| format!("{}: {step}", task.key))
                })
                .collect(),
            branches: tasks
                .into_iter()
                .filter_map(|task| task.workspace?.branch)
                .collect(),
        }
    }
}

impl Digest {
    pub fn settled(&self) -> bool {
        self.kind == "final"
    }
}

#[derive(Clone, Debug, Default)]
pub struct Wakes {
    pub loaded: bool,
    pub error: Option<String>,
    pub policy: Option<WakePolicy>,
    pub pending: u64,
    pub delivered_through: u64,
    pub batches: Vec<WakeBatch>,
}

impl Wakes {
    pub fn full(&self) -> bool {
        self.policy
            .as_ref()
            .is_some_and(|policy| policy.delivery == Some(WakeDelivery::Full))
    }

    pub fn delivery_label(&self) -> &'static str {
        if self.full() {
            "full context"
        } else {
            "delta only"
        }
    }

    pub fn summary(&self) -> String {
        if let Some(error) = &self.error {
            return format!("Wakes · unavailable: {error}");
        }
        if !self.loaded {
            return "Wakes · loading".into();
        }
        match &self.policy {
            None => "Wakes · off".into(),
            Some(policy) if policy.held => format!(
                "Wakes · held · {} · {} waiting",
                self.delivery_label(),
                self.pending
            ),
            Some(policy) if policy.enabled => format!(
                "Wakes · delivering · {} · {} pending",
                self.delivery_label(),
                self.pending
            ),
            Some(policy) => format!(
                "Wakes · {}{} · {}",
                policy.phase,
                policy
                    .reason
                    .as_deref()
                    .map_or_else(String::new, |reason| format!(" ({reason})")),
                self.delivery_label()
            ),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Detail {
    pub goal: String,
    pub tasks: Vec<Task>,
    pub tasks_load: Load,
    pub decisions: Vec<Decision>,
    pub decisions_load: Load,
    pub pending_messages: u64,
    pub messages: Vec<Message>,
    pub inbox_load: Load,
    pub digest: Option<Digest>,
    pub digest_error: Option<String>,
    pub wakes: Wakes,
}

pub type Template = WorkflowTemplate;

#[derive(Clone, Debug)]
pub struct Templates {
    pub load: Load,
    pub directory: String,
    pub repository: String,
    pub digest: Option<String>,
    pub approved: bool,
    pub items: Vec<Template>,
    pub selected: usize,
}

impl Templates {
    pub fn startable(&self) -> &[Template] {
        if self.approved { &self.items } else { &[] }
    }
}

#[derive(Clone, Debug)]
pub struct AnswerForm {
    pub run_id: String,
    pub decision_id: String,
    pub revision: u64,
    pub question: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Read {
    List,
    Run(String),
    Decisions { run: String, offset: u64, page: u64 },
    Inbox(String),
    Digest(String),
    Wakes(String),
    Templates,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Pause {
        run: String,
        revision: u64,
    },
    Resume {
        run: String,
        revision: u64,
    },
    Drain {
        run: String,
        revision: u64,
    },
    Answer {
        run: String,
        decision: String,
        revision: u64,
        answer: String,
    },
    Start {
        directory: String,
        name: String,
    },
    Wake {
        run: String,
        revision: u64,
        action: WakeAction,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeAction {
    Enable,
    Hold,
    Resume,
    Delta,
    Full,
}

impl WakeAction {
    fn request(self, key: String, run_id: String, expected_revision: u64) -> WakeRequest {
        match self {
            Self::Enable => WakeRequest::Enable {
                key,
                run_id,
                expected_revision,
            },
            Self::Hold => WakeRequest::Pause {
                key,
                run_id,
                expected_revision,
            },
            Self::Resume => WakeRequest::Resume {
                key,
                run_id,
                expected_revision,
            },
            Self::Delta | Self::Full => WakeRequest::SetDelivery {
                key,
                run_id,
                expected_revision,
                delivery: if self == Self::Full {
                    WakeDelivery::Full
                } else {
                    WakeDelivery::Delta
                },
            },
        }
    }

    fn notice(self) -> &'static str {
        match self {
            Self::Enable => "Coordinator wakes enabled; only new notices are delivered.",
            Self::Hold => "Wake delivery held; resume resynchronises from the inbox and blockers.",
            Self::Resume => {
                "Wake delivery resumed from current unacknowledged messages and blockers."
            }
            Self::Delta => "Wakes now carry only the new notices.",
            Self::Full => "Wakes now add the current run context digest to new notices.",
        }
    }
}

#[derive(Clone, Debug)]
struct Mutation {
    request_id: String,
    key: String,
    change: Change,
    sent: Instant,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Expiry {
    pub changed: bool,
    pub notice: Option<String>,
}

#[derive(Default, Debug)]
pub struct Effect {
    pub commands: Vec<Value>,
    pub notice: Option<String>,
}

impl Effect {
    pub(crate) fn notice(message: impl Into<String>) -> Self {
        Self {
            commands: Vec::new(),
            notice: Some(message.into()),
        }
    }
    fn command(result: Result<Value>) -> Self {
        match result {
            Ok(command) => Self {
                commands: vec![command],
                notice: None,
            },
            Err(error) => Self::notice(error.to_string()),
        }
    }
}

pub fn unconfirmed_notice(context: &str, change: &Change, key: &str) -> String {
    match change {
        Change::Start { .. } => format!(
            "{context} · Template start unconfirmed; press Enter on the same template to repeat key {key}"
        ),
        _ => format!(
            "{context} · Run change unconfirmed; inspect it with nesvo run mutation --key {key}"
        ),
    }
}

fn bounded(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

pub(crate) fn template_command(
    action: &str,
    directory: &str,
    digest: Option<&str>,
    start: Option<(&str, &str)>,
) -> Result<(Value, &'static str)> {
    let invalid = |message: &str| crate::cli::failure("invalid_argument", message);
    if !bounded(directory, 4096) {
        return Err(invalid(
            "Use an absolute host folder inside a Git repository",
        ));
    }
    if digest
        .is_some_and(|digest| digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid(
            "Use the 64-character digest reported by nesvo workflow templates",
        ));
    }
    if let Some((name, key)) = start
        && (name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !bounded(key, 96))
    {
        return Err(invalid(
            "Use a template name of 1-64 letters, digits, '_' or '-' and a start key of 1-96 bytes",
        ));
    }
    let request = match (action, digest, start) {
        ("list", None, None) => TemplateRequest::ListWorkflowTemplates { directory },
        ("approve", Some(digest), None) => {
            TemplateRequest::ApproveWorkflowTemplates { directory, digest }
        }
        ("revoke", Some(digest), None) => {
            TemplateRequest::RevokeWorkflowTemplates { directory, digest }
        }
        ("start", None, Some((name, key))) => TemplateRequest::StartWorkflowTemplate {
            directory,
            name,
            key,
        },
        _ => return Err(invalid("Invalid workflow template request")),
    };
    Ok((views::encode(&request), request.reply()))
}

pub struct Runs {
    pub open: bool,
    pub page: Page,
    pub load: Load,
    pub runs: Vec<Summary>,
    pub more: bool,
    pub selected: Option<String>,
    pub details: HashMap<String, Detail>,
    pub templates: Option<Templates>,
    pub answer: Option<AnswerForm>,
    pub confirm_pause: bool,
    pub snapshot_at: Option<Instant>,
    pub clock: Option<Instant>,
    prefix: String,
    counter: u64,
    reads: HashMap<String, (Read, Instant)>,
    mutation: Option<Mutation>,
    unconfirmed: Option<(String, Change)>,
    listed: Option<Instant>,
}

impl Runs {
    pub fn open(client_id: u64, features: &Value) -> Result<(Self, Value)> {
        let mut runs = Self {
            open: true,
            page: Page::Runs,
            load: Load::Loading,
            runs: Vec::new(),
            more: false,
            selected: None,
            details: HashMap::new(),
            templates: None,
            answer: None,
            confirm_pause: false,
            snapshot_at: None,
            clock: None,
            prefix: format!("tui-{client_id}-runs"),
            counter: 0,
            reads: HashMap::new(),
            mutation: None,
            unconfirmed: None,
            listed: None,
        };
        let command = runs.list(features)?;
        Ok((runs, command))
    }

    pub fn unconfirmed_key(&self) -> Option<(&str, &Change)> {
        self.mutation.as_ref().map_or_else(
            || {
                self.unconfirmed
                    .as_ref()
                    .map(|(key, change)| (key.as_str(), change))
            },
            |mutation| Some((mutation.key.as_str(), &mutation.change)),
        )
    }

    pub fn selected_run(&self) -> Option<&Summary> {
        let id = self.selected.as_deref()?;
        self.runs.iter().find(|run| run.id == id)
    }

    pub fn selected_detail(&self) -> Option<&Detail> {
        self.details.get(self.selected.as_deref()?)
    }

    fn listed_detail(&mut self, id: &str) -> Option<&mut Detail> {
        self.runs
            .iter()
            .any(|run| run.id == id)
            .then(|| self.details.entry(id.to_owned()).or_default())
    }

    pub fn selected_row(&self) -> usize {
        self.selected
            .as_deref()
            .and_then(|id| self.runs.iter().position(|run| run.id == id))
            .map_or(0, |index| index + 1)
    }

    pub fn pending_decision(&self) -> Option<&Decision> {
        self.selected_detail()?
            .decisions
            .iter()
            .find(|decision| decision.state == DecisionState::Pending)
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("{}-{}", self.prefix, self.counter)
    }

    fn workflow(&mut self, features: &Value, call: RunCall) -> Result<(String, Value)> {
        let mut command = crate::workflow::tool(call.action(), views::encode(&call))?;
        crate::workflow::supported(features, &command)?;
        let id = self.next_id();
        command["requestId"] = id.clone().into();
        Ok((id, command))
    }

    fn templates_supported(features: &Value) -> Result<()> {
        if features["workflowTemplates"] == true {
            Ok(())
        } else {
            Err(crate::cli::failure(
                "unsupported",
                "Update the host to start runs from workflow templates.",
            ))
        }
    }

    fn read(&mut self, read: Read, (id, command): (String, Value)) -> Value {
        self.reads.retain(|_, (pending, _)| *pending != read);
        self.reads.insert(id, (read, Instant::now()));
        command
    }

    fn list(&mut self, features: &Value) -> Result<Value> {
        self.listed = Some(Instant::now());
        let pair = self.workflow(features, RunCall::List { offset: 0 })?;
        Ok(self.read(Read::List, pair))
    }

    pub fn poll(&mut self, features: &Value) -> Option<Value> {
        let listing = self.reads.values().any(|(read, _)| *read == Read::List);
        if listing || self.listed.is_some_and(|at| at.elapsed() < POLL_INTERVAL) {
            return None;
        }
        self.list(features).ok()
    }

    #[cfg(test)]
    pub(crate) fn age_poll(&mut self) {
        self.listed = self
            .listed
            .and_then(|at| at.checked_sub(POLL_INTERVAL + Duration::from_secs(1)));
    }

    pub fn snapshot_age(&self) -> Option<String> {
        let seconds = self
            .clock?
            .saturating_duration_since(self.snapshot_at?)
            .as_secs();
        Some(match seconds {
            0..5 => "updated just now".into(),
            5..60 => format!("updated {seconds}s ago"),
            60..3600 => format!("updated {}m ago", seconds / 60),
            _ => format!("updated {}h ago", seconds / 3600),
        })
    }

    pub fn expire(&mut self, now: Instant) -> Expiry {
        let before = self.snapshot_age();
        self.clock = Some(now);
        let expired: Vec<String> = self
            .reads
            .iter()
            .filter(|(_, (_, sent))| now.saturating_duration_since(*sent) > READ_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            if let Some((read, _)) = self.reads.remove(id) {
                self.read_failure(read, TIMEOUT_MESSAGE.into());
            }
        }
        let mut notice = None;
        if self
            .mutation
            .as_ref()
            .is_some_and(|mutation| now.saturating_duration_since(mutation.sent) > CHANGE_TIMEOUT)
            && let Some(mutation) = self.mutation.take()
        {
            notice = Some(unconfirmed_notice(
                "The host did not answer",
                &mutation.change,
                &mutation.key,
            ));
            self.unconfirmed = Some((mutation.key, mutation.change));
        }
        Expiry {
            changed: !expired.is_empty() || notice.is_some() || before != self.snapshot_age(),
            notice,
        }
    }

    fn run_reads(&mut self, features: &Value, id: &str) -> Vec<Value> {
        let mut commands = Vec::new();
        let run_id = || id.to_owned();
        if let Ok(pair) = self.workflow(features, RunCall::Get { run_id: run_id() }) {
            commands.push(self.read(Read::Run(run_id()), pair));
        }
        if let Ok(pair) = self.decisions(features, id, 0) {
            let read = Read::Decisions {
                run: id.to_owned(),
                offset: 0,
                page: 0,
            };
            commands.push(self.read(read, pair));
        }
        let inbox = RunCall::Inbox {
            request: InboxRequest::Read { run_id: run_id() },
        };
        if let Ok(pair) = self.workflow(features, inbox) {
            commands.push(self.read(Read::Inbox(run_id()), pair));
        }
        if let Ok(pair) = self.workflow(features, RunCall::Digest { run_id: run_id() }) {
            commands.push(self.read(Read::Digest(run_id()), pair));
        }
        let wakes = RunCall::Wakes {
            request: WakeRequest::Get {
                run_id: run_id(),
                after: None,
            },
        };
        if features["runWakes"] == true
            && let Ok(pair) = self.workflow(features, wakes)
        {
            commands.push(self.read(Read::Wakes(run_id()), pair));
        }
        commands
    }

    fn decisions(&mut self, features: &Value, id: &str, offset: u64) -> Result<(String, Value)> {
        let request = DecisionRequest::List {
            run_id: id.to_owned(),
            offset,
        };
        self.workflow(features, RunCall::Decision { request })
    }

    pub fn refresh(&mut self, features: &Value) -> Effect {
        self.load = Load::Loading;
        let mut effect = Effect::command(self.list(features));
        if self.page == Page::Templates
            && let Some(directory) = self.templates.as_ref().map(|t| t.directory.clone())
        {
            effect
                .commands
                .extend(self.open_templates(features, directory).commands);
        }
        effect
    }

    pub fn move_selection(&mut self, features: &Value, delta: isize) -> Effect {
        self.confirm_pause = false;
        let next = self
            .selected_row()
            .saturating_add_signed(delta)
            .min(self.runs.len());
        let id = next.checked_sub(1).map(|index| self.runs[index].id.clone());
        if id == self.selected {
            return Effect::default();
        }
        self.selected = id.clone();
        match id {
            Some(id) if !self.details.contains_key(&id) => Effect {
                commands: self.run_reads(features, &id),
                notice: None,
            },
            _ => Effect::default(),
        }
    }

    pub fn reload_selected(&mut self, features: &Value) -> Effect {
        match self.selected.clone() {
            Some(id) => Effect {
                commands: self.run_reads(features, &id),
                notice: None,
            },
            None => Effect::default(),
        }
    }

    pub fn open_templates(&mut self, features: &Value, directory: String) -> Effect {
        self.page = Page::Templates;
        if let Err(error) = Self::templates_supported(features) {
            self.templates = None;
            return Effect::notice(error.to_string());
        }
        let mut command = match template_command("list", &directory, None, None) {
            Ok((command, _)) => command,
            Err(error) => {
                self.templates = None;
                return Effect::notice(error.to_string());
            }
        };
        let selected = self.templates.as_ref().map_or(0, |t| t.selected);
        self.templates = Some(Templates {
            load: Load::Loading,
            directory: directory.clone(),
            repository: String::new(),
            digest: None,
            approved: false,
            items: Vec::new(),
            selected,
        });
        let id = self.next_id();
        command["requestId"] = id.clone().into();
        Effect {
            commands: vec![self.read(Read::Templates, (id, command))],
            notice: None,
        }
    }

    pub fn move_template(&mut self, delta: isize) {
        if let Some(templates) = &mut self.templates {
            let count = templates.startable().len();
            if count > 0 {
                templates.selected = templates
                    .selected
                    .saturating_add_signed(delta)
                    .min(count - 1);
            }
        }
    }

    pub fn back(&mut self) {
        self.confirm_pause = false;
        match self.page {
            Page::Templates | Page::Answer => {
                self.page = Page::Runs;
                self.answer = None;
            }
            Page::Runs => self.open = false,
        }
    }

    fn key_for(&self, change: &Change) -> String {
        match &self.unconfirmed {
            Some((key, previous)) if previous == change => key.clone(),
            _ => format!("tui-run-{}", hex::encode(nesvo_wire::random::<8>())),
        }
    }

    fn build(&mut self, features: &Value, change: &Change, key: &str) -> Result<(String, Value)> {
        let key = key.to_owned();
        let call = match change {
            Change::Pause { run, revision } => RunCall::Control {
                request: ControlRequest::Start {
                    key,
                    run_id: run.clone(),
                    expected_revision: *revision,
                    kind: ControlKind::Stop,
                },
            },
            Change::Resume { run, revision } => RunCall::Resume {
                key,
                run_id: run.clone(),
                expected_revision: *revision,
            },
            Change::Drain { run, revision } => RunCall::Drain {
                key,
                run_id: run.clone(),
                expected_revision: *revision,
            },
            Change::Answer {
                run,
                decision,
                revision,
                answer,
            } => RunCall::Decision {
                request: DecisionRequest::Answer {
                    key,
                    run_id: run.clone(),
                    decision_id: decision.clone(),
                    expected_revision: *revision,
                    answer: answer.clone(),
                },
            },
            Change::Wake {
                run,
                revision,
                action,
            } => RunCall::Wakes {
                request: action.request(key, run.clone(), *revision),
            },
            Change::Start { directory, name } => {
                Self::templates_supported(features)?;
                let (mut command, _) =
                    template_command("start", directory, None, Some((name, &key)))?;
                let id = self.next_id();
                command["requestId"] = id.clone().into();
                return Ok((id, command));
            }
        };
        self.workflow(features, call)
    }

    fn change(&mut self, features: &Value, change: Change) -> Effect {
        self.confirm_pause = false;
        if self.mutation.is_some() {
            return Effect::notice(BUSY);
        }
        let key = self.key_for(&change);
        match self.build(features, &change, &key) {
            Ok((request_id, command)) => {
                self.unconfirmed = None;
                self.mutation = Some(Mutation {
                    request_id,
                    key,
                    change,
                    sent: Instant::now(),
                });
                Effect {
                    commands: vec![command],
                    notice: None,
                }
            }
            Err(error) => Effect::notice(error.to_string()),
        }
    }

    fn run_change(&mut self, features: &Value, make: fn(String, u64) -> Change) -> Effect {
        match self.selected_run() {
            Some(run) => {
                let change = make(run.id.clone(), run.revision);
                self.change(features, change)
            }
            None => Effect::default(),
        }
    }

    pub fn pause(&mut self, features: &Value) -> Effect {
        if self.selected_run().is_none() {
            return Effect::default();
        }
        if !self.confirm_pause {
            self.confirm_pause = true;
            return Effect::notice(
                "Press p again to stop this run's workers; r resumes the run later.",
            );
        }
        self.run_change(features, |run, revision| Change::Pause { run, revision })
    }

    pub fn resume(&mut self, features: &Value) -> Effect {
        self.run_change(features, |run, revision| Change::Resume { run, revision })
    }

    pub fn drain(&mut self, features: &Value) -> Effect {
        self.run_change(features, |run, revision| Change::Drain { run, revision })
    }

    pub fn toggle_wakes(&mut self, features: &Value) -> Effect {
        let Some(wakes) = self.selected_detail().map(|detail| detail.wakes.clone()) else {
            return Effect::default();
        };
        if wakes.error.is_some() {
            return Effect::notice("Wake policy is unavailable; Enter reloads the run.");
        }
        if !wakes.loaded {
            return Effect::notice("Wake policy is still loading.");
        }
        let action = match &wakes.policy {
            Some(policy) if policy.held => WakeAction::Resume,
            Some(policy) if policy.enabled => WakeAction::Hold,
            _ => WakeAction::Enable,
        };
        self.wake_change(features, action)
    }

    pub fn toggle_delivery(&mut self, features: &Value) -> Effect {
        let Some(wakes) = self.selected_detail().map(|detail| detail.wakes.clone()) else {
            return Effect::default();
        };
        if wakes.policy.is_none() {
            return Effect::notice("Enable coordinator wakes with w before choosing delivery.");
        }
        let action = if wakes.full() {
            WakeAction::Delta
        } else {
            WakeAction::Full
        };
        self.wake_change(features, action)
    }

    fn wake_change(&mut self, features: &Value, action: WakeAction) -> Effect {
        let Some(run) = self.selected_run() else {
            return Effect::default();
        };
        let change = Change::Wake {
            run: run.id.clone(),
            revision: run.revision,
            action,
        };
        self.change(features, change)
    }

    pub fn cancel_confirm(&mut self) -> bool {
        std::mem::take(&mut self.confirm_pause)
    }

    pub fn begin_answer(&mut self) -> Effect {
        self.confirm_pause = false;
        let Some(run) = self.selected.clone() else {
            return Effect::default();
        };
        let Some(decision) = self.pending_decision().cloned() else {
            return Effect::notice("This run has no pending decision.");
        };
        self.answer = Some(AnswerForm {
            run_id: run,
            decision_id: decision.id,
            revision: decision.revision,
            question: decision.question,
            text: String::new(),
        });
        self.page = Page::Answer;
        Effect::default()
    }

    pub fn submit_answer(&mut self, features: &Value) -> Effect {
        let Some(form) = self.answer.clone() else {
            return Effect::default();
        };
        if form.text.trim().is_empty() || form.text.len() > ANSWER_BYTES {
            return Effect::notice("Write an answer of at most 2048 bytes.");
        }
        self.change(
            features,
            Change::Answer {
                run: form.run_id,
                decision: form.decision_id,
                revision: form.revision,
                answer: form.text,
            },
        )
    }

    pub fn start_selected(&mut self, features: &Value) -> Effect {
        let Some(templates) = &self.templates else {
            return Effect::default();
        };
        if templates.load != Load::Ready {
            return Effect::default();
        }
        let Some(template) = templates.startable().get(templates.selected) else {
            return Effect::notice(if templates.items.is_empty() {
                "No workflow templates are declared in HEAD:nesvo.toml."
            } else {
                "Approve these templates with nesvo workflow approve-templates first."
            });
        };
        let change = Change::Start {
            directory: templates.directory.clone(),
            name: template.name.clone(),
        };
        self.change(features, change)
    }

    pub fn response(&mut self, features: &Value, event: &Value) -> Option<Effect> {
        let header = ReplyHeader::of(event);
        let request_id = header.request_id.as_deref()?;
        if let Some((read, _)) = self.reads.remove(request_id) {
            return Some(self.read_response(features, read, event));
        }
        if self
            .mutation
            .as_ref()
            .is_some_and(|mutation| mutation.request_id == request_id)
        {
            let mutation = self.mutation.take()?;
            return Some(self.change_response(features, mutation.change, event));
        }
        None
    }

    fn read_response(&mut self, features: &Value, read: Read, event: &Value) -> Effect {
        match read {
            Read::List => {
                let initial = self.runs.is_empty() && self.selected.is_none();
                let page: RunPage = views::decode(event).unwrap_or_default();
                self.runs = kept(page.runs);
                self.more = page.next_offset.is_some();
                self.load = Load::Ready;
                self.snapshot_at = Some(Instant::now());
                let kept = self
                    .selected
                    .as_deref()
                    .is_none_or(|id| self.runs.iter().any(|run| run.id == id));
                if initial || !kept {
                    self.selected = self.runs.first().map(|run| run.id.clone());
                }
                let runs = &self.runs;
                self.details
                    .retain(|id, _| runs.iter().any(|run| run.id == *id));
                self.reload_selected(features)
            }
            Read::Run(id) => {
                let Some(detail) = self.listed_detail(&id) else {
                    return Effect::default();
                };
                let view: RunView = views::decode(event).unwrap_or_default();
                detail.goal = view
                    .run
                    .0
                    .as_ref()
                    .map(|run| run.goal.clone())
                    .unwrap_or_default();
                detail.tasks = kept(view.tasks);
                detail.tasks_load = Load::Ready;
                if let Some(row) = self.runs.iter_mut().find(|run| run.id == id)
                    && let Some(summary) = view.run.0
                {
                    *row = summary;
                }
                Effect::default()
            }
            Read::Decisions { run, offset, page } => {
                let reply: DecisionPage = views::decode(event).unwrap_or_default();
                let Some(detail) = self.listed_detail(&run) else {
                    return Effect::default();
                };
                if offset == 0 {
                    detail.decisions.clear();
                }
                detail.decisions.extend(
                    kept(reply.decisions)
                        .into_iter()
                        .filter(|decision| decision.state == DecisionState::Pending),
                );
                let next = reply
                    .next_offset
                    .filter(|next| *next > offset && page + 1 < DECISION_PAGES);
                match next.map(|next| (next, self.decisions(features, &run, next))) {
                    Some((next, Ok(pair))) => {
                        let read = Read::Decisions {
                            run,
                            offset: next,
                            page: page + 1,
                        };
                        Effect {
                            commands: vec![self.read(read, pair)],
                            notice: None,
                        }
                    }
                    _ => {
                        if let Some(detail) = self.details.get_mut(&run) {
                            detail.decisions_load = Load::Ready;
                        }
                        Effect::default()
                    }
                }
            }
            Read::Inbox(id) => {
                let Some(detail) = self.listed_detail(&id) else {
                    return Effect::default();
                };
                let inbox: InboxPage = views::decode(event).unwrap_or_default();
                detail.pending_messages = inbox.pending_count;
                detail.messages = kept(inbox.messages);
                detail.inbox_load = Load::Ready;
                Effect::default()
            }
            Read::Digest(id) => {
                let Some(detail) = self.listed_detail(&id) else {
                    return Effect::default();
                };
                let reply: DigestReply = views::decode(event).unwrap_or_default();
                detail.digest = Some(reply.digest.into());
                detail.digest_error = None;
                Effect::default()
            }
            Read::Wakes(id) => {
                let Some(detail) = self.listed_detail(&id) else {
                    return Effect::default();
                };
                let state: WakeState = views::decode(event).unwrap_or_default();
                let wakes = &mut detail.wakes;
                wakes.loaded = true;
                wakes.error = None;
                wakes.policy = state.wake_policy;
                wakes.pending = state.pending_count;
                wakes.delivered_through = state.delivered_through;
                wakes.batches = kept(state.batches);
                Effect::default()
            }
            Read::Templates => {
                if let Some(templates) = &mut self.templates {
                    let reply: WorkflowTemplates = views::decode(event).unwrap_or_default();
                    templates.load = Load::Ready;
                    templates.repository = reply.repository;
                    templates.digest = reply.digest;
                    templates.approved = reply.approved;
                    templates.items = kept(reply.templates);
                    let count = templates.startable().len();
                    templates.selected = templates.selected.min(count.saturating_sub(1));
                }
                Effect::default()
            }
        }
    }

    fn change_response(&mut self, features: &Value, change: Change, event: &Value) -> Effect {
        let notice = match &change {
            Change::Pause { .. } => {
                "Stop requested for run-bound workers; this is not proof of exit."
            }
            Change::Resume { .. } => "Run resumed on the host.",
            Change::Drain { .. } => "Drain accepted; current workers may finish and report.",
            Change::Wake { action, .. } => action.notice(),
            Change::Answer { .. } => {
                self.answer = None;
                self.page = Page::Runs;
                "Answer recorded; it does not validate the task."
            }
            Change::Start { name, .. } => {
                self.page = Page::Runs;
                let run = views::decode::<RunChanged>(event).unwrap_or_default().run;
                if let Some(id) = run.id {
                    self.details.remove(&id);
                    self.selected = Some(id);
                }
                return Effect {
                    commands: self.list(features).into_iter().collect(),
                    notice: Some(format!(
                        "Started template {name} as run {}.",
                        run.title.as_deref().unwrap_or(name)
                    )),
                };
            }
        };
        let mut effect = Effect::notice(notice);
        effect.commands.extend(self.list(features));
        effect
    }

    fn read_failure(&mut self, read: Read, message: String) {
        match read {
            Read::List => self.load = Load::Failed(message),
            Read::Templates => {
                if let Some(templates) = &mut self.templates {
                    templates.load = Load::Failed(message);
                }
            }
            Read::Run(id) => {
                if let Some(detail) = self.listed_detail(&id) {
                    detail.tasks_load = Load::Failed(message);
                }
            }
            Read::Decisions { run, .. } => {
                if let Some(detail) = self.listed_detail(&run) {
                    detail.decisions_load = Load::Failed(message);
                }
            }
            Read::Inbox(id) => {
                if let Some(detail) = self.listed_detail(&id) {
                    detail.inbox_load = Load::Failed(message);
                }
            }
            Read::Digest(id) => {
                if let Some(detail) = self.listed_detail(&id) {
                    detail.digest_error = Some(message);
                }
            }
            Read::Wakes(id) => {
                if let Some(detail) = self.listed_detail(&id) {
                    detail.wakes.loaded = false;
                    detail.wakes.error = Some(message);
                }
            }
        }
    }

    pub fn failure(&mut self, features: &Value, event: &Value) -> Option<Effect> {
        let error = HostError::of(event);
        let request_id = error.request_id.as_deref()?;
        let message = error.message_or("Host rejected the request").to_owned();
        if let Some((read, _)) = self.reads.remove(request_id) {
            self.read_failure(read, message);
            return Some(Effect::default());
        }
        if !self
            .mutation
            .as_ref()
            .is_some_and(|mutation| mutation.request_id == request_id)
        {
            return None;
        }
        let mutation = self.mutation.take()?;
        if error.code() == "revision_conflict" {
            let mut effect = Effect::notice(
                "This run changed on the host; review the current revision and retry.",
            );
            effect.commands.extend(self.list(features));
            return Some(effect);
        }
        let notice = unconfirmed_notice(&message, &mutation.change, &mutation.key);
        self.unconfirmed = Some((mutation.key, mutation.change));
        Some(Effect::notice(notice))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn features() -> Value {
        json!({
            "workflowPlans": true,
            "workflowAttempts": true,
            "workflowInbox": true,
            "workflowDecisions": true,
            "runControls": true,
            "runDrain": true,
            "runDigests": true,
            "workflowTemplates": true
        })
    }

    pub(crate) fn digest() -> Value {
        json!({"run":{"id":"run-a","title":"Branch review","revision":4,"state":"active"},"stored":false,"fingerprint":"f".repeat(64),"digest":{
            "schemaVersion":1,"kind":"workingState","runId":"run-a","title":"Branch review","state":"active","sourceRevision":4,"producedAt":9,
            "tasks":{"total":2,"byState":{"planned":1,"succeeded":1}},
            "taskDigests":[
                {"id":"t1","key":"implement","state":"succeeded","nextSteps":["Wire the parser into the CLI"],"workspace":{"kind":"worktree","directory":"C:/w","branch":"nesvo/0123456789abcdef"}},
                {"id":"t2","key":"review","state":"planned","nextSteps":[],"workspace":null}
            ],
            "omittedTasks":0,"truncated":false,
            "decisions":{"answered":1,"closed":0,"pending":1,"total":2},"openDecisions":[],
            "budget":{"timeState":"open","activeAttempts":1},"inbox":{"pendingCoordinatorMessages":3,"messageHead":4},
            "evidence":{"journalCursor":41,"checkpointCount":2,"checkpoints":[]}
        }})
    }

    pub(crate) fn listed() -> Value {
        json!([
            {"id":"run-a","title":"Branch review","coordinatorSessionId":null,"revision":4,"state":"active","createdAt":2},
            {"id":"run-b","title":"Release notes","coordinatorSessionId":null,"revision":2,"state":"drained","createdAt":1}
        ])
    }

    pub(crate) fn view() -> Value {
        json!({
            "run":{"id":"run-a","title":"Branch review","goal":"Review the branch","revision":4,"state":"active","createdAt":2},
            "tasks":[
                {"id":"t1","key":"implement","title":"Implement","instruction":"x","dependencies":[],"state":"reported","dependencyState":"ready","attempts":2,
                 "currentAttempt":{"id":"a2","ordinal":2,"sessionId":"s-worker","state":"reported","reportedOutcome":"succeeded"},"taskResult":null},
                {"id":"t2","key":"review","title":"Review","instruction":"y","dependencies":["t1"],"state":"planned","dependencyState":"waiting","attempts":0,"currentAttempt":null,"taskResult":null}
            ]
        })
    }

    pub(crate) fn decisions() -> Value {
        json!([
            {"id":"d1","runId":"run-a","taskId":"t1","attemptId":"a1","audience":"owner","question":"Old question","revision":2,"state":"answered"},
            {"id":"d2","runId":"run-a","taskId":"t1","attemptId":"a2","audience":"owner","question":"Ship the migration now?","revision":1,"state":"pending"}
        ])
    }

    pub(crate) fn inbox() -> Value {
        json!({"pendingCount":3,"messages":[{"id":"m1","kind":"result","body":"Implementation reported"},{"id":"m2","kind":"decision","body":"Ship the migration now?"}]})
    }

    pub(crate) fn templates() -> Value {
        json!({"type":"workflowTemplates","repository":"C:/Projects/nesvo","configured":true,"digest":"a".repeat(64),"approved":true,"templates":[
            {"name":"review","title":"Branch review","goal":"g","start":"active","budget":null,"tasks":[{"key":"implement"},{"key":"review"}]},
            {"name":"triage","title":"Triage","goal":"g","start":"draft","budget":null,"tasks":[{"key":"triage"}]}
        ]})
    }

    pub(crate) fn reply(runs: &mut Runs, command: &Value, body: Value) -> Effect {
        reply_with(runs, &features(), command, body)
    }

    fn reply_with(runs: &mut Runs, features: &Value, command: &Value, mut body: Value) -> Effect {
        body["requestId"] = command["requestId"].clone();
        if body.get("type").is_none() {
            body["type"] = "workflow".into();
        }
        runs.response(features, &body).unwrap()
    }

    pub(crate) fn wake_features() -> Value {
        let mut features = features();
        features["runWakes"] = true.into();
        features["runWakeDelivery"] = true.into();
        features
    }

    pub(crate) fn wakes() -> Value {
        json!({
            "wakePolicy":{"enabled":true,"held":false,"phase":"waiting","reason":"no_new_notices","delivery":"delta","generation":2},
            "pendingCount":2,
            "deliveredThrough":11,
            "batches":[
                {"id":"b2aaaaaaaaaaaaaa","phase":"settled","reason":null,"delivery":"delta","noticeCount":8,"native":{"phase":"settled"}},
                {"id":"b1bbbbbbbbbbbbbb","phase":"unknown","reason":"host_restart","delivery":"full","noticeCount":3,"native":{"phase":"unknown"}}
            ]
        })
    }

    pub(crate) fn loaded_with_wakes() -> Runs {
        let features = wake_features();
        let (mut runs, list) = Runs::open(7, &features).unwrap();
        let effect = reply_with(
            &mut runs,
            &features,
            &list,
            json!({"runs":listed(),"nextOffset":null}),
        );
        for command in effect.commands {
            let body = match command["request"]["action"].as_str().unwrap() {
                "get" => view(),
                "decision" => json!({"decisions":decisions(),"nextOffset":null}),
                "wakes" => wakes(),
                "digest" => digest(),
                _ => inbox(),
            };
            reply_with(&mut runs, &features, &command, body);
        }
        runs
    }

    fn set_policy(runs: &mut Runs, policy: Value) {
        let wakes = &mut runs.details.get_mut("run-a").unwrap().wakes;
        wakes.policy = serde_json::from_value(policy).ok();
    }

    #[test]
    fn runs_wake_controls_hold_resume_enable_and_switch_delivery_at_the_run_revision() {
        let features = wake_features();
        let (mut runs, list) = Runs::open(7, &features).unwrap();
        let reads = reply_with(
            &mut runs,
            &features,
            &list,
            json!({"runs":listed(),"nextOffset":null}),
        );
        assert_eq!(
            reads.commands[4]["request"],
            json!({"action":"wakes","request":{"action":"get","runId":"run-a","after":null}})
        );
        let mut runs = loaded_with_wakes();
        let wakes = &runs.selected_detail().unwrap().wakes;
        assert_eq!(
            wakes.summary(),
            "Wakes · delivering · delta only · 2 pending"
        );
        assert_eq!(wakes.delivered_through, 11);
        assert_eq!(wakes.batches.len(), 2);
        let hold = runs.toggle_wakes(&features).commands.remove(0);
        let request = &hold["request"]["request"];
        assert_eq!(hold["request"]["action"], "wakes");
        assert_eq!(request["action"], "pause");
        assert_eq!(request["runId"], "run-a");
        assert_eq!(request["expectedRevision"], 4);
        assert!(request["key"].as_str().unwrap().starts_with("tui-run-"));
        assert_eq!(
            runs.toggle_delivery(&features).notice.as_deref(),
            Some(BUSY)
        );
        let done = reply(&mut runs, &hold, json!({"run":{"id":"run-a"}}));
        assert!(done.notice.unwrap().contains("held"));
        assert_eq!(done.commands[0]["request"]["action"], "list");
        set_policy(
            &mut runs,
            json!({"enabled":true,"held":true,"phase":"held","reason":"owner_held","delivery":"delta"}),
        );
        assert!(
            runs.selected_detail()
                .unwrap()
                .wakes
                .summary()
                .starts_with("Wakes · held · delta only")
        );
        let resume = runs.toggle_wakes(&features).commands.remove(0);
        assert_eq!(resume["request"]["request"]["action"], "resume");
        reply(&mut runs, &resume, json!({"run":{"id":"run-a"}}));
        let full = runs.toggle_delivery(&features).commands.remove(0);
        assert_eq!(full["request"]["request"]["action"], "setDelivery");
        assert_eq!(full["request"]["request"]["delivery"], "full");
        reply(&mut runs, &full, json!({"run":{"id":"run-a"}}));
        set_policy(
            &mut runs,
            json!({"enabled":true,"held":false,"phase":"enabled","reason":null,"delivery":"full"}),
        );
        let delta = runs.toggle_delivery(&features).commands.remove(0);
        assert_eq!(delta["request"]["request"]["delivery"], "delta");
        reply(&mut runs, &delta, json!({"run":{"id":"run-a"}}));
        set_policy(&mut runs, Value::Null);
        assert!(
            runs.toggle_delivery(&features)
                .notice
                .unwrap()
                .contains("Enable coordinator wakes")
        );
        let enable = runs.toggle_wakes(&features).commands.remove(0);
        assert_eq!(enable["request"]["request"]["action"], "enable");
        reply(&mut runs, &enable, json!({"run":{"id":"run-a"}}));
        set_policy(
            &mut runs,
            json!({"enabled":true,"held":false,"phase":"enabled","reason":null,"delivery":"delta"}),
        );
        let mut older = wake_features();
        older["runWakeDelivery"] = false.into();
        assert!(
            runs.toggle_wakes(&older)
                .notice
                .unwrap()
                .contains("update nesvo-host")
        );
    }

    pub(crate) fn loaded() -> Runs {
        let (mut runs, list) = Runs::open(7, &features()).unwrap();
        let effect = reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":null}));
        for command in effect.commands {
            let action = command["request"]["action"].as_str().unwrap().to_owned();
            let body = match action.as_str() {
                "get" => view(),
                "decision" => json!({"decisions":decisions(),"nextOffset":null}),
                "digest" => digest(),
                _ => inbox(),
            };
            reply(&mut runs, &command, body);
        }
        runs
    }

    #[test]
    fn runs_open_lists_and_loads_the_first_run_with_tasks_inbox_and_pending_decisions() {
        let (mut runs, list) = Runs::open(7, &features()).unwrap();
        assert_eq!(list["type"], "workflow");
        assert_eq!(list["request"], json!({"action":"list","offset":0}));
        assert_eq!(list["requestId"], "tui-7-runs-1");
        let effect = reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":16}));
        assert!(runs.more);
        assert_eq!(runs.selected.as_deref(), Some("run-a"));
        let actions: Vec<_> = effect
            .commands
            .iter()
            .map(|command| command["request"].clone())
            .collect();
        assert_eq!(
            actions,
            [
                json!({"action":"get","runId":"run-a"}),
                json!({"action":"decision","request":{"action":"list","runId":"run-a","attemptId":null,"offset":0}}),
                json!({"action":"inbox","request":{"action":"read","runId":"run-a","attemptId":null,"after":null,"includeAcked":null}}),
                json!({"action":"digest","runId":"run-a"}),
            ]
        );
        let loaded = loaded();
        let detail = loaded.selected_detail().unwrap();
        assert_eq!(detail.goal, "Review the branch");
        assert_eq!(detail.tasks[0].current_attempt.as_ref().unwrap().ordinal, 2);
        assert_eq!(detail.decisions.len(), 1);
        assert_eq!(detail.decisions[0].id, "d2");
        assert_eq!(detail.pending_messages, 3);
        assert_eq!(
            (
                &detail.decisions_load,
                &detail.inbox_load,
                &detail.tasks_load
            ),
            (&Load::Ready, &Load::Ready, &Load::Ready)
        );
        assert!(Runs::open(1, &json!({})).is_err());
    }

    fn fail(runs: &mut Runs, command: &Value, message: &str) {
        runs.failure(
            &features(),
            &json!({"type":"error","requestId":command["requestId"],"code":"internal","message":message}),
        );
    }

    #[test]
    fn runs_failed_section_reads_stay_failed_instead_of_reporting_zero() {
        let (mut runs, list) = Runs::open(7, &features()).unwrap();
        let reads = reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":null}));
        for command in &reads.commands {
            match command["request"]["action"].as_str().unwrap() {
                "get" | "digest" => fail(&mut runs, command, "read failed"),
                "decision" => {
                    reply(
                        &mut runs,
                        command,
                        json!({"decisions":decisions(),"nextOffset":null}),
                    );
                }
                _ => {}
            }
        }
        let detail = runs.selected_detail().unwrap();
        assert_eq!(detail.tasks_load, Load::Failed("read failed".into()));
        assert_eq!(detail.digest_error.as_deref(), Some("read failed"));
        assert_eq!(detail.decisions_load, Load::Ready);
        assert_eq!(detail.inbox_load, Load::Loading);
        let inbox = reads
            .commands
            .iter()
            .find(|command| command["request"]["action"] == "inbox")
            .unwrap();
        fail(&mut runs, inbox, "inbox down");
        assert_eq!(
            runs.selected_detail().unwrap().inbox_load,
            Load::Failed("inbox down".into())
        );
    }

    #[test]
    fn runs_decision_paging_counts_pages_instead_of_assuming_the_host_page_size() {
        let (mut runs, list) = Runs::open(7, &features()).unwrap();
        let reads = reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":null}));
        let mut read = reads
            .commands
            .into_iter()
            .find(|command| command["request"]["action"] == "decision")
            .unwrap();
        let mut pages = 1;
        loop {
            let offset = read["request"]["request"]["offset"].as_u64().unwrap();
            let next = reply(
                &mut runs,
                &read,
                json!({"decisions":decisions(),"nextOffset":offset + 3}),
            );
            match next.commands.into_iter().next() {
                Some(command) => {
                    read = command;
                    pages += 1;
                }
                None => break,
            }
        }
        assert_eq!(pages, DECISION_PAGES);
        assert_eq!(runs.selected_detail().unwrap().decisions_load, Load::Ready);
    }

    #[test]
    fn runs_details_are_pruned_to_the_listed_runs() {
        let mut runs = loaded();
        runs.details.insert("run-gone".into(), Detail::default());
        let list = runs.refresh(&features()).commands.remove(0);
        reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":null}));
        assert!(!runs.details.contains_key("run-gone"));
        assert!(runs.details.contains_key("run-a"));
    }

    #[test]
    fn runs_late_detail_replies_for_an_unlisted_run_do_not_recreate_its_details() {
        let (mut runs, list) = Runs::open(7, &features()).unwrap();
        let reads = reply(&mut runs, &list, json!({"runs":listed(),"nextOffset":null}));
        let refresh = runs.refresh(&features()).commands.remove(0);
        reply(
            &mut runs,
            &refresh,
            json!({"runs":[listed()[1].clone()],"nextOffset":null}),
        );
        assert_eq!(runs.selected.as_deref(), Some("run-b"));
        for command in &reads.commands {
            let body = match command["request"]["action"].as_str().unwrap() {
                "get" => view(),
                "decision" => json!({"decisions":decisions(),"nextOffset":3}),
                "digest" => {
                    fail(&mut runs, command, "late failure");
                    continue;
                }
                _ => inbox(),
            };
            let effect = reply(&mut runs, command, body);
            assert!(effect.commands.is_empty(), "{command}");
        }
        assert!(!runs.details.contains_key("run-a"));
    }

    #[test]
    fn runs_expired_reads_fail_and_an_expired_change_becomes_unconfirmed() {
        let features = features();
        let mut runs = loaded();
        runs.reload_selected(&features);
        runs.pause(&features);
        let pause = runs.pause(&features).commands.remove(0);
        assert_eq!(runs.resume(&features).notice.as_deref(), Some(BUSY));
        let early = runs.expire(Instant::now());
        assert!(early.notice.is_none());
        let later = Instant::now() + CHANGE_TIMEOUT + Duration::from_secs(1);
        let expiry = runs.expire(later);
        assert!(expiry.changed);
        assert!(expiry.notice.unwrap().contains("Run change unconfirmed"));
        assert!(runs.reads.is_empty());
        assert_eq!(
            runs.selected_detail().unwrap().tasks_load,
            Load::Failed(TIMEOUT_MESSAGE.into())
        );
        let (key, change) = runs.unconfirmed_key().unwrap();
        assert!(matches!(change, Change::Pause { .. }));
        let key = key.to_owned();
        let retry = runs.pause(&features);
        assert!(retry.commands.is_empty());
        let retry = runs.pause(&features).commands.remove(0);
        assert_eq!(retry["request"]["request"]["key"], key.as_str());
        assert_ne!(retry["requestId"], pause["requestId"]);
    }

    #[test]
    fn runs_poll_relists_after_the_interval_and_reports_the_snapshot_age() {
        let features = features();
        let mut runs = loaded();
        assert!(runs.poll(&features).is_none());
        runs.age_poll();
        let poll = runs.poll(&features).unwrap();
        assert_eq!(poll["request"]["action"], "list");
        assert!(runs.poll(&features).is_none());
        assert_eq!(runs.load, Load::Ready);
        let taken = runs.snapshot_at.unwrap();
        runs.expire(taken + Duration::from_secs(2));
        assert_eq!(runs.snapshot_age().as_deref(), Some("updated just now"));
        assert!(runs.expire(taken + Duration::from_secs(42)).changed);
        assert_eq!(runs.snapshot_age().as_deref(), Some("updated 42s ago"));
        assert!(!runs.expire(taken + Duration::from_secs(42)).changed);
    }

    #[test]
    fn runs_selection_includes_the_template_row_and_reads_each_run_once() {
        let mut runs = loaded();
        let features = features();
        assert_eq!(runs.selected_row(), 1);
        assert!(runs.move_selection(&features, -1).commands.is_empty());
        assert_eq!(runs.selected, None);
        assert_eq!(runs.selected_row(), 0);
        assert!(runs.move_selection(&features, -1).commands.is_empty());
        assert!(runs.move_selection(&features, 1).commands.is_empty());
        let fresh = runs.move_selection(&features, 1);
        assert_eq!(runs.selected.as_deref(), Some("run-b"));
        assert_eq!(fresh.commands.len(), 4);
        assert!(runs.move_selection(&features, 5).commands.is_empty());
    }

    #[test]
    fn runs_read_the_selected_run_digest_and_skip_it_on_older_hosts() {
        let runs = loaded();
        let parsed = runs.selected_detail().unwrap().digest.clone().unwrap();
        assert_eq!(
            parsed,
            Digest {
                kind: "workingState".into(),
                source_revision: 4,
                total: 2,
                accepted: 1,
                omitted: 0,
                decisions_pending: 1,
                decisions_answered: 1,
                time_state: "open".into(),
                active_attempts: 1,
                journal_cursor: 41,
                checkpoints: 2,
                next_steps: vec!["implement: Wire the parser into the CLI".into()],
                branches: vec!["nesvo/0123456789abcdef".into()],
            }
        );
        assert!(!parsed.settled());
        let mut legacy = features();
        legacy["runDigests"] = false.into();
        let (mut older, list) = Runs::open(8, &legacy).unwrap();
        older.runs = serde_json::from_value(listed()).unwrap();
        older.selected = Some("run-a".into());
        let commands = older.reload_selected(&legacy).commands;
        assert_eq!(commands.len(), 3);
        assert!(
            commands
                .iter()
                .all(|command| command["request"]["action"] != "digest")
        );
        assert_eq!(list["request"]["action"], "list");
        let mut failing = loaded();
        let reread = failing.reload_selected(&features()).commands;
        let digest_read = reread
            .iter()
            .find(|command| command["request"]["action"] == "digest")
            .unwrap();
        assert!(
            failing
                .failure(
                    &features(),
                    &json!({"type":"error","requestId":digest_read["requestId"],"code":"run_not_found","message":"gone"}),
                )
                .unwrap()
                .notice
                .is_none()
        );
        let mut settled = digest();
        settled["digest"]["kind"] = "final".into();
        let mut runs = loaded();
        let read = runs
            .reload_selected(&features())
            .commands
            .into_iter()
            .find(|command| command["request"]["action"] == "digest")
            .unwrap();
        reply(&mut runs, &read, settled);
        assert!(
            runs.selected_detail()
                .unwrap()
                .digest
                .as_ref()
                .unwrap()
                .settled()
        );
    }

    #[test]
    fn runs_controls_send_existing_commands_with_keys_and_revisions() {
        let features = features();
        let mut runs = loaded();
        let warned = runs.pause(&features);
        assert!(warned.commands.is_empty());
        assert!(warned.notice.unwrap().contains("Press p again"));
        let pause = runs.pause(&features).commands.remove(0);
        assert_eq!(pause["request"]["action"], "control");
        assert_eq!(pause["request"]["request"]["action"], "start");
        assert_eq!(pause["request"]["request"]["kind"], "stop");
        assert_eq!(pause["request"]["request"]["runId"], "run-a");
        assert_eq!(pause["request"]["request"]["expectedRevision"], 4);
        let key = pause["request"]["request"]["key"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(key.starts_with("tui-run-"));
        assert_eq!(runs.drain(&features).notice.as_deref(), Some(BUSY));
        let done = reply(&mut runs, &pause, json!({"run":{"id":"run-a"}}));
        assert!(done.notice.unwrap().contains("not proof of exit"));
        assert_eq!(done.commands[0]["request"]["action"], "list");
        let drain = runs.drain(&features).commands.remove(0);
        assert_eq!(
            drain["request"],
            json!({"action":"drain","key":drain["request"]["key"],"runId":"run-a","expectedRevision":4})
        );
        reply(&mut runs, &drain, json!({"run":{"id":"run-a"}}));
        let resume = runs.resume(&features).commands.remove(0);
        assert_eq!(resume["request"]["action"], "resume");
        let failed = runs
            .failure(
                &features,
                &json!({"type":"error","requestId":resume["requestId"],"code":"busy","message":"Host busy"}),
            )
            .unwrap();
        let resume_key = resume["request"]["key"].as_str().unwrap();
        assert!(
            failed
                .notice
                .unwrap()
                .contains(&format!("nesvo run mutation --key {resume_key}"))
        );
        let retry = runs.resume(&features).commands.remove(0);
        assert_eq!(retry["request"]["key"], resume_key);
        let conflict = runs
            .failure(
                &features,
                &json!({"type":"error","requestId":retry["requestId"],"code":"revision_conflict","message":"stale"}),
            )
            .unwrap();
        assert_eq!(conflict.commands[0]["request"]["action"], "list");
        let fresh = runs.resume(&features).commands.remove(0);
        assert_ne!(fresh["request"]["key"], resume_key);
    }

    #[test]
    fn runs_answer_the_pending_decision_at_its_revision() {
        let features = features();
        let mut runs = loaded();
        assert!(runs.begin_answer().commands.is_empty());
        assert_eq!(runs.page, Page::Answer);
        assert_eq!(
            runs.answer.as_ref().unwrap().question,
            "Ship the migration now?"
        );
        assert!(runs.submit_answer(&features).notice.is_some());
        runs.answer.as_mut().unwrap().text = "Yes, after the backup".into();
        let answer = runs.submit_answer(&features).commands.remove(0);
        assert_eq!(answer["request"]["action"], "decision");
        let inner = &answer["request"]["request"];
        assert_eq!(inner["action"], "answer");
        assert_eq!(inner["decisionId"], "d2");
        assert_eq!(inner["expectedRevision"], 1);
        assert_eq!(inner["answer"], "Yes, after the backup");
        reply(&mut runs, &answer, json!({"decision":{"id":"d2"}}));
        assert_eq!(runs.page, Page::Runs);
        assert!(runs.answer.is_none());
        runs.selected = Some("run-b".into());
        assert!(
            runs.begin_answer()
                .notice
                .unwrap()
                .contains("no pending decision")
        );
    }

    #[test]
    fn runs_start_approved_templates_through_the_host_with_a_reused_key() {
        let features = features();
        let mut runs = loaded();
        let open = runs
            .open_templates(&features, "C:/Projects/nesvo".into())
            .commands
            .remove(0);
        assert_eq!(open["type"], "listWorkflowTemplates");
        assert_eq!(open["directory"], "C:/Projects/nesvo");
        assert!(runs.start_selected(&features).commands.is_empty());
        reply(&mut runs, &open, templates());
        runs.move_template(1);
        let start = runs.start_selected(&features).commands.remove(0);
        assert_eq!(start["type"], "startWorkflowTemplate");
        assert_eq!(start["name"], "triage");
        let key = start["key"].as_str().unwrap().to_owned();
        let failed = runs
            .failure(
                &features,
                &json!({"type":"error","requestId":start["requestId"],"code":"workflow_failed","message":"Lost"}),
            )
            .unwrap();
        assert!(failed.notice.unwrap().contains(&key));
        let retry = runs.start_selected(&features).commands.remove(0);
        assert_eq!(retry["key"], key.as_str());
        let done = reply(
            &mut runs,
            &retry,
            json!({"type":"workflowTemplateStarted","run":{"id":"run-c","title":"Triage"}}),
        );
        assert_eq!(runs.page, Page::Runs);
        assert_eq!(runs.selected.as_deref(), Some("run-c"));
        assert!(done.notice.unwrap().contains("Started template triage"));
        assert_eq!(done.commands[0]["request"]["action"], "list");
        let mut unapproved = templates();
        unapproved["approved"] = false.into();
        let open = runs
            .open_templates(&features, "C:/Projects/nesvo".into())
            .commands
            .remove(0);
        reply(&mut runs, &open, unapproved);
        assert!(runs.templates.as_ref().unwrap().startable().is_empty());
        assert!(
            runs.start_selected(&features)
                .notice
                .unwrap()
                .contains("approve-templates")
        );
        let mut legacy = features.clone();
        legacy["workflowTemplates"] = false.into();
        assert!(
            runs.open_templates(&legacy, "C:/x".into())
                .notice
                .unwrap()
                .contains("Update the host")
        );
    }
}
