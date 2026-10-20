use super::Store;
use crate::{
    quota_wakes::{self, Arm, Dispatch, Reply, Work},
    sessions::session_quota::WakeProof,
};
use rusqlite::{Connection, params};
use serde_json::json;
use std::{sync::Arc, time::Duration};

fn arm(number: u64) -> Arm {
    Arm {
        id: format!("{number:032x}"),
        session_id: format!("session-{number}"),
        launch_id: "a".repeat(32),
        generation: 1,
        human_epoch: 5,
        predecessor_id: None,
        proof: WakeProof {
            reader_id: "b".repeat(32),
            context_id: "c".repeat(64),
            account_fingerprint: "d".repeat(64),
            revision: 7,
            read_started_elapsed_ms: 100,
            reset_at: 1_800_000_000,
            reset_elapsed_ms: 1100,
        },
    }
}

fn store() -> Store {
    Store::open(std::path::Path::new(":memory:")).unwrap()
}

#[test]
fn late_pause_of_an_old_arm_cannot_pause_its_replacement() {
    let mut store = store();
    let first = arm(1);
    armed(&mut store.0, &first);
    quota_wakes::handle(&mut store.0, Work::Disable(first.session_id.clone())).unwrap();
    let mut replacement = arm(2);
    replacement.session_id = first.session_id.clone();
    armed(&mut store.0, &replacement);
    quota_wakes::handle(
        &mut store.0,
        Work::Pause {
            id: first.id,
            reason: "quota_context_changed",
        },
    )
    .unwrap();
    let latest = quota_wakes::current(&store.0, &replacement.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(latest.arm.id, replacement.id);
    assert_eq!(latest.phase, "armed");
    assert!(claimed(&mut store.0, &replacement).is_some());
}

fn armed(connection: &mut Connection, value: &Arm) -> quota_wakes::View {
    let Reply::Armed(view) = quota_wakes::handle(connection, Work::Arm(value.clone())).unwrap()
    else {
        panic!("Expected arm reply");
    };
    view
}

fn claimed(connection: &mut Connection, value: &Arm) -> Option<Dispatch> {
    let Reply::Claimed(dispatch) = quota_wakes::handle(
        connection,
        Work::Claim {
            id: value.id.clone(),
            expected: value.clone(),
        },
    )
    .unwrap() else {
        panic!("Expected claim reply");
    };
    dispatch
}

fn count(connection: &Connection, table: &str) -> i64 {
    let query = match table {
        "arms" => "SELECT count(*) FROM quota_wake_arms",
        "receipts" => "SELECT count(*) FROM operation_receipts WHERE issuer='quota-wake'",
        _ => panic!("Unknown fixture count"),
    };
    connection.query_row(query, [], |row| row.get(0)).unwrap()
}

fn code<T>(value: anyhow::Result<T>, expected: &str) {
    let Err(error) = value else {
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

#[test]
fn arm_is_immutable_and_one_claim_atomically_retains_fixed_send_and_predecessor() {
    let mut store = store();
    let mut value = arm(1);
    let predecessor = crate::receipts::accept(
        &mut store.0,
        "owner",
        "original-send",
        "send",
        json!({"sessionId":value.session_id,"prompt":"An original instruction is private"}),
    )
    .unwrap();
    value.predecessor_id = Some(predecessor.receipt.id.clone());
    let view = armed(&mut store.0, &value);
    assert_eq!(view.phase, "armed");
    assert!(view.receipt.is_none());
    assert_eq!(count(&store.0, "receipts"), 0);

    let dispatch = claimed(&mut store.0, &value).unwrap();
    assert_eq!(dispatch.receipt.operation, "send");
    assert_eq!(dispatch.receipt.phase, "accepted");
    assert_eq!(dispatch.receipt.session_id, value.session_id);
    assert_eq!(dispatch.receipt.result["quotaWakeId"], value.id);
    assert_eq!(
        dispatch.receipt.result["predecessorId"],
        predecessor.receipt.id
    );
    let request = json!({"sessionId":value.session_id,"prompt":quota_wakes::PROMPT,
        "quotaWakeId":value.id,"predecessorId":value.predecessor_id});
    let expected_digest = hex::encode(
        ring::digest::digest(
            &ring::digest::SHA256,
            &serde_json::to_vec(&request).unwrap(),
        )
        .as_ref(),
    );
    let (issuer, key, digest): (String, String, String) = store
        .0
        .query_row(
            "SELECT issuer,key,digest FROM operation_receipts WHERE id=?1",
            [&dispatch.receipt.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(issuer, quota_wakes::ISSUER);
    assert_eq!(key, format!("quota-wake:{}", value.id));
    assert_eq!(digest, expected_digest);
    assert_eq!(quota_wakes::PROMPT, "Continue the previous task.");
    assert!(claimed(&mut store.0, &value).is_none());
    let replay = armed(&mut store.0, &value);
    assert_eq!(replay.phase, "dispatching");
    assert_eq!(replay.receipt.unwrap().id, dispatch.receipt.id);
    assert_eq!(count(&store.0, "receipts"), 1);
    let guarded = quota_wakes::guard_dispatch(&store.0, &value.session_id, &dispatch.receipt.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(guarded).unwrap(),
        request_binding(&value)
    );

    let public = quota_wakes::current(&store.0, &value.session_id)
        .unwrap()
        .unwrap()
        .public();
    assert_eq!(public["source"]["revision"], 7);
    assert_eq!(public["operationId"], dispatch.receipt.id);
    assert_eq!(public["predecessorId"], predecessor.receipt.id);
    let encoded = public.to_string();
    for private in [
        "humanEpoch",
        "resetElapsedMs",
        "readStartedElapsedMs",
        "prompt",
        "An original instruction is private",
    ] {
        assert!(!encoded.contains(private));
    }
}

fn request_binding(value: &Arm) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn every_frozen_binding_field_is_checked_before_receipt_acceptance() {
    let mut store = store();
    let value = arm(2);
    armed(&mut store.0, &value);
    let mut variants = Vec::new();
    let mut changed = value.clone();
    changed.session_id = "another-session".into();
    variants.push(changed);
    let mut changed = value.clone();
    changed.launch_id = "e".repeat(32);
    variants.push(changed);
    let mut changed = value.clone();
    changed.generation += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.human_epoch += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.predecessor_id = Some("f".repeat(32));
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.reader_id = "e".repeat(32);
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.context_id = "e".repeat(64);
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.account_fingerprint = "e".repeat(64);
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.revision += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.read_started_elapsed_ms += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.reset_at += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.proof.reset_elapsed_ms += 1;
    variants.push(changed);
    let mut changed = value.clone();
    changed.id = "e".repeat(32);
    variants.push(changed);
    for expected in variants {
        assert!(matches!(
            quota_wakes::handle(
                &mut store.0,
                Work::Claim {
                    id: value.id.clone(),
                    expected
                }
            )
            .unwrap(),
            Reply::Claimed(None)
        ));
    }
    assert_eq!(count(&store.0, "receipts"), 0);
    assert_eq!(
        quota_wakes::current(&store.0, &value.session_id)
            .unwrap()
            .unwrap()
            .phase,
        "armed"
    );
    assert!(claimed(&mut store.0, &value).is_some());
}

#[test]
fn disable_revokes_pending_and_accepted_arms_without_deleting_or_rearming_receipts() {
    let mut store = store();
    let value = arm(3);
    armed(&mut store.0, &value);
    quota_wakes::handle(&mut store.0, Work::Disable(value.session_id.clone())).unwrap();
    assert!(claimed(&mut store.0, &value).is_none());
    assert_eq!(armed(&mut store.0, &value).phase, "paused");
    assert_eq!(count(&store.0, "receipts"), 0);

    let mut replacement = arm(4);
    replacement.session_id = value.session_id.clone();
    armed(&mut store.0, &replacement);
    let dispatch = claimed(&mut store.0, &replacement).unwrap();
    code(
        quota_wakes::guard_dispatch(&store.0, "another-session", &dispatch.receipt.id),
        "forbidden",
    );
    quota_wakes::handle(&mut store.0, Work::Disable(value.session_id.clone())).unwrap();
    code(
        quota_wakes::guard_dispatch(&store.0, &value.session_id, &dispatch.receipt.id),
        "quota_wake_paused",
    );
    assert!(
        quota_wakes::guard_dispatch(&store.0, &value.session_id, "ordinary-operation")
            .unwrap()
            .is_none()
    );
    assert!(claimed(&mut store.0, &replacement).is_none());
    let retained = armed(&mut store.0, &replacement);
    assert_eq!(retained.reason.as_deref(), Some("disabled"));
    assert_eq!(retained.receipt.unwrap().id, dispatch.receipt.id);
    assert_eq!(count(&store.0, "arms"), 2);
    assert_eq!(count(&store.0, "receipts"), 1);
}

#[test]
fn restart_pauses_armed_and_dispatching_records_and_retains_uncertain_native_receipt() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-quota-restart-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let mut store = Store::open(&path).unwrap();
    let first = arm(5);
    let second = arm(6);
    armed(&mut store.0, &first);
    armed(&mut store.0, &second);
    let dispatch = claimed(&mut store.0, &second).unwrap();
    let immutable: Vec<(String, String)> = {
        let mut query = store
            .0
            .prepare("SELECT id,arm FROM quota_wake_arms ORDER BY sequence")
            .unwrap();
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    drop(store);
    let mut store = Store::open(&path).unwrap();
    for value in [&first, &second] {
        let view = quota_wakes::current(&store.0, &value.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(view.phase, "paused");
        assert_eq!(view.reason.as_deref(), Some("host_restarted"));
        assert_eq!(request_binding(&view.arm), request_binding(value));
        assert!(claimed(&mut store.0, value).is_none());
        assert_eq!(armed(&mut store.0, value).phase, "paused");
    }
    let view = quota_wakes::current(&store.0, &second.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(view.receipt.as_ref().unwrap().id, dispatch.receipt.id);
    assert_eq!(view.receipt.unwrap().phase, "unknown");
    code(
        quota_wakes::guard_dispatch(&store.0, &second.session_id, &dispatch.receipt.id),
        "quota_wake_paused",
    );
    for (id, encoded) in immutable {
        let retained: String = store
            .0
            .query_row("SELECT arm FROM quota_wake_arms WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(retained, encoded);
    }
    assert_eq!(count(&store.0, "receipts"), 1);
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn competing_writers_claim_exactly_one_native_send_without_redelivery() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-quota-claim-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let mut store = Store::open(&path).unwrap();
    let value = arm(7);
    armed(&mut store.0, &value);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut writers = Vec::new();
    for _ in 0..2 {
        let mut connection = Connection::open(&path).unwrap();
        connection.busy_timeout(Duration::from_secs(2)).unwrap();
        let barrier = barrier.clone();
        let expected = value.clone();
        writers.push(std::thread::spawn(move || {
            barrier.wait();
            claimed(&mut connection, &expected).map(|dispatch| dispatch.receipt.id)
        }));
    }
    barrier.wait();
    let dispatched: Vec<_> = writers
        .into_iter()
        .filter_map(|writer| writer.join().unwrap())
        .collect();
    assert_eq!(dispatched.len(), 1);
    assert_eq!(count(&store.0, "receipts"), 1);
    assert!(claimed(&mut store.0, &value).is_none());
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn receipt_admission_failure_rolls_back_claim_and_preserves_one_future_attempt() {
    let mut store = store();
    let value = arm(8);
    armed(&mut store.0, &value);
    let transaction = store.0.transaction().unwrap();
    for number in 0..256 {
        transaction.execute(
            "INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result)
             VALUES(?1,'owner',?1,'fixture','send','accepted','another-session','{}')",
            [format!("{number:032x}")],
        ).unwrap();
    }
    transaction.commit().unwrap();
    code(
        quota_wakes::handle(
            &mut store.0,
            Work::Claim {
                id: value.id.clone(),
                expected: value.clone(),
            },
        ),
        "busy",
    );
    assert_eq!(count(&store.0, "receipts"), 0);
    let view = quota_wakes::current(&store.0, &value.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(view.phase, "armed");
    assert!(view.receipt.is_none());
    store
        .0
        .execute("UPDATE operation_receipts SET phase='failed'", [])
        .unwrap();
    let dispatch = claimed(&mut store.0, &value).unwrap();
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase='failed',result=?2 WHERE id=?1",
            params![
                dispatch.receipt.id,
                json!({"code":"guard_refused","effectStarted":false}).to_string()
            ],
        )
        .unwrap();
    assert!(claimed(&mut store.0, &value).is_none());
    assert_eq!(count(&store.0, "receipts"), 1);
}

#[test]
fn capacity_is_bounded_and_replay_disable_remain_available_when_retention_is_full() {
    let mut store = store();
    for number in 1..=64 {
        armed(&mut store.0, &arm(number));
    }
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(arm(65))),
        "busy",
    );
    assert_eq!(count(&store.0, "arms"), 64);
    let Reply::List(views) = quota_wakes::handle(&mut store.0, Work::List).unwrap() else {
        panic!("Expected active list");
    };
    assert_eq!(views.len(), 64);
    assert_eq!(armed(&mut store.0, &arm(1)).phase, "armed");
    quota_wakes::handle(&mut store.0, Work::Disable(arm(1).session_id)).unwrap();
    armed(&mut store.0, &arm(65));
    quota_wakes::handle(&mut store.0, Work::Disable(arm(65).session_id)).unwrap();
    let transaction = store.0.transaction().unwrap();
    for number in 66..=4096 {
        let value = arm(number);
        transaction
            .execute(
                "INSERT INTO quota_wake_arms(id,session_id,arm,phase,reason)
             VALUES(?1,?2,?3,'paused','disabled')",
                params![
                    value.id,
                    value.session_id,
                    serde_json::to_string(&value).unwrap()
                ],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    assert_eq!(count(&store.0, "arms"), 4096);
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(arm(4097))),
        "busy",
    );
    assert_eq!(armed(&mut store.0, &arm(1)).phase, "paused");
    quota_wakes::handle(&mut store.0, Work::Disable(arm(2).session_id)).unwrap();
    assert_eq!(count(&store.0, "arms"), 4096);
    assert_eq!(count(&store.0, "receipts"), 0);
}

#[test]
fn invalid_bindings_and_silent_replacement_are_refused_without_writing() {
    let mut store = store();
    let value = arm(9);
    let mut invalid = value.clone();
    invalid.id = "A".repeat(32);
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(invalid)),
        "invalid_argument",
    );
    let mut invalid = value.clone();
    invalid.proof.context_id = "C:/private/configuration".into();
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(invalid)),
        "invalid_argument",
    );
    let mut invalid = value.clone();
    invalid.predecessor_id = Some("e".repeat(32));
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(invalid)),
        "invalid_argument",
    );
    assert_eq!(count(&store.0, "arms"), 0);
    armed(&mut store.0, &value);
    let mut different = value.clone();
    different.human_epoch += 1;
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(different)),
        "idempotency_conflict",
    );
    let mut replacement = arm(10);
    replacement.session_id = value.session_id;
    code(
        quota_wakes::handle(&mut store.0, Work::Arm(replacement)),
        "quota_wake_conflict",
    );
    assert_eq!(count(&store.0, "arms"), 1);
    assert_eq!(count(&store.0, "receipts"), 0);
}

#[test]
fn retained_native_receipt_never_becomes_a_second_dispatch_even_with_an_imported_armed_row() {
    let mut store = store();
    let value = arm(11);
    armed(&mut store.0, &value);
    let dispatch = claimed(&mut store.0, &value).unwrap();
    // Simulate inconsistent imported metadata; receipt replay remains a final
    // no-redelivery fence even when the arm's projection is wrong.
    store
        .0
        .execute(
            "UPDATE quota_wake_arms SET phase='armed',operation_id=NULL WHERE id=?1",
            [&value.id],
        )
        .unwrap();
    assert!(claimed(&mut store.0, &value).is_none());
    let view = quota_wakes::current(&store.0, &value.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(view.phase, "paused");
    assert_eq!(view.reason.as_deref(), Some("receipt_retained"));
    assert_eq!(view.receipt.unwrap().id, dispatch.receipt.id);
    assert_eq!(count(&store.0, "receipts"), 1);
}
