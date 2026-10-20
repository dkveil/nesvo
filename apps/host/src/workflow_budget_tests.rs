use super::{
    Store,
    orchestration_tests::{error, report},
};
use crate::orchestration::{self, Actor, Scope};
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
fn execute(store: &mut Store, role: &str, request: Value, now: u64) -> anyhow::Result<Value> {
    orchestration::execute_at(
        &mut store.0,
        actor(role),
        serde_json::from_value(request).unwrap(),
        now,
    )
}
fn draft(store: &mut Store, count: usize) -> Value {
    let created=execute(store,"coordinator",json!({"action":"create","key":"run","spec":{"title":"Budget run","goal":"Bounded work","coordinatorSessionId":"coordinator"}}),10_000).unwrap();
    execute(store,"coordinator",json!({"action":"setPlan","key":"plan","runId":created["run"]["id"],"expectedRevision":1,"tasks":(0..count).map(|i|json!({"key":format!("task-{i}"),"title":"Task","instruction":"Controlled budget fixture"})).collect::<Vec<_>>()}),10_000).unwrap()
}
fn limits(parallel: u16, attempts: u16, elapsed: Option<u64>) -> Value {
    json!({"maxParallel":parallel,"maxAttemptsPerTask":attempts,"maxElapsedMs":elapsed})
}
fn policy(
    store: &mut Store,
    role: &str,
    key: &str,
    run: &Value,
    limits: Value,
    now: u64,
) -> anyhow::Result<Value> {
    execute(
        store,
        role,
        json!({"action":"runBudget","request":{"action":"set","key":key,"runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"limits":limits}}),
        now,
    )
}
fn change(
    store: &mut Store,
    role: &str,
    action: &str,
    key: &str,
    run: &Value,
    now: u64,
) -> anyhow::Result<Value> {
    execute(
        store,
        role,
        json!({"action":action,"key":key,"runId":run["run"]["id"],"expectedRevision":run["run"]["revision"]}),
        now,
    )
}
fn assign(
    store: &mut Store,
    run: &Value,
    task: &Value,
    session: &str,
    now: u64,
) -> anyhow::Result<Value> {
    execute(
        store,
        "coordinator",
        json!({"action":"assign","key":format!("assign-{session}"),"runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"taskId":task,"sessionId":session}),
        now,
    )
}
fn validate(store: &mut Store, run: &Value, attempt: &Value, passed: bool, now: u64) -> Value {
    execute(store,"owner",json!({"action":"validate","key":format!("validate-{}",run["run"]["revision"]),"runId":run["run"]["id"],"expectedRevision":run["run"]["revision"],"attemptId":attempt,"validation":{"passed":passed,"summary":"Owner checks result","checks":[{"name":"review","outcome":if passed {"passed"} else {"failed"},"details":"Explicit test attestation"}]}}),now).unwrap()
}
fn current(store: &mut Store, run: &Value, now: u64) -> Value {
    execute(
        store,
        "owner",
        json!({"action":"get","runId":run["run"]["id"]}),
        now,
    )
    .unwrap()
}

#[test]
fn reported_results_occupy_parallel_slots_and_retries_require_owner_extension() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let draft = draft(&mut store, 2);
    let tasks = [
        draft["tasks"][0]["id"].clone(),
        draft["tasks"][1]["id"].clone(),
    ];
    let budget = policy(
        &mut store,
        "coordinator",
        "budget",
        &draft,
        limits(1, 1, None),
        11_000,
    )
    .unwrap();
    assert_eq!(budget["policy"]["timeState"], "notStarted");
    let run = change(
        &mut store,
        "coordinator",
        "activate",
        "start",
        &budget,
        20_000,
    )
    .unwrap();
    let run = assign(&mut store, &run, &tasks[0], "worker-1", 20_001).unwrap();
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    error(
        assign(&mut store, &run, &tasks[1], "worker-2", 20_002),
        "parallel_budget_exhausted",
    );
    execute(
        &mut store,
        "worker-1",
        json!({"action":"report","key":"result","attemptId":attempt,"result":report()}),
        20_003,
    )
    .unwrap();
    let run = current(&mut store, &run, 20_003);
    assert_eq!(run["run"]["budget"]["activeAttempts"], 1);
    error(
        assign(&mut store, &run, &tasks[1], "worker-2", 20_004),
        "parallel_budget_exhausted",
    );
    let run = validate(&mut store, &run, &attempt, false, 20_005);
    error(
        assign(&mut store, &run, &tasks[0], "worker-retry", 20_006),
        "retry_budget_exhausted",
    );
    error(
        policy(
            &mut store,
            "coordinator",
            "self-raise",
            &run,
            limits(2, 2, None),
            20_006,
        ),
        "forbidden",
    );
    let run = policy(
        &mut store,
        "owner",
        "owner-raise",
        &run,
        limits(2, 2, None),
        20_007,
    )
    .unwrap();
    let run = assign(&mut store, &run, &tasks[0], "worker-retry", 20_008).unwrap();
    assert_eq!(run["tasks"][0]["currentAttempt"]["ordinal"], 2);
    error(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker-1", 20_009),
        "stale_attempt",
    );
    crate::workflow_budget::guard_dispatch(&mut store.0, "worker-retry", 20_009).unwrap();
    error(
        execute(
            &mut store,
            "worker-retry",
            json!({"action":"runBudget","request":{"action":"get","runId":run["run"]["id"]}}),
            20_009,
        ),
        "forbidden",
    );
}

#[test]
fn elapsed_exhaustion_survives_rejected_admission_clock_rollback_and_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-run-budget-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let draft = draft(&mut store, 2);
    let task = draft["tasks"][0]["id"].clone();
    let policy_view = policy(
        &mut store,
        "owner",
        "timed",
        &draft,
        limits(2, 2, Some(1000)),
        12_000,
    )
    .unwrap();
    assert_eq!(policy_view["policy"]["startedAt"], Value::Null);
    let run = change(
        &mut store,
        "owner",
        "activate",
        "start",
        &policy_view,
        20_000,
    )
    .unwrap();
    assert_eq!(run["run"]["budget"]["deadlineAt"], 21_000);
    error(
        assign(&mut store, &run, &task, "too-late", 21_000),
        "time_budget_exhausted",
    );
    let head = store.cursors().unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    error(
        assign(&mut store, &run, &task, "rollback", 19_000),
        "time_budget_exhausted",
    );
    assert_eq!(
        store.cursors().unwrap(),
        head,
        "First exhaustion event commits once even when admission rejects"
    );
    let run = current(&mut store, &run, 19_000);
    assert_eq!(run["run"]["budget"]["exhaustedAt"], 21_000);
    error(
        policy(
            &mut store,
            "coordinator",
            "extend-self",
            &run,
            limits(2, 2, None),
            19_000,
        ),
        "forbidden",
    );
    let run = policy(
        &mut store,
        "owner",
        "different-cap",
        &run,
        limits(3, 2, Some(1000)),
        19_000,
    )
    .unwrap();
    assert_eq!(run["policy"]["timeState"], "exhausted");
    let run = policy(
        &mut store,
        "owner",
        "extend-owner",
        &run,
        limits(3, 2, Some(5000)),
        19_000,
    )
    .unwrap();
    assert_eq!(run["policy"]["startedAt"], 20_000);
    assert_eq!(run["policy"]["deadlineAt"], 25_000);
    assert_eq!(run["policy"]["exhaustedAt"], Value::Null);
    let assigned = assign(&mut store, &run, &task, "worker", 21_001).unwrap();
    let attempt = assigned["tasks"][0]["currentAttempt"]["id"].clone();
    error(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker", 25_000),
        "time_budget_exhausted",
    );
    let replay=execute(&mut store,"owner",json!({"action":"runBudget","request":{"action":"set","key":"extend-owner","runId":run["run"]["id"],"expectedRevision":run["run"]["revision"].as_u64().unwrap()-1,"limits":limits(3,2,Some(5000))}}),25_001).unwrap();
    assert_eq!(
        replay, run,
        "Historical replay does not reset current exhaustion"
    );
    error(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker", 20_500),
        "time_budget_exhausted",
    );
    execute(
        &mut store,
        "worker",
        json!({"action":"report","key":"finish","attemptId":attempt,"result":report()}),
        25_002,
    )
    .unwrap();
    let observed = current(&mut store, &assigned, 25_002);
    validate(&mut store, &observed, &attempt, true, 25_003);
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn owner_drain_blocks_assignments_preserves_results_and_cannot_be_resumed_by_coordinator() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let draft = draft(&mut store, 2);
    let task = draft["tasks"][0]["id"].clone();
    let run = change(
        &mut store,
        "coordinator",
        "activate",
        "start",
        &draft,
        20_000,
    )
    .unwrap();
    let run = assign(&mut store, &run, &task, "worker", 20_001).unwrap();
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    let drained = change(&mut store, "owner", "drain", "human-drain", &run, 20_002).unwrap();
    assert_eq!(drained["run"]["state"], "draining");
    let run = change(
        &mut store,
        "coordinator",
        "drain",
        "coord-drain",
        &drained,
        20_003,
    )
    .unwrap();
    error(
        change(&mut store, "coordinator", "resume", "bypass", &run, 20_004),
        "forbidden",
    );
    error(
        assign(&mut store, &run, &task, "fresh", 20_004),
        "run_state_conflict",
    );
    crate::workflow_budget::guard_dispatch(&mut store.0, "worker", 20_004).unwrap();
    execute(
        &mut store,
        "worker",
        json!({"action":"report","key":"finish","attemptId":attempt,"result":report()}),
        20_005,
    )
    .unwrap();
    let run = current(&mut store, &run, 20_006);
    assert_eq!(
        run["run"]["state"], "draining",
        "Awaiting validation is still in-flight"
    );
    let run = validate(&mut store, &run, &attempt, false, 20_007);
    assert_eq!(run["run"]["state"], "drained");
    let run = change(&mut store, "owner", "resume", "human-resume", &run, 20_008).unwrap();
    assert_eq!(run["run"]["budget"]["startedAt"], 20_000);
    assert_eq!(run["run"]["budget"]["ownerDrain"], false);
    let replay=change(&mut store,"owner","drain","human-drain",&json!({"run":{"id":run["run"]["id"],"revision":drained["run"]["revision"].as_u64().unwrap()-1}}),20_009).unwrap();
    assert_eq!(replay, drained);
    assert_eq!(current(&mut store, &run, 20_010)["run"]["state"], "active");
    let run = change(
        &mut store,
        "coordinator",
        "drain",
        "own-drain",
        &run,
        20_011,
    )
    .unwrap();
    assert_eq!(run["run"]["state"], "drained");
    change(
        &mut store,
        "coordinator",
        "resume",
        "own-resume",
        &run,
        20_012,
    )
    .unwrap();
}

#[test]
fn drain_can_complete_successfully_and_legacy_activation_time_is_never_invented() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let draft = draft(&mut store, 1);
    let task = draft["tasks"][0]["id"].clone();
    let run = change(&mut store, "owner", "activate", "start", &draft, 20_000).unwrap();
    store
        .0
        .execute("DELETE FROM workflow_run_budget", [])
        .unwrap();
    let run = current(&mut store, &run, 20_000);
    assert_eq!(run["run"]["budget"]["timeState"], "untracked");
    error(
        policy(
            &mut store,
            "owner",
            "fake-clock",
            &run,
            limits(2, 2, Some(1000)),
            20_001,
        ),
        "clock_unavailable",
    );
    let run = assign(&mut store, &run, &task, "worker", 20_001).unwrap();
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    let run = change(&mut store, "owner", "drain", "drain", &run, 20_002).unwrap();
    execute(
        &mut store,
        "worker",
        json!({"action":"report","key":"finish","attemptId":attempt,"result":report()}),
        20_003,
    )
    .unwrap();
    let run = current(&mut store, &run, 20_003);
    let run = validate(&mut store, &run, &attempt, true, 20_004);
    assert_eq!(run["run"]["state"], "succeeded");
    error(
        change(&mut store, "owner", "resume", "revive", &run, 20_005),
        "run_state_conflict",
    );
    error(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker", 20_005),
        "attempt_state_conflict",
    );
    crate::workflow_budget::guard_dispatch(&mut store.0, "unbound-process", 20_005).unwrap();
}
