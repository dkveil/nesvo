use super::Store;
use crate::orchestration::{self, Actor, Request, Scope};
use serde_json::{Value, json};

fn actor(id: Option<&str>) -> Actor {
    Actor {
        issuer: id.unwrap_or("owner").into(),
        scope: id.map_or(Scope::Owner, |id| Scope::Coordinator(id.into())),
    }
}
pub(super) fn execute(store: &mut Store, id: Option<&str>, value: Value) -> anyhow::Result<Value> {
    orchestration::execute(
        &mut store.0,
        actor(id),
        serde_json::from_value(value).unwrap(),
    )
}
fn create(store: &mut Store, id: Option<&str>, key: &str) -> Value {
    execute(store,id,json!({"action":"create","key":key,"spec":{"title":"Plan łódź","goal":"private goal text","coordinatorSessionId":id}})).unwrap()
}
fn task(key: &str, deps: &[&str]) -> Value {
    json!({"key":key,"title":key,"instruction":"private task text","dependencies":deps})
}
pub(super) fn error(result: anyhow::Result<Value>, code: &str) {
    assert_eq!(
        result
            .unwrap_err()
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        code
    );
}
pub(super) fn worker(store: &mut Store, id: &str, request: Value) -> anyhow::Result<Value> {
    orchestration::execute(
        &mut store.0,
        Actor {
            issuer: id.into(),
            scope: Scope::Worker(id.into()),
        },
        serde_json::from_value(request).unwrap(),
    )
}
pub(super) fn report() -> Value {
    json!({"outcome":"succeeded","summary":"Worker claims completion","files":["src/a.rs"],"artifacts":[],"checks":[{"name":"unit","outcome":"passed","details":"Worker-reported check"}],"limitations":["Needs independent validation"]})
}
fn validation(passed: bool) -> Value {
    json!({"passed":passed,"summary":"Explicit coordinator review","checks":[{"name":"review","outcome":if passed{"passed"}else{"failed"},"details":"Coordinator attestation, not host-executed validation"}]})
}
pub(super) fn prepare_run(store: &mut Store) -> Value {
    let run = create(store, Some("coordinator"), "run");
    let id = run["run"]["id"].clone();
    execute(store,Some("coordinator"),json!({"action":"setPlan","key":"plan","runId":id,"expectedRevision":1,"tasks":[task("implement",&[]),task("review",&["implement"])]})).unwrap();
    execute(
        store,
        Some("coordinator"),
        json!({"action":"activate","key":"activate","runId":id,"expectedRevision":2}),
    )
    .unwrap()
}

#[test]
fn attempts_require_explicit_authorized_results_and_validation_before_dependencies() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let run = plan["run"]["id"].clone();
    let implement = plan["tasks"][0]["id"].clone();
    let review = plan["tasks"][1]["id"].clone();
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"assign","key":"early-review","runId":run,"taskId":review,"sessionId":"reviewer","expectedRevision":3}),
        ),
        "dependencies_unmet",
    );
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"setPlan","key":"rewrite","runId":run,"expectedRevision":3,"tasks":[]}),
        ),
        "run_state_conflict",
    );
    let assigned=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"bind","runId":run,"taskId":implement,"sessionId":"worker-1","expectedRevision":3})).unwrap();
    let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
    assert_eq!(assigned["tasks"][0]["taskResult"], Value::Null);
    assert_eq!(
        worker(&mut store, "worker-1", json!({"action":"context"})).unwrap()["attempt"]["id"],
        attempt
    );
    error(
        worker(&mut store, "worker-1", json!({"action":"get","runId":run})),
        "forbidden",
    );
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"validate","key":"self","runId":run,"attemptId":attempt,"expectedRevision":4,"validation":validation(true)}),
        ),
        "forbidden",
    );
    error(
        worker(
            &mut store,
            "foreign",
            json!({"action":"report","key":"forge","attemptId":attempt,"result":report()}),
        ),
        "attempt_not_found",
    );
    error(
        execute(
            &mut store,
            None,
            json!({"action":"report","key":"owner-forge","attemptId":attempt,"result":report()}),
        ),
        "forbidden",
    );
    let request = json!({"action":"report","key":"result","attemptId":attempt,"result":report()});
    let reported = worker(&mut store, "worker-1", request.clone()).unwrap();
    assert_eq!(reported["attempt"]["state"], "reported");
    assert_eq!(worker(&mut store, "worker-1", request).unwrap(), reported);
    let head = store.cursors().unwrap();
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"replace","attemptId":attempt,"result":report()}),
        ),
        "attempt_state_conflict",
    );
    let current = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run}),
    )
    .unwrap();
    assert_eq!(current["tasks"][0]["taskResult"], Value::Null);
    assert_eq!(current["tasks"][1]["dependencyState"], "waiting");
    let mut no_checks = validation(true);
    no_checks["checks"] = json!([]);
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"validate","key":"no-checks","runId":run,"attemptId":attempt,"expectedRevision":5,"validation":no_checks}),
        ),
        "invalid_argument",
    );
    assert_eq!(head, store.cursors().unwrap());
    let accepted=execute(&mut store,Some("coordinator"),json!({"action":"validate","key":"accept","runId":run,"attemptId":attempt,"expectedRevision":5,"validation":validation(true)})).unwrap();
    assert_eq!(accepted["tasks"][0]["taskResult"], "succeeded");
    assert_eq!(accepted["tasks"][1]["dependencyState"], "ready");
    assert_eq!(accepted["run"]["state"], "active");
    let assigned=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"review","runId":run,"taskId":review,"sessionId":"reviewer","expectedRevision":6})).unwrap();
    let attempt = assigned["tasks"][1]["currentAttempt"]["id"].clone();
    worker(
        &mut store,
        "reviewer",
        json!({"action":"report","key":"result","attemptId":attempt,"result":report()}),
    )
    .unwrap();
    let finished=execute(&mut store,None,json!({"action":"validate","key":"owner-accept","runId":run,"attemptId":attempt,"expectedRevision":8,"validation":validation(true)})).unwrap();
    assert_eq!(finished["run"]["state"], "succeeded");
    assert_eq!(finished["run"]["taskResult"], "succeeded");
    let history = execute(
        &mut store,
        None,
        json!({"action":"task","runId":run,"taskId":review}),
    )
    .unwrap();
    assert_eq!(
        history["attempts"][0]["validation"]["source"],
        "ownerAttestation"
    );
}

#[test]
fn retry_retains_old_attempts_and_rejects_late_results_after_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-attempt-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let run;
    let task;
    let first;
    {
        let mut store = Store::open(&path).unwrap();
        let plan = prepare_run(&mut store);
        run = plan["run"]["id"].clone();
        task = plan["tasks"][0]["id"].clone();
        first=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"first","runId":run,"taskId":task,"sessionId":"worker-1","expectedRevision":3})).unwrap()["tasks"][0]["currentAttempt"]["id"].clone();
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"result","attemptId":first,"result":report()}),
        )
        .unwrap();
        execute(&mut store,Some("coordinator"),json!({"action":"validate","key":"reject","runId":run,"attemptId":first,"expectedRevision":5,"validation":validation(false)})).unwrap();
    }
    let mut store = Store::open(&path).unwrap();
    let current = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run}),
    )
    .unwrap();
    assert_eq!(current["tasks"][0]["state"], "failed");
    let retry=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"second","runId":run,"taskId":task,"sessionId":"worker-2","expectedRevision":6})).unwrap();
    let second = retry["tasks"][0]["currentAttempt"]["id"].clone();
    assert_ne!(first, second);
    assert_eq!(retry["tasks"][0]["attempts"], 2);
    let head = store.cursors().unwrap();
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"late","attemptId":first,"result":report()}),
        ),
        "stale_attempt",
    );
    error(
        worker(
            &mut store,
            "worker-2",
            json!({"action":"report","key":"forge-old","attemptId":first,"result":report()}),
        ),
        "stale_attempt",
    );
    assert_eq!(head, store.cursors().unwrap());
    let history = execute(
        &mut store,
        None,
        json!({"action":"task","runId":run,"taskId":task}),
    )
    .unwrap();
    assert_eq!(history["attempts"][0]["id"], first);
    assert_eq!(history["attempts"][0]["state"], "failed");
    assert_eq!(
        history["attempts"][0]["result"]["summary"],
        "Worker claims completion"
    );
    assert_eq!(history["attempts"][1]["id"], second);
    assert_eq!(history["attempts"][1]["state"], "assigned");
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn bounded_attempt_history_paginates_and_never_prunes_or_reuses_workers() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let run = plan["run"]["id"].clone();
    let task = plan["tasks"][0]["id"].clone();
    let mut revision = 3;
    for i in 0..16 {
        let session = format!("worker-{i}");
        let assigned=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":format!("assign-{i}"),"runId":run,"taskId":task,"sessionId":session,"expectedRevision":revision})).unwrap();
        let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
        let mut oversized = report();
        oversized["summary"] = json!("x".repeat(2049));
        error(
            worker(
                &mut store,
                &session,
                json!({"action":"report","key":"oversized","attemptId":attempt,"result":oversized}),
            ),
            "invalid_argument",
        );
        worker(
            &mut store,
            &session,
            json!({"action":"report","key":"result","attemptId":attempt,"result":report()}),
        )
        .unwrap();
        execute(&mut store,Some("coordinator"),json!({"action":"validate","key":format!("reject-{i}"),"runId":run,"attemptId":attempt,"expectedRevision":revision+2,"validation":validation(false)})).unwrap();
        revision += 3;
        if i == 0 {
            error(
                execute(
                    &mut store,
                    Some("coordinator"),
                    json!({"action":"assign","key":"reuse","runId":run,"taskId":task,"sessionId":session,"expectedRevision":revision}),
                ),
                "session_already_assigned",
            );
        }
    }
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"assign","key":"overflow","runId":run,"taskId":task,"sessionId":"worker-overflow","expectedRevision":revision}),
        ),
        "busy",
    );
    let mut count = 0;
    for offset in [0, 4, 8, 12] {
        let page = execute(
            &mut store,
            None,
            json!({"action":"task","runId":run,"taskId":task,"offset":offset}),
        )
        .unwrap();
        let attempts = page["attempts"].as_array().unwrap();
        count += attempts.len();
        assert_eq!(attempts.len(), 4);
        assert_eq!(attempts[0]["ordinal"], offset + 1);
        assert!(attempts.iter().all(|a| a["state"] == "failed"
            && a["result"].is_object()
            && a["validation"].is_object()));
        assert_eq!(
            page["nextOffset"],
            if offset == 12 {
                Value::Null
            } else {
                json!(offset + 4)
            }
        );
    }
    assert_eq!(count, 16);
}

#[test]
fn invalid_graphs_never_change_the_committed_plan_or_mutation_journal() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = create(&mut store, None, "run");
    let id = run["run"]["id"].clone();
    let initial_head = store.cursors().unwrap();
    let plans = vec![
        vec![task("self", &["self"])],
        vec![task("a", &["b"]), task("b", &["a"])],
        vec![task("a", &["absent"])],
        vec![task("a", &[]), task("a", &[])],
        vec![task("a", &[]), task("b", &["a", "a"])],
        vec![task("bad/key", &[])],
        (0..65).map(|i| task(&format!("t{i}"), &[])).collect(),
        vec![json!({"key":"large","title":"l","instruction":"x".repeat(8193)})],
    ];
    for tasks in plans {
        error(
            execute(
                &mut store,
                None,
                json!({"action":"setPlan","key":"invalid","runId":id,"expectedRevision":1,"tasks":tasks}),
            ),
            "invalid_argument",
        );
        assert_eq!(store.cursors().unwrap(), initial_head);
        error(
            execute(
                &mut store,
                None,
                json!({"action":"mutation","key":"invalid"}),
            ),
            "mutation_not_found",
        );
        assert_eq!(
            execute(&mut store, None, json!({"action":"get","runId":id})).unwrap()["tasks"],
            json!([])
        );
    }
    let missing: Request =
        serde_json::from_value(json!({"action":"get","runId":"no-run"})).unwrap();
    error(
        orchestration::execute(&mut store.0, actor(None), missing),
        "run_not_found",
    );
}

#[test]
fn revisions_and_receipts_are_atomic_and_task_identity_survives_plan_edits() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let first = create(&mut store, Some("coordinator"), "run");
    let id = first["run"]["id"].clone();
    assert_eq!(first["run"]["revision"], 1);
    assert_eq!(create(&mut store, Some("coordinator"), "run"), first);
    let plan = json!({"action":"setPlan","key":"plan","runId":id,"expectedRevision":1,"tasks":[task("implement",&[]),task("review",&["implement"])]});
    let committed = execute(&mut store, Some("coordinator"), plan.clone()).unwrap();
    assert_eq!(committed["run"]["revision"], 2);
    assert_eq!(committed["tasks"][0]["state"], "planned");
    assert_eq!(committed["tasks"][0]["dependencyState"], "ready");
    assert_eq!(
        committed["tasks"][1]["dependencies"][0],
        committed["tasks"][0]["id"]
    );
    assert_eq!(committed["tasks"][1]["dependencyState"], "waiting");
    assert_eq!(committed["tasks"][0]["taskResult"], Value::Null);
    let head = store.cursors().unwrap();
    assert_eq!(
        execute(&mut store, Some("coordinator"), plan).unwrap(),
        committed
    );
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"setPlan","key":"stale","runId":id,"expectedRevision":1,"tasks":[]}),
        ),
        "revision_conflict",
    );
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"create","key":"run","spec":{"title":"different","goal":"x"}}),
        ),
        "idempotency_conflict",
    );
    assert_eq!(store.cursors().unwrap(), head);
    let mut renamed = task("implement", &[]);
    renamed["title"] = "renamed task".into();
    let updated=execute(&mut store,Some("coordinator"),json!({"action":"setPlan","key":"edit","runId":id,"expectedRevision":2,"tasks":[task("review",&["implement"]),renamed]})).unwrap();
    assert_eq!(updated["run"]["revision"], 3);
    assert_eq!(updated["tasks"][0]["id"], committed["tasks"][1]["id"]);
    assert_eq!(updated["tasks"][1]["id"], committed["tasks"][0]["id"]);
    assert_eq!(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"mutation","key":"plan"})
        )
        .unwrap(),
        committed,
        "historical replay is separate from the current projection"
    );
    let events = serde_json::to_string(&store.read(0, 32, None).unwrap()).unwrap();
    assert!(!events.contains("private goal text") && !events.contains("private task text"));
    assert_eq!(
        store.read(0, 32, Some("coordinator")).unwrap().events.len(),
        3
    );
    assert!(
        store
            .read(0, 32, Some("foreign"))
            .unwrap()
            .events
            .is_empty()
    );
}

#[test]
fn durable_scope_isolation_and_summary_pagination_survive_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-run-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let id;
    {
        let mut store = Store::open(&path).unwrap();
        id = create(&mut store, Some("first"), "run")["run"]["id"].clone();
        error(
            execute(
                &mut store,
                Some("second"),
                json!({"action":"get","runId":id}),
            ),
            "run_not_found",
        );
        error(
            execute(
                &mut store,
                Some("second"),
                json!({"action":"setPlan","key":"foreign","runId":id,"expectedRevision":1,"tasks":[]}),
            ),
            "run_not_found",
        );
        error(
            execute(
                &mut store,
                Some("second"),
                json!({"action":"mutation","key":"run"}),
            ),
            "mutation_not_found",
        );
        assert_eq!(
            execute(&mut store, Some("second"), json!({"action":"list"})).unwrap()["runs"],
            json!([])
        );
        for i in 0..17 {
            create(&mut store, None, &format!("owner-{i}"));
        }
        let page = execute(&mut store, None, json!({"action":"list"})).unwrap();
        assert_eq!(page["runs"].as_array().unwrap().len(), 16);
        assert_eq!(page["nextOffset"], 16);
        assert!(!page.to_string().contains("private goal text"));
        let page = execute(&mut store, None, json!({"action":"list","offset":16})).unwrap();
        assert_eq!(page["runs"].as_array().unwrap().len(), 2);
        assert_eq!(page["nextOffset"], Value::Null);
    }
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        execute(
            &mut store,
            Some("first"),
            json!({"action":"mutation","key":"run"})
        )
        .unwrap()["run"]["id"],
        id
    );
    assert_eq!(
        execute(&mut store, None, json!({"action":"get","runId":id})).unwrap()["run"]["state"],
        "draft"
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}
