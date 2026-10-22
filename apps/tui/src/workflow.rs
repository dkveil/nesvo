use crate::{cli, network::Connection};
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum Command {
    /// Owner-only replacement of a lost coordinator; never adopts native work.
    BindCoordinator {
        id: String,
        #[arg(long, required_unless_present = "unbound", conflicts_with = "unbound")]
        from: Option<String>,
        #[arg(long, required_unless_present = "from", conflicts_with = "from")]
        unbound: bool,
        #[arg(long)]
        session: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Preserve owner-written constraints and explicitly acknowledge their revision.
    Constraints {
        #[command(subcommand)]
        command: crate::workflow_constraints::Command,
    },
    /// Capture immutable metadata or read current context, without replaying effects.
    Checkpoint {
        #[command(subcommand)]
        command: crate::workflow_checkpoints::Command,
    },
    /// Configure delta-only host notifications to a managed coordinator.
    Wake {
        #[command(subcommand)]
        command: crate::workflow_wakes::Command,
    },
    /// Configure and inspect explicit automatic DAG scheduling on the host.
    Executor {
        #[command(subcommand)]
        command: crate::workflow_executor::Command,
    },
    /// Queue the current task instruction once; host waits for safe readiness.
    Deliver(crate::workflow_delivery::Deliver),
    /// Cancel a queued instruction before its native input claim. Never interrupts.
    CancelDelivery(crate::workflow_delivery::Cancel),
    /// Reserve a dependency-ready task and start its worker once. Sends no prompt.
    Launch(crate::workflow_launches::Launch),
    /// Stop only run-bound workers with durable native receipts. Inspect control.
    Stop(crate::workflow_controls::Start),
    /// Cancel planned work and stop run-bound workers. Never overrides a human.
    Cancel(crate::workflow_controls::Start),
    /// Inspect a bounded page of native run-control outcomes. Never dispatches.
    Control {
        id: String,
        control: String,
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Inspect or replace this run's parallel, retry and elapsed budgets.
    Budget {
        #[command(subcommand)]
        command: crate::workflow_budget::Command,
    },
    /// Block new task assignments while current attempts finish. Does not kill.
    Drain {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Reopen a drained/stopped run without resetting history or its elapsed clock.
    Resume {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Owner admission policy, shared with the top-level budget command.
    #[command(hide = true)]
    HostBudget {
        #[command(subcommand)]
        command: crate::budgets::Command,
    },
    /// Ask, inspect and resolve attempt-bound questions without native approval.
    Decision {
        #[command(subcommand)]
        command: crate::workflow_decisions::Command,
    },
    /// Stop on a blocker: records a decision with one acknowledge option for this worker's attempt.
    Blocked(Blocked),
    /// Stop and ask instead of guessing: records a decision for this worker's attempt.
    Ask(Ask),
    /// Durable addressed messages. ACK is receipt, never task execution.
    Inbox {
        #[command(subcommand)]
        command: crate::workflow_inbox::Command,
    },
    /// Create a draft run once for this key. Does not start an agent.
    Create {
        title: String,
        #[arg(long)]
        key: String,
        #[arg(
            long,
            required_unless_present = "goal_file",
            conflicts_with = "goal_file"
        )]
        goal: Option<String>,
        #[arg(long)]
        goal_file: Option<PathBuf>,
        #[arg(long)]
        coordinator: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List one bounded page of visible runs.
    List {
        #[arg(long, default_value_t=0, value_parser=clap::value_parser!(u16).range(0..=1024))]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Read a run and its current plan by stable run ID.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Read the bounded digest of a run: final once settled, otherwise live working state.
    Digest {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Replace a draft DAG from a JSON array; stable task keys retain their IDs.
    Plan {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Recover a plan mutation by the original key, without creating processes.
    Mutation {
        #[arg(long)]
        key: String,
        #[arg(long)]
        json: bool,
    },
    /// Freeze a nonempty draft; no native process is started.
    Activate {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Assign one existing controlled worker to a dependency-ready task.
    Assign {
        id: String,
        #[arg(long)]
        task: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Inspect a task and a bounded page of immutable attempt history.
    Task {
        id: String,
        task: String,
        #[arg(long, default_value_t = 0)]
        offset: u16,
        #[arg(long)]
        json: bool,
    },
    /// Read this authenticated worker's exact task/attempt binding.
    Context {
        #[arg(long)]
        json: bool,
    },
    #[command(hide = true)]
    RecoverHook,
    /// Read current authenticated recovery context; never resumes native effects.
    Recover {
        run_id: Option<String>,
        #[arg(long)]
        offset: Option<u16>,
        #[arg(long)]
        expected_digest: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Report this worker's result from a bounded JSON file; never self-validates.
    Report {
        attempt: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Record explicit coordinator/owner validation of a worker result.
    Validate {
        id: String,
        attempt: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        host_checks: bool,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::BindCoordinator { json, .. } => *json,
            Self::RecoverHook => false,
            Self::Constraints { command } => command.machine(),
            Self::Checkpoint { command } => command.machine(),
            Self::Executor { command } => command.machine(),
            Self::Wake { command } => command.machine(),
            Self::Deliver(args) => args.json,
            Self::CancelDelivery(args) => args.json,
            Self::Launch(launch) => launch.json,
            Self::Stop(start) | Self::Cancel(start) => start.json,
            Self::Control { json, .. } => *json,
            Self::Budget { command } => command.machine(),
            Self::Drain { json, .. } | Self::Resume { json, .. } => *json,
            Self::Decision { command } => command.machine(),
            Self::Blocked(args) => args.json,
            Self::Ask(args) => args.json,
            Self::HostBudget { command } => command.machine(),
            Self::Inbox { command } => command.machine(),
            Self::Create { json, .. }
            | Self::List { json, .. }
            | Self::Get { json, .. }
            | Self::Digest { json, .. }
            | Self::Plan { json, .. }
            | Self::Mutation { json, .. }
            | Self::Activate { json, .. }
            | Self::Assign { json, .. }
            | Self::Task { json, .. }
            | Self::Context { json }
            | Self::Recover { json, .. }
            | Self::Report { json, .. }
            | Self::Validate { json, .. } => *json,
        }
    }
    fn request(self) -> Result<Request> {
        Ok(match self {
            Self::BindCoordinator {
                id,
                from,
                session,
                key,
                revision,
                ..
            } => Request::Coordinator {
                request: CoordinatorRequest {
                    key,
                    run_id: id,
                    expected_revision: revision,
                    expected_coordinator_session_id: from,
                    coordinator_session_id: session,
                },
            },
            Self::Constraints { command } => Request::Constraints {
                request: command.request()?,
            },
            Self::Checkpoint { command } => Request::Checkpoints {
                request: command.request()?,
            },
            Self::Wake { command } => Request::Wakes {
                request: command.request(),
            },
            Self::Executor { command } => Request::Executor {
                request: command.request()?,
            },
            Self::Deliver(args) => Request::Delivery {
                request: args.request(),
            },
            Self::CancelDelivery(args) => Request::Delivery {
                request: args.request(),
            },
            Self::Launch(launch) => Request::Launch {
                request: launch.request(),
            },
            Self::Stop(start) => Request::Control {
                request: start.request(crate::workflow_controls::Kind::Stop),
            },
            Self::Cancel(start) => Request::Control {
                request: start.request(crate::workflow_controls::Kind::Cancel),
            },
            Self::Control {
                id,
                control,
                offset,
                ..
            } => Request::Control {
                request: crate::workflow_controls::Request::Get {
                    run_id: id,
                    control_id: control,
                    offset: Some(offset),
                },
            },
            Self::Budget { command } => Request::RunBudget {
                request: command.request()?,
            },
            Self::Drain {
                id, key, revision, ..
            } => Request::Drain {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Resume {
                id, key, revision, ..
            } => Request::Resume {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::HostBudget { command } => Request::HostBudget {
                request: command.request()?,
            },
            Self::Decision { command } => Request::Decision {
                request: command.request()?,
            },
            Self::Blocked(_) | Self::Ask(_) => {
                return Err(cli::failure(
                    "invalid_argument",
                    "Blocked and ask resolve the worker attempt before dispatch",
                ));
            }
            Self::Inbox { command } => Request::Inbox {
                request: command.request()?,
            },
            Self::Create {
                title,
                key,
                goal,
                goal_file,
                coordinator,
                ..
            } => {
                let goal = match goal_file {
                    Some(path) => read_file(&path, 8192)?,
                    None => goal.ok_or_else(|| {
                        cli::failure("invalid_argument", "A goal or goal file is required")
                    })?,
                };
                Request::Create {
                    key,
                    spec: RunSpec {
                        title,
                        goal,
                        coordinator_session_id: coordinator,
                    },
                }
            }
            Self::List { offset, .. } => Request::List {
                offset: Some(offset),
            },
            Self::Get { id, .. } => Request::Get { run_id: id },
            Self::Digest { id, .. } => Request::Digest { run_id: id },
            Self::Plan {
                id,
                key,
                revision,
                file,
                ..
            } => Request::SetPlan {
                key,
                run_id: id,
                expected_revision: revision,
                tasks: serde_json::from_str(&read_file(&file, 24 * 1024)?).map_err(|_| {
                    cli::failure(
                        "invalid_argument",
                        "Plan file must be a JSON array of task specifications",
                    )
                })?,
            },
            Self::Mutation { key, .. } => Request::Mutation { key },
            Self::Activate {
                id, key, revision, ..
            } => Request::Activate {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Assign {
                id,
                task,
                session,
                key,
                revision,
                ..
            } => Request::Assign {
                key,
                run_id: id,
                task_id: task,
                session_id: session,
                expected_revision: revision,
            },
            Self::Task {
                id, task, offset, ..
            } => Request::Task {
                run_id: id,
                task_id: task,
                offset: Some(offset),
            },
            Self::Context { .. } => Request::Context {},
            Self::RecoverHook => {
                return Err(cli::failure(
                    "invalid_argument",
                    "Provider hook uses its own adapter entrypoint",
                ));
            }
            Self::Recover {
                run_id,
                offset,
                expected_digest,
                ..
            } => Request::Recover {
                run_id,
                offset,
                expected_digest,
            },
            Self::Report {
                attempt, key, file, ..
            } => Request::Report {
                key,
                attempt_id: attempt,
                result: read_json(&file, 4096)?,
            },
            Self::Validate {
                id,
                attempt,
                key,
                revision,
                file,
                host_checks,
                ..
            } => Request::Validate {
                key,
                run_id: id,
                attempt_id: attempt,
                expected_revision: revision,
                validation: read_json(&file, 2048)?,
                host_checks,
            },
        })
    }
}
fn read_json<T: serde::de::DeserializeOwned>(path: &std::path::Path, limit: usize) -> Result<T> {
    serde_json::from_str(&read_file(path, limit)?).map_err(|_| {
        cli::failure(
            "invalid_argument",
            "Workflow JSON must match its declared schema",
        )
    })
}
pub(crate) fn read_file(path: &std::path::Path, limit: usize) -> Result<String> {
    cli::read_text_input(path, limit)
}

const DECISION_TEXT_LIMIT: usize = 2048;
const OPTION_LIMIT: usize = 8;
const OPTION_TEXT_LIMIT: usize = 64;
const ACKNOWLEDGE_OPTION: &str = "acknowledge";

#[derive(clap::Args)]
pub struct Blocked {
    #[arg(long)]
    run: String,
    #[arg(long)]
    key: String,
    #[arg(long, required_unless_present = "file", conflicts_with = "file")]
    reason: Option<String>,
    #[arg(long)]
    file: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "owner")]
    audience: crate::workflow_decisions::Audience,
    #[arg(long, default_value_t = 86_400_000, value_parser = clap::value_parser!(u64).range(1000..=604_800_000))]
    timeout_ms: u64,
    #[arg(long)]
    json: bool,
}

#[derive(clap::Args)]
pub struct Ask {
    #[arg(long)]
    run: String,
    #[arg(long)]
    key: String,
    #[arg(long, required_unless_present = "file", conflicts_with = "file")]
    question: Option<String>,
    #[arg(long)]
    file: Option<PathBuf>,
    #[arg(long, value_delimiter = ',')]
    options: Vec<String>,
    #[arg(long, value_enum, default_value = "owner")]
    audience: crate::workflow_decisions::Audience,
    #[arg(long, default_value_t = 300_000, value_parser = clap::value_parser!(u64).range(1000..=604_800_000))]
    timeout_ms: u64,
    #[arg(long)]
    json: bool,
}

pub(crate) struct WorkerSignal {
    kind: &'static str,
    run_id: String,
    key: String,
    audience: crate::workflow_decisions::Audience,
    question: String,
    options: Vec<String>,
    timeout_ms: u64,
}

fn literal_or_file(literal: Option<String>, file: Option<PathBuf>) -> Result<String> {
    match (literal, file) {
        (Some(text), None) => Ok(text),
        (None, Some(path)) => read_file(&path, DECISION_TEXT_LIMIT),
        _ => Err(cli::failure(
            "invalid_argument",
            "Pass exactly one inline text or --file PATH (- reads stdin)",
        )),
    }
}

fn valid_options(options: Vec<String>) -> Result<Vec<String>> {
    let options: Vec<String> = options.into_iter().map(|o| o.trim().to_owned()).collect();
    let invalid = options.len() > OPTION_LIMIT
        || options.iter().enumerate().any(|(index, option)| {
            option.is_empty()
                || option.len() > OPTION_TEXT_LIMIT
                || option.chars().any(char::is_control)
                || options[..index].contains(option)
        });
    if invalid {
        return Err(cli::failure(
            "invalid_argument",
            "Options must be 1-8 distinct nonempty labels of at most 64 bytes",
        ));
    }
    Ok(options)
}

fn signal_text(heading: Option<&str>, body: &str, options: &[String]) -> Result<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(cli::failure(
            "invalid_argument",
            "Blocked reason or question must be nonempty",
        ));
    }
    let mut text = match heading {
        Some(heading) => format!("{heading}: {body}"),
        None => body.to_owned(),
    };
    if !options.is_empty() {
        text.push_str("\n\nOptions: ");
        text.push_str(&options.join(", "));
    }
    if text.len() > DECISION_TEXT_LIMIT {
        return Err(cli::failure(
            "input_too_large",
            "Question with its options exceeds the 2048-byte host limit",
        ));
    }
    Ok(text)
}

impl Blocked {
    pub(crate) fn signal(self) -> Result<WorkerSignal> {
        let options = vec![ACKNOWLEDGE_OPTION.to_owned()];
        let reason = literal_or_file(self.reason, self.file)?;
        Ok(WorkerSignal {
            kind: "blocked",
            question: signal_text(Some("Blocked"), &reason, &options)?,
            run_id: self.run,
            key: self.key,
            audience: self.audience,
            options,
            timeout_ms: self.timeout_ms,
        })
    }
}

impl Ask {
    pub(crate) fn signal(self) -> Result<WorkerSignal> {
        let options = valid_options(self.options)?;
        let question = literal_or_file(self.question, self.file)?;
        Ok(WorkerSignal {
            kind: "question",
            question: signal_text(None, &question, &options)?,
            run_id: self.run,
            key: self.key,
            audience: self.audience,
            options,
            timeout_ms: self.timeout_ms,
        })
    }
}

impl WorkerSignal {
    pub(crate) fn request(&self, context: &Value) -> Result<Value> {
        match context["run"]["id"].as_str() {
            None => {
                return Err(cli::failure(
                    "run_binding_required",
                    "This caller is not bound to a run; only an assigned worker can stop or ask",
                ));
            }
            Some(run) if run != self.run_id => {
                return Err(cli::failure(
                    "run_binding_changed",
                    "This worker is bound to another run; read run context before asking",
                ));
            }
            Some(_) => {}
        }
        let attempt = context["attempt"]["id"].as_str().ok_or_else(|| {
            cli::failure(
                "attempt_not_found",
                "This worker has no assigned attempt to stop on",
            )
        })?;
        wire(Request::Decision {
            request: crate::workflow_decisions::Request::Ask {
                key: self.key.clone(),
                attempt_id: attempt.to_owned(),
                audience: self.audience.clone(),
                question: self.question.clone(),
                timeout_ms: self.timeout_ms,
            },
        })
    }
    pub(crate) fn receipt(&self, mut response: Value) -> Value {
        response["signal"] = json!({"kind":self.kind,"options":self.options});
        response
    }
}

async fn signal(signal: WorkerSignal, machine: bool, connection: &mut Connection) -> Result<()> {
    let caps = cli::request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    let context_request = wire(Request::Context {})?;
    supported(&caps, &context_request)?;
    let context = cli::request(connection, context_request, "workflow").await?;
    let request = signal.request(&context)?;
    supported(&caps, &request)?;
    let response = cli::request(connection, request, "workflow").await?;
    cli::print_data(machine, signal.receipt(response))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Succeeded,
    Failed,
    Blocked,
    Canceled,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CheckOutcome {
    Passed,
    Failed,
    Skipped,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Check {
    name: String,
    outcome: CheckOutcome,
    details: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultSpec {
    outcome: Outcome,
    summary: String,
    files: Vec<String>,
    artifacts: Vec<String>,
    checks: Vec<Check>,
    limitations: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    next_steps: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidationSpec {
    passed: bool,
    summary: String,
    checks: Vec<Check>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoordinatorRequest {
    key: String,
    run_id: String,
    expected_revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    expected_coordinator_session_id: Option<String>,
    coordinator_session_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunSpec {
    title: String,
    goal: String,
    coordinator_session_id: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskSpec {
    key: String,
    title: String,
    instruction: String,
    #[serde(default)]
    dependencies: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Jobs {
        request: Box<crate::job_commands::Request>,
    },
    Coordinator {
        request: CoordinatorRequest,
    },
    Constraints {
        request: crate::workflow_constraints::Request,
    },
    Checkpoints {
        request: crate::workflow_checkpoints::Request,
    },
    Wakes {
        request: crate::workflow_wakes::Request,
    },
    Executor {
        request: crate::workflow_executor::Request,
    },
    Delivery {
        request: crate::workflow_delivery::Request,
    },
    Launch {
        request: crate::workflow_launches::Request,
    },
    Control {
        request: crate::workflow_controls::Request,
    },
    RunBudget {
        request: crate::workflow_budget::Request,
    },
    Drain {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Resume {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    HostBudget {
        request: crate::budgets::Request,
    },
    Decision {
        request: crate::workflow_decisions::Request,
    },
    Inbox {
        request: crate::workflow_inbox::Request,
    },
    Create {
        key: String,
        spec: RunSpec,
    },
    List {
        offset: Option<u16>,
    },
    Get {
        run_id: String,
    },
    Digest {
        run_id: String,
    },
    Mutation {
        key: String,
    },
    SetPlan {
        key: String,
        run_id: String,
        expected_revision: u64,
        tasks: Vec<TaskSpec>,
    },
    Activate {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Assign {
        key: String,
        run_id: String,
        task_id: String,
        session_id: String,
        expected_revision: u64,
    },
    Task {
        run_id: String,
        task_id: String,
        offset: Option<u16>,
    },
    Context {},
    Recover {
        run_id: Option<String>,
        offset: Option<u16>,
        expected_digest: Option<String>,
    },
    Report {
        key: String,
        attempt_id: String,
        result: ResultSpec,
    },
    Validate {
        key: String,
        run_id: String,
        attempt_id: String,
        expected_revision: u64,
        validation: ValidationSpec,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        host_checks: bool,
    },
}
fn wire(request: Request) -> Result<Value> {
    let value = serde_json::to_value(request)?;
    if serde_json::to_vec(&value)?.len() > 24 * 1024 {
        return Err(cli::failure(
            "invalid_argument",
            "Workflow request exceeds 24 KiB",
        ));
    }
    let request = json!({"type":"workflow","request":value});
    if task_profile_requested(&request, |profile| {
        profile.get("claudeQuotaCapture").is_some_and(|capture| {
            !crate::workflow_launches::valid_capture(capture, &profile["program"])
        })
    }) {
        return Err(cli::failure(
            "invalid_argument",
            "Claude quota capture requires Claude and an absolute host display-profile path",
        ));
    }
    Ok(request)
}
pub fn tool(action: &str, mut arguments: Value) -> Result<Value> {
    let object = arguments
        .as_object_mut()
        .ok_or_else(|| cli::failure("invalid_argument", "Workflow tool needs an object"))?;
    if object.contains_key("action") {
        return Err(cli::failure(
            "invalid_argument",
            "Workflow action is selected by the tool name",
        ));
    }
    object.insert("action".into(), action.into());
    wire(serde_json::from_value(arguments).map_err(|_| {
        cli::failure(
            "invalid_argument",
            "Workflow fields must match the tool schema",
        )
    })?)
}
fn model_profile_requested(request: &Value) -> bool {
    task_profile_requested(request, |profile: &Value| {
        profile.get("model").is_some() || profile.get("effort").is_some()
    })
}
fn capture_supported(caps: &Value, request: &Value) -> bool {
    !task_profile_requested(request, |profile| {
        profile.get("claudeQuotaCapture").is_some()
    }) || caps["claudeQuotaCapture"] == true
}
fn task_profile_requested(request: &Value, selected: impl Fn(&Value) -> bool) -> bool {
    let action = &request["request"];
    match action["action"].as_str() {
        Some("launch") => selected(&action["request"]["profile"]),
        Some("jobs") => selected(&action["request"]["spec"]["profile"]),
        Some("executor") => action["request"]["spec"]["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.iter().any(|task| selected(&task["profile"]))),
        _ => false,
    }
}
fn job_calendar_supported(caps: &Value, request: &Value) -> bool {
    if request["request"]["action"] != "jobs" {
        return true;
    }
    let Some(kind) = request["request"]["request"]["spec"]["schedule"]["kind"].as_str() else {
        return true;
    };
    kind == "once"
        || caps["jobScheduleKinds"]
            .as_array()
            .is_some_and(|kinds| kinds.iter().any(|k| k == kind))
}
fn job_external_supported(caps: &Value, request: &Value) -> bool {
    let job = &request["request"]["request"];
    if request["request"]["action"] != "jobs"
        || (job["action"] != "triggers" && job["spec"]["schedule"]["kind"] != "external")
    {
        return true;
    }
    if caps["jobExternalTriggers"] != true {
        return false;
    }
    let Some(providers) = caps["jobTriggerProviders"].as_array() else {
        return false;
    };
    if providers.is_empty() || !providers.iter().all(Value::is_string) {
        return false;
    }
    match job["request"]["spec"]["adapter"]["kind"].as_str() {
        Some(provider) => providers.iter().any(|value| value == provider),
        None => providers
            .iter()
            .any(|value| value == "webhook" || value == "github"),
    }
}
fn job_precheck_requested(request: &Value) -> bool {
    let action = &request["request"];
    action["action"] == "jobs"
        && (matches!(
            action["request"]["action"].as_str(),
            Some("prechecks" | "abandonPrecheck")
        ) || action["request"]["spec"].get("precheckId").is_some())
}
fn job_precheck_generations_supported(caps: &Value, request: &Value) -> bool {
    let action = &request["request"];
    if action["action"] != "jobs" {
        return true;
    }
    let job = &action["request"];
    let requested = match job["action"].as_str() {
        Some("create" | "update") => {
            job["spec"].get("retry").is_some() && job["spec"].get("precheckId").is_some()
        }
        Some("abandonPrecheck") => job.get("jobAttemptId").is_some(),
        _ => false,
    };
    !requested || caps["jobPrecheckGenerations"] == true
}
fn job_cancellation_supported(caps: &Value, request: &Value) -> bool {
    request["request"]["action"] != "jobs"
        || request["request"]["request"]["action"] != "cancelOccurrence"
        || caps["jobCancellation"] == true
}
fn job_launch_reconciliation_supported(caps: &Value, request: &Value) -> bool {
    request["request"]["action"] != "jobs"
        || request["request"]["request"]["action"] != "abandonLaunchNoEffect"
        || caps["jobLaunchReconciliation"] == true
}
pub(crate) fn job_quota_supported(caps: &Value, request: &Value) -> bool {
    let job = &request["request"]["request"];
    request["request"]["action"] != "jobs"
        || (job["action"] != "authorizeQuota" && job["spec"].get("quotaPolicy").is_none())
        || caps["jobQuotaAdmission"] == true
}
fn job_attempts_supported(caps: &Value, request: &Value) -> bool {
    request["request"]["action"] != "jobs"
        || !matches!(
            request["request"]["request"]["action"].as_str(),
            Some("attempts" | "attempt")
        )
        || caps["jobAttempts"] == true
}
fn job_retry_supported(caps: &Value, request: &Value) -> bool {
    let action = &request["request"];
    if action["action"] != "jobs"
        || !matches!(
            action["request"]["action"].as_str(),
            Some("create" | "update")
        )
    {
        return true;
    }
    let Some(retry) = action["request"]["spec"].get("retry") else {
        return true;
    };
    caps["jobRetries"] == true
        && caps["jobRetryKinds"].as_array().is_some_and(|kinds| {
            kinds.iter().all(Value::is_string) && kinds.iter().any(|kind| kind == &retry["on"])
        })
}
fn job_execution_timeout_supported(caps: &Value, request: &Value) -> bool {
    let action = &request["request"];
    action["action"] != "jobs"
        || !matches!(
            action["request"]["action"].as_str(),
            Some("create" | "update")
        )
        || action["request"]["spec"]
            .get("executionTimeoutMs")
            .is_none()
        || caps["jobExecutionTimeouts"] == true
}
pub async fn capability(connection: &mut Connection, request: &Value) -> Result<()> {
    let caps = cli::request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    supported(&caps, request)
}
pub(crate) fn supported(caps: &Value, request: &Value) -> Result<()> {
    if request["request"]["action"] == "hostBudget" {
        return if caps["hostBudgets"] == true {
            Ok(())
        } else {
            Err(cli::failure(
                "unsupported",
                "Host does not support persisted admission budgets; update nesvo-host",
            ))
        };
    }
    if caps["workflowPlans"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host does not support durable workflow plans; update nesvo-host",
        ));
    }
    if !matches!(
        request["request"]["action"].as_str(),
        Some("create" | "list" | "get" | "setPlan" | "mutation")
    ) && caps["workflowAttempts"] != true
    {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce workflow attempts and result grants; update nesvo-host",
        ));
    }
    if request["request"]["action"] == "inbox" && caps["workflowInbox"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host does not support durable inbox/ACK; update nesvo-host",
        ));
    }
    if request["request"]["hostChecks"] == true && caps["workflowHostChecks"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host cannot run attempt-bound host checks; update nesvo-host",
        ));
    }
    if request["request"]["action"] == "decision" && caps["workflowDecisions"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host does not support attempt-bound decisions; update nesvo-host",
        ));
    }
    let capability = match request["request"]["action"].as_str() {
        Some("coordinator") => Some("runCoordinatorRecovery"),
        Some("jobs") => Some("durableJobs"),
        Some("recover") => Some("runRecovery"),
        Some("checkpoints") => Some("runCheckpoints"),
        Some("constraints") => Some("runConstraints"),
        Some("digest") => Some("runDigests"),
        Some("launch") => Some("runLaunch"),
        Some("delivery") => Some("runDelivery"),
        Some("executor") => Some("runExecutor"),
        Some("wakes") => Some("runWakes"),
        Some("control") => Some("runControls"),
        Some("runBudget") => Some("runBudgets"),
        Some("drain" | "resume") => Some("runDrain"),
        _ => None,
    };
    if !job_calendar_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host does not support this job calendar; update nesvo-host",
        ));
    }
    if job_precheck_requested(request) && caps["jobPrechecks"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce owner-approved bounded prechecks; update nesvo-host",
        ));
    }
    if !job_precheck_generations_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce fresh prechecks for job generations; update nesvo-host",
        ));
    }
    if !job_cancellation_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce occurrence cancellation and cleanup; update nesvo-host",
        ));
    }
    if !job_launch_reconciliation_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot reconcile exact no-effect job launches; update nesvo-host",
        ));
    }
    if !job_quota_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce job quota admission or reauthorization; update nesvo-host",
        ));
    }
    if !job_attempts_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host does not support retained job attempt history; update nesvo-host",
        ));
    }
    if !job_retry_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce this job retry policy; update nesvo-host",
        ));
    }
    if !job_external_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot authorize this external job or trigger provider; update nesvo-host",
        ));
    }
    if !job_execution_timeout_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot enforce job execution timeouts; update nesvo-host",
        ));
    }
    if model_profile_requested(request) && caps["sessionModelProfiles"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host lacks launch-local model profile support; update nesvo-host",
        ));
    }
    if !capture_supported(caps, request) {
        return Err(cli::failure(
            "unsupported",
            "Host cannot configure explicit Claude quota capture; update nesvo-host",
        ));
    }
    if task_profile_requested(request, |p| p.get("allowedNesvoTools").is_some())
        && caps["taskNativeToolProfiles"] != true
    {
        return Err(cli::failure(
            "unsupported",
            "Host lacks task-local native tool profiles; update nesvo-host",
        ));
    }
    if request["request"]["action"] == "wakes"
        && matches!(
            request["request"]["request"]["action"].as_str(),
            Some("pause" | "resume" | "setDelivery")
        )
        && caps["runWakeDelivery"] != true
    {
        return Err(cli::failure(
            "unsupported",
            "Host cannot hold wakes or change their delivery; update nesvo-host",
        ));
    }
    if capability.is_some_and(|key| caps[key] != true) {
        return Err(cli::failure(
            "unsupported",
            "Host lacks the required workflow capability; update nesvo-host",
        ));
    }
    Ok(())
}

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let command = match command {
        Command::Blocked(args) => return signal(args.signal()?, machine, connection).await,
        Command::Ask(args) => return signal(args.signal()?, machine, connection).await,
        command => command,
    };
    let request = wire(command.request()?)?;
    capability(connection, &request).await?;
    cli::print_data(
        machine,
        cli::request(connection, request, "workflow").await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_null_is_rejected_before_profile_normalization() {
        for capture in [
            None,
            Some(Value::Null),
            Some(json!({"displayProfile":"/owner/display.json"})),
        ] {
            let mut profile = json!({"program":"claude","workspace":"shared"});
            if let Some(value) = &capture {
                profile["claudeQuotaCapture"] = value.clone();
            }
            let mut requests = vec![
                (
                    "launch",
                    json!({"request":{"key":"launch","runId":"r","taskId":"t","expectedRevision":1,"profile":profile}}),
                ),
                (
                    "executor",
                    json!({"request":{"action":"start","key":"executor","runId":"r","expectedRevision":1,"spec":{"tasks":[{"taskId":"t","profile":profile}]}}}),
                ),
            ];
            for action in ["create", "update"] {
                let mut job = json!({"action":action,"key":"job","spec":{"title":"Declared display","instruction":"Report result","profile":profile,"schedule":{"kind":"external"}}});
                if action == "update" {
                    job["jobId"] = json!("j");
                    job["expectedRevision"] = json!(1);
                }
                requests.push(("jobs", json!({"request":job})));
            }
            for (action, arguments) in requests {
                let result = tool(action, arguments);
                if capture.as_ref().is_some_and(Value::is_null) {
                    assert!(
                        result.is_err(),
                        "{action} must reject explicit capture null"
                    );
                } else {
                    let request = result.unwrap();
                    assert!(task_profile_requested(&request, |profile| {
                        profile.get("claudeQuotaCapture") == capture.as_ref()
                    }));
                    assert_eq!(capture_supported(&json!({}), &request), capture.is_none());
                }
            }
        }
    }
    #[test]
    fn declared_claude_capture_crosses_all_profiles_and_requires_exact_capability() {
        let profile = json!({"program":"claude","workspace":"shared","claudeQuotaCapture":{"displayProfile":"/owner/display.json"}});
        let launch=tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":profile}})).unwrap();
        let executor=tool("executor",json!({"request":{"action":"start","key":"e","runId":"r","expectedRevision":1,"spec":{"tasks":[{"taskId":"t","profile":profile}]}}})).unwrap();
        let jobs=tool("jobs",json!({"request":{"action":"create","key":"j","spec":{"title":"Explicit display","instruction":"Report result","profile":profile,"schedule":{"kind":"external"}}}})).unwrap();
        for request in [&launch, &executor, &jobs] {
            assert!(!capture_supported(&json!({}), request));
            assert!(!capture_supported(
                &json!({"claudeQuotaCapture":"true"}),
                request
            ));
            assert!(capture_supported(
                &json!({"claudeQuotaCapture":true}),
                request
            ));
        }
        let mut invalid = profile;
        invalid["program"] = json!("codex");
        assert!(tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":invalid}})).is_err());
        let legacy=tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":{"program":"claude","workspace":"shared"}}})).unwrap();
        assert!(capture_supported(&json!({}), &legacy));
        assert!(
            legacy["request"]["request"]["profile"]
                .get("claudeQuotaCapture")
                .is_none()
        );
    }
    #[test]
    fn external_jobs_and_trigger_actions_require_typed_scoped_support() {
        let external = tool("jobs",json!({"request":{"action":"create","key":"external","spec":{"title":"Triggered checks","instruction":"report-task","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"external"}}}})).unwrap();
        let list = tool(
            "jobs",
            json!({"request":{"action":"triggers","request":{"action":"list"}}}),
        )
        .unwrap();
        for bad in [
            json!({}),
            json!({"jobExternalTriggers":"true","jobTriggerProviders":["webhook"]}),
            json!({"jobExternalTriggers":true}),
            json!({"jobExternalTriggers":true,"jobTriggerProviders":"webhook"}),
            json!({"jobExternalTriggers":true,"jobTriggerProviders":[true]}),
            json!({"jobExternalTriggers":true,"jobTriggerProviders":["unknown"]}),
        ] {
            assert!(!job_external_supported(&bad, &external));
            assert!(!job_external_supported(&bad, &list));
        }
        let caps = json!({"jobExternalTriggers":true,"jobTriggerProviders":["webhook","github"],"jobScheduleKinds":["once","external"]});
        assert!(job_external_supported(&caps, &external));
        assert!(job_external_supported(&caps, &list));
        assert!(job_calendar_supported(&caps, &external));
        assert!(!job_calendar_supported(
            &json!({"jobScheduleKinds":["once"]}),
            &external
        ));
        let old = tool("jobs", json!({"request":{"action":"list"}})).unwrap();
        assert!(job_external_supported(&json!({}), &old));
    }
    #[test]
    fn launch_reconciliation_requires_strict_support_only_for_its_owner_action() {
        let request = tool(
            "jobs",
            json!({"request":{"action":"abandonLaunchNoEffect","key":"abandon","jobId":"j","occurrenceId":"o","jobAttemptId":"generation","expectedDigest":"a".repeat(64),"acknowledgeUnknownEffects":true}}),
        )
        .unwrap();
        for caps in [
            json!({}),
            json!({"jobExecutionTimeouts":true,"jobCancellation":true,"jobAttempts":true}),
            json!({"jobLaunchReconciliation":false}),
            json!({"jobLaunchReconciliation":null}),
            json!({"jobLaunchReconciliation":"true"}),
            json!({"jobLaunchReconciliation":1}),
            json!({"jobLaunchReconciliation":[]}),
            json!({"jobLaunchReconciliation":{}}),
        ] {
            assert!(!job_launch_reconciliation_supported(&caps, &request));
        }
        assert!(job_launch_reconciliation_supported(
            &json!({"jobLaunchReconciliation":true}),
            &request
        ));
        assert!(!job_precheck_requested(&request));
        assert!(job_precheck_generations_supported(&json!({}), &request));
        for fields in [
            json!({"action":"abandonPrecheck","key":"legacy","jobId":"j","occurrenceId":"o","expectedDigest":"a".repeat(64),"acknowledgeUnknownEffects":true}),
            json!({"action":"cancelOccurrence","key":"cancel","jobId":"j","occurrenceId":"o"}),
            json!({"action":"occurrence","jobId":"j","occurrenceId":"o"}),
            json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"generation"}),
        ] {
            let legacy = tool("jobs", json!({"request":fields})).unwrap();
            assert!(job_launch_reconciliation_supported(&json!({}), &legacy));
        }
        assert!(job_launch_reconciliation_supported(
            &json!({}),
            &json!({"request":{"action":"get","runId":"run"}})
        ));
    }
    #[test]
    fn job_execution_timeout_requires_typed_support_only_for_effective_create_or_update_intent() {
        for action in ["create", "update"] {
            let mut fields = json!({"action":action,"key":"timeout","spec":{"title":"Bounded job","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}}});
            if action == "update" {
                fields["jobId"] = json!("j");
                fields["expectedRevision"] = json!(1);
            }
            let legacy = tool("jobs", json!({"request":fields.clone()})).unwrap();
            assert!(
                legacy["request"]["request"]["spec"]
                    .get("executionTimeoutMs")
                    .is_none()
            );
            assert!(job_execution_timeout_supported(&json!({}), &legacy));
            fields["spec"]["executionTimeoutMs"] = Value::Null;
            let normalized = tool("jobs", json!({"request":fields.clone()})).unwrap();
            assert_eq!(normalized, legacy);
            assert!(job_execution_timeout_supported(&json!({}), &normalized));
            fields["spec"]["executionTimeoutMs"] = json!(1_000);
            let bounded = tool("jobs", json!({"request":fields})).unwrap();
            for caps in [
                json!({}),
                json!({"durableJobs":true,"jobCancellation":true,"jobAttempts":true}),
                json!({"jobExecutionTimeouts":false}),
                json!({"jobExecutionTimeouts":"true"}),
                json!({"jobExecutionTimeouts":1}),
                json!({"jobExecutionTimeouts":null}),
                json!({"jobExecutionTimeouts":[]}),
                json!({"jobExecutionTimeouts":{}}),
            ] {
                assert!(!job_execution_timeout_supported(&caps, &bounded));
            }
            assert!(job_execution_timeout_supported(
                &json!({"jobExecutionTimeouts":true}),
                &bounded
            ));
        }
        for fields in [
            json!({"action":"list"}),
            json!({"action":"get","jobId":"j"}),
            json!({"action":"runNow","key":"run","jobId":"j","expectedRevision":1}),
            json!({"action":"cancelOccurrence","key":"cancel","jobId":"j","occurrenceId":"o"}),
            json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"a"}),
        ] {
            assert!(job_execution_timeout_supported(
                &json!({}),
                &tool("jobs", json!({"request":fields})).unwrap()
            ));
        }
        assert!(job_execution_timeout_supported(
            &json!({}),
            &tool("context", json!({})).unwrap()
        ));
    }
    #[test]
    fn repeated_prechecks_require_explicit_typed_generation_support() {
        for action in ["create", "update"] {
            let mut fields = json!({"action":action,"key":"retry","spec":{"title":"Retry","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}}});
            if action == "update" {
                fields["jobId"] = json!("j");
                fields["expectedRevision"] = json!(1);
            }
            for (retry, precheck) in [(false, false), (true, false), (false, true), (true, true)] {
                let mut fields = fields.clone();
                if retry {
                    fields["spec"]["retry"] = json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
                }
                if precheck {
                    fields["spec"]["precheckId"] = json!("01234567890123456789012345678901");
                }
                let request = tool("jobs", json!({"request":fields})).unwrap();
                assert_eq!(job_precheck_requested(&request), precheck);
                assert_eq!(job_retry_supported(&json!({}), &request), !retry);
                let caps = json!({"jobPrechecks":true,"jobRetries":true,"jobRetryKinds":["launchNoEffect"]});
                assert!(job_retry_supported(&caps, &request));
                assert_eq!(
                    job_precheck_generations_supported(&caps, &request),
                    !(retry && precheck)
                );
                for value in [
                    json!(false),
                    json!("true"),
                    json!(1),
                    Value::Null,
                    json!([]),
                    json!({}),
                ] {
                    let mut caps = caps.clone();
                    caps["jobPrecheckGenerations"] = value;
                    assert_eq!(
                        job_precheck_generations_supported(&caps, &request),
                        !(retry && precheck)
                    );
                }
                assert!(job_precheck_generations_supported(
                    &json!({"jobPrecheckGenerations":true}),
                    &request
                ));
                if retry && precheck {
                    assert!(!job_retry_supported(
                        &json!({"jobPrecheckGenerations":true,"jobPrechecks":true}),
                        &request
                    ));
                }
            }
        }
    }
    #[test]
    fn exact_precheck_abandonment_requires_generation_support_but_legacy_omission_does_not() {
        let fields = json!({"action":"abandonPrecheck","key":"abandon","jobId":"j","occurrenceId":"o","expectedDigest":"d","acknowledgeUnknownEffects":true});
        let legacy = tool("jobs", json!({"request":fields.clone()})).unwrap();
        assert_eq!(legacy["request"]["request"], fields);
        assert!(job_precheck_requested(&legacy));
        assert!(job_precheck_generations_supported(&json!({}), &legacy));
        let mut fields = fields;
        fields["jobAttemptId"] = json!("generation-2");
        let exact = tool("jobs", json!({"request":fields})).unwrap();
        assert!(job_precheck_requested(&exact));
        assert!(job_retry_supported(&json!({}), &exact));
        for caps in [
            json!({}),
            json!({"jobAttempts":true,"jobPrechecks":true,"jobRetries":true}),
            json!({"jobPrecheckGenerations":false}),
            json!({"jobPrecheckGenerations":"true"}),
            json!({"jobPrecheckGenerations":1}),
            json!({"jobPrecheckGenerations":null}),
        ] {
            assert!(!job_precheck_generations_supported(&caps, &exact));
        }
        assert!(job_precheck_generations_supported(
            &json!({"jobPrecheckGenerations":true}),
            &exact
        ));
        for fields in [
            json!({"action":"list"}),
            json!({"action":"runNow","key":"run","jobId":"j","expectedRevision":1}),
            json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"a"}),
        ] {
            assert!(job_precheck_generations_supported(
                &json!({}),
                &tool("jobs", json!({"request":fields})).unwrap()
            ));
        }
    }
    #[test]
    fn retry_policy_requires_explicit_typed_host_support_only_when_serialized() {
        for action in ["create", "update"] {
            let mut fields = json!({"action":action,"key":"retry","spec":{"title":"Retry","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}}});
            if action == "update" {
                fields["jobId"] = json!("j");
                fields["expectedRevision"] = json!(1);
            }
            let legacy = tool("jobs", json!({"request":fields.clone()})).unwrap();
            assert!(legacy["request"]["request"]["spec"].get("retry").is_none());
            assert!(job_retry_supported(&json!({}), &legacy));
            fields["spec"]["retry"] = json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
            let retry = tool("jobs", json!({"request":fields})).unwrap();
            for caps in [
                json!({}),
                json!({"durableJobs":true,"jobAttempts":true}),
                json!({"jobRetries":true}),
                json!({"jobRetryKinds":["launchNoEffect"]}),
                json!({"jobRetries":false,"jobRetryKinds":["launchNoEffect"]}),
                json!({"jobRetries":"true","jobRetryKinds":["launchNoEffect"]}),
                json!({"jobRetries":true,"jobRetryKinds":"launchNoEffect"}),
                json!({"jobRetries":true,"jobRetryKinds":["unknown"]}),
                json!({"jobRetries":true,"jobRetryKinds":["launchNoEffect",true]}),
            ] {
                assert!(!job_retry_supported(&caps, &retry));
            }
            assert!(job_retry_supported(
                &json!({"jobRetries":true,"jobRetryKinds":["launchNoEffect"]}),
                &retry
            ));
        }
        for fields in [
            json!({"action":"list"}),
            json!({"action":"get","jobId":"j"}),
            json!({"action":"runNow","key":"run","jobId":"j","expectedRevision":1}),
            json!({"action":"attempts","jobId":"j","occurrenceId":"o"}),
        ] {
            assert!(job_retry_supported(
                &json!({}),
                &tool("jobs", json!({"request":fields})).unwrap()
            ));
        }
    }
    #[test]
    fn job_attempt_reads_require_their_own_host_capability() {
        for fields in [
            json!({"action":"attempts","jobId":"j","occurrenceId":"o"}),
            json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"a"}),
        ] {
            let request = tool("jobs", json!({"request":fields})).unwrap();
            for caps in [
                json!({}),
                json!({"durableJobs":true,"workflowAttempts":true,"jobCancellation":true}),
                json!({"jobAttempts":false}),
                json!({"jobAttempts":"true"}),
            ] {
                assert!(!job_attempts_supported(&caps, &request));
            }
            assert!(job_attempts_supported(
                &json!({"jobAttempts":true}),
                &request
            ));
        }
        assert!(job_attempts_supported(
            &json!({}),
            &tool(
                "jobs",
                json!({"request":{"action":"occurrence","jobId":"j","occurrenceId":"o"}})
            )
            .unwrap()
        ));
    }
    #[test]
    fn occurrence_cancellation_requires_its_own_host_capability() {
        let cancel = tool(
            "jobs",
            json!({"request":{"action":"cancelOccurrence","key":"cancel-once","jobId":"j","occurrenceId":"o"}}),
        )
        .unwrap();
        for caps in [
            json!({}),
            json!({"durableJobs":true,"jobPrechecks":true,"runControls":true}),
            json!({"jobCancellation":false}),
            json!({"jobCancellation":"true"}),
        ] {
            assert!(!job_cancellation_supported(&caps, &cancel));
        }
        assert!(job_cancellation_supported(
            &json!({"jobCancellation":true}),
            &cancel
        ));
        assert!(job_cancellation_supported(
            &json!({}),
            &tool("jobs", json!({"request":{"action":"list"}})).unwrap()
        ));
    }
    #[test]
    fn command_approval_and_checked_jobs_require_their_own_host_capability() {
        let command = tool(
            "jobs",
            json!({"request":{"action":"prechecks","request":{"action":"list"}}}),
        )
        .unwrap();
        assert!(job_precheck_requested(&command));
        assert!(!job_precheck_requested(
            &tool("jobs", json!({"request":{"action":"list"}})).unwrap()
        ));
        let checked=tool("jobs",json!({"request":{"action":"create","key":"checked","spec":{"title":"x","instruction":"x","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},"precheckId":"01234567890123456789012345678901"}}})).unwrap();
        assert!(job_precheck_requested(&checked));
    }
    #[test]
    fn recurrence_requires_its_own_capability_and_preserves_legacy_once_requests() {
        let request = |schedule: Value| {
            tool("jobs",json!({"request":{"action":"create","key":"calendar","spec":{"title":"Calendar","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":schedule}}})).unwrap()
        };
        let cron = request(json!({"kind":"cron","expression":"0 9 * * *"}));
        assert!(!job_calendar_supported(&json!({"durableJobs":true}), &cron));
        assert!(!job_calendar_supported(
            &json!({"jobScheduleKinds":["once"]}),
            &cron
        ));
        assert!(job_calendar_supported(
            &json!({"jobScheduleKinds":["once","cron","rrule"]}),
            &cron
        ));
        let once = request(json!({"kind":"once","at":"2026-12-01T00:00:00Z"}));
        assert!(job_calendar_supported(&json!({"durableJobs":true}), &once));
        assert!(job_calendar_supported(
            &json!({}),
            &tool("jobs", json!({"request":{"action":"list"}})).unwrap()
        ));
    }
    #[test]
    fn task_native_tool_profiles_preserve_empty_selection_and_require_their_own_capability() {
        let selected =
            json!({"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":[]});
        let launch = tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":selected}})).unwrap();
        assert_eq!(
            launch["request"]["request"]["profile"]["allowedNesvoTools"],
            json!([])
        );
        assert!(task_profile_requested(&launch, |p| p
            .get("allowedNesvoTools")
            .is_some()));
        assert!(!model_profile_requested(&launch));
        let executor = tool("executor",json!({"request":{"action":"start","key":"e","runId":"r","expectedRevision":1,"spec":{"tasks":[{"taskId":"t","profile":selected}]}}})).unwrap();
        assert!(task_profile_requested(&executor, |p| p
            .get("allowedNesvoTools")
            .is_some()));
        assert!(!task_profile_requested(
            &tool("executor", json!({"request":{"action":"get","runId":"r"}})).unwrap(),
            |p| p.get("allowedNesvoTools").is_some()
        ));
    }
    #[test]
    fn encoded_model_profiles_gate_native_capability_and_preserve_legacy_intent() {
        let plain = json!({"program":"claude","workspace":"shared","harness":true});
        let launch = |profile: Value| {
            tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":profile}})).unwrap()
        };
        let legacy = launch(plain.clone());
        assert!(!model_profile_requested(&legacy));
        assert!(
            legacy["request"]["request"]["profile"]
                .get("model")
                .is_none()
        );
        assert!(
            legacy["request"]["request"]["profile"]
                .get("effort")
                .is_none()
        );
        let mut selected = plain;
        selected["model"] = "opus".into();
        selected["effort"] = "low".into();
        assert!(model_profile_requested(&launch(selected.clone())));
        let executor=tool("executor",json!({"request":{"action":"start","key":"e","runId":"r","expectedRevision":1,"spec":{"tasks":[{"taskId":"t","profile":selected}]}}})).unwrap();
        assert!(model_profile_requested(&executor));
        assert!(!model_profile_requested(
            &tool("executor", json!({"request":{"action":"get","runId":"r"}})).unwrap()
        ));
    }
    #[test]
    fn adapters_reject_malformed_shapes_before_host_dispatch() {
        for extra in [
            json!({"prompt":"foreign instruction"}),
            json!({"sessionId":7}),
            json!({"session":"worker"}),
            json!({"owner":true}),
        ] {
            let mut request =
                json!({"action":"queue","key":"k","runId":"r","taskId":"t","expectedRevision":1});
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(tool("delivery", json!({"request":request})).is_err());
        }
        assert!(tool("delivery",json!({"request":{"action":"queue","key":"k","runId":"r","taskId":"t","expectedRevision":1,"sessionId":"worker"}})).is_ok());
        for profile in [
            json!({"program":"claude"}),
            json!({"program":"unsupported","workspace":"shared"}),
            json!({"program":"claude","workspace":"shared","role":"coordinator"}),
            json!({"program":"claude","workspace":"shared","prompt":"type before admission"}),
        ] {
            assert!(tool("launch",json!({"request":{"key":"k","runId":"r","taskId":"t","expectedRevision":1,"profile":profile}})).is_err());
        }
        assert!(tool("context", json!({"sessionId":"foreign"})).is_err());
        assert!(
            tool(
                "report",
                json!({"key":"k","attemptId":"a","result":{"outcome":"succeeded","summary":"x"}})
            )
            .is_err()
        );
        assert!(tool("setPlan",json!({"key":"k","runId":"r","expectedRevision":1,"tasks":[{"key":"a","title":"a","instruction":"x","dependencies":false}]})).is_err());
        assert!(
            tool(
                "create",
                json!({"action":"list","key":"k","spec":{"title":"a","goal":"b"}})
            )
            .is_err()
        );
        assert!(
            tool(
                "create",
                json!({"key":"k","spec":{"title":"a","goal":"b","owner":true}})
            )
            .is_err()
        );
        assert_eq!(
            tool("list", json!({})).unwrap()["request"]["action"],
            "list"
        );
    }

    fn blocked(reason: Option<&str>) -> Blocked {
        Blocked {
            run: "run-1".into(),
            key: "blocked-1".into(),
            reason: reason.map(str::to_owned),
            file: None,
            audience: crate::workflow_decisions::Audience::Owner,
            timeout_ms: 86_400_000,
            json: true,
        }
    }

    fn ask(question: &str, options: &[&str]) -> Ask {
        Ask {
            run: "run-1".into(),
            key: "ask-1".into(),
            question: Some(question.into()),
            file: None,
            options: options.iter().map(|o| (*o).to_owned()).collect(),
            audience: crate::workflow_decisions::Audience::Coordinator,
            timeout_ms: 300_000,
            json: true,
        }
    }

    fn worker_context() -> Value {
        json!({"type":"workflow","run":{"id":"run-1","state":"active"},"task":{"id":"task-1"},"attempt":{"id":"attempt-1","state":"assigned"}})
    }

    fn code_of(error: &anyhow::Error) -> Value {
        cli::error_value(error)["error"]["code"].clone()
    }

    #[test]
    fn workflow_blocked_records_an_acknowledge_decision_for_the_bound_attempt() {
        let signal = blocked(Some("  Missing database credentials  "))
            .signal()
            .unwrap();
        assert_eq!(
            signal.request(&worker_context()).unwrap(),
            json!({"type":"workflow","request":{"action":"decision","request":{"action":"ask","key":"blocked-1","attemptId":"attempt-1","audience":"owner","question":"Blocked: Missing database credentials\n\nOptions: acknowledge","timeoutMs":86_400_000}}})
        );
        let receipt = signal
            .receipt(json!({"type":"workflow","decision":{"id":"d","state":"pending"},"cursor":7}));
        assert_eq!(
            receipt,
            json!({"type":"workflow","decision":{"id":"d","state":"pending"},"cursor":7,"signal":{"kind":"blocked","options":["acknowledge"]}})
        );
        for reason in ["", "   "] {
            assert_eq!(
                code_of(&blocked(Some(reason)).signal().err().unwrap()),
                "invalid_argument"
            );
        }
        let long = "x".repeat(DECISION_TEXT_LIMIT);
        assert_eq!(
            code_of(&blocked(Some(&long)).signal().err().unwrap()),
            "input_too_large"
        );
        assert_eq!(
            code_of(&blocked(None).signal().err().unwrap()),
            "invalid_argument"
        );
    }

    #[test]
    fn workflow_ask_records_a_question_with_options_and_guards_the_run_binding() {
        let signal = ask("Which migration order?", &[" up first", "down first "])
            .signal()
            .unwrap();
        let request = signal.request(&worker_context()).unwrap();
        assert_eq!(
            request,
            json!({"type":"workflow","request":{"action":"decision","request":{"action":"ask","key":"ask-1","attemptId":"attempt-1","audience":"coordinator","question":"Which migration order?\n\nOptions: up first, down first","timeoutMs":300_000}}})
        );
        assert!(
            supported(
                &json!({"workflowPlans":true,"workflowAttempts":true,"workflowDecisions":true}),
                &request
            )
            .is_ok()
        );
        assert!(
            supported(
                &json!({"workflowPlans":true,"workflowAttempts":true}),
                &request
            )
            .is_err()
        );
        assert_eq!(
            signal.receipt(json!({}))["signal"],
            json!({"kind":"question","options":["up first","down first"]})
        );
        let plain = ask("Proceed?", &[]).signal().unwrap();
        assert_eq!(
            plain.request(&worker_context()).unwrap()["request"]["request"]["question"],
            "Proceed?"
        );
        let mut moved = worker_context();
        moved["run"]["id"] = json!("run-2");
        let error = plain.request(&moved).unwrap_err();
        assert_eq!(code_of(&error), "run_binding_changed");
        assert_eq!(cli::exit_code("run_binding_changed"), cli::EXIT_MOVED_ON);
        let mut unbound = worker_context();
        unbound["run"] = Value::Null;
        let error = plain.request(&unbound).unwrap_err();
        assert_eq!(code_of(&error), "run_binding_required");
        assert_eq!(cli::exit_code("run_binding_required"), cli::EXIT_AUTHORITY);
        let mut unassigned = worker_context();
        unassigned["attempt"] = Value::Null;
        assert_eq!(
            code_of(&plain.request(&unassigned).unwrap_err()),
            "attempt_not_found"
        );
        let nine: Vec<String> = (0..9).map(|i| i.to_string()).collect();
        let nine: Vec<&str> = nine.iter().map(String::as_str).collect();
        for options in [vec!["a", "a"], vec!["a", ""], vec!["bad\ncontrol"], nine] {
            assert_eq!(
                code_of(&ask("Which?", &options).signal().err().unwrap()),
                "invalid_argument",
                "{options:?}"
            );
        }
        let long = "x".repeat(OPTION_TEXT_LIMIT + 1);
        assert!(ask("Which?", &[&long]).signal().is_err());
        let near = "q".repeat(DECISION_TEXT_LIMIT - 5);
        assert_eq!(
            code_of(&ask(&near, &["yes", "no"]).signal().err().unwrap()),
            "input_too_large"
        );
    }

    #[test]
    fn workflow_validate_host_checks_cross_cli_and_mcp_and_require_their_capability() {
        let path = std::env::temp_dir().join(format!(
            "nesvo-validation-{}.json",
            hex::encode(nesvo_wire::random::<8>())
        ));
        std::fs::write(
            &path,
            r#"{"passed":true,"summary":"Host evidence","checks":[]}"#,
        )
        .unwrap();
        let command = |host_checks| Command::Validate {
            id: "r".into(),
            attempt: "a".into(),
            key: "k".into(),
            revision: 4,
            file: path.clone(),
            host_checks,
            json: true,
        };
        let checked = wire(command(true).request().unwrap()).unwrap();
        let plain = wire(command(false).request().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(checked["request"]["hostChecks"], true);
        assert!(plain["request"].get("hostChecks").is_none());
        let mcp = tool(
            "validate",
            json!({"key":"k","runId":"r","attemptId":"a","expectedRevision":4,"hostChecks":true,"validation":{"passed":true,"summary":"Host evidence","checks":[]}}),
        )
        .unwrap();
        assert_eq!(mcp, checked);
        let caps = json!({"workflowPlans":true,"workflowAttempts":true});
        assert_eq!(
            code_of(&supported(&caps, &checked).unwrap_err()),
            "unsupported"
        );
        assert!(supported(&caps, &plain).is_ok());
        let mut current = caps;
        current["workflowHostChecks"] = json!(true);
        assert!(supported(&current, &checked).is_ok());
        assert!(
            tool(
                "validate",
                json!({"key":"k","runId":"r","attemptId":"a","expectedRevision":4,"hostAttestation":{},"validation":{"passed":true,"summary":"x","checks":[]}}),
            )
            .is_err()
        );
    }

    #[test]
    fn run_digest_cli_wire_matches_the_mcp_tool_and_requires_its_capability() {
        use clap::Parser;
        let parsed =
            crate::Arguments::try_parse_from(["nesvo", "run", "digest", "run-1", "--json"])
                .unwrap();
        let Some(cli::Command::Run { command }) = parsed.command else {
            panic!("Expected run command");
        };
        assert!(command.machine());
        let wired = wire(command.request().unwrap()).unwrap();
        assert_eq!(
            wired,
            json!({"type":"workflow","request":{"action":"digest","runId":"run-1"}})
        );
        assert_eq!(tool("digest", json!({"runId":"run-1"})).unwrap(), wired);
        assert!(tool("digest", json!({})).is_err());
        assert!(tool("digest", json!({"runId":"run-1","offset":0})).is_err());
        assert!(crate::Arguments::try_parse_from(["nesvo", "run", "digest"]).is_err());
        let caps = json!({"workflowPlans":true,"workflowAttempts":true,"runDigests":true});
        supported(&caps, &wired).unwrap();
        let mut older = caps.clone();
        older["runDigests"] = false.into();
        assert_eq!(
            code_of(&supported(&older, &wired).unwrap_err()),
            "unsupported"
        );
        let report = tool(
            "report",
            json!({"key":"k","attemptId":"a","result":{"outcome":"succeeded","summary":"x","files":[],"artifacts":[],"checks":[],"limitations":[],"nextSteps":["Wire the parser"]}}),
        )
        .unwrap();
        assert_eq!(
            report["request"]["result"]["nextSteps"],
            json!(["Wire the parser"])
        );
        let legacy = tool(
            "report",
            json!({"key":"k","attemptId":"a","result":{"outcome":"succeeded","summary":"x","files":[],"artifacts":[],"checks":[],"limitations":[]}}),
        )
        .unwrap();
        assert!(legacy["request"]["result"].get("nextSteps").is_none());
    }

    #[test]
    fn workflow_signal_commands_are_not_plain_wire_requests() {
        assert!(Command::Blocked(blocked(Some("x"))).request().is_err());
        assert!(Command::Ask(ask("x", &[])).request().is_err());
        assert!(Command::Ask(ask("x", &[])).machine());
    }
}
