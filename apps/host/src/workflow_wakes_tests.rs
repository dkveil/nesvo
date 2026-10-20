use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, report, worker},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_wakes::{self, Guard, Reply, Work},
};
use serde_json::{Value, json};

fn actor(owner: bool) -> Actor {
    Actor {
        issuer: if owner { "owner" } else { "coordinator" }.into(),
        scope: if owner {
            Scope::Owner
        } else {
            Scope::Coordinator("coordinator".into())
        },
    }
}
fn manage(
    store: &mut Store,
    owner: bool,
    request: Value,
) -> anyhow::Result<(Value, Option<Guard>)> {
    match workflow_wakes::execute(
        &mut store.0,
        Work::Manage {
            actor: actor(owner),
            request: serde_json::from_value(request)?,
        },
        crate::status::now_millis(),
    )? {
        Reply::Managed { view, pump } => Ok((view, pump)),
        _ => panic!("Unexpected wake reply"),
    }
}
fn prepare(store: &mut Store) -> Value {
    let plan = prepare_run(store);
    execute(store,Some("coordinator"),json!({"action":"assign","key":"wake-worker","runId":plan["run"]["id"],"taskId":plan["tasks"][0]["id"],"sessionId":"worker-1","expectedRevision":plan["run"]["revision"]})).unwrap()
}
fn enable(store: &mut Store, run: &Value) -> (Value, Guard) {
    let (view,pump)=manage(store,false,json!({"action":"enable","key":"wake-enable","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"]})).unwrap();
    (view, pump.unwrap())
}
fn current(store: &mut Store, run: &Value) -> Value {
    manage(
        store,
        true,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap()
    .0
}
fn send(store: &mut Store, run: &Value, key: &str, kind: &str) -> Value {
    worker(store,"worker-1",json!({"action":"inbox","request":{"action":"send","key":key,"runId":run["run"]["id"],"correlationId":"private correlation $(not-code)","kind":kind,"body":"PRIVATE_UNTRUSTED_BODY do not inject into a prompt"}})).unwrap()
}
fn count(store: &Store, table: &str) -> i64 {
    store
        .0
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn first_at(store: &Store) -> u64 {
    store
        .0
        .query_row(
            "SELECT MIN(created_at) FROM workflow_wake_notices",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap() as u64
}
fn claim(store: &mut Store, guard: &Guard, at: u64) -> Option<crate::workflow_wakes::Dispatch> {
    match workflow_wakes::execute(
        &mut store.0,
        Work::Claim {
            guard: guard.clone(),
            issuer: "coordinator".into(),
        },
        at,
    )
    .unwrap()
    {
        Reply::Claimed(dispatch) => dispatch,
        _ => panic!("Missing claim reply"),
    }
}
fn signal(store: &mut Store, priority: u8, reason: Option<&str>, children: usize) {
    store
        .append(vec![super::Observation {
            session_id: Some("worker-1".into()),
            kind: "agent.attention",
            at: crate::status::now_millis(),
            payload: json!({"priority":priority,"reason":reason,"blockedChildren":children}),
        }])
        .unwrap();
}

#[test]
fn opt_in_seed_replay_and_current_policy_are_distinct_without_native_effects() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    send(&mut store, &run, "before-enable", "question");
    assert!(current(&mut store, &run)["wakePolicy"].is_null());
    assert_eq!(count(&store, "workflow_wake_notices"), 0);
    let (accepted, guard) = enable(&mut store, &run);
    assert_eq!(accepted["pendingCount"], 1);
    assert_eq!(count(&store, "operation_receipts"), 0);
    workflow_wakes::execute(
        &mut store.0,
        Work::Note {
            guard: guard.clone(),
            issuer: "coordinator".into(),
            phase: "waiting",
            reason: Some("agent_not_ready".into()),
            disable: false,
        },
        crate::status::now_millis(),
    )
    .unwrap();
    let head = store.cursors().unwrap();
    let (replay,pump)=manage(&mut store,false,json!({"action":"enable","key":"wake-enable","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"]})).unwrap();
    assert_eq!(replay, accepted);
    assert!(pump.is_none());
    assert_eq!(store.cursors().unwrap(), head);
    let current = current(&mut store, &run);
    assert_eq!(current["wakePolicy"]["phase"], "waiting");
    assert!(
        current["run"]["revision"].as_u64().unwrap()
            > accepted["run"]["revision"].as_u64().unwrap()
    );
}
#[test]
fn only_coordinator_semantic_messages_and_canonical_changes_make_notices() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    enable(&mut store, &run);
    send(&mut store, &run, "note", "note");
    assert_eq!(count(&store, "workflow_wake_notices"), 0);
    execute(&mut store,Some("coordinator"),json!({"action":"inbox","request":{"action":"send","key":"worker-mail","runId":run["run"]["id"],"attemptId":run["tasks"][0]["currentAttempt"]["id"],"correlationId":"worker","kind":"question","body":"For worker only"}})).unwrap();
    assert_eq!(count(&store, "workflow_wake_notices"), 0);
    send(&mut store, &run, "question", "question");
    send(&mut store, &run, "error", "error");
    signal(&mut store, 0, None, 0);
    assert_eq!(count(&store, "workflow_wake_notices"), 2);
    signal(&mut store, 2, Some("permission"), 0);
    signal(&mut store, 2, Some("permission"), 0);
    assert_eq!(count(&store, "workflow_wake_notices"), 3);
    signal(&mut store, 2, Some("child"), 2);
    signal(&mut store, 0, None, 0);
    assert_eq!(count(&store, "workflow_wake_notices"), 5);
    let request = json!({"action":"report","key":"report","attemptId":run["tasks"][0]["currentAttempt"]["id"],"result":report()});
    worker(&mut store, "worker-1", request.clone()).unwrap();
    worker(&mut store, "worker-1", request).unwrap();
    assert_eq!(count(&store, "workflow_wake_notices"), 6);
    let references = current(&mut store, &run)["notices"].to_string();
    assert!(!references.contains("PRIVATE_UNTRUSTED_BODY"));
    assert!(!references.contains("private correlation"));
    assert_eq!(count(&store, "operation_receipts"), 0);
}
#[test]
fn wake_claim_coalesces_eight_exact_references_without_ack_or_task_success() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (_, guard) = enable(&mut store, &run);
    for n in 0..10 {
        send(&mut store, &run, &format!("question-{n}"), "question");
    }
    let at = first_at(&store);
    assert!(claim(&mut store, &guard, at + 249).is_none());
    let dispatch = claim(&mut store, &guard, at + 1000).unwrap();
    assert!(dispatch.prompt.len() < 2048);
    assert!(dispatch.prompt.contains(&dispatch.batch_id));
    assert!(!dispatch.prompt.contains("PRIVATE_UNTRUSTED_BODY"));
    assert_eq!(dispatch.receipt.phase, "accepted");
    assert_eq!(count(&store, "operation_receipts"), 1);
    error(
        workflow_wakes::execute(
            &mut store.0,
            Work::Claim {
                guard: guard.clone(),
                issuer: "coordinator".into(),
            },
            at + 2000,
        )
        .map(|_| ()),
        "submission_pending",
    );
    let batch = manage(
        &mut store,
        false,
        json!({"action":"batch","runId":run["run"]["id"],"batchId":dispatch.batch_id}),
    )
    .unwrap()
    .0;
    assert_eq!(batch["wakeBatch"]["notices"].as_array().unwrap().len(), 8);
    assert!(batch["wakeBatch"]["notices"][0]["reference"]["messageSequence"].is_number());
    assert_eq!(current(&mut store, &run)["pendingCount"], 2);
    let inbox = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"inbox","request":{"action":"read","runId":run["run"]["id"]}}),
    )
    .unwrap();
    assert_eq!(inbox["pendingCount"], 10);
    let current_run = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    assert_eq!(current_run["tasks"][0]["state"], "assigned");
    assert!(current_run["tasks"][0]["taskResult"].is_null());
    assert_eq!(current_run["tasks"][1]["state"], "planned");
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase='settled',result='{}' WHERE id=?1",
            [&dispatch.receipt.id],
        )
        .unwrap();
    workflow_wakes::execute(
        &mut store.0,
        Work::Finish {
            batch_id: dispatch.batch_id,
        },
        at + 2000,
    )
    .unwrap();
    let second = claim(&mut store, &guard, at + 3000).unwrap();
    assert_ne!(second.receipt.id, dispatch.receipt.id);
    assert_eq!(current(&mut store, &run)["pendingCount"], 0);
}
#[test]
fn provenance_and_native_receipt_roll_back_together_and_reads_do_not_retry() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (_, guard) = enable(&mut store, &run);
    send(&mut store, &run, "question", "question");
    store.0.execute_batch("CREATE TRIGGER fail_wake BEFORE INSERT ON workflow_wake_batches BEGIN SELECT RAISE(ABORT,'injected wake failure'); END;").unwrap();
    let head = store.cursors().unwrap();
    let at = first_at(&store) + 1000;
    assert!(
        workflow_wakes::execute(
            &mut store.0,
            Work::Claim {
                guard: guard.clone(),
                issuer: "coordinator".into()
            },
            at
        )
        .is_err()
    );
    assert_eq!(store.cursors().unwrap(), head);
    assert_eq!(count(&store, "operation_receipts"), 0);
    assert_eq!(count(&store, "workflow_wake_batches"), 0);
    assert_eq!(current(&mut store, &run)["pendingCount"], 1);
    store.0.execute_batch("DROP TRIGGER fail_wake").unwrap();
    let batch = claim(&mut store, &guard, at).unwrap();
    store.0.execute("UPDATE operation_receipts SET phase='unknown',result='{\"code\":\"partial_input\",\"effectStarted\":true}' WHERE id=?1",[&batch.receipt.id]).unwrap();
    workflow_wakes::execute(
        &mut store.0,
        Work::Finish {
            batch_id: batch.batch_id.clone(),
        },
        at + 1,
    )
    .unwrap();
    let paused = current(&mut store, &run);
    assert_eq!(paused["wakePolicy"]["enabled"], false);
    assert_eq!(paused["pendingCount"], 0);
    let (_,new)=manage(&mut store,true,json!({"action":"enable","key":"fresh-authority","runId":run["run"]["id"],"expectedRevision":paused["run"]["revision"]})).unwrap();
    let new = new.unwrap();
    assert!(matches!(
        workflow_wakes::execute(
            &mut store.0,
            Work::Claim {
                guard: new,
                issuer: "owner".into()
            },
            at + 2000
        )
        .unwrap(),
        Reply::Claimed(None)
    ));
    assert_eq!(count(&store, "operation_receipts"), 1);
    assert_eq!(count(&store, "workflow_wake_batches"), 1);
}
#[test]
fn stale_generation_and_owner_receipt_pointer_do_not_grant_authority() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (started, guard) = enable(&mut store, &run);
    let disabled=manage(&mut store,true,json!({"action":"disable","key":"disable","runId":run["run"]["id"],"expectedRevision":started["run"]["revision"]})).unwrap().0;
    error(
        workflow_wakes::execute(
            &mut store.0,
            Work::Claim {
                guard: guard.clone(),
                issuer: "coordinator".into(),
            },
            crate::status::now_millis(),
        )
        .map(|_| ()),
        "wake_paused",
    );
    let (_,new)=manage(&mut store,true,json!({"action":"enable","key":"owner-enable","runId":run["run"]["id"],"expectedRevision":disabled["run"]["revision"]})).unwrap();
    let new = new.unwrap();
    error(
        workflow_wakes::guard(&store.0, &new, "coordinator").map(|_| ()),
        "wake_paused",
    );
    send(&mut store, &run, "new-message", "question");
    let at = first_at(&store) + 1000;
    let Reply::Claimed(Some(dispatch)) = workflow_wakes::execute(
        &mut store.0,
        Work::Claim {
            guard: new,
            issuer: "owner".into(),
        },
        at,
    )
    .unwrap() else {
        panic!("Owner claim")
    };
    assert!(
        store
            .0
            .query_row(
                "SELECT issuer FROM operation_receipts WHERE id=?1",
                [&dispatch.receipt.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap()
            == "owner"
    );
    let coordinator_batch = manage(
        &mut store,
        false,
        json!({"action":"batch","runId":run["run"]["id"],"batchId":dispatch.batch_id}),
    )
    .unwrap()
    .0;
    assert_eq!(
        coordinator_batch["wakeBatch"]["receiptId"],
        dispatch.receipt.id
    );
    assert!(
        crate::receipts::get(
            &store.0,
            "coordinator",
            false,
            Some(&dispatch.receipt.id),
            None
        )
        .is_err()
    );
    let worker_actor = Actor {
        issuer: "worker-1".into(),
        scope: Scope::Worker("worker-1".into()),
    };
    error(
        workflow_wakes::execute(
            &mut store.0,
            Work::Manage {
                actor: worker_actor,
                request: serde_json::from_value(json!({"action":"get","runId":run["run"]["id"]}))
                    .unwrap(),
            },
            crate::status::now_millis(),
        )
        .map(|_| ()),
        "forbidden",
    );
}
#[test]
fn failed_old_batch_cannot_disable_a_deliberately_enabled_new_generation() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (_, guard) = enable(&mut store, &run);
    send(&mut store, &run, "question", "question");
    let at = first_at(&store) + 1000;
    let dispatch = claim(&mut store, &guard, at).unwrap();
    let before = current(&mut store, &run);
    let disabled=manage(&mut store,false,json!({"action":"disable","key":"disable","runId":run["run"]["id"],"expectedRevision":before["run"]["revision"]})).unwrap().0;
    let enabled=manage(&mut store,true,json!({"action":"enable","key":"enable-again","runId":run["run"]["id"],"expectedRevision":disabled["run"]["revision"]})).unwrap().0;
    store.0.execute("UPDATE operation_receipts SET phase='failed',result='{\"effectStarted\":false}' WHERE id=?1",[dispatch.receipt.id]).unwrap();
    workflow_wakes::execute(
        &mut store.0,
        Work::Finish {
            batch_id: dispatch.batch_id,
        },
        at + 1,
    )
    .unwrap();
    let after = current(&mut store, &run);
    assert_eq!(after["wakePolicy"]["enabled"], true);
    assert_eq!(
        after["wakePolicy"]["generation"],
        enabled["wakePolicy"]["generation"]
    );
}
#[test]
fn restart_pauses_authority_and_retains_known_settlement_without_effect_replay() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (accepted, guard) = enable(&mut store, &run);
    send(&mut store, &run, "question", "question");
    let at = first_at(&store) + 1000;
    let dispatch = claim(&mut store, &guard, at).unwrap();
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase='settled',result='{}' WHERE id=?1",
            [&dispatch.receipt.id],
        )
        .unwrap();
    workflow_wakes::recover(&mut store.0).unwrap();
    let after = current(&mut store, &run);
    assert_eq!(after["wakePolicy"]["phase"], "paused");
    assert_eq!(after["wakePolicy"]["generation"], 2);
    let batch = manage(
        &mut store,
        true,
        json!({"action":"batch","runId":run["run"]["id"],"batchId":dispatch.batch_id}),
    )
    .unwrap()
    .0;
    assert_eq!(batch["wakeBatch"]["phase"], "settled");
    let (replay,pump)=manage(&mut store,false,json!({"action":"enable","key":"wake-enable","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"]})).unwrap();
    assert_eq!(replay, accepted);
    assert!(pump.is_none());
    assert_eq!(count(&store, "operation_receipts"), 1);
}

#[test]
fn quiet_poll_and_identical_wait_state_do_not_churn_revisions_or_events() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (_, guard) = enable(&mut store, &run);
    let at = crate::status::now_millis();
    let note = || Work::Note {
        guard: guard.clone(),
        issuer: "coordinator".into(),
        phase: "waiting",
        reason: Some("no_new_notices".into()),
        disable: false,
    };
    workflow_wakes::execute(&mut store.0, note(), at).unwrap();
    let before = current(&mut store, &run);
    let head = store.cursors().unwrap();
    for _ in 0..5 {
        workflow_wakes::execute(&mut store.0, note(), at + 100).unwrap();
        let Reply::Snapshot(Some(snapshot)) = workflow_wakes::execute(
            &mut store.0,
            Work::Poll {
                guard: guard.clone(),
                issuer: "coordinator".into(),
            },
            at + 100,
        )
        .unwrap() else {
            panic!("Quiet policy snapshot")
        };
        assert_eq!(snapshot.pending, 0);
        assert!(!snapshot.active_batch);
    }
    assert_eq!(store.cursors().unwrap(), head);
    assert_eq!(current(&mut store, &run), before);
    assert_eq!(count(&store, "operation_receipts"), 0);
}

#[test]
fn polling_persists_elapsed_exhaustion_so_clock_regression_cannot_reopen_input() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let run = execute(
        &mut store,
        None,
        json!({"action":"runBudget","request":{
            "action":"set","key":"wake-time-budget","runId":run["run"]["id"],
            "expectedRevision":run["run"]["revision"],
            "limits":{"maxParallel":8,"maxAttemptsPerTask":16,"maxElapsedMs":1000}
        }}),
    )
    .unwrap();
    let started = run["policy"]["startedAt"].as_u64().unwrap();
    let (_, guard) = enable(&mut store, &run);
    send(&mut store, &run, "question", "question");
    let Reply::Snapshot(Some(snapshot)) = workflow_wakes::execute(
        &mut store.0,
        Work::Poll {
            guard: guard.clone(),
            issuer: "coordinator".into(),
        },
        started + 1000,
    )
    .unwrap() else {
        panic!("Expired policy snapshot")
    };
    assert!(snapshot.time_exhausted);
    assert_eq!(snapshot.pending, 1);
    let head = store.cursors().unwrap();
    let Reply::Snapshot(Some(snapshot)) = workflow_wakes::execute(
        &mut store.0,
        Work::Poll {
            guard: guard.clone(),
            issuer: "coordinator".into(),
        },
        started,
    )
    .unwrap() else {
        panic!("Clock-regressed snapshot")
    };
    assert!(snapshot.time_exhausted);
    error(
        workflow_wakes::execute(
            &mut store.0,
            Work::Claim {
                guard,
                issuer: "coordinator".into(),
            },
            started + 1,
        )
        .map(|_| ()),
        "time_budget_exhausted",
    );
    assert_eq!(count(&store, "operation_receipts"), 0);
    assert_eq!(store.cursors().unwrap(), head);
}

#[test]
fn reopening_store_retains_unknown_batch_and_never_rearms_accepted_enable() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-wake-reopen-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let run = prepare(&mut store);
    let (accepted, guard) = enable(&mut store, &run);
    send(&mut store, &run, "question", "question");
    let at = first_at(&store) + 1000;
    let dispatch = claim(&mut store, &guard, at).unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let after = current(&mut store, &run);
    assert_eq!(after["wakePolicy"]["enabled"], false);
    assert_eq!(after["wakePolicy"]["reason"], "host_restart");
    assert_eq!(after["pendingCount"], 0);
    let batch = manage(
        &mut store,
        false,
        json!({"action":"batch","runId":run["run"]["id"],"batchId":dispatch.batch_id}),
    )
    .unwrap()
    .0;
    assert_eq!(batch["wakeBatch"]["phase"], "unknown");
    let (replay, pump) = manage(&mut store, false, json!({"action":"enable","key":"wake-enable","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"]})).unwrap();
    assert_eq!(replay, accepted);
    assert!(pump.is_none());
    assert_eq!(count(&store, "operation_receipts"), 1);
    error(
        workflow_wakes::guard(&store.0, &guard, "coordinator").map(|_| ()),
        "wake_paused",
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn exit_without_report_is_missing_result_while_reported_clean_exit_is_not_task_success() {
    for reported in [false, true] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let run = prepare(&mut store);
        if reported {
            worker(&mut store, "worker-1", json!({"action":"report","key":"worker-report","attemptId":run["tasks"][0]["currentAttempt"]["id"],"result":report()})).unwrap();
        }
        let run = current(&mut store, &run);
        enable(&mut store, &run);
        let before = count(&store, "workflow_wake_notices");
        store.append(vec![super::Observation {
            session_id: Some("worker-1".into()), kind: "agent.attention", at: crate::status::now_millis(),
            payload: json!({"priority":0,"reason":null,"blockedChildren":0,"processExited":true,"exitCode":0}),
        }]).unwrap();
        let after = current(&mut store, &run);
        assert_eq!(
            count(&store, "workflow_wake_notices"),
            before + i64::from(!reported)
        );
        if !reported {
            assert_eq!(
                after["notices"][0]["reference"]["attention"]["reason"],
                "missing_result"
            );
        }
        let task = execute(
            &mut store,
            None,
            json!({"action":"get","runId":run["run"]["id"]}),
        )
        .unwrap();
        assert_eq!(
            task["tasks"][0]["state"],
            if reported { "reported" } else { "assigned" }
        );
        assert!(task["tasks"][0]["taskResult"].is_null());
        assert_eq!(task["tasks"][1]["state"], "planned");
    }
}

#[test]
fn notice_retention_refusal_rolls_back_report_and_invalid_boundaries_leave_no_effect() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare(&mut store);
    let (_, guard) = enable(&mut store, &run);
    error(
        manage(
            &mut store,
            false,
            json!({"action":"get","runId":run["run"]["id"],"after":1}),
        )
        .map(|_| ()),
        "invalid_cursor",
    );
    assert!(serde_json::from_value::<workflow_wakes::Request>(json!({"action":"enable","key":"forged","runId":run["run"]["id"],"expectedRevision":1,"coordinatorSessionId":"forged"})).is_err());
    store.0.execute("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<8192) INSERT INTO workflow_wake_notices(id,run_id,source_key,kind,data,created_at) SELECT 'retention-'||i,?1,'fixture-retention-'||i,'question','{}',1 FROM n", [run["run"]["id"].as_str().unwrap()]).unwrap();
    let head = store.cursors().unwrap();
    let messages = count(&store, "workflow_messages");
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"full-retention-report","attemptId":run["tasks"][0]["currentAttempt"]["id"],"result":report()}),
        ),
        "busy",
    );
    assert_eq!(store.cursors().unwrap(), head);
    assert_eq!(count(&store, "workflow_messages"), messages);
    assert_eq!(count(&store, "workflow_wake_notices"), 8192);
    let task = execute(
        &mut store,
        None,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    assert_eq!(task["tasks"][0]["state"], "assigned");
    assert!(task["tasks"][0]["currentAttempt"]["result"].is_null());
    assert!(workflow_wakes::guard(&store.0, &guard, "coordinator").is_ok());
    assert_eq!(count(&store, "operation_receipts"), 0);
}
