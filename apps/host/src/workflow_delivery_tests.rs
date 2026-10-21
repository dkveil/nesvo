use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_delivery::{self, Reply, Request, Work},
};
use serde_json::{Value, json};
fn actor() -> Actor {
    Actor {
        issuer: "coordinator".into(),
        scope: Scope::Coordinator("coordinator".into()),
    }
}
fn fixture(store: &mut Store) -> Value {
    let plan = prepare_run(store);
    execute(store,Some("coordinator"),json!({"action":"assign","key":"assign","runId":plan["run"]["id"],"taskId":plan["tasks"][0]["id"],"sessionId":"worker","expectedRevision":plan["run"]["revision"]})).unwrap()
}
fn request(view: &Value, key: &str) -> Request {
    serde_json::from_value(json!({"action":"queue","key":key,"runId":view["run"]["id"],"taskId":view["tasks"][0]["id"],"expectedRevision":view["run"]["revision"],"timeoutMs":1000})).unwrap()
}
fn queue(store: &mut Store, request: Request) -> anyhow::Result<(Value, bool)> {
    match workflow_delivery::execute(
        &mut store.0,
        Work::Prepare {
            actor: actor(),
            request,
        },
        10_000,
    )? {
        Reply::Prepared { view, pending } => Ok((view, pending.is_some())),
        _ => panic!("unexpected"),
    }
}
fn summary(store: &Store, view: &Value) -> Value {
    workflow_delivery::summary(
        &store.0,
        view["tasks"][0]["currentAttempt"]["id"].as_str().unwrap(),
    )
    .unwrap()
}
fn claim(store: &mut Store, id: &str) -> Option<crate::workflow_delivery::Dispatch> {
    match workflow_delivery::execute(
        &mut store.0,
        Work::Claim {
            id: id.into(),
            conversation: None,
        },
        10_010,
    )
    .unwrap()
    {
        Reply::Claimed(dispatch) => dispatch,
        _ => panic!("unexpected"),
    }
}
#[test]
fn queuing_and_replay_do_not_allocate_native_effects_and_only_one_claim_wins() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let intent = request(&run, "send-once");
    let (accepted, new) = queue(&mut store, intent.clone()).unwrap();
    assert!(new);
    assert_eq!(accepted["delivery"]["phase"], "queued");
    assert!(accepted["delivery"]["receiptId"].is_null());
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        queue(&mut store, intent).unwrap(),
        (accepted.clone(), false)
    );
    let id = accepted["delivery"]["id"].as_str().unwrap();
    let dispatched = claim(&mut store, id).unwrap();
    assert_eq!(dispatched.prompt, "private task text");
    assert_eq!(dispatched.receipt.session_id, "worker");
    assert!(claim(&mut store, id).is_none());
    assert_eq!(summary(&store, &run)["phase"], "dispatching");
    let current = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    error(
        queue(&mut store, request(&current, "different-key")),
        "delivery_exists",
    );
}
#[test]
fn cancellation_timeout_and_repeated_blockers_never_send_or_spam_events() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (accepted, _) = queue(&mut store, request(&run, "queue")).unwrap();
    let id = accepted["delivery"]["id"].as_str().unwrap();
    workflow_delivery::execute(
        &mut store.0,
        Work::Note {
            id: id.into(),
            code: "agent_not_ready".into(),
        },
        10_002,
    )
    .unwrap();
    let revision: i64 = store
        .0
        .query_row("SELECT revision FROM workflow_runs", [], |r| r.get(0))
        .unwrap();
    for _ in 0..10 {
        workflow_delivery::execute(
            &mut store.0,
            Work::Note {
                id: id.into(),
                code: "agent_not_ready".into(),
            },
            10_003,
        )
        .unwrap();
    }
    assert_eq!(
        store
            .0
            .query_row("SELECT revision FROM workflow_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        revision
    );
    let cancel:Request=serde_json::from_value(json!({"action":"cancel","key":"cancel","runId":run["run"]["id"],"deliveryId":id,"expectedRevision":revision})).unwrap();
    let (canceled, new) = queue(&mut store, cancel).unwrap();
    assert!(!new);
    assert_eq!(canceled["delivery"]["phase"], "canceled");
    assert!(claim(&mut store, id).is_none());
    assert!(summary(&store, &run)["receiptId"].is_null());
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (accepted, _) = queue(&mut store, request(&run, "queue")).unwrap();
    workflow_delivery::execute(
        &mut store.0,
        Work::Claim {
            id: accepted["delivery"]["id"].as_str().unwrap().into(),
            conversation: None,
        },
        11_000,
    )
    .unwrap();
    assert_eq!(summary(&store, &run)["phase"], "expired");
    assert!(summary(&store, &run)["receiptId"].is_null());
}
#[test]
fn native_input_uncertainty_does_not_become_success_or_a_fresh_key_retry() {
    for (phase, result, expected) in [
        (
            "failed",
            json!({"effectStarted":false,"code":"unsafe_draft"}),
            "failed",
        ),
        ("unknown", json!({"effectStarted":true}), "unknown"),
        (
            "settled",
            json!({"providerPromptObserved":true,"taskResult":null,"sourceSequence":1}),
            "sent",
        ),
    ] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let run = fixture(&mut store);
        let (accepted, _) = queue(&mut store, request(&run, "queue")).unwrap();
        let id = accepted["delivery"]["id"].as_str().unwrap();
        let dispatch = claim(&mut store, id).unwrap();
        let claim = crate::receipts::claim(&mut store.0, &dispatch.receipt.id, "coordinator")
            .unwrap()
            .unwrap();
        crate::receipts::finish(
            &mut store.0,
            &claim.receipt.id,
            "coordinator",
            &claim.token,
            phase,
            result,
        )
        .unwrap();
        workflow_delivery::execute(&mut store.0, Work::Finish { id: id.into() }, 10_020).unwrap();
        assert_eq!(summary(&store, &run)["phase"], expected);
        let current = execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"get","runId":run["run"]["id"]}),
        )
        .unwrap();
        assert_eq!(current["tasks"][0]["state"], "assigned");
        assert!(current["tasks"][0]["taskResult"].is_null());
        error(
            queue(&mut store, request(&current, "retry-bypass")),
            "delivery_exists",
        );
    }
}
#[test]
fn claim_rechecks_run_attempt_and_decision_fences_before_a_native_receipt() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (accepted, _) = queue(&mut store, request(&run, "queue")).unwrap();
    let id = accepted["delivery"]["id"].as_str().unwrap();
    store
        .0
        .execute("UPDATE workflow_runs SET state='canceling'", [])
        .unwrap();
    error(
        workflow_delivery::execute(
            &mut store.0,
            Work::Claim {
                id: id.into(),
                conversation: None,
            },
            10_010,
        )
        .map(|_| ()),
        "attempt_state_conflict",
    );
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    store
        .0
        .execute("UPDATE workflow_runs SET state='active'", [])
        .unwrap();
    super::orchestration_tests::worker(&mut store,"worker",json!({"action":"decision","request":{"action":"ask","key":"ask","attemptId":run["tasks"][0]["currentAttempt"]["id"],"question":"Need human decision","audience":"owner","timeoutMs":60000}})).unwrap();
    error(
        workflow_delivery::execute(
            &mut store.0,
            Work::Claim {
                id: id.into(),
                conversation: None,
            },
            10_010,
        )
        .map(|_| ()),
        "decision_pending",
    );
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn restart_pauses_unclaimed_intents_and_keeps_claimed_effects_unknown() {
    for claimed in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "nesvo-delivery-{}.sqlite3",
            hex::encode(crate::wire::random::<8>())
        ));
        let mut store = Store::open(&path).unwrap();
        let run = fixture(&mut store);
        let intent = request(&run, "queue");
        let (accepted, _) = queue(&mut store, intent.clone()).unwrap();
        let id = accepted["delivery"]["id"].as_str().unwrap();
        if claimed {
            claim(&mut store, id).unwrap();
        }
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            summary(&store, &run)["phase"],
            if claimed { "unknown" } else { "paused" }
        );
        assert_eq!(
            queue(&mut store, intent).unwrap(),
            (accepted.clone(), false)
        );
        assert!(claim(&mut store, id).is_none());
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
}
#[test]
fn native_reservation_and_delivery_claim_rollback_together() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (accepted, _) = queue(&mut store, request(&run, "queue")).unwrap();
    let id = accepted["delivery"]["id"].as_str().unwrap();
    store.0.execute_batch("CREATE TRIGGER inject_delivery_failure BEFORE UPDATE OF phase ON workflow_deliveries WHEN NEW.phase='dispatching' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(
        workflow_delivery::execute(
            &mut store.0,
            Work::Claim {
                id: id.into(),
                conversation: None
            },
            10_010
        )
        .is_err()
    );
    assert_eq!(summary(&store, &run)["phase"], "queued");
    assert!(summary(&store, &run)["receiptId"].is_null());
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn invalid_scope_revision_and_timeout_never_commit_an_instruction_intent() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    for (scope, code) in [
        (Scope::Worker("worker".into()), "forbidden"),
        (Scope::Coordinator("foreign".into()), "run_not_found"),
    ] {
        error(
            workflow_delivery::execute(
                &mut store.0,
                Work::Prepare {
                    actor: Actor {
                        issuer: "foreign".into(),
                        scope,
                    },
                    request: request(&run, "invalid-scope"),
                },
                10_000,
            )
            .map(|_| ()),
            code,
        );
    }
    let mut stale = request(&run, "stale");
    if let Request::Queue {
        expected_revision, ..
    } = &mut stale
    {
        *expected_revision = 1;
    }
    error(queue(&mut store, stale), "revision_conflict");
    for timeout in [0, 300_001] {
        let mut intent = request(&run, "invalid-timeout");
        if let Request::Queue { timeout_ms, .. } = &mut intent {
            *timeout_ms = Some(timeout);
        }
        error(queue(&mut store, intent), "invalid_argument");
    }
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM workflow_deliveries", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
