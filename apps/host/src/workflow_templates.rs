use crate::{
    caller::Authority,
    event_log, git,
    orchestration::{Request, RunSpec, TaskSpec},
    process::display_path,
    protocol::Command,
    registry_files::{Registry, owner_only},
    sessions::{PtyEvent, State},
    workflow_budget::{self, Limits},
    workflow_executor::{self, Spec, TaskProfile},
    workflow_launches::Profile,
    worktrees::{self, CONFIG_FILE, Item, Parser, command_failure},
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{OwnedSemaphorePermit, mpsc};

const TEMPLATE_LIMIT: usize = 32;
const TASK_LIMIT: usize = 64;
const NAME_BYTES: usize = 64;
const TITLE_BYTES: usize = 80;
const TEXT_BYTES: usize = 8192;
const TOOL_LIMIT: usize = 32;
const KEY_BYTES: usize = 96;
const APPROVAL_LIMIT: usize = 256;
const STORE_LIMIT: u64 = 1024 * 1024;
const STORE_FILE: &str = "workflow-templates.json";
const MAX_ELAPSED_MS: u64 = 604_800_000;
pub(crate) const CHECK_LIMIT: usize = 8;
pub(crate) const CHECK_BYTES: usize = 256;
const BINDING_LIMIT: usize = 1024;

static STORE: OnceLock<Store> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Start {
    Draft,
    Active,
    Executor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Budget {
    pub(crate) max_parallel: u16,
    pub(crate) max_attempts_per_task: u16,
    pub(crate) max_elapsed_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Task {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) instruction: String,
    pub(crate) dependencies: Vec<String>,
    pub(crate) program: String,
    pub(crate) workspace: String,
    pub(crate) harness: Option<bool>,
    pub(crate) allowed_nesvo_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) checks: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Template {
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) start: Start,
    pub(crate) budget: Option<Budget>,
    pub(crate) tasks: Vec<Task>,
}

pub(crate) fn digest(templates: &[Template]) -> String {
    worktrees::canonical_digest(
        &json!({"version":1,"kind":"workflowTemplates","templates":templates}),
    )
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= NAME_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

fn tool_name(value: &str) -> bool {
    value.len() <= 128
        && value.strip_prefix("nesvo_").is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
}

#[derive(Default)]
struct TaskDraft {
    keys: HashSet<String>,
    key: Option<String>,
    title: Option<String>,
    instruction: Option<String>,
    dependencies: Vec<String>,
    program: Option<String>,
    workspace: Option<String>,
    harness: Option<bool>,
    allowed_nesvo_tools: Option<Vec<String>>,
    checks: Vec<String>,
}

#[derive(Default)]
struct TemplateDraft {
    keys: HashSet<String>,
    name: Option<String>,
    title: Option<String>,
    goal: Option<String>,
    start: Option<Start>,
    max_parallel: Option<u16>,
    max_attempts_per_task: Option<u16>,
    max_elapsed_ms: Option<u64>,
    tasks: Vec<TaskDraft>,
}

type Assigned = std::result::Result<(), String>;

fn bounded(
    key: &str,
    value: u64,
    range: std::ops::RangeInclusive<u64>,
) -> std::result::Result<u64, String> {
    if range.contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "{key} must be between {} and {}",
            range.start(),
            range.end()
        ))
    }
}

fn limit(key: &str, value: u64) -> std::result::Result<u16, String> {
    bounded(key, value, 1..=16).map(|value| value as u16)
}

impl TemplateDraft {
    fn assign(&mut self, key: &str, value: Item) -> Assigned {
        if !self.keys.insert(key.to_owned()) {
            return Err(format!("duplicate key {key}"));
        }
        match (key, value) {
            ("name", Item::Text(name)) if identifier(&name) => self.name = Some(name),
            ("name", Item::Text(_)) => {
                return Err(format!(
                    "name must be 1-{NAME_BYTES} ASCII letters, digits, '_' or '-'"
                ));
            }
            ("title", Item::Text(title)) if text(&title, TITLE_BYTES) => self.title = Some(title),
            ("title", Item::Text(_)) => {
                return Err(format!(
                    "title must be nonempty and at most {TITLE_BYTES} bytes"
                ));
            }
            ("goal", Item::Text(goal)) if text(&goal, TEXT_BYTES) => self.goal = Some(goal),
            ("goal", Item::Text(_)) => {
                return Err(format!(
                    "goal must be nonempty and at most {TEXT_BYTES} bytes"
                ));
            }
            ("start", Item::Text(start)) => {
                self.start = Some(match start.as_str() {
                    "draft" => Start::Draft,
                    "active" => Start::Active,
                    "executor" => Start::Executor,
                    _ => return Err("start must be draft, active or executor".into()),
                })
            }
            ("max_parallel", Item::Integer(value)) => self.max_parallel = Some(limit(key, value)?),
            ("max_attempts_per_task", Item::Integer(value)) => {
                self.max_attempts_per_task = Some(limit(key, value)?)
            }
            ("max_elapsed_ms", Item::Integer(value)) => {
                self.max_elapsed_ms = Some(bounded(key, value, 1000..=MAX_ELAPSED_MS)?)
            }
            (
                "name"
                | "title"
                | "goal"
                | "start"
                | "max_parallel"
                | "max_attempts_per_task"
                | "max_elapsed_ms",
                _,
            ) => return Err(format!("{key} has the wrong value type")),
            _ => return Err(format!("unsupported workflow key {key}")),
        }
        Ok(())
    }

    fn finish(self) -> Result<Template> {
        let name = self
            .name
            .ok_or_else(|| anyhow!("{CONFIG_FILE}: every [[workflow]] needs a name"))?;
        let fail = |message: String| anyhow!("{CONFIG_FILE} workflow {name}: {message}");
        let goal = self
            .goal
            .clone()
            .ok_or_else(|| fail("goal is required".into()))?;
        if self.tasks.is_empty() {
            return Err(fail("declare at least one [[workflow.task]]".into()));
        }
        let tasks = self
            .tasks
            .into_iter()
            .map(TaskDraft::finish)
            .collect::<std::result::Result<Vec<_>, String>>()
            .map_err(fail)?;
        validate_graph(&tasks).map_err(fail)?;
        let declared = self.max_parallel.is_some()
            || self.max_attempts_per_task.is_some()
            || self.max_elapsed_ms.is_some();
        let budget = declared.then(|| Budget {
            max_parallel: self.max_parallel.unwrap_or(8),
            max_attempts_per_task: self.max_attempts_per_task.unwrap_or(16),
            max_elapsed_ms: self.max_elapsed_ms,
        });
        Ok(Template {
            title: self.title.unwrap_or_else(|| name.clone()),
            name,
            goal,
            start: self.start.unwrap_or(Start::Draft),
            budget,
            tasks,
        })
    }
}

impl TaskDraft {
    fn assign(&mut self, key: &str, value: Item) -> Assigned {
        if !self.keys.insert(key.to_owned()) {
            return Err(format!("duplicate key {key}"));
        }
        match (key, value) {
            ("key", Item::Text(task)) if identifier(&task) => self.key = Some(task),
            ("key", Item::Text(_)) => {
                return Err(format!(
                    "task key must be 1-{NAME_BYTES} ASCII letters, digits, '_' or '-'"
                ));
            }
            ("title", Item::Text(title)) if text(&title, TITLE_BYTES) => self.title = Some(title),
            ("title", Item::Text(_)) => {
                return Err(format!(
                    "title must be nonempty and at most {TITLE_BYTES} bytes"
                ));
            }
            ("instruction", Item::Text(instruction)) if text(&instruction, TEXT_BYTES) => {
                self.instruction = Some(instruction)
            }
            ("instruction", Item::Text(_)) => {
                return Err(format!(
                    "instruction must be nonempty and at most {TEXT_BYTES} bytes"
                ));
            }
            ("depends_on", Item::List(keys)) => self.dependencies = keys,
            ("program", Item::Text(program))
                if matches!(program.as_str(), "claude" | "codex" | "gemini") =>
            {
                self.program = Some(program)
            }
            ("program", Item::Text(_)) => {
                return Err("program must be claude, codex or gemini".into());
            }
            ("workspace", Item::Text(workspace))
                if matches!(workspace.as_str(), "shared" | "worktree") =>
            {
                self.workspace = Some(workspace)
            }
            ("workspace", Item::Text(_)) => {
                return Err("workspace must be shared or worktree".into());
            }
            ("harness", Item::Flag(harness)) => self.harness = Some(harness),
            ("allowed_nesvo_tools", Item::List(tools)) => {
                let mut unique = HashSet::new();
                if tools.len() > TOOL_LIMIT
                    || !tools
                        .iter()
                        .all(|tool| tool_name(tool) && unique.insert(tool.clone()))
                {
                    return Err(format!(
                        "allowed_nesvo_tools must list at most {TOOL_LIMIT} unique exact nesvo_ tool names"
                    ));
                }
                self.allowed_nesvo_tools = Some(tools);
            }
            ("checks", Item::List(checks)) => {
                if checks.len() > CHECK_LIMIT
                    || !checks
                        .iter()
                        .all(|check| check.len() <= CHECK_BYTES && worktrees::valid_step(check))
                {
                    return Err(format!(
                        "checks must list at most {CHECK_LIMIT} nonempty single-line commands of at most {CHECK_BYTES} bytes"
                    ));
                }
                self.checks = checks;
            }
            (
                "key"
                | "title"
                | "instruction"
                | "depends_on"
                | "program"
                | "workspace"
                | "harness"
                | "allowed_nesvo_tools"
                | "checks",
                _,
            ) => return Err(format!("{key} has the wrong value type")),
            _ => return Err(format!("unsupported task key {key}")),
        }
        Ok(())
    }

    fn finish(self) -> std::result::Result<Task, String> {
        let key = self.key.ok_or("every task needs a key")?;
        let missing = |field: &str| format!("task {key} needs {field}");
        Ok(Task {
            title: self.title.unwrap_or_else(|| key.clone()),
            instruction: self.instruction.ok_or_else(|| missing("an instruction"))?,
            dependencies: self.dependencies,
            program: self.program.ok_or_else(|| missing("a program"))?,
            workspace: self.workspace.ok_or_else(|| missing("a workspace"))?,
            harness: self.harness,
            allowed_nesvo_tools: self.allowed_nesvo_tools,
            checks: self.checks,
            key,
        })
    }
}

fn validate_graph(tasks: &[Task]) -> std::result::Result<(), String> {
    let mut keys = HashSet::new();
    for task in tasks {
        if !keys.insert(task.key.as_str()) {
            return Err(format!("duplicate task key {}", task.key));
        }
    }
    for task in tasks {
        let mut seen = HashSet::new();
        for dependency in &task.dependencies {
            if dependency == &task.key
                || !keys.contains(dependency.as_str())
                || !seen.insert(dependency)
            {
                return Err(format!(
                    "task {} depends on a missing, duplicate or self key {dependency}",
                    task.key
                ));
            }
        }
    }
    let mut remaining: HashMap<&str, usize> = tasks
        .iter()
        .map(|task| (task.key.as_str(), task.dependencies.len()))
        .collect();
    let mut ready: Vec<&str> = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(key, _)| *key)
        .collect();
    let mut ordered = 0;
    while let Some(done) = ready.pop() {
        ordered += 1;
        for task in tasks
            .iter()
            .filter(|task| task.dependencies.iter().any(|d| d == done))
        {
            if let Some(count) = remaining.get_mut(task.key.as_str()) {
                *count -= 1;
                if *count == 0 {
                    ready.push(task.key.as_str());
                }
            }
        }
    }
    if ordered != tasks.len() {
        return Err("task dependencies form a cycle".into());
    }
    Ok(())
}

enum Section {
    Outside,
    Other,
    Workflow,
    Task,
}

pub(crate) fn parse(text: &str) -> Result<Vec<Template>> {
    let mut parser = Parser::document(text)?;
    let mut drafts: Vec<TemplateDraft> = Vec::new();
    let mut section = Section::Outside;
    loop {
        parser.trivia()?;
        if parser.peek().is_none() {
            break;
        }
        let line = parser.line();
        let fail = |message: String| anyhow!("{CONFIG_FILE} line {line}: {message}");
        if parser.peek() == Some('[') {
            let (array, name) = parser.header()?;
            section = match (array, name.as_str()) {
                (true, "workflow") if drafts.len() < TEMPLATE_LIMIT => {
                    drafts.push(TemplateDraft::default());
                    Section::Workflow
                }
                (true, "workflow") => {
                    return Err(fail(format!(
                        "at most {TEMPLATE_LIMIT} [[workflow]] entries are supported"
                    )));
                }
                (true, "workflow.task") => {
                    let draft = drafts.last_mut().ok_or_else(|| {
                        fail("[[workflow.task]] must follow a [[workflow]] entry".into())
                    })?;
                    if draft.tasks.len() == TASK_LIMIT {
                        return Err(fail(format!(
                            "a workflow declares at most {TASK_LIMIT} tasks"
                        )));
                    }
                    draft.tasks.push(TaskDraft::default());
                    Section::Task
                }
                (false, "worktree") | (true, "mcp.server") => Section::Other,
                _ => return Err(fail(format!("unsupported table {name}"))),
            };
            continue;
        }
        let (key, value) = parser.entry()?;
        let assigned = match section {
            Section::Outside => Err("keys must be inside a table".to_owned()),
            Section::Other => Ok(()),
            Section::Workflow => drafts
                .last_mut()
                .map_or(Ok(()), |draft| draft.assign(key, value)),
            Section::Task => drafts
                .last_mut()
                .and_then(|draft| draft.tasks.last_mut())
                .map_or(Ok(()), |task| task.assign(key, value)),
        };
        assigned.map_err(fail)?;
    }
    let templates = drafts
        .into_iter()
        .map(TemplateDraft::finish)
        .collect::<Result<Vec<_>>>()?;
    let mut names = HashSet::new();
    if let Some(template) = templates.iter().find(|t| !names.insert(t.name.as_str())) {
        return Err(anyhow!(
            "{CONFIG_FILE}: workflow name {} is declared twice",
            template.name
        ));
    }
    Ok(templates)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Approval {
    repository: String,
    digest: String,
    approved_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskChecks {
    pub(crate) key: String,
    pub(crate) commands: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunChecks {
    pub(crate) run_id: String,
    pub(crate) repository: String,
    pub(crate) template: String,
    pub(crate) digest: String,
    pub(crate) tasks: Vec<TaskChecks>,
    pub(crate) bound_at: u64,
}

impl RunChecks {
    pub(crate) fn commands(&self, task_key: &str) -> &[String] {
        self.tasks
            .iter()
            .find(|task| task.key == task_key)
            .map_or(&[], |task| task.commands.as_slice())
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    approvals: Vec<Approval>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runs: Vec<RunChecks>,
}

pub(crate) struct Store {
    registry: Registry<Document>,
}

impl Store {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
        Ok(Self {
            registry: Registry::open(
                directory,
                STORE_FILE,
                "Workflow template approval registry",
                STORE_LIMIT,
                || Document {
                    version: 1,
                    ..Document::default()
                },
                |document| document.version == 1,
            )?,
        })
    }

    fn update<T>(&self, change: impl FnOnce(&mut Document) -> T) -> Result<T> {
        self.registry.update(|document| Ok(change(document)))
    }

    pub(crate) fn approved(&self, repository: &str, digest: &str) -> bool {
        self.registry
            .read(|document| {
                document
                    .approvals
                    .iter()
                    .any(|approval| approval.repository == repository && approval.digest == digest)
            })
            .unwrap_or(false)
    }

    fn approve(&self, repository: &str, digest: &str) -> Result<u64> {
        self.update(|document| {
            if let Some(existing) = document
                .approvals
                .iter()
                .find(|approval| approval.repository == repository && approval.digest == digest)
            {
                return existing.approved_at;
            }
            let approved_at = crate::status::now_millis();
            document.approvals.push(Approval {
                repository: repository.into(),
                digest: digest.into(),
                approved_at,
            });
            let excess = document.approvals.len().saturating_sub(APPROVAL_LIMIT);
            document.approvals.drain(..excess);
            approved_at
        })
    }

    fn revoke(&self, repository: &str, digest: &str) -> Result<bool> {
        self.update(|document| {
            let before = document.approvals.len();
            document
                .approvals
                .retain(|approval| approval.repository != repository || approval.digest != digest);
            document.approvals.len() != before
        })
    }

    pub(crate) fn bind(&self, binding: RunChecks) -> Result<()> {
        if self.binding(&binding.run_id).is_some_and(|existing| {
            existing.repository == binding.repository
                && existing.template == binding.template
                && existing.digest == binding.digest
                && existing.tasks == binding.tasks
        }) {
            return Ok(());
        }
        self.update(|document| {
            document.runs.retain(|run| run.run_id != binding.run_id);
            document.runs.push(binding);
            let excess = document.runs.len().saturating_sub(BINDING_LIMIT);
            document.runs.drain(..excess);
        })
    }

    pub(crate) fn binding(&self, run_id: &str) -> Option<RunChecks> {
        self.registry
            .read(|document| {
                document
                    .runs
                    .iter()
                    .find(|run| run.run_id == run_id)
                    .cloned()
            })
            .ok()
            .flatten()
    }
}

pub fn available() -> bool {
    STORE.get().is_some()
}

pub(crate) fn store() -> Option<&'static Store> {
    STORE.get()
}

pub(crate) fn run_checks(
    source: &Source,
    template: &Template,
    digest: &str,
    run_id: &str,
) -> Option<RunChecks> {
    let tasks: Vec<TaskChecks> = template
        .tasks
        .iter()
        .filter(|task| !task.checks.is_empty())
        .map(|task| TaskChecks {
            key: task.key.clone(),
            commands: task.checks.clone(),
        })
        .collect();
    (!tasks.is_empty()).then(|| RunChecks {
        run_id: run_id.into(),
        repository: source.repository.clone(),
        template: template.name.clone(),
        digest: digest.into(),
        tasks,
        bound_at: crate::status::now_millis(),
    })
}

pub fn configure(directory: &Path) -> Result<()> {
    STORE
        .set(Store::open(directory)?)
        .map_err(|_| anyhow!("Workflow template approvals are already configured"))
}

pub(crate) struct Source {
    pub(crate) root: PathBuf,
    pub(crate) repository: String,
    pub(crate) templates: Vec<Template>,
}

impl Source {
    pub(crate) fn digest(&self) -> Option<String> {
        (!self.templates.is_empty()).then(|| digest(&self.templates))
    }
}

pub(crate) async fn inspect(directory: &str) -> Result<Source> {
    let root = git::toplevel(&worktrees::host_directory(directory)?)
        .await
        .map_err(|_| {
            command_failure(
                "invalid_argument",
                "The folder is not inside a Git repository",
            )
        })?;
    let templates = worktrees::head_text(&root)
        .await
        .and_then(|text| text.as_deref().map(parse).transpose())
        .map_err(|error| command_failure("workflow_templates_invalid", error.to_string()))?
        .unwrap_or_default();
    Ok(Source {
        repository: worktrees::repository_key(&root),
        root,
        templates,
    })
}

pub(crate) fn describe(store: &Store, source: &Source) -> Value {
    let digest = source.digest();
    let approved = digest
        .as_deref()
        .is_some_and(|digest| store.approved(&source.repository, digest));
    json!({"type":"workflowTemplates","repository":source.repository,"source":format!("HEAD:{CONFIG_FILE}"),"configured":digest.is_some(),"digest":digest,"approved":approved,"templates":source.templates})
}

fn observe(
    log: Option<&event_log::Service>,
    kind: fn(event_log::model::RepositoryDigest) -> event_log::DomainEvent,
    repository: &str,
    digest: &str,
) {
    if let Some(log) = log {
        log.observe(event_log::Observation {
            session_id: None,
            at: crate::status::now_millis(),
            event: kind(event_log::model::RepositoryDigest {
                repository: repository.into(),
                digest: digest.into(),
            }),
        });
    }
}

pub(crate) fn approve(
    store: &Store,
    log: Option<&event_log::Service>,
    source: &Source,
    digest: &str,
) -> Result<Value> {
    worktrees::valid_digest(digest)?;
    let current = source.digest().ok_or_else(|| {
        command_failure(
            "workflow_templates_missing",
            format!("HEAD:{CONFIG_FILE} declares no [[workflow]] entries"),
        )
    })?;
    if current != digest.to_ascii_lowercase() {
        return Err(command_failure(
            "digest_mismatch",
            format!(
                "The committed workflow templates changed; inspect them again (current digest {current})"
            ),
        ));
    }
    let approved_at = store.approve(&source.repository, &current)?;
    observe(
        log,
        event_log::DomainEvent::WorkflowTemplatesApproved,
        &source.repository,
        &current,
    );
    Ok(
        json!({"type":"workflowTemplatesApproved","repository":source.repository,"digest":current,"approvedAt":approved_at}),
    )
}

pub(crate) fn revoke(
    store: &Store,
    log: Option<&event_log::Service>,
    repository: &str,
    digest: &str,
) -> Result<Value> {
    worktrees::valid_digest(digest)?;
    let digest = digest.to_ascii_lowercase();
    let revoked = store.revoke(repository, &digest)?;
    if revoked {
        observe(
            log,
            event_log::DomainEvent::WorkflowTemplatesRevoked,
            repository,
            &digest,
        );
    }
    Ok(
        json!({"type":"workflowTemplatesRevoked","repository":repository,"digest":digest,"revoked":revoked}),
    )
}

async fn revoke_in(
    store: &Store,
    log: Option<&event_log::Service>,
    directory: &str,
    digest: &str,
) -> Result<Value> {
    let root = git::toplevel(&worktrees::host_directory(directory)?)
        .await
        .map_err(|_| {
            command_failure(
                "invalid_argument",
                "The folder is not inside a Git repository",
            )
        })?;
    revoke(store, log, &worktrees::repository_key(&root), digest)
}

pub(crate) type Step = Pin<Box<dyn Future<Output = Result<Value>> + Send>>;

fn revision(reply: &Value) -> Result<u64> {
    reply["run"]["revision"]
        .as_u64()
        .ok_or_else(|| anyhow!("Workflow reply has no run revision"))
}

fn valid_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > KEY_BYTES || key.chars().any(char::is_control) {
        return Err(command_failure(
            "invalid_argument",
            format!("Use a start key of 1-{KEY_BYTES} bytes without control characters"),
        ));
    }
    Ok(())
}

fn profile(task: &Task, cwd: &str) -> Result<Profile> {
    Ok(serde_json::from_value(json!({
        "name":null,"cwd":cwd,"program":task.program,"workspace":task.workspace,
        "harness":task.harness,"allowedNesvoTools":task.allowed_nesvo_tools
    }))?)
}

pub(crate) fn selected<'a>(
    store: &Store,
    source: &'a Source,
    name: &str,
) -> Result<(&'a Template, String)> {
    let digest = source.digest().ok_or_else(|| {
        command_failure(
            "workflow_templates_missing",
            format!("HEAD:{CONFIG_FILE} declares no [[workflow]] entries"),
        )
    })?;
    if !store.approved(&source.repository, &digest) {
        return Err(command_failure(
            "workflow_templates_unapproved",
            format!(
                "Workflow templates of {} are not approved; inspect them with nesvo workflow templates and approve digest {digest}",
                source.repository
            ),
        ));
    }
    let template = source
        .templates
        .iter()
        .find(|template| template.name == name)
        .ok_or_else(|| {
            command_failure(
                "workflow_template_not_found",
                format!("No approved workflow template is named {name}"),
            )
        })?;
    Ok((template, digest))
}

pub(crate) async fn start_with(
    execute: impl Fn(Request) -> Step,
    source: &Source,
    template: &Template,
    digest: &str,
    key: &str,
) -> Result<Value> {
    valid_key(key)?;
    let step = |name: &str| format!("{key}/{name}");
    let created = execute(Request::Create {
        key: step("create"),
        spec: RunSpec {
            title: template.title.clone(),
            goal: template.goal.clone(),
            coordinator_session_id: None,
        },
    })
    .await?;
    let run_id = created["run"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Workflow reply has no run identity"))?
        .to_owned();
    let planned = execute(Request::SetPlan {
        key: step("plan"),
        run_id: run_id.clone(),
        expected_revision: revision(&created)?,
        tasks: template
            .tasks
            .iter()
            .map(|task| TaskSpec {
                key: task.key.clone(),
                title: task.title.clone(),
                instruction: task.instruction.clone(),
                dependencies: task.dependencies.clone(),
            })
            .collect(),
    })
    .await?;
    let mut current = revision(&planned)?;
    let ids: HashMap<&str, &str> = planned["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|task| Some((task["key"].as_str()?, task["id"].as_str()?)))
        .collect();
    let cwd = display_path(&source.root);
    let profiles = template
        .tasks
        .iter()
        .map(|task| {
            let id = ids
                .get(task.key.as_str())
                .ok_or_else(|| anyhow!("Workflow plan reply omitted task {}", task.key))?;
            Ok(TaskProfile {
                task_id: (*id).to_owned(),
                profile: profile(task, &cwd)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if let Some(budget) = &template.budget {
        let reply = execute(Request::RunBudget {
            request: workflow_budget::Request::Set {
                key: step("budget"),
                run_id: run_id.clone(),
                expected_revision: current,
                limits: Limits {
                    max_parallel: budget.max_parallel,
                    max_attempts_per_task: budget.max_attempts_per_task,
                    max_elapsed_ms: budget.max_elapsed_ms,
                },
            },
        })
        .await?;
        current = revision(&reply)?;
    }
    if template.start != Start::Draft {
        let reply = execute(Request::Activate {
            key: step("activate"),
            run_id: run_id.clone(),
            expected_revision: current,
        })
        .await?;
        current = revision(&reply)?;
    }
    let executor = if template.start == Start::Executor {
        Some(
            execute(Request::Executor {
                request: workflow_executor::Request::Start {
                    key: step("executor"),
                    run_id: run_id.clone(),
                    expected_revision: current,
                    spec: Spec {
                        tasks: profiles.clone(),
                        retry_failed: false,
                        retry_delay_ms: 1000,
                        readiness_timeout_ms: 60_000,
                    },
                },
            })
            .await?,
        )
    } else {
        None
    };
    let view = execute(Request::Get { run_id }).await?;
    Ok(json!({
        "type":"workflowTemplateStarted","template":template.name,"digest":digest,"key":key,
        "start":template.start,"run":view["run"],"tasks":view["tasks"],
        "profiles":serde_json::to_value(&profiles)?,"executor":executor.map(|reply| reply.get("executor").cloned().unwrap_or(reply))
    }))
}

pub(crate) fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::ListWorkflowTemplates { .. }
            | Command::ApproveWorkflowTemplates { .. }
            | Command::RevokeWorkflowTemplates { .. }
            | Command::StartWorkflowTemplate { .. }
    )
}

fn error_event(error: &anyhow::Error) -> Value {
    json!({"type":"error","code":worktrees::error_code(error).unwrap_or("workflow_templates_unavailable"),"message":error.to_string()})
}

pub(crate) fn admit(authority: &Authority) -> Result<()> {
    owner_only(authority, |_| {
        command_failure(
            "forbidden",
            "Workflow templates require owner authority; approval is a human act through the owner CLI",
        )
    })
}

async fn start(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    client: u64,
    store: &Store,
    directory: &str,
    name: &str,
    key: &str,
) -> Result<Value> {
    let source = inspect(directory).await?;
    let (template, digest) = selected(store, &source, name)?;
    let (log, actor) = {
        let state = state
            .lock()
            .map_err(|_| anyhow!("Host state is unavailable"))?;
        let mut probe = Request::List { offset: None };
        (
            state.event_log()?,
            state.workflow_actor(client, &mut probe)?,
        )
    };
    let execute = move |request: Request| -> Step {
        let (state, events, log, actor) =
            (state.clone(), events.clone(), log.clone(), actor.clone());
        Box::pin(async move {
            match request {
                Request::Executor { request } => {
                    crate::workflow_executor_runtime::execute(
                        state,
                        events,
                        log,
                        actor,
                        Authority::Owner,
                        request,
                    )
                    .await
                }
                request => log.workflow(actor, request).await,
            }
        })
    };
    let started = start_with(execute, &source, template, &digest, key).await?;
    if let Some(binding) = started["run"]["id"]
        .as_str()
        .and_then(|run_id| run_checks(&source, template, &digest, run_id))
    {
        store.bind(binding)?;
    }
    Ok(started)
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    client: u64,
    authority: Authority,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let log = state.lock().ok().and_then(|state| state.event_log().ok());
    let result = match (admit(&authority), STORE.get(), permit) {
        (Err(error), _, _) => Err(error),
        (Ok(()), _, None) => Err(command_failure("busy", "Workflow template service is busy")),
        (Ok(()), None, _) => Err(command_failure(
            "unsupported",
            "The host workflow template registry is unavailable",
        )),
        (Ok(()), Some(store), Some(_permit)) => match command {
            Command::ListWorkflowTemplates { directory } => inspect(&directory)
                .await
                .map(|source| describe(store, &source)),
            Command::ApproveWorkflowTemplates { directory, digest } => {
                match inspect(&directory).await {
                    Ok(source) => approve(store, log.as_ref(), &source, &digest),
                    Err(error) => Err(error),
                }
            }
            Command::RevokeWorkflowTemplates { directory, digest } => {
                revoke_in(store, log.as_ref(), &directory, &digest).await
            }
            Command::StartWorkflowTemplate {
                directory,
                name,
                key,
            } => {
                start(
                    state.clone(),
                    events,
                    client,
                    store,
                    &directory,
                    &name,
                    &key,
                )
                .await
            }
            _ => Err(command_failure(
                "invalid_argument",
                "Unsupported workflow template command",
            )),
        },
    };
    let mut event = result.unwrap_or_else(|error| error_event(&error));
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

#[cfg(test)]
#[path = "workflow_templates_tests.rs"]
mod tests;
