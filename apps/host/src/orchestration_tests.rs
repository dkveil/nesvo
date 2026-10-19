use super::Store;
use crate::orchestration::{self, Actor, Request};
use serde_json::{Value, json};

fn actor(id: Option<&str>) -> Actor {
    Actor {
        issuer: id.unwrap_or("owner").into(),
        coordinator: id.map(str::to_owned),
    }
}
fn execute(store: &mut Store, id: Option<&str>, value: Value) -> anyhow::Result<Value> {
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
fn error(result: anyhow::Result<Value>, code: &str) {
    assert_eq!(
        result
            .unwrap_err()
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        code
    );
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
