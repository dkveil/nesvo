use super::{Store, job_timeouts_tests::due_fixture};
use crate::{
    job_timeouts,
    operations::ControlAction,
    orchestration::{Actor, Scope},
    workflow_controls::{self, Claim, Reply, Work},
};
use rusqlite::params;
use serde_json::{Value, json};

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

fn prepare(store: &mut Store, timeout: &job_timeouts::Claim) -> Reply {
    workflow_controls::execute(
        &mut store.0,
        Work::PrepareJobTimeout {
            claim: timeout.clone(),
        },
        timeout.deadline_at,
    )
    .unwrap()
}

fn inspect(store: &mut Store, timeout: &job_timeouts::Claim, control: &str) -> Value {
    let Reply::View(view) = workflow_controls::execute(
        &mut store.0,
        Work::Read {
            actor: owner(),
            run_id: timeout.identity.run_id.clone(),
            control_id: control.into(),
            offset: 0,
        },
        timeout.deadline_at + 1,
    )
    .unwrap() else {
        panic!("Expected control observation");
    };
    view
}

fn control_count(store: &Store) -> i64 {
    store
        .0
        .query_row("SELECT count(*) FROM workflow_controls", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn add_unrelated_attempt(store: &Store, timeout: &job_timeouts::Claim) {
    store.0.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES('other-task',?1,'other',?2)",params![timeout.identity.run_id,json!({"key":"other","title":"Other","instruction":"Must not be marked stopped","dependencies":[]}).to_string()]).unwrap();
    store.0.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('other-attempt','other-task',1,'other-session','assigned')",[]).unwrap();
}

fn owner_control(store: &mut Store, timeout: &job_timeouts::Claim) -> (String, Claim) {
    let revision: i64 = store
        .0
        .query_row(
            "SELECT revision FROM workflow_runs WHERE id=?1",
            [&timeout.identity.run_id],
            |row| row.get(0),
        )
        .unwrap();
    let Reply::Prepared { view, claim } = workflow_controls::execute(
        &mut store.0,
        Work::Prepare {
            actor: owner(),
            request: workflow_controls::Request::Start {
                key: "explicit-owner-control".into(),
                run_id: timeout.identity.run_id.clone(),
                expected_revision: u64::try_from(revision).unwrap(),
                kind: workflow_controls::Kind::Stop,
            },
        },
        timeout.deadline_at,
    )
    .unwrap() else {
        panic!("Expected owner control");
    };
    (
        view["control"]["id"].as_str().unwrap().into(),
        claim.unwrap(),
    )
}

#[test]
fn timeout_control_is_exact_replayable_and_settles_only_after_exit_evidence() {
    let (mut store, timeout) = due_fixture();
    let Reply::Prepared {
        view,
        claim: Some(claim),
    } = prepare(&mut store, &timeout)
    else {
        panic!("Expected one automatic control claim");
    };
    let control = view["control"]["id"].as_str().unwrap().to_owned();
    assert_eq!(view["targets"].as_array().unwrap().len(), 1);
    assert_eq!(view["targets"][0]["attemptId"], timeout.identity.attempt_id);
    assert_eq!(view["targets"][0]["sessionId"], timeout.identity.session_id);
    let Reply::Prepared {
        view: replay,
        claim: None,
    } = prepare(&mut store, &timeout)
    else {
        panic!("Existing control must not dispatch again");
    };
    assert_eq!(replay["control"]["id"], control);
    assert_eq!(control_count(&store), 1);
    let Reply::Targets(mut targets) = workflow_controls::execute(
        &mut store.0,
        Work::Claim {
            claim: claim.clone(),
        },
        timeout.deadline_at,
    )
    .unwrap() else {
        panic!("Expected exact target");
    };
    assert_eq!(targets.len(), 1);
    let target = targets.pop().unwrap();
    let native = crate::receipts::accept(
        &mut store.0,
        &timeout.issuer,
        &target.key,
        "stop",
        json!({"sessionId":target.session_id}),
    )
    .unwrap();
    let native_claim = crate::receipts::claim(&mut store.0, &native.receipt.id, &timeout.issuer)
        .unwrap()
        .unwrap();
    let receipt = crate::receipts::finish(
        &mut store.0,
        &native.receipt.id,
        &timeout.issuer,
        &native_claim.token,
        "stopRequested",
        json!({"nativeStopRequested":true,"processExited":null,"taskResult":null}),
    )
    .unwrap();
    workflow_controls::execute(
        &mut store.0,
        Work::Finish {
            claim: claim.clone(),
            session_id: target.session_id.clone(),
            receipt: Some(receipt),
        },
        timeout.deadline_at,
    )
    .unwrap();
    let Reply::Targets(empty) =
        workflow_controls::execute(&mut store.0, Work::Claim { claim }, timeout.deadline_at)
            .unwrap()
    else {
        panic!("Expected consumed native claim");
    };
    assert!(empty.is_empty());
    let pending = inspect(&mut store, &timeout, &control);
    assert_eq!(pending["control"]["state"], "awaitingExit");
    let tx = store.0.transaction().unwrap();
    job_timeouts::finish(&tx, &timeout, Some(pending), timeout.deadline_at + 1).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        job_timeouts::view_attempt(&store.0, &timeout.identity.job_attempt_id).unwrap()["state"],
        "awaitingExit"
    );

    add_unrelated_attempt(&store, &timeout);
    workflow_controls::execute(
        &mut store.0,
        Work::Observe {
            actor: owner(),
            run_id: timeout.identity.run_id.clone(),
            control_id: control.clone(),
            exited: vec![timeout.identity.session_id.clone()],
            unavailable: vec![],
        },
        timeout.deadline_at + 2,
    )
    .unwrap();
    let tx = store.0.transaction().unwrap();
    job_timeouts::refresh(&tx, timeout.deadline_at + 2).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        inspect(&mut store, &timeout, &control)["control"]["state"],
        "completed"
    );
    let unaffected: String = store
        .0
        .query_row(
            "SELECT state FROM workflow_attempts WHERE id='other-attempt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unaffected, "assigned");
    let native_state: String = store
        .0
        .query_row(
            "SELECT state FROM workflow_attempts WHERE id=?1",
            [&timeout.identity.attempt_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_state, "stopped");
    let observation =
        job_timeouts::view_attempt(&store.0, &timeout.identity.job_attempt_id).unwrap();
    assert_eq!(observation["state"], "completed");
    let (state, reason): (String, String) = store
        .0
        .query_row(
            "SELECT state,reason FROM harness_job_occurrences WHERE id=?1",
            [&timeout.identity.occurrence_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (state.as_str(), reason.as_str()),
        ("failed", "execution_timeout")
    );
}

#[test]
fn timeout_reuses_an_exact_owner_control_without_claiming_its_effect() {
    let (mut store, timeout) = due_fixture();
    let (id, owner_claim) = owner_control(&mut store, &timeout);
    let Reply::Prepared { view, claim: None } = prepare(&mut store, &timeout) else {
        panic!("Owner control must be observed without dispatch");
    };
    assert_eq!(view["control"]["id"], id);
    assert_eq!(control_count(&store), 1);
    let retained: String = store
        .0
        .query_row(
            "SELECT token FROM workflow_controls WHERE id=?1",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, owner_claim.token);
    assert_eq!(
        job_timeouts::view_attempt(&store.0, &timeout.identity.job_attempt_id).unwrap()["controlId"],
        id
    );
}

#[test]
fn timeout_blocks_a_broader_owner_control_and_refuses_stale_native_identity() {
    let (mut store, timeout) = due_fixture();
    let mut stale = timeout.clone();
    stale.identity.session_id = "9".repeat(32);
    let error = workflow_controls::execute(
        &mut store.0,
        Work::PrepareJobTimeout { claim: stale },
        timeout.deadline_at,
    )
    .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "stale_job_timeout"
    );
    assert_eq!(control_count(&store), 0);
    add_unrelated_attempt(&store, &timeout);
    let (_, owner_claim) = owner_control(&mut store, &timeout);
    assert!(matches!(prepare(&mut store, &timeout), Reply::Done));
    assert_eq!(control_count(&store), 1);
    let tx = store.0.transaction().unwrap();
    job_timeouts::finish(&tx, &timeout, None, timeout.deadline_at + 1).unwrap();
    tx.commit().unwrap();
    let observed = job_timeouts::view_attempt(&store.0, &timeout.identity.job_attempt_id).unwrap();
    assert_eq!(observed["state"], "blocked");
    assert_eq!(observed["reason"], "existing_control_conflict");
    let retained: String = store
        .0
        .query_row(
            "SELECT token FROM workflow_controls WHERE id=?1",
            [owner_claim.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, owner_claim.token);
}

#[test]
fn automatic_timeout_protects_active_leases_retained_drafts_and_released_takeovers() {
    for (leased, dirty, epoch) in [(true, false, 0), (false, true, 0), (false, false, 1)] {
        let error = ControlAction::StopJobTimeoutWorker
            .check_human_priority(true, leased, dirty, epoch)
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "control_busy"
        );
    }
    assert!(
        ControlAction::StopJobTimeoutWorker
            .check_human_priority(true, false, false, 0)
            .is_ok()
    );
}

#[test]
fn explicit_owner_control_retains_its_existing_released_takeover_behavior() {
    for action in [
        ControlAction::Stop,
        ControlAction::StopRunWorker,
        ControlAction::Interrupt,
    ] {
        assert!(action.check_human_priority(true, false, false, 8).is_ok());
        assert!(action.check_human_priority(true, true, false, 0).is_err());
    }
    assert!(
        ControlAction::StopRunWorker
            .check_human_priority(true, false, true, 0)
            .is_err()
    );
    assert!(
        ControlAction::Stop
            .check_human_priority(true, false, true, 0)
            .is_ok()
    );
}

#[test]
fn observed_exit_can_be_reconciled_after_human_takeover_without_authorizing_a_live_stop() {
    assert!(
        ControlAction::StopJobTimeoutWorker
            .check_human_priority(false, false, true, 8)
            .is_ok()
    );
    assert!(
        ControlAction::StopJobTimeoutWorker
            .check_human_priority(true, false, true, 8)
            .is_err()
    );
}
