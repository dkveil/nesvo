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
    let id = json!({"type":"string","minLength":1,"maxLength":128,"description":"Stable host-issued ID for the named field; run/task/attempt/session IDs are distinct, never names or UI focus"});
    let cursor = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64});
    let key = json!({"type":"string","minLength":1,"maxLength":128});
    let revision = json!({"type":"integer","minimum":1});
    let checks = json!({"type":"array","maxItems":16,"items":{"type":"object","additionalProperties":false,"required":["name","outcome","details"],"properties":{"name":{"type":"string","minLength":1,"maxLength":128},"outcome":{"enum":["passed","failed","skipped"]},"details":{"type":"string","minLength":1,"maxLength":1024}}}});
    let strings = |count: usize| json!({"type":"array","maxItems":count,"items":{"type":"string","minLength":1,"maxLength":1024}});
    let definitions = [
        (
            "nesvo_deliver_task",
            "Queue the immutable instruction of a current assigned task once. Host waits up to timeoutMs (default 60000, max 300000) for idle and ready, with no human control/draft or decision gate. No prompt is accepted from the caller. Acceptance is not delivery or task success. Inspect task attempt.delivery and its native receipt; unknown effects are never retried. Client disconnect keeps this intent, host restart pauses it without replay. Agent sessions only.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"expectedRevision":revision,"timeoutMs":{"type":"integer","minimum":1,"maximum":300000}}),
                &["key", "runId", "taskId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_cancel_task_delivery",
            "Cancel an unclaimed task instruction intent in an authorized run. Requires its current run revision. Does not interrupt or replay native input; a claimed/sent/unknown intent must be inspected through its original receipt.",
            object(
                json!({"key":key,"runId":id,"deliveryId":id,"expectedRevision":revision}),
                &["key", "runId", "deliveryId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_launch_task",
            "Reserve a dependency-ready task, run parallel/retry capacity and a native create identity atomically, then launch its visible worker once. Explicitly choose shared checkout or isolated worktree. No initial prompt is sent. Reply is immutable acceptance; inspect run/task history and the returned native receipt before sending work. Unknown launches keep capacity and cannot be retried with a fresh key. Does not take human focus/control or grant coordinator roles.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"expectedRevision":revision,"profile":{"type":"object","additionalProperties":false,"required":["program","workspace"],"properties":{"name":{"type":"string","minLength":1,"maxLength":80},"cwd":{"type":"string","maxLength":4096},"program":{"enum":["shell","claude","codex","gemini"]},"workspace":{"enum":["shared","worktree"]},"harness":{"type":"boolean"}}}}),
                &["key", "runId", "taskId", "expectedRevision", "profile"],
            ),
            false,
        ),
        (
            "nesvo_stop_run",
            "Accept a durable stop intent for only this run's bound worker processes. Native stop receipts precede observed exits; reply is immutable acceptance, not proof of termination. Inspect nesvo_get_run_control. Human leases/drafts and owner drain are protected. Same-key replay/reconnect never dispatches again. Stopped runs may resume with fresh attempts, preserving budgets/history; unknown control must be reconciled first.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_cancel_run",
            "Accept durable run cancellation and native stop of its bound workers only. Does not touch the coordinator, unassigned children or foreign sessions. The run becomes canceled only after exit proof, and cannot resume. Immutable acceptance is not termination; inspect nesvo_get_run_control. Never bypass human input or resubmit uncertain effects under new keys.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_run_control",
            "Inspect at most eight target receipts/exit observations and aggregate native control state. Refreshes actual host exit/unavailable evidence but never sends signals or replays input. Missing processes after restart are unavailable, not assumed stopped. Page through targets; use original operationKey/receiptId for native recovery. Worker scopes cannot inspect parent control.",
            object(
                json!({"runId":id,"controlId":id,"offset":{"type":"integer","minimum":0,"maximum":4096}}),
                &["runId", "controlId"],
            ),
            true,
        ),
        (
            "nesvo_get_run_budget",
            "Read a visible run's current policy, active attempts and activation/deadline clock. Workers use their own task context. Reads may persist observed time exhaustion; never start/stop a process.",
            object(json!({"runId":id}), &["runId"]),
            true,
        ),
        (
            "nesvo_set_run_budget",
            "Replace a visible run's parallel, per-task attempt and elapsed limits at its exact run revision. Coordinator can only tighten; only owner can relax or extend an exhausted deadline. Reported results occupy parallel slots until validated. Elapsed time includes draining and resume never resets the clock. This neither grants global capacity nor kills current work. Recover the original key through nesvo_get_run_mutation.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision,"limits":{"type":"object","additionalProperties":false,"required":["maxParallel","maxAttemptsPerTask","maxElapsedMs"],"properties":{"maxParallel":{"type":"integer","minimum":1,"maximum":16},"maxAttemptsPerTask":{"type":"integer","minimum":1,"maximum":16},"maxElapsedMs":{"type":["integer","null"],"minimum":1000,"maximum":604_800_000}}}}),
                &["key", "runId", "expectedRevision", "limits"],
            ),
            false,
        ),
        (
            "nesvo_drain_run",
            "Block new task assignments; allow assigned workers to report and parents to validate. Does not stop, interrupt or send input to native processes. Owner drain remains owner-controlled even after coordinator drains again. Exact run revision and original mutation key are required.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_resume_run",
            "Resume new assignments after drain without resetting time/retry history or relaxing budgets. Only owner may undo an owner drain; coordinator can resume its own drain. No process is launched and no input replayed.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_host_budget",
            "Read the explicit owner's persisted host admission policy and its revision. Coordinators/workers cannot inspect or raise global budgets. This changes no live process, focus or input control.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_set_host_budget",
            "Owner-only replacement of future admission limits at the exact budget revision. maxSessions counts retained session slots (1–16); maxWorkers counts running worker-role processes (0–16); provider caps count running processes including coordinators (0–16). Reducing limits never terminates existing work. Same-key replay is historical and cannot restore an old active policy; recover through nesvo_get_run_mutation.",
            object(
                json!({"key":key,"expectedRevision":revision,"limits":{"type":"object","additionalProperties":false,"required":["maxSessions","maxWorkers","providers"],"properties":{"maxSessions":{"type":"integer","minimum":1,"maximum":16},"maxWorkers":{"type":"integer","minimum":0,"maximum":16},"providers":{"type":"object","additionalProperties":false,"required":["shell","claude","codex","gemini"],"properties":{"shell":{"type":"integer","minimum":0,"maximum":16},"claude":{"type":"integer","minimum":0,"maximum":16},"codex":{"type":"integer","minimum":0,"maximum":16},"gemini":{"type":"integer","minimum":0,"maximum":16}}}}}}),
                &["key", "expectedRevision", "limits"],
            ),
            false,
        ),
        (
            "nesvo_ask_decision",
            "Ask one durable question for this worker's exact current attempt. Audience owner requires an explicit human answer; coordinator permits that run's coordinator or owner. Answered is data, not native permission approval. Pending/canceled/expired gates prevent successful result reporting. No input or model wake occurs. Recover a lost reply with nesvo_get_run_mutation and the original key.",
            object(
                json!({"key":key,"attemptId":id,"audience":{"enum":["owner","coordinator"]},"question":{"type":"string","minLength":1,"maxLength":2048},"timeoutMs":{"type":"integer","minimum":1000,"maximum":604_800_000}}),
                &["key", "attemptId", "audience", "question", "timeoutMs"],
            ),
            false,
        ),
        (
            "nesvo_list_decisions",
            "Read up to eight retained questions and answers in a run. A worker sees only its own current attempt. Deadline expiration is persisted when observed; pagination does not approve or acknowledge anything.",
            object(
                json!({"runId":id,"attemptId":id,"offset":{"type":"integer","minimum":0,"maximum":4096}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_get_decision",
            "Read the exact decision revision, audience and state before answering. Current-attempt authority is enforced by the host. This does not send input or imply native permission approval.",
            object(
                json!({"runId":id,"decisionId":id}),
                &["runId", "decisionId"],
            ),
            true,
        ),
        (
            "nesvo_answer_decision",
            "Record a literal answer at the decision's exact revision. Worker self-answer and coordinator answers to owner-only questions are refused. Answer and worker notice commit together; replay the original key after uncertainty. This does not type an approval, validate work or resume native input.",
            object(
                json!({"key":key,"runId":id,"decisionId":id,"expectedRevision":revision,"answer":{"type":"string","minLength":1,"maxLength":2048}}),
                &["key", "runId", "decisionId", "expectedRevision", "answer"],
            ),
            false,
        ),
        (
            "nesvo_cancel_decision",
            "Withdraw a pending question at its exact revision, retaining a reason. The current worker may withdraw its own question; addressed authority may cancel. Canceled is not approval: report a non-success result and deliberately retry rather than claiming success.",
            object(
                json!({"key":key,"runId":id,"decisionId":id,"expectedRevision":revision,"reason":{"type":"string","minLength":1,"maxLength":2048}}),
                &["key", "runId", "decisionId", "expectedRevision", "reason"],
            ),
            false,
        ),
        (
            "nesvo_read_inbox",
            "Read up to eight durable messages, without ACK or input. Worker defaults to its own current attempt; owner/coordinator defaults to the run coordinator mailbox. Optional attemptId inspects a worker mailbox. Pending messages repeat until explicit ACK. After consumer restart read from zero; cursors paginate, not acknowledge.",
            object(
                json!({"runId":id,"attemptId":id,"after":cursor,"includeAcked":{"type":"boolean","default":false}}),
                &["runId"],
            ),
            true,
        ),
        (
            "nesvo_send_message",
            "Persist one addressed message for a stable key/correlation. Optional attemptId targets a current worker; omission addresses the coordinator. Workers may send only to their own coordinator. Host supplies authenticated sender. Questions are messages, not approval/decision grants. No PTY/LLM execution. Recover uncertainty through nesvo_get_run_mutation with the original key.",
            object(
                json!({"key":key,"runId":id,"attemptId":id,"correlationId":key,"kind":{"enum":["note","question","error"],"default":"note"},"body":{"type":"string","minLength":1,"maxLength":4096}}),
                &["key", "runId", "correlationId", "body"],
            ),
            false,
        ),
        (
            "nesvo_ack_messages",
            "ACK 1–32 exact IDs in the receiving mailbox. Worker defaults to its own attempt; coordinator to its run inbox. Coordinator cannot ACK on behalf of a worker; owner may explicitly override. Retry the same IDs after loss: first ACK identity/time are preserved. ACK is delivery only, never task execution or validation.",
            object(
                json!({"runId":id,"attemptId":id,"ids":{"type":"array","minItems":1,"maxItems":32,"uniqueItems":true,"items":id}}),
                &["runId", "ids"],
            ),
            false,
        ),
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
            "nesvo_activate_run",
            "Freeze a nonempty draft DAG at an expected revision. Does not start any process or send prompts.",
            object(
                json!({"key":key,"runId":id,"expectedRevision":revision}),
                &["key", "runId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_assign_task",
            "Bind one existing worker process to a dependency-ready task. Only host-granted children for coordinators. Refuses human control/drafts/pending input. No prompt is sent. Retain the returned attempt identity; one process per attempt.",
            object(
                json!({"key":key,"runId":id,"taskId":id,"sessionId":id,"expectedRevision":revision}),
                &["key", "runId", "taskId", "sessionId", "expectedRevision"],
            ),
            false,
        ),
        (
            "nesvo_get_task_attempts",
            "Read a task and four retained attempts per page. Owner/coordinator only. Follow nextOffset; reported success remains unvalidated until separately accepted.",
            object(
                json!({"runId":id,"taskId":id,"offset":{"type":"integer","minimum":0,"maximum":16}}),
                &["runId", "taskId"],
            ),
            true,
        ),
        (
            "nesvo_get_current_task",
            "Read this authenticated worker's current task and attempt. Never uses UI focus or environment identity hints. A superseded attempt is refused.",
            object(json!({}), &[]),
            true,
        ),
        (
            "nesvo_report_task_result",
            "Report this worker's exact current attempt result. Include files/artifacts/checks/limitations, using empty arrays when none. Claims are not verification or validation. Reuse the original key after uncertainty; stale senders/replacement reports are refused. Result bound 4 KiB UTF-8.",
            object(
                json!({"key":key,"attemptId":id,"result":{"type":"object","additionalProperties":false,"required":["outcome","summary","files","artifacts","checks","limitations"],"properties":{"outcome":{"enum":["succeeded","failed","blocked","canceled"]},"summary":{"type":"string","minLength":1,"maxLength":2048},"files":strings(32),"artifacts":strings(16),"checks":checks,"limitations":strings(16)}}}),
                &["key", "attemptId", "result"],
            ),
            false,
        ),
        (
            "nesvo_validate_task_result",
            "Record owner/coordinator attestation of the current reported result. Success needs a succeeded report and passed validation checks. The host records evidence, without executing checks. Accepted results release dependencies; idle never does. Validation bound 2 KiB UTF-8.",
            object(
                json!({"key":key,"runId":id,"attemptId":id,"expectedRevision":revision,"validation":{"type":"object","additionalProperties":false,"required":["passed","summary","checks"],"properties":{"passed":{"type":"boolean"},"summary":{"type":"string","minLength":1,"maxLength":1024},"checks":checks}}}),
                &[
                    "key",
                    "runId",
                    "attemptId",
                    "expectedRevision",
                    "validation",
                ],
            ),
            false,
        ),
        (
            "nesvo_create_run",
            "Create a durable draft run once for a stable key. No agent or task is started; scoped coordinators are bound by the host.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"spec":{"type":"object","additionalProperties":false,"required":["title","goal"],"properties":{"title":{"type":"string","minLength":1,"maxLength":80},"goal":{"type":"string","minLength":1,"maxLength":8192},"coordinatorSessionId":{"type":["string","null"]}}}}),
                &["key", "spec"],
            ),
            false,
        ),
        (
            "nesvo_list_runs",
            "List a bounded page of visible workflow summaries. Follow nextOffset; does not expose goal/instruction text.",
            object(
                json!({"offset":{"type":"integer","minimum":0,"maximum":1024,"default":0}}),
                &[],
            ),
            true,
        ),
        (
            "nesvo_get_run",
            "Read a visible run and its draft DAG by stable run ID. Planned/dependency-ready never means executed or successful.",
            object(json!({"runId":id}), &["runId"]),
            true,
        ),
        (
            "nesvo_set_run_plan",
            "Atomically replace a draft DAG at an expected revision. Task keys retain IDs. Dependencies are task keys, not names. Cycles/missing edges are refused. Reuse the original key after uncertainty.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128},"runId":id,"expectedRevision":{"type":"integer","minimum":1},"tasks":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["key","title","instruction"],"properties":{"key":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},"title":{"type":"string","minLength":1,"maxLength":80},"instruction":{"type":"string","minLength":1,"maxLength":8192},"dependencies":{"type":"array","maxItems":64,"items":{"type":"string"}}}}}}),
                &["key", "runId", "expectedRevision", "tasks"],
            ),
            false,
        ),
        (
            "nesvo_get_run_mutation",
            "Recover the historical result of your workflow metadata mutation by its original key. Separate from native process-operation receipts; never starts an agent.",
            object(
                json!({"key":{"type":"string","minLength":1,"maxLength":128}}),
                &["key"],
            ),
            true,
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
        Tool::new(name,description,schema).with_annotations(ToolAnnotations::new().read_only(read_only).destructive(matches!(name,"nesvo_interrupt_session"|"nesvo_stop_session"|"nesvo_stop_run"|"nesvo_cancel_run")).idempotent(true).open_world(!read_only))
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
        "nesvo_deliver_task" | "nesvo_cancel_task_delivery" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Delivery arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Delivery action is selected by the tool name",
                ));
            }
            fields.insert(
                "action".into(),
                if name == "nesvo_deliver_task" {
                    "queue"
                } else {
                    "cancel"
                }
                .into(),
            );
            (
                crate::workflow::tool("delivery", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_launch_task" => (
            crate::workflow::tool("launch", json!({"request":arguments}))?,
            "workflow",
        ),
        "nesvo_stop_run" | "nesvo_cancel_run" | "nesvo_get_run_control" => {
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
            if name == "nesvo_get_run_control" {
                fields.insert("action".into(), "get".into());
            } else {
                fields.insert("action".into(), "start".into());
                fields.insert(
                    "kind".into(),
                    if name == "nesvo_stop_run" {
                        "stop"
                    } else {
                        "cancel"
                    }
                    .into(),
                );
            }
            (
                crate::workflow::tool("control", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_get_host_budget"
        | "nesvo_set_host_budget"
        | "nesvo_get_run_budget"
        | "nesvo_set_run_budget" => {
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Budget arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Budget action is selected by the tool name",
                ));
            }
            fields.insert(
                "action".into(),
                if matches!(name, "nesvo_get_host_budget" | "nesvo_get_run_budget") {
                    "get"
                } else {
                    "set"
                }
                .into(),
            );
            (
                crate::workflow::tool(
                    if name.contains("host_budget") {
                        "hostBudget"
                    } else {
                        "runBudget"
                    },
                    json!({"request":fields}),
                )?,
                "workflow",
            )
        }
        "nesvo_drain_run" | "nesvo_resume_run" => (
            crate::workflow::tool(
                if name == "nesvo_drain_run" {
                    "drain"
                } else {
                    "resume"
                },
                arguments,
            )?,
            "workflow",
        ),
        "nesvo_ask_decision"
        | "nesvo_list_decisions"
        | "nesvo_get_decision"
        | "nesvo_answer_decision"
        | "nesvo_cancel_decision" => {
            let action = match name {
                "nesvo_ask_decision" => "ask",
                "nesvo_list_decisions" => "list",
                "nesvo_get_decision" => "get",
                "nesvo_answer_decision" => "answer",
                _ => "cancel",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Decision arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Decision action is selected by the tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("decision", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_read_inbox" | "nesvo_send_message" | "nesvo_ack_messages" => {
            let action = match name {
                "nesvo_read_inbox" => "read",
                "nesvo_send_message" => "send",
                _ => "ack",
            };
            let mut fields = arguments
                .as_object()
                .ok_or_else(|| {
                    cli::failure("invalid_argument", "Inbox arguments must be an object")
                })?
                .clone();
            if fields.contains_key("action") {
                return Err(cli::failure(
                    "invalid_argument",
                    "Inbox action is selected by the tool name",
                ));
            }
            fields.insert("action".into(), action.into());
            (
                crate::workflow::tool("inbox", json!({"request":fields}))?,
                "workflow",
            )
        }
        "nesvo_create_run"
        | "nesvo_list_runs"
        | "nesvo_get_run"
        | "nesvo_set_run_plan"
        | "nesvo_get_run_mutation"
        | "nesvo_activate_run"
        | "nesvo_assign_task"
        | "nesvo_get_task_attempts"
        | "nesvo_get_current_task"
        | "nesvo_report_task_result"
        | "nesvo_validate_task_result" => {
            let action = match name {
                "nesvo_create_run" => "create",
                "nesvo_list_runs" => "list",
                "nesvo_get_run" => "get",
                "nesvo_set_run_plan" => "setPlan",
                "nesvo_activate_run" => "activate",
                "nesvo_assign_task" => "assign",
                "nesvo_get_task_attempts" => "task",
                "nesvo_get_current_task" => "context",
                "nesvo_report_task_result" => "report",
                "nesvo_validate_task_result" => "validate",
                _ => "mutation",
            };
            (crate::workflow::tool(action, arguments)?, "workflow")
        }
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
        if kind == "workflow" {
            crate::workflow::capability(&mut connection, &command).await?;
        } else if matches!(name, "nesvo_interrupt_session" | "nesvo_stop_session") {
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
        assert_eq!(catalog().len(), 44);
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
        let (literal, kind) = command(
            "nesvo_create_session",
            json!({"key":"k","spec":{"name":"n","prompt":"$(literal) `literal` łódź"}}),
        )
        .unwrap();
        assert_eq!(kind, "operation");
        assert_eq!(literal["spec"]["prompt"], "$(literal) `literal` łódź");
    }
}
