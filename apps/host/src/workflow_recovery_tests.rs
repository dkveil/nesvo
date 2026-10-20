use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, worker},
};
use serde_json::{Value, json};

fn recover(store: &mut Store, caller: Option<&str>, run: Option<&Value>) -> anyhow::Result<Value> {
    execute(store, caller, json!({"action":"recover","runId":run}))
}
#[test]
fn recovery_resolves_only_authenticated_unique_runs_without_mutations_or_effects() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    assert_eq!(
        recover(&mut store, Some("coordinator"), None).unwrap()["bound"],
        false
    );
    let plan = prepare_run(&mut store);
    let id = &plan["run"]["id"];
    let before = store.cursors().unwrap();
    let recovery = recover(&mut store, Some("coordinator"), None).unwrap();
    assert_eq!(recovery["scope"], "coordinator");
    assert_eq!(recovery["bound"], true);
    assert_eq!(recovery["selectionRequired"], false);
    assert_eq!(recovery["nativeEffectsRestored"], false);
    assert_eq!(recovery["page"]["run"]["id"], *id);
    assert!(
        recovery["page"]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["kind"] == "run" && p["data"]["goal"] == "private goal text")
    );
    error(recover(&mut store, None, None), "invalid_argument");
    assert_eq!(
        recover(&mut store, None, Some(id)).unwrap()["page"]["context"]["digest"],
        recovery["page"]["context"]["digest"]
    );
    assert_eq!(
        recover(&mut store, Some("foreign"), None).unwrap()["bound"],
        false
    );
    error(
        recover(&mut store, Some("foreign"), Some(id)),
        "run_not_found",
    );
    assert_eq!(store.cursors().unwrap(), before);
    let receipts: i64 = store
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(receipts, 0);
}
#[test]
fn multiple_retained_runs_require_selection_and_never_use_creation_order_or_titles() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let first = prepare_run(&mut store);
    let id = &first["run"]["id"];
    for n in 0..9 {
        execute(&mut store,Some("coordinator"),json!({"action":"create","key":format!("another-{n}"),"spec":{"title":"Duplicate display name","goal":"Do not guess identity","coordinatorSessionId":"coordinator"}})).unwrap();
    }
    let before = store.cursors().unwrap();
    let selection = recover(&mut store, Some("coordinator"), None).unwrap();
    assert_eq!(selection["selectionRequired"], true);
    assert_eq!(selection["bound"], false);
    assert_eq!(selection["hasMoreRuns"], true);
    assert_eq!(selection["runs"].as_array().unwrap().len(), 8);
    assert!(selection.get("page").is_none());
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"recover","offset":1}),
        ),
        "invalid_cursor",
    );
    assert_eq!(
        recover(&mut store, Some("coordinator"), Some(id)).unwrap()["page"]["run"]["id"],
        *id
    );
    assert_eq!(store.cursors().unwrap(), before);
    store
        .0
        .execute(
            "UPDATE workflow_runs SET state='succeeded' WHERE id!=?1",
            [id.as_str().unwrap()],
        )
        .unwrap();
    assert_eq!(
        recover(&mut store, Some("coordinator"), None).unwrap()["selectionRequired"],
        true
    );
    store
        .0
        .execute("UPDATE workflow_runs SET state='succeeded'", [])
        .unwrap();
    assert_eq!(
        recover(&mut store, Some("coordinator"), Some(id)).unwrap()["page"]["run"]["state"],
        "succeeded"
    );
}
#[test]
fn workers_recover_only_their_current_attempt_and_never_select_parent_manifests() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let id = &plan["run"]["id"];
    assert_eq!(
        worker(&mut store, "unbound", json!({"action":"recover"})).unwrap()["bound"],
        false
    );
    let assigned=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"worker","runId":id,"taskId":plan["tasks"][0]["id"],"sessionId":"worker","expectedRevision":3})).unwrap();
    execute(&mut store,None,json!({"action":"constraints","request":{"action":"add","key":"rule","runId":id,"expectedRevision":assigned["run"]["revision"],"text":"Preserve this current owner rule"}})).unwrap();
    let before = store.cursors().unwrap();
    let recovery = worker(&mut store, "worker", json!({"action":"recover"})).unwrap();
    assert_eq!(recovery["scope"], "worker");
    assert_eq!(recovery["bound"], true);
    assert!(recovery.get("page").is_none());
    assert!(recovery.get("runs").is_none());
    assert_eq!(
        recovery["taskContext"]["attempt"]["id"],
        assigned["tasks"][0]["currentAttempt"]["id"]
    );
    assert_eq!(
        recovery["taskContext"]["constraints"]["policy"]["pending"],
        true
    );
    assert_eq!(
        recovery["taskContext"]["constraints"]["records"][0]["text"],
        "Preserve this current owner rule"
    );
    for extra in [
        json!({"runId":id}),
        json!({"offset":1}),
        json!({"expectedDigest":"forged"}),
    ] {
        let mut request = extra;
        request["action"] = "recover".into();
        error(worker(&mut store, "worker", request), "forbidden");
    }
    assert_eq!(store.cursors().unwrap(), before);
    assert_eq!(
        recover(&mut store, None, Some(id)).unwrap()["page"]["currentConstraints"]["pending"],
        true
    );
}
#[test]
fn recovery_pages_share_current_digest_fences_and_never_acknowledge_new_owner_context() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let id = &plan["run"]["id"];
    for n in 0..8 {
        let revision=execute(&mut store,None,json!({"action":"get","runId":id})).unwrap()["run"]["revision"].clone();
        execute(&mut store,None,json!({"action":"constraints","request":{"action":"add","key":format!("rule-{n}"),"runId":id,"expectedRevision":revision,"text":format!("Manual rule {n}")}})).unwrap();
    }
    let before = store.cursors().unwrap();
    let first = recover(&mut store, Some("coordinator"), None).unwrap();
    let offset = first["page"]["nextOffset"].as_u64().unwrap();
    let digest = &first["page"]["context"]["digest"];
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"recover","runId":id,"offset":offset}),
        ),
        "context_changed",
    );
    let next = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"recover","runId":id,"offset":offset,"expectedDigest":digest}),
    )
    .unwrap();
    assert_eq!(next["page"]["context"]["digest"], *digest);
    assert_eq!(store.cursors().unwrap(), before);
    let revision =
        execute(&mut store, None, json!({"action":"get","runId":id})).unwrap()["run"]["revision"]
            .clone();
    execute(&mut store,None,json!({"action":"constraints","request":{"action":"add","key":"latest-rule","runId":id,"expectedRevision":revision,"text":"Never erase this newer rule"}})).unwrap();
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"recover","runId":id,"offset":offset,"expectedDigest":digest}),
        ),
        "context_changed",
    );
    let current = recover(&mut store, Some("coordinator"), Some(id)).unwrap();
    assert_eq!(current["page"]["currentConstraints"]["revision"], 9);
    assert_eq!(current["page"]["currentConstraints"]["pending"], true);
}
