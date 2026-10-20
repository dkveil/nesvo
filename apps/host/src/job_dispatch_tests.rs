//! Private dispatch capabilities fence metadata, old results and native intent.
use super::Store;
use crate::{
    job_attempts::{self, Dispatch},
    job_definitions::{self, Claim, Reply, Work},
    job_prechecks::{Outcome, OutcomeState},
    orchestration::{self, Actor, Scope},
};
use rusqlite::{Connection, params, types::ValueRef};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
fn admit(store: &mut Store, key: &str) -> Claim {
    let job = job_definitions::execute(&mut store.0,owner(),serde_json::from_value(json!({
        "action":"create","key":format!("definition:{key}"),"spec":{
            "title":key,"instruction":"No native effects in this fixture",
            "profile":{"program":"claude","workspace":"shared"},
            "schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW+60_000)as i64).unwrap().to_rfc3339()}
        }
    })).unwrap(),NOW).unwrap()["job"].clone();
    job_definitions::execute(&mut store.0,owner(),serde_json::from_value(json!({"action":"runNow","key":format!("manual:{key}"),"jobId":job["id"],"expectedRevision":1})).unwrap(),NOW).unwrap();
    let Reply::Claims(mut claims) =
        job_definitions::work(&mut store.0, Work::Poll { slots: 4 }, NOW).unwrap()
    else {
        panic!("Expected one actual job claim");
    };
    assert_eq!(claims.len(), 1);
    claims.pop().unwrap()
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
fn changes(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap()
}
fn snapshot(connection: &Connection) -> Value {
    let mut snapshot = serde_json::Map::new();
    for table in [
        "harness_jobs",
        "harness_job_occurrences",
        "harness_job_attempts",
        "harness_job_prechecks",
        "harness_job_cancellations",
        "harness_job_mutations",
        "workflow_runs",
        "workflow_tasks",
        "workflow_run_budget",
        "workflow_mutations",
        "operation_receipts",
        "domain_events",
        "domain_event_cursor",
    ] {
        let mut query = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = query.column_count();
        let rows = query
            .query_map([], |row| {
                let values = (0..columns)
                    .map(|index| {
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(value) => json!(value),
                            ValueRef::Real(value) => json!(value),
                            ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                            ValueRef::Blob(value) => json!(value),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(Value::Array(values))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        snapshot.insert(table.into(), Value::Array(rows));
    }
    Value::Object(snapshot)
}
fn phase(store: &Store, dispatch: &Dispatch, state: &str) {
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET state=?2 WHERE id=?1",
            params![dispatch.occurrence, state],
        )
        .unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_attempts SET state=?2 WHERE id=?1",
            params![dispatch.attempt, state],
        )
        .unwrap();
}
fn prepared(store: &mut Store, dispatch: &Dispatch, request: Value) -> Value {
    match job_definitions::work(
        &mut store.0,
        Work::Prepare {
            dispatch: dispatch.clone(),
            request: serde_json::from_value(request).unwrap(),
        },
        NOW,
    )
    .unwrap()
    {
        Reply::Prepared(view) => view,
        _ => panic!("Expected guarded metadata preparation"),
    }
}

#[test]
fn current_dispatch_prepares_only_its_bound_run_and_cannot_replay_after_retirement() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let claim = admit(&mut store, "prepare-current");
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: claim.dispatch.clone()
            },
            NOW
        )
        .unwrap(),
        Reply::Precheck(None)
    ));
    let prefix = format!("job:{}:{}", claim.job_id, claim.id);
    let create = json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":"Current generation","goal":"Metadata preparation only"}});
    let created = prepared(&mut store, &claim.dispatch, create.clone());
    let run = created["run"]["id"].as_str().unwrap().to_owned();
    job_definitions::work(
        &mut store.0,
        Work::BindRun {
            dispatch: claim.dispatch.clone(),
            run: run.clone(),
        },
        NOW,
    )
    .unwrap();
    let unrelated = orchestration::execute_at(&mut store.0,owner(),serde_json::from_value(json!({"action":"create","key":"unrelated-fixture","spec":{"title":"Unrelated run","goal":"Must remain untouched"}})).unwrap(),NOW).unwrap();
    for request in [
        json!({"action":"setPlan","key":"wrong:plan","runId":unrelated["run"]["id"],"expectedRevision":1,"tasks":[{"key":"job","title":"Wrong run","instruction":"Never admit"}]}),
        json!({"action":"runBudget","request":{"action":"set","key":"wrong:budget","runId":unrelated["run"]["id"],"expectedRevision":1,"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}}}),
        json!({"action":"activate","key":"wrong:activate","runId":unrelated["run"]["id"],"expectedRevision":1}),
    ] {
        let before = snapshot(&store.0);
        let writes = changes(&store.0);
        code(
            job_definitions::work(
                &mut store.0,
                Work::Prepare {
                    dispatch: claim.dispatch.clone(),
                    request: serde_json::from_value(request).unwrap(),
                },
                NOW,
            ),
            "job_attempt_conflict",
        );
        assert_eq!(snapshot(&store.0), before);
        assert_eq!(changes(&store.0), writes);
    }
    let plan = prepared(
        &mut store,
        &claim.dispatch,
        json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run,"expectedRevision":created["run"]["revision"],"tasks":[{"key":"job","title":"Current task","instruction":"No native effects"}]}),
    );
    let budget = prepared(
        &mut store,
        &claim.dispatch,
        json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}}}),
    );
    let active = prepared(
        &mut store,
        &claim.dispatch,
        json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run,"expectedRevision":budget["run"]["revision"]}),
    );
    assert_eq!(active["run"]["state"], "active");
    // Metadata-only fixture: Started tests token retirement, not process proof.
    job_definitions::work(
        &mut store.0,
        Work::Started {
            dispatch: claim.dispatch.clone(),
        },
        NOW,
    )
    .unwrap();
    job_attempts::guard_run(&store.0, &run).unwrap();
    let before = snapshot(&store.0);
    let writes = changes(&store.0);
    code(
        job_definitions::work(
            &mut store.0,
            Work::Prepare {
                dispatch: claim.dispatch,
                request: serde_json::from_value(create).unwrap(),
            },
            NOW,
        ),
        "job_attempt_conflict",
    );
    assert_eq!(snapshot(&store.0), before);
    assert_eq!(
        changes(&store.0),
        writes,
        "An immutable acceptance is not dispatch authority"
    );
}

#[test]
fn dispatch_guard_is_read_only_exact_and_a_retired_token_cannot_be_reissued() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let first = admit(&mut store, "first");
    let second = admit(&mut store, "second");
    assert_eq!(first.dispatch.token.len(), 64);
    assert_eq!(hex::decode(&first.dispatch.token).unwrap().len(), 32);
    assert_ne!(first.dispatch.token, second.dispatch.token);
    let read: (String, String) = store.0.query_row("SELECT a.id,a.dispatch_token FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id AND a.occurrence_id=o.id WHERE o.id=?1",[&first.id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(
        read,
        (first.dispatch.attempt.clone(), first.dispatch.token.clone())
    );
    let before = snapshot(&store.0);
    let writes = changes(&store.0);
    job_attempts::guard(&store.0, &first.dispatch, &["dispatching"]).unwrap();
    for wrong in [
        Dispatch {
            token: "invalid-token".into(),
            ..first.dispatch.clone()
        },
        Dispatch {
            attempt: second.dispatch.attempt.clone(),
            ..first.dispatch.clone()
        },
        Dispatch {
            occurrence: second.id.clone(),
            ..first.dispatch.clone()
        },
    ] {
        code(
            job_attempts::guard(&store.0, &wrong, &["dispatching"]),
            "job_attempt_conflict",
        );
    }
    code(
        job_attempts::guard(&store.0, &first.dispatch, &["prechecking"]),
        "job_attempt_conflict",
    );
    code(
        job_attempts::guard(&store.0, &first.dispatch, &[]),
        "job_attempt_conflict",
    );
    assert_eq!(snapshot(&store.0), before);
    assert_eq!(changes(&store.0), writes);
    store
        .0
        .execute(
            "UPDATE harness_job_attempts SET state='prechecking' WHERE id=?1",
            [&first.dispatch.attempt],
        )
        .unwrap();
    let before = snapshot(&store.0);
    let writes = changes(&store.0);
    code(
        job_attempts::guard(&store.0, &first.dispatch, &["dispatching", "prechecking"]),
        "job_attempt_conflict",
    );
    assert_eq!(snapshot(&store.0), before);
    assert_eq!(changes(&store.0), writes);
    phase(&store, &first.dispatch, "dispatching");
    let tx = store.0.transaction().unwrap();
    code(
        job_attempts::retire(
            &tx,
            &Dispatch {
                token: "wrong-token".into(),
                ..first.dispatch.clone()
            },
        ),
        "job_attempt_conflict",
    );
    job_attempts::guard(&tx, &first.dispatch, &["dispatching"]).unwrap();
    job_attempts::retire(&tx, &first.dispatch).unwrap();
    code(
        job_attempts::guard(&tx, &first.dispatch, &["dispatching"]),
        "job_attempt_conflict",
    );
    code(
        job_attempts::claim(&tx, &first.id, NOW + 1),
        "job_attempt_conflict",
    );
    assert_eq!(
        job_attempts::begin(&tx, &first.id, NOW + 1).unwrap(),
        first.dispatch.attempt
    );
    let token: Option<String> = tx
        .query_row(
            "SELECT dispatch_token FROM harness_job_attempts WHERE id=?1",
            [&first.dispatch.attempt],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        token.is_none(),
        "Metadata lookup cannot rearm a retired native claim"
    );
    job_attempts::guard(&tx, &second.dispatch, &["dispatching"]).unwrap();
    tx.commit().unwrap();
}

#[test]
fn every_late_job_producer_refuses_the_previous_generation_before_any_mutation() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let old = admit(&mut store, "generation-fence");
    phase(&store, &old.dispatch, "prechecking");
    store.0.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,state,reason,started_at,observed_at) VALUES(?1,'old-approval','old-digest','running','original command admitted',?2,?2)",params![old.id,NOW as i64]).unwrap();
    let created=orchestration::execute_at(&mut store.0,owner(),serde_json::from_value(json!({"action":"create","key":"fixture-new-run","spec":{"title":"New generation fixture","goal":"Metadata only"}})).unwrap(),NOW).unwrap();
    let run = created["run"]["id"].as_str().unwrap().to_owned();
    let planned=orchestration::execute_at(&mut store.0,owner(),serde_json::from_value(json!({"action":"setPlan","key":"fixture-new-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"job","title":"Current task","instruction":"Current generation only"}]})).unwrap(),NOW).unwrap();
    let next = Dispatch {
        occurrence: old.id.clone(),
        attempt: hex::encode(crate::wire::random::<16>()),
        token: hex::encode(crate::wire::random::<32>()),
    };
    // A future-shaped assignment fixture, not production retry functionality.
    // Keep the old command/claim intact to make stale producer mutation visible.
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,state,dispatch_token) VALUES(?1,?2,2,?3,?4,?4,'dispatching',?5)",params![next.attempt,next.occurrence,run,NOW as i64,next.token]).unwrap();
    store.0.execute("UPDATE harness_job_occurrences SET current_job_attempt_id=?2,run_id=?3,state='dispatching' WHERE id=?1",params![old.id,next.attempt,run]).unwrap();
    let mut completed = Outcome::failed(OutcomeState::Passed, "stale passed command");
    completed.exit_code = Some(0);
    completed.command_started = Some(true);
    completed.cleanup_confirmed = true;
    let works = vec![
        (
            "dispatching",
            Work::BeginPrecheck {
                dispatch: old.dispatch.clone(),
            },
        ),
        (
            "prechecking",
            Work::FinishPrecheck {
                dispatch: old.dispatch.clone(),
                result: completed,
            },
        ),
        (
            "dispatching",
            Work::BindRun {
                dispatch: old.dispatch.clone(),
                run: run.clone(),
            },
        ),
        (
            "dispatching",
            Work::Started {
                dispatch: old.dispatch.clone(),
            },
        ),
        (
            "dispatching",
            Work::Refused {
                dispatch: old.dispatch.clone(),
                uncertain: false,
            },
        ),
        (
            "dispatching",
            Work::Refused {
                dispatch: old.dispatch.clone(),
                uncertain: true,
            },
        ),
        (
            "prechecking",
            Work::Interrupted {
                dispatch: old.dispatch.clone(),
            },
        ),
        (
            "prechecking",
            Work::CancelRequested {
                dispatch: old.dispatch.clone(),
            },
        ),
    ];
    for (current_phase, work) in works {
        phase(&store, &next, current_phase);
        let before = snapshot(&store.0);
        let writes = changes(&store.0);
        code(
            job_definitions::work(&mut store.0, work, NOW + 1),
            "job_attempt_conflict",
        );
        assert_eq!(snapshot(&store.0), before);
        assert_eq!(
            changes(&store.0),
            writes,
            "A rejected producer must not write even rolled-back metadata"
        );
    }
    phase(&store, &next, "dispatching");
    let prefix = format!("job:{}:{}", old.job_id, old.id);
    for request in [
        json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":"Stale run must never exist","goal":"No delayed generation effects"}}),
        json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run,"expectedRevision":planned["run"]["revision"],"tasks":[{"key":"stale","title":"Stale task","instruction":"Never write this plan"}]}),
        json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run,"expectedRevision":planned["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}}}),
        json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run,"expectedRevision":planned["run"]["revision"]}),
    ] {
        let before = snapshot(&store.0);
        let writes = changes(&store.0);
        code(
            job_definitions::work(
                &mut store.0,
                Work::Prepare {
                    dispatch: old.dispatch.clone(),
                    request: serde_json::from_value(request).unwrap(),
                },
                NOW + 1,
            ),
            "job_attempt_conflict",
        );
        assert_eq!(snapshot(&store.0), before);
        assert_eq!(
            changes(&store.0),
            writes,
            "Stale preparation must fail before run creation, mutation acceptance or events"
        );
    }
    job_attempts::guard(&store.0, &next, &["dispatching"]).unwrap();
    let original: Option<String> = store
        .0
        .query_row(
            "SELECT result FROM harness_job_prechecks WHERE occurrence_id=?1",
            [&old.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        original.is_none(),
        "The older admitted command was never overwritten"
    );
}

#[test]
fn ongoing_run_guard_uses_current_assignment_even_after_preparation_token_retirement() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let old = admit(&mut store, "ongoing-run");
    for run in ["old-run", "new-run"] {
        store.0.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Run fence','Metadata only',1,'active',?2)",params![run,NOW as i64]).unwrap();
    }
    {
        let tx = store.0.transaction().unwrap();
        job_attempts::bind(&tx, &old.id, "old-run").unwrap();
        code(
            job_attempts::guard_bound_run(&tx, &old.dispatch, "old-run"),
            "job_attempt_conflict",
        );
        tx.execute(
            "UPDATE harness_job_occurrences SET run_id='old-run' WHERE id=?1",
            [&old.id],
        )
        .unwrap();
        job_attempts::guard_bound_run(&tx, &old.dispatch, "old-run").unwrap();
        code(
            job_attempts::guard_bound_run(&tx, &old.dispatch, "new-run"),
            "job_attempt_conflict",
        );
        job_attempts::retire(&tx, &old.dispatch).unwrap();
        tx.commit().unwrap();
    }
    job_attempts::guard_run(&store.0, "old-run").unwrap();
    let next = hex::encode(crate::wire::random::<16>());
    // Only this metadata fixture creates ordinal 2; no retry is dispatched.
    store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,state) VALUES(?1,?2,2,'new-run',?3,'dispatching')",params![next,old.id,NOW as i64]).unwrap();
    store.0.execute("UPDATE harness_job_occurrences SET current_job_attempt_id=?2,run_id='new-run' WHERE id=?1",params![old.id,next]).unwrap();
    let before = snapshot(&store.0);
    let writes = changes(&store.0);
    code(
        job_attempts::guard_run(&store.0, "old-run"),
        "job_generation_retired",
    );
    job_attempts::guard_run(&store.0, "new-run").unwrap();
    job_attempts::guard_run(&store.0, "ordinary-unrelated-run").unwrap();
    assert_eq!(snapshot(&store.0), before);
    assert_eq!(changes(&store.0), writes);
    {
        let tx = store.0.transaction().unwrap();
        job_attempts::sync(&tx, &old.id, "running", Some("current only"), None).unwrap();
        code(
            job_attempts::begin(&tx, &old.id, NOW + 1),
            "job_attempt_conflict",
        );
        tx.commit().unwrap();
    }
    let original: String = store
        .0
        .query_row(
            "SELECT state FROM harness_job_attempts WHERE id=?1",
            [&old.dispatch.attempt],
            |r| r.get(0),
        )
        .unwrap();
    let current: String = store
        .0
        .query_row(
            "SELECT state FROM harness_job_attempts WHERE id=?1",
            [&next],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(original, "dispatching");
    assert_eq!(current, "running");
}

#[test]
fn published_journal_migration_adds_pointers_without_manufacturing_dispatch_authority() {
    let mut connection = Connection::open_in_memory().unwrap();
    // Exact relevant pre-fence column shapes: generation 1 already exists, but
    // neither private tokens nor occurrence current-assignment pointers exist.
    connection.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE workflow_runs(id TEXT PRIMARY KEY);
      CREATE TABLE harness_job_occurrences(id TEXT PRIMARY KEY,run_id TEXT REFERENCES workflow_runs(id),created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,state TEXT NOT NULL,reason TEXT);
      CREATE TABLE harness_job_attempts(id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),ordinal INTEGER NOT NULL,run_id TEXT UNIQUE REFERENCES workflow_runs(id),created_at INTEGER NOT NULL,claimed_at INTEGER,finished_at INTEGER,state TEXT NOT NULL,reason TEXT,UNIQUE(occurrence_id,ordinal));
      CREATE TABLE harness_job_mutations(issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));
      INSERT INTO workflow_runs VALUES('historical-run');
      INSERT INTO harness_job_occurrences VALUES('historical','historical-run',10,11,NULL,'running','original reason');
      INSERT INTO harness_job_occurrences VALUES('unclaimed',NULL,10,NULL,NULL,'queued',NULL);
      INSERT INTO harness_job_attempts VALUES('published-generation','historical',1,'historical-run',10,11,NULL,'running','original reason');
      INSERT INTO harness_job_mutations VALUES('owner','original','fingerprint','{  \"accepted\": true  }');").unwrap();
    job_attempts::initialize(&connection).unwrap();
    crate::job_retries::initialize(&connection).unwrap();
    {
        let tx = connection.transaction().unwrap();
        job_attempts::backfill(&tx).unwrap();
        tx.commit().unwrap();
    }
    let actual:(String,Option<String>,i64,i64,Option<i64>)=connection.query_row("SELECT o.current_job_attempt_id,a.dispatch_token,a.created_at,a.claimed_at,a.finished_at FROM harness_job_occurrences o JOIN harness_job_attempts a ON a.id=o.current_job_attempt_id WHERE o.id='historical'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(actual, ("published-generation".into(), None, 10, 11, None));
    let false_claim = Dispatch {
        occurrence: "historical".into(),
        attempt: "published-generation".into(),
        token: "never-issued".into(),
    };
    code(
        job_attempts::guard(&connection, &false_claim, &["running"]),
        "job_attempt_conflict",
    );
    job_attempts::guard_run(&connection, "historical-run").unwrap();
    let before = changes(&connection);
    job_attempts::initialize(&connection).unwrap();
    {
        let tx = connection.transaction().unwrap();
        job_attempts::backfill(&tx).unwrap();
        assert_eq!(
            job_attempts::begin(&tx, "historical", NOW).unwrap(),
            "published-generation"
        );
        code(
            job_attempts::claim(&tx, "historical", NOW),
            "job_attempt_conflict",
        );
        tx.commit().unwrap();
    }
    assert_eq!(changes(&connection), before);
    assert_eq!(
        connection
            .query_row(
                "SELECT view FROM harness_job_mutations WHERE key='original'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "{  \"accepted\": true  }"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM harness_job_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        connection
            .query_row(
                "SELECT current_job_attempt_id FROM harness_job_occurrences WHERE id='unclaimed'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none()
    );
    assert!(
        connection
            .query_row(
                "SELECT dispatch_token FROM harness_job_attempts WHERE id='published-generation'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none()
    );
}
