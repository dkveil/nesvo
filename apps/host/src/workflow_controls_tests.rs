use super::{
    Store,
    orchestration_tests::{error, execute, report, worker},
};
use crate::{
    event_log::Observation,
    orchestration::{Actor, Scope},
    workflow_controls::{self, Claim, Kind, Reply, Request, Work},
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
fn setup(store: &mut Store, count: usize) -> Value {
    let run=execute(store,Some("coordinator"),json!({"action":"create","key":"run","spec":{"title":"Control run","goal":"Controlled lifecycle tests","coordinatorSessionId":"coordinator"}})).unwrap();
    let id = run["run"]["id"].clone();
    let run=execute(store,Some("coordinator"),json!({"action":"setPlan","key":"plan","runId":id,"expectedRevision":1,"tasks":(0..count).map(|i|json!({"key":format!("task-{i}"),"title":"Task","instruction":"Controlled scope"})).collect::<Vec<_>>()})).unwrap();
    let policy=execute(store,None,json!({"action":"runBudget","request":{"action":"set","key":"budget","runId":id,"expectedRevision":2,"limits":{"maxParallel":16,"maxAttemptsPerTask":16,"maxElapsedMs":null}}})).unwrap();
    let mut current=execute(store,Some("coordinator"),json!({"action":"activate","key":"start","runId":id,"expectedRevision":policy["run"]["revision"]})).unwrap();
    for i in 0..count {
        current=execute(store,Some("coordinator"),json!({"action":"assign","key":format!("assign-{i}"),"runId":id,"expectedRevision":current["run"]["revision"],"taskId":run["tasks"][i]["id"],"sessionId":format!("worker-{i}")})).unwrap();
    }
    current
}
fn request(run: &Value, key: &str, kind: Kind) -> Request {
    Request::Start {
        key: key.into(),
        run_id: run["run"]["id"].as_str().unwrap().into(),
        expected_revision: run["run"]["revision"].as_u64().unwrap(),
        kind,
    }
}
fn call(store: &mut Store, work: Work) -> anyhow::Result<Reply> {
    workflow_controls::execute(&mut store.0, work, crate::status::now_millis())
}
fn prepare(store: &mut Store, run: &Value, key: &str, kind: Kind, owner: bool) -> (Value, Claim) {
    let Reply::Prepared { view, claim } = call(
        store,
        Work::Prepare {
            actor: actor(owner),
            request: request(run, key, kind),
        },
    )
    .unwrap() else {
        panic!("prepare reply")
    };
    (view, claim.unwrap())
}
fn inspect(store: &mut Store, view: &Value, offset: u16) -> Value {
    let Reply::View(view) = call(
        store,
        Work::Read {
            actor: actor(true),
            run_id: view["run"]["id"].as_str().unwrap().into(),
            control_id: view["control"]["id"].as_str().unwrap().into(),
            offset,
        },
    )
    .unwrap() else {
        panic!("read reply")
    };
    view
}
fn finish(store: &mut Store, claim: &Claim, session: &str, phase: &str, code: Option<&str>) {
    call(store,Work::Finish {claim:claim.clone(),session_id:session.into(),receipt:Some(crate::receipts::Receipt {id:format!("receipt-{session}"),operation:"stop".into(),session_id:session.into(),phase:phase.into(),result:json!({"code":code,"effectStarted":false,"processExited":if phase=="stopped" {json!(true)} else {Value::Null}})})}).unwrap();
}
fn claim_page(store: &mut Store, claim: &Claim) -> Vec<workflow_controls::Target> {
    let Reply::Targets(targets) = call(
        store,
        Work::Claim {
            claim: claim.clone(),
        },
    )
    .unwrap() else {
        panic!("claim reply")
    };
    targets
}
fn exited(store: &mut Store, session: &str) -> u64 {
    store
        .append(vec![Observation {
            session_id: Some(session.into()),
            at: crate::status::now_millis(),
            event: crate::event_log::DomainEvent::ProcessExited(
                crate::event_log::model::ProcessExited { exit_code: Some(0) },
            ),
        }])
        .unwrap()
}

#[test]
fn stop_acceptance_is_not_exit_and_replay_does_not_dispatch_again() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = setup(&mut store, 2);
    let intent = request(&run, "stop", Kind::Stop);
    let (accepted, claim) = prepare(&mut store, &run, "stop", Kind::Stop, true);
    assert_eq!(accepted["run"]["state"], "stopping");
    let targets = claim_page(&mut store, &claim);
    assert_eq!(targets.len(), 2);
    assert!(
        targets
            .iter()
            .all(|target| target.session_id.starts_with("worker-"))
    );
    for target in targets {
        finish(
            &mut store,
            &claim,
            &target.session_id,
            "stopRequested",
            None,
        );
    }
    assert!(claim_page(&mut store, &claim).is_empty());
    let current = inspect(&mut store, &accepted, 0);
    assert_eq!(current["control"]["state"], "awaitingExit");
    assert_eq!(current["run"]["state"], "stopping");
    let Reply::Prepared { view, claim } = call(
        &mut store,
        Work::Prepare {
            actor: actor(true),
            request: intent,
        },
    )
    .unwrap() else {
        panic!("replay reply")
    };
    assert_eq!(view, accepted);
    assert!(claim.is_none());
    exited(&mut store, "worker-0");
    assert_eq!(
        inspect(&mut store, &accepted, 0)["run"]["state"],
        "stopping"
    );
    let head = exited(&mut store, "worker-1");
    assert_eq!(
        store.cursors().unwrap().0,
        head,
        "Exit append includes the atomic control completion cursor"
    );
    let stopped = inspect(&mut store, &accepted, 0);
    assert_eq!(stopped["run"]["state"], "stopped");
    assert_eq!(stopped["control"]["state"], "completed");
    let current = execute(
        &mut store,
        None,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    assert!(
        current["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|task| task["state"] == "stopped" && task["taskResult"].is_null())
    );
    error(
        execute(
            &mut store,
            Some("coordinator"),
            json!({"action":"resume","key":"bypass","runId":run["run"]["id"],"expectedRevision":stopped["run"]["revision"]}),
        ),
        "forbidden",
    );
    execute(&mut store,None,json!({"action":"resume","key":"owner-resume","runId":run["run"]["id"],"expectedRevision":stopped["run"]["revision"]})).unwrap();
    let current = execute(
        &mut store,
        None,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    let retry=execute(&mut store,Some("coordinator"),json!({"action":"assign","key":"fresh-retry","runId":run["run"]["id"],"taskId":current["tasks"][0]["id"],"sessionId":"fresh-worker","expectedRevision":current["run"]["revision"]})).unwrap();
    assert_eq!(retry["tasks"][0]["currentAttempt"]["ordinal"], 2);
}

#[test]
fn cancel_requires_real_exit_evidence_and_closes_questions_without_inventing_results() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = setup(&mut store, 1);
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    worker(&mut store,"worker-0",json!({"action":"decision","request":{"action":"ask","key":"question","attemptId":attempt,"audience":"owner","question":"A real gate","timeoutMs":300000}})).unwrap();
    let (accepted, claim) = prepare(&mut store, &run, "cancel", Kind::Cancel, false);
    for target in claim_page(&mut store, &claim) {
        finish(
            &mut store,
            &claim,
            &target.session_id,
            "stopRequested",
            None,
        );
    }
    claim_page(&mut store, &claim);
    assert_eq!(
        inspect(&mut store, &accepted, 0)["run"]["state"],
        "canceling"
    );
    exited(&mut store, "worker-0");
    let canceled = inspect(&mut store, &accepted, 0);
    assert_eq!(canceled["run"]["state"], "canceled");
    assert!(canceled["run"]["taskResult"].is_null());
    error(
        execute(
            &mut store,
            None,
            json!({"action":"resume","key":"revive","runId":run["run"]["id"],"expectedRevision":canceled["run"]["revision"]}),
        ),
        "run_state_conflict",
    );
    let questions = execute(
        &mut store,
        None,
        json!({"action":"decision","request":{"action":"list","runId":run["run"]["id"]}}),
    )
    .unwrap();
    assert_eq!(questions["decisions"][0]["state"], "canceled");
    assert_eq!(questions["decisions"][0]["answer"], Value::Null);
    let history = execute(
        &mut store,
        None,
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"]}),
    )
    .unwrap();
    assert!(history["attempts"][0]["result"].is_null());
}

#[test]
fn restart_never_reclaims_unknown_effects_or_assumes_missing_processes_exited() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-control-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let run = setup(&mut store, 1);
    let (accepted, claim) = prepare(&mut store, &run, "stop", Kind::Stop, true);
    let targets = claim_page(&mut store, &claim);
    assert_eq!(targets.len(), 1);
    let native = crate::receipts::accept(
        &mut store.0,
        "owner",
        &targets[0].key,
        "stop",
        json!({"sessionId":targets[0].session_id}),
    )
    .unwrap();
    let native_id = native.receipt.id;
    drop(store);
    let mut store = Store::open(&path).unwrap();
    error(call(&mut store, Work::Claim { claim }), "stale_control");
    let current = inspect(&mut store, &accepted, 0);
    assert_eq!(current["control"]["state"], "unconfirmed");
    assert_eq!(current["targets"][0]["phase"], "unknown");
    assert_eq!(
        current["targets"][0]["receiptId"], native_id,
        "Lost parent replies still expose the durable native receipt by issuer/key correlation"
    );
    call(
        &mut store,
        Work::Observe {
            actor: actor(true),
            run_id: current["run"]["id"].as_str().unwrap().into(),
            control_id: current["control"]["id"].as_str().unwrap().into(),
            exited: vec![],
            unavailable: vec!["worker-0".into()],
        },
    )
    .unwrap();
    let current = inspect(&mut store, &accepted, 0);
    assert_eq!(current["targets"][0]["phase"], "unavailable");
    assert_eq!(current["run"]["state"], "stopping");
    error(
        call(
            &mut store,
            Work::Prepare {
                actor: actor(true),
                request: request(&current, "new-key", Kind::Stop),
            },
        ),
        "control_unconfirmed",
    );
    let recovered = execute(&mut store, None, json!({"action":"mutation","key":"stop"})).unwrap();
    assert_eq!(recovered, accepted);
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn known_refusals_can_retry_and_exit_finalizes_the_latest_control_kind() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = setup(&mut store, 1);
    let (first, claim) = prepare(&mut store, &run, "stop", Kind::Stop, false);
    for target in claim_page(&mut store, &claim) {
        finish(
            &mut store,
            &claim,
            &target.session_id,
            "failed",
            Some("control_busy"),
        );
    }
    claim_page(&mut store, &claim);
    let current = inspect(&mut store, &first, 0);
    assert_eq!(current["control"]["state"], "blocked");
    let (cancel, claim) = prepare(
        &mut store,
        &current,
        "deliberate-cancel",
        Kind::Cancel,
        false,
    );
    call(
        &mut store,
        Work::Observe {
            actor: actor(true),
            run_id: first["run"]["id"].as_str().unwrap().into(),
            control_id: first["control"]["id"].as_str().unwrap().into(),
            exited: vec!["worker-0".into()],
            unavailable: vec![],
        },
    )
    .unwrap();
    assert_eq!(inspect(&mut store, &cancel, 0)["run"]["state"], "canceled");
    assert!(claim_page(&mut store, &claim).is_empty());
    assert_eq!(inspect(&mut store, &cancel, 0)["run"]["state"], "canceled");
}

#[test]
fn exit_proof_before_control_skips_closed_workers_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-control-exit-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut store = Store::open(&path).unwrap();
    let run = setup(&mut store, 1);
    exited(&mut store, "worker-0");
    let (accepted, claim) = prepare(&mut store, &run, "already-exited", Kind::Stop, true);
    assert_eq!(accepted["run"]["state"], "stopped");
    assert_eq!(accepted["control"]["state"], "completed");
    assert!(accepted["targets"].as_array().unwrap().is_empty());
    assert_eq!(accepted["cursor"], store.cursors().unwrap().0);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let current = inspect(&mut store, &accepted, 0);
    assert_eq!(
        current["control"]["state"], "completed",
        "Restart cannot downgrade proven exits while an empty dispatch claim was still active"
    );
    error(call(&mut store, Work::Claim { claim }), "stale_control");
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn stopped_reported_results_can_be_validated_after_resume_without_reexecuting_work() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = setup(&mut store, 1);
    let attempt = run["tasks"][0]["currentAttempt"]["id"].clone();
    worker(
        &mut store,
        "worker-0",
        json!({"action":"report","key":"completed-result","attemptId":attempt,"result":report()}),
    )
    .unwrap();
    let run = execute(
        &mut store,
        None,
        json!({"action":"get","runId":run["run"]["id"]}),
    )
    .unwrap();
    let (accepted, claim) = prepare(&mut store, &run, "stop-reported", Kind::Stop, true);
    for target in claim_page(&mut store, &claim) {
        finish(
            &mut store,
            &claim,
            &target.session_id,
            "stopRequested",
            None,
        );
    }
    claim_page(&mut store, &claim);
    exited(&mut store, "worker-0");
    let stopped = inspect(&mut store, &accepted, 0);
    assert_eq!(stopped["run"]["state"], "stopped");
    let resumed=execute(&mut store,None,json!({"action":"resume","key":"resume-reported","runId":run["run"]["id"],"expectedRevision":stopped["run"]["revision"]})).unwrap();
    assert_eq!(resumed["tasks"][0]["state"], "reported");
    let retained = execute(
        &mut store,
        None,
        json!({"action":"task","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"]}),
    )
    .unwrap();
    assert_eq!(retained["attempts"][0]["result"], report());
    let validated=execute(&mut store,None,json!({"action":"validate","key":"validate-retained","runId":run["run"]["id"],"attemptId":attempt,"expectedRevision":resumed["run"]["revision"],"validation":{"passed":true,"summary":"Review retained result","checks":[{"name":"review","outcome":"passed","details":"Explicit fixture attestation, no checks invented"}]}})).unwrap();
    assert_eq!(validated["run"]["state"], "succeeded");
    assert_eq!(validated["tasks"][0]["attempts"], 1);
}

#[test]
fn control_pages_keep_stable_targets_and_scope_does_not_expand_to_other_runs() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let run = setup(&mut store, 10);
    let (accepted, claim) = prepare(&mut store, &run, "stop", Kind::Stop, false);
    assert_eq!(accepted["targets"].as_array().unwrap().len(), 8);
    let next = inspect(&mut store, &accepted, 8);
    assert_eq!(next["targets"].as_array().unwrap().len(), 2);
    assert!(next["nextOffset"].is_null());
    let first = claim_page(&mut store, &claim);
    assert_eq!(first.len(), 8);
    for target in first {
        finish(&mut store, &claim, &target.session_id, "stopped", None);
    }
    let next = claim_page(&mut store, &claim);
    assert_eq!(next.len(), 2);
    for target in next {
        finish(&mut store, &claim, &target.session_id, "stopped", None);
    }
    assert!(claim_page(&mut store, &claim).is_empty());
    error(
        call(
            &mut store,
            Work::Read {
                actor: Actor {
                    issuer: "foreign".into(),
                    scope: Scope::Coordinator("foreign".into()),
                },
                run_id: run["run"]["id"].as_str().unwrap().into(),
                control_id: claim.id.clone(),
                offset: 0,
            },
        ),
        "run_not_found",
    );
    error(
        call(
            &mut store,
            Work::Prepare {
                actor: Actor {
                    issuer: "worker-0".into(),
                    scope: Scope::Worker("worker-0".into()),
                },
                request: request(&run, "worker-forge", Kind::Cancel),
            },
        ),
        "forbidden",
    );
    assert_eq!(
        inspect(&mut store, &accepted, 0)["control"]["counts"]["exited"],
        10
    );
}
