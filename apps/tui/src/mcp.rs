//! MCP is a transport adapter to the authenticated host, never a session engine.
use crate::{
    cli,
    network::{Connection, Pairing},
};
use anyhow::Result;
use futures_util::{StreamExt, future};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
    },
    service::{RequestContext, RxJsonRpcMessage, TxJsonRpcMessage},
    transport::async_rw::JsonRpcMessageCodec,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::codec::{FramedRead, FramedWrite};

const MAX_MESSAGE: usize = 64 * 1024;

fn launch_schema() -> Value {
    json!({
        "type":"object", "required":["name"], "additionalProperties":false,
        "properties": {
            "name":{"type":"string","minLength":1,"maxLength":80},
            "program":{"enum":["shell","claude","codex","gemini"],"default":"shell"},
            "role":{"enum":["worker","coordinator"],"default":"worker","description":"Only owner access may grant coordinator at launch; a coordinator cannot create coordinators"},
            "harness":{"type":"boolean","description":"Launch-local Nesvo MCP/instructions on supported Claude; inherits coordinator setting when omitted"},
            "cwd":{"type":"string"}, "groupId":{"type":["string","null"]},
            "parentSessionId":{"type":["string","null"],"description":"Lineage only; scoped creation binds the authenticated parent automatically"},
            "prompt":{"type":"string","description":"Literal agent prompt, at most 8192 UTF-8 bytes; not a shell command"},
            "worktree":{"type":"boolean","default":false},
            "autoTitle":{"type":"boolean","default":false},
            "muted":{"type":"boolean","default":false},
            "resumePicker":{"type":"boolean","default":false}
        }
    })
}

fn object(properties: Value, required: &[&str]) -> serde_json::Map<String, Value> {
    let mut schema = serde_json::Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), properties);
    schema.insert("required".into(), json!(required));
    schema.insert("additionalProperties".into(), false.into());
    schema
}
fn catalog() -> Vec<Tool> {
    let id = json!({"type":"string","minLength":1,"maxLength":128,"description":"Stable host session ID, never a display name or focused-session hint"});
    let cursor = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64});
    let definitions = [
        (
            "nesvo_list_sessions",
            "List visible session IDs, groups and lifecycle without acquiring control.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_get_session",
            "Inspect one visible session and its independent process/agent/turn state.",
            object(json!({"sessionId":id}), &["sessionId"]),
            true,
        ),
        (
            "nesvo_get_current_session",
            "Inspect the process session injected into this MCP launch. Never guesses from the UI focus; a context hint cannot bypass host authority.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_read_session",
            "Read a bounded terminal replay page. Cursors are UTF-8 byte offsets, not domain-event sequences; gap means retained history expired.",
            object(
                json!({"sessionId":id,"after":cursor,"maxBytes":{"type":"integer","minimum":1,"maximum":8192,"default":4096}}),
                &["sessionId"],
            ),
            true,
        ),
        (
            "nesvo_explain_session",
            "Explain this session's status evidence/readiness and integration health without exposing owner credentials or prompts.",
            object(json!({"sessionId":id}), &["sessionId"]),
            true,
        ),
        (
            "nesvo_read_diff",
            "Read repository changes on the host for this session's automatic edit context. Read-only; no staging or commit.",
            object(
                json!({"sessionId":id,"scope":{"enum":["staged","unstaged","untracked"],"default":"unstaged"}}),
                &["sessionId"],
            ),
            true,
        ),
        (
            "nesvo_read_events",
            "Read durable metadata events after a domain cursor. Preserve nextCursor; gap is incomplete history, never success. No terminal transcript.",
            object(
                json!({"sessionId":id,"after":cursor,"limit":{"type":"integer","minimum":1,"maximum":32,"default":32}}),
                &["after"],
            ),
            true,
        ),
        (
            "nesvo_create_session",
            "Create one background process for a stable idempotency key. Reuse the same key/spec after timeout, never invent another key to retry. Created is not agent readiness or task success. Host authorization still applies.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"spec":launch_schema()}),
                &["key", "spec"],
            ),
            false,
        ),
        (
            "nesvo_send_prompt",
            "Submit one literal prompt to a ready idle session for a durable key. Never takes control; human drafts, pending input and decision dialogs are refused. Reuse the same key/prompt after uncertainty; delivery is not agent pickup or task success.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128},"prompt":{"type":"string","minLength":1,"maxLength":8192,"description":"Literal prompt, at most 8192 UTF-8 bytes. Multiline/tab requires observed bracketed paste. No terminal controls."}}),
                &["sessionId", "key", "prompt"],
            ),
            false,
        ),
        (
            "nesvo_wait_prompt",
            "Passively wait for one send receipt by id or your original key. Exactly one selector. Binds the matching response, never old idle. Settled means response ended, not validated task success. A timeout returns the receipt and never retries input.",
            object(
                json!({"id":id,"key":{"type":"string","minLength":1,"maxLength":128},"sessionId":id,"until":{"enum":["delivered","received","started","settled"],"default":"settled"},"timeoutMs":{"type":"integer","minimum":1,"maximum":60000,"default":30000}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_interrupt_session",
            "Submit one Ctrl+C with a durable key; never takes human control. Delivery proves only a native write, not that the agent stopped. May discard the agent's current work. Inspect the same receipt after uncertainty.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["sessionId", "key"],
            ),
            false,
        ),
        (
            "nesvo_stop_session",
            "Request native stop of this managed process once for a durable key. Destructive: can lose in-memory work. Refuses human control, retains terminal output/session record. stopRequested is not observed process exit or task success.",
            object(
                json!({"sessionId":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["sessionId", "key"],
            ),
            false,
        ),
        (
            "nesvo_get_operation",
            "Recover a durable operation by its ID or your original idempotency key. Exactly one selector. Never resend with a fresh key after an unknown result.",
            object(
                json!({"id":id,"key":{"type":"string","minLength":1,"maxLength":128}}),
                &[],
            ),
            true,
        ),
    ];
    definitions.into_iter().map(|(name,description,schema,read_only)| {
        Tool::new(name,description,schema).with_annotations(ToolAnnotations::new().read_only(read_only).destructive(matches!(name,"nesvo_interrupt_session"|"nesvo_stop_session")).idempotent(true).open_world(!read_only))
            .with_raw_output_schema(Arc::new(serde_json::from_value(json!({"type":"object","required":["schemaVersion","ok"],"properties":{"schemaVersion":{"const":1},"ok":{"type":"boolean"},"data":{"type":"object"},"error":{"type":"object"}}})).expect("constant result schema")))
    }).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    session_id: String,
    after: Option<u64>,
    max_bytes: Option<u16>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diff {
    session_id: String,
    scope: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Events {
    session_id: Option<String>,
    after: u64,
    limit: Option<u16>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    key: String,
    spec: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    id: Option<String>,
    key: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Send {
    session_id: String,
    key: String,
    prompt: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    session_id: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    id: Option<String>,
    key: Option<String>,
    session_id: Option<String>,
    until: Option<String>,
    timeout_ms: Option<u64>,
}
fn parse<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T> {
    serde_json::from_value(arguments)
        .map_err(|_| cli::failure("invalid_argument", "Arguments must match the tool schema"))
}
fn command(name: &str, arguments: Value) -> Result<(Value, &'static str)> {
    if serde_json::to_vec(&arguments)?.len() > 24 * 1024 {
        return Err(cli::failure(
            "invalid_argument",
            "Tool arguments exceed 24 KiB",
        ));
    }
    Ok(match name {
        "nesvo_list_sessions" | "nesvo_get_current_session" => {
            let args: serde_json::Map<String, Value> = parse(arguments)?;
            if !args.is_empty() {
                return Err(cli::failure(
                    "invalid_argument",
                    "This tool takes no arguments",
                ));
            }
            if name == "nesvo_get_current_session" {
                (json!({"type":"getSession"}), "session")
            } else {
                (json!({"type":"list"}), "sessions")
            }
        }
        "nesvo_get_session" | "nesvo_explain_session" => {
            let s: Session = parse(arguments)?;
            cli::valid_id(&s.session_id)?;
            if name == "nesvo_get_session" {
                (
                    json!({"type":"getSession","sessionId":s.session_id}),
                    "session",
                )
            } else {
                (
                    json!({"type":"getDiagnostics","sessionId":s.session_id}),
                    "diagnostics",
                )
            }
        }
        "nesvo_read_session" => {
            let a: Read = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            if !(1..=8192).contains(&a.max_bytes.unwrap_or(4096)) {
                return Err(cli::failure("invalid_argument", "maxBytes must be 1–8192"));
            }
            (
                json!({"type":"readSession","sessionId":a.session_id,"after":a.after,"maxBytes":a.max_bytes}),
                "sessionRead",
            )
        }
        "nesvo_read_diff" => {
            let a: Diff = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            let scope = a.scope.as_deref().unwrap_or("unstaged");
            if !matches!(scope, "staged" | "unstaged" | "untracked") {
                return Err(cli::failure("invalid_argument", "Invalid diff scope"));
            }
            (
                json!({"type":"getDiff","sessionId":a.session_id,"scope":scope}),
                "diff",
            )
        }
        "nesvo_read_events" => {
            let a: Events = parse(arguments)?;
            if let Some(id) = &a.session_id {
                cli::valid_id(id)?;
            }
            if !(1..=32).contains(&a.limit.unwrap_or(32)) {
                return Err(cli::failure("invalid_argument", "Event limit must be 1–32"));
            }
            (
                json!({"type":"readEvents","sessionId":a.session_id,"after":a.after,"limit":a.limit}),
                "events",
            )
        }
        "nesvo_create_session" => {
            let a: Create = parse(arguments)?;
            let valid = a.spec.as_object().is_some_and(|spec| {
                spec.get("name").is_some_and(Value::is_string)
                    && spec.iter().all(|(key, value)| match key.as_str() {
                        "name" | "cwd" | "prompt" => value.is_string(),
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
                        _ => false,
                    })
            });
            if !valid {
                return Err(cli::failure(
                    "invalid_argument",
                    "Launch spec fields must match the declared schema",
                ));
            }
            (
                json!({"type":"createOperation","key":a.key,"spec":a.spec}),
                "operation",
            )
        }
        "nesvo_interrupt_session" | "nesvo_stop_session" => {
            let a: Control = parse(arguments)?;
            cli::valid_id(&a.session_id)?;
            cli::valid_id(&a.key)?;
            (
                json!({"type":if name=="nesvo_interrupt_session"{"interruptOperation"}else{"stopOperation"},"sessionId":a.session_id,"key":a.key}),
                "operation",
            )
        }
        "nesvo_send_prompt" => {
            let a: Send = parse(arguments)?;
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
            (
                json!({"type":"sendOperation","sessionId":a.session_id,"key":a.key,"prompt":a.prompt}),
                "operation",
            )
        }
        "nesvo_wait_prompt" => {
            let a: Wait = parse(arguments)?;
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
            (
                json!({"type":"waitOperation","id":a.id,"key":a.key,"sessionId":a.session_id,"until":until,"timeoutMs":timeout}),
                "operation",
            )
        }
        "nesvo_get_operation" => {
            let a: Operation = parse(arguments)?;
            if a.id.is_some() == a.key.is_some() {
                return Err(cli::failure(
                    "invalid_argument",
                    "Supply one operation ID or key",
                ));
            }
            (
                json!({"type":"getOperation","id":a.id,"key":a.key}),
                "operation",
            )
        }
        _ => return Err(cli::failure("invalid_argument", "Unknown Nesvo tool")),
    })
}

struct HostTools {
    pairing: PathBuf,
    url: Option<String>,
    slots: Semaphore,
}
impl HostTools {
    async fn invoke(&self, name: &str, arguments: Value) -> Result<Value> {
        let (mut command, kind) = command(name, arguments)?;
        let _permit = self.slots.try_acquire().map_err(|_| {
            cli::failure(
                "busy",
                "Four host calls are already pending; wait for a result before retrying",
            )
        })?;
        let pairing=Pairing::load(&self.pairing,self.url.as_deref()).map_err(|_|cli::failure("pairing_unavailable","Cannot load the private caller context; never substitute an owner key for a worker"))?;
        let mut connection = Connection::open(pairing).await.map_err(|_| {
            cli::failure(
                "host_unavailable",
                "Cannot authenticate with the paired host",
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
        if matches!(name, "nesvo_interrupt_session" | "nesvo_stop_session") {
            cli::control_capability(&mut connection).await?;
        } else if matches!(name, "nesvo_send_prompt" | "nesvo_wait_prompt") {
            cli::prompt_capability(&mut connection).await?;
        } else if kind == "operation" {
            let caps = cli::operation_capability(&mut connection).await?;
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
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
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
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let result = match self
            .invoke(
                &request.name,
                Value::Object(request.arguments.unwrap_or_default()),
            )
            .await
        {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(cli::error_value(&error)),
        };
        Ok(result.into())
    }
}

pub async fn serve(pairing: PathBuf, url: Option<String>) -> Result<()> {
    // The SDK's default stdio reader has no line limit. Use its codec with a cap;
    // malformed/oversized input closes this adapter before dispatching that input.
    let input = FramedRead::new(
        tokio::io::stdin(),
        JsonRpcMessageCodec::<RxJsonRpcMessage<RoleServer>>::new_with_max_length(MAX_MESSAGE),
    )
    .take_while(|message| future::ready(message.is_ok()))
    .filter_map(|message| future::ready(message.ok()));
    let output = FramedWrite::new(
        tokio::io::stdout(),
        JsonRpcMessageCodec::<TxJsonRpcMessage<RoleServer>>::default(),
    );
    HostTools {
        pairing,
        url,
        slots: Semaphore::new(4),
    }
    .serve((output, input))
    .await?
    .waiting()
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_and_boundary_reject_ambiguous_or_unbounded_requests() {
        assert_eq!(catalog().len(), 13);
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
        let (literal, kind) = command(
            "nesvo_create_session",
            json!({"key":"k","spec":{"name":"n","prompt":"$(literal) `literal` łódź"}}),
        )
        .unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(literal["spec"]["prompt"], "$(literal) `literal` łódź");
    }
}
