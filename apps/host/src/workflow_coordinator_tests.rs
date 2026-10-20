use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, worker},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_coordinator::{self, Facts, Location, Request, Work},
};
use serde_json::{Value, json};

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
fn location() -> Location {
    Location {
        directory: "canonical workspace łódź".into(),
        group_id: Some("group".into()),
    }
}
fn facts(target: &str) -> Facts {
    Facts {
        target_id: target.into(),
        target: location(),
        previous: Some(location()),
    }
}
fn current(store: &mut Store, run: &str) -> Value {
    execute(store, None, json!({"action":"get","runId":run})).unwrap()
}
fn request(store: &mut Store, run: &str, key: &str, target: &str) -> Request {
    let view = current(store, run);
    Request {
        key: key.into(),
        run_id: run.into(),
        expected_revision: view["run"]["revision"].as_u64().unwrap(),
        expected_coordinator_session_id: view["run"]["coordinatorSessionId"]
            .as_str()
            .map(str::to_owned),
        coordinator_session_id: target.into(),
    }
}
fn apply(store: &mut Store, request: Request, facts: Facts) -> anyhow::Result<Value> {
    Ok(workflow_coordinator::execute(
        &mut store.0,
        Work::Apply {
            actor: owner(),
            request,
            facts,
        },
        crate::status::now_millis(),
    )?
    .unwrap())
}
fn assigned(store: &mut Store) -> Value {
    let run = prepare_run(store);
    execute(store,Some("coordinator"),json!({"action":"assign","key":"assign","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"],"sessionId":"worker","expectedRevision":run["run"]["revision"]})).unwrap()
}
fn send(store: &mut Store, key: &str) -> crate::receipts::Accepted {
    crate::workflow_context::accept_native(
        &mut store.0,
        "owner",
        key,
        "send",
        json!({"sessionId":"worker","prompt":"Literal retained input"}),
    )
    .unwrap()
}
#[test]
fn replacement_preserves_pending_owner_rules_inbox_attempts_and_never_rearms_old_native_input() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = assigned(&mut store);
    let id = run["run"]["id"].as_str().unwrap();
    let original = send(&mut store, "before-rebind");
    crate::workflow_context::guard_native(&store.0, "worker", &original.receipt.id).unwrap();
    let note=worker(&mut store,"worker",json!({"action":"inbox","request":{"action":"send","key":"result-pointer","runId":id,"correlationId":"stable","body":"Retain this pending message"}})).unwrap();
    let revision = current(&mut store, id)["run"]["revision"].clone();
    execute(&mut store,None,json!({"action":"constraints","request":{"action":"add","key":"owner-rule","runId":id,"expectedRevision":revision,"text":"Preserve source changes; no publication"}})).unwrap();
    let rules = crate::workflow_context::summary(&store.0, id).unwrap();
    let before = current(&mut store, id);
    let req = request(&mut store, id, "recover", "replacement");
    let result = apply(&mut store, req, facts("replacement")).unwrap();
    assert_eq!(result["run"]["coordinatorSessionId"], "replacement");
    assert_eq!(result["run"]["coordinatorBinding"]["generation"], 1);
    assert_eq!(result["nativeEffectsRestored"], false);
    assert_eq!(result["workerAuthorityRestored"], false);
    assert_eq!(result["tasks"], before["tasks"]);
    assert_eq!(result["run"]["budget"], before["run"]["budget"]);
    assert_eq!(
        crate::workflow_context::summary(&store.0, id).unwrap(),
        rules
    );
    let inbox = execute(
        &mut store,
        Some("replacement"),
        json!({"action":"inbox","request":{"action":"read","runId":id}}),
    )
    .unwrap();
    assert_eq!(inbox["messages"][0]["id"], note["message"]["id"]);
    assert_eq!(inbox["messages"][0]["ackedAt"], Value::Null);
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"get","runId":id}),
        ),
        "run_not_found",
    );
    assert_eq!(
        worker(&mut store, "worker", json!({"action":"context"})).unwrap()["attempt"]["id"],
        run["tasks"][0]["currentAttempt"]["id"]
    );
    error(
        crate::workflow_context::guard_native(&store.0, "worker", &original.receipt.id),
        "coordinator_changed",
    );
    let revision = result["run"]["revision"].clone();
    execute(&mut store,None,json!({"action":"constraints","request":{"action":"acknowledge","key":"explicit-read","runId":id,"expectedRevision":revision,"constraintRevision":1}})).unwrap();
    error(
        crate::workflow_context::guard_native(&store.0, "worker", &original.receipt.id),
        "coordinator_changed",
    );
    let replay = send(&mut store, "before-rebind");
    assert_eq!(replay.receipt.id, original.receipt.id);
    let fresh = send(&mut store, "new-deliberate-owner-input");
    crate::workflow_context::guard_native(&store.0, "worker", &fresh.receipt.id).unwrap();
}
#[test]
fn replacing_invalidates_enabled_pumps_and_unclaimed_delivery_without_resetting_time_or_slots() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = assigned(&mut store);
    let id = run["run"]["id"].as_str().unwrap();
    let now = crate::status::now_millis();
    let spec = json!({"tasks":run["tasks"].as_array().unwrap().iter().map(|t|json!({"taskId":t["id"],"profile":{"program":"claude","workspace":"shared","harness":true}})).collect::<Vec<_>>()});
    crate::workflow_executor::execute(&mut store.0,crate::workflow_executor::Work::Manage {actor:owner(),request:serde_json::from_value(json!({"action":"start","key":"engine","runId":id,"expectedRevision":run["run"]["revision"],"spec":spec})).unwrap()},now).unwrap();
    let revision = current(&mut store, id)["run"]["revision"].clone();
    crate::workflow_wakes::execute(
        &mut store.0,
        crate::workflow_wakes::Work::Manage {
            actor: owner(),
            request: serde_json::from_value(
                json!({"action":"enable","key":"wakes","runId":id,"expectedRevision":revision}),
            )
            .unwrap(),
        },
        now,
    )
    .unwrap();
    let revision = current(&mut store, id)["run"]["revision"].clone();
    crate::workflow_delivery::execute(&mut store.0,crate::workflow_delivery::Work::Prepare {actor:owner(),request:serde_json::from_value(json!({"action":"queue","key":"task-input","runId":id,"expectedRevision":revision,"taskId":run["tasks"][0]["id"]})).unwrap()},now).unwrap();
    let before = current(&mut store, id);
    let old_wake = crate::workflow_wakes::read(&store.0, id).unwrap().unwrap();
    let req = request(&mut store, id, "bind", "replacement");
    let result = apply(&mut store, req, facts("replacement")).unwrap();
    assert_eq!(before["tasks"], result["tasks"]);
    assert_eq!(before["run"]["budget"], result["run"]["budget"]);
    let engine: (bool, i64, String) = store
        .0
        .query_row(
            "SELECT enabled,generation,reason FROM workflow_executors WHERE run_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(engine, (false, 2, "coordinator_changed".into()));
    let wake = crate::workflow_wakes::read(&store.0, id).unwrap().unwrap();
    assert!(!wake.enabled);
    assert_eq!(wake.generation, old_wake.generation + 1);
    assert_eq!(wake.coordinator, "replacement");
    error(
        crate::workflow_wakes::guard(
            &store.0,
            &crate::workflow_wakes::Guard {
                id: old_wake.id,
                generation: old_wake.generation,
            },
            &old_wake.issuer,
        )
        .map(|_| ()),
        "wake_paused",
    );
    let delivery: (String, String) = store
        .0
        .query_row(
            "SELECT phase,blocker FROM workflow_deliveries WHERE run_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(delivery, ("paused".into(), "coordinator_changed".into()));
    let receipts: i64 = store
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(receipts, 0);
}
#[test]
fn rebind_is_owner_only_atomic_and_historical_replay_never_replaces_a_newer_binding() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let id = run["run"]["id"].as_str().unwrap();
    let req = request(&mut store, id, "same-binding-key", "replacement");
    let before = store.cursors().unwrap();
    for scope in [
        Scope::Coordinator("coordinator".into()),
        Scope::Worker("worker".into()),
    ] {
        error(
            workflow_coordinator::execute(
                &mut store.0,
                Work::Apply {
                    actor: Actor {
                        issuer: "foreign".into(),
                        scope,
                    },
                    request: req.clone(),
                    facts: facts("replacement"),
                },
                123,
            ),
            "forbidden",
        );
    }
    let mut wrong = facts("replacement");
    wrong.target.directory = "foreign checkout".into();
    error(
        apply(&mut store, req.clone(), wrong),
        "coordinator_context_mismatch",
    );
    let mut wrong = facts("replacement");
    wrong.target.group_id = None;
    error(
        apply(&mut store, req.clone(), wrong),
        "coordinator_context_mismatch",
    );
    assert_eq!(before, store.cursors().unwrap());
    assert_eq!(
        crate::workflow_context::coordinator_generation(&store.0, id).unwrap(),
        0
    );
    let first = apply(&mut store, req.clone(), facts("replacement")).unwrap();
    let next = request(&mut store, id, "next-binding-key", "newest");
    let second = apply(&mut store, next, facts("newest")).unwrap();
    assert_eq!(second["run"]["coordinatorBinding"]["generation"], 2);
    let replay = workflow_coordinator::execute(
        &mut store.0,
        Work::Lookup {
            actor: owner(),
            request: req.clone(),
        },
        124,
    )
    .unwrap()
    .unwrap();
    assert_eq!(replay, first);
    assert_eq!(
        current(&mut store, id)["run"]["coordinatorSessionId"],
        "newest"
    );
    let mut conflict = req;
    conflict.coordinator_session_id = "other".into();
    error(
        workflow_coordinator::execute(
            &mut store.0,
            Work::Lookup {
                actor: owner(),
                request: conflict,
            },
            125,
        ),
        "idempotency_conflict",
    );
}
#[test]
fn old_native_context_schema_migrates_without_adopting_pre_rebind_input() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = assigned(&mut store);
    let id = run["run"]["id"].as_str().unwrap();
    let original = send(&mut store, "legacy-input");
    store.0.execute_batch("ALTER TABLE workflow_native_context RENAME TO old_context; CREATE TABLE workflow_native_context(operation_id TEXT PRIMARY KEY REFERENCES operation_receipts(id),run_id TEXT NOT NULL REFERENCES workflow_runs(id),revision INTEGER NOT NULL,admitted INTEGER NOT NULL); INSERT INTO workflow_native_context SELECT operation_id,run_id,revision,admitted FROM old_context; DROP TABLE old_context;").unwrap();
    crate::workflow_context::initialize(&store.0).unwrap();
    crate::workflow_context::initialize(&store.0).unwrap();
    crate::workflow_context::guard_native(&store.0, "worker", &original.receipt.id).unwrap();
    let req = request(&mut store, id, "bind-legacy", "replacement");
    apply(&mut store, req, facts("replacement")).unwrap();
    error(
        crate::workflow_context::guard_native(&store.0, "worker", &original.receipt.id),
        "coordinator_changed",
    );
}
#[test]
fn absent_source_uses_trusted_recovery_or_prior_binding_but_never_guesses_workspace() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let id = run["run"]["id"].as_str().unwrap();
    let req = request(&mut store, id, "lost-coordinator", "replacement");
    let absent = || Facts {
        target_id: "replacement".into(),
        target: location(),
        previous: None,
    };
    error(
        apply(&mut store, req.clone(), absent()),
        "coordinator_context_missing",
    );
    store
        .0
        .execute_batch(
            "CREATE TABLE recovery(id TEXT PRIMARY KEY,spec TEXT NOT NULL,state TEXT NOT NULL);",
        )
        .unwrap();
    store
        .0
        .execute(
            "INSERT INTO recovery VALUES('coordinator','not-json','exited')",
            [],
        )
        .unwrap();
    error(
        apply(&mut store, req.clone(), absent()),
        "coordinator_context_missing",
    );
    store.0.execute("DELETE FROM recovery", []).unwrap();
    let spec = crate::jobs::LaunchSpec {
        name: "Old coordinator".into(),
        cwd: Some(location().directory),
        group_id: location().group_id,
        role: crate::caller::Role::Coordinator,
        ..Default::default()
    };
    store
        .0
        .execute(
            "INSERT INTO recovery VALUES('coordinator',?1,'exited')",
            [serde_json::to_string(&spec).unwrap()],
        )
        .unwrap();
    let result = apply(&mut store, req, absent()).unwrap();
    assert_eq!(
        result["run"]["coordinatorBinding"]["source"],
        "recoveryRecord"
    );
    store.0.execute("DELETE FROM recovery", []).unwrap();
    let req = request(&mut store, id, "lost-again", "newest");
    let result = apply(
        &mut store,
        req,
        Facts {
            target_id: "newest".into(),
            target: location(),
            previous: None,
        },
    )
    .unwrap();
    assert_eq!(
        result["run"]["coordinatorBinding"]["source"],
        "previousBinding"
    );
}
