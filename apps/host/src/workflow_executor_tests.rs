use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_executor::{self, Guard, Reply, Work},
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
fn spec(run: &Value) -> Value {
    json!({"tasks":run["tasks"].as_array().unwrap().iter().map(|t|json!({"taskId":t["id"],"profile":{"program":"claude","workspace":"shared","harness":true}})).collect::<Vec<_>>()})
}
fn manage(
    store: &mut Store,
    owner: bool,
    request: Value,
) -> anyhow::Result<(Value, Option<Guard>)> {
    match workflow_executor::execute(
        &mut store.0,
        Work::Manage {
            actor: actor(owner),
            request: serde_json::from_value(request)?,
        },
        20_000,
    )? {
        Reply::Managed { view, pump } => Ok((view, pump)),
        _ => panic!("Unexpected executor reply"),
    }
}
fn start(store: &mut Store, run: &Value) -> (Value, Guard) {
    let (view,pump)=manage(store,false,json!({"action":"start","key":"engine","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":spec(run)})).unwrap();
    (view, pump.unwrap())
}
fn current(store: &mut Store, run: &Value) -> Value {
    execute(
        store,
        Some("coordinator"),
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap()
}
fn launch(store: &mut Store, run: &Value, guard: Guard, key: &str) -> anyhow::Result<Value> {
    let request=serde_json::from_value(json!({"key":key,"runId":run["run"]["id"],"taskId":run["tasks"][0]["id"],"expectedRevision":run["run"]["revision"],"profile":{"program":"claude","workspace":"shared"}})).unwrap();
    match crate::workflow_launches::execute(
        &mut store.0,
        crate::workflow_launches::Work::PrepareForExecutor {
            actor: actor(false),
            request,
            guard,
        },
        20_001,
    )? {
        crate::workflow_launches::Reply::Prepared { view, .. } => Ok(view),
        _ => panic!("Unexpected launch reply"),
    }
}
#[test]
fn start_is_explicit_idempotent_and_requires_complete_agent_profiles() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    for invalid in [
        json!({"tasks":[]}),
        json!({"tasks":[spec(&run)["tasks"][0].clone()]}),
        json!({"tasks":[spec(&run)["tasks"][0].clone(),spec(&run)["tasks"][0].clone()]}),
    ] {
        error(manage(&mut store,false,json!({"action":"start","key":"invalid","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":invalid})).map(|_|()),"invalid_argument");
    }
    for invalid in ["shell", "unknown"] {
        let mut profiles = spec(&run);
        profiles["tasks"][0]["profile"]["program"] = invalid.into();
        assert!(manage(&mut store,false,json!({"action":"start","key":"invalid","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":profiles})).is_err());
    }
    let request = json!({"action":"start","key":"engine","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":spec(&run)});
    let (view, pump) = manage(&mut store, false, request.clone()).unwrap();
    assert!(pump.is_some());
    assert_eq!(view["executor"]["generation"], 1);
    assert_eq!(view["executor"]["enabled"], true);
    let (replay, pump) = manage(&mut store, false, request).unwrap();
    assert_eq!(view, replay);
    assert!(pump.is_none());
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let now = current(&mut store, &run);
    error(manage(&mut store,false,json!({"action":"start","key":"duplicate","runId":run["run"]["id"],"expectedRevision":now["run"]["revision"],"spec":spec(&run)})).map(|_|()),"executor_exists");
}
#[test]
fn retry_cooldown_starts_at_observed_failure_and_does_not_reset_on_reads() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let mut profile = spec(&run);
    profile["retryFailed"] = true.into();
    let (_, guard) = manage(&mut store, false, json!({"action":"start","key":"retry-engine","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":profile})).unwrap();
    let guard = guard.unwrap();
    let now = current(&mut store, &run);
    let admitted = launch(&mut store, &now, guard.clone(), "retry-native").unwrap();
    let attempt = admitted["launch"]["attemptId"].as_str().unwrap().to_owned();
    let work = || Work::Retry {
        guard: guard.clone(),
        issuer: "coordinator".into(),
        attempt: attempt.clone(),
    };
    error(
        workflow_executor::execute(&mut store.0, work(), 30_000).map(|_| ()),
        "revision_conflict",
    );
    store
        .0
        .execute(
            "UPDATE workflow_attempts SET state='launchFailed' WHERE id=?1",
            [&attempt],
        )
        .unwrap();
    for (at, ready) in [
        (30_000, false),
        (30_999, false),
        (31_000, true),
        (30_500, false),
        (31_001, true),
    ] {
        let Reply::RetryReady(actual) =
            workflow_executor::execute(&mut store.0, work(), at).unwrap()
        else {
            panic!("Missing retry reply")
        };
        assert_eq!(actual, ready);
    }
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT count(*) FROM workflow_executor_retries",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    workflow_executor::recover(&mut store.0).unwrap();
    error(
        workflow_executor::execute(&mut store.0, work(), 50_000).map(|_| ()),
        "executor_paused",
    );
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT not_before FROM workflow_executor_retries",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        31_000
    );
}

#[test]
fn disabled_or_foreign_generations_cannot_admit_native_effects() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let (started, old) = start(&mut store, &run);
    let (disabled,_)=manage(&mut store,true,json!({"action":"disable","key":"disable","runId":run["run"]["id"],"expectedRevision":started["run"]["revision"]})).unwrap();
    assert_eq!(disabled["executor"]["enabled"], false);
    let now = current(&mut store, &run);
    error(
        launch(&mut store, &now, old.clone(), "no-effect"),
        "executor_paused",
    );
    let (enabled,new)=manage(&mut store,true,json!({"action":"enable","key":"enable","runId":run["run"]["id"],"expectedRevision":disabled["run"]["revision"]})).unwrap();
    assert_eq!(enabled["executor"]["issuer"], "owner");
    assert!(new.as_ref().unwrap().generation > old.generation);
    error(
        workflow_executor::guard(&store.0, new.as_ref().unwrap(), "coordinator"),
        "executor_paused",
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
fn executor_provenance_and_native_admission_commit_or_rollback_together() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let (_, guard) = start(&mut store, &run);
    let now = current(&mut store, &run);
    store.0.execute_batch("CREATE TRIGGER inject_executor_failure BEFORE INSERT ON workflow_executor_launches BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(launch(&mut store, &now, guard.clone(), "launch").is_err());
    for table in [
        "workflow_attempts",
        "operation_receipts",
        "workflow_executor_launches",
    ] {
        assert_eq!(
            store
                .0
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    store
        .0
        .execute_batch("DROP TRIGGER inject_executor_failure")
        .unwrap();
    let accepted = launch(&mut store, &now, guard.clone(), "launch").unwrap();
    let attempt = accepted["launch"]["attemptId"].as_str().unwrap();
    let Reply::Snapshot(Some(snapshot)) = workflow_executor::execute(
        &mut store.0,
        Work::Poll {
            guard: guard.clone(),
            issuer: "coordinator".into(),
        },
        20_002,
    )
    .unwrap() else {
        panic!("Expected active snapshot")
    };
    assert!(snapshot.owned.contains(attempt));
    let provenance: String = store
        .0
        .query_row(
            "SELECT workflow_key FROM workflow_executor_launches",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(provenance, "launch");
    error(
        workflow_executor::guard_run(&store.0, &guard, "coordinator", "other-run"),
        "executor_scope_conflict",
    );
}
#[test]
fn repeated_notes_do_not_spam_revisions_and_old_workers_cannot_write_a_new_generation() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let (_, guard) = start(&mut store, &run);
    for _ in 0..2 {
        workflow_executor::execute(
            &mut store.0,
            Work::Note {
                guard: guard.clone(),
                issuer: "coordinator".into(),
                phase: "waiting",
                reason: Some("validation_pending".into()),
                task_id: None,
                disable: false,
            },
            20_001,
        )
        .unwrap();
    }
    let before = current(&mut store, &run)["run"]["revision"].clone();
    for _ in 0..10 {
        workflow_executor::execute(
            &mut store.0,
            Work::Note {
                guard: guard.clone(),
                issuer: "coordinator".into(),
                phase: "waiting",
                reason: Some("validation_pending".into()),
                task_id: None,
                disable: false,
            },
            20_002,
        )
        .unwrap();
    }
    assert_eq!(current(&mut store, &run)["run"]["revision"], before);
    workflow_executor::execute(
        &mut store.0,
        Work::Note {
            guard: guard.clone(),
            issuer: "coordinator".into(),
            phase: "paused",
            reason: Some("scope_revoked".into()),
            task_id: None,
            disable: true,
        },
        20_003,
    )
    .unwrap();
    let after = current(&mut store, &run)["run"]["revision"].clone();
    workflow_executor::execute(
        &mut store.0,
        Work::Note {
            guard: guard.clone(),
            issuer: "coordinator".into(),
            phase: "scheduling",
            reason: None,
            task_id: None,
            disable: false,
        },
        20_004,
    )
    .unwrap();
    assert_eq!(current(&mut store, &run)["run"]["revision"], after);
    assert!(matches!(
        workflow_executor::execute(
            &mut store.0,
            Work::Poll {
                guard,
                issuer: "coordinator".into()
            },
            20_005
        )
        .unwrap(),
        Reply::Snapshot(None)
    ));
}
#[test]
fn restart_disables_dispatch_and_preserves_unknown_launch_history_and_original_acceptance() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-executor-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let run = prepare_run(&mut store);
    let (accepted, guard) = start(&mut store, &run);
    let now = current(&mut store, &run);
    let launch = launch(&mut store, &now, guard.clone(), "launch").unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let (view, pump) = manage(
        &mut store,
        true,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    assert!(pump.is_none());
    assert_eq!(view["executor"]["enabled"], false);
    assert_eq!(view["executor"]["reason"], "host_restart");
    let (replay,pump)=manage(&mut store,false,json!({"action":"start","key":"engine","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":spec(&run)})).unwrap();
    assert_eq!(replay, accepted);
    assert!(pump.is_none());
    let now = current(&mut store, &run);
    assert_eq!(now["tasks"][0]["state"], "launchUnknown");
    assert_eq!(now["run"]["budget"]["activeAttempts"], 1);
    assert_eq!(
        now["tasks"][0]["currentAttempt"]["id"],
        launch["launch"]["attemptId"]
    );
    error(
        workflow_executor::guard(&store.0, &guard, "coordinator"),
        "executor_paused",
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn executor_storage_errors_are_not_silently_treated_as_a_disabled_runtime() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    let (_, guard) = start(&mut store, &run);
    store
        .0
        .execute_batch("DROP TABLE workflow_executor_launches; DROP TABLE workflow_executors")
        .unwrap();
    assert!(
        workflow_executor::execute(
            &mut store.0,
            Work::Poll {
                guard,
                issuer: "coordinator".into()
            },
            20_001
        )
        .is_err()
    );
}

#[test]
fn workers_foreign_coordinators_stale_edits_and_invalid_bounds_cannot_enable_execution() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = prepare_run(&mut store);
    for (scope, code) in [
        (Scope::Worker("worker".into()), "forbidden"),
        (Scope::Coordinator("foreign".into()), "run_not_found"),
    ] {
        error(
            workflow_executor::execute(
                &mut store.0,
                Work::Manage {
                    actor: Actor {
                        issuer: "foreign".into(),
                        scope,
                    },
                    request: serde_json::from_value(
                        json!({"action":"get","runId":run["run"]["id"]}),
                    )
                    .unwrap(),
                },
                20_000,
            )
            .map(|_| ()),
            code,
        );
    }
    error(manage(&mut store,false,json!({"action":"start","key":"stale","runId":run["run"]["id"],"expectedRevision":1,"spec":spec(&run)})).map(|_|()),"revision_conflict");
    for (field, value) in [
        ("retryDelayMs", 999),
        ("retryDelayMs", 60001),
        ("readinessTimeoutMs", 0),
        ("readinessTimeoutMs", 300001),
    ] {
        let mut invalid = spec(&run);
        invalid[field] = value.into();
        error(manage(&mut store,false,json!({"action":"start","key":"bounds","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"spec":invalid})).map(|_|()),"invalid_argument");
    }
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM workflow_executors", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn enabled_executor_capacity_is_bounded_and_disabling_releases_only_the_runtime_slot() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let mut runs = Vec::new();
    for index in 0..17 {
        let created=execute(&mut store,Some("coordinator"),json!({"action":"create","key":format!("run-{index}"),"spec":{"title":"Capacity","goal":"Bounded deterministic runtime","coordinatorSessionId":"coordinator"}})).unwrap();
        let planned=execute(&mut store,Some("coordinator"),json!({"action":"setPlan","key":format!("plan-{index}"),"runId":created["run"]["id"],"expectedRevision":1,"tasks":[{"key":"work","title":"Work","instruction":"Scope only"}]})).unwrap();
        let active=execute(&mut store,Some("coordinator"),json!({"action":"activate","key":format!("active-{index}"),"runId":created["run"]["id"],"expectedRevision":planned["run"]["revision"]})).unwrap();
        let result = manage(
            &mut store,
            false,
            json!({"action":"start","key":format!("executor-{index}"),"runId":active["run"]["id"],"expectedRevision":active["run"]["revision"],"spec":spec(&active)}),
        );
        if index == 16 {
            error(result.map(|_| ()), "busy");
        } else {
            result.unwrap();
        }
        runs.push(active);
    }
    let first = current(&mut store, &runs[0]);
    manage(&mut store,true,json!({"action":"disable","key":"free-runtime","runId":first["run"]["id"],"expectedRevision":first["run"]["revision"]})).unwrap();
    let last = &runs[16];
    manage(&mut store,false,json!({"action":"start","key":"executor-16","runId":last["run"]["id"],"expectedRevision":last["run"]["revision"],"spec":spec(last)})).unwrap();
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT count(*) FROM workflow_executors WHERE enabled=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        16
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
