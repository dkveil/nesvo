use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, report, worker},
};
use serde_json::{Value, json};

fn prepare(store: &mut Store) -> (Value, Value) {
    let plan = prepare_run(store);
    let run = plan["run"]["id"].clone();
    let task = plan["tasks"][0]["id"].clone();
    let assigned=execute(store,Some("coordinator"),json!({"action":"assign","key":"assign","runId":run,"taskId":task,"sessionId":"worker-1","expectedRevision":3})).unwrap();
    (run, assigned["tasks"][0]["currentAttempt"]["id"].clone())
}
fn inbox(store: &mut Store, who: Option<&str>, request: Value) -> anyhow::Result<Value> {
    execute(store, who, json!({"action":"inbox","request":request}))
}
fn worker_inbox(store: &mut Store, request: Value) -> anyhow::Result<Value> {
    worker(
        store,
        "worker-1",
        json!({"action":"inbox","request":request}),
    )
}
fn send(run: &Value, attempt: Option<&Value>, key: &str) -> Value {
    json!({"action":"send","runId":run,"attemptId":attempt,"key":key,"correlationId":"task-context","body":"Literal private note łódź $(do-not-execute)\nline two"})
}

#[test]
fn only_the_receiver_acks_exact_ids_and_new_messages_survive_a_stale_read() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = prepare(&mut store);
    let request = send(&run, Some(&attempt), "note-1");
    let first = inbox(&mut store, Some("coordinator"), request.clone()).unwrap();
    let id = first["message"]["id"].clone();
    assert_eq!(first["message"]["sender"]["sessionId"], "coordinator");
    assert_eq!(first["message"]["recipientAttemptId"], attempt);
    assert_eq!(
        inbox(&mut store, Some("coordinator"), request).unwrap(),
        first
    );
    let read = json!({"action":"read","runId":run});
    let own = worker_inbox(&mut store, read.clone()).unwrap();
    assert_eq!(own["pendingCount"], 1);
    assert_eq!(own["messages"][0]["id"], id);
    assert_eq!(
        worker_inbox(&mut store, read.clone()).unwrap()["messages"],
        own["messages"]
    );
    assert_eq!(
        inbox(&mut store, Some("coordinator"), read.clone()).unwrap()["pendingCount"],
        0
    );
    error(
        worker_inbox(
            &mut store,
            json!({"action":"read","runId":run,"attemptId":"foreign"}),
        ),
        "forbidden",
    );
    error(
        inbox(&mut store, Some("foreign"), read.clone()),
        "run_not_found",
    );
    error(
        inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"ack","runId":run,"attemptId":attempt,"ids":[id]}),
        ),
        "forbidden",
    );
    error(
        worker_inbox(
            &mut store,
            send(&run, Some(&attempt), "worker-forged-target"),
        ),
        "forbidden",
    );
    let other =
        inbox(&mut store, None, send(&run, None, "owner-note")).unwrap()["message"]["id"].clone();
    error(
        worker_inbox(
            &mut store,
            json!({"action":"ack","runId":run,"ids":[id,other]}),
        ),
        "message_not_found",
    );
    assert_eq!(
        worker_inbox(&mut store, read.clone()).unwrap()["pendingCount"],
        1,
        "batch rejection cannot partially ACK"
    );
    error(
        worker_inbox(
            &mut store,
            json!({"action":"ack","runId":run,"ids":[id,id]}),
        ),
        "invalid_argument",
    );
    let new = inbox(
        &mut store,
        Some("coordinator"),
        send(&run, Some(&attempt), "note-2"),
    )
    .unwrap()["message"]["id"]
        .clone();
    let ack = json!({"action":"ack","runId":run,"ids":[id]});
    let accepted = worker_inbox(&mut store, ack.clone()).unwrap();
    let head = store.cursors().unwrap();
    assert_eq!(worker_inbox(&mut store, ack).unwrap(), accepted);
    assert_eq!(
        store.cursors().unwrap(),
        head,
        "ACK retry without changes emits no new event"
    );
    assert_eq!(accepted["acknowledged"][0]["ackedBy"]["role"], "worker");
    let pending = worker_inbox(&mut store, read).unwrap();
    assert_eq!(pending["pendingCount"], 1);
    assert_eq!(pending["messages"][0]["id"], new);
    let owner = inbox(
        &mut store,
        None,
        json!({"action":"ack","runId":run,"attemptId":attempt,"ids":[new]}),
    )
    .unwrap();
    assert_eq!(owner["acknowledged"][0]["ackedBy"]["role"], "owner");
    let run = execute(&mut store, None, json!({"action":"get","runId":run})).unwrap();
    assert_eq!(run["run"]["revision"], 4);
    assert_eq!(run["tasks"][0]["taskResult"], Value::Null);
}

#[test]
fn result_notification_is_deduplicated_and_ack_does_not_validate_work() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = prepare(&mut store);
    let request = json!({"action":"report","key":"result","attemptId":attempt,"result":report()});
    let first = worker(&mut store, "worker-1", request.clone()).unwrap();
    assert_eq!(worker(&mut store, "worker-1", request).unwrap(), first);
    let page = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"read","runId":run}),
    )
    .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    let message = &page["messages"][0];
    assert_eq!(message["kind"], "result");
    assert_eq!(message["payload"]["attemptId"], attempt);
    assert_eq!(message["sender"]["sessionId"], "worker-1");
    assert_eq!(message["correlationId"], attempt);
    inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"ack","runId":run,"ids":[message["id"]]}),
    )
    .unwrap();
    let current = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run}),
    )
    .unwrap();
    assert_eq!(current["run"]["revision"], 5);
    assert_eq!(current["tasks"][0]["state"], "reported");
    assert_eq!(current["tasks"][0]["taskResult"], Value::Null);
    assert_eq!(current["tasks"][1]["dependencyState"], "waiting");
    let events = serde_json::to_string(&store.read(0, 32, None).unwrap()).unwrap();
    assert!(!events.contains("Worker claims completion"));
    assert!(!events.contains("Literal private note"));
}

#[test]
fn unread_messages_and_ack_identity_survive_consumer_and_store_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-inbox-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let run;
    let id;
    {
        let mut store = Store::open(&path).unwrap();
        (run, _) = prepare(&mut store);
        let sent = worker_inbox(&mut store, send(&run, None, "worker-question")).unwrap();
        id = sent["message"]["id"].clone();
        let page = inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"read","runId":run}),
        )
        .unwrap();
        assert_eq!(page["messages"][0]["id"], id);
        let receipt = worker(
            &mut store,
            "worker-1",
            json!({"action":"mutation","key":"worker-question"}),
        )
        .unwrap();
        assert_eq!(receipt, sent);
    }
    let ack;
    {
        let mut store = Store::open(&path).unwrap();
        let pending = inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"read","runId":run}),
        )
        .unwrap();
        assert_eq!(pending["messages"][0]["id"], id);
        ack = inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"ack","runId":run,"ids":[id]}),
        )
        .unwrap()["acknowledged"]
            .clone();
    }
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        inbox(&mut store, None, json!({"action":"read","runId":run})).unwrap()["pendingCount"],
        0
    );
    let history = inbox(
        &mut store,
        None,
        json!({"action":"read","runId":run,"includeAcked":true}),
    )
    .unwrap();
    assert_eq!(history["messages"][0]["ackedAt"], ack[0]["ackedAt"]);
    assert_eq!(
        history["messages"][0]["ackedBy"]["sessionId"],
        "coordinator"
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn message_pages_and_encoded_bounds_are_explicit_without_cursor_ack() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, _) = prepare(&mut store);
    for n in 0..10 {
        inbox(
            &mut store,
            Some("coordinator"),
            send(&run, None, &format!("note-{n}")),
        )
        .unwrap();
    }
    let page = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"read","runId":run}),
    )
    .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 8);
    assert_eq!(page["more"], true);
    let remaining = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"read","runId":run,"after":page["nextCursor"]}),
    )
    .unwrap();
    assert_eq!(remaining["messages"].as_array().unwrap().len(), 2);
    assert_eq!(remaining["pendingCount"], 10);
    let again = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"read","runId":run}),
    )
    .unwrap();
    assert_eq!(again["messages"], page["messages"]);
    let ids: Vec<_> = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"ack","runId":run,"ids":ids}),
    )
    .unwrap();
    assert_eq!(
        inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"read","runId":run})
        )
        .unwrap()["pendingCount"],
        2
    );
    error(
        inbox(
            &mut store,
            Some("coordinator"),
            json!({"action":"read","runId":run,"after":999999}),
        ),
        "invalid_cursor",
    );
    let mut oversized = send(&run, None, "too-large");
    oversized["body"] = json!("x".repeat(4097));
    error(
        inbox(&mut store, Some("coordinator"), oversized),
        "invalid_argument",
    );
    let mut encoded = send(&run, None, "encoded-large");
    encoded["body"] = json!("\"".repeat(4096));
    error(
        inbox(&mut store, Some("coordinator"), encoded),
        "invalid_argument",
    );
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"mutation","key":"encoded-large"}),
        ),
        "mutation_not_found",
    );
    let events = serde_json::to_string(&store.read(0, 32, None).unwrap()).unwrap();
    assert!(!events.contains("Literal private note"));
}

#[test]
fn superseded_worker_cannot_reclaim_a_mailbox_but_owner_retains_its_history() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, first) = prepare(&mut store);
    let old_note = inbox(
        &mut store,
        Some("coordinator"),
        send(&run, Some(&first), "old-note"),
    )
    .unwrap();
    worker_inbox(&mut store, send(&run, None, "old-worker-message")).unwrap();
    worker(
        &mut store,
        "worker-1",
        json!({"action":"report","key":"old-result","attemptId":first,"result":report()}),
    )
    .unwrap();
    execute(&mut store,Some("coordinator"),json!({"action":"validate","key":"reject-old","runId":run,"attemptId":first,"expectedRevision":5,"validation":{"passed":false,"summary":"Retry required","checks":[]}})).unwrap();
    let task = execute(&mut store, None, json!({"action":"get","runId":run})).unwrap()["tasks"][0]
        ["id"]
        .clone();
    execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"new-attempt","runId":run,"taskId":task,"sessionId":"worker-2","expectedRevision":6})).unwrap();
    error(
        worker_inbox(&mut store, json!({"action":"read","runId":run})),
        "stale_attempt",
    );
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"mutation","key":"old-worker-message"}),
        ),
        "stale_attempt",
    );
    error(
        inbox(
            &mut store,
            Some("coordinator"),
            send(&run, Some(&first), "late-parent-note"),
        ),
        "stale_attempt",
    );
    let retained = inbox(
        &mut store,
        None,
        json!({"action":"read","runId":run,"attemptId":first}),
    )
    .unwrap();
    assert_eq!(retained["messages"][0]["id"], old_note["message"]["id"]);
    inbox(
        &mut store,
        None,
        json!({"action":"ack","runId":run,"attemptId":first,"ids":[old_note["message"]["id"]]}),
    )
    .unwrap();
    let coordinator = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"read","runId":run}),
    )
    .unwrap();
    assert_eq!(
        coordinator["pendingCount"], 2,
        "Prior attempt messages remain explicitly identified, not silently dropped"
    );
}

#[test]
fn full_inbox_rolls_back_result_acceptance_but_ack_remains_available() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = prepare(&mut store);
    let request = send(&run, None, "original");
    let original = inbox(&mut store, Some("coordinator"), request.clone()).unwrap();
    store.0.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8191) INSERT INTO workflow_messages(id,run_id,recipient,data) SELECT 'fixture-'||x,?1,'coordinator',json_object('id','fixture-'||x,'runId',?1,'recipientAttemptId',NULL,'sender',json_object('role','owner'),'correlationId','capacity-fixture','kind','note','body','explicit capacity fixture','payload',NULL,'createdAt',1) FROM n",[run.as_str().unwrap()]).unwrap();
    let head = store.cursors().unwrap();
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"full-result","attemptId":attempt,"result":report()}),
        ),
        "busy",
    );
    assert_eq!(store.cursors().unwrap(), head);
    let current = execute(&mut store, None, json!({"action":"get","runId":run})).unwrap();
    assert_eq!(current["tasks"][0]["state"], "assigned");
    assert_eq!(current["run"]["revision"], 4);
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"mutation","key":"full-result"}),
        ),
        "mutation_not_found",
    );
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM workflow_mutations", [], |r| r.get(0))
        .unwrap();
    store.0.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO workflow_mutations(issuer,key,digest,view) SELECT 'capacity-fixture','key-'||x,'fixture','{}' FROM n",[4096-count]).unwrap();
    let ack = inbox(
        &mut store,
        Some("coordinator"),
        json!({"action":"ack","runId":run,"ids":[original["message"]["id"]]}),
    )
    .unwrap();
    assert_eq!(ack["acknowledged"].as_array().unwrap().len(), 1);
    assert_eq!(
        inbox(&mut store, Some("coordinator"), request).unwrap(),
        original
    );
}
