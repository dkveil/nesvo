use super::{
    Store,
    orchestration_tests::{error, execute, prepare_run, report, worker},
};
use crate::{
    orchestration::{Actor, Scope},
    workflow_decisions,
};
use serde_json::{Value, json};

fn setup(store: &mut Store) -> (String, String) {
    let plan = prepare_run(store);
    let run = plan["run"]["id"].as_str().unwrap().to_owned();
    let assigned = execute(store,Some("coordinator"),json!({"action":"assign","key":"assign","runId":run,"taskId":plan["tasks"][0]["id"],"sessionId":"worker-1","expectedRevision":3})).unwrap();
    (
        run,
        assigned["tasks"][0]["currentAttempt"]["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}
fn call(store: &mut Store, scope: Scope, request: Value, now: u64) -> anyhow::Result<Value> {
    let issuer = match &scope {
        Scope::Owner => "owner",
        Scope::Coordinator(id) | Scope::Worker(id) => id,
    }
    .to_owned();
    workflow_decisions::execute(
        &mut store.0,
        Actor { issuer, scope },
        serde_json::from_value(request).unwrap(),
        now,
    )
}
fn owner(store: &mut Store, request: Value, now: u64) -> anyhow::Result<Value> {
    call(store, Scope::Owner, request, now)
}
fn ask(store: &mut Store, attempt: &str, audience: &str, key: &str, now: u64) -> Value {
    call(store,Scope::Worker("worker-1".into()),json!({"action":"ask","key":key,"attemptId":attempt,"audience":audience,"question":"Private question łódź\nnever execute $(text)","timeoutMs":1000}),now).unwrap()
}
#[test]
fn only_addressed_authority_answers_exact_attempt_and_ack_cannot_release_gate() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = setup(&mut store);
    let asked = ask(&mut store, &attempt, "owner", "q1", 1000);
    let id = asked["decision"]["id"].clone();
    let answer = json!({"action":"answer","key":"answer","runId":run,"decisionId":id,"expectedRevision":1,"answer":"Private human answer"});
    error(
        call(
            &mut store,
            Scope::Coordinator("coordinator".into()),
            answer.clone(),
            1100,
        ),
        "forbidden",
    );
    error(
        call(
            &mut store,
            Scope::Worker("worker-1".into()),
            answer.clone(),
            1100,
        ),
        "forbidden",
    );
    error(
        call(
            &mut store,
            Scope::Coordinator("stranger".into()),
            json!({"action":"get","runId":run,"decisionId":id}),
            1100,
        ),
        "run_not_found",
    );
    let page = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"inbox","request":{"action":"read","runId":run}}),
    )
    .unwrap();
    let message = &page["messages"][0];
    assert_eq!(message["kind"], "decision");
    assert_eq!(message["payload"]["audience"], "owner");
    execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"inbox","request":{"action":"ack","runId":run,"ids":[message["id"]]}}),
    )
    .unwrap();
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"too-early","attemptId":attempt,"result":report()}),
        ),
        "decision_pending",
    );
    error(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker-1", 1100),
        "decision_pending",
    );
    let current = worker(&mut store, "worker-1", json!({"action":"context"})).unwrap();
    assert_eq!(current["attempt"]["state"], "assigned");
    assert_eq!(current["attempt"]["decisionGate"]["blocksSuccess"], true);
    let answered = owner(&mut store, answer.clone(), 1100).unwrap();
    crate::workflow_budget::guard_dispatch(&mut store.0, "worker-1", 1100).unwrap();
    assert_eq!(answered["decision"]["resolvedBy"]["role"], "owner");
    assert_eq!(answered["run"]["revision"], 4);
    assert_eq!(owner(&mut store, answer.clone(), 1200).unwrap(), answered);
    let mut changed = answer;
    changed["answer"] = "Different intent".into();
    error(owner(&mut store, changed, 1200), "idempotency_conflict");
    let notification = worker(
        &mut store,
        "worker-1",
        json!({"action":"inbox","request":{"action":"read","runId":run}}),
    )
    .unwrap();
    assert_eq!(notification["messages"].as_array().unwrap().len(), 1);
    assert_eq!(notification["messages"][0]["body"], "Private human answer");
    assert_eq!(notification["messages"][0]["payload"]["decisionId"], id);
    let reported = worker(
        &mut store,
        "worker-1",
        json!({"action":"report","key":"result","attemptId":attempt,"result":report()}),
    )
    .unwrap();
    assert_eq!(reported["attempt"]["state"], "reported");
    assert_eq!(reported["attempt"]["decisionGate"]["blocksSuccess"], false);
    let view = execute(
        &mut store,
        Some("coordinator"),
        json!({"action":"get","runId":run}),
    )
    .unwrap();
    assert_eq!(view["tasks"][0]["taskResult"], Value::Null);
    assert_eq!(view["tasks"][1]["dependencyState"], "waiting");
    let events = serde_json::to_string(&store.read(0, 32, None).unwrap()).unwrap();
    assert!(!events.contains("Private question"));
    assert!(!events.contains("Private human answer"));
}
#[test]
fn deadline_is_durable_and_a_late_answer_or_clock_rollback_cannot_resurrect_it() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-decision-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let mut store = Store::open(&path).unwrap();
    let (run, attempt) = setup(&mut store);
    let asked = ask(&mut store, &attempt, "coordinator", "q1", 1000);
    let id = &asked["decision"]["id"];
    let read = json!({"action":"get","runId":run,"decisionId":id});
    assert_eq!(
        owner(&mut store, read.clone(), 1999).unwrap()["decision"]["state"],
        "pending"
    );
    let before = store.cursors().unwrap();
    let answer = json!({"action":"answer","key":"late","runId":run,"decisionId":id,"expectedRevision":1,"answer":"Too late"});
    error(owner(&mut store, answer.clone(), 2000), "revision_conflict");
    assert!(store.cursors().unwrap().0 > before.0);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let expired = owner(&mut store, read, 1500).unwrap();
    assert_eq!(expired["decision"]["state"], "expired");
    assert_eq!(expired["decision"]["resolvedAt"], 2000);
    let mut answer = answer;
    answer["expectedRevision"] = 2.into();
    error(owner(&mut store, answer, 2500), "decision_state_conflict");
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"success","attemptId":attempt,"result":report()}),
        ),
        "decision_pending",
    );
    let mut blocked = report();
    blocked["outcome"] = "blocked".into();
    worker(
        &mut store,
        "worker-1",
        json!({"action":"report","key":"blocked","attemptId":attempt,"result":blocked}),
    )
    .unwrap();
    drop(store);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn cancellation_is_not_approval_and_retry_fences_the_previous_worker() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = setup(&mut store);
    let asked = ask(&mut store, &attempt, "owner", "q1", 1000);
    let id = asked["decision"]["id"].clone();
    let cancel = json!({"action":"cancel","key":"withdraw","runId":run,"decisionId":id,"expectedRevision":1,"reason":"Cannot continue safely"});
    error(
        call(
            &mut store,
            Scope::Coordinator("coordinator".into()),
            cancel.clone(),
            1100,
        ),
        "forbidden",
    );
    let canceled = call(
        &mut store,
        Scope::Worker("worker-1".into()),
        cancel.clone(),
        1100,
    )
    .unwrap();
    assert_eq!(canceled["decision"]["state"], "canceled");
    assert_eq!(
        call(&mut store, Scope::Worker("worker-1".into()), cancel, 1200).unwrap(),
        canceled
    );
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"report","key":"success","attemptId":attempt,"result":report()}),
        ),
        "decision_pending",
    );
    let mut blocked = report();
    blocked["outcome"] = "blocked".into();
    worker(
        &mut store,
        "worker-1",
        json!({"action":"report","key":"blocked","attemptId":attempt,"result":blocked}),
    )
    .unwrap();
    execute(&mut store,None,json!({"action":"validate","key":"reject","runId":run,"attemptId":attempt,"expectedRevision":5,"validation":{"passed":false,"summary":"Needs a deliberate retry","checks":[]}})).unwrap();
    let plan = execute(&mut store, None, json!({"action":"get","runId":run})).unwrap();
    execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"retry","runId":run,"taskId":plan["tasks"][0]["id"],"sessionId":"worker-2","expectedRevision":6})).unwrap();
    error(
        call(
            &mut store,
            Scope::Worker("worker-1".into()),
            json!({"action":"get","runId":run,"decisionId":id}),
            1300,
        ),
        "stale_attempt",
    );
    assert_eq!(
        owner(
            &mut store,
            json!({"action":"get","runId":run,"decisionId":id}),
            1300
        )
        .unwrap()["decision"]["state"],
        "canceled"
    );
}
#[test]
fn question_and_notice_are_atomic_and_invalid_or_duplicate_intents_do_not_leak() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = setup(&mut store);
    let asked = ask(&mut store, &attempt, "coordinator", "q1", 1000);
    let replay = ask(&mut store, &attempt, "coordinator", "q1", 1100);
    assert_eq!(asked, replay);
    error(
        call(
            &mut store,
            Scope::Worker("worker-1".into()),
            json!({"action":"ask","key":"second","attemptId":attempt,"audience":"coordinator","question":"One at a time","timeoutMs":1000}),
            1100,
        ),
        "decision_pending",
    );
    let read = owner(&mut store, json!({"action":"list","runId":run}), 1100).unwrap();
    assert_eq!(read["decisions"].as_array().unwrap().len(), 1);
    let answer = json!({"action":"answer","key":"answer","runId":run,"decisionId":asked["decision"]["id"],"expectedRevision":1,"answer":"Literal $(untrusted) response"});
    call(
        &mut store,
        Scope::Coordinator("coordinator".into()),
        answer,
        1100,
    )
    .unwrap();
    store.0.execute_batch("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<8190) INSERT INTO workflow_messages(id,run_id,recipient,data) SELECT 'capacity-'||i,(SELECT id FROM workflow_runs LIMIT 1),'coordinator','{}' FROM n;").unwrap();
    error(
        call(
            &mut store,
            Scope::Worker("worker-1".into()),
            json!({"action":"ask","key":"full","attemptId":attempt,"audience":"owner","question":"Must not be lost","timeoutMs":1000}),
            1200,
        ),
        "busy",
    );
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM workflow_decisions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    error(
        worker(
            &mut store,
            "worker-1",
            json!({"action":"mutation","key":"full"}),
        ),
        "mutation_not_found",
    );
}

#[test]
fn question_bounds_and_history_pagination_reject_unbounded_or_control_text() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = setup(&mut store);
    for (question, timeout) in [
        ("x".repeat(2049), 1000),
        ("\n".repeat(2048), 1000),
        ("bad\u{1b}text".into(), 1000),
        ("valid".into(), 999),
        ("valid".into(), 604_800_001),
    ] {
        error(
            call(
                &mut store,
                Scope::Worker("worker-1".into()),
                json!({"action":"ask","key":"invalid","attemptId":attempt,"audience":"owner","question":question,"timeoutMs":timeout}),
                1000,
            ),
            "invalid_argument",
        );
    }
    for index in 0..9 {
        let asked = ask(
            &mut store,
            &attempt,
            "coordinator",
            &format!("q-{index}"),
            1000 + index,
        );
        owner(&mut store,json!({"action":"answer","key":format!("a-{index}"),"runId":run,"decisionId":asked["decision"]["id"],"expectedRevision":1,"answer":"Explicit answer"}),1100+index).unwrap();
    }
    let first = owner(&mut store, json!({"action":"list","runId":run}), 1200).unwrap();
    assert_eq!(first["decisions"].as_array().unwrap().len(), 8);
    assert_eq!(first["nextOffset"], 8);
    let last = owner(
        &mut store,
        json!({"action":"list","runId":run,"offset":8}),
        1200,
    )
    .unwrap();
    assert_eq!(last["decisions"].as_array().unwrap().len(), 1);
    assert_eq!(last["nextOffset"], Value::Null);
    error(
        owner(
            &mut store,
            json!({"action":"list","runId":run,"offset":4097}),
            1200,
        ),
        "invalid_argument",
    );
}
