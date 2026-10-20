//! CLI/MCP wire adapter for durable host plans, separate from native processes.
use crate::{cli, network::Connection};
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};

#[derive(Subcommand)]
pub enum Command {
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
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Executor { command } => command.machine(),
            Self::Deliver(args) => args.json,
            Self::CancelDelivery(args) => args.json,
            Self::Launch(launch) => launch.json,
            Self::Stop(start) | Self::Cancel(start) => start.json,
            Self::Control { json, .. } => *json,
            Self::Budget { command } => command.machine(),
            Self::Drain { json, .. } | Self::Resume { json, .. } => *json,
            Self::Decision { command } => command.machine(),
            Self::HostBudget { command } => command.machine(),
            Self::Inbox { command } => command.machine(),
            Self::Create { json, .. }
            | Self::List { json, .. }
            | Self::Get { json, .. }
            | Self::Plan { json, .. }
            | Self::Mutation { json, .. }
            | Self::Activate { json, .. }
            | Self::Assign { json, .. }
            | Self::Task { json, .. }
            | Self::Context { json }
            | Self::Report { json, .. }
            | Self::Validate { json, .. } => *json,
        }
    }
    fn request(self) -> Result<Request> {
        Ok(match self {
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
                ..
            } => Request::Validate {
                key,
                run_id: id,
                attempt_id: attempt,
                expected_revision: revision,
                validation: read_json(&file, 2048)?,
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
    let mut source = String::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(limit as u64 + 1).read_to_string(&mut source))
        .map_err(|_| cli::failure("invalid_argument", "Cannot read a UTF-8 workflow file"))?;
    if source.len() > limit {
        return Err(cli::failure(
            "invalid_argument",
            "Workflow file exceeds its byte limit",
        ));
    }
    Ok(source)
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
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidationSpec {
    passed: bool,
    summary: String,
    checks: Vec<Check>,
}
// These DTOs validate the wire shape only; the host owns DAG, access and revision rules.
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
    Ok(json!({"type":"workflow","request":value}))
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
pub async fn capability(connection: &mut Connection, request: &Value) -> Result<()> {
    let caps = cli::request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
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
    if request["request"]["action"] == "decision" && caps["workflowDecisions"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host does not support attempt-bound decisions; update nesvo-host",
        ));
    }
    let capability = match request["request"]["action"].as_str() {
        Some("launch") => Some("runLaunch"),
        Some("delivery") => Some("runDelivery"),
        Some("executor") => Some("runExecutor"),
        Some("control") => Some("runControls"),
        Some("runBudget") => Some("runBudgets"),
        Some("drain" | "resume") => Some("runDrain"),
        _ => None,
    };
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
    fn adapters_reject_malformed_shapes_before_host_dispatch() {
        for extra in [
            json!({"prompt":"foreign instruction"}),
            json!({"sessionId":"foreign"}),
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
}
