use super::{
    Store,
    orchestration_tests::{error, report},
};
use crate::{
    orchestration::{self, Actor, Scope},
    workflow_launches::{self, Dispatch, Reply, Request, Work},
};
use serde_json::{Value, json};

fn actor(role: &str) -> Actor {
    Actor {
        issuer: role.into(),
        scope: match role {
            "owner" => Scope::Owner,
            "coordinator" => Scope::Coordinator(role.into()),
            id => Scope::Worker(id.into()),
        },
    }
}
fn workflow(store: &mut Store, role: &str, request: Value) -> anyhow::Result<Value> {
    orchestration::execute_at(
        &mut store.0,
        actor(role),
        serde_json::from_value(request).unwrap(),
        20_000,
    )
}
fn fixture(store: &mut Store) -> Value {
    let run=workflow(store,"coordinator",json!({"action":"create","key":"run","spec":{"title":"Native reservations","goal":"Bounded startup","coordinatorSessionId":"coordinator"}})).unwrap();
    let plan=workflow(store,"coordinator",json!({"action":"setPlan","key":"plan","runId":run["run"]["id"],"expectedRevision":1,"tasks":[{"key":"first","title":"First","instruction":"Produce evidence"},{"key":"second","title":"Second","instruction":"Independent work"},{"key":"review","title":"Review","instruction":"Review accepted work","dependencies":["first"]}]})).unwrap();
    let policy=workflow(store,"coordinator",json!({"action":"runBudget","request":{"action":"set","key":"policy","runId":run["run"]["id"],"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":2,"maxElapsedMs":null}}})).unwrap();
    workflow(store,"coordinator",json!({"action":"activate","key":"activate","runId":run["run"]["id"],"expectedRevision":policy["run"]["revision"]})).unwrap()
}
fn current(store: &mut Store, run: &Value) -> Value {
    workflow(
        store,
        "owner",
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap()
}
fn request(run: &Value, key: &str, index: usize) -> Request {
    serde_json::from_value(json!({"key":key,"runId":run["run"]["id"],"taskId":run["tasks"][index]["id"],"expectedRevision":run["run"]["revision"],"profile":{"program":"shell","workspace":"shared"}})).unwrap()
}
fn prepare(
    store: &mut Store,
    role: &str,
    request: Request,
) -> anyhow::Result<(Value, Option<Box<Dispatch>>)> {
    match workflow_launches::execute(
        &mut store.0,
        Work::Prepare {
            actor: actor(role),
            request,
        },
        20_001,
    )? {
        Reply::Prepared { view, dispatch } => Ok((view, dispatch)),
        _ => panic!("Unexpected reply"),
    }
}
fn finish(store: &mut Store, dispatch: &Dispatch, phase: &str, result: Value) {
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
    workflow_launches::execute(
        &mut store.0,
        Work::Finish {
            attempt_id: dispatch.attempt_id.clone(),
            receipt_id: dispatch.receipt.id.clone(),
        },
        20_002,
    )
    .unwrap();
}
#[test]
fn reserves_native_identity_and_capacity_before_any_process_or_prompt() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let intent = request(&run, "launch", 0);
    let (accepted, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    assert_eq!(accepted["launch"]["phase"], "accepted");
    assert_eq!(accepted["tasks"][0]["state"], "launching");
    assert_eq!(accepted["run"]["budget"]["activeAttempts"], 1);
    assert_eq!(accepted["launch"]["sessionId"], dispatch.receipt.session_id);
    assert!(dispatch.spec.prompt.is_empty());
    assert_eq!(
        dispatch.spec.parent_session_id.as_deref(),
        Some("coordinator")
    );
    let (replay, claim) = prepare(&mut store, "coordinator", intent).unwrap();
    assert_eq!(replay, accepted);
    assert!(claim.is_none());
    let snapshot = current(&mut store, &run);
    error(
        prepare(
            &mut store,
            "coordinator",
            request(&snapshot, "second-launch", 1),
        )
        .map(|v| v.0),
        "parallel_budget_exhausted",
    );
    finish(
        &mut store,
        &dispatch,
        "created",
        json!({"sessionId":dispatch.receipt.session_id,"taskResult":null}),
    );
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["tasks"][0]["state"], "assigned");
    let history = workflow(
        &mut store,
        "owner",
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"],"offset":0}),
    )
    .unwrap();
    assert_eq!(
        history["attempts"][0]["launch"]["receiptId"],
        dispatch.receipt.id
    );
    assert!(history["attempts"][0]["result"].is_null());
    let recovered = workflow(
        &mut store,
        "coordinator",
        json!({"action":"mutation","key":"launch"}),
    )
    .unwrap();
    assert_eq!(recovered, accepted);
}
#[test]
fn selected_task_tools_are_persisted_in_history_and_fingerprint_without_becoming_owner_fields() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let mut intent = request(&run, "tool-profile", 0);
    intent.profile.program = crate::launchers::Program::Claude;
    intent.profile.harness = Some(true);
    intent.profile.allowed_nesvo_tools = Some(vec!["nesvo_get_current_task".into()]);
    let (accepted, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    assert_eq!(
        accepted["launch"]["profile"]["allowedNesvoTools"],
        json!(["nesvo_get_current_task"])
    );
    assert_eq!(dispatch.selected_tools, intent.profile.allowed_nesvo_tools);
    assert!(dispatch.spec.allowed_nesvo_tools.is_none());
    assert!(dispatch.spec.child_allowed_nesvo_tools.is_none());
    finish(
        &mut store,
        &dispatch,
        "created",
        json!({"sessionId":dispatch.receipt.session_id}),
    );
    let history = workflow(
        &mut store,
        "owner",
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"],"offset":0}),
    )
    .unwrap();
    assert_eq!(
        history["attempts"][0]["launch"]["profile"],
        accepted["launch"]["profile"]
    );
    let (replay, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    assert!(dispatch.is_none());
    assert_eq!(replay, accepted);
    for selected in [
        None,
        Some(Vec::new()),
        Some(vec!["nesvo_report_task_result".into()]),
    ] {
        intent.profile.allowed_nesvo_tools = selected;
        error(
            prepare(&mut store, "coordinator", intent.clone()).map(|v| v.0),
            "idempotency_conflict",
        );
    }
}
#[test]
fn launch_profile_migration_preserves_legacy_rows_and_saved_acceptance() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let intent = request(&run, "legacy-profile", 0);
    assert!(
        serde_json::to_value(&intent).unwrap()["profile"]
            .get("allowedNesvoTools")
            .is_none()
    );
    let (accepted, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    store
        .0
        .execute_batch("ALTER TABLE workflow_launches DROP COLUMN profile;")
        .unwrap();
    workflow_launches::initialize(&store.0).unwrap();
    workflow_launches::initialize(&store.0).unwrap();
    let saved = workflow_launches::summary(&store.0, &dispatch.attempt_id).unwrap();
    assert!(saved["profile"].is_null());
    assert_eq!(saved["receiptId"], dispatch.receipt.id);
    let (replay, dispatch) = prepare(&mut store, "coordinator", intent).unwrap();
    assert!(dispatch.is_none());
    assert_eq!(
        replay, accepted,
        "Migration must never rewrite a saved acceptance"
    );
}
#[test]
fn refuses_unmet_dependencies_worker_scope_and_stale_revisions_without_native_records() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    error(
        prepare(&mut store, "coordinator", request(&run, "early-review", 2)).map(|v| v.0),
        "dependencies_unmet",
    );
    error(
        prepare(&mut store, "worker", request(&run, "forged", 0)).map(|v| v.0),
        "forbidden",
    );
    let mut stale = request(&run, "stale", 0);
    stale.expected_revision = 1;
    error(
        prepare(&mut store, "coordinator", stale).map(|v| v.0),
        "revision_conflict",
    );
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM workflow_attempts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn known_no_effect_launch_failure_frees_slot_retains_retry_and_does_not_block_cancel() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (_, first) = prepare(&mut store, "coordinator", request(&run, "failed-launch", 0)).unwrap();
    let first = first.unwrap();
    finish(
        &mut store,
        &first,
        "failed",
        json!({"code":"scope_revoked","effectStarted":false}),
    );
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["tasks"][0]["state"], "launchFailed");
    assert_eq!(snapshot["run"]["budget"]["activeAttempts"], 0);
    assert!(snapshot["tasks"][0]["taskResult"].is_null());
    let (_, second) = prepare(
        &mut store,
        "coordinator",
        request(&snapshot, "retry-start", 0),
    )
    .unwrap();
    let second = second.unwrap();
    assert_ne!(second.receipt.session_id, first.receipt.session_id);
    finish(
        &mut store,
        &second,
        "failed",
        json!({"code":"invalid_launch","effectStarted":false}),
    );
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["tasks"][0]["attempts"], 2);
    error(
        prepare(
            &mut store,
            "coordinator",
            request(&snapshot, "retry-exhausted", 0),
        )
        .map(|v| v.0),
        "retry_budget_exhausted",
    );
    let reply=crate::workflow_controls::execute(&mut store.0,crate::workflow_controls::Work::Prepare{actor:actor("owner"),request:serde_json::from_value(json!({"action":"start","kind":"cancel","key":"cancel","runId":run["run"]["id"],"expectedRevision":snapshot["run"]["revision"]})).unwrap()},20_003).unwrap();
    let crate::workflow_controls::Reply::Prepared { view, .. } = reply else {
        panic!()
    };
    assert_eq!(view["run"]["state"], "canceled");
    assert!(view["targets"].as_array().unwrap().is_empty());
}
#[test]
fn unknown_launch_retains_capacity_and_cannot_be_retried_or_resolved_by_replay() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let intent = request(&run, "uncertain", 0);
    let (accepted, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    finish(
        &mut store,
        &dispatch,
        "unknown",
        json!({"code":"launch_unconfirmed","directory":"/possible/worktree"}),
    );
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["tasks"][0]["state"], "launchUnknown");
    assert_eq!(snapshot["run"]["budget"]["activeAttempts"], 1);
    error(
        prepare(
            &mut store,
            "coordinator",
            request(&snapshot, "force-fresh", 0),
        )
        .map(|v| v.0),
        "attempt_state_conflict",
    );
    let (replay, claim) = prepare(&mut store, "coordinator", intent).unwrap();
    assert_eq!(replay, accepted);
    assert!(claim.is_none());
    assert_eq!(
        current(&mut store, &run)["tasks"][0]["state"],
        "launchUnknown"
    );
}
#[test]
fn receipt_attempt_mutation_and_domain_events_roll_back_together_on_storage_failure() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let cursor = store.cursors().unwrap();
    store.0.execute_batch("CREATE TRIGGER reject_reservation BEFORE UPDATE ON workflow_runs BEGIN SELECT RAISE(ABORT,'controlled admission failure'); END;").unwrap();
    assert!(prepare(&mut store, "coordinator", request(&run, "rollback", 0)).is_err());
    for table in [
        "operation_receipts",
        "workflow_attempts",
        "workflow_launches",
    ] {
        let count: i64 = store
            .0
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(store.cursors().unwrap(), cursor);
    error(
        workflow(
            &mut store,
            "coordinator",
            json!({"action":"mutation","key":"rollback"}),
        ),
        "mutation_not_found",
    );
    store
        .0
        .execute_batch("DROP TRIGGER reject_reservation;")
        .unwrap();
    prepare(&mut store, "coordinator", request(&run, "rollback", 0)).unwrap();
}
#[test]
fn reserved_worker_can_report_only_after_native_binding_and_results_keep_capacity() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = fixture(&mut store);
    let (_, dispatch) = prepare(&mut store, "coordinator", request(&run, "first", 0)).unwrap();
    let dispatch = dispatch.unwrap();
    error(
        workflow(
            &mut store,
            &dispatch.receipt.session_id,
            json!({"action":"report","key":"early","attemptId":dispatch.attempt_id,"result":report()}),
        ),
        "attempt_state_conflict",
    );
    finish(
        &mut store,
        &dispatch,
        "created",
        json!({"sessionId":dispatch.receipt.session_id}),
    );
    workflow(
        &mut store,
        &dispatch.receipt.session_id,
        json!({"action":"report","key":"result","attemptId":dispatch.attempt_id,"result":report()}),
    )
    .unwrap();
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["run"]["budget"]["activeAttempts"], 1);
    error(
        prepare(
            &mut store,
            "coordinator",
            request(&snapshot, "review-too-soon", 2),
        )
        .map(|v| v.0),
        "dependencies_unmet",
    );
}

#[test]
fn restart_preserves_unknown_start_and_historical_acceptance_without_new_claims() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-launch-recovery-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let run = fixture(&mut store);
    let intent = request(&run, "lost-start", 0);
    let (accepted, dispatch) = prepare(&mut store, "coordinator", intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let snapshot = current(&mut store, &run);
    assert_eq!(snapshot["tasks"][0]["state"], "launchUnknown");
    assert_eq!(snapshot["run"]["budget"]["activeAttempts"], 1);
    let (replay, claim) = prepare(&mut store, "coordinator", intent).unwrap();
    assert_eq!(replay, accepted);
    assert!(claim.is_none());
    let native = crate::receipts::get(
        &store.0,
        "coordinator",
        false,
        Some(&dispatch.receipt.id),
        None,
    )
    .unwrap();
    assert_eq!(native.receipt.phase, "unknown");
    assert!(
        crate::receipts::claim(&mut store.0, &dispatch.receipt.id, "coordinator")
            .unwrap()
            .is_none()
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn separate_sqlite_writers_observe_the_reserved_parallel_slot_before_spawn() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-launch-writers-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut first = Store::open(&path).unwrap();
    let run = fixture(&mut first);
    // Both connections are opened before admission; opening is host recovery.
    let mut second = Store::open(&path).unwrap();
    prepare(&mut first, "coordinator", request(&run, "writer-one", 0)).unwrap();
    let snapshot = current(&mut second, &run);
    error(
        prepare(
            &mut second,
            "coordinator",
            request(&snapshot, "writer-two", 1),
        )
        .map(|v| v.0),
        "parallel_budget_exhausted",
    );
    assert_eq!(snapshot["run"]["budget"]["activeAttempts"], 1);
    let count: i64 = second
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    drop(first);
    drop(second);
    std::fs::remove_file(path).unwrap();
}
