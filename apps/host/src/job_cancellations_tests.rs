use super::Store;
use crate::{
    job_cancellations,
    job_definitions::{self, Claim, Reply, Work},
    job_prechecks::{self, Outcome, OutcomeState},
    orchestration::{self, Actor, Scope},
    workflow_controls,
};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
fn request(store: &mut Store, value: Value, now: u64) -> anyhow::Result<Value> {
    job_definitions::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(value).unwrap(),
        now,
    )
}
fn code<T>(result: anyhow::Result<T>, expected: &str) {
    let Err(error) = result else {
        panic!("Expected {expected}");
    };
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        expected
    );
}
fn job_events(store: &Store) -> i64 {
    store
        .0
        .query_row(
            "SELECT count(*) FROM domain_events WHERE kind='job.changed'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn create(store: &mut Store, approval: Option<&Value>) -> Value {
    let mut spec = json!({
        "title":"Cancelable job",
        "instruction":"Metadata-only cancellation fixture",
        "profile":{"program":"claude","workspace":"shared"},
        "schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW+60_000)as i64).unwrap().to_rfc3339()},
        "overlap":"queue"
    });
    if let Some(approval) = approval {
        spec["precheckId"] = approval["id"].clone();
    }
    request(
        store,
        json!({"action":"create","key":"definition","spec":spec}),
        NOW,
    )
    .unwrap()["job"]
        .clone()
}
fn manual(store: &mut Store, job: &Value, key: &str) -> Value {
    request(
        store,
        json!({"action":"runNow","key":key,"jobId":job["id"],"expectedRevision":1}),
        NOW,
    )
    .unwrap()["occurrence"]
        .clone()
}
fn poll(store: &mut Store, now: u64) -> Vec<Claim> {
    let Reply::Claims(claims) =
        job_definitions::work(&mut store.0, Work::Poll { slots: 4 }, now).unwrap()
    else {
        panic!("Expected dispatch claims");
    };
    claims
}
fn cancellations(store: &mut Store, now: u64) -> Vec<job_cancellations::Claim> {
    let Reply::Cancellations(claims) =
        job_definitions::work(&mut store.0, Work::CancelPoll { slots: 2 }, now).unwrap()
    else {
        panic!("Expected cancellation claims");
    };
    claims
}
fn current(store: &mut Store, job: &Value, occurrence: &Value) -> Value {
    request(
        store,
        json!({"action":"occurrence","jobId":job["id"],"occurrenceId":occurrence["id"]}),
        NOW + 500,
    )
    .unwrap()["occurrence"]
        .clone()
}
fn cancel_request(job: &Value, occurrence: &Value, key: &str) -> Value {
    json!({"action":"cancelOccurrence","key":key,"jobId":job["id"],"occurrenceId":occurrence["id"]})
}
fn cancel(store: &mut Store, job: &Value, occurrence: &Value) -> Value {
    request(store, cancel_request(job, occurrence, "cancel"), NOW + 100).unwrap()
}
fn workflow(store: &mut Store, value: Value) -> Value {
    orchestration::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(value).unwrap(),
        NOW,
    )
    .unwrap()
}
fn bind(store: &mut Store, occurrence: &Value, count: usize) -> Value {
    let created = workflow(
        store,
        json!({"action":"create","key":"run","spec":{"title":"Bound run","goal":"Metadata-only lifecycle fixture"}}),
    );
    let id = created["run"]["id"].clone();
    let plan = workflow(
        store,
        json!({"action":"setPlan","key":"plan","runId":id,"expectedRevision":1,"tasks":(0..count).map(|i|json!({"key":format!("task-{i}"),"title":"Task","instruction":"No native process in this test"})).collect::<Vec<_>>()}),
    );
    let budget = workflow(
        store,
        json!({"action":"runBudget","request":{"action":"set","key":"budget","runId":id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":2,"maxAttemptsPerTask":2,"maxElapsedMs":null}}}),
    );
    let active = workflow(
        store,
        json!({"action":"activate","key":"activate","runId":id,"expectedRevision":budget["run"]["revision"]}),
    );
    let assigned = workflow(
        store,
        json!({"action":"assign","key":"assign","runId":id,"expectedRevision":active["run"]["revision"],"taskId":plan["tasks"][0]["id"],"sessionId":"worker"}),
    );
    job_definitions::work(
        &mut store.0,
        Work::BindRun {
            occurrence: occurrence["id"].as_str().unwrap().into(),
            run: id.as_str().unwrap().into(),
        },
        NOW,
    )
    .unwrap();
    assigned
}
fn late_messages(store: &mut Store, occurrence: &Value) {
    let id = occurrence["id"].as_str().unwrap();
    for work in [
        Work::Started {
            occurrence: id.into(),
        },
        Work::Refused {
            occurrence: id.into(),
            uncertain: false,
        },
        Work::Refused {
            occurrence: id.into(),
            uncertain: true,
        },
    ] {
        job_definitions::work(&mut store.0, work, NOW + 900).unwrap();
    }
}
fn assert_unbindable(store: &mut Store, occurrence: &Value, expected: &str) {
    code(
        job_definitions::work(
            &mut store.0,
            Work::BindRun {
                occurrence: occurrence["id"].as_str().unwrap().into(),
                run: "never-created-run".into(),
            },
            NOW + 500,
        ),
        expected,
    );
}
fn approval(store: &mut Store) -> Value {
    let spec = json!({"title":"Approved fixture","executable":if cfg!(windows){"C:/fixture/check.exe"}else{"/fixture/check"},"cwd":if cfg!(windows){"C:/fixture"}else{"/fixture"}});
    let digest = job_prechecks::digest(&serde_json::from_value(spec.clone()).unwrap()).unwrap();
    job_prechecks::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(
            json!({"action":"approve","key":"approval","spec":spec,"expectedDigest":digest}),
        )
        .unwrap(),
        NOW,
    )
    .unwrap()["precheckApproval"]
        .clone()
}
fn begin_precheck(store: &mut Store, occurrence: &Value) {
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                occurrence: occurrence["id"].as_str().unwrap().into(),
            },
            NOW + 50,
        )
        .unwrap(),
        Reply::Precheck(Some(_))
    ));
}
fn passed(cleanup_confirmed: bool) -> Outcome {
    Outcome {
        state: OutcomeState::Passed,
        reason: "exit_pass".into(),
        exit_code: Some(0),
        stdout: "Actual check result\n".into(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 25,
        cleanup_confirmed,
        command_started: Some(true),
    }
}
fn copy_claim(claim: &job_cancellations::Claim) -> job_cancellations::Claim {
    job_cancellations::Claim {
        occurrence: claim.occurrence.clone(),
        token: claim.token.clone(),
        issuer: claim.issuer.clone(),
        run: claim.run.clone(),
        key: claim.key.clone(),
    }
}
fn native_control(
    store: &mut Store,
    run: &Value,
    key: &str,
    kind: workflow_controls::Kind,
) -> (Value, workflow_controls::Claim) {
    let workflow_controls::Reply::Prepared { view, claim } = workflow_controls::execute(
        &mut store.0,
        workflow_controls::Work::Prepare {
            actor: owner(),
            request: workflow_controls::Request::Start {
                key: key.into(),
                run_id: run["run"]["id"].as_str().unwrap().into(),
                expected_revision: run["run"]["revision"].as_u64().unwrap(),
                kind,
            },
        },
        NOW + 200,
    )
    .unwrap() else {
        panic!("Expected run control acceptance");
    };
    (view, claim.unwrap())
}
fn finish_native_target(store: &mut Store, claim: &workflow_controls::Claim, exited: bool) {
    let workflow_controls::Reply::Targets(targets) = workflow_controls::execute(
        &mut store.0,
        workflow_controls::Work::Claim {
            claim: claim.clone(),
        },
        NOW + 210,
    )
    .unwrap() else {
        panic!("Expected control targets");
    };
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].session_id, "worker");
    // Controlled native-adapter evidence; this test never creates a process.
    workflow_controls::execute(
        &mut store.0,
        workflow_controls::Work::Finish {
            claim: claim.clone(),
            session_id: "worker".into(),
            receipt: Some(crate::receipts::Receipt {
                id: "controlled-native-receipt".into(),
                operation: "stop".into(),
                session_id: "worker".into(),
                phase: if exited { "stopped" } else { "stopRequested" }.into(),
                result: json!({"effectStarted":true,"processExited":if exited {json!(true)}else{Value::Null}}),
            }),
        },
        NOW + 220,
    )
    .unwrap();
}

#[test]
fn cancellation_requires_owner_before_even_a_wrong_identity_lookup() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, None);
    let occurrence = manual(&mut store, &job, "first");
    for (job_id, occurrence_id) in [
        (job["id"].clone(), occurrence["id"].clone()),
        (json!("missing-job"), json!("missing-occurrence")),
    ] {
        for scope in [Scope::Coordinator("c".into()), Scope::Worker("w".into())] {
            code(
                job_definitions::execute(
                    &mut store.0,
                    Actor {
                        issuer: "session:scoped".into(),
                        scope,
                    },
                    serde_json::from_value(json!({"action":"cancelOccurrence","key":"denied","jobId":job_id,"occurrenceId":occurrence_id})).unwrap(),
                    NOW,
                ),
                "forbidden",
            );
        }
    }
    assert!(current(&mut store, &job, &occurrence)["cancellation"].is_null());
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM harness_job_cancellations", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn queued_and_claimed_cancellation_fences_binding_and_replays_original_acceptance() {
    for claimed in [false, true] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = create(&mut store, None);
        let occurrence = manual(&mut store, &job, "first");
        if claimed {
            assert_eq!(poll(&mut store, NOW).len(), 1);
        }
        let accepted = cancel(&mut store, &job, &occurrence);
        assert_eq!(accepted["occurrence"]["state"], "canceled");
        assert_eq!(accepted["occurrence"]["cancellation"]["state"], "completed");
        assert_eq!(accepted["occurrence"]["finishedAt"], NOW + 100);
        assert_unbindable(&mut store, &occurrence, "occurrence_conflict");
        code(
            job_definitions::work(
                &mut store.0,
                Work::BeginPrecheck {
                    occurrence: occurrence["id"].as_str().unwrap().into(),
                },
                NOW + 200,
            ),
            "occurrence_conflict",
        );
        late_messages(&mut store, &occurrence);
        assert_eq!(
            current(&mut store, &job, &occurrence),
            accepted["occurrence"]
        );
        assert_eq!(
            request(
                &mut store,
                cancel_request(&job, &occurrence, "cancel"),
                NOW + 900
            )
            .unwrap(),
            accepted
        );
        let mut changed = cancel_request(&job, &occurrence, "cancel");
        changed["occurrenceId"] = json!("different-occurrence");
        code(
            request(&mut store, changed, NOW + 900),
            "idempotency_conflict",
        );
        code(
            request(
                &mut store,
                cancel_request(&job, &occurrence, "second-key"),
                NOW + 900,
            ),
            "cancellation_exists",
        );
        assert!(poll(&mut store, NOW + 1000).is_empty());
        assert!(cancellations(&mut store, NOW + 1000).is_empty());
    }
}

#[test]
fn actual_pass_after_owner_cancel_is_retained_without_any_run_admission() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let approval = approval(&mut store);
    let job = create(&mut store, Some(&approval));
    let occurrence = manual(&mut store, &job, "first");
    assert_eq!(poll(&mut store, NOW).len(), 1);
    begin_precheck(&mut store, &occurrence);
    let accepted = cancel(&mut store, &job, &occurrence);
    assert_eq!(accepted["occurrence"]["state"], "canceling");
    assert_eq!(
        accepted["occurrence"]["cancellation"]["state"],
        "awaitingPrecheck"
    );
    assert!(accepted["occurrence"]["finishedAt"].is_null());
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::CancelRequested {
                occurrence: occurrence["id"].as_str().unwrap().into()
            },
            NOW + 150
        )
        .unwrap(),
        Reply::CancelRequested(true)
    ));
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                occurrence: occurrence["id"].as_str().unwrap().into(),
                result: passed(true)
            },
            NOW + 200
        )
        .unwrap(),
        Reply::PrecheckPassed(false)
    ));
    let finished = current(&mut store, &job, &occurrence);
    assert_eq!(finished["state"], "canceled");
    assert_eq!(finished["cancellation"]["state"], "completed");
    assert_eq!(finished["precheck"]["state"], "passed");
    assert_eq!(finished["precheck"]["result"]["state"], "passed");
    assert_eq!(finished["precheck"]["result"]["exitCode"], 0);
    assert_eq!(
        finished["precheck"]["result"]["stdout"],
        "Actual check result\n"
    );
    assert!(finished["runId"].is_null());
    assert_unbindable(&mut store, &occurrence, "occurrence_conflict");
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM workflow_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        request(
            &mut store,
            cancel_request(&job, &occurrence, "cancel"),
            NOW + 900
        )
        .unwrap(),
        accepted
    );
    late_messages(&mut store, &occurrence);
    assert_eq!(current(&mut store, &job, &occurrence), finished);
}

#[test]
fn canceled_precheck_with_unconfirmed_cleanup_stays_unfinished_and_blocks_siblings() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let approval = approval(&mut store);
    let job = create(&mut store, Some(&approval));
    let occurrence = manual(&mut store, &job, "first");
    assert_eq!(poll(&mut store, NOW).len(), 1);
    begin_precheck(&mut store, &occurrence);
    cancel(&mut store, &job, &occurrence);
    let sibling = manual(&mut store, &job, "second");
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                occurrence: occurrence["id"].as_str().unwrap().into(),
                result: passed(false)
            },
            NOW + 200
        )
        .unwrap(),
        Reply::PrecheckPassed(false)
    ));
    let uncertain = current(&mut store, &job, &occurrence);
    assert_eq!(uncertain["state"], "reconcile");
    assert_eq!(uncertain["cancellation"]["state"], "unconfirmed");
    assert_eq!(uncertain["precheck"]["state"], "unknown");
    assert!(
        !uncertain["precheck"]["result"]["cleanupConfirmed"]
            .as_bool()
            .unwrap()
    );
    assert!(uncertain["finishedAt"].is_null());
    assert!(uncertain["precheck"]["finishedAt"].is_null());
    assert!(poll(&mut store, NOW + 500).is_empty());
    assert!(cancellations(&mut store, NOW + 500).is_empty());
    assert_eq!(current(&mut store, &job, &sibling)["state"], "queued");
    late_messages(&mut store, &occurrence);
    assert_eq!(current(&mut store, &job, &occurrence), uncertain);
    let abandon = json!({"action":"abandonPrecheck","key":"abandon","jobId":job["id"],"occurrenceId":occurrence["id"],"expectedDigest":approval["digest"],"acknowledgeUnknownEffects":true});
    let accepted = request(&mut store, abandon.clone(), NOW + 1000).unwrap();
    assert_eq!(accepted["occurrence"]["state"], "canceled");
    assert_eq!(accepted["occurrence"]["cancellation"]["state"], "abandoned");
    assert_eq!(
        accepted["occurrence"]["cancellation"]["reason"],
        "owner_acknowledged_unknown_effects"
    );
    assert_eq!(accepted["occurrence"]["precheck"]["state"], "abandoned");
    assert!(accepted["occurrence"]["precheck"]["finishedAt"].is_null());
    assert_eq!(
        accepted["occurrence"]["precheck"]["result"]["cleanupConfirmed"],
        false
    );
    job_definitions::recover(&mut store.0, NOW + 1100).unwrap();
    assert_eq!(
        current(&mut store, &job, &occurrence),
        accepted["occurrence"]
    );
    assert_eq!(request(&mut store, abandon, NOW + 1200).unwrap(), accepted);
    assert!(cancellations(&mut store, NOW + 1300).is_empty());
    let released = poll(&mut store, NOW + 1300);
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].id, sibling["id"]);
}

#[test]
fn bound_cancellation_fences_attempt_input_and_executor_admission_immediately() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, None);
    let occurrence = manual(&mut store, &job, "first");
    assert_eq!(poll(&mut store, NOW).len(), 1);
    let run = bind(&mut store, &occurrence, 2);
    let id = run["run"]["id"].as_str().unwrap();
    crate::workflow_budget::admit_attempt(&store.0, id, 1).unwrap();
    crate::workflow_budget::guard_dispatch(&mut store.0, "worker", NOW).unwrap();
    cancel(&mut store, &job, &occurrence);
    code(
        crate::workflow_budget::admit_attempt(&store.0, id, 1),
        "job_canceled",
    );
    code(
        crate::workflow_budget::guard_dispatch(&mut store.0, "worker", NOW),
        "job_canceled",
    );
    code(
        crate::workflow_executor::execute(
            &mut store.0,
            crate::workflow_executor::Work::Manage {
                actor: owner(),
                request: serde_json::from_value(json!({"action":"start","key":"bypass-executor","runId":id,"expectedRevision":run["run"]["revision"],"spec":{"tasks":[{"taskId":run["tasks"][1]["id"],"profile":{"program":"claude","workspace":"shared"}}]}})).unwrap(),
            },
            NOW,
        ),
        "job_canceled",
    );
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM workflow_executors", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let before = current(&mut store, &job, &occurrence);
    late_messages(&mut store, &occurrence);
    assert_eq!(current(&mut store, &job, &occurrence), before);
}

#[test]
fn cancellation_fences_pending_validation_without_breaking_an_earlier_acceptance_replay() {
    for validated_before_cancel in [false, true] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = create(&mut store, None);
        let occurrence = manual(&mut store, &job, "first");
        assert_eq!(poll(&mut store, NOW).len(), 1);
        let run = bind(&mut store, &occurrence, 2);
        orchestration::execute_at(
            &mut store.0,
            Actor { issuer: "worker".into(), scope: Scope::Worker("worker".into()) },
            serde_json::from_value(json!({"action":"report","key":"result","attemptId":run["tasks"][0]["currentAttempt"]["id"],"result":super::orchestration_tests::report()})).unwrap(),
            NOW + 50,
        ).unwrap();
        let reported = workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}));
        let validation = json!({"action":"validate","key":"validation","runId":run["run"]["id"],"expectedRevision":reported["run"]["revision"],"attemptId":run["tasks"][0]["currentAttempt"]["id"],"validation":{"passed":true,"summary":"Controlled owner validation","checks":[{"name":"fixture","outcome":"passed","details":"No native execution"}]}});
        let accepted = validated_before_cancel.then(|| workflow(&mut store, validation.clone()));
        let before = workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}));
        assert_eq!(before["run"]["state"], "active");
        cancel(&mut store, &job, &occurrence);
        // Job intent does not alter the run revision. This is the exact race in
        // which an otherwise-current validation could incorrectly finish a run.
        let after = workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}));
        assert_eq!(after["run"]["revision"], before["run"]["revision"]);
        if let Some(accepted) = accepted {
            assert_eq!(workflow(&mut store, validation.clone()), accepted);
        }
        let mut fresh = validation;
        fresh["key"] = json!("fresh-validation");
        fresh["expectedRevision"] = after["run"]["revision"].clone();
        code(
            orchestration::execute_at(
                &mut store.0,
                owner(),
                serde_json::from_value(fresh).unwrap(),
                NOW + 150,
            ),
            "job_canceled",
        );
        let unchanged = workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}));
        assert_eq!(unchanged["run"]["state"], "active");
        assert_eq!(unchanged["run"]["revision"], after["run"]["revision"]);
        assert_eq!(
            unchanged["tasks"][0]["state"],
            if validated_before_cancel {
                "succeeded"
            } else {
                "reported"
            }
        );
        assert!(unchanged["run"]["taskResult"].is_null());
        assert_eq!(current(&mut store, &job, &occurrence)["state"], "canceling");
    }
}

#[test]
fn cancellation_claim_survives_native_projection_and_queue_waits_for_exit_proof() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, None);
    let occurrence = manual(&mut store, &job, "first");
    assert_eq!(poll(&mut store, NOW).len(), 1);
    let run = bind(&mut store, &occurrence, 1);
    let sibling = manual(&mut store, &job, "second");
    let accepted = cancel(&mut store, &job, &occurrence);
    assert!(accepted["occurrence"]["finishedAt"].is_null());
    let claim = cancellations(&mut store, NOW + 150).pop().unwrap();
    let (control, native) = native_control(
        &mut store,
        &run,
        &claim.key,
        workflow_controls::Kind::Cancel,
    );
    finish_native_target(&mut store, &native, false);
    // Refresh may see the underlying control before the async dispatcher reports
    // it. The live job claim and its token must remain valid throughout this race.
    assert!(cancellations(&mut store, NOW + 250).is_empty());
    let token: Option<String> = store
        .0
        .query_row(
            "SELECT token FROM harness_job_cancellations WHERE occurrence_id=?1",
            [&claim.occurrence],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(token.as_deref(), Some(claim.token.as_str()));
    assert_eq!(
        current(&mut store, &job, &occurrence)["cancellation"]["state"],
        "dispatching"
    );
    let stale = copy_claim(&claim);
    job_definitions::work(
        &mut store.0,
        Work::CancelFinished {
            claim,
            result: Some(control.clone()),
        },
        NOW + 300,
    )
    .unwrap();
    let waiting = current(&mut store, &job, &occurrence);
    assert_eq!(waiting["state"], "canceling");
    assert_eq!(waiting["cancellation"]["state"], "awaitingExit");
    assert!(waiting["finishedAt"].is_null());
    let token: Option<String> = store
        .0
        .query_row(
            "SELECT token FROM harness_job_cancellations WHERE occurrence_id=?1",
            [occurrence["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(token.is_none());
    code(
        job_definitions::work(
            &mut store.0,
            Work::CancelFinished {
                claim: stale,
                result: Some(control.clone()),
            },
            NOW + 310,
        ),
        "stale_cancellation",
    );
    assert!(poll(&mut store, NOW + 350).is_empty());
    assert_eq!(current(&mut store, &job, &sibling)["state"], "queued");
    workflow_controls::execute(
        &mut store.0,
        workflow_controls::Work::Observe {
            actor: owner(),
            run_id: run["run"]["id"].as_str().unwrap().into(),
            control_id: control["control"]["id"].as_str().unwrap().into(),
            exited: vec!["worker".into()],
            unavailable: vec![],
        },
        NOW + 400,
    )
    .unwrap();
    assert!(cancellations(&mut store, NOW + 450).is_empty());
    let finished = current(&mut store, &job, &occurrence);
    assert_eq!(finished["state"], "canceled");
    assert_eq!(finished["cancellation"]["state"], "completed");
    assert_eq!(
        finished["cancellation"]["controlId"],
        control["control"]["id"]
    );
    assert_eq!(finished["finishedAt"], NOW + 450);
    let next = poll(&mut store, NOW + 500);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id, sibling["id"]);
    code(
        job_cancellations::guard_run(&store.0, run["run"]["id"].as_str().unwrap()),
        "job_canceled",
    );
    assert_eq!(
        request(
            &mut store,
            cancel_request(&job, &occurrence, "cancel"),
            NOW + 900
        )
        .unwrap(),
        accepted
    );
}

#[test]
fn an_unconfirmed_cancel_dispatch_is_not_exit_proof_or_permission_to_repeat() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, None);
    let occurrence = manual(&mut store, &job, "first");
    assert_eq!(poll(&mut store, NOW).len(), 1);
    let run = bind(&mut store, &occurrence, 1);
    let accepted = cancel(&mut store, &job, &occurrence);
    let sibling = manual(&mut store, &job, "second");
    let claim = cancellations(&mut store, NOW + 150).pop().unwrap();
    let stale = copy_claim(&claim);
    let before = job_events(&store);
    job_definitions::work(
        &mut store.0,
        Work::CancelFinished {
            claim,
            result: None,
        },
        NOW + 200,
    )
    .unwrap();
    let emitted = job_events(&store);
    assert_eq!(
        emitted,
        before + 1,
        "Publish the unconfirmed projection once"
    );
    let uncertain = current(&mut store, &job, &occurrence);
    assert_eq!(uncertain["state"], "reconcile");
    assert_eq!(uncertain["reason"], "cancel_dispatch_unconfirmed");
    assert_eq!(uncertain["cancellation"]["state"], "unconfirmed");
    assert!(uncertain["cancellation"]["controlId"].is_null());
    assert!(uncertain["finishedAt"].is_null());
    code(
        job_definitions::work(
            &mut store.0,
            Work::CancelFinished {
                claim: stale,
                result: None,
            },
            NOW + 250,
        ),
        "stale_cancellation",
    );
    assert!(cancellations(&mut store, NOW + 300).is_empty());
    assert!(poll(&mut store, NOW + 300).is_empty());
    assert_eq!(current(&mut store, &job, &sibling)["state"], "queued");
    assert_eq!(
        request(
            &mut store,
            cancel_request(&job, &occurrence, "cancel"),
            NOW + 900,
        )
        .unwrap(),
        accepted
    );
    code(
        job_cancellations::guard_run(&store.0, run["run"]["id"].as_str().unwrap()),
        "job_canceled",
    );
    late_messages(&mut store, &occurrence);
    assert_eq!(current(&mut store, &job, &occurrence), uncertain);
    assert_eq!(
        job_events(&store),
        emitted,
        "Quiet observations/replay/stale replies emit no duplicate event"
    );
}

#[test]
fn restart_invalidates_native_claims_without_reclaiming_or_reopening_the_queue() {
    for claimed in [false, true] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = create(&mut store, None);
        let occurrence = manual(&mut store, &job, "first");
        assert_eq!(poll(&mut store, NOW).len(), 1);
        let run = bind(&mut store, &occurrence, 1);
        let accepted = cancel(&mut store, &job, &occurrence);
        let sibling = manual(&mut store, &job, "second");
        let old = if claimed {
            cancellations(&mut store, NOW + 150).pop()
        } else {
            None
        };
        job_definitions::recover(&mut store.0, NOW + 200).unwrap();
        assert!(cancellations(&mut store, NOW + 300).is_empty());
        assert!(poll(&mut store, NOW + 300).is_empty());
        let recovered = current(&mut store, &job, &occurrence);
        assert_eq!(recovered["state"], "reconcile");
        assert_eq!(recovered["cancellation"]["state"], "unconfirmed");
        assert_eq!(recovered["cancellation"]["reason"], "host_restarted");
        assert!(recovered["finishedAt"].is_null());
        assert_eq!(current(&mut store, &job, &sibling)["state"], "queued");
        assert!(
            store
                .0
                .query_row(
                    "SELECT token FROM harness_job_cancellations WHERE occurrence_id=?1",
                    [occurrence["id"].as_str().unwrap()],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap()
                .is_none()
        );
        if let Some(claim) = old {
            code(
                job_definitions::work(
                    &mut store.0,
                    Work::CancelFinished {
                        claim,
                        result: None,
                    },
                    NOW + 400,
                ),
                "stale_cancellation",
            );
        }
        code(
            job_cancellations::guard_run(&store.0, run["run"]["id"].as_str().unwrap()),
            "job_canceled",
        );
        assert_eq!(
            request(
                &mut store,
                cancel_request(&job, &occurrence, "cancel"),
                NOW + 900
            )
            .unwrap(),
            accepted
        );
    }
}

#[test]
fn a_new_cancellation_cannot_rewrite_a_terminal_bound_run() {
    for terminal in ["succeeded", "canceled", "stopped"] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = create(&mut store, None);
        let occurrence = manual(&mut store, &job, "first");
        assert_eq!(poll(&mut store, NOW).len(), 1);
        let run = bind(&mut store, &occurrence, 1);
        if terminal == "succeeded" {
            orchestration::execute_at(&mut store.0, Actor { issuer: "worker".into(), scope: Scope::Worker("worker".into()) }, serde_json::from_value(json!({"action":"report","key":"result","attemptId":run["tasks"][0]["currentAttempt"]["id"],"result":super::orchestration_tests::report()})).unwrap(), NOW + 100).unwrap();
            let reported = workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}));
            workflow(
                &mut store,
                json!({"action":"validate","key":"validation","runId":run["run"]["id"],"expectedRevision":reported["run"]["revision"],"attemptId":run["tasks"][0]["currentAttempt"]["id"],"validation":{"passed":true,"summary":"Controlled owner validation","checks":[{"name":"fixture","outcome":"passed","details":"No native execution"}]}}),
            );
        } else {
            let kind = if terminal == "canceled" {
                workflow_controls::Kind::Cancel
            } else {
                workflow_controls::Kind::Stop
            };
            let (_, native) = native_control(&mut store, &run, "separate-run-control", kind);
            finish_native_target(&mut store, &native, true);
        }
        assert_eq!(
            workflow(&mut store, json!({"action":"get","runId":run["run"]["id"]}))["run"]["state"],
            terminal
        );
        code(
            request(
                &mut store,
                cancel_request(&job, &occurrence, "cancel"),
                NOW + 500,
            ),
            "occurrence_conflict",
        );
        assert!(current(&mut store, &job, &occurrence)["cancellation"].is_null());
    }
}

#[test]
fn existing_owner_control_can_reconcile_cancellation_only_after_exact_exit_proof() {
    for kind in [
        workflow_controls::Kind::Stop,
        workflow_controls::Kind::Cancel,
    ] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = create(&mut store, None);
        let occurrence = manual(&mut store, &job, "first");
        assert_eq!(poll(&mut store, NOW).len(), 1);
        let run = bind(&mut store, &occurrence, 1);
        let accepted = cancel(&mut store, &job, &occurrence);
        let claim = cancellations(&mut store, NOW + 150).pop().unwrap();
        job_definitions::work(
            &mut store.0,
            Work::CancelFinished {
                claim,
                result: None,
            },
            NOW + 160,
        )
        .unwrap();
        let sibling = manual(&mut store, &job, "second");
        let (control, native) = native_control(&mut store, &run, "owner-reconciliation", kind);
        finish_native_target(&mut store, &native, false);
        assert!(cancellations(&mut store, NOW + 230).is_empty());
        assert!(poll(&mut store, NOW + 230).is_empty());
        let pending = current(&mut store, &job, &occurrence);
        assert_eq!(pending["state"], "reconcile");
        assert!(pending["finishedAt"].is_null());
        workflow_controls::execute(
            &mut store.0,
            workflow_controls::Work::Observe {
                actor: owner(),
                run_id: run["run"]["id"].as_str().unwrap().into(),
                control_id: native.id,
                exited: vec!["worker".into()],
                unavailable: vec![],
            },
            NOW + 240,
        )
        .unwrap();
        assert!(cancellations(&mut store, NOW + 250).is_empty());
        let settled = current(&mut store, &job, &occurrence);
        assert_eq!(settled["state"], "canceled");
        assert_eq!(settled["cancellation"]["state"], "completed");
        assert_eq!(
            settled["cancellation"]["controlId"],
            control["control"]["id"]
        );
        assert_eq!(settled["reason"], "run_termination_observed");
        assert!(settled["finishedAt"].is_number());
        assert_eq!(
            store
                .0
                .query_row("SELECT count(*) FROM workflow_controls", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            request(
                &mut store,
                cancel_request(&job, &occurrence, "cancel"),
                NOW + 300
            )
            .unwrap(),
            accepted
        );
        let released = poll(&mut store, NOW + 300);
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].id, sibling["id"]);
    }
}
