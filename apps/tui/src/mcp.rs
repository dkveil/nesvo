//! MCP is a transport adapter to the authenticated host, never a session engine.
use crate::{
    cli, mcp_events,
    mcp_tools::{
        self, Handler, Request, Scope,
        args::{
            CreateSession, DeliverReview, GetOperation, NoArgs, OpenReview, ProviderQuota,
            ReadDiff, ReadEvents, ReadSession, SendPrompt, SessionArgs, SessionControl,
            SetQuotaWake, StartWorkflowTemplate, WaitPrompt, WorktreeSession, WorktreeSetup,
        },
        catalog, parse,
    },
    network::{Connection, Pairing, open_failure_message},
};
use anyhow::Result;
use futures_util::{Stream, StreamExt, future};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation,
        ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
        ReadResourceRequestParams, ReadResourceResponse, ServerCapabilities, ServerConfig,
        SubscribeRequestParams, SubscriptionFilter, Tool, UnsubscribeRequestParams,
    },
    service::{RequestContext, RxJsonRpcMessage, SubscriptionContext, TxJsonRpcMessage},
    transport::async_rw::JsonRpcMessageCodec,
};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::sync::Semaphore;
use tokio_util::{
    codec::{FramedRead, FramedWrite},
    sync::CancellationToken,
};

const MAX_MESSAGE: usize = 64 * 1024;

#[cfg(test)]
#[path = "quota_job_cli_tests.rs"]
mod quota_job_cli_tests;

#[cfg(test)]
fn published_tools() -> Vec<String> {
    mcp_tools::published_names()
        .into_iter()
        .map(String::from)
        .collect()
}

fn valid_permission_additions(value: &Value) -> bool {
    let Some(tools) = value.as_array() else {
        return false;
    };
    let known = mcp_tools::published_names();
    let mut seen = std::collections::HashSet::new();
    tools.len() <= 32
        && tools.iter().all(|v| {
            v.as_str()
                .is_some_and(|t| known.contains(&t) && seen.insert(t))
        })
}

#[cfg(test)]
#[path = "quota_mcp_tests.rs"]
mod quota_tests;

#[cfg(test)]
mod workflow_template_tests {
    use super::*;

    #[test]
    fn workflow_template_mcp_matches_cli_wire_and_has_no_approval_tool() {
        assert_eq!(
            command(
                "nesvo_list_workflow_templates",
                json!({"directory":"/repo"})
            )
            .unwrap(),
            crate::runs::template_command("list", "/repo", None, None).unwrap()
        );
        assert_eq!(
            command(
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review","key":"k1"})
            )
            .unwrap(),
            (
                json!({"type":"startWorkflowTemplate","directory":"/repo","name":"review","key":"k1"}),
                "workflowTemplateStarted"
            )
        );
        for (name, value) in [
            ("nesvo_list_workflow_templates", json!({})),
            (
                "nesvo_list_workflow_templates",
                json!({"directory":"/repo","digest":"a".repeat(64)}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"bad name","key":"k"}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review","key":""}),
            ),
            (
                "nesvo_start_workflow_template",
                json!({"directory":"/repo","name":"review"}),
            ),
        ] {
            assert!(command(name, value.clone()).is_err(), "{name} {value}");
        }
        for name in [
            "nesvo_approve_workflow_templates",
            "nesvo_revoke_workflow_templates",
        ] {
            assert!(catalog().iter().all(|tool| tool.name != name), "{name}");
        }
        for (name, read_only) in [
            ("nesvo_list_workflow_templates", true),
            ("nesvo_start_workflow_template", false),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
        }
    }
}

#[cfg(test)]
mod run_digest_tests {
    use super::*;

    #[test]
    fn run_digest_mcp_matches_cli_wire_and_is_a_strict_read_only_tool() {
        assert_eq!(
            command("nesvo_get_run_digest", json!({"runId":"run-1"})).unwrap(),
            (
                crate::workflow::tool("digest", json!({"runId":"run-1"})).unwrap(),
                "workflow"
            )
        );
        for arguments in [json!({}), json!({"runId":"run-1","kind":"final"})] {
            assert!(command("nesvo_get_run_digest", arguments).is_err());
        }
        let tool = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_get_run_digest")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(tool["inputSchema"]["required"], json!(["runId"]));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool["annotations"]["destructiveHint"], false);
        assert!(tool["description"].as_str().unwrap().contains("8 KiB"));
        assert!(
            published_tools()
                .iter()
                .any(|name| name == "nesvo_get_run_digest")
        );
        let report = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_report_task_result")
                .unwrap(),
        )
        .unwrap();
        let result = &report["inputSchema"]["properties"]["result"];
        assert_eq!(result["properties"]["nextSteps"]["maxItems"], 8);
        assert!(
            !result["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "nextSteps")
        );
    }
}

#[cfg(test)]
mod worktree_tests {
    use super::*;

    #[test]
    fn worktree_mcp_matches_cli_wire_and_refuses_extra_arguments() {
        let digest = "b".repeat(64);
        for name in [
            "nesvo_approve_worktree_setup",
            "nesvo_revoke_worktree_setup",
        ] {
            assert!(
                command(name, json!({"directory":"/repo","digest":digest})).is_err(),
                "{name}"
            );
            assert!(catalog().iter().all(|tool| tool.name != name), "{name}");
            assert!(!published_tools().iter().any(|tool| tool == name), "{name}");
        }
        assert_eq!(
            command(
                "nesvo_describe_worktree_setup",
                json!({"directory":"/repo"})
            )
            .unwrap(),
            cli::worktree_setup_query("describe", "/repo", None).unwrap()
        );
        assert_eq!(
            command(
                "nesvo_archive_worktree",
                json!({"sessionId":"s","discard":true})
            )
            .unwrap(),
            cli::worktree_session_query("archive", "s", true).unwrap()
        );
        assert_eq!(
            command("nesvo_archive_worktree", json!({"sessionId":"s"})).unwrap(),
            cli::worktree_session_query("archive", "s", false).unwrap()
        );
        assert_eq!(
            command("nesvo_run_worktree", json!({"sessionId":"s"})).unwrap(),
            cli::worktree_session_query("run", "s", false).unwrap()
        );
        assert_eq!(
            command("nesvo_list_worktrees", json!({})).unwrap(),
            (json!({"type":"listWorktrees"}), "worktreeRegistry")
        );
        for (name, value) in [
            ("nesvo_describe_worktree_setup", json!({})),
            (
                "nesvo_describe_worktree_setup",
                json!({"directory":"/repo","digest":digest}),
            ),
            (
                "nesvo_run_worktree",
                json!({"sessionId":"s","discard":false}),
            ),
            ("nesvo_cancel_worktree", json!({})),
            (
                "nesvo_archive_worktree",
                json!({"sessionId":"s","force":true}),
            ),
            (
                "nesvo_archive_worktree",
                json!({"sessionId":"s","discard":"yes"}),
            ),
            ("nesvo_list_worktrees", json!({"repository":"/repo"})),
        ] {
            assert!(command(name, value.clone()).is_err(), "{name} {value}");
        }
    }

    #[test]
    fn worktree_catalog_marks_reads_and_the_destructive_archive() {
        for (name, read_only, destructive) in [
            ("nesvo_describe_worktree_setup", true, false),
            ("nesvo_run_worktree", false, false),
            ("nesvo_cancel_worktree", false, false),
            ("nesvo_archive_worktree", false, true),
            ("nesvo_list_worktrees", true, false),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], destructive);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
            assert_eq!(
                published_tools()
                    .iter()
                    .filter(|tool| tool.as_str() == name)
                    .count(),
                1
            );
        }
    }
}

#[cfg(test)]
mod quota_wake_tests {
    use super::*;

    #[test]
    fn quota_wake_mcp_matches_cli_wire_and_requires_exact_mutation_arguments() {
        for enabled in [false, true] {
            assert_eq!(
                command(
                    "nesvo_set_quota_wake",
                    json!({"sessionId":"s","enabled":enabled})
                )
                .unwrap(),
                cli::quota_wake_query("s", Some(enabled)).unwrap()
            );
        }
        assert_eq!(
            command("nesvo_get_quota_wake", json!({"sessionId":"s"})).unwrap(),
            cli::quota_wake_query("s", None).unwrap()
        );
        for value in [
            json!({}),
            json!({"sessionId":"s"}),
            json!({"enabled":true}),
            json!({"sessionId":null,"enabled":true}),
            json!({"sessionId":"s","enabled":null}),
            json!({"sessionId":"s","enabled":"true"}),
            json!({"sessionId":"s","enabled":1}),
            json!({"sessionId":"s","enabled":true,"owner":true}),
            json!({"sessionId":"s","enabled":true,"accountId":"injected"}),
            json!({"sessionId":"s","enabled":true,"readerId":"ambient"}),
            json!({"sessionId":"s","enabled":true,"prompt":"new task"}),
            json!({"sessionId":"s","enabled":true,"key":"replay-input"}),
            json!({"sessionId":"s","enabled":true,"type":"sendOperation"}),
            json!({"sessionId":"bad\nidentity","enabled":true}),
            json!([]),
            json!(null),
        ] {
            assert!(command("nesvo_set_quota_wake", value).is_err());
        }
        for value in [
            json!({}),
            json!({"sessionId":"s","enabled":true}),
            json!({"sessionId":"s","refresh":true}),
            json!({"sessionId":"s","scopeId":"foreign"}),
            json!({"sessionId":null}),
        ] {
            assert!(command("nesvo_get_quota_wake", value).is_err());
        }
    }

    #[test]
    fn quota_wake_catalog_is_strict_and_get_remains_read_only() {
        for (name, required, read_only) in [
            (
                "nesvo_set_quota_wake",
                json!(["sessionId", "enabled"]),
                false,
            ),
            ("nesvo_get_quota_wake", json!(["sessionId"]), true),
        ] {
            let tool = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert_eq!(tool["inputSchema"]["required"], required);
            assert_eq!(
                tool["inputSchema"]["properties"].as_object().unwrap().len(),
                if read_only { 1 } else { 2 }
            );
            assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert_eq!(tool["annotations"]["openWorldHint"], !read_only);
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .contains("durableQuotaWake:true")
            );
            assert_eq!(
                published_tools()
                    .iter()
                    .filter(|tool| tool.as_str() == name)
                    .count(),
                1
            );
        }
    }
}

fn unknown_tool() -> anyhow::Error {
    cli::failure("invalid_argument", "Unknown Nesvo tool")
}

fn command(name: &str, arguments: Value) -> Result<Request> {
    if serde_json::to_vec(&arguments)?.len() > 24 * 1024 {
        return Err(cli::failure(
            "invalid_argument",
            "Tool arguments exceed 24 KiB",
        ));
    }
    let tool = mcp_tools::find(name).ok_or_else(unknown_tool)?;
    match &tool.handler {
        Handler::Typed(translate) => translate(tool.name, arguments),
        Handler::Raw(translate) => translate(tool.name, arguments),
        Handler::Workflow(action) => Ok((crate::workflow::tool(action, arguments)?, "workflow")),
        Handler::WorkflowRequest(group) => Ok((
            crate::workflow::tool(group, json!({"request":arguments}))?,
            "workflow",
        )),
        Handler::Scoped(scope, action) => scoped(*scope, action, arguments),
        Handler::RunControl(kind) => run_control(*kind, arguments),
        Handler::Adapter(adapter) => {
            adapter(tool.name, &arguments).unwrap_or_else(|| Err(unknown_tool()))
        }
    }
}

fn scoped(scope: Scope, action: &'static str, arguments: Value) -> Result<Request> {
    let (group, not_object, preselected) = match scope {
        Scope::Constraints | Scope::Checkpoints => (
            if matches!(scope, Scope::Constraints) {
                "constraints"
            } else {
                "checkpoints"
            },
            "Context arguments must be an object",
            "Context action is selected by the tool name",
        ),
        Scope::Wakes => (
            "wakes",
            "Wake arguments must be an object",
            "Wake action is selected by the tool name",
        ),
        Scope::Executor => (
            "executor",
            "Executor arguments must be an object",
            "Executor action is selected by the tool name",
        ),
        Scope::Delivery => (
            "delivery",
            "Delivery arguments must be an object",
            "Delivery action is selected by the tool name",
        ),
        Scope::RunBudget | Scope::HostBudget => (
            if matches!(scope, Scope::RunBudget) {
                "runBudget"
            } else {
                "hostBudget"
            },
            "Budget arguments must be an object",
            "Budget action is selected by the tool name",
        ),
        Scope::Decision => (
            "decision",
            "Decision arguments must be an object",
            "Decision action is selected by the tool name",
        ),
        Scope::Prechecks => (
            "jobs",
            "Precheck arguments must be an object",
            "Precheck action is selected by tool name",
        ),
        Scope::Jobs => (
            "jobs",
            "Job arguments must be an object",
            "Job action is selected by the tool name",
        ),
        Scope::Inbox => (
            "inbox",
            "Inbox arguments must be an object",
            "Inbox action is selected by the tool name",
        ),
    };
    let mut fields = arguments
        .as_object()
        .ok_or_else(|| cli::failure("invalid_argument", not_object))?
        .clone();
    if fields.contains_key("action") {
        return Err(cli::failure("invalid_argument", preselected));
    }
    fields.insert("action".into(), action.into());
    let request = match scope {
        Scope::Prechecks => json!({"request":{"action":"prechecks","request":fields}}),
        _ => json!({"request":fields}),
    };
    Ok((crate::workflow::tool(group, request)?, "workflow"))
}

fn run_control(kind: Option<&'static str>, arguments: Value) -> Result<Request> {
    let mut fields = arguments
        .as_object()
        .ok_or_else(|| {
            cli::failure(
                "invalid_argument",
                "Run control arguments must be an object",
            )
        })?
        .clone();
    if fields.contains_key("action") || fields.contains_key("kind") {
        return Err(cli::failure(
            "invalid_argument",
            "Control action is selected by the tool name",
        ));
    }
    match kind {
        None => {
            fields.insert("action".into(), "get".into());
        }
        Some(kind) => {
            fields.insert("action".into(), "start".into());
            fields.insert("kind".into(), kind.into());
        }
    }
    Ok((
        crate::workflow::tool("control", json!({"request":fields}))?,
        "workflow",
    ))
}

pub(crate) fn job_trigger(name: &str, arguments: &Value) -> Option<Result<Request>> {
    crate::job_trigger_tools::command(name, arguments)
        .map(|request| request.map(|request| (request, "workflow")))
}

pub(crate) fn set_quota_wake(_: &str, request: SetQuotaWake) -> Result<Request> {
    cli::quota_wake_query(&request.session_id, Some(request.enabled))
}

pub(crate) fn get_quota_wake(_: &str, request: SessionArgs) -> Result<Request> {
    cli::quota_wake_query(&request.session_id, None)
}

pub(crate) fn provider_quota(_: &str, arguments: Value) -> Result<Request> {
    if arguments
        .get("directory")
        .is_some_and(|value| !value.is_string())
    {
        return Err(cli::failure(
            "invalid_argument",
            "Quota directory must be a host folder",
        ));
    }
    if arguments
        .get("program")
        .is_some_and(|value| !value.is_string())
    {
        return Err(cli::failure(
            "invalid_argument",
            "Quota program must be a provider name",
        ));
    }
    let query: ProviderQuota = parse(arguments)?;
    Ok((
        cli::provider_quota_context_query(
            query.program.as_deref(),
            query.refresh,
            query.directory.as_deref(),
        )?,
        "providerQuota",
    ))
}

pub(crate) fn sessions(name: &str, arguments: Value) -> Result<Request> {
    let args: serde_json::Map<String, Value> = parse(arguments)?;
    if !args.is_empty() {
        return Err(cli::failure(
            "invalid_argument",
            "This tool takes no arguments",
        ));
    }
    Ok(if name == "nesvo_get_current_session" {
        (json!({"type":"getSession"}), "session")
    } else {
        (json!({"type":"list"}), "sessions")
    })
}

pub(crate) fn session(name: &str, s: SessionArgs) -> Result<Request> {
    cli::valid_id(&s.session_id)?;
    Ok(if name == "nesvo_get_session" {
        (
            json!({"type":"getSession","sessionId":s.session_id}),
            "session",
        )
    } else {
        (
            json!({"type":"getDiagnostics","sessionId":s.session_id}),
            "diagnostics",
        )
    })
}

pub(crate) fn read_session(_: &str, a: ReadSession) -> Result<Request> {
    cli::valid_id(&a.session_id)?;
    if !(1..=8192).contains(&a.max_bytes.unwrap_or(4096)) {
        return Err(cli::failure("invalid_argument", "maxBytes must be 1–8192"));
    }
    Ok((
        json!({"type":"readSession","sessionId":a.session_id,"after":a.after,"maxBytes":a.max_bytes}),
        "sessionRead",
    ))
}

pub(crate) fn read_diff(_: &str, a: ReadDiff) -> Result<Request> {
    cli::valid_id(&a.session_id)?;
    let scope = a.scope.as_deref().unwrap_or("unstaged");
    if !matches!(scope, "staged" | "unstaged" | "untracked") {
        return Err(cli::failure("invalid_argument", "Invalid diff scope"));
    }
    Ok((
        json!({"type":"getDiff","sessionId":a.session_id,"scope":scope}),
        "diff",
    ))
}

pub(crate) fn open_review(_: &str, a: OpenReview) -> Result<Request> {
    Ok((
        cli::open_review_query(
            a.session_id.as_deref(),
            a.directory.as_deref(),
            a.pull_url.as_deref(),
            a.base.as_deref(),
        )?,
        "reviewOpened",
    ))
}

pub(crate) fn deliver_review(_: &str, a: DeliverReview) -> Result<Request> {
    Ok((
        cli::deliver_review_query(&a.review_id, &a.session_id, &a.text, a.key.as_deref())?,
        "reviewDelivered",
    ))
}

pub(crate) fn describe_worktree_setup(_: &str, a: WorktreeSetup) -> Result<Request> {
    cli::worktree_setup_query("describe", &a.directory, None)
}

pub(crate) fn worktree_session(name: &str, arguments: Value) -> Result<Request> {
    let a: WorktreeSession = parse(arguments)?;
    let action = match name {
        "nesvo_run_worktree" => "run",
        "nesvo_cancel_worktree" => "cancel",
        _ => "archive",
    };
    if action != "archive" && a.discard.is_some() {
        return Err(cli::failure(
            "invalid_argument",
            "Only archive accepts discard",
        ));
    }
    cli::worktree_session_query(action, &a.session_id, a.discard.unwrap_or(false))
}

pub(crate) fn list_worktrees(_: &str, _: NoArgs) -> Result<Request> {
    Ok((json!({"type":"listWorktrees"}), "worktreeRegistry"))
}

pub(crate) fn list_workflow_templates(_: &str, a: WorktreeSetup) -> Result<Request> {
    crate::runs::template_command("list", &a.directory, None, None)
}

pub(crate) fn start_workflow_template(_: &str, a: StartWorkflowTemplate) -> Result<Request> {
    crate::runs::template_command("start", &a.directory, None, Some((&a.name, &a.key)))
}

pub(crate) fn read_events(_: &str, a: ReadEvents) -> Result<Request> {
    if let Some(id) = &a.session_id {
        cli::valid_id(id)?;
    }
    if !(1..=32).contains(&a.limit.unwrap_or(32)) {
        return Err(cli::failure("invalid_argument", "Event limit must be 1–32"));
    }
    Ok((
        json!({"type":"readEvents","sessionId":a.session_id,"after":a.after,"limit":a.limit}),
        "events",
    ))
}

pub(crate) fn create_session(_: &str, a: CreateSession) -> Result<Request> {
    let valid = a.spec.as_object().is_some_and(|spec| {
        spec.get("name").is_some_and(Value::is_string)
            && spec.iter().all(|(key, value)| match key.as_str() {
                "name" | "cwd" | "prompt" | "model" | "effort" => value.is_string(),
                "program" => value
                    .as_str()
                    .is_some_and(|v| matches!(v, "shell" | "claude" | "codex" | "gemini")),
                "groupId" | "parentSessionId" => value.is_null() || value.is_string(),
                "role" => value
                    .as_str()
                    .is_some_and(|role| matches!(role, "worker" | "coordinator")),
                "harness" | "worktree" | "autoTitle" | "muted" | "resumePicker" => {
                    value.is_boolean()
                }
                "allowedNesvoTools" | "childAllowedNesvoTools" => valid_permission_additions(value),
                "claudeQuotaCapture" => {
                    crate::workflow_launches::valid_capture(value, &a.spec["program"])
                }
                _ => false,
            })
    });
    if !valid {
        return Err(cli::failure(
            "invalid_argument",
            "Launch spec fields must match the declared schema",
        ));
    }
    Ok((
        json!({"type":"createOperation","key":a.key,"spec":a.spec}),
        "operation",
    ))
}

pub(crate) fn control_session(name: &str, a: SessionControl) -> Result<Request> {
    cli::valid_id(&a.session_id)?;
    cli::valid_id(&a.key)?;
    Ok((
        json!({"type":if name=="nesvo_interrupt_session"{"interruptOperation"}else{"stopOperation"},"sessionId":a.session_id,"key":a.key}),
        "operation",
    ))
}

pub(crate) fn send_prompt(_: &str, a: SendPrompt) -> Result<Request> {
    cli::valid_id(&a.session_id)?;
    cli::valid_id(&a.key)?;
    if a.prompt.trim().is_empty()
        || a.prompt.len() > 8192
        || a.prompt
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return Err(cli::failure(
            "invalid_argument",
            "Prompt must be nonempty UTF-8 within 8192 bytes, without terminal controls",
        ));
    }
    Ok((
        json!({"type":"sendOperation","sessionId":a.session_id,"key":a.key,"prompt":a.prompt}),
        "operation",
    ))
}

pub(crate) fn wait_prompt(_: &str, a: WaitPrompt) -> Result<Request> {
    if a.id.is_some() == a.key.is_some() {
        return Err(cli::failure(
            "invalid_argument",
            "Supply one operation ID or key",
        ));
    }
    for id in [&a.id, &a.key, &a.session_id].into_iter().flatten() {
        cli::valid_id(id)?;
    }
    let until = a.until.as_deref().unwrap_or("settled");
    let timeout = a.timeout_ms.unwrap_or(30_000);
    if !matches!(until, "delivered" | "received" | "started" | "settled")
        || !(1..=60_000).contains(&timeout)
    {
        return Err(cli::failure(
            "invalid_argument",
            "Invalid wait milestone or timeout (1–60000 ms)",
        ));
    }
    Ok((
        json!({"type":"waitOperation","id":a.id,"key":a.key,"sessionId":a.session_id,"until":until,"timeoutMs":timeout}),
        "operation",
    ))
}

pub(crate) fn get_operation(_: &str, a: GetOperation) -> Result<Request> {
    if a.id.is_some() == a.key.is_some() {
        return Err(cli::failure(
            "invalid_argument",
            "Supply one operation ID or key",
        ));
    }
    Ok((
        json!({"type":"getOperation","id":a.id,"key":a.key}),
        "operation",
    ))
}

struct HostTools {
    pairing: PathBuf,
    url: Option<String>,
    slots: Semaphore,
    events: mcp_events::EventBridge,
}
impl HostTools {
    async fn invoke_until_cancelled(
        &self,
        name: &str,
        arguments: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cli::failure(
                "canceled",
                "Tool call canceled; inspect the original mutation or receipt before another request",
            )),
            result = self.invoke(name, arguments) => result,
        }
    }

    async fn invoke(&self, name: &str, arguments: Value) -> Result<Value> {
        let (mut command, kind) = command(name, arguments)?;
        let _permit = self.slots.try_acquire().map_err(|_| {
            cli::failure(
                "busy",
                "Four host calls are already pending; wait for a result before retrying",
            )
        })?;
        let pairing=Pairing::load(&self.pairing,self.url.as_deref()).map_err(|_|cli::failure("pairing_unavailable","Cannot load the private caller context; never substitute an owner key for a worker"))?;
        let mut connection = Connection::open(pairing).await.map_err(|error| {
            cli::failure(
                "host_unavailable",
                &open_failure_message(&error, "Cannot authenticate with the paired host"),
            )
        })?;
        if name == "nesvo_get_current_session" {
            let caps = cli::request(
                &mut connection,
                json!({"type":"getCapabilities"}),
                "capabilities",
            )
            .await?;
            command["sessionId"] = cli::current_session(&caps)?.into();
        }
        if matches!(kind, "quotaWake" | "wakeConfigured") {
            cli::quota_wake_capability(&mut connection).await?;
        } else if kind == "providerQuota" {
            cli::provider_quota_capability(&mut connection).await?;
            if command.get("directory").is_some()
                && cli::request(
                    &mut connection,
                    json!({"type":"getCapabilities"}),
                    "capabilities",
                )
                .await?["providerQuotaContexts"]
                    != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host does not support configured-directory quota observations",
                ));
            }
        } else if kind == "workflow" {
            crate::workflow::capability(&mut connection, &command).await?;
        } else if cli::attention::TOOLS.contains(&name) {
            cli::attention::capability(&mut connection, &command).await?;
        } else if crate::session_recovery::TOOLS.contains(&name) {
            crate::session_recovery::capability(&mut connection, &command).await?;
        } else if crate::project_commands::TOOLS.contains(&name) {
            crate::project_commands::capability(&mut connection).await?;
        } else if matches!(name, "nesvo_interrupt_session" | "nesvo_stop_session") {
            cli::control_capability(&mut connection).await?;
        } else if matches!(name, "nesvo_send_prompt" | "nesvo_wait_prompt") {
            cli::prompt_capability(&mut connection).await?;
        } else if matches!(kind, "reviewOpened" | "reviewDelivered") {
            cli::review_capability(&mut connection).await?;
        } else if kind.starts_with("worktree") {
            cli::worktree_capability(&mut connection).await?;
        } else if kind.starts_with("workflowTemplate") {
            cli::workflow_templates_capability(&mut connection).await?;
        } else if kind == "operation" {
            let caps = cli::operation_capability(&mut connection).await?;
            if name == "nesvo_create_session"
                && command["spec"].get("claudeQuotaCapture").is_some()
                && caps["claudeQuotaCapture"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot configure explicit Claude quota capture; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"].get("childAllowedNesvoTools").is_some()
                && caps["childToolPolicy"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce an owner child-tool policy; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && (command["spec"].get("model").is_some()
                    || command["spec"].get("effort").is_some())
                && caps["sessionModelProfiles"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host lacks launch-local model profile support; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"].get("allowedNesvoTools").is_some()
                && caps["sessionToolPermissions"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce process-scoped tool permission additions; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["harness"].is_boolean()
                && caps["sessionHarness"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot configure session-scoped harness tools; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["role"] == "coordinator"
                && caps["coordinatorScopes"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot enforce coordinator scopes; update nesvo-host",
                ));
            }
            if name == "nesvo_create_session"
                && command["spec"]["parentSessionId"].is_string()
                && caps["sessionLineage"] != true
            {
                return Err(cli::failure(
                    "unsupported",
                    "Host cannot preserve parent-session lineage; update nesvo-host",
                ));
            }
        }
        let mut result = cli::request(&mut connection, command, kind).await?;
        if matches!(
            name,
            "nesvo_create_session"
                | "nesvo_send_prompt"
                | "nesvo_interrupt_session"
                | "nesvo_stop_session"
                | "nesvo_deliver_review"
        ) {
            cli::check_receipt(&result)?;
        }
        if name == "nesvo_wait_prompt" {
            cli::check_wait(&result)?;
        }
        if let Some(o) = result.as_object_mut() {
            o.remove("requestId");
        }
        Ok(json!({"schemaVersion":1,"ok":true,"data":result}))
    }
}
impl ServerHandler for HostTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .build(),
        )
            .with_server_info(Implementation::new("nesvo",env!("CARGO_PKG_VERSION")))
            .with_instructions("Host session IDs are stable process identities, not UI focus. Capabilities come from the private launch context. Never request owner credentials to bypass a refusal. After a timeout inspect the original idempotency key; unknown, idle and response settlement never mean task success.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        catalog().into_iter().find(|t| t.name == name)
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        if request.is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "Tool catalog fits one page; omit cursor",
                None,
            ));
        }
        Ok(ListToolsResult::with_all_items(catalog()))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let result = match self
            .invoke_until_cancelled(
                &request.name,
                Value::Object(request.arguments.unwrap_or_default()),
                &context.ct,
            )
            .await
        {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(cli::error_value(&error)),
        };
        Ok(result.into())
    }
    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, ErrorData> {
        mcp_events::single_page(request.as_ref())?;
        Ok(mcp_events::resources())
    }
    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourceTemplatesResult, ErrorData> {
        mcp_events::single_page(request.as_ref())?;
        Ok(mcp_events::templates())
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, ErrorData> {
        mcp_events::read(
            &self.pairing,
            self.url.as_deref(),
            &self.slots,
            &request.uri,
            &context.ct,
        )
        .await
        .map(Into::into)
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(mcp_events::EventBridge::accepted(requested))
    }
    async fn listen(&self, context: SubscriptionContext) -> std::result::Result<(), ErrorData> {
        self.events
            .listen(&self.pairing, self.url.as_deref(), context)
            .await
    }
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<(), ErrorData> {
        self.events
            .subscribe(
                &self.pairing,
                self.url.as_deref(),
                request.uri,
                context.peer,
            )
            .await
    }
    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<(), ErrorData> {
        self.events.unsubscribe(&request.uri).await
    }
}

fn capped_stdin_messages() -> impl Stream<Item = RxJsonRpcMessage<RoleServer>> {
    FramedRead::new(
        tokio::io::stdin(),
        JsonRpcMessageCodec::<RxJsonRpcMessage<RoleServer>>::new_with_max_length(MAX_MESSAGE),
    )
    .take_while(|message| future::ready(message.is_ok()))
    .filter_map(|message| future::ready(message.ok()))
}

pub async fn serve(pairing: PathBuf, url: Option<String>) -> Result<()> {
    let input = capped_stdin_messages();
    let output = FramedWrite::new(
        tokio::io::stdout(),
        JsonRpcMessageCodec::<TxJsonRpcMessage<RoleServer>>::default(),
    );
    let tools = HostTools {
        pairing,
        url,
        slots: Semaphore::new(4),
        events: mcp_events::EventBridge::default(),
    };
    let closed = tools.events.closed();
    let input = Box::pin(
        input.chain(
            futures_util::stream::once(async move {
                closed.cancel();
                None
            })
            .filter_map(future::ready),
        ),
    );
    tools.serve((output, input)).await?.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_before_invoke_precedes_validation_and_slot_acquisition() {
        let tools = HostTools {
            pairing: PathBuf::new(),
            url: None,
            slots: Semaphore::new(0),
            events: mcp_events::EventBridge::default(),
        };
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        for name in ["nesvo_get_current_session", "unknown-tool"] {
            let error = tools
                .invoke_until_cancelled(name, json!({}), &cancellation)
                .await
                .unwrap_err();
            assert_eq!(
                cli::error_value(&error),
                json!({
                    "schemaVersion":1,
                    "ok":false,
                    "error":{
                        "code":"canceled",
                        "message":"Tool call canceled; inspect the original mutation or receipt before another request",
                        "retryable":false,
                    },
                })
            );
            assert_eq!(tools.slots.available_permits(), 0);
        }
    }

    fn retry_job_spec() -> Value {
        json!({"title":"Retry","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}})
    }
    #[test]
    fn declared_claude_display_capture_is_strict_and_advertised_on_existing_tools() {
        let capture = json!({"displayProfile":"/owner/display.json"});
        let (request,kind)=command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"claude","claudeQuotaCapture":capture}})).unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(request["spec"]["claudeQuotaCapture"], capture);
        assert!(command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"codex","claudeQuotaCapture":capture}})).is_err());
        assert!(command("nesvo_create_session",json!({"key":"capture","spec":{"name":"Capture","program":"claude","claudeQuotaCapture":{"displayProfile":"/owner/display.json","shell":"extra"}}})).is_err());
        let spec = |name: &str| {
            serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap()["inputSchema"]["properties"]["spec"]
                .clone()
        };
        let declared = &spec("nesvo_create_session")["properties"]["claudeQuotaCapture"];
        assert_eq!(
            &spec("nesvo_create_job")["properties"]["profile"]["properties"]["claudeQuotaCapture"],
            declared
        );
        assert_eq!(declared["additionalProperties"], false);
    }
    #[test]
    fn job_execution_timeout_create_and_edit_share_cli_mcp_shape_and_optional_schema() {
        use clap::Parser;
        let path = std::env::temp_dir().join(format!(
            "nesvo-job-execution-timeout-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for selected in [
            None,
            Some(Value::Null),
            Some(json!(1_000)),
            Some(json!(604_800_000)),
        ] {
            let mut spec = retry_job_spec();
            spec["maxElapsedMs"] = json!(12_345);
            if let Some(value) = selected {
                spec["executionTimeoutMs"] = value;
            }
            std::fs::write(&path, serde_json::to_vec(&spec).unwrap()).unwrap();
            for (mut args, name, arguments) in [
                (
                    vec!["nesvo", "job", "create", "--key", "timeout"],
                    "nesvo_create_job",
                    json!({"key":"timeout","spec":spec}),
                ),
                (
                    vec![
                        "nesvo",
                        "job",
                        "edit",
                        "j",
                        "--key",
                        "timeout",
                        "--revision",
                        "1",
                    ],
                    "nesvo_update_job",
                    json!({"key":"timeout","jobId":"j","expectedRevision":1,"spec":spec}),
                ),
            ] {
                args.extend(["--file", path.to_str().unwrap(), "--json"]);
                let parsed = crate::Arguments::try_parse_from(args).unwrap();
                let Some(cli::Command::Job { command: cli }) = parsed.command else {
                    panic!("Expected job command");
                };
                let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()}))
                    .unwrap();
                let (mcp, kind) = command(name, arguments).unwrap();
                assert_eq!(kind, "workflow");
                assert_eq!(
                    cli, mcp,
                    "Both callers must reach the shared capability gate with identical intent"
                );
                assert_eq!(mcp["request"]["request"]["spec"]["maxElapsedMs"], 12_345);
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("executionTimeoutMs"),
                    spec.get("executionTimeoutMs")
                        .filter(|value| !value.is_null())
                );
            }
        }
        std::fs::remove_file(path).unwrap();
        for name in ["nesvo_create_job", "nesvo_update_job"] {
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            let spec = &schema["inputSchema"]["properties"]["spec"];
            let timeout = &spec["properties"]["executionTimeoutMs"];
            assert_eq!(timeout["type"], "integer");
            assert_eq!(timeout["minimum"], 1_000);
            assert_eq!(timeout["maximum"], 604_800_000);
            assert!(timeout.get("default").is_none());
            assert!(
                !spec["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|field| field == "executionTimeoutMs")
            );
            assert_eq!(spec["properties"]["maxElapsedMs"]["default"], 300_000);
            for value in [
                json!(999),
                json!(604_800_001_u64),
                json!(-1),
                json!(1_000.5),
                json!("1000"),
                json!(true),
            ] {
                let mut invalid = retry_job_spec();
                invalid["executionTimeoutMs"] = value;
                let mut arguments = json!({"key":"timeout","spec":invalid});
                if name == "nesvo_update_job" {
                    arguments["jobId"] = json!("j");
                    arguments["expectedRevision"] = json!(1);
                }
                assert!(command(name, arguments).is_err());
            }
        }
    }
    #[test]
    fn job_retry_create_and_edit_share_cli_mcp_shape_and_preserve_legacy_specs() {
        use clap::Parser;
        let path = std::env::temp_dir().join(format!(
            "nesvo-job-retry-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let retry =
            json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
        for (policy, precheck) in [
            (None, false),
            (None, true),
            (Some(retry.clone()), false),
            (Some(retry.clone()), true),
        ] {
            let mut spec = retry_job_spec();
            if let Some(policy) = policy {
                spec["retry"] = policy;
            }
            if precheck {
                spec["precheckId"] = json!("01234567890123456789012345678901");
            }
            std::fs::write(&path, serde_json::to_vec(&spec).unwrap()).unwrap();
            for (mut args, name, mut arguments) in [
                (
                    vec!["nesvo", "job", "create", "--key", "retry"],
                    "nesvo_create_job",
                    json!({"key":"retry","spec":spec}),
                ),
                (
                    vec![
                        "nesvo",
                        "job",
                        "edit",
                        "j",
                        "--key",
                        "retry",
                        "--revision",
                        "1",
                    ],
                    "nesvo_update_job",
                    json!({"key":"retry","jobId":"j","expectedRevision":1,"spec":spec}),
                ),
            ] {
                args.extend(["--file", path.to_str().unwrap(), "--json"]);
                let parsed = crate::Arguments::try_parse_from(args).unwrap();
                let Some(cli::Command::Job { command: cli }) = parsed.command else {
                    panic!("Expected job command");
                };
                let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()}))
                    .unwrap();
                let (mcp, kind) = command(name, arguments.clone()).unwrap();
                assert_eq!(kind, "workflow");
                assert_eq!(cli, mcp);
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("retry"),
                    spec.get("retry")
                );
                assert_eq!(
                    mcp["request"]["request"]["spec"].get("precheckId"),
                    spec.get("precheckId")
                );
                if spec.get("retry").is_none() {
                    arguments["spec"]["retry"] = Value::Null;
                    assert_eq!(command(name, arguments).unwrap().0, mcp);
                }
            }
        }
        std::fs::remove_file(path).unwrap();
        for name in ["nesvo_create_job", "nesvo_update_job"] {
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            let spec = &schema["inputSchema"]["properties"]["spec"];
            assert!(spec.get("not").is_none());
            assert_eq!(
                spec["properties"]["retry"]["required"],
                json!(["on", "maxAttempts", "initialDelayMs", "maxDelayMs"])
            );
            assert_eq!(spec["properties"]["retry"]["additionalProperties"], false);
            assert_eq!(
                spec["properties"]["retry"]["properties"]["on"]["enum"],
                json!(["launchNoEffect"])
            );
        }
    }
    #[test]
    fn job_retry_policy_refuses_unknown_incomplete_or_out_of_bounds_intent() {
        let valid =
            json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":10000});
        let mut invalid = vec![json!({}), json!("launchNoEffect"), json!([])];
        for field in ["on", "maxAttempts", "initialDelayMs", "maxDelayMs"] {
            let mut policy = valid.clone();
            policy.as_object_mut().unwrap().remove(field);
            invalid.push(policy);
        }
        for (field, value) in [
            ("on", json!("failed")),
            ("on", json!(["launchNoEffect"])),
            ("maxAttempts", json!(0)),
            ("maxAttempts", json!(9)),
            ("maxAttempts", json!(1.5)),
            ("maxAttempts", json!("3")),
            ("initialDelayMs", json!(999)),
            ("initialDelayMs", json!(3_600_001)),
            ("maxDelayMs", json!(999)),
            ("maxDelayMs", json!(86_400_001)),
            ("unknown", json!(true)),
        ] {
            let mut policy = valid.clone();
            policy[field] = value;
            invalid.push(policy);
        }
        for policy in invalid {
            let mut spec = retry_job_spec();
            spec["retry"] = policy;
            for precheck in [false, true] {
                if precheck {
                    spec["precheckId"] = json!("01234567890123456789012345678901");
                }
                assert!(command("nesvo_create_job", json!({"key":"retry","spec":spec})).is_err());
                assert!(
                    command(
                        "nesvo_update_job",
                        json!({"key":"retry","jobId":"j","expectedRevision":1,"spec":spec})
                    )
                    .is_err()
                );
            }
        }
        for policy in [
            json!({"on":"launchNoEffect","maxAttempts":1,"initialDelayMs":1000,"maxDelayMs":1000}),
            json!({"on":"launchNoEffect","maxAttempts":8,"initialDelayMs":3600000,"maxDelayMs":86400000}),
        ] {
            let mut spec = retry_job_spec();
            spec["retry"] = policy;
            assert!(command("nesvo_create_job", json!({"key":"retry","spec":spec})).is_ok());
        }
    }
    #[test]
    fn job_attempt_reads_share_cli_mcp_shape_without_mutation_authority() {
        use clap::Parser;
        for (args, name, arguments, expected) in [
            (
                vec!["nesvo", "job", "attempts", "j", "o", "--json"],
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o"}),
                json!({"action":"attempts","jobId":"j","occurrenceId":"o","offset":0}),
            ),
            (
                vec![
                    "nesvo", "job", "attempts", "j", "o", "--offset", "8", "--json",
                ],
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o","offset":8}),
                json!({"action":"attempts","jobId":"j","occurrenceId":"o","offset":8}),
            ),
            (
                vec!["nesvo", "job", "attempt", "j", "o", "generation", "--json"],
                "nesvo_get_job_attempt",
                json!({"jobId":"j","occurrenceId":"o","jobAttemptId":"generation"}),
                json!({"action":"attempt","jobId":"j","occurrenceId":"o","jobAttemptId":"generation"}),
            ),
        ] {
            let parsed = crate::Arguments::try_parse_from(args).unwrap();
            let Some(cli::Command::Job { command: cli }) = parsed.command else {
                panic!("Expected job command");
            };
            assert!(cli.machine());
            let cli =
                crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
            let (mcp, kind) = command(name, arguments.clone()).unwrap();
            assert_eq!(kind, "workflow");
            assert_eq!(cli, mcp);
            assert_eq!(mcp["request"]["request"], expected);
            for field in ["key", "owner", "retry", "action", "sessionId"] {
                let mut forged = arguments.clone();
                forged[field] = json!("forged");
                assert!(command(name, forged).is_err());
            }
            for field in ["jobId", "occurrenceId"] {
                let mut missing = arguments.clone();
                missing.as_object_mut().unwrap().remove(field);
                assert!(command(name, missing).is_err());
            }
            let schema = serde_json::to_value(
                catalog()
                    .into_iter()
                    .find(|tool| tool.name == name)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(schema["inputSchema"]["additionalProperties"], false);
            assert_eq!(
                schema["inputSchema"]["properties"]
                    .as_object()
                    .unwrap()
                    .len(),
                3
            );
            assert_eq!(schema["annotations"]["readOnlyHint"], true);
            assert_eq!(schema["annotations"]["destructiveHint"], false);
            if name == "nesvo_get_job_attempts" {
                assert_eq!(
                    schema["inputSchema"]["required"],
                    json!(["jobId", "occurrenceId"])
                );
                assert_eq!(
                    schema["inputSchema"]["properties"]["offset"]["maximum"],
                    4096
                );
            } else {
                assert_eq!(
                    schema["inputSchema"]["required"],
                    json!(["jobId", "occurrenceId", "jobAttemptId"])
                );
                assert!(command(name, json!({"jobId":"j","occurrenceId":"o"})).is_err());
            }
        }
        assert!(
            command(
                "nesvo_get_job_attempts",
                json!({"jobId":"j","occurrenceId":"o","offset":65536})
            )
            .is_err()
        );
        assert!(
            crate::Arguments::try_parse_from([
                "nesvo", "job", "attempts", "j", "o", "--offset", "4097"
            ])
            .is_err()
        );
    }
    #[test]
    fn precheck_abandon_cli_and_mcp_preserve_legacy_and_exact_generation_intent() {
        use clap::Parser;
        let legacy = json!({"key":"abandon-once","jobId":"j","occurrenceId":"o","expectedDigest":"d".repeat(64),"acknowledgeUnknownEffects":true});
        for generation in [None, Some("generation-2")] {
            let digest = "d".repeat(64);
            let mut args = vec![
                "nesvo",
                "job",
                "abandon-precheck",
                "j",
                "o",
                "--key",
                "abandon-once",
                "--digest",
                &digest,
                "--acknowledge-unknown-effects",
                "--json",
            ];
            let mut arguments = legacy.clone();
            if let Some(id) = generation {
                args.extend(["--job-attempt-id", id]);
                arguments["jobAttemptId"] = json!(id);
            }
            let parsed = crate::Arguments::try_parse_from(args).unwrap();
            let Some(cli::Command::Job { command: cli }) = parsed.command else {
                panic!("Expected job command");
            };
            assert!(cli.machine());
            let cli =
                crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
            let (mcp, kind) = command("nesvo_abandon_job_precheck", arguments.clone()).unwrap();
            assert_eq!(kind, "workflow");
            assert_eq!(cli, mcp);
            let mut expected = arguments;
            expected["action"] = json!("abandonPrecheck");
            assert_eq!(mcp["request"]["request"], expected);
            if generation.is_none() {
                assert!(mcp["request"]["request"].get("jobAttemptId").is_none());
                assert_eq!(
                    serde_json::to_string(&mcp["request"]["request"]).unwrap(),
                    concat!(
                        "{\"acknowledgeUnknownEffects\":true,\"action\":\"abandonPrecheck\",",
                        "\"expectedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",",
                        "\"jobId\":\"j\",\"key\":\"abandon-once\",\"occurrenceId\":\"o\"}"
                    )
                );
            }
        }
        for value in [json!(true), json!(2), json!([]), json!({})] {
            let mut fields = legacy.clone();
            fields["jobAttemptId"] = value;
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        for required in [
            "key",
            "jobId",
            "occurrenceId",
            "expectedDigest",
            "acknowledgeUnknownEffects",
        ] {
            let mut fields = legacy.clone();
            fields.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        for (field, value) in [
            ("action", json!("runNow")),
            ("owner", json!(true)),
            ("expectedDigest", json!(7)),
            ("acknowledgeUnknownEffects", json!("true")),
        ] {
            let mut fields = legacy.clone();
            fields[field] = value;
            assert!(command("nesvo_abandon_job_precheck", fields).is_err());
        }
        let schema = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_abandon_job_precheck")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["properties"]["jobAttemptId"]["type"],
            "string"
        );
        assert_eq!(
            schema["inputSchema"]["required"],
            json!([
                "key",
                "jobId",
                "occurrenceId",
                "expectedDigest",
                "acknowledgeUnknownEffects"
            ])
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
    }
    #[test]
    fn launch_abandon_cli_and_mcp_require_the_same_explicit_generation_and_acknowledgement() {
        use clap::Parser;
        let digest = "a".repeat(64);
        let args = [
            "nesvo",
            "job",
            "abandon-launch",
            "j",
            "o",
            "--job-attempt-id",
            "generation",
            "--key",
            "abandon-launch-once",
            "--digest",
            &digest,
            "--acknowledge-unknown-effects",
            "--json",
        ];
        let parsed = crate::Arguments::try_parse_from(args).unwrap();
        let Some(cli::Command::Job { command: cli }) = parsed.command else {
            panic!("Expected exact launch abandonment");
        };
        assert!(cli.machine());
        let cli = crate::workflow::tool("jobs", json!({"request":cli.request().unwrap()})).unwrap();
        let arguments = json!({"key":"abandon-launch-once","jobId":"j","occurrenceId":"o","jobAttemptId":"generation","expectedDigest":digest,"acknowledgeUnknownEffects":true});
        let (mcp, kind) = command("nesvo_abandon_job_launch", arguments.clone()).unwrap();
        assert_eq!(kind, "workflow");
        assert_eq!(cli, mcp);
        let mut expected = arguments.clone();
        expected["action"] = json!("abandonLaunchNoEffect");
        assert_eq!(mcp["request"]["request"], expected);

        for flag in ["--job-attempt-id", "--acknowledge-unknown-effects"] {
            let mut omitted = args.to_vec();
            let position = omitted
                .iter()
                .position(|argument| *argument == flag)
                .unwrap();
            omitted.remove(position);
            if flag == "--job-attempt-id" {
                omitted.remove(position);
            }
            assert!(crate::Arguments::try_parse_from(omitted).is_err());
        }
        for required in [
            "key",
            "jobId",
            "occurrenceId",
            "jobAttemptId",
            "expectedDigest",
            "acknowledgeUnknownEffects",
        ] {
            let mut fields = arguments.clone();
            fields.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_abandon_job_launch", fields).is_err());
        }
        for (field, value) in [
            ("jobAttemptId", Value::Null),
            ("jobAttemptId", json!(1)),
            ("expectedDigest", json!("a".repeat(63))),
            ("expectedDigest", json!("g".repeat(64))),
            ("expectedDigest", json!("A".repeat(64))),
            ("expectedDigest", Value::Null),
            ("acknowledgeUnknownEffects", json!(false)),
            ("acknowledgeUnknownEffects", json!("true")),
            ("acknowledgeUnknownEffects", json!(1)),
            ("action", json!("abandonPrecheck")),
            ("owner", json!(true)),
            ("proof", json!({"effectStarted":false})),
        ] {
            let mut fields = arguments.clone();
            fields[field] = value;
            assert!(command("nesvo_abandon_job_launch", fields).is_err());
        }
        let schema = serde_json::to_value(
            catalog()
                .into_iter()
                .find(|tool| tool.name == "nesvo_abandon_job_launch")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["required"],
            json!([
                "key",
                "jobId",
                "occurrenceId",
                "jobAttemptId",
                "expectedDigest",
                "acknowledgeUnknownEffects"
            ])
        );
        assert_eq!(
            schema["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            schema["inputSchema"]["properties"]["acknowledgeUnknownEffects"]["const"],
            true
        );
        assert_eq!(
            schema["inputSchema"]["properties"]["expectedDigest"]["pattern"],
            "^[0-9a-f]{64}$"
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
    }

    #[test]
    fn launch_reconciliation_output_schema_is_additive_exact_and_keeps_proof_private() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let definitions = &schema["definitions"];
        for (name, extra, optional) in [
            (
                "jobLaunchReconciliation",
                ["available", "reason", "digest"],
                1,
            ),
            (
                "jobLaunchResolution",
                ["digest", "mutationKey", "acknowledgedAt"],
                0,
            ),
        ] {
            let object = &definitions[name];
            assert_eq!(object["type"], "object");
            assert_eq!(object["additionalProperties"], false);
            assert_eq!(
                object["properties"].as_object().unwrap().len(),
                11 + optional
            );
            let required = object["required"].as_array().unwrap();
            assert_eq!(required.len(), 11);
            assert_eq!(object["properties"]["kind"]["const"], "launchNoEffect");
            for field in [
                "kind",
                "jobId",
                "occurrenceId",
                "jobAttemptId",
                "runId",
                "attemptId",
                "sessionId",
                "launchReceiptId",
            ]
            .into_iter()
            .chain(extra)
            {
                assert!(required.contains(&json!(field)));
                assert!(object["properties"].get(field).is_some());
            }
            for private in ["token", "proof", "deadlineMonotonicMs", "claimToken"] {
                assert!(object["properties"].get(private).is_none());
            }
            assert_eq!(object["properties"]["digest"]["minLength"], 64);
            assert_eq!(object["properties"]["digest"]["maxLength"], 64);
            assert_eq!(object["properties"]["digest"]["pattern"], "^[0-9a-f]{64}$");
        }
        assert_eq!(
            definitions["jobLaunchReconciliation"]["properties"]["available"]["type"],
            "boolean"
        );
        assert_eq!(
            definitions["jobLaunchReconciliation"]["properties"]["digest"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(
            definitions["jobLaunchReconciliation"]["properties"]["retryClassification"]["$ref"],
            "#/definitions/jobRetryClassification"
        );
        assert!(
            !definitions["jobLaunchReconciliation"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("retryClassification"))
        );
        assert_eq!(
            definitions["jobLaunchResolution"]["properties"]["digest"]["type"],
            "string"
        );
        for (field, definition) in [
            ("launchReconciliation", "jobLaunchReconciliation"),
            ("launchResolution", "jobLaunchResolution"),
        ] {
            let occurrence = &definitions["jobOccurrence"];
            assert!(
                !occurrence["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            );
            assert_eq!(occurrence["properties"][field]["anyOf"][0]["type"], "null");
            assert_eq!(
                occurrence["properties"][field]["anyOf"][1]["$ref"],
                format!("#/definitions/{definition}")
            );
            let summary = &definitions["jobAttemptSummary"];
            assert!(
                !summary["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            );
            assert_eq!(
                summary["properties"][field]["$ref"],
                format!("#/definitions/jobOccurrence/properties/{field}")
            );
        }
        assert_eq!(
            definitions["jobAttemptDetail"]["allOf"][0]["$ref"],
            "#/definitions/jobAttemptSummary"
        );
    }

    #[test]
    fn occurrence_cancel_cli_and_mcp_share_exact_owner_intent() {
        use clap::Parser;
        let parsed = crate::Arguments::try_parse_from([
            "nesvo",
            "job",
            "cancel",
            "job-stable-id",
            "occurrence-stable-id",
            "--key",
            "cancel-once",
            "--json",
        ])
        .unwrap();
        let Some(cli::Command::Job { command: cli }) = parsed.command else {
            panic!("Expected job command");
        };
        assert!(cli.machine());
        let cli =
            crate::workflow::tool("jobs", json!({"request": cli.request().unwrap()})).unwrap();
        let arguments = json!({
            "key": "cancel-once",
            "jobId": "job-stable-id",
            "occurrenceId": "occurrence-stable-id"
        });
        let (mcp, result_kind) = command("nesvo_cancel_job_occurrence", arguments.clone()).unwrap();
        assert_eq!(result_kind, "workflow");
        assert_eq!(cli, mcp);
        assert_eq!(
            mcp["request"]["request"],
            json!({"action":"cancelOccurrence","key":"cancel-once","jobId":"job-stable-id","occurrenceId":"occurrence-stable-id"})
        );

        for required in ["key", "jobId", "occurrenceId"] {
            let mut missing = arguments.clone();
            missing.as_object_mut().unwrap().remove(required);
            assert!(command("nesvo_cancel_job_occurrence", missing).is_err());
        }
        for (field, value) in [
            ("action", json!("runNow")),
            ("owner", json!(true)),
            ("sessionId", json!("focused-session")),
            ("expectedRevision", json!(1)),
            ("key", json!(7)),
        ] {
            let mut changed = arguments.clone();
            changed[field] = value;
            assert!(command("nesvo_cancel_job_occurrence", changed).is_err());
        }

        let tool = catalog()
            .into_iter()
            .find(|tool| tool.name == "nesvo_cancel_job_occurrence")
            .unwrap();
        let schema = serde_json::to_value(tool).unwrap();
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["inputSchema"]["required"],
            json!(["key", "jobId", "occurrenceId"])
        );
        assert_eq!(
            schema["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(schema["annotations"]["readOnlyHint"], false);
        assert_eq!(schema["annotations"]["destructiveHint"], true);
        assert_eq!(schema["annotations"]["idempotentHint"], true);
    }
    #[test]
    fn catalog_and_boundary_reject_ambiguous_or_unbounded_requests() {
        let published: Vec<String> =
            serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json")).unwrap();
        let mut names = catalog()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert!(
            names.windows(2).all(|pair| pair[0] < pair[1]),
            "Published MCP names must be unique"
        );
        assert_eq!(
            names, published,
            "Host permission validation and actual MCP tools must share one exact catalog contract"
        );
        for extra in [
            json!({"sessionId":"foreign"}),
            json!({"owner":true}),
            json!({"key":"rearm"}),
            json!({"checkpointId":"old"}),
        ] {
            assert!(command("nesvo_recover_run_context", extra).is_err());
        }
        assert!(command("nesvo_set_host_budget",json!({"key":"k","expectedRevision":1,"limits":{"maxSessions":2,"maxWorkers":1,"providers":{"shell":1,"claude":1,"codex":1,"gemini":1},"role":"owner"}})).is_err());
        assert!(command("nesvo_answer_decision",json!({"runId":"r","decisionId":"d","key":"k","expectedRevision":1,"answer":"x","audience":"owner"})).is_err());
        assert!(
            command(
                "nesvo_send_message",
                json!({"runId":"r","key":"k","correlationId":"c","body":"x","sender":"owner"})
            )
            .is_err()
        );
        assert!(command("nesvo_ack_messages", json!({"runId":"r","ids":"all"})).is_err());
        assert!(
            command(
                "nesvo_read_session",
                json!({"sessionId":"s","maxBytes":8193})
            )
            .is_err()
        );
        assert!(
            command(
                "nesvo_create_session",
                json!({"key":"k","spec":{"name":"n","prompt":[]}})
            )
            .is_err()
        );
        assert!(command("nesvo_list_sessions", json!({"owner":true})).is_err());
        assert!(command("nesvo_get_session", json!({"sessionId":"s","owner":true})).is_err());
        assert!(command("nesvo_get_operation", json!({"id":"a","key":"b"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","key":"b"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","until":"idle"})).is_err());
        assert!(command("nesvo_wait_prompt", json!({"id":"a","timeoutMs":60001})).is_err());
        assert!(
            command(
                "nesvo_send_prompt",
                json!({"sessionId":"a","key":"k","prompt":"\u{1b}[201~"})
            )
            .is_err()
        );
        assert!(
            command(
                "nesvo_create_session",
                json!({"key":"k","spec":{"name":"n","shellCommand":"no"}})
            )
            .is_err()
        );
        let (open, kind) = command(
            "nesvo_open_review",
            json!({"pullUrl":"https://github.com/a/b/pull/1","base":"main"}),
        )
        .unwrap();
        assert_eq!(kind, "reviewOpened");
        assert_eq!(
            open,
            cli::open_review_query(
                None,
                None,
                Some("https://github.com/a/b/pull/1"),
                Some("main")
            )
            .unwrap()
        );
        let (deliver, kind) = command(
            "nesvo_deliver_review",
            json!({"reviewId":"r","sessionId":"s","text":"see a.rs:3"}),
        )
        .unwrap();
        assert_eq!(kind, "reviewDelivered");
        assert_eq!(
            deliver,
            cli::deliver_review_query("r", "s", "see a.rs:3", None).unwrap()
        );
        for (name, arguments) in [
            ("nesvo_open_review", json!({})),
            (
                "nesvo_open_review",
                json!({"sessionId":"s","pullUrl":"https://github.com/a/b/pull/1"}),
            ),
            ("nesvo_open_review", json!({"sessionId":"s","owner":true})),
            (
                "nesvo_deliver_review",
                json!({"reviewId":"r","sessionId":"s","text":"\u{1b}[201~"}),
            ),
            (
                "nesvo_deliver_review",
                json!({"reviewId":"r","sessionId":"s","text":"x","leaseId":"stolen"}),
            ),
            ("nesvo_deliver_review", json!({"reviewId":"r","text":"x"})),
        ] {
            assert!(command(name, arguments).is_err(), "{name}");
        }
        let (literal, kind) = command(
            "nesvo_create_session",
            json!({"key":"k","spec":{"name":"n","prompt":"$(literal) `literal` łódź"}}),
        )
        .unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(literal["spec"]["prompt"], "$(literal) `literal` łódź");
    }
}
