use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, worker},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_delivery::{self, Dispatch, Reply, Request, Work},
    workflow_session_reuse::Live,
};
use serde_json::{Value, json};

const CONVERSATION: &str = "fixture-conversation-a";

fn actor() -> Actor {
    Actor {
        issuer: "coordinator".into(),
        scope: Scope::Coordinator("coordinator".into()),
    }
}
fn current(store: &mut Store, run: &Value) -> Value {
    execute(
        store,
        Some("coordinator"),
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap()
}
fn fresh(view: &Value, key: &str) -> Request {
    serde_json::from_value(json!({"action":"queue","key":key,"runId":view["run"]["id"],"taskId":view["tasks"][0]["id"],"expectedRevision":view["run"]["revision"],"timeoutMs":300000})).unwrap()
}
fn reuse(view: &Value, key: &str, session: &str) -> Request {
    serde_json::from_value(json!({"action":"queue","key":key,"runId":view["run"]["id"],"taskId":view["tasks"][0]["id"],"expectedRevision":view["run"]["revision"],"timeoutMs":1000,"sessionId":session})).unwrap()
}
fn live(blocker: Option<&'static str>, conversation: Option<&str>) -> Live {
    Live {
        blocker,
        conversation: conversation.map(str::to_owned),
    }
}
fn prepared(reply: Reply) -> (Value, bool) {
    match reply {
        Reply::Prepared { view, pending } => (view, pending.is_some()),
        _ => panic!("unexpected"),
    }
}
fn queue_reuse(
    store: &mut Store,
    request: Request,
    observed: Live,
) -> anyhow::Result<(Value, bool)> {
    workflow_delivery::execute(
        &mut store.0,
        Work::Reuse {
            actor: actor(),
            request,
            live: observed,
        },
        20_000,
    )
    .map(prepared)
}
fn claim(
    store: &mut Store,
    id: &str,
    conversation: Option<&str>,
) -> anyhow::Result<Option<Dispatch>> {
    match workflow_delivery::execute(
        &mut store.0,
        Work::Claim {
            id: id.into(),
            conversation: conversation.map(str::to_owned),
        },
        20_010,
    )? {
        Reply::Claimed(dispatch) => Ok(dispatch),
        _ => panic!("unexpected"),
    }
}
fn settle_receipt(store: &mut Store, dispatch: &Dispatch, phase: &str, result: Value) {
    let claimed = crate::receipts::claim(&mut store.0, &dispatch.receipt.id, "coordinator")
        .unwrap()
        .unwrap();
    crate::receipts::finish(
        &mut store.0,
        &claimed.receipt.id,
        "coordinator",
        &claimed.token,
        phase,
        result,
    )
    .unwrap();
}
fn failed_report() -> Value {
    json!({"outcome":"failed","summary":"Worker could not finish","files":[],"artifacts":[],"checks":[],"limitations":["Needs another attempt"]})
}
fn rejected() -> Value {
    json!({"passed":false,"summary":"Explicit coordinator review","checks":[{"name":"review","outcome":"failed","details":"Coordinator attestation"}]})
}
fn delivered(store: &mut Store, conversation: Option<&str>) -> (Value, Value) {
    let plan = prepare_run(store);
    let run = execute(store,Some("coordinator"),json!({"action":"assign","key":"assign","runId":plan["run"]["id"],"taskId":plan["tasks"][0]["id"],"sessionId":"worker","expectedRevision":plan["run"]["revision"]})).unwrap();
    let (accepted, _) = prepared(
        workflow_delivery::execute(
            &mut store.0,
            Work::Prepare {
                actor: actor(),
                request: fresh(&run, "first-delivery"),
            },
            10_000,
        )
        .unwrap(),
    );
    let id = accepted["delivery"]["id"].as_str().unwrap().to_owned();
    let dispatch = claim(store, &id, conversation).unwrap().unwrap();
    settle_receipt(
        store,
        &dispatch,
        "settled",
        json!({"providerPromptObserved":true,"taskResult":null,"sourceSequence":1}),
    );
    workflow_delivery::execute(&mut store.0, Work::Finish { id }, 10_020).unwrap();
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    worker(
        store,
        "worker",
        json!({"action":"report","key":"first-report","attemptId":attempt,"result":failed_report()}),
    )
    .unwrap();
    (run, attempt)
}
fn settled(store: &mut Store, conversation: Option<&str>) -> (Value, Value) {
    let (run, attempt) = delivered(store, conversation);
    let view = current(store, &run);
    execute(store,Some("coordinator"),json!({"action":"validate","key":"reject","runId":run["run"]["id"],"attemptId":attempt,"expectedRevision":view["run"]["revision"],"validation":rejected()})).unwrap();
    (current(store, &run), attempt)
}
fn count(store: &Store, table: &str) -> i64 {
    store
        .0
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
#[test]
fn reuse_delivery_creates_a_new_attempt_on_the_same_worker_without_replaying_old_input() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, first) = settled(&mut store, Some(CONVERSATION));
    assert_eq!(run["tasks"][0]["currentAttempt"]["state"], "failed");
    let receipts = count(&store, "operation_receipts");
    let intent = reuse(&run, "reuse-once", "worker");
    let (accepted, new) =
        queue_reuse(&mut store, intent.clone(), live(None, Some(CONVERSATION))).unwrap();
    assert!(new);
    assert_eq!(accepted["delivery"]["phase"], "queued");
    assert!(accepted["delivery"]["receiptId"].is_null());
    assert_eq!(accepted["delivery"]["reuse"]["previousAttemptId"], first);
    assert_eq!(accepted["delivery"]["reuse"]["sessionId"], "worker");
    let attempt = &accepted["tasks"][0]["currentAttempt"];
    assert_eq!(attempt["ordinal"], 2);
    assert_eq!(attempt["sessionId"], "worker");
    assert_eq!(attempt["state"], "assigned");
    assert_ne!(attempt["id"], first);
    assert_eq!(count(&store, "operation_receipts"), receipts);
    assert_eq!(
        queue_reuse(&mut store, intent, live(Some("control_busy"), None)).unwrap(),
        (accepted.clone(), false)
    );
    let reused: i64 = store
        .0
        .query_row(
            "SELECT count(*) FROM domain_events WHERE kind='run.session_reused' AND json_extract(payload,'$.previousAttemptId')=?1",
            [first.as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reused, 1);
    assert_eq!(accepted["run"]["budget"]["activeAttempts"], 1);
    assert_eq!(
        worker(&mut store, "worker", json!({"action":"context"})).unwrap()["attempt"]["id"],
        attempt["id"]
    );
    let id = accepted["delivery"]["id"].as_str().unwrap();
    let dispatch = claim(&mut store, id, Some(CONVERSATION)).unwrap().unwrap();
    assert_eq!(dispatch.prompt, "private task text");
    assert_eq!(dispatch.receipt.session_id, "worker");
    assert_eq!(count(&store, "operation_receipts"), receipts + 1);
    assert!(claim(&mut store, id, Some(CONVERSATION)).unwrap().is_none());
    let history = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"]}),
    )
    .unwrap();
    let attempts = history["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0]["state"], "failed");
    assert_eq!(attempts[0]["delivery"]["phase"], "sent");
    assert!(attempts[0]["delivery"]["reuse"].is_null());
    assert_eq!(attempts[1]["delivery"]["phase"], "dispatching");
    let view = current(&mut store, &run);
    error(
        queue_reuse(
            &mut store,
            reuse(&view, "reuse-twice", "worker"),
            live(None, Some(CONVERSATION)),
        ),
        "attempt_unsettled",
    );
}
#[test]
fn reuse_delivery_refuses_busy_foreign_mismatched_and_pending_resume_sessions() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = settled(&mut store, Some(CONVERSATION));
    let attempts = count(&store, "workflow_attempts");
    let deliveries = count(&store, "workflow_deliveries");
    for (session, observed, code) in [
        (
            "worker",
            live(Some("control_busy"), Some(CONVERSATION)),
            "session_busy",
        ),
        (
            "worker",
            live(Some("unsafe_draft"), Some(CONVERSATION)),
            "session_busy",
        ),
        (
            "worker",
            live(Some("agent_not_ready"), Some(CONVERSATION)),
            "session_busy",
        ),
        (
            "worker",
            live(Some("submission_pending"), Some(CONVERSATION)),
            "session_busy",
        ),
        (
            "worker",
            live(Some("process_exited"), Some(CONVERSATION)),
            "session_busy",
        ),
        (
            "worker",
            live(Some("resume_pending"), Some(CONVERSATION)),
            "resume_pending",
        ),
        (
            "worker",
            live(Some("resume_failed"), Some(CONVERSATION)),
            "identity_mismatch",
        ),
        (
            "worker",
            live(Some("unsupported"), Some(CONVERSATION)),
            "session_foreign",
        ),
        (
            "worker",
            live(None, Some("fixture-conversation-b")),
            "identity_mismatch",
        ),
        ("worker", live(None, None), "identity_mismatch"),
        (
            "stranger",
            live(None, Some(CONVERSATION)),
            "session_foreign",
        ),
        (
            "coordinator",
            live(None, Some(CONVERSATION)),
            "session_foreign",
        ),
    ] {
        error(
            queue_reuse(&mut store, reuse(&run, "refused", session), observed),
            code,
        );
    }
    error(
        workflow_delivery::execute(
            &mut store.0,
            Work::Prepare {
                actor: actor(),
                request: reuse(&run, "no-live-evidence", "worker"),
            },
            20_000,
        )
        .map(|_| ()),
        "invalid_argument",
    );
    assert_eq!(count(&store, "workflow_attempts"), attempts);
    assert_eq!(count(&store, "workflow_deliveries"), deliveries);
    assert_eq!(count(&store, "workflow_session_reuses"), 0);
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = settled(&mut store, None);
    error(
        queue_reuse(
            &mut store,
            reuse(&run, "unrecorded", "worker"),
            live(None, Some(CONVERSATION)),
        ),
        "identity_mismatch",
    );
}
#[test]
fn reuse_delivery_refuses_unsettled_attempts_deliveries_and_native_input() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = delivered(&mut store, Some(CONVERSATION));
    let view = current(&mut store, &run);
    assert_eq!(view["tasks"][0]["currentAttempt"]["state"], "reported");
    error(
        queue_reuse(
            &mut store,
            reuse(&view, "reported", "worker"),
            live(None, Some(CONVERSATION)),
        ),
        "attempt_unsettled",
    );
    for phase in ["unknown", "dispatching"] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let (run, _) = settled(&mut store, Some(CONVERSATION));
        store
            .0
            .execute("UPDATE workflow_deliveries SET phase=?1", [phase])
            .unwrap();
        error(
            queue_reuse(
                &mut store,
                reuse(&run, "uncertain-delivery", "worker"),
                live(None, Some(CONVERSATION)),
            ),
            "attempt_unsettled",
        );
    }
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = settled(&mut store, Some(CONVERSATION));
    crate::receipts::accept(
        &mut store.0,
        "coordinator",
        "uncertain-send",
        "send",
        json!({"sessionId":"worker","prompt":"other"}),
    )
    .unwrap();
    error(
        queue_reuse(
            &mut store,
            reuse(&run, "uncertain-native", "worker"),
            live(None, Some(CONVERSATION)),
        ),
        "attempt_unsettled",
    );
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = settled(&mut store, Some(CONVERSATION));
    store
        .0
        .execute(
            "UPDATE workflow_run_budget SET limits=?1",
            [json!({"maxParallel":8,"maxAttemptsPerTask":1,"maxElapsedMs":null}).to_string()],
        )
        .unwrap();
    error(
        queue_reuse(
            &mut store,
            reuse(&run, "over-budget", "worker"),
            live(None, Some(CONVERSATION)),
        ),
        "retry_budget_exhausted",
    );
    assert_eq!(count(&store, "workflow_attempts"), 1);
}
#[test]
fn reuse_delivery_claim_refuses_a_changed_conversation_and_restart_keeps_history() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-reuse-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let (run, first) = settled(&mut store, Some(CONVERSATION));
    let (accepted, _) = queue_reuse(
        &mut store,
        reuse(&run, "reuse-restart", "worker"),
        live(None, Some(CONVERSATION)),
    )
    .unwrap();
    let id = accepted["delivery"]["id"].as_str().unwrap().to_owned();
    let receipts = count(&store, "operation_receipts");
    for observed in [Some("fixture-conversation-b"), None] {
        error(
            claim(&mut store, &id, observed).map(|_| ()),
            "identity_mismatch",
        );
    }
    assert_eq!(count(&store, "operation_receipts"), receipts);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let history = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"]}),
    )
    .unwrap();
    let reused = &history["attempts"][1];
    assert_eq!(reused["delivery"]["phase"], "paused");
    assert_eq!(reused["delivery"]["blocker"], "host_restart");
    assert_eq!(reused["delivery"]["reuse"]["previousAttemptId"], first);
    assert!(
        claim(&mut store, &id, Some(CONVERSATION))
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&store, "operation_receipts"), receipts);
    drop(store);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn reuse_delivery_migration_keeps_attempt_history_and_foreign_keys_on_upgrade() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-reuse-legacy-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut legacy = Store::legacy_initialize(&path).unwrap();
    let plan = prepare_run(&mut legacy);
    let run = execute(&mut legacy,Some("coordinator"),json!({"action":"assign","key":"assign","runId":plan["run"]["id"],"taskId":plan["tasks"][0]["id"],"sessionId":"worker","expectedRevision":plan["run"]["revision"]})).unwrap();
    let attempt = run["tasks"][0]["currentAttempt"]["id"].as_str().unwrap();
    legacy
        .0
        .execute_batch(&format!(
            "INSERT INTO workflow_deliveries(id,run_id,attempt_id,issuer,phase,created_at,deadline_at) SELECT 'legacy',t.run_id,a.id,'coordinator','sent',1,2 FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id WHERE a.id='{attempt}';
            INSERT INTO workflow_process_exits(session_id,observed_at) VALUES('worker',5);"
        ))
        .unwrap();
    drop(legacy);
    let store = Store::open(&path).unwrap();
    let foreign: i64 = store
        .0
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(foreign, 0);
    let summary = workflow_delivery::summary(&store.0, attempt).unwrap();
    assert_eq!(summary["id"], "legacy");
    assert!(summary["reuse"].is_null());
    assert_eq!(count(&store, "workflow_process_exits"), 1);
    store
        .0
        .execute("UPDATE workflow_attempts SET state='failed'", [])
        .unwrap();
    store
        .0
        .execute(
            "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) SELECT 'second',task_id,2,session_id,'assigned' FROM workflow_attempts",
            [],
        )
        .unwrap();
    assert!(
        store
            .0
            .execute(
                "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) SELECT 'third',task_id,3,session_id,'assigned' FROM workflow_attempts WHERE id='second'",
                [],
            )
            .is_err(),
        "one session owns at most one open attempt"
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}
