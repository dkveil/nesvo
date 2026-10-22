use super::Store;
use crate::{job_timeouts, job_timeouts::Identity};
use rusqlite::params;
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;
const ELAPSED: u64 = 100;

fn sql_time(value: u64) -> i64 {
    i64::try_from(value).unwrap()
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

pub(super) fn armed_fixture(timeout: Option<u64>) -> (Store, Identity) {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let identity = Identity {
        job_id: "1".repeat(32),
        occurrence_id: "2".repeat(32),
        job_attempt_id: "3".repeat(32),
        run_id: "4".repeat(32),
        attempt_id: "5".repeat(32),
        session_id: "6".repeat(32),
        launch_receipt_id: "7".repeat(32),
    };
    let mut spec = json!({"title":"Bounded job","instruction":"Report only this exact task","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},"misfire":"catchUp","graceMs":60000,"overlap":"queue","maxElapsedMs":300000});
    if let Some(timeout) = timeout {
        spec["executionTimeoutMs"] = json!(timeout);
    }
    let spec = serde_json::to_string(
        &serde_json::from_value::<crate::job_definitions::Spec>(spec).unwrap(),
    )
    .unwrap();
    let tx = store.0.transaction().unwrap();
    tx.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Run','Exact timeout fixture',1,'active',?2)",params![identity.run_id,sql_time(NOW)]).unwrap();
    tx.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES('task',?1,'job',?2)",params![identity.run_id,json!({"key":"job","title":"Task","instruction":"Report exact metadata","dependencies":[]}).to_string()]).unwrap();
    tx.execute(
        "INSERT INTO harness_jobs(id,spec,revision,enabled,created_at) VALUES(?1,?2,1,1,?3)",
        params![identity.job_id, spec, sql_time(NOW)],
    )
    .unwrap();
    tx.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,run_id,started_at) VALUES(?1,?2,1,?3,'manual','manual',?4,?4,'running',?5,?4)",params![identity.occurrence_id,identity.job_id,spec,sql_time(NOW),identity.run_id]).unwrap();
    tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,state) VALUES(?1,?2,1,?3,?4,?4,'running')",params![identity.job_attempt_id,identity.occurrence_id,identity.run_id,sql_time(NOW)]).unwrap();
    tx.execute(
        "UPDATE harness_job_occurrences SET current_job_attempt_id=?2 WHERE id=?1",
        params![identity.occurrence_id, identity.job_attempt_id],
    )
    .unwrap();
    tx.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,'task',1,?2,'assigned')",params![identity.attempt_id,identity.session_id]).unwrap();
    tx.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES(?1,'owner','launch','fixture','create','created',?2,'{}')",params![identity.launch_receipt_id,identity.session_id]).unwrap();
    tx.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES(?1,?2,'launch','shared',?3)",params![identity.attempt_id,identity.launch_receipt_id,sql_time(NOW)]).unwrap();
    job_timeouts::arm(&tx, &identity.run_id, &identity.attempt_id, NOW, ELAPSED).unwrap();
    tx.commit().unwrap();
    (store, identity)
}

pub(super) fn due_fixture() -> (Store, job_timeouts::Claim) {
    let (mut store, _) = armed_fixture(Some(1000));
    let tx = store.0.transaction().unwrap();
    let mut claims = job_timeouts::claims(&tx, 1, NOW + 1000, ELAPSED + 1000).unwrap();
    assert_eq!(claims.len(), 1);
    let claim = claims.pop().unwrap();
    tx.commit().unwrap();
    (store, claim)
}

#[test]
fn legacy_spec_and_current_reads_keep_timeout_opt_in_and_private_clock_fields_hidden() {
    let (store, identity) = armed_fixture(None);
    let source: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_jobs WHERE id=?1",
            [&identity.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: Value = serde_json::from_str(&source).unwrap();
    assert!(value.get("executionTimeoutMs").is_none());
    value["executionTimeoutMs"] = Value::Null;
    let spec: crate::job_definitions::Spec = serde_json::from_value(value).unwrap();
    assert_eq!(
        serde_json::to_string(&spec).unwrap(),
        source,
        "Absent optional policy must retain existing mutation fingerprints"
    );
    assert_eq!(
        job_timeouts::view_current(&store.0, &identity.occurrence_id).unwrap(),
        Value::Null
    );
    let (store, identity) = armed_fixture(Some(1000));
    let view = job_timeouts::view_current(&store.0, &identity.occurrence_id).unwrap();
    assert_eq!(view.as_object().unwrap().len(), 16);
    assert_eq!(view["jobAttemptId"], identity.job_attempt_id);
    assert_eq!(view["executionTimeoutMs"], 1000);
    assert!(view["requestedAt"].is_null());
    assert!(view["controlId"].is_null());
    assert!(!view.to_string().contains("monotonic"));
    assert!(!view.to_string().contains("token"));
    let generation = crate::job_attempts::view(
        &store.0,
        &identity.job_id,
        &identity.occurrence_id,
        Some(&identity.job_attempt_id),
        0,
    )
    .unwrap();
    assert_eq!(generation["jobAttempt"]["executionTimeout"], view);
}

#[test]
fn specification_refuses_invalid_timeout_bounds_and_types() {
    let (mut store, identity) = armed_fixture(None);
    let source: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_jobs WHERE id=?1",
            [&identity.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let source: Value = serde_json::from_str(&source).unwrap();
    for timeout in [json!(-1), json!(1.5), json!("1000"), json!(true)] {
        let mut spec = source.clone();
        spec["executionTimeoutMs"] = timeout;
        assert!(serde_json::from_value::<crate::job_definitions::Spec>(spec).is_err());
    }
    for timeout in [0, 999, 604_800_001] {
        let mut spec = source.clone();
        spec["executionTimeoutMs"] = json!(timeout);
        let request = serde_json::from_value(
            json!({"action":"create","key":format!("invalid-{timeout}"),"spec":spec}),
        )
        .unwrap();
        code(
            crate::job_definitions::execute(
                &mut store.0,
                crate::orchestration::Actor {
                    issuer: "owner".into(),
                    scope: crate::orchestration::Scope::Owner,
                },
                request,
                NOW,
            ),
            "invalid_argument",
        );
    }
}

#[test]
fn deadline_uses_injected_monotonic_time_across_wall_clock_rollback_and_forward_jump() {
    let (mut store, identity) = armed_fixture(Some(1000));
    job_timeouts::guard_run(&store.0, &identity.run_id, NOW + 999_999, ELAPSED + 999).unwrap();
    job_timeouts::guard_report(&store.0, &identity.attempt_id, NOW + 999_999, ELAPSED + 999)
        .unwrap();
    let tx = store.0.transaction().unwrap();
    assert!(
        job_timeouts::claims(&tx, 2, NOW + 999_999, ELAPSED + 999)
            .unwrap()
            .is_empty()
    );
    tx.commit().unwrap();
    code(
        job_timeouts::guard_report(&store.0, &identity.attempt_id, NOW - 60_000, ELAPSED + 1000),
        "job_execution_timeout",
    );
    let tx = store.0.transaction().unwrap();
    let claims = job_timeouts::claims(&tx, 2, NOW - 60_000, ELAPSED + 1000).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].identity, identity);
    assert_eq!(claims[0].deadline_at, NOW + 1000);
    assert!(
        job_timeouts::claims(&tx, 2, NOW + 999_999, ELAPSED + 999_999)
            .unwrap()
            .is_empty()
    );
    let public = job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap();
    assert_eq!(public["armedAt"], NOW);
    assert_eq!(public["deadlineAt"], NOW + 1000);
    assert_eq!(public["requestedAt"], NOW - 60_000);
    assert!(!public.to_string().contains(&claims[0].token));
    tx.commit().unwrap();
}

#[test]
fn report_before_deadline_disarms_but_at_deadline_cannot_write_a_result() {
    let (mut store, identity) = armed_fixture(Some(1000));
    code(
        job_timeouts::guard_report(&store.0, &identity.attempt_id, NOW, ELAPSED + 1000),
        "job_execution_timeout",
    );
    let result: Option<String> = store
        .0
        .query_row(
            "SELECT result FROM workflow_attempts WHERE id=?1",
            [&identity.attempt_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(result.is_none());
    let tx = store.0.transaction().unwrap();
    job_timeouts::guard_report(&tx, &identity.attempt_id, NOW + 999, ELAPSED + 999).unwrap();
    tx.execute(
        "UPDATE workflow_attempts SET state='reported',result=?2 WHERE id=?1",
        params![
            identity.attempt_id,
            super::orchestration_tests::report().to_string()
        ],
    )
    .unwrap();
    job_timeouts::report_accepted(&tx, &identity.attempt_id, NOW + 999).unwrap();
    tx.commit().unwrap();
    let tx = store.0.transaction().unwrap();
    let schedule = job_timeouts::schedule(&tx, 2, NOW + 999_999, ELAPSED + 999_999).unwrap();
    assert!(schedule.claims.is_empty());
    assert!(!schedule.observing);
    assert!(schedule.next_deadline_monotonic_ms.is_none());
    assert_eq!(
        job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap()["reason"],
        "report_accepted"
    );
    job_timeouts::guard_run(&tx, &identity.run_id, NOW + 999_999, ELAPSED + 999_999).unwrap();
    tx.commit().unwrap();
    let (mut store, claim) = due_fixture();
    code(
        job_timeouts::guard_report(&store.0, &claim.identity.attempt_id, NOW, 0),
        "job_execution_timeout",
    );
    let tx = store.0.transaction().unwrap();
    assert!(
        job_timeouts::claims(&tx, 2, NOW + 10_000, ELAPSED + 10_000)
            .unwrap()
            .is_empty()
    );
    tx.commit().unwrap();
}

#[test]
fn accepted_report_replay_survives_timeout_projection_and_retains_validation() {
    let (mut store, identity) = armed_fixture(Some(604_800_000));
    let actor = crate::orchestration::Actor {
        issuer: "worker".into(),
        scope: crate::orchestration::Scope::Worker(identity.session_id.clone()),
    };
    let request=serde_json::from_value(json!({"action":"report","key":"original-result","attemptId":identity.attempt_id,"result":super::orchestration_tests::report()})).unwrap();
    let accepted =
        crate::orchestration::execute_at(&mut store.0, actor.clone(), request, NOW + 1).unwrap();
    let tx = store.0.transaction().unwrap();
    assert!(
        job_timeouts::schedule(&tx, 2, NOW + 604_800_001, ELAPSED + 604_800_001)
            .unwrap()
            .claims
            .is_empty()
    );
    tx.commit().unwrap();
    let request=serde_json::from_value(json!({"action":"report","key":"original-result","attemptId":identity.attempt_id,"result":super::orchestration_tests::report()})).unwrap();
    assert_eq!(
        crate::orchestration::execute_at(&mut store.0, actor, request, NOW + 604_800_001).unwrap(),
        accepted
    );
    let view = job_timeouts::view_current(&store.0, &identity.occurrence_id).unwrap();
    assert_eq!(view["state"], "disarmed");
    assert_eq!(view["reason"], "report_accepted");
    let run = crate::orchestration::execute_at(
        &mut store.0,
        crate::orchestration::Actor {
            issuer: "owner".into(),
            scope: crate::orchestration::Scope::Owner,
        },
        serde_json::from_value(json!({"action":"get","runId":identity.run_id})).unwrap(),
        NOW + 604_800_001,
    )
    .unwrap();
    assert_eq!(run["tasks"][0]["state"], "reported");
    assert_eq!(run["run"]["state"], "active");
}

#[test]
fn accepted_report_projects_its_occurrence_without_waiting_for_a_host_tick() {
    for timeout in [None, Some(604_800_000)] {
        let (mut store, identity) = armed_fixture(timeout);
        let actor = crate::orchestration::Actor {
            issuer: "worker".into(),
            scope: crate::orchestration::Scope::Worker(identity.session_id.clone()),
        };
        let request=serde_json::from_value(json!({"action":"report","key":"projected-result","attemptId":identity.attempt_id,"result":super::orchestration_tests::report()})).unwrap();
        crate::orchestration::execute_at(&mut store.0, actor, request, NOW + 1).unwrap();
        let projected: (String, Option<String>, Option<i64>) = store
            .0
            .query_row(
                "SELECT state,reason,finished_at FROM harness_job_occurrences WHERE id=?1",
                [&identity.occurrence_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            projected,
            (
                "needsValidation".into(),
                Some("validation_pending".into()),
                None
            )
        );
        let attempt: String = store
            .0
            .query_row(
                "SELECT state FROM harness_job_attempts WHERE id=?1",
                [&identity.job_attempt_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt, "needsValidation");
    }
}

#[test]
fn exact_boolean_no_effect_disarms_without_claiming_a_stop_or_resetting_the_deadline() {
    for effect in [Value::Bool(false), json!(0)] {
        let (mut store, identity) = armed_fixture(Some(1000));
        store
            .0
            .execute(
                "UPDATE operation_receipts SET phase='failed',result=?2 WHERE id=?1",
                params![
                    identity.launch_receipt_id,
                    json!({"effectStarted":effect}).to_string()
                ],
            )
            .unwrap();
        let tx = store.0.transaction().unwrap();
        let schedule = job_timeouts::schedule(&tx, 2, NOW + 1000, ELAPSED + 1000).unwrap();
        let view = job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap();
        assert_eq!(view["deadlineAt"], NOW + 1000);
        if effect == Value::Bool(false) {
            assert!(schedule.claims.is_empty());
            assert_eq!(view["state"], "disarmed");
            assert_eq!(view["reason"], "launch_no_effect");
        } else {
            assert_eq!(schedule.claims.len(), 1);
            assert_eq!(view["state"], "dispatching");
        }
        tx.commit().unwrap();
    }
}

#[test]
fn actual_exit_without_result_fails_honestly_before_any_timeout_stop_claim() {
    for observed_at in [NOW + 50, NOW + 2000] {
        let (mut store, identity) = armed_fixture(Some(1000));
        let tx = store.0.transaction().unwrap();
        crate::workflow_controls::observe_exit(&tx, &identity.session_id, observed_at).unwrap();
        let schedule = job_timeouts::schedule(&tx, 2, NOW + 3000, ELAPSED + 3000).unwrap();
        assert!(schedule.claims.is_empty());
        assert!(!schedule.observing);
        let view = job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap();
        assert_eq!(view["state"], "disarmed");
        assert_eq!(view["reason"], "process_exited");
        assert!(view["controlId"].is_null());
        let occurrence = crate::job_definitions::occurrence(
            &tx,
            &identity.job_id,
            &identity.occurrence_id,
            true,
        )
        .unwrap();
        assert_eq!(occurrence["state"], "failed");
        assert_eq!(occurrence["reason"], "worker_exited_without_result");
        let native: (String, Option<String>) = tx
            .query_row(
                "SELECT state,result FROM workflow_attempts WHERE id=?1",
                [&identity.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(native.0, "stopped");
        assert!(native.1.is_none());
        assert_eq!(
            tx.query_row("SELECT count(*) FROM workflow_controls", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        tx.commit().unwrap();
    }
}

#[test]
fn owner_control_disarms_armed_timeout_without_creating_another_control() {
    let (mut store, identity) = armed_fixture(Some(1000));
    store.0.execute("INSERT INTO workflow_controls(id,run_id,kind,issuer,state,created_at) VALUES('owner-control',?1,'stop','owner','blocked',?2)",params![identity.run_id,sql_time(NOW+50)]).unwrap();
    let tx = store.0.transaction().unwrap();
    let schedule = job_timeouts::schedule(&tx, 2, NOW + 1000, ELAPSED + 1000).unwrap();
    assert!(schedule.claims.is_empty());
    let view = job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap();
    assert_eq!(view["state"], "disarmed");
    assert_eq!(view["reason"], "owner_control");
    assert_eq!(
        tx.query_row("SELECT count(*) FROM workflow_controls", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    tx.commit().unwrap();
}

#[test]
fn scheduler_hints_remain_idle_without_timers_and_do_not_spin_with_full_slots() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let tx = store.0.transaction().unwrap();
    let idle = job_timeouts::schedule(&tx, 2, NOW, ELAPSED).unwrap();
    assert!(idle.claims.is_empty());
    assert!(idle.next_deadline_monotonic_ms.is_none());
    assert!(!idle.observing);
    tx.commit().unwrap();
    let (mut store, _) = armed_fixture(Some(1000));
    let before = store.0.total_changes();
    let tx = store.0.transaction().unwrap();
    let future = job_timeouts::schedule(&tx, 2, NOW, ELAPSED).unwrap();
    assert_eq!(future.next_deadline_monotonic_ms, Some(ELAPSED + 1000));
    assert!(!future.observing);
    let full = job_timeouts::schedule(&tx, 0, NOW + 1000, ELAPSED + 1000).unwrap();
    assert!(full.claims.is_empty());
    assert!(full.next_deadline_monotonic_ms.is_none());
    tx.commit().unwrap();
    assert_eq!(
        store.0.total_changes(),
        before,
        "Quiet observations cannot rewrite timer evidence"
    );
}

#[test]
fn restart_invalidates_armed_and_claimed_monotonic_authority_without_rearming() {
    for claimed in [false, true] {
        let (mut store, identity, claim) = if claimed {
            let (store, claim) = due_fixture();
            let identity = claim.identity.clone();
            (store, identity, Some(claim))
        } else {
            let (store, identity) = armed_fixture(Some(1000));
            (store, identity, None)
        };
        crate::job_definitions::recover(&mut store.0, NOW + 10_000).unwrap();
        let tx = store.0.transaction().unwrap();
        let schedule = job_timeouts::schedule(&tx, 2, NOW + 100_000, 0).unwrap();
        assert!(schedule.claims.is_empty());
        assert!(!schedule.observing);
        assert!(schedule.next_deadline_monotonic_ms.is_none());
        let view = job_timeouts::view_current(&tx, &identity.occurrence_id).unwrap();
        assert_eq!(view["state"], "unconfirmed");
        assert_eq!(view["reason"], "host_restarted");
        assert_eq!(view["deadlineAt"], NOW + 1000);
        code(
            job_timeouts::guard_report(&tx, &identity.attempt_id, NOW + 100_000, 0),
            "job_execution_timeout",
        );
        if let Some(claim) = claim {
            code(job_timeouts::guard_claim(&tx, &claim), "stale_job_timeout");
        }
        tx.commit().unwrap();
    }
}

#[test]
fn recovery_honors_exit_committed_before_timeout_projection_without_rearming_cleanup() {
    let (mut store, identity) = armed_fixture(Some(1000));
    let tx = store.0.transaction().unwrap();
    crate::workflow_controls::observe_exit(&tx, &identity.session_id, NOW + 50).unwrap();
    tx.commit().unwrap();
    // Simulate a crash after trusted exit persistence but before any timer poll.
    assert_eq!(
        job_timeouts::view_current(&store.0, &identity.occurrence_id).unwrap()["state"],
        "armed"
    );
    crate::job_definitions::recover(&mut store.0, NOW + 10_000).unwrap();
    let view = job_timeouts::view_current(&store.0, &identity.occurrence_id).unwrap();
    assert_eq!(view["state"], "disarmed");
    assert_eq!(view["reason"], "process_exited");
    assert_eq!(view["deadlineAt"], NOW + 1000);
    assert!(view["requestedAt"].is_null());
    assert!(view["controlId"].is_null());
    let generation = crate::job_attempts::view(
        &store.0,
        &identity.job_id,
        &identity.occurrence_id,
        Some(&identity.job_attempt_id),
        0,
    )
    .unwrap();
    assert_eq!(generation["jobAttempt"]["state"], "failed");
    assert_eq!(
        generation["jobAttempt"]["reason"],
        "worker_exited_without_result"
    );
    let occurrence = crate::job_definitions::occurrence(
        &store.0,
        &identity.job_id,
        &identity.occurrence_id,
        true,
    )
    .unwrap();
    assert_eq!(occurrence["state"], "failed");
    assert_eq!(occurrence["reason"], "worker_exited_without_result");
    assert!(occurrence["finishedAt"].is_u64());
    let tx = store.0.transaction().unwrap();
    let schedule = job_timeouts::schedule(&tx, 2, NOW + 100_000, 0).unwrap();
    assert!(schedule.claims.is_empty());
    assert!(!schedule.observing);
    assert!(schedule.next_deadline_monotonic_ms.is_none());
    assert_eq!(
        tx.query_row("SELECT count(*) FROM workflow_controls", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        tx.query_row(
            "SELECT count(*) FROM operation_receipts WHERE operation='stop'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    tx.commit().unwrap();
    // Terminal evidence releases overlap for separate deliberate owner intent.
    let next = crate::job_definitions::execute(
        &mut store.0,
        crate::orchestration::Actor {
            issuer: "owner".into(),
            scope: crate::orchestration::Scope::Owner,
        },
        serde_json::from_value(json!({
            "action":"runNow", "key":"explicit-after-proven-exit",
            "jobId":identity.job_id, "expectedRevision":1
        }))
        .unwrap(),
        NOW + 10_001,
    )
    .unwrap();
    assert_eq!(next["occurrence"]["state"], "queued");
    assert!(next["occurrence"]["reason"].is_null());
}

#[test]
fn historical_generation_cannot_claim_or_overwrite_a_replacement_occurrence_binding() {
    let (mut store, identity) = armed_fixture(Some(1000));
    let replacement = "a".repeat(32);
    let run = "b".repeat(32);
    store.0.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Replacement','Explicit replacement',1,'active',?2)",params![run,sql_time(NOW+500)]).unwrap();
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,state) VALUES(?1,?2,2,?3,?4,'running')",params![replacement,identity.occurrence_id,run,sql_time(NOW+500)]).unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET current_job_attempt_id=?2,run_id=?3 WHERE id=?1",
            params![identity.occurrence_id, replacement, run],
        )
        .unwrap();
    let tx = store.0.transaction().unwrap();
    assert!(
        job_timeouts::claims(&tx, 2, NOW + 1000, ELAPSED + 1000)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        job_timeouts::view_attempt(&tx, &identity.job_attempt_id).unwrap()["reason"],
        "timeout_target_changed"
    );
    assert!(
        job_timeouts::view_current(&tx, &identity.occurrence_id)
            .unwrap()
            .is_null()
    );
    assert!(!job_timeouts::owns_occurrence(&tx, &identity.occurrence_id).unwrap());
    let occurrence =
        crate::job_definitions::occurrence(&tx, &identity.job_id, &identity.occurrence_id, true)
            .unwrap();
    assert_eq!(occurrence["state"], "running");
    assert_eq!(occurrence["runId"], run);
    tx.commit().unwrap();
}

#[test]
fn lost_dispatch_callback_stays_unconfirmed_until_the_original_stop_receipt_arrives() {
    use crate::workflow_controls::{self, Reply, Work};

    for target_claimed in [false, true] {
        let (mut store, timeout) = due_fixture();
        let Reply::Prepared {
            claim: Some(control),
            ..
        } = workflow_controls::execute(
            &mut store.0,
            Work::PrepareJobTimeout {
                claim: timeout.clone(),
            },
            NOW + 1000,
        )
        .unwrap()
        else {
            panic!("Expected one exact timeout control");
        };
        let mut target = None;
        if target_claimed {
            let Reply::Targets(mut targets) = workflow_controls::execute(
                &mut store.0,
                Work::Claim {
                    claim: control.clone(),
                },
                NOW + 1001,
            )
            .unwrap() else {
                panic!("Expected original target claim");
            };
            assert_eq!(targets.len(), 1);
            target = targets.pop();
        }
        let tx = store.0.transaction().unwrap();
        job_timeouts::finish(&tx, &timeout, None, NOW + 1002).unwrap();
        let view = job_timeouts::view_current(&tx, &timeout.identity.occurrence_id).unwrap();
        assert_eq!(view["state"], "unconfirmed");
        assert_eq!(view["reason"], "timeout_unconfirmed");
        assert_eq!(view["controlId"], control.id);
        let native: (String, Option<String>) = tx
            .query_row(
                "SELECT phase,receipt_id FROM workflow_control_targets WHERE control_id=?1",
                [&control.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            native.0,
            if target_claimed {
                "dispatching"
            } else {
                "pending"
            }
        );
        assert!(native.1.is_none());
        let occurrence = crate::job_definitions::occurrence(
            &tx,
            &timeout.identity.job_id,
            &timeout.identity.occurrence_id,
            true,
        )
        .unwrap();
        assert_eq!(occurrence["state"], "reconcile");
        assert_eq!(occurrence["reason"], "execution_timeout_unconfirmed");
        assert!(occurrence["finishedAt"].is_null());
        let schedule = job_timeouts::schedule(&tx, 2, NOW + 2000, ELAPSED + 2000).unwrap();
        assert!(schedule.claims.is_empty());
        assert!(!schedule.observing);
        code(
            job_timeouts::guard_claim(&tx, &timeout),
            "stale_job_timeout",
        );
        tx.commit().unwrap();

        // Observe a late completion of the same admitted control/receipt path.
        // This does not allocate another timeout/control or dispatch a signal.
        if target.is_none() {
            let Reply::Targets(mut targets) = workflow_controls::execute(
                &mut store.0,
                Work::Claim {
                    claim: control.clone(),
                },
                NOW + 2001,
            )
            .unwrap() else {
                panic!("Expected original target claim");
            };
            assert_eq!(targets.len(), 1);
            target = targets.pop();
        }
        let target = target.unwrap();
        let accepted = crate::receipts::accept(
            &mut store.0,
            &timeout.issuer,
            &target.key,
            "stop",
            json!({"sessionId":target.session_id}),
        )
        .unwrap();
        assert!(accepted.is_new);
        let native = crate::receipts::claim(&mut store.0, &accepted.receipt.id, &timeout.issuer)
            .unwrap()
            .unwrap();
        let receipt = crate::receipts::finish(
            &mut store.0,
            &native.receipt.id,
            &timeout.issuer,
            &native.token,
            "stopRequested",
            json!({"nativeStopRequested":true,"processExited":null,"taskResult":null}),
        )
        .unwrap();
        workflow_controls::execute(
            &mut store.0,
            Work::Finish {
                claim: control,
                session_id: target.session_id,
                receipt: Some(receipt),
            },
            NOW + 2002,
        )
        .unwrap();
        let tx = store.0.transaction().unwrap();
        let schedule = job_timeouts::schedule(&tx, 2, NOW + 2003, ELAPSED + 2003).unwrap();
        assert!(schedule.claims.is_empty());
        assert!(schedule.observing);
        let view = job_timeouts::view_current(&tx, &timeout.identity.occurrence_id).unwrap();
        assert_eq!(view["state"], "awaitingExit");
        assert_eq!(view["reason"], "timeout_pending");
        assert_eq!(
            tx.query_row("SELECT count(*) FROM workflow_controls", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            tx.query_row(
                "SELECT count(*) FROM operation_receipts WHERE operation='stop'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        tx.commit().unwrap();
    }
}
