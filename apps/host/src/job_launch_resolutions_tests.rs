use super::{Store, job_timeouts_tests::due_fixture};
use crate::{
    job_definitions::{self, Request},
    job_launch_resolutions as resolutions, job_timeouts,
    orchestration::{Actor, Scope},
    workflow_controls::{self, Work},
};
use rusqlite::{Connection, params, types::Value as SqlValue};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
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

fn fixture(control: bool) -> (Store, job_timeouts::Claim) {
    let (mut store, timeout) = due_fixture();
    if control {
        let workflow_controls::Reply::Prepared {
            claim: Some(claim), ..
        } = workflow_controls::execute(
            &mut store.0,
            Work::PrepareJobTimeout {
                claim: timeout.clone(),
            },
            NOW + 1001,
        )
        .unwrap()
        else {
            panic!("Expected exact native control claim");
        };
        let workflow_controls::Reply::Targets(targets) = workflow_controls::execute(
            &mut store.0,
            Work::Claim {
                claim: claim.clone(),
            },
            NOW + 1002,
        )
        .unwrap() else {
            panic!("Expected target");
        };
        assert_eq!(targets.len(), 1);
        workflow_controls::execute(
            &mut store.0,
            Work::Finish {
                claim: claim.clone(),
                session_id: timeout.identity.session_id.clone(),
                receipt: None,
            },
            NOW + 1003,
        )
        .unwrap();
        workflow_controls::execute(&mut store.0, Work::Claim { claim }, NOW + 1004).unwrap();
    }
    let tx = store.0.transaction().unwrap();
    job_timeouts::finish(&tx, &timeout, None, NOW + 1005).unwrap();
    let key = format!("run-launch:{}", timeout.identity.attempt_id);
    tx.execute("UPDATE operation_receipts SET key=?2,phase='failed',result=?3,claim_token=NULL WHERE id=?1",params![timeout.identity.launch_receipt_id,key,json!({"code":"invalid_launch","message":"Private scope path and native proof stay in storage","effectStarted":false,"taskResult":null}).to_string()]).unwrap();
    tx.execute(
        "UPDATE workflow_launches SET operation_key=?2 WHERE operation_id=?1",
        params![timeout.identity.launch_receipt_id, key],
    )
    .unwrap();
    tx.execute(
        "UPDATE workflow_attempts SET state='launchFailed' WHERE id=?1",
        [&timeout.identity.attempt_id],
    )
    .unwrap();
    tx.commit().unwrap();
    (store, timeout)
}

fn descriptor(store: &Store, claim: &job_timeouts::Claim) -> Value {
    resolutions::view_attempt(&store.0, &claim.identity.job_attempt_id)
        .unwrap()
        .0
}

fn request(claim: &job_timeouts::Claim, digest: &str, key: &str) -> Request {
    Request::AbandonLaunchNoEffect {
        key: key.into(),
        job_id: claim.identity.job_id.clone(),
        occurrence_id: claim.identity.occurrence_id.clone(),
        job_attempt_id: claim.identity.job_attempt_id.clone(),
        expected_digest: digest.into(),
        acknowledge_unknown_effects: true,
    }
}

fn abandon(store: &mut Store, claim: &job_timeouts::Claim, key: &str) -> Value {
    let descriptor = descriptor(store, claim);
    assert_eq!(descriptor["available"], true, "{descriptor}");
    job_definitions::execute(
        &mut store.0,
        owner(),
        request(claim, descriptor["digest"].as_str().unwrap(), key),
        NOW + 2000,
    )
    .unwrap()
}

fn native_facts(connection: &Connection) -> Vec<Vec<Vec<SqlValue>>> {
    [
        "operation_receipts",
        "workflow_runs",
        "workflow_tasks",
        "workflow_attempts",
        "workflow_launches",
        "workflow_controls",
        "workflow_control_targets",
        "workflow_process_exits",
        "harness_job_timeouts",
        "harness_job_cancellations",
        "harness_job_prechecks",
        "harness_job_generation_prechecks",
        "harness_precheck_approvals",
    ]
    .iter()
    .map(|table| {
        let mut query = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = query.column_count();
        query
            .query_map([], |row| {
                (0..columns)
                    .map(|column| row.get::<_, SqlValue>(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    })
    .collect()
}

#[test]
fn explicit_owner_resolution_releases_overlap_without_rewriting_any_native_fact() {
    for control in [false, true] {
        let (mut store, claim) = fixture(control);
        let before = native_facts(&store.0);
        let available = descriptor(&store, &claim);
        assert_eq!(available.as_object().unwrap().len(), 11);
        assert_eq!(available["available"], true);
        assert!(available["reason"].is_null());
        assert_eq!(available["digest"].as_str().unwrap().len(), 64);
        assert!(!available.to_string().contains("Private scope"));
        let accepted = abandon(&mut store, &claim, "owner-abandon");
        assert_eq!(accepted["occurrence"]["state"], "canceled");
        assert_eq!(accepted["occurrence"]["reason"], "launch_owner_abandoned");
        let resolution = &accepted["occurrence"]["launchResolution"];
        assert_eq!(resolution.as_object().unwrap().len(), 11);
        assert_eq!(resolution["mutationKey"], "owner-abandon");
        assert_eq!(resolution["digest"], available["digest"]);
        assert_eq!(
            accepted["occurrence"]["launchReconciliation"]["reason"],
            "generation_resolved"
        );
        assert!(!job_timeouts::owns_occurrence(&store.0, &claim.identity.occurrence_id).unwrap());
        assert_eq!(native_facts(&store.0), before);
        let generation = crate::job_attempts::view(
            &store.0,
            &claim.identity.job_id,
            &claim.identity.occurrence_id,
            Some(&claim.identity.job_attempt_id),
            0,
        )
        .unwrap();
        assert_eq!(generation["jobAttempt"]["launchResolution"], *resolution);
        let next = job_definitions::execute(
            &mut store.0,
            owner(),
            Request::RunNow {
                key: "separate-occurrence".into(),
                job_id: claim.identity.job_id.clone(),
                expected_revision: 1,
            },
            NOW + 2001,
        )
        .unwrap();
        assert_eq!(next["occurrence"]["state"], "queued");
        assert!(next["occurrence"]["reason"].is_null());
        assert!(next["occurrence"]["launchResolution"].is_null());
        assert_eq!(native_facts(&store.0), before);
    }
}

#[test]
fn proof_requires_terminal_create_and_json_boolean_false() {
    for result in [
        json!({}),
        json!({"effectStarted":null}),
        json!({"effectStarted":0}),
        json!({"effectStarted":"false"}),
        json!({"effectStarted":true}),
        json!({"effectStarted":false,"taskResult":{"ok":true}}),
    ] {
        let (mut store, claim) = fixture(false);
        store
            .0
            .execute(
                "UPDATE operation_receipts SET result=?2 WHERE id=?1",
                params![claim.identity.launch_receipt_id, result.to_string()],
            )
            .unwrap();
        assert_eq!(
            descriptor(&store, &claim)["reason"],
            "launch_reconciliation_unavailable"
        );
        code(
            job_definitions::execute(
                &mut store.0,
                owner(),
                request(&claim, &"0".repeat(64), "bad-proof"),
                NOW + 2000,
            ),
            "occurrence_conflict",
        );
    }
    for phase in ["accepted", "dispatching", "unknown", "created"] {
        let (store, claim) = fixture(false);
        store
            .0
            .execute(
                "UPDATE operation_receipts SET phase=?2 WHERE id=?1",
                params![claim.identity.launch_receipt_id, phase],
            )
            .unwrap();
        assert_eq!(descriptor(&store, &claim)["available"], false);
    }
}

#[test]
fn owner_and_exact_generation_acknowledgment_are_required_before_fresh_acceptance() {
    let (mut store, claim) = fixture(false);
    let digest = descriptor(&store, &claim)["digest"]
        .as_str()
        .unwrap()
        .to_owned();
    for scope in [
        Scope::Worker(claim.identity.session_id.clone()),
        Scope::Coordinator("coordinator".into()),
    ] {
        code(
            job_definitions::execute(
                &mut store.0,
                Actor {
                    issuer: "owner".into(),
                    scope,
                },
                request(&claim, &digest, "nonowner"),
                NOW + 2000,
            ),
            "forbidden",
        );
    }
    let mut no_ack = request(&claim, &digest, "no-ack");
    if let Request::AbandonLaunchNoEffect {
        acknowledge_unknown_effects,
        ..
    } = &mut no_ack
    {
        *acknowledge_unknown_effects = false;
    }
    code(
        job_definitions::execute(&mut store.0, owner(), no_ack, NOW + 2000),
        "invalid_argument",
    );
    let mut wrong = request(&claim, &digest, "wrong-generation");
    if let Request::AbandonLaunchNoEffect { job_attempt_id, .. } = &mut wrong {
        *job_attempt_id = "another-generation".into();
    }
    code(
        job_definitions::execute(&mut store.0, owner(), wrong, NOW + 2000),
        "occurrence_conflict",
    );
    let mut wire = serde_json::to_value(request(&claim, &digest, "missing-generation")).unwrap();
    wire.as_object_mut().unwrap().remove("jobAttemptId");
    assert!(serde_json::from_value::<Request>(wire).is_err());
    code(
        job_definitions::execute(
            &mut store.0,
            owner(),
            request(&claim, &"0".repeat(64), "stale-digest"),
            NOW + 2000,
        ),
        "occurrence_conflict",
    );
    assert_eq!(descriptor(&store, &claim)["digest"], digest);
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT count(*) FROM harness_job_launch_resolutions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn digest_ignores_poll_timestamps_but_binds_new_exact_receipt_and_cleanup_facts() {
    let (mut store, claim) = fixture(true);
    let first = descriptor(&store, &claim);
    store
        .0
        .execute(
            "UPDATE harness_job_timeouts SET observed_at=observed_at+10000",
            [],
        )
        .unwrap();
    assert_eq!(descriptor(&store, &claim), first);
    store
        .0
        .execute(
            "UPDATE operation_receipts SET result=?2 WHERE id=?1",
            params![
                claim.identity.launch_receipt_id,
                json!({"effectStarted":false,"code":"updated_immutable_proof"}).to_string()
            ],
        )
        .unwrap();
    let changed = descriptor(&store, &claim);
    assert_eq!(changed["available"], true);
    assert_ne!(changed["digest"], first["digest"]);
    code(
        job_definitions::execute(
            &mut store.0,
            owner(),
            request(&claim, first["digest"].as_str().unwrap(), "changed-proof"),
            NOW + 2000,
        ),
        "occurrence_conflict",
    );
    abandon(&mut store, &claim, "fresh-proof");
}

#[test]
fn live_producers_mismatched_targets_and_outcomes_block_abandonment() {
    for sql in [
        "UPDATE harness_job_attempts SET dispatch_token='live'",
        "UPDATE operation_receipts SET claim_token='live' WHERE operation='create'",
        "UPDATE harness_job_timeouts SET token='live'",
        "UPDATE harness_job_timeouts SET state='armed'",
        "UPDATE workflow_controls SET token='live'",
        "UPDATE workflow_control_targets SET phase='pending'",
        "UPDATE workflow_control_targets SET phase='dispatching'",
        "UPDATE workflow_control_targets SET session_id='unrelated'",
        "UPDATE workflow_control_targets SET phase='stopRequested'",
        "UPDATE workflow_attempts SET result='{}'",
        "UPDATE workflow_attempts SET validation='{}'",
        "INSERT INTO workflow_process_exits(session_id,observed_at) SELECT session_id,1 FROM workflow_attempts",
        "UPDATE workflow_launches SET operation_key='other-launch'",
        "UPDATE harness_job_cancellations SET token='live'",
        "INSERT INTO harness_job_retries(source_attempt_id,occurrence_id,native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,state) SELECT j.id,j.occurrence_id,n.id,l.operation_id,1,2,2,'waiting' FROM harness_job_attempts j JOIN workflow_tasks t ON t.run_id=j.run_id JOIN workflow_attempts n ON n.task_id=t.id JOIN workflow_launches l ON l.attempt_id=n.id",
        "INSERT INTO workflow_deliveries(id,run_id,attempt_id,issuer,phase,created_at,deadline_at) SELECT 'input',t.run_id,n.id,'owner','unknown',1,2 FROM workflow_attempts n JOIN workflow_tasks t ON t.id=n.task_id",
        "INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state) SELECT 'later',occurrence_id,2,1,'failed' FROM harness_job_attempts WHERE ordinal=1",
    ] {
        let (mut store, claim) = fixture(true);
        store.0.execute("INSERT INTO harness_job_cancellations(occurrence_id,issuer,state,requested_at,observed_at,control_key) VALUES(?1,'owner','unconfirmed',1,1,'old-cancel')",[&claim.identity.occurrence_id]).unwrap();
        let digest = descriptor(&store, &claim)["digest"]
            .as_str()
            .unwrap()
            .to_owned();
        store.0.execute_batch(sql).unwrap();
        assert_eq!(descriptor(&store, &claim)["available"], false, "{sql}");
        code(
            job_definitions::execute(
                &mut store.0,
                owner(),
                request(&claim, &digest, "unsafe"),
                NOW + 2000,
            ),
            "occurrence_conflict",
        );
    }
}

#[test]
fn old_descriptor_cannot_resolve_a_replacement_generation() {
    let (mut store, claim) = fixture(false);
    let old = descriptor(&store, &claim);
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state,dispatch_token) VALUES('replacement',?1,2,1,'dispatching','fresh-producer')", [&claim.identity.occurrence_id]).unwrap();
    store.0.execute("UPDATE harness_job_occurrences SET current_job_attempt_id='replacement',run_id=NULL,state='dispatching',reason=NULL WHERE id=?1", [&claim.identity.occurrence_id]).unwrap();
    assert_eq!(
        descriptor(&store, &claim)["reason"],
        "launch_reconciliation_unavailable"
    );
    code(
        job_definitions::execute(
            &mut store.0,
            owner(),
            request(&claim, old["digest"].as_str().unwrap(), "old-generation"),
            NOW + 2000,
        ),
        "occurrence_conflict",
    );
    let current = job_definitions::execute(
        &mut store.0,
        owner(),
        Request::Occurrence {
            job_id: claim.identity.job_id.clone(),
            occurrence_id: claim.identity.occurrence_id.clone(),
        },
        NOW + 2001,
    )
    .unwrap();
    assert_eq!(current["occurrence"]["jobAttemptId"], "replacement");
    assert_eq!(current["occurrence"]["state"], "dispatching");
    assert!(current["occurrence"]["launchResolution"].is_null());
    assert!(current["occurrence"]["launchReconciliation"].is_null());
}

#[test]
fn original_owner_control_key_replays_after_resolution_but_fresh_control_is_fenced() {
    let (mut store, claim) = fixture(false);
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase='unknown',result='{}' WHERE operation='create'",
            [],
        )
        .unwrap();
    let original = workflow_controls::Request::Start {
        key: "accepted-owner-stop".into(),
        run_id: claim.identity.run_id.clone(),
        expected_revision: 1,
        kind: workflow_controls::Kind::Stop,
    };
    let workflow_controls::Reply::Prepared {
        view,
        claim: Some(control),
    } = workflow_controls::execute(
        &mut store.0,
        Work::Prepare {
            actor: owner(),
            request: original.clone(),
        },
        NOW + 1100,
    )
    .unwrap()
    else {
        panic!("Expected owner control");
    };
    workflow_controls::execute(
        &mut store.0,
        Work::Claim {
            claim: control.clone(),
        },
        NOW + 1101,
    )
    .unwrap();
    workflow_controls::execute(
        &mut store.0,
        Work::Finish {
            claim: control.clone(),
            session_id: claim.identity.session_id.clone(),
            receipt: None,
        },
        NOW + 1102,
    )
    .unwrap();
    workflow_controls::execute(&mut store.0, Work::Claim { claim: control }, NOW + 1103).unwrap();
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase='failed',result=?1 WHERE operation='create'",
            [json!({"effectStarted":false,"taskResult":null}).to_string()],
        )
        .unwrap();
    abandon(&mut store, &claim, "resolve-after-owner-stop");
    let workflow_controls::Reply::Prepared {
        view: replayed,
        claim: replayed_claim,
    } = workflow_controls::execute(
        &mut store.0,
        Work::Prepare {
            actor: owner(),
            request: original,
        },
        NOW + 3000,
    )
    .unwrap()
    else {
        panic!("Expected immutable control replay");
    };
    assert!(replayed_claim.is_none());
    assert_eq!(replayed, view);
    code(
        workflow_controls::execute(
            &mut store.0,
            Work::Prepare {
                actor: owner(),
                request: workflow_controls::Request::Start {
                    key: "fresh-owner-stop".into(),
                    run_id: claim.identity.run_id.clone(),
                    expected_revision: 2,
                    kind: workflow_controls::Kind::Stop,
                },
            },
            NOW + 3000,
        ),
        "job_generation_retired",
    );
}

#[test]
fn unknown_cleanup_receipt_is_retained_but_positive_native_evidence_is_never_acknowledged_away() {
    for positive in [false, true] {
        let (mut store, claim) = fixture(true);
        let (key, control): (String, String) = store
            .0
            .query_row(
                "SELECT key,control_id FROM workflow_control_targets",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('unknown-stop','owner',?1,'retained','stop','unknown',?2,?3)",params![key,claim.identity.session_id,json!({"effectStarted":true,"nativeStopRequested":positive,"taskResult":null}).to_string()]).unwrap();
        store
            .0
            .execute(
                "UPDATE workflow_control_targets SET receipt_id='unknown-stop' WHERE control_id=?1",
                [control],
            )
            .unwrap();
        if positive {
            assert_eq!(descriptor(&store, &claim)["available"], false);
        } else {
            let before = native_facts(&store.0);
            abandon(&mut store, &claim, "acknowledge-unknown");
            assert_eq!(native_facts(&store.0), before);
        }
    }
}

#[test]
fn replay_recovery_poll_and_stale_callbacks_keep_resolution_and_native_evidence_immutable() {
    let (mut store, claim) = fixture(true);
    store.0.execute("INSERT INTO harness_job_cancellations(occurrence_id,issuer,state,requested_at,observed_at,control_key) VALUES(?1,'owner','unconfirmed',1,1,'old-cancel')",[&claim.identity.occurrence_id]).unwrap();
    let digest = descriptor(&store, &claim)["digest"]
        .as_str()
        .unwrap()
        .to_owned();
    let original = request(&claim, &digest, "immutable-owner-decision");
    let accepted =
        job_definitions::execute(&mut store.0, owner(), original.clone(), NOW + 2000).unwrap();
    let before = native_facts(&store.0);
    job_definitions::recover(&mut store.0, NOW + 3000).unwrap();
    for _ in 0..3 {
        job_definitions::work(
            &mut store.0,
            job_definitions::Work::Poll { slots: 0 },
            NOW + 4000,
        )
        .unwrap();
        let tx = store.0.transaction().unwrap();
        assert!(
            !crate::job_retries::consider(&tx, &claim.identity.occurrence_id, NOW + 4000).unwrap()
        );
        assert!(
            crate::job_retries::claim(&tx, &claim.identity.occurrence_id, NOW + 4000)
                .unwrap()
                .is_none()
        );
        assert!(
            job_timeouts::claims(&tx, 2, NOW + 4000, 999999)
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::job_cancellations::claims(&tx, 2, NOW + 4000)
                .unwrap()
                .is_empty()
        );
        job_definitions::transition(
            &tx,
            &claim.identity.occurrence_id,
            "reconcile",
            Some("late_callback"),
            false,
            NOW + 4000,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let tx = store.0.transaction().unwrap();
    code(
        job_timeouts::finish(&tx, &claim, None, NOW + 5000),
        "stale_job_timeout",
    );
    code(
        crate::job_cancellations::finish(
            &tx,
            &crate::job_cancellations::Claim {
                occurrence: claim.identity.occurrence_id.clone(),
                token: "old".into(),
                issuer: "owner".into(),
                run: claim.identity.run_id.clone(),
                key: "old-cancel".into(),
            },
            None,
            NOW + 5000,
        ),
        "stale_cancellation",
    );
    tx.commit().unwrap();
    assert_eq!(native_facts(&store.0), before);
    assert_eq!(
        job_definitions::execute(&mut store.0, owner(), original, NOW + 6000).unwrap(),
        accepted
    );
    code(
        job_definitions::execute(
            &mut store.0,
            owner(),
            request(&claim, &"0".repeat(64), "immutable-owner-decision"),
            NOW + 6000,
        ),
        "idempotency_conflict",
    );
    code(
        job_definitions::execute(
            &mut store.0,
            owner(),
            request(&claim, &digest, "second-owner-decision"),
            NOW + 6000,
        ),
        "occurrence_conflict",
    );
    code(
        crate::job_attempts::guard_run(&store.0, &claim.identity.run_id),
        "job_generation_retired",
    );
    code(workflow_controls::execute(&mut store.0,Work::Prepare {actor:owner(),request:serde_json::from_value(json!({"action":"start","key":"fresh-stop","runId":claim.identity.run_id,"expectedRevision":2,"kind":"stop"})).unwrap()},NOW+6000),"job_generation_retired");
    assert_eq!(
        job_definitions::execute(
            &mut store.0,
            owner(),
            Request::Occurrence {
                job_id: claim.identity.job_id.clone(),
                occurrence_id: claim.identity.occurrence_id.clone()
            },
            NOW + 6000
        )
        .unwrap()["occurrence"],
        accepted["occurrence"]
    );
}

#[test]
fn exact_generation_precheck_history_is_preserved_and_previous_pass_cannot_authorize_replacement() {
    let (mut store, claim) = fixture(false);
    let command:crate::job_prechecks::Command=serde_json::from_value(json!({"title":"Exact command","executable":if cfg!(windows){"C:/tools/check.exe"}else{"/usr/bin/check"},"cwd":if cfg!(windows){"C:/workspace"}else{"/workspace"}})).unwrap();
    let command_digest = crate::job_prechecks::digest(&command).unwrap();
    let command = serde_json::to_string(&command).unwrap();
    let mut spec: Value = store
        .0
        .query_row("SELECT spec FROM harness_job_occurrences", [], |r| {
            r.get::<_, String>(0)
        })
        .map(|text| serde_json::from_str(&text).unwrap())
        .unwrap();
    spec["precheckId"] = "approval".into();
    store
        .0
        .execute("UPDATE harness_jobs SET spec=?1", [spec.to_string()])
        .unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET spec=?1",
            [spec.to_string()],
        )
        .unwrap();
    store.0.execute("INSERT INTO harness_precheck_approvals(id,spec,digest,revision,enabled,created_at) VALUES('approval',?1,?2,1,1,1)",params![command,command_digest]).unwrap();
    store.0.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,spec,state,reason,started_at,finished_at,result,observed_at) VALUES(?1,'approval',?2,?3,'passed','fixture',1,2,?4,2)",params![claim.identity.occurrence_id,command_digest,command,json!({"state":"passed","commandStarted":true,"cleanupConfirmed":true,"stdout":"retained old command effects"}).to_string()]).unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_attempts SET ordinal=2 WHERE id=?1",
            [&claim.identity.job_attempt_id],
        )
        .unwrap();
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state) VALUES('old-generation',?1,1,1,'failed')",[&claim.identity.occurrence_id]).unwrap();
    assert_eq!(
        descriptor(&store, &claim)["reason"],
        "launch_reconciliation_unavailable"
    );
    store.0.execute("INSERT INTO harness_job_generation_prechecks(job_attempt_id,occurrence_id,ordinal,approval_id,approval_digest,approval_revision,spec,state,reason,started_at,finished_at,result,observed_at) VALUES(?1,?2,2,'approval',?3,1,?4,'passed','fixture',3,4,?5,4)",params![claim.identity.job_attempt_id,claim.identity.occurrence_id,command_digest,command,json!({"state":"passed","commandStarted":true,"cleanupConfirmed":true,"stdout":"retained generation-two command effects"}).to_string()]).unwrap();
    let before = native_facts(&store.0);
    abandon(&mut store, &claim, "exact-generation-two");
    assert_eq!(native_facts(&store.0), before);
    assert_eq!(
        crate::job_precheck_records::view_attempt(
            &store.0,
            &claim.identity.occurrence_id,
            "old-generation",
            true
        )
        .unwrap()["result"]["stdout"],
        "retained old command effects"
    );
    let next = job_definitions::execute(
        &mut store.0,
        owner(),
        Request::RunNow {
            key: "new-command-required".into(),
            job_id: claim.identity.job_id.clone(),
            expected_revision: 1,
        },
        NOW + 3000,
    )
    .unwrap();
    assert!(next["occurrence"]["precheck"].is_null());
    assert!(next["occurrence"]["jobAttemptId"].is_null());
}

#[test]
fn unavailable_diagnostic_keeps_legacy_history_readable_without_authorizing_unusable_specs() {
    for spec in ["{}", "{invalid legacy policy", r#"{"title":"Legacy"}"#] {
        let (mut store, claim) = fixture(false);
        store
            .0
            .execute("UPDATE harness_job_occurrences SET spec=?1", [spec])
            .unwrap();
        let view = crate::job_attempts::view(
            &store.0,
            &claim.identity.job_id,
            &claim.identity.occurrence_id,
            Some(&claim.identity.job_attempt_id),
            0,
        )
        .unwrap();
        let diagnostic = &view["jobAttempt"]["launchReconciliation"];
        assert_eq!(diagnostic["available"], false);
        assert_eq!(diagnostic["reason"], "launch_reconciliation_unavailable");
        assert!(diagnostic["digest"].is_null());
        assert_eq!(diagnostic["attemptId"], claim.identity.attempt_id);
        assert!(view["jobAttempt"]["launchResolution"].is_null());
        let before = native_facts(&store.0);
        code(
            job_definitions::execute(
                &mut store.0,
                owner(),
                request(&claim, &"0".repeat(64), "unusable-spec"),
                NOW + 2000,
            ),
            "occurrence_conflict",
        );
        assert_eq!(native_facts(&store.0), before);
    }
}

#[test]
fn unavailable_historical_descriptor_stays_stable_as_retry_and_current_pointer_change() {
    let (mut store, claim) = fixture(false);
    store.0.execute("INSERT INTO harness_job_retries(source_attempt_id,occurrence_id,native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,state) VALUES(?1,?2,?3,?4,1,2,2,'waiting')",params![claim.identity.job_attempt_id,claim.identity.occurrence_id,claim.identity.attempt_id,claim.identity.launch_receipt_id]).unwrap();
    let original = crate::job_attempts::view(
        &store.0,
        &claim.identity.job_id,
        &claim.identity.occurrence_id,
        Some(&claim.identity.job_attempt_id),
        0,
    )
    .unwrap();
    assert_eq!(
        original["jobAttempt"]["launchReconciliation"]["available"],
        false
    );
    for state in ["retryWaiting", "reconcile", "canceled"] {
        store
            .0
            .execute("UPDATE harness_job_occurrences SET state=?1", [state])
            .unwrap();
        assert_eq!(
            crate::job_attempts::view(
                &store.0,
                &claim.identity.job_id,
                &claim.identity.occurrence_id,
                Some(&claim.identity.job_attempt_id),
                0
            )
            .unwrap(),
            original
        );
    }
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state) VALUES('later-generation',?1,2,1,'dispatching')",[&claim.identity.occurrence_id]).unwrap();
    store.0.execute("UPDATE harness_job_occurrences SET current_job_attempt_id='later-generation',run_id=NULL,state='dispatching'",[]).unwrap();
    assert_eq!(
        crate::job_attempts::view(
            &store.0,
            &claim.identity.job_id,
            &claim.identity.occurrence_id,
            Some(&claim.identity.job_attempt_id),
            0
        )
        .unwrap(),
        original
    );
    let tx = store.0.transaction().unwrap();
    crate::job_cancellations::recover(&tx, NOW + 3000).unwrap();
    job_timeouts::recover(&tx, NOW + 3000).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        descriptor(&store, &claim),
        original["jobAttempt"]["launchReconciliation"]
    );
}

#[test]
fn generation_initializer_installs_the_permanent_fence_for_the_legacy_schema_subset() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE workflow_runs(id TEXT PRIMARY KEY);
        CREATE TABLE harness_job_occurrences(id TEXT PRIMARY KEY,run_id TEXT REFERENCES workflow_runs(id),created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,state TEXT NOT NULL,reason TEXT);
        INSERT INTO workflow_runs VALUES('old-run');
        INSERT INTO harness_job_occurrences VALUES('old-occurrence','old-run',1,2,NULL,'running',NULL);").unwrap();
    crate::job_attempts::initialize(&connection).unwrap();
    crate::job_retries::initialize_legacy_schema(&connection).unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    crate::job_attempts::backfill(&tx).unwrap();
    tx.commit().unwrap();
    crate::job_attempts::guard_run(&connection, "old-run").unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM harness_job_launch_resolutions",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn retained_coordinator_identity_and_other_run_native_context_are_outside_reconciliation_scope() {
    for mutation in 0..5 {
        let (mut store, claim) = fixture(false);
        let original = descriptor(&store, &claim);
        assert_eq!(original["available"], true);
        match mutation {
            0 => {
                store
                    .0
                    .execute(
                        "UPDATE workflow_runs SET coordinator_id='coordinator' WHERE id=?1",
                        [&claim.identity.run_id],
                    )
                    .unwrap();
            }
            1 => {
                store.0.execute("INSERT INTO workflow_coordinator_bindings(run_id,coordinator_id,previous_id,directory,generation,source,updated_at) VALUES(?1,'coordinator','previous-coordinator','retained-path',1,'unbound',1)",[&claim.identity.run_id]).unwrap();
            }
            2 => {
                store.0.execute("INSERT INTO workflow_wake_policies(id,run_id,coordinator_id,issuer,enabled,generation,phase,created_at) VALUES('retained-policy',?1,'old-coordinator','owner',0,1,'disabled',1)",[&claim.identity.run_id]).unwrap();
            }
            3 => {
                store.0.execute("INSERT INTO workflow_mutations(issuer,key,digest,view) VALUES('owner','retained-coordinator-view','retained',?1)",[json!({"run":{"id":claim.identity.run_id,"coordinatorSessionId":"old-coordinator"}}).to_string()]).unwrap();
            }
            _ => {
                store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('other-run-input','owner','other-input','retained','send','unknown','other-coordinator','{}')",[]).unwrap();
                store.0.execute("INSERT INTO workflow_native_context(operation_id,run_id,revision,admitted) VALUES('other-run-input',?1,0,1)",[&claim.identity.run_id]).unwrap();
            }
        }
        assert!(
            store
                .0
                .query_row(
                    "SELECT coordinator_id FROM workflow_runs WHERE id=?1",
                    [&claim.identity.run_id],
                    |row| row.get::<_, Option<String>>(0)
                )
                .unwrap()
                .is_none()
                || mutation == 0
        );
        let diagnostic = descriptor(&store, &claim);
        assert_eq!(diagnostic["available"], false, "Scope case {mutation}");
        assert_eq!(diagnostic["reason"], "launch_reconciliation_unavailable");
        assert!(diagnostic["digest"].is_null());
        let before = native_facts(&store.0);
        code(
            job_definitions::execute(
                &mut store.0,
                owner(),
                request(
                    &claim,
                    original["digest"].as_str().unwrap(),
                    "expanded-scope",
                ),
                NOW + 2000,
            ),
            "occurrence_conflict",
        );
        assert_eq!(native_facts(&store.0), before);
    }
}

#[test]
fn postresolution_coordinator_binding_is_metadata_but_new_wake_admission_and_dispatch_are_fenced() {
    use crate::{workflow_coordinator as coordinator, workflow_wakes as wakes};
    let (mut store, claim) = fixture(false);
    abandon(&mut store, &claim, "retire-before-binding");
    let rebound = coordinator::execute(
        &mut store.0,
        coordinator::Work::Apply {
            actor: owner(),
            request: coordinator::Request {
                key: "later-metadata-binding".into(),
                run_id: claim.identity.run_id.clone(),
                expected_revision: 1,
                expected_coordinator_session_id: None,
                coordinator_session_id: "later-coordinator".into(),
            },
            facts: coordinator::Facts {
                target_id: "later-coordinator".into(),
                target: coordinator::Location {
                    directory: if cfg!(windows) {
                        "C:/workspace"
                    } else {
                        "/workspace"
                    }
                    .into(),
                    group_id: None,
                },
                previous: None,
            },
        },
        NOW + 3000,
    )
    .unwrap()
    .unwrap();
    assert_eq!(rebound["nativeEffectsRestored"], false);
    assert_eq!(rebound["workerAuthorityRestored"], false);
    let enable = wakes::Request::Enable {
        key: "fresh-wake-after-retirement".into(),
        run_id: claim.identity.run_id.clone(),
        expected_revision: rebound["run"]["revision"].as_u64().unwrap(),
    };
    let receipts: i64 = store
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    code(
        wakes::execute(
            &mut store.0,
            wakes::Work::Manage {
                actor: owner(),
                request: enable,
            },
            NOW + 3001,
        ),
        "job_generation_retired",
    );
    assert!(
        wakes::read(&store.0, &claim.identity.run_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM operation_receipts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        receipts
    );

    store.0.execute("INSERT INTO workflow_wake_policies(id,run_id,coordinator_id,issuer,enabled,generation,phase,created_at) VALUES('old-policy',?1,'later-coordinator','owner',1,1,'enabled',1)",[&claim.identity.run_id]).unwrap();
    store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('old-wake-receipt','owner','run-wake:old-batch','retained','send','accepted','later-coordinator','{}')",[]).unwrap();
    store.0.execute("INSERT INTO workflow_wake_batches(id,policy_id,generation,issuer,operation_id,phase,created_at) VALUES('old-batch','old-policy',1,'owner','old-wake-receipt','dispatching',1)",[]).unwrap();
    let before = native_facts(&store.0);
    code(
        wakes::execute(
            &mut store.0,
            wakes::Work::Claim {
                guard: wakes::Guard {
                    id: "old-policy".into(),
                    generation: 1,
                },
                issuer: "owner".into(),
            },
            NOW + 3002,
        ),
        "job_generation_retired",
    );
    code(
        crate::workflow_wake_batches::guard_dispatch(
            &store.0,
            "later-coordinator",
            "old-wake-receipt",
            NOW + 3002,
        ),
        "job_generation_retired",
    );
    assert_eq!(native_facts(&store.0), before);

    let original = wakes::Request::Enable {
        key: "retained-wake-key".into(),
        run_id: claim.identity.run_id.clone(),
        expected_revision: 1,
    };
    let accepted =
        json!({"run":{"id":claim.identity.run_id},"retained":"original immutable wake response"});
    let fingerprint = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&json!({"action":"wakes","request":original})).unwrap(),
        )
        .as_ref(),
    );
    let tx = store.0.transaction().unwrap();
    crate::orchestration::remember(&tx, &owner(), "retained-wake-key", &fingerprint, &accepted)
        .unwrap();
    tx.commit().unwrap();
    let wakes::Reply::Managed { view, pump } = wakes::execute(
        &mut store.0,
        wakes::Work::Manage {
            actor: owner(),
            request: original,
        },
        NOW + 3003,
    )
    .unwrap() else {
        panic!("Expected immutable replay");
    };
    assert_eq!(view, accepted);
    assert!(pump.is_none());
}

#[test]
fn uncertain_classification_is_in_the_launch_diagnostic_and_never_authorizes_abandonment() {
    use super::job_retries_tests as retries;
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let fixture = retries::seed(&store, "diagnostic", Some(retries::retry(3)), 1);
    let proven = resolutions::view_attempt(&store.0, &fixture.source)
        .unwrap()
        .0;
    assert!(proven.get("retryClassification").is_none());
    retries::native_state(
        &store,
        &fixture,
        "launchUnknown",
        "unknown",
        json!({"code":"launch_unconfirmed"}),
    );
    retries::retire_producer(&store, &fixture);
    retries::fail(&mut store, &fixture, "launch_unconfirmed", NOW + 5);
    let probing = resolutions::view_attempt(&store.0, &fixture.source)
        .unwrap()
        .0;
    assert_eq!(probing["retryClassification"]["decision"], "probing");
    assert!(retries::claim(&mut store, &fixture, NOW + 6).is_none());
    let descriptor = resolutions::view_attempt(&store.0, &fixture.source)
        .unwrap()
        .0;
    assert_eq!(descriptor["available"], false);
    assert!(descriptor["digest"].is_null());
    let class = &descriptor["retryClassification"];
    assert_eq!(class["class"], "definiteEffect");
    assert_eq!(class["decision"], "adopted");
    assert_eq!(class["state"], "adopted");
    assert_eq!(class["probe"]["result"], "attemptFound");
    assert_eq!(class["probe"]["launchReceiptId"], fixture.receipt);
    assert_eq!(class["probe"]["observedAt"], NOW + 6);
    let occurrence =
        job_definitions::occurrence(&store.0, &fixture.job, &fixture.occurrence, true).unwrap();
    assert_eq!(occurrence["launchReconciliation"], descriptor);
    assert_eq!(occurrence["state"], "reconcile");
    let facts = native_facts(&store.0);
    let tx = store.0.transaction().unwrap();
    code(
        resolutions::accept(
            &tx,
            &owner(),
            &fixture.job,
            &fixture.occurrence,
            &fixture.source,
            &"0".repeat(64),
            true,
            "abandon-adopted-launch",
            NOW + 7,
        ),
        "occurrence_conflict",
    );
    drop(tx);
    assert_eq!(native_facts(&store.0), facts);
}
