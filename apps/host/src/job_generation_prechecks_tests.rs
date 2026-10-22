use super::Store;
use crate::{
    job_attempts::{self, Dispatch},
    job_cancellations, job_definitions,
    job_definitions::Reply,
    job_precheck_records as records,
    job_prechecks::{self, Outcome, OutcomeState},
    orchestration::{Actor, Scope},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn store() -> Store {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    records::initialize(&store.0).unwrap();
    store
}

fn command() -> job_prechecks::Command {
    serde_json::from_value(json!({
        "title":"Generation command",
        "executable":if cfg!(windows){"C:/tools/check.exe"}else{"/usr/bin/check"},
        "arguments":["literal command"],
        "cwd":if cfg!(windows){"C:/workspace"}else{"/workspace"}
    }))
    .unwrap()
}

fn seed(store: &mut Store, occurrence: &str) -> Dispatch {
    let command = command();
    let spec = json!({"title":"Generation fixture","instruction":"Metadata only","profile":{"program":"claude","workspace":"shared"},"precheckId":"approval","schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}});
    store.0.execute("INSERT OR IGNORE INTO harness_precheck_approvals(id,spec,digest,revision,enabled,created_at) VALUES('approval',?1,?2,1,1,?3)",params![serde_json::to_string(&command).unwrap(),job_prechecks::digest(&command).unwrap(),NOW as i64]).unwrap();
    store.0.execute("INSERT INTO harness_jobs(id,spec,revision,enabled,next_due,created_at) VALUES(?1,?2,1,0,NULL,?3)",params![occurrence,spec.to_string(),NOW as i64]).unwrap();
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,started_at) VALUES(?1,?1,1,?2,?1,'manual',?3,?3,'dispatching',?3)",params![occurrence,spec.to_string(),NOW as i64]).unwrap();
    let tx = store.0.transaction().unwrap();
    let dispatch = job_attempts::claim(&tx, occurrence, NOW).unwrap();
    tx.commit().unwrap();
    dispatch
}

fn next_generation(store: &mut Store, previous: &Dispatch) -> Dispatch {
    let tx = store.0.transaction().unwrap();
    let ordinal: i64 = tx
        .query_row(
            "SELECT ordinal+1 FROM harness_job_attempts WHERE id=?1",
            [&previous.attempt],
            |row| row.get(0),
        )
        .unwrap();
    let dispatch = Dispatch {
        occurrence: previous.occurrence.clone(),
        attempt: format!("{}-generation-{ordinal}", previous.occurrence),
        token: format!("{}-token-{ordinal}", previous.occurrence),
    };
    tx.execute("UPDATE harness_job_attempts SET state='failed',reason='fixture_launch_no_effect',finished_at=?2,dispatch_token=NULL WHERE id=?1",params![previous.attempt,(NOW+3) as i64]).unwrap();
    tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,claimed_at,state,dispatch_token) VALUES(?1,?2,?3,?4,?4,'dispatching',?5)",params![dispatch.attempt,dispatch.occurrence,ordinal,(NOW+10) as i64,dispatch.token]).unwrap();
    tx.execute("UPDATE harness_job_occurrences SET current_job_attempt_id=?2,state='dispatching',reason=NULL,finished_at=NULL,run_id=NULL WHERE id=?1",params![dispatch.occurrence,dispatch.attempt]).unwrap();
    tx.commit().unwrap();
    dispatch
}

fn begin(store: &mut Store, dispatch: &Dispatch, now: u64) -> anyhow::Result<Reply> {
    let tx = store.0.transaction().unwrap();
    let reply = records::begin_attempt(&tx, dispatch, now)?;
    tx.commit().unwrap();
    Ok(reply)
}

fn outcome(state: OutcomeState, output: &str) -> Outcome {
    Outcome {
        state,
        reason: "fixture_exit".into(),
        exit_code: Some(0),
        stdout: output.into(),
        stderr: "retained stderr".into(),
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 1,
        cleanup_confirmed: true,
        command_started: Some(true),
    }
}

fn finish(
    store: &mut Store,
    dispatch: &Dispatch,
    result: Outcome,
    now: u64,
) -> anyhow::Result<bool> {
    let tx = store.0.transaction().unwrap();
    let (passed, state, reason) = records::finish_attempt(&tx, dispatch, result, now)?;
    job_definitions::transition(
        &tx,
        &dispatch.occurrence,
        state,
        reason,
        !passed && state != "reconcile",
        now,
    )?;
    tx.commit().unwrap();
    Ok(passed)
}

fn view(store: &Store, dispatch: &Dispatch) -> Value {
    records::view_attempt(&store.0, &dispatch.occurrence, &dispatch.attempt, true).unwrap()
}

fn events(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT count(*) FROM domain_events", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn each_generation_requires_a_new_authorization_and_keeps_its_own_outcome() {
    let mut store = store();
    let first = seed(&mut store, "fresh");
    assert!(matches!(
        begin(&mut store, &first, NOW + 1).unwrap(),
        Reply::Precheck(Some(_))
    ));
    assert!(
        finish(
            &mut store,
            &first,
            outcome(OutcomeState::Passed, "first"),
            NOW + 2
        )
        .unwrap()
    );
    let old = view(&store, &first);
    assert!(old.get("approvalRevision").is_none());
    assert!(records::passed_current(&store.0, &first.occurrence).unwrap());

    let second = next_generation(&mut store, &first);
    assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
    assert!(
        records::view_current(&store.0, &second.occurrence, true)
            .unwrap()
            .is_null()
    );
    let wrong_token = Dispatch {
        token: "old-or-forged-token".into(),
        ..second.clone()
    };
    assert!(begin(&mut store, &wrong_token, NOW + 11).is_err());
    assert!(begin(&mut store, &first, NOW + 11).is_err());
    assert!(
        finish(
            &mut store,
            &first,
            outcome(OutcomeState::Passed, "stale"),
            NOW + 11
        )
        .is_err()
    );
    assert!(matches!(
        begin(&mut store, &second, NOW + 11).unwrap(),
        Reply::Precheck(Some(_))
    ));
    assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
    assert!(begin(&mut store, &second, NOW + 12).is_err());
    assert!(
        finish(
            &mut store,
            &wrong_token,
            outcome(OutcomeState::Passed, "wrong token"),
            NOW + 12
        )
        .is_err()
    );
    assert!(
        finish(
            &mut store,
            &second,
            outcome(OutcomeState::Passed, "second"),
            NOW + 13
        )
        .unwrap()
    );
    assert!(records::passed_current(&store.0, &second.occurrence).unwrap());
    assert_eq!(view(&store, &first), old);
    let current = view(&store, &second);
    assert_eq!(current["approvalRevision"], 1);
    assert_eq!(current["authorizedAt"], NOW + 11);
    assert_eq!(current["result"]["stdout"], "second");
    assert_ne!(current["authorizedAt"], old["authorizedAt"]);
    assert!(
        finish(
            &mut store,
            &second,
            outcome(OutcomeState::Passed, "duplicate"),
            NOW + 14
        )
        .is_err()
    );

    let retained_events = events(&store.0);
    for _ in 0..3 {
        assert_eq!(
            records::view_current(&store.0, &second.occurrence, true).unwrap(),
            current
        );
        assert_eq!(view(&store, &first), old);
        assert!(records::passed_current(&store.0, &second.occurrence).unwrap());
    }
    assert_eq!(events(&store.0), retained_events);
    let summary = records::view_current(&store.0, &second.occurrence, false).unwrap();
    assert!(summary["result"].get("stdout").is_none());
    assert!(summary["result"].get("stderr").is_none());
    assert_eq!(view(&store, &second), current);
}

#[test]
fn revocation_and_noncanonical_approval_are_checked_again_before_fresh_begin() {
    for revoke in [true, false] {
        let mut store = store();
        let first = seed(&mut store, "revoked");
        begin(&mut store, &first, NOW + 1).unwrap();
        finish(
            &mut store,
            &first,
            outcome(OutcomeState::Passed, "first"),
            NOW + 2,
        )
        .unwrap();
        let old = view(&store, &first);
        let second = next_generation(&mut store, &first);
        assert!(records::approval_ready(&store.0, "approval").unwrap());
        if revoke {
            store.0.execute("UPDATE harness_precheck_approvals SET enabled=0,revision=2 WHERE id='approval'",[]).unwrap();
        } else {
            store
                .0
                .execute(
                    "UPDATE harness_precheck_approvals SET digest='different' WHERE id='approval'",
                    [],
                )
                .unwrap();
        }
        assert!(!records::approval_ready(&store.0, "approval").unwrap());
        assert!(matches!(
            begin(&mut store, &second, NOW + 11).unwrap(),
            Reply::PrecheckPassed(false)
        ));
        assert_eq!(view(&store, &second)["state"], "refused");
        assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
        assert_eq!(view(&store, &first), old);
        assert!(begin(&mut store, &second, NOW + 12).is_err());
    }
}

#[test]
fn completed_authorization_survives_revocation_and_bool_evidence_is_required() {
    let mut store = store();
    let first = seed(&mut store, "evidence");
    begin(&mut store, &first, NOW + 1).unwrap();
    finish(
        &mut store,
        &first,
        outcome(OutcomeState::Passed, "first"),
        NOW + 2,
    )
    .unwrap();
    let second = next_generation(&mut store, &first);
    begin(&mut store, &second, NOW + 11).unwrap();
    store
        .0
        .execute(
            "UPDATE harness_precheck_approvals SET enabled=0,revision=2 WHERE id='approval'",
            [],
        )
        .unwrap();
    assert!(
        finish(
            &mut store,
            &second,
            outcome(OutcomeState::Passed, "second"),
            NOW + 12
        )
        .unwrap()
    );
    assert!(records::passed_current(&store.0, &second.occurrence).unwrap());
    let original = view(&store, &second)["result"].clone();
    store
        .0
        .execute(
            "UPDATE harness_job_generation_prechecks SET finished_at=NULL WHERE job_attempt_id=?1",
            [&second.attempt],
        )
        .unwrap();
    assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
    store
        .0
        .execute(
            "UPDATE harness_job_generation_prechecks SET finished_at=?2 WHERE job_attempt_id=?1",
            params![second.attempt, (NOW + 12) as i64],
        )
        .unwrap();
    for (key, forged) in [
        ("commandStarted", Value::Null),
        ("commandStarted", json!("true")),
        ("cleanupConfirmed", json!(1)),
        ("state", json!("failed")),
    ] {
        let mut result = original.clone();
        result[key] = forged;
        store
            .0
            .execute(
                "UPDATE harness_job_generation_prechecks SET result=?2 WHERE job_attempt_id=?1",
                params![second.attempt, result.to_string()],
            )
            .unwrap();
        assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
    }
    store.0.execute("UPDATE harness_job_generation_prechecks SET result=?2,spec='{}' WHERE job_attempt_id=?1",params![second.attempt,original.to_string()]).unwrap();
    assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
}

#[test]
fn identical_command_digests_still_require_exact_current_abandonment_identity() {
    let mut store = store();
    let first = seed(&mut store, "abandon");
    begin(&mut store, &first, NOW + 1).unwrap();
    finish(
        &mut store,
        &first,
        outcome(OutcomeState::Passed, "first"),
        NOW + 2,
    )
    .unwrap();
    let old = view(&store, &first);
    let second = next_generation(&mut store, &first);
    begin(&mut store, &second, NOW + 11).unwrap();
    let mut unknown = outcome(OutcomeState::Passed, "uncertain second");
    unknown.cleanup_confirmed = false;
    assert!(!finish(&mut store, &second, unknown, NOW + 12).unwrap());
    let digest = job_prechecks::digest(&command()).unwrap();
    for attempt in [None, Some(first.attempt.as_str())] {
        let tx = store.0.transaction().unwrap();
        assert!(records::abandon(&tx, &second.occurrence, attempt, &digest, NOW + 13).is_err());
    }
    {
        let tx = store.0.transaction().unwrap();
        assert!(
            records::abandon(
                &tx,
                &second.occurrence,
                Some(&second.attempt),
                "wrong",
                NOW + 13
            )
            .is_err()
        );
    }
    {
        let tx = store.0.transaction().unwrap();
        records::abandon(
            &tx,
            &second.occurrence,
            Some(&second.attempt),
            &digest,
            NOW + 13,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(view(&store, &second)["state"], "abandoned");
    assert!(view(&store, &second)["finishedAt"].is_null());
    assert_eq!(view(&store, &first), old);
}

#[test]
fn cancellation_waits_for_exact_second_command_cleanup_and_rejects_old_callback() {
    for confirmed in [true, false] {
        let mut store = store();
        let first = seed(&mut store, "cancel");
        begin(&mut store, &first, NOW + 1).unwrap();
        finish(
            &mut store,
            &first,
            outcome(OutcomeState::Passed, "first"),
            NOW + 2,
        )
        .unwrap();
        let old = view(&store, &first);
        let second = next_generation(&mut store, &first);
        begin(&mut store, &second, NOW + 11).unwrap();
        {
            let tx = store.0.transaction().unwrap();
            job_cancellations::accept(
                &tx,
                &Actor {
                    issuer: "owner".into(),
                    scope: Scope::Owner,
                },
                &second.occurrence,
                &second.occurrence,
                NOW + 12,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            job_cancellations::view(&store.0, &second.occurrence).unwrap()["state"],
            "awaitingPrecheck"
        );
        assert!(
            finish(
                &mut store,
                &first,
                outcome(OutcomeState::Passed, "old callback"),
                NOW + 13
            )
            .is_err()
        );
        assert_eq!(
            job_cancellations::view(&store.0, &second.occurrence).unwrap()["state"],
            "awaitingPrecheck"
        );
        let mut result = outcome(OutcomeState::Passed, "second");
        result.cleanup_confirmed = confirmed;
        assert!(!finish(&mut store, &second, result, NOW + 14).unwrap());
        assert_eq!(
            job_cancellations::view(&store.0, &second.occurrence).unwrap()["state"],
            if confirmed {
                "completed"
            } else {
                "unconfirmed"
            }
        );
        assert_eq!(view(&store, &first), old);
    }
}

#[test]
fn rollback_and_recovery_preserve_first_command_and_do_not_rearm_second() {
    let mut store = store();
    let first = seed(&mut store, "recover");
    begin(&mut store, &first, NOW + 1).unwrap();
    finish(
        &mut store,
        &first,
        outcome(OutcomeState::Passed, "first"),
        NOW + 2,
    )
    .unwrap();
    let old = view(&store, &first);
    let second = next_generation(&mut store, &first);
    let retained_events = events(&store.0);
    {
        let tx = store.0.transaction().unwrap();
        records::begin_attempt(&tx, &second, NOW + 11).unwrap();
    }
    assert!(view(&store, &second).is_null());
    assert_eq!(events(&store.0), retained_events);
    begin(&mut store, &second, NOW + 12).unwrap();
    {
        let tx = store.0.transaction().unwrap();
        records::finish_attempt(
            &tx,
            &second,
            outcome(OutcomeState::Passed, "rolled back"),
            NOW + 13,
        )
        .unwrap();
    }
    assert_eq!(view(&store, &second)["state"], "running");
    job_definitions::recover(&mut store.0, NOW + 14).unwrap();
    let unknown = view(&store, &second);
    assert_eq!(unknown["state"], "unknown");
    assert_eq!(unknown["reason"], "host_restarted");
    assert!(unknown["finishedAt"].is_null());
    assert_eq!(view(&store, &first), old);
    assert!(begin(&mut store, &second, NOW + 15).is_err());
    assert!(
        finish(
            &mut store,
            &second,
            outcome(OutcomeState::Passed, "late"),
            NOW + 15
        )
        .is_err()
    );
    job_definitions::recover(&mut store.0, NOW + 16).unwrap();
    assert_eq!(view(&store, &second), unknown);
    assert_eq!(view(&store, &first), old);
}

#[test]
fn disk_reopen_keeps_generation_history_and_legacy_acceptance_bytes() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-job-generation-prechecks-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let accepted = "{\n  \"occurrence\": {\"id\":\"reopen\",\"state\":\"queued\"}\n}";
    let (first, second, old);
    {
        let mut store = Store::open(&path).unwrap();
        records::initialize(&store.0).unwrap();
        first = seed(&mut store, "reopen");
        begin(&mut store, &first, NOW + 1).unwrap();
        finish(
            &mut store,
            &first,
            outcome(OutcomeState::Passed, "first disk output"),
            NOW + 2,
        )
        .unwrap();
        old = view(&store, &first);
        second = next_generation(&mut store, &first);
        begin(&mut store, &second, NOW + 11).unwrap();
        store.0.execute("INSERT INTO harness_job_mutations(issuer,key,digest,view) VALUES('owner','legacy-precheck','legacy-digest',?1)",[accepted]).unwrap();
    }
    let unknown;
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(view(&store, &first), old);
        unknown = view(&store, &second);
        assert_eq!(unknown["state"], "unknown");
        assert!(!records::passed_current(&store.0, &second.occurrence).unwrap());
        assert!(job_attempts::guard(&store.0, &second, &["prechecking"]).is_err());
        let retained_events = events(&store.0);
        assert_eq!(
            records::view_current(&store.0, &second.occurrence, true).unwrap(),
            unknown
        );
        assert_eq!(events(&store.0), retained_events);
        let saved: String = store.0.query_row("SELECT view FROM harness_job_mutations WHERE issuer='owner' AND key='legacy-precheck'",[],|row|row.get(0)).unwrap();
        assert_eq!(saved, accepted);
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(view(&store, &first), old);
        assert_eq!(view(&store, &second), unknown);
    }
    std::fs::remove_file(path).unwrap();
}
