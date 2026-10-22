use super::*;
use serde_json::json;

const SESSION: &str = "5e55105e55105e55105e55105e551051";
const PARENT: &str = "9a7e9a7e9a7e9a7e9a7e9a7e9a7e9a7e";
const RUN: &str = "7a117a117a117a117a117a117a117a11";
const DIGEST: &str = "d165000000000000000000000000000000000000000000000000000000000001";

#[test]
fn capture_current_event_records() {
    let attempt = "a77e0000a77e0000a77e0000a77e0001";
    let none: Option<String> = None;
    let occurrence: Option<&str> = Some("0cc00000000000000000000000000001");
    let code: Option<u32> = Some(0);
    let no_code: Option<u32> = None;
    let program = crate::launchers::Program::Claude;
    let state = crate::status::StatusState::Idle;
    let reason: Option<&'static str> = Some("question");
    let no_reason: Option<&'static str> = None;
    let exit: Option<Option<u32>> = None;
    let exited: Option<Option<u32>> = Some(Some(1));
    let revision_i64: i64 = 7;
    let bytes: usize = 2048;
    let count: usize = 2;
    let journaled: Vec<(Option<&str>, &'static str, Value)> = vec![
        (None, "host.started", json!({"buildId":"0123456789abcdef"})),
        (None, "host.budget_changed", json!({"revision":3u64})),
        (Some(SESSION), "session.created", json!({"program":program,"parentSessionId":Some(PARENT)})),
        (Some(SESSION), "session.created", json!({"program":crate::launchers::Program::Shell,"parentSessionId":none})),
        (Some(SESSION), "session.created", json!({"program":crate::launchers::Program::Codex})),
        (Some(SESSION), "session.closed", json!({})),
        (Some(SESSION), "process.exited", json!({"exitCode":code})),
        (Some(SESSION), "process.exited", json!({"exitCode":no_code})),
        (Some(SESSION), "response.settled", json!({"turnId":"launch:2","taskResult":null})),
        (Some(SESSION), "agent.lifecycle", json!({"event":"Stop","state":state,"generation":2u64,"sourceSequence":17u64,"submissionEvidence":true})),
        (Some(SESSION), "agent.attention", json!({"priority":2u8,"reason":reason,"blockedChildren":1usize,"processExited":exit.is_some(),"exitCode":exit.flatten()})),
        (Some(SESSION), "agent.attention", json!({"priority":0u8,"reason":no_reason,"blockedChildren":0usize,"processExited":exited.is_some(),"exitCode":exited.flatten()})),
        (Some(SESSION), "operation.changed", json!({"operationId":"0be00000000000000000000000000001","phase":"accepted","operation":"send"})),
        (None, "job.changed", json!({"jobId":"0b000000000000000000000000000001","occurrenceId":None::<&str>,"phase":"created"})),
        (None, "job.changed", json!({"jobId":"0b000000000000000000000000000001","occurrenceId":occurrence,"phase":"queued"})),
        (None, "provider.quota_changed", json!({"revision":4u64})),
        (None, "precheck.approval.changed", json!({"approvalId":"a99f0000000000000000000000000001","phase":"revoked"})),
        (None, "job.trigger_changed", json!({"triggerId":"7f160000000000000000000000000001","phase":"rotated"})),
        (None, "job.trigger_delivery", json!({"triggerId":"7f160000000000000000000000000001","deliveryId":"de110000000000000000000000000001","disposition":"queued"})),
        (Some(SESSION), "run.created", json!({"runId":RUN,"revision":json!({"revision":1i64})["revision"]})),
        (Some(SESSION), "run.plan_changed", json!({"runId":RUN,"revision":json!(2i64)})),
        (Some(SESSION), "run.activated", json!({"runId":RUN,"revision":json!(3i64)})),
        (Some(SESSION), "run.attempt_assigned", json!({"runId":RUN,"revision":json!(4i64)})),
        (Some(SESSION), "run.result_reported", json!({"runId":RUN,"revision":json!(5i64)})),
        (Some(SESSION), "run.result_validated", json!({"runId":RUN,"revision":json!(6i64)})),
        (Some(SESSION), "run.draining", json!({"runId":RUN,"revision":json!(7i64)})),
        (Some(SESSION), "run.resumed", json!({"runId":RUN,"revision":json!(8i64)})),
        (Some(SESSION), "run.checkpoint_saved", json!({"runId":RUN,"checkpointId":"c4ec0000000000000000000000000001","sourceRunRevision":9u64})),
        (Some(SESSION), "run.constraints_added", json!({"runId":RUN,"constraintRevision":json!({"revision":1i64})["revision"]})),
        (Some(SESSION), "run.constraints_acknowledged", json!({"runId":RUN,"constraintRevision":json!(1i64)})),
        (Some(SESSION), "run.control_requested", json!({"runId":RUN,"controlId":"c0de0000000000000000000000000001"})),
        (Some(SESSION), "run.control_progress", json!({"runId":RUN,"controlId":"c0de0000000000000000000000000001"})),
        (Some(SESSION), "run.control_completed", json!({"runId":RUN,"controlId":"c0de0000000000000000000000000001"})),
        (Some(SESSION), "run.control_unconfirmed", json!({"runId":RUN,"controlId":"c0de0000000000000000000000000001"})),
        (Some(SESSION), "run.coordinator_rebound", json!({"runId":RUN,"previousSessionId":Some(PARENT),"sessionId":SESSION,"generation":2u64})),
        (Some(SESSION), "run.coordinator_rebound", json!({"runId":RUN,"previousSessionId":none,"sessionId":SESSION,"generation":1u64})),
        (Some(SESSION), "run.decision_asked", json!({"runId":RUN,"decisionId":json!("dec10000000000000000000000000001"),"state":json!("pending")})),
        (Some(SESSION), "run.decision_answered", json!({"runId":RUN,"decisionId":json!("dec10000000000000000000000000001"),"state":json!("answered")})),
        (Some(SESSION), "run.decision_canceled", json!({"runId":RUN,"decisionId":json!("dec10000000000000000000000000001"),"state":json!("canceled")})),
        (Some(SESSION), "run.decisions_expired", json!({"runId":json!({"id":RUN})["id"],"count":count})),
        (Some(SESSION), "run.delivery_changed", json!({"runId":RUN,"deliveryId":"de1e0000000000000000000000000001"})),
        (Some(SESSION), "run.digest_recorded", json!({"runId": RUN, "revision": revision_i64, "state": "completed", "fingerprint": DIGEST, "bytes": bytes})),
        (Some(SESSION), "run.executor_changed", json!({"runId":RUN,"executorId":"e8ec0000000000000000000000000001"})),
        (Some(SESSION), "run.message_sent", json!({"runId":RUN,"messageId":json!("3e550000000000000000000000000001")})),
        (Some(SESSION), "run.messages_acknowledged", json!({"runId":RUN,"count":count})),
        (Some(SESSION), "run.launch_reserved", json!({"runId":RUN,"attemptId":attempt})),
        (Some(SESSION), "run.launch_recovered", json!({"runId":RUN,"attemptId":attempt})),
        (Some(SESSION), "run.launch_observed", json!({"runId":RUN,"attemptId":attempt})),
        (Some(SESSION), "run.workspace_prepared", json!({"runId":RUN,"attemptId":attempt})),
        (Some(SESSION), "run.quota_hold_changed", json!({"runId":RUN,"attemptId":attempt})),
        (Some(SESSION), "run.session_reused", json!({"runId":RUN,"taskId":"7a5c0000000000000000000000000001","attemptId":attempt,"previousAttemptId":"a77e0000a77e0000a77e0000a77e0000","sessionId":PARENT})),
        (Some(SESSION), "run.time_budget_exhausted", json!({"runId":RUN})),
        (Some(SESSION), "run.budget_changed", json!({"runId":RUN})),
        (Some(SESSION), "run.wake_changed", json!({"runId":RUN,"policyId":"9011c000000000000000000000000001"})),
    ];
    let blockers: Vec<&'static str> = vec!["uncommitted changes", "unpushed commits"];
    let branch: Option<String> = Some("nesvo/feature".into());
    let rejected: Vec<(Option<&str>, &'static str, Value)> = vec![
        (None, "workflowTemplatesApproved", json!({"repository":"C:/work/repo","digest":DIGEST})),
        (None, "workflowTemplatesRevoked", json!({"repository":"C:/work/repo","digest":DIGEST})),
        (None, "worktreeSetupApproved", json!({"repository":"C:/work/repo","digest":DIGEST})),
        (None, "worktreeSetupRevoked", json!({"repository":"C:/work/repo","digest":DIGEST})),
        (Some(SESSION), "worktreePrepared", json!({"sessionId":SESSION,"result":"passed","log":"C:/work/repo-wt/.nesvo/setup.log","worktree":"C:/work/repo-wt","digest":DIGEST})),
        (Some(SESSION), "worktreeRan", json!({"sessionId":SESSION,"result":"failed","log":"C:/work/repo-wt/.nesvo/run.log"})),
        (Some(SESSION), "worktreeArchived", json!({"sessionId":SESSION,"worktree":"C:/work/repo-wt","branch":branch,"discarded":true,"blockers":blockers,"branchDeleted":false})),
        (Some(SESSION), "worktreeArchived", json!({"sessionId":SESSION,"worktree":"C:/work/repo-wt","branch":None::<String>,"discarded":false,"blockers":Vec::<&str>::new(),"branchDeleted":true})),
    ];
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let mut lines = Vec::new();
    for (index, (session, kind, payload)) in journaled.into_iter().enumerate() {
        let at = 1_792_783_000_000 + index as u64;
        store
            .append(vec![Observation {
                session_id: session.map(str::to_owned),
                kind,
                at,
                payload,
            }])
            .unwrap();
    }
    let mut after = 0;
    loop {
        let page = store.read(after, 32, None).unwrap();
        for event in &page.events {
            lines.push(serde_json::to_string(event).unwrap());
        }
        after = page.next_cursor;
        if !page.more {
            break;
        }
    }
    for (index, (session, kind, payload)) in rejected.into_iter().enumerate() {
        let at = 1_792_784_000_000 + index as u64;
        let observation = Observation {
            session_id: session.map(str::to_owned),
            kind,
            at,
            payload: payload.clone(),
        };
        assert!(store.append(vec![observation]).is_err(), "{kind} was journaled");
        lines.push(
            serde_json::to_string(&Event {
                sequence: 0,
                session_id: session.map(str::to_owned),
                kind: kind.into(),
                at,
                payload,
            })
            .unwrap(),
        );
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/nesvo-wire/tests/fixtures/events.jsonl");
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
}
