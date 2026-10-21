use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

const DECISION_PAGES: u64 = 8;
const ANSWER_BYTES: usize = 2048;
const BUSY: &str = "Waiting for the host to confirm the previous run change.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Runs,
    Templates,
    Answer,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Load {
    Loading,
    Ready,
    Failed(String),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub ordinal: u64,
    pub session_id: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub key: String,
    pub state: String,
    pub dependency_state: String,
    pub attempts: u64,
    pub current_attempt: Option<Attempt>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub task_id: String,
    pub audience: String,
    pub question: String,
    pub revision: u64,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub kind: String,
    pub body: String,
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

impl Digest {
    fn parse(body: &Value) -> Self {
        let number = |value: &Value| value.as_u64().unwrap_or_default();
        let tasks = body["taskDigests"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        Self {
            kind: body["kind"].as_str().unwrap_or_default().to_owned(),
            source_revision: number(&body["sourceRevision"]),
            total: number(&body["tasks"]["total"]),
            accepted: number(&body["tasks"]["byState"]["succeeded"]),
            omitted: number(&body["omittedTasks"]),
            decisions_pending: number(&body["decisions"]["pending"]),
            decisions_answered: number(&body["decisions"]["answered"]),
            time_state: body["budget"]["timeState"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            active_attempts: number(&body["budget"]["activeAttempts"]),
            journal_cursor: number(&body["evidence"]["journalCursor"]),
            checkpoints: number(&body["evidence"]["checkpointCount"]),
            next_steps: tasks
                .iter()
                .flat_map(|task| {
                    let key = task["key"].as_str().unwrap_or_default();
                    task["nextSteps"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(move |step| format!("{key}: {step}"))
                })
                .collect(),
            branches: tasks
                .iter()
                .filter_map(|task| task["workspace"]["branch"].as_str())
                .map(str::to_owned)
                .collect(),
        }
    }

    pub fn settled(&self) -> bool {
        self.kind == "final"
    }
}

#[derive(Clone, Debug, Default)]
pub struct Detail {
    pub goal: String,
    pub tasks: Vec<Task>,
    pub decisions: Vec<Decision>,
    pub decisions_loaded: bool,
    pub pending_messages: u64,
    pub messages: Vec<Message>,
    pub inbox_loaded: bool,
    pub digest: Option<Digest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub name: String,
    pub title: String,
    pub start: String,
    pub tasks: Vec<serde::de::IgnoredAny>,
}

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
    Decisions(String, u64),
    Inbox(String),
    Digest(String),
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
}

#[derive(Clone, Debug)]
struct Mutation {
    request_id: String,
    key: String,
    change: Change,
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
    Ok(match (action, digest, start) {
        ("list", None, None) => (
            json!({"type":"listWorkflowTemplates","directory":directory}),
            "workflowTemplates",
        ),
        ("approve", Some(digest), None) => (
            json!({"type":"approveWorkflowTemplates","directory":directory,"digest":digest}),
            "workflowTemplatesApproved",
        ),
        ("revoke", Some(digest), None) => (
            json!({"type":"revokeWorkflowTemplates","directory":directory,"digest":digest}),
            "workflowTemplatesRevoked",
        ),
        ("start", None, Some((name, key))) => (
            json!({"type":"startWorkflowTemplate","directory":directory,"name":name,"key":key}),
            "workflowTemplateStarted",
        ),
        _ => return Err(invalid("Invalid workflow template request")),
    })
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
    prefix: String,
    counter: u64,
    reads: HashMap<String, Read>,
    mutation: Option<Mutation>,
    unconfirmed: Option<(String, Change)>,
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
            prefix: format!("tui-{client_id}-runs"),
            counter: 0,
            reads: HashMap::new(),
            mutation: None,
            unconfirmed: None,
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
            .find(|decision| decision.state == "pending")
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("{}-{}", self.prefix, self.counter)
    }

    fn workflow(
        &mut self,
        features: &Value,
        action: &str,
        arguments: Value,
    ) -> Result<(String, Value)> {
        let mut command = crate::workflow::tool(action, arguments)?;
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
        self.reads.retain(|_, pending| *pending != read);
        self.reads.insert(id, read);
        command
    }

    fn list(&mut self, features: &Value) -> Result<Value> {
        let pair = self.workflow(features, "list", json!({"offset":0}))?;
        Ok(self.read(Read::List, pair))
    }

    fn run_reads(&mut self, features: &Value, id: &str) -> Vec<Value> {
        let mut commands = Vec::new();
        if let Ok(pair) = self.workflow(features, "get", json!({"runId":id})) {
            commands.push(self.read(Read::Run(id.to_owned()), pair));
        }
        if let Ok(pair) = self.decisions(features, id, 0) {
            commands.push(self.read(Read::Decisions(id.to_owned(), 0), pair));
        }
        if let Ok(pair) = self.workflow(
            features,
            "inbox",
            json!({"request":{"action":"read","runId":id}}),
        ) {
            commands.push(self.read(Read::Inbox(id.to_owned()), pair));
        }
        if let Ok(pair) = self.workflow(features, "digest", json!({"runId":id})) {
            commands.push(self.read(Read::Digest(id.to_owned()), pair));
        }
        commands
    }

    fn decisions(&mut self, features: &Value, id: &str, offset: u64) -> Result<(String, Value)> {
        self.workflow(
            features,
            "decision",
            json!({"request":{"action":"list","runId":id,"offset":offset}}),
        )
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
        match change {
            Change::Pause { run, revision } => self.workflow(
                features,
                "control",
                json!({"request":{"action":"start","key":key,"runId":run,"expectedRevision":revision,"kind":"stop"}}),
            ),
            Change::Resume { run, revision } => self.workflow(
                features,
                "resume",
                json!({"key":key,"runId":run,"expectedRevision":revision}),
            ),
            Change::Drain { run, revision } => self.workflow(
                features,
                "drain",
                json!({"key":key,"runId":run,"expectedRevision":revision}),
            ),
            Change::Answer {
                run,
                decision,
                revision,
                answer,
            } => self.workflow(
                features,
                "decision",
                json!({"request":{"action":"answer","key":key,"runId":run,"decisionId":decision,"expectedRevision":revision,"answer":answer}}),
            ),
            Change::Start { directory, name } => {
                Self::templates_supported(features)?;
                let (mut command, _) =
                    template_command("start", directory, None, Some((name, key)))?;
                let id = self.next_id();
                command["requestId"] = id.clone().into();
                Ok((id, command))
            }
        }
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
        let request_id = event["requestId"].as_str()?;
        if let Some(read) = self.reads.remove(request_id) {
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
                self.runs = serde_json::from_value(event["runs"].clone()).unwrap_or_default();
                self.more = event["nextOffset"].is_u64();
                self.load = Load::Ready;
                let kept = self
                    .selected
                    .as_deref()
                    .is_none_or(|id| self.runs.iter().any(|run| run.id == id));
                if initial || !kept {
                    self.selected = self.runs.first().map(|run| run.id.clone());
                }
                self.reload_selected(features)
            }
            Read::Run(id) => {
                let detail = self.details.entry(id.clone()).or_default();
                detail.goal = event["run"]["goal"].as_str().unwrap_or_default().to_owned();
                detail.tasks = serde_json::from_value(event["tasks"].clone()).unwrap_or_default();
                if let Some(row) = self.runs.iter_mut().find(|run| run.id == id)
                    && let Ok(summary) = serde_json::from_value::<Summary>(event["run"].clone())
                {
                    *row = summary;
                }
                Effect::default()
            }
            Read::Decisions(id, offset) => {
                let page: Vec<Decision> =
                    serde_json::from_value(event["decisions"].clone()).unwrap_or_default();
                let detail = self.details.entry(id.clone()).or_default();
                if offset == 0 {
                    detail.decisions.clear();
                }
                detail.decisions.extend(
                    page.into_iter()
                        .filter(|decision| decision.state == "pending"),
                );
                let next = event["nextOffset"]
                    .as_u64()
                    .filter(|next| *next < DECISION_PAGES * 8);
                detail.decisions_loaded = next.is_none();
                match next.map(|next| (next, self.decisions(features, &id, next))) {
                    Some((next, Ok(pair))) => Effect {
                        commands: vec![self.read(Read::Decisions(id, next), pair)],
                        notice: None,
                    },
                    _ => {
                        if let Some(detail) = self.details.get_mut(&id) {
                            detail.decisions_loaded = true;
                        }
                        Effect::default()
                    }
                }
            }
            Read::Inbox(id) => {
                let detail = self.details.entry(id).or_default();
                detail.pending_messages = event["pendingCount"].as_u64().unwrap_or_default();
                detail.messages =
                    serde_json::from_value(event["messages"].clone()).unwrap_or_default();
                detail.inbox_loaded = true;
                Effect::default()
            }
            Read::Digest(id) => {
                self.details.entry(id).or_default().digest = Some(Digest::parse(&event["digest"]));
                Effect::default()
            }
            Read::Templates => {
                if let Some(templates) = &mut self.templates {
                    templates.load = Load::Ready;
                    templates.repository =
                        event["repository"].as_str().unwrap_or_default().to_owned();
                    templates.digest = event["digest"].as_str().map(str::to_owned);
                    templates.approved = event["approved"] == true;
                    templates.items =
                        serde_json::from_value(event["templates"].clone()).unwrap_or_default();
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
            Change::Answer { .. } => {
                self.answer = None;
                self.page = Page::Runs;
                "Answer recorded; it does not validate the task."
            }
            Change::Start { name, .. } => {
                self.page = Page::Runs;
                if let Some(id) = event["run"]["id"].as_str() {
                    self.selected = Some(id.to_owned());
                    self.details.remove(id);
                }
                return Effect {
                    commands: self.list(features).into_iter().collect(),
                    notice: Some(format!(
                        "Started template {name} as run {}.",
                        event["run"]["title"].as_str().unwrap_or(name)
                    )),
                };
            }
        };
        let mut effect = Effect::notice(notice);
        effect.commands.extend(self.list(features));
        effect
    }

    pub fn failure(&mut self, features: &Value, event: &Value) -> Option<Effect> {
        let request_id = event["requestId"].as_str()?;
        let message = event["message"]
            .as_str()
            .unwrap_or("Host rejected the request")
            .to_owned();
        if let Some(read) = self.reads.remove(request_id) {
            return Some(match read {
                Read::List => {
                    self.load = Load::Failed(message);
                    Effect::default()
                }
                Read::Templates => {
                    if let Some(templates) = &mut self.templates {
                        templates.load = Load::Failed(message);
                    }
                    Effect::default()
                }
                Read::Decisions(id, _) | Read::Inbox(id) | Read::Run(id) | Read::Digest(id) => {
                    let detail = self.details.entry(id).or_default();
                    detail.decisions_loaded = true;
                    detail.inbox_loaded = true;
                    Effect::default()
                }
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
        if event["code"] == "revision_conflict" {
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

    pub(crate) fn reply(runs: &mut Runs, command: &Value, mut body: Value) -> Effect {
        body["requestId"] = command["requestId"].clone();
        if body.get("type").is_none() {
            body["type"] = "workflow".into();
        }
        runs.response(&features(), &body).unwrap()
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
        assert!(detail.decisions_loaded && detail.inbox_loaded);
        assert!(Runs::open(1, &json!({})).is_err());
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
