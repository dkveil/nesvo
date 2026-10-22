use super::{
    Store,
    orchestration_tests::{error, execute, report, worker},
};
use crate::{
    attention_inbox::{self, Mark, PAGE_BYTES, SessionItem, Window},
    launchers::Program,
    orchestration::{Actor, Scope},
    workflow_decisions,
};
use serde_json::{Value, json};
use std::collections::HashSet;

const NOW: u64 = 1_792_416_000_000;

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

fn run_with_worker(store: &mut Store, tag: &str) -> (String, String) {
    let coordinator = format!("coordinator-{tag}");
    let coordinator = Some(coordinator.as_str());
    let run = execute(store,coordinator,json!({"action":"create","key":format!("{tag}-run"),"spec":{"title":format!("Run \"{tag}\" łódź"),"goal":"private goal","coordinatorSessionId":coordinator}})).unwrap();
    let id = run["run"]["id"].clone();
    execute(store,coordinator,json!({"action":"setPlan","key":format!("{tag}-plan"),"runId":id,"expectedRevision":1,"tasks":[{"key":"implement","title":"implement","instruction":"private task","dependencies":[]}]})).unwrap();
    let plan = execute(
        store,
        coordinator,
        json!({"action":"activate","key":format!("{tag}-activate"),"runId":id,"expectedRevision":2}),
    )
    .unwrap();
    let assigned = execute(store,coordinator,json!({"action":"assign","key":format!("{tag}-assign"),"runId":id,"taskId":plan["tasks"][0]["id"],"sessionId":format!("worker-{tag}"),"expectedRevision":3})).unwrap();
    (
        id.as_str().unwrap().to_owned(),
        assigned["tasks"][0]["currentAttempt"]["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}

fn ask(store: &mut Store, tag: &str, attempt: &str, question: &str, now: u64) -> Value {
    workflow_decisions::execute(
        &mut store.0,
        Actor {
            issuer: format!("worker-{tag}"),
            scope: Scope::Worker(format!("worker-{tag}")),
        },
        serde_json::from_value(json!({"action":"ask","key":format!("{tag}-ask"),"attemptId":attempt,"audience":"owner","question":question,"timeoutMs":60_000})).unwrap(),
        now,
    )
    .unwrap()
}

fn decide(
    store: &mut Store,
    actor: Actor,
    id: &str,
    choice: &str,
    now: u64,
) -> anyhow::Result<Value> {
    workflow_decisions::execute(
        &mut store.0,
        actor,
        workflow_decisions::Request::Decide {
            decision_id: id.into(),
            choice: choice.into(),
            note: Some("Keep the public API stable".into()),
        },
        now,
    )
}

fn results(store: &mut Store, count: usize) {
    let job = workflow_decisions_job(store);
    for index in 0..count {
        store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,reason,finished_at) VALUES(?1,?2,1,'{}',?1,'once',?3,?3,'failed',?4,?3)",rusqlite::params![format!("occurrence-{index:03}"),job,(NOW + index as u64) as i64,"\"quoted\" failure \u{1F600} ".repeat(64)]).unwrap();
    }
}

fn workflow_decisions_job(store: &mut Store) -> String {
    let spec = json!({"title":"Nightly \"review\" łódź ".repeat(3),"instruction":"Record an explicit result","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW + 10_000) as i64).unwrap().to_rfc3339()}});
    crate::job_definitions::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"create","key":"inbox-job","spec":spec})).unwrap(),
        NOW,
    )
    .unwrap()["job"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn sessions(count: usize, revision: u64) -> Vec<SessionItem> {
    (0..count)
        .map(|index| SessionItem {
            session_id: format!("{index:032x}"),
            name: format!("\"agent\" {index} łódź \u{1F600} ").repeat(40),
            program: Program::Claude,
            priority: 3,
            reason: "question",
            revision,
            at: NOW + index as u64,
        })
        .collect()
}

fn read(store: &mut Store, page: u16, limit: u16, live: Vec<SessionItem>) -> Value {
    attention_inbox::read(
        &mut store.0,
        &owner(),
        Window::new(Some(page), Some(limit)).unwrap(),
        live,
        NOW + 1_000,
    )
    .unwrap()
}

fn ack(store: &mut Store, marks: Value, live: Vec<SessionItem>, now: u64) -> anyhow::Result<Value> {
    attention_inbox::acknowledge(
        &mut store.0,
        &owner(),
        serde_json::from_value::<Vec<Mark>>(marks).unwrap(),
        live,
        now,
    )
}

#[test]
fn attention_inbox_aggregates_sessions_decisions_runs_and_results_in_pages_under_the_byte_cap() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = run_with_worker(&mut store, "asks");
    let asked = ask(
        &mut store,
        "asks",
        &attempt,
        &"Ship \"this\"?\n\u{1F600} ".repeat(100),
        NOW,
    );
    let (reported_run, reported_attempt) = run_with_worker(&mut store, "reports");
    worker(&mut store,"worker-reports",json!({"action":"report","key":"reports-result","attemptId":reported_attempt,"result":report()})).unwrap();
    results(&mut store, 40);
    let live = sessions(16, 4);
    let mut seen = HashSet::new();
    let mut kinds = Vec::new();
    let mut page = 0;
    loop {
        let reply = read(&mut store, page, 32, live.clone());
        assert!(serde_json::to_vec(&reply).unwrap().len() <= PAGE_BYTES);
        assert_eq!(reply["total"], 16 + 1 + 1 + 40);
        let items = reply["items"].as_array().unwrap();
        assert!(items.len() <= 32);
        for item in items {
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
            kinds.push(item["kind"].as_str().unwrap().to_owned());
        }
        match reply["nextPage"].as_u64() {
            Some(next) => page = next as u16,
            None => break,
        }
    }
    assert_eq!(seen.len(), 58);
    assert_eq!(page, 1);
    let decision = workflow_decisions::inbox_id(&run, asked["decision"]["id"].as_str().unwrap());
    assert!(seen.contains(&decision));
    assert!(seen.contains(&format!("run:{reported_run}:{reported_attempt}")));
    assert!(seen.contains("result:occurrence-039"));
    assert!(seen.contains(&format!("session:{:032x}", 0)));
    let first = read(&mut store, 0, 32, live.clone());
    let priorities: Vec<u64> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["priority"].as_u64().unwrap())
        .collect();
    assert!(priorities.windows(2).all(|pair| pair[0] >= pair[1]));
    let decision_view = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == decision)
        .unwrap();
    assert_eq!(decision_view["kind"], "decision");
    assert_eq!(decision_view["revision"], 1);
    assert!(decision_view["summary"].as_str().unwrap().len() < 480);
    assert_eq!(kinds.iter().filter(|kind| *kind == "result").count(), 40);
    assert!(Window::new(Some(1025), None).is_err());
    assert!(Window::new(None, Some(33)).is_err());
    assert!(Window::new(None, Some(0)).is_err());
    error(
        attention_inbox::read(
            &mut store.0,
            &Actor {
                issuer: "coordinator-asks".into(),
                scope: Scope::Coordinator("coordinator-asks".into()),
            },
            Window::new(None, None).unwrap(),
            Vec::new(),
            NOW,
        ),
        "forbidden",
    );
}

#[test]
fn inbox_acknowledgements_survive_a_reconnect_and_only_journal_items_survive_a_host_restart() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-attention-{}.sqlite3",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let (run, attempt) = run_with_worker(&mut store, "asks");
    let asked = ask(&mut store, "asks", &attempt, "Merge now?", NOW);
    let decision = workflow_decisions::inbox_id(&run, asked["decision"]["id"].as_str().unwrap());
    let session = format!("session:{:032x}", 0);
    let live = sessions(1, 4);
    assert_eq!(read(&mut store, 0, 16, live.clone())["total"], 2);
    let receipt = ack(
        &mut store,
        json!([{"id":decision,"revision":1},{"id":session,"revision":4}]),
        live.clone(),
        NOW + 10,
    )
    .unwrap();
    assert_eq!(receipt["acknowledged"][0]["acknowledgedAt"], NOW + 10);
    assert_eq!(read(&mut store, 0, 16, live.clone())["total"], 0);
    let again = ack(
        &mut store,
        json!([{"id":decision,"revision":1}]),
        live.clone(),
        NOW + 99,
    )
    .unwrap();
    assert_eq!(again["acknowledged"][0]["acknowledgedAt"], NOW + 10);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let restarted = read(&mut store, 0, 16, live.clone());
    assert_eq!(restarted["total"], 1);
    assert_eq!(restarted["items"][0]["id"], session);
    let newer = read(&mut store, 0, 16, sessions(1, 5));
    assert_eq!(newer["total"], 1);
    assert_eq!(newer["items"][0]["id"], session);
    assert_eq!(newer["items"][0]["revision"], 5);
    error(
        ack(
            &mut store,
            json!([{"id":session,"revision":9}]),
            sessions(1, 5),
            NOW,
        ),
        "invalid_argument",
    );
    for marks in [
        json!([]),
        json!([{"id":"unknown:1","revision":1}]),
        json!([{"id":"session:","revision":1}]),
        json!([{"id":session,"revision":1},{"id":session,"revision":2}]),
        json!([{"id":session,"revision":9_007_199_254_740_992_u64}]),
    ] {
        error(ack(&mut store, marks, Vec::new(), NOW), "invalid_argument");
    }
    let gone = ack(
        &mut store,
        json!([{"id":"result:resolved-elsewhere","revision":2}]),
        Vec::new(),
        NOW + 20,
    )
    .unwrap();
    assert_eq!(gone["acknowledged"][0]["revision"], 2);
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn owner_decisions_list_and_decide_without_a_run_id_replay_a_lost_reply_and_refuse_resolved_or_expired()
 {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (run, attempt) = run_with_worker(&mut store, "asks");
    let asked = ask(&mut store, "asks", &attempt, "Which branch?", NOW);
    let id = asked["decision"]["id"].as_str().unwrap().to_owned();
    let (_, late_attempt) = run_with_worker(&mut store, "late");
    let late = ask(&mut store, "late", &late_attempt, "Too late?", NOW);
    let pending = workflow_decisions::execute(
        &mut store.0,
        owner(),
        workflow_decisions::Request::Pending { page: None },
        NOW + 1,
    )
    .unwrap();
    assert_eq!(pending["total"], 2);
    assert_eq!(pending["nextPage"], Value::Null);
    assert_eq!(pending["decisions"][0]["id"], id);
    assert_eq!(
        pending["decisions"][0]["inboxId"],
        workflow_decisions::inbox_id(&run, &id)
    );
    assert_eq!(pending["decisions"][0]["run"]["id"], run);
    error(
        decide(
            &mut store,
            Actor {
                issuer: "coordinator-asks".into(),
                scope: Scope::Coordinator("coordinator-asks".into()),
            },
            &id,
            "main",
            NOW + 2,
        ),
        "forbidden",
    );
    let decided = decide(&mut store, owner(), &id, "main", NOW + 2).unwrap();
    assert_eq!(decided["decision"]["state"], "answered");
    assert_eq!(
        decided["decision"]["answer"],
        "main\n\nKeep the public API stable"
    );
    assert_eq!(decided["inboxId"], workflow_decisions::inbox_id(&run, &id));
    assert_eq!(
        decide(&mut store, owner(), &id, "main", NOW + 3).unwrap(),
        decided
    );
    error(
        decide(&mut store, owner(), &id, "other", NOW + 3),
        "decision_resolved",
    );
    error(
        decide(
            &mut store,
            owner(),
            late["decision"]["id"].as_str().unwrap(),
            "yes",
            NOW + 120_000,
        ),
        "decision_expired",
    );
    error(
        decide(&mut store, owner(), "missing", "yes", NOW),
        "decision_not_found",
    );
    let after = workflow_decisions::execute(
        &mut store.0,
        owner(),
        workflow_decisions::Request::Pending { page: Some(0) },
        NOW + 120_000,
    )
    .unwrap();
    assert_eq!(after["total"], 0);
    error(
        workflow_decisions::execute(
            &mut store.0,
            owner(),
            workflow_decisions::Request::Pending { page: Some(513) },
            NOW,
        ),
        "invalid_argument",
    );
}

#[test]
fn owner_job_list_and_history_accept_a_page_beside_the_offset() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = workflow_decisions_job(&mut store);
    for index in 0..17 {
        let spec = json!({"title":format!("Job {index}"),"instruction":"Record an explicit result","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW + 10_000) as i64).unwrap().to_rfc3339()}});
        crate::job_definitions::execute(
            &mut store.0,
            owner(),
            serde_json::from_value(
                json!({"action":"create","key":format!("job-{index}"),"spec":spec}),
            )
            .unwrap(),
            NOW,
        )
        .unwrap();
    }
    results(&mut store, 9);
    let mut jobs = |request: Value| {
        crate::job_definitions::execute(
            &mut store.0,
            owner(),
            serde_json::from_value(request).unwrap(),
            NOW,
        )
    };
    let first = jobs(json!({"action":"list","page":0})).unwrap();
    assert_eq!(first["jobs"].as_array().unwrap().len(), 16);
    assert_eq!(first["nextPage"], 1);
    let second = jobs(json!({"action":"list","page":1})).unwrap();
    assert_eq!(second["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(second["nextPage"], Value::Null);
    let legacy = jobs(json!({"action":"list","offset":16})).unwrap();
    assert!(legacy.get("page").is_none());
    assert_eq!(legacy["jobs"], second["jobs"]);
    let history = jobs(json!({"action":"history","jobId":job,"page":1})).unwrap();
    assert_eq!(history["occurrences"].as_array().unwrap().len(), 1);
    assert_eq!(history["page"], 1);
    error(
        jobs(json!({"action":"list","page":1,"offset":16})),
        "invalid_argument",
    );
    error(
        jobs(json!({"action":"history","jobId":job,"page":513})),
        "invalid_argument",
    );
}

#[test]
fn journal_signals_name_inbox_items_and_only_new_needs_request_a_push() {
    let event = |kind: &str, payload: Value| crate::event_log::Event {
        sequence: 1,
        session_id: None,
        kind: kind.into(),
        at: NOW,
        payload,
    };
    let asked = attention_inbox::signal(&event(
        "run.decision_asked",
        json!({"runId":"r","decisionId":"d","state":"pending"}),
    ))
    .unwrap();
    assert_eq!(asked.item.as_deref(), Some("decision:r:d"));
    assert_eq!(asked.push, Some(attention_inbox::PUSH_DECISION));
    let answered = attention_inbox::signal(&event(
        "run.decision_answered",
        json!({"runId":"r","decisionId":"d"}),
    ))
    .unwrap();
    assert_eq!(answered.push, None);
    let ready = attention_inbox::signal(&event(
        "job.changed",
        json!({"jobId":"j","occurrenceId":"o","phase":"needsValidation"}),
    ))
    .unwrap();
    assert_eq!(ready.item.as_deref(), Some("result:o"));
    assert_eq!(ready.push, Some(attention_inbox::PUSH_RESULT));
    assert!(
        attention_inbox::signal(&event(
            "job.changed",
            json!({"jobId":"j","occurrenceId":"o","phase":"running"}),
        ))
        .is_none()
    );
    assert!(attention_inbox::signal(&event("agent.attention", json!({}))).is_none());
    assert_eq!(attention_inbox::clip("\"ab\"", 6), "\"ab");
}

#[test]
fn result_ready_pushes_once_per_occurrence_while_every_change_still_notifies() {
    let event = |occurrence: &str, phase: &str| crate::event_log::Event {
        sequence: 1,
        session_id: None,
        kind: "job.changed".into(),
        at: NOW,
        payload: json!({"jobId":"j","occurrenceId":occurrence,"phase":phase}),
    };
    let mut pushed = attention_inbox::Pushed::default();
    let mut admit = |occurrence: &str, phase: &str| {
        pushed.admit(attention_inbox::signal(&event(occurrence, phase)).unwrap())
    };
    assert_eq!(
        admit("o", "needsValidation").push,
        Some(attention_inbox::PUSH_RESULT)
    );
    let validated = admit("o", "succeeded");
    assert_eq!(validated.push, None);
    assert_eq!(validated.item.as_deref(), Some("result:o"));
    assert_eq!(
        admit("p", "failed").push,
        Some(attention_inbox::PUSH_RESULT)
    );
}

#[test]
fn acknowledging_items_the_host_no_longer_lists_is_bounded() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    error(
        ack(
            &mut store,
            json!([{"id":"result:resolved-elsewhere","revision":3}]),
            Vec::new(),
            NOW,
        ),
        "invalid_argument",
    );
    let session = format!("session:{:032x}", 7);
    let echoed = ack(
        &mut store,
        json!([{"id":session,"revision":9_000_000}]),
        Vec::new(),
        NOW + 1,
    )
    .unwrap();
    assert_eq!(echoed["acknowledged"][0]["revision"], 9_000_000);
    let receipts: i64 = store
        .0
        .query_row("SELECT count(*) FROM attention_receipts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(receipts, 0);
    let mut live = sessions(8, 1);
    live[7].revision = 1;
    assert_eq!(read(&mut store, 0, 16, live)["total"], 8);
}
