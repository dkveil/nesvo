use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, worker},
};
use crate::workflow_digest::{MAX_BYTES, bound, clip, fingerprint, settle};
use serde_json::{Value, json};

fn result(summary: &str, next_steps: &[&str]) -> Value {
    json!({"outcome":"succeeded","summary":summary,"files":["src/a.rs","src/b.rs"],"artifacts":[],"checks":[{"name":"unit","outcome":"passed","details":"Worker-reported check"},{"name":"lint","outcome":"skipped","details":"Not run"}],"limitations":["Needs independent validation"],"nextSteps":next_steps})
}
fn accept() -> Value {
    json!({"passed":true,"summary":"Explicit owner review","checks":[{"name":"review","outcome":"passed","details":"Owner attestation"}]})
}
fn digest(store: &mut Store, run: &Value) -> Value {
    execute(store, None, json!({"action":"digest","runId":run})).unwrap()
}
fn recorded(store: &Store) -> i64 {
    store
        .0
        .query_row(
            "SELECT count(*) FROM domain_events WHERE kind='run.digest_recorded'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn rows(store: &Store) -> i64 {
    store
        .0
        .query_row("SELECT count(*) FROM workflow_digests", [], |r| r.get(0))
        .unwrap()
}
fn finish(store: &mut Store, run: &Value, task: &Value, session: &str, revision: u64) -> Value {
    let assigned = execute(store,Some("coordinator"),json!({"action":"assign","key":format!("assign-{session}"),"runId":run,"taskId":task,"sessionId":session,"expectedRevision":revision})).unwrap();
    let attempt = assigned["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == *task)
        .unwrap()["currentAttempt"]["id"]
        .clone();
    worker(store,session,json!({"action":"report","key":"result","attemptId":attempt,"result":result("Reviewed the parser",&[])})).unwrap();
    execute(store,None,json!({"action":"validate","key":format!("accept-{session}"),"runId":run,"attemptId":attempt,"expectedRevision":revision+2,"validation":accept()})).unwrap()
}

#[test]
fn digest_reports_live_working_state_without_journal_writes_and_records_the_final_digest_once() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let run = plan["run"]["id"].clone();
    let implement = plan["tasks"][0]["id"].clone();
    let review = plan["tasks"][1]["id"].clone();
    let assigned = execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"bind","runId":run,"taskId":implement,"sessionId":"worker-1","expectedRevision":3})).unwrap();
    let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
    worker(&mut store,"worker-1",json!({"action":"report","key":"result","attemptId":attempt,"result":result("Implemented the parser\nand covered it",&["Wire the parser into the CLI","Document the flag"])})).unwrap();
    let head = store.cursors().unwrap();
    let live = digest(&mut store, &run);
    assert_eq!(head, store.cursors().unwrap());
    assert_eq!(live["stored"], false);
    assert_eq!(live["run"]["state"], "active");
    assert!(live["run"].get("goal").is_none());
    let body = &live["digest"];
    assert_eq!(body["kind"], "workingState");
    assert_eq!(body["sourceRevision"], 5);
    assert_eq!(
        body["tasks"],
        json!({"total":2,"byState":{"planned":1,"reported":1}})
    );
    let first = &body["taskDigests"][0];
    assert_eq!(first["key"], "implement");
    assert_eq!(first["outcome"], "succeeded");
    assert_eq!(first["summary"], "Implemented the parser and covered it");
    assert_eq!(first["files"], json!(["src/a.rs", "src/b.rs"]));
    assert_eq!(first["checks"], json!({"passed":1,"failed":0,"skipped":1}));
    assert_eq!(first["limitations"], 1);
    assert_eq!(
        first["nextSteps"],
        json!(["Wire the parser into the CLI", "Document the flag"])
    );
    assert_eq!(first["attempt"]["sessionId"], "worker-1");
    assert_eq!(first["validation"], Value::Null);
    assert_eq!(body["taskDigests"][1]["attempt"], Value::Null);
    assert_eq!(
        body["decisions"],
        json!({"answered":0,"closed":0,"pending":0,"total":0})
    );
    assert_eq!(body["evidence"]["journalCursor"], head.0);
    assert_eq!(body["evidence"]["checkpointCount"], 0);
    assert_eq!(body["budget"]["activeAttempts"], 1);
    assert_eq!(live["fingerprint"], fingerprint(body).unwrap());
    assert_eq!(digest(&mut store, &run)["fingerprint"], live["fingerprint"]);
    assert_eq!(recorded(&store), 0);
    execute(&mut store,None,json!({"action":"validate","key":"accept","runId":run,"attemptId":attempt,"expectedRevision":5,"validation":accept()})).unwrap();
    assert_eq!(recorded(&store), 0);
    let finished = finish(&mut store, &run, &review, "reviewer", 6);
    assert_eq!(finished["run"]["state"], "succeeded");
    assert_eq!((recorded(&store), rows(&store)), (1, 1));
    let event: Value = serde_json::from_str(
        &store
            .0
            .query_row(
                "SELECT payload FROM domain_events WHERE kind='run.digest_recorded'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    let stored = digest(&mut store, &run);
    assert_eq!(stored["stored"], true);
    assert_eq!(stored["digest"]["kind"], "final");
    assert_eq!(stored["digest"]["state"], "succeeded");
    assert_eq!(stored["digest"]["sourceRevision"], 9);
    assert_eq!(
        stored["digest"]["taskDigests"][1]["validation"]["source"],
        "ownerAttestation"
    );
    assert_eq!(event["fingerprint"], stored["fingerprint"]);
    assert_eq!(event["revision"], 9);
    assert_eq!(
        stored["fingerprint"],
        fingerprint(&stored["digest"]).unwrap()
    );
    assert_eq!(digest(&mut store, &run), stored);
    let transaction = store.0.transaction().unwrap();
    settle(&transaction, run.as_str().unwrap(), 42).unwrap();
    transaction.commit().unwrap();
    assert_eq!((recorded(&store), rows(&store)), (1, 1));
    assert_eq!(digest(&mut store, &run), stored);
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"digest","runId":run}),
        ),
        "forbidden",
    );
    error(
        execute(
            &mut store,
            Some("other-coordinator"),
            json!({"action":"digest","runId":run}),
        ),
        "run_not_found",
    );
    error(
        execute(
            &mut store,
            None,
            json!({"action":"digest","runId":"missing"}),
        ),
        "run_not_found",
    );
}

#[test]
fn digest_working_state_is_inherited_by_the_dependent_task_context_only() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let run = plan["run"]["id"].clone();
    let implement = plan["tasks"][0]["id"].clone();
    let review = plan["tasks"][1]["id"].clone();
    let assigned = execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"bind","runId":run,"taskId":implement,"sessionId":"worker-1","expectedRevision":3})).unwrap();
    let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
    let own = worker(&mut store, "worker-1", json!({"action":"context"})).unwrap();
    assert_eq!(own["workingState"], Value::Null);
    worker(&mut store,"worker-1",json!({"action":"report","key":"result","attemptId":attempt,"result":result("Parser done",&["Wire the parser into the CLI"])})).unwrap();
    execute(&mut store,None,json!({"action":"validate","key":"accept","runId":run,"attemptId":attempt,"expectedRevision":5,"validation":accept()})).unwrap();
    execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"review","runId":run,"taskId":review,"sessionId":"reviewer","expectedRevision":6})).unwrap();
    let context = worker(&mut store, "reviewer", json!({"action":"context"})).unwrap();
    let inherited = &context["workingState"];
    assert_eq!(inherited["kind"], "inherited");
    assert_eq!(inherited["tasks"]["total"], 1);
    assert_eq!(inherited["taskDigests"][0]["key"], "implement");
    assert_eq!(inherited["taskDigests"][0]["state"], "succeeded");
    assert_eq!(
        inherited["taskDigests"][0]["nextSteps"],
        json!(["Wire the parser into the CLI"])
    );
    for private in [
        "decisions",
        "openDecisions",
        "budget",
        "inbox",
        "evidence",
        "producedAt",
    ] {
        assert!(inherited.get(private).is_none(), "{private}");
    }
    assert!(serde_json::to_vec(inherited).unwrap().len() <= MAX_BYTES);
    let recovered = worker(&mut store, "reviewer", json!({"action":"context"})).unwrap();
    assert_eq!(recovered["workingState"], context["workingState"]);
}

#[test]
fn digest_follows_drain_and_resume_and_replaces_its_record_at_a_newer_revision() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let plan = prepare_run(&mut store);
    let run = plan["run"]["id"].clone();
    let drained = execute(
        &mut store,
        None,
        json!({"action":"drain","key":"drain-1","runId":run,"expectedRevision":3}),
    )
    .unwrap();
    assert_eq!(drained["run"]["state"], "drained");
    assert_eq!((recorded(&store), rows(&store)), (1, 1));
    let first = digest(&mut store, &run);
    assert_eq!(first["digest"]["kind"], "final");
    assert_eq!(first["digest"]["state"], "drained");
    assert_eq!(first["digest"]["sourceRevision"], 4);
    execute(
        &mut store,
        None,
        json!({"action":"resume","key":"resume-1","runId":run,"expectedRevision":4}),
    )
    .unwrap();
    let live = digest(&mut store, &run);
    assert_eq!(live["stored"], false);
    assert_eq!(live["digest"]["kind"], "workingState");
    execute(
        &mut store,
        None,
        json!({"action":"drain","key":"drain-2","runId":run,"expectedRevision":5}),
    )
    .unwrap();
    assert_eq!((recorded(&store), rows(&store)), (2, 1));
    let second = digest(&mut store, &run);
    assert_eq!(second["digest"]["sourceRevision"], 6);
    assert_ne!(second["digest"]["producedAt"], Value::Null);
    store
        .0
        .execute("UPDATE workflow_digests SET source_revision=1", [])
        .unwrap();
    let refreshed = digest(&mut store, &run);
    assert_eq!(refreshed["digest"]["sourceRevision"], 6);
    assert_eq!(recorded(&store), 3);
}

#[test]
fn digest_bounds_compact_long_task_records_and_count_what_was_omitted() {
    let task = |index: usize| {
        json!({"id":format!("task-{index}"),"key":format!("k{index}"),"title":"t".repeat(80),"state":"succeeded","summary":clip(&"łódź ".repeat(200), 240),
        "files":["a".repeat(160),"b".repeat(160),"c".repeat(160),"d".repeat(160)],"filesTotal":32,
        "nextSteps":["n".repeat(160),"m".repeat(160),"o".repeat(160)],"workspace":{"kind":"worktree","directory":"C:/".repeat(170),"branch":"nesvo/0123456789abcdef"}})
    };
    let small = json!({"kind":"final","taskDigests":[task(0)],"omittedTasks":0,"truncated":false});
    assert_eq!(bound(small.clone()), small);
    let body = json!({"kind":"final","taskDigests":(0..64).map(task).collect::<Vec<_>>(),"omittedTasks":0,"truncated":false,
        "openDecisions":[{"question":"q"}],"evidence":{"journalCursor":7,"checkpoints":[{"id":"c"}]}});
    let bounded = bound(body);
    assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_BYTES);
    assert_eq!(bounded["truncated"], true);
    let kept = bounded["taskDigests"].as_array().unwrap();
    assert!(!kept.is_empty());
    assert_eq!(
        bounded["omittedTasks"].as_u64().unwrap() as usize + kept.len(),
        64
    );
    assert_eq!(kept[0]["key"], "k0");
    assert_eq!(kept[0]["files"], json!([]));
    assert_eq!(kept[0]["filesTotal"], 32);
    assert_eq!(kept[0]["nextSteps"].as_array().unwrap().len(), 1);
    assert_eq!(kept[0]["workspace"]["directory"], Value::Null);
    assert_eq!(kept[0]["workspace"]["branch"], "nesvo/0123456789abcdef");
    assert!(kept[0]["summary"].as_str().unwrap().len() <= 80);
    let clipped = clip(&"łódź ".repeat(200), 240);
    assert!(clipped.len() <= 240 && clipped.ends_with('…'));
    assert_eq!(clip("a\n\tb   c", 240), "a b c");
}
