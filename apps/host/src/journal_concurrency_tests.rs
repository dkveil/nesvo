//! Deterministic competing-writer regression: no sleeps or model/native effects.
use super::Store;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::json;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

struct Barrier {
    observed: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
}
static BUSY_BARRIER: Mutex<Option<Barrier>> = Mutex::new(None);
fn blocked_writer(_: i32) -> bool {
    let barrier = BUSY_BARRIER
        .lock()
        .unwrap()
        .take()
        .expect("one controlled lock wait");
    barrier.observed.send(()).unwrap();
    barrier.release.recv_timeout(Duration::from_secs(2)).is_ok()
}
#[test]
fn receipt_acceptance_reserves_write_access_before_reading_a_competing_snapshot() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-writer-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let store = Store::open(&path).unwrap();
    let mut operation = Connection::open(&path).unwrap();
    operation.busy_handler(Some(blocked_writer)).unwrap();
    let mut metadata = Connection::open(&path).unwrap();
    let writer = metadata
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    writer
        .execute("UPDATE domain_event_cursor SET head=head WHERE id=1", [])
        .unwrap();
    let (observed, blocked) = mpsc::sync_channel(1);
    let (release, resumed) = mpsc::channel();
    *BUSY_BARRIER.lock().unwrap() = Some(Barrier {
        observed,
        release: resumed,
    });
    let pending = std::thread::spawn(move || {
        crate::receipts::accept(
            &mut operation,
            "owner",
            "competing-create",
            "create",
            json!({"name":"One process"}),
        )
    });
    let admission = blocked.recv_timeout(Duration::from_secs(2));
    writer.commit().unwrap();
    let _ = release.send(());
    let accepted = pending.join().unwrap();
    *BUSY_BARRIER.lock().unwrap() = None;
    assert!(
        admission.is_ok(),
        "Write reservation must wait before snapshot reads; deferred upgrades can fail without invoking busy handling: {:?}",
        accepted.as_ref().err().map(ToString::to_string)
    );
    let accepted = accepted.unwrap();
    assert!(accepted.is_new);
    let replay = crate::receipts::accept(
        &mut metadata,
        "owner",
        "competing-create",
        "create",
        json!({"name":"One process"}),
    )
    .unwrap();
    assert!(!replay.is_new);
    assert_eq!(replay.receipt.id, accepted.receipt.id);
    drop(metadata);
    drop(store);
    std::fs::remove_file(path).unwrap();
}
